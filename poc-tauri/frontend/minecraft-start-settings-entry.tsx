/**
 * Mounts the REAL, completely unmodified
 * src/renderer/src/pages/MinecraftServerDetail/StartSettingsTab.tsx - a thirtieth real page.
 * Reuses every already-proven window.api surface (minecraft.install.listVersions/
 * listLoaderVersions from "A twenty-seventh real page", minecraft.profiles.save from "A
 * twenty-eighth real page", dialog.selectDirectory) plus one genuinely new real call site:
 * minecraft.detectLaunchable (lib/minecraftDetect.ts, unmodified) backing the "Re-detect from
 * install directory" button.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import StartSettingsTab from '../../src/renderer/src/pages/MinecraftServerDetail/StartSettingsTab'
import { createDefaultMinecraftProfile } from '../../src/renderer/src/lib/minecraftProfile'
import { wrapInvoke } from './lib/tauriInvoke'
import type { MinecraftProfile } from '../../shared/minecraft'
import type { MinecraftInstallableType, MinecraftVersionOption } from '../../shared/minecraftInstall'

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
        install: {
          listVersions: (serverType: MinecraftInstallableType) => Promise<MinecraftVersionOption[]>
          listLoaderVersions: (
            serverType: MinecraftInstallableType,
            minecraftVersion: string
          ) => Promise<MinecraftVersionOption[]>
        }
        detectLaunchable: (installDir: string) => Promise<{
          launchMode: 'jar' | 'script'
          jarFileName: string
          scriptFileName: string
          serverType: MinecraftProfile['serverType']
        } | null>
      }
      dialog: {
        selectDirectory: () => Promise<string | null>
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
    install: {
      listVersions: (serverType) =>
        invoke('minecraft_install_list_versions', { serverType }) as Promise<MinecraftVersionOption[]>,
      listLoaderVersions: (serverType, minecraftVersion) =>
        invoke('minecraft_install_list_loader_versions', { serverType, minecraftVersion }) as Promise<
          MinecraftVersionOption[]
        >
    },
    detectLaunchable: (installDir) => invoke('minecraft_detect_launchable', { installDir }) as Promise<{
      launchMode: 'jar' | 'script'
      jarFileName: string
      scriptFileName: string
      serverType: MinecraftProfile['serverType']
    } | null>
  },
  dialog: {
    selectDirectory: () => invoke('dialog_select_directory') as Promise<string | null>
  }
}

function StartSettingsPage(): JSX.Element | null {
  const [profile, setProfile] = useState<MinecraftProfile | null>(null)

  useEffect(() => {
    window.api.minecraft.profiles.list().then(async (profiles) => {
      if (profiles[0]) {
        setProfile(profiles[0])
        return
      }
      const seeded = createDefaultMinecraftProfile('POC Minecraft Start Settings Test')
      const saved = await window.api.minecraft.profiles.save(seeded)
      setProfile(saved.find((p) => p.id === seeded.id) ?? seeded)
    })
  }, [])

  if (!profile) return null
  return <StartSettingsTab profile={profile} onProfileChange={setProfile} />
}

const container = document.getElementById('root')
if (!container) throw new Error('minecraft-start-settings.html is missing #root')
createRoot(container).render(<StartSettingsPage />)
