/**
 * PoC Node sidecar: a persistent child process the Rust shell spawns and talks to over
 * newline-delimited JSON on stdin/stdout, standing in for what a real migration's sidecar
 * would look like - the actual application logic (imported below from the real
 * src/main/store.ts, completely unmodified) runs exactly as it does today, in Node; only the
 * transport (Electron's ipcMain <-> this process's stdin/stdout) and the host (Electron's own
 * Node integration <-> a plain `node` child process spawned by Rust) are different.
 *
 * Two message shapes travel over stdout: a response (has "id", answers one specific request)
 * and a push event (has "event" instead, unsolicited - the Rust side forwards these to the
 * webview as ordinary Tauri events). profiles.list/profiles.save below are real calls into
 * store.ts; the 'profiles-changed' push wraps store.ts's own `profileEvents` EventEmitter,
 * unmodified - proving a live update (the kind every console/status view in the real app
 * needs) can reach the webview without the webview having asked for it first.
 *
 * log.record/'manager-log-entry' below proves the same push mechanism carries a SECOND,
 * independent event source too (lib/managerLog.ts's own `managerLogEvents`, a different real
 * subsystem backed by a JSONL file rather than electron-store) - multiplexed over the exact
 * same stdout pipe by event name, which is the shape a real migration needs for every one of
 * the real app's several independent live-update channels (console output, server status,
 * manager log, ...), not just one.
 *
 * console.* below is the actual headline case all of the above was standing in for: the real
 * per-server live console feed. watchLogFile (serverProcess.ts) and
 * parseLogChunkWithDate/createLogEventCaches/readLogBacklog (lib/logEvents.ts) are the exact,
 * unmodified functions the desktop Manager/Web Dashboard's own console tabs already use -
 * nothing here is a stand-in parser. The only genuinely new code is the small amount of glue
 * wiring watchLogFile's onChunk callback to a push-event line, plus a test-only method
 * (console.appendTestLine) to simulate a game server writing new output, since there's no real
 * ARK/Minecraft server process available to generate one in this sandbox.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import {
  listProfiles,
  saveProfile,
  deleteProfile,
  setProfileOrder,
  profileEvents,
  getRunningPids,
  getRunningStartedAt,
  recordPlayerBan,
  listWhitelistedPlayers,
  recordWhitelistedPlayer,
  removeWhitelistedPlayerProfile,
  listWatchedPlayers,
  addWatchedPlayer,
  removeWatchedPlayer,
  listPlayerActivity,
  listPlayerSessions,
  listPlayerBans,
  removePlayerBanProfile
} from '../../src/main/store'
import { sendRconCommand, parsePlayerListWithIds } from '../../src/main/lib/rcon'
import { logManagerEvent, newTaskId, managerLogEvents, readManagerLog } from '../../src/main/lib/managerLog'
import {
  watchLogFile,
  getLogFilePath,
  getStatus,
  serverEvents,
  getExecutablePath,
  adoptPersistedProcesses
} from '../../src/main/lib/serverProcess'
import { doStartServer, doStopServer, doRestartServer, doKillServer, doUpdateServer } from '../../src/main/lib/serverActions'
import { readLogBacklog, parseLogChunkWithDate, createLogEventCaches } from '../../src/main/lib/logEvents'
import { openProfilesFolder, openServerConfigFolder, openServerSavedArksFolder, openServerSaveGamesFolder } from '../../src/main/lib/systemFolders'
import { copyProfile, moveProfile } from '../../src/main/lib/profileCopyMove'
import { startDiscordBot, stopDiscordBot, getDiscordBotStatus } from '../../src/main/lib/discordBot'
import { applyWebDashboardSettings, stopWebDashboard, getWebDashboardStatus } from '../../src/main/lib/webDashboard'
import { getSystemStaticInfo, getNetworkUsage } from '../../src/main/lib/systemStats'
import { readStatsHistory, readClusterStatsHistoryForGroups } from '../../src/main/lib/statsHistory'
import { getBackupScheduleStatus, applyBackupSchedule, registerBackupScheduleWatcher } from '../../src/main/lib/schedule'
import { getInstalledBuildId, readUpdateLog, getUpdateLogPath, steamcmdUpdateEvents } from '../../src/main/lib/steamcmd'
import { listMapFolders, createMapFolder, deleteMapFolder, openMapFolder } from '../../src/main/lib/mapManagement'
import { getGroupConsoleBacklog, watchGroupConsole } from '../../src/main/lib/groupConsole'
import { installManagedSteamCmd, getManagedSteamCmdStatus } from '../../src/main/lib/steamcmdInstaller'
import { addFirewallRulesForSteamCmd } from '../../src/main/lib/firewall'
import { getGameVersion, getCachedGameVersion, setCachedGameVersion } from '../../src/main/lib/serverVersion'
import { getLatestBuildIdCache } from '../../src/main/lib/updateCheck'
import {
  createBackup,
  listBackups,
  deleteBackup,
  restoreBackup,
  openBackupFolder,
  backupEvents,
  getBackupLog
} from '../../src/main/lib/backup'
import { listPlayerBackupFolders, listPlayerBackups, openPlayerBackupFolder } from '../../src/main/lib/playerBackup'
import {
  getSettings,
  saveSettings,
  listModEvents,
  saveModEvent,
  deleteModEvent,
  listModEventHistory,
  getIniTemplateGeneric,
  saveIniTemplateGeneric,
  getIniTemplateOverride,
  saveIniTemplateOverride,
  deleteIniTemplateOverride
} from '../../src/main/store'
import { applyIniTemplate, applyIniTemplateToAll } from '../../src/main/lib/iniTemplates'
import { armModEvent, disarmModEvent, armAllModEvents } from '../../src/main/lib/modEvents'
import { listMaps } from '../../src/main/lib/maps'
import { listCustomMaps, addCustomMap, updateCustomMap, deleteCustomMap } from '../../src/main/lib/customMaps'
import { send, resolveRustResponse } from './rpcToRust'
import type { GameId } from '../../shared/games'
import type { AppSettings, IniTemplateContent, IniTemplateProfileOverride, ModEvent, ServerProfile } from '../../shared/types'

interface RpcRequest {
  id: number
  method: string
  params?: unknown
}

const methods: Record<string, (params: unknown) => unknown> = {
  'profiles.list': () => listProfiles(),
  // No schema validation here on purpose - store.ts itself does none either (TS types are
  // compile-time only), and this PoC is about proving the write path reaches the real
  // function and its real side effects (persisting to disk, emitting profileEvents), not
  // about adding input validation a real migration would still need to design properly.
  // Also calls the real applyBackupSchedule() right after saving, same as the real
  // ipc/profiles.ts handler does - added this round (AnalyticsTab needs the Backup Status
  // panel to reflect a schedule actually just turned on, not a stale pre-save one), after
  // backup.getScheduleStatus below first came back permanently inactive and tracing it
  // showed this exact gap: arming only happens on a profile save or a running-state
  // transition (see lib/schedule.ts's own comments), neither of which this PoC's
  // profiles.save touched until now.
  'profiles.save': (params) => {
    const profile = params as ServerProfile
    const profiles = saveProfile(profile)
    applyBackupSchedule(profile)
    return profiles
  },
  // Real, unmodified copyProfile()/moveProfile() from lib/profileCopyMove.ts - a write path
  // with a native dialog on the renderer side (ProfileManagementView.tsx's "Browse..." button,
  // see main.rs's dialog_select_directory) in front of it, unlike every read/write above. The
  // real ipc/profiles.ts handler also re-runs applyBackupSchedule/syncPlayerBackupWatch/
  // applyScheduledRestart/applyScheduledDinoWipe/applyScheduledRconCommands/
  // applyScheduledMaintenance on the result - deliberately left out here: those re-arm file
  // watchers and cron-like timers against the *new* install path, which this PoC has no way to
  // observe (no real server process, no real backup content) and isn't part of what this
  // increment is testing (whether copy/move + a native folder picker can round-trip through the
  // sidecar at all). A real migration still has to port that wiring.
  'profiles.copy': async (params) => {
    const { profileId, destInstallDir, newName } = params as {
      profileId: string
      destInstallDir: string
      newName: string
    }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    const copied = await copyProfile(profile, destInstallDir, newName)
    const profiles = saveProfile(copied)
    return { profile: copied, profiles }
  },
  'profiles.move': async (params) => {
    const { profileId, destInstallDir, newName } = params as {
      profileId: string
      destInstallDir: string
      newName: string
    }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    const moved = await moveProfile(profile, destInstallDir, newName)
    const profiles = saveProfile(moved)
    return { profile: moved, profiles }
  },
  // Real write into lib/managerLog.ts's own JSONL file, through the real logManagerEvent -
  // proves a second, differently-shaped real subsystem (file-backed, async persistence)
  // behaves the same way through this sidecar as the in-memory-then-electron-store one above.
  'log.record': async (params) => {
    const message = typeof params === 'string' ? params : 'Test entry from the Tauri PoC sidecar'
    // logManagerEvent resolves void - the RPC response still needs a concrete result value
    // (not undefined, which JSON.stringify would drop, leaving neither "result" nor "error"
    // in the line Rust reads) so { ok: true } stands in for "the write finished".
    await logManagerEvent(newTaskId('poc'), 'Tauri PoC', message, 'info')
    return { ok: true }
  },
  // Real, unmodified readManagerLog() - backs the real ManagerLogView.tsx's window.api.
  // managerLog.getLog() (see "A real React page" below), reading the exact same JSONL file
  // log.record/managerLogEvents already write to.
  'log.getAll': () => readManagerLog(),
  // Real, unmodified doStartServer()/doStopServer()/doRestartServer()/doKillServer()/
  // doUpdateServer() from lib/serverActions.ts - the actual orchestration layer every real
  // caller (the desktop IPC handlers in ipc/serverProcess.ts, and the web dashboard's own HTTP
  // API) goes through, not serverProcess.ts's own startServer/stopServer directly (an earlier
  // round of this PoC called those directly before this file existed in this PoC's scope -
  // serverActions.ts wraps them with the monitor (lib/monitor.ts: CPU/RAM/player-list polling
  // on a self-rescheduling timer), crash-watch cancellation (lib/crashWatch.ts), and a Manager
  // activity-log entry for every action - none of which is Electron-coupled either, so the
  // whole chain ports with zero changes). getExecutablePath resolves platform-specific
  // (def.executableLinux on this Linux sandbox, e.g.
  // "ShooterGame/Binaries/Linux/ArkAscendedServer" under the profile's installDir). No real
  // ARK/Minecraft dedicated server binary exists in this sandbox, so standalone testing points
  // a profile's installDir at a small long-running stand-in script placed at that exact
  // resolved path (same spirit as console.appendTestLine simulating a game server's log output
  // below) - proves the real spawn/PID-tracking/status/graceful-stop-then-force-kill round trip
  // without needing the real game server binary. stopServer's real shutdown sequence (RCON
  // SaveWorld -> DoExit -> grace period -> force kill) runs unmodified too; the stand-in script
  // never responds to RCON, so every real stop exercises the force-kill fallback path - see
  // README for what this does and doesn't confirm. doUpdateServer calls the real SteamCMD
  // updateServer(), which fails fast and honestly ("Set the SteamCMD path in Settings before
  // updating.") with no real SteamCMD installed in this sandbox - the same category of
  // honestly-gated path as the RCON-dependent player-management calls below.
  'server.start': (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return doStartServer(profile)
  },
  'server.stop': async (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return doStopServer(profile)
  },
  'server.restart': async (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return doRestartServer(profile)
  },
  'server.kill': (params) => {
    const { profileId } = params as { profileId: string }
    if (!listProfiles().some((p) => p.id === profileId)) throw new Error(`Unknown profile: ${profileId}`)
    return doKillServer(profileId)
  },
  'server.update': async (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    await doUpdateServer(profile)
    return { ok: true }
  },
  'server.status': (params) => getStatus((params as { profileId: string }).profileId),
  // Test-only: writes a small long-running shell script to the real, unmodified
  // getExecutablePath(profile)'s resolved path - standing in for a real ARK/Minecraft dedicated
  // server binary, since this sandbox has none (same role as console.appendTestLine above, for
  // the process-spawn side rather than the log-output side). Exits on SIGTERM, same as a real
  // game server - see README for what this found about stopServer()'s shutdown sequence when a
  // first version of this script ignored it instead. `withStartupMarker` additionally has the
  // script write the real STARTUP_COMPLETE_MARKER string (copied here - serverProcess.ts keeps
  // it as a private const, not worth exporting just for this test fixture) to the real,
  // unmodified getLogFilePath(installDir) a few seconds after launch, the same way a real ARK
  // server's own engine log announces it has actually finished loading - proving
  // watchLogFileForMarker()'s real 'starting' -> 'running' transition, not just the untested
  // code path every earlier round's silent fake script left unreachable.
  'server.installTestExecutable': (params) => {
    const { profileId, withStartupMarker } = params as { profileId: string; withStartupMarker?: boolean }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    const exePath = getExecutablePath(profile)
    fs.mkdirSync(path.dirname(exePath), { recursive: true })
    const markerLine = 'Server has completed startup and is now advertising for join'
    const logPath = getLogFilePath(profile.installDir)
    // Creates the (empty) log file immediately, before watchLogFile's first poll tick, then
    // appends the marker several seconds later on a separate tick - matching a real ARK
    // server's own shape (the log exists and is growing well before the startup-complete line
    // shows up in it). Appending the marker to a log file watchLogFile hasn't polled even once
    // yet would instead get silently absorbed into its first "establish a size baseline" tick
    // (see watchLogFile's own comment on that) and never reported as a chunk at all - a real
    // ordering requirement found by hitting exactly that race first.
    const markerWrite = withStartupMarker
      ? `\nmkdir -p "$(dirname "${logPath}")"\n: > "${logPath}"\n(sleep 3; printf '%s\\n' "[STAGING][  0]${markerLine}" >> "${logPath}") &\n`
      : ''
    fs.writeFileSync(exePath, `#!/bin/sh\ntrap 'exit 0' TERM${markerWrite}\nwhile true; do sleep 1; done\n`)
    fs.chmodSync(exePath, 0o755)
    return { ok: true, exePath }
  },
  // Real, unmodified player-management subsystem - a different real domain from everything
  // above (RCON-driven live roster + kick, plus the Manager's own persisted ban/whitelist
  // records), backing the real PlayerRosterPanel.tsx - see "A third real page" below. Each
  // method's body mirrors the real ipc/playerRoster.ts/playerBans.ts/playerWhitelist.ts
  // handlers exactly (same real functions, same order, same success/failure shape) rather than
  // just calling the underlying lib functions some other way.
  'playerRoster.list': async (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    const result = await sendRconCommand(profile, 'ListPlayers')
    return result.ok && result.response ? parsePlayerListWithIds(result.response) : []
  },
  'playerRoster.kick': async (params) => {
    const { profileId, playerId } = params as { profileId: string; playerId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    const result = await sendRconCommand(profile, `KickPlayer ${playerId}`)
    if (!result.ok) throw new Error(result.error ?? 'KickPlayer failed')
    return { ok: true }
  },
  // playerBans.ban only writes the real local ban record (recordPlayerBan) once the real RCON
  // BanPlayer call itself succeeds - same real gate the desktop/web dashboard both go through,
  // not a shortcut that writes the record unconditionally.
  'playerBans.ban': async (params) => {
    const { profileId, playerId, playerName, reason } = params as {
      profileId: string
      playerId: string
      playerName: string
      reason: string
    }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    const result = await sendRconCommand(profile, `BanPlayer ${playerId}`)
    if (!result.ok) throw new Error(result.error ?? 'BanPlayer failed')
    return recordPlayerBan(playerId, playerName, reason, profileId)
  },
  // Tracking-only, unlike playerBans.ban - no RCON call at all, straight to the real
  // electron-store-backed write, same as playerWhitelist.ts's own doc comment says.
  'playerWhitelist.add': (params) => {
    const { profileId, playerId, playerName } = params as { profileId: string; playerId: string; playerName: string }
    return recordWhitelistedPlayer(playerId, playerName, profileId)
  },
  'playerWhitelist.list': () => listWhitelistedPlayers(),
  'playerWhitelist.remove': (params) => {
    const { profileId, playerId } = params as { profileId: string; playerId: string }
    return removeWhitelistedPlayerProfile(playerId, profileId)
  },
  // Real backlog read straight off a ShooterGame.log-shaped file - same function the desktop
  // Console tab and Web Dashboard both call on open/reconnect.
  'console.backlog': (params) => readLogBacklog((params as { installDir: string }).installDir),
  // Starts (or restarts) the real watchLogFile poller against installDir's log file, parsing
  // each newly-written chunk with the real parser and pushing one 'console-line' event per
  // parsed line - this is the actual live-console-feed shape, not a simplified stand-in.
  'console.watch': (params) => {
    const { installDir } = params as { installDir: string }
    const logPath = getLogFilePath(installDir)
    // watchLogFile's first poll tick only ever establishes a size baseline, never reports
    // anything (by design - it must not treat a server's pre-existing log as "new" on every
    // Manager restart). If the file doesn't exist yet, that baseline tick is deferred until it
    // does, so touching it into existence here (as 0 bytes, if missing) means the very next
    // append is the first thing actually reported, rather than silently eaten by whichever
    // tick happens to be the first one to see the file at all.
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '')
    stopConsoleWatch?.()
    const caches = createLogEventCaches()
    stopConsoleWatch = watchLogFile(installDir, (chunk) => {
      for (const event of parseLogChunkWithDate(chunk, caches)) {
        send({ event: 'console-line', data: event })
      }
    })
    return { ok: true, watching: logPath }
  },
  // Test-only: simulates a game server appending output to its own log file, since this
  // sandbox has no real ARK/Minecraft process to generate one. Formats a line exactly as
  // parseLogLine's own LOG_LINE_RE expects so the real parser (not a stand-in) accepts it.
  'console.appendTestLine': (params) => {
    const { installDir, message } = params as { installDir: string; message: string }
    const logPath = getLogFilePath(installDir)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    const now = new Date()
    const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
    const stamp = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}-${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}:${pad(now.getMilliseconds(), 3)}`
    fs.appendFileSync(logPath, `[${stamp}][  0]${message}\n`)
    return { ok: true }
  },
  // Real, unmodified lib/systemFolders.ts function - the whole point of the `shell.openPath`
  // round trip this proves (see electronShim.ts/rpcToRust.ts), not a synthetic test method.
  // Every real call site in the app follows this exact shape: call a systemFolders.ts
  // function, let it call `shell.openPath` itself, surface whatever it throws as the RPC
  // error - same as every other real function this sidecar calls into.
  'folders.openProfiles': async () => {
    await openProfilesFolder()
    return { ok: true }
  },
  // Real, unmodified lib/discordBot.ts - proving the bot subsystem, not just the main-process
  // logic this PoC has otherwise covered. startDiscordBot() itself calls Node's `fork()` with
  // ELECTRON_RUN_AS_NODE=1 (meaningless, harmless outside Electron - fork() already runs
  // process.execPath, i.e. this sidecar's own plain Node/SEA binary, with or without that
  // var) to spawn sidecar/bot/index.js, the real src/bot/index.ts bundled unmodified by
  // build-bot.mjs - no Electron coupling in src/bot/ at all (confirmed by grepping for "from
  // 'electron'": zero hits). Flips discordBotEnabled/discordBotToken on through the real
  // saveSettings()/getSettings() round trip first, exactly the shape the real Settings UI
  // would send, rather than constructing a fake settings object by hand.
  'bot.start': async () => {
    const settings = saveSettings({
      ...getSettings(),
      discordBotEnabled: true,
      discordBotToken: 'poc.fake.token.not.real'
    })
    await startDiscordBot(settings)
    return getDiscordBotStatus()
  },
  'bot.stop': () => {
    stopDiscordBot()
    return { ok: true }
  },
  'bot.status': () => getDiscordBotStatus(),
  // Real, unmodified lib/webDashboard.ts - the third real subsystem from the original size
  // estimate. Unlike the bot, this one was never a separate process even in the real app - it's
  // an in-process http.Server/https.Server started directly by the main process - so there's no
  // fork()/SEA interaction to worry about here (see "The Discord bot subsystem" for why that
  // mattered there). applyWebDashboardSettings/getWebDashboardStatus called exactly as the real
  // Settings UI would, through the same real saveSettings()/getSettings() round trip.
  'dashboard.start': async (params) => {
    const { port } = params as { port: number }
    const settings = saveSettings({
      ...getSettings(),
      webDashboardEnabled: true,
      webDashboardPort: port,
      webDashboardHost: '127.0.0.1',
      webDashboardAuthEnabled: false
    })
    applyWebDashboardSettings(settings)
    return getWebDashboardStatus()
  },
  'dashboard.stop': () => {
    stopWebDashboard()
    return { ok: true }
  },
  'dashboard.status': () => getWebDashboardStatus(),
  // Real, unmodified store.ts settings accessors - already used internally above (bot.start/
  // dashboard.start) but not exposed to the frontend directly until Dashboard.tsx needed them
  // (it reads/writes registeredGroups/groupOrder/collapsedGroups through these).
  'settings.get': () => getSettings(),
  'settings.save': (params) => saveSettings(params as AppSettings),
  // Real, unmodified deleteProfile()/setProfileOrder() from store.ts - the two profiles.*
  // writes profiles.save/.copy/.move above didn't need (delete, and the dashboard's own
  // drag-to-reorder).
  'profiles.delete': (params) => deleteProfile((params as { profileId: string }).profileId),
  'profiles.reorder': (params) => setProfileOrder((params as { orderedIds: string[] }).orderedIds),
  // Real, unmodified lib/systemStats.ts - a fourth subsystem from the original "what's
  // Electron-coupled" survey (see "Where the real Electron coupling lives" below), pulled in
  // by HardwareStatsBar.tsx. getSystemStaticInfo shells out via the `systeminformation`
  // package (CPU model/core count, total RAM, link speed); getNetworkUsage samples
  // `os.networkInterfaces()` byte counters twice a second apart. Neither touches Electron.
  'systemStats.getStaticInfo': async () => getSystemStaticInfo(),
  'systemStats.getNetworkUsage': async () => getNetworkUsage(),
  // Real, unmodified subsystems AnalyticsTab.tsx pulls in - five more real files this PoC
  // hadn't touched, none of them Electron-coupled.
  // readStatsHistory reads the real JSONL file monitor.ts's recordStatSample (see "A fifth
  // real page" above) already writes to every 5s while a server's statsEnabled and running -
  // this is the read side of the same real subsystem, not a new one.
  'statsHistory.get': async (params) => {
    const { profileId, sinceMs, maxPoints } = params as { profileId: string; sinceMs: number | null; maxPoints?: number }
    return readStatsHistory(profileId, sinceMs, maxPoints)
  },
  // getBackupScheduleStatus reads an in-memory armed-timer map that lib/schedule.ts's own
  // `serverEvents.on('status', ...)` (registered as a side effect of importing the module
  // above, same pattern as every other push-driven subsystem here) keeps in sync with the
  // real server lifecycle - no explicit wiring needed beyond the import itself.
  'backup.getScheduleStatus': (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return getBackupScheduleStatus(profile)
  },
  // Mirrors the real ipc/serverProcess.ts handlers exactly (cache-then-live-read for game
  // version, a direct manifest read for the installed build id - see that file's own comment
  // on why the cache-check-first order matters for a page that polls this every few seconds).
  'server.getInstalledBuildId': (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return getInstalledBuildId(profile.installDir, profile.game)
  },
  'server.getGameVersion': async (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    const cached = getCachedGameVersion(profileId)
    if (cached) return cached
    const version = await getGameVersion(profile.installDir)
    if (version) setCachedGameVersion(profileId, version)
    return version
  },
  // Pure cache reads (lib/updateCheck.ts) - real, but nothing in this PoC ever arms the real
  // background SteamCMD poller that would actually populate them, so these honestly return
  // { buildId: null, checkedAt: null, error: null } rather than a stubbed-in fake value.
  'steamcmd.getLatestBuildId': (params) => {
    const { game, branch } = params as { game: GameId; branch?: string }
    return getLatestBuildIdCache(game, branch)
  },
  // Real, unmodified lib/systemFolders.ts functions - the same shell.openPath round trip
  // openProfilesFolder above already proved, just three more real call sites of it.
  'system.openServerConfigFolder': async (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    await openServerConfigFolder(profile)
    return { ok: true }
  },
  'system.openServerSavedArksFolder': async (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    await openServerSavedArksFolder(profile)
    return { ok: true }
  },
  'system.openServerSaveGamesFolder': async (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    await openServerSaveGamesFolder(profile)
    return { ok: true }
  },
  // A seventh real page: BackupsTab.tsx (plus the two child components it mounts itself,
  // PlayerBackupsSection.tsx and BackupLogPanel.tsx - neither has its own RPC method, they
  // call window.api.backup.*/playerBackup.* same as BackupsTab does). Real, unmodified
  // lib/backup.ts/lib/playerBackup.ts - a write path heavier than anything this PoC has
  // proven yet: createBackup actually sends a real RCON SaveWorld (when the server is
  // running), waits a real 40s settle, then zips real files off disk with `archiver`;
  // restoreBackup extracts a real zip with `adm-zip` straight over SavedArks. Mirrors the
  // real ipc/backup.ts/ipc/playerBackup.ts handlers' exact bodies (requireProfile-then-call
  // shape), not a shortcut that skips the profile lookup.
  'backup.create': (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return createBackup(profile)
  },
  'backup.list': (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return listBackups(profile)
  },
  // deleteBackup/restoreBackup both resolve void, same gap log.record's own comment already
  // flags: a response line with neither "result" nor "error" (JSON.stringify drops an
  // undefined result entirely) reads on the Rust side as "sidecar returned neither a result
  // nor an error" - an error, even though the call actually succeeded. Found by actually
  // driving this RPC method end to end (a real restore really did put the deleted file back
  // on disk) and only then noticing the response line itself was malformed - { ok: true }
  // closes the same gap every other void-returning method here already closes.
  'backup.delete': (params) => {
    deleteBackup((params as { filePath: string }).filePath)
    return { ok: true }
  },
  'backup.restore': (params) => {
    const { profileId, filePath } = params as { profileId: string; filePath: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    restoreBackup(profile, filePath)
    return { ok: true }
  },
  'backup.openFolder': async (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    await openBackupFolder(profile)
    return { ok: true }
  },
  'backup.getLog': (params) => getBackupLog((params as { profileId: string }).profileId),
  'playerBackup.listFolders': (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return listPlayerBackupFolders(profile)
  },
  'playerBackup.list': (params) => {
    const { profileId, folderKey } = params as { profileId: string; folderKey: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return listPlayerBackups(profile, folderKey)
  },
  'playerBackup.openFolder': async (params) => {
    const { profileId, folderKey } = params as { profileId: string; folderKey: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    await openPlayerBackupFolder(profile, folderKey)
    return { ok: true }
  },
  // An eighth real page: UpdateLogTab.tsx. Real, unmodified readUpdateLog() - the read side of
  // lib/steamcmd.ts's own update-run log file, written by the real updateServer() this PoC's
  // server.update already calls (doUpdateServer -> serverActions.ts -> updateServer), which
  // fails fast with "Set the SteamCMD path in Settings before updating." before ever creating
  // that log file, since no real SteamCMD is installed in this sandbox - same honestly-gated
  // category as UpdateCheckPanel's own permanently-"Checking..." state. readUpdateLog correctly
  // returns null in that case, same as the real app would on a profile that's never been
  // updated.
  'steamcmd.getUpdateLog': (params) => readUpdateLog((params as { profileId: string }).profileId),
  // Test-only: writes directly to the real getUpdateLogPath(profileId) file and emits the real
  // steamcmdUpdateEvents 'log' event - standing in for a real updateServer() run (which this
  // sandbox can't produce without a real SteamCMD install), the same honest-simulation role
  // console.appendTestLine/server.installTestExecutable already play elsewhere in this PoC.
  // Proves the live-refresh push path (UpdateLogTab's own onUpdateLogChanged subscription)
  // without needing a real SteamCMD run to drive it.
  'steamcmd.appendTestUpdateLogLine': (params) => {
    const { profileId, line } = params as { profileId: string; line: string }
    const logPath = getUpdateLogPath(profileId)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `${line}\n`)
    steamcmdUpdateEvents.emit('log', profileId)
    return { ok: true }
  },
  // A ninth real page: MapManagementTab.tsx. Real, unmodified lib/mapManagement.ts - a small,
  // no-push-event subsystem (no live updates to prove here, unlike the last two rounds), picked
  // specifically to not need a new push source for once. create/delete both mirror the same
  // void-return shape backup.delete/backup.restore already taught this PoC to watch for -
  // wrapped in a concrete { ok: true } from the start this time, not found the hard way again.
  'mapManagement.list': (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return listMapFolders(profile)
  },
  'mapManagement.create': (params) => {
    const { profileId, folderName, fileName } = params as { profileId: string; folderName: string; fileName: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    createMapFolder(profile, folderName, fileName)
    return { ok: true }
  },
  'mapManagement.delete': (params) => {
    const { profileId, folderName } = params as { profileId: string; folderName: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    deleteMapFolder(profile, folderName)
    return { ok: true }
  },
  'mapManagement.openFolder': async (params) => {
    const { profileId, folderName } = params as { profileId: string; folderName: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    await openMapFolder(profile, folderName)
    return { ok: true }
  },
  // A tenth real page: ServerManagementTab.tsx - mostly a big settings form (every field
  // persists through the real, already-proven profiles.save), but its "Run now" button on a
  // scheduled RCON command entry needs one genuinely new real call: lib/groupConsole.ts's own
  // IPC handler (ipc/groupConsole.ts's groupConsoleRconSend) turns out to be a thin wrapper
  // around the exact same real sendRconCommand() this sidecar already imported for
  // playerRoster.kick/playerBans.ban - no new import needed, just one more real call site of a
  // function this PoC already proved.
  'groupConsole.rconSend': async (params) => {
    const { profileId, command } = params as { profileId: string; command: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return sendRconCommand(profile, command)
  },
  // An eleventh real page: WatchedPlayersSection.tsx - the watchlist for the "player joined"
  // Discord alert, a different real store.ts-backed subsystem from playerWhitelist (tracking
  // who to alert on, not who's allowed to connect). Real, unmodified listWatchedPlayers/
  // addWatchedPlayer/removeWatchedPlayer, same shape as every other store.ts CRUD here.
  'watchedPlayers.list': () => listWatchedPlayers(),
  'watchedPlayers.add': (params) => {
    const { value, label } = params as { value: string; label: string }
    return addWatchedPlayer({ id: randomUUID(), value, label, createdAt: Date.now() })
  },
  'watchedPlayers.remove': (params) => removeWatchedPlayer((params as { id: string }).id),
  // A twelfth real page: PlayerActivityPanel.tsx - read-only aggregated playtime, a third
  // distinct real store.ts-backed player subsystem (after bans/whitelist and watched-players).
  // Real, unmodified listPlayerActivity/listPlayerSessions - nothing to write here at all.
  'playerActivity.list': () => listPlayerActivity(),
  'playerActivity.sessions': () => listPlayerSessions(),
  // A fourteenth real page: PlayerBansPanel.tsx - the centralized cross-server view of
  // playerBans.ban (already proven in "A third real page"). list/unban are the two methods
  // that round never needed: listPlayerBans is a plain store.ts read; unban mirrors ban's own
  // real RCON-gate-then-write shape exactly (a real UnbanPlayer RCON call must succeed before
  // removePlayerBanProfile ever runs).
  'playerBans.list': () => listPlayerBans(),
  'playerBans.unban': async (params) => {
    const { profileId, playerId } = params as { profileId: string; playerId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    const result = await sendRconCommand(profile, `UnbanPlayer ${playerId}`)
    if (!result.ok) throw new Error(result.error ?? 'UnbanPlayer failed')
    return removePlayerBanProfile(playerId, profileId)
  },
  // A fifteenth real page: ClusterDataView.tsx ("Cluster Dashboard" - merged per-group
  // CPU/RAM/player totals + a history chart, same real ServerStatsChart.tsx "A fifth real
  // page" already proved). The one new real call: readClusterStatsHistoryForGroups, the
  // read-every-group-at-once sibling of readStatsHistory ("A sixth real page") - real,
  // unmodified, reads the same real stats-history.jsonl file once and sums per group.
  'statsHistory.getForGroups': async (params) => {
    const { groupProfileIds, sinceMs, maxPoints } = params as {
      groupProfileIds: Record<string, string[]>
      sinceMs: number | null
      maxPoints?: number
    }
    return readClusterStatsHistoryForGroups(groupProfileIds, sinceMs, maxPoints)
  },
  // A sixteenth real page: SteamCmdView.tsx. getManagedSteamCmdStatus is a plain real fs
  // check; installManagedSteamCmd is the first real OUTBOUND NETWORK call this whole PoC
  // makes - a real `fetch()` straight to Valve's own CDN, real bytes written to disk, then
  // really extracted (tar.gz on Linux, same real code path the Windows build uses for its own
  // .zip). addFirewallRulesForSteamCmd is real too, and real-honestly platform-gated: it
  // rejects immediately on anything but win32, the exact branch this Linux sandbox exercises
  // - no PowerShell/UAC path reachable here, same category as every other Windows-only gap
  // this PoC has already documented. The real ipc/steamcmdInstall.ts handler also calls
  // forceRefocus(mainWindow) in a finally block around the firewall call (same real
  // Electron/Windows focus-loss workaround confirmAction() needs) - no window handle exists
  // on the sidecar side of this architecture, so that part is handled on the Rust side
  // instead (see main.rs's steamcmd_add_firewall_rule), not dropped.
  'steamcmd.managedStatus': () => getManagedSteamCmdStatus(),
  'steamcmd.install': async () => {
    const exePath = await installManagedSteamCmd()
    saveSettings({ ...getSettings(), steamCmdPath: exePath })
    return exePath
  },
  'steamcmd.addFirewallRule': (params) => addFirewallRulesForSteamCmd((params as { steamCmdPath: string }).steamCmdPath),
  // A seventeenth real page: GroupConsoleView.tsx - merges every profile in a dashboard group's
  // live log feed into one chronological view. Real, unmodified getGroupConsoleBacklog()/
  // watchGroupConsole() from lib/groupConsole.ts, which themselves just orchestrate the exact
  // same watchLogFile/parseLogChunkWithDate/readLogBacklog this PoC's own console.watch/
  // console.backlog above already proved - this page's only genuinely new real code is the
  // per-profile multiplexing (one watchLogFile per running profile in the group, tagging each
  // event with which profile it came from) and the real serverEvents 'status' subscription that
  // starts/stops a profile's own tailer live as it starts/stops. groupConsole.rconSend already
  // existed (see "A tenth real page" above) - reused unmodified. Only one Group Console can be
  // subscribed at a time in the real app (a new subscribe replaces whatever was previously
  // watching, mirrored here with the same single `stopGroupConsoleWatch` slot console.watch's
  // own `stopConsoleWatch` already uses this shape for).
  'groupConsole.subscribe': async (params) => {
    const { profileIds } = params as { profileIds: string[] }
    stopGroupConsoleWatch?.()
    const profiles = profileIds
      .map((id) => listProfiles().find((p) => p.id === id))
      .filter((p): p is ServerProfile => p !== undefined)
    stopGroupConsoleWatch = watchGroupConsole(profiles, (event) => {
      send({ event: 'group-console-event', data: event })
    })
    return getGroupConsoleBacklog(profiles)
  },
  'groupConsole.unsubscribe': () => {
    stopGroupConsoleWatch?.()
    stopGroupConsoleWatch = null
    return { ok: true }
  },
  // A nineteenth real page: EventSchedulerView.tsx - automatically adds/removes a set of mod
  // ids on target servers when a scheduled event starts/ends. Real, unmodified
  // listModEvents/saveModEvent/deleteModEvent/listModEventHistory (store.ts) and
  // armModEvent/disarmModEvent (lib/modEvents.ts) - the latter owns real `node-cron`
  // schedules and `setTimeout`s (not Electron APIs) that fire a real reconciliation pass
  // (applyModEventChange -> real profiles.save + real syncAseModsToIni), including a real
  // start/stop cycle through the same real startServer/stopServer this PoC's "The actual
  // headline case" already proved, when an event's shutdownOnStart/shutdownOnEnd is set. No
  // push event needed - the real page just re-fetches the list/history after every save, the
  // same shape "A ninth real page" (MapManagementTab) already proved doesn't need one either.
  'modEvents.list': () => listModEvents(),
  'modEvents.save': (params) => {
    const modEvent = params as ModEvent
    const events = saveModEvent(modEvent)
    armModEvent(modEvent)
    return events
  },
  'modEvents.delete': (params) => {
    const { id } = params as { id: string }
    disarmModEvent(id)
    return deleteModEvent(id)
  },
  'modEvents.history': () => listModEventHistory(),
  // A twentieth real page: MapManagerView.tsx. Real, unmodified listMaps() (lib/maps.ts, reads
  // the shipped per-game maps.json) and listCustomMaps/addCustomMap/updateCustomMap/
  // deleteCustomMap (lib/customMaps.ts, reads/writes a real customMaps.json in the real data
  // dir) - a different real file-backed subsystem from every store.ts-based one this PoC has
  // ported so far, proving getDataDir()'s own JSON-list read/write helpers (jsonListFile.ts)
  // port with zero Electron coupling too. No push event - same no-live-update shape as
  // "A ninth real page" (MapManagementTab) and "A nineteenth real page" (EventSchedulerView)
  // already proved doesn't need one.
  'maps.list': (params) => listMaps((params as { game: GameId }).game),
  'customMaps.list': () => listCustomMaps(),
  'customMaps.add': (params) => addCustomMap(params as { id: string; displayName: string; modId?: string }),
  'customMaps.update': (params) => {
    const { originalId, entry } = params as { originalId: string; entry: { id: string; displayName: string; modId?: string } }
    return updateCustomMap(originalId, entry)
  },
  'customMaps.delete': (params) => deleteCustomMap((params as { id: string }).id),
  // A twenty-first real page: IniTemplatesView.tsx - a cluster-wide generic
  // GameUserSettings.ini/Game.ini template plus an optional per-server override, merged
  // key-by-key into each real profile's real config files. getIniTemplateGeneric/
  // saveIniTemplateGeneric/getIniTemplateOverride/saveIniTemplateOverride/
  // deleteIniTemplateOverride (store.ts) are the same real electron-store-backed CRUD shape
  // this PoC has already proven many times over; the genuinely new real code is
  // applyIniTemplate/applyIniTemplateToAll (lib/iniTemplates.ts) - real, unmodified, and the
  // first thing in this whole PoC to write directly into a real GameUserSettings.ini/Game.ini
  // file (gameConfigWrite.ts's upsertIniKeys, surgically updating an existing key in place or
  // inserting a new one into its section - not a template engine standing in for it). No real
  // ARK config file exists yet for any seeded profile in this sandbox, so applying for the
  // first time genuinely creates `ShooterGame/Saved/Config/WindowsServer/*.ini` from nothing -
  // confirmed real, honest file-creation behavior (upsertIniKeys's own
  // tryReadExistingContent treats a missing file as a legitimate empty starting point, not an
  // error), not a simulated success.
  'iniTemplates.getGeneric': () => getIniTemplateGeneric(),
  'iniTemplates.saveGeneric': (params) => saveIniTemplateGeneric(params as IniTemplateContent),
  'iniTemplates.getOverride': (params) => getIniTemplateOverride((params as { profileId: string }).profileId) ?? null,
  'iniTemplates.saveOverride': (params) => saveIniTemplateOverride(params as IniTemplateProfileOverride),
  'iniTemplates.deleteOverride': (params) => deleteIniTemplateOverride((params as { profileId: string }).profileId),
  'iniTemplates.apply': (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    applyIniTemplate(profile)
    return { ok: true }
  },
  'iniTemplates.applyAll': () => applyIniTemplateToAll(),
  // Real, unmodified fs.readFileSync wrapper - backs the real "Import from file..." buttons
  // (reads back whatever .ini the native file picker below returned). Not Electron-coupled at
  // all in the real ipc/iniTemplates.ts handler either (it's a plain fs call wrapped in a
  // try/catch, no shim needed), so it's reproduced directly here rather than imported from a
  // lib/ file that doesn't exist for it.
  'iniTemplates.readFile': (params) => {
    const { filePath } = params as { filePath: string }
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch (err) {
      throw new Error(`Couldn't read ${filePath}: ${(err as Error).message}`)
    }
  }
}

let stopConsoleWatch: (() => void) | null = null
let stopGroupConsoleWatch: (() => void) | null = null

// Tauri's own event names only accept alphanumerics, '-', '/', ':', '_' - found by actually
// running this against a real Tauri app.emit() call, not from reading the docs - 'profiles-
// changed' here, not 'profiles.changed' matching the RPC method naming below. Same for
// 'manager-log-entry' vs. the real app's own 'log' event name on managerLogEvents.
profileEvents.on('changed', (profiles) => send({ event: 'profiles-changed', data: profiles }))
managerLogEvents.on('log', (entry) => send({ event: 'manager-log-entry', data: entry }))
// A third independent push source: serverProcess.ts's own `serverEvents` 'status' emitter -
// the one every server card/detail page in the real app subscribes to for live state
// ('starting'/'running'/'stopping'/'stopped'/'error'), not just what a one-off status poll
// would show.
serverEvents.on('status', (status) => send({ event: 'server-status', data: status }))
// A fourth and fifth: lib/backup.ts's own `backupEvents` - 'created' backs BackupsTab.tsx's
// window.api.backup.onCreated (reload the file list without polling), 'log' backs
// BackupLogPanel.tsx's window.api.backup.onLogChanged (append one line live instead of
// re-fetching the whole log). Both are plain EventEmitter.on subscriptions at module level,
// same shape as profileEvents/managerLogEvents/serverEvents above - no explicit "arm" call
// needed here, unlike lib/schedule.ts's own serverEvents subscription.
backupEvents.on('created', (profileId: string) => send({ event: 'backup-created', data: profileId }))
backupEvents.on('log', (profileId: string, entry) => send({ event: 'backup-log-entry', data: { profileId, entry } }))
// A sixth: lib/steamcmd.ts's own `steamcmdUpdateEvents` - backs UpdateLogTab.tsx's
// window.api.steamcmd.onUpdateLogChanged, the same "module-level EventEmitter.on
// subscription, no explicit arm call needed" shape as every push source above except
// lib/schedule.ts's own (see registerBackupScheduleWatcher below).
steamcmdUpdateEvents.on('log', (profileId: string) => send({ event: 'steamcmd-update-log-changed', data: profileId }))

// Real, unmodified adoptPersistedProcesses() - the real app's own answer to "what happens to a
// running server if the Manager itself crashes or restarts": startServer() launches it detached
// and unref'd (see serverProcess.ts) specifically so the OS process survives that, and this is
// what re-attaches to it afterward instead of losing track of it (or letting a second instance
// start on the same ports). The real index.ts calls this once at app startup, after registering
// its own watchers (so an adopted server's status broadcast still reaches them) and before
// anything else touches `running` - mirrored here in the same order, once per sidecar process
// lifetime, which is the right analog: a new sidecar process is spawned exactly when the real
// app's main process would be (a fresh `cargo tauri` run, not a page reload), so "restart the
// whole app" and "a new sidecar process starts" are the same event in this architecture.
adoptPersistedProcesses(listProfiles(), getRunningPids(), getRunningStartedAt())

// Real, unmodified registerBackupScheduleWatcher() - unlike profileEvents/managerLogEvents/
// serverEvents above, lib/schedule.ts's own serverEvents.on('status', ...) subscription is
// NOT a module-load side effect; it only happens once this function is actually called, the
// same real index.ts startup-order requirement as adoptPersistedProcesses just above. Found
// the hard way: importing getBackupScheduleStatus alone left it permanently reporting
// { active: false }, even with a running server and a real cron schedule saved, because
// nothing had ever subscribed it to real status transitions.
registerBackupScheduleWatcher()

// Real, unmodified armAllModEvents() - the real index.ts's own startup call, same shape as
// adoptPersistedProcesses/registerBackupScheduleWatcher above: arms every saved event's real
// node-cron/setTimeout schedule AND runs an immediate reconciliation pass per event, so a
// sidecar process that starts mid-event (or mid-gap) still ends up with the right mods
// present/absent right away, not just from the next scheduled firing onward.
armAllModEvents()

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line)
  } catch (err) {
    console.error('sidecar: failed to parse incoming line:', line, err)
    return
  }
  // A line with no "method" field is a response to one of THIS sidecar's own outgoing
  // shell-request calls (see rpcToRust.ts), not a command from Rust - every command line
  // always carries one. Checked first since both shapes otherwise look alike (both just
  // {id, ...}).
  if (parsed.method === undefined) {
    const handled = resolveRustResponse(parsed.id as number, parsed.result, parsed.error as string | undefined)
    if (!handled) console.error('sidecar: response for unknown/already-resolved request id:', line)
    return
  }
  const request = parsed as unknown as RpcRequest
  const handler = methods[request.method]
  if (!handler) {
    send({ id: request.id, error: `Unknown method "${request.method}"` })
    return
  }
  try {
    const result = await handler(request.params)
    send({ id: request.id, result })
  } catch (err) {
    send({ id: request.id, error: (err as Error).message })
  }
})

// Tells the Rust side the sidecar is up and its stdio pipes are ready to receive requests -
// spawning a child process and it actually being ready to read stdin aren't the same instant.
console.error('sidecar: ready')
