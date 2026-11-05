import { useEffect, useState } from 'react'
import type { AppSettings, SystemStaticInfo } from '@shared/types'
import type { MinecraftProfile, MinecraftRunState, MinecraftServerStatus, MinecraftServerType } from '@shared/minecraft'
import { createDefaultMinecraftProfile } from '../lib/minecraftProfile'
import { confirmAction } from '../lib/confirmAction'
import { tabsFor, type MinecraftTabKey } from './MinecraftServerDetail'
import InstallMinecraftServerPanel from './InstallMinecraftServerPanel'
import HardwareStatsBar from '../components/HardwareStatsBar'
import { MINECRAFT_SERVER_TYPE_ICONS } from '../lib/minecraftServerTypeIcons'
import minecraftIcon from '../assets/games/minecraft.png'

const SERVER_TYPE_LABELS: Record<MinecraftServerType, string> = {
  vanilla: 'Vanilla',
  paper: 'Paper',
  spigot: 'Spigot',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  spongevanilla: 'SpongeVanilla',
  spongeforge: 'SpongeForge',
  unknown: 'Unknown'
}

interface MinecraftDashboardProps {
  profiles: MinecraftProfile[]
  onProfilesChange: (profiles: MinecraftProfile[]) => void
  onOpenProfile: (id: string, tab?: MinecraftTabKey) => void
  /** Lifted up to App.tsx - see Dashboard.tsx's own DashboardProps doc comment for why
   *  (the short version: App.tsx never unmounts, this page does). */
  statuses: Record<string, MinecraftServerStatus>
  staticInfo: SystemStaticInfo | null
}

