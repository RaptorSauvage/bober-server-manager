import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { platform } from 'node:process'
import type { MinecraftProfile, MinecraftServerStatus, MinecraftConsoleLine } from '@shared/minecraft'
import { findListeningPid, isPidAlive } from './serverProcess'
import { getMinecraftServerPort, writeUserJvmArgs, hasVariablesTxt, writeVariablesTxtJavaArgs } from './minecraftProperties'
import { sendMinecraftRconCommand } from './minecraftRcon'
import { setMinecraftRunningPid, setMinecraftRunningStartedAt } from '../store'
import { queueConsoleLineForArchive, flushQueuedConsoleLines, readMinecraftConsoleArchive } from './minecraftConsoleArchive'

/** Minecraft's own log line once the world has finished loading and is ready for players -
 *  every vanilla/Fabric/Paper/Spigot/Forge version prints this exact wording (only the
 *  timing number and the surrounding `[HH:MM:SS] [Server thread/INFO]:` prefix vary), so
 *  matching on it rather than a fixed line format keeps this working across launchMode
 *  'jar' and 'script' alike. */
const READY_MARKER = /Done \([\d.]+s\)! For help, type "help"/

/** How many of the most recent archived lines getConsoleBacklog actually returns to the
 *  renderer - the archive file itself (minecraftConsoleArchive.ts) holds far more than this,
 *  but the Console tab only needs enough to fill the screen on open, not the whole archive.
 *  Matches ConsoleTab.tsx's own MAX_LINES, which in turn matches MCSS's (a well-known
 *  Minecraft server manager) own 250-line cap on its live console. */
const CONSOLE_BACKLOG_LIMIT = 250

/** How long stopServer waits for the process to exit on its own (after writing "stop" to
 *  its stdin) before force-killing it. Generous by ARK standards since a world save on
 *  shutdown can legitimately take a while on a large/modded world - there's no Minecraft
 *  equivalent of ARK's separate SaveWorld/DoExit RCON handshake to phase this into, since
 *  the "stop" command already saves and exits on its own. */
const STOP_GRACE_MS = 30_000

interface RunningMinecraftServer {
  /** Null for a server re-adopted from a previous Manager session (see
   *  adoptPersistedMinecraftProcesses) - we have its pid but no live handle: no stdout to
   *  read the console from, no stdin to send commands to (sendStdinCommand/stopServer both
   *  fall back to RCON, when enabled), and no 'exit' event to detect it stopping (which is
   *  why waitForExitOrKill/killServer poll/finalize manually for this case instead). */
  process: ChildProcess | null
  /** Best-known real server pid - used for CPU/RAM stats (minecraftMonitor.ts) and for
   *  force-kill. Starts out equal to `process.pid`, except right after a Windows
   *  launchMode 'script' launch (see watchForScriptPidHandoff below), where it's corrected
   *  once the real java process is found. */
  pid: number
  /** False only for the brief window between a Windows launchMode 'script' launch and the
   *  real java pid being found. During that window, `process.pid` (and therefore the
   *  starting value of `pid` above) is cmd.exe's own wrapper pid, not the actual server -
   *  cmd.exe spawns java as a *child* process rather than replacing itself the way a POSIX
   *  shell's `exec` would, so reading CPU/RAM off it, or killing it, would target the wrong
   *  process entirely (same problem, and same fix, as ARK: Survival Evolved's own .bat
   *  launch - see serverProcess.ts's watchForBatchPidHandoff). */
  pidTracked: boolean
  status: MinecraftServerStatus
  /** Set only on the placeholder entry startServer reserves synchronously before the async
   *  memory-file checks (see doSpawn) - there's no real process yet (`process` is null, `pid`
   *  is 0, which must never reach killByPid/isPidAlive: pid 0 means "this whole process
   *  group" to POSIX kill()). Lets stop/kill requested during that brief window cancel the
   *  pending spawn outright instead of racing it, or (worse) trying to kill pid 0 - same
   *  pattern as ARK's own cancelQueuedSpawn for its staggered-start queue slot
   *  (serverProcess.ts). */
  cancelPendingSpawn?: () => void
}

const running = new Map<string, RunningMinecraftServer>()

