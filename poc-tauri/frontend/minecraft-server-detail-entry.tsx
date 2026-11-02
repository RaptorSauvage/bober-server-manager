/**
 * Mounts the REAL, completely unmodified
 * src/renderer/src/pages/MinecraftServerDetail/index.tsx - a thirty-fifth real page, and the
 * Minecraft-side twin of "A twenty-fifth real page" (ServerDetail/index.tsx's own ARK tab-shell
 * composition): no new real backend surface at all. Every tab it renders (ConsoleTab,
 * StartSettingsTab, ServerSettingsTab, ModsTab, BackupsTab, ServerManagementTab) is already
 * individually proven by an earlier round (minecraft-console-entry.tsx, minecraft-start-
 * settings-entry.tsx, minecraft-server-settings-entry.tsx, minecraft-mods-entry.tsx,
 * minecraft-backups-entry.tsx, minecraft-server-management-entry.tsx) - this entry is just
 * their union. The only genuinely new thing this round proves is that the real tab-switching
 * shell itself (the grouped left nav, the `tab` state, `tabsFor()`'s per-server-type Mods/
 * Plugins branching) works unmodified against this architecture, with every already-proven
 * window.api method reachable from inside it exactly as it was standalone.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import MinecraftServerDetail from '../../src/renderer/src/pages/MinecraftServerDetail'
import { createDefaultMinecraftProfile } from '../../src/renderer/src/lib/minecraftProfile'
import { wrapInvoke } from './lib/tauriInvoke'
import type { MinecraftConsoleLine, MinecraftProfile, MinecraftServerStatus, MinecraftPropertiesData } from '../../shared/minecraft'
import type { RconResult, AppSettings, BackupLogEntry } from '../../shared/types'
import type { MinecraftInstallableType, MinecraftVersionOption } from '../../shared/minecraftInstall'
import type {
  MinecraftModEcosystem,
  MinecraftModSearchResult,
  MinecraftModSource,
  MinecraftModInstallResult,
  MinecraftModUpdateCheckResult,
  MinecraftModScanResult
} from '../../shared/minecraftMods'
import type { BackupEntry } from '../../shared/types'

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
      }
      system: {
        focusWindow: () => Promise<void>
      }
      dialog: {
        selectDirectory: () => Promise<string | null>
      }
      minecraft: {
        profiles: {
          list: () => Promise<MinecraftProfile[]>
          save: (profile: MinecraftProfile) => Promise<MinecraftProfile[]>
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
          listLoaderVersions: (
            serverType: MinecraftInstallableType,
            minecraftVersion: string
          ) => Promise<MinecraftVersionOption[]>
        }
        properties: {
          get: (profileId: string) => Promise<MinecraftPropertiesData>
          save: (profileId: string, updates: MinecraftPropertiesData) => Promise<MinecraftPropertiesData>
        }
        server: {
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
          update: (
            profileId: string,
            source: MinecraftModSource,
            projectId: string
          ) => Promise<{ profile: MinecraftProfile; result: MinecraftModInstallResult }>
          scan: (profileId: string) => Promise<{ profile: MinecraftProfile; result: MinecraftModScanResult }>
          openFolder: (profileId: string) => Promise<void>
        }
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
    get: () => invoke('settings_get') as Promise<AppSettings>
  },
  system: {
    focusWindow: () => invoke('window_focus') as Promise<void>
  },
  dialog: {
    selectDirectory: () => invoke('dialog_select_directory') as Promise<string | null>
  },
  minecraft: {
    profiles: {
      list: () => invoke('minecraft_profiles_list') as Promise<MinecraftProfile[]>,
      save: (profile) => invoke('minecraft_profiles_save', { profile }) as Promise<MinecraftProfile[]>
    },
    openServerFolder: (profileId) => invoke('minecraft_open_server_folder', { profileId }) as Promise<void>,
    detectLaunchable: (installDir) => invoke('minecraft_detect_launchable', { installDir }) as Promise<{
      launchMode: 'jar' | 'script'
      jarFileName: string
      scriptFileName: string
      serverType: MinecraftProfile['serverType']
    } | null>,
    install: {
      listVersions: (serverType) =>
        invoke('minecraft_install_list_versions', { serverType }) as Promise<MinecraftVersionOption[]>,
      listLoaderVersions: (serverType, minecraftVersion) =>
        invoke('minecraft_install_list_loader_versions', { serverType, minecraftVersion }) as Promise<
          MinecraftVersionOption[]
        >
    },
    properties: {
      get: (profileId) => invoke('minecraft_properties_get', { profileId }) as Promise<MinecraftPropertiesData>,
      save: (profileId, updates) =>
        invoke('minecraft_properties_save', { profileId, updates }) as Promise<MinecraftPropertiesData>
    },
    server: {
      getStatus: (profileId) => invoke('minecraft_server_get_status', { profileId }) as Promise<MinecraftServerStatus>,
      onStatusChanged: (callback) => onEvent<MinecraftServerStatus>('minecraft-server-status', callback),
      sendCommand: (profileId, command) =>
        invoke('minecraft_server_send_command', { profileId, command }) as Promise<RconResult>
    },
    console: {
      getBacklog: (profileId) => invoke('minecraft_console_get_backlog', { profileId }) as Promise<MinecraftConsoleLine[]>,
      onLine: (callback) =>
        onEvent<{ profileId: string; line: MinecraftConsoleLine }>('minecraft-console-line', ({ profileId, line }) =>
          callback(profileId, line)
        )
    },
    backup: {
      create: (profileId) => invoke('minecraft_backup_create', { profileId }) as Promise<BackupEntry>,
      list: (profileId) => invoke('minecraft_backup_list', { profileId }) as Promise<BackupEntry[]>,
      delete: (filePath) => invoke('minecraft_backup_delete', { filePath }) as Promise<void>,
      restore: (profileId, filePath) => invoke('minecraft_backup_restore', { profileId, filePath }) as Promise<void>,
      openFolder: (profileId) => invoke('minecraft_backup_open_folder', { profileId }) as Promise<void>,
      onCreated: (callback) => onEvent<string>('minecraft-backup-created', callback),
      getLog: (profileId) => invoke('minecraft_backup_get_log', { profileId }) as Promise<BackupLogEntry[]>,
      onLogChanged: (callback) =>
        onEvent<{ profileId: string; entry: BackupLogEntry }>('minecraft-backup-log-entry', ({ profileId, entry }) =>
          callback(profileId, entry)
        )
    },
    mods: {
      search: (profileId, query, ecosystem) =>
        invoke('minecraft_mods_search', { profileId, query, ecosystem }) as Promise<MinecraftModSearchResult[]>,
      install: (profileId, source, projectId, ecosystem) =>
        invoke('minecraft_mods_install', { profileId, source, projectId, ecosystem }) as Promise<{
          profile: MinecraftProfile
          result: MinecraftModInstallResult
        }>,
      remove: (profileId, projectId) => invoke('minecraft_mods_remove', { profileId, projectId }) as Promise<MinecraftProfile>,
      setEnabled: (profileId, projectId, enabled) =>
        invoke('minecraft_mods_set_enabled', { profileId, projectId, enabled }) as Promise<MinecraftProfile>,
      checkUpdates: (profileId) =>
        invoke('minecraft_mods_check_updates', { profileId }) as Promise<MinecraftModUpdateCheckResult[]>,
      update: (profileId, source, projectId) =>
        invoke('minecraft_mods_update', { profileId, source, projectId }) as Promise<{
          profile: MinecraftProfile
          result: MinecraftModInstallResult
        }>,
      scan: (profileId) =>
        invoke('minecraft_mods_scan', { profileId }) as Promise<{ profile: MinecraftProfile; result: MinecraftModScanResult }>,
      openFolder: (profileId) => invoke('minecraft_mods_open_folder', { profileId }) as Promise<void>
    }
  }
}

function MinecraftServerDetailPage(): JSX.Element | null {
  const [profile, setProfile] = useState<MinecraftProfile | null>(null)

  useEffect(() => {
    window.api.minecraft.profiles.list().then(async (profiles) => {
      if (profiles[0]) {
        setProfile(profiles[0])
        return
      }
      const seeded = { ...createDefaultMinecraftProfile('POC Minecraft Server Detail Test'), serverType: 'forge' as const }
      const saved = await window.api.minecraft.profiles.save(seeded)
      setProfile(saved.find((p) => p.id === seeded.id) ?? seeded)
    })
  }, [])

  if (!profile) return null
  return (
    <MinecraftServerDetail
      profile={profile}
      onBack={() => window.history.back()}
      onProfileChange={setProfile}
    />
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('minecraft-server-detail.html is missing #root')
createRoot(container).render(<MinecraftServerDetailPage />)
