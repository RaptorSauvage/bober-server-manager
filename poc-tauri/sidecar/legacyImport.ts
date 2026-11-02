/**
 * First real piece of MIGRATION-PLAN.md's "data migration" gap: finding and importing a real
 * user's existing Electron-app data (profiles, Minecraft profiles) into this Tauri shell's own
 * store, without assuming the two apps happen to land on the same on-disk path.
 *
 * Why this can't just be "point electronShim.ts at the same path Electron used": Electron's
 * own `app.getPath('userData')` resolves from `app.getName()`, which reads package.json's
 * `name` field by default - but electron-builder's `productName` ("Bober Server Manager") is
 * what actually shows up in Windows/macOS/Linux folder names in practice for a lot of
 * electron-builder setups, and the exact rule depends on electron-builder's own packaging
 * behavior (whether it rewrites the packaged app's package.json `name`), which isn't something
 * to assert confidently without checking an actual installed copy. Rather than hardcode a
 * guess and risk silently missing a real user's data, this checks both plausible folder names
 * and reports exactly what it found - the user (or a real future UI) picks the right one, with
 * a manual folder picker (the already-fixed native dialog) as the fallback either way.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listProfiles, saveProfile, listMinecraftProfiles, saveMinecraftProfile } from '../../src/main/store'
import { getDefaultDataDir } from '../../src/main/lib/dataDir'
import { migrateProfile } from '../../src/main/lib/profileMigration'
import { migrateMinecraftProfile } from '../../src/main/lib/minecraftProfileMigration'

interface LegacyStoreShape {
  profiles?: unknown[]
  minecraftProfiles?: unknown[]
  webDashboardAccessTokens?: unknown[]
  bans?: unknown[]
  whitelist?: unknown[]
  watchedPlayers?: unknown[]
}

/** Mirrors Electron's own `app.getPath('userData')` resolution closely enough to search both
 *  real candidates - the OS-conventional per-platform parent directory, joined with each
 *  plausible app-name folder. Not a guess at a single "right" answer on purpose. */
function candidateUserDataDirs(): string[] {
  const home = os.homedir()
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'))
  // electron-builder's `productName` ("Bober Server Manager") vs. package.json's own `name`
  // field ("ark-server-manager") - see this file's own top comment for why both are checked.
  return [path.join(base, 'Bober Server Manager'), path.join(base, 'ark-server-manager')]
}

export interface LegacyCandidate {
  path: string
  configPath: string
  hasConfig: boolean
  profileCount: number
  minecraftProfileCount: number
  error?: string
}

