import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ipcMain, type WebContents } from 'electron'
import { IPC, type ServerProfile } from '@shared/types'
import { listProfiles, saveProfile, deleteProfile, setProfileOrder, profileEvents } from '../store'
import { applyBackupSchedule, clearBackupSchedule } from '../lib/schedule'
import {
  applyScheduledRestart,
  applyScheduledDinoWipe,
  applyScheduledRconCommands,
  applyScheduledMaintenance,
  clearScheduledRestart,
  clearScheduledDinoWipe,
  clearScheduledRconCommands,
  clearScheduledMaintenance
} from '../lib/scheduledActions'
import { detectGameFromInstall, detectProfileFields, uniqueProfileName } from '../lib/detect'
import { serializeProfile, parseImportedProfile } from '../lib/profileExport'
import { syncPlayerBackupWatch } from '../lib/playerBackupWatch'
import { syncDiscordChatBridgeWatch } from '../lib/discordChatBridgeWatch'
import { copyProfile, moveProfile } from '../lib/profileCopyMove'
import { copyProfileConfigFiles } from '../lib/profileConfigCopy'

function requireProfile(profileId: string): ServerProfile {
  const profile = listProfiles().find((p) => p.id === profileId)
  if (!profile) throw new Error(`Unknown profile: ${profileId}`)
  return profile
}

export function registerProfileHandlers(webContents: WebContents): void {
  profileEvents.on('changed', (profiles: ServerProfile[]) => {
    if (!webContents.isDestroyed()) webContents.send(IPC.profilesChanged, profiles)
  })

  ipcMain.handle(IPC.profilesList, () => listProfiles())

  ipcMain.handle(IPC.profilesSave, (_event, profile: ServerProfile) => {
    const profiles = saveProfile(profile)
    applyBackupSchedule(profile)
    syncPlayerBackupWatch(profile)
    syncDiscordChatBridgeWatch(profile)
    applyScheduledRestart(profile)
    applyScheduledDinoWipe(profile)
    applyScheduledRconCommands(profile)
    applyScheduledMaintenance(profile)
    return profiles
  })

  ipcMain.handle(IPC.profilesDelete, (_event, id: string) => {
    clearBackupSchedule(id)
    clearScheduledRestart(id)
    clearScheduledDinoWipe(id)
    clearScheduledRconCommands(id)
    clearScheduledMaintenance(id)
    return deleteProfile(id)
  })

  ipcMain.handle(IPC.profilesReorder, (_event, orderedIds: string[]) => setProfileOrder(orderedIds))

  ipcMain.handle(IPC.profilesExport, (_event, profileId: string, filePath: string) => {
    fs.writeFileSync(filePath, serializeProfile(requireProfile(profileId)), 'utf-8')
  })

  ipcMain.handle(IPC.profilesImportFromFile, (_event, filePath: string) => {
    const existing = listProfiles()
    const profile = parseImportedProfile(fs.readFileSync(filePath, 'utf-8'), existing.map((p) => p.name))
    const profiles = saveProfile(profile)
    applyBackupSchedule(profile)
    applyScheduledRestart(profile)
    applyScheduledDinoWipe(profile)
    applyScheduledRconCommands(profile)
    applyScheduledMaintenance(profile)
    return { profile, profiles }
  })

  ipcMain.handle(IPC.profilesImport, async (_event, installDir: string) => {
    const game = await detectGameFromInstall(installDir)
    if (!game) {
      throw new Error('No supported ARK server executable found in this folder.')
    }

    const detected = detectProfileFields(installDir)
    const existing = listProfiles()

    const name = uniqueProfileName(detected.suggestedName, existing.map((p) => p.name))

    const profile: ServerProfile = {
      id: randomUUID(),
      name,
      game,
      installDir,
      steamBetaEnabled: false,
      steamBetaName: '',
      map: detected.map,
      moddedMapEnabled: false,
      moddedMapId: '',
      gamePort: detected.gamePort ?? 7777,
      rconPort: detected.rconPort ?? 27020,
      queryPort: detected.queryPort ?? 27015,
      serverPlatform: 'PC',
      maxPlayers: 70,
      backupDir: '',
      maxBackups: 10,
      backupSchedule: '',
      backupScheduleEnabled: false,
      playerProfileBackupEnabled: false,
      playerProfileBackupMaxPerPlayer: 20,
      mods: detected.mods,
      clusterEnabled: false,
      clusterId: '',
      clusterDirOverride: '',
      noTransferFromFiltering: false,
      externalIp: '',
      discordChatChannelId: '',
      discordEventsChannelId: '',
      discordBotExcluded: false,
      cultureSettings: 'none',
      disableBattlEye: false,
      rconTribeLog: false,
      forceRespawnDinos: false,
      noSound: false,
      maxDinoLevel: '',
      serverPassword: '',
      autoManageMods: false,
      extraArgs: '',
      scheduledRestartEnabled: false,
      scheduledRestartTime: '00:00',
      scheduledRestartDays: [],
      scheduledRestartUpdateAfter: false,
      scheduledRestartStartAfter: false,
      scheduledRestartOnlyIfEmpty: false,
      scheduledRestartOnlyIfUpdateAvailable: false,
      scheduledDinoWipeEnabled: false,
      scheduledDinoWipeTime: '00:00',
      scheduledDinoWipeDays: [],
      scheduledRconCommands: [],
      scheduledMaintenanceEnabled: false,
      scheduledMaintenanceTime: '00:00',
      scheduledMaintenanceDays: [],
      startOnManagerLaunch: false,
      hidden: false,
      group: '',
      crashWatchEnabled: false,
      zombieDetectionEnabled: false,
      zombieDetectionTimeoutMinutes: 10,
      zombieDetectionAutoRestart: false,
      clusterLogArchiveMaxSizeMB: 10,
      statsEnabled: false
    }

    const profiles = saveProfile(profile)
    applyBackupSchedule(profile)
    return { profile, profiles }
  })

  ipcMain.handle(IPC.profilesCopy, async (_event, profileId: string, destInstallDir: string, newName: string) => {
    const copied = await copyProfile(requireProfile(profileId), destInstallDir, newName)
    const profiles = saveProfile(copied)
    applyBackupSchedule(copied)
    syncPlayerBackupWatch(copied)
    applyScheduledRestart(copied)
    applyScheduledDinoWipe(copied)
    applyScheduledRconCommands(copied)
    applyScheduledMaintenance(copied)
    return { profile: copied, profiles }
  })

  ipcMain.handle(IPC.profilesMove, async (_event, profileId: string, destInstallDir: string, newName: string) => {
    const moved = await moveProfile(requireProfile(profileId), destInstallDir, newName)
    const profiles = saveProfile(moved)
    applyBackupSchedule(moved)
    syncPlayerBackupWatch(moved)
    applyScheduledRestart(moved)
    applyScheduledDinoWipe(moved)
    applyScheduledRconCommands(moved)
    applyScheduledMaintenance(moved)
    return { profile: moved, profiles }
  })

  ipcMain.handle(IPC.profilesCopyConfigFrom, (_event, sourceProfileId: string, destProfileId: string) => {
    copyProfileConfigFiles(requireProfile(sourceProfileId).installDir, requireProfile(destProfileId).installDir)
  })
}
