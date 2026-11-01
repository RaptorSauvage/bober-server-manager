/**
 * PoC-only stand-in for the subset of Electron's `app` module that main/store.ts (via
 * electron-store) and lib/dataDir.ts actually touch. Bundled in place of the real 'electron'
 * module (see build.mjs's esbuild alias) so this sidecar can run as a plain Node child process
 * instead of inside Electron's own runtime - this is exactly the kind of small decoupling
 * point a real Tauri migration would need everywhere Electron APIs leak into business logic;
 * surfacing it cheaply here (two methods, one file) is the actual point of this PoC, not
 * something to treat as finished infrastructure.
 */
import os from 'node:os'
import path from 'node:path'
import { callRust } from './rpcToRust'

const POC_USER_DATA = path.join(os.homedir(), '.tauri-poc-bober-manager')

export const app = {
  getPath(name: string): string {
    if (name === 'userData') return POC_USER_DATA
    if (name === 'documents') return path.join(os.homedir(), 'Documents')
    throw new Error(`electronShim.app.getPath: unhandled path name "${name}" - add it if the sidecar needs it`)
  },
  getVersion(): string {
    return '0.0.0-poc'
  },
  isPackaged: false,
  setLoginItemSettings(_settings: { openAtLogin: boolean }): void {
    // No real "launch at login" concept for a plain Node child process - lib/launchOnStartup.ts
    // already wraps its one call to this in a try/catch and treats a thrown error as a
    // harmless no-op in an unsupported environment, so a stub that quietly accepts the call
    // is the honest PoC-appropriate behavior here, not a thrown "unimplemented".
  }
}

/**
 * electron-store's own constructor (node_modules/electron-store/index.js) only uses this
 * shim's `app.getPath('userData')` as its data directory when `ipcMain && app` is truthy -
 * found by actually hitting the failure this avoids, not by reading electron-store's source
 * first: running the packaged SEA binary standalone (no `node_modules`/`package.json` nearby,
 * unlike running from this source tree where `conf`'s own fallback happens to find one) threw
 * "Project name could not be inferred" from deep inside `conf`, because with `ipcMain`
 * undefined the real electron-store skips straight past `app.getPath('userData')` to that
 * fallback regardless of what this shim's `app` returns. A one-method `ipcMain` stub (just
 * enough to satisfy electron-store's own internal `ipcMain.on('electron-store-get-data', ...)`
 * registration, never actually invoked since there's no separate renderer process here) is
 * enough to make it take the `app.getPath('userData')` path instead.
 */
export const ipcMain = {
  on(_channel: string, _listener: (...args: unknown[]) => void): void {}
}

/**
 * Real lib files (systemFolders.ts, backup.ts, ...) call `shell.openPath(path)` directly - a
 * native "open in the system file manager" call only the Rust shell can actually make (see
 * rpcToRust.ts for the bidirectional plumbing this round-trips through). Matches real
 * Electron's own `shell.openPath` return shape exactly, since every real call site checks it
 * that way: an empty string means success, a non-empty string is the error message - none of
 * them `catch` a thrown error.
 */
export const shell = {
  async openPath(targetPath: string): Promise<string> {
    try {
      await callRust('openPath', { path: targetPath })
      return ''
    } catch (err) {
      return (err as Error).message
    }
  }
}
