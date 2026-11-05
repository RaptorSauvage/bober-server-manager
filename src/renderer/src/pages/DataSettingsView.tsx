import { useEffect, useState } from 'react'
import type { AppSettings, AppUpdateStatus } from '@shared/types'
import { listGameDefinitions } from '@shared/games'
import AccessTokensSection from './AccessTokensSection'
import ApiKeysSection from './ApiKeysSection'
import WatchedPlayersSection from './WatchedPlayersSection'
import { GAME_ICONS } from '../lib/gameIcons'
import { confirmAction } from '../lib/confirmAction'

interface DataSettingsViewProps {
  onBack: () => void
}

type SettingsTabKey = 'general' | 'webDashboard' | 'accessTokens' | 'discordBot' | 'updates'

interface SettingsTabMeta {
  key: SettingsTabKey
  label: string
  icon: string
  description: string
  group: 'Application' | 'Integrations'
}

const SETTINGS_TABS: SettingsTabMeta[] = [
  {
    key: 'general',
    label: 'Application',
    icon: '⚙️',
    description: 'Data storage, cluster backups, startup behavior, and multi-game support.',
    group: 'Application'
  },
  {
    key: 'webDashboard',
    label: 'Web Dashboard',
    icon: '🌐',
    description: 'A browser-accessible live console and RCON for your servers.',
    group: 'Integrations'
  },
  {
    key: 'accessTokens',
    label: 'Access Tokens',
    icon: '🔑',
    description: 'Access tokens for the web dashboard, and API keys for other integrations.',
    group: 'Integrations'
  },
  {
    key: 'discordBot',
    label: 'Discord Bot',
    icon: '💬',
    description: 'Status embeds, slash commands, and mod-update notifications in Discord.',
    group: 'Integrations'
  },
  {
    key: 'updates',
    label: 'Updates',
    icon: '⬆️',
    description: 'Check for and install Manager updates.',
    group: 'Integrations'
  }
]

const SETTINGS_TAB_GROUPS: SettingsTabMeta['group'][] = ['Application', 'Integrations']

function describeAppUpdateStatus(appUpdateStatus: AppUpdateStatus, appVersion: string): string {
  switch (appUpdateStatus.state) {
    case 'checking':
      return 'Checking for updates...'
    case 'available':
      return `Update ${appUpdateStatus.version} found - starting download...`
    case 'downloading':
      return `Downloading update ${appUpdateStatus.version ?? ''}... ${appUpdateStatus.percent ?? 0}%`
    case 'downloaded':
      return `Update ${appUpdateStatus.version} downloaded - save any unsaved changes, then click Restart & install.`
    case 'not-available':
      return `You're on the latest version (${appVersion}).`
    case 'error':
      return appUpdateStatus.error ?? 'Update check failed.'
    default:
      return ''
  }
}

