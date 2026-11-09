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
  removePlayerBanProfile,
  getProfile
} from '../../src/main/store'
import { sendRconCommand, parsePlayerListWithIds } from '../../src/main/lib/rcon'
import { isValidArkInstall, detectGameFromInstall, detectProfileFields, uniqueProfileName } from '../../src/main/lib/detect'
import { isStartupComplete, markStartupComplete, startupStatusEvents } from '../../src/main/lib/startupStatus'
import { logManagerEvent, newTaskId, managerLogEvents, readManagerLog } from '../../src/main/lib/managerLog'
import {
  watchLogFile,
  getLogFilePath,
  getStatus,
  serverEvents,
  getExecutablePath,
  buildLaunchArgs,
  adoptPersistedProcesses
} from '../../src/main/lib/serverProcess'
import { doStartServer, doStopServer, doRestartServer, doKillServer, doUpdateServer } from '../../src/main/lib/serverActions'
import { readLogBacklog, parseLogChunkWithDate, createLogEventCaches } from '../../src/main/lib/logEvents'
import {
  openProfilesFolder,
  openServerConfigFolder,
  openServerSavedArksFolder,
  openServerSaveGamesFolder,
  openDataDirFolder
} from '../../src/main/lib/systemFolders'
import { copyProfile, moveProfile } from '../../src/main/lib/profileCopyMove'
import { startDiscordBot, stopDiscordBot, getDiscordBotStatus, applyDiscordBotSettings, restartDiscordBot } from '../../src/main/lib/discordBot'
import { applyWebDashboardSettings, stopWebDashboard, getWebDashboardStatus } from '../../src/main/lib/webDashboard'
import { getSystemStaticInfo, getNetworkUsage } from '../../src/main/lib/systemStats'
import { readStatsHistory, readClusterStatsHistory, readClusterStatsHistoryForGroups } from '../../src/main/lib/statsHistory'
import { copyProfileConfigFiles } from '../../src/main/lib/profileConfigCopy'
import { fetchOfficialServerStatus } from '../../src/main/lib/officialServerStatus'
import { getBackupScheduleStatus, applyBackupSchedule, registerBackupScheduleWatcher } from '../../src/main/lib/schedule'
import { getInstalledBuildId, readUpdateLog, getUpdateLogPath, steamcmdUpdateEvents } from '../../src/main/lib/steamcmd'
import { listMapFolders, createMapFolder, deleteMapFolder, openMapFolder } from '../../src/main/lib/mapManagement'
import { getGroupConsoleBacklog, watchGroupConsole } from '../../src/main/lib/groupConsole'
import { installManagedSteamCmd, getManagedSteamCmdStatus } from '../../src/main/lib/steamcmdInstaller'
import { addFirewallRulesForSteamCmd } from '../../src/main/lib/firewall'
import { getGameVersion, getCachedGameVersion, setCachedGameVersion } from '../../src/main/lib/serverVersion'
import { registerServerVersionWatcher, checkAllGameVersionsOnStartup } from '../../src/main/lib/serverVersionWatcher'
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
import { syncAseModsToIni, reconcileAseModsFromIni } from '../../src/main/lib/gameConfigWrite'
import { parseImportedMods } from '../../src/main/lib/modsExport'
import { searchArkMods, getArkModsInfo } from '../../src/main/lib/arkMods'
import { serializeProfile, parseImportedProfile } from '../../src/main/lib/profileExport'
import {
  listFileBrowserEntries,
  resolveFileBrowserPath,
  deleteFileBrowserFile,
  readIniFile,
  writeIniFile,
  listIniHistory,
  diffIniHistoryEntry,
  restoreIniHistoryEntry
} from '../../src/main/lib/fileBrowser'
import { applyLaunchOnStartup } from '../../src/main/lib/launchOnStartup'
import { applyIniLockSetting } from '../../src/main/lib/iniLock'
import { syncAllPlayerJoinAlertWatches } from '../../src/main/lib/playerJoinAlertWatch'
import { syncAllPlayerActivityWatches } from '../../src/main/lib/playerActivityWatch'
import { getDefaultDataDir } from '../../src/main/lib/dataDir'
import { detectLegacyCandidates, previewLegacyImport, runLegacyImport } from './legacyImport'
import { getLocalNetworkIps } from '../../src/main/lib/webDashboard'
import { serializeClusterBundle, parseClusterBundle } from '../../src/main/lib/clusterExport'
import {
  applyScheduledRestart,
  applyScheduledDinoWipe,
  applyScheduledRconCommands,
  applyScheduledMaintenance
} from '../../src/main/lib/scheduledActions'
import { applyMinecraftScheduledRestart, clearMinecraftScheduledRestart } from '../../src/main/lib/minecraftScheduledActions'
import {
  applyMinecraftBackupSchedule,
  clearMinecraftBackupSchedule,
  getMinecraftBackupScheduleStatus
} from '../../src/main/lib/minecraftBackupSchedule'
import {
  listMinecraftProfiles,
  saveMinecraftProfile,
  getMinecraftProfile,
  deleteMinecraftProfile,
  minecraftProfileEvents
} from '../../src/main/store'
import {
  listWebDashboardAccessTokens,
  saveWebDashboardAccessToken,
  deleteWebDashboardAccessToken,
  listWebDashboardApiKeys,
  saveWebDashboardApiKey,
  deleteWebDashboardApiKey
} from '../../src/main/store'
import { hashPassword, generateApiKeyId, generateApiKeySecret, buildApiKey } from '../../src/main/lib/auth'
import {
  listInstallableMinecraftVersions,
  listInstallableLoaderVersions,
  installMinecraftServerFiles
} from '../../src/main/lib/minecraftInstall'
import { getStatus as getMinecraftStatus, minecraftServerEvents, sendStdinCommand, getConsoleBacklog, minecraftConsoleEvents } from '../../src/main/lib/minecraftProcess'
import { sendMinecraftRconCommand } from '../../src/main/lib/minecraftRcon'
import { detectMinecraftLaunchable } from '../../src/main/lib/minecraftDetect'
import {
  getMinecraftBackupLog,
  minecraftBackupEvents,
  logMinecraftBackup,
  createMinecraftBackup,
  listMinecraftBackups,
  deleteMinecraftBackup,
  restoreMinecraftBackup,
  openMinecraftBackupFolder,
  openMinecraftServerRootFolder
} from '../../src/main/lib/minecraftBackup'
import { readServerProperties, upsertServerPropertiesKeys } from '../../src/main/lib/minecraftProperties'
import {
  searchMinecraftMods,
  installMinecraftMod,
  removeMinecraftMod,
  setMinecraftModEnabled,
  checkMinecraftModUpdates,
  updateMinecraftMod,
  scanForInstalledMods,
  openMinecraftModsFolder
} from '../../src/main/lib/minecraftMods'
import type { MinecraftModSource, MinecraftModEcosystem } from '../../shared/minecraftMods'
import { doStartMinecraftServer, doStopMinecraftServer, doKillMinecraftServer } from '../../src/main/lib/minecraftActions'
import { detectMinecraftProfile, isValidMinecraftInstall } from '../../src/main/lib/minecraftDetect'
import { app, shell } from 'electron'
import { send, resolveRustResponse } from './rpcToRust'
import type { GameId } from '../../shared/games'
import type { MinecraftInstallableType, MinecraftInstallParams } from '../../shared/minecraftInstall'
import type { MinecraftProfile } from '../../shared/minecraft'
import type {
  AppSettings,
  IniTemplateContent,
  IniTemplateProfileOverride,
  ModEvent,
  ServerMod,
  ServerProfile,
  WebDashboardRole
} from '../../shared/types'

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
  // Real, unmodified parseImportedProfile() - backs Dashboard.tsx's own "+ Add Profile" wizard
  // import-from-file path, found only once the real App.tsx (which actually renders that
  // wizard, unlike dashboard-entry.tsx's own earlier round which left it explicitly out of
  // scope) was mounted and this call site was hit for real the first time in this PoC.
  'profiles.importFromFile': (params) => {
    const { filePath } = params as { filePath: string }
    const existing = listProfiles()
    const profile = parseImportedProfile(fs.readFileSync(filePath, 'utf-8'), existing.map((p) => p.name))
    const profiles = saveProfile(profile)
    applyBackupSchedule(profile)
    applyScheduledRestart(profile)
    applyScheduledDinoWipe(profile)
    applyScheduledRconCommands(profile)
    applyScheduledMaintenance(profile)
    return { profile, profiles }
  },
  // Real, unmodified detectGameFromInstall()/detectProfileFields()/uniqueProfileName() - backs
  // Dashboard.tsx's own "+ Add Profile" wizard's "Import from install folder" path (ARK side;
  // Minecraft's own equivalent is 'minecraft.profiles.importFromInstall' below). Found missing
  // during an IPC-surface audit against the real preload (src/preload/index.ts) - every other
  // 'profiles.*' method here had a counterpart, this one didn't, even though windowApi.ts's own
  // type declaration already promised it. Builds the same full ServerProfile object the real
  // ipc/profiles.ts handler does (every field defaulted the same way), rather than a narrower
  // PoC-only shape - a real migration's import path has to produce a profile the rest of the
  // real app (saveProfile's own sanitization, every field the UI reads) can trust unconditionally.
  'profiles.importFromInstall': async (params) => {
    const { installDir } = params as { installDir: string }
    const game = await detectGameFromInstall(installDir)
    if (!game) {
      throw new Error('No supported ARK server executable found in this folder.')
    }

    const detected = detectProfileFields(installDir)
    const existing = listProfiles()
    const name = uniqueProfileName(detected.suggestedName, existing.map((p) => p.name))

    const profile: ServerProfile = {
      id: randomUUID(),
      name,
      game,
      installDir,
      steamBetaEnabled: false,
      steamBetaName: '',
      map: detected.map,
      moddedMapEnabled: false,
      moddedMapId: '',
      gamePort: detected.gamePort ?? 7777,
      rconPort: detected.rconPort ?? 27020,
      queryPort: detected.queryPort ?? 27015,
      serverPlatform: 'PC',
      maxPlayers: 70,
      backupDir: '',
      maxBackups: 10,
      backupSchedule: '',
      backupScheduleEnabled: false,
      playerProfileBackupEnabled: false,
      playerProfileBackupMaxPerPlayer: 20,
      mods: detected.mods,
      clusterEnabled: false,
      clusterId: '',
      clusterDirOverride: '',
      noTransferFromFiltering: false,
      externalIp: '',
      discordChatChannelId: '',
      discordEventsChannelId: '',
      discordBotExcluded: false,
      cultureSettings: 'none',
      disableBattlEye: false,
      rconTribeLog: false,
      forceRespawnDinos: false,
      noSound: false,
      maxDinoLevel: '',
      serverPassword: '',
      autoManageMods: false,
      extraArgs: '',
      scheduledRestartEnabled: false,
      scheduledRestartTime: '00:00',
      scheduledRestartDays: [],
      scheduledRestartUpdateAfter: false,
      scheduledRestartStartAfter: false,
      scheduledRestartOnlyIfEmpty: false,
      scheduledRestartOnlyIfUpdateAvailable: false,
      scheduledDinoWipeEnabled: false,
      scheduledDinoWipeTime: '00:00',
      scheduledDinoWipeDays: [],
      scheduledRconCommands: [],
      scheduledMaintenanceEnabled: false,
      scheduledMaintenanceTime: '00:00',
      scheduledMaintenanceDays: [],
      startOnManagerLaunch: false,
      hidden: false,
      group: '',
      crashWatchEnabled: false,
      zombieDetectionEnabled: false,
      zombieDetectionTimeoutMinutes: 10,
      zombieDetectionAutoRestart: false,
      clusterLogArchiveMaxSizeMB: 10,
      statsEnabled: false
    }

    const profiles = saveProfile(profile)
    applyBackupSchedule(profile)
    return { profile, profiles }
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
  // copyProfileConfigFiles - CreateServerWizard's "copy config from an existing server"
  // option. Found missing during the IPC-surface audit against the real preload.
  'profiles.copyConfigFrom': (params) => {
    const { sourceProfileId, destProfileId } = params as { sourceProfileId: string; destProfileId: string }
    const source = listProfiles().find((p) => p.id === sourceProfileId)
    const dest = listProfiles().find((p) => p.id === destProfileId)
    if (!source) throw new Error(`Unknown profile: ${sourceProfileId}`)
    if (!dest) throw new Error(`Unknown profile: ${destProfileId}`)
    copyProfileConfigFiles(source.installDir, dest.installDir)
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
  // fetchOfficialServerStatus - the Dashboard's "ARK Official Server Network" banner, a
  // real outbound fetch against arkdedicated.com's own status feed. Found missing during
  // the IPC-surface audit against the real preload.
  'officialServerStatus.get': async () => fetchOfficialServerStatus(),
  // Real, unmodified subsystems AnalyticsTab.tsx pulls in - five more real files this PoC
  // hadn't touched, none of them Electron-coupled.
  // readStatsHistory reads the real JSONL file monitor.ts's recordStatSample (see "A fifth
  // real page" above) already writes to every 5s while a server's statsEnabled and running -
  // this is the read side of the same real subsystem, not a new one.
  'statsHistory.get': async (params) => {
    const { profileId, sinceMs, maxPoints } = params as { profileId: string; sinceMs: number | null; maxPoints?: number }
    return readStatsHistory(profileId, sinceMs, maxPoints)
  },
  // readClusterStatsHistory - the single-group sibling of readClusterStatsHistoryForGroups
  // below (ClusterConsole/ClusterDataView's single merged-cluster view, vs. the Cluster
  // Dashboard's every-group-at-once view). Found missing during the IPC-surface audit
  // against the real preload's Api interface.
  'statsHistory.getForGroup': async (params) => {
    const { profileIds, sinceMs, maxPoints } = params as { profileIds: string[]; sinceMs: number | null; maxPoints?: number }
    return readClusterStatsHistory(profileIds, sinceMs, maxPoints)
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
  },
  // A twenty-second real page: ServerDetail/FilesTab.tsx - a Notepad++-inspired file browser
  // and tabbed editor over the server's own install directory, with the same real
  // history/diff/restore .ini editing lib/iniTemplates.ts's own Save button already proved a
  // slice of. Real, unmodified listFileBrowserEntries/resolveFileBrowserPath/
  // deleteFileBrowserFile/readIniFile/writeIniFile/listIniHistory/diffIniHistoryEntry/
  // restoreIniHistoryEntry (lib/fileBrowser.ts) - mirrors the real ipc/fileBrowser.ts
  // handlers' exact bodies, including fileBrowser.open's real `shell.openPath` call (the same
  // real reverse-direction round trip "The reverse direction" already proved, a new real call
  // site of it rather than a new mechanism).
  'fileBrowser.list': (params) => {
    const { profileId, relativePath } = params as { profileId: string; relativePath: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return listFileBrowserEntries(profile.installDir, relativePath)
  },
  'fileBrowser.open': async (params) => {
    const { profileId, relativePath } = params as { profileId: string; relativePath: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    const filePath = resolveFileBrowserPath(profile.installDir, relativePath)
    const error = await shell.openPath(filePath)
    if (error) throw new Error(error)
    return { ok: true }
  },
  'fileBrowser.delete': (params) => {
    const { profileId, relativePath } = params as { profileId: string; relativePath: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    deleteFileBrowserFile(profile.installDir, relativePath)
    return { ok: true }
  },
  'fileBrowser.readIni': (params) => {
    const { profileId, relativePath } = params as { profileId: string; relativePath: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return readIniFile(profile.installDir, relativePath)
  },
  'fileBrowser.writeIni': (params) => {
    const { profileId, relativePath, content } = params as { profileId: string; relativePath: string; content: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    writeIniFile(profileId, profile.installDir, relativePath, content)
    return { ok: true }
  },
  'fileBrowser.iniHistory': (params) => {
    const { profileId, relativePath } = params as { profileId: string; relativePath: string }
    return listIniHistory(profileId, relativePath)
  },
  'fileBrowser.iniHistoryDiff': (params) => {
    const { profileId, entryId } = params as { profileId: string; entryId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return diffIniHistoryEntry(profileId, profile.installDir, entryId)
  },
  'fileBrowser.iniRestore': (params) => {
    const { profileId, entryId } = params as { profileId: string; entryId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    restoreIniHistoryEntry(profileId, profile.installDir, entryId)
    return { ok: true }
  },
  // A twenty-third real page: ServerDetail/ModsTab.tsx - the per-server mod list, shared
  // (with real per-game branching) between ARK: Survival Ascended (-mods=/-passivemods=
  // launch flags, real CurseForge search/enrichment) and ARK: Survival Evolved
  // (GameUserSettings.ini's real ActiveMods=/Game.ini's [ModInstaller], via the same real
  // gameConfigWrite.ts functions "A nineteenth real page"'s applyModEventChange already
  // called internally - new direct real call sites of them here, not a new mechanism).
  // mods.save mirrors the real handler's exact body (profiles.save + syncAseModsToIni, a
  // no-op for Ascended); mods.reconcileFromIni picks up any mod already in a real
  // ActiveMods= line the Manager didn't know about yet. arkMods.search/arkMods.info hit the
  // real CurseForge API (curseforgeClient.ts) - honestly, real-gracefully empty with no real
  // network attempt at all when no CurseForge API key is configured (unlike SteamCMD's own
  // "A sixteenth real page" fetch, which always attempts), confirmed by this sandbox's own
  // unset curseforgeApiKey setting.
  'mods.save': (params) => {
    const { profileId, mods } = params as { profileId: string; mods: ServerMod[] }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    const updated = { ...profile, mods }
    saveProfile(updated)
    syncAseModsToIni(updated)
    return updated
  },
  'mods.parseText': (params) => parseImportedMods((params as { text: string }).text),
  'mods.reconcileFromIni': (params) => {
    const { profileId } = params as { profileId: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    const mods = reconcileAseModsFromIni(profile)
    if (mods === profile.mods) return profile
    const updated = { ...profile, mods }
    saveProfile(updated)
    return updated
  },
  'arkMods.search': (params) => searchArkMods((params as { query: string }).query),
  'arkMods.info': (params) => getArkModsInfo((params as { modIds: string[] }).modIds),
  'server.previewLaunchCommand': (params) => {
    const profile = params as ServerProfile
    return { executable: getExecutablePath(profile), args: buildLaunchArgs(profile) }
  },
  'system.openDataDirFolder': async () => {
    await openDataDirFolder()
    return { ok: true }
  },
  'profiles.export': (params) => {
    const { profileId, filePath } = params as { profileId: string; filePath: string }
    const profile = listProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)
    fs.writeFileSync(filePath, serializeProfile(profile), 'utf-8')
    return { ok: true }
  },
  // Real, unmodified ipc/settings.ts handler body - saveSettings() plus every real follow-up
  // re-application it does (web dashboard, Discord bot, launch-on-startup, ini lock,
  // player-join-alert/player-activity watchers). applyLaunchOnStartup calls the real
  // electronShim.app.setLoginItemSettings stub (see electronShim.ts's own comment) rather than
  // throwing, same "small enough to just satisfy" shape as the ipcMain stub above it. Replaces
  // this PoC's own earlier, bare `saveSettings(params)`-only version (dashboard-entry.tsx/
  // steamcmd-entry.tsx used that narrower shape for their own settings writes) - same RPC
  // method name, so those two entry files now get the real full re-application too, which is
  // strictly more correct, not a behavior change they depended on.
  'settings.save': async (params) => {
    const settings = params as AppSettings
    const saved = saveSettings(settings)
    applyWebDashboardSettings(saved)
    await applyDiscordBotSettings(saved)
    applyLaunchOnStartup(saved)
    applyIniLockSetting(saved.iniLockEnabled, listProfiles())
    syncAllPlayerJoinAlertWatches()
    syncAllPlayerActivityWatches()
    return saved
  },
  // Real, unmodified getDefaultDataDir() (lib/dataDir.ts) - a third real call site of
  // electronShim's app.getPath('documents'), after managerLog.ts's getDataDir() and
  // customMaps.ts's own use of it.
  'dataDir.getDefault': () => getDefaultDataDir(),
  // Real, unmodified getLocalNetworkIps() (lib/webDashboard.ts) - plain os.networkInterfaces()
  // filtering, no Electron coupling at all.
  'webDashboard.getLocalIps': () => getLocalNetworkIps(),
  // Real, unmodified restartDiscordBot() (lib/discordBot.ts) - getDiscordBotStatus/stopDiscordBot
  // were already proven under the 'bot.*' RPC names; this is the one new real call site
  // DataSettingsView.tsx itself needs (its own "Restart bot"/"Stop bot" buttons reuse the
  // already-proven discordBot.status/stop shape via new RPC names below for a 1:1 real
  // ipc/discordBot.ts handler match).
  'discordBot.status': () => getDiscordBotStatus(),
  'discordBot.restart': async () => {
    await restartDiscordBot()
    return getDiscordBotStatus()
  },
  'discordBot.stop': () => {
    stopDiscordBot()
    return getDiscordBotStatus()
  },
  // appUpdate.* used to live here, routed to the real (but Electron-only, and in this sandbox
  // always dev-mode-stubbed - see checkForUpdate()'s own `app.isPackaged` gate) lib/appUpdater.ts
  // just to prove the four-command IPC shape end to end. Replaced in main.rs by a real
  // tauri-plugin-updater-backed implementation (app_update_check/_install/_status/_get_version) -
  // there's nothing left for the sidecar to do for this feature, Tauri's own updater runs
  // entirely in Rust. See main.rs's own comment on PendingUpdate for the full story.
  //
  // Real, unmodified serializeClusterBundle() (lib/clusterExport.ts) - pretty-printed JSON of
  // every ARK/Minecraft profile plus Settings, written straight to disk exactly like the real
  // ipc/cluster.ts handler.
  'cluster.export': (params) => {
    const { filePath } = params as { filePath: string }
    fs.writeFileSync(filePath, serializeClusterBundle(), 'utf-8')
    return { ok: true }
  },
  // Real, unmodified parseClusterBundle() plus every real per-profile re-application the real
  // ipc/cluster.ts handler does - the first real call site in this PoC to touch the Minecraft
  // profile store (listMinecraftProfiles/saveMinecraftProfile) and its own scheduled-action
  // appliers (applyMinecraftScheduledRestart/applyMinecraftBackupSchedule), proving that real
  // subsystem ports with zero changes too, not just the ARK one every earlier round exercised.
  'cluster.import': async (params) => {
    const { filePath, includeSettings } = params as { filePath: string; includeSettings: boolean }
    const existing = listProfiles()
    const existingMinecraft = listMinecraftProfiles()
    const bundle = parseClusterBundle(
      fs.readFileSync(filePath, 'utf-8'),
      existing.map((p) => p.name),
      existingMinecraft.map((p) => p.name)
    )

    let profiles = existing
    for (const profile of bundle.profiles) {
      profiles = saveProfile(profile)
      applyBackupSchedule(profile)
      applyScheduledRestart(profile)
      applyScheduledDinoWipe(profile)
      applyScheduledRconCommands(profile)
      applyScheduledMaintenance(profile)
    }

    let minecraftProfiles = existingMinecraft
    for (const profile of bundle.minecraftProfiles) {
      minecraftProfiles = saveMinecraftProfile(profile)
      applyMinecraftScheduledRestart(profile)
      applyMinecraftBackupSchedule(profile)
    }

    let settings: AppSettings = getSettings()
    if (includeSettings) {
      settings = saveSettings(bundle.settings)
      applyWebDashboardSettings(settings)
      await applyDiscordBotSettings(settings)
      applyLaunchOnStartup(settings)
      applyIniLockSetting(settings.iniLockEnabled, profiles)
    }

    return {
      profiles,
      minecraftProfiles,
      settings,
      addedProfileCount: bundle.profiles.length,
      addedMinecraftProfileCount: bundle.minecraftProfiles.length,
      settingsReplaced: includeSettings
    }
  },
  // Real, unmodified webDashboardAccessTokens/webDashboardApiKeys CRUD (store.ts) plus
  // lib/auth.ts's real hashPassword/generateApiKeyId/generateApiKeySecret/buildApiKey - the
  // exact same functions ipc/webDashboardAccessTokens.ts/ipc/webDashboardApiKeys.ts call,
  // deliberately desktop-only (never exposed over the web dashboard's own HTTP API) in the
  // real app too, so this is just the ordinary sidecar RPC round trip, no new architectural
  // shape.
  'webDashboardAccessTokens.list': () =>
    listWebDashboardAccessTokens().map((t) => ({
      id: t.id,
      label: t.label,
      role: t.role,
      profileIds: t.profileIds,
      createdAt: t.createdAt
    })),
  'webDashboardAccessTokens.create': async (params) => {
    const { label, role, profileIds } = params as {
      label: string
      role: WebDashboardRole
      profileIds: string[] | null
    }
    const trimmed = label.trim()
    if (!trimmed) throw new Error('Label is required')
    const id = generateApiKeyId()
    const secret = generateApiKeySecret()
    const secretHash = await hashPassword(secret)
    const normalizedProfileIds = profileIds && profileIds.length > 0 ? profileIds : null
    saveWebDashboardAccessToken({
      id,
      label: trimmed,
      secretHash,
      role,
      profileIds: normalizedProfileIds,
      createdAt: Date.now()
    })
    return {
      token: buildApiKey(id, secret),
      tokens: listWebDashboardAccessTokens().map((t) => ({
        id: t.id,
        label: t.label,
        role: t.role,
        profileIds: t.profileIds,
        createdAt: t.createdAt
      }))
    }
  },
  'webDashboardAccessTokens.update': (params) => {
    const { id, updates } = params as {
      id: string
      updates: { label?: string; role?: WebDashboardRole; profileIds?: string[] | null }
    }
    const existing = listWebDashboardAccessTokens().find((t) => t.id === id)
    if (!existing) throw new Error('Unknown access token')
    const label = updates.label !== undefined ? updates.label.trim() : existing.label
    if (!label) throw new Error('Label is required')
    const role = updates.role ?? existing.role
    const profileIds = updates.profileIds !== undefined ? updates.profileIds : existing.profileIds
    const normalizedProfileIds = profileIds && profileIds.length > 0 ? profileIds : null
    saveWebDashboardAccessToken({ ...existing, label, role, profileIds: normalizedProfileIds })
    return listWebDashboardAccessTokens().map((t) => ({
      id: t.id,
      label: t.label,
      role: t.role,
      profileIds: t.profileIds,
      createdAt: t.createdAt
    }))
  },
  'webDashboardAccessTokens.delete': (params) => {
    const { id } = params as { id: string }
    return deleteWebDashboardAccessToken(id).map((t) => ({
      id: t.id,
      label: t.label,
      role: t.role,
      profileIds: t.profileIds,
      createdAt: t.createdAt
    }))
  },
  'webDashboardApiKeys.list': () =>
    listWebDashboardApiKeys().map((k) => ({ id: k.id, label: k.label, role: k.role, createdAt: k.createdAt })),
  'webDashboardApiKeys.create': async (params) => {
    const { label, role } = params as { label: string; role: WebDashboardRole }
    const trimmed = label.trim()
    if (!trimmed) throw new Error('Label is required')
    const id = generateApiKeyId()
    const secret = generateApiKeySecret()
    const secretHash = await hashPassword(secret)
    saveWebDashboardApiKey({ id, label: trimmed, secretHash, role, createdAt: Date.now() })
    return {
      key: buildApiKey(id, secret),
      keys: listWebDashboardApiKeys().map((k) => ({ id: k.id, label: k.label, role: k.role, createdAt: k.createdAt }))
    }
  },
  'webDashboardApiKeys.update': (params) => {
    const { id, updates } = params as { id: string; updates: { label?: string; role?: WebDashboardRole } }
    const existing = listWebDashboardApiKeys().find((k) => k.id === id)
    if (!existing) throw new Error('Unknown API key')
    const label = updates.label !== undefined ? updates.label.trim() : existing.label
    if (!label) throw new Error('Label is required')
    const role = updates.role ?? existing.role
    saveWebDashboardApiKey({ ...existing, label, role })
    return listWebDashboardApiKeys().map((k) => ({ id: k.id, label: k.label, role: k.role, createdAt: k.createdAt }))
  },
  'webDashboardApiKeys.delete': (params) => {
    const { id } = params as { id: string }
    return deleteWebDashboardApiKey(id).map((k) => ({ id: k.id, label: k.label, role: k.role, createdAt: k.createdAt }))
  },
  // Real, unmodified listInstallableMinecraftVersions()/listInstallableLoaderVersions()/
  // installMinecraftServerFiles() (lib/minecraftInstall.ts, dispatching into
  // lib/minecraftInstallClient.ts's own per-loader fetch/build functions) - the first real
  // Minecraft-specific subsystem this PoC exercises beyond the profile store itself (see
  // "A twenty-sixth real page"'s cluster.import). minecraftInstallClient.ts's own top-of-file
  // comment already flags that none of this could be verified against the real Mojang/Paper/
  // Fabric/Forge/NeoForge/Sponge APIs from the real app's own development sandbox either - this
  // PoC's own network-less sandbox is the same category of gap, not a new one, and is the first
  // time any of this code has actually been exercised at all, in either environment.
  'minecraft.install.listVersions': (params) => {
    const { serverType } = params as { serverType: MinecraftInstallableType }
    return listInstallableMinecraftVersions(serverType)
  },
  'minecraft.install.listLoaderVersions': (params) => {
    const { serverType, minecraftVersion } = params as {
      serverType: MinecraftInstallableType
      minecraftVersion: string
    }
    return listInstallableLoaderVersions(serverType, minecraftVersion)
  },
  'minecraft.install.run': (params) => installMinecraftServerFiles(params as MinecraftInstallParams),
  // Real, unmodified ipc/minecraft.ts handler bodies - listMinecraftProfiles/saveMinecraftProfile
  // (already proven as part of "A twenty-sixth real page"'s cluster.import, new direct call
  // sites here) plus getMinecraftProfile/deleteMinecraftProfile and the real
  // clearMinecraftScheduledRestart/clearMinecraftBackupSchedule pair - the Minecraft profile
  // CRUD foundation every future Minecraft-side round reuses, same role profiles.list/.save/
  // .delete already play on the ARK side.
  'minecraft.profiles.list': () => listMinecraftProfiles(),
  'minecraft.profiles.save': (params) => {
    const profile = params as MinecraftProfile
    const profiles = saveMinecraftProfile(profile)
    applyMinecraftScheduledRestart(profile)
    applyMinecraftBackupSchedule(profile)
    return profiles
  },
  'minecraft.profiles.delete': (params) => {
    const { id } = params as { id: string }
    clearMinecraftScheduledRestart(id)
    clearMinecraftBackupSchedule(id)
    return deleteMinecraftProfile(id)
  },
  'minecraft.profiles.get': (params) => {
    const { id } = params as { id: string }
    return getMinecraftProfile(id) ?? null
  },
  // Real, unmodified getStatus()/getConsoleBacklog() (lib/minecraftProcess.ts) backing
  // MinecraftServerDetail/ConsoleTab.tsx - a twenty-ninth real page. sendCommand mirrors the
  // real ipc/minecraft.ts handler's own fallback exactly: sendStdinCommand first (a live
  // process's stdin), then real RCON (sendMinecraftRconCommand) if there's no live stdin to
  // write to - the same "no real server process in this sandbox" honest gap every ARK
  // RCON-dependent call already has, not a new shape.
  'minecraft.server.getStatus': (params) => getMinecraftStatus((params as { profileId: string }).profileId),
  'minecraft.server.sendCommand': async (params) => {
    const { profileId, command } = params as { profileId: string; command: string }
    if (sendStdinCommand(profileId, command)) return { ok: true }
    const profile = getMinecraftProfile(profileId)
    if (!profile) return { ok: false, error: `Unknown Minecraft profile: ${profileId}` }
    return sendMinecraftRconCommand(profile.installDir, command)
  },
  'minecraft.console.getBacklog': (params) => getConsoleBacklog((params as { profileId: string }).profileId),
  // Real, unmodified detectMinecraftLaunchable() (lib/minecraftDetect.ts) - backs
  // MinecraftServerDetail/StartSettingsTab.tsx's "Re-detect from install directory" button, a
  // thirtieth real page. Plain fs.readdirSync-based heuristic, no Electron coupling at all.
  'minecraft.detectLaunchable': (params) => detectMinecraftLaunchable((params as { installDir: string }).installDir),
  // Real, unmodified getMinecraftBackupLog() (lib/minecraftBackup.ts) - backs
  // MinecraftServerDetail/BackupLogPanel.tsx, a thirty-first real page. Mirrors the real
  // ARK backup.getLog/onLogChanged shape already proven (see backupEvents.on('log', ...) below).
  'minecraft.backup.getLog': (params) => getMinecraftBackupLog((params as { profileId: string }).profileId),
  // Test-only: calls the real, unmodified logMinecraftBackup() directly (not a simulated line
  // format the way console.appendTestLine above has to be - this sandbox has no real backup
  // operation wired up yet, since BackupsTab.tsx/createMinecraftBackup() remain unported, but
  // the logging function itself needs no server process or disk state to call honestly).
  'minecraft.backup.appendTestLogLine': (params) => {
    const { profileId, message, level } = params as { profileId: string; message: string; level?: 'info' | 'error' }
    logMinecraftBackup(profileId, message, level ?? 'info')
    return { ok: true }
  },
  // Real, unmodified minecraftBackup.ts CRUD - backs MinecraftServerDetail/BackupsTab.tsx, a
  // thirty-second real page. Mirrors ipc/minecraftBackup.ts's own requireProfile() shape exactly.
  'minecraft.backup.create': (params) => {
    const profile = getMinecraftProfile((params as { profileId: string }).profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${(params as { profileId: string }).profileId}`)
    return createMinecraftBackup(profile)
  },
  'minecraft.backup.list': (params) => {
    const profile = getMinecraftProfile((params as { profileId: string }).profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${(params as { profileId: string }).profileId}`)
    return listMinecraftBackups(profile)
  },
  'minecraft.backup.delete': (params) => {
    deleteMinecraftBackup((params as { filePath: string }).filePath)
    return { ok: true }
  },
  'minecraft.backup.restore': (params) => {
    const { profileId, filePath } = params as { profileId: string; filePath: string }
    const profile = getMinecraftProfile(profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${profileId}`)
    restoreMinecraftBackup(profile, filePath)
    return { ok: true }
  },
  'minecraft.backup.openFolder': async (params) => {
    const profile = getMinecraftProfile((params as { profileId: string }).profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${(params as { profileId: string }).profileId}`)
    await openMinecraftBackupFolder(profile)
    return { ok: true }
  },
  // Real, unmodified getMinecraftBackupScheduleStatus() - the Minecraft side of
  // 'backup.getScheduleStatus' above (AnalyticsTab's own Backup Status panel). Found missing
  // during the same IPC-surface audit as profiles.importFromInstall above - every other
  // 'minecraft.backup.*' method here had already been ported, this one hadn't.
  'minecraft.backup.getScheduleStatus': (params) => {
    const { profileId } = params as { profileId: string }
    const profile = getMinecraftProfile(profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${profileId}`)
    return getMinecraftBackupScheduleStatus(profile)
  },
  // Real, unmodified openMinecraftServerRootFolder() (lib/minecraftBackup.ts) and
  // readServerProperties()/upsertServerPropertiesKeys() (lib/minecraftProperties.ts) - backs
  // MinecraftServerDetail/ServerSettingsTab.tsx, a thirty-third real page. Mirrors
  // ipc/minecraft.ts's own requireProfile() shape exactly.
  'minecraft.openServerFolder': async (params) => {
    const profile = getMinecraftProfile((params as { profileId: string }).profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${(params as { profileId: string }).profileId}`)
    await openMinecraftServerRootFolder(profile)
    return { ok: true }
  },
  'minecraft.properties.get': (params) => {
    const profile = getMinecraftProfile((params as { profileId: string }).profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${(params as { profileId: string }).profileId}`)
    return readServerProperties(profile.installDir)
  },
  'minecraft.properties.save': (params) => {
    const { profileId, updates } = params as { profileId: string; updates: Record<string, string> }
    const profile = getMinecraftProfile(profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${profileId}`)
    upsertServerPropertiesKeys(profile.installDir, updates)
    return readServerProperties(profile.installDir)
  },
  // Real, unmodified lib/minecraftMods.ts - backs MinecraftServerDetail/ModsTab.tsx, a
  // thirty-fourth real page. Mirrors ipc/minecraftMods.ts's own requireProfile() shape exactly.
  // search/install/update are real Modrinth/CurseForge network calls - same honest "fetch
  // failed" category as "A twenty-seventh real page"'s minecraft.install.* methods.
  'minecraft.mods.search': (params) => {
    const { profileId, query, ecosystem } = params as { profileId: string; query: string; ecosystem: MinecraftModEcosystem }
    const profile = getMinecraftProfile(profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${profileId}`)
    return searchMinecraftMods(profile, query, ecosystem)
  },
  'minecraft.mods.install': (params) => {
    const { profileId, source, projectId, ecosystem } = params as {
      profileId: string
      source: MinecraftModSource
      projectId: string
      ecosystem: MinecraftModEcosystem
    }
    const profile = getMinecraftProfile(profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${profileId}`)
    return installMinecraftMod(profile, source, projectId, ecosystem)
  },
  'minecraft.mods.remove': (params) => {
    const { profileId, projectId } = params as { profileId: string; projectId: string }
    const profile = getMinecraftProfile(profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${profileId}`)
    return removeMinecraftMod(profile, projectId)
  },
  'minecraft.mods.setEnabled': (params) => {
    const { profileId, projectId, enabled } = params as { profileId: string; projectId: string; enabled: boolean }
    const profile = getMinecraftProfile(profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${profileId}`)
    return setMinecraftModEnabled(profile, projectId, enabled)
  },
  'minecraft.mods.checkUpdates': (params) => {
    const profile = getMinecraftProfile((params as { profileId: string }).profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${(params as { profileId: string }).profileId}`)
    return checkMinecraftModUpdates(profile)
  },
  'minecraft.mods.update': (params) => {
    const { profileId, source, projectId } = params as { profileId: string; source: MinecraftModSource; projectId: string }
    const profile = getMinecraftProfile(profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${profileId}`)
    return updateMinecraftMod(profile, source, projectId)
  },
  'minecraft.mods.scan': (params) => {
    const profile = getMinecraftProfile((params as { profileId: string }).profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${(params as { profileId: string }).profileId}`)
    return scanForInstalledMods(profile)
  },
  'minecraft.mods.openFolder': async (params) => {
    const profile = getMinecraftProfile((params as { profileId: string }).profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${(params as { profileId: string }).profileId}`)
    await openMinecraftModsFolder(profile)
    return { ok: true }
  },
  // Real, unmodified lib/minecraftActions.ts/lib/minecraftDetect.ts - backs
  // MinecraftDashboard.tsx, a thirty-sixth real page. doStartMinecraftServer/
  // doStopMinecraftServer/doKillMinecraftServer are the actual headline case for the
  // Minecraft side: a real spawned process, monitored, stopped gracefully via stdin "stop"
  // (or RCON), or force-killed - the Minecraft-side twin of serverProcess.ts's own
  // start/stop/kill already proven extensively on the ARK side.
  'minecraft.server.start': (params) => {
    const profile = getMinecraftProfile((params as { profileId: string }).profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${(params as { profileId: string }).profileId}`)
    return doStartMinecraftServer(profile)
  },
  'minecraft.server.stop': (params) => {
    const profile = getMinecraftProfile((params as { profileId: string }).profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${(params as { profileId: string }).profileId}`)
    return doStopMinecraftServer(profile)
  },
  'minecraft.server.kill': (params) => {
    const profile = getMinecraftProfile((params as { profileId: string }).profileId)
    if (!profile) throw new Error(`Unknown Minecraft profile: ${(params as { profileId: string }).profileId}`)
    return doKillMinecraftServer(profile)
  },
  // Real, unmodified detectMinecraftProfile()/isValidMinecraftInstall() - backs the Minecraft
  // Dashboard's own "Import existing server" button, mirroring ipc/minecraft.ts's own handler
  // exactly (including its real validation error message).
  'minecraft.profiles.importFromInstall': (params) => {
    const { installDir } = params as { installDir: string }
    if (!isValidMinecraftInstall(installDir)) {
      throw new Error(
        'This folder does not look like a set-up Minecraft server (no server.properties, eula.txt, jar, or launch script found).'
      )
    }
    return detectMinecraftProfile(installDir)
  },
  // First real piece of MIGRATION-PLAN.md's data-migration gap: finding and importing a real
  // user's existing Electron install data into this Tauri shell's own store - see
  // legacyImport.ts's own top comment for why "detect" checks two candidate folders instead of
  // asserting one exact path.
  'legacyImport.detect': () => detectLegacyCandidates(),
  'legacyImport.preview': (params) => previewLegacyImport((params as { path: string }).path),
  'legacyImport.run': (params) => runLegacyImport((params as { path: string }).path),
  // Real, unmodified isValidArkInstall() - backs App.tsx's own direct window.api.server
  // .isInstalled call (not a per-page wrapper's own concern, App.tsx uses it itself to compute
  // installedById before ever rendering Dashboard.tsx), the same real check the ARK ipc
  // handler's own serverIsInstalled uses.
  'server.isInstalled': async (params) => {
    const { profileId } = params as { profileId: string }
    const profile = getProfile(profileId)
    if (!profile) throw new Error(`Unknown profile: ${profileId}`)
    return isValidArkInstall(profile.installDir, profile.game)
  },
  // Real, unmodified isStartupComplete() - the other call App.tsx makes directly. This sidecar
  // has no multi-step boot chain to match main/index.ts's own real sequence (re-attach
  // processes, start the web dashboard, arm the scheduler, auto-start servers...) - it marks
  // its own startup complete right after its own init finishes (see the bottom of this file),
  // an honest PoC-appropriate stand-in for "the real app has finished booting", not a replica
  // of every real step that leads there.
  'appStartup.isComplete': () => isStartupComplete()
}

let stopConsoleWatch: (() => void) | null = null
let stopGroupConsoleWatch: (() => void) | null = null

// Tauri's own event names only accept alphanumerics, '-', '/', ':', '_' - found by actually
// running this against a real Tauri app.emit() call, not from reading the docs - 'profiles-
// changed' here, not 'profiles.changed' matching the RPC method naming below. Same for
// 'manager-log-entry' vs. the real app's own 'log' event name on managerLogEvents.
profileEvents.on('changed', (profiles) => send({ event: 'profiles-changed', data: profiles }))
// An eighth: store.ts's own `minecraftProfileEvents` - the Minecraft-side twin of
// `profileEvents` above, same real EventEmitter.on module-level subscription shape.
minecraftProfileEvents.on('changed', (profiles) => send({ event: 'minecraft-profiles-changed', data: profiles }))
// A ninth and tenth: lib/minecraftProcess.ts's own `minecraftServerEvents`/
// `minecraftConsoleEvents` - the Minecraft-side twins of serverEvents/console-line above, same
// real module-level EventEmitter.on subscription shape.
minecraftServerEvents.on('status', (status) => send({ event: 'minecraft-server-status', data: status }))
minecraftConsoleEvents.on('line', (profileId: string, line) =>
  send({ event: 'minecraft-console-line', data: { profileId, line } })
)
// An eleventh: lib/minecraftBackup.ts's own `minecraftBackupEvents` - the Minecraft-side twin
// of backupEvents's own 'log' emitter below, same real module-level EventEmitter.on shape.
minecraftBackupEvents.on('log', (profileId: string, entry) =>
  send({ event: 'minecraft-backup-log-entry', data: { profileId, entry } })
)
minecraftBackupEvents.on('created', (profileId: string) => send({ event: 'minecraft-backup-created', data: profileId }))
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
// App.tsx's own window.api.appStartup.onComplete subscription - real startupStatusEvents,
// fires once (markStartupComplete() itself is idempotent/no-op past the first call, same real
// guard the real main/index.ts relies on).
startupStatusEvents.once('complete', () => send({ event: 'app-startup-complete', data: true }))
// A sixth: lib/steamcmd.ts's own `steamcmdUpdateEvents` - backs UpdateLogTab.tsx's
// window.api.steamcmd.onUpdateLogChanged, the same "module-level EventEmitter.on
// subscription, no explicit arm call needed" shape as every push source above except
// lib/schedule.ts's own (see registerBackupScheduleWatcher below).
steamcmdUpdateEvents.on('log', (profileId: string) => send({ event: 'steamcmd-update-log-changed', data: profileId }))
// lib/appUpdater.ts's own `appUpdateEvents` used to be forwarded from here too, the same
// module-level EventEmitter.on shape as every push source above - removed along with the
// appUpdate.* RPC handlers themselves (see this file's own comment where they used to be):
// main.rs now pushes 'app-update-status-changed' directly from its own tauri-plugin-updater
// integration, with nothing left for the sidecar to forward.

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
// Real, unmodified registerServerVersionWatcher() - real report: Dashboard cards' version
// label got cached once (the first server.getGameVersion call, cache-then-live-read - see that
// RPC handler's own comment) and then never again, so updating a server to a new game version
// left the card showing the old one forever. The real index.ts registers this BEFORE adoption
// below, specifically so it still catches the running-status broadcast adoptPersistedProcesses
// itself emits for an already-running adopted server, not just a fresh start/stop/update -
// mirrored here in the same order.
registerServerVersionWatcher()

adoptPersistedProcesses(listProfiles(), getRunningPids(), getRunningStartedAt())

// Real, unmodified checkAllGameVersionsOnStartup() - same real index.ts ordering, right after
// adoption: every profile, not just running ones, so a stopped server's log from its last run
// shows a version immediately instead of waiting for its next start.
checkAllGameVersionsOnStartup(listProfiles())

// Real, unmodified registerBackupScheduleWatcher() - unlike profileEvents/managerLogEvents/
// serverEvents above, lib/schedule.ts's own serverEvents.on('status', ...) subscription is
// NOT a module-load side effect; it only happens once this function is actually called, the
// same real index.ts startup-order requirement as adoptPersistedProcesses just above. Found
// the hard way: importing getBackupScheduleStatus alone left it permanently reporting
// { active: false }, even with a running server and a real cron schedule saved, because
// nothing had ever subscribed it to real status transitions.
registerBackupScheduleWatcher()

// Real, unmodified applyWebDashboardSettings(getSettings()) - the real index.ts's own startup
// call (same file, same shape as adoptPersistedProcesses/registerBackupScheduleWatcher above),
// missing from this sidecar until a real report: webDashboardEnabled saved in settings had no
// effect on launch - the dashboard only ever started if something explicitly called
// dashboard.start (the index.html demo button, or the Settings UI's own save handler, which
// already calls this for a live toggle - see 'dashboard.start' above). Without this one-time
// startup call, a profile saved with the toggle already on stayed off every time the sidecar
// itself restarted, exactly the "doesn't start when the manager starts" gap reported.
applyWebDashboardSettings(getSettings())

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

// Real markStartupComplete() - see this file's own 'appStartup.isComplete' comment for why
// this fires right after this sidecar's own init finishes rather than replicating every real
// step of main/index.ts's own boot chain.
markStartupComplete()

// Tells the Rust side the sidecar is up and its stdio pipes are ready to receive requests -
// spawning a child process and it actually being ready to read stdin aren't the same instant.
console.error('sidecar: ready')
