// Builds sidecar/bot/bot-bin: the bot (sidecar/bot/index.js, from build-bot.mjs) packaged as
// its own standalone Node SEA executable, exactly like build-sea.mjs does for the main sidecar.
// This exists to validate the fix for the real bug documented in README.md's "The Discord bot
// subsystem": fork()-based spawning silently can't launch a different script from inside a SEA
// binary (it just relaunches the SEA binary's own embedded entry point). Shipping the bot as
// ITS OWN separate SEA binary, spawned by explicit path via discordBot.ts's new
// BOT_LAUNCH_COMMAND override instead of fork()'s implicit process.execPath re-exec, is one of
// the two fixes that README section named as unexplored - this validates it actually works.
//
// Also copies the result into src-tauri/binaries/bot-bin-<target-triple>, the same
// bundle.externalBin convention build-sea.mjs already uses for the main sidecar - so
// `cargo build`/`cargo tauri build` place a resolvable `bot-bin` next to the compiled shell in
// both dev mode and a real installed bundle, not just in this source tree.
import { execFileSync } from 'node:child_process'
import { copyFileSync, chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const nodeBin = process.execPath
const botJs = path.join(here, 'bot', 'index.js')
const outBin = path.join(here, 'bot', 'bot-bin')
const seaConfigPath = path.join(here, 'bot', 'sea-config.json')
const seaBlobPath = path.join(here, 'bot', 'sea-prep.blob')

const rustcHost = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  .split('\n')
  .find((line) => line.startsWith('host:'))
  ?.split(':')[1]
  ?.trim()
if (!rustcHost) throw new Error("could not determine the Rust target triple from `rustc -vV`'s `host:` line")

await import('node:fs').then((fs) =>
  fs.writeFileSync(
    seaConfigPath,
    JSON.stringify({ main: botJs, output: seaBlobPath, disableExperimentalSEAWarning: true })
  )
)

execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { cwd: here, stdio: 'inherit' })

copyFileSync(nodeBin, outBin)
chmodSync(outBin, 0o755)

// shell: true on Windows only - see build-sea.mjs's own comment on this exact line: `npx` is
// a .cmd there, and execFileSync's default direct-exec can't resolve it (spawnSync npx ENOENT).
execFileSync(
  'npx',
  ['-y', 'postject@latest', outBin, 'NODE_SEA_BLOB', seaBlobPath, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
  { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' }
)

const binariesDir = path.join(here, '..', 'src-tauri', 'binaries')
const windows = rustcHost.includes('windows')
const externalBinPath = path.join(binariesDir, `bot-bin-${rustcHost}${windows ? '.exe' : ''}`)
mkdirSync(binariesDir, { recursive: true })
copyFileSync(outBin, externalBinPath)
chmodSync(externalBinPath, 0o755)

// Windows Task Manager branding via rcedit was tried and reverted - see build-sea.mjs's identical
// comment for why (the npm package hangs indefinitely on GitHub's windows-latest runners).

console.log(`bot SEA binary -> ${outBin}`)
console.log(`              -> ${externalBinPath} (Tauri externalBin)`)
