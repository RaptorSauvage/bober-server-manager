/**
 * Mounts the REAL, completely unmodified src/renderer/src/pages/ServerDetail/index.tsx - a
 * twenty-fifth real page, and the first one with NO new real backend surface at all: every tab
 * it renders (AnalyticsTab, ModsTab, BackupsTab, SettingsTab, ServerManagementTab,
 * MapManagementTab, UpdateLogTab, FilesTab) is already individually proven by an earlier round
 * (analytics-entry.tsx, mods-entry.tsx, backups-entry.tsx, settings-entry.tsx,
 * server-management-entry.tsx, map-management-entry.tsx, update-log-entry.tsx,
 * files-entry.tsx) - same shape as "An eighteenth real page" (PlayersView.tsx, a pure frontend
 * composition of four already-proven pages), just a wider union (eight) this time. The only
 * genuinely new thing this round proves is that the real tab-switching shell itself - the left
 * nav, the `tab` state, mounting/unmounting each real child component on click - works
 * unmodified against this architecture, with every already-proven window.api method reachable
 * from inside it exactly as it was standalone.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import ServerDetail from '../../src/renderer/src/pages/ServerDetail'
import { wrapInvoke } from './lib/tauriInvoke'
import type {
  AppSettings,
  ArkModInfoMap,
  ArkModSearchResult,
  BackupEntry,
  BackupLogEntry,
  BackupScheduleStatus,
  ConfigFileHistorySummary,
  DiffLine,
  FileBrowserEntry,
  LatestBuildIdCache,
  MapDefinition,
  MapFolderEntry,
  PlayerBackupFolder,
  ServerMod,
  ServerProfile,
  ServerStatus,
  StatSample
} from '../../shared/types'
import type { GameId } from '../../shared/games'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
      event: {
        listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>
      }
    }
    api: {
      system: {
        focusWindow: () => Promise<void>
        openServerConfigFolder: (profileId: string) => Promise<void>
        openServerSavedArksFolder: (profileId: string) => Promise<void>
        openServerSaveGamesFolder: (profileId: string) => Promise<void>
        openDataDirFolder: () => Promise<void>
      }
      profiles: {
        save: (profile: ServerProfile) => Promise<ServerProfile[]>
        export: (profileId: string, filePath: string) => Promise<void>
      }
      dialog: {
        selectDirectory: () => Promise<string | null>
        saveProfileFile: (defaultName: string) => Promise<string | null>
      }
      server: {
        status: (profileId: string) => Promise<ServerStatus>
        onStatusChanged: (callback: (status: ServerStatus) => void) => () => void
        getInstalledBuildId: (profileId: string) => Promise<string | null>
        getGameVersion: (profileId: string) => Promise<string | null>
        previewLaunchCommand: (profile: ServerProfile) => Promise<{ executable: string; args: string[] }>
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
        get: (profileId: string, sinceMs: number | null, maxPoints?: number) => Promise<StatSample[]>
      }
      steamcmd: {
        getLatestBuildId: (game: string, branch?: string) => Promise<LatestBuildIdCache>
        getUpdateLog: (profileId: string) => Promise<string | null>
        onUpdateLogChanged: (callback: (profileId: string) => void) => () => void
      }
      groupConsole: {
        sendRcon: (profileId: string, command: string) => Promise<{ ok: boolean; response?: string; error?: string }>
      }
      mapManagement: {
        list: (profileId: string) => Promise<MapFolderEntry[]>
        create: (profileId: string, folderName: string, fileName: string) => Promise<void>
        delete: (profileId: string, folderName: string) => Promise<void>
        openFolder: (profileId: string, folderName: string) => Promise<void>
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
      settings: {
        get: () => Promise<AppSettings>
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
      maps: {
        list: (game: GameId) => Promise<MapDefinition[]>
      }
      customMaps: {
        list: () => Promise<MapDefinition[]>
      }
    }
  }
}

const invoke = wrapInvoke(window.__TAURI__.core.invoke)
const { listen } = window.__TAURI__.event

// Same "listen, buffer cancellation, return an unlisten fn" shape as every other push-backed
// window.api method in this PoC - see manager-log-entry.tsx's own comment on why the
// cancelled/unlistenFn dance is needed (listen() resolves asynchronously, after a caller may
// have already unmounted).
function onEvent<T>(event: string, callback: (payload: T) => void): () => void {
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

window.api = {
  system: {
    focusWindow: () => invoke('window_focus') as Promise<void>,
    openServerConfigFolder: (profileId) => invoke('system_open_server_config_folder', { profileId }) as Promise<void>,
    openServerSavedArksFolder: (profileId) =>
      invoke('system_open_server_saved_arks_folder', { profileId }) as Promise<void>,
    openServerSaveGamesFolder: (profileId) =>
      invoke('system_open_server_save_games_folder', { profileId }) as Promise<void>,
    openDataDirFolder: () => invoke('system_open_data_dir_folder') as Promise<void>
  },
  profiles: {
    save: (profile) => invoke('profiles_save', { profile }) as Promise<ServerProfile[]>,
    export: (profileId, filePath) => invoke('profiles_export', { profileId, filePath }) as Promise<void>
  },
  dialog: {
    selectDirectory: () => invoke('dialog_select_directory') as Promise<string | null>,
    saveProfileFile: (defaultName) => invoke('dialog_save_profile_file', { defaultName }) as Promise<string | null>
  },
  server: {
    status: (profileId) => invoke('server_status', { profileId }) as Promise<ServerStatus>,
    onStatusChanged: (callback) => onEvent('server-status', callback),
    getInstalledBuildId: (profileId) =>
      invoke('server_get_installed_build_id', { profileId }) as Promise<string | null>,
    getGameVersion: (profileId) => invoke('server_get_game_version', { profileId }) as Promise<string | null>,
    previewLaunchCommand: (profile) =>
      invoke('server_preview_launch_command', { profile }) as Promise<{ executable: string; args: string[] }>
  },
  backup: {
    create: (profileId) => invoke('backup_create', { profileId }) as Promise<BackupEntry>,
    list: (profileId) => invoke('backup_list', { profileId }) as Promise<BackupEntry[]>,
    delete: (filePath) => invoke('backup_delete', { filePath }) as Promise<void>,
    restore: (profileId, filePath) => invoke('backup_restore', { profileId, filePath }) as Promise<void>,
    openFolder: (profileId) => invoke('backup_open_folder', { profileId }) as Promise<void>,
    onCreated: (callback) => onEvent<string>('backup-created', callback),
    getLog: (profileId) => invoke('backup_get_log', { profileId }) as Promise<BackupLogEntry[]>,
    onLogChanged: (callback) =>
      onEvent<{ profileId: string; entry: BackupLogEntry }>('backup-log-entry', ({ profileId, entry }) =>
        callback(profileId, entry)
      ),
    getScheduleStatus: (profileId) =>
      invoke('backup_get_schedule_status', { profileId }) as Promise<BackupScheduleStatus>
  },
  playerBackup: {
    listFolders: (profileId) => invoke('player_backup_list_folders', { profileId }) as Promise<PlayerBackupFolder[]>,
    list: (profileId, folderKey) => invoke('player_backup_list', { profileId, folderKey }) as Promise<BackupEntry[]>,
    openFolder: (profileId, folderKey) =>
      invoke('player_backup_open_folder', { profileId, folderKey }) as Promise<void>
  },
  statsHistory: {
    get: (profileId, sinceMs, maxPoints) =>
      invoke('stats_history_get', { profileId, sinceMs, maxPoints }) as Promise<StatSample[]>
  },
  steamcmd: {
    getLatestBuildId: (game, branch) =>
      invoke('steamcmd_get_latest_build_id', { game, branch }) as Promise<LatestBuildIdCache>,
    getUpdateLog: (profileId) => invoke('steamcmd_get_update_log', { profileId }) as Promise<string | null>,
    onUpdateLogChanged: (callback) => onEvent<string>('steamcmd-update-log-changed', callback)
  },
  groupConsole: {
    sendRcon: (profileId, command) =>
      invoke('group_console_rcon_send', { profileId, command }) as Promise<{
        ok: boolean
        response?: string
        error?: string
      }>
  },
  mapManagement: {
    list: (profileId) => invoke('map_management_list', { profileId }) as Promise<MapFolderEntry[]>,
    create: (profileId, folderName, fileName) =>
      invoke('map_management_create', { profileId, folderName, fileName }) as Promise<void>,
    delete: (profileId, folderName) => invoke('map_management_delete', { profileId, folderName }) as Promise<void>,
    openFolder: (profileId, folderName) =>
      invoke('map_management_open_folder', { profileId, folderName }) as Promise<void>
  },
  fileBrowser: {
    list: (profileId, relativePath) =>
      invoke('file_browser_list', { profileId, relativePath }) as Promise<{
        path: string
        entries: FileBrowserEntry[]
      }>,
    open: (profileId, relativePath) => invoke('file_browser_open', { profileId, relativePath }) as Promise<void>,
    delete: (profileId, relativePath) => invoke('file_browser_delete', { profileId, relativePath }) as Promise<void>,
    readIni: (profileId, relativePath) => invoke('file_browser_read_ini', { profileId, relativePath }) as Promise<string>,
    writeIni: (profileId, relativePath, content) =>
      invoke('file_browser_write_ini', { profileId, relativePath, content }) as Promise<void>,
    iniHistory: (profileId, relativePath) =>
      invoke('file_browser_ini_history', { profileId, relativePath }) as Promise<ConfigFileHistorySummary[]>,
    iniHistoryDiff: (profileId, entryId) =>
      invoke('file_browser_ini_history_diff', { profileId, entryId }) as Promise<DiffLine[]>,
    iniRestore: (profileId, entryId) => invoke('file_browser_ini_restore', { profileId, entryId }) as Promise<void>
  },
  settings: {
    get: () => invoke('settings_get') as Promise<AppSettings>
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
  maps: {
    list: (game) => invoke('maps_list', { game }) as Promise<MapDefinition[]>
  },
  customMaps: {
    list: () => invoke('custom_maps_list') as Promise<MapDefinition[]>
  }
}

function ServerDetailPage(): JSX.Element | null {
  const [profile, setProfile] = useState<ServerProfile | null>(null)
  useEffect(() => {
    invoke('profiles_list').then((result) => {
      const profiles = result as ServerProfile[]
      const requestedId = new URLSearchParams(window.location.search).get('profile')
      setProfile(profiles.find((p) => p.id === requestedId) ?? profiles[0] ?? null)
    })
  }, [])
  if (!profile) return null
  return <ServerDetail profile={profile} onBack={() => window.history.back()} onProfileChange={setProfile} />
}

const container = document.getElementById('root')
if (!container) throw new Error('server-detail.html is missing #root')
createRoot(container).render(<ServerDetailPage />)
