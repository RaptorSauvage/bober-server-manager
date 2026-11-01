/**
 * Mounts the REAL, completely unmodified src/renderer/src/pages/MapManagerView.tsx - a
 * twentieth real page, and a different real file-backed subsystem from every store.ts-based one
 * this PoC has ported so far: real, unmodified listMaps() (lib/maps.ts, reads the shipped
 * per-game maps.json) and listCustomMaps/addCustomMap/updateCustomMap/deleteCustomMap
 * (lib/customMaps.ts, reads/writes a real customMaps.json via jsonListFile.ts's own
 * read/parse/write helpers) - proving getDataDir()'s JSON-list file subsystem ports with zero
 * Electron coupling too. No push event needed, same shape "A ninth"/"A nineteenth real page"
 * already proved doesn't need one.
 */
import { createRoot } from 'react-dom/client'
import MapManagerView from '../../src/renderer/src/pages/MapManagerView'
import { wrapInvoke } from './lib/tauriInvoke'
import type { MapDefinition } from '../../shared/types'
import type { GameId } from '../../shared/games'

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    }
    api: {
      system: {
        focusWindow: () => Promise<void>
      }
      maps: {
        list: (game: GameId) => Promise<MapDefinition[]>
      }
      customMaps: {
        list: () => Promise<MapDefinition[]>
        add: (entry: { id: string; displayName: string; modId?: string }) => Promise<MapDefinition[]>
        update: (originalId: string, entry: { id: string; displayName: string; modId?: string }) => Promise<MapDefinition[]>
        delete: (id: string) => Promise<MapDefinition[]>
      }
    }
  }
}

const invoke = wrapInvoke(window.__TAURI__.core.invoke)

window.api = {
  system: {
    focusWindow: () => invoke('window_focus') as Promise<void>
  },
  maps: {
    list: (game) => invoke('maps_list', { game }) as Promise<MapDefinition[]>
  },
  customMaps: {
    list: () => invoke('custom_maps_list') as Promise<MapDefinition[]>,
    add: (entry) => invoke('custom_maps_add', { entry }) as Promise<MapDefinition[]>,
    update: (originalId, entry) =>
      invoke('custom_maps_update', { originalId, entry }) as Promise<MapDefinition[]>,
    delete: (id) => invoke('custom_maps_delete', { id }) as Promise<MapDefinition[]>
  }
}

const container = document.getElementById('root')
if (!container) throw new Error('map-manager.html is missing #root')
createRoot(container).render(<MapManagerView onBack={() => window.history.back()} />)
