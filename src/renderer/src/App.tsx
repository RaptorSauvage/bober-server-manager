import { useEffect, useState } from 'react'
import type { MapDefinition, ServerProfile, SystemStaticInfo } from '@shared/types'
import type { MinecraftProfile } from '@shared/minecraft'
import { listGameDefinitions } from '@shared/games'
import { useServerStatuses } from './lib/useServerStatuses'
import { useMinecraftServerStatuses } from './lib/useMinecraftServerStatuses'
import Dashboard from './pages/Dashboard'
import ClusterDataView from './pages/ClusterDataView'
import GroupConsoleView from './pages/GroupConsoleView'
import ManagerLogView from './pages/ManagerLogView'
import ServerDetail, { type TabKey } from './pages/ServerDetail'
import SteamCmdView from './pages/SteamCmdView'
import DataSettingsView from './pages/DataSettingsView'
import ChangelogView from './pages/ChangelogView'
import PlayersView from './pages/PlayersView'
import ProfileManagementView from './pages/ProfileManagementView'
import MapManagerView from './pages/MapManagerView'
import EventSchedulerView from './pages/EventSchedulerView'
import IniTemplatesView from './pages/IniTemplatesView'
import MinecraftDashboard from './pages/MinecraftDashboard'
import MinecraftServerDetail, { type MinecraftTabKey } from './pages/MinecraftServerDetail'
import { GAME_ICONS } from './lib/gameIcons'
import minecraftIcon from './assets/games/minecraft.png'
import TitleBar from './components/TitleBar'
import SidePanel from './components/SidePanel'
import ManageGroupsDialog from './components/ManageGroupsDialog'
import dashboardIcon from './assets/icons/dashboard.png'
import clusterIcon from './assets/icons/cluster.png'
import playersIcon from './assets/icons/players.png'
import settingsIcon from './assets/icons/settings.png'
import logIcon from './assets/icons/log.png'
import appLogo from './assets/icons/app-logo.png'

type MainPage = 'dashboard' | 'clusterData' | 'players' | 'managerLog'
type GameMode = 'ark' | 'minecraft'

/** A sidebar nav button's leading icon - either a line-art image (masked into the current
 *  text color, same technique as the Update button's shield icon) for the ones the user
 *  supplied real artwork for, or a plain emoji glyph for the rest, matching how the app
 *  already mixes both elsewhere (card action icons vs. the title bar's bell/grid). */
function SidebarIcon({ mask, emoji }: { mask?: string; emoji?: string }): JSX.Element {
  if (mask) {
    return (
      <span className="sidebar-icon icon-mask" style={{ WebkitMaskImage: `url("${mask}")`, maskImage: `url("${mask}")` }} />
    )
  }
  return <span className="sidebar-icon">{emoji}</span>
}

/** The ARK/Minecraft switch - its own small group at the top of the sidebar, visually
 *  separate (a divider below it) from whatever page nav follows, since it toggles the
 *  entire app's mode rather than navigating within it. */
function GameSwitch({ mode, onChange }: { mode: GameMode; onChange: (mode: GameMode) => void }): JSX.Element {
  return (
    <div className="app-sidebar-game-switch">
      <button
        type="button"
        className={mode === 'ark' ? 'active' : ''}
        onClick={() => onChange('ark')}
        title="ARK: Survival Evolved / Ascended"
      >
        <img src={GAME_ICONS['ark-evolved.png']} alt="ARK" />
      </button>
      <button
        type="button"
        className={mode === 'minecraft' ? 'active' : ''}
        onClick={() => onChange('minecraft')}
        title="Minecraft"
      >
        <img src={minecraftIcon} alt="Minecraft" />
      </button>
    </div>
  )
}

