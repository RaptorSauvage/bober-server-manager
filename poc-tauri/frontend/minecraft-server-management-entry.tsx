/**
 * Mounts the REAL, completely unmodified
 * src/renderer/src/pages/MinecraftServerDetail/ServerManagementTab.tsx - a twenty-eighth real
 * page, and the first to touch the Minecraft profile CRUD foundation
 * (window.api.minecraft.profiles.list/save/delete) this sandbox has never had a real Minecraft
 * profile to exercise against before now. Reuses the real, unmodified
 * ServerDetail/ScheduleDaysPicker.tsx (already proven on the ARK side) unchanged - no
 * window.api needs of its own, pure presentational + shared/scheduleTime.ts pure functions.
 * A thin wrapper seeds one real Minecraft profile via the real createDefaultMinecraftProfile()
 * (src/renderer/src/lib/minecraftProfile.ts, unmodified) and a real minecraft.profiles.save
 * call if none exist yet, mirroring how earlier ARK-side wrapper entries seed state via
 * already-proven real calls rather than inventing fixture data server-side.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import ServerManagementTab from '../../src/renderer/src/pages/MinecraftServerDetail/ServerManagementTab'
import { createDefaultMinecraftProfile } from '../../src/renderer/src/lib/minecraftProfile'
import { wrapInvoke } from './lib/tauriInvoke'
import type { MinecraftProfile } from '../../shared/minecraft'

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
    }
  }
}

function ServerManagementPage(): JSX.Element | null {
  const [profile, setProfile] = useState<MinecraftProfile | null>(null)

  useEffect(() => {
    window.api.minecraft.profiles.list().then(async (profiles) => {
      if (profiles[0]) {
        setProfile(profiles[0])
        return
      }
      const seeded = createDefaultMinecraftProfile('POC Minecraft Test Server')
      const saved = await window.api.minecraft.profiles.save(seeded)
      setProfile(saved.find((p) => p.id === seeded.id) ?? seeded)
    })
  }, [])

  if (!profile) return null
  return <ServerManagementTab profile={profile} onProfileChange={setProfile} />
}

const container = document.getElementById('root')
if (!container) throw new Error('minecraft-server-management.html is missing #root')
createRoot(container).render(<ServerManagementPage />)
