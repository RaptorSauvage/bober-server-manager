/**
 * Mounts the REAL, completely unmodified
 * src/renderer/src/pages/MinecraftServerDetail/BackupLogPanel.tsx - a thirty-first real page.
 * Reuses the proven minecraft.profiles.list/save (see "A twenty-eighth real page") to seed a
 * profile, plus one genuinely new real call pair: minecraft.backup.getLog/onLogChanged
 * (lib/minecraftBackup.ts's getMinecraftBackupLog() + its own minecraftBackupEvents 'log'
 * emitter, unmodified), the Minecraft-side twin of the already-proven ARK backup.getLog/
 * onLogChanged shape.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import BackupLogPanel from '../../src/renderer/src/pages/MinecraftServerDetail/BackupLogPanel'
import { createDefaultMinecraftProfile } from '../../src/renderer/src/lib/minecraftProfile'
import { wrapInvoke } from './lib/tauriInvoke'
import type { MinecraftProfile } from '../../shared/minecraft'
import type { BackupLogEntry } from '../../shared/types'

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
        backup: {
          getLog: (profileId: string) => Promise<BackupLogEntry[]>
          onLogChanged: (callback: (profileId: string, entry: BackupLogEntry) => void) => () => void
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
    backup: {
      getLog: (profileId) => invoke('minecraft_backup_get_log', { profileId }) as Promise<BackupLogEntry[]>,
      onLogChanged: (callback) =>
        onEvent<{ profileId: string; entry: BackupLogEntry }>('minecraft-backup-log-entry', ({ profileId, entry }) =>
          callback(profileId, entry)
        )
    }
  }
}

function BackupLogPage(): JSX.Element | null {
  const [profile, setProfile] = useState<MinecraftProfile | null>(null)

  useEffect(() => {
    window.api.minecraft.profiles.list().then(async (profiles) => {
      if (profiles[0]) {
        setProfile(profiles[0])
        return
      }
      const seeded = createDefaultMinecraftProfile('POC Minecraft Backup Log Test')
      const saved = await window.api.minecraft.profiles.save(seeded)
      setProfile(saved.find((p) => p.id === seeded.id) ?? seeded)
    })
  }, [])

  if (!profile) return null
  return <BackupLogPanel profileId={profile.id} />
}

const container = document.getElementById('root')
if (!container) throw new Error('minecraft-backup-log.html is missing #root')
createRoot(container).render(<BackupLogPage />)
