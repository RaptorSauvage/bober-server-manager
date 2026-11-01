/**
 * Mounts the REAL, completely unmodified src/renderer/src/pages/IniTemplatesView.tsx - a
 * twenty-first real page, and the first real code in this whole PoC to write directly into a
 * real GameUserSettings.ini/Game.ini file. getIniTemplateGeneric/saveIniTemplateGeneric/
 * getIniTemplateOverride/saveIniTemplateOverride/deleteIniTemplateOverride (store.ts) are the
 * same real electron-store CRUD shape this PoC has proven many times over; the genuinely new
 * real code is applyIniTemplate/applyIniTemplateToAll (lib/iniTemplates.ts), which surgically
 * updates an existing key in place or inserts a new one into its section
 * (gameConfigWrite.ts's upsertIniKeys) - real, unmodified, not a template engine standing in
 * for it. window.api.dialog.selectIniFile backs "Import from file..." - a new native-dialog
 * command (dialog_select_ini_file), the same sidecar-free architectural class as
 * dialog_select_file/dialog_select_directory.
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import IniTemplatesView from '../../src/renderer/src/pages/IniTemplatesView'
import { wrapInvoke } from './lib/tauriInvoke'
import type {
  IniTemplateApplyResult,
  IniTemplateContent,
  IniTemplateProfileOverride,
  ServerProfile
} from '../../shared/types'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    }
    api: {
      dialog: {
        selectIniFile: () => Promise<string | null>
      }
      iniTemplates: {
        getGeneric: () => Promise<IniTemplateContent>
        saveGeneric: (content: IniTemplateContent) => Promise<IniTemplateContent>
        getOverride: (profileId: string) => Promise<IniTemplateProfileOverride | null>
        saveOverride: (override: IniTemplateProfileOverride) => Promise<IniTemplateProfileOverride[]>
        deleteOverride: (profileId: string) => Promise<IniTemplateProfileOverride[]>
        apply: (profileId: string) => Promise<void>
        applyAll: () => Promise<IniTemplateApplyResult[]>
        readFile: (filePath: string) => Promise<string>
      }
    }
  }
}

const invoke = wrapInvoke(window.__TAURI__.core.invoke)

window.api = {
  dialog: {
    selectIniFile: () => invoke('dialog_select_ini_file') as Promise<string | null>
  },
  iniTemplates: {
    getGeneric: () => invoke('ini_templates_get_generic') as Promise<IniTemplateContent>,
    saveGeneric: (content) => invoke('ini_templates_save_generic', { content }) as Promise<IniTemplateContent>,
    getOverride: (profileId) =>
      invoke('ini_templates_get_override', { profileId }) as Promise<IniTemplateProfileOverride | null>,
    saveOverride: (override) =>
      invoke('ini_templates_save_override', { overrideEntry: override }) as Promise<IniTemplateProfileOverride[]>,
    deleteOverride: (profileId) =>
      invoke('ini_templates_delete_override', { profileId }) as Promise<IniTemplateProfileOverride[]>,
    apply: (profileId) => invoke('ini_templates_apply', { profileId }) as Promise<void>,
    applyAll: () => invoke('ini_templates_apply_all') as Promise<IniTemplateApplyResult[]>,
    readFile: (filePath) => invoke('ini_templates_read_file', { filePath }) as Promise<string>
  }
}

function IniTemplatesPage(): JSX.Element | null {
  const [profiles, setProfiles] = useState<ServerProfile[] | null>(null)

  useEffect(() => {
    invoke('profiles_list').then((result) => setProfiles(result as ServerProfile[]))
  }, [])

  if (!profiles) return null

  return <IniTemplatesView profiles={profiles} onBack={() => window.history.back()} />
}

const container = document.getElementById('root')
if (!container) throw new Error('ini-templates.html is missing #root')
createRoot(container).render(<IniTemplatesPage />)
