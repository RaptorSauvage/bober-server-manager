import fs from 'node:fs'
import { ipcMain } from 'electron'
import { IPC, type IniTemplateContent, type IniTemplateProfileOverride } from '@shared/types'
import {
  getIniTemplateGeneric,
  saveIniTemplateGeneric,
  getIniTemplateOverride,
  saveIniTemplateOverride,
  deleteIniTemplateOverride,
  getProfile
} from '../store'
import {
  applyIniTemplate,
  applyIniTemplateToAll,
  generatePendingIniTemplate,
  getPendingIniTemplateStatus,
  confirmPendingIniTemplate,
  discardPendingIniTemplate
} from '../lib/iniTemplates'

function requireProfile(profileId: string) {
  const profile = getProfile(profileId)
  if (!profile) throw new Error(`Unknown profile: ${profileId}`)
  return profile
}

export function registerIniTemplatesHandlers(): void {
  ipcMain.handle(IPC.iniTemplatesGetGeneric, () => getIniTemplateGeneric())

  ipcMain.handle(IPC.iniTemplatesSaveGeneric, (_event, content: IniTemplateContent) => saveIniTemplateGeneric(content))

  ipcMain.handle(IPC.iniTemplatesGetOverride, (_event, profileId: string) => getIniTemplateOverride(profileId) ?? null)

  ipcMain.handle(IPC.iniTemplatesSaveOverride, (_event, override: IniTemplateProfileOverride) => saveIniTemplateOverride(override))

  ipcMain.handle(IPC.iniTemplatesDeleteOverride, (_event, profileId: string) => deleteIniTemplateOverride(profileId))

  ipcMain.handle(IPC.iniTemplatesApply, (_event, profileId: string) => applyIniTemplate(requireProfile(profileId)))

  ipcMain.handle(IPC.iniTemplatesApplyAll, () => applyIniTemplateToAll())

  ipcMain.handle(IPC.iniTemplatesGeneratePending, (_event, profileId: string) => generatePendingIniTemplate(requireProfile(profileId)))

  ipcMain.handle(IPC.iniTemplatesGetPendingStatus, (_event, profileId: string) => getPendingIniTemplateStatus(requireProfile(profileId)))

  ipcMain.handle(IPC.iniTemplatesConfirmPending, (_event, profileId: string) => confirmPendingIniTemplate(requireProfile(profileId)))

  ipcMain.handle(IPC.iniTemplatesDiscardPending, (_event, profileId: string) => discardPendingIniTemplate(requireProfile(profileId)))

  ipcMain.handle(IPC.iniTemplatesReadFile, (_event, filePath: string) => {
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch (err) {
      throw new Error(`Couldn't read ${filePath}: ${(err as Error).message}`)
    }
  })
}
