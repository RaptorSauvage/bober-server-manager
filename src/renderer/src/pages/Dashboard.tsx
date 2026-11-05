import { useEffect, useState } from 'react'
import type { AppSettings, MapDefinition, ServerProfile, ServerRunState, ServerStatus, SystemStaticInfo } from '@shared/types'
import { getGameDefinition } from '@shared/games'
import { SERVER_DETAIL_TABS, type TabKey } from './ServerDetail'
import HardwareStatsBar from '../components/HardwareStatsBar'
import { GAME_ICONS } from '../lib/gameIcons'
import { confirmAction } from '../lib/confirmAction'
import updateIcon from '../assets/icons/update.png'
import CreateServerWizard from '../components/CreateServerWizard'

interface DashboardProps {
  profiles: ServerProfile[]
  onProfilesChange: (profiles: ServerProfile[]) => void
  onOpenProfile: (id: string, tab?: TabKey) => void
  /** Lifted up to App.tsx so the title bar's Tools > Add Profile menu item can open the same
   *  wizard from anywhere, not just from this page's own "+ Add Profile" button. */
  showCreateWizard: boolean
  onOpenCreateWizard: () => void
  onCloseCreateWizard: () => void
  /** These three also live in App.tsx rather than here, specifically because App.tsx never
   *  unmounts while this page does (every visit to a server's own detail view and back is a
   *  full unmount+remount) - keeping them here meant each one reset to its default and had to
   *  re-fetch/re-settle on every single navigation, a real visible flash (raw map ids,
   *  placeholder hardware text, a running server briefly showing "stopped" again). */
  statuses: Record<string, ServerStatus>
  maps: MapDefinition[]
  staticInfo: SystemStaticInfo | null
  /** Same reasoning as statuses/maps/staticInfo above - lifted to App.tsx so a Start/Update
   *  action's refresh (see handleUpdate/stopUpdateRestartAll below) can actually stick instead
   *  of being thrown away the moment this page remounts. */
  installedById: Record<string, boolean>
  gameVersionById: Record<string, string | null>
  refreshInstalled: (profileId: string) => Promise<void>
}

