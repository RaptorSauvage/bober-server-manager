/**
 * Mounts the REAL, completely unmodified src/renderer/src/pages/ServerDetail/FilesTab.tsx - a
 * twenty-second real page: a Notepad++-inspired file browser and tabbed editor over the
 * server's own real install directory, with real history/diff/restore for .ini saves. Real,
 * unmodified lib/fileBrowser.ts functions (listFileBrowserEntries/resolveFileBrowserPath/
 * deleteFileBrowserFile/readIniFile/writeIniFile/listIniHistory/diffIniHistoryEntry/
 * restoreIniHistoryEntry), mirroring the real ipc/fileBrowser.ts handlers' exact bodies.
 * window.api.fileBrowser.open backs the real "Open" button - the exact same real
 * shell.openPath round trip through Rust "The reverse direction" already proved
 * (folders.openProfiles), just a new real call site of it, not a new mechanism.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import FilesTab from '../../src/renderer/src/pages/ServerDetail/FilesTab'
import { wrapInvoke } from './lib/tauriInvoke'
import type { ConfigFileHistorySummary, FileBrowserEntry, ServerProfile } from '../../shared/types'
import type { DiffLine } from '../../shared/textDiff'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    }
    api: {
      system: {
        focusWindow: () => Promise<void>
      }
      fileBrowser: {
        list: (profileId: string, relativePath: string) => Promise<{ path: string; entries: FileBrowserEntry[] }>
        open: (profileId: string, relativePath: string) => Promise<void>
        delete: (profileId: string, relativePath: string) => Promise<void>
        readIni: (profileId: string, relativePath: string) => Promise<string>
        writeIni: (profileId: string, relativePath: string, content: string) => Promise<void>
        iniHistory: (profileId: string, relativePath: string) => Promise<ConfigFileHistorySummary[]>
        iniHistoryDiff: (profileId: string, entryId: string) => Promise<DiffLine[]>
        iniRestore: (profileId: string, entryId: string) => Promise<void>
      }
    }
  }
}

const invoke = wrapInvoke(window.__TAURI__.core.invoke)

window.api = {
  system: {
    focusWindow: () => invoke('window_focus') as Promise<void>
  },
  fileBrowser: {
    list: (profileId, relativePath) =>
      invoke('file_browser_list', { profileId, relativePath }) as Promise<{
        path: string
        entries: FileBrowserEntry[]
      }>,
    open: (profileId, relativePath) => invoke('file_browser_open', { profileId, relativePath }) as Promise<void>,
    delete: (profileId, relativePath) => invoke('file_browser_delete', { profileId, relativePath }) as Promise<void>,
    readIni: (profileId, relativePath) => invoke('file_browser_read_ini', { profileId, relativePath }) as Promise<string>,
    writeIni: (profileId, relativePath, content) =>
      invoke('file_browser_write_ini', { profileId, relativePath, content }) as Promise<void>,
    iniHistory: (profileId, relativePath) =>
      invoke('file_browser_ini_history', { profileId, relativePath }) as Promise<ConfigFileHistorySummary[]>,
    iniHistoryDiff: (profileId, entryId) =>
      invoke('file_browser_ini_history_diff', { profileId, entryId }) as Promise<DiffLine[]>,
    iniRestore: (profileId, entryId) => invoke('file_browser_ini_restore', { profileId, entryId }) as Promise<void>
  }
}

function FilesPage(): JSX.Element | null {
  const [profile, setProfile] = useState<ServerProfile | null>(null)

  useEffect(() => {
    invoke('profiles_list').then((result) => {
      const profiles = result as ServerProfile[]
      const requestedId = new URLSearchParams(window.location.search).get('profile')
      setProfile(profiles.find((p) => p.id === requestedId) ?? profiles[0] ?? null)
    })
  }, [])

  if (!profile) return null
  return <FilesTab profile={profile} />
}

const container = document.getElementById('root')
if (!container) throw new Error('files.html is missing #root')
createRoot(container).render(<FilesPage />)