export const minecraftServerEvents = new EventEmitter()
export const minecraftConsoleEvents = new EventEmitter()

/** Persists a status update (so a later getStatus() call sees it too, not just whoever's
 *  listening for the 'status' event right now) and broadcasts it. */
export function emitStatus(status: MinecraftServerStatus): void {
  const entry = running.get(status.profileId)
  if (entry) entry.status = status
  minecraftServerEvents.emit('status', status)
}

export function getStatus(profileId: string): MinecraftServerStatus {
  return running.get(profileId)?.status ?? { profileId, state: 'stopped' }
}

export function isRunning(profileId: string): boolean {
  return running.has(profileId)
}

/** Clears an entry's bookkeeping (in-memory and persisted pid) and broadcasts 'stopped' -
 *  the one place that needs to happen from, whether triggered by the live child's own
 *  'exit' event or (for an adopted process with no such event - see killServer/
 *  waitForExitOrKill) a poll noticing it's gone. */
function finalizeStopped(profileId: string): void {
  running.delete(profileId)
  setMinecraftRunningPid(profileId, null)
  setMinecraftRunningStartedAt(profileId, null)
  emitStatus({ profileId, state: 'stopped' })
}

/**
 * Re-attaches to servers still running from a previous Manager session - the process itself
 * survives a Manager crash/close (nothing about it is tied to the Manager's own lifetime),
 * so without this a relaunched Manager would show every one of them as "stopped" even while
 * still actually running, and let a second instance be started on top of it. Same shape as
 * ARK's own adoptPersistedProcesses in serverProcess.ts. Console/stdin aren't available for
 * an adopted entry (see RunningMinecraftServer.process's own comment) - CPU/RAM and, if RCON
 * is enabled, player list and command sending still work.
 */
export function adoptPersistedMinecraftProcesses(
  profiles: MinecraftProfile[],
  persistedPids: Record<string, number>,
  persistedStartedAt: Record<string, number> = {}
): void {
  for (const profile of profiles) {
    const pid = persistedPids[profile.id]
    if (pid === undefined) continue

    if (isPidAlive(pid)) {
      const status: MinecraftServerStatus = {
        profileId: profile.id,
        state: 'running',
        pid,
        consoleAvailable: false,
        ...(persistedStartedAt[profile.id] !== undefined ? { startedAt: persistedStartedAt[profile.id] } : {})
      }
      running.set(profile.id, { process: null, pid, pidTracked: true, status })
      emitStatus(status)
    } else {
      setMinecraftRunningPid(profile.id, null)
      setMinecraftRunningStartedAt(profile.id, null)
    }
  }
}

/** Whether `getStatus(profileId).pid` is currently trustworthy for an OS-level CPU/RAM
 *  reading - false during the brief window before watchForScriptPidHandoff finds the real
 *  java pid for a Windows launchMode 'script' launch (see RunningMinecraftServer.pidTracked).
 *  Unknown/not-running profiles report true (nothing to distrust). */
export function isPidTracked(profileId: string): boolean {
  return running.get(profileId)?.pidTracked ?? true
}

/** Reads the tail of the on-disk archive (minecraftConsoleArchive.ts) rather than an
 *  in-memory buffer - survives both a Manager restart and the Minecraft server's own
 *  restarts, since nothing clears the archive file on a fresh start (see startServer below). */
export async function getConsoleBacklog(profileId: string): Promise<MinecraftConsoleLine[]> {
  return (await readMinecraftConsoleArchive(profileId)).slice(-CONSOLE_BACKLOG_LIMIT)
}

function appendConsoleLine(profileId: string, text: string): void {
  const line: MinecraftConsoleLine = { text, ts: Date.now() }
  // Queued, not written immediately - see queueConsoleLineForArchive's own comment: a big
  // modpack's startup can print thousands of lines within seconds, and firing one independent
  // fs round-trip per line (even async ones) was enough to flood the Electron main process's
  // I/O and freeze the Manager for minutes at a stretch.
  queueConsoleLineForArchive(profileId, line)
  minecraftConsoleEvents.emit('line', profileId, line)
}

/** Splits a stream of arbitrarily-chunked stdout/stderr data into whole lines, holding back
 *  a trailing partial line until more data completes it - a naive per-chunk split would
 *  otherwise regularly cut a line in half across two 'data' events. */
function makeLineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let remainder = ''
  return (chunk: Buffer) => {
    remainder += chunk.toString('utf-8')
    const lines = remainder.split(/\r?\n/)
    remainder = lines.pop() ?? ''
    for (const line of lines) {
      if (line) onLine(line)
    }
  }
}

/** -Xms/-Xmx plus any extra JVM flags - shared between jar mode (built straight onto the
 *  java command line below) and script mode (written to user_jvm_args.txt instead, since
 *  the Manager doesn't control that command line - see minecraftProperties.ts).
 *
 *  Clamps min down to max when min > max - the JVM itself refuses to start at all with
 *  "Initial heap size set to a larger value than the maximum heap size" and keeps
 *  crash-looping (restarting every few seconds, forever) rather than just ignoring it. That
 *  combination is easy to end up in by accident: both fields auto-save on every keystroke
 *  (see StartSettingsTab.tsx), so even typing a smaller max memory value momentarily saves
 *  min > max the instant the field is cleared before the new digits are typed. */
function buildJvmArgs(profile: MinecraftProfile): string[] {
  const minMB = Math.min(profile.minMemoryMB, profile.maxMemoryMB)
  const args = [`-Xms${minMB}M`, `-Xmx${profile.maxMemoryMB}M`]
  if (profile.extraJvmArgs.trim()) args.push(...profile.extraJvmArgs.trim().split(/\s+/))
  return args
}

function buildJavaArgs(profile: MinecraftProfile): string[] {
  const args = buildJvmArgs(profile)
  args.push('-jar', profile.jarFileName)
  if (profile.extraProgramArgs.trim()) args.push(...profile.extraProgramArgs.trim().split(/\s+/))
  return args
}

/**
 * Polls for the real java process once a Windows launchMode 'script' server's own port
 * starts listening, and switches this profile's tracked pid to it - same technique (and
 * same reason) as ARK: Survival Evolved's watchForBatchPidHandoff in serverProcess.ts:
 * `wrapperPid` is cmd.exe's own pid, not java's, so CPU/RAM stats and force-kill need to
 * target whichever pid is actually holding the server's port instead. Stops on its own once
 * handed off, or once the profile is no longer running under the wrapper pid it started
 * with (findListeningPid is Windows-only, matching the only platform this is called from).
 *
 * Self-rescheduling (setTimeout, not setInterval) - the next poll is only scheduled once the
 * current one's findListeningPid call has actually settled, so there is never more than one
 * in flight. A real report traced an escalating, near-continuous Manager freeze for the first
 * few minutes after starting a very large modpack - exactly this function's own active
 * window, before the real java pid is found - to a WPA trace showing electron.exe's message
 * pump stalled in blocks matching the freeze durations almost exactly, while CPU usage stayed
 * low throughout. findListeningPid spawns a netstat.exe process every call; a plain
 * setInterval here used to fire a new one every intervalMs regardless of whether the previous
 * spawn had finished - once a single spawn ran slow (antivirus scanning it, the system
 * already busy loading hundreds of mods), the next interval fired anyway and piled another
 * netstat spawn on top of the one still pending, compounding instead of just waiting. Same
 * bug, same fix, as monitor.ts/minecraftMonitor.ts's own scheduleNextTick.
 */