export default function MinecraftDashboard({
  profiles,
  onProfilesChange,
  onOpenProfile,
  statuses,
  staticInfo
}: MinecraftDashboardProps): JSX.Element {
  const visibleProfiles = profiles.filter((p) => !p.hidden)
  const hiddenProfiles = profiles.filter((p) => p.hidden)
  const ungroupedProfiles = visibleProfiles.filter((p) => !p.group.trim())
  const [importError, setImportError] = useState('')
  const [importing, setImporting] = useState(false)
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const [portById, setPortById] = useState<Record<string, string>>({})
  const [localIp, setLocalIp] = useState('localhost')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragGroupName, setDragGroupName] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [showInstallPanel, setShowInstallPanel] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | MinecraftRunState>('all')
  const [typeFilter, setTypeFilter] = useState<'all' | MinecraftServerType>('all')
  const [sortOrder, setSortOrder] = useState<'none' | 'name-asc' | 'name-desc'>('none')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  // Only drives the Uptime tile's freshness - same reasoning as ARK's own Dashboard.tsx.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void window.api.webDashboard.getLocalIps().then((ips) => {
      if (ips[0]) setLocalIp(ips[0])
    })
  }, [])

  useEffect(() => {
    window.api.settings.get().then(setSettings)
  }, [])

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!openMenuId) return
    const close = (): void => setOpenMenuId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [openMenuId])

  // Patch-based for the same reason as ARK's own Dashboard.tsx persistSettings: this
  // component's `settings` snapshot goes stale once Dashboard/MinecraftDashboard stay mounted
  // for the whole session, so saving a full `{ ...settings, ... }` copy risks clobbering
  // settings changed elsewhere since mount. Re-fetching fresh right before the write avoids it.
  async function persistSettings(patch: Partial<AppSettings>): Promise<void> {
    const current = await window.api.settings.get()
    const next = { ...current, ...patch }
    setSettings(next)
    await window.api.settings.save(next)
  }

  // Same "explicitly-ordered names first, then any new one alphabetically" pattern as ARK's
  // own Dashboard.tsx - a brand new group just appears without needing to be added to the
  // order first. Kept in its own minecraftGroupOrder/minecraftCollapsedGroups settings
  // rather than sharing ARK's groupOrder/collapsedGroups, since a name collision between an
  // ARK group and a Minecraft group shouldn't share display order/collapse state.
  const groupNamesRaw = Array.from(new Set(visibleProfiles.filter((p) => p.group.trim()).map((p) => p.group.trim())))
  const groupOrder = settings?.minecraftGroupOrder ?? []
  const groupNames = [
    ...groupOrder.filter((name) => groupNamesRaw.includes(name)),
    ...groupNamesRaw.filter((name) => !groupOrder.includes(name)).sort((a, b) => a.localeCompare(b))
  ]
  const collapsedGroups = settings?.minecraftCollapsedGroups ?? []

  function setGroupCollapsed(name: string, collapsed: boolean): void {
    if (!settings) return
    const next = new Set(settings.minecraftCollapsedGroups)
    if (collapsed) next.add(name)
    else next.delete(name)
    void persistSettings({ minecraftCollapsedGroups: Array.from(next) })
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
    await persistSettings({ minecraftGroupOrder: reordered })
  }

  // One read of server.properties per profile, for the server-port shown on its card - not
  // wired up to live-refresh on every change, since the port practically never changes while
  // the Manager is open; re-fetched whenever the profile list itself changes (import/create/
  // delete), same "cheap, not polled" pattern as Dashboard.tsx's own installedById/
  // gameVersionById effects.
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      profiles.map(async (p) => {
        const props = await window.api.minecraft.properties.get(p.id)
        return [p.id, props['server-port'] ?? '25565'] as const
      })
    ).then((entries) => {
      if (!cancelled) setPortById(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.map((p) => p.id).join(',')])

  async function copyAddress(profileId: string, address: string): Promise<void> {
    await navigator.clipboard.writeText(address)
    setCopiedId(profileId)
    setTimeout(() => setCopiedId((prev) => (prev === profileId ? null : prev)), 1500)
  }

  async function handleImport(): Promise<void> {
    setImportError('')
    const installDir = await window.api.dialog.selectDirectory()
    if (!installDir) return

    setImporting(true)
    try {
      const detected = await window.api.minecraft.profiles.importFromInstall(installDir)
      // The import IPC handler deliberately doesn't save the detected profile itself (see
      // shared/minecraft.ts) - persisted here, right away, so it shows up on the dashboard
      // and opens straight into Settings for review, same flow as ARK's own import. Every
      // Settings tab field auto-saves on change, so a correction made there immediately
      // overwrites this best-effort guess.
      const updated = await window.api.minecraft.profiles.save(detected)
      onProfilesChange(updated)
      onOpenProfile(detected.id, 'startSettings')
    } catch (err) {
      setImportError((err as Error).message)
    } finally {
      setImporting(false)
    }
  }

  // The blank/manual path, kept available from inside the install panel below ("configure
  // manually instead") for a server whose files will be set up by hand afterward - the
  // install panel itself is now the primary "+ Add Server" entry point, fetching/building
  // the right files for the chosen type/version instead of leaving every field blank.
  async function handleCreate(): Promise<void> {
    const profile = createDefaultMinecraftProfile(`Minecraft Server ${profiles.length + 1}`)
    const updated = await window.api.minecraft.profiles.save(profile)
    setShowInstallPanel(false)
    onProfilesChange(updated)
    onOpenProfile(profile.id, 'startSettings')
  }

  async function handleInstalled(profile: MinecraftProfile): Promise<void> {
    const updated = await window.api.minecraft.profiles.save(profile)
    setShowInstallPanel(false)
    onProfilesChange(updated)
    onOpenProfile(profile.id, 'startSettings')
  }

  async function handleDelete(id: string): Promise<void> {
    if (!confirmAction('Delete this server profile? This does not delete any files on disk.')) return
    const updated = await window.api.minecraft.profiles.delete(id)
    onProfilesChange(updated)
  }

  async function handleToggleHidden(profile: MinecraftProfile): Promise<void> {
    const updated = await window.api.minecraft.profiles.save({ ...profile, hidden: !profile.hidden })
    onProfilesChange(updated)
  }

  async function runAction(profile: MinecraftProfile, action: () => Promise<unknown>): Promise<void> {
    setActionErrors((prev) => ({ ...prev, [profile.id]: '' }))
    try {
      await action()
    } catch (err) {
      setActionErrors((prev) => ({ ...prev, [profile.id]: (err as Error).message }))
    }
  }

  function stateOf(profile: MinecraftProfile): MinecraftRunState {
    return statuses[profile.id]?.state ?? 'stopped'
  }

  async function handleStart(profile: MinecraftProfile): Promise<void> {
    await runAction(profile, () => window.api.minecraft.server.start(profile.id))
  }

  async function handleStop(profile: MinecraftProfile): Promise<void> {
    await runAction(profile, () => window.api.minecraft.server.stop(profile.id))
  }

  // No single restart IPC exists for Minecraft (unlike ARK's window.api.server.restart) -
  // stop then start, same sequencing minecraftScheduledActions.ts's own
  // runMinecraftScheduledRestart already uses for a single profile.
  async function handleRestart(profile: MinecraftProfile): Promise<void> {
    await runAction(profile, async () => {
      await window.api.minecraft.server.stop(profile.id)
      await window.api.minecraft.server.start(profile.id)
    })
  }

  async function handleKill(profile: MinecraftProfile): Promise<void> {
    if (!confirmAction(`Force-kill "${profile.name}" without a graceful save? Progress since the last autosave will be lost.`)) return
    await runAction(profile, () => window.api.minecraft.server.kill(profile.id))
  }

  async function runBulk(action: () => Promise<void>): Promise<void> {
    setBulkBusy(true)
    try {
      await action()
    } finally {
      setBulkBusy(false)
    }
  }

  async function startAll(targets: MinecraftProfile[]): Promise<void> {
    const toStart = targets.filter((p) => stateOf(p) === 'stopped')
    await Promise.all(toStart.map((p) => runAction(p, () => window.api.minecraft.server.start(p.id))))
  }

  async function restartAll(targets: MinecraftProfile[]): Promise<void> {
    const toRestart = targets.filter((p) => stateOf(p) === 'running')
    await Promise.all(
      toRestart.map((p) =>
        runAction(p, async () => {
          await window.api.minecraft.server.stop(p.id)
          await window.api.minecraft.server.start(p.id)
        })
      )
    )
  }

  async function stopAll(targets: MinecraftProfile[]): Promise<void> {
    const toStop = targets.filter((p) => stateOf(p) === 'running')
    await Promise.all(toStop.map((p) => runAction(p, () => window.api.minecraft.server.stop(p.id))))
  }

  /** Compact "1h 9m" / "2d 4h" form - same as ARK's own Dashboard.tsx. */
  function formatUptimeShort(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000)
    const days = Math.floor(totalMinutes / 1440)
    const hours = Math.floor((totalMinutes % 1440) / 60)
    const minutes = totalMinutes % 60
    return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`
  }

  /** Values both renderCard and renderListRow need, computed once per profile - same reason
   *  as ARK's own Dashboard.tsx's cardData. */
  function cardData(profile: MinecraftProfile): {
    status: MinecraftServerStatus | undefined
    state: MinecraftRunState
    address: string
    playersLabel: string
    uptimeLabel: string
    cpuLabel: string
    memoryLabel: string
  } {
    const status = statuses[profile.id]
    const state: MinecraftRunState = status?.state ?? 'stopped'
    const running = state === 'running'
    return {
      status,
      state,
      address: `${localIp}:${portById[profile.id] ?? '25565'}`,
      playersLabel: running && status?.players ? `${status.players.length}${status.maxPlayers !== undefined ? ` / ${status.maxPlayers}` : ''}` : '-',
      uptimeLabel: running && status?.startedAt ? formatUptimeShort(now - status.startedAt) : '-',
      cpuLabel: running && status?.cpu !== undefined ? `${status.cpu}%` : '-',
      memoryLabel: running && status?.memoryMB !== undefined ? `${status.memoryMB} MB` : '-'
    }
  }

  function renderActionButtons(profile: MinecraftProfile, state: MinecraftRunState, compact: boolean): JSX.Element {
    return (
      <div className={compact ? 'action-row-list' : 'action-row'}>
        <button className="start" disabled={state !== 'stopped'} onClick={() => void handleStart(profile)} title="Start">
          ▶
        </button>
        <button className="stop" disabled={state !== 'running'} onClick={() => void handleStop(profile)} title="Stop">
          ■
        </button>
        <button
          className="restart"
          disabled={state !== 'running'}
          onClick={() => void handleRestart(profile)}
          title="Restart"
        >
          ↻
        </button>
        <button
          className="kill"
          disabled={state === 'stopped'}
          onClick={() => void handleKill(profile)}
          title="Kill (force, no save)"
        >
          ✕
        </button>
      </div>
    )
  }

  /** Same icon set/colors as a single card's own Start/Stop/Restart buttons, scoped to every
   *  server in this group - same reasoning as ARK's own renderGroupBulkActions, minus the
   *  Update button (no SteamCMD-equivalent for Minecraft). */
  function renderGroupBulkActions(groupProfiles: MinecraftProfile[]): JSX.Element {
    function run(action: (targets: MinecraftProfile[]) => Promise<void>): void {
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
      </div>
    )
  }

  function renderCardMenu(profile: MinecraftProfile): JSX.Element {
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
              {tabsFor(profile.serverType).map((t) => (
                <button key={t.key} onClick={() => onOpenProfile(profile.id, t.key)}>
                  <span className="card-menu-icon">{t.icon}</span>
                  {t.label}
                </button>
              ))}
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

  function renderCard(profile: MinecraftProfile): JSX.Element {
    const { state, status, address, playersLabel, uptimeLabel, cpuLabel, memoryLabel } = cardData(profile)
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
            <img src={minecraftIcon} alt="" title="Minecraft" className="server-card-game-icon" />
            <h3>{profile.name}</h3>
            <span className="server-version">{profile.minecraftVersion || '?'}</span>
          </div>
          {renderCardMenu(profile)}
        </div>
        {status?.lastError && <p className="error-message">{status.lastError}</p>}
        {actionErrors[profile.id] && <p className="error-message">{actionErrors[profile.id]}</p>}
        <div className="stat-tile-grid">
          <div className="stat-tile">
            <div className="stat-tile-label">Type</div>
            <div className="stat-tile-value server-type-value">
              {MINECRAFT_SERVER_TYPE_ICONS[profile.serverType] && (
                <img src={MINECRAFT_SERVER_TYPE_ICONS[profile.serverType]} alt="" className="server-type-icon" />
              )}
              {SERVER_TYPE_LABELS[profile.serverType]}
            </div>
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
          <div className="stat-tile">
            <div className="stat-tile-label">Address</div>
            <button type="button" className="stat-tile-value copyable-address" onClick={() => void copyAddress(profile.id, address)} title="Click to copy">
              {copiedId === profile.id ? 'Copied!' : address}
            </button>
          </div>
        </div>
        {renderActionButtons(profile, state, false)}
      </div>
    )
  }

  function renderListRow(profile: MinecraftProfile): JSX.Element {
    const { state, address, playersLabel, uptimeLabel, cpuLabel, memoryLabel } = cardData(profile)
    return (
      <tr key={profile.id}>
        <td>
          <span className={`badge badge-${state}`}>{state}</span>
        </td>
        <td>
          <strong>{profile.name}</strong>
        </td>
        <td>{SERVER_TYPE_LABELS[profile.serverType]}</td>
        <td className="mono">{profile.minecraftVersion || '?'}</td>
        <td>{playersLabel}</td>
        <td>{uptimeLabel}</td>
        <td>{cpuLabel}</td>
        <td>{memoryLabel}</td>
        <td>
          <button type="button" className="copyable-address" onClick={() => void copyAddress(profile.id, address)} title="Click to copy">
            {copiedId === profile.id ? 'Copied!' : address}
          </button>
        </td>
        <td>{renderActionButtons(profile, state, true)}</td>
      </tr>
    )
  }

  function renderProfileList(list: MinecraftProfile[]): JSX.Element {
    if (viewMode === 'list') {
      return (
        <table className="server-list-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Name</th>
              <th>Type</th>
              <th>Version</th>
              <th>Players</th>
              <th>Uptime</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>Address</th>
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
    // No reorder IPC exists for Minecraft profiles (unlike ARK's profiles.reorder) - each
    // profile is saved individually in its new relative order instead, same end result.
    for (const profile of reordered) {
      await window.api.minecraft.profiles.save(profile)
    }
  }

  // Same matches-name-or-group search, plus status/type filters, as ARK's own Dashboard.tsx.
  const isSearching = searchQuery.trim().length > 0
  const isFiltering = isSearching || statusFilter !== 'all' || typeFilter !== 'all'
  function matchesFilters(profile: MinecraftProfile): boolean {
    if (isSearching) {
      const q = searchQuery.trim().toLowerCase()
      if (!profile.name.toLowerCase().includes(q) && !profile.group.toLowerCase().includes(q)) return false
    }
    if (statusFilter !== 'all' && (statuses[profile.id]?.state ?? 'stopped') !== statusFilter) return false
    if (typeFilter !== 'all' && profile.serverType !== typeFilter) return false
    return true
  }
  function sortProfiles(list: MinecraftProfile[]): MinecraftProfile[] {
    if (sortOrder === 'none') return list
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name))
    return sortOrder === 'name-desc' ? sorted.reverse() : sorted
  }
  // Every distinct server type among this dashboard's own profiles, not every type the app
  // supports - same reasoning as ARK's own availableMaps.
  const availableTypes = Array.from(new Set(visibleProfiles.map((p) => p.serverType))).sort((a, b) =>
    SERVER_TYPE_LABELS[a].localeCompare(SERVER_TYPE_LABELS[b])
  )

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Minecraft Servers</h1>
        <div className="dashboard-header-actions">
          <button onClick={() => void handleImport()} disabled={importing}>
            {importing ? 'Scanning...' : 'Import existing server'}
          </button>
          <button className="btn-accent" onClick={() => setShowInstallPanel(true)}>
            + Add Server
          </button>
        </div>
      </header>

      {importError && <p className="error-message">{importError}</p>}

      {showInstallPanel && (
        <>
          <InstallMinecraftServerPanel
            existingNameCount={profiles.length}
            onInstalled={(profile) => void handleInstalled(profile)}
            onCancel={() => setShowInstallPanel(false)}
          />
          <p className="empty-state">
            Already have a server set up somewhere? Use &quot;Import existing server&quot; above instead, or want to
            start from a blank profile?{' '}
            <button type="button" className="link-button" onClick={() => void handleCreate()}>
              Configure manually
            </button>
            .
          </p>
        </>
      )}

      <HardwareStatsBar profiles={visibleProfiles} statuses={statuses} labelPrefix="Minecraft Servers" staticInfo={staticInfo} />

      <div className="toolbar">
        <div className="toolbar-filters">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">All Statuses</option>
            <option value="running">Running</option>
            <option value="starting">Starting</option>
            <option value="stopping">Stopping</option>
            <option value="stopped">Stopped</option>
            <option value="error">Error</option>
          </select>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}>
            <option value="all">All Types</option>
            {availableTypes.map((type) => (
              <option key={type} value={type}>
                {SERVER_TYPE_LABELS[type]}
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
            <p className="empty-state">
              No Minecraft servers yet. Click &quot;Import existing server&quot; to point at a folder that already has
              a Minecraft server set up (server.properties/eula.txt, plus a jar or launch script), or &quot;+ Add
              Server&quot; to install one.
            </p>
          )}
          {profiles.length > 0 && visibleProfiles.length === 0 && (
            <p className="empty-state">
              Every Minecraft server is hidden. Expand &quot;Hidden servers&quot; below to unhide one.
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
                <summary onDragOver={(e) => e.preventDefault()} onDrop={() => void handleGroupDrop(groupName)}>
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
