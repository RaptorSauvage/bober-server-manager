/**
 * Mounts the REAL, completely unmodified src/renderer/src/pages/MinecraftDashboard.tsx - a
 * thirty-sixth real page, the Minecraft-side twin of "A fifty-seventh..." - no, of ARK's own
 * Dashboard.tsx - and the last page in this PoC's original scope. Composes two more already-
 * proven real components unmodified (HardwareStatsBar.tsx, InstallMinecraftServerPanel.tsx)
 * plus `tabsFor` from the already-proven MinecraftServerDetail/index.tsx. The one genuinely new
 * real backend surface: `minecraft.server.start/stop/kill` (lib/minecraftActions.ts ->
 * lib/minecraftProcess.ts) - the actual headline case for the Minecraft side, a real spawned
 * process, monitored, and `minecraft.profiles.importFromInstall` (lib/minecraftDetect.ts).
 * onOpenProfile is a console.log no-op, same as ARK's own dashboard-entry.tsx - this PoC has no
 * real router to navigate a selected profile into (the already-proven minecraft-server-detail.html
 * exists as its own separate page, not reachable from here without inventing routing the real
 * app itself doesn't need, since App.tsx owns that in the real app).
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import MinecraftDashboard from '../../src/renderer/src/pages/MinecraftDashboard'
import { wrapInvoke } from './lib/tauriInvoke'
import type { AppSettings, SystemStaticInfo } from '../../shared/types'
import type { MinecraftProfile, MinecraftServerStatus } from '../../shared/minecraft'
import type { MinecraftInstallableType, MinecraftInstallParams, MinecraftInstallResult, MinecraftVersionOption } from '../../shared/minecraftInstall'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
      event: {
        listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>
      }
    }
    api: {
      webDashboard: {
        getLocalIps: () => Promise<string[]>
      }
      settings: {
        get: () => Promise<AppSettings>
        save: (settings: AppSettings) => Promise<void>
      }
      systemStats: {
        getStaticInfo: () => Promise<SystemStaticInfo>
        getNetworkUsage: () => Promise<{ rxBytesPerSec: number | null; txBytesPerSec: number | null }>
      }
      dialog: {
        selectDirectory: () => Promise<string | null>
      }
      minecraft: {
        profiles: {
          list: () => Promise<MinecraftProfile[]>
          save: (profile: MinecraftProfile) => Promise<MinecraftProfile[]>
          delete: (id: string) => Promise<MinecraftProfile[]>
          importFromInstall: (installDir: string) => Promise<MinecraftProfile>
        }
        properties: {
          get: (profileId: string) => Promise<Record<string, string>>
        }
        server: {
          start: (profileId: string) => Promise<MinecraftServerStatus>
          stop: (profileId: string) => Promise<MinecraftServerStatus>
          kill: (profileId: string) => Promise<MinecraftServerStatus>
          onStatusChanged: (callback: (status: MinecraftServerStatus) => void) => () => void
        }
        install: {
          listVersions: (serverType: MinecraftInstallableType) => Promise<MinecraftVersionOption[]>
          listLoaderVersions: (
            serverType: MinecraftInstallableType,
            minecraftVersion: string
          ) => Promise<MinecraftVersionOption[]>
          run: (params: MinecraftInstallParams) => Promise<MinecraftInstallResult>
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
  webDashboard: {
    getLocalIps: () => invoke('web_dashboard_get_local_ips') as Promise<string[]>
  },
  settings: {
    get: () => invoke('settings_get') as Promise<AppSettings>,
    save: (settings) => invoke('settings_save', { settings }) as Promise<void>
  },
  systemStats: {
    getStaticInfo: () => invoke('system_stats_get_static_info') as Promise<SystemStaticInfo>,
    getNetworkUsage: () =>
      invoke('system_stats_get_network_usage') as Promise<{ rxBytesPerSec: number | null; txBytesPerSec: number | null }>
  },
  dialog: {
    selectDirectory: () => invoke('dialog_select_directory') as Promise<string | null>
  },
  minecraft: {
    profiles: {
      list: () => invoke('minecraft_profiles_list') as Promise<MinecraftProfile[]>,
      save: (profile) => invoke('minecraft_profiles_save', { profile }) as Promise<MinecraftProfile[]>,
      delete: (id) => invoke('minecraft_profiles_delete', { id }) as Promise<MinecraftProfile[]>,
      importFromInstall: (installDir) => invoke('minecraft_profiles_import', { installDir }) as Promise<MinecraftProfile>
    },
    properties: {
      get: (profileId) => invoke('minecraft_properties_get', { profileId }) as Promise<Record<string, string>>
    },
    server: {
      start: (profileId) => invoke('minecraft_server_start', { profileId }) as Promise<MinecraftServerStatus>,
      stop: (profileId) => invoke('minecraft_server_stop', { profileId }) as Promise<MinecraftServerStatus>,
      kill: (profileId) => invoke('minecraft_server_kill', { profileId }) as Promise<MinecraftServerStatus>,
      onStatusChanged: (callback) => onEvent<MinecraftServerStatus>('minecraft-server-status', callback)
    },
    install: {
      listVersions: (serverType) =>
        invoke('minecraft_install_list_versions', { serverType }) as Promise<MinecraftVersionOption[]>,
      listLoaderVersions: (serverType, minecraftVersion) =>
        invoke('minecraft_install_list_loader_versions', { serverType, minecraftVersion }) as Promise<
          MinecraftVersionOption[]
        >,
      run: (params) => invoke('minecraft_install_run', { params }) as Promise<MinecraftInstallResult>
    }
  }
}

function MinecraftDashboardPage(): JSX.Element | null {
  const [profiles, setProfiles] = useState<MinecraftProfile[] | null>(null)
  const [statuses, setStatuses] = useState<Record<string, MinecraftServerStatus>>({})
  const [staticInfo, setStaticInfo] = useState<SystemStaticInfo | null>(null)

  useEffect(() => {
    window.api.minecraft.profiles.list().then(setProfiles)
    window.api.systemStats.getStaticInfo().then(setStaticInfo)
    return window.api.minecraft.server.onStatusChanged((status) => {
      setStatuses((prev) => ({ ...prev, [status.profileId]: status }))
    })
  }, [])

  if (!profiles) return null
  return (
    <MinecraftDashboard
      profiles={profiles}
      onProfilesChange={setProfiles}
      onOpenProfile={(id, tab) => console.log('onOpenProfile (out of scope this round):', id, tab)}
      statuses={statuses}
      staticInfo={staticInfo}
    />
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('minecraft-dashboard.html is missing #root')
createRoot(container).render(<MinecraftDashboardPage />)
