/**
 * Keeps every real existing installation reading and writing the exact same on-disk folder it
 * always has, across the package.json `name` rename from "ark-server-manager" to
 * "bober-server-manager" (done to match the app's actual display name, "Bober Server Manager").
 *
 * `app.getPath('userData')`'s default is `path.join(app.getPath('appData'), app.getName())`,
 * and `app.getName()` reads package.json's own `name` field - so renaming that field alone
 * would silently point every real user's next update at a brand new, empty userData folder
 * (losing every profile, setting, ban list, etc. from their point of view, even though nothing
 * was actually deleted). `app.getPath('appData')` itself (the OS-level base folder, e.g.
 * `%APPDATA%` on Windows) isn't affected by the app's name at all, so pinning `userData` back
 * to the historical folder name here keeps the resolved path identical to what it was before
 * the rename, with no migration needed for anyone already installed.
 *
 * Must be imported before any module that reads `app.getPath('userData')` at import time
 * (store.ts's own `new Store(...)` call, in particular) - which is why this is the very first
 * import in index.ts, not just an early line of code in it.
 */
import { app } from 'electron'
import path from 'node:path'

app.setPath('userData', path.join(app.getPath('appData'), 'ark-server-manager'))
