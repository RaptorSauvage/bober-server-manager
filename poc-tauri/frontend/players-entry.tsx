/**
 * Mounts the REAL, completely unmodified src/renderer/src/pages/PlayersView.tsx - an eighteenth
 * real page, and the first one needing zero new real code anywhere in this PoC: it's purely a
 * sidebar-tabbed composition of four pages already fully proven on their own
 * (PlayerRosterPanel - "A third real page", PlayerBansPanel - "A fourteenth real page",
 * PlayerWhitelistPanel - "A fourth real page", PlayerActivityPanel - "A twelfth real page").
 * window.api here is the union of all four of those pages' own entry files, unmodified - not a
 * new shim, just the same real functions with more real call sites active behind one UI at
 * once. Confirms the real tab-switching itself (not just each panel in isolation) renders and
 * mounts/unmounts each real child correctly against this architecture.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import PlayersView from '../../src/renderer/src/pages/PlayersView'
import { wrapInvoke } from './lib/tauriInvoke'
import type {
  BannedPlayer,
  PlayerActivityRecord,
  PlayerActivitySession,
  PlayerRosterEntry,
  ServerProfile,
  WhitelistedPlayer
} from '../../shared/types'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    }
    api: {
      system: {
        focusWindow: () => Promise<void>
      }
      playerRoster: {
        list: (profileId: string) => Promise<PlayerRosterEntry[]>
        kick: (profileId: string, playerId: string) => Promise<void>
      }
      playerBans: {
        list: () => Promise<BannedPlayer[]>
        ban: (profileId: string, playerId: string, playerName: string, reason: string) => Promise<BannedPlayer[]>
        unban: (profileId: string, playerId: string) => Promise<BannedPlayer[]>
      }
      playerWhitelist: {
        list: () => Promise<WhitelistedPlayer[]>
        add: (profileId: string, playerId: string, playerName: string) => Promise<WhitelistedPlayer[]>
        remove: (profileId: string, playerId: string) => Promise<WhitelistedPlayer[]>
      }
      playerActivity: {
        list: () => Promise<PlayerActivityRecord[]>
        sessions: () => Promise<PlayerActivitySession[]>
      }
    }
  }
}

const invoke = wrapInvoke(window.__TAURI__.core.invoke)

window.api = {
  system: {
    focusWindow: () => invoke('window_focus') as Promise<void>
  },
  playerRoster: {
    list: (profileId) => invoke('player_roster_list', { profileId }) as Promise<PlayerRosterEntry[]>,
    kick: (profileId, playerId) => invoke('player_roster_kick', { profileId, playerId }) as Promise<void>
  },
  playerBans: {
    list: () => invoke('player_bans_list') as Promise<BannedPlayer[]>,
    ban: (profileId, playerId, playerName, reason) =>
      invoke('player_bans_ban', { profileId, playerId, playerName, reason }) as Promise<BannedPlayer[]>,
    unban: (profileId, playerId) => invoke('player_bans_unban', { profileId, playerId }) as Promise<BannedPlayer[]>
  },
  playerWhitelist: {
    list: () => invoke('player_whitelist_list') as Promise<WhitelistedPlayer[]>,
    add: (profileId, playerId, playerName) =>
      invoke('player_whitelist_add', { profileId, playerId, playerName }) as Promise<WhitelistedPlayer[]>,
    remove: (profileId, playerId) =>
      invoke('player_whitelist_remove', { profileId, playerId }) as Promise<WhitelistedPlayer[]>
  },
  playerActivity: {
    list: () => invoke('player_activity_list') as Promise<PlayerActivityRecord[]>,
    sessions: () => invoke('player_activity_sessions') as Promise<PlayerActivitySession[]>
  }
}

function PlayersPage(): JSX.Element | null {
  const [profiles, setProfiles] = useState<ServerProfile[] | null>(null)

  useEffect(() => {
    invoke('profiles_list').then((result) => setProfiles(result as ServerProfile[]))
  }, [])

  if (!profiles) return null

  return <PlayersView profiles={profiles} onBack={() => window.history.back()} />
}

const container = document.getElementById('root')
if (!container) throw new Error('players.html is missing #root')
createRoot(container).render(<PlayersPage />)
