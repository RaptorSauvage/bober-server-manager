import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type Api,
  type ServerProfile,
  type ServerStatus,
  type ServerMod,
  type AppSettings,
  type AppUpdateStatus,
  type BackupLogEntry,
  type WebDashboardRole,
  type GroupConsoleEvent,
  type RconResult,
  type ManagerLogEntry
} from '@shared/types'
import type { MinecraftProfile, MinecraftServerStatus, MinecraftConsoleLine, MinecraftPropertiesData } from '@shared/minecraft'
import type { MinecraftModSource, MinecraftModEcosystem } from '@shared/minecraftMods'
import type { MinecraftInstallableType, MinecraftInstallParams } from '@shared/minecraftInstall'

const api: Api = {
  profiles: {
    list: () => ipcRenderer.invoke(IPC.profilesList),
    save: (profile: ServerProfile) => ipcRenderer.invoke(IPC.profilesSave, profile),
    delete: (id: string) => ipcRenderer.invoke(IPC.profilesDelete, id),
    importFromInstall: (installDir: string) => ipcRenderer.invoke(IPC.profilesImport, installDir),
    reorder: (orderedIds: string[]) => ipcRenderer.invoke(IPC.profilesReorder, orderedIds),
    export: (profileId: string, filePath: string) => ipcRenderer.invoke(IPC.profilesExport, profileId, filePath),
    importFromFile: (filePath: string) => ipcRenderer.invoke(IPC.profilesImportFromFile, filePath),
    copy: (profileId: string, destInstallDir: string, newName: string) =>
      ipcRenderer.invoke(IPC.profilesCopy, profileId, destInstallDir, newName),
    move: (profileId: string, destInstallDir: string, newName: string) =>
      ipcRenderer.invoke(IPC.profilesMove, profileId, destInstallDir, newName),
    copyConfigFrom: (sourceProfileId: string, destProfileId: string) =>
      ipcRenderer.invoke(IPC.profilesCopyConfigFrom, sourceProfileId, destProfileId),
    onChanged: (callback: (profiles: ServerProfile[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, profiles: ServerProfile[]): void => callback(profiles)
      ipcRenderer.on(IPC.profilesChanged, listener)
      return () => ipcRenderer.removeListener(IPC.profilesChanged, listener)
    }
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke(IPC.dialogSelectDirectory),
    selectFile: () => ipcRenderer.invoke(IPC.dialogSelectFile),
    saveProfileFile: (defaultName: string) => ipcRenderer.invoke(IPC.dialogSaveProfileFile, defaultName),
    selectProfileFile: () => ipcRenderer.invoke(IPC.dialogSelectProfileFile),
    saveClusterBundleFile: () => ipcRenderer.invoke(IPC.dialogSaveClusterBundleFile),
    selectClusterBundleFile: () => ipcRenderer.invoke(IPC.dialogSelectClusterBundleFile),
    selectIniFile: () => ipcRenderer.invoke(IPC.dialogSelectIniFile)
  },
  cluster: {
    export: (filePath: string) => ipcRenderer.invoke(IPC.clusterExport, filePath),
    import: (filePath: string, options: { includeSettings: boolean }) =>
      ipcRenderer.invoke(IPC.clusterImport, filePath, options)
  },
  server: {
    start: (profileId: string) => ipcRenderer.invoke(IPC.serverStart, profileId),
    stop: (profileId: string) => ipcRenderer.invoke(IPC.serverStop, profileId),
    restart: (profileId: string) => ipcRenderer.invoke(IPC.serverRestart, profileId),
    kill: (profileId: string) => ipcRenderer.invoke(IPC.serverKill, profileId),
    update: (profileId: string) => ipcRenderer.invoke(IPC.serverUpdate, profileId),
    isInstalled: (profileId: string) => ipcRenderer.invoke(IPC.serverIsInstalled, profileId),
    status: (profileId: string) => ipcRenderer.invoke(IPC.serverStatus, profileId),
    onStatusChanged: (callback: (status: ServerStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: ServerStatus): void => callback(status)
      ipcRenderer.on(IPC.serverStatusChanged, listener)
      return () => ipcRenderer.removeListener(IPC.serverStatusChanged, listener)
    },
    getInstalledBuildId: (profileId: string) => ipcRenderer.invoke(IPC.serverGetInstalledBuildId, profileId),
    getGameVersion: (profileId: string) => ipcRenderer.invoke(IPC.serverGetGameVersion, profileId),
    previewLaunchCommand: (profile: ServerProfile) => ipcRenderer.invoke(IPC.serverPreviewLaunchCommand, profile)
  },
  mods: {
    save: (profileId: string, mods: ServerMod[]) => ipcRenderer.invoke(IPC.modsSave, profileId, mods),
    parseText: (text: string) => ipcRenderer.invoke(IPC.modsParseText, text),
    reconcileFromIni: (profileId: string) => ipcRenderer.invoke(IPC.modsReconcileFromIni, profileId)
  },
  arkMods: {
    search: (query: string) => ipcRenderer.invoke(IPC.arkModsSearch, query),
    info: (modIds: string[]) => ipcRenderer.invoke(IPC.arkModsInfo, modIds)
  },
  backup: {
    create: (profileId: string) => ipcRenderer.invoke(IPC.backupCreate, profileId),
    list: (profileId: string) => ipcRenderer.invoke(IPC.backupList, profileId),
    delete: (filePath: string) => ipcRenderer.invoke(IPC.backupDelete, filePath),
    restore: (profileId: string, filePath: string) => ipcRenderer.invoke(IPC.backupRestore, profileId, filePath),
    openFolder: (profileId: string) => ipcRenderer.invoke(IPC.backupOpenFolder, profileId),
    onCreated: (callback: (profileId: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, profileId: string): void => callback(profileId)
      ipcRenderer.on(IPC.backupCreated, listener)
      return () => ipcRenderer.removeListener(IPC.backupCreated, listener)
    },
    getScheduleStatus: (profileId: string) => ipcRenderer.invoke(IPC.backupScheduleStatus, profileId),
    getLog: (profileId: string) => ipcRenderer.invoke(IPC.backupLogGet, profileId),
    onLogChanged: (callback: (profileId: string, entry: BackupLogEntry) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, profileId: string, entry: BackupLogEntry): void =>
        callback(profileId, entry)
      ipcRenderer.on(IPC.backupLogChanged, listener)
      return () => ipcRenderer.removeListener(IPC.backupLogChanged, listener)
    }
  },
  playerBackup: {
    listFolders: (profileId: string) => ipcRenderer.invoke(IPC.playerBackupFoldersList, profileId),
    list: (profileId: string, folderKey: string) => ipcRenderer.invoke(IPC.playerBackupList, profileId, folderKey),
    openFolder: (profileId: string, folderKey: string) =>
      ipcRenderer.invoke(IPC.playerBackupOpenFolder, profileId, folderKey)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    save: (settings: AppSettings) => ipcRenderer.invoke(IPC.settingsSave, settings)
  },
  steamcmd: {
    install: () => ipcRenderer.invoke(IPC.steamcmdInstall),
    managedStatus: () => ipcRenderer.invoke(IPC.steamcmdManagedStatus),
    getUpdateLog: (profileId: string) => ipcRenderer.invoke(IPC.steamcmdUpdateLog, profileId),
    onUpdateLogChanged: (callback: (profileId: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, profileId: string): void => callback(profileId)
      ipcRenderer.on(IPC.steamcmdUpdateLogChanged, listener)
      return () => ipcRenderer.removeListener(IPC.steamcmdUpdateLogChanged, listener)
    },
    addFirewallRule: (steamCmdPath: string) => ipcRenderer.invoke(IPC.steamcmdAddFirewallRule, steamCmdPath),
    getLatestBuildId: (game, branch) => ipcRenderer.invoke(IPC.steamcmdLatestBuildId, game, branch)
  },
  maps: {
    list: (game) => ipcRenderer.invoke(IPC.mapsList, game)
  },
  customMaps: {
    list: () => ipcRenderer.invoke(IPC.customMapsList),
    add: (entry) => ipcRenderer.invoke(IPC.customMapsAdd, entry),
    update: (originalId, entry) => ipcRenderer.invoke(IPC.customMapsUpdate, originalId, entry),
    delete: (id) => ipcRenderer.invoke(IPC.customMapsDelete, id)
  },
  dataDir: {
    getDefault: () => ipcRenderer.invoke(IPC.dataDirGetDefault)
  },
  officialServerStatus: {
    get: () => ipcRenderer.invoke(IPC.officialServerStatusGet)
  },
  systemStats: {
    get: () => ipcRenderer.invoke(IPC.systemStatsGet),
    getNetworkUsage: () => ipcRenderer.invoke(IPC.systemStatsGetNetworkUsage)
  },
  webDashboard: {
    getStatus: () => ipcRenderer.invoke(IPC.webDashboardStatus),
    getLocalIps: () => ipcRenderer.invoke(IPC.webDashboardLocalIps)
  },
  webDashboardAccessTokens: {
    list: () => ipcRenderer.invoke(IPC.webDashboardAccessTokensList),
    create: (label: string, role: WebDashboardRole, profileIds: string[] | null) =>
      ipcRenderer.invoke(IPC.webDashboardAccessTokensCreate, label, role, profileIds),
    update: (id: string, updates: { label?: string; role?: WebDashboardRole; profileIds?: string[] | null }) =>
      ipcRenderer.invoke(IPC.webDashboardAccessTokensUpdate, id, updates),
    delete: (id: string) => ipcRenderer.invoke(IPC.webDashboardAccessTokensDelete, id)
  },
  webDashboardApiKeys: {
    list: () => ipcRenderer.invoke(IPC.webDashboardApiKeysList),
    create: (label: string, role: WebDashboardRole) => ipcRenderer.invoke(IPC.webDashboardApiKeysCreate, label, role),
    update: (id: string, updates: { label?: string; role?: WebDashboardRole }) =>
      ipcRenderer.invoke(IPC.webDashboardApiKeysUpdate, id, updates),
    delete: (id: string) => ipcRenderer.invoke(IPC.webDashboardApiKeysDelete, id)
  },
  playerBans: {
    list: () => ipcRenderer.invoke(IPC.playerBansList),
    ban: (profileId: string, playerId: string, playerName: string, reason: string) =>
      ipcRenderer.invoke(IPC.playerBansBan, profileId, playerId, playerName, reason),
    unban: (profileId: string, playerId: string) => ipcRenderer.invoke(IPC.playerBansUnban, profileId, playerId)
  },
  playerWhitelist: {
    list: () => ipcRenderer.invoke(IPC.playerWhitelistList),
    add: (profileId: string, playerId: string, playerName: string) =>
      ipcRenderer.invoke(IPC.playerWhitelistAdd, profileId, playerId, playerName),
    remove: (profileId: string, playerId: string) => ipcRenderer.invoke(IPC.playerWhitelistRemove, profileId, playerId)
  },
  playerRoster: {
    list: (profileId: string) => ipcRenderer.invoke(IPC.playerRosterList, profileId),
    kick: (profileId: string, playerId: string) => ipcRenderer.invoke(IPC.playerRosterKick, profileId, playerId)
  },
  watchedPlayers: {
    list: () => ipcRenderer.invoke(IPC.watchedPlayersList),
    add: (value: string, label: string) => ipcRenderer.invoke(IPC.watchedPlayersAdd, value, label),
    remove: (id: string) => ipcRenderer.invoke(IPC.watchedPlayersRemove, id)
  },
  playerActivity: {
    list: () => ipcRenderer.invoke(IPC.playerActivityList),
    sessions: () => ipcRenderer.invoke(IPC.playerActivitySessions)
  },
  modEvents: {
    list: () => ipcRenderer.invoke(IPC.modEventsList),
    save: (event) => ipcRenderer.invoke(IPC.modEventsSave, event),
    delete: (id) => ipcRenderer.invoke(IPC.modEventsDelete, id),
    history: () => ipcRenderer.invoke(IPC.modEventsHistoryList)
  },
  iniTemplates: {
    getGeneric: () => ipcRenderer.invoke(IPC.iniTemplatesGetGeneric),
    saveGeneric: (content) => ipcRenderer.invoke(IPC.iniTemplatesSaveGeneric, content),
    getOverride: (profileId) => ipcRenderer.invoke(IPC.iniTemplatesGetOverride, profileId),
    saveOverride: (override) => ipcRenderer.invoke(IPC.iniTemplatesSaveOverride, override),
    deleteOverride: (profileId) => ipcRenderer.invoke(IPC.iniTemplatesDeleteOverride, profileId),
    apply: (profileId) => ipcRenderer.invoke(IPC.iniTemplatesApply, profileId),
    applyAll: () => ipcRenderer.invoke(IPC.iniTemplatesApplyAll),
    readFile: (filePath) => ipcRenderer.invoke(IPC.iniTemplatesReadFile, filePath),
    generatePending: (profileId) => ipcRenderer.invoke(IPC.iniTemplatesGeneratePending, profileId),
    getPendingStatus: (profileId) => ipcRenderer.invoke(IPC.iniTemplatesGetPendingStatus, profileId),
    confirmPending: (profileId) => ipcRenderer.invoke(IPC.iniTemplatesConfirmPending, profileId),
    discardPending: (profileId) => ipcRenderer.invoke(IPC.iniTemplatesDiscardPending, profileId)
  },
  fileBrowser: {
    list: (profileId: string, relativePath: string) => ipcRenderer.invoke(IPC.fileBrowserList, profileId, relativePath),
    open: (profileId: string, relativePath: string) => ipcRenderer.invoke(IPC.fileBrowserOpen, profileId, relativePath),
    delete: (profileId: string, relativePath: string) => ipcRenderer.invoke(IPC.fileBrowserDelete, profileId, relativePath),
    readIni: (profileId: string, relativePath: string) => ipcRenderer.invoke(IPC.fileBrowserReadIni, profileId, relativePath),
    writeIni: (profileId: string, relativePath: string, content: string) =>
      ipcRenderer.invoke(IPC.fileBrowserWriteIni, profileId, relativePath, content),
    iniHistory: (profileId: string, relativePath: string) => ipcRenderer.invoke(IPC.fileBrowserIniHistory, profileId, relativePath),
    iniHistoryDiff: (profileId: string, entryId: string) => ipcRenderer.invoke(IPC.fileBrowserIniHistoryDiff, profileId, entryId),
    iniRestore: (profileId: string, entryId: string) => ipcRenderer.invoke(IPC.fileBrowserIniRestore, profileId, entryId)
  },
  discordBot: {
    status: () => ipcRenderer.invoke(IPC.discordBotStatus),
    restart: () => ipcRenderer.invoke(IPC.discordBotRestart),
    stop: () => ipcRenderer.invoke(IPC.discordBotStop)
  },
  system: {
    openProfilesFolder: () => ipcRenderer.invoke(IPC.appOpenProfilesFolder),
    openDataDirFolder: () => ipcRenderer.invoke(IPC.appOpenDataDirFolder),
    openServerConfigFolder: (profileId: string) => ipcRenderer.invoke(IPC.serverOpenConfigFolder, profileId),
    openServerSavedArksFolder: (profileId: string) => ipcRenderer.invoke(IPC.serverOpenSavedArksFolder, profileId),
    openServerSaveGamesFolder: (profileId: string) => ipcRenderer.invoke(IPC.serverOpenSaveGamesFolder, profileId),
    focusWindow: () => ipcRenderer.invoke(IPC.appFocusWindow),
    quit: () => ipcRenderer.invoke(IPC.appQuit),
    openDevTools: () => ipcRenderer.invoke(IPC.appOpenDevTools)
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(IPC.windowClose),
    isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
    onMaximizedChange: (callback: (maximized: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, maximized: boolean): void => callback(maximized)
      ipcRenderer.on(IPC.windowMaximizedChanged, listener)
      return () => ipcRenderer.removeListener(IPC.windowMaximizedChanged, listener)
    }
  },
  mapManagement: {
    list: (profileId: string) => ipcRenderer.invoke(IPC.mapManagementList, profileId),
    create: (profileId: string, folderName: string, fileName: string) =>
      ipcRenderer.invoke(IPC.mapManagementCreate, profileId, folderName, fileName),
    delete: (profileId: string, folderName: string) => ipcRenderer.invoke(IPC.mapManagementDelete, profileId, folderName),
    openFolder: (profileId: string, folderName: string) =>
      ipcRenderer.invoke(IPC.mapManagementOpenFolder, profileId, folderName)
  },
  appUpdate: {
    getVersion: () => ipcRenderer.invoke(IPC.appUpdateGetVersion),
    check: () => ipcRenderer.invoke(IPC.appUpdateCheck),
    install: () => ipcRenderer.invoke(IPC.appUpdateInstall),
    getStatus: () => ipcRenderer.invoke(IPC.appUpdateStatus),
    onStatusChanged: (callback: (status: AppUpdateStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: AppUpdateStatus): void => callback(status)
      ipcRenderer.on(IPC.appUpdateStatusChanged, listener)
      return () => ipcRenderer.removeListener(IPC.appUpdateStatusChanged, listener)
    }
  },
  appStartup: {
    isComplete: () => ipcRenderer.invoke(IPC.appStartupStatus),
    onComplete: (callback: () => void) => {
      const listener = (): void => callback()
      ipcRenderer.on(IPC.appStartupStatusChanged, listener)
      return () => ipcRenderer.removeListener(IPC.appStartupStatusChanged, listener)
    }
  },
  groupConsole: {
    subscribe: (profileIds: string[]) => ipcRenderer.invoke(IPC.groupConsoleSubscribe, profileIds),
    unsubscribe: () => ipcRenderer.invoke(IPC.groupConsoleUnsubscribe),
    onEvent: (callback: (event: GroupConsoleEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: GroupConsoleEvent): void => callback(payload)
      ipcRenderer.on(IPC.groupConsoleEvent, listener)
      return () => ipcRenderer.removeListener(IPC.groupConsoleEvent, listener)
    },
    sendRcon: (profileId: string, command: string): Promise<RconResult> =>
      ipcRenderer.invoke(IPC.groupConsoleRconSend, profileId, command)
  },
  managerLog: {
    getLog: () => ipcRenderer.invoke(IPC.managerLogGet),
    onLogChanged: (callback: (entry: ManagerLogEntry) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, entry: ManagerLogEntry): void => callback(entry)
      ipcRenderer.on(IPC.managerLogChanged, listener)
      return () => ipcRenderer.removeListener(IPC.managerLogChanged, listener)
    }
  },
  statsHistory: {
    get: (profileId: string, sinceMs: number | null, maxPoints?: number) =>
      ipcRenderer.invoke(IPC.statsHistoryGet, profileId, sinceMs, maxPoints),
    getForGroup: (profileIds: string[], sinceMs: number | null, maxPoints?: number) =>
      ipcRenderer.invoke(IPC.statsHistoryGetForGroup, profileIds, sinceMs, maxPoints),
    getForGroups: (groupProfileIds: Record<string, string[]>, sinceMs: number | null, maxPoints?: number) =>
      ipcRenderer.invoke(IPC.statsHistoryGetForGroups, groupProfileIds, sinceMs, maxPoints)
  },
  minecraft: {
    profiles: {
      list: () => ipcRenderer.invoke(IPC.minecraftProfilesList),
      save: (profile: MinecraftProfile) => ipcRenderer.invoke(IPC.minecraftProfilesSave, profile),
      delete: (id: string) => ipcRenderer.invoke(IPC.minecraftProfilesDelete, id),
      importFromInstall: (installDir: string) => ipcRenderer.invoke(IPC.minecraftProfilesImport, installDir),
      onChanged: (callback: (profiles: MinecraftProfile[]) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, profiles: MinecraftProfile[]): void => callback(profiles)
        ipcRenderer.on(IPC.minecraftProfilesChanged, listener)
        return () => ipcRenderer.removeListener(IPC.minecraftProfilesChanged, listener)
      }
    },
    detectLaunchable: (installDir: string) => ipcRenderer.invoke(IPC.minecraftDetectLaunchable, installDir),
    openServerFolder: (profileId: string) => ipcRenderer.invoke(IPC.minecraftOpenServerFolder, profileId),
    server: {
      start: (profileId: string) => ipcRenderer.invoke(IPC.minecraftServerStart, profileId),
      stop: (profileId: string) => ipcRenderer.invoke(IPC.minecraftServerStop, profileId),
      kill: (profileId: string) => ipcRenderer.invoke(IPC.minecraftServerKill, profileId),
      getStatus: (profileId: string) => ipcRenderer.invoke(IPC.minecraftServerStatus, profileId),
      onStatusChanged: (callback: (status: MinecraftServerStatus) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, status: MinecraftServerStatus): void => callback(status)
        ipcRenderer.on(IPC.minecraftServerStatusChanged, listener)
        return () => ipcRenderer.removeListener(IPC.minecraftServerStatusChanged, listener)
      },
      sendCommand: (profileId: string, command: string): Promise<RconResult> =>
        ipcRenderer.invoke(IPC.minecraftServerSendCommand, profileId, command)
    },
    console: {
      getBacklog: (profileId: string) => ipcRenderer.invoke(IPC.minecraftConsoleBacklog, profileId),
      onLine: (callback: (profileId: string, line: MinecraftConsoleLine) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, profileId: string, line: MinecraftConsoleLine): void =>
          callback(profileId, line)
        ipcRenderer.on(IPC.minecraftConsoleLine, listener)
        return () => ipcRenderer.removeListener(IPC.minecraftConsoleLine, listener)
      }
    },
    properties: {
      get: (profileId: string) => ipcRenderer.invoke(IPC.minecraftPropertiesGet, profileId),
      save: (profileId: string, updates: MinecraftPropertiesData) =>
        ipcRenderer.invoke(IPC.minecraftPropertiesSave, profileId, updates)
    },
    backup: {
      create: (profileId: string) => ipcRenderer.invoke(IPC.minecraftBackupCreate, profileId),
      list: (profileId: string) => ipcRenderer.invoke(IPC.minecraftBackupList, profileId),
      delete: (filePath: string) => ipcRenderer.invoke(IPC.minecraftBackupDelete, filePath),
      restore: (profileId: string, filePath: string) => ipcRenderer.invoke(IPC.minecraftBackupRestore, profileId, filePath),
      openFolder: (profileId: string) => ipcRenderer.invoke(IPC.minecraftBackupOpenFolder, profileId),
      onCreated: (callback: (profileId: string) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, profileId: string): void => callback(profileId)
        ipcRenderer.on(IPC.minecraftBackupCreated, listener)
        return () => ipcRenderer.removeListener(IPC.minecraftBackupCreated, listener)
      },
      getScheduleStatus: (profileId: string) => ipcRenderer.invoke(IPC.minecraftBackupScheduleStatus, profileId),
      getLog: (profileId: string) => ipcRenderer.invoke(IPC.minecraftBackupLogGet, profileId),
      onLogChanged: (callback: (profileId: string, entry: BackupLogEntry) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, profileId: string, entry: BackupLogEntry): void =>
          callback(profileId, entry)
        ipcRenderer.on(IPC.minecraftBackupLogChanged, listener)
        return () => ipcRenderer.removeListener(IPC.minecraftBackupLogChanged, listener)
      }
    },
    mods: {
      search: (profileId: string, query: string, ecosystem: MinecraftModEcosystem) =>
        ipcRenderer.invoke(IPC.minecraftModsSearch, profileId, query, ecosystem),
      install: (profileId: string, source: MinecraftModSource, projectId: string, ecosystem: MinecraftModEcosystem) =>
        ipcRenderer.invoke(IPC.minecraftModsInstall, profileId, source, projectId, ecosystem),
      remove: (profileId: string, projectId: string) => ipcRenderer.invoke(IPC.minecraftModsRemove, profileId, projectId),
      setEnabled: (profileId: string, projectId: string, enabled: boolean) =>
        ipcRenderer.invoke(IPC.minecraftModsSetEnabled, profileId, projectId, enabled),
      checkUpdates: (profileId: string) => ipcRenderer.invoke(IPC.minecraftModsCheckUpdates, profileId),
      update: (profileId: string, source: MinecraftModSource, projectId: string) =>
        ipcRenderer.invoke(IPC.minecraftModsUpdate, profileId, source, projectId),
      scan: (profileId: string) => ipcRenderer.invoke(IPC.minecraftModsScan, profileId),
      openFolder: (profileId: string) => ipcRenderer.invoke(IPC.minecraftModsOpenFolder, profileId)
    },
    install: {
      listVersions: (serverType: MinecraftInstallableType) => ipcRenderer.invoke(IPC.minecraftInstallListVersions, serverType),
      listLoaderVersions: (serverType: MinecraftInstallableType, minecraftVersion: string) =>
        ipcRenderer.invoke(IPC.minecraftInstallListLoaderVersions, serverType, minecraftVersion),
      run: (params: MinecraftInstallParams) => ipcRenderer.invoke(IPC.minecraftInstallRun, params)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
