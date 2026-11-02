import { ipcMain, type WebContents } from 'electron'
import { IPC, type ServerProfile } from '@shared/types'
import { getProfile } from '../store'
import { getStatus, serverEvents, getExecutablePath, buildLaunchArgs } from '../lib/serverProcess'
import { doStartServer, doStopServer, doRestartServer, doKillServer, doUpdateServer } from '../lib/serverActions'
import { isValidArkInstall } from '../lib/detect'
import { getInstalledBuildId } from '../lib/steamcmd'
import { getCachedGameVersion, getGameVersion, setCachedGameVersion } from '../lib/serverVersion'

function requireProfile(profileId: string) {
  const profile = getProfile(profileId)
  if (!profile) throw new Error(`Unknown profile: ${profileId}`)
  return profile
}

export function registerServerProcessHandlers(webContents: WebContents): void {
  serverEvents.on('status', (status) => {
    if (!webContents.isDestroyed()) webContents.send(IPC.serverStatusChanged, status)
  })

  ipcMain.handle(IPC.serverStart, (_event, profileId: string) => doStartServer(requireProfile(profileId)))

  ipcMain.handle(IPC.serverStop, async (_event, profileId: string) => doStopServer(requireProfile(profileId)))

  ipcMain.handle(IPC.serverRestart, async (_event, profileId: string) => doRestartServer(requireProfile(profileId)))

  ipcMain.handle(IPC.serverKill, (_event, profileId: string) => {
    requireProfile(profileId)
    return doKillServer(profileId)
  })

  ipcMain.handle(IPC.serverUpdate, async (_event, profileId: string) => doUpdateServer(requireProfile(profileId)))

  ipcMain.handle(IPC.serverIsInstalled, async (_event, profileId: string) => {
    const profile = requireProfile(profileId)
    return isValidArkInstall(profile.installDir, profile.game)
  })

  ipcMain.handle(IPC.serverStatus, (_event, profileId: string) => getStatus(profileId))

  ipcMain.handle(IPC.serverGetInstalledBuildId, (_event, profileId: string) => {
    const profile = requireProfile(profileId)
    return getInstalledBuildId(profile.installDir, profile.game)
  })

  ipcMain.handle(IPC.serverGetGameVersion, async (_event, profileId: string) => {
    const profile = requireProfile(profileId)
    const cached = getCachedGameVersion(profileId)
    if (cached) return cached
    // Falls back to a live read whenever nothing's cached yet, rather than trusting
    // serverVersionWatcher.ts's edge-triggered state-tracking to have already caught it -
    // that only refreshes on a state *transition*, so a version that only appears in the log
    // well after the 'running' transition already fired (or a transition it missed for any
    // reason) would otherwise never get picked up until the next start/stop cycle. Every
    // caller of this already polls on an interval (Dashboard, Analytics tab), so this just
    // makes that polling actually productive instead of forever returning the same null.
    const version = await getGameVersion(profile.installDir)
    if (version) setCachedGameVersion(profileId, version)
    return version
  })

  ipcMain.handle(IPC.serverPreviewLaunchCommand, (_event, profile: ServerProfile) => ({
    executable: getExecutablePath(profile),
    args: buildLaunchArgs(profile)
  }))
}
