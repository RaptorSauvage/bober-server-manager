/**
 * Mounts the REAL, completely unmodified
 * src/renderer/src/pages/MinecraftServerDetail/ServerSettingsTab.tsx - a thirty-third real
 * page, the server.properties editor. Two real call sites: `openMinecraftServerRootFolder()`
 * (lib/minecraftBackup.ts, the same `shell.openPath` round trip "The reverse direction" already
 * proved) and `readServerProperties()`/`upsertServerPropertiesKeys()` (lib/minecraftProperties.ts,
 * plain line-based key=value file I/O with no Electron coupling at all - the Minecraft
 * equivalent of ARK's own gameConfigWrite.ts).
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import ServerSettingsTab from '../../src/renderer/src/pages/MinecraftServerDetail/ServerSettingsTab'
import { createDefaultMinecraftProfile } from '../../src/renderer/src/lib/minecraftProfile'
import { wrapInvoke } from './lib/tauriInvoke'
import type { MinecraftProfile, MinecraftPropertiesData } from '../../shared/minecraft'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    }
    api: {
      minecraft: {
        profiles: {
          list: () => Promise<MinecraftProfile[]>
          save: (profile: MinecraftProfile) => Promise<MinecraftProfile[]>
        }
        openServerFolder: (profileId: string) => Promise<void>
        properties: {
          get: (profileId: string) => Promise<MinecraftPropertiesData>
          save: (profileId: string, updates: MinecraftPropertiesData) => Promise<MinecraftPropertiesData>
        }
      }
    }
  }
}

const invoke = wrapInvoke(window.__TAURI__.core.invoke)

window.api = {
  minecraft: {
    profiles: {
      list: () => invoke('minecraft_profiles_list') as Promise<MinecraftProfile[]>,
      save: (profile) => invoke('minecraft_profiles_save', { profile }) as Promise<MinecraftProfile[]>
    },
    openServerFolder: (profileId) => invoke('minecraft_open_server_folder', { profileId }) as Promise<void>,
    properties: {
      get: (profileId) => invoke('minecraft_properties_get', { profileId }) as Promise<MinecraftPropertiesData>,
      save: (profileId, updates) =>
        invoke('minecraft_properties_save', { profileId, updates }) as Promise<MinecraftPropertiesData>
    }
  }
}

function ServerSettingsPage(): JSX.Element | null {
  const [profile, setProfile] = useState<MinecraftProfile | null>(null)

  useEffect(() => {
    window.api.minecraft.profiles.list().then(async (profiles) => {
      if (profiles[0]) {
        setProfile(profiles[0])
        return
      }
      const seeded = createDefaultMinecraftProfile('POC Minecraft Server Settings Test')
      const saved = await window.api.minecraft.profiles.save(seeded)
      setProfile(saved.find((p) => p.id === seeded.id) ?? seeded)
    })
  }, [])

  if (!profile) return null
  return <ServerSettingsTab profile={profile} />
}

const container = document.getElementById('root')
if (!container) throw new Error('minecraft-server-settings.html is missing #root')
createRoot(container).render(<ServerSettingsPage />)
