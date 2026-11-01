/**
 * Mounts the REAL, completely unmodified src/renderer/src/pages/DataSettingsView.tsx - a
 * twenty-sixth real page, and by far the widest real backend surface this PoC has wired in a
 * single round: settings.save (the real ipc/settings.ts handler body, with every real
 * follow-up re-application it does - web dashboard, Discord bot, launch-on-startup, ini lock,
 * player-join-alert/player-activity watchers), dataDir.getDefault, webDashboard.getLocalIps,
 * discordBot.restart, appUpdate.* (the real lib/appUpdater.ts, gated on the real
 * app.isPackaged - see sidecar.ts's own comment for why checkForUpdate() is safe to call for
 * real here), cluster.export/import (the first real call site to touch the Minecraft profile
 * store), and the webDashboardAccessTokens/webDashboardApiKeys CRUD the two real child
 * components (AccessTokensSection.tsx, ApiKeysSection.tsx) need. Two new sidecar-free native
 * dialogs (dialog_save_cluster_bundle_file/dialog_select_cluster_bundle_file) round out the
 * set, same architectural class as every earlier native picker in this PoC.
 */
import { createRoot } from 'react-dom/client'
import DataSettingsView from '../../src/renderer/src/pages/DataSettingsView'
import { wrapInvoke } from './lib/tauriInvoke'
import type {
  AppSettings,
  AppUpdateStatus,
  ClusterImportResult,
  ServerProfile,
  WatchedPlayerAlert,
  WebDashboardAccessTokenSummary,
  WebDashboardApiKeySummary,
  WebDashboardRole
} from '../../shared/types'

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
      dataDir: {
        getDefault: () => Promise<string>
      }
      webDashboard: {
        getStatus: () => Promise<{ running: boolean; error: string | null; host: string | null }>
        getLocalIps: () => Promise<string[]>
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
      dialog: {
        selectDirectory: () => Promise<string | null>
        saveClusterBundleFile: () => Promise<string | null>
        selectClusterBundleFile: () => Promise<string | null>
      }
      cluster: {
        export: (filePath: string) => Promise<void>
        import: (filePath: string, options: { includeSettings: boolean }) => Promise<ClusterImportResult>
      }
      system: {
        openProfilesFolder: () => Promise<void>
        focusWindow: () => Promise<void>
      }
      profiles: {
        list: () => Promise<ServerProfile[]>
      }
      watchedPlayers: {
        list: () => Promise<WatchedPlayerAlert[]>
        add: (value: string, label: string) => Promise<WatchedPlayerAlert[]>
        remove: (id: string) => Promise<WatchedPlayerAlert[]>
      }
      webDashboardAccessTokens: {
        list: () => Promise<WebDashboardAccessTokenSummary[]>
        create: (
          label: string,
          role: WebDashboardRole,
          profileIds: string[] | null
        ) => Promise<{ token: string; tokens: WebDashboardAccessTokenSummary[] }>
        update: (
          id: string,
          updates: { label?: string; role?: WebDashboardRole; profileIds?: string[] | null }
        ) => Promise<WebDashboardAccessTokenSummary[]>
        delete: (id: string) => Promise<WebDashboardAccessTokenSummary[]>
      }
      webDashboardApiKeys: {
        list: () => Promise<WebDashboardApiKeySummary[]>
        create: (label: string, role: WebDashboardRole) => Promise<{ key: string; keys: WebDashboardApiKeySummary[] }>
        update: (id: string, updates: { label?: string; role?: WebDashboardRole }) => Promise<WebDashboardApiKeySummary[]>
        delete: (id: string) => Promise<WebDashboardApiKeySummary[]>
      }
    }
  }
}

