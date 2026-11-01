/**
 * Mounts the REAL, completely unmodified src/renderer/src/pages/ServerDetail/ModsTab.tsx - a
 * twenty-third real page. Real, unmodified syncAseModsToIni/reconcileAseModsFromIni
 * (gameConfigWrite.ts) - the same real functions "A nineteenth real page"'s
 * applyModEventChange already called internally, new direct real call sites of them here, not
 * a new mechanism. Real, unmodified parseImportedMods (modsExport.ts) and
 * searchArkMods/getArkModsInfo (arkMods.ts, the real CurseForge API client) - honestly
 * real-gracefully empty with no real network attempt at all when no CurseForge API key is
 * configured (this sandbox's own state), the opposite honest-gap shape from SteamCMD's own
 * always-attempts fetch in "A sixteenth real page".
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import ModsTab from '../../src/renderer/src/pages/ServerDetail/ModsTab'
import { wrapInvoke } from './lib/tauriInvoke'
import type { ArkModInfoMap, ArkModSearchResult, AppSettings, ServerMod, ServerProfile } from '../../shared/types'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    }
    api: {
      settings: {
        get: () => Promise<AppSettings>
      }
      mods: {
        save: (profileId: string, mods: ServerMod[]) => Promise<ServerProfile>
        parseText: (text: string) => Promise<ServerMod[]>
        reconcileFromIni: (profileId: string) => Promise<ServerProfile>
      }
      arkMods: {
        search: (query: string) => Promise<ArkModSearchResult[]>
        info: (modIds: string[]) => Promise<ArkModInfoMap>
      }
    }
  }
}

const invoke = wrapInvoke(window.__TAURI__.core.invoke)

window.api = {
  settings: {
    get: () => invoke('settings_get') as Promise<AppSettings>
  },
  mods: {
    save: (profileId, mods) => invoke('mods_save', { profileId, mods }) as Promise<ServerProfile>,
    parseText: (text) => invoke('mods_parse_text', { text }) as Promise<ServerMod[]>,
    reconcileFromIni: (profileId) => invoke('mods_reconcile_from_ini', { profileId }) as Promise<ServerProfile>
  },
  arkMods: {
    search: (query) => invoke('ark_mods_search', { query }) as Promise<ArkModSearchResult[]>,
    info: (modIds) => invoke('ark_mods_info', { modIds }) as Promise<ArkModInfoMap>
  }
}

function ModsPage(): JSX.Element | null {
  const [profile, setProfile] = useState<ServerProfile | null>(null)

  useEffect(() => {
    invoke('profiles_list').then((result) => {
      const profiles = result as ServerProfile[]
      const requestedId = new URLSearchParams(window.location.search).get('profile')
      setProfile(profiles.find((p) => p.id === requestedId) ?? profiles[0] ?? null)
    })
  }, [])

  if (!profile) return null
  return <ModsTab profile={profile} onProfileChange={setProfile} />
}

const container = document.getElementById('root')
if (!container) throw new Error('mods.html is missing #root')
createRoot(container).render(<ModsPage />)
