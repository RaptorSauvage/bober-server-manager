import fs from 'node:fs'
import path from 'node:path'
import type { IniTemplateApplyResult, IniTemplatePendingResult, ServerProfile } from '@shared/types'
import { listProfiles, getIniTemplateGeneric, getIniTemplateOverride, recordConfigFileHistory } from '../store'
import { resolveConfigDir } from './config'
import { upsertIniKeys, type IniUpsertEntry } from './gameConfigWrite'

/**
 * INI Templates - a cluster-wide "generic" template is merged with a profile's own "override"
 * (override wins per `[Section]` key on a collision) and applied as a surgical, per-key
 * upsert into that profile's real GameUserSettings.ini/Game.ini (see upsertIniKeys): an
 * already-existing key's line is updated in place, staying right where it already is among
 * its neighbors, rather than being duplicated into a separate block elsewhere in the file - a
 * key the destination doesn't have yet is inserted into its section (or a brand new section,
 * appended at the end, if that doesn't exist yet either). Any line in either file that isn't
 * covered by either template, including something the user wrote in by hand, is left
 * completely untouched. SessionName is always force-set last, to the override's own
 * `sessionName` if it set one or the profile's own Manager name otherwise, regardless of what
 * either template itself says for that key.
 *
 * Templates are parsed with a small line-scanner of our own (parseIniEntries) rather than the
 * `ini` package - besides sidestepping that package's own quirks (it silently drops comments,
 * and expands a dotted section name like ARK's own `/script/shootergame.shootergamemode`
 * into nested objects), it lets each key keep whatever comment lines were written directly
 * above it in the source template, carried along only when that key is new to the
 * destination (an update to an already-existing line never touches whatever comment, if any,
 * already sits above it there - avoids a duplicate on every re-apply).
 */

function parseIniEntries(text: string): IniUpsertEntry[] {
  const entries: IniUpsertEntry[] = []
  let currentSection: string | null = null
  let pendingComments: string[] = []

  for (const rawLine of text.split(/\r\n|\n/)) {
    const trimmed = rawLine.trim()
    if (trimmed === '') {
      pendingComments = []
      continue
    }
    const sectionMatch = /^\[(.+)\]$/.exec(trimmed)
    if (sectionMatch) {
      currentSection = sectionMatch[1]
      pendingComments = []
      continue
    }
    if (trimmed.startsWith(';') || trimmed.startsWith('#')) {
      pendingComments.push(rawLine)
      continue
    }
    const eqIndex = rawLine.indexOf('=')
    if (eqIndex === -1 || currentSection === null) {
      // Not a recognizable `key=value` line, or one with no section to belong to yet (a
      // sectionless line never legitimately appears in GameUserSettings.ini/Game.ini) -
      // silently skipped rather than guessed at, same as a stray comment with nothing
      // following it.
      pendingComments = []
      continue
    }
    entries.push({
      section: currentSection,
      key: rawLine.slice(0, eqIndex).trim(),
      value: rawLine.slice(eqIndex + 1),
      comments: pendingComments.length > 0 ? pendingComments : undefined
    })
    pendingComments = []
  }

  return entries
}

/** `override` entries win over `base` ones for the same section+key - a plain Map keyed by
 *  "section::key" rather than relying on upsertIniKeys itself to dedupe, so a key present in
 *  both ends up applied exactly once with its final value (and that entry's own comments, if
 *  any), not written twice in a row. */
function mergeEntries(base: IniUpsertEntry[], override: IniUpsertEntry[]): IniUpsertEntry[] {
  const merged = new Map<string, IniUpsertEntry>()
  for (const entry of [...base, ...override]) {
    merged.set(`${entry.section}::${entry.key}`, entry)
  }
  return Array.from(merged.values())
}

function snapshotBeforeApply(profileId: string, installDir: string, filePath: string): void {
  try {
    const previous = fs.readFileSync(filePath, 'utf-8')
    // Keyed the same way the Files tab's own editor/history already does (fileBrowser.ts,
    // relative to installDir) - so an Apply shows up in that same history/diff view
    // alongside any manual edit, instead of a separate list nothing else reads.
    recordConfigFileHistory(profileId, path.relative(installDir, filePath), previous)
  } catch {
    // No existing file yet (fresh install never started) - nothing to snapshot.
  }
}

/** Applies the generic template plus `profile`'s own override to its real config files.
 *  Throws (with a message naming which file was the problem) on a write failure (e.g. the
 *  config dir is locked read-only while the server's running). */