function watchForScriptPidHandoff(profileId: string, port: number, wrapperPid: number, intervalMs = 2000): () => void {
  let stopped = false
  let timer: NodeJS.Timeout

  const poll = (): void => {
    void (async () => {
      const entry = running.get(profileId)
      if (!entry || entry.pid !== wrapperPid) {
        stopped = true
        return
      }
      const realPid = await findListeningPid(port)
      if (stopped) return
      if (realPid && realPid !== wrapperPid && isPidAlive(realPid)) {
        entry.pid = realPid
        entry.pidTracked = true
        entry.status = { ...entry.status, pid: realPid }
        // So a Manager restart re-adopts the real java pid rather than cmd.exe's wrapper
        // pid, which might not even exist any more (or worse, be reused by something
        // unrelated) by the time adoptPersistedMinecraftProcesses runs.
        setMinecraftRunningPid(profileId, realPid)
        emitStatus(entry.status)
        stopped = true
        return
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

function killByPid(pid: number): void {
  try {
    process.kill(pid)
  } catch {
    // Already gone - nothing to do.
  }
}

/**
 * Force-kills `pid` and every process still under it in the OS's *current* process tree - not
 * just `pid` itself. Needed specifically for a Windows launchMode 'script' launch: a
 * CurseForge/Overwolf-exported modpack's generated run.bat commonly wraps the actual
 * Minecraft server in its own auto-restart loop ("Automatically restarting server in 5
 * seconds. Press CTRL+C to abort and exit.") that respawns a brand new java process the
 * instant the one process Manager is tracking exits - including right after a clean, graceful
 * "stop". Killing only the one pid Manager happens to know about leaves that loop (and
 * whichever java process it spawns next, a pid Manager never learns about) running completely
 * unsupervised in the background - which matches a real report of "the process stays running
 * after the server stops".
 *
 * `taskkill /T` walks the live process tree at the moment it actually runs, not a snapshot
 * Manager took earlier, so it still catches a process that was respawned after Manager last
 * checked - unlike trying to track pids one at a time ever could. `/F` force-kills outright,
 * which also means it never triggers the interactive "Terminate batch job (Y/N)?" prompt a
 * console-attached batch script shows for a *graceful* break signal (there's nothing to
 * confirm - a forced kill isn't asking).
 *
 * Fire-and-forget (uses the async execFile, not execFileSync - a sync call would block the
 * entire Electron main process on it) - nothing downstream needs to wait for this to actually
 * finish; the real server process's own 'exit' event (or the adopted-process poll) is what
 * finalizes this profile's status either way.
 */
function killProcessTreeWindows(pid: number): void {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
    // Already gone, or nothing left under it - either way, nothing to do.
  })
}

/**
 * Whether `scriptPath` actually reads user_jvm_args.txt as a java "argfile" (modern
 * Forge/NeoForge's generated run.bat/run.sh does, via `@user_jvm_args.txt` right on its own
 * java command line) - checked before startServer below writes to that file at all. Not
 * every script does: a real report came from a CurseForge-exported pack whose generated
 * script has its own -Xms/-Xmx written directly on the command line instead, with no
 * `@user_jvm_args.txt` anywhere - writing the file regardless just leaves a dead one sitting
 * there for a script like that, harmless on its own, but it's exactly how a *different* pack
 * can end up with two independent, conflicting sources of truth for memory if its own script
 * happens to combine both approaches (its own hardcoded flags alongside also reading this
 * file) - this check means the Manager only ever writes the file for a script actually set
 * up to read it, instead of unconditionally.
 *
 * Specifically the `@`-prefixed argfile form, not a bare mention of the filename - the
 * ServerStarterJar script (see hasVariablesTxt/writeVariablesTxtJavaArgs in
 * minecraftProperties.ts, checked first by the caller) documents in its own comments that
 * *it* writes to user_jvm_args.txt for some modloaders, which would otherwise read as a
 * false positive here and have the Manager write the same file independently right alongside
 * it - precisely the overlap this check exists to prevent.
 *
 * Errors on the side of still writing it (returns true) if the script can't be read at all,
 * rather than silently stop applying a Settings change that was already working. Async
 * (fs.promises), not fs.readFileSync - called from doSpawn below on every single Start, and
 * a sync read blocks the entire Electron main process for however long the disk I/O takes.
 */
async function scriptReadsUserJvmArgs(scriptPath: string): Promise<boolean> {
  try {
    const content = await fsPromises.readFile(scriptPath, 'utf-8')
    return content.toLowerCase().includes('@user_jvm_args.txt')
  } catch {
    return true
  }
}

export function startServer(profile: MinecraftProfile): MinecraftServerStatus {
  const existing = running.get(profile.id)
  if (existing) return existing.status

  const startedAt = Date.now()
  let cancelled = false
  const placeholder: MinecraftServerStatus = { profileId: profile.id, state: 'starting', startedAt }
  // Reserved synchronously, before doSpawn's async memory-file checks below ever run - a
  // second startServer call for the same profile during that window must see this and dedupe
  // immediately (the `existing` check above), not race the pending spawn. pid 0 / process
  // null here means "nothing real yet" - see cancelPendingSpawn's own doc comment and
  // stopServer/killServer's guard for it below.
  running.set(profile.id, {
    process: null,
    pid: 0,
    pidTracked: true,
    status: placeholder,
    cancelPendingSpawn: () => {
      cancelled = true
    }
  })
  emitStatus(placeholder)

  void doSpawn(profile, startedAt, () => cancelled)

  return placeholder
}

/**
 * The actual OS-level spawn, deferred out of startServer's own synchronous return - the
 * memory-settings file checks it needs first (hasVariablesTxt/writeVariablesTxtJavaArgs/
 * writeUserJvmArgs/scriptReadsUserJvmArgs, all async) must never block the Electron main
 * process while Start is clicked, same as every other sync-fs-call-on-the-main-thread fix
 * already made this session - a real report tied exactly this moment to a several-second
 * freeze. `isCancelled` reflects a Stop/Kill requested for this profile while still in this
 * async window (see startServer's own cancelPendingSpawn) - checked at each point there's
 * now something to actually cancel.
 */
async function doSpawn(profile: MinecraftProfile, startedAt: number, isCancelled: () => boolean): Promise<void> {
  // cmd.exe spawns java as a *child* process rather than replacing itself (unlike a POSIX
  // shell's `exec`, which the fake test server and Forge's own run.sh both use), so on
  // Windows the pid Node hands back for a script launch is cmd.exe's own wrapper pid, not
  // java's - watchForScriptPidHandoff below corrects it once the real process is found.
  const launchedViaWindowsScriptWrapper = profile.launchMode === 'script' && platform === 'win32'

  let child: ChildProcess
  try {
    if (profile.launchMode === 'script') {
      const scriptPath = path.join(profile.installDir, profile.scriptFileName)

      // The Manager can't put -Xms/-Xmx/extra JVM args on the command line itself in script
      // mode (it executes the script as-is), so one of these files is what makes editing
      // memory in Settings actually take effect for a script-launched server - whichever one
      // the script in `profile.installDir` actually reads for it:
      //  - variables.txt's own JAVA_ARGS, for a CurseForge/Overwolf-exported pack's
      //    "ServerStarterJar" universal script (every modloader uses this one nowadays).
      //  - user_jvm_args.txt, for modern Forge/NeoForge's own older generated run.bat/run.sh.
      // Checked as two mutually-exclusive branches, never both - writing memory to the one
      // this particular script doesn't read is harmless on its own, but a real report showed
      // writing *both* independently creates two conflicting sources of truth for the exact
      // same setting on a script that happens to read one of them in terms of the other.
      if (await hasVariablesTxt(profile.installDir)) {
        await writeVariablesTxtJavaArgs(profile.installDir, buildJvmArgs(profile))
      } else if (await scriptReadsUserJvmArgs(scriptPath)) {
        await writeUserJvmArgs(profile.installDir, buildJvmArgs(profile))
      }

      if (isCancelled()) return

      // Same cmd.exe /d /c launch shape as ARK: Survival Evolved's own .bat launch (see
      // serverProcess.ts's writeLaunchBatchFile) - spawning a .bat directly is unreliable on
      // Windows, going through cmd.exe is the confirmed-working way to run one. stdio: 'pipe'
      // (unlike ARK, which allocates its own console window) - Java/Minecraft processes
      // support piped stdio reliably, which is what lets the Console tab and sendStdinCommand
      // below work for a script-launched (e.g. modern Forge) server too.
      child =
        platform === 'win32'
          ? spawn('cmd.exe', ['/d', '/c', scriptPath], { cwd: profile.installDir, stdio: 'pipe' })
          : spawn('sh', [scriptPath], { cwd: profile.installDir, stdio: 'pipe' })
    } else {
      if (isCancelled()) return
      child = spawn('java', buildJavaArgs(profile), { cwd: profile.installDir, stdio: 'pipe' })
    }
  } catch (err) {
    running.delete(profile.id)
    if (!isCancelled()) {
      const failed: MinecraftServerStatus = { profileId: profile.id, state: 'error', lastError: (err as Error).message }
      emitStatus(failed)
    }
    return
  }

  // Declared here (before the pid check below), reassigned once the process is confirmed
  // actually running - so the single 'error' listener right below can always reference it
  // safely, even for a failure that happens before it gets its real value. Registered
  // immediately after spawn() (before even checking `pid`), covering this child's whole
  // lifetime in one place - previously nothing at all covered a spawn failure that doesn't
  // throw synchronously (the common case for a bad install path or a permissions/antivirus
  // block: Node's spawn() returns right away with `pid` already undefined, but only
  // *reports* the real reason - ENOENT, EACCES, ... - a tick later via this same 'error'
  // event). Real report (same bug, same fix, as serverProcess.ts's own ARK equivalent -
  // see its own doc comment): with no listener attached yet at that point, every one of
  // those failures showed only this function's own generic "Process started without a pid."
  // - the actual OS error had nowhere to go, since 'error' is special-cased by Node's
  // EventEmitter to throw when it fires with zero listeners.
  let stopPidHandoffWatch: () => void = () => {}
  child.on('error', (err) => {
    stopPidHandoffWatch()
    running.delete(profile.id)
    setMinecraftRunningPid(profile.id, null)
    setMinecraftRunningStartedAt(profile.id, null)
    emitStatus({ profileId: profile.id, state: 'error', lastError: err.message })
  })

  const pid = child.pid
  if (!pid) {
    running.delete(profile.id)
    const failed: MinecraftServerStatus = { profileId: profile.id, state: 'error', lastError: 'Process started without a pid.' }
    emitStatus(failed)
    return
  }

  if (isCancelled()) {
    // Stop/Kill landed in the narrow gap between the cancellation check above and the
    // process actually existing - nothing else is tracking it yet (the listeners below
    // haven't been wired up), so it has to be force-killed right here instead of leaking an
    // orphaned process nobody in the Manager knows about.
    try {
      child.kill()
    } catch {
      // Already gone - nothing to do.
    }
    return
  }

  const status: MinecraftServerStatus = { profileId: profile.id, state: 'starting', pid, startedAt, consoleAvailable: true }
  running.set(profile.id, { process: child, pid, pidTracked: !launchedViaWindowsScriptWrapper, status })
  setMinecraftRunningPid(profile.id, pid)
  setMinecraftRunningStartedAt(profile.id, startedAt)
  emitStatus(status)

  stopPidHandoffWatch = launchedViaWindowsScriptWrapper
    ? watchForScriptPidHandoff(profile.id, getMinecraftServerPort(profile.installDir), pid)
    : () => {}

  // Start/Stop, sending stdin commands, and the ready-marker detection right below all keep
  // working regardless of this setting - only the archive write + live Console tab feed
  // (appendConsoleLine) are skipped. For a modpack chatty enough that even the capped,
  // backgrounded version of that pipeline is still real per-line overhead, turning it off
  // entirely is the actual fix, rather than trying to make an unboundedly chatty feed cheap
  // enough.
  const consoleLoggingEnabled = profile.consoleLoggingEnabled
  const onStdoutLine = makeLineSplitter((line) => {
    if (consoleLoggingEnabled) appendConsoleLine(profile.id, line)
    if (READY_MARKER.test(line)) {
      const current = running.get(profile.id)
      if (current && current.status.state === 'starting') {
        emitStatus({ ...current.status, state: 'running' })
      }
    }
  })
  const onStderrLine = makeLineSplitter((line) => {
    if (consoleLoggingEnabled) appendConsoleLine(profile.id, line)
  })
  child.stdout?.on('data', onStdoutLine)
  child.stderr?.on('data', onStderrLine)

  child.on('exit', (code, signal) => {
    stopPidHandoffWatch()
    // Writes out whatever's still queued (see queueConsoleLineForArchive) right away rather
    // than leaving it to land on its own regular flush schedule - nothing is going to add to
    // this profile's queue once it's stopped, so there's no reason to wait.
    flushQueuedConsoleLines(profile.id)
    // A deliberate stop/kill already flips the status to 'stopping' before it ever touches the
    // process (see stopServer/killServer) - so a non-zero/non-null exit code seen from that
    // state is expected, not a surprise worth flagging in red on the server card. This matters
    // in particular since waitForExitOrKill/killServer now force-kill a hung Windows script-
    // mode wrapper (cmd.exe) directly once the real server pid is confirmed gone - and a
    // forcibly-terminated process's own exit code is whatever the OS reports for that (e.g.
    // code 1 on Windows), not 0, even though the stop itself completed exactly as asked.
    // Anything else (still 'starting' or 'running') is an exit nobody asked for, same
    // distinction ARK's own serverProcess.ts makes for its equivalent handler.
    const wasExpectedStop = running.get(profile.id)?.status.state === 'stopping'
    running.delete(profile.id)
    setMinecraftRunningPid(profile.id, null)
    setMinecraftRunningStartedAt(profile.id, null)
    emitStatus({
      profileId: profile.id,
      state: 'stopped',
      ...(!wasExpectedStop && code !== 0 && code !== null
        ? { lastError: `Process exited with code ${code}${signal ? ` (signal ${signal})` : ''}` }
        : {})
    })
  })
}

/** Sends a line of input straight to the running process's stdin - the primary way to send
 *  a server command, since Minecraft/Java server processes reliably support piped stdio
 *  (unlike ARK's dedicated server on Windows, which is why ARK is RCON/log-file-only).
 *  Works whether or not RCON is enabled in server.properties. minecraftRcon.ts's
 *  sendMinecraftRconCommand is the secondary path (see ipc/minecraft.ts's send-command
 *  handler), for player-list queries or a server re-adopted from a previous Manager session
 *  (adoptPersistedMinecraftProcesses) - no live stdin handle exists for one of those. */
export function sendStdinCommand(profileId: string, command: string): boolean {
  const entry = running.get(profileId)
  if (!entry?.process?.stdin?.writable) return false
  try {
    entry.process.stdin.write(command.endsWith('\n') ? command : `${command}\n`)
    return true
  } catch (err) {
    console.error(`Failed to write command to Minecraft profile ${profileId}'s stdin:`, (err as Error).message)
    return false
  }
}

/** Waits for the process to exit on its own, or force-kills it after `graceMs`. Three ways of
 *  detecting "it exited": a live child's own 'exit' event, polling isPidAlive(entry.pid) (the
 *  real server pid, which can differ from entry.process's own pid - see
 *  RunningMinecraftServer.pid), or - for an adopted process with no 'exit' event available at
 *  all (see RunningMinecraftServer.process) - that same poll alone. The poll matters even for
 *  a live process: after a Windows launchMode 'script' handoff, entry.process is cmd.exe, and
 *  cmd.exe isn't guaranteed to exit just because the java process it spawned did - some
 *  servers' generated run.bat ends in a `pause` (or similar) that blocks forever on a piped,
 *  non-interactive stdin once there's nothing left to ever satisfy it. Without the poll, the
 *  Manager would report that server stuck "Stopping" forever even though it's actually long
 *  gone. Once the real pid is confirmed gone, the still-hung wrapper is force-killed directly
 *  below rather than left running forever in the background - which also makes it actually
 *  emit 'exit' and run the cleanup registered on it in startServer. */
async function waitForExitOrKill(entry: RunningMinecraftServer, profileId: string, graceMs: number): Promise<void> {
  const exited = await new Promise<boolean>((resolve) => {
    if (entry.process) {
      let settled = false
      const finish = (result: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearInterval(poll)
        resolve(result)
      }
      const timeout = setTimeout(() => finish(false), graceMs)
      const poll = setInterval(() => {
        if (!isPidAlive(entry.pid)) finish(true)
      }, 1000)
      entry.process.once('exit', () => finish(true))
      return
    }
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
    if (!exited && running.has(profileId)) killByPid(entry.pid)
    const wrapperPid = entry.process.pid
    if (wrapperPid) {
      // On Windows, a tree-kill of the wrapper catches both the "hung on a trailing pause"
      // case this function's own comment describes AND an auto-restart loop that has already
      // respawned a brand new java process under it (see killProcessTreeWindows) - either way,
      // nothing should still be alive under this profile once stopServer/killServer returns.
      if (platform === 'win32') killProcessTreeWindows(wrapperPid)
      else if (wrapperPid !== entry.pid && isPidAlive(wrapperPid)) killByPid(wrapperPid)
    }
    return
  }
  // Adopted process: no child.on('exit') handler exists to clean up its bookkeeping for us.
  if (!exited) killByPid(entry.pid)
  finalizeStopped(profileId)
}

/** If `entry` is still waiting out its async memory-file checks (see startServer/doSpawn's
 *  own cancelPendingSpawn), cancels the pending spawn outright and finalizes it as stopped -
 *  there's no real process yet to gracefully save/exit or force-kill, and `entry.pid` is 0
 *  for exactly that reason (never pass it to killByPid/isPidAlive - pid 0 has a special
 *  "whole process group" meaning to POSIX kill()). Same pattern, same reasoning, as ARK's own
 *  cancelIfQueuedSpawn for its staggered-start queue slot (serverProcess.ts). Returns the
 *  stopped status if it handled it this way, or null if `entry` is a real, already-spawned
 *  process the caller should handle normally. */
function cancelIfPendingSpawn(entry: RunningMinecraftServer, profileId: string): MinecraftServerStatus | null {
  if (!entry.cancelPendingSpawn) return null
  entry.cancelPendingSpawn()
  running.delete(profileId)
  const stopped: MinecraftServerStatus = { profileId, state: 'stopped' }
  emitStatus(stopped)
  return stopped
}

/** Graceful shutdown: writes "stop" to the process's own stdin, which saves the world, kicks
 *  players, and exits on its own - there's no separate save-then-exit RCON handshake to phase
 *  this into the way ARK's stopServerPhased needs. Waits up to graceMs before force-killing.
 *  An adopted process (see RunningMinecraftServer.process) has no stdin to write to - RCON's
 *  own "stop" command is the only other graceful path available, if RCON happens to be
 *  enabled; otherwise this falls straight through to the wait-then-force-kill below. */
export async function stopServer(profile: MinecraftProfile, graceMs = STOP_GRACE_MS): Promise<MinecraftServerStatus> {
  const entry = running.get(profile.id)
  if (!entry) return { profileId: profile.id, state: 'stopped' }

  const cancelled = cancelIfPendingSpawn(entry, profile.id)
  if (cancelled) return cancelled

  emitStatus({ ...entry.status, state: 'stopping' })
  if (!sendStdinCommand(profile.id, 'stop')) {
    const rconResult = await sendMinecraftRconCommand(profile.installDir, 'stop').catch(
      (err: Error) => ({ ok: false, error: err.message }) as const
    )
    if (!rconResult.ok) {
      console.error(
        `Could not gracefully stop ${profile.name} (no stdin, and RCON's own "stop" didn't work either: ${rconResult.error}) - waiting then force-killing.`
      )
    }
  }
  await waitForExitOrKill(entry, profile.id, graceMs)
  return getStatus(profile.id)
}

/** Immediately force-kills the process - no graceful "stop" is sent, so any unsaved world
 *  state since the last autosave is lost. */
export function killServer(profileId: string): MinecraftServerStatus {
  const entry = running.get(profileId)
  if (!entry) return { profileId, state: 'stopped' }
  const cancelled = cancelIfPendingSpawn(entry, profileId)
  if (cancelled) return cancelled
  emitStatus({ ...entry.status, state: 'stopping' })
  // See waitForExitOrKill's comment - entry.pid, not entry.process, for the same reason.
  killByPid(entry.pid)
  // Also kill the wrapper (cmd.exe, after a Windows launchMode 'script' handoff) directly -
  // it isn't guaranteed to exit just because the real pid above did (same "hangs on a
  // trailing pause", or an auto-restart loop that respawns a replacement java process Manager
  // never tracked, cases as waitForExitOrKill's own comment), and this is a force-kill, so
  // there's no reason to wait and see before doing it. Tree-kill on Windows (see
  // killProcessTreeWindows) for the same reason waitForExitOrKill uses it.
  const wrapperPid = entry.process?.pid
  if (wrapperPid) {
    if (platform === 'win32') killProcessTreeWindows(wrapperPid)
    else if (wrapperPid !== entry.pid) killByPid(wrapperPid)
  }
  // A live process's own child.on('exit') handler (registered in startServer) finalizes it
  // once the kill actually takes effect; an adopted one (entry.process === null) has no
  // such handler, so nothing else would ever clear its bookkeeping without this.
  if (!entry.process) finalizeStopped(profileId)
  return getStatus(profileId)
}
