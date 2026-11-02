import { spawn, exec, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { platform } from 'node:process'
import { promisify } from 'node:util'
import type { ServerMod, ServerProfile, ServerStatus } from '@shared/types'
import { getGameDefinition } from '@shared/games'
import { sendRconCommand } from './rcon'
import { readAdminPassword } from './config'
import { setRunningPid, setRunningStartedAt, getSettings } from '../store'
import { delay } from './delay'
import { logManagerEvent, newTaskId } from './managerLog'

const execAsync = promisify(exec)

/** How long to wait after RCON confirms SaveWorld before sending DoExit - the RCON
 *  response only means ARK accepted the command, not that every file under SavedArks has
 *  finished being written. Sending DoExit (or killing the process) too soon risks the
 *  server exiting mid-write, corrupting the save it just claimed to have finished. Same
 *  margin (and same reasoning) as the settle delay before zipping a backup. */
const SAVE_SETTLE_MS = 30_000

/** ARK writes this once the world has actually finished loading and is ready for players. */
const STARTUP_COMPLETE_MARKER = 'Server has completed startup and is now advertising for join'
/** Safety net in case that log line's wording ever changes and the marker stops matching. */
const STARTUP_FALLBACK_MS = 5 * 60 * 1000

/** Extra time waitForExitOrKill gives a force-kill signal to actually take effect, on top of
 *  the graceMs it already waited for a graceful exit - see that function's own doc comment
 *  for why this matters. */
const FORCE_KILL_CONFIRM_MS = 10_000

export function getLogFilePath(installDir: string): string {
  return path.join(installDir, 'ShooterGame', 'Saved', 'Logs', 'ShooterGame.log')
}

/**
 * Given the file size we last saw and the current one, returns the byte
 * offset new content should be read from, or null if there's nothing new.
 * A size decrease means the log was rotated/truncated (Unreal starts a
 * fresh log per server session) - in that case we start over from 0 rather
 * than treating the whole new file as "old".
 */
export function computeTailReadStart(previousSize: number, currentSize: number): number | null {
  if (currentSize === previousSize) return null
  if (currentSize < previousSize) return 0
  return previousSize
}

/**
 * Polls the server's own log file, calling onChunk with each newly-written slice of
 * content. We watch the log file rather than the process's stdout because ARK's
 * dedicated server on Windows allocates its own console rather than writing through the
 * standard stdout handle, so piping stdio never sees anything. Content already in the
 * file before watching started is never passed to onChunk, so leftover lines from a
 * previous session can't cause a false match immediately on start. Returns a function
 * that stops watching.
 */
export function watchLogFile(
  installDir: string,
  onChunk: (chunk: string, rotated: boolean) => void,
  intervalMs = 2000
): () => void {
  const logPath = getLogFilePath(installDir)
  let previousSize: number | null = null
  let previousIno: number | null = null
  let stopped = false

  const interval = setInterval(() => {
    fs.stat(logPath, (statErr, stats) => {
      if (stopped || statErr) return

      if (previousSize === null) {
        previousSize = stats.size
        previousIno = stats.ino
        return
      }

      // A changed inode means the file itself was recreated (ARK starts a fresh log per
      // server session), so always re-read from the start in that case - relying on size
      // alone would miss a restart where the new session already writes past the old
      // file's size before our next poll, leaving the tailer reading from a stale offset
      // in the new file and never surfacing anything from it.
      const rotated = stats.ino !== previousIno
      const readStart = rotated ? 0 : computeTailReadStart(previousSize, stats.size)
      previousIno = stats.ino
      if (readStart === null) {
        previousSize = stats.size
        return
      }
      previousSize = stats.size

      const stream = fs.createReadStream(logPath, { start: readStart, encoding: 'utf-8' })
      let chunk = ''
      stream.on('data', (data) => {
        chunk += data
      })
      stream.on('error', () => {})
      stream.on('end', () => {
        if (!stopped) onChunk(chunk, rotated)
      })
    })
  }, intervalMs)

  return () => {
    stopped = true
    clearInterval(interval)
  }
}

/** Watches for `marker` to appear, firing onReady (at most once) the first time it does.
 *  `since` (epoch ms) is the moment this particular start was requested - see below. */
export function watchLogFileForMarker(
  installDir: string,
  marker: string,
  onReady: () => void,
  since: number,
  intervalMs = 2000
): () => void {
  let fired = false
  const fireOnce = (): void => {
    if (fired) return
    fired = true
    onReady()
  }

  // Also checks the log's current full content once, immediately - not just content written
  // after this starts watching. watchLogFile's own "baseline on the first poll tick, only diff
  // after that" design exists so re-opening an already-running server's Console tab doesn't
  // re-match stale lines from a previous session (see its own doc comment, and
  // startupLogWatch.test.ts's "does not fire on content already in the file" case, which this
  // must keep passing) - but it has a real gap for this specific caller: if the whole startup
  // log, marker line included, gets written before the very first poll tick ever runs - more
  // likely here than it sounds, since this is called after an extra IPC round trip (invoke ->
  // sidecar) that doesn't exist in a direct same-process call - that content is never "new"
  // relative to the diff-based watcher's baseline, so it's never seen.
  //
  // Only trusted if the log file's own mtime is at or after `since`: that's what actually
  // distinguishes "this session already wrote the marker before we got here" from "that's a
  // stale marker left over from the previous session, ARK just hasn't rotated/truncated the
  // file yet" - content alone can't tell the two apart, but a restart's very next log write
  // can only land at or after the moment this restart was requested.
  fs.stat(getLogFilePath(installDir), (statErr, stats) => {
    if (statErr || stats.mtimeMs < since) return
    fs.readFile(getLogFilePath(installDir), 'utf-8', (readErr, content) => {
      if (!readErr && content.includes(marker)) fireOnce()
    })
  })

  return watchLogFile(
    installDir,
    (chunk) => {
      if (chunk.includes(marker)) fireOnce()
    },
    intervalMs
  )
}

interface RunningServer {
  /** Null for a server adopted from a previous app run - we have its pid but no live handle.
   *  Also null (with `pid` a 0 placeholder) while queued for a staggered spawn - see
   *  `cancelQueuedSpawn` below. */
  process: ChildProcess | null
  pid: number
  status: ServerStatus
  /** False once the process we actually spawned has exited but RCON confirmed the server
   *  itself is still up (see handleUnexpectedExit) - `pid` is stale past that point, so
   *  monitor.ts falls back to an RCON-only liveness/player-list check instead of pidusage. */
  pidTracked: boolean
  /** Set only while this entry is queued for a staggered spawn (see reserveSpawnSlot) and
   *  hasn't actually spawned an OS process yet - cancels the pending setTimeout so a Stop/
   *  Kill requested during that window stops it outright instead of racing the queued spawn.
   *  Cleared (entry replaced) the moment the real process actually spawns. */
  cancelQueuedSpawn?: () => void
}

const running = new Map<string, RunningServer>()

/**
 * Global (not per-profile) spawn queue - ensures the actual OS-level process spawn for any
 * two ARK servers is at least `serverAutoStartStaggerSeconds` apart, regardless of what
 * triggered them: a manual Start/Restart click, the Dashboard's bulk Start All/Restart All,
 * a scheduled restart, or a crash-watch/zombie-detection auto-restart. ARK's own world-
 * loading is heavy enough (much of it single-threaded) that several spawning in the same
 * instant can starve each other out badly enough that some never actually finish loading - a
 * real report showed restarting several servers manually resulting in only 1-2 of them
 * actually coming back up. Reuses the same setting already used to stagger "start on Manager
 * launch" (autoStart.ts) rather than a second one, since it's the same underlying concern -
 * autoStart.ts's own staggering keeps working unchanged on top of this; the two don't double
 * up in practice since autoStart's own pacing already satisfies this queue's requirement by
 * the time each of its calls actually reaches startServer.
 */
let nextSpawnSlotAt = 0

/** `now` is passed in (rather than this function calling Date.now() itself) so it shares the
 *  exact same timestamp the caller already captured as the request's own `startedAt` - two
 *  separate Date.now() calls can land a millisecond apart, which was enough to make a fresh
 *  (unstaggered) call see `slot > now` and wait a stray ~1ms it should never have needed to,
 *  taking the queued-spawn code path instead of spawning immediately. */
function reserveSpawnSlot(now: number): number {
  const staggerMs = Math.max(0, getSettings().serverAutoStartStaggerSeconds) * 1000
  const slot = Math.max(now, nextSpawnSlotAt)
  nextSpawnSlotAt = slot + staggerMs
  return slot
}

/** Resets the spawn queue's internal clock - exported only for tests, so one test's queued
 *  stagger delay can't leak into the next test in the same file (module state otherwise
 *  persists across `it()` blocks within a file). Mirrors statsHistory.ts's own
 *  `__resetStatsHistoryCacheForTests`. */
export function __resetServerSpawnQueueForTests(): void {
  nextSpawnSlotAt = 0
}

export const serverEvents = new EventEmitter()
// Deliberately shared by many independent, permanent features (crashWatch, iniLock,
// serverVersionWatcher, playerJoinAlertWatch, playerActivityWatch, zombieDetection,
// playerBackupWatch, the backup schedule, the IPC status broadcast...) each adding their own
// 'status' listener once at startup, plus short-lived per-connection ones (web dashboard SSE
// clients, the group console). That easily clears Node's conservative default of 10 and logs
// a "possible EventEmitter memory leak" warning that isn't one - every permanent listener is
// added exactly once, not accumulated, so the real count stays flat over time; this just
// raises the threshold so the warning doesn't needlessly show up in a real user's logs.
serverEvents.setMaxListeners(30)

/** Persists a status update (so a later getStatus() call sees it too, not just whoever's
 *  listening for the 'status' event right now) and broadcasts it. */
export function emitStatus(status: ServerStatus): void {
  const entry = running.get(status.profileId)
  if (entry) entry.status = status
  serverEvents.emit('status', status)
}

/** Whether a running profile's pid is still trustworthy for OS-level checks (pidusage,
 *  force-kill) - false after handleUnexpectedExit decided a process hand-off happened
 *  rather than a real stop. Unknown/not-running profiles report true (nothing to distrust). */
export function isPidTracked(profileId: string): boolean {
  return running.get(profileId)?.pidTracked ?? true
}

function finalizeStopped(profileId: string): void {
  running.delete(profileId)
  setRunningPid(profileId, null)
  setRunningStartedAt(profileId, null)
  emitStatus({ profileId, state: 'stopped' })
}

/** True if a process with this pid currently exists (works for any pid, not just our own children). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killByPid(pid: number): void {
  try {
    process.kill(pid)
  } catch {
    // Already gone - nothing to do.
  }
}

/** Finds the pid of whichever process currently holds a TCP port in LISTENING state, via
 *  `netstat` - Windows only (the only platform this app ships a build for). Returns null
 *  on any other platform, or if netstat's output can't be parsed/doesn't have a match, so
 *  callers can fall back gracefully instead of throwing. */
export async function findListeningPid(port: number): Promise<number | null> {
  if (platform !== 'win32') return null
  try {
    const { stdout } = await execAsync('netstat -ano -p TCP')
    const suffix = `:${port}`
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5) continue
      const [proto, local, foreign, , pid] = parts
      if (proto !== 'TCP' || !local.endsWith(suffix)) continue
      // A listening socket's foreign address is always the "nobody yet" placeholder
      // (0.0.0.0:0 / [::]:0) - checking that instead of the State column keeps this
      // locale-independent, since Windows localizes State text (e.g. "LISTENING" becomes
      // "ÉCOUTE" on a French install) but never the IP literal.
      if (!/^(0\.0\.0\.0|\[::\]):0$/.test(foreign)) continue
      const parsedPid = Number(pid)
      if (Number.isFinite(parsedPid) && parsedPid > 0) return parsedPid
    }
    return null
  } catch {
    return null
  }
}

