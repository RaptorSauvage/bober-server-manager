/**
 * Mounts the REAL, completely unmodified src/renderer/src/pages/EventSchedulerView.tsx - a
 * nineteenth real page, and the first subsystem in this PoC that reconciles its own state
 * immediately on save/startup rather than waiting for a user action or a live status push.
 * Real, unmodified listModEvents/saveModEvent/deleteModEvent/listModEventHistory (store.ts) and
 * armModEvent/disarmModEvent/armAllModEvents (lib/modEvents.ts) - the latter owns real
 * `node-cron` schedules and `setTimeout`s (not Electron APIs at all) that fire a real
 * reconciliation pass (applyModEventChange) adding/removing real mod ids on real target
 * profiles' own mod lists, including a real stop-then-start cycle through the already-proven
 * serverProcess.ts functions when shutdownOnStart/shutdownOnEnd is set. No new push event -
 * the real page just re-fetches list/history after every save/delete, same shape "A ninth real
 * page" already proved doesn't need one.
 */
import { createRoot } from 'react-dom/client'
import EventSchedulerView from '../../src/renderer/src/pages/EventSchedulerView'
import { wrapInvoke } from './lib/tauriInvoke'
import { useEffect, useState } from 'react'
import type { ModEvent, ModEventHistoryEntry, ServerProfile } from '../../shared/types'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    }
    api: {
      system: {
        focusWindow: () => Promise<void>
      }
      modEvents: {
        list: () => Promise<ModEvent[]>
        save: (event: ModEvent) => Promise<ModEvent[]>
        delete: (id: string) => Promise<ModEvent[]>
        history: () => Promise<ModEventHistoryEntry[]>
      }
    }
  }
}

const invoke = wrapInvoke(window.__TAURI__.core.invoke)

window.api = {
  system: {
    focusWindow: () => invoke('window_focus') as Promise<void>
  },
  modEvents: {
    list: () => invoke('mod_events_list') as Promise<ModEvent[]>,
    save: (event) => invoke('mod_events_save', { event }) as Promise<ModEvent[]>,
    delete: (id) => invoke('mod_events_delete', { id }) as Promise<ModEvent[]>,
    history: () => invoke('mod_events_history') as Promise<ModEventHistoryEntry[]>
  }
}

function EventSchedulerPage(): JSX.Element | null {
  const [profiles, setProfiles] = useState<ServerProfile[] | null>(null)

  useEffect(() => {
    invoke('profiles_list').then((result) => setProfiles(result as ServerProfile[]))
  }, [])

  if (!profiles) return null

  return <EventSchedulerView profiles={profiles} onBack={() => window.history.back()} />
}

const container = document.getElementById('root')
if (!container) throw new Error('event-scheduler.html is missing #root')
createRoot(container).render(<EventSchedulerPage />)
