/**
 * Mounts the REAL, completely unmodified src/renderer/src/pages/ServerDetail/SettingsTab.tsx -
 * a twenty-fourth real page, and the first one with a debounced-live-preview effect: every form
 * edit re-calls window.api.server.previewLaunchCommand(form) 300ms after the last keystroke,
 * which round-trips through the sidecar to the real, unmodified getExecutablePath()/
 * buildLaunchArgs() (lib/serverProcess.ts) - the exact function pair startServer() itself calls,
 * so what's shown here is genuinely what would be launched, not a parallel reimplementation.
 * window.api.system.openDataDirFolder and window.api.profiles.export/dialog.saveProfileFile are
 * the other two new real call sites (see sidecar.ts's own comment and main.rs's
 * dialog_save_profile_file for why the Save dialog itself has no sidecar involvement, same
 * architectural class as dialog_select_directory/dialog_select_ini_file). Everything else
 * (maps.list, customMaps.list, profiles.save, mods.save, dialog.selectDirectory) is already
 * proven by earlier rounds and reused unchanged.
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import SettingsTab from '../../src/renderer/src/pages/ServerDetail/SettingsTab'
import { wrapInvoke } from './lib/tauriInvoke'
import type { MapDefinition, ServerMod, ServerProfile } from '../../shared/types'
import type { GameId } from '../../shared/games'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    }
    api: {
      dialog: {
        selectDirectory: () => Promise<string | null>
        saveProfileFile: (defaultName: string) => Promise<string | null>
      }
      profiles: {
        save: (profile: ServerProfile) => Promise<ServerProfile[]>
        export: (profileId: string, filePath: string) => Promise<void>
      }
      maps: {
        list: (game: GameId) => Promise<MapDefinition[]>
      }
      customMaps: {
        list: () => Promise<MapDefinition[]>
      }
      mods: {
        save: (profileId: string, mods: ServerMod[]) => Promise<ServerProfile>
      }
      system: {
        openDataDirFolder: () => Promise<void>
      }
      server: {
        previewLaunchCommand: (profile: ServerProfile) => Promise<{ executable: string; args: string[] }>
      }
    }
  }
}

const invoke = wrapInvoke(window.__TAURI__.core.invoke)

window.api = {
  dialog: {
    selectDirectory: () => invoke('dialog_select_directory') as Promise<string | null>,
    saveProfileFile: (defaultName) => invoke('dialog_save_profile_file', { defaultName }) as Promise<string | null>
  },
  profiles: {
    save: (profile) => invoke('profiles_save', { profile }) as Promise<ServerProfile[]>,
    export: (profileId, filePath) => invoke('profiles_export', { profileId, filePath }) as Promise<void>
  },
  maps: {
    list: (game) => invoke('maps_list', { game }) as Promise<MapDefinition[]>
  },
  customMaps: {
    list: () => invoke('custom_maps_list') as Promise<MapDefinition[]>
  },
  mods: {
    save: (profileId, mods) => invoke('mods_save', { profileId, mods }) as Promise<ServerProfile>
  },
  system: {
    openDataDirFolder: () => invoke('system_open_data_dir_folder') as Promise<void>
  },
  server: {
    previewLaunchCommand: (profile) =>
      invoke('server_preview_launch_command', { profile }) as Promise<{ executable: string; args: string[] }>
  }
}

function SettingsPage(): JSX.Element | null {
  const [profile, setProfile] = useState<ServerProfile | null>(null)
  useEffect(() => {
    invoke('profiles_list').then((result) => {
      const profiles = result as ServerProfile[]
      const requestedId = new URLSearchParams(window.location.search).get('profile')
      setProfile(profiles.find((p) => p.id === requestedId) ?? profiles[0] ?? null)
    })
  }, [])
  if (!profile) return null
  return <SettingsTab profile={profile} onProfileChange={setProfile} />
}

const container = document.getElementById('root')
if (!container) throw new Error('settings.html is missing #root')
createRoot(container).render(<SettingsPage />)