/** Tries a harmless RCON round-trip a few times, spaced out, to confirm the server is
 *  genuinely still reachable - a couple of retries rather than one shot, since a process
 *  hand-off (see handleUnexpectedExit) can leave RCON briefly unreachable for a moment
 *  right as the new process takes over. */
export async function confirmAliveViaRcon(profile: ServerProfile, attempts = 3, delayMs = 2000): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await delay(delayMs)
    const result = await sendRconCommand(profile, 'ListPlayers')
    if (result.ok) return true
  }
  return false
}

/**
 * The process we actually spawned exited, but nothing asked it to - on some recent ARK
 * builds, the dedicated server hands off to a new underlying process shortly after
 * finishing startup (the game itself keeps running, just no longer under the pid we
 * originally tracked), and Node correctly reports that hand-off as our child exiting. A
 * lost child process isn't by itself proof the server actually stopped, so before believing
 * it, ask the server directly over RCON - the one channel that doesn't care which OS
 * process is actually serving it. If RCON still answers, keep the entry as running but stop
 * trusting `pid` for OS-level checks (CPU/RAM monitoring, force-kill) until it either comes
 * back later or genuinely goes offline. If RCON doesn't answer either, this was a real,
 * unexpected stop (a crash) - finalize it as stopped like before.
 */
