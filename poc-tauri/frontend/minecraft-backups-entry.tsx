/**
 * Mounts the REAL, completely unmodified
 * src/renderer/src/pages/MinecraftServerDetail/BackupsTab.tsx - a thirty-second real page, the
 * Minecraft-side twin of ARK's own already-proven BackupsTab.tsx (see "A seventh real page").
 * BackupsTab itself mounts one more real, unmodified child component (BackupLogPanel.tsx,
 * already proven in "A thirty-first real page") and a real hook (useMinecraftServerStatuses.ts,
 * for the "stop the server before restoring" gate) - neither has its own entry file here, they
 * just call the same window.api.minecraft.backup / minecraft.server methods this page declares.
 *
 * What's genuinely new versus "A thirty-first real page": createMinecraftBackup() actually
 * zips the real world dimension folders off disk with `archiver` (no RCON SaveWorld step the
 * way ARK's own createBackup() has - Minecraft's own save-off/save-all flush happens over
 * stdin/RCON instead, already proven); restoreMinecraftBackup() extracts a real zip back over
 * the install directory with `adm-zip`.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import BackupsTab from '../../src/renderer/src/pages/MinecraftServerDetail/BackupsTab'
import { createDefaultMinecraftProfile } from '../../src/renderer/src/lib/minecraftProfile'
import { wrapInvoke } from './lib/tauriInvoke'
import type { MinecraftProfile, MinecraftServerStatus } from '../../shared/minecraft'
import type { BackupEntry, BackupLogEntry } from '../../shared/types'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
      event: {
        listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>
      }
    }
    api: {
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
        server: {
          getStatus: (profileId: string) => Promise<MinecraftServerStatus>
          onStatusChanged: (callback: (status: MinecraftServerStatus) => void) => () => void
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
    server: {
      getStatus: (profileId) => invoke('minecraft_server_get_status', { profileId }) as Promise<MinecraftServerStatus>,
      onStatusChanged: (callback) => onEvent<MinecraftServerStatus>('minecraft-server-status', callback)
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
    }
  }
}

function BackupsPage(): JSX.Element | null {
  const [profile, setProfile] = useState<MinecraftProfile | null>(null)

  useEffect(() => {
    window.api.minecraft.profiles.list().then(async (profiles) => {
      if (profiles[0]) {
        setProfile(profiles[0])
        return
      }
      const seeded = createDefaultMinecraftProfile('POC Minecraft Backups Test')
      const saved = await window.api.minecraft.profiles.save(seeded)
      setProfile(saved.find((p) => p.id === seeded.id) ?? seeded)
    })
  }, [])

  if (!profile) return null
  return <BackupsTab profile={profile} onProfileChange={setProfile} />
}

const container = document.getElementById('root')
if (!container) throw new Error('minecraft-backups.html is missing #root')
createRoot(container).render(<BackupsPage />)