export function applyIniTemplate(profile: ServerProfile): void {
  const generic = getIniTemplateGeneric()
  const override = getIniTemplateOverride(profile.id)

  const gusEntries = mergeEntries(parseIniEntries(generic.gameUserSettingsIni), parseIniEntries(override?.gameUserSettingsIni ?? ''))
  // Always wins, regardless of what either template says for this one key - see this
  // module's own doc comment.
  gusEntries.push({ section: 'SessionSettings', key: 'SessionName', value: override?.sessionName.trim() || profile.name })
  const gameEntries = mergeEntries(parseIniEntries(generic.gameIni), parseIniEntries(override?.gameIni ?? ''))

  const configDir = resolveConfigDir(profile.installDir)
  const gusPath = path.join(configDir, 'GameUserSettings.ini')
  const gamePath = path.join(configDir, 'Game.ini')

  try {
    snapshotBeforeApply(profile.id, profile.installDir, gusPath)
    upsertIniKeys(gusPath, gusEntries)
  } catch (err) {
    throw new Error(`GameUserSettings.ini: ${(err as Error).message}`)
  }

  if (gameEntries.length > 0) {
    try {
      snapshotBeforeApply(profile.id, profile.installDir, gamePath)
      upsertIniKeys(gamePath, gameEntries)
    } catch (err) {
      throw new Error(`Game.ini: ${(err as Error).message}`)
    }
  }
}

/** Same as applyIniTemplate, for every ARK profile at once - never rejects itself, each
 *  profile's own outcome is reported in the returned array instead, so one bad override
 *  doesn't stop the rest of the cluster from being applied. Deliberately still a direct,
 *  immediate write (not staged via generatePendingIniTemplate below) - a bulk push across a
 *  whole cluster is the one case where reviewing N staged files one by one before confirming
 *  each would be busywork, not safety. */
export function applyIniTemplateToAll(): IniTemplateApplyResult[] {
  const arkProfiles = listProfiles()
  return arkProfiles.map((profile) => {
    try {
      applyIniTemplate(profile)
      return { profileId: profile.id, profileName: profile.name, ok: true }
    } catch (err) {
      return { profileId: profile.id, profileName: profile.name, ok: false, error: (err as Error).message }
    }
  })
}

/** `<dir>/GameUserSettings.ini` -> `<dir>/GameUserSettings.pending.ini` - a real, separate
 *  file living right next to the real one (same folder the user already finds it in,
 *  including in a Files tab/Explorer listing), so it opens in whatever text editor the user
 *  already uses for hand-editing INI files, not something only this app can see. */
function toPendingPath(realPath: string): string {
  const ext = path.extname(realPath)
  return `${realPath.slice(0, -ext.length)}.pending${ext}`
}

function gusAndGamePaths(profile: ServerProfile): { gusPath: string; gamePath: string } {
  const configDir = resolveConfigDir(profile.installDir)
  return { gusPath: path.join(configDir, 'GameUserSettings.ini'), gamePath: path.join(configDir, 'Game.ini') }
}

/** Copies the real file's current content into `stagingPath` (an empty starting point if the
 *  real file doesn't exist yet, same convention upsertIniKeys itself already uses), then runs
 *  the exact same surgical per-key upsert applyIniTemplate uses onto that copy instead of the
 *  real file - so the staged result is exactly what Apply would have written, just sitting in
 *  a separate file first. */
function stageUpsert(realPath: string, stagingPath: string, entries: IniUpsertEntry[]): void {
  const existing = fs.existsSync(realPath) ? fs.readFileSync(realPath, 'utf-8') : ''
  fs.mkdirSync(path.dirname(stagingPath), { recursive: true })
  fs.writeFileSync(stagingPath, existing, 'utf-8')
  upsertIniKeys(stagingPath, entries)
}

function toPendingResult(profile: ServerProfile, gusPendingPath: string, gamePendingPath: string): IniTemplatePendingResult {
  return {
    profileId: profile.id,
    gameUserSettingsIniPath: path.relative(profile.installDir, gusPendingPath),
    gameIniPath: fs.existsSync(gamePendingPath) ? path.relative(profile.installDir, gamePendingPath) : null
  }
}

/**
 * The INI Templates redesign: instead of Apply writing straight into a profile's real
 * GameUserSettings.ini/Game.ini, it first stages the exact same merged result into
 * `*.pending.ini` files sitting right next to them - lets the user open and hand-tweak that
 * separate file in their own editor if the merged result needs a correction, before anything
 * about their real, currently-working config is touched. Nothing about the real files changes
 * until confirmPendingIniTemplate is called.
 */