export async function handleUnexpectedExit(profile: ServerProfile): Promise<void> {
  const entry = running.get(profile.id)
  if (!entry) return

  const stillAlive = await confirmAliveViaRcon(profile)
  const current = running.get(profile.id)
  if (!current) return // stopped/restarted for real while we were checking

  if (stillAlive) {
    // RCON only answers if some process is holding that port, so whichever pid netstat
    // reports for it is unambiguously the new process - re-attach full pid-based
    // monitoring (CPU/RAM, force-kill) to it rather than settling for the degraded,
    // RCON-only fallback.
    const newPid = await findListeningPid(profile.rconPort)
    if (newPid && isPidAlive(newPid)) {
      console.warn(
        `${profile.name}: its process exited unexpectedly but RCON still responds - re-attached to the new process (pid ${newPid}) that took over.`
      )
      current.process = null
      current.pid = newPid
      current.pidTracked = true
      current.status = { ...current.status, pid: newPid }
      setRunningPid(profile.id, newPid)
      emitStatus(current.status)
      return
    }

    console.warn(
      `${profile.name}: its process exited unexpectedly but RCON still responds - assuming a hand-off to a new process and continuing to monitor it without pid tracking.`
    )
    current.process = null
    current.pidTracked = false
    return
  }

  finalizeStopped(profile.id)
}

const updatingProfiles = new Set<string>()

/** Marks a profile as being updated via SteamCMD (or not), pushing the new status to listeners. */
export function setUpdating(profileId: string, value: boolean): void {
  if (value) updatingProfiles.add(profileId)
  else updatingProfiles.delete(profileId)
  emitStatus(getStatus(profileId))
}

export function isUpdating(profileId: string): boolean {
  return updatingProfiles.has(profileId)
}

export function getExecutablePath(profile: ServerProfile): string {
  const def = getGameDefinition(profile.game)
  const relPath = platform === 'win32' ? def.executableWin : def.executableLinux
  return path.join(profile.installDir, ...relPath.split('/'))
}

/**
 * Builds the ARK launch command line: `<Map>?param=value?param=value -flag -flag=value`.
 * Shared across ARK: Survival Ascended and ARK: Survival Evolved (ASE predates ASA and most
 * of this flag surface carries over unchanged), except where marked otherwise below.
 * Exact flags can drift between game updates - `extraArgs` on the profile is the
 * escape hatch for anything not covered here.
 */
