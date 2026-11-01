/**
 * Mounts the REAL, completely unmodified src/renderer/src/pages/InstallMinecraftServerPanel.tsx
 * - a twenty-seventh real page, and the first to exercise the real Minecraft server-install
 * subsystem (lib/minecraftInstall.ts/minecraftInstallClient.ts): fetches the right
 * vanilla/Paper/Fabric/Forge/NeoForge/Spigot/Sponge files for a brand-new server. Real,
 * unmodified functions throughout - no stand-in. minecraftInstallClient.ts's own top-of-file
 * comment already notes none of this was ever verified against the real Mojang/Paper/Fabric/
 * Forge/NeoForge/Sponge APIs from the real app's own development sandbox either, so this PoC's
 * network-less sandbox hitting the same honest "fetch failed" is the same category of gap, not
 * a new one - and the first time any of this code has actually been exercised at all, in either
 * environment. A thin InstallPage wrapper just logs onInstalled/onCancel to the page itself
 * (status text) since there's no real Dashboard here to hand the resulting MinecraftProfile to.
 */
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import InstallMinecraftServerPanel from '../../src/renderer/src/pages/InstallMinecraftServerPanel'
import { wrapInvoke } from './lib/tauriInvoke'
import type {
  MinecraftInstallableType,
  MinecraftInstallParams,
  MinecraftInstallResult,
  MinecraftVersionOption
} from '../../shared/minecraftInstall'
import type { MinecraftProfile } from '../../shared/minecraft'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    }
    api: {
      minecraft: {
        install: {
          listVersions: (serverType: MinecraftInstallableType) => Promise<MinecraftVersionOption[]>
          listLoaderVersions: (
            serverType: MinecraftInstallableType,
            minecraftVersion: string
          ) => Promise<MinecraftVersionOption[]>
          run: (params: MinecraftInstallParams) => Promise<MinecraftInstallResult>
        }
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
    install: {
      listVersions: (serverType) =>
        invoke('minecraft_install_list_versions', { serverType }) as Promise<MinecraftVersionOption[]>,
      listLoaderVersions: (serverType, minecraftVersion) =>
        invoke('minecraft_install_list_loader_versions', { serverType, minecraftVersion }) as Promise<
          MinecraftVersionOption[]
        >,
      run: (params) => invoke('minecraft_install_run', { params }) as Promise<MinecraftInstallResult>
    }
  },
  dialog: {
    selectDirectory: () => invoke('dialog_select_directory') as Promise<string | null>
  }
}

function InstallPage(): JSX.Element {
  const [result, setResult] = useState<MinecraftProfile | null>(null)
  const [cancelled, setCancelled] = useState(false)
  if (result) {
    return (
      <div style={{ padding: 24 }}>
        <p className="status-message">Installed - real MinecraftProfile built:</p>
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </div>
    )
  }
  if (cancelled) {
    return (
      <div style={{ padding: 24 }}>
        <p className="empty-state">Cancelled.</p>
      </div>
    )
  }
  return (
    <InstallMinecraftServerPanel existingNameCount={0} onInstalled={setResult} onCancel={() => setCancelled(true)} />
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('install-minecraft.html is missing #root')
createRoot(container).render(<InstallPage />)