export default function App(): JSX.Element {
  const [gameMode, setGameMode] = useState<GameMode>('ark')

  const [profiles, setProfiles] = useState<ServerProfile[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [initialTab, setInitialTab] = useState<TabKey | undefined>(undefined)
  const [showSteamCmd, setShowSteamCmd] = useState(false)
  const [showDataSettings, setShowDataSettings] = useState(false)
  const [showProfileManagement, setShowProfileManagement] = useState(false)
  const [showMapManager, setShowMapManager] = useState(false)
  const [showEventScheduler, setShowEventScheduler] = useState(false)
  const [showIniTemplates, setShowIniTemplates] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)
  const [showManageGroups, setShowManageGroups] = useState(false)
  const [showCreateWizard, setShowCreateWizard] = useState(false)
  const [mainPage, setMainPage] = useState<MainPage>('dashboard')
  const [groupConsoleTarget, setGroupConsoleTarget] = useState<{ groupName: string; profileIds: string[] } | null>(
    null
  )
  const [loaded, setLoaded] = useState(false)

  const [minecraftProfiles, setMinecraftProfiles] = useState<MinecraftProfile[]>([])
  const [minecraftSelectedId, setMinecraftSelectedId] = useState<string | null>(null)
  const [minecraftInitialTab, setMinecraftInitialTab] = useState<MinecraftTabKey | undefined>(undefined)
  const [minecraftLoaded, setMinecraftLoaded] = useState(false)

  // Separate from loaded/minecraftLoaded above - those just reflect the first profiles list
  // IPC calls resolving, which (now that main/index.ts's own startup sequence yields between
  // steps instead of blocking start to finish) can happen well before the rest of startup
  // actually finishes. Query-then-subscribe: isComplete() covers the window where it was
  // already done by the time this mounts, onComplete covers the window where it finishes
  // while this is already waiting.
  const [startupComplete, setStartupComplete] = useState(false)
  useEffect(() => {
    let cancelled = false
    window.api.appStartup.isComplete().then((complete) => {
      if (!cancelled && complete) setStartupComplete(true)
    })
    const unsubscribe = window.api.appStartup.onComplete(() => setStartupComplete(true))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Lifted up here (rather than living inside Dashboard/MinecraftDashboard/HardwareStatsBar
  // themselves) specifically because App.tsx never unmounts, while Dashboard does: navigating
  // to a server's own detail view and back is a full unmount+remount of Dashboard (see the
  // mutually exclusive `if (selected) { return <ServerDetail ... /> }` branch below), so state
  // that lived inside it reset to its defaults and had to re-fetch/re-settle on every single
  // visit. That showed up as a real, visible flash: map names briefly showing raw ids
  // ("TheIsland_WP") before the friendly ones loaded, hardware cards briefly showing generic
  // placeholder text, and worst of all a server that's actually running briefly showing
  // "STOPPED" again until its real status re-arrived - exactly what a user caught on video.
  const statuses = useServerStatuses(profiles.map((p) => p.id))
  const minecraftStatuses = useMinecraftServerStatuses(minecraftProfiles.map((p) => p.id))
  const [maps, setMaps] = useState<MapDefinition[]>([])
  const [hardwareStaticInfo, setHardwareStaticInfo] = useState<SystemStaticInfo | null>(null)

  useEffect(() => {
    // Merged across every known game, not just whichever profiles happen to be loaded - map
    // ids don't collide between games (ARK: Survival Ascended's carry a _WP suffix ARK:
    // Survival Evolved's don't), so one combined lookup covers every card correctly.
    void Promise.all(listGameDefinitions().map((g) => window.api.maps.list(g.id))).then((lists) => setMaps(lists.flat()))
  }, [])

  useEffect(() => {
    window.api.systemStats
      .get()
      .then(setHardwareStaticInfo)
      .catch(() => {
        // Best-effort - the hardware stats bar just renders without the "16 Cores / 32
        // Threads • ..." and "X GB total RAM" context lines if this one-time fetch fails.
      })
  }, [])

  // Same remount-reset problem as above, for the two bits of per-server info Dashboard's own
  // cards show beyond live status: whether a profile's install is actually present on disk,
  // and the detected game version string.
  const [installedById, setInstalledById] = useState<Record<string, boolean>>({})
  const [gameVersionById, setGameVersionById] = useState<Record<string, string | null>>({})

  useEffect(() => {
    let cancelled = false
    void Promise.all(profiles.map(async (p) => [p.id, await window.api.server.isInstalled(p.id)] as const)).then(
      (entries) => {
        if (!cancelled) setInstalledById(Object.fromEntries(entries))
      }
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.map((p) => `${p.id}:${p.installDir}`).join(',')])

  async function refreshInstalled(profileId: string): Promise<void> {
    const installed = await window.api.server.isInstalled(profileId)
    setInstalledById((prev) => ({ ...prev, [profileId]: installed }))
  }

  // One-shot per profile list change - reads whatever's already cached/known (or reads it
  // once from the log if not), no polling/"Detecting..." here like the Analytics tab does.
  useEffect(() => {
    let cancelled = false
    void Promise.all(profiles.map(async (p) => [p.id, await window.api.server.getGameVersion(p.id)] as const)).then(
      (entries) => {
        if (!cancelled) setGameVersionById(Object.fromEntries(entries))
      }
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.map((p) => p.id).join(',')])

  useEffect(() => {
    window.api.profiles.list().then((list) => {
      setProfiles(list)
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    window.api.minecraft.profiles.list().then((list) => {
      setMinecraftProfiles(list)
      setMinecraftLoaded(true)
    })
  }, [])

  // Same reasoning as the ARK profiles.onChanged effect below - keeps this window's
  // Minecraft profile list live if it's ever changed from outside it.
  useEffect(() => {
    return window.api.minecraft.profiles.onChanged((updated) => {
      setMinecraftProfiles(updated)
      setMinecraftSelectedId((prev) => (prev && !updated.some((p) => p.id === prev) ? null : prev))
    })
  }, [])

  // Keeps this window's profile list live even when a change came from outside it - most
  // notably the web dashboard's own HTTP routes, which save profiles directly without going
  // through this window's IPC calls at all, so without this an edit made there would only
  // ever show up here after a restart. Uses the functional setSelectedId form rather than
  // reading selectedId directly, since this effect's closure is fixed at mount and a direct
  // read would go stale the moment a server is actually selected.
  useEffect(() => {
    return window.api.profiles.onChanged((updated) => {
      setProfiles(updated)
      setSelectedId((prev) => (prev && !updated.some((p) => p.id === prev) ? null : prev))
    })
  }, [])

  // Settings/SteamCMD/Profile Management/Changelog are all checked ahead of the "selected
  // server"/"group console" branches below, so just setting their flags from the title bar
  // already takes over the view regardless of what's currently showing - no extra resetting
  // needed. "Manager Log" is different: it's a mainPage *inside* the default shell branch,
  // which is checked last, so reaching it from somewhere like a server's own detail view also
  // needs that other view's own state cleared first, or the earlier branch would still win.
  function handleOpenManagerLog(): void {
    setSelectedId(null)
    setMinecraftSelectedId(null)
    setGroupConsoleTarget(null)
    setShowSteamCmd(false)
    setShowDataSettings(false)
    setShowProfileManagement(false)
    setShowMapManager(false)
    setShowChangelog(false)
    setMainPage('managerLog')
  }

  // Same reasoning as handleOpenManagerLog above - the wizard only renders inside Dashboard's
  // own JSX, which only mounts for the default ARK shell branch, so reaching it from anywhere
  // else needs every other view's state cleared first.
  function handleOpenCreateWizard(): void {
    setSelectedId(null)
    setMinecraftSelectedId(null)
    setGroupConsoleTarget(null)
    setShowSteamCmd(false)
    setShowDataSettings(false)
    setShowProfileManagement(false)
    setShowMapManager(false)
    setShowChangelog(false)
    setGameMode('ark')
    setMainPage('dashboard')
    setShowCreateWizard(true)
  }

  // Settings/SteamCMD/Profile Management/Map Manager/Event Scheduler/INI Templates now
  // render as a right-side drawer (see SidePanel) over whatever page is already showing,
  // rather than replacing it outright - so opening one just needs the others closed first,
  // nothing else to reset.
  function openSteamCmd(): void {
    setShowDataSettings(false)
    setShowProfileManagement(false)
    setShowMapManager(false)
    setShowEventScheduler(false)
    setShowIniTemplates(false)
    setShowSteamCmd(true)
  }

  function openDataSettings(): void {
    setShowSteamCmd(false)
    setShowProfileManagement(false)
    setShowMapManager(false)
    setShowEventScheduler(false)
    setShowIniTemplates(false)
    setShowDataSettings(true)
  }

  function openProfileManagement(): void {
    setShowSteamCmd(false)
    setShowDataSettings(false)
    setShowMapManager(false)
    setShowEventScheduler(false)
    setShowIniTemplates(false)
    setShowProfileManagement(true)
  }

  function openMapManager(): void {
    setShowSteamCmd(false)
    setShowDataSettings(false)
    setShowProfileManagement(false)
    setShowEventScheduler(false)
    setShowIniTemplates(false)
    setShowMapManager(true)
  }

  function openEventScheduler(): void {
    setShowSteamCmd(false)
    setShowDataSettings(false)
    setShowProfileManagement(false)
    setShowMapManager(false)
    setShowIniTemplates(false)
    setShowEventScheduler(true)
  }

  function openIniTemplates(): void {
    setShowSteamCmd(false)
    setShowDataSettings(false)
    setShowProfileManagement(false)
    setShowMapManager(false)
    setShowEventScheduler(false)
    setShowIniTemplates(true)
  }

  const titleBar = (
    <TitleBar
      onOpenSettings={openDataSettings}
      onOpenSteamCmd={openSteamCmd}
      onOpenProfileManagement={openProfileManagement}
      onOpenMapManager={openMapManager}
      onOpenEventScheduler={openEventScheduler}
      onOpenIniTemplates={openIniTemplates}
      onOpenManageGroups={() => setShowManageGroups(true)}
      onOpenManagerLog={handleOpenManagerLog}
      onOpenChangelog={() => setShowChangelog(true)}
      onOpenCreateWizard={handleOpenCreateWizard}
    />
  )

  if (!loaded || !minecraftLoaded || !startupComplete) {
    return (
      <>
        {titleBar}
        <div className="loading">
          <img src={appLogo} alt="" className="loading-logo" />
          <div className="loading-spinner" />
          <div>Loading...</div>
        </div>
      </>
    )
  }

  const selected = profiles.find((p) => p.id === selectedId) ?? null
  const minecraftSelected = minecraftProfiles.find((p) => p.id === minecraftSelectedId) ?? null

  function handleProfilesChange(updated: ServerProfile[]): void {
    setProfiles(updated)
    if (selectedId && !updated.find((p) => p.id === selectedId)) {
      setSelectedId(null)
    }
  }

  function handleProfileChange(updated: ServerProfile): void {
    setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
  }

  function handleOpenProfile(id: string, tab?: TabKey): void {
    setSelectedId(id)
    setInitialTab(tab)
  }

  function handleOpenGroup(groupName: string, groupProfiles: ServerProfile[]): void {
    setGroupConsoleTarget({ groupName, profileIds: groupProfiles.map((p) => p.id) })
  }

  function handleMinecraftProfilesChange(updated: MinecraftProfile[]): void {
    setMinecraftProfiles(updated)
    if (minecraftSelectedId && !updated.find((p) => p.id === minecraftSelectedId)) {
      setMinecraftSelectedId(null)
    }
  }

  function handleMinecraftProfileChange(updated: MinecraftProfile): void {
    setMinecraftProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
  }

  function handleOpenMinecraftProfile(id: string, tab?: MinecraftTabKey): void {
    setMinecraftSelectedId(id)
    setMinecraftInitialTab(tab)
  }

  // Changelog is still a full-page takeover (not one of the four right-side drawers below) -
  // checked before the ARK/Minecraft split since it's reachable from either game mode.
  if (showChangelog) {
    return (
      <>
        {titleBar}
        <ChangelogView onBack={() => setShowChangelog(false)} />
      </>
    )
  }

  // Settings/SteamCMD/Profile Management/Map Manager render as a right-side drawer (see
  // SidePanel) layered on top of whatever mainContent below ends up being, instead of
  // replacing it outright - so this page tree no longer needs to special-case them.
  //
  // The Dashboard/MinecraftDashboard shell below is always rendered once gameMode first
  // reaches it, merely hidden (via .app-view-hidden, plain CSS display:none) rather than
  // conditionally unmounted whenever ServerDetail/GroupConsoleView takes over - it used to be
  // a genuine `if (selected) return <ServerDetail ... />` early return, which meant every
  // single Back click fully tore down Dashboard and rebuilt it from an empty default state,
  // visibly flashing through placeholder data (raw map ids, "Stopped" for a server that was
  // actually running, generic hardware-card text) while everything it needs re-fetched from
  // scratch. Keeping it mounted in the background means it's already showing the right thing
  // the instant it's shown again, same as it would if you'd just never navigated away.
  // Each game mode's whole tree (not just Dashboard/ServerDetail within one mode, see above)
  // stays mounted and merely hidden via .app-view-hidden rather than swapped by a ternary -
  // same reasoning, same fix for the same flash, just one level up: switching gameMode used to
  // unmount the entire other side (sidebar, Dashboard, any open ServerDetail) and rebuild it
  // from scratch on every single switch back, which is both the visible flash and the real
  // lag a user can feel on a slower machine, not just a redraw.
  const mainContent = (
    <>
      <div className={gameMode === 'minecraft' ? '' : 'app-view-hidden'}>
        <div className={minecraftSelected ? 'app-shell app-view-hidden' : 'app-shell'}>
          <nav className="app-sidebar">
            <GameSwitch mode={gameMode} onChange={setGameMode} />
            <button
              type="button"
              className={mainPage !== 'managerLog' ? 'active' : ''}
              onClick={() => setMainPage('dashboard')}
              title="Minecraft Servers"
            >
              <SidebarIcon mask={dashboardIcon} />
            </button>
            <button
              type="button"
              className="app-sidebar-bottom-group"
              onClick={() => setShowChangelog(true)}
              title="What's New"
            >
              <SidebarIcon emoji="🔔" />
            </button>
            <button
              type="button"
              className={mainPage === 'managerLog' ? 'active' : ''}
              onClick={() => setMainPage('managerLog')}
              title="Log"
            >
              <SidebarIcon mask={logIcon} />
            </button>
            <button type="button" onClick={openDataSettings} title="Settings">
              <SidebarIcon mask={settingsIcon} />
            </button>
          </nav>
          <div className="app-content">
            {mainPage === 'managerLog' ? (
              <ManagerLogView />
            ) : (
              <MinecraftDashboard
                profiles={minecraftProfiles}
                onProfilesChange={handleMinecraftProfilesChange}
                onOpenProfile={handleOpenMinecraftProfile}
                statuses={minecraftStatuses}
                staticInfo={hardwareStaticInfo}
              />
            )}
          </div>
        </div>
        {minecraftSelected && (
          <MinecraftServerDetail
            profile={minecraftSelected}
            initialTab={minecraftInitialTab}
            onBack={() => setMinecraftSelectedId(null)}
            onProfileChange={handleMinecraftProfileChange}
          />
        )}
      </div>
      <div className={gameMode === 'ark' ? '' : 'app-view-hidden'}>
        <div className={selected || groupConsoleTarget ? 'app-shell app-view-hidden' : 'app-shell'}>
          <nav className="app-sidebar">
            <GameSwitch mode={gameMode} onChange={setGameMode} />
            <button
              type="button"
              className={mainPage === 'dashboard' ? 'active' : ''}
              onClick={() => setMainPage('dashboard')}
              title="Dashboard"
            >
              <SidebarIcon mask={dashboardIcon} />
            </button>
            <button
              type="button"
              className={mainPage === 'clusterData' ? 'active' : ''}
              onClick={() => setMainPage('clusterData')}
              title="Cluster Dashboard"
            >
              <SidebarIcon mask={clusterIcon} />
            </button>
            <button
              type="button"
              className={mainPage === 'players' ? 'active' : ''}
              onClick={() => setMainPage('players')}
              title="Players"
            >
              <SidebarIcon mask={playersIcon} />
            </button>
            <button
              type="button"
              className="app-sidebar-bottom-group"
              onClick={() => setShowChangelog(true)}
              title="What's New"
            >
              <SidebarIcon emoji="🔔" />
            </button>
            <button
              type="button"
              className={mainPage === 'managerLog' ? 'active' : ''}
              onClick={() => setMainPage('managerLog')}
              title="Log"
            >
              <SidebarIcon mask={logIcon} />
            </button>
            <button type="button" onClick={openDataSettings} title="Settings">
              <SidebarIcon mask={settingsIcon} />
            </button>
          </nav>
          <div className="app-content">
            {mainPage === 'clusterData' ? (
              <ClusterDataView profiles={profiles} onOpenGroup={handleOpenGroup} />
            ) : mainPage === 'players' ? (
              <PlayersView profiles={profiles} />
            ) : mainPage === 'managerLog' ? (
              <ManagerLogView />
            ) : (
              <Dashboard
                profiles={profiles}
                onProfilesChange={handleProfilesChange}
                onOpenProfile={handleOpenProfile}
                showCreateWizard={showCreateWizard}
                onOpenCreateWizard={() => setShowCreateWizard(true)}
                onCloseCreateWizard={() => setShowCreateWizard(false)}
                statuses={statuses}
                maps={maps}
                staticInfo={hardwareStaticInfo}
                installedById={installedById}
                gameVersionById={gameVersionById}
                refreshInstalled={refreshInstalled}
              />
            )}
          </div>
        </div>
        {selected ? (
          <ServerDetail
            profile={selected}
            initialTab={initialTab}
            onBack={() => setSelectedId(null)}
            onProfileChange={handleProfileChange}
          />
        ) : (
          groupConsoleTarget && (
            <GroupConsoleView
              groupName={groupConsoleTarget.groupName}
              profiles={profiles.filter((p) => groupConsoleTarget.profileIds.includes(p.id))}
              onBack={() => setGroupConsoleTarget(null)}
              onOpenProfile={handleOpenProfile}
            />
          )
        )}
      </div>
    </>
  )

  return (
    <>
      {titleBar}
      {mainContent}
      {showSteamCmd && (
        <SidePanel onClose={() => setShowSteamCmd(false)}>
          <SteamCmdView onBack={() => setShowSteamCmd(false)} />
        </SidePanel>
      )}
      {showDataSettings && (
        <SidePanel onClose={() => setShowDataSettings(false)}>
          <DataSettingsView onBack={() => setShowDataSettings(false)} />
        </SidePanel>
      )}
      {showProfileManagement && (
        <SidePanel onClose={() => setShowProfileManagement(false)}>
          <ProfileManagementView
            profiles={profiles}
            onProfilesChange={handleProfilesChange}
            onBack={() => setShowProfileManagement(false)}
          />
        </SidePanel>
      )}
      {showMapManager && (
        <SidePanel onClose={() => setShowMapManager(false)}>
          <MapManagerView onBack={() => setShowMapManager(false)} />
        </SidePanel>
      )}
      {showEventScheduler && (
        <SidePanel onClose={() => setShowEventScheduler(false)}>
          <EventSchedulerView profiles={profiles} onBack={() => setShowEventScheduler(false)} />
        </SidePanel>
      )}
      {showIniTemplates && (
        <SidePanel onClose={() => setShowIniTemplates(false)}>
          <IniTemplatesView profiles={profiles} onBack={() => setShowIniTemplates(false)} />
        </SidePanel>
      )}
      {showManageGroups && (
        <ManageGroupsDialog
          profiles={profiles}
          onProfilesChange={handleProfilesChange}
          onClose={() => setShowManageGroups(false)}
        />
      )}
    </>
  )
}