export function buildLaunchArgs(profile: ServerProfile, adminPasswordOverride?: string): string[] {
  const isEvolved = profile.game === 'ark-evolved'
  const adminPassword = adminPasswordOverride ?? readAdminPassword(profile.installDir)

  let args: string[]

  if (isEvolved) {
    // Every detail here - the exact ?-string param order and the exact flag order below -
    // is copied from a real, working ShooterGameServer.exe command line, confirmed the hard
    // way: reordering these (e.g. putting -servergamelog right after the map string instead
    // of after -NoBattlEye/-ForceRespawnDinos, like the ARK: Survival Ascended shape used to)
    // reproducibly caused a blocking "Plugin 'RuntimeMeshComponent' failed to load" dialog on
    // launch. Why order would matter for a plugin load isn't obvious, but the fix is
    // empirically confirmed, so it's kept exact here rather than normalized.
    const params = [
      `Port=${profile.gamePort}`,
      `QueryPort=${profile.queryPort}`,
      `RCONPort=${profile.rconPort}`,
      'RCONEnabled=True',
      `MaxPlayers=${profile.maxPlayers}`
    ]
    if (adminPassword) params.push(`ServerAdminPassword=${adminPassword}`)
    // ServerPassword= is mandatory for ARK: Survival Evolved - always emitted, even blank (a
    // blank value means no join password required, a valid, common setting). SessionName= is
    // deliberately not passed here - GameUserSettings.ini's SessionSettings.SessionName
    // already covers it (same as ARK: Survival Ascended), so the launch-arg duplicate was
    // unnecessary.
    params.push(`ServerPassword=${profile.serverPassword}`)

    args = [`${profile.map}?${params.join('?')}`]
    if (profile.disableBattlEye) args.push('-NoBattlEye')
    if (profile.forceRespawnDinos) args.push('-ForceRespawnDinos')
    args.push('-servergamelog')
    // -log: originally left out here on the assumption -servergamelog alone was enough to
    // get a useful ShooterGame.log (the file the Manager's Console/version-detection read) -
    // a real report showed the Manager's live console and version display staying empty for
    // ARK: Survival Evolved even though the server itself ran fine, which -servergamelog
    // alone apparently doesn't fix (it's the separate dated ServerGame.<date>.txt tribe-log
    // feature, not the engine's own log). Added back after that report, right after
    // -servergamelog rather than up near -server/-log's usual ARK: Survival Ascended spot -
    // the position empirically confirmed to matter (see the comment above) is
    // -servergamelog's, relative to -NoBattlEye/-ForceRespawnDinos, not this one's.
    args.push('-log')
    if (profile.rconTribeLog) args.push('-servergamelogincludetribelogs', '-ServerRCONOutputTribeLogs')
    // Tells the server to download/update its own workshop mods (from ActiveMods=, written
    // to GameUserSettings.ini by gameConfigWrite.ts) instead of relying on them being
    // pre-installed. ARK: Survival Evolved only - has no equivalent on ARK: Survival Ascended.
    if (profile.autoManageMods) args.push('-automanagedmods')
  } else {
    const params = ['listen', `Port=${profile.gamePort}`, 'RCONEnabled=True', `RCONPort=${profile.rconPort}`]
    if (adminPassword) params.push(`ServerAdminPassword=${adminPassword}`)

    args = [
      `${profile.map}?${params.join('?')}`,
      '-server',
      '-log',
      `-ServerPlatform=${profile.serverPlatform}`,
      `-WinLiveMaxPlayers=${profile.maxPlayers}`
    ]
  }

  // ARK: Survival Evolved has no command-line mechanism for mods at all (confirmed - not
  // just unconfirmed support) - its mods are instead written to GameUserSettings.ini/Game.ini
  // by gameConfigWrite.ts whenever the Mods tab saves (see ipc/mods.ts), so nothing belongs
  // on its command line here.
  if (!isEvolved) {
    const enabledMods = profile.mods.filter((mod) => mod.enabled)
    const formatModId = (mod: ServerMod): string => (mod.dev ? `${mod.id}-dev` : mod.id)
    const activeModIds = enabledMods.filter((mod) => !mod.passive).map(formatModId)
    if (activeModIds.length > 0) {
      args.push(`-mods=${activeModIds.join(',')}`)
    }
    const passiveModIds = enabledMods.filter((mod) => mod.passive).map(formatModId)
    if (passiveModIds.length > 0) args.push(`-passivemods=${passiveModIds.join(',')}`)
  }

  if (profile.clusterEnabled) {
    if (profile.clusterId.trim()) args.push(`-clusterid=${profile.clusterId.trim()}`)
    if (profile.clusterDirOverride.trim()) args.push(`-ClusterDirOverride=${profile.clusterDirOverride.trim()}`)
    if (profile.noTransferFromFiltering) args.push('-NoTransferFromFiltering')
    if (profile.externalIp.trim()) args.push(`-ServerIP=${profile.externalIp.trim()}`)
  }

  if (profile.cultureSettings !== 'none') args.push(`-culture=${profile.cultureSettings}`)
  // Already pushed above, in the exact confirmed position, for ARK: Survival Evolved.
  if (!isEvolved) {
    if (profile.disableBattlEye) args.push('-NoBattlEye')
    if (profile.rconTribeLog) args.push('-servergamelogincludetribelogs', '-ServerRCONOutputTribeLogs')
    if (profile.forceRespawnDinos) args.push('-ForceRespawnDinos')
  }
  if (profile.noSound) args.push('-nosound')
  // -DestroyTamesOverLevel= is an ARK: Survival Ascended addition with unconfirmed ARK:
  // Survival Evolved support - never emitted for it (see shared/games.ts). Falls back to ''
  // for a profile saved before this field existed and read some way that bypasses store.ts's
  // own migrateProfile backfill (e.g. a test fixture) - never throws.
  if (profile.game === 'ark-ascended' && (profile.maxDinoLevel ?? '').trim()) {
    args.push(`-DestroyTamesOverLevel=${profile.maxDinoLevel.trim()}`)
  }
  if (profile.moddedMapEnabled && profile.moddedMapId.trim()) args.push(`-MapModID=${profile.moddedMapId.trim()}`)

  if (profile.extraArgs.trim()) {
    args.push(...profile.extraArgs.trim().split(/\s+/))
  }
  // extraArgs is free text the user maintains themselves - a flag added there before the
  // Manager natively supported it (e.g. -servergamelog, -nosound, -NoBattlEye) would otherwise
  // end up on the command line twice once the Manager starts emitting it too. Keeping only the
  // first occurrence of each exact token (the map string at index 0 is always kept, since it's
  // never a duplicate of anything else) is a no-op for a profile whose extraArgs doesn't
  // overlap with the rest, and silently fixes it for one that does.
  const seen = new Set<string>()
  return args.filter((arg, index) => {
    if (index === 0 || !seen.has(arg)) {
      seen.add(arg)
      return true
    }
    return false
  })
}

