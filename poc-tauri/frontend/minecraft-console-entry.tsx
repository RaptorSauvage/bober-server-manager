/**
 * Mounts the REAL, completely unmodified
 * src/renderer/src/pages/MinecraftServerDetail/ConsoleTab.tsx - a twenty-ninth real page, and
 * the first in this PoC to pull in a real third-party UI library (xterm.js, via @xterm/xterm +
 * @xterm/addon-fit) rather than plain DOM/CSS. The component's own `import
 * '@xterm/xterm/css/xterm.css'` is real and unmodified; esbuild has no CSS-import-as-side-effect
 * story (see build-react.mjs's own comment), so that import is a no-op in the bundled JS and the
 * real xterm.css content is served instead via a plain <link> in minecraft-console.html, copied
 * byte-for-byte from node_modules. A thin wrapper seeds one real Minecraft profile (reusing "A
 * twenty-eighth real page"'s createDefaultMinecraftProfile()/minecraft.profiles.save pattern).
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import ConsoleTab from '../../src/renderer/src/pages/MinecraftServerDetail/ConsoleTab'
import { createDefaultMinecraftProfile } from '../../src/renderer/src/lib/minecraftProfile'
import { wrapInvoke } from './lib/tauriInvoke'
import type { MinecraftConsoleLine, MinecraftProfile, MinecraftServerStatus } from '../../shared/minecraft'
import type { RconResult } from '../../shared/types'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
      event: {
        listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>
      }
    }
    api: {
      minecraft: {
        profiles: {
          list: () => Promise<MinecraftProfile[]>
          save: (profile: MinecraftProfile) => Promise<MinecraftProfile[]>
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
  minecraft: {
    profiles: {
      list: () => invoke('minecraft_profiles_list') as Promise<MinecraftProfile[]>,
      save: (profile) => invoke('minecraft_profiles_save', { profile }) as Promise<MinecraftProfile[]>
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
    }
  }
}

function ConsolePage(): JSX.Element | null {
  const [profile, setProfile] = useState<MinecraftProfile | null>(null)

  useEffect(() => {
    window.api.minecraft.profiles.list().then(async (profiles) => {
      if (profiles[0]) {
        setProfile(profiles[0])
        return
      }
      const seeded = createDefaultMinecraftProfile('POC Minecraft Console Test')
      const saved = await window.api.minecraft.profiles.save(seeded)
      setProfile(saved.find((p) => p.id === seeded.id) ?? seeded)
    })
  }, [])

  if (!profile) return null
  return <ConsoleTab profile={profile} />
}

const container = document.getElementById('root')
if (!container) throw new Error('minecraft-console.html is missing #root')
createRoot(container).render(<ConsolePage />)
