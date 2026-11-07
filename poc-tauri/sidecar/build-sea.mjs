// Builds dist/sidecar-bin: a standalone executable containing the Node runtime + the bundled
// sidecar, via Node's SEA (Single Executable Applications) feature. Run build.mjs first - this
// reads dist/sidecar.cjs, it doesn't produce it.
//
// Steps are the ones Node's own SEA docs describe, scripted instead of typed by hand each time:
// 1. node --experimental-sea-config writes a V8 code-cache blob from dist/sidecar.cjs
// 2. copy the current `node` binary
// 3. postject injects the blob into that copy under the NODE_SEA_BLOB section/sentinel
//
// Platform notes (see README.md):
// - Linux: works as-is, binary runs standalone with no `node` on PATH.
// - macOS: needs extra codesigning steps (`--macho-segment-name NODE_SEA` + re-signing) that
//   this script does not attempt.
// - Windows: works, but needed `shell: true` on the npx call below to actually find `npx` -
//   see that line's own comment.
//
// Also copies the result into src-tauri/binaries/sidecar-bin-<target-triple>, the exact name
// and location Tauri's `bundle.externalBin` (see tauri.conf.json) requires to treat it as a
// real sidecar resource instead of a path main.rs has to know about by convention.
import { execFileSync } from 'node:child_process'
import { copyFileSync, chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const nodeBin = process.execPath
const outBin = path.join(here, 'dist', 'sidecar-bin')

const rustcHost = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  .split('\n')
  .find((line) => line.startsWith('host:'))
  ?.split(':')[1]
  ?.trim()
if (!rustcHost) throw new Error("could not determine the Rust target triple from `rustc -vV`'s `host:` line")

execFileSync(process.execPath, ['--experimental-sea-config', path.join(here, 'sea-config.json')], {
  cwd: here,
  stdio: 'inherit'
})

copyFileSync(nodeBin, outBin)
chmodSync(outBin, 0o755)

// `shell: true` on Windows only - found by actually running this on a real Windows machine,
// not from Node's docs: `npx` there is `npx.cmd` (a batch file), and execFileSync's default
// direct-exec (no shell) fails with `spawnSync npx ENOENT` even though `npx` works fine typed
// into the same terminal - Windows' CreateProcess doesn't resolve PATHEXT (.cmd/.bat) the way
// a shell does. Routing through `cmd.exe` (what `shell: true` does on Windows) fixes it;
// Linux/macOS already worked without it and are unaffected since this only applies there.
execFileSync(
  'npx',
  [
    '-y',
    'postject@latest',
    outBin,
    'NODE_SEA_BLOB',
    path.join(here, 'dist', 'sea-prep.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  ],
  { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' }
)

const binariesDir = path.join(here, '..', 'src-tauri', 'binaries')
const windows = rustcHost.includes('windows')
const externalBinPath = path.join(binariesDir, `sidecar-bin-${rustcHost}${windows ? '.exe' : ''}`)
mkdirSync(binariesDir, { recursive: true })
copyFileSync(outBin, externalBinPath)
chmodSync(externalBinPath, 0o755)

// Windows Task Manager branding via rcedit was tried and reverted (see MIGRATION-PLAN.md) - the
// npm `rcedit` package hangs indefinitely on GitHub's windows-latest runners (confirmed: CI job
// stuck 1h+ with zero output right after this point, had to be force-cancelled), for reasons not
// worth chasing further for a purely cosmetic Task Manager label. Not reattempting without a
// fundamentally different approach (e.g. a vendored rcedit.exe invoked directly, bypassing the
// npm package's wrapper entirely).

console.log(`sidecar SEA binary -> ${outBin}`)
console.log(`                  -> ${externalBinPath} (Tauri externalBin)`)
