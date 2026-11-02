/**
 * Mounts the REAL, completely unmodified src/renderer/src/App.tsx - not one more per-page
 * wrapper like every earlier entry in this PoC, but the actual top-level app shell every one of
 * those pages normally lives inside. App.tsx turns out to need no Context providers or router
 * at all (confirmed by reading the real src/renderer/src/main.tsx this mirrors: a plain
 * `ReactDOM.createRoot(...).render(<App />)` inside React.StrictMode, nothing else) - it's a
 * single large component that owns its own page-switching state via plain useState, and calls
 * window.api directly for everything it needs itself (profiles/minecraft profiles lists, map
 * definitions, per-profile install/version checks, startup-complete gating), rendering whichever
 * real already-proven page (Dashboard, ServerDetail and its 8 tabs, ClusterDataView,
 * MinecraftDashboard, MinecraftServerDetail and its 6 tabs, ...) the user has navigated to.
 *
 * This is also the first page in this PoC to load the real app.css (styles.css, copied
 * byte-for-byte as app-styles.css and linked from app.html - see that file) instead of staying
 * deliberately unstyled - every earlier "real page" round proved the logic; this one additionally
 * proves the real layout renders correctly too.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '../../src/renderer/src/App'
import { installWindowApi } from './lib/windowApi'

installWindowApi()

const container = document.getElementById('root')
if (!container) throw new Error('Root element not found')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
