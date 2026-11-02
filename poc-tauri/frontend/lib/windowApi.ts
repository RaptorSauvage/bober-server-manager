/**
 * The real fix MIGRATION-PLAN.md's section 1 calls for: ONE complete `window.api` bridge,
 * built once here, instead of the ~36 partial per-page unions every earlier entry file in this
 * PoC hand-rolled (each one correct for the one real page it mounted, but never meant to be the
 * app's actual bridge). This file is the union of every one of those - mechanically merged, not
 * re-derived - plus the two calls only `App.tsx` itself makes directly
 * (`server.isInstalled`/`appStartup.*`), which no single-page entry ever needed.
 *
 * `installWindowApi()` must run after `window.__TAURI__` exists (so after Tauri's own injected
 * init script, same ordering every earlier entry already relied on) and before the real
 * `App.tsx` (or any real page it renders) touches `window.api` - call it once, synchronously,
 * at the top of whatever mounts `App.tsx`.
 */
import type {
  AppSettings,
  AppUpdateStatus,
  ArkModInfoMap,
  ArkModSearchResult,
  BackupEntry,
  BackupLogEntry,
  BackupScheduleStatus,
  BannedPlayer,
  ClusterImportResult,
  ConfigFileHistorySummary,
  FileBrowserEntry,
  GroupConsoleEvent,
  IniTemplateApplyResult,
  IniTemplateContent,
  IniTemplateProfileOverride,
  LatestBuildIdCache,
  ManagerLogEntry,
  MapDefinition,
  MapFolderEntry,
  ModEvent,
  ModEventHistoryEntry,
  NetworkUsage,
  PlayerActivityRecord,
  PlayerActivitySession,
  PlayerBackupFolder,
  PlayerRosterEntry,
  RconResult,
  ServerMod,
  ServerProfile,
  ServerStatus,
  StatSample,
  SystemStaticInfo,
  WatchedPlayerAlert,
  WebDashboardAccessTokenSummary,
  WebDashboardApiKeySummary,
  WebDashboardRole,
  WhitelistedPlayer
} from '../../shared/types'
import type { MinecraftConsoleLine, MinecraftProfile, MinecraftPropertiesData, MinecraftServerStatus } from '../../shared/minecraft'
import type {
  MinecraftModEcosystem,
  MinecraftModInstallResult,
  MinecraftModScanResult,
  MinecraftModSearchResult,
  MinecraftModSource,
  MinecraftModUpdateCheckResult
} from '../../shared/minecraftMods'
import type { MinecraftInstallParams, MinecraftInstallResult, MinecraftInstallableType, MinecraftVersionOption } from '../../shared/minecraftInstall'
import type { DiffLine } from '../../shared/textDiff'
import type { GameId } from '../../shared/games'
import { wrapInvoke } from './tauriInvoke'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
      event: {
        listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>
      }
    }
    api: {
      settings: {
        get: () => Promise<AppSettings>
        save: (settings: AppSettings) => Promise<AppSettings>
      }
      profiles: {
        list: () => Promise<ServerProfile[]>
        save: (profile: ServerProfile) => Promise<ServerProfile[]>
        delete: (id: string) => Promise<ServerProfile[]>
        reorder: (orderedIds: string[]) => Promise<ServerProfile[]>
        copy: (profileId: string, destInstallDir: string, newName: string) => Promise<{ profile: ServerProfile; profiles: ServerProfile[] }>
        move: (profileId: string, destInstallDir: string, newName: string) => Promise<{ profile: ServerProfile; profiles: ServerProfile[] }>
        export: (profileId: string, filePath: string) => Promise<void>
        importFromFile: (filePath: string) => Promise<{ profile: ServerProfile; profiles: ServerProfile[] }>
        onChanged: (callback: (profiles: ServerProfile[]) => void) => () => void
      }
      server: {
        start: (profileId: string) => Promise<ServerStatus>
        stop: (profileId: string) => Promise<ServerStatus>
        restart: (profileId: string) => Promise<ServerStatus>
        kill: (profileId: string) => Promise<ServerStatus>
        update: (profileId: string) => Promise<void>
        status: (profileId: string) => Promise<ServerStatus>
        onStatusChanged: (callback: (status: ServerStatus) => void) => () => void
        getInstalledBuildId: (profileId: string) => Promise<string | null>
        getGameVersion: (profileId: string) => Promise<string | null>
        previewLaunchCommand: (profile: ServerProfile) => Promise<{ executable: string; args: string[] }>
        isInstalled: (profileId: string) => Promise<boolean>
      }
      systemStats: {
        getNetworkUsage: () => Promise<NetworkUsage>
        getStaticInfo: () => Promise<SystemStaticInfo>
        get: () => Promise<SystemStaticInfo>
      }
      backup: {
        create: (profileId: string) => Promise<BackupEntry>
        list: (profileId: string) => Promise<BackupEntry[]>
        delete: (filePath: string) => Promise<void>
        restore: (profileId: string, filePath: string) => Promise<void>
        openFolder: (profileId: string) => Promise<void>
        onCreated: (callback: (profileId: string) => void) => () => void
        getLog: (profileId: string) => Promise<BackupLogEntry[]>
        onLogChanged: (callback: (profileId: string, entry: BackupLogEntry) => void) => () => void
        getScheduleStatus: (profileId: string) => Promise<BackupScheduleStatus>
      }
      playerBackup: {
        listFolders: (profileId: string) => Promise<PlayerBackupFolder[]>
        list: (profileId: string, folderKey: string) => Promise<BackupEntry[]>
        openFolder: (profileId: string, folderKey: string) => Promise<void>
      }
      statsHistory: {
        get: (profileId: string, sinceMs: number, maxPoints: number) => Promise<StatSample[]>
        getForGroups: (groupProfileIds: string[], sinceMs: number, maxPoints: number) => Promise<Record<string, StatSample[]>>
      }
      system: {
        openServerConfigFolder: (profileId: string) => Promise<void>
        openServerSavedArksFolder: (profileId: string) => Promise<void>
        openServerSaveGamesFolder: (profileId: string) => Promise<void>
        openDataDirFolder: () => Promise<void>
        openProfilesFolder: () => Promise<void>
        focusWindow: () => Promise<void>
        quit: () => Promise<void>
        openDevTools: () => Promise<void>
      }
      windowControls: {
        minimize: () => Promise<void>
        toggleMaximize: () => Promise<void>
        close: () => Promise<void>
        isMaximized: () => Promise<boolean>
        onMaximizedChange: (callback: (maximized: boolean) => void) => () => void
      }
      steamcmd: {
        getLatestBuildId: (game: GameId, branch?: string) => Promise<LatestBuildIdCache>
        managedStatus: () => Promise<string | null>
        install: () => Promise<string>
        addFirewallRule: (steamCmdPath: string) => Promise<void>
        getUpdateLog: (profileId: string) => Promise<string | null>
        onUpdateLogChanged: (callback: (log: string) => void) => () => void
      }
      dialog: {
        selectDirectory: () => Promise<string | null>
        selectFile: () => Promise<string | null>
        selectIniFile: () => Promise<string | null>
        selectProfileFile: () => Promise<string | null>
        saveProfileFile: (defaultName: string) => Promise<string | null>
        saveClusterBundleFile: () => Promise<string | null>
        selectClusterBundleFile: () => Promise<string | null>
      }
      mods: {
        save: (profileId: string, mods: ServerMod[]) => Promise<ServerProfile>
        parseText: (text: string) => Promise<ServerMod[]>
        reconcileFromIni: (profileId: string) => Promise<ServerProfile>
      }
      arkMods: {
        search: (query: string) => Promise<ArkModSearchResult[]>
        info: (modIds: string[]) => Promise<ArkModInfoMap>
      }
      mapManagement: {
        list: (profileId: string) => Promise<MapFolderEntry[]>
        create: (profileId: string, folderName: string, fileName: string) => Promise<void>
        delete: (profileId: string, folderName: string) => Promise<void>
        openFolder: (profileId: string, folderName: string) => Promise<void>
      }
      maps: {
        list: (game: GameId) => Promise<MapDefinition[]>
      }
      customMaps: {
        list: () => Promise<MapDefinition[]>
        add: (entry: MapDefinition) => Promise<MapDefinition[]>
        update: (originalId: string, entry: MapDefinition) => Promise<MapDefinition[]>
        delete: (id: string) => Promise<MapDefinition[]>
      }
      fileBrowser: {
        list: (profileId: string, relativePath: string) => Promise<{ path: string; entries: FileBrowserEntry[] }>
        open: (profileId: string, relativePath: string) => Promise<void>
        delete: (profileId: string, relativePath: string) => Promise<void>
        readIni: (profileId: string, relativePath: string) => Promise<string>
        writeIni: (profileId: string, relativePath: string, content: string) => Promise<void>
        iniHistory: (profileId: string, relativePath: string) => Promise<ConfigFileHistorySummary[]>
        iniHistoryDiff: (profileId: string, entryId: string) => Promise<DiffLine[]>
        iniRestore: (profileId: string, entryId: string) => Promise<void>
      }
      groupConsole: {
        subscribe: (profileIds: string[]) => Promise<GroupConsoleEvent[]>
        unsubscribe: () => Promise<void>
        onEvent: (callback: (event: GroupConsoleEvent) => void) => () => void
        sendRcon: (profileId: string, command: string) => Promise<RconResult>
      }
      iniTemplates: {
        getGeneric: () => Promise<IniTemplateContent>
        saveGeneric: (content: IniTemplateContent) => Promise<IniTemplateContent>
        getOverride: (profileId: string) => Promise<IniTemplateProfileOverride | null>
        saveOverride: (override: IniTemplateProfileOverride) => Promise<IniTemplateProfileOverride[]>
        deleteOverride: (profileId: string) => Promise<IniTemplateProfileOverride[]>
        apply: (profileId: string) => Promise<void>
        applyAll: () => Promise<IniTemplateApplyResult[]>
        readFile: (filePath: string) => Promise<string>
      }
      modEvents: {
        list: () => Promise<ModEvent[]>
        save: (event: ModEvent) => Promise<ModEvent[]>
        delete: (id: string) => Promise<ModEvent[]>
        history: () => Promise<ModEventHistoryEntry[]>
      }
      watchedPlayers: {
        list: () => Promise<WatchedPlayerAlert[]>
        add: (value: string, label: string) => Promise<WatchedPlayerAlert[]>
        remove: (id: string) => Promise<WatchedPlayerAlert[]>
      }
      playerActivity: {
        list: () => Promise<PlayerActivityRecord[]>
        sessions: () => Promise<PlayerActivitySession[]>
      }
      playerBans: {
        list: () => Promise<BannedPlayer[]>
        ban: (profileId: string, playerId: string, playerName: string, reason: string) => Promise<BannedPlayer[]>
        unban: (profileId: string, playerId: string) => Promise<BannedPlayer[]>
      }
      playerRoster: {
        list: (profileId: string) => Promise<PlayerRosterEntry[]>
        kick: (profileId: string, playerId: string) => Promise<void>
      }
      playerWhitelist: {
        list: () => Promise<WhitelistedPlayer[]>
        add: (profileId: string, playerId: string, playerName: string) => Promise<WhitelistedPlayer[]>
        remove: (profileId: string, playerId: string) => Promise<WhitelistedPlayer[]>
      }
      managerLog: {
        getLog: () => Promise<ManagerLogEntry[]>
        onLogChanged: (callback: (entry: ManagerLogEntry) => void) => () => void
      }
      dataDir: {
        getDefault: () => Promise<string>
      }
      webDashboard: {
        getStatus: () => Promise<{ running: boolean; error: string | null; host: string | null }>
        getLocalIps: () => Promise<string[]>
      }
      webDashboardAccessTokens: {
        list: () => Promise<WebDashboardAccessTokenSummary[]>
        create: (label: string, role: WebDashboardRole, profileIds: string[] | null) => Promise<{ token: string; tokens: WebDashboardAccessTokenSummary[] }>
        update: (id: string, updates: Partial<WebDashboardAccessTokenSummary>) => Promise<WebDashboardAccessTokenSummary[]>
        delete: (id: string) => Promise<WebDashboardAccessTokenSummary[]>
      }
      webDashboardApiKeys: {
        list: () => Promise<WebDashboardApiKeySummary[]>
        create: (label: string, role: WebDashboardRole) => Promise<{ key: string; keys: WebDashboardApiKeySummary[] }>
        update: (id: string, updates: Partial<WebDashboardApiKeySummary>) => Promise<WebDashboardApiKeySummary[]>
        delete: (id: string) => Promise<WebDashboardApiKeySummary[]>
      }
      appUpdate: {
        getVersion: () => Promise<string>
        getStatus: () => Promise<AppUpdateStatus>
        onStatusChanged: (callback: (status: AppUpdateStatus) => void) => () => void
        check: () => Promise<void>
        install: () => Promise<void>
      }
      discordBot: {
        status: () => Promise<{ running: boolean; error: string | null }>
        restart: () => Promise<{ running: boolean; error: string | null }>
        stop: () => Promise<{ running: boolean; error: string | null }>
      }
      cluster: {
        export: (filePath: string) => Promise<void>
        import: (filePath: string, options: { includeSettings: boolean }) => Promise<ClusterImportResult>
      }
      appStartup: {
        isComplete: () => Promise<boolean>
        onComplete: (callback: () => void) => () => void
      }
      minecraft: {
        profiles: {
          list: () => Promise<MinecraftProfile[]>
          save: (profile: MinecraftProfile) => Promise<MinecraftProfile[]>
          delete: (id: string) => Promise<MinecraftProfile[]>
          importFromInstall: (installDir: string) => Promise<MinecraftProfile>
          onChanged: (callback: (profiles: MinecraftProfile[]) => void) => () => void
        }
        openServerFolder: (profileId: string) => Promise<void>
        detectLaunchable: (installDir: string) => Promise<{
          launchMode: 'jar' | 'script'
          jarFileName: string
          scriptFileName: string
          serverType: MinecraftProfile['serverType']
        } | null>
        install: {
          listVersions: (serverType: MinecraftInstallableType) => Promise<MinecraftVersionOption[]>
          listLoaderVersions: (serverType: MinecraftInstallableType, minecraftVersion: string) => Promise<MinecraftVersionOption[]>
          run: (params: MinecraftInstallParams) => Promise<MinecraftInstallResult>
        }
        properties: {
          get: (profileId: string) => Promise<MinecraftPropertiesData>
          save: (profileId: string, updates: Record<string, string>) => Promise<MinecraftPropertiesData>
        }
        server: {
          start: (profileId: string) => Promise<MinecraftServerStatus>
          stop: (profileId: string) => Promise<MinecraftServerStatus>
          kill: (profileId: string) => Promise<MinecraftServerStatus>
          getStatus: (profileId: string) => Promise<MinecraftServerStatus>
          onStatusChanged: (callback: (status: MinecraftServerStatus) => void) => () => void
          sendCommand: (profileId: string, command: string) => Promise<RconResult>
        }
        console: {
          getBacklog: (profileId: string) => Promise<MinecraftConsoleLine[]>
          onLine: (callback: (profileId: string, line: MinecraftConsoleLine) => void) => () => void
        }
        backup: {
          create: (profileId: string) => Promise<BackupEntry>
          list: (profileId: string) => Promise<BackupEntry[]>
          delete: (filePath: string) => Promise<void>
          restore: (profileId: string, filePath: string) => Promise<void>
          openFolder: (profileId: string) => Promise<void>
          onCreated: (callback: (profileId: string) => void) => () => void
          getLog: (profileId: string) => Promise<BackupLogEntry[]>
          onLogChanged: (callback: (profileId: string, entry: BackupLogEntry) => void) => () => void
        }
        mods: {
          search: (profileId: string, query: string, ecosystem: MinecraftModEcosystem) => Promise<MinecraftModSearchResult[]>
          install: (
            profileId: string,
            source: MinecraftModSource,
            projectId: string,
            ecosystem: MinecraftModEcosystem
          ) => Promise<{ profile: MinecraftProfile; result: MinecraftModInstallResult }>
          remove: (profileId: string, projectId: string) => Promise<MinecraftProfile>
          setEnabled: (profileId: string, projectId: string, enabled: boolean) => Promise<MinecraftProfile>
          checkUpdates: (profileId: string) => Promise<MinecraftModUpdateCheckResult[]>
          update: (profileId: string, source: MinecraftModSource, projectId: string) => Promise<{ profile: MinecraftProfile; result: MinecraftModInstallResult }>
          scan: (profileId: string) => Promise<{ profile: MinecraftProfile; result: MinecraftModScanResult }>
          openFolder: (profileId: string) => Promise<void>
        }
      }
    }
  }
}