export function generatePendingIniTemplate(profile: ServerProfile): IniTemplatePendingResult {
  const generic = getIniTemplateGeneric()
  const override = getIniTemplateOverride(profile.id)

  const gusEntries = mergeEntries(parseIniEntries(generic.gameUserSettingsIni), parseIniEntries(override?.gameUserSettingsIni ?? ''))
  gusEntries.push({ section: 'SessionSettings', key: 'SessionName', value: override?.sessionName.trim() || profile.name })
  const gameEntries = mergeEntries(parseIniEntries(generic.gameIni), parseIniEntries(override?.gameIni ?? ''))

  const { gusPath, gamePath } = gusAndGamePaths(profile)
  const gusPendingPath = toPendingPath(gusPath)
  const gamePendingPath = toPendingPath(gamePath)

  try {
    stageUpsert(gusPath, gusPendingPath, gusEntries)
  } catch (err) {
    throw new Error(`GameUserSettings.ini: ${(err as Error).message}`)
  }

  if (gameEntries.length > 0) {
    try {
      stageUpsert(gamePath, gamePendingPath, gameEntries)
    } catch (err) {
      throw new Error(`Game.ini: ${(err as Error).message}`)
    }
  } else if (fs.existsSync(gamePendingPath)) {
    // A pending file staged by an earlier generate (back when the override still had Game.ini
    // entries) would otherwise sit there stale, forever - confirmPendingIniTemplate picks up
    // anything it finds, so a Game.ini this template no longer touches at all must not leave
    // one behind for it to mistakenly pick up.
    fs.rmSync(gamePendingPath)
  }

  return toPendingResult(profile, gusPendingPath, gamePendingPath)
}

/** Whatever's currently staged for this profile, or `null` if generatePendingIniTemplate has
 *  never been run (or its result was already confirmed/discarded) - lets the view restore the
 *  "pending, ready to confirm" state after navigating away and back, without regenerating
 *  (and so without re-reading the real files) just to check. */
export function getPendingIniTemplateStatus(profile: ServerProfile): IniTemplatePendingResult | null {
  const { gusPath, gamePath } = gusAndGamePaths(profile)
  const gusPendingPath = toPendingPath(gusPath)
  if (!fs.existsSync(gusPendingPath)) return null
  return toPendingResult(profile, gusPendingPath, toPendingPath(gamePath))
}

/** Replaces the real file with its staged `*.pending.ini` content verbatim - whatever the
 *  pending file holds at this point, hand-edits included, is exactly what the real file ends
 *  up with (not re-run through the template merge a second time). Snapshots the real file into
 *  the same Files-tab history applyIniTemplate itself records to first, same undo story. */
function commitPending(profileId: string, installDir: string, realPath: string, pendingPath: string): void {
  const pendingContent = fs.readFileSync(pendingPath, 'utf-8')
  snapshotBeforeApply(profileId, installDir, realPath)
  fs.mkdirSync(path.dirname(realPath), { recursive: true })
  fs.writeFileSync(realPath, pendingContent, 'utf-8')
  fs.rmSync(pendingPath)
}

/** Confirms whatever generatePendingIniTemplate most recently staged for this profile,
 *  replacing its real GameUserSettings.ini/Game.ini. Throws if nothing's staged - the view
 *  always generates before letting Confirm be clicked, so this only fires on a genuinely
 *  stale call (e.g. two tabs/windows open on the same profile). */
export function confirmPendingIniTemplate(profile: ServerProfile): void {
  const { gusPath, gamePath } = gusAndGamePaths(profile)
  const gusPendingPath = toPendingPath(gusPath)
  const gamePendingPath = toPendingPath(gamePath)

  if (!fs.existsSync(gusPendingPath)) {
    throw new Error('Nothing staged to confirm for this server - generate the preview again first.')
  }

  try {
    commitPending(profile.id, profile.installDir, gusPath, gusPendingPath)
  } catch (err) {
    throw new Error(`GameUserSettings.ini: ${(err as Error).message}`)
  }

  if (fs.existsSync(gamePendingPath)) {
    try {
      commitPending(profile.id, profile.installDir, gamePath, gamePendingPath)
    } catch (err) {
      throw new Error(`Game.ini: ${(err as Error).message}`)
    }
  }
}

/** Throws away whatever's staged for this profile without touching its real config files -
 *  the "never mind" counterpart to confirmPendingIniTemplate. A no-op (not an error) if
 *  nothing was staged, same forgiving-delete convention as deleteCustomMap/profiles.delete. */
export function discardPendingIniTemplate(profile: ServerProfile): void {
  const { gusPath, gamePath } = gusAndGamePaths(profile)
  for (const pendingPath of [toPendingPath(gusPath), toPendingPath(gamePath)]) {
    if (fs.existsSync(pendingPath)) fs.rmSync(pendingPath)
  }
}