function readLegacyStore(configPath: string): { data?: LegacyStoreShape; error?: string } {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    return { data: JSON.parse(raw) as LegacyStoreShape }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

function describeCandidate(dir: string): LegacyCandidate {
  const configPath = path.join(dir, 'config.json')
  if (!fs.existsSync(configPath)) {
    return { path: dir, configPath, hasConfig: false, profileCount: 0, minecraftProfileCount: 0 }
  }
  const { data, error } = readLegacyStore(configPath)
  if (!data) return { path: dir, configPath, hasConfig: true, profileCount: 0, minecraftProfileCount: 0, error }
  return {
    path: dir,
    configPath,
    hasConfig: true,
    profileCount: Array.isArray(data.profiles) ? data.profiles.length : 0,
    minecraftProfileCount: Array.isArray(data.minecraftProfiles) ? data.minecraftProfiles.length : 0
  }
}

/** Backs the "Scan for an existing install" button - checks both plausible real Electron
 *  userData folders for this OS and reports what (if anything) is actually there, without
 *  writing anything. */
export function detectLegacyCandidates(): LegacyCandidate[] {
  return candidateUserDataDirs().map(describeCandidate)
}

/** Same read-only shape as detectLegacyCandidates, for a manually-picked folder (the native
 *  dialog fallback) instead of one of the two guessed candidates. */
export function previewLegacyImport(dir: string): LegacyCandidate {
  return describeCandidate(dir)
}

export interface LegacyImportResult {
  importedProfiles: number
  skippedProfiles: number
  importedMinecraftProfiles: number
  skippedMinecraftProfiles: number
  customMapsCopied: boolean
  error?: string
}

/** The actual write path. Reuses the real saveProfile()/saveMinecraftProfile() - the same
 *  functions every other real write in this PoC already goes through - rather than writing to
 *  the store directly, so an imported legacy-shaped profile gets upgraded by the real
 *  migrateProfile()/migrateMinecraftProfile() the next time it's read (listProfiles() already
 *  maps every entry through those on every call), exactly as if the user had opened an old
 *  profile in the current app. Already-present ids (matched against the current store, not the
 *  legacy one) are left untouched rather than overwritten - an import should never clobber data
 *  the new app already has. */
export function runLegacyImport(dir: string): LegacyImportResult {
  const configPath = path.join(dir, 'config.json')
  const { data, error } = readLegacyStore(configPath)
  if (!data) return { importedProfiles: 0, skippedProfiles: 0, importedMinecraftProfiles: 0, skippedMinecraftProfiles: 0, customMapsCopied: false, error }

  const existingProfileIds = new Set(listProfiles().map((p) => p.id))
  let importedProfiles = 0
  let skippedProfiles = 0
  for (const raw of data.profiles ?? []) {
    const profile = raw as { id?: string }
    if (!profile.id || existingProfileIds.has(profile.id)) {
      skippedProfiles++
      continue
    }
    // Real legacy data can predate fields saveProfile()'s own sanitization step assumes are
    // present (stripWrappingQuotes(profile.backupDir) etc.) - found by actually hitting
    // "Cannot read properties of undefined (reading 'trim')" on a deliberately bare-bones
    // legacy-shaped profile, not by reading the code first. Running it through the real
    // migrateProfile() first (the same function listProfiles() already maps every stored
    // profile through on every read) fills in most of what a current-schema profile expects -
    // but not quite all of it: migrateProfile() itself never defaults `backupDir` (only
    // `clusterDirOverride`), because in normal real-app use the React form that produces a
    // profile object always initializes it to `''` before it ever reaches saveProfile() - a
    // guarantee a raw imported JSON file doesn't carry. Defaulting the three fields
    // stripWrappingQuotes() touches is this importer's own responsibility, not something to
    // paper over inside the real migration/sanitization code.
    const migrated = migrateProfile(profile as unknown as Parameters<typeof migrateProfile>[0])
    saveProfile({
      ...migrated,
      installDir: migrated.installDir ?? '',
      backupDir: migrated.backupDir ?? '',
      clusterDirOverride: migrated.clusterDirOverride ?? ''
    })
    importedProfiles++
  }

  const existingMcProfileIds = new Set(listMinecraftProfiles().map((p) => p.id))
  let importedMinecraftProfiles = 0
  let skippedMinecraftProfiles = 0
  for (const raw of data.minecraftProfiles ?? []) {
    const profile = raw as { id?: string }
    if (!profile.id || existingMcProfileIds.has(profile.id)) {
      skippedMinecraftProfiles++
      continue
    }
    saveMinecraftProfile(migrateMinecraftProfile(profile as unknown as Parameters<typeof migrateMinecraftProfile>[0]))
    importedMinecraftProfiles++
  }

  // Best-effort secondary copy: the Documents-based data dir (customMaps.json, INI template
  // imports) is a second, independent on-disk location from the electron-store config.json
  // above, and only ever gets copied here if the *new* app's own default data dir doesn't
  // already have one - never overwrites real data the new app already created.
  let customMapsCopied = false
  try {
    // Matches electronShim.ts's own 'documents' resolution exactly (see that file) - the real
    // app.getPath('documents') this stands in for.
    const legacyDocuments = path.join(os.homedir(), 'Documents')
    const legacyCustomMaps = path.join(legacyDocuments, 'ARK Server Manager', 'customMaps.json')
    const newCustomMaps = path.join(getDefaultDataDir(), 'customMaps.json')
    if (fs.existsSync(legacyCustomMaps) && !fs.existsSync(newCustomMaps)) {
      fs.mkdirSync(path.dirname(newCustomMaps), { recursive: true })
      fs.copyFileSync(legacyCustomMaps, newCustomMaps)
      customMapsCopied = true
    }
  } catch {
    // Honest best-effort: a failure here (e.g. no Documents folder in this environment) never
    // blocks the real profile import above, which is the part that actually matters.
  }

  return { importedProfiles, skippedProfiles, importedMinecraftProfiles, skippedMinecraftProfiles, customMapsCopied }
}