export function getStatus(profileId: string): ServerStatus {
  if (updatingProfiles.has(profileId)) {
    return { profileId, state: 'updating' }
  }
  return running.get(profileId)?.status ?? { profileId, state: 'stopped' }
}

export function isRunning(profileId: string): boolean {
  return running.has(profileId)
}

/** Marks a still-alive pid from a previous app run as running again, so this session can manage it. */
export function markProcessExited(profileId: string): void {
  finalizeStopped(profileId)
}

/**
 * On app startup, re-attach to servers that are still running from a previous
 * session (the process itself survives a Manager crash/close - see startServer).
 * Without this, a relaunched app would "forget" about them and let the user
 * start a second instance on the same ports.
 */
export function adoptPersistedProcesses(
  profiles: ServerProfile[],
  persistedPids: Record<string, number>,
  persistedStartedAt: Record<string, number> = {}
): void {
  for (const profile of profiles) {
    const pid = persistedPids[profile.id]
    if (pid === undefined) continue

    if (isPidAlive(pid)) {
      const status: ServerStatus = {
        profileId: profile.id,
        state: 'running',
        pid,
        ...(persistedStartedAt[profile.id] !== undefined ? { startedAt: persistedStartedAt[profile.id] } : {})
      }
      running.set(profile.id, { process: null, pid, status, pidTracked: true })
      // Broadcasts the same way a fresh start does, so anything listening for a
      // running-transition (e.g. serverVersionWatcher.ts) treats an adopted server the
      // same as one this session actually started - no renderer window exists yet to
      // receive it at this point in app startup, so this is purely for other main-process
      // listeners registered before this runs.
      emitStatus(status)
    } else {
      setRunningPid(profile.id, null)
      setRunningStartedAt(profile.id, null)
    }
  }
}

/**
 * Writes a temporary launch script for `profile` and returns its path. Every established
 * ARK: Survival Evolved server manager launches through a .bat rather than calling
 * ShooterGameServer.exe directly - its command-line parsing is a much older, less rigorous
 * UE4 codebase than ARK: Survival Ascended's, and going through cmd.exe (with the raw,
 * unquoted command line exactly as a person would type it) is the confirmed-working way to
 * reach it, rather than relying on getting Node's own Windows argument quoting to line up
 * with what it expects. Regenerated fresh on every start, at a stable per-profile path under
 * the OS temp dir so it's easy to find and inspect without touching the install directory.
 */
function writeLaunchBatchFile(profile: ServerProfile, exe: string, args: string[]): string {
  const batPath = path.join(os.tmpdir(), `ark-manager-launch-${profile.id}.bat`)
  const commandLine = [path.basename(exe), ...args].join(' ')
  fs.writeFileSync(batPath, `@echo off\r\ncd /d "${path.dirname(exe)}"\r\n${commandLine}\r\n`, 'utf-8')
  return batPath
}

/**
 * A .bat-launched server's `child.pid` (see writeLaunchBatchFile) is cmd.exe's own pid, not
 * ShooterGameServer.exe's - cmd.exe stays alive as its parent for as long as the batch script
 * runs. Polls for whichever process actually holds `port` (the same `findListeningPid`
 * technique handleUnexpectedExit already uses for a hand-off) and switches this profile's
 * tracked pid to it once found, nulling out `process` too so killServer/waitForExitOrKill fall
 * through to killing that real pid directly instead of the now-irrelevant cmd.exe wrapper -
 * exactly the same re-attach shape handleUnexpectedExit uses. Until this fires, CPU/RAM
 * monitoring is unavailable (pidTracked stays false) rather than misleadingly reporting
 * cmd.exe's own near-zero usage. Stops on its own once handed off, or once the profile is no
 * longer running under the wrapper pid it started with.
 */
/** Self-rescheduling (setTimeout, not setInterval) - the next poll is only scheduled once
 *  the current one's findListeningPid call has actually settled, so there is never more than
 *  one in flight. See minecraftProcess.ts's watchForScriptPidHandoff for the full reasoning
 *  (same bug, same fix, same real report): findListeningPid spawns a netstat.exe process
 *  every call, and a plain setInterval used to fire a new one every intervalMs regardless of
 *  whether the previous spawn had finished - once a single spawn ran slow, the next interval
 *  piled another one on top instead of waiting, compounding into a long freeze. */
