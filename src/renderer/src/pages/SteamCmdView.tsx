import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'

interface SteamCmdViewProps {
  onBack: () => void
}

export default function SteamCmdView({ onBack }: SteamCmdViewProps): JSX.Element {
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
  const [status, setStatus] = useState('')
  const [managedPath, setManagedPath] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')
  const [addingFirewallRule, setAddingFirewallRule] = useState(false)
  const [firewallStatus, setFirewallStatus] = useState('')
  const [firewallError, setFirewallError] = useState('')

  useEffect(() => {
    window.api.settings.get().then(setSettings)
    window.api.steamcmd.managedStatus().then(setManagedPath)
  }, [])

  async function browse(): Promise<void> {
    const filePath = await window.api.dialog.selectFile()
    if (filePath) setSettings((prev) => ({ ...prev, steamCmdPath: filePath }))
  }

  async function save(): Promise<void> {
    // Only steamCmdPath is actually edited on this screen, but settings.save() replaces the
    // whole stored object rather than merging it - saving the local `settings` snapshot as-is
    // (fetched once on mount, same as DataSettingsView's own fuller editor) would silently wipe
    // out every other setting changed elsewhere since this screen was opened. Re-fetching fresh
    // and merging just the one field this screen owns avoids that.
    const current = await window.api.settings.get()
    const next = { ...current, steamCmdPath: settings.steamCmdPath }
    const saved = await window.api.settings.save(next)
    setSettings(saved)
    setStatus('Saved')
    setTimeout(() => setStatus(''), 2000)
  }

  async function installManaged(): Promise<void> {
    setInstalling(true)
    setInstallError('')
    try {
      const exePath = await window.api.steamcmd.install()
      setManagedPath(exePath)
      setSettings((prev) => ({ ...prev, steamCmdPath: exePath }))
    } catch (err) {
      setInstallError((err as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  async function addFirewallRule(): Promise<void> {
    setAddingFirewallRule(true)
    setFirewallError('')
    setFirewallStatus('')
    try {
      await window.api.steamcmd.addFirewallRule(settings.steamCmdPath)
      setFirewallStatus('Firewall rule added')
      setTimeout(() => setFirewallStatus(''), 3000)
    } catch (err) {
      setFirewallError((err as Error).message)
    } finally {
      setAddingFirewallRule(false)
    }
  }

  return (
    <div className="server-detail">
      <header className="server-detail-header">
        <button onClick={onBack}>&larr; Back</button>
        <h1>SteamCMD</h1>
      </header>

      <section className="managed-steamcmd">
        <h3>Managed SteamCMD</h3>
        <p className="empty-state">
          {managedPath ? `Installed at ${managedPath}` : 'Not installed yet.'} Downloads SteamCMD directly from
          Valve into this app's own folder and points the path below at it - no manual setup needed.
        </p>
        {installError && <p className="error-message">{installError}</p>}
        <button onClick={() => void installManaged()} disabled={installing}>
          {installing ? 'Installing...' : managedPath ? 'Reinstall managed SteamCMD' : 'Install managed SteamCMD'}
        </button>
      </section>

      <form
        className="settings-tab"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label>
          SteamCMD path
          <div className="path-input-row">
            <input
              value={settings.steamCmdPath}
              onChange={(e) => setSettings({ ...settings, steamCmdPath: e.target.value })}
              placeholder="C:\SteamCMD\steamcmd.exe"
            />
            <button type="button" onClick={() => void browse()}>
              Browse...
            </button>
          </div>
        </label>
        <p className="empty-state">
          Used by each server&apos;s <strong>Update</strong> button to run steamcmd with{' '}
          <code>+force_install_dir &lt;install dir&gt; +login anonymous +app_update 2430930 validate +quit</code>.
          Works for a first install into an empty folder too.
        </p>
        <div className="form-actions">
          <button type="submit">Save</button>
          {status && <span className="status-message">{status}</span>}
        </div>
      </form>

      <section className="managed-steamcmd">
        <h3>Firewall (Windows)</h3>
        <p className="empty-state">
          Adds Windows Firewall allow rules for the SteamCMD path above (inbound + outbound). Prompts once for
          admin rights (UAC) just for this action - the app itself keeps running without elevation.
        </p>
        {firewallError && <p className="error-message">{firewallError}</p>}
        <button
          onClick={() => void addFirewallRule()}
          disabled={addingFirewallRule || !settings.steamCmdPath.trim()}
        >
          {addingFirewallRule ? 'Adding rule...' : 'Add firewall rule for SteamCMD'}
        </button>
        {firewallStatus && <span className="status-message">{firewallStatus}</span>}
      </section>
    </div>
  )
}
