// Bundles each real-page entry file (manager-log-entry.tsx, profile-management-entry.tsx - each
// mounting a REAL, unmodified src/renderer/src/pages/*.tsx component) into its own .js, served
// by Tauri alongside index.html (frontendDist is a whole directory, not a single file, so this
// just adds more pages). Proves real renderer components, not just the business logic
// underneath them, can run against this architecture - see "A real React page" in README.md.
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')

const pages = [
  'manager-log',
  'profile-management',
  'player-roster',
  'player-whitelist',
  'dashboard',
  'analytics',
  'backups',
  'update-log',
  'map-management',
  'server-management',
  'changelog',
  'watched-players',
  'player-activity',
  'player-bans',
  'cluster-data',
  'steamcmd',
  'groupconsole',
  'players',
  'event-scheduler',
  'map-manager'
]

for (const page of pages) {
  await build({
    entryPoints: [path.join(here, `${page}-entry.tsx`)],
    outfile: path.join(here, `${page}.js`),
    bundle: true,
    format: 'esm',
    target: 'es2020',
    jsx: 'automatic',
    // Mirrors tsconfig.web.json's "@shared/*" path alias - esbuild doesn't read tsconfig path
    // mappings on its own (same finding as sidecar/build.mjs's own comment on this).
    alias: { '@shared': path.join(root, 'shared') },
    // Dashboard.tsx is the first real page that imports a binary asset directly (icons/*.png,
    // via its own code and HardwareStatsBar.tsx/lib/gameIcons.ts) - esbuild has no default
    // loader for that (unlike the real app's own Vite build, which handles it transparently),
    // so a plain `esbuild` call fails outright on the first .png import. `dataurl` inlines each
    // icon as a base64 data URI right into this page's own bundled .js - keeps every page a
    // single self-contained file, matching how every other page here is already served, rather
    // than introducing a second kind of build output (loose files) just for this one page.
    loader: { '.png': 'dataurl' },
    logLevel: 'info'
  })
  console.log(`React page bundled -> ${page}.js`)
}