const invoke = wrapInvoke(window.__TAURI__.core.invoke)
const { listen } = window.__TAURI__.event

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
  settings: {
    get: () => invoke('settings_get') as Promise<AppSettings>,
    save: (settings) => invoke('settings_save', { settings }) as Promise<AppSettings>
  },
  dataDir: {
    getDefault: () => invoke('data_dir_get_default') as Promise<string>
  },
  webDashboard: {
    getStatus: () =>
      invoke('dashboard_status') as Promise<{ running: boolean; error: string | null; host: string | null }>,
    getLocalIps: () => invoke('web_dashboard_get_local_ips') as Promise<string[]>
  },
  appUpdate: {
    getVersion: () => invoke('app_update_get_version') as Promise<string>,
    getStatus: () => invoke('app_update_status') as Promise<AppUpdateStatus>,
    onStatusChanged: (callback) => onEvent<AppUpdateStatus>('app-update-status-changed', callback),
    check: () => invoke('app_update_check') as Promise<void>,
    install: () => invoke('app_update_install') as Promise<void>
  },
  discordBot: {
    status: () => invoke('discord_bot_status') as Promise<{ running: boolean; error: string | null }>,
    restart: () => invoke('discord_bot_restart') as Promise<{ running: boolean; error: string | null }>,
    stop: () => invoke('discord_bot_stop') as Promise<{ running: boolean; error: string | null }>
  },
  dialog: {
    selectDirectory: () => invoke('dialog_select_directory') as Promise<string | null>,
    saveClusterBundleFile: () => invoke('dialog_save_cluster_bundle_file') as Promise<string | null>,
    selectClusterBundleFile: () => invoke('dialog_select_cluster_bundle_file') as Promise<string | null>
  },
  cluster: {
    export: (filePath) => invoke('cluster_export', { filePath }) as Promise<void>,
    import: (filePath, options) =>
      invoke('cluster_import', { filePath, includeSettings: options.includeSettings }) as Promise<ClusterImportResult>
  },
  system: {
    openProfilesFolder: () => invoke('folders_open_profiles') as Promise<void>,
    focusWindow: () => invoke('window_focus') as Promise<void>
  },
  profiles: {
    list: () => invoke('profiles_list') as Promise<ServerProfile[]>
  },
  watchedPlayers: {
    list: () => invoke('watched_players_list') as Promise<WatchedPlayerAlert[]>,
    add: (value, label) => invoke('watched_players_add', { value, label }) as Promise<WatchedPlayerAlert[]>,
    remove: (id) => invoke('watched_players_remove', { id }) as Promise<WatchedPlayerAlert[]>
  },
  webDashboardAccessTokens: {
    list: () => invoke('web_dashboard_access_tokens_list') as Promise<WebDashboardAccessTokenSummary[]>,
    create: (label, role, profileIds) =>
      invoke('web_dashboard_access_tokens_create', { label, role, profileIds }) as Promise<{
        token: string
        tokens: WebDashboardAccessTokenSummary[]
      }>,
    update: (id, updates) =>
      invoke('web_dashboard_access_tokens_update', { id, updates }) as Promise<WebDashboardAccessTokenSummary[]>,
    delete: (id) => invoke('web_dashboard_access_tokens_delete', { id }) as Promise<WebDashboardAccessTokenSummary[]>
  },
  webDashboardApiKeys: {
    list: () => invoke('web_dashboard_api_keys_list') as Promise<WebDashboardApiKeySummary[]>,
    create: (label, role) =>
      invoke('web_dashboard_api_keys_create', { label, role }) as Promise<{
        key: string
        keys: WebDashboardApiKeySummary[]
      }>,
    update: (id, updates) =>
      invoke('web_dashboard_api_keys_update', { id, updates }) as Promise<WebDashboardApiKeySummary[]>,
    delete: (id) => invoke('web_dashboard_api_keys_delete', { id }) as Promise<WebDashboardApiKeySummary[]>
  }
}

const container = document.getElementById('root')
if (!container) throw new Error('data-settings.html is missing #root')
createRoot(container).render(<DataSettingsView onBack={() => window.history.back()} />)