export default function Dashboard({
  profiles,
  onProfilesChange,
  onOpenProfile,
  showCreateWizard,
  onOpenCreateWizard,
  onCloseCreateWizard,
  statuses,
  maps,
  staticInfo,
  installedById,
  gameVersionById,
  refreshInstalled
}: DashboardProps): JSX.Element {
  const visibleProfiles = profiles.filter((p) => !p.hidden)
  const hiddenProfiles = profiles.filter((p) => p.hidden)
  const ungroupedProfiles = visibleProfiles.filter((p) => !p.group.trim())
  const [importError, setImportError] = useState('')
  const [importing, setImporting] = useState(false)
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragGroupName, setDragGroupName] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | ServerRunState>('all')
  const [mapFilter, setMapFilter] = useState('all')
  const [sortOrder, setSortOrder] = useState<'none' | 'name-asc' | 'name-desc'>('none')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [groupSubmenuId, setGroupSubmenuId] = useState<string | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  // Only drives the Uptime tile's freshness - a minute is plenty for something shown as
  // "1h 9m", unlike the Analytics tab's own per-second ticker which needs second precision.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    window.api.settings.get().then(setSettings)
  }, [])

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!openMenuId) return
    const close = (): void => {
      setOpenMenuId(null)
      setGroupSubmenuId(null)
      setNewGroupName('')
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [openMenuId])

  // Patch-based rather than taking a full AppSettings snapshot: this component fetches
  // `settings` once on mount and (since Dashboard now stays mounted for the whole session -
  // see "Keep Dashboard/MinecraftDashboard mounted" above) never refreshes it on its own, so
  // by the time a group gets reordered/collapsed hours into a session, Settings or another
  // screen may well have saved changes this component's own `settings` state never saw. Saving
  // `{ ...settings, ... }` straight from that stale snapshot would silently wipe those changes
  // back out, since settings.save() replaces the whole stored object rather than merging it.
  // Re-fetching right before the write and merging the patch onto *that* keeps this screen's
  // group-related writes from ever clobbering settings changed elsewhere in the meantime.
  async function persistSettings(patch: Partial<AppSettings>): Promise<void> {
    const current = await window.api.settings.get()
    const next = { ...current, ...patch }
    setSettings(next)
    await window.api.settings.save(next)
  }

  // Explicitly-ordered names first (in that order), then any group not mentioned yet -
  // a brand new group name just appears at the end, alphabetically among its peers, rather
  // than needing to be added to the order first. Includes registeredGroups so a group
  // created ahead of time (File > Manage Groups, or "New group..." on a card) still shows
  // its own empty section here, ready to receive servers, rather than only appearing once a
  // server actually has that group set.
  const groupNamesRaw = Array.from(
    new Set([
      ...visibleProfiles.filter((p) => p.group.trim()).map((p) => p.group.trim()),
      ...(settings?.registeredGroups ?? [])
    ])
  )
  const groupOrder = settings?.groupOrder ?? []
  const groupNames = [
    ...groupOrder.filter((name) => groupNamesRaw.includes(name)),
    ...groupNamesRaw.filter((name) => !groupOrder.includes(name)).sort((a, b) => a.localeCompare(b))
  ]
  const collapsedGroups = settings?.collapsedGroups ?? []

  /** Creates the group if it's new (so it keeps showing up even once empty again), then
   *  moves this one profile into it - used by the card menu's Group submenu. Passing '' puts
   *  the profile back in "no group". */
  async function setProfileGroup(profile: ServerProfile, groupName: string): Promise<void> {
    const trimmed = groupName.trim()
    if (trimmed && settings && !settings.registeredGroups.includes(trimmed)) {
      await persistSettings({ registeredGroups: [...settings.registeredGroups, trimmed] })
    }
    const updated = await window.api.profiles.save({ ...profile, group: trimmed })
    onProfilesChange(updated)
  }

  function setGroupCollapsed(name: string, collapsed: boolean): void {
    if (!settings) return
    const next = new Set(settings.collapsedGroups)
    if (collapsed) next.add(name)
    else next.delete(name)
    void persistSettings({ collapsedGroups: Array.from(next) })
  }

  async function handleGroupDrop(targetName: string): Promise<void> {
    const sourceName = dragGroupName
    setDragGroupName(null)
    if (!settings || !sourceName || sourceName === targetName) return
    const reordered = groupNames.slice()
    const fromIndex = reordered.indexOf(sourceName)
    const toIndex = reordered.indexOf(targetName)
    if (fromIndex === -1 || toIndex === -1) return
    reordered.splice(toIndex, 0, reordered.splice(fromIndex, 1)[0])
    await persistSettings({ groupOrder: reordered })
  }

  function mapDisplayName(mapId: string): string {
    return maps.find((m) => m.id === mapId)?.displayName ?? mapId
  }

  async function handleImport(): Promise<void> {
    setImportError('')
    const installDir = await window.api.dialog.selectDirectory()
    if (!installDir) return

    setImporting(true)
    try {
      const { profile, profiles: updated } = await window.api.profiles.importFromInstall(installDir)
      onProfilesChange(updated)
      onOpenProfile(profile.id, 'settings')
    } catch (err) {
      setImportError((err as Error).message)
    } finally {
      setImporting(false)
    }
  }

  async function handleImportFromFile(): Promise<void> {
    setImportError('')
    const filePath = await window.api.dialog.selectProfileFile()
    if (!filePath) return

    setImporting(true)
    try {
      const { profile, profiles: updated } = await window.api.profiles.importFromFile(filePath)
      onProfilesChange(updated)
      onOpenProfile(profile.id, 'settings')
    } catch (err) {
      setImportError((err as Error).message)
    } finally {
      setImporting(false)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!confirmAction('Delete this server profile? This does not delete any files on disk.')) return
    const updated = await window.api.profiles.delete(id)
    onProfilesChange(updated)
  }

  async function handleToggleHidden(profile: ServerProfile): Promise<void> {
    const updated = await window.api.profiles.save({ ...profile, hidden: !profile.hidden })
    onProfilesChange(updated)
  }

  async function runAction(profile: ServerProfile, action: () => Promise<unknown>): Promise<void> {
    setActionErrors((prev) => ({ ...prev, [profile.id]: '' }))
    try {
      await action()
    } catch (err) {
      setActionErrors((prev) => ({ ...prev, [profile.id]: (err as Error).message }))
    }
  }

  async function handleAction(profile: ServerProfile, action: 'start' | 'stop' | 'restart'): Promise<void> {
    await runAction(profile, () => window.api.server[action](profile.id))
  }

  async function handleKill(profile: ServerProfile): Promise<void> {
    if (!confirmAction(`Force-kill "${profile.name}" without saving? Progress since the last save will be lost.`)) return
    await runAction(profile, () => window.api.server.kill(profile.id))
  }

  async function handleUpdate(profile: ServerProfile): Promise<void> {
    await runAction(profile, () => window.api.server.update(profile.id))
    await refreshInstalled(profile.id)
  }

  function stateOf(profile: ServerProfile): ServerRunState {
    return statuses[profile.id]?.state ?? 'stopped'
  }

  async function runBulk(action: () => Promise<void>): Promise<void> {
    setBulkBusy(true)
    try {
      await action()
    } finally {
      setBulkBusy(false)
    }
  }

  async function startAll(targets: ServerProfile[]): Promise<void> {
    const toStart = targets.filter((p) => stateOf(p) === 'stopped')
    await Promise.all(toStart.map((p) => runAction(p, () => window.api.server.start(p.id))))
  }

  async function restartAll(targets: ServerProfile[]): Promise<void> {
    const toRestart = targets.filter((p) => stateOf(p) === 'running')
    await Promise.all(toRestart.map((p) => runAction(p, () => window.api.server.restart(p.id))))
  }

  async function stopAll(targets: ServerProfile[]): Promise<void> {
    const toStop = targets.filter((p) => stateOf(p) === 'running')
    await Promise.all(toStop.map((p) => runAction(p, () => window.api.server.stop(p.id))))
  }

  async function stopUpdateRestartAll(targets: ServerProfile[]): Promise<void> {
    const wasRunning = targets.filter((p) => stateOf(p) === 'running')
    await Promise.all(wasRunning.map((p) => runAction(p, () => window.api.server.stop(p.id))))

    // Stop above waits for each server to actually exit, so every profile is stopped now.
    await Promise.all(targets.map((p) => runAction(p, () => window.api.server.update(p.id))))
    await Promise.all(targets.map((p) => refreshInstalled(p.id)))

    await Promise.all(wasRunning.map((p) => runAction(p, () => window.api.server.start(p.id))))
  }

  /** Compact "1h 9m" / "2d 4h" form - the Uptime tile only has room for a glance, unlike the
   *  Analytics tab's own full "0d 1h 9m 42s" formatUptime. */
  function formatUptimeShort(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000)
    const days = Math.floor(totalMinutes / 1440)
    const hours = Math.floor((totalMinutes % 1440) / 60)
    const minutes = totalMinutes % 60
    return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`
  }

  /** Values both renderCard and renderListRow need, computed once per profile so the two
   *  views can never silently drift apart on what counts as "running", what the version
   *  label says, etc. */
  function cardData(profile: ServerProfile): {
    status: ServerStatus | undefined
    state: ServerRunState
    mapLabel: string
    versionLabel: string
    playersLabel: string
    uptimeLabel: string
    cpuLabel: string
    memoryLabel: string
  } {
    const status = statuses[profile.id]
    const state: ServerRunState = status?.state ?? 'stopped'
    const running = state === 'running'
    return {
      status,
      state,
      mapLabel: profile.map ? mapDisplayName(profile.map) : '(not set)',
      versionLabel: gameVersionById[profile.id] ?? '-',
      playersLabel: running && status?.players ? `${status.players.length} / ${profile.maxPlayers}` : '-',
      uptimeLabel: running && status?.startedAt ? formatUptimeShort(now - status.startedAt) : '-',
      cpuLabel: running && status?.cpu !== undefined ? `${status.cpu}%` : '-',
      memoryLabel: running && status?.memoryMB !== undefined ? `${status.memoryMB} MB` : '-'
    }
  }

  function renderActionButtons(profile: ServerProfile, state: ServerRunState, compact: boolean): JSX.Element {
    const updateTitle =
      installedById[profile.id] === false
        ? `No server executable found - expected one of:\n${profile.installDir}\\ShooterGame\\Binaries\\Win64\\ArkAscendedServer.exe\n${profile.installDir}/ShooterGame/Binaries/Linux/ArkAscendedServer`
        : 'Install/update the server files via SteamCMD'
    const updateLabel =
      installedById[profile.id] === false
        ? state === 'updating'
          ? 'Installing...'
          : 'Install'
        : state === 'updating'
          ? 'Updating...'
          : 'Update'
    return (
      <div className={compact ? 'action-row-list' : 'action-row'}>
        <button className="start" disabled={state !== 'stopped'} onClick={() => void handleAction(profile, 'start')} title="Start">
          ▶
        </button>
        <button className="stop" disabled={state !== 'running'} onClick={() => void handleAction(profile, 'stop')} title="Stop">
          ■
        </button>
        <button
          className="restart"
          disabled={state !== 'running'}
          onClick={() => void handleAction(profile, 'restart')}
          title="Restart"
        >
          ↻
        </button>
        <button
          className="update"
          disabled={state !== 'stopped'}
          onClick={() => void handleUpdate(profile)}
          title={`${updateLabel} - ${updateTitle}`}
        >
          <span className="icon-mask" style={{ WebkitMaskImage: `url("${updateIcon}")`, maskImage: `url("${updateIcon}")` }} />
        </button>
        <button
          className="kill"
          disabled={state === 'stopped' || state === 'updating'}
          onClick={() => void handleKill(profile)}
          title="Kill (force, no save)"
        >
          ✕
        </button>
      </div>
    )
  }

  /** Same icon set/colors as a single card's own Start/Stop/Restart buttons, just scoped to
   *  every server in this group instead of one - this replaced the old standalone "Server
   *  Controls" panel, which only ever acted on every visible server at once regardless of
   *  which group you actually wanted to manage. */
  function renderGroupBulkActions(groupProfiles: ServerProfile[]): JSX.Element {
    function run(action: (targets: ServerProfile[]) => Promise<void>): void {
      void runBulk(() => action(groupProfiles))
    }
    return (
      <div className="group-bulk-actions" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="start" disabled={bulkBusy} onClick={(e) => { e.preventDefault(); run(startAll) }} title="Start all in this group">
          ▶
        </button>
        <button type="button" className="stop" disabled={bulkBusy} onClick={(e) => { e.preventDefault(); run(stopAll) }} title="Stop all in this group">
          ■
        </button>
        <button type="button" className="restart" disabled={bulkBusy} onClick={(e) => { e.preventDefault(); run(restartAll) }} title="Restart all in this group">
          ↻
        </button>
        <button
          type="button"
          className="update"
          disabled={bulkBusy}
          onClick={(e) => { e.preventDefault(); run(stopUpdateRestartAll) }}
          title="Stop every running server in this group, update all of them via SteamCMD, then start the ones that were running back up"
        >
          <span className="icon-mask" style={{ WebkitMaskImage: `url("${updateIcon}")`, maskImage: `url("${updateIcon}")` }} />
        </button>
      </div>
    )
  }

  function renderCardMenu(profile: ServerProfile): JSX.Element {
    const open = openMenuId === profile.id
    return (
      <div className="header-right">
        <span className={`badge badge-${statuses[profile.id]?.state ?? 'stopped'}`}>
          {statuses[profile.id]?.state ?? 'stopped'}
        </span>
        <button
          type="button"
          className="card-menu-btn"
          onClick={(e) => {
            e.stopPropagation()
            setOpenMenuId(open ? null : profile.id)
          }}
        >
          ⋯
        </button>
        {open && (
          <div className="card-menu-dropdown open" onClick={(e) => e.stopPropagation()}>
            <div className="card-menu-group">
              {SERVER_DETAIL_TABS.map((t) => (
                <button key={t.key} onClick={() => onOpenProfile(profile.id, t.key)}>
                  <span className="card-menu-icon">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="card-menu-group">
              <button
                onClick={() => setGroupSubmenuId(groupSubmenuId === profile.id ? null : profile.id)}
              >
                Group: {profile.group.trim() || 'None'} {groupSubmenuId === profile.id ? '▾' : '▸'}
              </button>
              {groupSubmenuId === profile.id && (
                <div className="card-menu-submenu">
                  <button
                    className={!profile.group.trim() ? 'active' : ''}
                    onClick={() => {
                      void setProfileGroup(profile, '')
                      setGroupSubmenuId(null)
                      setOpenMenuId(null)
                    }}
                  >
                    No group
                  </button>
                  {groupNames.map((name) => (
                    <button
                      key={name}
                      className={profile.group.trim() === name ? 'active' : ''}
                      onClick={() => {
                        void setProfileGroup(profile, name)
                        setGroupSubmenuId(null)
                        setOpenMenuId(null)
                      }}
                    >
                      {name}
                    </button>
                  ))}
                  <form
                    className="card-menu-submenu-new"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (!newGroupName.trim()) return
                      void setProfileGroup(profile, newGroupName)
                      setNewGroupName('')
                      setGroupSubmenuId(null)
                      setOpenMenuId(null)
                    }}
                  >
                    <input
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      placeholder="New group..."
                      onClick={(e) => e.stopPropagation()}
                    />
                    <button type="submit" disabled={!newGroupName.trim()}>
                      +
                    </button>
                  </form>
                </div>
              )}
            </div>
            <div className="card-menu-group">
              <button
                onClick={() => void handleToggleHidden(profile)}
                title={profile.hidden ? 'Show this server on the main dashboard again' : 'Hide this server from the main dashboard'}
              >
                {profile.hidden ? 'Unhide' : 'Hide'}
              </button>
            </div>
            <div className="card-menu-group">
              <button className="danger" onClick={() => void handleDelete(profile.id)}>
                Delete Profile
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  function renderCard(profile: ServerProfile): JSX.Element {
    const { state, status, mapLabel, versionLabel, playersLabel, uptimeLabel, cpuLabel, memoryLabel } = cardData(profile)
    return (
      <div
        className={`server-card-v2 status-${state}${dragId === profile.id ? ' dragging' : ''}`}
        key={profile.id}
        draggable
        onDragStart={() => setDragId(profile.id)}
        onDragEnd={() => setDragId(null)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => void handleDrop(profile.id)}
      >
        <div className="server-card-v2-header">
          <div className="server-card-v2-title">
            <img
              src={GAME_ICONS[getGameDefinition(profile.game).iconFileName]}
              alt=""
              title={getGameDefinition(profile.game).displayName}
              className="server-card-game-icon"
            />
            <h3>{profile.name}</h3>
            <span className="server-version">v{versionLabel}</span>
          </div>
          {renderCardMenu(profile)}
        </div>
        {status?.lastError && <p className="error-message">{status.lastError}</p>}
        {actionErrors[profile.id] && <p className="error-message">{actionErrors[profile.id]}</p>}
        <div className="stat-tile-grid">
          <div className="stat-tile">
            <div className="stat-tile-label">Port</div>
            <div className="stat-tile-value">{profile.gamePort}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">Map</div>
            <div className="stat-tile-value">{mapLabel}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">Players</div>
            <div className="stat-tile-value">{playersLabel}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">Uptime</div>
            <div className="stat-tile-value">{uptimeLabel}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">CPU</div>
            <div className="stat-tile-value">{cpuLabel}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">Memory</div>
            <div className="stat-tile-value">{memoryLabel}</div>
          </div>
        </div>
        {renderActionButtons(profile, state, false)}
      </div>
    )
  }

  function renderListRow(profile: ServerProfile): JSX.Element {
    const { state, mapLabel, versionLabel, playersLabel, uptimeLabel, cpuLabel, memoryLabel } = cardData(profile)
    return (
      <tr key={profile.id}>
        <td>
          <span className={`badge badge-${state}`}>{state}</span>
        </td>
        <td>
          <strong>{profile.name}</strong>
        </td>
        <td className="mono">v{versionLabel}</td>
        <td>{mapLabel}</td>
        <td className="mono">{profile.gamePort}</td>
        <td>{playersLabel}</td>
        <td>{uptimeLabel}</td>
        <td>{cpuLabel}</td>
        <td>{memoryLabel}</td>
        <td>{renderActionButtons(profile, state, true)}</td>
      </tr>
    )
  }

  function renderProfileList(list: ServerProfile[]): JSX.Element {
    if (viewMode === 'list') {
      return (
        <table className="server-list-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Name</th>
              <th>Version</th>
              <th>Map</th>
              <th>Port</th>
              <th>Players</th>
              <th>Uptime</th>
              <th>CPU</th>
              <th>Memory</th>
              <th></th>
            </tr>
          </thead>
          <tbody>{list.map(renderListRow)}</tbody>
        </table>
      )
    }
    return <div className="server-grid">{list.map(renderCard)}</div>
  }

  async function handleDrop(targetId: string): Promise<void> {
    const sourceId = dragId
    setDragId(null)
    if (!sourceId || sourceId === targetId) return

    const ids = profiles.map((p) => p.id)
    const fromIndex = ids.indexOf(sourceId)
    const toIndex = ids.indexOf(targetId)
    ids.splice(toIndex, 0, ids.splice(fromIndex, 1)[0])

    const reordered = ids.map((id) => profiles.find((p) => p.id === id)!)
    onProfilesChange(reordered)
    const saved = await window.api.profiles.reorder(ids)
    onProfilesChange(saved)
  }

  // Matches on name or group, case-insensitively - with 13+ servers on one cluster, finding
  // a specific one by scrolling/expanding groups gets tedious fast. Forces matching groups
  // open below (regardless of their own collapsed state) so a match inside a collapsed group
  // is never hidden from the result. Status/Map narrow the same result set further - all
  // three combine with AND, same as the toolbar's own left-to-right reading order.
  const isSearching = searchQuery.trim().length > 0
  const isFiltering = isSearching || statusFilter !== 'all' || mapFilter !== 'all'
  function matchesFilters(profile: ServerProfile): boolean {
    if (isSearching) {
      const q = searchQuery.trim().toLowerCase()
      if (!profile.name.toLowerCase().includes(q) && !profile.group.toLowerCase().includes(q)) return false
    }
    if (statusFilter !== 'all' && (statuses[profile.id]?.state ?? 'stopped') !== statusFilter) return false
    if (mapFilter !== 'all' && profile.map !== mapFilter) return false
    return true
  }
  function sortProfiles(list: ServerProfile[]): ServerProfile[] {
    if (sortOrder === 'none') return list
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name))
    return sortOrder === 'name-desc' ? sorted.reverse() : sorted
  }
  // Every distinct map among this dashboard's own profiles, not every map the game
  // supports - an empty "All Maps" dropdown full of maps nobody's actually running would be
  // closer to noise than a filter.
  const availableMaps = Array.from(new Set(visibleProfiles.map((p) => p.map).filter(Boolean))).sort((a, b) =>
    mapDisplayName(a).localeCompare(mapDisplayName(b))
  )

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Bober Server Manager</h1>
        <div className="dashboard-header-actions">
          <button className="btn-accent" onClick={onOpenCreateWizard}>
            + Add Profile
          </button>
        </div>
      </header>

      {showCreateWizard && (
        <CreateServerWizard
          profiles={profiles}
          onProfilesChange={onProfilesChange}
          onImportInstall={handleImport}
          onImportFile={handleImportFromFile}
          importing={importing}
          importError={importError}
          onClose={() => {
            onCloseCreateWizard()
            setImportError('')
          }}
        />
      )}

      <HardwareStatsBar profiles={visibleProfiles} statuses={statuses} labelPrefix="ARK Servers" staticInfo={staticInfo} />

      <div className="toolbar">
        <div className="toolbar-filters">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">All Statuses</option>
            <option value="running">Running</option>
            <option value="starting">Starting</option>
            <option value="stopping">Stopping</option>
            <option value="stopped">Stopped</option>
            <option value="updating">Updating</option>
          </select>
          <select value={mapFilter} onChange={(e) => setMapFilter(e.target.value)}>
            <option value="all">All Maps</option>
            {availableMaps.map((mapId) => (
              <option key={mapId} value={mapId}>
                {mapDisplayName(mapId)}
              </option>
            ))}
          </select>
          <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}>
            <option value="none">Default order</option>
            <option value="name-asc">Name (A-Z)</option>
            <option value="name-desc">Name (Z-A)</option>
          </select>
        </div>
        <input
          type="search"
          className="dashboard-search"
          placeholder="Search servers..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <div className="view-toggle">
          <button type="button" className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')}>
            ▦ Grid
          </button>
          <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>
            ☰ List
          </button>
        </div>
      </div>

      <div className="dashboard-body">
        <div className="dashboard-content">
          {profiles.length === 0 && (
            <p className="empty-state">No server profiles yet. Click &quot;Add Profile&quot; to configure one.</p>
          )}
          {profiles.length > 0 && visibleProfiles.length === 0 && (
            <p className="empty-state">
              Every server profile is hidden. Expand &quot;Hidden servers&quot; below to unhide one.
            </p>
          )}
          {isFiltering && !visibleProfiles.some(matchesFilters) && (
            <p className="empty-state">No server matches the current search/filters.</p>
          )}

          {renderProfileList(sortProfiles(ungroupedProfiles.filter(matchesFilters)))}

          {groupNames.map((groupName) => {
            const groupProfiles = visibleProfiles.filter((p) => p.group.trim() === groupName)
            const matchingGroupProfiles = sortProfiles(groupProfiles.filter(matchesFilters))
            if (isFiltering && matchingGroupProfiles.length === 0) return null
            return (
            <details
              className={`server-group${dragGroupName === groupName ? ' dragging' : ''}`}
              key={groupName}
              open={isFiltering || !collapsedGroups.includes(groupName)}
              onToggle={(e) => setGroupCollapsed(groupName, !(e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => void handleGroupDrop(groupName)}
              >
                <span
                  className="drag-handle"
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation()
                    setDragGroupName(groupName)
                  }}
                  onDragEnd={() => setDragGroupName(null)}
                  title="Drag to reorder groups"
                >
                  ⠿
                </span>
                <span className="server-group-name">{groupName}</span>
                {renderGroupBulkActions(groupProfiles)}
              </summary>
              {renderProfileList(matchingGroupProfiles)}
            </details>
            )
          })}

          {hiddenProfiles.length > 0 && (
            <details className="hidden-servers">
              <summary>Hidden servers ({hiddenProfiles.length})</summary>
              {renderProfileList(sortProfiles(hiddenProfiles.filter(matchesFilters)))}
            </details>
          )}
        </div>
      </div>
    </div>
  )
}
