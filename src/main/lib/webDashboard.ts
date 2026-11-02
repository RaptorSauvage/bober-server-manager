import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'
import type { AppSettings, ServerProfile, ServerStatus, WebDashboardRole } from '@shared/types'
import type { MinecraftProfile } from '@shared/minecraft'
import {
  listProfiles,
  getProfile,
  saveProfile,
  getSettings,
  saveSettings,
  listWebDashboardAccessTokens,
  listWebDashboardApiKeys,
  listMinecraftProfiles,
  getMinecraftProfile,
  saveMinecraftProfile,
  recordPlayerBan
} from '../store'
import { getStatus, watchLogFile, serverEvents } from './serverProcess'
import { sendRconCommand, parsePlayerListWithIds } from './rcon'
import { parseLogChunk, createLogEventCaches, readLogBacklog } from './logEvents'
import { getGroupConsoleBacklog, watchGroupConsole } from './groupConsole'
import { readClusterStatsHistory, readStatsHistory } from './statsHistory'
import {
  doStartServer,
  doStopServerConfirmSave,
  doRestartServerConfirmSave,
  doUpdateServer,
  doStopUpdateRestart,
  doKillServer
} from './serverActions'
import { createBackup, listBackups, deleteBackup, restoreBackup, getBackupLog } from './backup'
import {
  listFileBrowserEntries,
  resolveFileBrowserPath,
  deleteFileBrowserFile,
  readIniFile,
  writeIniFile,
  listIniHistory,
  diffIniHistoryEntry,
  restoreIniHistoryEntry
} from './fileBrowser'
import { listPlayerBackupFolders, listPlayerBackups } from './playerBackup'
import { getBackupScheduleStatus, applyBackupSchedule } from './schedule'
import {
  applyScheduledRestart,
  applyScheduledDinoWipe,
  applyScheduledRconCommands,
  applyScheduledMaintenance
} from './scheduledActions'
import { syncPlayerBackupWatch } from './playerBackupWatch'
import { syncDiscordChatBridgeWatch } from './discordChatBridgeWatch'
import { syncAseModsToIni } from './gameConfigWrite'
import { getCachedGameVersion } from './serverVersion'
import { getOrCreateCert } from './tlsCert'
import { verifyPassword, roleAtLeast, getBearerTokenFromRequest, parseApiKey } from './auth'
import { readUpdateLog } from './steamcmd'
import { listMapFolders, createMapFolder, deleteMapFolder } from './mapManagement'
import { listMaps } from './maps'
import { listCustomMaps } from './customMaps'
import { type GameId, getGameDefinition, listGameDefinitions } from '@shared/games'
import {
  getStatus as getMinecraftStatus,
  minecraftServerEvents,
  minecraftConsoleEvents,
  getConsoleBacklog as getMinecraftConsoleBacklog,
  sendStdinCommand as sendMinecraftStdinCommand
} from './minecraftProcess'
import { doStartMinecraftServer, doStopMinecraftServer, doKillMinecraftServer } from './minecraftActions'
import { sendMinecraftRconCommand, parseMinecraftPlayerList } from './minecraftRcon'
import {
  readServerProperties as readMinecraftServerProperties,
  upsertServerPropertiesKeys as upsertMinecraftServerPropertiesKeys
} from './minecraftProperties'
import { searchArkMods, getArkModsInfo } from './arkMods'
import { listInstallableMinecraftVersions, listInstallableLoaderVersions } from './minecraftInstall'
import type { MinecraftInstallableType } from '@shared/minecraftInstall'
import {
  createMinecraftBackup,
  listMinecraftBackups,
  deleteMinecraftBackup,
  restoreMinecraftBackup,
  getMinecraftBackupLog
} from './minecraftBackup'
import {
  searchMinecraftMods,
  installMinecraftMod,
  removeMinecraftMod,
  setMinecraftModEnabled,
  scanForInstalledMods,
  checkMinecraftModUpdates
} from './minecraftMods'
import type { MinecraftModSource, MinecraftModEcosystem } from '@shared/minecraftMods'

// Minecraft isn't part of shared/games.ts's GameDefinition registry (that one's ARK-only by
// design - see its own top-of-file comment) - its icon is served the same way regardless,
// just added to the known-file-names allow-list by hand instead of coming from
// listGameDefinitions(). NeoForge's own icon (a per-loader-type icon, not a per-game one -
// shown next to "NeoForge" wherever a Minecraft server's type is displayed) is served through
// this exact same route/allow-list for simplicity, rather than a second icon-serving
// mechanism just for loader icons.
const MINECRAFT_ICON_FILE_NAME = 'minecraft.png'
const NEOFORGE_ICON_FILE_NAME = 'neoforge.png'
const FORGE_ICON_FILE_NAME = 'forge.png'
const VANILLA_ICON_FILE_NAME = 'vanilla.png'
const PAPER_ICON_FILE_NAME = 'paper.png'
const FABRIC_ICON_FILE_NAME = 'fabric.png'
const SPIGOT_ICON_FILE_NAME = 'spigot.jpg'
const SPONGE_ICON_FILE_NAME = 'sponge.png'
const KNOWN_GAME_ICON_FILE_NAMES = new Set([
  ...listGameDefinitions().map((g) => g.iconFileName),
  MINECRAFT_ICON_FILE_NAME,
  NEOFORGE_ICON_FILE_NAME,
  FORGE_ICON_FILE_NAME,
  VANILLA_ICON_FILE_NAME,
  PAPER_ICON_FILE_NAME,
  FABRIC_ICON_FILE_NAME,
  SPIGOT_ICON_FILE_NAME,
  SPONGE_ICON_FILE_NAME
])

/**
 * Orders Minecraft profiles the same way sortProfilesForDisplay does for ARK ones (ungrouped
 * first in stored order, then each group alphabetically, also in stored order) - kept as its
 * own small copy rather than genericizing the exported ARK version, which already has its own
 * pinned test suite/signature.
 */
function sortMinecraftProfilesForDisplay(profiles: MinecraftProfile[]): MinecraftProfile[] {
  const visible = profiles.filter((p) => !p.hidden)
  const ungrouped = visible.filter((p) => !p.group.trim())
  const groupNames = Array.from(new Set(visible.filter((p) => p.group.trim()).map((p) => p.group.trim()))).sort()
  const grouped = groupNames.flatMap((groupName) => visible.filter((p) => p.group.trim() === groupName))
  return [...ungrouped, ...grouped]
}

type AnyServer = { kind: 'ark'; profile: ServerProfile } | { kind: 'minecraft'; profile: MinecraftProfile }

/** Looks a server id up across both games' own profile stores - every per-server web
 *  dashboard route that's been taught about Minecraft (see each route's own dispatch below)
 *  uses this instead of listProfiles().find(...) alone, so a Minecraft server id resolves
 *  too rather than always 404ing the way it did before Minecraft support existed here. */
function findAnyServer(id: string): AnyServer | null {
  const arkProfile = listProfiles().find((p) => p.id === id)
  if (arkProfile) return { kind: 'ark', profile: arkProfile }
  const minecraftProfile = listMinecraftProfiles().find((p) => p.id === id)
  if (minecraftProfile) return { kind: 'minecraft', profile: minecraftProfile }
  return null
}

/** Minecraft's own console (minecraftProcess.ts) is just plain lines with no JOIN/LEFT/CHAT/
 *  etc. categorization the way ARK's own parseLogChunk produces (a real log-parsing effort of
 *  its own, left for later) - wrapped into the same LogEvent shape the dashboard's existing
 *  console feed/SSE client code already renders, under one generic 'LOG' category, so that
 *  client code needs no changes to show Minecraft's raw console output too. */
function toMinecraftLogEvent(line: { text: string; ts: number }): { label: string; cls: string; text: string; ts: string } {
  return { label: 'LOG', cls: 'log', text: line.text, ts: new Date(line.ts).toTimeString().slice(0, 8) }
}

/** Same side effects the desktop Manager's own IPC profile-save handler applies
 *  (src/main/ipc/profiles.ts) - re-arming the backup/restart/dino-wipe schedules and the
 *  player-backup log watcher against whatever the save just changed. Every web dashboard
 *  route that calls saveProfile() must call this too, or an edit made there (e.g. toggling
 *  a schedule on, or changing its cron/time) silently has no effect until the Manager is
 *  next restarted or the same profile happens to get saved from the desktop UI too.
 *
 *  syncMods must only be true when the request body actually intended to change mods (i.e.
 *  it has a `mods` key) - otherwise an unrelated save (any other Settings field, a schedule
 *  toggle, ...) would re-write ActiveMods=/[ModInstaller] from the profile's last-known mod
 *  list and clobber real pre-existing ini content that reconcileAseModsFromIni is meant to
 *  pick up instead. Same reasoning as why ipc/profiles.ts's generic profilesSave handler
 *  doesn't call syncAseModsToIni either - only ipc/mods.ts's dedicated modsSave handler does. */
function applyProfileSideEffects(profile: ServerProfile, syncMods: boolean): void {
  applyBackupSchedule(profile)
  syncPlayerBackupWatch(profile)
  syncDiscordChatBridgeWatch(profile)
  applyScheduledRestart(profile)
  applyScheduledDinoWipe(profile)
  applyScheduledRconCommands(profile)
  applyScheduledMaintenance(profile)
  if (syncMods) syncAseModsToIni(profile)
}

let server: http.Server | https.Server | null = null
let lastError: string | null = null
let lastHost: string | null = null

// Same icon.png the desktop window/taskbar uses (see src/main/index.ts), read once and
// cached in memory since it never changes while the app is running.
//
// Served with Cache-Control: no-store and no ETag/If-None-Match/304 at all (see the
// /favicon.png route below) - not the first design tried here. The first used a long-lived
// ETag so a browser with an older cached icon would revalidate and pick up a new one; that
// missed an uglier failure mode entirely: a browser can cache a *broken* response just as
// durably as a good one. One real round genuinely served a 404 here (before current_dir was
// fixed in the Tauri PoC shell this also ships through), which some browsers - especially
// favicons specifically, tracked in their own on-disk store outside the normal HTTP cache -
// can pin as "this URL has nothing" for a long time, immune to a plain reload or even a new
// private window. A conditional-GET route can't recover from that on its own: a `304 Not
// Modified` just confirms "keep using what you already have," which is exactly the problem
// when what the browser has is broken or nothing. A cache-busted URL (this value's own
// content hash in the query string - see gameIconUrl below, and renderDashboardHtml's own use
// of this same etag for the favicon <link>) forces a fetch of a URL that specific browser has
// never requested before, sidestepping whatever it already has cached for the plain path
// instead of asking it to revalidate something that was never safe to trust in the first
// place.
let faviconCache: Buffer | null | undefined
let faviconETag = ''
function getFaviconBuffer(): { buffer: Buffer; etag: string } | null {
  if (faviconCache !== undefined) return faviconCache ? { buffer: faviconCache, etag: faviconETag } : null
  // cwd rather than __dirname-relative math: this file sits one level deeper than
  // src/main/index.ts (which resolves the same dev-mode icon via __dirname), but once
  // bundled by electron-vite both end up inlined into the same out/main/index.js anyway -
  // cwd is the one thing that stays correct whether this runs bundled (dev/packaged) or
  // as an unbundled source file (vitest importing this module directly).
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(process.cwd(), 'build/icon.png')
  try {
    faviconCache = fs.readFileSync(iconPath)
    faviconETag = `"${crypto.createHash('md5').update(faviconCache).digest('hex')}"`
  } catch {
    faviconCache = null
  }
  return faviconCache ? { buffer: faviconCache, etag: faviconETag } : null
}

// Per-game icons (shared/games.ts's GameDefinition.iconFileName), same read-once in-memory
// caching as the favicon above, and the same no-store/cache-busted-URL serving (see
// getFaviconBuffer's own comment on why, and gameIconUrl below) rather than ETag/304 - these
// are ordinary <img> tags, not favicons, but hit the exact same failure mode: a browser that
// ever saw one 404 can keep it broken indefinitely. Keyed by the exact set of file names the
// registry knows about rather than trusting the request path directly, so a crafted
// /game-icons/../../x request can't be used to read arbitrary files off disk.
const gameIconCache = new Map<string, { buffer: Buffer; etag: string } | null>()
function getGameIconBuffer(fileName: string): { buffer: Buffer; etag: string } | null {
  if (gameIconCache.has(fileName)) return gameIconCache.get(fileName) ?? null
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'games', fileName)
    : path.join(process.cwd(), 'build/games', fileName)
  let result: { buffer: Buffer; etag: string } | null = null
  try {
    const buffer = fs.readFileSync(iconPath)
    result = { buffer, etag: `"${crypto.createHash('md5').update(buffer).digest('hex')}"` }
  } catch {
    result = null
  }
  gameIconCache.set(fileName, result)
  return result
}

// Same cache-busting reasoning as getFaviconBuffer's own comment and renderDashboardHtml's own
// favicon href - these /game-icons/ URLs are just as fixed and just as likely to have been
// requested once already (and cached as broken) by a browser that saw the pre-current_dir-fix
// 404, be it the small per-card game icon (gameIconUrl in /api/servers, below) or the static
// sidebar game-switch buttons' own <img> tags in DASHBOARD_HTML (see renderDashboardHtml).
function gameIconUrl(fileName: string): string {
  const icon = getGameIconBuffer(fileName)
  return icon ? `/game-icons/${fileName}?v=${icon.etag.replace(/"/g, '')}` : `/game-icons/${fileName}`
}

/** Event categories that can be individually hidden from the web dashboard's feed. */
const ALL_EVENT_LABELS = ['JOIN', 'LEFT', 'CHAT', 'WARN', 'KILL', 'TAME', 'CMD', 'SAVE', 'CRYO', 'MISSION', 'READY']

/**
 * Orders profiles the same way the Manager's own dashboard grid does, and drops hidden
 * ones: ungrouped profiles first (in their stored/reordered position), then each named
 * group's profiles (alphabetical by group name), also in their stored position within
 * the group. Hidden profiles never appear here, matching the desktop dashboard where
 * they're tucked away in a separate collapsed section.
 */
export function sortProfilesForDisplay(profiles: ServerProfile[]): ServerProfile[] {
  const visible = profiles.filter((p) => !p.hidden)
  const ungrouped = visible.filter((p) => !p.group.trim())
  const groupNames = Array.from(new Set(visible.filter((p) => p.group.trim()).map((p) => p.group.trim()))).sort()
  const grouped = groupNames.flatMap((groupName) => visible.filter((p) => p.group.trim() === groupName))
  return [...ungrouped, ...grouped]
}

/** URL-safe stand-in for the (empty-string) ungrouped "group" - an actual empty path
 *  segment invites double-slash URL edge cases the client would rather not construct. */
const UNGROUPED_GROUP_TOKEN = '_ungrouped_'

function resolveGroupProfiles(groupParam: string): ServerProfile[] {
  const groupName = groupParam === UNGROUPED_GROUP_TOKEN ? '' : groupParam
  return sortProfilesForDisplay(listProfiles()).filter((p) => p.group.trim() === groupName)
}

/** `null` or an empty array (including a stored token from before this field existed, or one
 *  saved with nothing checked) means every profile - matching both the pre-scoping behavior
 *  and the Settings UI's "nothing checked = all servers" picker. A `globalAdmin` credential
 *  always has access regardless of `profileIds` - it's the one role scoping was never meant
 *  to apply to; use `admin` for a token that should be restricted to specific servers. */
function hasProfileAccess(auth: RequireRoleResult, profileId: string): boolean {
  if (auth.role === 'globalAdmin') return true
  return !auth.profileIds || auth.profileIds.length === 0 || auth.profileIds.includes(profileId)
}

function filterProfilesForAuth<T extends { id: string }>(auth: RequireRoleResult, profiles: T[]): T[] {
  if (auth.role === 'globalAdmin') return profiles
  if (!auth.profileIds || auth.profileIds.length === 0) return profiles
  const allowed = auth.profileIds
  return profiles.filter((p) => allowed.includes(p.id))
}

function getDisabledLabels(): Set<string> {
  return new Set(getSettings().webDashboardDisabledLabels ?? [])
}

function setLabelEnabled(label: string, enabled: boolean): void {
  const settings = getSettings()
  const disabled = new Set(settings.webDashboardDisabledLabels ?? [])
  if (enabled) disabled.delete(label)
  else disabled.add(label)
  saveSettings({ ...settings, webDashboardDisabledLabels: Array.from(disabled) })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

/** Defined up here rather than inline in the route below because the request handler's own
 *  local `path` (the URL's pathname, see `const path = url.pathname` further down) shadows
 *  the `node:path` module import for the rest of that function's scope - this one needs the
 *  real one. The rest of the file-browser logic lives in fileBrowser.ts, shared with the
 *  desktop Manager's own IPC handlers - this is HTTP-response-specific enough (streaming,
 *  headers) that it stays here instead.
 *
 *  Throws (caller sends 400) if `filePath` isn't a plain file - streams it as an attachment
 *  otherwise. `filename*` covers a non-ASCII name properly; the plain `filename` fallback is
 *  just the same name with quotes stripped, for a client that ignores `filename*` entirely. */
function sendFileDownload(res: http.ServerResponse, filePath: string): void {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error('Not a file')
  const safeName = path.basename(filePath).replace(/"/g, '')
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`
  })
  fs.createReadStream(filePath).pipe(res)
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err as Error)
      }
    })
    req.on('error', reject)
  })
}

interface RequireRoleResult {
  role: WebDashboardRole
  /** `null` = every profile (an API key, or an access token with nothing checked in its
   *  server picker). Only ever restricted for a WebDashboardAccessToken. */
  profileIds: string[] | null
}

/**
 * Gate for every route below `minRole`. When the web dashboard's login requirement is off
 * (the default, unchanged from before this feature existed), this always succeeds with a
 * synthetic full-access role - every route behaves exactly as it did previously. When it's
 * required, the caller must present a valid Bearer credential (`Authorization` header, or a
 * `?token=` query parameter for the two `EventSource` connections that can't set custom
 * headers) matching either a WebDashboardApiKey (bots/scripts) or a WebDashboardAccessToken
 * (pasted into a browser and kept in its own `localStorage`, never a cookie/session) -
 * sending the 401/403 itself and returning null on failure. Callers must `return`
 * immediately when this returns null.
 *
 * A route that operates on one profile or group must additionally check the returned
 * `profileIds` (via hasProfileAccess/filterProfilesForAuth below) - this only checks role,
 * not which servers the credential is scoped to.
 */
async function requireRole(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  minRole: WebDashboardRole
): Promise<RequireRoleResult | null> {
  if (!getSettings().webDashboardAuthEnabled) return { role: 'globalAdmin', profileIds: null }

  const presented = getBearerTokenFromRequest(req)
  const parsed = presented ? parseApiKey(presented) : null
  if (!parsed) {
    sendJson(res, 401, { error: 'Not authenticated' })
    return null
  }

  const apiKey = listWebDashboardApiKeys().find((k) => k.id === parsed.id)
  const accessToken = apiKey ? undefined : listWebDashboardAccessTokens().find((t) => t.id === parsed.id)
  const stored = apiKey ?? accessToken
  const valid = stored ? await verifyPassword(parsed.secret, stored.secretHash) : false
  if (!valid || !stored) {
    sendJson(res, 401, { error: 'Invalid token' })
    return null
  }
  if (!roleAtLeast(stored.role, minRole)) {
    sendJson(res, 403, { error: 'Insufficient permissions' })
    return null
  }
  // apiKey is never profile-scoped; accessToken may be, but a stored token from before this
  // field existed has no profileIds at all (undefined, despite the type) - treat that the
  // same as null (unrestricted).
  return { role: stored.role, profileIds: accessToken?.profileIds ?? null }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderDashboardHtml(getSettings().webDashboardAuthEnabled))
    return
  }

  if (req.method === 'GET' && path === '/favicon.png') {
    const favicon = getFaviconBuffer()
    if (!favicon) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    // Plain 200 every time, no ETag/If-None-Match/304 - see getFaviconBuffer's own comment on
    // why a conditional-GET icon route turned out to be the wrong shape of fix entirely, not
    // just an incomplete one.
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    res.end(favicon.buffer)
    return
  }

  const gameIconMatch = path.match(/^\/game-icons\/([^/]+)$/)
  if (req.method === 'GET' && gameIconMatch) {
    const fileName = decodeURIComponent(gameIconMatch[1])
    const icon = KNOWN_GAME_ICON_FILE_NAMES.has(fileName) ? getGameIconBuffer(fileName) : null
    if (!icon) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    // Same no-store reasoning as /favicon.png above - see getFaviconBuffer's own comment.
    const iconContentType = /\.jpe?g$/i.test(fileName) ? 'image/jpeg' : 'image/png'
    res.writeHead(200, { 'Content-Type': iconContentType, 'Cache-Control': 'no-store' })
    res.end(icon.buffer)
    return
  }

  if (req.method === 'GET' && path === '/api/whoami') {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    sendJson(res, 200, { role: auth.role })
    return
  }

  if (req.method === 'GET' && path === '/api/servers') {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const settings = getSettings()
    const collapsedGroups = new Set(settings.collapsedGroups)
    const arkServers = filterProfilesForAuth(auth, sortProfilesForDisplay(listProfiles())).map((profile) => {
      const status = getStatus(profile.id)
      const game = getGameDefinition(profile.game)
      return {
        id: profile.id,
        name: profile.name,
        group: profile.group.trim(),
        // A group minimized on the desktop Manager's own Dashboard - the server itself stays
        // fully manageable here (still listed in every server picker), but the Dashboard/
        // Cluster Dashboard tabs' own card grids leave it out, matching the desktop.
        groupCollapsed: collapsedGroups.has(profile.group.trim()),
        maxPlayers: profile.maxPlayers,
        state: status.state,
        players: status.players ?? [],
        cpu: status.cpu ?? null,
        memoryMB: status.memoryMB ?? null,
        startedAt: status.startedAt ?? null,
        gameVersion: getCachedGameVersion(profile.id),
        statsEnabled: profile.statsEnabled,
        gameIconUrl: gameIconUrl(game.iconFileName),
        gameDisplayName: game.displayName,
        discordChatChannelId: profile.discordChatChannelId || undefined,
        discordEventsChannelId: profile.discordEventsChannelId || undefined,
        discordBotExcluded: profile.discordBotExcluded
      }
    })
    const minecraftCollapsedGroups = new Set(settings.minecraftCollapsedGroups)
    const minecraftServers = filterProfilesForAuth(auth, sortMinecraftProfilesForDisplay(listMinecraftProfiles())).map(
      (profile) => {
        const status = getMinecraftStatus(profile.id)
        const maxPlayersRaw = Number(readMinecraftServerProperties(profile.installDir)['max-players'])
        return {
          id: profile.id,
          name: profile.name,
          group: profile.group.trim(),
          groupCollapsed: minecraftCollapsedGroups.has(profile.group.trim()),
          maxPlayers: Number.isFinite(maxPlayersRaw) && maxPlayersRaw > 0 ? maxPlayersRaw : 20,
          state: status.state,
          players: status.players ?? [],
          cpu: status.cpu ?? null,
          memoryMB: status.memoryMB ?? null,
          startedAt: status.startedAt ?? null,
          // The user-set target version, not a live-detected one (Minecraft servers have no
          // SteamCMD-style installed-build-id check the way ARK's getCachedGameVersion reads) -
          // still the most useful single "version" string to show for one of these.
          gameVersion: profile.minecraftVersion || null,
          // Only consumed client-side to pick a per-loader icon (see
          // MC_SERVER_TYPE_ICON_URLS) where one exists - sparse by design, same as that map.
          serverType: profile.serverType,
          statsEnabled: undefined,
          gameIconUrl: gameIconUrl(MINECRAFT_ICON_FILE_NAME),
          gameDisplayName: 'Minecraft',
          discordBotExcluded: profile.discordBotExcluded
        }
      }
    )
    sendJson(res, 200, [...arkServers, ...minecraftServers])
    return
  }

  const eventsMatch = path.match(/^\/api\/servers\/([^/]+)\/events$/)
  if (req.method === 'GET' && eventsMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(eventsMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 200, [])
      return
    }
    if (found.kind === 'minecraft') {
      sendJson(res, 200, (await getMinecraftConsoleBacklog(found.profile.id)).map(toMinecraftLogEvent))
      return
    }
    sendJson(res, 200, await readLogBacklog(found.profile.installDir, getDisabledLabels()))
    return
  }

  const streamMatch = path.match(/^\/api\/servers\/([^/]+)\/events\/stream$/)
  if (req.method === 'GET' && streamMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(streamMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Unknown server')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.write('\n')

    if (found.kind === 'minecraft') {
      // Minecraft's own console (minecraftProcess.ts) is an in-memory line buffer/event
      // emitter, not a log file to tail - no rotation-detection or baseline-read-position
      // concerns the way ARK's own watchLogFile needs. 'reset' still matters the same way,
      // just hung off the server actually (re)starting rather than a log file's inode
      // changing, since the previous session's lines shouldn't linger once a fresh one begins.
      const profileId = found.profile.id
      function onLine(lineProfileId: string, line: { text: string; ts: number }): void {
        if (lineProfileId !== profileId) return
        res.write(`data: ${JSON.stringify(toMinecraftLogEvent(line))}\n\n`)
      }
      function onStatus(status: { profileId: string; state: string }): void {
        if (status.profileId !== profileId || status.state !== 'starting') return
        res.write('event: reset\ndata: {}\n\n')
      }
      minecraftConsoleEvents.on('line', onLine)
      minecraftServerEvents.on('status', onStatus)
      req.on('close', () => {
        minecraftConsoleEvents.off('line', onLine)
        minecraftServerEvents.off('status', onStatus)
      })
      return
    }

    // Captured into their own consts so the nested function declarations below (whose
    // closures TypeScript can't narrow the same way it narrows inline callbacks) don't
    // need to re-check profile for undefined on every use.
    const profileId = found.profile.id
    const installDir = found.profile.installDir

    let caches = createLogEventCaches()

    function onLogChunk(chunk: string, rotated: boolean): void {
      if (rotated) {
        // ARK opened a fresh log file (detected here by its inode changing) - drop
        // whatever the page was showing from the previous session and start resolving
        // player names fresh. Kept as a backup signal alongside the 'starting' status
        // hook below, for a server the Manager didn't itself (re)start.
        caches = createLogEventCaches()
        res.write('event: reset\ndata: {}\n\n')
      }
      const disabled = getDisabledLabels()
      for (const event of parseLogChunk(chunk, caches)) {
        if (disabled.has(event.label)) continue
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
    }

    let stopWatching = watchLogFile(installDir, onLogChunk)

    // The log file's own rotation isn't a reliable enough signal by itself - whether and
    // when ARK actually replaces the file on disk isn't consistently observable across
    // platforms. Spawning the process is something the Manager does itself, though, so
    // treat that as the definitive "a new session is starting" moment whenever it's the
    // Manager doing the (re)starting: drop the old tailer and start a fresh one so it
    // re-establishes its own read position from scratch instead of an offset that could
    // belong to a session that no longer exists.
    function onStatus(status: ServerStatus): void {
      if (status.profileId !== profileId || status.state !== 'starting') return
      caches = createLogEventCaches()
      res.write('event: reset\ndata: {}\n\n')
      stopWatching()
      stopWatching = watchLogFile(installDir, onLogChunk)
    }
    serverEvents.on('status', onStatus)

    req.on('close', () => {
      stopWatching()
      serverEvents.off('status', onStatus)
    })
    return
  }

  const groupEventsMatch = path.match(/^\/api\/groups\/([^/]+)\/events$/)
  if (req.method === 'GET' && groupEventsMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const profiles = filterProfilesForAuth(auth, resolveGroupProfiles(decodeURIComponent(groupEventsMatch[1])))
    const disabled = getDisabledLabels()
    sendJson(
      res,
      200,
      (await getGroupConsoleBacklog(profiles)).filter((event) => !disabled.has(event.label))
    )
    return
  }

  const groupStreamMatch = path.match(/^\/api\/groups\/([^/]+)\/events\/stream$/)
  if (req.method === 'GET' && groupStreamMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const profiles = filterProfilesForAuth(auth, resolveGroupProfiles(decodeURIComponent(groupStreamMatch[1])))
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    res.write('\n')
    const stopWatchingGroup = watchGroupConsole(profiles, (event) => {
      if (getDisabledLabels().has(event.label)) return
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    })
    req.on('close', () => stopWatchingGroup())
    return
  }

  const groupStatsMatch = path.match(/^\/api\/groups\/([^/]+)\/stats$/)
  if (req.method === 'GET' && groupStatsMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const profiles = filterProfilesForAuth(auth, resolveGroupProfiles(decodeURIComponent(groupStatsMatch[1])))
    const sinceParam = url.searchParams.get('since')
    const sinceMs = sinceParam === null || sinceParam === 'null' ? null : Number(sinceParam)
    const maxPointsParam = url.searchParams.get('maxPoints')
    const maxPoints = maxPointsParam !== null ? Number(maxPointsParam) : undefined
    sendJson(
      res,
      200,
      await readClusterStatsHistory(
        profiles.map((p) => p.id),
        Number.isFinite(sinceMs) ? sinceMs : null,
        maxPoints
      )
    )
    return
  }

  const serverStatsMatch = path.match(/^\/api\/servers\/([^/]+)\/stats$/)
  if (req.method === 'GET' && serverStatsMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const profileId = decodeURIComponent(serverStatsMatch[1])
    if (!listProfiles().some((p) => p.id === profileId) || !hasProfileAccess(auth, profileId)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    const sinceParam = url.searchParams.get('since')
    const sinceMs = sinceParam === null || sinceParam === 'null' ? null : Number(sinceParam)
    const maxPointsParam = url.searchParams.get('maxPoints')
    const maxPoints = maxPointsParam !== null ? Number(maxPointsParam) : undefined
    sendJson(res, 200, await readStatsHistory(profileId, Number.isFinite(sinceMs) ? sinceMs : null, maxPoints))
    return
  }

  if (req.method === 'GET' && path === '/api/labelsettings') {
    if (!(await requireRole(req, res, 'readonly'))) return
    const disabled = getDisabledLabels()
    const result: Record<string, boolean> = {}
    for (const label of ALL_EVENT_LABELS) result[label] = !disabled.has(label)
    sendJson(res, 200, result)
    return
  }

  const labelMatch = path.match(/^\/api\/labelsettings\/([^/]+)$/)
  if (req.method === 'POST' && labelMatch) {
    if (!(await requireRole(req, res, 'admin'))) return
    const label = decodeURIComponent(labelMatch[1])
    if (!ALL_EVENT_LABELS.includes(label)) {
      sendJson(res, 404, { error: 'Unknown event label' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const enabled = typeof body.enabled !== 'boolean' || body.enabled
        setLabelEnabled(label, enabled)
        sendJson(res, 200, { label, enabled })
      })
      .catch(() => sendJson(res, 400, { error: 'Invalid request body' }))
    return
  }

  const playersMatch = path.match(/^\/api\/servers\/([^/]+)\/players$/)
  if (req.method === 'GET' && playersMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(playersMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 200, [])
      return
    }
    if (found.kind === 'minecraft') {
      // Minecraft's own `list` command has no per-player id the way ARK's ListPlayers does
      // (see parsePlayerListWithIds) - just names, wrapped into the same {name, id} shape
      // with id left empty so the client's existing player-list rendering (which only ever
      // displays the name) needs no changes to show these too.
      sendMinecraftRconCommand(found.profile.installDir, 'list').then((result) => {
        const names = result.ok && result.response ? parseMinecraftPlayerList(result.response).players : []
        sendJson(
          res,
          200,
          names.map((name) => ({ name, id: '' }))
        )
      })
      return
    }
    sendRconCommand(found.profile, 'ListPlayers').then((result) => {
      sendJson(res, 200, result.ok && result.response ? parsePlayerListWithIds(result.response) : [])
    })
    return
  }

  const startMatch = path.match(/^\/api\/servers\/([^/]+)\/start$/)
  if (req.method === 'POST' && startMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(startMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    try {
      if (found.kind === 'minecraft') doStartMinecraftServer(found.profile)
      else doStartServer(found.profile)
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendJson(res, 400, { ok: false, error: (err as Error).message })
    }
    return
  }

  // Force-kill, no save - same tier (moderator+) and the same "respond immediately, the
  // actual process teardown happens in the background" shape as stop/restart above, since
  // killServer/the Minecraft equivalent are themselves fire-and-forget (see their own doc
  // comments in serverProcess.ts/minecraftProcess.ts).
  const killMatch = path.match(/^\/api\/servers\/([^/]+)\/kill$/)
  if (req.method === 'POST' && killMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(killMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    if (found.kind === 'minecraft') doKillMinecraftServer(found.profile)
    else doKillServer(found.profile.id)
    sendJson(res, 200, { ok: true })
    return
  }

  // Stop/restart/stop+update+restart can take a while (RCON SaveWorld+DoExit, a
  // multi-minute SteamCMD download) - respond once SaveWorld's outcome is confirmed
  // rather than holding the request open for the whole thing, same as the desktop app's
  // own buttons: the periodic /api/servers poll picks up the state changes (stopping/
  // updating/starting/running) as they happen. A failure past this point is logged
  // server-side since there's no request left to answer by then. Responding only once
  // SaveWorld is confirmed (rather than the instant the action is merely kicked off)
  // means `saved` in the response is meaningful - a caller polling too fast right after
  // a bare "ok" can't mistake "we started stopping it" for "it actually saved first".
  const stopMatch = path.match(/^\/api\/servers\/([^/]+)\/stop$/)
  if (req.method === 'POST' && stopMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(stopMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    if (found.kind === 'minecraft') {
      // No separate SaveWorld/DoExit handshake to phase a response around the way ARK's own
      // stopServerPhased needs - Minecraft's "stop" command already saves and exits on its
      // own (see minecraftProcess.ts's stopServer), so there's no meaningful `saved` outcome
      // to report back the way ARK's doStopServerConfirmSave has.
      await doStopMinecraftServer(found.profile)
      sendJson(res, 200, { ok: true })
      return
    }
    const { saved } = await doStopServerConfirmSave(found.profile)
    sendJson(res, 200, { ok: true, saved })
    return
  }

  const restartMatch = path.match(/^\/api\/servers\/([^/]+)\/restart$/)
  if (req.method === 'POST' && restartMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(restartMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    if (found.kind === 'minecraft') {
      sendJson(res, 400, { ok: false, error: 'Restart is not available for Minecraft servers yet - use Stop then Start.' })
      return
    }
    const { saved } = await doRestartServerConfirmSave(found.profile)
    sendJson(res, 200, { ok: true, saved })
    return
  }

  const updateMatch = path.match(/^\/api\/servers\/([^/]+)\/update$/)
  if (req.method === 'POST' && updateMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(updateMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    if (found.kind === 'minecraft') {
      sendJson(res, 400, { ok: false, error: 'This Manager has no auto-update mechanism for Minecraft servers.' })
      return
    }
    doUpdateServer(found.profile).catch((err: Error) =>
      console.error(`Web dashboard update failed for ${found.profile.name}:`, err.message)
    )
    sendJson(res, 200, { ok: true })
    return
  }

  const stopUpdateRestartMatch = path.match(/^\/api\/servers\/([^/]+)\/stop-update-restart$/)
  if (req.method === 'POST' && stopUpdateRestartMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(stopUpdateRestartMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    if (found.kind === 'minecraft') {
      sendJson(res, 400, { ok: false, error: 'This Manager has no auto-update mechanism for Minecraft servers.' })
      return
    }
    doStopUpdateRestart(found.profile).catch((err: Error) =>
      console.error(`Web dashboard stop+update+restart failed for ${found.profile.name}:`, err.message)
    )
    sendJson(res, 200, { ok: true })
    return
  }

  const rconMatch = path.match(/^\/api\/servers\/([^/]+)\/rcon$/)
  if (req.method === 'POST' && rconMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(rconMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then(async (body) => {
        const command = typeof body.command === 'string' ? body.command.trim() : ''
        if (!command) {
          sendJson(res, 400, { ok: false, error: 'Empty command' })
          return
        }
        if (found.kind === 'minecraft') {
          // Live stdin is the primary channel (same as the desktop Console tab's own command
          // box) - RCON is only the fallback for a server re-adopted from a previous Manager
          // session, with no live process handle to write to (see sendStdinCommand's own doc
          // comment in minecraftProcess.ts).
          if (sendMinecraftStdinCommand(found.profile.id, command)) {
            sendJson(res, 200, { ok: true })
            return
          }
          const result = await sendMinecraftRconCommand(found.profile.installDir, command)
          sendJson(res, 200, result)
          return
        }
        const result = await sendRconCommand(found.profile, command)
        sendJson(res, 200, result)
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid request body' }))
    return
  }

  // ARK only - BanPlayer's a real RCON command there (same as Kick above, a thin wrapper
  // around sendRconCommand), but it also records the ban into the centralized list (see
  // BannedPlayer's own doc comment) so it shows up in the desktop app's own Player Bans
  // view merged with whatever it's already been banned on elsewhere, not just this server.
  const banMatch = path.match(/^\/api\/servers\/([^/]+)\/ban$/)
  if (req.method === 'POST' && banMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(banMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    if (found.kind === 'minecraft') {
      sendJson(res, 400, { ok: false, error: 'Banning is only supported for ARK servers.' })
      return
    }
    readJsonBody(req)
      .then(async (body) => {
        const playerId = typeof body.playerId === 'string' ? body.playerId.trim() : ''
        const playerName = typeof body.playerName === 'string' ? body.playerName.trim() : ''
        const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
        if (!playerId) {
          sendJson(res, 400, { ok: false, error: 'Missing playerId' })
          return
        }
        const result = await sendRconCommand(found.profile, `BanPlayer ${playerId}`)
        if (result.ok) recordPlayerBan(playerId, playerName || playerId, reason, found.profile.id)
        sendJson(res, 200, result)
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid request body' }))
    return
  }

  const backupStatusMatch = path.match(/^\/api\/servers\/([^/]+)\/backups\/status$/)
  if (req.method === 'GET' && backupStatusMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(backupStatusMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    const schedule = getBackupScheduleStatus(profile)
    sendJson(res, 200, {
      backupDir: profile.backupDir,
      maxBackups: profile.maxBackups,
      scheduleEnabled: profile.backupScheduleEnabled,
      scheduleCron: profile.backupSchedule ?? '',
      scheduleActive: schedule.active,
      nextRunAt: schedule.nextRunAt,
      // Only rendered into an editable form for an admin+ token (see the Backup tab's
      // backup-settings-section) - readonly-gated like the rest of this route since these two
      // fields on their own aren't sensitive, same as everything else already returned here.
      playerProfileBackupEnabled: profile.playerProfileBackupEnabled,
      playerProfileBackupMaxPerPlayer: profile.playerProfileBackupMaxPerPlayer
    })
    return
  }

  // File browser / raw .ini editor / config history - core logic lives in fileBrowser.ts,
  // shared with the desktop Manager's own IPC handlers (ipc/fileBrowser.ts) so the two
  // surfaces can never disagree on what's safe to read/write/delete. Admin-gated like every
  // other route that can touch arbitrary files on disk (restore/delete backup above) rather
  // than just moderator, since installDir can contain anything (save games, configs, logs)
  // and resolveSafePath only guarantees the path stays inside installDir, not that
  // everything in there is safe to hand out. ARK and Minecraft both have an installDir, so
  // these use findAnyServer rather than ARK-only listProfiles() the way the ban/dino-wipe
  // routes above do.
  const filesListMatch = path.match(/^\/api\/servers\/([^/]+)\/files$/)
  if (req.method === 'GET' && filesListMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(filesListMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    const relativePath = url.searchParams.get('path') ?? ''
    try {
      sendJson(res, 200, listFileBrowserEntries(found.profile.installDir, relativePath))
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  const filesDownloadMatch = path.match(/^\/api\/servers\/([^/]+)\/files\/download$/)
  if (req.method === 'GET' && filesDownloadMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(filesDownloadMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    const relativePath = url.searchParams.get('path') ?? ''
    try {
      sendFileDownload(res, resolveFileBrowserPath(found.profile.installDir, relativePath))
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  const filesDeleteMatch = path.match(/^\/api\/servers\/([^/]+)\/files\/delete$/)
  if (req.method === 'POST' && filesDeleteMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(filesDeleteMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const relativePath = typeof body.path === 'string' ? body.path : ''
        if (!relativePath) {
          sendJson(res, 400, { ok: false, error: 'Missing path' })
          return
        }
        try {
          deleteFileBrowserFile(found.profile.installDir, relativePath)
          sendJson(res, 200, { ok: true })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: (err as Error).message })
        }
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid request body' }))
    return
  }

  const iniMatch = path.match(/^\/api\/servers\/([^/]+)\/ini$/)
  if (req.method === 'GET' && iniMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(iniMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    const relativePath = url.searchParams.get('path') ?? ''
    try {
      sendJson(res, 200, { content: readIniFile(found.profile.installDir, relativePath) })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }
  if (req.method === 'POST' && iniMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(iniMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const relativePath = typeof body.path === 'string' ? body.path : ''
        const content = typeof body.content === 'string' ? body.content : null
        if (!relativePath || content === null) {
          sendJson(res, 400, { ok: false, error: 'Missing path or content' })
          return
        }
        try {
          writeIniFile(found.profile.id, found.profile.installDir, relativePath, content)
          sendJson(res, 200, { ok: true })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: (err as Error).message })
        }
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid request body' }))
    return
  }

  const iniHistoryMatch = path.match(/^\/api\/servers\/([^/]+)\/ini\/history$/)
  if (req.method === 'GET' && iniHistoryMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(iniHistoryMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    const relativePath = url.searchParams.get('path') ?? ''
    sendJson(res, 200, listIniHistory(found.profile.id, relativePath))
    return
  }

  const iniHistoryDiffMatch = path.match(/^\/api\/servers\/([^/]+)\/ini\/history-diff$/)
  if (req.method === 'GET' && iniHistoryDiffMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(iniHistoryDiffMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    const entryId = url.searchParams.get('id') ?? ''
    try {
      sendJson(res, 200, { diff: diffIniHistoryEntry(found.profile.id, found.profile.installDir, entryId) })
    } catch (err) {
      const status = (err as Error).message === 'Unknown history entry' ? 404 : 400
      sendJson(res, status, { error: (err as Error).message })
    }
    return
  }

  const iniRestoreMatch = path.match(/^\/api\/servers\/([^/]+)\/ini\/restore$/)
  if (req.method === 'POST' && iniRestoreMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const found = findAnyServer(decodeURIComponent(iniRestoreMatch[1]))
    if (!found || !hasProfileAccess(auth, found.profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const entryId = typeof body.id === 'string' ? body.id : ''
        try {
          restoreIniHistoryEntry(found.profile.id, found.profile.installDir, entryId)
          sendJson(res, 200, { ok: true })
        } catch (err) {
          const status = (err as Error).message === 'Unknown history entry' ? 404 : 400
          sendJson(res, status, { ok: false, error: (err as Error).message })
        }
      })
      .catch(() => sendJson(res, 400, { ok: false, error: 'Invalid request body' }))
    return
  }

  const backupLogMatch = path.match(/^\/api\/servers\/([^/]+)\/backups\/log$/)
  if (req.method === 'GET' && backupLogMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const profileId = decodeURIComponent(backupLogMatch[1])
    sendJson(res, 200, hasProfileAccess(auth, profileId) ? getBackupLog(profileId) : [])
    return
  }

  const backupRestoreMatch = path.match(/^\/api\/servers\/([^/]+)\/backups\/restore$/)
  if (req.method === 'POST' && backupRestoreMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(backupRestoreMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const filePath = typeof body.filePath === 'string' ? body.filePath : ''
        if (!filePath) {
          sendJson(res, 400, { ok: false, error: 'Missing filePath' })
          return
        }
        restoreBackup(profile, filePath)
        sendJson(res, 200, { ok: true })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  const backupDeleteMatch = path.match(/^\/api\/servers\/([^/]+)\/backups\/delete$/)
  if (req.method === 'POST' && backupDeleteMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    if (!hasProfileAccess(auth, decodeURIComponent(backupDeleteMatch[1]))) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const filePath = typeof body.filePath === 'string' ? body.filePath : ''
        if (!filePath) {
          sendJson(res, 400, { ok: false, error: 'Missing filePath' })
          return
        }
        deleteBackup(filePath)
        sendJson(res, 200, { ok: true })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  const backupsMatch = path.match(/^\/api\/servers\/([^/]+)\/backups$/)
  if (req.method === 'GET' && backupsMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(backupsMatch[1]))
    sendJson(res, 200, profile && hasProfileAccess(auth, profile.id) ? listBackups(profile) : [])
    return
  }
  if (req.method === 'POST' && backupsMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(backupsMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    try {
      const entry = await createBackup(profile)
      sendJson(res, 200, { ok: true, entry })
    } catch (err) {
      sendJson(res, 400, { ok: false, error: (err as Error).message })
    }
    return
  }

  // Player Profile Backups - read-only (same tier as the world backup list above); restoring
  // or deleting one reuses the exact same /backups/restore and /backups/delete routes above,
  // since restoreBackup/deleteBackup only ever take a file path and don't care which kind of
  // backup it came from. No remote equivalent for the desktop tab's "Open backup folder"
  // button, same as everywhere else a local file-system dialog would be needed.
  const playerBackupFoldersMatch = path.match(/^\/api\/servers\/([^/]+)\/playerbackups\/folders$/)
  if (req.method === 'GET' && playerBackupFoldersMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(playerBackupFoldersMatch[1]))
    sendJson(res, 200, profile && hasProfileAccess(auth, profile.id) ? listPlayerBackupFolders(profile) : [])
    return
  }

  const playerBackupsMatch = path.match(/^\/api\/servers\/([^/]+)\/playerbackups$/)
  if (req.method === 'GET' && playerBackupsMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(playerBackupsMatch[1]))
    const folderKey = url.searchParams.get('folder') ?? ''
    sendJson(res, 200, profile && folderKey && hasProfileAccess(auth, profile.id) ? listPlayerBackups(profile, folderKey) : [])
    return
  }

  // ---- Admin-only remote control: Settings/Mods/Map Management/Update Log - lets an
  // admin-scoped token do everything the desktop Manager's own per-server tabs can, without
  // local file-system access (no directory/file picker dialogs, no "open folder" - those are
  // desktop-only conveniences with no remote equivalent). Server Management has its own
  // narrower, moderator-accessible route pair further down.

  const profileMatch = path.match(/^\/api\/servers\/([^/]+)\/profile$/)
  if (req.method === 'GET' && profileMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(profileMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    sendJson(res, 200, profile)
    return
  }
  if (req.method === 'POST' && profileMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = getProfile(decodeURIComponent(profileMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        // id never changes, regardless of what the body sends - every other field is fair
        // game, matching what the desktop Manager's own Settings/Server Management/Mods
        // tabs can already do to this same profile via profiles.save.
        const updated = saveProfile({ ...profile, ...body, id: profile.id } as ServerProfile)
        const saved = updated.find((p) => p.id === profile.id)
        if (saved) applyProfileSideEffects(saved, typeof body === 'object' && body !== null && 'mods' in body)
        sendJson(res, 200, { ok: true, profile: saved })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  // CurseForge key presence only - never the key itself - so the Mods tab's client JS can
  // show/hide the search section the same way the desktop app's ModsTab does, without any
  // route needing to leak the actual secret.
  if (req.method === 'GET' && path === '/api/arkmods/status') {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    sendJson(res, 200, { hasCurseForgeKey: getSettings().curseforgeApiKey.trim().length > 0 })
    return
  }

  const arkModsSearchMatch = path.match(/^\/api\/servers\/([^/]+)\/mods\/search$/)
  if (req.method === 'GET' && arkModsSearchMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(arkModsSearchMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    const query = url.searchParams.get('q') ?? ''
    const hits = await searchArkMods(query)
    sendJson(res, 200, hits)
    return
  }

  const arkModsInfoMatch = path.match(/^\/api\/servers\/([^/]+)\/mods\/info$/)
  if (req.method === 'POST' && arkModsInfoMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(arkModsInfoMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then(async (body) => {
        const modIds = typeof body === 'object' && body !== null && Array.isArray((body as { modIds?: unknown }).modIds)
          ? ((body as { modIds: unknown[] }).modIds.filter((id): id is string => typeof id === 'string'))
          : []
        const info = await getArkModsInfo(modIds)
        sendJson(res, 200, info)
      })
      .catch((err: Error) => sendJson(res, 400, { error: err.message }))
    return
  }

  // ---- Minecraft-specific remote control: separate route names (mc-startsettings/
  // mc-serversettings/mc-mods/mc-backups/mc-management) from their ARK counterparts above
  // (profile/mods/backups/servermanagement), same "one route per game's own shape" precedent
  // as /profile itself - mirrors the desktop Manager's own separate MinecraftServerDetail tab
  // set (Start Settings/Server Settings/Mods/Backup/Server Management) rather than trying to
  // force a MinecraftProfile through ARK's ServerProfile-shaped routes. Role tiers per tab
  // match what the web dashboard's own sidebar shows a moderator: Start Settings and Mods stay
  // admin+ only (same tier as ARK's Settings/Mods); Server Settings, Backup, and Server
  // Management are moderator+ (Backup's restore/delete still admin+, matching ARK's own
  // backups/restore and backups/delete routes above).

  // Feeds MC Start Settings' own Minecraft-version/loader-version pickers - same
  // window.api.minecraft.install.listVersions/listLoaderVersions functions the desktop app's
  // Install dialog and Start Settings tab call directly over IPC (both run in the main
  // process already, no IPC boundary there); the web dashboard needs these as plain HTTP
  // routes instead. Not server-scoped (no /api/servers/:id prefix) - the picker only needs a
  // serverType (and, for the second one, a minecraftVersion), not which server is selected.
  const mcInstallVersionsMatch = path === '/api/mc-install/versions'
  if (req.method === 'GET' && mcInstallVersionsMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const serverType = url.searchParams.get('serverType') as MinecraftInstallableType | null
    if (!serverType) {
      sendJson(res, 400, { error: 'serverType is required' })
      return
    }
    try {
      sendJson(res, 200, await listInstallableMinecraftVersions(serverType))
    } catch (err) {
      sendJson(res, 502, { error: (err as Error).message })
    }
    return
  }

  const mcInstallLoaderVersionsMatch = path === '/api/mc-install/loaderversions'
  if (req.method === 'GET' && mcInstallLoaderVersionsMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const serverType = url.searchParams.get('serverType') as MinecraftInstallableType | null
    const minecraftVersion = url.searchParams.get('minecraftVersion')
    if (!serverType || !minecraftVersion) {
      sendJson(res, 400, { error: 'serverType and minecraftVersion are required' })
      return
    }
    try {
      sendJson(res, 200, await listInstallableLoaderVersions(serverType, minecraftVersion))
    } catch (err) {
      sendJson(res, 502, { error: (err as Error).message })
    }
    return
  }

  const mcStartSettingsMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-startsettings$/)
  if (req.method === 'GET' && mcStartSettingsMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcStartSettingsMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    sendJson(res, 200, profile)
    return
  }
  if (req.method === 'POST' && mcStartSettingsMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcStartSettingsMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const updated = saveMinecraftProfile({ ...profile, ...body, id: profile.id } as MinecraftProfile)
        const saved = updated.find((p) => p.id === profile.id)
        sendJson(res, 200, { ok: true, profile: saved })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  const mcServerSettingsMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-serversettings$/)
  if (req.method === 'GET' && mcServerSettingsMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcServerSettingsMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    sendJson(res, 200, readMinecraftServerProperties(profile.installDir))
    return
  }
  if (req.method === 'POST' && mcServerSettingsMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcServerSettingsMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const updates: Record<string, string> = {}
        for (const [key, value] of Object.entries(body)) {
          if (typeof value === 'string') updates[key] = value
        }
        upsertMinecraftServerPropertiesKeys(profile.installDir, updates)
        sendJson(res, 200, { ok: true, properties: readMinecraftServerProperties(profile.installDir) })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  const MC_MANAGEMENT_FIELDS = [
    'startOnManagerLaunch',
    'scheduledRestartEnabled',
    'scheduledRestartTime',
    'scheduledRestartDays',
    'scheduledRestartStartAfter'
  ] as const
  function pickMcManagementFields(profile: MinecraftProfile): Record<string, unknown> {
    const picked: Record<string, unknown> = {}
    for (const field of MC_MANAGEMENT_FIELDS) picked[field] = profile[field]
    return picked
  }

  const mcManagementMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-management$/)
  if (req.method === 'GET' && mcManagementMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcManagementMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    sendJson(res, 200, pickMcManagementFields(profile))
    return
  }
  if (req.method === 'POST' && mcManagementMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcManagementMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const picked: Record<string, unknown> = {}
        for (const field of MC_MANAGEMENT_FIELDS) {
          if (field in body) picked[field] = body[field]
        }
        const updated = saveMinecraftProfile({ ...profile, ...picked, id: profile.id } as MinecraftProfile)
        const saved = updated.find((p) => p.id === profile.id)
        sendJson(res, 200, { ok: true, profile: saved && pickMcManagementFields(saved) })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  const mcBackupLogMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-backups\/log$/)
  if (req.method === 'GET' && mcBackupLogMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const profileId = decodeURIComponent(mcBackupLogMatch[1])
    sendJson(res, 200, hasProfileAccess(auth, profileId) ? getMinecraftBackupLog(profileId) : [])
    return
  }

  const mcBackupRestoreMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-backups\/restore$/)
  if (req.method === 'POST' && mcBackupRestoreMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcBackupRestoreMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const filePath = typeof body.filePath === 'string' ? body.filePath : ''
        if (!filePath) {
          sendJson(res, 400, { ok: false, error: 'Missing filePath' })
          return
        }
        restoreMinecraftBackup(profile, filePath)
        sendJson(res, 200, { ok: true })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  const mcBackupDeleteMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-backups\/delete$/)
  if (req.method === 'POST' && mcBackupDeleteMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    if (!hasProfileAccess(auth, decodeURIComponent(mcBackupDeleteMatch[1]))) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const filePath = typeof body.filePath === 'string' ? body.filePath : ''
        if (!filePath) {
          sendJson(res, 400, { ok: false, error: 'Missing filePath' })
          return
        }
        deleteMinecraftBackup(filePath)
        sendJson(res, 200, { ok: true })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  const mcBackupsMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-backups$/)
  if (req.method === 'GET' && mcBackupsMatch) {
    const auth = await requireRole(req, res, 'readonly')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcBackupsMatch[1]))
    sendJson(res, 200, profile && hasProfileAccess(auth, profile.id) ? listMinecraftBackups(profile) : [])
    return
  }
  if (req.method === 'POST' && mcBackupsMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcBackupsMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    try {
      const entry = await createMinecraftBackup(profile)
      sendJson(res, 200, { ok: true, entry })
    } catch (err) {
      sendJson(res, 400, { ok: false, error: (err as Error).message })
    }
    return
  }

  const mcModsSearchMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-mods\/search$/)
  if (req.method === 'GET' && mcModsSearchMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcModsSearchMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    try {
      const ecosystem = (url.searchParams.get('ecosystem') as MinecraftModEcosystem) || 'mods'
      const hits = await searchMinecraftMods(profile, url.searchParams.get('q') ?? '', ecosystem)
      sendJson(res, 200, hits)
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  const mcModsUpdateCheckMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-mods\/updatecheck$/)
  if (req.method === 'GET' && mcModsUpdateCheckMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcModsUpdateCheckMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    try {
      sendJson(res, 200, await checkMinecraftModUpdates(profile))
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  const mcModsInstallMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-mods\/install$/)
  if (req.method === 'POST' && mcModsInstallMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcModsInstallMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then(async (body) => {
        const source = body.source as MinecraftModSource
        const projectId = typeof body.projectId === 'string' ? body.projectId : ''
        const ecosystem = (body.ecosystem as MinecraftModEcosystem) || 'mods'
        const { profile: updated, result } = await installMinecraftMod(profile, source, projectId, ecosystem)
        sendJson(res, 200, { ok: true, installedMods: updated.installedMods, result })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  const mcModsRemoveMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-mods\/remove$/)
  if (req.method === 'POST' && mcModsRemoveMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcModsRemoveMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const projectId = typeof body.projectId === 'string' ? body.projectId : ''
        const updated = removeMinecraftMod(profile, projectId)
        sendJson(res, 200, { ok: true, installedMods: updated.installedMods })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  const mcModsEnabledMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-mods\/enabled$/)
  if (req.method === 'POST' && mcModsEnabledMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcModsEnabledMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const projectId = typeof body.projectId === 'string' ? body.projectId : ''
        const updated = setMinecraftModEnabled(profile, projectId, body.enabled === true)
        sendJson(res, 200, { ok: true, installedMods: updated.installedMods })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  const mcModsRescanMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-mods\/rescan$/)
  if (req.method === 'POST' && mcModsRescanMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcModsRescanMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    try {
      const { profile: updated, result } = await scanForInstalledMods(profile)
      sendJson(res, 200, { ok: true, installedMods: updated.installedMods, result })
    } catch (err) {
      sendJson(res, 400, { ok: false, error: (err as Error).message })
    }
    return
  }

  const mcModsMatch = path.match(/^\/api\/servers\/([^/]+)\/mc-mods$/)
  if (req.method === 'GET' && mcModsMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = getMinecraftProfile(decodeURIComponent(mcModsMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    sendJson(res, 200, profile.installedMods)
    return
  }

  // ---- Moderator-accessible remote control: Server Management only - a narrow whitelist of
  // the same ServerProfile fields the Server Management tab edits, kept as its own route (not
  // the admin-only /profile route above) so a moderator token gets this one tab without also
  // reaching Settings/Mods/Map Management/Update Log, which stay admin+.
  const SERVER_MANAGEMENT_FIELDS = [
    'startOnManagerLaunch',
    'crashWatchEnabled',
    'zombieDetectionEnabled',
    'zombieDetectionTimeoutMinutes',
    'zombieDetectionAutoRestart',
    'clusterLogArchiveMaxSizeMB',
    'scheduledRestartEnabled',
    'scheduledRestartTime',
    'scheduledRestartDays',
    'scheduledRestartUpdateAfter',
    'scheduledRestartStartAfter',
    'scheduledDinoWipeEnabled',
    'scheduledDinoWipeTime',
    'scheduledDinoWipeDays'
  ] as const
  function pickServerManagementFields(profile: ServerProfile): Record<string, unknown> {
    const picked: Record<string, unknown> = {}
    for (const field of SERVER_MANAGEMENT_FIELDS) picked[field] = profile[field]
    return picked
  }

  const serverManagementMatch = path.match(/^\/api\/servers\/([^/]+)\/servermanagement$/)
  if (req.method === 'GET' && serverManagementMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(serverManagementMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    sendJson(res, 200, pickServerManagementFields(profile))
    return
  }
  if (req.method === 'POST' && serverManagementMatch) {
    const auth = await requireRole(req, res, 'moderator')
    if (!auth) return
    const profile = getProfile(decodeURIComponent(serverManagementMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        // Only the whitelisted Server Management fields are accepted here, regardless of what
        // else the body contains - everything else stays reachable only through the admin-only
        // /profile route above.
        const patch: Record<string, unknown> = {}
        for (const field of SERVER_MANAGEMENT_FIELDS) {
          if (field in body) patch[field] = body[field]
        }
        const updated = saveProfile({ ...profile, ...patch, id: profile.id } as ServerProfile)
        const saved = updated.find((p) => p.id === profile.id)
        // Server Management's field whitelist never includes 'mods', so this save never needs
        // to touch the ini.
        if (saved) applyProfileSideEffects(saved, false)
        sendJson(res, 200, { ok: true, profile: saved && pickServerManagementFields(saved) })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  const updateLogMatch = path.match(/^\/api\/servers\/([^/]+)\/update-log$/)
  if (req.method === 'GET' && updateLogMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profileId = decodeURIComponent(updateLogMatch[1])
    if (!listProfiles().some((p) => p.id === profileId) || !hasProfileAccess(auth, profileId)) {
      sendJson(res, 404, { log: null })
      return
    }
    sendJson(res, 200, { log: readUpdateLog(profileId) })
    return
  }

  if (req.method === 'GET' && path === '/api/maps') {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    // Web Dashboard's Settings tab editing isn't wired up for a second game yet (desktop-only
    // for now - see shared/games.ts) - always ARK: Survival Ascended's list here regardless
    // of which server is selected, same as before this param existed.
    const game = (url.searchParams.get('game') as GameId) ?? 'ark-ascended'
    sendJson(res, 200, { maps: listMaps(game), customMaps: listCustomMaps() })
    return
  }

  const mapFoldersMatch = path.match(/^\/api\/servers\/([^/]+)\/mapfolders$/)
  if (req.method === 'GET' && mapFoldersMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(mapFoldersMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { error: 'Unknown server' })
      return
    }
    try {
      sendJson(res, 200, listMapFolders(profile))
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }
  if (req.method === 'POST' && mapFoldersMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(mapFoldersMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const folderName = typeof body.folderName === 'string' ? body.folderName : ''
        const fileName = typeof body.fileName === 'string' ? body.fileName : ''
        if (!folderName.trim() || !fileName.trim()) {
          sendJson(res, 400, { ok: false, error: 'Missing folderName/fileName' })
          return
        }
        createMapFolder(profile, folderName, fileName)
        sendJson(res, 200, { ok: true })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  const mapFoldersDeleteMatch = path.match(/^\/api\/servers\/([^/]+)\/mapfolders\/delete$/)
  if (req.method === 'POST' && mapFoldersDeleteMatch) {
    const auth = await requireRole(req, res, 'admin')
    if (!auth) return
    const profile = listProfiles().find((p) => p.id === decodeURIComponent(mapFoldersDeleteMatch[1]))
    if (!profile || !hasProfileAccess(auth, profile.id)) {
      sendJson(res, 404, { ok: false, error: 'Unknown server' })
      return
    }
    readJsonBody(req)
      .then((body) => {
        const folderName = typeof body.folderName === 'string' ? body.folderName : ''
        if (!folderName.trim()) {
          sendJson(res, 400, { ok: false, error: 'Missing folderName' })
          return
        }
        deleteMapFolder(profile, folderName)
        sendJson(res, 200, { ok: true })
      })
      .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found')
}

export function stopWebDashboard(): void {
  if (server) {
    server.close()
    server = null
  }
}

/** Starts the web dashboard bound to `host` - '127.0.0.1' (default) keeps it reachable
 *  from this machine only; '0.0.0.0' or a specific local IP makes it reachable from other
 *  devices on the LAN. By default this page has no authentication of its own (same posture
 *  as the standalone Python dashboard it replaces), so widening the host is a deliberate
 *  choice made in Settings, never a default - unless "Require access token" is also turned
 *  on, in which case every route is gated behind a valid token and the server switches to
 *  HTTPS with a self-signed certificate, since a token shouldn't travel in the clear. */
export function startWebDashboard(port: number, host: string): void {
  stopWebDashboard()
  lastError = null
  lastHost = host
  const authEnabled = getSettings().webDashboardAuthEnabled
  if (authEnabled && listWebDashboardAccessTokens().length === 0) {
    lastError = 'Add at least one access token in Settings before enabling it.'
    return
  }
  if (authEnabled) {
    const { key, cert } = getOrCreateCert()
    server = https.createServer({ key, cert }, handleRequest)
  } else {
    server = http.createServer(handleRequest)
  }
  server.on('error', (err) => {
    lastError = (err as Error).message
    server = null
  })
  server.listen(port, host)
}

export function applyWebDashboardSettings(settings: AppSettings): void {
  if (settings.webDashboardEnabled) startWebDashboard(settings.webDashboardPort, settings.webDashboardHost || '127.0.0.1')
  else stopWebDashboard()
}

export function getWebDashboardStatus(): { running: boolean; error: string | null; host: string | null } {
  return { running: server !== null, error: lastError, host: server ? lastHost : null }
}

/** Non-internal IPv4 addresses of this machine, so Settings can suggest what to type into
 *  the Host field for LAN access instead of the user having to look it up themselves. */
export function getLocalNetworkIps(): string[] {
  const ips: string[] = []
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const addr of addresses ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address)
    }
  }
  return ips
}

/** Splices whether an access token is required at all into the page as
 *  `window.__authRequired` - unlike the old session-cookie design, the server can't know
 *  up front whether *this* browser already has a valid token (it lives only in that
 *  browser's own `localStorage`, never sent until the client's own JS attaches it), so the
 *  same page is always served either way; the client validates any stored token itself via
 *  `GET /api/whoami` once loaded (see the token-gate logic in the client `<script>` below)
 *  and only then learns its role. This flag is not sensitive - it's just "does this
 *  dashboard require a token", not a credential.
 *
 *  Also cache-busts the favicon link's own URL with the icon's content hash (reusing
 *  getFaviconBuffer's cached ETag, so this costs nothing beyond the one string op below) -
 *  found necessary after a real report that a fixed favicon that had been genuinely broken
 *  (served a 404) for a while still didn't show up in a browser even after a hard refresh and
 *  a fresh private window. The server side was already confirmed correct by then (a direct,
 *  cold fetch of /favicon.png returns a real 200 with the right PNG bytes), which points at
 *  Chromium's favicon handling specifically: unlike the page itself, favicons are tracked in
 *  their own on-disk database keyed by icon URL rather than going through the normal HTTP
 *  cache, and that store is well known to ignore ordinary cache-busting (ETag/Cache-Control)
 *  and even to survive into private windows in some versions - a browser that ever saw
 *  /favicon.png 404 can keep "no icon" pinned to that exact URL indefinitely. Serving the icon
 *  at a URL the browser has never requested before (the query string here, not the path -
 *  routing above matches on pathname only) is the one thing that reliably forces a fresh fetch
 *  regardless of whatever the favicon database already has cached for the plain path.
 *
 *  Same treatment for the two static sidebar game-switch <img> tags (ark-evolved.png,
 *  minecraft.png) - a real follow-up report ("still no icons on the cards or buttons either")
 *  turned out to be these two plus the per-card gameIconUrl in /api/servers (see that route's
 *  own use of the gameIconUrl() helper): ordinary <img> tags, not favicons, but hit by the
 *  exact same root cause - these are just as fixed a URL, just as likely to have been
 *  requested once already (and cached as a broken image) by a browser that saw the same
 *  pre-current_dir-fix 404 the favicon did. */
function renderDashboardHtml(authRequired: boolean): string {
  let html = DASHBOARD_HTML
  const favicon = getFaviconBuffer()
  if (favicon) {
    html = html.replace('href="/favicon.png"', `href="/favicon.png?v=${favicon.etag.replace(/"/g, '')}"`)
  }
  html = html
    .replace('src="/game-icons/ark-evolved.png"', `src="${gameIconUrl('ark-evolved.png')}"`)
    .replace('src="/game-icons/minecraft.png"', `src="${gameIconUrl(MINECRAFT_ICON_FILE_NAME)}"`)
  if (!authRequired) return html
  return html.replace('<script>', '<script>window.__authRequired = true;</script>\n<script>')
}


const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Bober Server Manager - Web Console</title>
<link rel="icon" type="image/png" href="/favicon.png" />
<style>
  :root {
    color-scheme: dark;
    --bg: #14161a; --panel: #1d2027; --border: #2c303a; --text: #e6e8ec; --muted: #9aa0ab;
    --accent: #4f8cff; --danger: #e0555b; --danger-dark: #8f2c30; --ok: #3fbf6f; --warn: #e0a63f; --cyan: #22d3ee;
    --purple: #a78bfa; --pink: #f472b6;
    --status-running: #1f8a4c; --status-starting: #7ee6a0; --status-updating: #6fa8ff;
    --status-stopping: #f2878b; --status-stopped: #a83239; --status-restarting: #e0a63f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    display: flex; height: 100vh; overflow: hidden;
  }
  #token-gate {
    display: none; position: fixed; inset: 0; z-index: 1000; background: var(--bg);
    align-items: center; justify-content: center;
  }
  #token-gate form { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 28px; width: 320px; display: flex; flex-direction: column; gap: 12px; }
  #token-gate h1 { font-size: 1.05rem; margin: 0 0 4px; }
  #token-gate input, #token-gate button { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 9px 10px; font-size: 0.95rem; }
  #token-gate button { cursor: pointer; background: var(--accent); border-color: var(--accent); color: #fff; }
  #token-gate button:disabled { opacity: 0.6; cursor: not-allowed; }
  #token-gate-error { color: var(--danger); font-size: 0.85rem; min-height: 1.1em; }
  #sidebar { width: 190px; flex-shrink: 0; border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 16px 10px; gap: 4px; overflow-y: auto; }
  #sidebar h1 { font-size: 0.95rem; margin: 0 6px 12px; }
  /* The ARK/Minecraft switch - its own small group at the top of the sidebar, visually
     separate (a divider below it) from whatever page nav follows, since it toggles which
     entire .nav-group is shown rather than navigating within one - same component and same
     styling as the desktop Manager's own GameSwitch (src/renderer/src/App.tsx). */
  .app-sidebar-game-switch { display: flex; gap: 4px; padding: 0 6px 14px; margin-bottom: 6px; border-bottom: 1px solid var(--border); }
  .app-sidebar-game-switch button { flex: 1; display: flex; align-items: center; justify-content: center; text-align: center; border: 1px solid var(--border); border-radius: 6px; padding: 6px; background: transparent; }
  .app-sidebar-game-switch button img { width: 28px; height: 28px; object-fit: contain; opacity: 0.55; }
  .app-sidebar-game-switch button.active { border-color: var(--accent); background: rgba(79, 140, 255, 0.15); color: var(--text); }
  .app-sidebar-game-switch button.active img { opacity: 1; }
  .nav-group { display: flex; flex-direction: column; gap: 4px; }
  .nav-btn { text-align: left; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 9px 10px; font-size: 0.88rem; }
  .nav-btn:hover { border-color: var(--border); }
  .nav-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .nav-btn.active:hover { border-color: var(--accent); }
  .nav-sep { width: 100%; border: none; border-top: 1px solid var(--border); margin: 6px 0; }
  .nav-logout { margin-top: auto; color: var(--muted); }
  #main-area { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .view { display: none; flex: 1; min-height: 0; }
  .view.active { display: flex; flex-direction: column; }
  #view-cluster.active { display: flex; flex-direction: column; padding: 16px; min-height: 0; }
  #cluster-groups { flex: 1; overflow-y: auto; }
  #cluster-cards { display: flex; flex-direction: column; gap: 24px; }
  .cluster-group summary { cursor: pointer; color: var(--muted); font-weight: 600; margin-bottom: 12px; }
  .cluster-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 18px; }
  .cluster-card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px; cursor: pointer; }
  .cluster-card:hover { border-color: var(--accent); }
  .cluster-card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
  .cluster-card-header h3 { margin: 0; font-size: 1.05rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cluster-card-state { flex-shrink: 0; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; padding: 3px 9px; border-radius: 999px; border: 1px solid currentColor; }
  .cluster-card-state.state-running { color: var(--status-running); }
  .cluster-card-state.state-starting { color: var(--status-starting); }
  .cluster-card-state.state-updating { color: var(--status-updating); }
  .cluster-card-state.state-stopping { color: var(--status-stopping); }
  .cluster-card-state.state-stopped { color: var(--status-stopped); }
  .cluster-card-state.state-restarting { color: var(--status-restarting); }
  .cluster-card-state.state-error { color: var(--danger); }
  .cluster-card-stats { display: flex; flex-direction: column; gap: 6px; font-size: 0.92rem; color: var(--muted); }
  .cluster-card-stats strong { color: var(--text); font-weight: 600; }
  .group-row-online { color: var(--status-running); font-weight: 700; }
  .status-ok { color: var(--status-running); }
  .status-warn { color: var(--danger); }
  .status-offline { color: var(--status-stopping); }
  .group-row-online .group-row-offline { color: var(--muted); font-weight: 400; }
  #cluster-groups.hidden { display: none; }
  .cluster-time-scale { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; font-size: 0.85rem; color: var(--muted); }
  .analytics-stats-toggle { margin-left: auto; }
  .time-scale-btn { padding: 3px 10px; font-size: 0.8rem; }
  .time-scale-btn.active { color: var(--ok); border-color: var(--ok); }
  .cluster-card-chart { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
  .stats-chart-label { display: flex; justify-content: space-between; font-size: 0.7rem; color: var(--muted); }
  .stats-chart-label strong { color: var(--text); }
  .stats-chart-svg-wrap { position: relative; height: 30px; }
  .stats-chart-svg { width: 100%; height: 100%; display: block; }
  .stats-chart-hover-line { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--border); pointer-events: none; }
  .stats-chart-tooltip { position: absolute; top: -20px; transform: translateX(-50%); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; font-size: 0.65rem; white-space: nowrap; pointer-events: none; }
  #cluster-console { display: none; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }
  #cluster-console.active { display: flex; }
  .cluster-console-header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .cluster-console-header h2 { margin: 0; font-size: 1.05rem; flex: 1; }
  .cluster-console-header button { font-size: 0.8rem; padding: 4px 8px; flex-shrink: 0; }
  /* Reuses the Dashboard view's own .content-row/.panel/.console-panel/.side-col - same
     two-column-on-desktop, stacked-and-collapsible-on-mobile layout as the single-server
     console, so the group console gets the same "console takes the room, side info is a
     collapsible column" shape for free instead of a second bespoke layout. */
  #cluster-console .content-row { flex: 1; min-height: 0; }
  .cluster-console-feed { flex: 1; overflow-y: auto; font-size: 0.82rem; font-family: Consolas, Menlo, monospace; min-height: 200px; }
  .log-event .server-tag { color: #2dd4bf; margin-right: 8px; }
  .log-event-start .label, .log-event-start .text { color: var(--status-running); }
  .log-event-stop .label, .log-event-stop .text { color: var(--status-stopped); }
  .log-event-update .label, .log-event-update .text { color: var(--status-updating); }
  .cluster-console-rcon-form { display: flex; gap: 8px; margin-top: 8px; }
  .cluster-console-rcon-form input, .cluster-console-rcon-form button, .cluster-console-rcon-form select { padding: 10px 14px; font-size: 1rem; border-radius: 8px; }
  .cluster-console-rcon-form select { flex: 0 0 auto; max-width: 40%; }
  .cluster-console-rcon-form input { flex: 1; }
  .cluster-console-rcon-results { font-size: 0.85rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; max-height: 120px; overflow-y: auto; margin-top: 8px; }
  .cluster-console-rcon-results p { margin: 2px 0; }
  .rcon-result-ok { color: var(--ok); }
  .rcon-result-error { color: var(--danger); }
  .cluster-console-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; flex-shrink: 0; }
  .cluster-console-stats div { display: flex; flex-direction: column; gap: 2px; }
  .cluster-console-stats dt { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; }
  .cluster-console-stats dd { margin: 0; font-size: 1rem; font-weight: 600; }
  #cluster-console-sidecol { overflow-y: auto; }
  .server-card-mobile { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
  .server-card-mobile-header { display: flex; align-items: center; gap: 8px; }
  .server-card-mobile-game-icon { width: 18px; height: 18px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
  .server-card-mobile-header h3 { margin: 0; flex: 1; font-size: 0.98rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .server-card-mobile-menu-btn { flex-shrink: 0; padding: 6px 11px; font-size: 1.1rem; line-height: 1; }
  .server-card-mobile-stats { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; color: var(--muted); }
  .server-card-mobile-stats strong { color: var(--text); font-weight: 600; }
  #dashboard-cards { display: flex; flex-direction: column; gap: 20px; }
  .dashboard-group-label { margin: 0 0 8px; font-size: 0.8rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .dashboard-group-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 340px)); gap: 16px; }
  .dashboard-group-grid .server-card-mobile { cursor: pointer; }
  /* Card-v2 - same markup/classes as the desktop Manager's own Dashboard.tsx card
     (src/renderer/src/styles.css), used for the Dashboard and Minecraft Servers card grids
     (not Cluster Dashboard, which mirrors its own desktop reference, ClusterDataView.tsx's
     row-list-with-inline-chart layout instead, nor the Cluster Console sidebar, which mirrors
     GroupConsoleView.tsx's own compact summary card - so .server-card-mobile above stays as
     it is for those two). */
  .server-card-v2 { position: relative; background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--status-stopped); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 9px; }
  .server-card-v2.status-running { border-left-color: var(--status-running); }
  .server-card-v2.status-starting { border-left-color: var(--status-starting); }
  .server-card-v2.status-updating { border-left-color: var(--status-updating); }
  .server-card-v2.status-stopping { border-left-color: var(--status-stopping); }
  .server-card-v2.status-restarting { border-left-color: var(--warn); }
  .server-card-v2.status-error { border-left-color: var(--danger); }
  .server-card-v2-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; }
  .server-card-v2-title { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; min-width: 0; }
  .server-card-v2-title h3 { margin: 0; font-size: 1rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .server-card-game-icon { width: 20px; height: 20px; border-radius: 5px; object-fit: cover; flex-shrink: 0; }
  .server-version { font-size: 0.7rem; font-weight: 400; color: var(--muted); flex-shrink: 0; }
  .header-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .card-menu-btn { padding: 2px 7px; font-size: 1rem; line-height: 1; }
  .card-menu-dropdown { position: absolute; top: 40px; right: 14px; z-index: 20; width: 230px; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 6px; display: none; flex-direction: column; box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45); }
  .card-menu-dropdown.open { display: flex; }
  .card-menu-group { display: flex; flex-direction: column; padding: 4px 0; }
  .card-menu-group + .card-menu-group { border-top: 1px solid var(--border); }
  .card-menu-dropdown button { all: unset; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; font-size: 0.85rem; color: var(--text); }
  .card-menu-icon { flex-shrink: 0; }
  .card-menu-dropdown button:hover { background: var(--bg); }
  .card-menu-dropdown button.danger { color: var(--danger); }
  .stat-tile-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .stat-tile { background: var(--bg); border: 1px solid var(--border); border-radius: 7px; padding: 6px 7px; }
  .stat-tile-label { font-size: 0.65rem; color: var(--muted); }
  .stat-tile-value { font-size: 0.82rem; font-weight: 600; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action-row { display: flex; gap: 5px; }
  .action-row button { flex: 1; padding: 6px 0; font-size: 0.95rem; line-height: 1; }
  .action-row button.start { color: var(--ok); border-color: var(--ok); }
  .action-row button.stop { color: var(--danger); border-color: var(--danger); }
  .action-row button.restart { color: var(--warn); border-color: var(--warn); }
  .action-row button.update { color: var(--accent); border-color: var(--accent); }
  .action-row button.kill { color: var(--danger-dark); border-color: var(--danger-dark); }
  .icon-mask { display: inline-block; width: 13px; height: 13px; background-color: currentColor; -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat; -webkit-mask-position: center; mask-size: contain; mask-repeat: no-repeat; mask-position: center; }
  .badge { padding: 2px 10px; border-radius: 999px; font-size: 0.75rem; text-transform: uppercase; border: 1px solid var(--border); flex-shrink: 0; }
  .badge-running { color: var(--status-running); border-color: var(--status-running); }
  .badge-starting { color: var(--status-starting); border-color: var(--status-starting); }
  .badge-updating { color: var(--status-updating); border-color: var(--status-updating); }
  .badge-stopping { color: var(--status-stopping); border-color: var(--status-stopping); }
  .badge-stopped { color: var(--status-stopped); border-color: var(--status-stopped); }
  .badge-restarting { color: var(--warn); border-color: var(--warn); }
  .badge-error { color: var(--danger); border-color: var(--danger); }
  /* Per-server "Manage" shell - the grouped side nav wrapping the console/analytics/.../
     mc-management sections, same classes as the desktop Manager's own Settings/ServerDetail
     left nav (src/renderer/src/styles.css's .settings-nav block). */
  #view-server-detail.view.active { display: flex; flex-direction: column; }
  .settings-shell { display: flex; flex: 1; min-height: 0; }
  .settings-nav { width: 220px; flex-shrink: 0; padding: 0 10px 24px; border-right: 1px solid var(--border); overflow-y: auto; }
  .settings-nav-group + .settings-nav-group { margin-top: 18px; }
  .settings-nav-group-label { padding: 0 10px 6px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; color: var(--muted); }
  .settings-nav button { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: none; border-radius: 8px; padding: 8px 10px; color: var(--muted); font-size: 0.88rem; }
  .settings-nav button:hover { background: var(--bg); color: var(--text); }
  .settings-nav button.active { background: rgba(79, 140, 255, 0.15); color: var(--text); font-weight: 600; }
  .settings-nav-icon { flex-shrink: 0; }
  .settings-content { flex: 1; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; }
  .settings-content .view { flex: 1; min-height: 0; }
  .action-sheet { position: fixed; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 6px; z-index: 1000; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); min-width: 170px; }
  .action-sheet button { display: block; width: 100%; text-align: left; border: none; background: none; padding: 9px 12px; border-radius: 6px; font-size: 0.9rem; }
  .action-sheet button:hover:not(:disabled) { background: var(--bg); }
  .action-sheet button.ok { color: var(--ok); }
  .action-sheet button.danger { color: var(--danger); }
  .action-sheet button.warn { color: var(--warn); }
  .action-sheet button.info { color: var(--accent); }
  .action-sheet button.cyan { color: var(--cyan); }
  header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { flex-shrink: 0; }
  .server-picker { margin-left: auto; min-width: 140px; }
  header h1 { font-size: 1rem; margin: 0; }
  select, input, button { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 0.9rem; }
  button { cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button:disabled:hover { border-color: var(--border); }
  #server-actions { display: flex; gap: 6px; }
  #server-actions button.ok { border-color: var(--ok); color: var(--ok); }
  #server-actions button.ok:hover:not(:disabled) { background: var(--ok); color: #14161a; }
  #server-actions button.danger { border-color: var(--danger); color: var(--danger); }
  #server-actions button.danger:hover:not(:disabled) { background: var(--danger); color: #14161a; }
  #server-actions button.info { border-color: var(--accent); color: var(--accent); }
  #server-actions button.info:hover:not(:disabled) { background: var(--accent); color: #14161a; }
  #server-actions button.warn { border-color: var(--warn); color: var(--warn); }
  #server-actions button.warn:hover:not(:disabled) { background: var(--warn); color: #14161a; }
  main { flex: 1; display: flex; flex-direction: column; padding: 12px 16px; min-height: 0; }
  .panel { flex: 1; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; min-height: 0; }
  #console { flex: 1; overflow-y: auto; font-size: 0.82rem; font-family: Consolas, Menlo, monospace; min-height: 200px; }
  /* Deliberately not a flex row: letting ts/label/text flow as regular inline content
     means a wrapped line breaks back to the panel's own left edge, not indented under
     wherever the text happened to start - much more readable on a narrow phone screen. */
  .log-event { padding: 3px 0; line-height: 1.4; }
  .log-event .ts { color: var(--muted); margin-right: 8px; }
  .log-event .label { font-weight: 700; margin-right: 8px; }
  .log-event .text { white-space: pre-wrap; word-break: break-word; }
  .log-event-join .label, .log-event-ready .label { color: #1f8a4c; }
  .log-event-leave .label { color: #a83239; }
  .log-event-save .label { color: var(--muted); }
  .log-event-cmd .label, .log-event-freeze .label { color: var(--accent); }
  .log-event-warn .label, .log-event-mission .label { color: var(--warn); }
  .log-event-kill .label { color: var(--danger); }
  .log-event-tame .label { color: var(--ok); }
  .log-event-rcon-cmd .label { color: var(--accent); }
  .log-event-rcon-error .label { color: var(--danger); }
  .log-event-join .player { color: #1f8a4c; }
  .log-event-leave .player { color: #a83239; }
  #rcon-form { display: flex; gap: 8px; margin-top: 8px; }
  #rcon-form input, #rcon-form button { padding: 10px 14px; font-size: 1rem; border-radius: 8px; }
  #rcon-input { flex: 1; }
  .empty-state { color: var(--muted); font-size: 0.85rem; }
  #filters-bar, #cluster-console-filters-bar { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
  #btn-toggle-filters { font-size: 0.8rem; padding: 4px 8px; flex-shrink: 0; }
  #filters, #cluster-console-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 0.8rem; color: var(--muted); }
  #filters-bar.collapsed #filters, #cluster-console-filters-bar.collapsed #cluster-console-filters { display: none; }
  #filters label, #cluster-console-filters label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  #filters input, #cluster-console-filters input { padding: 0; width: auto; }
  .content-row { flex: 1; display: flex; gap: 12px; min-height: 0; }
  .console-panel { flex: 3; }
  .side-col { display: flex; flex-direction: column; gap: 12px; flex: 1; min-width: 220px; max-width: 300px; }
  .side-col.collapsed { display: none; }
  #btn-toggle-sidecol { font-size: 0.8rem; padding: 4px 8px; flex-shrink: 0; }
  .status-panel { flex: 0 0 auto; }
  .status-panel h3 { margin: 0 0 10px; font-size: 0.95rem; }
  .status-lines { display: flex; flex-direction: column; gap: 6px; font-size: 0.85rem; color: var(--muted); }
  .status-lines strong { color: var(--text); font-weight: 600; }
  .players-panel { flex: 1; min-height: 0; }
  .players-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .players-header h3 { margin: 0; font-size: 0.95rem; }
  .players-count { background: var(--accent); color: #fff; border-radius: 999px; padding: 1px 9px; font-size: 0.75rem; }
  #players-list { flex: 1; overflow-y: auto; font-size: 0.85rem; }
  .player-row { padding: 6px 8px; border-radius: 6px; }
  .player-row:hover { background: var(--bg); }
  .context-menu { position: fixed; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 4px; z-index: 1000; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5); min-width: 150px; }
  .context-menu button { display: block; width: 100%; text-align: left; border: none; background: none; padding: 7px 10px; border-radius: 4px; font-size: 0.85rem; }
  .context-menu button:hover { background: var(--bg); }
  .context-menu button.danger { color: var(--danger); }
  #backup-content { display: none; flex: 1; flex-direction: column; min-height: 0; }
  #backup-content.active { display: flex; }
  .form-actions { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  #backup-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  #backup-table th, #backup-table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); }
  #backup-table th { color: var(--muted); font-weight: 600; }
  #backup-table .backup-row-actions { display: flex; gap: 6px; justify-content: flex-end; }
  #backup-table .backup-row-actions button { font-size: 0.78rem; padding: 4px 8px; }
  #btn-backup-show-more { display: none; width: 100%; margin-top: 10px; font-size: 0.8rem; }
  .backup-table-panel { flex: 0 1 45%; }
  .player-backup-panel { flex: 0 1 30%; min-width: 260px; }
  .backup-log-panel { flex: 0 1 25%; min-width: 220px; }
  #backup-log { flex: 1; overflow-y: auto; font-size: 0.85rem; }
  .backup-log-line { padding: 3px 0; color: var(--muted); }
  .backup-log-line.error { color: var(--danger); }
  .backup-log-time { color: var(--muted); margin-right: 6px; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; font-size: 0.85rem; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5); z-index: 1100; }
  /* Admin-only remote control tabs (Settings/Mods/Map Management/Server Management/Update
     Log) - reuses the same select/input/button/table/.empty-state/.form-actions styling
     already defined above for the console and backup views, rather than a second bespoke
     visual language. */
  .admin-tab-content { display: none; flex: 1; flex-direction: column; min-height: 0; overflow-y: auto; }
  .admin-tab-content.active { display: flex; }
  .settings-form { display: none; flex: 1; overflow-y: auto; flex-direction: column; gap: 16px; }
  .settings-form.active { display: flex; }
  .settings-section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
  .settings-section h3 { margin: 0; font-size: 1rem; }
  .settings-section label { display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem; color: var(--muted); }
  .settings-section label.checkbox { flex-direction: row; align-items: center; gap: 6px; color: var(--text); font-size: 0.88rem; }
  .settings-section label.checkbox input { width: auto; }
  .settings-section .form-actions { margin-bottom: 0; }
  .settings-grid2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px 16px; }
  .settings-days-row { display: flex; gap: 10px; flex-wrap: wrap; font-size: 0.82rem; }
  .settings-days-row label { flex-direction: row; align-items: center; gap: 4px; color: var(--text); }
  .settings-days-row input { width: auto; }
  .status-message { color: var(--ok); font-size: 0.85rem; }
  button.danger { border-color: var(--danger); color: var(--danger); }
  button.danger:hover:not(:disabled) { background: var(--danger); color: #14161a; }
  .data-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 4px; }
  .data-table th, .data-table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); }
  .data-table th { color: var(--muted); font-weight: 600; }
  .data-table tbody tr.selected { background: var(--bg); }
  .data-table tbody tr.selectable { cursor: pointer; }
  .files-breadcrumb { margin: 8px 0; font-size: 0.85rem; }
  .files-breadcrumb button { background: none; border: none; color: var(--accent); cursor: pointer; padding: 0 2px; font-size: 0.85rem; }
  .files-breadcrumb button:hover { text-decoration: underline; }
  .files-breadcrumb span.sep { color: var(--muted); margin: 0 2px; }
  .data-table td.files-name-cell { cursor: pointer; }
  .data-table td.files-name-cell:hover { text-decoration: underline; }
  /* Notepad++-inspired: several files can be open at once, each its own tab, instead of the
     editor always replacing the table for a single file with no way back to a previously
     opened one short of re-browsing to it. */
  .files-open-tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
  .files-open-tab { display: flex; align-items: center; background: var(--panel); border: 1px solid var(--border); border-bottom: none; border-radius: 6px 6px 0 0; overflow: hidden; }
  .files-browse-tab { padding: 6px 12px; color: var(--muted); background: none; border: 1px solid var(--border); border-bottom: none; border-radius: 6px 6px 0 0; }
  .files-open-tab.active, .files-browse-tab.active { background: var(--bg); border-color: var(--accent); color: var(--text); }
  .files-open-tab-label { background: none; border: none; border-radius: 0; padding: 6px 4px 6px 12px; color: var(--muted); }
  .files-open-tab.active .files-open-tab-label { color: var(--text); }
  .files-open-tab-close { background: none; border: none; border-radius: 0; padding: 6px 10px 6px 4px; color: var(--muted); font-size: 1rem; line-height: 1; }
  .files-open-tab-close:hover { color: var(--danger); }
  .files-editor-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .files-editor-header h3 { margin: 0; font-size: 0.9rem; font-weight: 400; color: var(--muted); overflow-wrap: anywhere; }
  /* Fills most of the viewport instead of a small fixed box - bigger and responsive to the
     window size, per direct user feedback on the previous fixed-height textarea. */
  .files-editor-body { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; height: 60vh; margin-top: 8px; }
  .files-editor-gutter { flex-shrink: 0; padding: 8px 8px 8px 0; text-align: right; font-family: monospace; font-size: 0.85rem; line-height: 1.5; color: var(--muted); background: var(--panel); border-right: 1px solid var(--border); overflow: hidden; user-select: none; white-space: pre-wrap; }
  .files-editor-readonly-badge { color: var(--muted); font-style: italic; }
  .files-editor-code { position: relative; flex: 1; min-width: 0; }
  /* Notepad++-style coloring: a non-interactive <pre> behind the real textarea shows colored
     tokens; the textarea on top stays fully functional but renders its own text transparent
     (only the caret/selection show) so the colors underneath show through. Both share the
     same font/padding/white-space so they wrap identically and stay pixel-aligned as the user
     types - see the 'scroll' listener below for how their scroll position stays in sync. The
     highlight layer's scrollTop is only ever set programmatically (to mirror the textarea's),
     so it stays overflow: hidden - but the textarea is what the user actually scrolls with the
     wheel/keyboard, so it needs overflow-y: auto, not hidden (hidden would silently block the
     user's own scroll input, not just the scrollbar). */
  .files-editor-highlight, .files-editor-textarea { position: absolute; inset: 0; margin: 0; padding: 8px 10px; font-family: monospace; font-size: 0.85rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .files-editor-highlight { color: var(--text); overflow: hidden; pointer-events: none; }
  .files-editor-textarea { border: none; border-radius: 0; resize: none; background: transparent; color: transparent; caret-color: var(--text); overflow-y: auto; overflow-x: hidden; }
  .files-editor-textarea::selection { background: rgba(79, 140, 255, 0.35); }
  .files-editor-textarea:focus { outline: none; }
  .files-editor-textarea[readonly] { cursor: default; }
  .tok-section { color: var(--accent); font-weight: 600; }
  .tok-comment { color: var(--muted); font-style: italic; }
  .tok-key { color: var(--cyan); }
  .tok-punctuation { color: var(--muted); }
  .tok-string { color: var(--warn); }
  .tok-number { color: var(--purple); }
  .tok-boolean { color: var(--pink); }
  .tok-timestamp { color: var(--muted); }
  .tok-error { color: var(--danger); font-weight: 600; }
  .tok-warn { color: var(--warn); font-weight: 600; }
  .tok-info { color: var(--cyan); }
  .tok-plain { color: var(--text); }
  .files-ini-history-list { list-style: none; padding: 0; margin: 8px 0; }
  .files-ini-history-list li { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
  .files-ini-history-list li span { flex: 1; }
  .files-ini-diff { font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; margin-top: 8px; max-height: 300px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
  .files-ini-diff .diff-added { background: rgba(46, 204, 113, 0.18); display: block; }
  .files-ini-diff .diff-removed { background: rgba(231, 76, 60, 0.18); display: block; }
  .files-ini-diff .diff-same { display: block; opacity: 0.7; }
  .data-table td.mod-disabled-row { color: var(--muted); }
  .playerbackup-select-col { width: 28px; }
  .ark-mod-icon { width: 24px; height: 24px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
  .server-type-icon-large { width: 28px; height: 28px; border-radius: 5px; object-fit: cover; flex-shrink: 0; align-self: center; }
  .server-type-icon { width: 16px; height: 16px; border-radius: 3px; object-fit: cover; flex-shrink: 0; }
  .mc-mods-browse-heading { display: flex; align-items: center; gap: 6px; }
  .ark-mod-name-cell { display: flex; align-items: center; gap: 8px; }
  .ark-mod-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ark-mod-search-results { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; max-height: 260px; overflow-y: auto; }
  .ark-mod-search-result { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; }
  .ark-mod-search-result-info { display: flex; flex-direction: column; min-width: 0; flex: 1; gap: 2px; }
  .ark-mod-search-result-name { font-weight: 600; }
  .ark-mod-search-result-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.78rem; }
  .ark-mod-search-result-downloads { font-size: 0.78rem; flex-shrink: 0; }
  .mods-grid-actions { display: flex; gap: 4px; white-space: nowrap; }
  .mods-grid-actions button { padding: 4px 8px; font-size: 0.8rem; }
  .log-output { flex: 1; overflow: auto; font-size: 0.8rem; font-family: Consolas, Menlo, monospace; white-space: pre-wrap; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin: 0; }
  @media (max-width: 700px) {
    /* The desktop layout is a fixed-viewport "app" (body: height:100vh + overflow:hidden)
       that relies on each panel being its own bounded, individually-scrolling box. That
       shape keeps breaking on mobile - a panel not explicitly height-capped just grows
       past the screen, and because the page itself can't scroll, that overflow becomes
       completely unreachable rather than merely ugly. Simpler and more robust: let the
       page scroll normally on mobile, like any other web page, and only keep an internal
       scroll box where one is actually wanted (the live console feed, the online players
       list) - everything else just flows and the page grows to fit it. */
    body { flex-direction: column; height: auto; min-height: 100vh; overflow: visible; }
    #sidebar { width: auto; flex-direction: row; border-right: none; border-bottom: 1px solid var(--border); padding: 8px 10px; overflow-x: auto; }
    #sidebar h1 { display: none; }
    .app-sidebar-game-switch { flex-shrink: 0; padding: 0 8px 0 0; margin-bottom: 0; border-bottom: none; border-right: 1px solid var(--border); }
    .nav-group { flex-direction: row; }
    .nav-btn { flex-shrink: 0; }
    .nav-logout { margin-top: 0; margin-left: auto; }
    #main-area { overflow: visible; }
    .view.active { overflow: visible; }
    header { padding: 10px 12px; gap: 8px; }
    main { padding: 8px 10px; overflow: visible; }
    select, #server-actions button { flex: 1 1 auto; }
    .server-picker { margin-left: 0; flex: 1 1 100%; }
    .content-row { flex-direction: column; }
    /* flex:1 turned out not to reliably bound this on real mobile browsers - a chain of
       nested flex-grow containers several levels deep (main-area > view > main >
       content-row > console-panel) apparently doesn't force #console's overflow-y:auto to
       actually kick in the way it does on desktop (verified: with a busy 60-event backlog,
       the panel just grew to fit every line instead of scrolling internally). A real vh-
       based height is a definite value regardless of how that chain resolves, so it
       reliably stays a compact box - and scales with the actual device screen instead of
       being a flat number that's too small on a tall phone. */
    .console-panel { flex: none; height: 55vh; min-height: 280px; }
    #console { font-size: 0.72rem; }
    .log-event { padding: 2px 0; line-height: 1.3; }
    .side-col { flex: none; width: 100%; max-width: none; }
    .players-panel { flex: none; max-height: 160px; }
    #players-list { display: flex; flex-direction: row; flex-wrap: wrap; overflow-y: hidden; gap: 6px; }
    .player-row { flex: 0 0 auto; background: var(--bg); border: 1px solid var(--border); }
    .cluster-cards { grid-template-columns: 1fr; gap: 10px; }
    .cluster-card { padding: 14px; }
    /* The stats chart is desktop-only (see the JS width check in buildGroupRow) - this is
       just a safety net so a chart already in the DOM from a resize down from desktop
       width doesn't linger visually before the next poll rebuilds the cards without it. */
    .cluster-time-scale, .cluster-card-chart { display: none; }
    .cluster-console-feed { font-size: 0.72rem; }
    .cluster-console-stats { grid-template-columns: repeat(2, 1fr); gap: 4px 10px; padding: 8px 10px; }
    .cluster-console-stats dt { font-size: 0.62rem; }
    .cluster-console-stats dd { font-size: 0.82rem; }
    .cluster-console-rcon-form { flex-wrap: wrap; }
    .cluster-console-rcon-form select, .cluster-console-rcon-form input { flex: 1 1 auto; max-width: none; }
    .form-actions { flex-wrap: wrap; }
    .form-actions button { flex: 1 1 auto; }
    .backup-table-panel, .player-backup-panel, .backup-log-panel { flex: none; width: 100%; min-width: 0; }
    .backup-table-panel, .player-backup-panel { overflow-x: auto; }
    #backup-table { font-size: 0.78rem; }
    .admin-tab-content, .settings-form { overflow-y: visible; }
    .settings-grid2 { grid-template-columns: 1fr; }
    .data-table { font-size: 0.78rem; }
    /* A fixed 320px form plus its own 28px padding on each side needs 376px to fit without
       overflow - wider than several real phones (iPhone SE/older/budget Android are 320-
       360px), which would otherwise force horizontal scrolling on the very first screen a
       mobile viewer with "Require access token" on ever sees. */
    #token-gate form { width: auto; max-width: 320px; padding: 20px; }
  }
</style>
</head>
<body>
<div id="token-gate">
  <form id="token-gate-form">
    <h1>Bober Server Manager</h1>
    <input id="token-gate-input" placeholder="Access token" autocomplete="off" autofocus />
    <div id="token-gate-error"></div>
    <button type="submit">Continue</button>
  </form>
</div>
<nav id="sidebar">
  <h1>Bober Manager</h1>
  <div id="game-switch" class="app-sidebar-game-switch">
    <button id="game-switch-ark" type="button" title="ARK: Survival Evolved / Ascended">
      <img src="/game-icons/ark-evolved.png" alt="ARK" />
    </button>
    <button id="game-switch-minecraft" type="button" title="Minecraft">
      <img src="/game-icons/minecraft.png" alt="Minecraft" />
    </button>
  </div>
  <!-- Just the top-level pages now - same shape as the desktop Manager's own app-sidebar
       (Dashboard/Cluster Dashboard, or Minecraft Servers). Every per-server tab (Console,
       Analytics, Settings, ...) used to live here permanently too; they're now reached via
       the new #view-server-detail shell's own grouped nav instead (renderServerDetailNav),
       the same way the desktop Manager replaced its own flat per-server tab row with
       ServerDetail's grouped side nav. -->
  <div id="nav-group-ark" class="nav-group">
    <button id="nav-dashboard" class="nav-btn" type="button">Dashboard</button>
    <button id="nav-cluster" class="nav-btn" type="button">Cluster Dashboard</button>
  </div>
  <div id="nav-group-minecraft" class="nav-group">
    <button id="nav-mcdashboard" class="nav-btn" type="button">Minecraft Servers</button>
  </div>
</nav>
<div id="main-area">
  <section id="view-dashboard" class="view">
    <header>
      <h1>Dashboard</h1>
    </header>
    <main>
      <div id="dashboard-cards"></div>
    </main>
  </section>
  <section id="view-cluster" class="view">
    <div id="cluster-groups">
      <div id="cluster-time-scale" class="cluster-time-scale">
        <span>Time Scale</span>
        <button type="button" class="time-scale-btn" data-ms="60000">1m</button>
        <button type="button" class="time-scale-btn" data-ms="300000">5m</button>
        <button type="button" class="time-scale-btn" data-ms="900000">15m</button>
        <button type="button" class="time-scale-btn" data-ms="3600000">1h</button>
        <button type="button" class="time-scale-btn" data-ms="21600000">6h</button>
        <button type="button" class="time-scale-btn" data-ms="43200000">12h</button>
        <button type="button" class="time-scale-btn" data-ms="86400000">24h</button>
        <button type="button" class="time-scale-btn" data-ms="null">All</button>
      </div>
      <div id="cluster-cards"></div>
    </div>
    <div id="cluster-console">
      <div class="cluster-console-header">
        <button id="btn-cluster-console-back" type="button">&larr; Back</button>
        <h2 id="cluster-console-title"></h2>
        <button id="btn-cluster-toggle-filters" type="button">Show ▾</button>
        <button id="btn-cluster-toggle-sidecol" type="button">Servers ▾</button>
      </div>
      <div id="cluster-console-filters-bar">
        <div id="cluster-console-filters"></div>
      </div>
      <dl id="cluster-console-stats" class="cluster-console-stats"></dl>
      <div class="content-row">
        <section class="panel console-panel">
          <div id="cluster-console-feed" class="cluster-console-feed"></div>
          <div id="cluster-console-rcon-results" class="cluster-console-rcon-results" style="display: none"></div>
          <form id="cluster-console-rcon-form" class="cluster-console-rcon-form">
            <select id="cluster-console-rcon-target"></select>
            <input id="cluster-console-rcon-input" placeholder="RCON command..." autocomplete="off" />
            <button type="submit">Send</button>
          </form>
        </section>
        <div id="cluster-console-sidecol" class="side-col">
          <div id="cluster-console-cards"></div>
        </div>
      </div>
    </div>
  </section>
  <section id="view-mcdashboard" class="view">
    <header>
      <h1>Minecraft Servers</h1>
    </header>
    <main>
      <div id="mcdashboard-cards"></div>
    </main>
  </section>
  <!-- Per-server "Manage" shell - wraps every per-server view below (console through
       mc-management, unmoved/unchanged - NOT view-mcdashboard, which is Minecraft's own
       overview tab, kept outside the shell as a sibling same as view-dashboard/view-cluster)
       in the same grouped side nav + Back header as the desktop Manager's own ServerDetail/
       MinecraftServerDetail, replacing their old permanent flat sidebar buttons (see
       renderServerDetailNav/applyActiveView in the script below). -->
  <section id="view-server-detail" class="view">
    <header>
      <button id="btn-server-detail-back" type="button">&larr; Back</button>
      <h1 id="server-detail-title"></h1>
    </header>
    <div class="settings-shell">
      <nav id="server-detail-nav" class="settings-nav"></nav>
      <div class="settings-content">
  <section id="view-console" class="view">
    <header>
      <h1>Bober Server Manager</h1>
      <div id="server-actions">
        <button id="btn-start" class="ok">Start</button>
        <button id="btn-stop" class="danger">Stop</button>
        <button id="btn-restart" class="warn">Restart</button>
        <button id="btn-stop-update-restart" class="info">Update Restart</button>
      </div>
      <button id="btn-toggle-filters" type="button">Events ▾</button>
      <button id="btn-toggle-sidecol" type="button">Status ▾</button>
      <select id="server-select" class="server-picker"></select>
    </header>
    <main>
      <div id="filters-bar">
        <div id="filters"></div>
      </div>
      <div class="content-row">
        <section class="panel console-panel">
          <div id="console"></div>
          <form id="rcon-form">
            <input id="rcon-input" placeholder="e.g. Broadcast Hello world" autocomplete="off" />
            <button type="submit">Send</button>
          </form>
        </section>
        <div id="side-col" class="side-col">
          <aside class="panel status-panel">
            <h3>Status</h3>
            <div id="status"></div>
          </aside>
          <aside class="panel players-panel">
            <div class="players-header">
              <h3>Online players</h3>
              <span class="players-count" id="players-count">0</span>
            </div>
            <div id="players-list"></div>
          </aside>
        </div>
      </div>
    </main>
  </section>
  <section id="view-analytics" class="view">
    <header>
      <h1>Analytics</h1>
      <select id="analytics-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="analytics-no-server" class="empty-state">No server selected - choose one above.</p>
      <div id="analytics-content" class="admin-tab-content">
        <section class="settings-section">
          <h3>Server Status</h3>
          <dl id="analytics-status-grid" class="cluster-console-stats"></dl>
        </section>
        <div id="analytics-time-scale" class="cluster-time-scale">
          <span>Time Scale</span>
          <button type="button" class="time-scale-btn analytics-scale-btn" data-ms="60000">1m</button>
          <button type="button" class="time-scale-btn analytics-scale-btn" data-ms="300000">5m</button>
          <button type="button" class="time-scale-btn analytics-scale-btn" data-ms="900000">15m</button>
          <button type="button" class="time-scale-btn analytics-scale-btn" data-ms="3600000">1h</button>
          <button type="button" class="time-scale-btn analytics-scale-btn" data-ms="21600000">6h</button>
          <button type="button" class="time-scale-btn analytics-scale-btn" data-ms="43200000">12h</button>
          <button type="button" class="time-scale-btn analytics-scale-btn" data-ms="86400000">24h</button>
          <button type="button" class="time-scale-btn analytics-scale-btn" data-ms="null">All</button>
          <label class="checkbox analytics-stats-toggle">
            <input id="analytics-statsenabled" type="checkbox" /> Enable stats collection
          </label>
        </div>
        <p id="analytics-disabled-note" class="empty-state" style="display: none">
          Stats collection is off for this server - enable it above to start recording CPU/RAM/player history.
        </p>
        <div id="analytics-chart"></div>
      </div>
    </main>
  </section>
  <section id="view-backup" class="view">
    <header>
      <h1>Backup</h1>
      <select id="backup-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="backup-no-server" class="empty-state">No server selected - choose one above.</p>
      <div id="backup-content">
        <section id="backup-settings-section" class="settings-section">
          <h3>Backup Settings</h3>
          <label>
            Backup directory
            <input id="backup-dir" placeholder="C:\\ARK\\Backups" />
          </label>
          <div class="settings-grid2">
            <label>
              Max backups to keep
              <input id="backup-maxbackups" type="number" min="1" />
            </label>
            <label class="checkbox">
              <input id="backup-schedule-enabled" type="checkbox" /> Enable scheduled automatic backups
            </label>
          </div>
          <label>
            Backup schedule (cron expression)
            <input id="backup-schedule-cron" placeholder="every 6 hours: 0 */6 * * *" />
          </label>
          <label class="checkbox">
            <input id="backup-playerprofile-enabled" type="checkbox" /> Back up player profiles on join/leave
          </label>
          <label>
            Backups to keep per player
            <input id="backup-playerprofile-maxperplayer" type="number" min="1" />
          </label>
          <p id="backup-settings-status" class="empty-state" style="display: none"></p>
          <p id="backup-settings-error" class="error-message" style="display: none"></p>
        </section>
        <p id="backup-info" class="empty-state"></p>
        <div class="form-actions">
          <button id="btn-backup-create">Create backup now</button>
          <button id="btn-backup-refresh" type="button">Refresh</button>
        </div>
        <div class="content-row">
          <section class="panel backup-table-panel">
            <h3>World Backups</h3>
            <table id="backup-table">
              <thead>
                <tr><th>File Name</th><th>Size</th><th>Creation Time</th><th></th></tr>
              </thead>
              <tbody id="backup-table-body"></tbody>
            </table>
            <button id="btn-backup-show-more" type="button"></button>
          </section>
          <section class="panel player-backup-panel">
            <h3>Player Profile Backups</h3>
            <div class="form-actions">
              <select id="playerbackup-folder-select"></select>
              <button id="btn-playerbackup-refresh-folders" type="button">Refresh</button>
            </div>
            <div class="form-actions">
              <button id="btn-playerbackup-restore" type="button" disabled>Restore selected backup</button>
              <button id="btn-playerbackup-delete" type="button" disabled>Delete selected backup</button>
            </div>
            <table id="playerbackup-table" class="data-table">
              <thead>
                <tr>
                  <th class="playerbackup-select-col"><input id="playerbackup-selectall" type="checkbox" /></th>
                  <th>File Name</th>
                  <th>Creation Time</th>
                </tr>
              </thead>
              <tbody id="playerbackup-table-body"></tbody>
            </table>
          </section>
          <aside class="panel backup-log-panel">
            <h3>Backup Process Log</h3>
            <div id="backup-log"></div>
          </aside>
        </div>
      </div>
    </main>
  </section>
  <section id="view-settings" class="view">
    <header>
      <h1>Settings</h1>
      <select id="settings-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="settings-no-server" class="empty-state">No server selected - choose one above.</p>
      <form id="settings-content" class="settings-form" onsubmit="return false;">
        <section class="settings-section">
          <h3>Server</h3>
          <label>
            Name
            <input id="settings-name" />
          </label>
          <label>
            Install directory
            <input id="settings-installdir" placeholder="C:\\ARK\\Server" />
          </label>
          <div class="settings-grid2">
            <label>
              Game port
              <input id="settings-gameport" type="number" />
            </label>
            <label>
              RCON port
              <input id="settings-rconport" type="number" />
            </label>
            <label>
              Server Platform
              <select id="settings-platform">
                <option value="PC">PC</option>
                <option value="ALL">ALL</option>
              </select>
            </label>
            <label>
              Max Players
              <input id="settings-maxplayers" type="number" />
            </label>
          </div>
          <label>
            Map
            <select id="settings-map"></select>
          </label>
          <label>
            Mod Map ID
            <div class="form-actions">
              <input id="settings-moddedmapid" placeholder="Workshop mod id" />
              <label class="checkbox"><input id="settings-moddedmapenabled" type="checkbox" /> Enabled</label>
            </div>
            <p class="empty-state">Passed as -MapModID=&lt;id&gt; when enabled, alongside Map above.</p>
          </label>
          <label>
            Beta
            <div class="form-actions">
              <label class="checkbox"><input id="settings-betaenabled" type="checkbox" /> Enabled</label>
              <input id="settings-betaname" placeholder="Beta branch name" />
            </div>
          </label>
        </section>
        <section class="settings-section">
          <h3>Extra Settings</h3>
          <label>
            Culture Settings
            <select id="settings-culture">
              <option value="none">None</option>
              <option value="en">English</option>
              <option value="fr">French</option>
            </select>
          </label>
          <label class="checkbox"><input id="settings-battleye" type="checkbox" /> Disable BattlEye</label>
          <label class="checkbox"><input id="settings-tribelog" type="checkbox" /> RCON Tribe Log</label>
          <label class="checkbox"><input id="settings-respawndinos" type="checkbox" /> Force Respawn Wild Dinos</label>
          <label class="checkbox"><input id="settings-nosound" type="checkbox" /> No Sound</label>
          <label>
            Max Dino Level
            <input id="settings-maxdinolevel" />
          </label>
          <label>
            Dashboard group
            <input id="settings-group" placeholder="Leave blank for no group" />
          </label>
          <label>
            Extra launch arguments
            <input id="settings-extraargs" />
          </label>
        </section>
        <section class="settings-section">
          <h3>Cluster</h3>
          <label class="checkbox"><input id="settings-clusterenabled" type="checkbox" /> Enable cluster</label>
          <label>
            Cluster ID
            <input id="settings-clusterid" placeholder="my-cluster" />
          </label>
          <label>
            Dedicated Cluster Directory
            <input id="settings-clusterdir" />
          </label>
          <label class="checkbox"><input id="settings-notransferfiltering" type="checkbox" /> No Transfer From Filtering</label>
          <label>
            External IP
            <input id="settings-externalip" placeholder="203.0.113.10" />
          </label>
          <label>
            Discord Chat Channel ID
            <input id="settings-discordchatchannel" placeholder="Blank disables the chat bridge" />
          </label>
          <label>
            Discord Events Channel ID
            <input id="settings-discordeventschannel" placeholder="Blank disables tame/death/mission posts" />
          </label>
          <p class="empty-state">
            Relays this server's in-game chat to/from the Chat Channel, and posts tame/tamed-dino-death/mission
            events to the Events Channel - both independent of the cluster settings above and off by default. Set
            the same channel id on every server in a cluster to share one channel between them.
          </p>
        </section>
        <p id="settings-status" class="status-message" style="display: none"></p>
        <p id="settings-error" class="error-message" style="display: none"></p>
      </form>
    </main>
  </section>
  <section id="view-mods" class="view">
    <header>
      <h1>Mods</h1>
      <select id="mods-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="mods-no-server" class="empty-state">No server selected - choose one above.</p>
      <div id="mods-content" class="admin-tab-content">
        <p class="empty-state">
          Mod IDs, applied in this order. Enabled mods are passed via -mods= at the next start, unless Passive is
          checked (-passivemods= instead). Dev appends -dev to the ID. Name shows each mod's real icon/name
          resolved from CurseForge once a CurseForge API key is configured. Changes save immediately - restart
          the server to apply them.
        </p>
        <section id="mods-search-section" class="settings-section" style="display: none">
          <h3>Search CurseForge</h3>
          <p id="mods-search-nokey" class="empty-state" style="display: none">
            Set a CurseForge API key in Settings (General) to search for mods by name here instead of typing a
            numeric id by hand.
          </p>
          <div id="mods-search-ui" style="display: none">
            <p class="empty-state">Find a mod by name and add it below - its id and name are filled in for you.</p>
            <div class="form-actions">
              <input id="mods-search-query" placeholder="Search ARK: Survival Ascended mods..." />
              <button id="btn-mods-search" type="button">Search</button>
            </div>
            <p id="mods-search-error" class="error-message" style="display: none"></p>
            <div id="mods-search-results" class="ark-mod-search-results"></div>
          </div>
        </section>
        <div class="form-actions">
          <input id="mods-new-id" placeholder="Mod ID" />
          <button id="btn-mods-add" type="button">Add</button>
        </div>
        <table id="mods-table" class="data-table">
          <thead>
            <tr><th>Enable</th><th>Passive</th><th>Dev</th><th>Mod ID</th><th>Name</th><th></th></tr>
          </thead>
          <tbody id="mods-table-body"></tbody>
        </table>
        <p id="mods-error" class="error-message" style="display: none"></p>
      </div>
    </main>
  </section>
  <section id="view-mapmanagement" class="view">
    <header>
      <h1>Map Management</h1>
      <select id="mapmanagement-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="mapmanagement-no-server" class="empty-state">No server selected - choose one above.</p>
      <div id="mapmanagement-content" class="admin-tab-content">
        <div class="form-actions">
          <input id="mapmanagement-folder" placeholder="Folder name (e.g. Svartalfheim)" />
          <input id="mapmanagement-file" placeholder="File name (e.g. Svartalfheim_WP.ark)" />
          <button id="btn-mapmanagement-add" type="button">Add map</button>
        </div>
        <p class="empty-state">
          Creates SavedArks/&lt;folder&gt;/&lt;file&gt; (an empty placeholder) under this server's install
          directory. Also add its mod in the Mods tab - that's what actually downloads the map.
        </p>
        <p id="mapmanagement-error" class="error-message" style="display: none"></p>
        <div class="form-actions">
          <button id="btn-mapmanagement-refresh" type="button">Refresh</button>
          <button id="btn-mapmanagement-delete" type="button" class="danger" disabled>Delete selected map</button>
        </div>
        <table id="mapmanagement-table" class="data-table">
          <thead><tr><th>Name</th><th>Creation Date</th></tr></thead>
          <tbody id="mapmanagement-table-body"></tbody>
        </table>
      </div>
    </main>
  </section>
  <section id="view-files" class="view">
    <header>
      <h1>Files</h1>
      <select id="files-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="files-no-server" class="empty-state">No server selected - choose one above.</p>
      <div id="files-content" class="admin-tab-content">
        <p class="empty-state">
          Browses this server's own install directory - everything under it, not just configs. Deleting is limited
          to files (not folders) as a safety margin for a remote web UI.
        </p>
        <div id="files-open-tabs" class="files-open-tabs" style="display: none"></div>
        <nav id="files-breadcrumb" class="files-breadcrumb"></nav>
        <p id="files-error" class="error-message" style="display: none"></p>
        <table id="files-table" class="data-table">
          <thead><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr></thead>
          <tbody id="files-table-body"></tbody>
        </table>
        <div id="files-ini-editor" style="display: none">
          <div class="files-editor-header">
            <h3 id="files-ini-editor-title"></h3>
            <div class="form-actions">
              <button id="btn-files-ini-save" type="button">Save</button>
              <button id="btn-files-ini-cancel" type="button">Close</button>
            </div>
          </div>
          <p id="files-ini-editor-error" class="error-message" style="display: none"></p>
          <div class="files-editor-body">
            <div id="files-ini-gutter" class="files-editor-gutter"></div>
            <div class="files-editor-code">
              <pre id="files-ini-highlight" class="files-editor-highlight" aria-hidden="true"></pre>
              <textarea id="files-ini-editor-textarea" class="files-editor-textarea" spellcheck="false"></textarea>
            </div>
          </div>
          <div id="files-ini-history-section">
            <h4>History</h4>
            <p id="files-ini-history-empty" class="empty-state" style="display: none">No saved edits yet.</p>
            <ul id="files-ini-history-list" class="files-ini-history-list"></ul>
          </div>
          <div id="files-ini-diff" class="files-ini-diff" style="display: none"></div>
        </div>
      </div>
    </main>
  </section>
  <section id="view-servermanagement" class="view">
    <header>
      <h1>Server Management</h1>
      <select id="servermanagement-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="servermanagement-no-server" class="empty-state">No server selected - choose one above.</p>
      <form id="servermanagement-content" class="settings-form" onsubmit="return false;">
        <section class="settings-section">
          <h3>Startup &amp; Watchdog</h3>
          <label class="checkbox">
            <input id="sm-startonlaunch" type="checkbox" /> Start this server when the Manager starts
          </label>
          <label class="checkbox">
            <input id="sm-crashwatch" type="checkbox" /> Automatically restart this server if it crashes unexpectedly
          </label>
          <label class="checkbox">
            <input id="sm-zombiedetection" type="checkbox" /> Kill this server if it gets stuck starting up
          </label>
          <div class="settings-grid2">
            <label>
              Zombie timeout (minutes)
              <input id="sm-zombietimeout" type="number" min="1" />
            </label>
            <label class="checkbox">
              <input id="sm-zombieautorestart" type="checkbox" /> Restart automatically after killing it
            </label>
          </div>
          <label>
            Cluster console archive max size (MB, 1-100)
            <input id="sm-archivesize" type="number" min="1" max="100" />
          </label>
        </section>
        <section class="settings-section">
          <h3>Scheduled Restart</h3>
          <div class="form-actions">
            <label class="checkbox"><input id="sm-restart-enabled" type="checkbox" /> Shutdown server at:</label>
            <input id="sm-restart-time" type="time" />
          </div>
          <div id="sm-restart-days" class="settings-days-row"></div>
          <label class="checkbox"><input id="sm-restart-updateafter" type="checkbox" /> Update server from steam after shutdown</label>
          <label class="checkbox"><input id="sm-restart-startafter" type="checkbox" /> Start server after shutdown</label>
          <p id="sm-restart-countdown" class="empty-state">Next shutdown in: --:--:--:--</p>
        </section>
        <section class="settings-section">
          <h3>Dino Wipe</h3>
          <div class="form-actions">
            <label class="checkbox"><input id="sm-dinowipe-enabled" type="checkbox" /> Wipe wild dinos at:</label>
            <input id="sm-dinowipe-time" type="time" />
          </div>
          <div id="sm-dinowipe-days" class="settings-days-row"></div>
          <p id="sm-dinowipe-countdown" class="empty-state">Next dinowipe in: --:--:--:--</p>
        </section>
        <p id="servermanagement-error" class="error-message" style="display: none"></p>
      </form>
    </main>
  </section>
  <section id="view-updatelog" class="view">
    <header>
      <h1>Update Log</h1>
      <select id="updatelog-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="updatelog-no-server" class="empty-state">No server selected - choose one above.</p>
      <div id="updatelog-content" class="admin-tab-content">
        <p class="empty-state">
          Output of this server's last SteamCMD install/update run - manual or scheduled. Refreshes every few
          seconds while this tab is open.
        </p>
        <pre id="updatelog-output" class="log-output"></pre>
      </div>
    </main>
  </section>
  <section id="view-mc-startsettings" class="view">
    <header>
      <h1>MC Start Settings</h1>
      <select id="mc-startsettings-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="mc-startsettings-no-server" class="empty-state">No Minecraft server selected - choose one above.</p>
      <form id="mc-startsettings-content" class="settings-form" onsubmit="return false;">
        <section class="settings-section">
          <h3>Server</h3>
          <label>
            Name
            <input id="mcss-name" />
          </label>
          <label>
            Server type
            <div class="form-actions">
              <select id="mcss-servertype">
                <option value="vanilla">Vanilla</option>
                <option value="paper">Paper</option>
                <option value="spigot">Spigot</option>
                <option value="fabric">Fabric</option>
                <option value="forge">Forge</option>
                <option value="neoforge">NeoForge</option>
                <option value="spongevanilla">SpongeVanilla</option>
                <option value="spongeforge">SpongeForge</option>
                <option value="unknown">Unknown</option>
              </select>
              <img id="mcss-servertype-icon" class="server-type-icon-large" alt="" style="display: none" />
            </div>
          </label>
          <label>
            Minecraft version
            <select id="mcss-version"></select>
          </label>
          <p id="mcss-version-loading" class="empty-state" style="display: none">Loading versions...</p>
          <p id="mcss-version-error" class="error-message" style="display: none"></p>
          <label id="mcss-loaderversion-row">
            Loader / build version
            <select id="mcss-loaderversion"></select>
          </label>
          <p id="mcss-loaderversion-loading" class="empty-state" style="display: none">Loading loader/build versions...</p>
          <p id="mcss-loaderversion-error" class="error-message" style="display: none"></p>
          <p class="empty-state">Required by the Mods tab to find compatible mods/plugins; the loader/build version is purely informational.</p>
          <label>
            Install directory
            <input id="mcss-installdir" placeholder="C:\Minecraft\Server" />
          </label>
          <p class="empty-state">
            server.properties (port, RCON, motd, max players, ...) and eula.txt live in this folder and are read
            directly from there.
          </p>
        </section>
        <section class="settings-section">
          <h3>Launch</h3>
          <label>
            Launch mode
            <select id="mcss-launchmode">
              <option value="jar">Jar (vanilla / Fabric / Paper / Spigot)</option>
              <option value="script">Launch script (modern Forge, or your own custom start script)</option>
            </select>
          </label>
          <label id="mcss-jarfield-label">
            Jar file name
            <input id="mcss-jarfilename" placeholder="server.jar" />
          </label>
          <label id="mcss-scriptfield-label">
            Script file name
            <input id="mcss-scriptfilename" placeholder="run.bat" />
          </label>
          <div class="settings-grid2">
            <label>
              Min memory (MB)
              <input id="mcss-minmemory" type="number" />
            </label>
            <label>
              Max memory (MB)
              <input id="mcss-maxmemory" type="number" />
            </label>
          </div>
          <label>
            Extra JVM arguments
            <input id="mcss-extrajvmargs" placeholder="-XX:+UseG1GC" />
          </label>
          <label>
            Extra program arguments
            <input id="mcss-extraprogramargs" placeholder="nogui" />
          </label>
        </section>
        <section class="settings-section">
          <h3>Extra Settings</h3>
          <label>
            Dashboard group
            <input id="mcss-group" placeholder="(none)" />
          </label>
          <label class="checkbox"><input id="mcss-hidden" type="checkbox" /> Hide from the main dashboard</label>
        </section>
        <p id="mc-startsettings-error" class="error-message" style="display: none"></p>
      </form>
    </main>
  </section>
  <section id="view-mc-serversettings" class="view">
    <header>
      <h1>MC Server Settings</h1>
      <select id="mc-serversettings-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="mc-serversettings-no-server" class="empty-state">No Minecraft server selected - choose one above.</p>
      <div id="mc-serversettings-content" class="admin-tab-content">
        <p class="empty-state">
          Editing server.properties directly. Minecraft only re-reads it at startup - a change made here takes
          effect the next time this server starts, not live.
        </p>
        <div id="mc-serversettings-fields"></div>
        <p id="mc-serversettings-error" class="error-message" style="display: none"></p>
      </div>
    </main>
  </section>
  <section id="view-mc-mods" class="view">
    <header>
      <h1>MC Mods</h1>
      <select id="mc-mods-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="mc-mods-no-server" class="empty-state">No Minecraft server selected - choose one above.</p>
      <p id="mc-mods-unsupported" class="empty-state" style="display: none">This server type has no "mods" ecosystem - set Server type in Start Settings to a loader that does (Forge/NeoForge/Fabric, or SpongeForge's own underlying Forge layer).</p>
      <div id="mc-mods-content" class="admin-tab-content">
        <p class="empty-state">
          Mods are searched and installed from Modrinth, plus CurseForge too once a CurseForge API key is
          configured - set this server's Minecraft version and server type in Start Settings first.
        </p>
        <section id="mc-mods-search-section" class="settings-section">
          <h3 class="mc-mods-browse-heading">
            <img id="mc-mods-browse-icon" class="server-type-icon" alt="" style="display: none" />
            Search Modrinth / CurseForge
          </h3>
          <div class="form-actions">
            <input id="mc-mods-search-query" placeholder="Search mods..." />
            <button id="btn-mc-mods-search" type="button">Search</button>
          </div>
          <p id="mc-mods-search-error" class="error-message" style="display: none"></p>
          <div id="mc-mods-search-results" class="ark-mod-search-results"></div>
        </section>
        <div class="form-actions">
          <button id="btn-mc-mods-rescan" type="button">Rescan folder</button>
          <button id="btn-mc-mods-updatecheck" type="button">Check for updates</button>
        </div>
        <table id="mc-mods-table" class="data-table">
          <thead>
            <tr><th>Enable</th><th>Name</th><th>Source</th><th>Version</th><th></th></tr>
          </thead>
          <tbody id="mc-mods-table-body"></tbody>
        </table>
        <p id="mc-mods-error" class="error-message" style="display: none"></p>
      </div>
    </main>
  </section>
  <section id="view-mc-plugins" class="view">
    <header>
      <h1>MC Plugins</h1>
      <select id="mc-plugins-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="mc-plugins-no-server" class="empty-state">No Minecraft server selected - choose one above.</p>
      <p id="mc-plugins-unsupported" class="empty-state" style="display: none">This server type has no "plugins" ecosystem - set Server type in Start Settings to a loader that does (Paper/Spigot/SpongeVanilla, or SpongeForge's own Sponge layer).</p>
      <div id="mc-plugins-content" class="admin-tab-content">
        <p class="empty-state">
          Plugins are searched and installed from Modrinth, plus CurseForge too once a CurseForge API key is
          configured - set this server's Minecraft version and server type in Start Settings first.
        </p>
        <section id="mc-plugins-search-section" class="settings-section">
          <h3 class="mc-mods-browse-heading">
            <img id="mc-plugins-browse-icon" class="server-type-icon" alt="" style="display: none" />
            Search Modrinth / CurseForge
          </h3>
          <div class="form-actions">
            <input id="mc-plugins-search-query" placeholder="Search plugins..." />
            <button id="btn-mc-plugins-search" type="button">Search</button>
          </div>
          <p id="mc-plugins-search-error" class="error-message" style="display: none"></p>
          <div id="mc-plugins-search-results" class="ark-mod-search-results"></div>
        </section>
        <div class="form-actions">
          <button id="btn-mc-plugins-rescan" type="button">Rescan folder</button>
          <button id="btn-mc-plugins-updatecheck" type="button">Check for updates</button>
        </div>
        <table id="mc-plugins-table" class="data-table">
          <thead>
            <tr><th>Enable</th><th>Name</th><th>Source</th><th>Version</th><th></th></tr>
          </thead>
          <tbody id="mc-plugins-table-body"></tbody>
        </table>
        <p id="mc-plugins-error" class="error-message" style="display: none"></p>
      </div>
    </main>
  </section>
  <section id="view-mc-backup" class="view">
    <header>
      <h1>MC Backup</h1>
      <select id="mc-backup-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="mc-backup-no-server" class="empty-state">No Minecraft server selected - choose one above.</p>
      <div id="mc-backup-content" class="admin-tab-content">
        <section id="mc-backup-settings-section" class="settings-section">
          <h3>Backup Settings</h3>
          <label>
            Backup directory
            <input id="mc-backup-dir" />
          </label>
          <label>
            Backups to keep
            <input id="mc-backup-maxbackups" type="number" min="1" />
          </label>
          <label class="checkbox">
            <input id="mc-backup-schedule-enabled" type="checkbox" /> Enable scheduled automatic backups
          </label>
          <label>
            Backup schedule (cron expression)
            <input id="mc-backup-schedule-cron" placeholder="every 6 hours: 0 */6 * * *" />
          </label>
          <p id="mc-backup-settings-error" class="error-message" style="display: none"></p>
        </section>
        <div class="form-actions">
          <button id="btn-mc-backup-create">Create backup now</button>
          <button id="btn-mc-backup-refresh" type="button">Refresh</button>
        </div>
        <div class="content-row">
          <section class="panel backup-table-panel">
            <h3>World Backups</h3>
            <table id="mc-backup-table">
              <thead>
                <tr><th>File Name</th><th>Size</th><th>Creation Time</th><th></th></tr>
              </thead>
              <tbody id="mc-backup-table-body"></tbody>
            </table>
          </section>
          <aside class="panel backup-log-panel">
            <h3>Backup Process Log</h3>
            <div id="mc-backup-log"></div>
          </aside>
        </div>
      </div>
    </main>
  </section>
  <section id="view-mc-management" class="view">
    <header>
      <h1>MC Server Management</h1>
      <select id="mc-management-server-select" class="server-picker"></select>
    </header>
    <main>
      <p id="mc-management-no-server" class="empty-state">No Minecraft server selected - choose one above.</p>
      <form id="mc-management-content" class="settings-form" onsubmit="return false;">
        <section class="settings-section">
          <h3>Startup</h3>
          <label class="checkbox">
            <input id="mcm-startonlaunch" type="checkbox" /> Start this server when the Manager starts
          </label>
        </section>
        <section class="settings-section">
          <h3>Scheduled Restart</h3>
          <div class="form-actions">
            <label class="checkbox"><input id="mcm-restart-enabled" type="checkbox" /> Shutdown server at:</label>
            <input id="mcm-restart-time" type="time" />
          </div>
          <div id="mcm-restart-days" class="settings-days-row"></div>
          <label class="checkbox"><input id="mcm-restart-startafter" type="checkbox" /> Start server after shutdown</label>
          <p id="mcm-restart-countdown" class="empty-state">Next shutdown in: --:--:--:--</p>
        </section>
        <p id="mc-management-error" class="error-message" style="display: none"></p>
      </form>
    </main>
  </section>
      </div>
    </div>
  </section>
</div>
<script>
// True only when "Require access token" is on (see renderDashboardHtml in webDashboard.ts);
// stays undefined/false otherwise, in which case the token gate below is skipped entirely
// and the page behaves exactly as it did before this feature existed. Not sensitive - just
// a "does this dashboard require a token" flag, not a credential.
var authRequired = typeof window.__authRequired !== 'undefined' && window.__authRequired;
var ACCESS_TOKEN_KEY = 'ark-dashboard-access-token';
var accessToken = null;
try { accessToken = localStorage.getItem(ACCESS_TOKEN_KEY); } catch (err) { /* storage unavailable - not fatal */ }

// Every fetch call in initDashboard() below goes through window.fetch, so wrapping it here
// once - rather than threading the token through every one of those call sites - is enough
// to authenticate all of them. EventSource can't set custom headers at all, so its two call
// sites append the token as a ?token= query parameter instead (requireRole on the server
// accepts either - see src/main/lib/auth.ts's getBearerTokenFromRequest).
var nativeFetch = window.fetch.bind(window);
window.fetch = function (input, init) {
  init = init || {};
  if (accessToken) {
    var headers = new Headers(init.headers || {});
    headers.set('Authorization', 'Bearer ' + accessToken);
    init.headers = headers;
  }
  return nativeFetch(input, init);
};

function validateAccessToken() {
  return fetch('/api/whoami').then(function (res) {
    if (!res.ok) throw new Error('Invalid token');
    return res.json();
  });
}

var tokenGateEl = document.getElementById('token-gate');
var tokenGateFormEl = document.getElementById('token-gate-form');
var tokenGateInputEl = document.getElementById('token-gate-input');
var tokenGateErrorEl = document.getElementById('token-gate-error');

function showTokenGate(message) {
  tokenGateEl.style.display = 'flex';
  tokenGateErrorEl.textContent = message || '';
}

tokenGateFormEl.addEventListener('submit', function (e) {
  e.preventDefault();
  var value = tokenGateInputEl.value.trim();
  if (!value) return;
  accessToken = value;
  validateAccessToken()
    .then(function (data) {
      try { localStorage.setItem(ACCESS_TOKEN_KEY, accessToken); } catch (err) { /* storage unavailable - not fatal */ }
      tokenGateEl.style.display = 'none';
      initDashboard(data.role);
    })
    .catch(function () {
      accessToken = null;
      tokenGateErrorEl.textContent = 'Invalid access token';
    });
});

if (!authRequired) {
  initDashboard(null);
} else if (accessToken) {
  validateAccessToken()
    .then(function (data) { initDashboard(data.role); })
    .catch(function () {
      accessToken = null;
      try { localStorage.removeItem(ACCESS_TOKEN_KEY); } catch (err) { /* storage unavailable - not fatal */ }
      showTokenGate('Saved access token is no longer valid.');
    });
} else {
  showTokenGate();
}

/** Everything the dashboard page actually does, deferred until we know the caller's role -
 *  either immediately with null (no token required at all) or after a stored/just-entered
 *  access token validates via GET /api/whoami above. role drives the same UI-hiding checks
 *  as before this feature existed (roughly: full access when role is null, otherwise hide
 *  what canOperate/canAdmin don't allow) - the real enforcement is server-side (every route
 *  checks this same role); hiding controls here is just so a role never sees a button that
 *  would 401/403 if clicked. */
function initDashboard(resolvedRole) {
  var role = resolvedRole;
  var canOperate = role === 'moderator' || role === 'admin' || role === 'globalAdmin';
  var canAdmin = role === 'admin' || role === 'globalAdmin';

  var currentId = null;
  var es = null;
  var consoleEl = document.getElementById('console');
  var select = document.getElementById('server-select');
  var statusEl = document.getElementById('status');
  var rconForm = document.getElementById('rcon-form');
  var rconInput = document.getElementById('rcon-input');
  var filtersEl = document.getElementById('filters');
  var filtersBarEl = document.getElementById('filters-bar');
  var toggleFiltersBtn = document.getElementById('btn-toggle-filters');
  var playersListEl = document.getElementById('players-list');
  var playersCountEl = document.getElementById('players-count');
  var startBtn = document.getElementById('btn-start');
  var stopBtn = document.getElementById('btn-stop');
  var restartBtn = document.getElementById('btn-restart');
  var stopUpdateRestartBtn = document.getElementById('btn-stop-update-restart');
  var contextMenuEl = null;

  function closeContextMenu() {
    if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
  }
  document.addEventListener('click', closeContextMenu);
  document.addEventListener('scroll', closeContextMenu, true);

  function showToast(message) {
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 2200);
  }

  // navigator.clipboard is only available in a "secure context" - https, or the
  // literal hostnames localhost/127.0.0.1. Reaching this page via a LAN IP (Settings'
  // Host field set to something other than 127.0.0.1) is plain http from a non-localhost
  // hostname, so the Clipboard API is simply absent there - fall back to the older
  // execCommand('copy') approach via a temporary textarea, which still works.
  function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        // fall through - ok stays false, handled below
      }
      textarea.remove();
      if (ok) resolve(); else reject(new Error('Copy command was not available'));
    });
  }

  function showContextMenu(x, y, player) {
    closeContextMenu();
    var menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    var copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy ID';
    copyBtn.addEventListener('click', function () {
      copyToClipboard(player.id)
        .then(function () { showToast('Copied ' + player.name + ' ID to clipboard'); })
        .catch(function () { showToast('Could not copy automatically - ID: ' + player.id); });
    });
    menu.appendChild(copyBtn);

    if (!role || canOperate) {
      var kickBtn = document.createElement('button');
      kickBtn.className = 'danger';
      kickBtn.textContent = 'Kick';
      kickBtn.addEventListener('click', function () {
        if (!currentId) return;
        if (!confirm('Kick ' + player.name + '?')) return;
        fetch('/api/servers/' + encodeURIComponent(currentId) + '/rcon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'KickPlayer ' + player.id })
        });
      });
      menu.appendChild(kickBtn);

      var banBtn = document.createElement('button');
      banBtn.className = 'danger';
      banBtn.textContent = 'Ban';
      banBtn.addEventListener('click', function () {
        if (!currentId) return;
        if (!confirm('Ban ' + player.name + '?')) return;
        var reason = prompt('Reason for banning ' + player.name + '? (optional)', '');
        if (reason === null) return;
        fetch('/api/servers/' + encodeURIComponent(currentId) + '/ban', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId: player.id, playerName: player.name, reason: reason })
        })
          .then(function (res) { return res.json(); })
          .then(function (result) {
            if (result && result.ok) showToast('Banned ' + player.name);
            else showToast('Ban failed: ' + (result && result.error ? result.error : 'unknown error'));
          })
          .catch(function () { showToast('Ban failed'); });
      });
      menu.appendChild(banBtn);
    }

    document.body.appendChild(menu);
    contextMenuEl = menu;
  }

  function loadPlayers() {
    if (!currentId) {
      playersListEl.innerHTML = '';
      playersCountEl.textContent = '0';
      return;
    }
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/players')
      .then(function (r) { return r.json(); })
      .then(function (players) {
        playersCountEl.textContent = String(players.length);
        playersListEl.innerHTML = '';
        if (players.length === 0) {
          var empty = document.createElement('p');
          empty.className = 'empty-state';
          empty.textContent = 'No players connected';
          playersListEl.appendChild(empty);
          return;
        }
        players.forEach(function (p) {
          var row = document.createElement('div');
          row.className = 'player-row';
          row.textContent = p.name;
          row.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(e.clientX, e.clientY, p);
          });
          playersListEl.appendChild(row);
        });
      });
  }

  var FILTERS_COLLAPSED_KEY = 'ark-dashboard-filters-collapsed';
  var filtersCollapsed = false;
  try { filtersCollapsed = localStorage.getItem(FILTERS_COLLAPSED_KEY) === '1'; } catch (err) { /* storage unavailable - not fatal */ }

  function applyFiltersCollapsed() {
    filtersBarEl.classList.toggle('collapsed', filtersCollapsed);
    toggleFiltersBtn.textContent = filtersCollapsed ? 'Events ▸' : 'Events ▾';
  }
  applyFiltersCollapsed();

  toggleFiltersBtn.addEventListener('click', function () {
    filtersCollapsed = !filtersCollapsed;
    try { localStorage.setItem(FILTERS_COLLAPSED_KEY, filtersCollapsed ? '1' : '0'); } catch (err) { /* storage unavailable - not fatal */ }
    applyFiltersCollapsed();
  });

  // Lets the Status + Online players column be hidden to give the console more room -
  // handy on a small screen where it otherwise pushes the console up. The toggle itself
  // lives in the header rather than inside the column, so it stays reachable once collapsed.
  var toggleSideColBtn = document.getElementById('btn-toggle-sidecol');
  var sideColEl = document.getElementById('side-col');
  var SIDE_COL_COLLAPSED_KEY = 'ark-dashboard-sidecol-collapsed';
  var sideColCollapsed = false;
  try { sideColCollapsed = localStorage.getItem(SIDE_COL_COLLAPSED_KEY) === '1'; } catch (err) { /* storage unavailable - not fatal */ }

  function applySideColCollapsed() {
    sideColEl.classList.toggle('collapsed', sideColCollapsed);
    toggleSideColBtn.textContent = sideColCollapsed ? 'Status ▸' : 'Status ▾';
  }
  applySideColCollapsed();

  toggleSideColBtn.addEventListener('click', function () {
    sideColCollapsed = !sideColCollapsed;
    try { localStorage.setItem(SIDE_COL_COLLAPSED_KEY, sideColCollapsed ? '1' : '0'); } catch (err) { /* storage unavailable - not fatal */ }
    applySideColCollapsed();
  });

  // The ARK/Minecraft switch - its own small icon-button pair at the top of the sidebar,
  // toggling which entire .nav-group (and which game's servers show up anywhere else on the
  // page) is active, same component/behavior as the desktop Manager's own GameSwitch
  // (src/renderer/src/App.tsx) rather than mixing both games' nav into one combined list.
  var gameSwitchArkBtn = document.getElementById('game-switch-ark');
  var gameSwitchMinecraftBtn = document.getElementById('game-switch-minecraft');
  var navGroupArkEl = document.getElementById('nav-group-ark');
  var navGroupMinecraftEl = document.getElementById('nav-group-minecraft');
  var gameMode = 'ark';
  function selectGameMode(mode) {
    gameMode = mode;
    gameSwitchArkBtn.classList.toggle('active', mode === 'ark');
    gameSwitchMinecraftBtn.classList.toggle('active', mode === 'minecraft');
    navGroupArkEl.style.display = mode === 'ark' ? '' : 'none';
    navGroupMinecraftEl.style.display = mode === 'minecraft' ? '' : 'none';
    // Always lands on that mode's own "home" view - there's no view that makes sense to stay
    // on across a mode switch (an ARK-shaped view's content would be left showing under the
    // Minecraft nav, or vice versa), same as the desktop Manager always remounting onto that
    // mode's own Dashboard when GameSwitch changes.
    selectView(mode === 'ark' ? 'cluster' : 'mcdashboard');
  }
  gameSwitchArkBtn.addEventListener('click', function () { selectGameMode('ark'); });
  gameSwitchMinecraftBtn.addEventListener('click', function () { selectGameMode('minecraft'); });

  var navDashboardBtn = document.getElementById('nav-dashboard');
  var navClusterBtn = document.getElementById('nav-cluster');
  var navMcDashboardBtn = document.getElementById('nav-mcdashboard');
  // Per-server "Manage" shell - replaces the old permanent flat nav buttons (Console,
  // Analytics, Settings, ...) with a grouped side nav built fresh on every navigation
  // (renderServerDetailNav below), same as the desktop Manager's own ServerDetail/
  // MinecraftServerDetail.
  var serverDetailShellEl = document.getElementById('view-server-detail');
  var serverDetailNavEl = document.getElementById('server-detail-nav');
  var serverDetailBackBtn = document.getElementById('btn-server-detail-back');
  var serverDetailTitleEl = document.getElementById('server-detail-title');
  var viewMcDashboardEl = document.getElementById('view-mcdashboard');
  var mcdashboardCardsEl = document.getElementById('mcdashboard-cards');
  var viewMcStartSettingsEl = document.getElementById('view-mc-startsettings');
  var viewMcServerSettingsEl = document.getElementById('view-mc-serversettings');
  var viewMcModsEl = document.getElementById('view-mc-mods');
  var viewMcPluginsEl = document.getElementById('view-mc-plugins');
  var viewMcBackupEl = document.getElementById('view-mc-backup');
  var viewMcManagementEl = document.getElementById('view-mc-management');
  var viewDashboardEl = document.getElementById('view-dashboard');
  var dashboardCardsEl = document.getElementById('dashboard-cards');
  var viewClusterEl = document.getElementById('view-cluster');
  var viewConsoleEl = document.getElementById('view-console');
  var viewAnalyticsEl = document.getElementById('view-analytics');
  var viewBackupEl = document.getElementById('view-backup');
  var viewSettingsEl = document.getElementById('view-settings');
  var viewModsEl = document.getElementById('view-mods');
  var viewMapManagementEl = document.getElementById('view-mapmanagement');
  var viewFilesEl = document.getElementById('view-files');
  var viewServerManagementEl = document.getElementById('view-servermanagement');
  var viewUpdateLogEl = document.getElementById('view-updatelog');
  var clusterCardsEl = document.getElementById('cluster-cards');
  var clusterGroupsEl = document.getElementById('cluster-groups');
  var clusterConsoleEl = document.getElementById('cluster-console');
  var clusterConsoleBackBtn = document.getElementById('btn-cluster-console-back');
  var clusterConsoleTitleEl = document.getElementById('cluster-console-title');
  var clusterConsoleFiltersBarEl = document.getElementById('cluster-console-filters-bar');
  var clusterConsoleFiltersEl = document.getElementById('cluster-console-filters');
  var clusterConsoleToggleFiltersBtn = document.getElementById('btn-cluster-toggle-filters');
  var clusterConsoleStatsEl = document.getElementById('cluster-console-stats');
  var clusterConsoleFeedEl = document.getElementById('cluster-console-feed');
  var clusterConsoleRconResultsEl = document.getElementById('cluster-console-rcon-results');
  var clusterConsoleRconForm = document.getElementById('cluster-console-rcon-form');
  var clusterConsoleRconTargetEl = document.getElementById('cluster-console-rcon-target');
  var clusterConsoleRconInputEl = document.getElementById('cluster-console-rcon-input');
  var clusterConsoleSidecolEl = document.getElementById('cluster-console-sidecol');
  var clusterConsoleToggleSidecolBtn = document.getElementById('btn-cluster-toggle-sidecol');
  var clusterConsoleCardsEl = document.getElementById('cluster-console-cards');

  // Same collapse-to-localStorage pattern as the Dashboard view's own Events/Status
  // toggles above - independent keys, so collapsing one view's filters/side info doesn't
  // affect the other's.
  var CLUSTER_FILTERS_COLLAPSED_KEY = 'ark-dashboard-cluster-filters-collapsed';
  var clusterFiltersCollapsed = false;
  try { clusterFiltersCollapsed = localStorage.getItem(CLUSTER_FILTERS_COLLAPSED_KEY) === '1'; } catch (err) { /* storage unavailable - not fatal */ }

  function applyClusterFiltersCollapsed() {
    clusterConsoleFiltersBarEl.classList.toggle('collapsed', clusterFiltersCollapsed);
    clusterConsoleToggleFiltersBtn.textContent = clusterFiltersCollapsed ? 'Show ▸' : 'Show ▾';
  }
  applyClusterFiltersCollapsed();

  clusterConsoleToggleFiltersBtn.addEventListener('click', function () {
    clusterFiltersCollapsed = !clusterFiltersCollapsed;
    try { localStorage.setItem(CLUSTER_FILTERS_COLLAPSED_KEY, clusterFiltersCollapsed ? '1' : '0'); } catch (err) { /* storage unavailable - not fatal */ }
    applyClusterFiltersCollapsed();
  });

  var CLUSTER_SIDECOL_COLLAPSED_KEY = 'ark-dashboard-cluster-sidecol-collapsed';
  var clusterSidecolCollapsed = false;
  try { clusterSidecolCollapsed = localStorage.getItem(CLUSTER_SIDECOL_COLLAPSED_KEY) === '1'; } catch (err) { /* storage unavailable - not fatal */ }

  function applyClusterSidecolCollapsed() {
    clusterConsoleSidecolEl.classList.toggle('collapsed', clusterSidecolCollapsed);
    clusterConsoleToggleSidecolBtn.textContent = clusterSidecolCollapsed ? 'Servers ▸' : 'Servers ▾';
  }
  applyClusterSidecolCollapsed();

  clusterConsoleToggleSidecolBtn.addEventListener('click', function () {
    clusterSidecolCollapsed = !clusterSidecolCollapsed;
    try { localStorage.setItem(CLUSTER_SIDECOL_COLLAPSED_KEY, clusterSidecolCollapsed ? '1' : '0'); } catch (err) { /* storage unavailable - not fatal */ }
    applyClusterSidecolCollapsed();
  });

  // The Dashboard tab (card grid, admin-only) is always visible like Cluster Dashboard - not
  // tied to a specific server the way the per-server "Manage" shell below is.
  if (role && !canAdmin) navDashboardBtn.style.display = 'none';

  // The per-server "Manage" shell (grouped side nav, built fresh by renderServerDetailNav
  // further down - see ARK_MANAGE_TABS/mcManageTabsFor/tabAllowedForRole - once a server tab
  // is actually picked) only belongs on screen while a server-scoped view is active - on
  // Dashboard/Cluster Dashboard/Minecraft Servers it would just be an empty shell for a
  // server that isn't even on screen anymore. Recomputed on every view change (see
  // applyActiveView below) against these two lists, rather than a one-time reveal that used
  // to stick around for the rest of the page's session even after navigating back to an
  // overview tab.
  var SERVER_SCOPED_VIEWS = ['console', 'analytics', 'backup', 'settings', 'mods', 'mapmanagement', 'files', 'servermanagement', 'updatelog'];
  // Minecraft's own per-server views - 'console' isn't repeated here since it's shared with
  // ARK's own entry in SERVER_SCOPED_VIEWS above; the shell-visibility check in
  // applyActiveView ORs both lists together so either game's per-server view opens it.
  var MC_SERVER_SCOPED_VIEWS = ['mc-startsettings', 'mc-serversettings', 'mc-mods', 'mc-plugins', 'mc-backup', 'mc-management'];
  if (role && !canOperate) {
    startBtn.style.display = 'none';
    stopBtn.style.display = 'none';
    restartBtn.style.display = 'none';
    stopUpdateRestartBtn.style.display = 'none';
    rconForm.style.display = 'none';
    clusterConsoleRconForm.style.display = 'none';
  }
  if (role) {
    var sidebarEl = document.getElementById('sidebar');
    var logoutBtn = document.createElement('button');
    logoutBtn.className = 'nav-btn nav-logout';
    logoutBtn.type = 'button';
    logoutBtn.textContent = 'Log out (' + role + ')';
    logoutBtn.addEventListener('click', function () {
      accessToken = null;
      try { localStorage.removeItem(ACCESS_TOKEN_KEY); } catch (err) { /* storage unavailable - not fatal */ }
      location.reload();
    });
    sidebarEl.appendChild(logoutBtn);
  }

  // Cluster Dashboard is always the landing tab now - no remembered-last-view restore
  // across page loads, matching "Cluster Dashboard is the main tab" rather than
  // occasionally reopening straight into a single server's Dashboard/Backup/admin view.
  var activeView = 'cluster';

  function applyActiveView() {
    var serverScoped = SERVER_SCOPED_VIEWS.indexOf(activeView) !== -1 || MC_SERVER_SCOPED_VIEWS.indexOf(activeView) !== -1;
    serverDetailShellEl.classList.toggle('active', serverScoped);
    if (serverScoped) renderServerDetailNav();
    navDashboardBtn.classList.toggle('active', activeView === 'dashboard');
    navClusterBtn.classList.toggle('active', activeView === 'cluster');
    navMcDashboardBtn.classList.toggle('active', activeView === 'mcdashboard');
    viewMcDashboardEl.classList.toggle('active', activeView === 'mcdashboard');
    viewMcStartSettingsEl.classList.toggle('active', activeView === 'mc-startsettings');
    viewMcServerSettingsEl.classList.toggle('active', activeView === 'mc-serversettings');
    viewMcModsEl.classList.toggle('active', activeView === 'mc-mods');
    viewMcPluginsEl.classList.toggle('active', activeView === 'mc-plugins');
    viewMcBackupEl.classList.toggle('active', activeView === 'mc-backup');
    viewMcManagementEl.classList.toggle('active', activeView === 'mc-management');
    viewDashboardEl.classList.toggle('active', activeView === 'dashboard');
    viewClusterEl.classList.toggle('active', activeView === 'cluster');
    viewConsoleEl.classList.toggle('active', activeView === 'console');
    viewAnalyticsEl.classList.toggle('active', activeView === 'analytics');
    viewBackupEl.classList.toggle('active', activeView === 'backup');
    viewSettingsEl.classList.toggle('active', activeView === 'settings');
    viewModsEl.classList.toggle('active', activeView === 'mods');
    viewMapManagementEl.classList.toggle('active', activeView === 'mapmanagement');
    viewFilesEl.classList.toggle('active', activeView === 'files');
    viewServerManagementEl.classList.toggle('active', activeView === 'servermanagement');
    viewUpdateLogEl.classList.toggle('active', activeView === 'updatelog');
    if (activeView === 'dashboard') renderDashboardCards(latestServers.filter(isArkServerEntry));
    if (activeView === 'analytics') loadAnalyticsView();
    if (activeView === 'backup') loadBackupView();
    if (activeView === 'settings') loadSettingsView();
    if (activeView === 'mods') loadModsView();
    if (activeView === 'mapmanagement') loadMapManagementView();
    if (activeView === 'files') loadFilesView();
    if (activeView === 'servermanagement') loadServerManagementView();
    if (activeView === 'updatelog') loadUpdateLogView();
    if (activeView === 'mcdashboard') renderMcDashboardCards(latestServers.filter(isMcServerEntry));
    if (activeView === 'mc-startsettings') loadMcStartSettingsView();
    if (activeView === 'mc-serversettings') loadMcServerSettingsView();
    if (activeView === 'mc-mods') loadMcModsView();
    if (activeView === 'mc-plugins') loadMcPluginsView();
    if (activeView === 'mc-backup') loadMcBackupView();
    if (activeView === 'mc-management') loadMcManagementView();
  }

  function selectView(view) {
    activeView = view;
    applyActiveView();
  }
  navDashboardBtn.addEventListener('click', function () { selectView('dashboard'); });
  navClusterBtn.addEventListener('click', function () { selectView('cluster'); });
  navMcDashboardBtn.addEventListener('click', function () { selectView('mcdashboard'); });
  serverDetailBackBtn.addEventListener('click', function () { selectView(gameMode === 'minecraft' ? 'mcdashboard' : 'cluster'); });

  // ---- Cluster stats chart (desktop only) ----------------------------------------------
  // Same 1m/5m/15m/1h/6h/12h/24h/All time scales and persistent, server-downsampled history
  // as the desktop Manager's own Cluster Dashboard (src/main/lib/statsHistory.ts) - queried
  // over HTTP (GET /api/groups/:group/stats) once per poll (loadServers() already runs every
  // 5s) instead of sampled/accumulated client-side, so every viewer of this page sees the
  // same history the Manager itself recorded rather than their own separate per-browser
  // copy, and only servers with stats enabled (Analytics tab) contribute to a group's chart.
  var STATS_TIME_SCALES = [
    { label: '1m', ms: 60 * 1000 },
    { label: '5m', ms: 5 * 60 * 1000 },
    { label: '15m', ms: 15 * 60 * 1000 },
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '6h', ms: 6 * 60 * 60 * 1000 },
    { label: '12h', ms: 12 * 60 * 60 * 1000 },
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
    { label: 'All', ms: null }
  ];
  var STATS_SCALE_KEY = 'web-dashboard-cluster-stats-scale';
  var STATS_MAX_POINTS = 500;
  var DESKTOP_CHART_MIN_WIDTH = 701;
  // Named rather than indexed into STATS_TIME_SCALES so adding/reordering scales can't
  // silently change which one a fresh viewer starts on - matches the desktop Manager's own
  // STATS_DEFAULT_SCALE_MS (src/renderer/src/lib/sparkline.ts).
  var STATS_DEFAULT_SCALE_MS = 12 * 60 * 60 * 1000;

  function loadStoredScale() {
    var raw = null;
    try { raw = localStorage.getItem(STATS_SCALE_KEY); } catch (err) { /* storage unavailable */ }
    if (raw === null) return STATS_DEFAULT_SCALE_MS;
    var parsed = raw === 'null' ? null : Number(raw);
    var known = STATS_TIME_SCALES.some(function (s) { return s.ms === parsed; });
    return known ? parsed : STATS_DEFAULT_SCALE_MS;
  }

  function saveStoredScale(ms) {
    try { localStorage.setItem(STATS_SCALE_KEY, ms === null ? 'null' : String(ms)); } catch (err) { /* storage unavailable - not fatal */ }
  }

  var statsScale = loadStoredScale();
  var MAX_CONTINUOUS_GAP_MS = 60000;

  function buildTimeSeriesPath(samples, windowMs, now, width, height, min, max, maxGapMs) {
    if (samples.length === 0) return '';
    maxGapMs = maxGapMs || MAX_CONTINUOUS_GAP_MS;
    var range = (max - min) || 1;
    var start = now - windowMs;
    var span = windowMs || 1;
    var d = '';
    var previousTime = null;
    samples.forEach(function (s) {
      var x = Math.max(0, Math.min(width, ((s.time - start) / span) * width));
      var y = Math.max(0, Math.min(height, height - ((s.value - min) / range) * height));
      var command = previousTime === null || s.time - previousTime > maxGapMs ? 'M' : 'L';
      d += command + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
      previousTime = s.time;
    });
    return d.trim();
  }

  var STATS_CHART_WIDTH = 1000;
  var STATS_CHART_HEIGHT = 30;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function buildSparkline(label, unit, current, samples, windowMs, now, color, max, maxGapMs) {
    var wrap = document.createElement('div');
    wrap.className = 'stats-chart';

    var labelRow = document.createElement('div');
    labelRow.className = 'stats-chart-label';
    var labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    var currentStrong = document.createElement('strong');
    currentStrong.textContent = current !== undefined ? Math.round(current) + unit : '-';
    labelRow.appendChild(labelSpan);
    labelRow.appendChild(currentStrong);
    wrap.appendChild(labelRow);

    var svgWrap = document.createElement('div');
    svgWrap.className = 'stats-chart-svg-wrap';
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + STATS_CHART_WIDTH + ' ' + STATS_CHART_HEIGHT);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'stats-chart-svg');
    var pathD = buildTimeSeriesPath(samples, windowMs, now, STATS_CHART_WIDTH, STATS_CHART_HEIGHT, 0, max, maxGapMs);
    if (pathD) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', pathD);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(path);
    }
    svgWrap.appendChild(svg);

    var hoverLine = document.createElement('div');
    hoverLine.className = 'stats-chart-hover-line';
    hoverLine.style.display = 'none';
    var tooltip = document.createElement('div');
    tooltip.className = 'stats-chart-tooltip';
    tooltip.style.display = 'none';
    svgWrap.appendChild(hoverLine);
    svgWrap.appendChild(tooltip);

    svgWrap.addEventListener('mousemove', function (e) {
      var rect = svgWrap.getBoundingClientRect();
      if (rect.width === 0 || samples.length === 0) return;
      var fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      var targetTime = now - windowMs + fraction * windowMs;
      var nearest = samples[0];
      samples.forEach(function (s) {
        if (Math.abs(s.time - targetTime) < Math.abs(nearest.time - targetTime)) nearest = s;
      });
      var xPercent = (fraction * 100).toFixed(2) + '%';
      hoverLine.style.left = xPercent;
      hoverLine.style.display = 'block';
      tooltip.style.left = xPercent;
      tooltip.style.display = 'block';
      tooltip.textContent = new Date(nearest.time).toLocaleTimeString() + ' · ' + Math.round(nearest.value) + unit;
    });
    svgWrap.addEventListener('mouseleave', function () {
      hoverLine.style.display = 'none';
      tooltip.style.display = 'none';
    });

    wrap.appendChild(svgWrap);
    return wrap;
  }

  function buildClusterChart(history, windowMs, now) {
    var latest = history[history.length - 1];
    var cpuSamples = history.map(function (h) { return { time: h.time, value: h.cpu }; });
    var memorySamples = history.map(function (h) { return { time: h.time, value: h.memoryMB }; });
    var playerSamples = history.map(function (h) { return { time: h.time, value: h.players }; });
    var cpuMax = Math.max(10, cpuSamples.reduce(function (m, s) { return Math.max(m, s.value); }, 0));
    var memoryMax = Math.max(100, memorySamples.reduce(function (m, s) { return Math.max(m, s.value); }, 0));
    // Scaled to the highest player count actually seen (never the group's combined slot
    // count) - against a large combined cap, 0 vs 1 connected player is an imperceptible
    // blip. A floor of 1 keeps an all-zero window from dividing by zero.
    var playersMax = Math.max(1, playerSamples.reduce(function (m, s) { return Math.max(m, s.value); }, 0));
    var maxGapMs = Math.max(MAX_CONTINUOUS_GAP_MS, (windowMs / Math.max(history.length, 1)) * 3);

    var container = document.createElement('div');
    container.className = 'cluster-card-chart';
    container.appendChild(
      buildSparkline('CPU', '%', latest ? latest.cpu : undefined, cpuSamples, windowMs, now, 'var(--accent)', cpuMax, maxGapMs)
    );
    container.appendChild(
      buildSparkline('RAM', ' MB', latest ? latest.memoryMB : undefined, memorySamples, windowMs, now, 'var(--ok)', memoryMax, maxGapMs)
    );
    container.appendChild(
      buildSparkline(
        'Players',
        '',
        latest ? latest.players : undefined,
        playerSamples,
        windowMs,
        now,
        'var(--warn)',
        playersMax,
        maxGapMs
      )
    );
    return container;
  }

  var clusterTimeScaleEl = document.getElementById('cluster-time-scale');
  var timeScaleButtons = Array.prototype.slice.call(document.querySelectorAll('.time-scale-btn'));
  function scaleFromButton(btn) {
    var raw = btn.getAttribute('data-ms');
    return raw === 'null' ? null : Number(raw);
  }
  function updateTimeScaleButtons() {
    timeScaleButtons.forEach(function (btn) {
      btn.classList.toggle('active', scaleFromButton(btn) === statsScale);
    });
  }
  updateTimeScaleButtons();
  timeScaleButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      statsScale = scaleFromButton(btn);
      saveStoredScale(statsScale);
      updateTimeScaleButtons();
      renderClusterCards(latestServers.filter(isArkServerEntry));
    });
  });

  // "Ungrouped" row) - like the desktop Manager's own Cluster Dashboard rows: how many of
  // the group's servers are online (offline count in parens), combined players/max,
  // combined CPU%, combined RAM. Tapping a row opens that group's mobile Group Console.
  // Built from the same /api/servers response loadServers() already fetches every poll,
  // no separate request needed. The desktop-only stats chart is fetched separately and
  // appended to this row once its own request resolves - see renderClusterCards. Returns an
  // "entry" (the row element plus references to the bits that change every poll) rather
  // than just the element, so renderClusterCards can update those in place on later polls
  // instead of tearing down and rebuilding the whole row - see the comment above that
  // function for why that matters.
  function buildGroupRow(g) {
    var card = document.createElement('div');
    card.className = 'cluster-card';

    var header = document.createElement('div');
    header.className = 'cluster-card-header';
    var name = document.createElement('h3');
    name.textContent = g.displayName;
    var online = document.createElement('span');
    online.className = 'group-row-online';
    header.appendChild(name);
    header.appendChild(online);

    var stats = document.createElement('div');
    stats.className = 'cluster-card-stats';
    var playersValue = document.createElement('span');
    var cpuValue = document.createElement('span');
    var ramValue = document.createElement('span');
    var lines = [
      ['Players', playersValue],
      ['CPU', cpuValue],
      ['RAM', ramValue]
    ];
    lines.forEach(function (pair) {
      var line = document.createElement('div');
      var strong = document.createElement('strong');
      strong.textContent = pair[0] + ': ';
      line.appendChild(strong);
      line.appendChild(pair[1]);
      stats.appendChild(line);
    });

    card.appendChild(header);
    card.appendChild(stats);

    card.addEventListener('click', function () { openGroupConsole(g.groupName); });
    return {
      el: card,
      onlineEl: online,
      playersValueEl: playersValue,
      cpuValueEl: cpuValue,
      ramValueEl: ramValue,
      chartEl: null
    };
  }

  function updateGroupRow(entry, g) {
    entry.onlineEl.textContent = g.onlineCount + '/' + g.servers.length;
    var offlineCount = g.servers.length - g.onlineCount;
    if (offlineCount > 0) {
      var offline = document.createElement('span');
      offline.className = 'group-row-offline';
      offline.textContent = ' (' + offlineCount + ' off)';
      entry.onlineEl.appendChild(offline);
    }
    entry.playersValueEl.textContent = g.totalPlayers + '/' + g.totalMaxPlayers;
    entry.cpuValueEl.textContent = g.totalCpu.toFixed(1) + '%';
    entry.ramValueEl.textContent = g.totalMemoryMB + ' MB';
  }

  // Persists across polls (unlike a local variable inside renderClusterCards) so each poll
  // can update an existing row's text/chart in place instead of tearing the whole card list
  // down and rebuilding it from scratch - that used to blank every card (numbers and chart
  // alike) for the moment between the rebuild and the chart's own re-fetch resolving,
  // visible as a distracting flicker every 5s poll even though nothing had actually changed.
  var clusterRowEntries = {};

  // Same grouping/ordering as the desktop dashboard: ungrouped servers first, then each
  // named group alphabetically (the already-sorted /api/servers response puts them in
  // that order already). Plain totals update immediately from data loadServers() already
  // has; the desktop-only stats chart (same persistent store + 6h/12h/24h/All scales as
  // the Manager) is fetched per group from /api/groups/:group/stats and swapped in once it
  // resolves, so a slow/failed fetch never blocks the totals from updating.
  function renderClusterCards(allServers) {
    // A group minimized on the desktop Manager's own Dashboard is left out here too - the
    // server itself stays fully manageable (still in every server picker), just not counted
    // into this aggregate view.
    var servers = allServers.filter(function (s) { return !s.groupCollapsed; });
    if (clusterTimeScaleEl) clusterTimeScaleEl.style.display = servers.length > 0 ? '' : 'none';
    var byGroup = {};
    var order = [];
    servers.forEach(function (s) {
      var key = s.group || '';
      if (!byGroup[key]) { byGroup[key] = []; order.push(key); }
      byGroup[key].push(s);
    });
    var groups = {};
    var seenKeys = {};
    order.forEach(function (key) {
      var list = byGroup[key];
      var g = {
        groupName: key,
        displayName: key || 'Ungrouped',
        servers: list,
        onlineCount: list.filter(function (s) { return s.state === 'running'; }).length,
        totalPlayers: list.reduce(function (sum, s) { return sum + (s.players ? s.players.length : 0); }, 0),
        totalMaxPlayers: list.reduce(function (sum, s) { return sum + (s.maxPlayers || 0); }, 0),
        totalCpu: list.reduce(function (sum, s) { return sum + (s.cpu || 0); }, 0),
        totalMemoryMB: list.reduce(function (sum, s) { return sum + (s.memoryMB || 0); }, 0)
      };
      groups[key] = g;
      seenKeys[key] = true;
      var entry = clusterRowEntries[key];
      if (!entry) {
        entry = buildGroupRow(g);
        clusterRowEntries[key] = entry;
      }
      updateGroupRow(entry, g);
      // appendChild on a node already in the DOM just moves it - cheap, and doesn't blank
      // or re-flow anything else, so this both adds new rows and keeps existing ones in the
      // right order as the group list changes.
      clusterCardsEl.appendChild(entry.el);
    });

    // A group that no longer has any servers in it (last one moved out, or deleted).
    Object.keys(clusterRowEntries).forEach(function (key) {
      if (seenKeys[key]) return;
      clusterRowEntries[key].el.remove();
      delete clusterRowEntries[key];
    });

    var belowDesktopWidth = window.innerWidth < DESKTOP_CHART_MIN_WIDTH;
    var now = Date.now();
    var sinceParam = statsScale === null ? 'null' : String(now - statsScale);
    order.forEach(function (key) {
      var g = groups[key];
      var entry = clusterRowEntries[key];
      // Nothing running in this group right now, or the window has shrunk below the
      // desktop breakpoint - same as the desktop Manager's own Cluster Dashboard, there's
      // nothing live to show (or no room to show it), and a stale chart would misrepresent
      // the group as merely idle instead of fully down.
      if (belowDesktopWidth || g.onlineCount === 0) {
        if (entry.chartEl) { entry.chartEl.remove(); entry.chartEl = null; }
        return;
      }
      var urlToken = key ? encodeURIComponent(key) : UNGROUPED_TOKEN;
      fetch('/api/groups/' + urlToken + '/stats?since=' + sinceParam + '&maxPoints=' + STATS_MAX_POINTS)
        .then(function (res) { return res.ok ? res.json() : []; })
        .then(function (history) {
          if (!Array.isArray(history) || history.length === 0) return;
          // The group (or its row) may have disappeared while this fetch was in flight.
          var currentEntry = clusterRowEntries[key];
          if (!currentEntry) return;
          var windowMs = statsScale !== null ? statsScale : Math.max(1, Date.now() - history[0].time);
          var chart = buildClusterChart(history, windowMs, Date.now());
          chart.addEventListener('click', function (e) { e.stopPropagation(); });
          // Swaps the old chart for the new one in a single operation (or just appends if
          // there wasn't one yet) instead of removing then re-adding, so there's never a
          // moment where the row has no chart at all.
          if (currentEntry.chartEl) currentEntry.chartEl.replaceWith(chart);
          else currentEntry.el.appendChild(chart);
          currentEntry.chartEl = chart;
        })
        .catch(function () { /* stats chart is best-effort - totals above already updated */ });
    });
  }

  // ---- Mobile Group Console (drills down from a group row above) ----------------------

  var UNGROUPED_TOKEN = '_ungrouped_';
  var CLUSTER_ALL_LABELS = ['JOIN', 'LEFT', 'CHAT', 'WARN', 'KILL', 'TAME', 'CMD', 'SAVE', 'CRYO', 'MISSION', 'READY', 'START', 'STOP', 'UPDATE'];
  var CLUSTER_VISIBLE_LABELS_KEY = 'ark-dashboard-cluster-visible-labels';
  var CLUSTER_AUTOSCROLL_KEY = 'ark-dashboard-cluster-autoscroll';
  var clusterAutoScroll = false;
  try { clusterAutoScroll = localStorage.getItem(CLUSTER_AUTOSCROLL_KEY) === '1'; } catch (err) { /* storage unavailable - not fatal */ }
  var clusterConsoleGroup = null; // null = showing the group list; otherwise the raw group name ('' for ungrouped)
  var clusterConsoleServers = [];
  var clusterEs = null;
  var latestServers = [];
  // Every admin-tab view below that's genuinely ARK-shaped (Settings, Analytics, Map
  // Management, Update Log - plus ARK's own Mods/Backup/Server Management, which now have
  // real Minecraft-shaped counterparts of their own: MC Mods/MC Backup/MC Server Management,
  // in their own always-visible sidebar section further down) checks this before loading, and
  // shows a plain "not available" message instead of fetching/rendering data shaped for a
  // ServerProfile against what's actually a MinecraftProfile - Console/Dashboard/Cluster
  // Dashboard/start-stop/RCON-equivalent already work for both (see webDashboard.ts's own
  // /api/servers and findAnyServer on the server side).
  function isMinecraftServer(id) {
    var s = latestServers.find(function (s) { return s.id === id; });
    return !!s && s.gameDisplayName === 'Minecraft';
  }
  function isArkServerEntry(s) { return s.gameDisplayName !== 'Minecraft'; }
  function isMcServerEntry(s) { return s.gameDisplayName === 'Minecraft'; }
  var MINECRAFT_VIEW_UNAVAILABLE_TEXT = 'Not available for Minecraft servers yet - only Console/start/stop currently work here.';
  // Tracks every server's last-seen state for as long as this tab stays open (not tied to
  // the console being open) - mirrors the desktop Manager's module-scope lastKnownStates
  // map, so a transition that happens while you're on a different tab still gets caught
  // and reflected next time you look, instead of that server's now-current state quietly
  // becoming the new unremarked baseline.
  var clusterLastKnownStates = {};

  function loadClusterVisibleLabels() {
    var stored = null;
    try { stored = JSON.parse(localStorage.getItem(CLUSTER_VISIBLE_LABELS_KEY) || 'null'); } catch (err) { /* storage unavailable - not fatal */ }
    if (!Array.isArray(stored)) return CLUSTER_ALL_LABELS.slice();
    return stored.filter(function (l) { return CLUSTER_ALL_LABELS.indexOf(l) !== -1; });
  }
  var clusterVisibleLabels = loadClusterVisibleLabels();
  function saveClusterVisibleLabels() {
    try { localStorage.setItem(CLUSTER_VISIBLE_LABELS_KEY, JSON.stringify(clusterVisibleLabels)); } catch (err) { /* storage unavailable - not fatal */ }
  }

  function applyClusterEventFilter() {
    Array.prototype.forEach.call(clusterConsoleFeedEl.children, function (el) {
      el.style.display = clusterVisibleLabels.indexOf(el.getAttribute('data-label')) !== -1 ? '' : 'none';
    });
  }

  function renderClusterConsoleFilters() {
    clusterConsoleFiltersEl.innerHTML = '';
    var title = document.createElement('span');
    title.textContent = 'Show:';
    clusterConsoleFiltersEl.appendChild(title);
    CLUSTER_ALL_LABELS.forEach(function (label) {
      var wrapper = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = clusterVisibleLabels.indexOf(label) !== -1;
      cb.addEventListener('change', function () {
        var idx = clusterVisibleLabels.indexOf(label);
        if (cb.checked && idx === -1) clusterVisibleLabels.push(label);
        if (!cb.checked && idx !== -1) clusterVisibleLabels.splice(idx, 1);
        saveClusterVisibleLabels();
        applyClusterEventFilter();
      });
      wrapper.appendChild(cb);
      wrapper.appendChild(document.createTextNode(label));
      clusterConsoleFiltersEl.appendChild(wrapper);
    });
    var autoScrollWrapper = document.createElement('label');
    var autoScrollCb = document.createElement('input');
    autoScrollCb.type = 'checkbox';
    autoScrollCb.checked = clusterAutoScroll;
    autoScrollCb.addEventListener('change', function () {
      clusterAutoScroll = autoScrollCb.checked;
      try { localStorage.setItem(CLUSTER_AUTOSCROLL_KEY, clusterAutoScroll ? '1' : '0'); } catch (err) { /* storage unavailable - not fatal */ }
    });
    autoScrollWrapper.appendChild(autoScrollCb);
    autoScrollWrapper.appendChild(document.createTextNode('Auto-scroll'));
    clusterConsoleFiltersEl.appendChild(autoScrollWrapper);
  }

  // "YYYY.MM.DD" (ARK's own log date format, as sent by the merged-backlog/stream) -> "DD/MM".
  function formatDateDDMM(date) {
    var parts = date.split('.');
    return parts.length === 3 ? parts[2] + '/' + parts[1] : date;
  }

  // Same event line as the single-server console, plus the merged feed's date prefix and
  // [Server Name] tag, and no visible label tag for the synthetic START/STOP lines (the
  // label still drives the Show filter above, it's just not printed on the line itself).
  function addClusterEvent(ev) {
    var div = document.createElement('div');
    div.className = 'log-event log-event-' + ev.cls;
    div.setAttribute('data-label', ev.label);
    if (clusterVisibleLabels.indexOf(ev.label) === -1) div.style.display = 'none';
    var ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = formatDateDDMM(ev.date) + ' ' + ev.ts;
    var tag = document.createElement('span');
    tag.className = 'server-tag';
    tag.textContent = '[' + ev.profileName + ']';
    div.appendChild(ts);
    div.appendChild(tag);
    if (ev.label !== 'START' && ev.label !== 'STOP' && ev.label !== 'UPDATE') {
      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = ev.label;
      div.appendChild(label);
    }
    var text = document.createElement('span');
    text.className = 'text';
    renderEventText(text, ev.text);
    div.appendChild(text);
    clusterConsoleFeedEl.appendChild(div);
    if (clusterAutoScroll) clusterConsoleFeedEl.scrollTop = clusterConsoleFeedEl.scrollHeight;
  }

  function renderClusterConsoleStats(servers) {
    var onlineCount = servers.filter(function (s) { return s.state === 'running'; }).length;
    var offlineCount = servers.length - onlineCount;
    var entries = [
      ['Online', onlineCount + ' (' + offlineCount + ' off)'],
      ['Players', String(servers.reduce(function (sum, s) { return sum + (s.players ? s.players.length : 0); }, 0))],
      ['CPU', servers.reduce(function (sum, s) { return sum + (s.cpu || 0); }, 0).toFixed(1) + '%'],
      ['RAM', servers.reduce(function (sum, s) { return sum + (s.memoryMB || 0); }, 0) + ' MB']
    ];
    clusterConsoleStatsEl.innerHTML = '';
    entries.forEach(function (pair) {
      var div = document.createElement('div');
      var dt = document.createElement('dt');
      dt.textContent = pair[0];
      var dd = document.createElement('dd');
      dd.textContent = pair[1];
      div.appendChild(dt);
      div.appendChild(dd);
      clusterConsoleStatsEl.appendChild(div);
    });
  }

  function clusterServerAction(id, action) {
    return fetch('/api/servers/' + encodeURIComponent(id) + '/' + action, { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) showToast('Error: ' + result.error);
        loadServers();
      })
      .catch(function () { showToast('Request failed'); });
  }

  // Reuses the same contextMenuEl/closeContextMenu wiring the online-players' right-click
  // menu already established (document click/scroll listeners dismiss whichever of the two
  // is open) - just a differently-styled, differently-triggered (tap the card's "..." button
  // instead of right-click) menu of the same shape. Same five actions and color coding as
  // the desktop Manager's own Group Console context menu.
  function openActionSheet(x, y, server) {
    closeContextMenu();
    var menu = document.createElement('div');
    menu.className = 'action-sheet';
    menu.style.visibility = 'hidden';

    function addAction(label, cls, disabled, onClick) {
      var btn = document.createElement('button');
      btn.className = cls;
      btn.textContent = label;
      btn.disabled = !!disabled;
      btn.addEventListener('click', function () {
        closeContextMenu();
        onClick();
      });
      menu.appendChild(btn);
    }

    addAction('Start', 'ok', server.state !== 'stopped', function () { clusterServerAction(server.id, 'start'); });
    addAction('Stop', 'danger', server.state !== 'running', function () { clusterServerAction(server.id, 'stop'); });
    if (server.gameDisplayName !== 'Minecraft') {
      addAction('Restart', 'warn', server.state !== 'running', function () { clusterServerAction(server.id, 'restart'); });
      addAction('Update', 'info', server.state !== 'stopped', function () { clusterServerAction(server.id, 'update'); });
      addAction('Update Restart', 'cyan', false, function () {
        if (!confirm('Stop this server, update it via SteamCMD, then start it back up?')) return;
        clusterServerAction(server.id, 'stop-update-restart');
      });
    }

    document.body.appendChild(menu);
    contextMenuEl = menu;

    // Anchored from the tapped button's position, but clamped so a card near the bottom
    // (or edge) of a small phone screen never opens a menu that's partly or fully
    // unreachable - position:fixed doesn't respond to page scroll, so an overflowing menu
    // would otherwise be stuck off-screen with no way to reach it.
    var rect = menu.getBoundingClientRect();
    var left = Math.min(x, window.innerWidth - rect.width - 8);
    var top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
    menu.style.visibility = '';
  }

  // Card-v2's own "..." dropdown - a sibling, separate floating-menu singleton from
  // contextMenuEl/closeContextMenu above (right-click player menu, action sheet): this one
  // lives INSIDE the card itself (position: absolute, see .card-menu-dropdown's own CSS),
  // toggled via a .open class, rather than appended to document.body - matching the desktop
  // Manager's own card menu (Dashboard.tsx's renderCardMenu) exactly, dropdown markup and
  // all, down to the shared .card-menu-dropdown/.card-menu-group/.card-menu-icon classes.
  var openCardMenuEl = null;
  function closeCardMenu() {
    if (openCardMenuEl) { openCardMenuEl.classList.remove('open'); openCardMenuEl = null; }
  }
  document.addEventListener('click', function (e) {
    if (openCardMenuEl && !openCardMenuEl.contains(e.target) && !(e.target.closest && e.target.closest('.card-menu-btn'))) {
      closeCardMenu();
    }
  });
  document.addEventListener('scroll', closeCardMenu, true);

  // Every ARK per-server tab the card's "..." menu can jump straight to - same key/label/
  // icon/group as the desktop Manager's own SERVER_DETAIL_TABS (src/renderer/src/pages/
  // ServerDetail/index.tsx), and the same tier gate already used to show/hide each one's
  // permanent sidebar button in renderServerDetailNav/tabAllowedForRole (tier null = always
  // visible, 'readonly' = hidden only for the readonly role, 'moderator'/'admin' = canOperate/canAdmin).
  var ARK_MANAGE_TABS = [
    { view: 'console', label: 'Console', icon: '🖥️', group: 'Overview', tier: null },
    { view: 'analytics', label: 'Analytics', icon: '📊', group: 'Overview', tier: null },
    { view: 'settings', label: 'Settings', icon: '⚙️', group: 'Configuration', tier: 'admin' },
    { view: 'mods', label: 'Mods', icon: '🧩', group: 'Configuration', tier: 'admin' },
    { view: 'mapmanagement', label: 'Map Management', icon: '🗺️', group: 'Configuration', tier: 'admin' },
    { view: 'backup', label: 'Backups', icon: '💾', group: 'Maintenance', tier: 'readonly' },
    { view: 'updatelog', label: 'Update Log', icon: '📜', group: 'Maintenance', tier: 'admin' },
    { view: 'servermanagement', label: 'Server Management', icon: '🛠️', group: 'Maintenance', tier: 'moderator' },
    { view: 'files', label: 'Files', icon: '📁', group: 'Files', tier: 'admin' }
  ];

  // Same idea for Minecraft - mirrors MinecraftServerDetail/index.tsx's own tabsFor, Mods/
  // Plugins conditionally included per serverType the same way minecraftServerSupportsEcosystem
  // decides on desktop (replicated inline here since the web dashboard's client script has no
  // access to that shared TS module - see MC_MODS_ECOSYSTEM/MC_PLUGINS_ECOSYSTEM below).
  var MC_MODS_SERVER_TYPES = ['forge', 'neoforge', 'fabric', 'spongeforge'];
  var MC_PLUGINS_SERVER_TYPES = ['paper', 'spigot', 'spongevanilla', 'spongeforge'];
  function mcManageTabsFor(serverType) {
    var tabs = [
      { view: 'console', label: 'Console', icon: '🖥️', group: 'Overview', tier: null },
      { view: 'mc-startsettings', label: 'Start Settings', icon: '🚀', group: 'Configuration', tier: 'admin' },
      { view: 'mc-serversettings', label: 'Server Settings', icon: '📝', group: 'Configuration', tier: 'moderator' }
    ];
    if (MC_MODS_SERVER_TYPES.indexOf(serverType) !== -1) {
      tabs.push({ view: 'mc-mods', label: 'Mods', icon: '🧩', group: 'Configuration', tier: 'admin' });
    }
    if (MC_PLUGINS_SERVER_TYPES.indexOf(serverType) !== -1) {
      tabs.push({ view: 'mc-plugins', label: 'Plugins', icon: '🔌', group: 'Configuration', tier: 'admin' });
    }
    tabs.push({ view: 'mc-backup', label: 'Backup', icon: '💾', group: 'Maintenance', tier: 'moderator' });
    tabs.push({ view: 'mc-management', label: 'Server Management', icon: '🛠️', group: 'Maintenance', tier: 'moderator' });
    return tabs;
  }

  function tabAllowedForRole(tier) {
    if (!tier) return true;
    if (tier === 'readonly') return role !== 'readonly';
    if (tier === 'moderator') return !role || canOperate;
    return !role || canAdmin;
  }

  /** Builds the grouped side nav inside the "Manage" shell for whichever server is currently
   *  selected (currentId) - same grouped-sidebar pattern as the desktop Manager's own
   *  ServerDetail/MinecraftServerDetail (settings-nav/settings-nav-group), rebuilt from
   *  scratch on every call rather than patched in place since it's cheap and the active tab/
   *  available tabs (role, server type) can both change between calls. Called from
   *  applyActiveView on every navigation into the shell, and from selectServer so switching
   *  server via a per-view server picker refreshes both the title and which tabs show. */
  function renderServerDetailNav() {
    var found = latestServers.find(function (s) { return s.id === currentId; });
    serverDetailTitleEl.textContent = found ? found.name : '';
    serverDetailNavEl.innerHTML = '';
    if (!found) return;
    var tabs = isMcServerEntry(found) ? mcManageTabsFor(found.serverType) : ARK_MANAGE_TABS;
    var openGroup = null;
    var openGroupEl = null;
    tabs.forEach(function (tab) {
      if (!tabAllowedForRole(tab.tier)) return;
      if (tab.group !== openGroup) {
        openGroup = tab.group;
        openGroupEl = document.createElement('div');
        openGroupEl.className = 'settings-nav-group';
        var groupLabel = document.createElement('div');
        groupLabel.className = 'settings-nav-group-label';
        groupLabel.textContent = tab.group;
        openGroupEl.appendChild(groupLabel);
        serverDetailNavEl.appendChild(openGroupEl);
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.classList.toggle('active', activeView === tab.view);
      var iconEl = document.createElement('span');
      iconEl.className = 'settings-nav-icon';
      iconEl.textContent = tab.icon;
      btn.appendChild(iconEl);
      btn.appendChild(document.createTextNode(tab.label));
      btn.addEventListener('click', function () { selectView(tab.view); });
      openGroupEl.appendChild(btn);
    });
  }

  function buildCardMenuDropdown(server, tabs) {
    var dropdown = document.createElement('div');
    dropdown.className = 'card-menu-dropdown';
    var openGroup = null;
    var openGroupEl = null;
    tabs.forEach(function (tab) {
      if (!tabAllowedForRole(tab.tier)) return;
      if (tab.group !== openGroup) {
        openGroup = tab.group;
        openGroupEl = document.createElement('div');
        openGroupEl.className = 'card-menu-group';
        dropdown.appendChild(openGroupEl);
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      var iconEl = document.createElement('span');
      iconEl.className = 'card-menu-icon';
      iconEl.textContent = tab.icon;
      btn.appendChild(iconEl);
      btn.appendChild(document.createTextNode(tab.label));
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeCardMenu();
        selectServer(server.id);
        selectView(tab.view);
      });
      openGroupEl.appendChild(btn);
    });
    return dropdown;
  }

  /** Card-v2 - same markup as the desktop Manager's own Dashboard.tsx/MinecraftDashboard.tsx
   *  card (renderCard): status-colored left border, game icon + name + version in the header,
   *  a "..." dropdown (built above) replacing the old single "Manage" entry point, a 3x2 grid
   *  of stat tiles, and an icon-only action row - Start/Stop/Kill for every game, plus
   *  Restart/Update (ARK only, same as desktop's own renderActionButtons). */
  function buildServerCardV2(server) {
    var isMc = isMcServerEntry(server);
    var state = server.state;
    var card = document.createElement('div');
    card.className = 'server-card-v2 status-' + state;

    var header = document.createElement('div');
    header.className = 'server-card-v2-header';
    var title = document.createElement('div');
    title.className = 'server-card-v2-title';
    var gameIcon = document.createElement('img');
    gameIcon.className = 'server-card-game-icon';
    gameIcon.src = server.gameIconUrl;
    gameIcon.alt = '';
    gameIcon.title = server.gameDisplayName;
    var name = document.createElement('h3');
    name.textContent = server.name;
    var version = document.createElement('span');
    version.className = 'server-version';
    version.textContent = 'v' + (server.gameVersion || '-');
    title.appendChild(gameIcon);
    title.appendChild(name);
    title.appendChild(version);
    header.appendChild(title);

    var headerRight = document.createElement('div');
    headerRight.className = 'header-right';
    var badge = document.createElement('span');
    badge.className = 'badge badge-' + state;
    badge.textContent = state;
    headerRight.appendChild(badge);
    var menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'card-menu-btn';
    menuBtn.textContent = '⋯';
    var dropdown = buildCardMenuDropdown(server, isMc ? mcManageTabsFor(server.serverType) : ARK_MANAGE_TABS);
    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (openCardMenuEl === dropdown) { closeCardMenu(); return; }
      closeCardMenu();
      dropdown.classList.add('open');
      openCardMenuEl = dropdown;
    });
    headerRight.appendChild(menuBtn);
    header.appendChild(headerRight);
    card.appendChild(header);
    card.appendChild(dropdown);

    var statGrid = document.createElement('div');
    statGrid.className = 'stat-tile-grid';
    var playerCount = server.players ? server.players.length : 0;
    var tiles = [
      ['Players', playerCount + '/' + server.maxPlayers],
      ['CPU', server.cpu != null ? server.cpu + '%' : '-'],
      ['Memory', server.memoryMB != null ? server.memoryMB + ' MB' : '-']
    ];
    tiles.forEach(function (pair) {
      var tile = document.createElement('div');
      tile.className = 'stat-tile';
      var label = document.createElement('div');
      label.className = 'stat-tile-label';
      label.textContent = pair[0];
      var value = document.createElement('div');
      value.className = 'stat-tile-value';
      value.textContent = pair[1];
      tile.appendChild(label);
      tile.appendChild(value);
      statGrid.appendChild(tile);
    });
    card.appendChild(statGrid);

    if (!role || canOperate) {
      var actions = document.createElement('div');
      actions.className = 'action-row';
      function addAction(cls, title, content, disabled, onClick) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = cls;
        btn.title = title;
        btn.disabled = disabled;
        if (typeof content === 'string') btn.textContent = content;
        else btn.appendChild(content);
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          onClick();
        });
        actions.appendChild(btn);
      }
      addAction('start', 'Start', '▶', state !== 'stopped', function () { clusterServerAction(server.id, 'start'); });
      addAction('stop', 'Stop', '■', state !== 'running', function () { clusterServerAction(server.id, 'stop'); });
      if (!isMc) {
        addAction('restart', 'Restart', '↻', state !== 'running', function () { clusterServerAction(server.id, 'restart'); });
        // Desktop's own Update button uses a small shield PNG (update.png) via icon-mask -
        // not servable here (that file isn't one of the allowlisted /game-icons/ names, which
        // are genuine per-game logos, not generic UI icons), so this uses a plain glyph
        // instead for the same "Update" action in the same button position/color.
        addAction('update', 'Update', '⬆', state !== 'stopped', function () { clusterServerAction(server.id, 'update'); });
      }
      addAction('kill', 'Kill (force, no save)', '✕', state === 'stopped' || state === 'updating', function () {
        if (!confirm('Force-kill this server? Any unsaved progress since the last save is lost.')) return;
        clusterServerAction(server.id, 'kill');
      });
      card.appendChild(actions);
    }

    card.addEventListener('click', function () {
      selectServer(server.id);
      selectView('console');
    });
    return card;
  }

  function buildServerCardMobile(server) {
    var card = document.createElement('div');
    card.className = 'server-card-mobile';

    var header = document.createElement('div');
    header.className = 'server-card-mobile-header';
    var gameIcon = document.createElement('img');
    gameIcon.className = 'server-card-mobile-game-icon';
    gameIcon.src = server.gameIconUrl;
    gameIcon.alt = '';
    gameIcon.title = server.gameDisplayName;
    var name = document.createElement('h3');
    name.textContent = server.name;
    var state = document.createElement('span');
    state.className = 'cluster-card-state state-' + server.state;
    state.textContent = server.state;
    header.appendChild(gameIcon);
    header.appendChild(name);
    header.appendChild(state);
    if (!role || canOperate) {
      var menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'server-card-mobile-menu-btn';
      menuBtn.textContent = '⋮';
      menuBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var rect = menuBtn.getBoundingClientRect();
        openActionSheet(rect.right, rect.bottom, server);
      });
      header.appendChild(menuBtn);
    }

    var stats = document.createElement('div');
    stats.className = 'server-card-mobile-stats';
    var playerCount = server.players ? server.players.length : 0;
    var lines = [
      ['Version', server.gameVersion || '-'],
      ['Players', playerCount + '/' + server.maxPlayers],
      ['CPU', server.cpu != null ? server.cpu + '%' : '-'],
      ['RAM', server.memoryMB != null ? server.memoryMB + ' MB' : '-']
    ];
    lines.forEach(function (pair) {
      var line = document.createElement('div');
      var strong = document.createElement('strong');
      strong.textContent = pair[0] + ': ';
      line.appendChild(strong);
      line.appendChild(document.createTextNode(pair[1]));
      stats.appendChild(line);
    });

    card.appendChild(header);
    card.appendChild(stats);
    card.addEventListener('click', function () {
      selectServer(server.id);
      selectView('console');
    });
    return card;
  }

  // Admin-only Dashboard tab: the same per-server card as the mobile Cluster Dashboard
  // Card-v2 grid (buildServerCardV2 above) - same card the desktop Manager's own Dashboard/
  // Minecraft Servers pages use, grouped like the Settings map dropdown/server pickers: a run
  // of consecutive same-group servers (servers already arrive pre-sorted ungrouped-first-then-
  // alphabetical-by-group) becomes one labeled grid section.
  function renderServerCardsGrid(containerEl, allServers, emptyText) {
    // Same minimized-group exclusion as renderClusterCards above.
    var servers = allServers.filter(function (s) { return !s.groupCollapsed; });
    containerEl.innerHTML = '';
    if (servers.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = emptyText;
      containerEl.appendChild(empty);
      return;
    }
    var openGroupName = null;
    var openGroupGrid = null;
    servers.forEach(function (server) {
      var group = server.group || '';
      if (group !== openGroupName || !openGroupGrid) {
        openGroupName = group;
        var section = document.createElement('div');
        section.className = 'dashboard-group';
        if (group) {
          var label = document.createElement('h3');
          label.className = 'dashboard-group-label';
          label.textContent = group;
          section.appendChild(label);
        }
        openGroupGrid = document.createElement('div');
        openGroupGrid.className = 'dashboard-group-grid';
        section.appendChild(openGroupGrid);
        containerEl.appendChild(section);
      }
      openGroupGrid.appendChild(buildServerCardV2(server));
    });
  }

  function renderDashboardCards(allServers) {
    renderServerCardsGrid(dashboardCardsEl, allServers, 'No servers yet.');
  }

  // Minecraft's own Dashboard-equivalent list - same card/grouping as ARK's Dashboard above,
  // just fed only Minecraft servers (see isMcServerEntry) and its own container, so the two
  // games' servers never mix into one list the way they briefly did before this tab existed.
  function renderMcDashboardCards(allServers) {
    renderServerCardsGrid(mcdashboardCardsEl, allServers, 'No Minecraft servers yet. Add one in the Manager.');
  }

  function renderClusterConsoleCards(servers) {
    clusterConsoleCardsEl.innerHTML = '';
    servers.forEach(function (server) { clusterConsoleCardsEl.appendChild(buildServerCardMobile(server)); });
  }

  function renderClusterConsoleRconTargets(servers) {
    var previous = clusterConsoleRconTargetEl.value;
    clusterConsoleRconTargetEl.innerHTML = '';
    var allOpt = document.createElement('option');
    allOpt.value = 'ALL';
    allOpt.textContent = 'ALL';
    clusterConsoleRconTargetEl.appendChild(allOpt);
    servers.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      clusterConsoleRconTargetEl.appendChild(opt);
    });
    if (previous && (previous === 'ALL' || servers.some(function (s) { return s.id === previous; }))) {
      clusterConsoleRconTargetEl.value = previous;
    }
  }

  // Refreshed every /api/servers poll while a group's console is open - keeps the stats
  // row, server cards and RCON target list current without a separate request.
  function refreshClusterConsoleServers() {
    if (clusterConsoleGroup === null) return;
    clusterConsoleServers = latestServers.filter(function (s) { return (s.group || '') === clusterConsoleGroup; });
    renderClusterConsoleStats(clusterConsoleServers);
    renderClusterConsoleCards(clusterConsoleServers);
    renderClusterConsoleRconTargets(clusterConsoleServers);
  }

  function openGroupConsole(groupName) {
    clusterConsoleGroup = groupName;
    clusterGroupsEl.classList.add('hidden');
    clusterConsoleEl.classList.add('active');
    clusterConsoleTitleEl.textContent = (groupName || 'Ungrouped') + ' — Group Console';
    clusterConsoleFeedEl.innerHTML = '';
    clusterConsoleRconResultsEl.innerHTML = '';
    clusterConsoleRconResultsEl.style.display = 'none';
    renderClusterConsoleFilters();
    refreshClusterConsoleServers();

    var urlToken = groupName ? encodeURIComponent(groupName) : UNGROUPED_TOKEN;
    fetch('/api/groups/' + urlToken + '/events')
      .then(function (r) { return r.json(); })
      .then(function (events) {
        events.forEach(addClusterEvent);
        // Opening the console should land on the latest activity, not the oldest -
        // regardless of the Auto-scroll setting, which only governs whether it keeps
        // following new events from here on.
        clusterConsoleFeedEl.scrollTop = clusterConsoleFeedEl.scrollHeight;
      });

    if (clusterEs) { clusterEs.close(); clusterEs = null; }
    var clusterEsUrl = '/api/groups/' + urlToken + '/events/stream';
    if (accessToken) clusterEsUrl += '?token=' + encodeURIComponent(accessToken);
    clusterEs = new EventSource(clusterEsUrl);
    clusterEs.onmessage = function (msg) { addClusterEvent(JSON.parse(msg.data)); };
  }

  function closeGroupConsole() {
    clusterConsoleGroup = null;
    clusterGroupsEl.classList.remove('hidden');
    clusterConsoleEl.classList.remove('active');
    if (clusterEs) { clusterEs.close(); clusterEs = null; }
  }

  clusterConsoleBackBtn.addEventListener('click', closeGroupConsole);

  clusterConsoleRconForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var command = clusterConsoleRconInputEl.value.trim();
    if (!command || clusterConsoleGroup === null) return;
    var targetValue = clusterConsoleRconTargetEl.value;
    var targets = targetValue === 'ALL' ? clusterConsoleServers : clusterConsoleServers.filter(function (s) { return s.id === targetValue; });
    if (targets.length === 0) return;
    clusterConsoleRconInputEl.value = '';
    Promise.all(targets.map(function (s) {
      return fetch('/api/servers/' + encodeURIComponent(s.id) + '/rcon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command })
      })
        .then(function (r) { return r.json(); })
        .then(function (result) { return { name: s.name, ok: result.ok, response: result.response, error: result.error }; });
    })).then(function (results) {
      clusterConsoleRconResultsEl.innerHTML = '';
      clusterConsoleRconResultsEl.style.display = results.length ? '' : 'none';
      results.forEach(function (r) {
        var p = document.createElement('p');
        p.className = r.ok ? 'rcon-result-ok' : 'rcon-result-error';
        var strong = document.createElement('strong');
        strong.textContent = r.name + ': ';
        p.appendChild(strong);
        p.appendChild(document.createTextNode(r.ok ? (r.response || '(no response)') : r.error));
        clusterConsoleRconResultsEl.appendChild(p);
      });
    });
  });

  // Pops a toast for any server's start/stop transition (regardless of which tab is
  // active), and additionally drops a matching START/STOP line into the currently-open
  // group's console feed if that server belongs to it - same dual notification (transient
  // toast + permanent feed line) as the desktop Manager's own Group Console.
  function checkClusterStateTransitions(servers) {
    servers.forEach(function (server) {
      var prevState = clusterLastKnownStates[server.id];
      clusterLastKnownStates[server.id] = server.state;
      if (prevState === undefined || prevState === server.state) return;
      if (server.state !== 'running' && server.state !== 'stopped') return;

      // An update that didn't restart the server ends by going 'updating' -> 'stopped',
      // same as a real stop - without this it'd show/toast as a spurious extra stop right
      // after whichever stop (or none, if it wasn't running) actually preceded the update.
      var isUpdateFinish = server.state === 'stopped' && prevState === 'updating';
      var type = isUpdateFinish ? 'update' : (server.state === 'running' ? 'start' : 'stop');
      var label = type === 'start' ? 'START' : (type === 'update' ? 'UPDATE' : 'STOP');
      var text = server.name + (type === 'start' ? ' started' : (type === 'update' ? ' updated' : ' stopped'));
      showToast(text);

      if (clusterConsoleGroup !== null && (server.group || '') === clusterConsoleGroup) {
        var now = new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        addClusterEvent({
          label: label,
          cls: type,
          text: text,
          ts: pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()),
          date: now.getFullYear() + '.' + pad(now.getMonth() + 1) + '.' + pad(now.getDate()),
          profileId: server.id,
          profileName: server.name
        });
      }
    });
  }

  var backupServerSelectEl = document.getElementById('backup-server-select');
  var backupNoServerEl = document.getElementById('backup-no-server');
  var backupContentEl = document.getElementById('backup-content');
  var backupInfoEl = document.getElementById('backup-info');
  var backupTableBody = document.getElementById('backup-table-body');
  var backupShowMoreBtn = document.getElementById('btn-backup-show-more');
  var backupLogEl = document.getElementById('backup-log');
  var createBackupBtn = document.getElementById('btn-backup-create');
  var refreshBackupBtn = document.getElementById('btn-backup-refresh');
  if (role && !canOperate) createBackupBtn.style.display = 'none';

  // Player Profile Backups - same panel as the desktop Backups tab's own, restore/delete
  // reusing the exact same /backups/restore and /backups/delete routes as world backups.
  var playerBackupFolderSelectEl = document.getElementById('playerbackup-folder-select');
  var playerBackupRefreshFoldersBtn = document.getElementById('btn-playerbackup-refresh-folders');
  var playerBackupTableBody = document.getElementById('playerbackup-table-body');
  var playerBackupSelectAllEl = document.getElementById('playerbackup-selectall');
  var playerBackupRestoreBtn = document.getElementById('btn-playerbackup-restore');
  var playerBackupDeleteBtn = document.getElementById('btn-playerbackup-delete');
  var playerBackupSelectedFolder = '';
  var playerBackupSelectedPaths = [];
  var playerBackupBackups = [];

  // Backup directory/retention/schedule editing - same function as the desktop Manager's own
  // Backups tab, admin+ only (it goes through the same admin-gated /profile route Settings
  // uses), unlike create/restore/delete above which stay at their own, lower tiers.
  var backupSettingsSectionEl = document.getElementById('backup-settings-section');
  var backupDirInput = document.getElementById('backup-dir');
  var backupMaxBackupsInput = document.getElementById('backup-maxbackups');
  var backupScheduleEnabledInput = document.getElementById('backup-schedule-enabled');
  var backupScheduleCronInput = document.getElementById('backup-schedule-cron');
  var backupPlayerProfileEnabledInput = document.getElementById('backup-playerprofile-enabled');
  var backupPlayerProfileMaxInput = document.getElementById('backup-playerprofile-maxperplayer');
  var backupSettingsStatusEl = document.getElementById('backup-settings-status');
  var backupSettingsErrorEl = document.getElementById('backup-settings-error');
  if (role && !canAdmin) backupSettingsSectionEl.style.display = 'none';

  function showBackupSettingsError(message) {
    backupSettingsErrorEl.textContent = message || '';
    backupSettingsErrorEl.style.display = message ? '' : 'none';
  }

  function showBackupSettingsStatus(message) {
    backupSettingsStatusEl.textContent = message || '';
    backupSettingsStatusEl.style.display = message ? '' : 'none';
    if (message) setTimeout(function () { showBackupSettingsStatus(''); }, 2000);
  }

  function saveBackupSettingsField(field, value) {
    if (!currentId) return;
    var id = currentId;
    var body = {};
    body[field] = value;
    showBackupSettingsError('');
    fetch('/api/servers/' + encodeURIComponent(id) + '/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showBackupSettingsError(result.error || 'Save failed'); return; }
        if (id !== currentId) return;
        showBackupSettingsStatus('Saved');
        loadBackupView();
      })
      .catch(function () { showBackupSettingsError('Request failed'); });
  }

  backupDirInput.addEventListener('change', function () { saveBackupSettingsField('backupDir', backupDirInput.value); });
  backupMaxBackupsInput.addEventListener('change', function () { saveBackupSettingsField('maxBackups', Number(backupMaxBackupsInput.value)); });
  backupScheduleEnabledInput.addEventListener('change', function () { saveBackupSettingsField('backupScheduleEnabled', backupScheduleEnabledInput.checked); });
  backupScheduleCronInput.addEventListener('change', function () { saveBackupSettingsField('backupSchedule', backupScheduleCronInput.value); });
  backupPlayerProfileEnabledInput.addEventListener('change', function () { saveBackupSettingsField('playerProfileBackupEnabled', backupPlayerProfileEnabledInput.checked); });
  backupPlayerProfileMaxInput.addEventListener('change', function () { saveBackupSettingsField('playerProfileBackupMaxPerPlayer', Number(backupPlayerProfileMaxInput.value)); });

  // On a phone, a long backup list (whatever the Backups tab's retention setting keeps -
  // could be well beyond 10) is a lot of scrolling just to reach the process log below it.
  // Cap it there by default, with a button to see the rest. Desktop always shows everything.
  var BACKUP_PAGE_SIZE = 10;
  var backupShowAll = false;
  function isMobileWidth() {
    return window.matchMedia('(max-width: 700px)').matches;
  }

  function formatBackupSize(bytes) {
    var mb = bytes / (1024 * 1024);
    return mb >= 1 ? mb.toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' KB';
  }

  function backupAction(path, filePath) {
    return fetch('/api/servers/' + encodeURIComponent(currentId) + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: filePath })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showToast('Error: ' + result.error); return; }
        loadBackupView();
      })
      .catch(function () { showToast('Request failed'); });
  }

  function renderBackupTable(backups) {
    backupTableBody.innerHTML = '';
    if (backups.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 4;
      emptyCell.className = 'empty-state';
      emptyCell.textContent = 'No backups yet.';
      emptyRow.appendChild(emptyCell);
      backupTableBody.appendChild(emptyRow);
      backupShowMoreBtn.style.display = 'none';
      return;
    }

    var capped = isMobileWidth() && !backupShowAll && backups.length > BACKUP_PAGE_SIZE;
    var visibleBackups = capped ? backups.slice(0, BACKUP_PAGE_SIZE) : backups;

    if (isMobileWidth() && backups.length > BACKUP_PAGE_SIZE) {
      backupShowMoreBtn.style.display = 'block';
      backupShowMoreBtn.textContent = capped ? 'Show all ' + backups.length + ' backups' : 'Show fewer';
      backupShowMoreBtn.onclick = function () {
        backupShowAll = !backupShowAll;
        renderBackupTable(backups);
      };
    } else {
      backupShowMoreBtn.style.display = 'none';
    }

    visibleBackups.forEach(function (b) {
      var row = document.createElement('tr');
      var nameCell = document.createElement('td');
      nameCell.textContent = b.fileName;
      var sizeCell = document.createElement('td');
      sizeCell.textContent = formatBackupSize(b.sizeBytes);
      var timeCell = document.createElement('td');
      timeCell.textContent = new Date(b.createdAt).toLocaleString();

      var actionsCell = document.createElement('td');
      actionsCell.className = 'backup-row-actions';
      if (!role || canAdmin) {
        var restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.textContent = 'Restore';
        restoreBtn.addEventListener('click', function () {
          if (!confirm('Restore ' + b.fileName + '? This overwrites the current save.')) return;
          void backupAction('/backups/restore', b.filePath);
        });
        var deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', function () {
          if (!confirm('Delete ' + b.fileName + '?')) return;
          void backupAction('/backups/delete', b.filePath);
        });
        actionsCell.appendChild(restoreBtn);
        actionsCell.appendChild(deleteBtn);
      }

      row.appendChild(nameCell);
      row.appendChild(sizeCell);
      row.appendChild(timeCell);
      row.appendChild(actionsCell);
      backupTableBody.appendChild(row);
    });
  }

  function renderBackupLog(entries) {
    backupLogEl.innerHTML = '';
    if (entries.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No backup activity yet.';
      backupLogEl.appendChild(empty);
      return;
    }
    entries.forEach(function (entry) {
      var line = document.createElement('div');
      line.className = 'backup-log-line' + (entry.level === 'error' ? ' error' : '');
      var time = document.createElement('span');
      time.className = 'backup-log-time';
      time.textContent = new Date(entry.timestamp).toLocaleTimeString();
      line.appendChild(time);
      line.appendChild(document.createTextNode(entry.message));
      backupLogEl.appendChild(line);
    });
    backupLogEl.scrollTop = backupLogEl.scrollHeight;
  }

  if (role && !canAdmin) {
    playerBackupRestoreBtn.style.display = 'none';
    playerBackupDeleteBtn.style.display = 'none';
  }

  function updatePlayerBackupActionButtons() {
    playerBackupRestoreBtn.disabled = playerBackupSelectedPaths.length !== 1;
    playerBackupDeleteBtn.disabled = playerBackupSelectedPaths.length === 0;
    playerBackupDeleteBtn.textContent = playerBackupSelectedPaths.length > 1
      ? 'Delete selected backups (' + playerBackupSelectedPaths.length + ')'
      : 'Delete selected backup';
  }

  function togglePlayerBackupSelected(filePath) {
    var idx = playerBackupSelectedPaths.indexOf(filePath);
    if (idx === -1) playerBackupSelectedPaths.push(filePath);
    else playerBackupSelectedPaths.splice(idx, 1);
    renderPlayerBackupTable(playerBackupBackups);
  }

  function renderPlayerBackupTable(backups) {
    playerBackupBackups = backups;
    playerBackupSelectedPaths = playerBackupSelectedPaths.filter(function (p) {
      return backups.some(function (b) { return b.filePath === p; });
    });
    playerBackupTableBody.innerHTML = '';
    if (backups.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 3;
      emptyCell.className = 'empty-state';
      emptyCell.textContent = playerBackupSelectedFolder ? 'No backups yet.' : 'No player has been backed up yet.';
      emptyRow.appendChild(emptyCell);
      playerBackupTableBody.appendChild(emptyRow);
    } else {
      backups.forEach(function (b) {
        var row = document.createElement('tr');
        row.className = 'selectable' + (playerBackupSelectedPaths.indexOf(b.filePath) !== -1 ? ' selected' : '');
        row.addEventListener('click', function () { togglePlayerBackupSelected(b.filePath); });
        var selectCell = document.createElement('td');
        selectCell.className = 'playerbackup-select-col';
        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = playerBackupSelectedPaths.indexOf(b.filePath) !== -1;
        checkbox.addEventListener('click', function (e) { e.stopPropagation(); });
        checkbox.addEventListener('change', function () { togglePlayerBackupSelected(b.filePath); });
        selectCell.appendChild(checkbox);
        var nameCell = document.createElement('td');
        nameCell.textContent = b.fileName;
        var timeCell = document.createElement('td');
        timeCell.textContent = new Date(b.createdAt).toLocaleString();
        row.appendChild(selectCell);
        row.appendChild(nameCell);
        row.appendChild(timeCell);
        playerBackupTableBody.appendChild(row);
      });
    }
    playerBackupSelectAllEl.checked = backups.length > 0 && playerBackupSelectedPaths.length === backups.length;
    playerBackupSelectAllEl.disabled = backups.length === 0;
    updatePlayerBackupActionButtons();
  }

  function loadPlayerBackups() {
    var id = currentId;
    var folder = playerBackupSelectedFolder;
    if (!id || !folder) {
      renderPlayerBackupTable([]);
      return;
    }
    fetch('/api/servers/' + encodeURIComponent(id) + '/playerbackups?folder=' + encodeURIComponent(folder))
      .then(function (r) { return r.json(); })
      .then(function (backups) {
        if (id !== currentId || folder !== playerBackupSelectedFolder) return;
        renderPlayerBackupTable(backups);
      });
  }

  function loadPlayerBackupFolders() {
    var id = currentId;
    if (!id) return;
    fetch('/api/servers/' + encodeURIComponent(id) + '/playerbackups/folders')
      .then(function (r) { return r.json(); })
      .then(function (folders) {
        if (id !== currentId) return;
        playerBackupFolderSelectEl.innerHTML = '';
        if (folders.length === 0) {
          var opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'No players backed up yet';
          playerBackupFolderSelectEl.appendChild(opt);
          playerBackupFolderSelectEl.disabled = true;
          playerBackupSelectedFolder = '';
          renderPlayerBackupTable([]);
          return;
        }
        playerBackupFolderSelectEl.disabled = false;
        folders.forEach(function (f) {
          var opt = document.createElement('option');
          opt.value = f.key;
          opt.textContent = f.playerName;
          playerBackupFolderSelectEl.appendChild(opt);
        });
        if (!folders.some(function (f) { return f.key === playerBackupSelectedFolder; })) {
          playerBackupSelectedFolder = folders[0].key;
        }
        playerBackupFolderSelectEl.value = playerBackupSelectedFolder;
        loadPlayerBackups();
      });
  }

  playerBackupFolderSelectEl.addEventListener('change', function () {
    playerBackupSelectedFolder = playerBackupFolderSelectEl.value;
    playerBackupSelectedPaths = [];
    loadPlayerBackups();
  });

  playerBackupRefreshFoldersBtn.addEventListener('click', function () { loadPlayerBackupFolders(); });

  playerBackupSelectAllEl.addEventListener('change', function () {
    playerBackupSelectedPaths = playerBackupSelectAllEl.checked
      ? playerBackupBackups.map(function (b) { return b.filePath; })
      : [];
    renderPlayerBackupTable(playerBackupBackups);
  });

  function playerBackupAction(actionPath, filePath) {
    return fetch('/api/servers/' + encodeURIComponent(currentId) + actionPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: filePath })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showToast('Error: ' + result.error); return; }
        loadPlayerBackups();
      })
      .catch(function () { showToast('Request failed'); });
  }

  playerBackupRestoreBtn.addEventListener('click', function () {
    if (playerBackupSelectedPaths.length !== 1) return;
    var backup = playerBackupBackups.filter(function (b) { return b.filePath === playerBackupSelectedPaths[0]; })[0];
    if (!backup || !confirm('Restore ' + backup.fileName + "? This overwrites this player's current profile.")) return;
    void playerBackupAction('/backups/restore', backup.filePath);
  });

  playerBackupDeleteBtn.addEventListener('click', function () {
    if (playerBackupSelectedPaths.length === 0) return;
    var label = playerBackupSelectedPaths.length === 1
      ? playerBackupBackups.filter(function (b) { return b.filePath === playerBackupSelectedPaths[0]; })[0].fileName
      : playerBackupSelectedPaths.length + ' backups';
    if (!confirm('Delete ' + label + '?')) return;
    var paths = playerBackupSelectedPaths.slice();
    var chain = Promise.resolve();
    paths.forEach(function (p) { chain = chain.then(function () { return playerBackupAction('/backups/delete', p); }); });
  });

  // The Backup view has no server picker of its own - it always follows whichever server
  // is selected in the Dashboard view (currentId).
  function loadBackupView() {
    var id = currentId;
    if (!id) {
      backupNoServerEl.textContent = 'No server selected - choose one above.';
      backupNoServerEl.style.display = '';
      backupContentEl.classList.remove('active');
      return;
    }
    if (isMinecraftServer(id)) {
      backupNoServerEl.textContent = MINECRAFT_VIEW_UNAVAILABLE_TEXT;
      backupNoServerEl.style.display = '';
      backupContentEl.classList.remove('active');
      return;
    }
    backupNoServerEl.style.display = 'none';
    backupContentEl.classList.add('active');

    fetch('/api/servers/' + encodeURIComponent(id) + '/backups/status')
      .then(function (r) { return r.json(); })
      .then(function (status) {
        if (id !== currentId) return;
        if (!status.backupDir) {
          backupInfoEl.textContent = (!role || canAdmin)
            ? 'No backup directory set - configure it below.'
            : "No backup directory set - configure it in the Manager's Backups tab first.";
        } else {
          var scheduleText = !status.scheduleEnabled
            ? 'no schedule'
            : status.scheduleActive
              ? 'scheduled (' + status.scheduleCron + ')'
              : 'scheduled but not currently armed';
          backupInfoEl.textContent = 'Directory: ' + status.backupDir + ' - keeping last ' + status.maxBackups + ' - ' + scheduleText;
        }
        backupDirInput.value = status.backupDir || '';
        backupMaxBackupsInput.value = status.maxBackups;
        backupScheduleEnabledInput.checked = !!status.scheduleEnabled;
        backupScheduleCronInput.value = status.scheduleCron || '';
        backupScheduleCronInput.disabled = !status.scheduleEnabled;
        backupPlayerProfileEnabledInput.checked = !!status.playerProfileBackupEnabled;
        backupPlayerProfileMaxInput.value = status.playerProfileBackupMaxPerPlayer;
        backupPlayerProfileMaxInput.disabled = !status.playerProfileBackupEnabled;
      });
    fetch('/api/servers/' + encodeURIComponent(id) + '/backups')
      .then(function (r) { return r.json(); })
      .then(function (backups) { if (id === currentId) renderBackupTable(backups); });
    fetch('/api/servers/' + encodeURIComponent(id) + '/backups/log')
      .then(function (r) { return r.json(); })
      .then(function (entries) { if (id === currentId) renderBackupLog(entries); });
    loadPlayerBackupFolders();
  }

  createBackupBtn.addEventListener('click', function () {
    if (!currentId) return;
    createBackupBtn.disabled = true;
    createBackupBtn.textContent = 'Creating...';
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/backups', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) showToast('Error: ' + result.error);
        loadBackupView();
      })
      .catch(function () { showToast('Request failed'); })
      .finally(function () {
        createBackupBtn.disabled = false;
        createBackupBtn.textContent = 'Create backup now';
      });
  });

  refreshBackupBtn.addEventListener('click', function () { loadBackupView(); });

  // Keeps the process log live while this view is open, same cadence as everything else
  // here - the table/status info only need refreshing after an action or a view switch.
  setInterval(function () {
    if (activeView !== 'backup' || !currentId) return;
    var id = currentId;
    fetch('/api/servers/' + encodeURIComponent(id) + '/backups/log')
      .then(function (r) { return r.json(); })
      .then(function (entries) { if (id === currentId) renderBackupLog(entries); });
  }, 5000);

  // ---- Admin-only remote control tabs: Update Log, Mods, Map Management, Server
  // Management, Settings - each follows currentId exactly like the Backup view above. Every
  // one of these views now also carries its own server picker in its header (see
  // populateServerPickers/syncServerPickers below), and every write still goes through
  // requireRole('admin') server-side regardless of what this client-side hiding does or
  // doesn't show.

  // -- Analytics ------------------------------------------------------------------------
  // Per-server CPU/RAM/Players history chart - same GET /api/servers/:id/stats route (backed
  // by src/main/lib/statsHistory.ts's readStatsHistory) and the same buildClusterChart/
  // buildSparkline drawing code the Cluster Dashboard's own combined chart already uses
  // above, just fed one server's own samples instead of several summed together. Available
  // to any role (like Dashboard/Backup) - only toggling "Enable stats" itself requires admin,
  // since that's a profile field change going through the same admin-gated
  // POST /api/servers/:id/profile route as Settings/Mods/Server Management.
  var analyticsServerSelectEl = document.getElementById('analytics-server-select');
  var analyticsNoServerEl = document.getElementById('analytics-no-server');
  var analyticsContentEl = document.getElementById('analytics-content');
  var analyticsStatusGridEl = document.getElementById('analytics-status-grid');
  var analyticsStatsEnabledInput = document.getElementById('analytics-statsenabled');
  var analyticsDisabledNoteEl = document.getElementById('analytics-disabled-note');
  var analyticsChartEl = document.getElementById('analytics-chart');
  var analyticsScaleButtons = Array.prototype.slice.call(document.querySelectorAll('.analytics-scale-btn'));
  if (role && !canAdmin) analyticsStatsEnabledInput.disabled = true;

  // Same Server Status box as the desktop Manager's own Analytics tab - State/Version/
  // Players/CPU/RAM come straight from the /api/servers poll loadServers() already runs
  // (renderAnalyticsStatus is just called from there whenever this tab is the active one,
  // same as the Console view's own renderStatus), Uptime ticks locally off startedAt every
  // second like Console's does, and Backup task status/Next backup in reuse the exact same
  // GET /api/servers/:id/backups/status route the Backup tab itself calls.
  var analyticsUptimeValueEl = null;
  var analyticsUptimeStartedAt = null;
  var analyticsUptimeRunning = false;

  function statPair(dt, dd) {
    var wrap = document.createElement('div');
    var dtEl = document.createElement('dt');
    dtEl.textContent = dt;
    var ddEl = document.createElement('dd');
    if (typeof dd === 'string') ddEl.textContent = dd;
    else ddEl.appendChild(dd);
    wrap.appendChild(dtEl);
    wrap.appendChild(ddEl);
    return { wrap: wrap, dd: ddEl };
  }

  function renderAnalyticsStatus() {
    var id = currentId;
    if (!id || activeView !== 'analytics') return;
    var server = latestServers.filter(function (s) { return s.id === id; })[0];
    analyticsStatusGridEl.innerHTML = '';
    if (!server) return;

    var stateBadge = document.createElement('span');
    stateBadge.className = 'cluster-card-state state-' + server.state;
    stateBadge.textContent = server.state;
    analyticsStatusGridEl.appendChild(statPair('State', stateBadge).wrap);

    var playerCount = server.players ? server.players.length : 0;
    analyticsStatusGridEl.appendChild(statPair('Players', playerCount + ' / ' + server.maxPlayers).wrap);
    analyticsStatusGridEl.appendChild(statPair('CPU', server.cpu != null ? server.cpu + '%' : '-').wrap);
    analyticsStatusGridEl.appendChild(statPair('RAM', server.memoryMB != null ? server.memoryMB + ' MB' : '-').wrap);
    analyticsStatusGridEl.appendChild(statPair('Version', server.gameVersion || '-').wrap);

    analyticsUptimeRunning = server.state === 'running';
    analyticsUptimeStartedAt = server.startedAt || null;
    var uptimeValueEl = document.createElement('span');
    uptimeValueEl.textContent = analyticsUptimeRunning && analyticsUptimeStartedAt
      ? formatUptime(Date.now() - analyticsUptimeStartedAt)
      : '-';
    analyticsUptimeValueEl = uptimeValueEl;
    analyticsStatusGridEl.appendChild(statPair('Uptime', uptimeValueEl).wrap);

    fetch('/api/servers/' + encodeURIComponent(id) + '/backups/status')
      .then(function (r) { return r.json(); })
      .then(function (status) {
        if (id !== currentId || activeView !== 'analytics') return;
        var taskText = !analyticsUptimeRunning
          ? 'Offline'
          : !status.scheduleEnabled
            ? 'Deactivate'
            : status.scheduleActive
              ? 'Started'
              : 'Stopped';
        var taskClass = !analyticsUptimeRunning ? 'status-offline' : status.scheduleActive ? 'status-ok' : 'status-warn';
        var taskPair = statPair('Backup task status', taskText);
        taskPair.dd.className = taskClass;
        analyticsStatusGridEl.appendChild(taskPair.wrap);
        if (analyticsUptimeRunning && status.scheduleEnabled) {
          analyticsStatusGridEl.appendChild(
            statPair('Next backup in', status.nextRunAt !== null ? formatCountdown(status.nextRunAt - Date.now()) : '--:--:--:--').wrap
          );
        }
      });
  }

  setInterval(function () {
    if (analyticsUptimeValueEl && analyticsUptimeRunning && analyticsUptimeStartedAt) {
      analyticsUptimeValueEl.textContent = formatUptime(Date.now() - analyticsUptimeStartedAt);
    }
  }, 1000);

  function analyticsScaleKey(id) {
    return 'web-dashboard-analytics-stats-scale:' + id;
  }

  function loadStoredAnalyticsScale(id) {
    var raw = null;
    try { raw = localStorage.getItem(analyticsScaleKey(id)); } catch (err) { /* storage unavailable */ }
    if (raw === null) return STATS_DEFAULT_SCALE_MS;
    var parsed = raw === 'null' ? null : Number(raw);
    var known = STATS_TIME_SCALES.some(function (s) { return s.ms === parsed; });
    return known ? parsed : STATS_DEFAULT_SCALE_MS;
  }

  function saveStoredAnalyticsScale(id, ms) {
    try { localStorage.setItem(analyticsScaleKey(id), ms === null ? 'null' : String(ms)); } catch (err) { /* storage unavailable - not fatal */ }
  }

  var analyticsScale = STATS_DEFAULT_SCALE_MS;

  function updateAnalyticsScaleButtons() {
    analyticsScaleButtons.forEach(function (btn) {
      btn.classList.toggle('active', scaleFromButton(btn) === analyticsScale);
    });
  }

  analyticsScaleButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!currentId) return;
      analyticsScale = scaleFromButton(btn);
      saveStoredAnalyticsScale(currentId, analyticsScale);
      updateAnalyticsScaleButtons();
      refreshAnalyticsChart();
    });
  });

  function refreshAnalyticsChart() {
    var id = currentId;
    if (!id) return;
    var sinceMs = analyticsScale === null ? null : Date.now() - analyticsScale;
    var url = '/api/servers/' + encodeURIComponent(id) + '/stats?maxPoints=' + STATS_MAX_POINTS;
    url += '&since=' + (sinceMs === null ? 'null' : sinceMs);
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (history) {
        if (id !== currentId || activeView !== 'analytics') return;
        analyticsChartEl.innerHTML = '';
        if (history.length === 0) {
          var server = latestServers.filter(function (s) { return s.id === id; })[0];
          var isRunning = server ? server.state === 'running' : false;
          var empty = document.createElement('p');
          empty.className = 'empty-state';
          empty.textContent = isRunning ? 'Collecting data... check back in a few seconds.' : "Server isn't running - start it to see live stats.";
          analyticsChartEl.appendChild(empty);
          return;
        }
        var windowMs = analyticsScale !== null ? analyticsScale : Math.max(1, Date.now() - history[0].time);
        analyticsChartEl.appendChild(buildClusterChart(history, windowMs, Date.now()));
      });
  }

  function loadAnalyticsView() {
    var id = currentId;
    if (!id) {
      analyticsNoServerEl.textContent = 'No server selected - choose one above.';
      analyticsNoServerEl.style.display = '';
      analyticsContentEl.classList.remove('active');
      return;
    }
    if (isMinecraftServer(id)) {
      analyticsNoServerEl.textContent = MINECRAFT_VIEW_UNAVAILABLE_TEXT;
      analyticsNoServerEl.style.display = '';
      analyticsContentEl.classList.remove('active');
      return;
    }
    analyticsNoServerEl.style.display = 'none';
    analyticsContentEl.classList.add('active');
    analyticsScale = loadStoredAnalyticsScale(id);
    updateAnalyticsScaleButtons();
    renderAnalyticsStatus();
    var server = latestServers.filter(function (s) { return s.id === id; })[0];
    var statsEnabled = server ? !!server.statsEnabled : false;
    analyticsStatsEnabledInput.checked = statsEnabled;
    analyticsDisabledNoteEl.style.display = statsEnabled ? 'none' : '';
    analyticsChartEl.innerHTML = '';
    if (statsEnabled) refreshAnalyticsChart();
  }

  analyticsStatsEnabledInput.addEventListener('change', function () {
    if (!currentId) return;
    var id = currentId;
    var checked = analyticsStatsEnabledInput.checked;
    fetch('/api/servers/' + encodeURIComponent(id) + '/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statsEnabled: checked })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) {
          analyticsStatsEnabledInput.checked = !checked;
          showToast('Error: ' + (result.error || 'Save failed'));
          return;
        }
        if (id !== currentId) return;
        analyticsDisabledNoteEl.style.display = checked ? 'none' : '';
        analyticsChartEl.innerHTML = '';
        if (checked) refreshAnalyticsChart();
      })
      .catch(function () {
        analyticsStatsEnabledInput.checked = !checked;
        showToast('Request failed');
      });
  });

  setInterval(function () {
    if (activeView === 'analytics' && currentId && analyticsStatsEnabledInput.checked) refreshAnalyticsChart();
  }, 5000);

  // -- Update Log --------------------------------------------------------------------
  var updatelogServerSelectEl = document.getElementById('updatelog-server-select');
  var updatelogNoServerEl = document.getElementById('updatelog-no-server');
  var updatelogContentEl = document.getElementById('updatelog-content');
  var updatelogOutputEl = document.getElementById('updatelog-output');

  function loadUpdateLogView() {
    var id = currentId;
    if (!id) {
      updatelogNoServerEl.textContent = 'No server selected - choose one above.';
      updatelogNoServerEl.style.display = '';
      updatelogContentEl.classList.remove('active');
      return;
    }
    if (isMinecraftServer(id)) {
      updatelogNoServerEl.textContent = MINECRAFT_VIEW_UNAVAILABLE_TEXT;
      updatelogNoServerEl.style.display = '';
      updatelogContentEl.classList.remove('active');
      return;
    }
    updatelogNoServerEl.style.display = 'none';
    updatelogContentEl.classList.add('active');
    fetch('/api/servers/' + encodeURIComponent(id) + '/update-log')
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (id !== currentId) return;
        updatelogOutputEl.textContent = result.log || 'No update log yet - run Update at least once.';
      });
  }

  setInterval(function () {
    if (activeView === 'updatelog' && currentId) loadUpdateLogView();
  }, 4000);

  // ======================================================================================
  // Minecraft-specific tabs - separate from every ARK tab above (own routes: mc-startsettings/
  // mc-serversettings/mc-mods/mc-backups/mc-management, own server pickers further down, own
  // always-visible sidebar section) since a MinecraftProfile has a genuinely different shape
  // from ServerProfile - see shared/minecraft.ts's own top-of-file comment. Mirrors the
  // desktop Manager's own MinecraftServerDetail tab set (Start Settings/Server Settings/Mods/
  // Backup/Server Management) rather than trying to force these through ARK's own routes/
  // views above, the way Settings/Mods/Backup/Server Management's "not available for
  // Minecraft servers yet" placeholders used to be the only option.
  // ======================================================================================

  // -- MC Start Settings -----------------------------------------------------------------
  var mcStartSettingsServerSelectEl = document.getElementById('mc-startsettings-server-select');
  var mcStartSettingsNoServerEl = document.getElementById('mc-startsettings-no-server');
  var mcStartSettingsContentEl = document.getElementById('mc-startsettings-content');
  var mcStartSettingsErrorEl = document.getElementById('mc-startsettings-error');
  var mcssName = document.getElementById('mcss-name');
  var mcssServerType = document.getElementById('mcss-servertype');
  var mcssServerTypeIcon = document.getElementById('mcss-servertype-icon');
  // Sparse by design - only the types with a real icon asset are listed (served the same way
  // as Minecraft's own game icon, see KNOWN_GAME_ICON_FILE_NAMES on the server side); any other
  // type just shows no icon, exactly as before any of these existed.
  var MC_SERVER_TYPE_ICON_URLS = {
    vanilla: '/game-icons/vanilla.png',
    paper: '/game-icons/paper.png',
    fabric: '/game-icons/fabric.png',
    forge: '/game-icons/forge.png',
    neoforge: '/game-icons/neoforge.png',
    spigot: '/game-icons/spigot.jpg',
    spongevanilla: '/game-icons/sponge.png',
    spongeforge: '/game-icons/sponge.png'
  };
  function updateMcssServerTypeIcon() {
    var url = MC_SERVER_TYPE_ICON_URLS[mcssServerType.value];
    mcssServerTypeIcon.src = url || '';
    mcssServerTypeIcon.style.display = url ? '' : 'none';
  }
  mcssServerType.addEventListener('change', updateMcssServerTypeIcon);
  var mcssVersion = document.getElementById('mcss-version');
  var mcssVersionLoadingEl = document.getElementById('mcss-version-loading');
  var mcssVersionErrorEl = document.getElementById('mcss-version-error');
  var mcssLoaderVersionRowEl = document.getElementById('mcss-loaderversion-row');
  var mcssLoaderVersion = document.getElementById('mcss-loaderversion');
  var mcssLoaderVersionLoadingEl = document.getElementById('mcss-loaderversion-loading');
  var mcssLoaderVersionErrorEl = document.getElementById('mcss-loaderversion-error');
  // Vanilla/Spigot publish exactly one artifact per Minecraft version - no separate loader/
  // build version to additionally choose, same reasoning as supportsLoaderVersionSelection in
  // shared/minecraftInstall.ts (duplicated here rather than imported - this client script has
  // no module imports at all, see its own top-of-file comment).
  function mcssSupportsLoaderVersion(serverType) {
    return serverType !== 'vanilla' && serverType !== 'spigot';
  }
  /** Clears and repopulates a version select from a list of {id, label, recommended}
   *  options, keeping whatever selectedValue already was even if it isn't (or isn't yet) in
   *  the live list - a server set up before these pickers existed, or on a version the live
   *  source has since dropped, would otherwise just silently lose its own value. */
  function populateMcVersionSelect(selectEl, options, selectedValue, starRecommended) {
    selectEl.innerHTML = '';
    var blankOpt = document.createElement('option');
    blankOpt.value = '';
    blankOpt.textContent = '(not set)';
    selectEl.appendChild(blankOpt);
    var hasSelected = !selectedValue;
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = (starRecommended && o.recommended) ? ('★ ' + o.label) : o.label;
      selectEl.appendChild(opt);
      if (o.id === selectedValue) hasSelected = true;
    });
    if (selectedValue && !hasSelected) {
      var customOpt = document.createElement('option');
      customOpt.value = selectedValue;
      customOpt.textContent = selectedValue;
      selectEl.insertBefore(customOpt, blankOpt.nextSibling);
    }
    selectEl.value = selectedValue || '';
  }
  function loadMcssLoaderVersionOptions() {
    var serverType = mcssServerType.value;
    var mcVersion = mcssVersion.value;
    var selected = mcStartSettingsProfile ? (mcStartSettingsProfile.loaderVersion || '') : '';
    if (!mcssSupportsLoaderVersion(serverType) || !mcVersion) {
      mcssLoaderVersionRowEl.style.display = 'none';
      mcssLoaderVersion.innerHTML = '';
      mcssLoaderVersionLoadingEl.style.display = 'none';
      mcssLoaderVersionErrorEl.style.display = 'none';
      return;
    }
    mcssLoaderVersionRowEl.style.display = '';
    mcssLoaderVersionErrorEl.style.display = 'none';
    mcssLoaderVersionLoadingEl.style.display = '';
    fetch('/api/mc-install/loaderversions?serverType=' + encodeURIComponent(serverType) + '&minecraftVersion=' + encodeURIComponent(mcVersion))
      .then(function (r) { return r.json(); })
      .then(function (options) {
        mcssLoaderVersionLoadingEl.style.display = 'none';
        populateMcVersionSelect(mcssLoaderVersion, options, selected, true);
      })
      .catch(function () {
        mcssLoaderVersionLoadingEl.style.display = 'none';
        mcssLoaderVersionErrorEl.textContent = 'Failed to load loader/build versions';
        mcssLoaderVersionErrorEl.style.display = '';
      });
  }
  function loadMcssVersionOptions() {
    var serverType = mcssServerType.value;
    var selected = mcStartSettingsProfile ? mcStartSettingsProfile.minecraftVersion : '';
    mcssVersionErrorEl.style.display = 'none';
    mcssVersionLoadingEl.style.display = '';
    fetch('/api/mc-install/versions?serverType=' + encodeURIComponent(serverType))
      .then(function (r) { return r.json(); })
      .then(function (options) {
        mcssVersionLoadingEl.style.display = 'none';
        populateMcVersionSelect(mcssVersion, options, selected, false);
        loadMcssLoaderVersionOptions();
      })
      .catch(function () {
        mcssVersionLoadingEl.style.display = 'none';
        mcssVersionErrorEl.textContent = 'Failed to load versions';
        mcssVersionErrorEl.style.display = '';
      });
  }
  var mcssInstallDir = document.getElementById('mcss-installdir');
  var mcssLaunchMode = document.getElementById('mcss-launchmode');
  var mcssJarFileName = document.getElementById('mcss-jarfilename');
  var mcssScriptFileName = document.getElementById('mcss-scriptfilename');
  var mcssJarFieldLabel = document.getElementById('mcss-jarfield-label');
  var mcssScriptFieldLabel = document.getElementById('mcss-scriptfield-label');
  var mcssMinMemory = document.getElementById('mcss-minmemory');
  var mcssMaxMemory = document.getElementById('mcss-maxmemory');
  var mcssExtraJvmArgs = document.getElementById('mcss-extrajvmargs');
  var mcssExtraProgramArgs = document.getElementById('mcss-extraprogramargs');
  var mcssGroup = document.getElementById('mcss-group');
  var mcssHidden = document.getElementById('mcss-hidden');
  var mcStartSettingsProfile = null;

  function showMcStartSettingsError(message) {
    mcStartSettingsErrorEl.textContent = message || '';
    mcStartSettingsErrorEl.style.display = message ? '' : 'none';
  }

  function saveMcStartSettingsField(field, value) {
    if (!currentId || !mcStartSettingsProfile) return;
    var id = currentId;
    var body = {};
    body[field] = value;
    fetch('/api/servers/' + encodeURIComponent(id) + '/mc-startsettings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showMcStartSettingsError(result.error || 'Save failed'); return; }
        if (id !== currentId) return;
        mcStartSettingsProfile = result.profile;
        renderMcStartSettingsForm();
      })
      .catch(function () { showMcStartSettingsError('Request failed'); });
  }

  function renderMcStartSettingsForm() {
    var p = mcStartSettingsProfile;
    mcssName.value = p.name;
    mcssServerType.value = p.serverType;
    updateMcssServerTypeIcon();
    loadMcssVersionOptions();
    mcssInstallDir.value = p.installDir;
    mcssLaunchMode.value = p.launchMode;
    mcssJarFileName.value = p.jarFileName;
    mcssScriptFileName.value = p.scriptFileName;
    mcssJarFieldLabel.style.display = p.launchMode === 'jar' ? '' : 'none';
    mcssScriptFieldLabel.style.display = p.launchMode === 'script' ? '' : 'none';
    mcssMinMemory.value = p.minMemoryMB;
    mcssMaxMemory.value = p.maxMemoryMB;
    mcssExtraJvmArgs.value = p.extraJvmArgs;
    mcssExtraProgramArgs.value = p.extraProgramArgs;
    mcssGroup.value = p.group;
    mcssHidden.checked = !!p.hidden;
  }

  function loadMcStartSettingsView() {
    var id = currentId;
    if (!id || !isMinecraftServer(id)) {
      mcStartSettingsNoServerEl.style.display = '';
      mcStartSettingsContentEl.classList.remove('active');
      return;
    }
    showMcStartSettingsError('');
    mcStartSettingsNoServerEl.style.display = 'none';
    mcStartSettingsContentEl.classList.add('active');
    fetch('/api/servers/' + encodeURIComponent(id) + '/mc-startsettings')
      .then(function (r) { return r.json(); })
      .then(function (profile) {
        if (id !== currentId) return;
        mcStartSettingsProfile = profile;
        renderMcStartSettingsForm();
      });
  }

  mcssName.addEventListener('change', function () { saveMcStartSettingsField('name', mcssName.value); });
  mcssServerType.addEventListener('change', function () {
    saveMcStartSettingsField('serverType', mcssServerType.value);
    loadMcssVersionOptions();
  });
  mcssVersion.addEventListener('change', function () {
    saveMcStartSettingsField('minecraftVersion', mcssVersion.value);
    loadMcssLoaderVersionOptions();
  });
  mcssLoaderVersion.addEventListener('change', function () { saveMcStartSettingsField('loaderVersion', mcssLoaderVersion.value); });
  mcssInstallDir.addEventListener('change', function () { saveMcStartSettingsField('installDir', mcssInstallDir.value); });
  mcssLaunchMode.addEventListener('change', function () {
    saveMcStartSettingsField('launchMode', mcssLaunchMode.value);
    mcssJarFieldLabel.style.display = mcssLaunchMode.value === 'jar' ? '' : 'none';
    mcssScriptFieldLabel.style.display = mcssLaunchMode.value === 'script' ? '' : 'none';
  });
  mcssJarFileName.addEventListener('change', function () { saveMcStartSettingsField('jarFileName', mcssJarFileName.value); });
  mcssScriptFileName.addEventListener('change', function () { saveMcStartSettingsField('scriptFileName', mcssScriptFileName.value); });
  mcssMinMemory.addEventListener('change', function () { saveMcStartSettingsField('minMemoryMB', Number(mcssMinMemory.value)); });
  mcssMaxMemory.addEventListener('change', function () { saveMcStartSettingsField('maxMemoryMB', Number(mcssMaxMemory.value)); });
  mcssExtraJvmArgs.addEventListener('change', function () { saveMcStartSettingsField('extraJvmArgs', mcssExtraJvmArgs.value); });
  mcssExtraProgramArgs.addEventListener('change', function () { saveMcStartSettingsField('extraProgramArgs', mcssExtraProgramArgs.value); });
  mcssGroup.addEventListener('change', function () { saveMcStartSettingsField('group', mcssGroup.value); });
  mcssHidden.addEventListener('change', function () { saveMcStartSettingsField('hidden', mcssHidden.checked); });

  // -- MC Server Settings -----------------------------------------------------------------
  var mcServerSettingsServerSelectEl = document.getElementById('mc-serversettings-server-select');
  var mcServerSettingsNoServerEl = document.getElementById('mc-serversettings-no-server');
  var mcServerSettingsContentEl = document.getElementById('mc-serversettings-content');
  var mcServerSettingsFieldsEl = document.getElementById('mc-serversettings-fields');
  var mcServerSettingsErrorEl = document.getElementById('mc-serversettings-error');
  var mcServerSettingsForm = null;

  // Same field set as the desktop Manager's own Minecraft Server Settings tab
  // (MinecraftServerDetail/ServerSettingsTab.tsx), kept as plain data here (this client
  // script has no module imports, unlike the desktop's React components) rather than
  // duplicating a field list per input type.
  var MC_PROPERTIES_SECTIONS = [
    {
      title: 'Gameplay',
      fields: [
        { key: 'spawn-animals', type: 'bool', label: 'Spawn animals', default: true },
        { key: 'spawn-monsters', type: 'bool', label: 'Spawn monsters', default: true },
        { key: 'spawn-npcs', type: 'bool', label: 'Spawn npcs', default: true },
        { key: 'hardcore', type: 'bool', label: 'Hardcore mode', hint: 'If enabled, players will be set to spectator mode if they die.', default: false },
        { key: 'allow-nether', type: 'bool', label: 'Nether world', hint: 'Allows players to travel to the Nether.', default: true },
        { key: 'pvp', type: 'bool', label: 'PVP', hint: 'Players will be able to kill each other.', default: true },
        { key: 'allow-flight', type: 'bool', label: 'Flight', hint: 'Allows users to use flight on your server while in Survival mode, if they have a mod that provides flight.', default: false },
        { key: 'force-gamemode', type: 'bool', label: 'Force Gamemode', hint: 'Force players to join in the default game mode.', default: false },
        { key: 'difficulty', type: 'select', label: 'Difficulty', default: 'easy', options: ['peaceful', 'easy', 'normal', 'hard'] },
        { key: 'gamemode', type: 'select', label: 'Gamemode', default: 'survival', options: ['survival', 'creative', 'adventure', 'spectator'] },
        { key: 'view-distance', type: 'number', label: 'View Distance', default: 10 }
      ]
    },
    {
      title: 'Appearance',
      fields: [
        { key: 'motd', type: 'text', label: 'Motd', default: 'A Minecraft Server' },
        { key: 'resource-pack', type: 'text', label: 'Resource Pack URL' },
        { key: 'resource-pack-sha1', type: 'text', label: 'Resource Pack SHA1' }
      ]
    },
    {
      title: 'World',
      fields: [
        { key: 'generate-structures', type: 'bool', label: 'Generate Structures', hint: 'Defines whether structures (such as villages, mineshafts, strongholds, ...) will be generated.', default: true },
        { key: 'enable-command-block', type: 'bool', label: 'Command Blocks', default: false },
        { key: 'level-name', type: 'text', label: 'World Name', default: 'world' },
        { key: 'max-world-size', type: 'number', label: 'Max World Size', default: 29999984 },
        { key: 'max-build-height', type: 'number', label: 'Max Build Height', default: 256 },
        { key: 'level-seed', type: 'text', label: 'Level Seed' },
        { key: 'level-type', type: 'text', label: 'Level Type', default: 'default' },
        { key: 'generator-settings', type: 'text', label: 'Flat Generator Settings', default: '{}' }
      ]
    },
    {
      title: 'Networking',
      fields: [
        { key: 'online-mode', type: 'bool', label: 'Online Mode', hint: 'Requires a valid Minecraft account to connect. Turn off only for an offline/cracked server.', default: true },
        { key: 'white-list', type: 'bool', label: 'Whitelisting', hint: 'When enabled, users not on the whitelist will be unable to connect. Intended for private servers.', default: false },
        { key: 'prevent-proxy-connections', type: 'bool', label: 'Prevent Proxy', hint: 'Prevents users from using vpns or proxies.', default: false },
        { key: 'snooper-enabled', type: 'bool', label: 'Snooper', hint: 'Sets whether the server sends snoop data regularly to snoop.minecraft.net.', default: true },
        { key: 'enable-rcon', type: 'bool', label: 'Rcon', hint: 'Enables remote access to the server console.', default: false },
        { key: 'enable-query', type: 'bool', label: 'Query', hint: 'Enables GameSpy4 protocol server listener. Used to get information about server.', default: false },
        { key: 'rcon.password', type: 'text', label: 'Rcon Password' },
        { key: 'rcon.port', type: 'number', label: 'Rcon Port', default: 25575 },
        { key: 'query.port', type: 'number', label: 'Query Port', default: 25565 },
        { key: 'server-port', type: 'number', label: 'Server Port', default: 25565 },
        { key: 'max-players', type: 'number', label: 'Player Limit', default: 20 },
        { key: 'max-tick-time', type: 'number', label: 'Max Tick Time', default: 60000 },
        { key: 'network-compression-threshold', type: 'number', label: 'Network Compression Threshold', default: 256 }
      ]
    },
    {
      title: 'Miscellaneous',
      fields: [
        { key: 'op-permission-level', type: 'select', label: 'OP Permission level', default: '4', options: ['1', '2', '3', '4'] },
        { key: 'player-idle-timeout', type: 'number', label: 'Idle Timeout Kick', default: 0 }
      ]
    }
  ];

  function mcPropValue(field) {
    var raw = mcServerSettingsForm[field.key];
    if (field.type === 'bool') return raw === undefined ? field.default : raw === 'true';
    if (field.type === 'number') {
      var n = Number(raw);
      return raw !== undefined && isFinite(n) ? n : field.default;
    }
    return raw !== undefined ? raw : (field.default !== undefined ? field.default : '');
  }

  function showMcServerSettingsError(message) {
    mcServerSettingsErrorEl.textContent = message || '';
    mcServerSettingsErrorEl.style.display = message ? '' : 'none';
  }

  function saveMcPropertyField(key, value) {
    if (!currentId) return;
    var id = currentId;
    var body = {};
    body[key] = String(value);
    fetch('/api/servers/' + encodeURIComponent(id) + '/mc-serversettings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showMcServerSettingsError(result.error || 'Save failed'); return; }
        if (id !== currentId) return;
        mcServerSettingsForm = result.properties;
        renderMcServerSettingsFields();
      })
      .catch(function () { showMcServerSettingsError('Request failed'); });
  }

  function renderMcServerSettingsFields() {
    mcServerSettingsFieldsEl.innerHTML = '';
    MC_PROPERTIES_SECTIONS.forEach(function (section) {
      var sectionEl = document.createElement('section');
      sectionEl.className = 'settings-section';
      var h3 = document.createElement('h3');
      h3.textContent = section.title;
      sectionEl.appendChild(h3);
      section.fields.forEach(function (field) {
        if (field.type === 'bool') {
          var wrap = document.createElement('div');
          var boolLabel = document.createElement('label');
          boolLabel.className = 'checkbox';
          var boolInput = document.createElement('input');
          boolInput.type = 'checkbox';
          boolInput.checked = mcPropValue(field);
          boolInput.addEventListener('change', function () { saveMcPropertyField(field.key, boolInput.checked ? 'true' : 'false'); });
          boolLabel.appendChild(boolInput);
          boolLabel.appendChild(document.createTextNode(field.label));
          wrap.appendChild(boolLabel);
          if (field.hint) {
            var hint = document.createElement('p');
            hint.className = 'empty-state';
            hint.textContent = field.hint;
            wrap.appendChild(hint);
          }
          sectionEl.appendChild(wrap);
          return;
        }
        var label = document.createElement('label');
        label.appendChild(document.createTextNode(field.label));
        if (field.type === 'select') {
          var select = document.createElement('select');
          field.options.forEach(function (opt) {
            var optEl = document.createElement('option');
            optEl.value = opt;
            optEl.textContent = opt;
            select.appendChild(optEl);
          });
          select.value = mcPropValue(field);
          select.addEventListener('change', function () { saveMcPropertyField(field.key, select.value); });
          label.appendChild(select);
        } else {
          var input = document.createElement('input');
          input.type = field.type === 'number' ? 'number' : 'text';
          input.value = mcPropValue(field);
          input.addEventListener('change', function () { saveMcPropertyField(field.key, input.value); });
          label.appendChild(input);
        }
        sectionEl.appendChild(label);
      });
      mcServerSettingsFieldsEl.appendChild(sectionEl);
    });
  }

  function loadMcServerSettingsView() {
    var id = currentId;
    if (!id || !isMinecraftServer(id)) {
      mcServerSettingsNoServerEl.style.display = '';
      mcServerSettingsContentEl.classList.remove('active');
      return;
    }
    showMcServerSettingsError('');
    mcServerSettingsNoServerEl.style.display = 'none';
    mcServerSettingsContentEl.classList.add('active');
    fetch('/api/servers/' + encodeURIComponent(id) + '/mc-serversettings')
      .then(function (r) { return r.json(); })
      .then(function (properties) {
        if (id !== currentId) return;
        mcServerSettingsForm = properties;
        renderMcServerSettingsFields();
      });
  }

  // -- MC Mods / MC Plugins -------------------------------------------------------------------
  // Two fully independent instances of the exact same controller, one per ecosystem - not two
  // tabs that happen to share a label. SpongeForge genuinely has both at once (its own Sponge-
  // plugin layer, and the Forge-mod layer it actually runs on), each with its own search/
  // install/installed-list; every other type only ever has one of the two populated (the
  // other instance's "unsupported" message shows instead - see mcServerSupportsEcosystem).
  // Mirrors shared/minecraftMods.ts's minecraftServerSupportsEcosystem (duplicated here, same
  // reasoning as every other small lookup in this client script - no module imports at all,
  // see its own top-of-file comment).
  var MC_ECOSYSTEM_SERVER_TYPES = {
    mods: ['forge', 'neoforge', 'fabric', 'spongeforge'],
    plugins: ['paper', 'spigot', 'spongevanilla', 'spongeforge']
  };
  function mcServerSupportsEcosystem(serverType, ecosystem) {
    return MC_ECOSYSTEM_SERVER_TYPES[ecosystem].indexOf(serverType) !== -1;
  }
  // Only this instance's own slice of a server's installedMods - an entry whose own
  // ecosystem tag couldn't be determined (scanForInstalledMods' best-effort case) is shown
  // in every ecosystem tab the server type offers rather than hidden from all of them, same
  // reasoning as ModsTab.tsx's own installedModsFor on the desktop side.
  function mcModsForEcosystem(mods, ecosystem) {
    return (mods || []).filter(function (m) { return m.ecosystem === undefined || m.ecosystem === ecosystem; });
  }

  function createMcModEcosystemView(ecosystem, ids) {
    var noun = ecosystem === 'mods' ? 'mod' : 'plugin';
    var serverSelectEl = document.getElementById(ids.serverSelect);
    var noServerEl = document.getElementById(ids.noServer);
    var unsupportedEl = document.getElementById(ids.unsupported);
    var contentEl = document.getElementById(ids.content);
    var browseIcon = document.getElementById(ids.browseIcon);
    var searchQueryInput = document.getElementById(ids.searchQuery);
    var btnSearch = document.getElementById(ids.btnSearch);
    var searchErrorEl = document.getElementById(ids.searchError);
    var searchResultsEl = document.getElementById(ids.searchResults);
    var btnRescan = document.getElementById(ids.btnRescan);
    var btnUpdateCheck = document.getElementById(ids.btnUpdateCheck);
    var tableBody = document.getElementById(ids.tableBody);
    var errorEl = document.getElementById(ids.error);

    var installedMods = [];
    var searchResults = [];
    var searched = false;
    var updateInfo = {};

    function showError(message) {
      errorEl.textContent = message || '';
      errorEl.style.display = message ? '' : 'none';
    }
    function showSearchError(message) {
      searchErrorEl.textContent = message || '';
      searchErrorEl.style.display = message ? '' : 'none';
    }

    function renderTable() {
      tableBody.innerHTML = '';
      if (installedMods.length === 0) {
        var emptyRow = document.createElement('tr');
        var emptyCell = document.createElement('td');
        emptyCell.colSpan = 5;
        emptyCell.className = 'empty-state';
        emptyCell.textContent = 'No ' + noun + 's installed yet.';
        emptyRow.appendChild(emptyCell);
        tableBody.appendChild(emptyRow);
        return;
      }
      installedMods.forEach(function (mod) {
        var row = document.createElement('tr');

        var enableCell = document.createElement('td');
        var enableInput = document.createElement('input');
        enableInput.type = 'checkbox';
        enableInput.checked = !!mod.enabled;
        enableInput.addEventListener('change', function () {
          fetch('/api/servers/' + encodeURIComponent(currentId) + '/mc-mods/enabled', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: mod.projectId, enabled: enableInput.checked })
          })
            .then(function (r) { return r.json(); })
            .then(function (result) {
              if (!result.ok) { showError(result.error || 'Save failed'); return; }
              installedMods = mcModsForEcosystem(result.installedMods, ecosystem);
              renderTable();
            })
            .catch(function () { showError('Request failed'); });
        });
        enableCell.appendChild(enableInput);
        row.appendChild(enableCell);

        var nameCell = document.createElement('td');
        nameCell.className = 'ark-mod-name-cell';
        if (mod.iconUrl) {
          var icon = document.createElement('img');
          icon.src = mod.iconUrl;
          icon.alt = '';
          icon.className = 'ark-mod-icon';
          icon.addEventListener('error', function () { icon.style.display = 'none'; });
          nameCell.appendChild(icon);
        }
        var nameSpan = document.createElement('span');
        nameSpan.className = 'ark-mod-title';
        nameSpan.title = mod.title;
        nameSpan.textContent = mod.title;
        nameCell.appendChild(nameSpan);
        row.appendChild(nameCell);

        var sourceCell = document.createElement('td');
        sourceCell.textContent = mod.source === 'unknown' ? 'Unidentified' : mod.source;
        if (mod.alsoOn && mod.alsoOn.length > 0) sourceCell.textContent += ' (also on ' + mod.alsoOn.join(', ') + ')';
        row.appendChild(sourceCell);

        var versionCell = document.createElement('td');
        versionCell.textContent = mod.versionNumber || '-';
        var info = updateInfo[mod.projectId];
        if (info && info.updateAvailable) {
          var badge = document.createElement('span');
          badge.className = 'status-message';
          badge.textContent = ' (update: ' + (info.latestVersionNumber || 'available') + ')';
          versionCell.appendChild(badge);
        }
        row.appendChild(versionCell);

        var actionsCell = document.createElement('td');
        if (mod.source !== 'unknown' && info && info.updateAvailable) {
          var updateBtn = document.createElement('button');
          updateBtn.type = 'button';
          updateBtn.textContent = 'Update';
          updateBtn.addEventListener('click', function () { void installMod(mod.source, mod.projectId); });
          actionsCell.appendChild(updateBtn);
        }
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'danger';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', function () {
          fetch('/api/servers/' + encodeURIComponent(currentId) + '/mc-mods/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: mod.projectId })
          })
            .then(function (r) { return r.json(); })
            .then(function (result) {
              if (!result.ok) { showError(result.error || 'Remove failed'); return; }
              installedMods = mcModsForEcosystem(result.installedMods, ecosystem);
              renderTable();
            })
            .catch(function () { showError('Request failed'); });
        });
        actionsCell.appendChild(removeBtn);
        row.appendChild(actionsCell);

        tableBody.appendChild(row);
      });
    }

    function renderSearchResults() {
      searchResultsEl.innerHTML = '';
      if (searchResults.length === 0) {
        var empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = searched ? 'No results.' : ('Search above to find ' + noun + 's to install.');
        searchResultsEl.appendChild(empty);
        return;
      }
      searchResults.forEach(function (r) {
        var row = document.createElement('div');
        row.className = 'ark-mod-search-result';
        if (r.iconUrl) {
          var icon = document.createElement('img');
          icon.src = r.iconUrl;
          icon.alt = '';
          icon.className = 'ark-mod-icon';
          icon.addEventListener('error', function () { icon.style.display = 'none'; });
          row.appendChild(icon);
        }
        var info = document.createElement('div');
        info.className = 'ark-mod-search-result-info';
        var nameSpan = document.createElement('span');
        nameSpan.className = 'ark-mod-search-result-name';
        nameSpan.textContent = r.title + ' (' + r.source + ')';
        var summarySpan = document.createElement('span');
        summarySpan.className = 'empty-state ark-mod-search-result-summary';
        summarySpan.title = r.description || '';
        summarySpan.textContent = r.description || '';
        info.appendChild(nameSpan);
        info.appendChild(summarySpan);
        row.appendChild(info);
        var downloadsSpan = document.createElement('span');
        downloadsSpan.className = 'empty-state ark-mod-search-result-downloads';
        downloadsSpan.textContent = (r.downloads || 0).toLocaleString() + ' downloads';
        row.appendChild(downloadsSpan);
        var addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.disabled = !!r.installed;
        addBtn.textContent = r.installed ? 'Installed' : 'Install';
        addBtn.addEventListener('click', function () { void installMod(r.source, r.projectId); });
        row.appendChild(addBtn);
        searchResultsEl.appendChild(row);
      });
    }

    function installMod(source, projectId) {
      if (!currentId) return;
      showError('');
      return fetch('/api/servers/' + encodeURIComponent(currentId) + '/mc-mods/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: source, projectId: projectId, ecosystem: ecosystem })
      })
        .then(function (r) { return r.json(); })
        .then(function (result) {
          if (!result.ok) { showError(result.error || 'Install failed'); return; }
          installedMods = mcModsForEcosystem(result.installedMods, ecosystem);
          renderTable();
          renderSearchResults();
          if (result.result && result.result.optionalDependenciesSkipped && result.result.optionalDependenciesSkipped.length > 0) {
            showToast(result.result.optionalDependenciesSkipped.length + ' optional dependenc' + (result.result.optionalDependenciesSkipped.length === 1 ? 'y' : 'ies') + ' skipped - install by hand if needed.');
          }
        })
        .catch(function () { showError('Request failed'); });
    }

    function runSearch() {
      var query = searchQueryInput.value.trim();
      if (!query || !currentId) return;
      var id = currentId;
      btnSearch.disabled = true;
      btnSearch.textContent = 'Searching...';
      showSearchError('');
      fetch('/api/servers/' + encodeURIComponent(id) + '/mc-mods/search?q=' + encodeURIComponent(query) + '&ecosystem=' + ecosystem)
        .then(function (r) { return r.json(); })
        .then(function (results) {
          searched = true;
          if (id !== currentId) return;
          if (results && results.error) { showSearchError(results.error); searchResults = []; }
          else searchResults = results || [];
          renderSearchResults();
        })
        .catch(function () { if (id === currentId) showSearchError('Search failed'); })
        .finally(function () {
          btnSearch.disabled = false;
          btnSearch.textContent = 'Search';
        });
    }

    btnSearch.addEventListener('click', runSearch);
    searchQueryInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
    });

    btnRescan.addEventListener('click', function () {
      if (!currentId) return;
      var id = currentId;
      btnRescan.disabled = true;
      btnRescan.textContent = 'Rescanning...';
      fetch('/api/servers/' + encodeURIComponent(id) + '/mc-mods/rescan', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (result) {
          if (!result.ok) { showError(result.error || 'Rescan failed'); return; }
          if (id !== currentId) return;
          installedMods = mcModsForEcosystem(result.installedMods, ecosystem);
          renderTable();
          showToast(result.result && result.result.adopted.length > 0 ? 'Recognized ' + result.result.adopted.length + ' file(s).' : 'No new files found.');
        })
        .catch(function () { showError('Request failed'); })
        .finally(function () {
          btnRescan.disabled = false;
          btnRescan.textContent = 'Rescan folder';
        });
    });

    btnUpdateCheck.addEventListener('click', function () {
      if (!currentId) return;
      var id = currentId;
      btnUpdateCheck.disabled = true;
      btnUpdateCheck.textContent = 'Checking...';
      fetch('/api/servers/' + encodeURIComponent(id) + '/mc-mods/updatecheck')
        .then(function (r) { return r.json(); })
        .then(function (results) {
          if (id !== currentId) return;
          updateInfo = {};
          (results || []).forEach(function (r) { updateInfo[r.projectId] = r; });
          renderTable();
        })
        .catch(function () { showError('Update check failed'); })
        .finally(function () {
          btnUpdateCheck.disabled = false;
          btnUpdateCheck.textContent = 'Check for updates';
        });
    });

    function load() {
      var id = currentId;
      if (!id || !isMinecraftServer(id)) {
        noServerEl.style.display = '';
        unsupportedEl.style.display = 'none';
        contentEl.classList.remove('active');
        return;
      }
      var server = latestServers.find(function (s) { return s.id === id; });
      if (!server || !mcServerSupportsEcosystem(server.serverType, ecosystem)) {
        noServerEl.style.display = 'none';
        unsupportedEl.style.display = '';
        contentEl.classList.remove('active');
        return;
      }
      showError('');
      showSearchError('');
      noServerEl.style.display = 'none';
      unsupportedEl.style.display = 'none';
      contentEl.classList.add('active');
      var iconUrl = MC_SERVER_TYPE_ICON_URLS[server.serverType];
      browseIcon.src = iconUrl || '';
      browseIcon.style.display = iconUrl ? '' : 'none';
      searched = false;
      searchResults = [];
      searchQueryInput.value = '';
      updateInfo = {};
      renderSearchResults();
      fetch('/api/servers/' + encodeURIComponent(id) + '/mc-mods')
        .then(function (r) { return r.json(); })
        .then(function (mods) {
          if (id !== currentId) return;
          installedMods = mcModsForEcosystem(mods, ecosystem);
          renderTable();
        });
    }

    return { load: load };
  }

  var mcModsView = createMcModEcosystemView('mods', {
    serverSelect: 'mc-mods-server-select',
    noServer: 'mc-mods-no-server',
    unsupported: 'mc-mods-unsupported',
    content: 'mc-mods-content',
    browseIcon: 'mc-mods-browse-icon',
    searchQuery: 'mc-mods-search-query',
    btnSearch: 'btn-mc-mods-search',
    searchError: 'mc-mods-search-error',
    searchResults: 'mc-mods-search-results',
    btnRescan: 'btn-mc-mods-rescan',
    btnUpdateCheck: 'btn-mc-mods-updatecheck',
    tableBody: 'mc-mods-table-body',
    error: 'mc-mods-error'
  });
  var mcPluginsView = createMcModEcosystemView('plugins', {
    serverSelect: 'mc-plugins-server-select',
    noServer: 'mc-plugins-no-server',
    unsupported: 'mc-plugins-unsupported',
    content: 'mc-plugins-content',
    browseIcon: 'mc-plugins-browse-icon',
    searchQuery: 'mc-plugins-search-query',
    btnSearch: 'btn-mc-plugins-search',
    searchError: 'mc-plugins-search-error',
    searchResults: 'mc-plugins-search-results',
    btnRescan: 'btn-mc-plugins-rescan',
    btnUpdateCheck: 'btn-mc-plugins-updatecheck',
    tableBody: 'mc-plugins-table-body',
    error: 'mc-plugins-error'
  });
  function loadMcModsView() { mcModsView.load(); }
  function loadMcPluginsView() { mcPluginsView.load(); }
  // Looked up again here (cheap, idempotent) for MC_SERVER_PICKERS further below - the actual
  // <select> elements live inside createMcModEcosystemView's own closures, not as globals.
  var mcModsServerSelectEl = document.getElementById('mc-mods-server-select');
  var mcPluginsServerSelectEl = document.getElementById('mc-plugins-server-select');

  // -- MC Backup ----------------------------------------------------------------------------
  var mcBackupServerSelectEl = document.getElementById('mc-backup-server-select');
  var mcBackupNoServerEl = document.getElementById('mc-backup-no-server');
  var mcBackupContentEl = document.getElementById('mc-backup-content');
  var mcBackupSettingsSectionEl = document.getElementById('mc-backup-settings-section');
  var mcBackupDirInput = document.getElementById('mc-backup-dir');
  var mcBackupMaxBackupsInput = document.getElementById('mc-backup-maxbackups');
  var mcBackupScheduleEnabledInput = document.getElementById('mc-backup-schedule-enabled');
  var mcBackupScheduleCronInput = document.getElementById('mc-backup-schedule-cron');
  var mcBackupSettingsErrorEl = document.getElementById('mc-backup-settings-error');
  var btnMcBackupCreate = document.getElementById('btn-mc-backup-create');
  var btnMcBackupRefresh = document.getElementById('btn-mc-backup-refresh');
  var mcBackupTableBody = document.getElementById('mc-backup-table-body');
  var mcBackupLogEl = document.getElementById('mc-backup-log');
  if (role && !canOperate) btnMcBackupCreate.style.display = 'none';
  if (role && !canAdmin) mcBackupSettingsSectionEl.style.display = 'none';

  function showMcBackupSettingsError(message) {
    mcBackupSettingsErrorEl.textContent = message || '';
    mcBackupSettingsErrorEl.style.display = message ? '' : 'none';
  }

  function saveMcBackupSettingsField(field, value) {
    if (!currentId) return;
    var id = currentId;
    var body = {};
    body[field] = value;
    showMcBackupSettingsError('');
    fetch('/api/servers/' + encodeURIComponent(id) + '/mc-startsettings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showMcBackupSettingsError(result.error || 'Save failed'); return; }
        if (id !== currentId) return;
        loadMcBackupView();
      })
      .catch(function () { showMcBackupSettingsError('Request failed'); });
  }

  mcBackupDirInput.addEventListener('change', function () { saveMcBackupSettingsField('backupDir', mcBackupDirInput.value); });
  mcBackupMaxBackupsInput.addEventListener('change', function () { saveMcBackupSettingsField('maxBackups', Number(mcBackupMaxBackupsInput.value)); });
  mcBackupScheduleEnabledInput.addEventListener('change', function () { saveMcBackupSettingsField('backupScheduleEnabled', mcBackupScheduleEnabledInput.checked); });
  mcBackupScheduleCronInput.addEventListener('change', function () { saveMcBackupSettingsField('backupSchedule', mcBackupScheduleCronInput.value); });

  function mcBackupAction(actionPath, filePath) {
    return fetch('/api/servers/' + encodeURIComponent(currentId) + actionPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: filePath })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showToast('Error: ' + result.error); return; }
        loadMcBackupView();
      })
      .catch(function () { showToast('Request failed'); });
  }

  function renderMcBackupTable(backups) {
    mcBackupTableBody.innerHTML = '';
    if (backups.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 4;
      emptyCell.className = 'empty-state';
      emptyCell.textContent = 'No backups yet.';
      emptyRow.appendChild(emptyCell);
      mcBackupTableBody.appendChild(emptyRow);
      return;
    }
    backups.forEach(function (b) {
      var row = document.createElement('tr');
      var nameCell = document.createElement('td');
      nameCell.textContent = b.fileName;
      var sizeCell = document.createElement('td');
      sizeCell.textContent = formatBackupSize(b.sizeBytes);
      var timeCell = document.createElement('td');
      timeCell.textContent = new Date(b.createdAt).toLocaleString();

      var actionsCell = document.createElement('td');
      actionsCell.className = 'backup-row-actions';
      if (!role || canAdmin) {
        var restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.textContent = 'Restore';
        restoreBtn.addEventListener('click', function () {
          if (!confirm('Restore ' + b.fileName + '? This overwrites the current world.')) return;
          void mcBackupAction('/mc-backups/restore', b.filePath);
        });
        var deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', function () {
          if (!confirm('Delete ' + b.fileName + '?')) return;
          void mcBackupAction('/mc-backups/delete', b.filePath);
        });
        actionsCell.appendChild(restoreBtn);
        actionsCell.appendChild(deleteBtn);
      }

      row.appendChild(nameCell);
      row.appendChild(sizeCell);
      row.appendChild(timeCell);
      row.appendChild(actionsCell);
      mcBackupTableBody.appendChild(row);
    });
  }

  function renderMcBackupLog(entries) {
    mcBackupLogEl.innerHTML = '';
    if (entries.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No backup activity yet.';
      mcBackupLogEl.appendChild(empty);
      return;
    }
    entries.forEach(function (entry) {
      var line = document.createElement('div');
      line.className = 'backup-log-line' + (entry.level === 'error' ? ' error' : '');
      var time = document.createElement('span');
      time.className = 'backup-log-time';
      time.textContent = new Date(entry.timestamp).toLocaleTimeString();
      line.appendChild(time);
      line.appendChild(document.createTextNode(entry.message));
      mcBackupLogEl.appendChild(line);
    });
    mcBackupLogEl.scrollTop = mcBackupLogEl.scrollHeight;
  }

  function loadMcBackupView() {
    var id = currentId;
    if (!id || !isMinecraftServer(id)) {
      mcBackupNoServerEl.style.display = '';
      mcBackupContentEl.classList.remove('active');
      return;
    }
    showMcBackupSettingsError('');
    mcBackupNoServerEl.style.display = 'none';
    mcBackupContentEl.classList.add('active');
    fetch('/api/servers/' + encodeURIComponent(id) + '/mc-startsettings')
      .then(function (r) { return r.json(); })
      .then(function (profile) {
        if (id !== currentId || !profile || !profile.id) return;
        mcBackupDirInput.value = profile.backupDir || '';
        mcBackupMaxBackupsInput.value = profile.maxBackups;
        mcBackupScheduleEnabledInput.checked = !!profile.backupScheduleEnabled;
        mcBackupScheduleCronInput.value = profile.backupSchedule || '';
        mcBackupScheduleCronInput.disabled = !profile.backupScheduleEnabled;
      })
      .catch(function () {});
    fetch('/api/servers/' + encodeURIComponent(id) + '/mc-backups')
      .then(function (r) { return r.json(); })
      .then(function (backups) { if (id === currentId) renderMcBackupTable(backups); });
    fetch('/api/servers/' + encodeURIComponent(id) + '/mc-backups/log')
      .then(function (r) { return r.json(); })
      .then(function (entries) { if (id === currentId) renderMcBackupLog(entries); });
  }

  btnMcBackupCreate.addEventListener('click', function () {
    if (!currentId) return;
    btnMcBackupCreate.disabled = true;
    btnMcBackupCreate.textContent = 'Creating...';
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/mc-backups', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) showToast('Error: ' + result.error);
        loadMcBackupView();
      })
      .catch(function () { showToast('Request failed'); })
      .finally(function () {
        btnMcBackupCreate.disabled = false;
        btnMcBackupCreate.textContent = 'Create backup now';
      });
  });

  btnMcBackupRefresh.addEventListener('click', function () { loadMcBackupView(); });

  setInterval(function () {
    if (activeView !== 'mc-backup' || !currentId) return;
    var id = currentId;
    fetch('/api/servers/' + encodeURIComponent(id) + '/mc-backups/log')
      .then(function (r) { return r.json(); })
      .then(function (entries) { if (id === currentId) renderMcBackupLog(entries); });
  }, 5000);

  // -- MC Server Management ----------------------------------------------------------------
  var mcManagementServerSelectEl = document.getElementById('mc-management-server-select');
  var mcManagementNoServerEl = document.getElementById('mc-management-no-server');
  var mcManagementContentEl = document.getElementById('mc-management-content');
  var mcManagementErrorEl = document.getElementById('mc-management-error');
  var mcmStartOnLaunch = document.getElementById('mcm-startonlaunch');
  var mcmRestartEnabled = document.getElementById('mcm-restart-enabled');
  var mcmRestartTime = document.getElementById('mcm-restart-time');
  var mcmRestartDaysEl = document.getElementById('mcm-restart-days');
  var mcmRestartStartAfter = document.getElementById('mcm-restart-startafter');
  var mcmRestartCountdownEl = document.getElementById('mcm-restart-countdown');
  var mcManagementProfile = null;

  function showMcManagementError(message) {
    mcManagementErrorEl.textContent = message || '';
    mcManagementErrorEl.style.display = message ? '' : 'none';
  }

  function saveMcManagementField(field, value) {
    if (!currentId || !mcManagementProfile) return;
    var id = currentId;
    var body = {};
    body[field] = value;
    fetch('/api/servers/' + encodeURIComponent(id) + '/mc-management', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showMcManagementError(result.error || 'Save failed'); return; }
        if (id !== currentId) return;
        mcManagementProfile = result.profile;
        renderMcManagementForm();
      })
      .catch(function () { showMcManagementError('Request failed'); });
  }

  function updateMcmCountdown() {
    if (!mcManagementProfile) return;
    var now = new Date();
    var next = mcManagementProfile.scheduledRestartEnabled
      ? computeNextOccurrence(now, mcManagementProfile.scheduledRestartTime, mcManagementProfile.scheduledRestartDays)
      : null;
    mcmRestartCountdownEl.textContent = 'Next shutdown in: ' + (next ? formatCountdown(next.getTime() - now.getTime()) : '--:--:--:--');
  }

  setInterval(function () {
    if (activeView === 'mc-management') updateMcmCountdown();
  }, 1000);

  function renderMcManagementForm() {
    var p = mcManagementProfile;
    mcmStartOnLaunch.checked = !!p.startOnManagerLaunch;
    mcmRestartEnabled.checked = !!p.scheduledRestartEnabled;
    mcmRestartTime.value = p.scheduledRestartTime || '00:00';
    mcmRestartTime.disabled = !p.scheduledRestartEnabled;
    mcmRestartStartAfter.checked = !!p.scheduledRestartStartAfter;
    mcmRestartStartAfter.disabled = !p.scheduledRestartEnabled;
    buildDayCheckboxes(mcmRestartDaysEl, p.scheduledRestartDays || [], function (day, checked) {
      var days = (p.scheduledRestartDays || []).slice();
      var idx = days.indexOf(day);
      if (checked && idx === -1) days.push(day);
      if (!checked && idx !== -1) days.splice(idx, 1);
      days.sort(function (a, b) { return a - b; });
      saveMcManagementField('scheduledRestartDays', days);
    });
    updateMcmCountdown();
  }

  function loadMcManagementView() {
    var id = currentId;
    if (!id || !isMinecraftServer(id)) {
      mcManagementNoServerEl.style.display = '';
      mcManagementContentEl.classList.remove('active');
      return;
    }
    showMcManagementError('');
    mcManagementNoServerEl.style.display = 'none';
    mcManagementContentEl.classList.add('active');
    fetch('/api/servers/' + encodeURIComponent(id) + '/mc-management')
      .then(function (r) { return r.json(); })
      .then(function (profile) {
        if (id !== currentId) return;
        mcManagementProfile = profile;
        renderMcManagementForm();
      });
  }

  mcmStartOnLaunch.addEventListener('change', function () { saveMcManagementField('startOnManagerLaunch', mcmStartOnLaunch.checked); });
  mcmRestartEnabled.addEventListener('change', function () { saveMcManagementField('scheduledRestartEnabled', mcmRestartEnabled.checked); });
  mcmRestartTime.addEventListener('change', function () { saveMcManagementField('scheduledRestartTime', mcmRestartTime.value); });
  mcmRestartStartAfter.addEventListener('change', function () { saveMcManagementField('scheduledRestartStartAfter', mcmRestartStartAfter.checked); });

  // -- Mods ---------------------------------------------------------------------------
  var modsServerSelectEl = document.getElementById('mods-server-select');
  var modsNoServerEl = document.getElementById('mods-no-server');
  var modsContentEl = document.getElementById('mods-content');
  var modsNewIdInput = document.getElementById('mods-new-id');
  var btnModsAdd = document.getElementById('btn-mods-add');
  var modsTableBody = document.getElementById('mods-table-body');
  var modsErrorEl = document.getElementById('mods-error');
  var modsSearchSectionEl = document.getElementById('mods-search-section');
  var modsSearchNoKeyEl = document.getElementById('mods-search-nokey');
  var modsSearchUiEl = document.getElementById('mods-search-ui');
  var modsSearchQueryInput = document.getElementById('mods-search-query');
  var btnModsSearch = document.getElementById('btn-mods-search');
  var modsSearchErrorEl = document.getElementById('mods-search-error');
  var modsSearchResultsEl = document.getElementById('mods-search-results');
  var currentMods = [];
  // ARK: Survival Evolved's mod ids are a Steam Workshop namespace, not CurseForge - the
  // search/icon/resolved-name additions below only ever make sense for ARK: Survival
  // Ascended, same gating as the desktop app's own ModsTab (isEvolved there).
  var currentModsIsEvolved = false;
  var currentArkInfo = {};
  var modsSearched = false;

  function showModsError(message) {
    modsErrorEl.textContent = message || '';
    modsErrorEl.style.display = message ? '' : 'none';
  }

  function showModsSearchError(message) {
    modsSearchErrorEl.textContent = message || '';
    modsSearchErrorEl.style.display = message ? '' : 'none';
  }

  // Looks up a real name/icon for every mod id currently in the list (typed by hand, or
  // added via search below) so the table can show it next to every row - re-fetched after
  // every save, same as the desktop app's own background enrichment effect.
  function refreshArkModsInfo() {
    if (currentModsIsEvolved || currentMods.length === 0) {
      currentArkInfo = {};
      renderModsTable();
      return;
    }
    var id = currentId;
    fetch('/api/servers/' + encodeURIComponent(id) + '/mods/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modIds: currentMods.map(function (m) { return m.id; }) })
    })
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (id !== currentId) return;
        currentArkInfo = info || {};
        renderModsTable();
      })
      .catch(function () { renderModsTable(); });
  }

  function saveMods(next) {
    if (!currentId) return;
    var id = currentId;
    fetch('/api/servers/' + encodeURIComponent(id) + '/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mods: next })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showModsError(result.error || 'Save failed'); return; }
        if (id !== currentId) return;
        currentMods = result.profile.mods || [];
        refreshArkModsInfo();
        renderModsSearchResults(); // re-render so just-added rows switch from "Add" to "Added"
      })
      .catch(function () { showModsError('Request failed'); });
  }

  function renderModsTable() {
    modsTableBody.innerHTML = '';
    if (currentMods.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 6;
      emptyCell.className = 'empty-state';
      emptyCell.textContent = 'No mods configured.';
      emptyRow.appendChild(emptyCell);
      modsTableBody.appendChild(emptyRow);
      return;
    }
    currentMods.forEach(function (mod, index) {
      var row = document.createElement('tr');

      function checkboxCell(field) {
        var td = document.createElement('td');
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!mod[field];
        input.addEventListener('change', function () {
          var updatedMod = Object.assign({}, mod);
          updatedMod[field] = input.checked;
          var next = currentMods.slice();
          next[index] = updatedMod;
          saveMods(next);
        });
        td.appendChild(input);
        return td;
      }
      row.appendChild(checkboxCell('enabled'));
      row.appendChild(checkboxCell('passive'));
      row.appendChild(checkboxCell('dev'));

      var idCell = document.createElement('td');
      idCell.textContent = mod.id + (mod.dev ? '-dev' : '');
      row.appendChild(idCell);

      var nameCell = document.createElement('td');
      nameCell.className = 'ark-mod-name-cell';
      if (currentModsIsEvolved) {
        var nameInput = document.createElement('input');
        nameInput.value = mod.name || '';
        nameInput.placeholder = 'Optional label';
        nameInput.addEventListener('change', function () {
          var updatedMod = Object.assign({}, mod, { name: nameInput.value || undefined });
          var next = currentMods.slice();
          next[index] = updatedMod;
          saveMods(next);
        });
        nameCell.appendChild(nameInput);
      } else {
        var info = currentArkInfo[mod.id];
        if (info && info.iconUrl) {
          var icon = document.createElement('img');
          icon.src = info.iconUrl;
          icon.alt = '';
          icon.className = 'ark-mod-icon';
          icon.addEventListener('error', function () { icon.style.display = 'none'; });
          nameCell.appendChild(icon);
        }
        var resolved = (info && info.name) || mod.name;
        var nameSpan = document.createElement('span');
        nameSpan.className = 'ark-mod-title' + (resolved ? '' : ' muted');
        nameSpan.title = resolved || '';
        nameSpan.textContent = resolved || '—';
        nameCell.appendChild(nameSpan);
      }
      row.appendChild(nameCell);

      var actionsCell = document.createElement('td');
      actionsCell.className = 'mods-grid-actions';

      function moveModBtn(label, title, disabled, onClick) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.title = title;
        btn.disabled = disabled;
        btn.addEventListener('click', onClick);
        return btn;
      }

      actionsCell.appendChild(moveModBtn('⤒', 'Move to top of list', index === 0, function () {
        var next = currentMods.slice();
        var moved = next.splice(index, 1)[0];
        next.unshift(moved);
        saveMods(next);
      }));
      actionsCell.appendChild(moveModBtn('↑', 'Move up', index === 0, function () {
        var next = currentMods.slice();
        var tmp = next[index - 1];
        next[index - 1] = next[index];
        next[index] = tmp;
        saveMods(next);
      }));
      actionsCell.appendChild(moveModBtn('↓', 'Move down', index === currentMods.length - 1, function () {
        var next = currentMods.slice();
        var tmp = next[index + 1];
        next[index + 1] = next[index];
        next[index] = tmp;
        saveMods(next);
      }));

      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'danger';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', function () {
        saveMods(currentMods.filter(function (m) { return m.id !== mod.id; }));
      });
      actionsCell.appendChild(removeBtn);
      row.appendChild(actionsCell);

      modsTableBody.appendChild(row);
    });
  }

  // Renders the CurseForge search-results list (separate from renderModsTable, which renders
  // the server's own mod list above it) - takes no args, re-reading modsSearchResults/
  // modsSearched state, so it can be called again after a save to flip a freshly-added
  // result's button from "Add" to "Added" without re-searching.
  var modsSearchResults = [];
  function renderModsSearchResults() {
    modsSearchResultsEl.innerHTML = '';
    if (modsSearchResults.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = modsSearched ? 'No results.' : 'Search above to find mods to add.';
      modsSearchResultsEl.appendChild(empty);
      return;
    }
    modsSearchResults.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'ark-mod-search-result';
      if (r.iconUrl) {
        var icon = document.createElement('img');
        icon.src = r.iconUrl;
        icon.alt = '';
        icon.className = 'ark-mod-icon';
        icon.addEventListener('error', function () { icon.style.display = 'none'; });
        row.appendChild(icon);
      }
      var info = document.createElement('div');
      info.className = 'ark-mod-search-result-info';
      var nameSpan = document.createElement('span');
      nameSpan.className = 'ark-mod-search-result-name';
      nameSpan.textContent = r.name;
      var summarySpan = document.createElement('span');
      summarySpan.className = 'empty-state ark-mod-search-result-summary';
      summarySpan.title = r.summary || '';
      summarySpan.textContent = r.summary || '';
      info.appendChild(nameSpan);
      info.appendChild(summarySpan);
      row.appendChild(info);
      var downloadsSpan = document.createElement('span');
      downloadsSpan.className = 'empty-state ark-mod-search-result-downloads';
      downloadsSpan.textContent = (r.downloads || 0).toLocaleString() + ' downloads';
      row.appendChild(downloadsSpan);
      var added = currentMods.some(function (m) { return m.id === r.id; });
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.disabled = added;
      addBtn.textContent = added ? 'Added' : 'Add';
      addBtn.addEventListener('click', function () {
        if (currentMods.some(function (m) { return m.id === r.id; })) return;
        saveMods(currentMods.concat([{ id: r.id, name: r.name, enabled: true, passive: false, dev: false }]));
      });
      row.appendChild(addBtn);
      modsSearchResultsEl.appendChild(row);
    });
  }

  function runModsSearch() {
    var query = modsSearchQueryInput.value.trim();
    if (!query || !currentId) return;
    var id = currentId;
    btnModsSearch.disabled = true;
    btnModsSearch.textContent = 'Searching...';
    showModsSearchError('');
    fetch('/api/servers/' + encodeURIComponent(id) + '/mods/search?q=' + encodeURIComponent(query))
      .then(function (r) { return r.json(); })
      .then(function (results) {
        modsSearched = true;
        if (id !== currentId) return;
        modsSearchResults = results || [];
        renderModsSearchResults();
      })
      .catch(function () {
        if (id !== currentId) return;
        showModsSearchError('Search failed');
      })
      .finally(function () {
        btnModsSearch.disabled = false;
        btnModsSearch.textContent = 'Search';
      });
  }

  btnModsSearch.addEventListener('click', runModsSearch);
  modsSearchQueryInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); runModsSearch(); }
  });

  function loadModsView() {
    var id = currentId;
    if (!id) {
      modsNoServerEl.textContent = 'No server selected - choose one above.';
      modsNoServerEl.style.display = '';
      modsContentEl.classList.remove('active');
      return;
    }
    if (isMinecraftServer(id)) {
      modsNoServerEl.textContent = MINECRAFT_VIEW_UNAVAILABLE_TEXT;
      modsNoServerEl.style.display = '';
      modsContentEl.classList.remove('active');
      return;
    }
    showModsError('');
    showModsSearchError('');
    modsNoServerEl.style.display = 'none';
    modsContentEl.classList.add('active');
    modsSearched = false;
    modsSearchResults = [];
    modsSearchQueryInput.value = '';
    renderModsSearchResults();
    fetch('/api/servers/' + encodeURIComponent(id) + '/profile')
      .then(function (r) { return r.json(); })
      .then(function (profile) {
        if (id !== currentId) return;
        currentMods = profile.mods || [];
        currentModsIsEvolved = profile.game === 'ark-evolved';
        modsSearchSectionEl.style.display = currentModsIsEvolved ? 'none' : '';
        if (!currentModsIsEvolved) {
          fetch('/api/arkmods/status')
            .then(function (r) { return r.json(); })
            .then(function (result) {
              if (id !== currentId) return;
              var hasKey = !!(result && result.hasCurseForgeKey);
              modsSearchNoKeyEl.style.display = hasKey ? 'none' : '';
              modsSearchUiEl.style.display = hasKey ? '' : 'none';
            });
        }
        refreshArkModsInfo();
      });
  }

  btnModsAdd.addEventListener('click', function () {
    var idValue = modsNewIdInput.value.trim();
    if (!idValue || currentMods.some(function (m) { return m.id === idValue; })) return;
    saveMods(currentMods.concat([{ id: idValue, enabled: true, passive: false, dev: false }]));
    modsNewIdInput.value = '';
  });

  // -- Map Management -------------------------------------------------------------------
  var mapmanagementServerSelectEl = document.getElementById('mapmanagement-server-select');
  var mapmanagementNoServerEl = document.getElementById('mapmanagement-no-server');
  var mapmanagementContentEl = document.getElementById('mapmanagement-content');
  var mapmanagementFolderInput = document.getElementById('mapmanagement-folder');
  var mapmanagementFileInput = document.getElementById('mapmanagement-file');
  var btnMapManagementAdd = document.getElementById('btn-mapmanagement-add');
  var mapmanagementErrorEl = document.getElementById('mapmanagement-error');
  var btnMapManagementRefresh = document.getElementById('btn-mapmanagement-refresh');
  var btnMapManagementDelete = document.getElementById('btn-mapmanagement-delete');
  var mapmanagementTableBody = document.getElementById('mapmanagement-table-body');
  var mapManagementSelected = '';
  var mapManagementFolders = [];

  function showMapManagementError(message) {
    mapmanagementErrorEl.textContent = message || '';
    mapmanagementErrorEl.style.display = message ? '' : 'none';
  }

  function renderMapManagementTable() {
    mapmanagementTableBody.innerHTML = '';
    if (mapManagementFolders.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 2;
      emptyCell.className = 'empty-state';
      emptyCell.textContent = 'No map folders under SavedArks yet.';
      emptyRow.appendChild(emptyCell);
      mapmanagementTableBody.appendChild(emptyRow);
      return;
    }
    mapManagementFolders.forEach(function (folder) {
      var row = document.createElement('tr');
      row.className = 'selectable' + (folder.name === mapManagementSelected ? ' selected' : '');
      row.addEventListener('click', function () {
        mapManagementSelected = folder.name;
        btnMapManagementDelete.disabled = false;
        renderMapManagementTable();
      });
      var nameCell = document.createElement('td');
      nameCell.textContent = folder.name;
      var dateCell = document.createElement('td');
      dateCell.textContent = new Date(folder.createdAt).toLocaleString();
      row.appendChild(nameCell);
      row.appendChild(dateCell);
      mapmanagementTableBody.appendChild(row);
    });
  }

  function loadMapManagementView() {
    var id = currentId;
    if (!id) {
      mapmanagementNoServerEl.textContent = 'No server selected - choose one above.';
      mapmanagementNoServerEl.style.display = '';
      mapmanagementContentEl.classList.remove('active');
      return;
    }
    if (isMinecraftServer(id)) {
      mapmanagementNoServerEl.textContent = MINECRAFT_VIEW_UNAVAILABLE_TEXT;
      mapmanagementNoServerEl.style.display = '';
      mapmanagementContentEl.classList.remove('active');
      return;
    }
    showMapManagementError('');
    mapmanagementNoServerEl.style.display = 'none';
    mapmanagementContentEl.classList.add('active');
    mapManagementSelected = '';
    btnMapManagementDelete.disabled = true;
    fetch('/api/servers/' + encodeURIComponent(id) + '/mapfolders')
      .then(function (r) { return r.json(); })
      .then(function (folders) {
        if (id !== currentId) return;
        mapManagementFolders = folders;
        renderMapManagementTable();
      });
  }

  btnMapManagementAdd.addEventListener('click', function () {
    if (!currentId) return;
    var folderName = mapmanagementFolderInput.value.trim();
    var fileName = mapmanagementFileInput.value.trim();
    if (!folderName || !fileName) return;
    showMapManagementError('');
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/mapfolders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderName: folderName, fileName: fileName })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showMapManagementError(result.error || 'Failed'); return; }
        mapmanagementFolderInput.value = '';
        mapmanagementFileInput.value = '';
        loadMapManagementView();
      })
      .catch(function () { showMapManagementError('Request failed'); });
  });

  btnMapManagementRefresh.addEventListener('click', function () { loadMapManagementView(); });

  btnMapManagementDelete.addEventListener('click', function () {
    if (!currentId || !mapManagementSelected) return;
    if (!confirm('Delete the "' + mapManagementSelected + '" map folder and everything in it?')) return;
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/mapfolders/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderName: mapManagementSelected })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showMapManagementError(result.error || 'Failed'); return; }
        loadMapManagementView();
      })
      .catch(function () { showMapManagementError('Request failed'); });
  });

  // -- Files ----------------------------------------------------------------------------
  // Browses a server's own install directory over the /files* routes (webDashboard.ts),
  // which resolve every path server-side via resolveSafePath (pathSanitize.ts) - this client
  // code never has to think about traversal itself, it just sends whatever relative path the
  // breadcrumb/folder clicks build up.
  var filesServerSelectEl = document.getElementById('files-server-select');
  var filesNoServerEl = document.getElementById('files-no-server');
  var filesContentEl = document.getElementById('files-content');
  var filesOpenTabsEl = document.getElementById('files-open-tabs');
  var filesBreadcrumbEl = document.getElementById('files-breadcrumb');
  var filesErrorEl = document.getElementById('files-error');
  var filesTableEl = document.getElementById('files-table');
  var filesTableBody = document.getElementById('files-table-body');
  var filesIniEditorEl = document.getElementById('files-ini-editor');
  var filesIniEditorTitleEl = document.getElementById('files-ini-editor-title');
  var filesIniGutterEl = document.getElementById('files-ini-gutter');
  var filesIniHighlightEl = document.getElementById('files-ini-highlight');
  var filesIniHistorySectionEl = document.getElementById('files-ini-history-section');
  var filesIniTextareaEl = document.getElementById('files-ini-editor-textarea');
  var filesIniErrorEl = document.getElementById('files-ini-editor-error');
  var btnFilesIniSave = document.getElementById('btn-files-ini-save');
  var btnFilesIniCancel = document.getElementById('btn-files-ini-cancel');
  var filesIniHistoryEmptyEl = document.getElementById('files-ini-history-empty');
  var filesIniHistoryListEl = document.getElementById('files-ini-history-list');
  var filesIniDiffEl = document.getElementById('files-ini-diff');
  var filesCurrentPath = '';
  var filesEntries = [];
  // Notepad++-inspired: several .ini files can be open at once, each its own tab
  // ({path, content, originalContent}), rather than the editor always replacing the table
  // for a single file with no way back to a previously opened one short of re-browsing to
  // it. filesActiveTabPath === null means "browsing the table", not "no tabs open".
  var filesOpenTabs = [];
  var filesActiveTabPath = null;
  // .log files are opened read-only (see isEditableTextPath's own comment in
  // src/main/lib/fileBrowser.ts for why) - tracked alongside the active tab so the Save
  // button/History section/textarea can all reflect it without re-deriving it everywhere.
  var filesActiveReadOnly = false;

  // BEGIN-FILES-HIGHLIGHT-PURE - a plain-JS mirror of shared/syntaxHighlight.ts's
  // languageForPath/tokenizeLine, duplicated here (rather than imported) because this whole
  // script is a hand-written string served as-is, not bundled code. No DOM access in this
  // block on purpose - tests/webDashboard.test.ts extracts exactly the text between these two
  // markers and actually runs it (not just checking its syntax) against the same cases as
  // tests/syntaxHighlight.test.ts, to catch the two drifting apart. Writing backslash escapes
  // in this section specifically needs care: this whole script is itself one giant TS
  // template literal (DASHBOARD_HTML in this same file) - a single backslash followed by a
  // recognized escape letter written here is consumed by *that* template literal's own escape
  // processing before it ever reaches the browser, so a regex meant to keep its word-boundary
  // escape in the served JS has to double that backslash here (see the "syntactically valid
  // JS" test's own comment for the newline-escape case that first caught this).
  function filesLanguageForPath(p) {
    if (/\\.ini$/i.test(p)) return 'ini';
    if (/\\.json$/i.test(p)) return 'json';
    if (/\\.log$/i.test(p)) return 'log';
    return 'plain';
  }

  var FILES_INI_BOOLEAN_RE = /^(true|false)$/i;
  var FILES_NUMBER_RE = /^-?\\d+(\\.\\d+)?$/;

  function filesTokenizeIniLine(line) {
    var trimmed = line.trim();
    if (trimmed.indexOf(';') === 0 || trimmed.indexOf('#') === 0) return [{ text: line, type: 'comment' }];
    if (trimmed.indexOf('[') === 0 && trimmed.charAt(trimmed.length - 1) === ']') return [{ text: line, type: 'section' }];
    var eq = line.indexOf('=');
    if (eq === -1) return [{ text: line, type: 'plain' }];
    var key = line.slice(0, eq);
    var value = line.slice(eq + 1);
    var valueTrimmed = value.trim();
    var valueType = FILES_NUMBER_RE.test(valueTrimmed)
      ? 'number'
      : (FILES_INI_BOOLEAN_RE.test(valueTrimmed) ? 'boolean' : 'string');
    return [{ text: key, type: 'key' }, { text: '=', type: 'punctuation' }, { text: value, type: valueType }];
  }

  // See JSON_TOKEN_RE's own comment in shared/syntaxHighlight.ts for why the string
  // alternative here is a plain "[^"]*" instead of handling escaped quotes.
  var FILES_JSON_TOKEN_RE = /"[^"]*"|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|\\btrue\\b|\\bfalse\\b|\\bnull\\b|[{}[\\],:]/g;

  function filesTokenizeJsonLine(line) {
    var tokens = [];
    var lastIndex = 0;
    FILES_JSON_TOKEN_RE.lastIndex = 0;
    var match;
    while ((match = FILES_JSON_TOKEN_RE.exec(line))) {
      if (match.index > lastIndex) tokens.push({ text: line.slice(lastIndex, match.index), type: 'plain' });
      var text = match[0];
      var type;
      if (text === '{' || text === '}' || text === '[' || text === ']' || text === ',' || text === ':') type = 'punctuation';
      else if (text === 'true' || text === 'false' || text === 'null') type = 'boolean';
      else if (text.charAt(0) === '"') type = /^\\s*:/.test(line.slice(match.index + text.length)) ? 'key' : 'string';
      else type = 'number';
      tokens.push({ text: text, type: type });
      lastIndex = FILES_JSON_TOKEN_RE.lastIndex;
    }
    if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex), type: 'plain' });
    return tokens.length ? tokens : [{ text: line, type: 'plain' }];
  }

  var FILES_LOG_TIMESTAMP_RE = /^\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z?/;
  var FILES_LOG_LEVEL_RE = /\\b(ERROR|FATAL|WARN|WARNING|INFO|DEBUG|TRACE)\\b/;

  function filesTokenizeLogLine(line) {
    var tokens = [];
    var rest = line;
    var tsMatch = rest.match(FILES_LOG_TIMESTAMP_RE);
    if (tsMatch) {
      tokens.push({ text: tsMatch[0], type: 'timestamp' });
      rest = rest.slice(tsMatch[0].length);
    }
    var levelMatch = rest.match(FILES_LOG_LEVEL_RE);
    if (levelMatch) {
      var before = rest.slice(0, levelMatch.index);
      if (before) tokens.push({ text: before, type: 'plain' });
      var level = levelMatch[0].toUpperCase();
      var type = (level === 'ERROR' || level === 'FATAL') ? 'error' : ((level === 'WARN' || level === 'WARNING') ? 'warn' : 'info');
      tokens.push({ text: levelMatch[0], type: type });
      rest = rest.slice(levelMatch.index + levelMatch[0].length);
    }
    if (rest) tokens.push({ text: rest, type: 'plain' });
    return tokens.length ? tokens : [{ text: line, type: 'plain' }];
  }

  function filesTokenizeLine(line, language) {
    if (language === 'ini') return filesTokenizeIniLine(line);
    if (language === 'json') return filesTokenizeJsonLine(line);
    if (language === 'log') return filesTokenizeLogLine(line);
    return [{ text: line, type: 'plain' }];
  }
  // END-FILES-HIGHLIGHT-PURE

  function filesEscapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function isOpenableFileName(name) { return filesLanguageForPath(name) !== 'plain'; }

  function showFilesIniError(message) {
    filesIniErrorEl.textContent = message || '';
    filesIniErrorEl.style.display = message ? '' : 'none';
  }

  function findFilesOpenTab(entryPath) {
    for (var i = 0; i < filesOpenTabs.length; i++) {
      if (filesOpenTabs[i].path === entryPath) return filesOpenTabs[i];
    }
    return null;
  }

  // Renders both the line-number gutter and the Notepad++-style colored layer behind the
  // textarea from the same split-into-lines pass - see the "Files syntax highlighting"
  // section above for the tokenizer and the .files-editor-highlight CSS rule for how the two
  // layers stay pixel-aligned.
  function renderFilesIniEditorContent() {
    var lines = filesIniTextareaEl.value.split('\\n');

    var gutterText = '';
    for (var i = 1; i <= lines.length; i++) gutterText += i + '\\n';
    filesIniGutterEl.textContent = gutterText;

    var language = filesActiveTabPath ? filesLanguageForPath(filesActiveTabPath) : 'plain';
    var htmlParts = [];
    for (var li = 0; li < lines.length; li++) {
      var tokens = filesTokenizeLine(lines[li], language);
      var lineHtml = '';
      for (var ti = 0; ti < tokens.length; ti++) {
        lineHtml += '<span class="tok-' + tokens[ti].type + '">' + filesEscapeHtml(tokens[ti].text) + '</span>';
      }
      htmlParts.push(lineHtml);
    }
    filesIniHighlightEl.innerHTML = htmlParts.join('\\n');
  }

  filesIniTextareaEl.addEventListener('scroll', function () {
    filesIniGutterEl.scrollTop = filesIniTextareaEl.scrollTop;
    filesIniHighlightEl.scrollTop = filesIniTextareaEl.scrollTop;
  });

  function renderFilesOpenTabs() {
    filesOpenTabsEl.innerHTML = '';
    filesOpenTabsEl.style.display = filesOpenTabs.length === 0 ? 'none' : '';
    if (filesOpenTabs.length === 0) return;

    var browseBtn = document.createElement('button');
    browseBtn.type = 'button';
    browseBtn.className = 'files-browse-tab' + (filesActiveTabPath === null ? ' active' : '');
    browseBtn.textContent = '📁 Files';
    browseBtn.addEventListener('click', function () { showFilesBrowser(); });
    filesOpenTabsEl.appendChild(browseBtn);

    filesOpenTabs.forEach(function (tab) {
      var wrap = document.createElement('div');
      wrap.className = 'files-open-tab' + (tab.path === filesActiveTabPath ? ' active' : '');
      var label = document.createElement('button');
      label.type = 'button';
      label.className = 'files-open-tab-label';
      label.title = tab.path;
      label.textContent = tab.path.split('/').pop() + (tab.content !== tab.originalContent ? ' •' : '');
      label.addEventListener('click', function () { focusFilesTab(tab.path); });
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'files-open-tab-close';
      closeBtn.title = 'Close';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', function () { closeFilesTab(tab.path); });
      wrap.appendChild(label);
      wrap.appendChild(closeBtn);
      filesOpenTabsEl.appendChild(wrap);
    });
  }

  function showFilesBrowser() {
    filesActiveTabPath = null;
    filesActiveReadOnly = false;
    filesIniEditorEl.style.display = 'none';
    filesIniDiffEl.style.display = 'none';
    filesTableEl.style.display = '';
    renderFilesOpenTabs();
  }

  function closeFilesTab(entryPath) {
    var closedIndex = -1;
    for (var i = 0; i < filesOpenTabs.length; i++) {
      if (filesOpenTabs[i].path === entryPath) { closedIndex = i; break; }
    }
    if (closedIndex === -1) return;
    filesOpenTabs.splice(closedIndex, 1);
    if (filesActiveTabPath === entryPath) {
      var fallback = filesOpenTabs[closedIndex] || filesOpenTabs[closedIndex - 1] || null;
      if (fallback) focusFilesTab(fallback.path);
      else showFilesBrowser();
    } else {
      renderFilesOpenTabs();
    }
  }

  function renderFilesIniDiff(diffLines) {
    filesIniDiffEl.innerHTML = '';
    diffLines.forEach(function (line) {
      var span = document.createElement('span');
      span.className = 'diff-' + line.type;
      var prefix = line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  ';
      span.textContent = prefix + line.text;
      filesIniDiffEl.appendChild(span);
    });
    filesIniDiffEl.style.display = '';
  }

  function viewFilesIniDiff(entryId) {
    if (!currentId) return;
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/ini/history-diff?id=' + encodeURIComponent(entryId))
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok) { showFilesIniError(result.body.error || 'Failed to load diff.'); return; }
        renderFilesIniDiff(result.body.diff);
      })
      .catch(function () { showFilesIniError('Request failed'); });
  }

  function restoreFilesIniEntry(entryId) {
    if (!currentId || !filesActiveTabPath) return;
    var path = filesActiveTabPath;
    if (!confirm('Restore this version of "' + path + '"? The current content will be saved to history first.')) return;
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/ini/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: entryId })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showFilesIniError(result.error || 'Failed to restore.'); return; }
        showToast('Restored ' + path);
        fetch('/api/servers/' + encodeURIComponent(currentId) + '/ini?path=' + encodeURIComponent(path))
          .then(function (r) { return r.json(); })
          .then(function (body) {
            var tab = findFilesOpenTab(path);
            if (tab) { tab.content = body.content; tab.originalContent = body.content; }
            if (filesActiveTabPath === path) filesIniTextareaEl.value = body.content;
            renderFilesIniEditorContent();
            renderFilesOpenTabs();
            loadFilesIniHistory(path);
          });
      })
      .catch(function () { showFilesIniError('Request failed'); });
  }

  function loadFilesIniHistory(entryPath) {
    if (!currentId) return;
    filesIniDiffEl.style.display = 'none';
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/ini/history?path=' + encodeURIComponent(entryPath))
      .then(function (r) { return r.json(); })
      .then(function (entries) {
        filesIniHistoryListEl.innerHTML = '';
        filesIniHistoryEmptyEl.style.display = entries.length === 0 ? '' : 'none';
        entries.forEach(function (entry) {
          var li = document.createElement('li');
          var span = document.createElement('span');
          span.textContent = new Date(entry.savedAt).toLocaleString();
          var diffBtn = document.createElement('button');
          diffBtn.type = 'button';
          diffBtn.textContent = 'View diff';
          diffBtn.addEventListener('click', function () { viewFilesIniDiff(entry.id); });
          var restoreBtn = document.createElement('button');
          restoreBtn.type = 'button';
          restoreBtn.textContent = 'Restore';
          restoreBtn.addEventListener('click', function () { restoreFilesIniEntry(entry.id); });
          li.appendChild(span);
          li.appendChild(diffBtn);
          li.appendChild(restoreBtn);
          filesIniHistoryListEl.appendChild(li);
        });
      })
      .catch(function () { /* non-fatal - the editor itself still works without history */ });
  }

  function focusFilesTab(entryPath) {
    var tab = findFilesOpenTab(entryPath);
    if (!tab) return;
    filesActiveTabPath = entryPath;
    filesActiveReadOnly = filesLanguageForPath(entryPath) === 'log';
    filesIniEditorTitleEl.textContent = entryPath + (filesActiveReadOnly ? ' (read-only)' : '');
    filesIniTextareaEl.value = tab.content;
    filesIniTextareaEl.readOnly = filesActiveReadOnly;
    btnFilesIniSave.style.display = filesActiveReadOnly ? 'none' : '';
    filesIniHistorySectionEl.style.display = filesActiveReadOnly ? 'none' : '';
    renderFilesIniEditorContent();
    showFilesIniError('');
    filesIniDiffEl.style.display = 'none';
    filesTableEl.style.display = 'none';
    filesIniEditorEl.style.display = '';
    renderFilesOpenTabs();
    if (!filesActiveReadOnly) loadFilesIniHistory(entryPath);
  }

  function openFilesIniEditor(entryPath) {
    if (!currentId) return;
    if (findFilesOpenTab(entryPath)) { focusFilesTab(entryPath); return; }
    showFilesError('');
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/ini?path=' + encodeURIComponent(entryPath))
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok) { showFilesError(result.body.error || 'Failed to open this file.'); return; }
        filesOpenTabs.push({ path: entryPath, content: result.body.content, originalContent: result.body.content });
        focusFilesTab(entryPath);
      })
      .catch(function () { showFilesError('Request failed'); });
  }

  filesIniTextareaEl.addEventListener('input', function () {
    if (filesActiveReadOnly) return;
    var tab = findFilesOpenTab(filesActiveTabPath);
    if (tab) tab.content = filesIniTextareaEl.value;
    renderFilesIniEditorContent();
    renderFilesOpenTabs();
  });

  btnFilesIniSave.addEventListener('click', function () {
    if (!currentId || !filesActiveTabPath || filesActiveReadOnly) return;
    var path = filesActiveTabPath;
    showFilesIniError('');
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/ini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path, content: filesIniTextareaEl.value })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showFilesIniError(result.error || 'Failed to save.'); return; }
        showToast('Saved ' + path);
        var tab = findFilesOpenTab(path);
        if (tab) tab.originalContent = tab.content;
        renderFilesOpenTabs();
        loadFilesIniHistory(path);
      })
      .catch(function () { showFilesIniError('Request failed'); });
  });

  btnFilesIniCancel.addEventListener('click', function () {
    if (filesActiveTabPath) closeFilesTab(filesActiveTabPath);
  });

  function showFilesError(message) {
    filesErrorEl.textContent = message || '';
    filesErrorEl.style.display = message ? '' : 'none';
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var value = bytes;
    for (var i = 0; i < units.length; i++) {
      value = value / 1024;
      if (value < 1024 || i === units.length - 1) return value.toFixed(1) + ' ' + units[i];
    }
    return bytes + ' B';
  }

  function renderFilesBreadcrumb() {
    filesBreadcrumbEl.innerHTML = '';
    var rootBtn = document.createElement('button');
    rootBtn.type = 'button';
    rootBtn.textContent = 'Root';
    rootBtn.addEventListener('click', function () { filesCurrentPath = ''; loadFilesView(); });
    filesBreadcrumbEl.appendChild(rootBtn);
    if (!filesCurrentPath) return;
    var segments = filesCurrentPath.split('/').filter(Boolean);
    var built = '';
    segments.forEach(function (segment) {
      built = built ? built + '/' + segment : segment;
      var sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      filesBreadcrumbEl.appendChild(sep);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = segment;
      var target = built;
      btn.addEventListener('click', function () { filesCurrentPath = target; loadFilesView(); });
      filesBreadcrumbEl.appendChild(btn);
    });
  }

  function deleteFilesEntry(entry) {
    if (!currentId) return;
    if (!confirm('Delete "' + entry.name + '"? This cannot be undone.')) return;
    var entryPath = filesCurrentPath ? filesCurrentPath + '/' + entry.name : entry.name;
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entryPath })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showFilesError(result.error || 'Failed'); return; }
        loadFilesView();
      })
      .catch(function () { showFilesError('Request failed'); });
  }

  function renderFilesTable() {
    filesTableBody.innerHTML = '';
    if (filesEntries.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 4;
      emptyCell.className = 'empty-state';
      emptyCell.textContent = 'This folder is empty.';
      emptyRow.appendChild(emptyCell);
      filesTableBody.appendChild(emptyRow);
      return;
    }
    // Folders first, then files, each alphabetical - matches a typical native file browser
    // rather than whatever order fs.readdirSync happened to return.
    var sorted = filesEntries.slice().sort(function (a, b) {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    sorted.forEach(function (entry) {
      var entryPath = filesCurrentPath ? filesCurrentPath + '/' + entry.name : entry.name;
      var row = document.createElement('tr');
      var nameCell = document.createElement('td');
      nameCell.textContent = (entry.isDir ? '📁 ' : '📄 ') + entry.name;
      if (entry.isDir) {
        nameCell.className = 'files-name-cell';
        nameCell.addEventListener('click', function () {
          filesCurrentPath = entryPath;
          loadFilesView();
        });
      } else if (isOpenableFileName(entry.name)) {
        nameCell.className = 'files-name-cell';
        nameCell.title = filesLanguageForPath(entry.name) === 'log' ? 'Click to view' : 'Click to edit';
        nameCell.addEventListener('click', function () { openFilesIniEditor(entryPath); });
      }
      var sizeCell = document.createElement('td');
      sizeCell.textContent = entry.isDir ? '-' : formatFileSize(entry.size);
      var mtimeCell = document.createElement('td');
      mtimeCell.textContent = new Date(entry.mtime).toLocaleString();
      var actionsCell = document.createElement('td');
      if (!entry.isDir) {
        var downloadLink = document.createElement('a');
        downloadLink.href = '/api/servers/' + encodeURIComponent(currentId) + '/files/download?path=' + encodeURIComponent(entryPath) +
          (accessToken ? '&token=' + encodeURIComponent(accessToken) : '');
        downloadLink.textContent = 'Download';
        downloadLink.style.marginRight = '8px';
        actionsCell.appendChild(downloadLink);
        var deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'danger';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', function () { deleteFilesEntry(entry); });
        actionsCell.appendChild(deleteBtn);
      }
      row.appendChild(nameCell);
      row.appendChild(sizeCell);
      row.appendChild(mtimeCell);
      row.appendChild(actionsCell);
      filesTableBody.appendChild(row);
    });
  }

  function loadFilesView() {
    var id = currentId;
    if (!id) {
      filesNoServerEl.textContent = 'No server selected - choose one above.';
      filesNoServerEl.style.display = '';
      filesContentEl.classList.remove('active');
      return;
    }
    showFilesError('');
    showFilesBrowser();
    filesNoServerEl.style.display = 'none';
    filesContentEl.classList.add('active');
    renderFilesBreadcrumb();
    fetch('/api/servers/' + encodeURIComponent(id) + '/files?path=' + encodeURIComponent(filesCurrentPath))
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (result) {
        if (id !== currentId) return;
        if (!result.ok) {
          showFilesError(result.body.error || 'Failed to load this folder.');
          filesEntries = [];
          renderFilesTable();
          return;
        }
        filesEntries = result.body.entries;
        renderFilesTable();
      })
      .catch(function () { showFilesError('Request failed'); });
  }

  // -- Server Management ---------------------------------------------------------------
  var DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var smServerSelectEl = document.getElementById('servermanagement-server-select');
  var smNoServerEl = document.getElementById('servermanagement-no-server');
  var smContentEl = document.getElementById('servermanagement-content');
  var smErrorEl = document.getElementById('servermanagement-error');
  var smStartOnLaunch = document.getElementById('sm-startonlaunch');
  var smCrashWatch = document.getElementById('sm-crashwatch');
  var smZombieDetection = document.getElementById('sm-zombiedetection');
  var smZombieTimeout = document.getElementById('sm-zombietimeout');
  var smZombieAutoRestart = document.getElementById('sm-zombieautorestart');
  var smArchiveSize = document.getElementById('sm-archivesize');
  var smRestartEnabled = document.getElementById('sm-restart-enabled');
  var smRestartTime = document.getElementById('sm-restart-time');
  var smRestartDaysEl = document.getElementById('sm-restart-days');
  var smRestartUpdateAfter = document.getElementById('sm-restart-updateafter');
  var smRestartStartAfter = document.getElementById('sm-restart-startafter');
  var smDinoWipeEnabled = document.getElementById('sm-dinowipe-enabled');
  var smDinoWipeTime = document.getElementById('sm-dinowipe-time');
  var smDinoWipeDaysEl = document.getElementById('sm-dinowipe-days');
  var smRestartCountdownEl = document.getElementById('sm-restart-countdown');
  var smDinoWipeCountdownEl = document.getElementById('sm-dinowipe-countdown');
  var smProfile = null;

  // Ported from shared/scheduleTime.ts - the client script here is plain JS with no module
  // imports, so this stays a hand-kept copy rather than sharing the source file; the tests
  // for the real one (tests/scheduleTime.test.ts) are the source of truth for the math.
  // NOTE: this whole client script is itself the *value* of a JS template literal
  // (DASHBOARD_HTML, back in the outer main-process source) - an unescaped backslash-d,
  // backslash-w, backslash-s etc. here gets its backslash silently stripped by THAT outer
  // template literal's own string parsing before this text ever reaches the browser (a
  // template literal containing just backslash-d evaluates to the plain string "d" in JS),
  // so every backslash in a regex below must be doubled to survive that one extra layer of
  // parsing intact.
  function parseScheduleTime(time) {
    var match = /^([01]\\d|2[0-3]):([0-5]\\d)$/.exec(time || '');
    if (!match) return null;
    return { hour: Number(match[1]), minute: Number(match[2]) };
  }

  function computeNextOccurrence(now, time, days) {
    var parsed = parseScheduleTime(time);
    if (!parsed || !days || days.length === 0) return null;
    for (var offset = 0; offset <= 7; offset++) {
      var candidate = new Date(now);
      candidate.setDate(now.getDate() + offset);
      candidate.setHours(parsed.hour, parsed.minute, 0, 0);
      if (candidate <= now) continue;
      if (days.indexOf(candidate.getDay()) !== -1) return candidate;
    }
    return null;
  }

  function formatCountdown(ms) {
    var clamped = Math.max(0, ms);
    var totalSeconds = Math.floor(clamped / 1000);
    var seconds = totalSeconds % 60;
    var totalMinutes = Math.floor(totalSeconds / 60);
    var minutes = totalMinutes % 60;
    var totalHours = Math.floor(totalMinutes / 60);
    var hours = totalHours % 24;
    var days = Math.floor(totalHours / 24);
    function pad(n) { return String(n).padStart(2, '0'); }
    return pad(days) + ':' + pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
  }

  function updateSmCountdowns() {
    if (!smProfile) return;
    var now = new Date();
    var restartNext = smProfile.scheduledRestartEnabled
      ? computeNextOccurrence(now, smProfile.scheduledRestartTime, smProfile.scheduledRestartDays)
      : null;
    smRestartCountdownEl.textContent = 'Next shutdown in: ' + (restartNext ? formatCountdown(restartNext.getTime() - now.getTime()) : '--:--:--:--');
    var dinoWipeNext = smProfile.scheduledDinoWipeEnabled
      ? computeNextOccurrence(now, smProfile.scheduledDinoWipeTime, smProfile.scheduledDinoWipeDays)
      : null;
    smDinoWipeCountdownEl.textContent = 'Next dinowipe in: ' + (dinoWipeNext ? formatCountdown(dinoWipeNext.getTime() - now.getTime()) : '--:--:--:--');
  }

  setInterval(function () {
    if (activeView === 'servermanagement') updateSmCountdowns();
  }, 1000);

  function buildDayCheckboxes(container, days, onChange) {
    container.innerHTML = '';
    DAY_LABELS.forEach(function (label, index) {
      var wrapper = document.createElement('label');
      wrapper.className = 'checkbox';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = days.indexOf(index) !== -1;
      input.addEventListener('change', function () { onChange(index, input.checked); });
      wrapper.appendChild(input);
      wrapper.appendChild(document.createTextNode(label));
      container.appendChild(wrapper);
    });
  }

  function showSmError(message) {
    smErrorEl.textContent = message || '';
    smErrorEl.style.display = message ? '' : 'none';
  }

  function saveSmField(field, value) {
    if (!currentId || !smProfile) return;
    var id = currentId;
    var body = {};
    body[field] = value;
    fetch('/api/servers/' + encodeURIComponent(id) + '/servermanagement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showSmError(result.error || 'Save failed'); return; }
        if (id !== currentId) return;
        smProfile = result.profile;
        renderServerManagementForm();
      })
      .catch(function () { showSmError('Request failed'); });
  }

  function renderServerManagementForm() {
    var p = smProfile;
    smStartOnLaunch.checked = !!p.startOnManagerLaunch;
    smCrashWatch.checked = !!p.crashWatchEnabled;
    smZombieDetection.checked = !!p.zombieDetectionEnabled;
    smZombieTimeout.value = p.zombieDetectionTimeoutMinutes;
    smZombieTimeout.disabled = !p.zombieDetectionEnabled;
    smZombieAutoRestart.checked = !!p.zombieDetectionAutoRestart;
    smZombieAutoRestart.disabled = !p.zombieDetectionEnabled;
    smArchiveSize.value = p.clusterLogArchiveMaxSizeMB;
    smRestartEnabled.checked = !!p.scheduledRestartEnabled;
    smRestartTime.value = p.scheduledRestartTime || '00:00';
    smRestartTime.disabled = !p.scheduledRestartEnabled;
    smRestartUpdateAfter.checked = !!p.scheduledRestartUpdateAfter;
    smRestartUpdateAfter.disabled = !p.scheduledRestartEnabled;
    smRestartStartAfter.checked = !!p.scheduledRestartStartAfter;
    smRestartStartAfter.disabled = !p.scheduledRestartEnabled;
    buildDayCheckboxes(smRestartDaysEl, p.scheduledRestartDays || [], function (day, checked) {
      var days = (p.scheduledRestartDays || []).slice();
      var idx = days.indexOf(day);
      if (checked && idx === -1) days.push(day);
      if (!checked && idx !== -1) days.splice(idx, 1);
      days.sort(function (a, b) { return a - b; });
      saveSmField('scheduledRestartDays', days);
    });
    smDinoWipeEnabled.checked = !!p.scheduledDinoWipeEnabled;
    smDinoWipeTime.value = p.scheduledDinoWipeTime || '00:00';
    smDinoWipeTime.disabled = !p.scheduledDinoWipeEnabled;
    buildDayCheckboxes(smDinoWipeDaysEl, p.scheduledDinoWipeDays || [], function (day, checked) {
      var days = (p.scheduledDinoWipeDays || []).slice();
      var idx = days.indexOf(day);
      if (checked && idx === -1) days.push(day);
      if (!checked && idx !== -1) days.splice(idx, 1);
      days.sort(function (a, b) { return a - b; });
      saveSmField('scheduledDinoWipeDays', days);
    });
    updateSmCountdowns();
  }

  function loadServerManagementView() {
    var id = currentId;
    if (!id) {
      smNoServerEl.textContent = 'No server selected - choose one above.';
      smNoServerEl.style.display = '';
      smContentEl.classList.remove('active');
      return;
    }
    if (isMinecraftServer(id)) {
      smNoServerEl.textContent = MINECRAFT_VIEW_UNAVAILABLE_TEXT;
      smNoServerEl.style.display = '';
      smContentEl.classList.remove('active');
      return;
    }
    showSmError('');
    smNoServerEl.style.display = 'none';
    smContentEl.classList.add('active');
    fetch('/api/servers/' + encodeURIComponent(id) + '/servermanagement')
      .then(function (r) { return r.json(); })
      .then(function (profile) {
        if (id !== currentId) return;
        smProfile = profile;
        renderServerManagementForm();
      });
  }

  smStartOnLaunch.addEventListener('change', function () { saveSmField('startOnManagerLaunch', smStartOnLaunch.checked); });
  smCrashWatch.addEventListener('change', function () { saveSmField('crashWatchEnabled', smCrashWatch.checked); });
  smZombieDetection.addEventListener('change', function () { saveSmField('zombieDetectionEnabled', smZombieDetection.checked); });
  smZombieTimeout.addEventListener('change', function () { saveSmField('zombieDetectionTimeoutMinutes', Number(smZombieTimeout.value)); });
  smZombieAutoRestart.addEventListener('change', function () { saveSmField('zombieDetectionAutoRestart', smZombieAutoRestart.checked); });
  smArchiveSize.addEventListener('change', function () { saveSmField('clusterLogArchiveMaxSizeMB', Math.min(100, Math.max(1, Number(smArchiveSize.value)))); });
  smRestartEnabled.addEventListener('change', function () { saveSmField('scheduledRestartEnabled', smRestartEnabled.checked); });
  smRestartTime.addEventListener('change', function () { saveSmField('scheduledRestartTime', smRestartTime.value); });
  smRestartUpdateAfter.addEventListener('change', function () { saveSmField('scheduledRestartUpdateAfter', smRestartUpdateAfter.checked); });
  smRestartStartAfter.addEventListener('change', function () { saveSmField('scheduledRestartStartAfter', smRestartStartAfter.checked); });
  smDinoWipeEnabled.addEventListener('change', function () { saveSmField('scheduledDinoWipeEnabled', smDinoWipeEnabled.checked); });
  smDinoWipeTime.addEventListener('change', function () { saveSmField('scheduledDinoWipeTime', smDinoWipeTime.value); });

  // -- Settings ---------------------------------------------------------------------------
  var settingsServerSelectEl = document.getElementById('settings-server-select');
  var settingsNoServerEl = document.getElementById('settings-no-server');
  var settingsContentEl = document.getElementById('settings-content');
  var settingsStatusEl = document.getElementById('settings-status');
  var settingsErrorEl = document.getElementById('settings-error');
  var settingsName = document.getElementById('settings-name');
  var settingsInstallDir = document.getElementById('settings-installdir');
  var settingsGamePort = document.getElementById('settings-gameport');
  var settingsRconPort = document.getElementById('settings-rconport');
  var settingsPlatform = document.getElementById('settings-platform');
  var settingsMaxPlayers = document.getElementById('settings-maxplayers');
  var settingsMap = document.getElementById('settings-map');
  var settingsModdedMapId = document.getElementById('settings-moddedmapid');
  var settingsModdedMapEnabled = document.getElementById('settings-moddedmapenabled');
  var settingsBetaEnabled = document.getElementById('settings-betaenabled');
  var settingsBetaName = document.getElementById('settings-betaname');
  var settingsCulture = document.getElementById('settings-culture');
  var settingsBattlEye = document.getElementById('settings-battleye');
  var settingsTribeLog = document.getElementById('settings-tribelog');
  var settingsRespawnDinos = document.getElementById('settings-respawndinos');
  var settingsNoSound = document.getElementById('settings-nosound');
  var settingsMaxDinoLevel = document.getElementById('settings-maxdinolevel');
  var settingsGroup = document.getElementById('settings-group');
  var settingsExtraArgs = document.getElementById('settings-extraargs');
  var settingsClusterEnabled = document.getElementById('settings-clusterenabled');
  var settingsClusterId = document.getElementById('settings-clusterid');
  var settingsClusterDir = document.getElementById('settings-clusterdir');
  var settingsNoTransferFiltering = document.getElementById('settings-notransferfiltering');
  var settingsExternalIp = document.getElementById('settings-externalip');
  var settingsDiscordChatChannel = document.getElementById('settings-discordchatchannel');
  var settingsDiscordEventsChannel = document.getElementById('settings-discordeventschannel');
  var settingsProfile = null;
  var settingsMapsCache = { maps: [], customMaps: [] };

  function showSettingsError(message) {
    settingsErrorEl.textContent = message || '';
    settingsErrorEl.style.display = message ? '' : 'none';
  }

  function showSettingsStatus(message) {
    settingsStatusEl.textContent = message || '';
    settingsStatusEl.style.display = message ? '' : 'none';
    if (message) setTimeout(function () { showSettingsStatus(''); }, 2000);
  }

  function populateSettingsMapOptions() {
    var current = settingsProfile ? settingsProfile.map : '';
    settingsMap.innerHTML = '';
    var known = settingsMapsCache.maps.concat(settingsMapsCache.customMaps);
    if (current && !known.some(function (m) { return m.id === current; })) {
      var currentOpt = document.createElement('option');
      currentOpt.value = current;
      currentOpt.textContent = current;
      settingsMap.appendChild(currentOpt);
    }
    var officialGroup = document.createElement('optgroup');
    officialGroup.label = 'Official';
    settingsMapsCache.maps.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.displayName;
      officialGroup.appendChild(opt);
    });
    settingsMap.appendChild(officialGroup);
    var customGroup = document.createElement('optgroup');
    customGroup.label = 'Custom';
    settingsMapsCache.customMaps.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.displayName;
      customGroup.appendChild(opt);
    });
    settingsMap.appendChild(customGroup);
    settingsMap.value = current;
  }

  function renderSettingsForm() {
    var p = settingsProfile;
    settingsName.value = p.name;
    settingsInstallDir.value = p.installDir;
    settingsGamePort.value = p.gamePort;
    settingsRconPort.value = p.rconPort;
    settingsPlatform.value = p.serverPlatform;
    settingsMaxPlayers.value = p.maxPlayers;
    populateSettingsMapOptions();
    settingsModdedMapId.value = p.moddedMapId || '';
    settingsModdedMapId.disabled = !p.moddedMapEnabled;
    settingsModdedMapEnabled.checked = !!p.moddedMapEnabled;
    settingsBetaEnabled.checked = !!p.steamBetaEnabled;
    settingsBetaName.value = p.steamBetaName || '';
    settingsBetaName.disabled = !p.steamBetaEnabled;
    settingsCulture.value = p.cultureSettings;
    settingsBattlEye.checked = !!p.disableBattlEye;
    settingsTribeLog.checked = !!p.rconTribeLog;
    settingsRespawnDinos.checked = !!p.forceRespawnDinos;
    settingsNoSound.checked = !!p.noSound;
    settingsMaxDinoLevel.value = p.maxDinoLevel || '';
    settingsGroup.value = p.group;
    settingsExtraArgs.value = p.extraArgs;
    settingsClusterEnabled.checked = !!p.clusterEnabled;
    settingsClusterId.value = p.clusterId;
    settingsClusterId.disabled = !p.clusterEnabled;
    settingsClusterDir.value = p.clusterDirOverride;
    settingsClusterDir.disabled = !p.clusterEnabled;
    settingsNoTransferFiltering.checked = !!p.noTransferFromFiltering;
    settingsNoTransferFiltering.disabled = !p.clusterEnabled;
    settingsExternalIp.value = p.externalIp;
    settingsExternalIp.disabled = !p.clusterEnabled;
    settingsDiscordChatChannel.value = p.discordChatChannelId || '';
    settingsDiscordEventsChannel.value = p.discordEventsChannelId || '';
  }

  function saveSettingsField(field, value) {
    if (!currentId || !settingsProfile) return;
    var id = currentId;
    var body = {};
    body[field] = value;
    showSettingsError('');
    fetch('/api/servers/' + encodeURIComponent(id) + '/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) { showSettingsError(result.error || 'Save failed'); return; }
        if (id !== currentId) return;
        settingsProfile = result.profile;
        renderSettingsForm();
        showSettingsStatus('Saved');
      })
      .catch(function () { showSettingsError('Request failed'); });
  }

  function loadSettingsMaps() {
    fetch('/api/maps').then(function (r) { return r.json(); }).then(function (data) {
      settingsMapsCache = data;
      if (settingsProfile) populateSettingsMapOptions();
    });
  }

  function loadSettingsView() {
    var id = currentId;
    if (!id) {
      settingsNoServerEl.textContent = 'No server selected - choose one above.';
      settingsNoServerEl.style.display = '';
      settingsContentEl.classList.remove('active');
      return;
    }
    if (isMinecraftServer(id)) {
      settingsNoServerEl.textContent = MINECRAFT_VIEW_UNAVAILABLE_TEXT;
      settingsNoServerEl.style.display = '';
      settingsContentEl.classList.remove('active');
      return;
    }
    showSettingsError('');
    settingsNoServerEl.style.display = 'none';
    settingsContentEl.classList.add('active');
    loadSettingsMaps();
    fetch('/api/servers/' + encodeURIComponent(id) + '/profile')
      .then(function (r) { return r.json(); })
      .then(function (profile) {
        if (id !== currentId) return;
        settingsProfile = profile;
        renderSettingsForm();
      });
  }

  settingsName.addEventListener('change', function () { saveSettingsField('name', settingsName.value); });
  settingsInstallDir.addEventListener('change', function () { saveSettingsField('installDir', settingsInstallDir.value); });
  settingsGamePort.addEventListener('change', function () { saveSettingsField('gamePort', Number(settingsGamePort.value)); });
  settingsRconPort.addEventListener('change', function () { saveSettingsField('rconPort', Number(settingsRconPort.value)); });
  settingsPlatform.addEventListener('change', function () { saveSettingsField('serverPlatform', settingsPlatform.value); });
  settingsMaxPlayers.addEventListener('change', function () { saveSettingsField('maxPlayers', Number(settingsMaxPlayers.value)); });
  settingsMap.addEventListener('change', function () { saveSettingsField('map', settingsMap.value); });
  settingsModdedMapId.addEventListener('change', function () { saveSettingsField('moddedMapId', settingsModdedMapId.value); });
  settingsModdedMapEnabled.addEventListener('change', function () { saveSettingsField('moddedMapEnabled', settingsModdedMapEnabled.checked); });
  settingsBetaEnabled.addEventListener('change', function () { saveSettingsField('steamBetaEnabled', settingsBetaEnabled.checked); });
  settingsBetaName.addEventListener('change', function () { saveSettingsField('steamBetaName', settingsBetaName.value); });
  settingsCulture.addEventListener('change', function () { saveSettingsField('cultureSettings', settingsCulture.value); });
  settingsBattlEye.addEventListener('change', function () { saveSettingsField('disableBattlEye', settingsBattlEye.checked); });
  settingsTribeLog.addEventListener('change', function () { saveSettingsField('rconTribeLog', settingsTribeLog.checked); });
  settingsRespawnDinos.addEventListener('change', function () { saveSettingsField('forceRespawnDinos', settingsRespawnDinos.checked); });
  settingsNoSound.addEventListener('change', function () { saveSettingsField('noSound', settingsNoSound.checked); });
  settingsMaxDinoLevel.addEventListener('change', function () { saveSettingsField('maxDinoLevel', settingsMaxDinoLevel.value); });
  settingsGroup.addEventListener('change', function () { saveSettingsField('group', settingsGroup.value); });
  settingsExtraArgs.addEventListener('change', function () { saveSettingsField('extraArgs', settingsExtraArgs.value); });
  settingsClusterEnabled.addEventListener('change', function () { saveSettingsField('clusterEnabled', settingsClusterEnabled.checked); });
  settingsClusterId.addEventListener('change', function () { saveSettingsField('clusterId', settingsClusterId.value); });
  settingsClusterDir.addEventListener('change', function () { saveSettingsField('clusterDirOverride', settingsClusterDir.value); });
  settingsNoTransferFiltering.addEventListener('change', function () { saveSettingsField('noTransferFromFiltering', settingsNoTransferFiltering.checked); });
  settingsExternalIp.addEventListener('change', function () { saveSettingsField('externalIp', settingsExternalIp.value); });
  settingsDiscordChatChannel.addEventListener('change', function () { saveSettingsField('discordChatChannelId', settingsDiscordChatChannel.value); });
  settingsDiscordEventsChannel.addEventListener('change', function () { saveSettingsField('discordEventsChannelId', settingsDiscordEventsChannel.value); });

  var CONSOLE_AUTOSCROLL_KEY = 'ark-dashboard-console-autoscroll';
  var consoleAutoScroll = false;
  try { consoleAutoScroll = localStorage.getItem(CONSOLE_AUTOSCROLL_KEY) === '1'; } catch (err) { /* storage unavailable - not fatal */ }

  function loadLabelSettings() {
    fetch('/api/labelsettings').then(function (r) { return r.json(); }).then(function (settings) {
      filtersEl.innerHTML = '';
      var title = document.createElement('span');
      title.textContent = 'Show:';
      filtersEl.appendChild(title);
      Object.keys(settings).forEach(function (label) {
        var wrapper = document.createElement('label');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = settings[label];
        if (role && !canAdmin) cb.disabled = true;
        cb.addEventListener('change', function () {
          fetch('/api/labelsettings/' + encodeURIComponent(label), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: cb.checked })
          });
        });
        wrapper.appendChild(cb);
        wrapper.appendChild(document.createTextNode(label));
        filtersEl.appendChild(wrapper);
      });
      var autoScrollWrapper = document.createElement('label');
      var autoScrollCb = document.createElement('input');
      autoScrollCb.type = 'checkbox';
      autoScrollCb.checked = consoleAutoScroll;
      autoScrollCb.addEventListener('change', function () {
        consoleAutoScroll = autoScrollCb.checked;
        try { localStorage.setItem(CONSOLE_AUTOSCROLL_KEY, consoleAutoScroll ? '1' : '0'); } catch (err) { /* storage unavailable - not fatal */ }
      });
      autoScrollWrapper.appendChild(autoScrollCb);
      autoScrollWrapper.appendChild(document.createTextNode('Auto-scroll'));
      filtersEl.appendChild(autoScrollWrapper);
    });
  }

  function nowTs() {
    return new Date().toTimeString().slice(0, 8);
  }

  var PLAYER_OPEN = String.fromCharCode(1);
  var PLAYER_CLOSE = String.fromCharCode(2);

  // Renders event text as plain text, except for a JOIN/LEFT event's player name (marked
  // with invisible open/close characters by the parser), which gets its own colored span
  // so only that portion picks up the event's color - not the whole line.
  function renderEventText(container, text) {
    var openIdx = text.indexOf(PLAYER_OPEN);
    var closeIdx = text.indexOf(PLAYER_CLOSE);
    if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) {
      container.textContent = text;
      return;
    }
    if (openIdx > 0) container.appendChild(document.createTextNode(text.slice(0, openIdx)));
    var playerSpan = document.createElement('span');
    playerSpan.className = 'player';
    playerSpan.textContent = text.slice(openIdx + 1, closeIdx);
    container.appendChild(playerSpan);
    var after = text.slice(closeIdx + 1);
    if (after) container.appendChild(document.createTextNode(after));
  }

  function addEvent(ev) {
    var div = document.createElement('div');
    div.className = 'log-event log-event-' + ev.cls;
    var ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = ev.ts;
    var label = document.createElement('span'); label.className = 'label'; label.textContent = ev.label;
    var text = document.createElement('span'); text.className = 'text';
    renderEventText(text, ev.text);
    div.appendChild(ts); div.appendChild(label); div.appendChild(text);
    consoleEl.appendChild(div);
    if (consoleAutoScroll) consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  // Ticks the uptime line once a second between the 5s /api/servers polls, the same "live"
  // feel the desktop Manager's own Analytics tab uptime field has - rebuilding the whole
  // status panel every second just for this would be wasteful, so only this one span is
  // touched by the interval below.
  var uptimeValueEl = null;
  var uptimeStartedAt = null;
  var uptimeRunning = false;

  function formatUptime(ms) {
    var totalSeconds = Math.floor(ms / 1000);
    var seconds = totalSeconds % 60;
    var totalMinutes = Math.floor(totalSeconds / 60);
    var minutes = totalMinutes % 60;
    var totalHours = Math.floor(totalMinutes / 60);
    var hours = totalHours % 24;
    var days = Math.floor(totalHours / 24);
    return days + 'd ' + hours + 'h ' + minutes + 'm ' + seconds + 's';
  }

  setInterval(function () {
    if (uptimeValueEl && uptimeRunning && uptimeStartedAt) {
      uptimeValueEl.textContent = formatUptime(Date.now() - uptimeStartedAt);
    }
  }, 1000);

  function renderStatus(s) {
    statusEl.innerHTML = '';
    if (!s) {
      startBtn.disabled = true; stopBtn.disabled = true; restartBtn.disabled = true; stopUpdateRestartBtn.disabled = true;
      uptimeValueEl = null;
      return;
    }
    var lines = document.createElement('div');
    lines.className = 'status-lines';

    var stateLine = document.createElement('div');
    var stateStrong = document.createElement('strong');
    stateStrong.textContent = 'State: ';
    var stateBadge = document.createElement('span');
    stateBadge.className = 'cluster-card-state state-' + s.state;
    stateBadge.textContent = s.state;
    stateLine.appendChild(stateStrong);
    stateLine.appendChild(stateBadge);
    lines.appendChild(stateLine);

    var playerCount = s.players ? s.players.length : 0;
    var pairs = [
      ['Version', s.gameVersion || '-'],
      ['Players', String(playerCount) + (playerCount ? ': ' + s.players.join(', ') : '')],
      ['CPU', s.cpu != null ? s.cpu + '%' : '-'],
      ['RAM', s.memoryMB != null ? s.memoryMB + ' MB' : '-']
    ];
    pairs.forEach(function (pair) {
      var line = document.createElement('div');
      var strong = document.createElement('strong');
      strong.textContent = pair[0] + ': ';
      line.appendChild(strong);
      line.appendChild(document.createTextNode(pair[1]));
      lines.appendChild(line);
    });

    uptimeRunning = s.state === 'running';
    uptimeStartedAt = s.startedAt || null;
    var uptimeLine = document.createElement('div');
    var uptimeStrong = document.createElement('strong');
    uptimeStrong.textContent = 'Uptime: ';
    uptimeValueEl = document.createElement('span');
    uptimeValueEl.textContent = uptimeRunning && uptimeStartedAt ? formatUptime(Date.now() - uptimeStartedAt) : '-';
    uptimeLine.appendChild(uptimeStrong);
    uptimeLine.appendChild(uptimeValueEl);
    lines.appendChild(uptimeLine);

    statusEl.appendChild(lines);
    var isMinecraft = s.gameDisplayName === 'Minecraft';
    startBtn.disabled = s.state !== 'stopped';
    stopBtn.disabled = s.state !== 'running';
    restartBtn.disabled = isMinecraft || s.state !== 'running';
    restartBtn.style.display = isMinecraft ? 'none' : '';
    stopUpdateRestartBtn.disabled = isMinecraft || s.state === 'updating';
    stopUpdateRestartBtn.style.display = isMinecraft ? 'none' : '';
  }

  function postServerAction(action) {
    if (!currentId) return;
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/' + action, { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (!result.ok) {
          showToast('Error: ' + result.error);
        } else if (result.saved === false) {
          showToast('Stopped without a confirmed save - RCON may be unreachable');
        }
        loadServers();
      })
      .catch(function () { showToast('Request failed'); });
  }

  startBtn.addEventListener('click', function () { postServerAction('start'); });
  stopBtn.addEventListener('click', function () { postServerAction('stop'); });
  restartBtn.addEventListener('click', function () { postServerAction('restart'); });
  stopUpdateRestartBtn.addEventListener('click', function () {
    if (!confirm('Stop this server, update it via SteamCMD, then start it back up?')) return;
    postServerAction('stop-update-restart');
  });

  // Every per-server view carries its own server picker in its header (top-right, via the
  // .server-picker CSS class) - not just the Console view's original one - so switching
  // servers never requires going back to Cluster Dashboard first. All 8 always show the same
  // options and stay in sync with each other and with currentId.
  var SERVER_PICKERS = [
    select,
    analyticsServerSelectEl,
    settingsServerSelectEl,
    modsServerSelectEl,
    backupServerSelectEl,
    mapmanagementServerSelectEl,
    filesServerSelectEl,
    smServerSelectEl,
    updatelogServerSelectEl
  ];

  // Minecraft's own per-server tabs get their own picker list, populated from Minecraft
  // servers only (see populateServerPickers below) - kept separate from SERVER_PICKERS above
  // rather than mixed in, same "Minecraft and ARK servers never share one dropdown" separation
  // as the Dashboard-equivalent list views (renderDashboardCards/renderMcDashboardCards).
  // Both arrays still sync to the one shared currentId (syncServerPickers below) - a picker
  // simply shows no selection if currentId isn't one of its own options.
  var MC_SERVER_PICKERS = [
    mcStartSettingsServerSelectEl,
    mcServerSettingsServerSelectEl,
    mcModsServerSelectEl,
    mcPluginsServerSelectEl,
    mcBackupServerSelectEl,
    mcManagementServerSelectEl
  ];

  // servers arrives already ordered ungrouped-first-then-alphabetical-by-group (server-side
  // sortProfilesForDisplay), so a run of consecutive same-group entries can just be wrapped in
  // one optgroup as it's encountered - same idea as populateSettingsMapOptions' Official/Custom
  // optgroups, but grouped by each server's own Dashboard group instead of a fixed pair.
  function populatePickerGroup(pickers, servers) {
    pickers.forEach(function (picker) {
      picker.innerHTML = '';
      var openGroupName = null;
      var openGroupEl = null;
      servers.forEach(function (s) {
        var group = s.group || '';
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        if (!group) {
          openGroupName = null;
          openGroupEl = null;
          picker.appendChild(opt);
          return;
        }
        if (group !== openGroupName) {
          openGroupName = group;
          openGroupEl = document.createElement('optgroup');
          openGroupEl.label = group;
          picker.appendChild(openGroupEl);
        }
        openGroupEl.appendChild(opt);
      });
    });
  }

  function populateServerPickers(servers) {
    populatePickerGroup(SERVER_PICKERS, servers);
    populatePickerGroup(MC_SERVER_PICKERS, servers.filter(isMcServerEntry));
  }

  function syncServerPickers() {
    if (!currentId) return;
    SERVER_PICKERS.forEach(function (picker) { picker.value = currentId; });
    MC_SERVER_PICKERS.forEach(function (picker) { picker.value = currentId; });
  }

  SERVER_PICKERS.concat(MC_SERVER_PICKERS).forEach(function (picker) {
    picker.addEventListener('change', function () { selectServer(picker.value); });
  });

  function selectServer(id) {
    if (id === currentId) return;
    currentId = id;
    syncServerPickers();
    if (SERVER_SCOPED_VIEWS.indexOf(activeView) !== -1 || MC_SERVER_SCOPED_VIEWS.indexOf(activeView) !== -1) renderServerDetailNav();
    backupShowAll = false;
    filesCurrentPath = '';
    filesOpenTabs = [];
    filesActiveTabPath = null;
    filesActiveReadOnly = false;
    if (activeView === 'analytics') loadAnalyticsView();
    if (activeView === 'backup') loadBackupView();
    if (activeView === 'settings') loadSettingsView();
    if (activeView === 'mods') loadModsView();
    if (activeView === 'mapmanagement') loadMapManagementView();
    if (activeView === 'files') loadFilesView();
    if (activeView === 'servermanagement') loadServerManagementView();
    if (activeView === 'updatelog') loadUpdateLogView();
    if (activeView === 'mc-startsettings') loadMcStartSettingsView();
    if (activeView === 'mc-serversettings') loadMcServerSettingsView();
    if (activeView === 'mc-mods') loadMcModsView();
    if (activeView === 'mc-plugins') loadMcPluginsView();
    if (activeView === 'mc-backup') loadMcBackupView();
    if (activeView === 'mc-management') loadMcManagementView();
    consoleEl.innerHTML = '';
    if (es) { es.close(); es = null; }
    loadPlayers();
    if (!id) return;
    fetch('/api/servers/' + encodeURIComponent(id) + '/events')
      .then(function (r) { return r.json(); })
      .then(function (events) {
        events.forEach(addEvent);
        // Opening a server's console should land on the latest activity, not the oldest -
        // regardless of the Auto-scroll setting, which only governs whether it keeps
        // following new events from here on.
        consoleEl.scrollTop = consoleEl.scrollHeight;
      });
    var esUrl = '/api/servers/' + encodeURIComponent(id) + '/events/stream';
    if (accessToken) esUrl += '?token=' + encodeURIComponent(accessToken);
    es = new EventSource(esUrl);
    es.onmessage = function (msg) { addEvent(JSON.parse(msg.data)); };
    es.addEventListener('reset', function () { consoleEl.innerHTML = ''; });
  }

  function loadServers() {
    fetch('/api/servers').then(function (r) { return r.json(); }).then(function (servers) {
      latestServers = servers;
      checkClusterStateTransitions(servers);
      populateServerPickers(servers);
      // A server that was selected can vanish out from under us (profile deleted, or
      // filtered out by Hidden) - treat that the same as never having selected one. This
      // never auto-picks a replacement: Dashboard/Backup/the admin tabs only ever get a
      // server through an explicit click, never a silent default - so losing the selection
      // just falls back to Cluster Dashboard (which also hides the "Manage" shell again, via
      // applyActiveView's own serverScoped check).
      if (currentId && !servers.some(function (s) { return s.id === currentId; })) {
        currentId = null;
        if (SERVER_SCOPED_VIEWS.indexOf(activeView) !== -1) selectView('cluster');
        if (MC_SERVER_SCOPED_VIEWS.indexOf(activeView) !== -1) selectView('mcdashboard');
      }
      syncServerPickers();
      renderStatus(servers.find(function (s) { return s.id === currentId; }));
      renderAnalyticsStatus();
      renderClusterCards(servers.filter(isArkServerEntry));
      if (activeView === 'dashboard') renderDashboardCards(servers.filter(isArkServerEntry));
      if (activeView === 'mcdashboard') renderMcDashboardCards(servers.filter(isMcServerEntry));
      refreshClusterConsoleServers();
    });
  }

  rconForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var command = rconInput.value.trim();
    if (!command || !currentId) return;
    rconInput.value = '';
    addEvent({ label: 'RCON', cls: 'rcon-cmd', text: '> ' + command, ts: nowTs() });
    fetch('/api/servers/' + encodeURIComponent(currentId) + '/rcon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: command })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        addEvent({
          label: 'RCON',
          cls: result.ok ? 'rcon-resp' : 'rcon-error',
          text: result.ok ? (result.response || '(no response)') : ('Error: ' + result.error),
          ts: nowTs()
        });
      });
  });

  // Runs after every element/function this (and loadBackupView, if we reload straight
  // into the Backup view) touches has been declared above - calling it any earlier throws
  // on the not-yet-assigned backup-view elements and aborts the rest of this script,
  // including loadServers() below, leaving the page stuck on "no server selected" forever.
  // selectGameMode('ark') also applies the initial sidebar state (which .nav-group shows)
  // and, via selectView inside it, the initial activeView/applyActiveView() call - ARK is
  // the default landing mode, same as the desktop Manager's own GameSwitch defaulting to it.
  selectGameMode('ark');
  loadServers();
  loadLabelSettings();
  setInterval(loadServers, 5000);
  setInterval(loadPlayers, 5000);
}
</script>
</body>
</html>
`