/** Shared by every push-event wrapper below - identical body every per-page entry in this PoC
 *  already duplicated once each; here exactly once. */
function onEvent<T>(listen: Window['__TAURI__']['event']['listen'], event: string, callback: (payload: T) => void): () => void {
  let unlistenFn: (() => void) | null = null
  let cancelled = false
  listen(event, (e) => callback(e.payload as T)).then((unlisten) => {
    if (cancelled) unlisten()
    else unlistenFn = unlisten
  })
  return () => {
    cancelled = true
    unlistenFn?.()
  }
}

export function installWindowApi(): void {
  const invoke = wrapInvoke(window.__TAURI__.core.invoke)
  const { listen } = window.__TAURI__.event
  const on = <T>(event: string, callback: (payload: T) => void) => onEvent<T>(listen, event, callback)

  window.api = {
    settings: {
      get: () => invoke('settings_get') as Promise<AppSettings>,
      save: (settings) => invoke('settings_save', { settings }) as Promise<AppSettings>
    },
    profiles: {
      list: () => invoke('profiles_list') as Promise<ServerProfile[]>,
      save: (profile) => invoke('profiles_save', { profile }) as Promise<ServerProfile[]>,
      delete: (id) => invoke('profiles_delete', { profileId: id }) as Promise<ServerProfile[]>,
      reorder: (orderedIds) => invoke('profiles_reorder', { orderedIds }) as Promise<ServerProfile[]>,
      copy: (profileId, destInstallDir, newName) =>
        invoke('profiles_copy', { profileId, destInstallDir, newName }) as Promise<{ profile: ServerProfile; profiles: ServerProfile[] }>,
      move: (profileId, destInstallDir, newName) =>
        invoke('profiles_move', { profileId, destInstallDir, newName }) as Promise<{ profile: ServerProfile; profiles: ServerProfile[] }>,
      export: (profileId, filePath) => invoke('profiles_export', { profileId, filePath }) as Promise<void>,
      importFromFile: (filePath) =>
        invoke('profiles_import_from_file', { filePath }) as Promise<{ profile: ServerProfile; profiles: ServerProfile[] }>,
      onChanged: (callback) => on('profiles-changed', callback)
    },
    server: {
      start: (profileId) => invoke('server_start', { profileId }) as Promise<ServerStatus>,
      stop: (profileId) => invoke('server_stop', { profileId }) as Promise<ServerStatus>,
      restart: (profileId) => invoke('server_restart', { profileId }) as Promise<ServerStatus>,
      kill: (profileId) => invoke('server_kill', { profileId }) as Promise<ServerStatus>,
      update: (profileId) => invoke('server_update', { profileId }) as Promise<void>,
      status: (profileId) => invoke('server_status', { profileId }) as Promise<ServerStatus>,
      onStatusChanged: (callback) => on('server-status', callback),
      getInstalledBuildId: (profileId) => invoke('server_get_installed_build_id', { profileId }) as Promise<string | null>,
      getGameVersion: (profileId) => invoke('server_get_game_version', { profileId }) as Promise<string | null>,
      previewLaunchCommand: (profile) => invoke('server_preview_launch_command', { profile }) as Promise<{ executable: string; args: string[] }>,
      isInstalled: (profileId) => invoke('server_is_installed', { profileId }) as Promise<boolean>
    },
    systemStats: {
      getNetworkUsage: () => invoke('system_stats_get_network_usage') as Promise<NetworkUsage>,
      getStaticInfo: () => invoke('system_stats_get_static_info') as Promise<SystemStaticInfo>,
      // Real App.tsx itself calls window.api.systemStats.get(), a separate IPC channel name
      // (IPC.systemStatsGet) from getStaticInfo()'s own - but the real main-process handler for
      // both is the exact same getSystemStaticInfo() (see src/main/ipc/systemStats.ts), a
      // naming inconsistency already present in the real app, not introduced here. Reuses the
      // same Tauri command rather than adding a redundant one.
      get: () => invoke('system_stats_get_static_info') as Promise<SystemStaticInfo>
    },
    backup: {
      create: (profileId) => invoke('backup_create', { profileId }) as Promise<BackupEntry>,
      list: (profileId) => invoke('backup_list', { profileId }) as Promise<BackupEntry[]>,
      delete: (filePath) => invoke('backup_delete', { filePath }) as Promise<void>,
      restore: (profileId, filePath) => invoke('backup_restore', { profileId, filePath }) as Promise<void>,
      openFolder: (profileId) => invoke('backup_open_folder', { profileId }) as Promise<void>,
      onCreated: (callback) => on<string>('backup-created', callback),
      getLog: (profileId) => invoke('backup_get_log', { profileId }) as Promise<BackupLogEntry[]>,
      onLogChanged: (callback) =>
        on<{ profileId: string; entry: BackupLogEntry }>('backup-log-entry', ({ profileId, entry }) => callback(profileId, entry)),
      getScheduleStatus: (profileId) => invoke('backup_get_schedule_status', { profileId }) as Promise<BackupScheduleStatus>
    },
    playerBackup: {
      listFolders: (profileId) => invoke('player_backup_list_folders', { profileId }) as Promise<PlayerBackupFolder[]>,
      list: (profileId, folderKey) => invoke('player_backup_list', { profileId, folderKey }) as Promise<BackupEntry[]>,
      openFolder: (profileId, folderKey) => invoke('player_backup_open_folder', { profileId, folderKey }) as Promise<void>
    },
    statsHistory: {
      get: (profileId, sinceMs, maxPoints) => invoke('stats_history_get', { profileId, sinceMs, maxPoints }) as Promise<StatSample[]>,
      getForGroups: (groupProfileIds, sinceMs, maxPoints) =>
        invoke('stats_history_get_for_groups', { groupProfileIds, sinceMs, maxPoints }) as Promise<Record<string, StatSample[]>>
    },
    system: {
      openServerConfigFolder: (profileId) => invoke('system_open_server_config_folder', { profileId }) as Promise<void>,
      openServerSavedArksFolder: (profileId) => invoke('system_open_server_saved_arks_folder', { profileId }) as Promise<void>,
      openServerSaveGamesFolder: (profileId) => invoke('system_open_server_save_games_folder', { profileId }) as Promise<void>,
      openDataDirFolder: () => invoke('system_open_data_dir_folder') as Promise<void>,
      openProfilesFolder: () => invoke('folders_open_profiles') as Promise<void>,
      focusWindow: () => invoke('window_focus') as Promise<void>,
      quit: () => invoke('app_quit') as Promise<void>,
      openDevTools: () => invoke('app_open_dev_tools') as Promise<void>
    },
    windowControls: {
      minimize: () => invoke('window_minimize') as Promise<void>,
      toggleMaximize: () => invoke('window_toggle_maximize') as Promise<void>,
      close: () => invoke('window_close') as Promise<void>,
      isMaximized: () => invoke('window_is_maximized') as Promise<boolean>,
      onMaximizedChange: (callback) => on<boolean>('window-maximized-changed', callback)
    },
    steamcmd: {
      getLatestBuildId: (game, branch) => invoke('steamcmd_get_latest_build_id', { game, branch }) as Promise<LatestBuildIdCache>,
      managedStatus: () => invoke('steamcmd_managed_status') as Promise<string | null>,
      install: () => invoke('steamcmd_install') as Promise<string>,
      addFirewallRule: (steamCmdPath) => invoke('steamcmd_add_firewall_rule', { steamCmdPath }) as Promise<void>,
      getUpdateLog: (profileId) => invoke('steamcmd_get_update_log', { profileId }) as Promise<string | null>,
      onUpdateLogChanged: (callback) => on<string>('steamcmd-update-log-changed', callback)
    },
    dialog: {
      selectDirectory: () => invoke('dialog_select_directory') as Promise<string | null>,
      selectFile: () => invoke('dialog_select_file') as Promise<string | null>,
      selectIniFile: () => invoke('dialog_select_ini_file') as Promise<string | null>,
      selectProfileFile: () => invoke('dialog_select_profile_file') as Promise<string | null>,
      saveProfileFile: (defaultName) => invoke('dialog_save_profile_file', { defaultName }) as Promise<string | null>,
      saveClusterBundleFile: () => invoke('dialog_save_cluster_bundle_file') as Promise<string | null>,
      selectClusterBundleFile: () => invoke('dialog_select_cluster_bundle_file') as Promise<string | null>
    },
    mods: {
      save: (profileId, mods) => invoke('mods_save', { profileId, mods }) as Promise<ServerProfile>,
      parseText: (text) => invoke('mods_parse_text', { text }) as Promise<ServerMod[]>,
      reconcileFromIni: (profileId) => invoke('mods_reconcile_from_ini', { profileId }) as Promise<ServerProfile>
    },
    arkMods: {
      search: (query) => invoke('ark_mods_search', { query }) as Promise<ArkModSearchResult[]>,
      info: (modIds) => invoke('ark_mods_info', { modIds }) as Promise<ArkModInfoMap>
    },
    mapManagement: {
      list: (profileId) => invoke('map_management_list', { profileId }) as Promise<MapFolderEntry[]>,
      create: (profileId, folderName, fileName) => invoke('map_management_create', { profileId, folderName, fileName }) as Promise<void>,
      delete: (profileId, folderName) => invoke('map_management_delete', { profileId, folderName }) as Promise<void>,
      openFolder: (profileId, folderName) => invoke('map_management_open_folder', { profileId, folderName }) as Promise<void>
    },
    maps: {
      list: (game) => invoke('maps_list', { game }) as Promise<MapDefinition[]>
    },
    customMaps: {
      list: () => invoke('custom_maps_list') as Promise<MapDefinition[]>,
      add: (entry) => invoke('custom_maps_add', { entry }) as Promise<MapDefinition[]>,
      update: (originalId, entry) => invoke('custom_maps_update', { originalId, entry }) as Promise<MapDefinition[]>,
      delete: (id) => invoke('custom_maps_delete', { id }) as Promise<MapDefinition[]>
    },
    fileBrowser: {
      list: (profileId, relativePath) => invoke('file_browser_list', { profileId, relativePath }) as Promise<{ path: string; entries: FileBrowserEntry[] }>,
      open: (profileId, relativePath) => invoke('file_browser_open', { profileId, relativePath }) as Promise<void>,
      delete: (profileId, relativePath) => invoke('file_browser_delete', { profileId, relativePath }) as Promise<void>,
      readIni: (profileId, relativePath) => invoke('file_browser_read_ini', { profileId, relativePath }) as Promise<string>,
      writeIni: (profileId, relativePath, content) => invoke('file_browser_write_ini', { profileId, relativePath, content }) as Promise<void>,
      iniHistory: (profileId, relativePath) => invoke('file_browser_ini_history', { profileId, relativePath }) as Promise<ConfigFileHistorySummary[]>,
      iniHistoryDiff: (profileId, entryId) => invoke('file_browser_ini_history_diff', { profileId, entryId }) as Promise<DiffLine[]>,
      iniRestore: (profileId, entryId) => invoke('file_browser_ini_restore', { profileId, entryId }) as Promise<void>
    },
    groupConsole: {
      subscribe: (profileIds) => invoke('group_console_subscribe', { profileIds }) as Promise<GroupConsoleEvent[]>,
      unsubscribe: () => invoke('group_console_unsubscribe') as Promise<void>,
      onEvent: (callback) => on('group-console-event', callback),
      sendRcon: (profileId, command) => invoke('group_console_rcon_send', { profileId, command }) as Promise<RconResult>
    },
    iniTemplates: {
      getGeneric: () => invoke('ini_templates_get_generic') as Promise<IniTemplateContent>,
      saveGeneric: (content) => invoke('ini_templates_save_generic', { content }) as Promise<IniTemplateContent>,
      getOverride: (profileId) => invoke('ini_templates_get_override', { profileId }) as Promise<IniTemplateProfileOverride | null>,
      saveOverride: (override) => invoke('ini_templates_save_override', { overrideEntry: override }) as Promise<IniTemplateProfileOverride[]>,
      deleteOverride: (profileId) => invoke('ini_templates_delete_override', { profileId }) as Promise<IniTemplateProfileOverride[]>,
      apply: (profileId) => invoke('ini_templates_apply', { profileId }) as Promise<void>,
      applyAll: () => invoke('ini_templates_apply_all') as Promise<IniTemplateApplyResult[]>,
      readFile: (filePath) => invoke('ini_templates_read_file', { filePath }) as Promise<string>
    },
    modEvents: {
      list: () => invoke('mod_events_list') as Promise<ModEvent[]>,
      save: (event) => invoke('mod_events_save', { event }) as Promise<ModEvent[]>,
      delete: (id) => invoke('mod_events_delete', { id }) as Promise<ModEvent[]>,
      history: () => invoke('mod_events_history') as Promise<ModEventHistoryEntry[]>
    },
    watchedPlayers: {
      list: () => invoke('watched_players_list') as Promise<WatchedPlayerAlert[]>,
      add: (value, label) => invoke('watched_players_add', { value, label }) as Promise<WatchedPlayerAlert[]>,
      remove: (id) => invoke('watched_players_remove', { id }) as Promise<WatchedPlayerAlert[]>
    },
    playerActivity: {
      list: () => invoke('player_activity_list') as Promise<PlayerActivityRecord[]>,
      sessions: () => invoke('player_activity_sessions') as Promise<PlayerActivitySession[]>
    },
    playerBans: {
      list: () => invoke('player_bans_list') as Promise<BannedPlayer[]>,
      ban: (profileId, playerId, playerName, reason) =>
        invoke('player_bans_ban', { profileId, playerId, playerName, reason }) as Promise<BannedPlayer[]>,
      unban: (profileId, playerId) => invoke('player_bans_unban', { profileId, playerId }) as Promise<BannedPlayer[]>
    },
    playerRoster: {
      list: (profileId) => invoke('player_roster_list', { profileId }) as Promise<PlayerRosterEntry[]>,
      kick: (profileId, playerId) => invoke('player_roster_kick', { profileId, playerId }) as Promise<void>
    },
    playerWhitelist: {
      list: () => invoke('player_whitelist_list') as Promise<WhitelistedPlayer[]>,
      add: (profileId, playerId, playerName) => invoke('player_whitelist_add', { profileId, playerId, playerName }) as Promise<WhitelistedPlayer[]>,
      remove: (profileId, playerId) => invoke('player_whitelist_remove', { profileId, playerId }) as Promise<WhitelistedPlayer[]>
    },
    managerLog: {
      getLog: () => invoke('manager_log_get_all') as Promise<ManagerLogEntry[]>,
      onLogChanged: (callback) => on<ManagerLogEntry>('manager-log-entry', callback)
    },
    dataDir: {
      getDefault: () => invoke('data_dir_get_default') as Promise<string>
    },
    webDashboard: {
      getStatus: () => invoke('dashboard_status') as Promise<{ running: boolean; error: string | null; host: string | null }>,
      getLocalIps: () => invoke('web_dashboard_get_local_ips') as Promise<string[]>
    },
    webDashboardAccessTokens: {
      list: () => invoke('web_dashboard_access_tokens_list') as Promise<WebDashboardAccessTokenSummary[]>,
      create: (label, role, profileIds) =>
        invoke('web_dashboard_access_tokens_create', { label, role, profileIds }) as Promise<{ token: string; tokens: WebDashboardAccessTokenSummary[] }>,
      update: (id, updates) => invoke('web_dashboard_access_tokens_update', { id, updates }) as Promise<WebDashboardAccessTokenSummary[]>,
      delete: (id) => invoke('web_dashboard_access_tokens_delete', { id }) as Promise<WebDashboardAccessTokenSummary[]>
    },
    webDashboardApiKeys: {
      list: () => invoke('web_dashboard_api_keys_list') as Promise<WebDashboardApiKeySummary[]>,
      create: (label, role) => invoke('web_dashboard_api_keys_create', { label, role }) as Promise<{ key: string; keys: WebDashboardApiKeySummary[] }>,
      update: (id, updates) => invoke('web_dashboard_api_keys_update', { id, updates }) as Promise<WebDashboardApiKeySummary[]>,
      delete: (id) => invoke('web_dashboard_api_keys_delete', { id }) as Promise<WebDashboardApiKeySummary[]>
    },
    appUpdate: {
      getVersion: () => invoke('app_update_get_version') as Promise<string>,
      getStatus: () => invoke('app_update_status') as Promise<AppUpdateStatus>,
      onStatusChanged: (callback) => on<AppUpdateStatus>('app-update-status-changed', callback),
      check: () => invoke('app_update_check') as Promise<void>,
      install: () => invoke('app_update_install') as Promise<void>
    },
    discordBot: {
      status: () => invoke('discord_bot_status') as Promise<{ running: boolean; error: string | null }>,
      restart: () => invoke('discord_bot_restart') as Promise<{ running: boolean; error: string | null }>,
      stop: () => invoke('discord_bot_stop') as Promise<{ running: boolean; error: string | null }>
    },
    cluster: {
      export: (filePath) => invoke('cluster_export', { filePath }) as Promise<void>,
      import: (filePath, options) => invoke('cluster_import', { filePath, includeSettings: options.includeSettings }) as Promise<ClusterImportResult>
    },
    appStartup: {
      isComplete: () => invoke('app_startup_is_complete') as Promise<boolean>,
      onComplete: (callback) => on('app-startup-complete', () => callback())
    },
    minecraft: {
      profiles: {
        list: () => invoke('minecraft_profiles_list') as Promise<MinecraftProfile[]>,
        save: (profile) => invoke('minecraft_profiles_save', { profile }) as Promise<MinecraftProfile[]>,
        delete: (id) => invoke('minecraft_profiles_delete', { id }) as Promise<MinecraftProfile[]>,
        importFromInstall: (installDir) => invoke('minecraft_profiles_import', { installDir }) as Promise<MinecraftProfile>,
        onChanged: (callback) => on('minecraft-profiles-changed', callback)
      },
      openServerFolder: (profileId) => invoke('minecraft_open_server_folder', { profileId }) as Promise<void>,
      detectLaunchable: (installDir) =>
        invoke('minecraft_detect_launchable', { installDir }) as Promise<{
          launchMode: 'jar' | 'script'
          jarFileName: string
          scriptFileName: string
          serverType: MinecraftProfile['serverType']
        } | null>,
      install: {
        listVersions: (serverType) => invoke('minecraft_install_list_versions', { serverType }) as Promise<MinecraftVersionOption[]>,
        listLoaderVersions: (serverType, minecraftVersion) =>
          invoke('minecraft_install_list_loader_versions', { serverType, minecraftVersion }) as Promise<MinecraftVersionOption[]>,
        run: (params) => invoke('minecraft_install_run', { params }) as Promise<MinecraftInstallResult>
      },
      properties: {
        get: (profileId) => invoke('minecraft_properties_get', { profileId }) as Promise<MinecraftPropertiesData>,
        save: (profileId, updates) => invoke('minecraft_properties_save', { profileId, updates }) as Promise<MinecraftPropertiesData>
      },
      server: {
        start: (profileId) => invoke('minecraft_server_start', { profileId }) as Promise<MinecraftServerStatus>,
        stop: (profileId) => invoke('minecraft_server_stop', { profileId }) as Promise<MinecraftServerStatus>,
        kill: (profileId) => invoke('minecraft_server_kill', { profileId }) as Promise<MinecraftServerStatus>,
        getStatus: (profileId) => invoke('minecraft_server_get_status', { profileId }) as Promise<MinecraftServerStatus>,
        onStatusChanged: (callback) => on<MinecraftServerStatus>('minecraft-server-status', callback),
        sendCommand: (profileId, command) => invoke('minecraft_server_send_command', { profileId, command }) as Promise<RconResult>
      },
      console: {
        getBacklog: (profileId) => invoke('minecraft_console_get_backlog', { profileId }) as Promise<MinecraftConsoleLine[]>,
        onLine: (callback) =>
          on<{ profileId: string; line: MinecraftConsoleLine }>('minecraft-console-line', ({ profileId, line }) => callback(profileId, line))
      },
      backup: {
        create: (profileId) => invoke('minecraft_backup_create', { profileId }) as Promise<BackupEntry>,
        list: (profileId) => invoke('minecraft_backup_list', { profileId }) as Promise<BackupEntry[]>,
        delete: (filePath) => invoke('minecraft_backup_delete', { filePath }) as Promise<void>,
        restore: (profileId, filePath) => invoke('minecraft_backup_restore', { profileId, filePath }) as Promise<void>,
        openFolder: (profileId) => invoke('minecraft_backup_open_folder', { profileId }) as Promise<void>,
        onCreated: (callback) => on<string>('minecraft-backup-created', callback),
        getLog: (profileId) => invoke('minecraft_backup_get_log', { profileId }) as Promise<BackupLogEntry[]>,
        onLogChanged: (callback) =>
          on<{ profileId: string; entry: BackupLogEntry }>('minecraft-backup-log-entry', ({ profileId, entry }) => callback(profileId, entry))
      },
      mods: {
        search: (profileId, query, ecosystem) => invoke('minecraft_mods_search', { profileId, query, ecosystem }) as Promise<MinecraftModSearchResult[]>,
        install: (profileId, source, projectId, ecosystem) =>
          invoke('minecraft_mods_install', { profileId, source, projectId, ecosystem }) as Promise<{
            profile: MinecraftProfile
            result: MinecraftModInstallResult
          }>,
        remove: (profileId, projectId) => invoke('minecraft_mods_remove', { profileId, projectId }) as Promise<MinecraftProfile>,
        setEnabled: (profileId, projectId, enabled) => invoke('minecraft_mods_set_enabled', { profileId, projectId, enabled }) as Promise<MinecraftProfile>,
        checkUpdates: (profileId) => invoke('minecraft_mods_check_updates', { profileId }) as Promise<MinecraftModUpdateCheckResult[]>,
        update: (profileId, source, projectId) =>
          invoke('minecraft_mods_update', { profileId, source, projectId }) as Promise<{
            profile: MinecraftProfile
            result: MinecraftModInstallResult
          }>,
        scan: (profileId) => invoke('minecraft_mods_scan', { profileId }) as Promise<{ profile: MinecraftProfile; result: MinecraftModScanResult }>,
        openFolder: (profileId) => invoke('minecraft_mods_open_folder', { profileId }) as Promise<void>
      }
    }
  }
}