function watchForBatchPidHandoff(profileId: string, port: number, wrapperPid: number, intervalMs = 2000): () => void {
  const taskId = newTaskId('batch-pid-handoff')
  const taskLabel = 'ARK: Survival Evolved pid handoff'
  logManagerEvent(
    taskId,
    taskLabel,
    `Launched via cmd.exe (wrapper pid ${wrapperPid}) - waiting to find the real server process listening on port ${port}.`
  )

  let stopped = false
  let attempts = 0
  let timer: NodeJS.Timeout

  const poll = (): void => {
    void (async () => {
      const entry = running.get(profileId)
      if (!entry || entry.pid !== wrapperPid) {
        stopped = true
        return
      }
      attempts += 1
      const realPid = await findListeningPid(port)
      if (stopped) return
      // Logged even when nothing/the wrapper's own pid came back - the exact value (or lack
      // of one) is the whole point of this diagnostic, added after a real report of the
      // hand-off silently never completing with no way to tell why. Capped to the first 10
      // attempts (20s) so a persistently-failing hand-off can't flood the log for as long as
      // the server stays up.
      if (attempts <= 10) {
        logManagerEvent(
          taskId,
          taskLabel,
          `Attempt ${attempts}: findListeningPid(${port}) returned ${realPid ?? 'null'}${
            realPid === wrapperPid ? ' (still just the wrapper)' : ''
          }.`
        )
      }
      if (realPid && realPid !== wrapperPid) {
        const alive = isPidAlive(realPid)
        if (!alive) {
          logManagerEvent(taskId, taskLabel, `pid ${realPid} found listening but isPidAlive() says it's gone already - skipping.`, 'error')
        } else {
          entry.process = null
          entry.pid = realPid
          entry.pidTracked = true
          entry.status = { ...entry.status, pid: realPid }
          setRunningPid(profileId, realPid)
          emitStatus(entry.status)
          logManagerEvent(taskId, taskLabel, `Found it - now tracking pid ${realPid} instead of the launch wrapper (pid ${wrapperPid}).`)
          stopped = true
          return
        }
      }
      // A real report showed this taking well past 20s for a real ARK: Survival Evolved
      // world to finish opening its RCON port (30-90s+ isn't unusual) - logging per-attempt
      // detail only for the first 20s (above) but then going completely silent made it look
      // like this had given up, when it was actually still retrying (unbounded) the whole
      // time and eventually succeeded. A periodic reminder (every 15 attempts, ~30s) that
      // it's still trying - never a final "gave up" message, since it never does - avoids
      // that false impression without flooding the log the way per-attempt logging would
      // over a long wait.
      if (attempts * intervalMs >= 20000 && attempts % 15 === 0) {
        logManagerEvent(
          taskId,
          taskLabel,
          `Still haven't found a process listening on port ${port} after ${Math.round((attempts * intervalMs) / 1000)}s - ` +
            'CPU/RAM monitoring stays unavailable until it does, but still retrying every 2s in the background (no timeout).'
        )
      }
      if (!stopped) timer = setTimeout(poll, intervalMs)
    })()
  }
  timer = setTimeout(poll, intervalMs)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

export function startServer(profile: ServerProfile): ServerStatus {
  if (running.has(profile.id)) {
    return running.get(profile.id)!.status
  }

  const startedAt = Date.now()
  const waitMs = Math.max(0, reserveSpawnSlot(startedAt) - startedAt)

  if (waitMs <= 0) {
    emitStatus({ profileId: profile.id, state: 'starting', startedAt })
    return doSpawn(profile, startedAt)
  }

  // Staggered: reserve this profile's slot in `running` right away, with a placeholder pid,
  // so a Stop/Kill requested during the wait can cancel it outright (see
  // stopServerPhased/killServer's own cancelQueuedSpawn check) instead of racing the queued
  // spawn, and so getStatus() reports 'starting' consistently during the wait rather than
  // falling back to 'stopped' just because nothing's in `running` yet.
  const queuedStatus: ServerStatus = { profileId: profile.id, state: 'starting', startedAt }
  const timer = setTimeout(() => doSpawn(profile, startedAt), waitMs)
  running.set(profile.id, {
    process: null,
    pid: 0,
    status: queuedStatus,
    pidTracked: true,
    cancelQueuedSpawn: () => clearTimeout(timer)
  })
  emitStatus(queuedStatus)
  return queuedStatus
}

/** The actual OS-level spawn - called either immediately from startServer (its reserved
 *  slot was already free) or from the setTimeout above once a staggered slot arrives.
 *  `startedAt` is always when the start was originally requested, not when this function
 *  itself runs, so a staggered server's displayed uptime reflects "asked to start at", not
 *  "the queue let it through at". */
function doSpawn(profile: ServerProfile, startedAt: number): ServerStatus {
  const exe = getExecutablePath(profile)
  const args = buildLaunchArgs(profile)

  // ARK: Survival Evolved goes through a .bat/cmd.exe, like every established ARK: Survival
  // Evolved server manager does - see writeLaunchBatchFile. ARK: Survival Ascended keeps the
  // direct spawn, unaffected. Windows-only (a .bat is a Windows concept), matching the only
  // platform this app ships a build for; falls back to the direct spawn elsewhere (e.g. Linux
  // test/dev runs of this codebase).
  const launchViaBatch = profile.game === 'ark-evolved' && platform === 'win32'

  // Both games allocate their own console window the moment their exe is spawned (or, for
  // ARK: Survival Evolved, the moment cmd.exe spawns it from within the .bat) - there's no
  // launch flag that suppresses it and no way to resize its font from here, so the "General"
  // Manager settings toggle instead controls Node's own windowsHide, which stops Windows
  // from ever creating that window in the first place. No-op on non-Windows.
  const windowsHide = !getSettings().showServerConsoleWindow

  let child: ChildProcess
  try {
    // stdio: 'ignore' - ARK's dedicated server allocates its own console on
    // Windows rather than writing through the standard stdout handle, so
    // piping it never sees anything; the startup-complete marker is instead
    // read from the server's own log file (see watchLogFileForMarker).
    // detached + unref - the server must keep running even if this Manager
    // crashes or is closed; without detaching, Windows ties child processes to
    // the parent's job object and kills them the moment the parent dies.
    // cwd: the executable's own directory (Win64/Linux), not the install root - every
    // community-standard ARK launch script `cd`s into that folder before running the exe
    // (a manually confirmed working ARK: Survival Evolved launch, for instance, was run from
    // its own Win64 folder), and this keeps the Manager's spawn matching that exactly rather
    // than leaving a working-directory mismatch as one more unverified difference.
    if (launchViaBatch) {
      const batPath = writeLaunchBatchFile(profile, exe, args)
      child = spawn('cmd.exe', ['/d', '/c', batPath], { cwd: path.dirname(exe), stdio: 'ignore', detached: true, windowsHide })
    } else {
      // windowsVerbatimArguments: true - Node's default Windows quoting wraps a space-
      // containing argument in double quotes, the normally-correct thing to do for a
      // well-behaved argv parser. Harmless no-op here (ARK: Survival Ascended's arguments
      // never contain a bare space) and ignored on non-Windows platforms; kept for parity in
      // case that ever changes.
      child = spawn(exe, args, {
        cwd: path.dirname(exe),
        stdio: 'ignore',
        detached: true,
        windowsVerbatimArguments: true,
        windowsHide
      })
    }
    child.unref()
  } catch (err) {
    running.delete(profile.id) // clears a queued placeholder entry too, if this came from one
    const failed: ServerStatus = { profileId: profile.id, state: 'error', lastError: (err as Error).message }
    emitStatus(failed)
    return failed
  }

  const pid = child.pid
  if (!pid) {
    running.delete(profile.id)
    const failed: ServerStatus = { profileId: profile.id, state: 'error', lastError: 'Process started without a pid.' }
    emitStatus(failed)
    return failed
  }

  // Still "starting" here - the OS process exists, but ARK itself hasn't
  // finished loading the world yet. We only flip to "running" once we see
  // the startup-complete marker (or the fallback timeout below fires).
  const status: ServerStatus = {
    profileId: profile.id,
    state: 'starting',
    pid,
    startedAt
  }
  // launchViaBatch: `pid` is cmd.exe's own pid, not the real ShooterGameServer.exe's - not
  // trustworthy for OS-level checks (CPU/RAM, force-kill) until watchForBatchPidHandoff below
  // finds the real one.
  running.set(profile.id, { process: child, pid, status, pidTracked: !launchViaBatch })
  setRunningPid(profile.id, pid)
  setRunningStartedAt(profile.id, startedAt)
  emitStatus(status)

  const fallback = setTimeout(() => markReady(), STARTUP_FALLBACK_MS)
  const stopWatchingLog = watchLogFileForMarker(profile.installDir, STARTUP_COMPLETE_MARKER, () => markReady(), startedAt)
  const stopBatchPidHandoff = launchViaBatch ? watchForBatchPidHandoff(profile.id, profile.rconPort, pid) : () => {}

  function markReady(): void {
    clearTimeout(fallback)
    stopWatchingLog()
    const entry = running.get(profile.id)
    if (entry && entry.status.state === 'starting') {
      emitStatus({ ...entry.status, state: 'running' })
    }
  }

  child.on('exit', () => {
    clearTimeout(fallback)
    stopWatchingLog()
    stopBatchPidHandoff()
    const entry = running.get(profile.id)
    // A deliberate stop/kill/restart already flips the status to 'stopping'/'restarting'
    // before it ever touches the process - so seeing it exit from one of those states is
    // expected, not a surprise, and there's nothing to double-check. Anything else (still
    // 'starting' or 'running') is an exit nobody asked for.
    const expected = !entry || entry.status.state === 'stopping' || entry.status.state === 'restarting'
    if (expected) {
      finalizeStopped(profile.id)
      return
    }
    void handleUnexpectedExit(profile)
  })

  child.on('error', (err) => {
    clearTimeout(fallback)
    stopWatchingLog()
    stopBatchPidHandoff()
    emitStatus({ profileId: profile.id, state: 'error', lastError: err.message })
  })

  return status
}

/** Waits for the process to exit on its own, or force-kills it after `graceMs` - and, for a
 *  forced kill, actually waits for it to take effect before returning (up to
 *  FORCE_KILL_CONFIRM_MS more) rather than firing the kill signal and returning immediately.
 *
 *  That immediate-return used to be the whole story for a live (non-adopted) process, which
 *  looked harmless - the real cleanup (running.delete, via finalizeStopped) happens from the
 *  'exit' listener doSpawn registered back when the process was spawned, not from here. But
 *  `kill()` only *sends* the signal; the OS tears the process down and Node delivers 'exit'
 *  asynchronously, often a noticeable moment later for a large server process - so a caller
 *  that immediately chains startServer() after stopServer() resolves (restartServer, and the
 *  Event Scheduler's own shutdown-then-restart cycle in modEvents.ts) could find `running`
 *  still holding the old entry and have startServer() no-op (its own `if (running.has(...))
 *  return` guard), silently leaving the pre-change process running instead of replacing it -
 *  exactly what a real report traced a scheduled mod-activation event to (mod added to the
 *  profile and the server "restarted" per the Manager, but the new mod was never actually
 *  loaded, because no new process had actually been spawned). Now waits for confirmation
 *  (the 'exit' event, or the pid simply no longer existing - whichever comes first) before
 *  returning, so a chained startServer() is guaranteed a clear `running` entry to work with. */
async function waitForExitOrKill(entry: RunningServer, profileId: string, graceMs: number): Promise<void> {
  const exited = await new Promise<boolean>((resolve) => {
    if (entry.process) {
      const timeout = setTimeout(() => resolve(false), graceMs)
      entry.process.once('exit', () => {
        clearTimeout(timeout)
        resolve(true)
      })
      return
    }

    // Adopted process - no 'exit' event available, so poll for liveness instead.
    const start = Date.now()
    const interval = setInterval(() => {
      const alive = isPidAlive(entry.pid)
      if (!alive || Date.now() - start >= graceMs) {
        clearInterval(interval)
        resolve(!alive)
      }
    }, 1000)
  })

  if (entry.process) {
    if (exited || !running.has(profileId)) return
    const child = entry.process
    const pid = entry.pid
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearInterval(poll)
        clearTimeout(giveUp)
        resolve()
      }
      const poll = setInterval(() => {
        if (!isPidAlive(pid)) finish()
      }, 500)
      const giveUp = setTimeout(finish, FORCE_KILL_CONFIRM_MS)
      child.once('exit', finish)
      child.kill()
    })
    // Covers the poll/timeout paths above resolving before doSpawn's own 'exit' listener (the
    // normal cleanup path, registered earlier, so it usually wins the race) gets a chance to -
    // finalizeStopped/running.delete are idempotent, so this is a no-op when it already ran.
    finalizeStopped(profileId)
    return
  }

  // Adopted process: nothing else will clean up its bookkeeping for us.
  if (!exited) killByPid(entry.pid)
  finalizeStopped(profileId)
}

