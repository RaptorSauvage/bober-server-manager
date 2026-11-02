/**
 * Mounts the REAL, completely unmodified
 * src/renderer/src/pages/MinecraftServerDetail/ModsTab.tsx - a thirty-fourth real page, backed
 * by the real, unmodified lib/minecraftMods.ts (1187 lines - Modrinth/CurseForge search,
 * install, update, hash-based folder scanning). Reuses `window.api.settings.get()` (already
 * proven) for the CurseForge-API-key gate, and the real `confirmAction()`/server-type and
 * mod-source icon assets (`.png`/`.jpg` -> dataurl, already proven since "A fifth real page").
 * Seeds a 'forge' profile (not the default 'unknown') so this ecosystem actually renders
 * instead of hitting the real "no mods/plugins ecosystem" branch.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import ModsTab from '../../src/renderer/src/pages/MinecraftServerDetail/ModsTab'
import { createDefaultMinecraftProfile } from '../../src/renderer/src/lib/minecraftProfile'
import { wrapInvoke } from './lib/tauriInvoke'
import type { MinecraftProfile } from '../../shared/minecraft'
import type {
  MinecraftModEcosystem,
  MinecraftModSearchResult,
  MinecraftModSource,
  MinecraftModInstallResult,
  MinecraftModUpdateCheckResult,
  MinecraftModScanResult
} from '../../shared/minecraftMods'
import type { AppSettings } from '../../shared/types'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    }
    api: {
      settings: {
        get: () => Promise<AppSettings>
      }
      system: {
        focusWindow: () => Promise<void>
      }
      minecraft: {
        profiles: {
          list: () => Promise<MinecraftProfile[]>
          save: (profile: MinecraftProfile) => Promise<MinecraftProfile[]>
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

window.api = {
  settings: {
    get: () => invoke('settings_get') as Promise<AppSettings>
  },
  system: {
    focusWindow: () => invoke('window_focus') as Promise<void>
  },
  minecraft: {
    profiles: {
      list: () => invoke('minecraft_profiles_list') as Promise<MinecraftProfile[]>,
      save: (profile) => invoke('minecraft_profiles_save', { profile }) as Promise<MinecraftProfile[]>
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

function ModsPage(): JSX.Element | null {
  const [profile, setProfile] = useState<MinecraftProfile | null>(null)

  useEffect(() => {
    window.api.minecraft.profiles.list().then(async (profiles) => {
      if (profiles[0]) {
        setProfile(profiles[0])
        return
      }
      const seeded = { ...createDefaultMinecraftProfile('POC Minecraft Mods Test'), serverType: 'forge' as const }
      const saved = await window.api.minecraft.profiles.save(seeded)
      setProfile(saved.find((p) => p.id === seeded.id) ?? seeded)
    })
  }, [])

  if (!profile) return null
  return (
    <ModsTab
      profile={profile}
      ecosystem="mods"
      onProfileChange={setProfile}
      onGoToStartSettings={() => {
        window.location.href = 'minecraft-start-settings.html'
      }}
    />
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('minecraft-mods.html is missing #root')
createRoot(container).render(<ModsPage />)
