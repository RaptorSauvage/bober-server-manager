import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ServerMod } from '@shared/types'
import { resolveConfigDir, readIniFile } from './config'
import { type GameId, getGameDefinition, listGameDefinitions } from '@shared/games'

export interface DetectedProfileFields {
  suggestedName: string
  map: string
  mods: ServerMod[]
  gamePort?: number
  rconPort?: number
  queryPort?: number
}

function executableCandidates(installDir: string, game: GameId): string[] {
  const def = getGameDefinition(game)
  return [path.join(installDir, ...def.executableWin.split('/')), path.join(installDir, ...def.executableLinux.split('/'))]
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fsp.access(candidate)
    return true
  } catch {
    return false
  }
}

// Async (fs/promises.access, not fs.existsSync) so a slow disk/antivirus-intercepted check on
// one profile's install folder can't block Node's single event loop thread - and so, by
// extension, every other pending IPC call - while this runs. Found by a real user with 6-20+
// real profiles: App.tsx checks every profile's install on every launch
// (window.api.server.isInstalled), and with that many synchronous fs.existsSync calls run
// back to back on a real Windows machine, the whole app appeared to freeze on whatever page
// was clicked right after startup for as long as that loop took to finish.
export async function isValidArkInstall(installDir: string, game: GameId): Promise<boolean> {
  for (const candidate of executableCandidates(installDir, game)) {
    if (await pathExists(candidate)) return true
  }
  return false
}

/** Tries every known game's executable candidates against `installDir` in turn, returning
 *  the first one that matches - used by "Import existing server" so the user doesn't have
 *  to say up front which game they're pointing it at. Returns null if none match (not a
 *  recognized install of any supported game). */
export async function detectGameFromInstall(installDir: string): Promise<GameId | null> {
  for (const def of listGameDefinitions()) {
    if (await isValidArkInstall(installDir, def.id)) return def.id
  }
  return null
}

/** Best-effort: the map is whichever subfolder exists under SavedArks (usually just one). */
function detectMap(installDir: string): string {
  const savedArksDir = path.join(installDir, 'ShooterGame', 'Saved', 'SavedArks')
  if (!fs.existsSync(savedArksDir)) return ''
  const mapDir = fs
    .readdirSync(savedArksDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory())
  return mapDir?.name ?? ''
}

function parsePort(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Scans an existing ARK:SA install folder and pulls out whatever it can from
 * GameUserSettings.ini. Ports and mods aren't actually used from this file by
 * the game (ports are launch-flag only, mods load via -mods=), so an
 * ActiveMods entry here would only exist if another tool wrote it - treat
 * anything detected as a starting guess, not a source of truth.
 */
export function detectProfileFields(installDir: string): DetectedProfileFields {
  const configDir = resolveConfigDir(installDir)
  const gus = readIniFile(path.join(configDir, 'GameUserSettings.ini'))
  const serverSettings = gus.ServerSettings ?? {}
  const sessionSettings = gus.SessionSettings ?? {}

  const mods: ServerMod[] = String(serverSettings.ActiveMods ?? '')
    .split(',')
    .map((id: string) => id.trim())
    .filter(Boolean)
    .map((id: string) => ({ id, enabled: true, passive: false, dev: false }))

  return {
    suggestedName: sessionSettings.SessionName || path.basename(installDir),
    map: detectMap(installDir),
    mods,
    gamePort: parsePort(serverSettings.Port),
    rconPort: parsePort(serverSettings.RCONPort),
    queryPort: parsePort(serverSettings.QueryPort)
  }
}

/** Appends " (2)", " (3)", ... until the name doesn't collide with an existing one. */
export function uniqueProfileName(base: string, existingNames: string[]): string {
  const name = base.trim() || 'Imported Server'
  const taken = new Set(existingNames)
  if (!taken.has(name)) return name

  let suffix = 2
  while (taken.has(`${name} (${suffix})`)) suffix++
  return `${name} (${suffix})`
}