export interface StopPhases {
  /** Resolves as soon as SaveWorld's RCON outcome is known - true only if it was
   *  confirmed before DoExit was sent. Lets a caller that just wants proof a save was
   *  attempted return without waiting out the rest of the shutdown below. */
  saved: Promise<boolean>
  /** Resolves once the process has actually exited (or been force-killed after the
   *  grace period) - the same completion `stopServer` itself waits for. */
  finished: Promise<ServerStatus>
}

/**
 * Graceful shutdown, split into two independently-awaitable phases: SaveWorld, wait for
 * its RCON confirmation, wait saveSettleMs for the save to actually finish writing to
 * disk, then DoExit. DoExit is only sent once SaveWorld is confirmed - if RCON is
 * unreachable or the save fails, there is no safe orderly path, so we skip straight to
 * the grace-period/kill fallback instead of exiting (or waiting) on an unconfirmed save.
 */
/** If `entry` is still waiting out its staggered spawn slot (see startServer's queuing path),
 *  cancels the pending spawn outright and finalizes it as stopped - there's no process to
 *  gracefully save/exit yet, so Stop and Kill both collapse to the same thing for this case.
 *  Returns the stopped status if it handled it this way, or null if `entry` is a real,
 *  already-spawned process that the caller should handle normally. */