export default function DataSettingsView({ onBack }: DataSettingsViewProps): JSX.Element {
  const [tab, setTab] = useState<SettingsTabKey>('general')
  const [settings, setSettings] = useState<AppSettings>({
    steamCmdPath: '',
    dataDir: '',
    webDashboardEnabled: false,
    webDashboardPort: 8090,
    webDashboardHost: '127.0.0.1',
    webDashboardDisabledLabels: [],
    launchOnStartup: false,
    closeToTrayEnabled: false,
    webDashboardAuthEnabled: false,
    serverAutoStartStaggerSeconds: 10,
    iniLockEnabled: true,
    statsHistoryMaxSizeMB: 1024,
    statsHistoryMaxAgeHours: 24,
    showServerConsoleWindow: true,
    groupOrder: [],
    registeredGroups: [],
    collapsedGroups: [],
    minecraftGroupOrder: [],
    minecraftCollapsedGroups: [],
    curseforgeApiKey: '',
    discordBotEnabled: false,
    discordBotToken: '',
    discordBotDevGuildId: '',
    discordBotStatusChannelId: '',
    discordBotRefreshSeconds: 60,
    discordBotStatusEmbedTitle: '🦖 Statut ARK: Survival Ascended',
    discordBotStatusEmbedDescription: '',
    discordBotStatusEmbedColor: '9B59B6',
    discordBotArkCheckEnabled: true,
    discordBotMcStatusChannelId: '',
    discordBotMcRefreshSeconds: 60,
    discordBotMcStatusEmbedTitle: '⛏️ Statut Minecraft',
    discordBotMcStatusEmbedDescription: '',
    discordBotMcStatusEmbedColor: '9B59B6',
    discordBotMcCheckEnabled: true,
    discordBotDisplayEnabled: true,
    discordBotPresenceEnabled: true,
    discordBotChatBridgeEnabled: true,
    discordBotMaintenanceWhitelistIds: [],
    discordBotManagerWhitelistIds: [],
    discordBotCurseforgeModuleEnabled: true,
    discordBotCurseforgeDefaultModIds: [],
    discordBotCurseforgeCheckIntervalMinutes: 10,
    discordBotPlayerAlertEnabled: false,
    discordBotPlayerAlertChannelId: '',
    playerActivityTrackingEnabled: false,
    discordBotApiKeyId: ''
  })
  const [defaultDataDir, setDefaultDataDir] = useState('')
  const [status, setStatus] = useState('')
  const [webDashboardStatus, setWebDashboardStatus] = useState<{
    running: boolean
    error: string | null
    host: string | null
  }>({ running: false, error: null, host: null })
  const [localIps, setLocalIps] = useState<string[]>([])
  const [appVersion, setAppVersion] = useState('')
  const [appUpdateStatus, setAppUpdateStatus] = useState<AppUpdateStatus>({ state: 'idle' })
  const [discordBotStatus, setDiscordBotStatus] = useState<{ running: boolean; error: string | null }>({
    running: false,
    error: null
  })
  const [discordBotWhitelistInput, setDiscordBotWhitelistInput] = useState('')
  const [discordBotManagerWhitelistInput, setDiscordBotManagerWhitelistInput] = useState('')
  const [discordBotModIdsInput, setDiscordBotModIdsInput] = useState('')
  const [includeSettingsOnImport, setIncludeSettingsOnImport] = useState(false)
  const [clusterBackupBusy, setClusterBackupBusy] = useState(false)
  const [clusterBackupStatus, setClusterBackupStatus] = useState('')
  const [clusterBackupError, setClusterBackupError] = useState('')

  useEffect(() => {
    window.api.settings.get().then((s) => {
      setSettings(s)
      setDiscordBotWhitelistInput(s.discordBotMaintenanceWhitelistIds.join(', '))
      setDiscordBotManagerWhitelistInput(s.discordBotManagerWhitelistIds.join(', '))
      setDiscordBotModIdsInput(s.discordBotCurseforgeDefaultModIds.join(', '))
    })
    window.api.dataDir.getDefault().then(setDefaultDataDir)
    window.api.webDashboard.getStatus().then(setWebDashboardStatus)
    window.api.webDashboard.getLocalIps().then(setLocalIps)
    window.api.appUpdate.getVersion().then(setAppVersion)
    window.api.appUpdate.getStatus().then(setAppUpdateStatus)
    window.api.discordBot.status().then(setDiscordBotStatus)
    return window.api.appUpdate.onStatusChanged(setAppUpdateStatus)
  }, [])

  function parseIdList(value: string): string[] {
    return value
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  }

  const appUpdateBusy = appUpdateStatus.state === 'checking' || appUpdateStatus.state === 'available' || appUpdateStatus.state === 'downloading'

  async function browse(): Promise<void> {
    const dir = await window.api.dialog.selectDirectory()
    if (dir) setSettings((prev) => ({ ...prev, dataDir: dir }))
  }

  async function save(): Promise<void> {
    // Re-fetches rather than spreading this screen's own `settings` state as the base: this is
    // the comprehensive settings editor, so it's right for its own in-progress edits to win on
    // every field it renders, but `settings` was fetched once on open and settings.save()
    // replaces the whole stored object rather than merging it - if another window (or the web
    // dashboard's own HTTP routes) saved something in the meantime, spreading a since-stale
    // `settings` as the base would silently wipe that out. Spreading the fresh fetch first,
    // then this screen's own state on top, keeps this screen authoritative for what it edits
    // without clobbering changes made elsewhere to fields it doesn't.
    const current = await window.api.settings.get()
    const toSave: AppSettings = {
      ...current,
      ...settings,
      discordBotMaintenanceWhitelistIds: parseIdList(discordBotWhitelistInput),
      discordBotManagerWhitelistIds: parseIdList(discordBotManagerWhitelistInput),
      discordBotCurseforgeDefaultModIds: parseIdList(discordBotModIdsInput)
    }
    const saved = await window.api.settings.save(toSave)
    setSettings(saved)
    setStatus('Saved')
    setTimeout(() => setStatus(''), 2000)
    setWebDashboardStatus(await window.api.webDashboard.getStatus())
    setDiscordBotStatus(await window.api.discordBot.status())
  }

  async function exportClusterBackup(): Promise<void> {
    setClusterBackupError('')
    setClusterBackupStatus('')
    const filePath = await window.api.dialog.saveClusterBundleFile()
    if (!filePath) return
    setClusterBackupBusy(true)
    try {
      await window.api.cluster.export(filePath)
      setClusterBackupStatus('Backup exported.')
      setTimeout(() => setClusterBackupStatus(''), 3000)
    } catch (err) {
      setClusterBackupError((err as Error).message)
    } finally {
      setClusterBackupBusy(false)
    }
  }

  async function importClusterBackup(): Promise<void> {
    setClusterBackupError('')
    setClusterBackupStatus('')
    const filePath = await window.api.dialog.selectClusterBundleFile()
    if (!filePath) return
    const warning = includeSettingsOnImport
      ? 'Import this cluster backup? Every ARK/Minecraft profile in it will be added as new profiles, and your current Settings will be replaced with the ones from the backup.'
      : 'Import this cluster backup? Every ARK/Minecraft profile in it will be added as new profiles (Settings are left untouched).'
    if (!confirmAction(warning)) return
    setClusterBackupBusy(true)
    try {
      const result = await window.api.cluster.import(filePath, { includeSettings: includeSettingsOnImport })
      if (result.settingsReplaced) setSettings(result.settings)
      setClusterBackupStatus(
        `Imported ${result.addedProfileCount} ARK and ${result.addedMinecraftProfileCount} Minecraft profile(s)` +
          (result.settingsReplaced ? ', Settings replaced.' : '.')
      )
    } catch (err) {
      setClusterBackupError((err as Error).message)
    } finally {
      setClusterBackupBusy(false)
    }
  }

  const isLan = settings.webDashboardHost.trim() !== '' && settings.webDashboardHost.trim() !== '127.0.0.1'
  const activeTabMeta = SETTINGS_TABS.find((t) => t.key === tab) ?? SETTINGS_TABS[0]

  return (
    <div className="server-detail settings-view">
      <header className="server-detail-header">
        <button onClick={onBack}>&larr; Back</button>
        <h1>Settings</h1>
      </header>

      <div className="settings-shell">
        <nav className="settings-nav">
          {SETTINGS_TAB_GROUPS.map((group) => (
            <div className="settings-nav-group" key={group}>
              <div className="settings-nav-group-label">{group.toUpperCase()}</div>
              {SETTINGS_TABS.filter((t) => t.group === group).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={tab === t.key ? 'active' : ''}
                  onClick={() => setTab(t.key)}
                >
                  <span className="settings-nav-icon">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="settings-content">
          <div className="settings-content-header">
            <h2>
              <span className="settings-nav-icon">{activeTabMeta.icon}</span>
              {activeTabMeta.label}
            </h2>
            <p>{activeTabMeta.description}</p>
          </div>
          <div className="app-settings-view">
        {(tab === 'general' || tab === 'webDashboard' || tab === 'discordBot') && (
          <form
            className="app-settings-form"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            {tab === 'general' && (
              <>
                <section className="cluster-section">
                  <h3>Data &amp; Storage</h3>
                  <label>
                    Data files location
                    <div className="path-input-row">
                      <input
                        value={settings.dataDir}
                        onChange={(e) => setSettings({ ...settings, dataDir: e.target.value })}
                        placeholder={defaultDataDir}
                      />
                      <button type="button" onClick={() => void browse()}>
                        Browse...
                      </button>
                    </div>
                  </label>
                  <p className="empty-state">
                    Where <code>maps.json</code>, <code>customMaps.json</code>, and other config live - blank uses{' '}
                    {defaultDataDir || 'Documents/ARK Server Manager'}.
                  </p>
                  <div className="settings-grid">
                    <label>
                      Stats history size limit (MB)
                      <input
                        type="number"
                        min={1}
                        value={settings.statsHistoryMaxSizeMB}
                        onChange={(e) => setSettings({ ...settings, statsHistoryMaxSizeMB: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      Stats history retention (hours)
                      <input
                        type="number"
                        min={0}
                        value={settings.statsHistoryMaxAgeHours}
                        onChange={(e) => setSettings({ ...settings, statsHistoryMaxAgeHours: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <p className="empty-state">
                    Combined cap on every server&apos;s CPU/RAM/player history (Analytics tab) - oldest samples
                    trimmed first once either limit is hit. Retention defaults to 24h, keeping a long-running
                    Manager from re-parsing an ever-growing file every time a stats chart is open. Set retention to
                    0 to keep history bounded by size alone, however long that ends up spanning.
                  </p>
                  <label>
                    Server profiles
                    <div className="path-input-row">
                      <button type="button" onClick={() => void window.api.system.openProfilesFolder()}>
                        Open profiles folder
                      </button>
                    </div>
                  </label>
                  <p className="empty-state">Opens this app&apos;s own data folder (profiles, settings, config.json).</p>
                </section>

                <section className="cluster-section">
                  <h3>Cluster Backup</h3>
                  <p className="empty-state">
                    Exports every ARK and Minecraft profile, plus these Settings, into a single JSON file - for
                    migrating to another machine or just keeping a snapshot. Only the Manager&apos;s own
                    configuration is included, not the actual server files themselves (install directories still
                    point at wherever they lived when exported).
                  </p>
                  <div className="form-actions">
                    <button type="button" onClick={() => void exportClusterBackup()} disabled={clusterBackupBusy}>
                      Export cluster backup
                    </button>
                    <button type="button" onClick={() => void importClusterBackup()} disabled={clusterBackupBusy}>
                      Import cluster backup
                    </button>
                  </div>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={includeSettingsOnImport}
                      onChange={(e) => setIncludeSettingsOnImport(e.target.checked)}
                    />
                    Also replace my current Settings with the ones from the backup
                  </label>
                  <p className="empty-state">
                    Imported profiles are always added as new profiles (never overwrite an existing one, renamed on
                    a name collision) - safe to import more than once. Settings are left untouched unless the box
                    above is checked, since replacing them overwrites things like your Discord bot token and web
                    dashboard ports.
                  </p>
                  {clusterBackupStatus && <p className="status-message">{clusterBackupStatus}</p>}
                  {clusterBackupError && <p className="error-message">{clusterBackupError}</p>}
                </section>

                <section className="cluster-section">
                  <h3>Startup &amp; Safety</h3>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.launchOnStartup}
                      onChange={(e) => setSettings({ ...settings, launchOnStartup: e.target.checked })}
                    />
                    Start Manager when you log into Windows
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.closeToTrayEnabled}
                      onChange={(e) => setSettings({ ...settings, closeToTrayEnabled: e.target.checked })}
                    />
                    Keep running in the background when the window is closed
                  </label>
                  <p className="empty-state">
                    With this on, closing the window hides it to a system tray icon instead of quitting - every
                    managed server, the web dashboard, and the Discord bot all keep running. Click the tray icon to
                    reopen the window, or use its right-click menu&apos;s <strong>Quit</strong> to actually exit the
                    app.
                  </p>
                  <label>
                    Minimum delay between servers starting (seconds)
                    <input
                      type="number"
                      min={0}
                      value={settings.serverAutoStartStaggerSeconds}
                      onChange={(e) => setSettings({ ...settings, serverAutoStartStaggerSeconds: Number(e.target.value) })}
                    />
                  </label>
                  <p className="empty-state">
                    Applies to every ARK server start, not just &quot;Start this server when the Manager starts&quot;
                    (Server Management tab) - manual Start/Restart, the Dashboard&apos;s bulk Start All/Restart All,
                    a scheduled restart, or an auto-restart all wait their turn too if another server started less
                    than this long ago. Several ARK servers loading their map at the exact same time can starve
                    each other out badly enough that some never finish starting at all - this keeps that from
                    happening without you needing to space out your own clicks.
                  </p>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.iniLockEnabled}
                      onChange={(e) => setSettings({ ...settings, iniLockEnabled: e.target.checked })}
                    />
                    Lock config files while a server is running
                  </label>
                  <p className="empty-state">
                    Makes <code>GameUserSettings.ini</code>/<code>Game.ini</code> read-only while that server runs,
                    as a guard against editing it by accident.
                  </p>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.showServerConsoleWindow}
                      onChange={(e) => setSettings({ ...settings, showServerConsoleWindow: e.target.checked })}
                    />
                    Show the server&apos;s own console/debug window
                  </label>
                  <p className="empty-state">
                    Both games open their own small-font console window (Windows only) the moment a server starts -
                    there&apos;s no launch flag to resize or suppress it. Unchecking this hides that window
                    entirely; the server itself is unaffected, and its own log file keeps updating either way.
                    Takes effect on the next start.
                  </p>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.playerActivityTrackingEnabled}
                      onChange={(e) => setSettings({ ...settings, playerActivityTrackingEnabled: e.target.checked })}
                    />
                    Track player activity/playtime (ARK)
                  </label>
                  <p className="empty-state">
                    Tracks how long each player's been connected, merged across every ARK server - see the
                    &quot;Player Activity&quot; button on the Dashboard. Takes effect immediately on already-running
                    servers, no restart needed.
                  </p>
                </section>

                <section className="cluster-section">
                  <h3>Games</h3>
                  <div className="games-list">
                    {listGameDefinitions().map((game) => (
                      <div className="games-list-item" key={game.id}>
                        <img src={GAME_ICONS[game.iconFileName]} alt="" className="games-list-icon" />
                        <span>{game.displayName}</span>
                        <span className={game.status === 'available' ? 'status-ok' : 'muted'}>
                          {game.status === 'available' ? 'Available' : 'Coming soon'}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="empty-state">Multi-game support is in progress.</p>
                </section>

                <section className="cluster-section">
                  <h3>Integrations</h3>
                  <label>
                    CurseForge API key
                    <input
                      type="password"
                      value={settings.curseforgeApiKey}
                      onChange={(e) => setSettings({ ...settings, curseforgeApiKey: e.target.value })}
                      placeholder="Paste your CurseForge API key here"
                    />
                  </label>
                  <p className="empty-state">
                    Lets the Minecraft Mods tab also search/install from CurseForge, alongside Modrinth (which needs
                    no key at all). Get a free one at{' '}
                    <strong>console.curseforge.com</strong> - sign in with a CurseForge/Overwolf account, open{' '}
                    <strong>API Keys</strong> in the left sidebar, click <strong>Generate new API key</strong>, give
                    it any name, and agree to the non-commercial terms. The key shown there is what goes here. Leave
                    empty to skip CurseForge entirely - Modrinth search still works either way.
                  </p>
                </section>
              </>
            )}

            {tab === 'webDashboard' && (
              <section className="cluster-section">
                <h3>Web Dashboard</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={settings.webDashboardEnabled}
                    onChange={(e) => setSettings({ ...settings, webDashboardEnabled: e.target.checked })}
                  />
                  Enable web dashboard
                </label>
                <p className="empty-state">
                  A browser-accessible page (live console + RCON, one server at a time) - same content as the
                  desktop console, reachable from any device with a web browser.
                </p>
                <div className="settings-grid">
                  <label>
                    Host
                    <input
                      value={settings.webDashboardHost}
                      onChange={(e) => setSettings({ ...settings, webDashboardHost: e.target.value })}
                      placeholder="127.0.0.1"
                      disabled={!settings.webDashboardEnabled}
                    />
                  </label>
                  <label>
                    Port
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={settings.webDashboardPort}
                      onChange={(e) => setSettings({ ...settings, webDashboardPort: Number(e.target.value) })}
                      disabled={!settings.webDashboardEnabled}
                    />
                  </label>
                </div>
                <p className="empty-state">
                  <code>127.0.0.1</code> (default) keeps it reachable from this machine only; <code>0.0.0.0</code> or
                  a specific local IP also allows other devices on your network.
                  {localIps.length > 0 && (
                    <>
                      {' '}
                      This machine&apos;s local IP{localIps.length > 1 ? 's' : ''}:{' '}
                      {localIps.map((ip, i) => (
                        <span key={ip}>
                          <code>{ip}</code>
                          {i < localIps.length - 1 ? ', ' : ''}
                        </span>
                      ))}
                      .
                    </>
                  )}
                </p>
                {isLan && !settings.webDashboardAuthEnabled && (
                  <p className="error-message">
                    Host is set to {settings.webDashboardHost} - reachable from your network with no access token
                    required.
                  </p>
                )}
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={settings.webDashboardAuthEnabled}
                    onChange={(e) => setSettings({ ...settings, webDashboardAuthEnabled: e.target.checked })}
                    disabled={!settings.webDashboardEnabled}
                  />
                  Require access token (HTTPS)
                </label>
                <p className="empty-state">
                  Switches to <code>https://</code> (self-signed - browsers will warn once) and requires pasting an
                  access token (Access Tokens tab) into every browser that opens the dashboard. Needed before
                  exposing this outside your LAN.
                </p>
                {settings.webDashboardEnabled && (
                  <p className={webDashboardStatus.error ? 'error-message' : 'empty-state'}>
                    {webDashboardStatus.error
                      ? `Failed to start: ${webDashboardStatus.error}`
                      : webDashboardStatus.running
                        ? `Running at ${settings.webDashboardAuthEnabled ? 'https' : 'http'}://${webDashboardStatus.host}:${settings.webDashboardPort}`
                        : 'Not running yet - save to start it.'}
                  </p>
                )}
              </section>
            )}

            {tab === 'discordBot' && (
              <>
                <section className="cluster-section">
                  <h3>Discord Bot</h3>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.discordBotEnabled}
                      onChange={(e) => setSettings({ ...settings, discordBotEnabled: e.target.checked })}
                    />
                    Enable the Discord bot integration
                  </label>
                  <p className="empty-state">
                    Runs the bot (status embeds, /start /stop /restart /update, RCON commands, scheduled DinoWipe,
                    CurseForge mod-update notifications) as its own process, supervised by the Manager - it talks to
                    this same Manager purely over the Web Dashboard API below, so <strong>enable the web dashboard
                    first</strong>. A crash in the bot never affects server management, and vice versa.
                  </p>
                  {!settings.webDashboardEnabled && settings.discordBotEnabled && (
                    <p className="error-message">
                      The web dashboard is disabled - the bot has nothing to talk to. Enable it in the Web Dashboard
                      tab.
                    </p>
                  )}
                  <label>
                    Bot token
                    <input
                      type="password"
                      value={settings.discordBotToken}
                      onChange={(e) => setSettings({ ...settings, discordBotToken: e.target.value })}
                      placeholder="Discord Developer Portal > your app > Bot > Reset Token"
                      disabled={!settings.discordBotEnabled}
                    />
                  </label>
                  <label>
                    Dev guild id (optional)
                    <input
                      value={settings.discordBotDevGuildId}
                      onChange={(e) => setSettings({ ...settings, discordBotDevGuildId: e.target.value })}
                      placeholder="Syncs slash commands instantly to this one Discord server while testing"
                      disabled={!settings.discordBotEnabled}
                    />
                  </label>
                  {settings.discordBotEnabled && (
                    <p className={discordBotStatus.error ? 'error-message' : 'empty-state'}>
                      {discordBotStatus.error
                        ? `Bot error: ${discordBotStatus.error}`
                        : discordBotStatus.running
                          ? 'Bot process running.'
                          : 'Not running yet - save to start it.'}{' '}
                      <button
                        type="button"
                        onClick={() => void window.api.discordBot.restart().then(setDiscordBotStatus)}
                      >
                        Restart bot
                      </button>{' '}
                      {discordBotStatus.running && (
                        <button
                          type="button"
                          onClick={() => void window.api.discordBot.stop().then(setDiscordBotStatus)}
                        >
                          Stop bot
                        </button>
                      )}
                    </p>
                  )}
                  {!settings.discordBotEnabled && discordBotStatus.running && (
                    <p className="empty-state">
                      Bot process still running from before this checkbox was turned off - save to actually stop it,
                      or stop it right away:{' '}
                      <button
                        type="button"
                        onClick={() => void window.api.discordBot.stop().then(setDiscordBotStatus)}
                      >
                        Stop bot
                      </button>
                    </p>
                  )}
                </section>

                <section className="cluster-section">
                  <h3>Display</h3>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.discordBotDisplayEnabled}
                      onChange={(e) => setSettings({ ...settings, discordBotDisplayEnabled: e.target.checked })}
                      disabled={!settings.discordBotEnabled}
                    />
                    Show the bot on Discord
                  </label>
                  <p className="empty-state">
                    Master switch over everything the bot actually shows - the status embeds below, its own Discord
                    presence, and the chat/events relay. Turn this off to silence all of it at once (e.g. while
                    testing, or if a channel is getting too noisy) without losing any of the settings below - slash
                    commands, CurseForge update checks, and player-join alerts keep working regardless.
                  </p>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.discordBotPresenceEnabled}
                      onChange={(e) => setSettings({ ...settings, discordBotPresenceEnabled: e.target.checked })}
                      disabled={!settings.discordBotEnabled || !settings.discordBotDisplayEnabled}
                    />
                    Show bot presence (&quot;Surveille N survivants&quot;, maintenance status, ...)
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.discordBotChatBridgeEnabled}
                      onChange={(e) => setSettings({ ...settings, discordBotChatBridgeEnabled: e.target.checked })}
                      disabled={!settings.discordBotEnabled || !settings.discordBotDisplayEnabled}
                    />
                    Enable chat/events relay
                  </label>
                  <p className="empty-state">
                    Each server&apos;s own chat/events channel ids (Server Settings &gt; Discord) still need to be set
                    separately - this is just a single override to pause the whole relay at once without clearing
                    every server&apos;s own configuration.
                  </p>
                </section>

                <section className="cluster-section">
                  <h3>ARK cluster status</h3>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.discordBotArkCheckEnabled}
                      onChange={(e) => setSettings({ ...settings, discordBotArkCheckEnabled: e.target.checked })}
                      disabled={!settings.discordBotEnabled || !settings.discordBotDisplayEnabled}
                    />
                    Enable ARK status (/status, /statusserveur)
                  </label>
                  <div className="settings-grid">
                    <label>
                      Status channel id
                      <input
                        value={settings.discordBotStatusChannelId}
                        onChange={(e) => setSettings({ ...settings, discordBotStatusChannelId: e.target.value })}
                        placeholder="Discord channel id (optional)"
                        disabled={!settings.discordBotEnabled}
                      />
                    </label>
                    <label>
                      Refresh interval (seconds)
                      <input
                        type="number"
                        min={10}
                        value={settings.discordBotRefreshSeconds}
                        onChange={(e) => setSettings({ ...settings, discordBotRefreshSeconds: Number(e.target.value) })}
                        disabled={!settings.discordBotEnabled}
                      />
                    </label>
                  </div>
                  <p className="empty-state">
                    Leave the channel id empty to skip the auto-refreshed embed - <code>/status</code> and{' '}
                    <code>/statusserveur</code> still work on demand either way.
                  </p>
                  <label>
                    Embed title
                    <input
                      value={settings.discordBotStatusEmbedTitle}
                      onChange={(e) => setSettings({ ...settings, discordBotStatusEmbedTitle: e.target.value })}
                      disabled={!settings.discordBotEnabled}
                    />
                  </label>
                  <label>
                    Embed description (optional, supports Discord markdown)
                    <input
                      value={settings.discordBotStatusEmbedDescription}
                      onChange={(e) => setSettings({ ...settings, discordBotStatusEmbedDescription: e.target.value })}
                      disabled={!settings.discordBotEnabled}
                    />
                  </label>
                  <label>
                    Embed color (hex)
                    <input
                      value={settings.discordBotStatusEmbedColor}
                      onChange={(e) => setSettings({ ...settings, discordBotStatusEmbedColor: e.target.value })}
                      placeholder="9B59B6"
                      disabled={!settings.discordBotEnabled}
                    />
                  </label>
                </section>

                <section className="cluster-section">
                  <h3>Minecraft cluster status</h3>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.discordBotMcCheckEnabled}
                      onChange={(e) => setSettings({ ...settings, discordBotMcCheckEnabled: e.target.checked })}
                      disabled={!settings.discordBotEnabled || !settings.discordBotDisplayEnabled}
                    />
                    Enable Minecraft status (/statusmc)
                  </label>
                  <div className="settings-grid">
                    <label>
                      Status channel id
                      <input
                        value={settings.discordBotMcStatusChannelId}
                        onChange={(e) => setSettings({ ...settings, discordBotMcStatusChannelId: e.target.value })}
                        placeholder="Discord channel id (optional, different from the ARK one)"
                        disabled={!settings.discordBotEnabled}
                      />
                    </label>
                    <label>
                      Refresh interval (seconds)
                      <input
                        type="number"
                        min={10}
                        value={settings.discordBotMcRefreshSeconds}
                        onChange={(e) => setSettings({ ...settings, discordBotMcRefreshSeconds: Number(e.target.value) })}
                        disabled={!settings.discordBotEnabled}
                      />
                    </label>
                  </div>
                  <label>
                    Embed title
                    <input
                      value={settings.discordBotMcStatusEmbedTitle}
                      onChange={(e) => setSettings({ ...settings, discordBotMcStatusEmbedTitle: e.target.value })}
                      disabled={!settings.discordBotEnabled}
                    />
                  </label>
                  <label>
                    Embed description (optional)
                    <input
                      value={settings.discordBotMcStatusEmbedDescription}
                      onChange={(e) => setSettings({ ...settings, discordBotMcStatusEmbedDescription: e.target.value })}
                      disabled={!settings.discordBotEnabled}
                    />
                  </label>
                  <label>
                    Embed color (hex)
                    <input
                      value={settings.discordBotMcStatusEmbedColor}
                      onChange={(e) => setSettings({ ...settings, discordBotMcStatusEmbedColor: e.target.value })}
                      placeholder="9B59B6"
                      disabled={!settings.discordBotEnabled}
                    />
                  </label>
                </section>

                <section className="cluster-section">
                  <h3>Access control</h3>
                  <label>
                    Admin whitelist (Discord user ids, comma-separated)
                    <input
                      value={discordBotWhitelistInput}
                      onChange={(e) => setDiscordBotWhitelistInput(e.target.value)}
                      placeholder="123456789012345678, 987654321098765432"
                      disabled={!settings.discordBotEnabled}
                    />
                  </label>
                  <p className="empty-state">
                    Required for /maintenance, /maintenancemc, /botmaintenance, /check, /schedule, /dinowipe,
                    /saveworld, /adminchat, /adminchatall, /rcon, /rconall, /setchannel, /addmod, /removemod - empty
                    means nobody can use them.
                  </p>
                  <label>
                    Manager whitelist (Discord user ids, comma-separated)
                    <input
                      value={discordBotManagerWhitelistInput}
                      onChange={(e) => setDiscordBotManagerWhitelistInput(e.target.value)}
                      placeholder="123456789012345678"
                      disabled={!settings.discordBotEnabled}
                    />
                  </label>
                  <p className="empty-state">
                    Separate, smaller list for /start /stop /restart /update /updaterestart only - anyone already in
                    the admin whitelist above has access automatically.
                  </p>
                </section>

                <section className="cluster-section">
                  <h3>CurseForge mod-update notifications</h3>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.discordBotCurseforgeModuleEnabled}
                      onChange={(e) => setSettings({ ...settings, discordBotCurseforgeModuleEnabled: e.target.checked })}
                      disabled={!settings.discordBotEnabled}
                    />
                    Enable (/setchannel, /addmod, /removemod, /listmods, /testmod)
                  </label>
                  <p className="empty-state">
                    Reuses the CurseForge API key from the General tab - no separate key needed here. Leave that key
                    empty to keep this module off.
                  </p>
                  <label>
                    Default mod ids (comma-separated, optional)
                    <input
                      value={discordBotModIdsInput}
                      onChange={(e) => setDiscordBotModIdsInput(e.target.value)}
                      placeholder="12345, 67890"
                      disabled={!settings.discordBotEnabled}
                    />
                  </label>
                  <label>
                    Check interval (minutes)
                    <input
                      type="number"
                      min={1}
                      value={settings.discordBotCurseforgeCheckIntervalMinutes}
                      onChange={(e) =>
                        setSettings({ ...settings, discordBotCurseforgeCheckIntervalMinutes: Number(e.target.value) })
                      }
                      disabled={!settings.discordBotEnabled}
                    />
                  </label>
                </section>

                <section className="cluster-section">
                  <h3>Player join alert (ARK only)</h3>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.discordBotPlayerAlertEnabled}
                      onChange={(e) => setSettings({ ...settings, discordBotPlayerAlertEnabled: e.target.checked })}
                      disabled={!settings.discordBotEnabled}
                    />
                    Enable - post to the channel below whenever a watched player joins any ARK server
                  </label>
                  <label>
                    Channel id
                    <input
                      value={settings.discordBotPlayerAlertChannelId}
                      onChange={(e) => setSettings({ ...settings, discordBotPlayerAlertChannelId: e.target.value })}
                      placeholder="123456789012345678"
                      disabled={!settings.discordBotEnabled || !settings.discordBotPlayerAlertEnabled}
                    />
                  </label>
                </section>
              </>
            )}

            <div className="form-actions">
              <button type="submit">Save</button>
              {status && <span className="status-message">{status}</span>}
            </div>
          </form>
        )}

        {tab === 'discordBot' && <WatchedPlayersSection />}

        {tab === 'accessTokens' && (
          <>
            <AccessTokensSection />
            <ApiKeysSection />
          </>
        )}

        {tab === 'updates' && (
          <section className="managed-steamcmd">
            <h3>Manager updates</h3>
            <p className="empty-state">
              Current version: <code>{appVersion || '...'}</code>. Checks GitHub for a newer release and downloads
              it - installing (below) restarts the Manager, as a separate step so it never happens automatically.
            </p>
            {appUpdateStatus.state !== 'idle' && (
              <p className={appUpdateStatus.state === 'error' ? 'error-message' : 'empty-state'}>
                {describeAppUpdateStatus(appUpdateStatus, appVersion)}
              </p>
            )}
            <button onClick={() => void window.api.appUpdate.check()} disabled={appUpdateBusy}>
              {appUpdateBusy ? 'Working...' : 'Check for updates'}
            </button>
            {appUpdateStatus.state === 'downloaded' && (
              <button onClick={() => void window.api.appUpdate.install()}>Restart &amp; install now</button>
            )}
          </section>
        )}
          </div>
        </div>
      </div>
    </div>
  )
}