function cancelIfQueuedSpawn(entry: RunningServer, profileId: string): ServerStatus | null {
  if (!entry.cancelQueuedSpawn) return null
  entry.cancelQueuedSpawn()
  running.delete(profileId)
  const stopped: ServerStatus = { profileId, state: 'stopped' }
  emitStatus(stopped)
  return stopped
}

export function stopServerPhased(
  profile: ServerProfile,
  graceMs = 15000,
  transientState: 'stopping' | 'restarting' = 'stopping',
  saveSettleMs = SAVE_SETTLE_MS
): StopPhases {
  const entry = running.get(profile.id)
  if (!entry) {
    return {
      saved: Promise.resolve(false),
      finished: Promise.resolve({ profileId: profile.id, state: 'stopped' })
    }
  }

  const queuedStop = cancelIfQueuedSpawn(entry, profile.id)
  if (queuedStop) {
    return { saved: Promise.resolve(false), finished: Promise.resolve(queuedStop) }
  }

  emitStatus({ ...entry.status, state: transientState })

  let resolveSaved!: (saved: boolean) => void
  const saved = new Promise<boolean>((resolve) => {
    resolveSaved = resolve
  })

  const finished = (async () => {
    const saveResult = await sendRconCommand(profile, 'SaveWorld')
    resolveSaved(saveResult.ok)
    if (saveResult.ok) {
      await delay(saveSettleMs)
      await sendRconCommand(profile, 'DoExit')
    }
    await waitForExitOrKill(entry, profile.id, graceMs)
    return getStatus(profile.id)
  })()

  return { saved, finished }
}

export async function stopServer(
  profile: ServerProfile,
  graceMs = 15000,
  transientState: 'stopping' | 'restarting' = 'stopping',
  saveSettleMs = SAVE_SETTLE_MS
): Promise<ServerStatus> {
  return stopServerPhased(profile, graceMs, transientState, saveSettleMs).finished
}

/** Same restart, split the same way as stopServerPhased - `saved` resolves once the
 *  shutdown's SaveWorld is confirmed, `finished` once the new process has actually
 *  spawned back up. */
export function restartServerPhased(profile: ServerProfile, saveSettleMs = SAVE_SETTLE_MS): StopPhases {
  const { saved, finished: stopFinished } = stopServerPhased(profile, 15000, 'restarting', saveSettleMs)
  const finished = stopFinished.then(() => startServer(profile))
  return { saved, finished }
}

export async function restartServer(profile: ServerProfile, saveSettleMs = SAVE_SETTLE_MS): Promise<ServerStatus> {
  return restartServerPhased(profile, saveSettleMs).finished
}

/** Immediately force-kills the process with no SaveWorld/DoExit - current world state since the last save is lost. */
export function killServer(profileId: string): ServerStatus {
  const entry = running.get(profileId)
  if (!entry) return { profileId, state: 'stopped' }

  const queuedStop = cancelIfQueuedSpawn(entry, profileId)
  if (queuedStop) return queuedStop

  emitStatus({ ...entry.status, state: 'stopping' })

  if (entry.process) {
    entry.process.kill()
  } else {
    killByPid(entry.pid)
    finalizeStopped(profileId)
  }

  return getStatus(profileId)
}
