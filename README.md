# Bober Server Manager

A small desktop app (Electron + React + TypeScript) for controlling ARK: Survival Ascended
dedicated servers running on the same machine.

## Features

- **Start / stop / restart / kill** one or more server profiles (each profile is an
  independent ARK:SA server install/instance). Stop and restart send RCON `SaveWorld`,
  wait for its confirmation, then wait another 30s for the save to actually finish being
  written to disk (RCON confirming the command only means ARK accepted it, not that every
  file is done being flushed - sending `DoExit` too soon risks the server exiting
  mid-write and corrupting the save it just claimed to have finished) before finally
  sending `DoExit`; Kill force-terminates the process immediately with no save, for when a
  server is stuck. Each server's card colors these buttons the same way the web dashboard
  does - Start green, Stop red, Restart orange, Update light blue (`--status-updating`,
  the same color the Updating status badge already uses) - plus Kill in its own darker red
  (`--danger-dark`), distinct from Stop's red so the more destructive action doesn't blend
  in with the merely disruptive one; Update sits right before Kill in the button row. The
  status badge tracks the OS process
  (`starting`), the server actually finishing loading - detected by polling its own log
  file (`ShooterGame/Saved/Logs/ShooterGame.log`) for the
  `Server has completed startup and is now advertising for join` line, since ARK's
  dedicated server allocates its own console on Windows instead of writing through the
  standard stdout handle a piped process would normally use - (`running`), and a distinct
  `restarting` phase for the shutdown half of a restart, so it never claims "running"
  before the world has actually loaded or while it's mid-restart.
- **Tolerates a process hand-off without a false "stopped"** — on some ARK builds, the
  dedicated server's OS process exits shortly after finishing startup while the game
  itself keeps running under a different, untracked process; Node correctly reports that
  as "the process we spawned exited", but that's no longer proof the server itself
  stopped. Any exit that wasn't asked for (i.e. not already mid `stopping`/`restarting`) -
  and the same for a monitored pid that `pidusage` can no longer find - is first double
  checked with a few spaced-out RCON round-trips before being believed. If RCON still
  answers, the Manager asks Windows (`netstat -ano`) which pid now owns the server's own
  RCON port - matched by the listening socket's placeholder foreign address
  (`0.0.0.0:0`/`[::]:0`) rather than the State column's text, since that text is localized
  (e.g. `LISTENING` becomes `ÉCOUTE` on a French install) while the address never is -
  and re-attaches full monitoring (CPU/RAM, force-kill) to it, so the switch is invisible in
  the UI. Only if that lookup can't find a match does it fall back to an RCON-only degraded
  mode; even then, the player list keeps refreshing every tick (CPU/RAM hold their last
  known values, since there's no trustworthy pid left to read them from). Only once RCON
  stops answering too does it actually finalize as `stopped`. A deliberate Stop/Restart/Kill
  is unaffected - it already flips the status before touching the process, so seeing it
  exit right after is never treated as unexpected.
- **Survives the Manager closing or crashing** — the server process is spawned detached
  from the app, so it keeps running either way instead of being torn down with it (the
  default on Windows otherwise). Relaunching the Manager re-detects any server that's
  still running (by pid) and picks it back up under management rather than losing track
  of it or letting you start a conflicting second instance.
- **No in-app console/RCON tab** — that live event feed + RCON command box lives only in
  the **web dashboard** (see below), not duplicated in the desktop app's per-server tabs.
  Stop/Restart still use RCON internally (`SaveWorld` before `DoExit`), and the RCON/admin
  password still isn't a field anywhere in this app - it's read live from the server's own
  `GameUserSettings.ini` (`ServerAdminPassword`) every time it's needed, since ARK:SA
  doesn't have a separate concept of an "RCON password". Reading that file strips a
  leading UTF-8 BOM first if present - a BOM (common after the file's been saved/re-saved
  by Notepad or some server panels on Windows) otherwise breaks the ini parser's section
  handling, silently making `ServerAdminPassword` unreadable even though it's right there
  in the file.
- **Mod manager** — a table (Enable/Passive/Dev checkboxes, Mod Name, Mod ID, plus
  reorder/remove) instead of a plain list. Reordering has a one-step ↑/↓ pair plus a ⤒
  button that jumps a mod straight to the top of the list, for a long list where nudging
  one row at a time would take forever. Enable/disable/reorder mod IDs and toggle a Dev
  flag per mod (appends `-dev` to load that mod's in-development build); enabled mods are
  applied via the server's `-mods=` launch flag by default, or `-passivemods=` instead if
  Passive is checked for that mod (ARK:SA's only mod mechanisms - no Steam Workshop, no
  GameUserSettings.ini involvement). Each header checkbox toggles that column for every
  mod at once. Mod Name is a free-text label you type in yourself, not looked up
  automatically. The app never touches your `.ini` files — edit those yourself.
  A **Copy / Paste Mod List** section below the table shares the whole list (ids, names,
  enabled/passive/dev flags, and order) as plain JSON text - **Copy mod list to clipboard**
  puts it on the clipboard directly (no save-file dialog), and pasting a previously copied
  list into the text box below and clicking **Import pasted list** replaces the table in
  the editor with it, then auto-saves like any other edit here (see below). Handy for
  sharing a modpack setup between servers without leaving a file on disk to clean up
  afterward.
- **Backups tab** — backup directory (folder picker or typed by hand, both save
  immediately - see below), max backups to keep, and scheduled
  automatic backups (gated behind an explicit enable/disable toggle, not just an
  empty/filled cron field) live here, instead of being split off into Settings. The
  scheduled task itself only actually runs while the server is online - not just skipped
  at fire time, but off entirely while the server is stopped: enabling the schedule (or
  saving the profile with it already on) only arms it if the server happens to be running
  at that moment, and it's armed/disarmed live from then on as the server actually
  starts/stops, not just at save time - so it never sits ticking away in the background,
  or shows as **Started** in the Analytics tab's Backup task status, for a server that's
  offline. This also means a scheduled tick can only ever fire while the server is
  running, but the fire-time "skip if not running" check (logged to the Backup Process Log
  below like any other cancellation) stays in place as a defensive fallback for the
  narrow race of the server stopping in the instant between the schedule arming and that
  exact tick firing. **Create backup now** is different: it's a deliberate one-off click, so it
  works whether the server is running or stopped. While it's running, a backup (manual or
  scheduled) requires a confirmed save first: it sends `SaveGame` (RCON `SaveWorld`) and
  cancels outright - no zip created - if that command doesn't confirm, rather than backing
  up a possibly-stale or mid-write state. Once confirmed, it waits 40s before actually
  reading the save files - RCON confirming the command only means ARK accepted it, not
  that every file under `SavedArks` has finished being written, and zipping too soon risks
  reading a file mid-write, which can crash the server (a locked, still-open file) as well
  as produce a corrupt backup. While the server is stopped, none of that applies - nothing
  is writing to those files, so **Create backup now** zips them as-is immediately,
  skipping SaveGame and the wait entirely. After that (or immediately, when stopped),
  every file directly under `SavedArks/<Map>` is added to
  the zip one by one, skipping `.arkrbf` rollback files and ARK's own periodic native
  backups (named like `Extinction_WP_29.07.2026_20.00.01.ark` - a timestamp suffix the
  main save file itself never has, so `<Map>.ark` is always kept regardless) since this
  app's own backups already cover that. Compression uses a moderate level (not maximum)
  - large save files barely compress any smaller at max effort, but cost much more CPU
  getting there, and that CPU spike was making the whole Manager appear
  frozen ("Not Responding") while a big backup zipped. The backup file
  list is a checkbox-select table (File Name/Creation
  Time, with a header checkbox to select/deselect all) with a toolbar above it - Refresh
  backup file list, Open backup folder (opens the configured backup directory in the OS
  file explorer), Restore selected backup, Delete selected backup(s) - instead of a
  Restore/Delete button pair per row. Multiple backups can be checked at once to delete
  them together; Restore only enables when exactly one is checked, since restoring more
  than one at a time isn't meaningful. Restore also requires the server to be stopped
  first (same rule as Profile Copy/Move) - extracting a backup straight into a live
  `SavedArks` overwrites save files the server may have open or be mid-write to, which
  only surfaces as a crash on the next restart rather than an error at restore time. The
  list also reloads itself automatically - both
  when a scheduled/cron backup completes in the background (the main process pushes a
  `backup:created` event for the tab to pick up, so you don't have to click Refresh to see
  it) and right after saving a changed backup directory in this tab, so switching folders
  immediately shows that folder's contents instead of the previous one's. A **Backup
  Process Log** panel alongside it traces every backup's SaveGame → 40s settle → zip
  sequence as it happens - both what's sent/confirmed and any cancellation/error - live,
  so a scheduled backup nobody's watching happen isn't a black box; kept in memory only
  (cleared on Manager restart), last 200 entries per profile.
- **Per-player profile backups** — tails the server's own `ShooterGame.log` for join/leave
  lines (e.g. `LeRaptorSauvage [UniqueNetId:0002dbe9... Platform:None] joined this ARK!`)
  rather than polling RCON, and zips up that player's `<UniqueNetId>.profilebak` file from
  `SavedArks/<map>` (ARK:SA writes this itself, right around both connect and disconnect -
  it's the same content as `.arkprofile` under a different extension, so reading it means
  never having to guess/wait for the live `.arkprofile` to be rewritten) into
  `PlayerBackups/<player>_<id>/` under the backup directory as a small `.zip`, timestamped
  and tagged `_joined`/`_left`, with the `.arkprofile` extension restored on the entry
  inside so it drops back in cleanly if ever extracted. Configured from its own **Player
  Profile Backups** block in the Backups tab, shown side-by-side with the World Backups
  settings block - an enable/disable checkbox (off by default) and a "Backups to keep per
  player" count (default 20, pruning older ones automatically). Toggling the checkbox
  takes effect immediately on an already-running server, not just on its next restart -
  saving the profile re-evaluates the watch right away instead of requiring a Stop/Start.
  The resulting snapshots are managed from a matching **Player Profile Backups** list
  block below (side-by-side with the world backup list) - a player dropdown (with its own
  Refresh) picks whose folder to browse, then the same checkbox-select table/toolbar as
  the world backups (Refresh backup file list, Open backup folder, Restore selected
  backup, Delete selected backup(s)) operates on that player's snapshots specifically.
- **Monitoring** — CPU/RAM usage and connected player count while a server is running. On
  Windows this reads through `src/main/lib/processStats.ts`, not
  [`pidusage`](https://www.npmjs.com/package/pidusage) - both of pidusage's own Windows
  backends proved unreliable in practice: its `wmic` path breaks outright on the growing
  number of Windows installs that have removed `wmic.exe` by default (and its `4.x`
  PowerShell fallback for exactly that case doesn't reliably trigger in this app's
  Electron/Node environment - a missing `wmic.exe` still surfaces as a raw `ENOENT`), and
  its PowerShell fallback itself invokes `powershell.exe` without `-NoProfile`, so on a
  machine where the user's own PowerShell profile script can't load (script execution
  disabled by policy, observed in practice) every reading fails with a PSSecurityException
  before the actual query ever runs. `processStats.ts` shells out to PowerShell's
  `Get-Process` directly instead, with `-NoProfile -ExecutionPolicy Bypass` (scoped to that
  one process, not a system-wide policy change) and explicit invariant-culture number
  parsing (a plain `.ToString()` would print a comma decimal separator on a
  French/European-locale Windows install). If a CPU/RAM reading still fails for any other
  reason, the Analytics tab's Server Status block shows "Unavailable" (hover, or the error
  line right below the grid, for the raw OS error) instead of just a bare `-`, so a
  persistent failure is diagnosable from the UI alone rather than needing the Manager's own
  console output.
- **Dashboard** — server cards can be dragged (via the ⠿ handle) into any order you like;
  the order is persisted and stays the same next time you open the app. A **Hide**/**Unhide**
  button on each card removes it from the main grid and the "...All" bulk actions without
  deleting it or touching whatever server process is actually running underneath - just a
  way to declutter the dashboard for a profile you're not actively using right now. Hidden
  profiles collapse into a "Hidden servers (N)" section at the bottom (collapsed by
  default) where they're still fully functional - Start/Stop/RCON/etc. all still work
  there - so unhiding one is a single click away. Separately, a **Dashboard group** field
  in each server's Settings ("Extra Settings" section) collects every profile sharing the
  same group name into its own collapsible section (expanded by default) instead of the
  main grid - handy for a cluster or a set of related test servers. A profile can be
  hidden and grouped independently; hidden always wins (it goes to the Hidden section
  regardless of its group). Each card also shows a **Version** field (the same Game
  Version as the Analytics tab, e.g. "92.28") - reads whatever's already known when the
  dashboard loads and shows "-" if nothing's been detected yet for that server (it doesn't
  actively poll/"Detect" here the way the Analytics tab does). The Map/Port/Version/
  Players/CPU/RAM fields sit in their own slightly darker inset panel within the card
  (rather than blending into the card's own background). The card is wide enough (380px
  max, up from the original 340px) that Start/Stop/Restart/Update/Kill all fit on one row
  instead of Update wrapping onto its own line - that row's buttons use tighter padding/
  font-size than buttons elsewhere so the row still fits at that width - with Manage/Hide/
  Delete on a second row below.
- **No native File/Edit/View/Window/Help menu bar** — this app never intentionally set one
  up; `Menu.setApplicationMenu(null)` (`src/main/index.ts`) removes Electron's unused
  default instead of leaving it to show up unasked for.
- **Sidebar / Cluster Dashboard page** — a left sidebar (`src/renderer/src/App.tsx`) with
  three entries, **Dashboard** (the page described above), **Cluster Dashboard**, and **Log**
  (see "Manager Log" below), shown whenever you're not inside a server's own tabs or one of
  the settings screens. Cluster Dashboard shows
  one row per **Dashboard group** (same grouping/ordering as the Dashboard's collapsible
  sections, hidden servers excluded, an "Ungrouped" row for anything with no group) with
  that group's servers summed together: how many are running out of the group's total,
  combined CPU %, combined memory (MB), and combined connected players out of the group's
  combined configured max. A stopped server contributes nothing to the numeric totals (its
  telemetry is stale/absent) but still counts toward the server total, so the totals always
  reflect what's actually running right now rather than what's configured. This reads the
  Manager's own dashboard `group` field - unrelated to ARK's own multiplayer clustering
  (`clusterId`/`clusterEnabled` in a profile's Settings), which is a completely separate,
  game-level feature. Each row also gets a **Server Statistics** chart identical in
  behavior to the per-server Analytics tab's (same sparklines, same hover tooltip, same
  gap-breaking) fed that group's *persisted* history summed across its servers -
  `src/main/lib/statsHistory.ts`'s `readClusterStatsHistory`, the same query the web
  dashboard's own Cluster Dashboard chart uses - rather than the group's own separate
  client-side sampling; only servers with stats enabled (Analytics tab) contribute to a
  group's chart, and a group with none of its servers opted in simply shows no chart. When
  some but not all of a group's currently-running servers have it on, a note above the chart
  spells out how many of the running servers it actually reflects - otherwise the chart (and
  the bold current-value numbers above each of its sparklines, which are simply that
  history's own last point) reading noticeably lower than the live CPU/Memory/Players totals
  in the row's own header looks like a bug rather than the servers that just aren't opted in. A
  single **Time Scale** selector at the top of the page (**1m/5m/15m/1h/6h/12h/24h/All**, same
  options and same main-process downsampling as the per-server chart) applies to every
  group's chart at once and re-queries every group when changed. A group with no history
  in the selected window (nothing enabled, or a fully-stopped group with nothing recorded
  recently) shows no chart at all rather than a flat line of zeroes. Every group is queried
  in a single IPC round trip (`statsHistory.getForGroups`) that reads and parses the shared
  stats-history file exactly once no matter how many groups exist, rather than once per
  group - that file can grow up to `AppSettings.statsHistoryMaxSizeMB` (1GB by default), and
  re-parsing all of it from scratch for every single group on every 5-second poll multiplied
  that cost by the group count for no reason. The parsed result is also cached in memory
  (`src/main/lib/statsHistory.ts`) and kept in sync incrementally as new samples are
  recorded, rather than re-reading the file from disk on every poll while any stats view
  stays open - that read is synchronous and runs on the same thread as every other Electron
  main-process job (IPC, window events, all of it), so repeating it every 5 seconds for a
  large file stalled the whole app noticeably each time, not just the chart. Only the very
  first read after the Manager starts still pays that one-time cost; every poll after that is
  an in-memory slice. Finding the earliest recorded sample for the
  **All** scale (`sinceMs === null`) is a plain loop rather than
  `Math.min(...samples.map(...))` - spreading every element as its own function argument
  throws "Maximum call stack size exceeded" once there are roughly 65k-130k of them
  (engine-dependent), and a single profile with stats enabled reaches six figures of recorded
  samples within days at one sample per ~5s. That crash was silent (an unhandled rejection in
  the renderer), so **All** could fail on every single poll indefinitely - only querying a
  narrower time scale (a concrete `sinceMs`, which skips that code path entirely) would ever
  get a chart to appear at all once a group's history grew large enough to trigger it. Each
  group's own combine pass (`readClusterStatsHistory`) drops its newest time bucket whenever
  it has contributions from fewer servers than the
  bucket right before it - each server's own stats-recording tick fires on an independent
  timer, so the very latest bucket can otherwise be read before every currently-running
  server has landed a sample in it yet, understating the combined total and showing a
  misleading dip right at the chart's leading edge (and in the bold current-value number
  above each sparkline, which is simply that history's own last point) until the next poll
  catches it up. A settled bucket further back is never dropped this way, so a genuine drop
  (a server actually stopping) still shows up normally.

  Clicking anywhere on a row other than its chart opens that group's **Group Console**,
  filling the full page: a live log feed merging every server in the group into one
  chronological view, each line tagged with a turquoise `[Server Name]` prefix - same
  visual language (checkboxes to show/hide event categories:
  JOIN/LEFT/CHAT/WARN/KILL/TAME/CMD/SAVE/CRYO/MISSION/READY, colored labels) as the
  standalone web dashboard's own console, but merging every server in the group instead of
  showing just one, plus three categories the web dashboard doesn't have: **START**,
  **STOP**, and **UPDATE**, synthetic lines this page injects itself (not parsed from the
  log - there's no log line for "the Manager noticed this server is now
  running/stopped/updated") whenever a server's live status actually transitions, colored
  green/red/blue - the line has no visible label tag (unlike every other category), it's
  just the colored "&lt;name&gt; started"/"&lt;name&gt; stopped"/"&lt;name&gt; updated" text,
  though the label still exists under the hood for the Show filter checkboxes above. A
  server going 'updating' -> 'stopped' (a plain Update that wasn't paired with a restart)
  logs as UPDATE rather than STOP - without that distinction it would misleadingly look like
  the server stopped twice in a row (once for the STOP that may have preceded the update,
  once more when the update itself finished). Its filter checkboxes are independent of the web dashboard's own
  persisted per-label setting (toggling one here doesn't affect the other) and, unlike that
  setting, persist across sessions on their own. An **Auto-scroll** checkbox sits alongside
  the Show filters (unchecked by default) - only when checked does a new event jump the feed
  to the bottom; otherwise it appends silently wherever you've scrolled to. Either way,
  opening the console always jumps to the latest entry in the backlog first - Auto-scroll
  only decides what happens once new events start arriving live. Events are merged by their actual log date
  plus time, not time-of-day alone - a single server's backlog can itself span more than a
  day, so HH:MM:SS by itself isn't enough to correctly order events from multiple servers'
  backlogs together. Only servers that are actually running get their new events tailed
  live - the main process starts/stops each server's own tailer in real time as it starts
  or stops while the console page is open (`src/main/lib/groupConsole.ts`, one
  `watchLogFile` per running server in the group, the same primitive every other
  log-following feature in this app already uses concurrently); a stopped server's older
  history still shows up in the initial backlog, it just stops growing. Navigating back
  stops every tailer still active for that group. That initial backlog survives a server
  restart too, not just a stop: independently of the console page being open at all,
  `src/main/lib/clusterLogArchive.ts` continuously parses every running server's log growth
  (for as long as it's running, wired off the same status events as everything else) the same
  way the live tailer above already does, and appends only the resulting displayable events
  (one per line, as JSON) to a permanent per-server archive file under the Manager's data
  folder, separate from ARK's own `ShooterGame.log` (which a server restart truncates back to
  empty for the new session). Everything `parseLogLine` itself treats as internal engine
  noise for display purposes - the bulk of the raw file - never reaches the archive either;
  there's no reason to spend archive space (or read time later) on a line nothing would ever
  show. The backlog above reads from that archive instead of the live log whenever one
  exists, so it can show history from before the server's last restart - the live log is only
  a fallback for a profile that's never been archived yet (a fresh install, or one that
  simply hasn't started since this existed). The archive is a rolling window rather than
  growing forever: each server has its own **Max archive size (MB)** setting (Server
  Management tab, 1-100, default 10) past which the oldest events are trimmed automatically,
  always on with no separate enable toggle - this is passive background logging, not an
  automated action. The same **START**/**STOP**/**UPDATE** events the live Group Console
  injects for itself (see below) are also archived directly by the main process the moment
  they happen - `handleStatusForClusterLogArchiveNotification`, wired off the same status
  events as the tailer above, with its own copy of the same 'updating' -> 'stopped'
  exception (an update finishing without a restart archives as UPDATE, not a second STOP) -
  so a Start/Stop/Restart/Update shows up in a *future* backlog even if no console was open
  to see it live and even across a Manager restart, independent of the renderer's
  own copy of this logic.

  Each log line also shows its date as
  **DD/MM** next to the HH:MM:SS timestamp (derived from ARK's own "YYYY.MM.DD" log date,
  the same field the merge/sort already relies on), since a merged multi-server feed can
  span more than one day. Below the log feed sits an **RCON command bar**: a target
  selector listing every server in the group plus an **ALL** option, a text field for the
  command, and a Send button - sending to ALL fans the same command out to every server in
  the group at once (one `sendRconCommand` call per server, same non-throwing
  `{ ok, response/error }` result as everywhere else RCON is used in this app) and shows
  each server's individual result above the bar.

  A vertical divider separates the log/RCON column from a right-hand **sidebar**. At the
  top of the sidebar, a cluster summary shows how many of the group's servers are online
  (with the offline count in parentheses), total connected players, and total CPU%/RAM
  summed across whichever servers are currently running - the same aggregation the Cluster
  Dashboard row above already computes for its chart. Below that, one card per server shows
  its live status badge, Game Version, connected/max players, and CPU%/RAM - the same fields
  and `badge badge-<state>` styling as the Dashboard's own server cards, fed by the same
  `useServerStatuses` live-status hook. Clicking a card opens that server's own profile (same
  place the Dashboard's "Manage" button goes); right-clicking it instead opens a small
  context menu with **Start**, **Stop**, **Restart**, **Update** and **Update Restart** -
  colored the same as the Dashboard's "All" bulk-action buttons (green/red/amber/blue),
  except Update Restart which gets its own cyan to stand out from the plain Update.
  Update is the plain SteamCMD install/update (only while stopped, like the Dashboard's own
  per-server Update button). Update Restart mirrors the Dashboard's "Stop+Update+Restart":
  it stops the server first if it's running, runs the SteamCMD update, then starts it back
  up if it was running before. Whenever a server in the group actually transitions to
  running or stopped (not for the in-between starting/stopping/updating/restarting states),
  the matching START/STOP/UPDATE line described above lands in the log feed - no separate
  toast popup, just that permanent feed entry. Each profile's last-seen status is tracked at
  module scope rather than tied to this page being mounted, so starting or stopping a
  server from the Dashboard while the Group Console isn't open still produces that log line
  the next time you open the console for that group - only each profile's very first status
  observed this session is treated as a baseline, not a transition.
- **Analytics tab** — the first tab on every server, read-only:
  - **Server Status**: one consolidated group with everything at a glance, no explanatory
    text and no sub-headers - just the fields:
    - PID, connected players (X / configured max), CPU usage (%), and Server Memory (MB
      and % of total system RAM) - laid out PID/Players then CPU/Memory so the two live
      resource readings sit next to each other. Uptime (live, ticking every second while
      running) sits further down, next to Next backup in. Uptime survives a Manager
      restart too - the actual start time is persisted alongside the pid it already
      tracks to re-adopt a still-running server, so a re-adopted server shows real
      elapsed uptime instead of losing it.
    - **Game Version**, with the **Installed Build ID** shown in parentheses right next to
      it (e.g. `92.43 (24786897)`). These are two separate numbers under the hood, since
      ARK exposes them differently: Game Version (e.g. "92.28") is the human-readable
      version ARK itself prints, read straight from the "ARK Version: 92.28" line it
      writes to `ShooterGame.log` near the start of boot. (An earlier version of this
      feature tried to read it back from the server's own console window title via
      PowerShell/Win32 APIs instead - that turned out to be unreliable for a server
      adopted after a Manager restart; reading the log line directly sidesteps that.)
      Refreshed by `serverVersionWatcher.ts`, edge-triggered on the server's status
      transitioning into `running`/`starting`/`stopping`/`updating`/`stopped`, plus once
      for every profile when the Manager itself starts. Installed Build ID is the
      SteamCMD-installed build id, read straight from that install's
      `appmanifest_2430930.acf` - blank before the first install. Game Version keeps
      showing the last value read even while the server is stopped (it doesn't change
      between runs, so there's no reason to blank it out) - "Detecting..." only appears
      while running and nothing's been read yet, "Unknown" if it's never been read at all.
    - **Backup task status** always shows one of four states: **Offline** (light red)
      whenever the server itself isn't running, regardless of the schedule - the backup
      task's own "active" flag is about whether its timer is armed, which is unrelated to
      whether the ARK process is currently up, so this avoids implying a backup could fire
      right now when it can't; **Deactivate** (red) when the server is running but the
      backup schedule is disabled in the Backups tab; otherwise **Started**/**Stopped**
      read directly off the same timer that will actually fire the next backup (a single
      self-armed `setTimeout` recomputed via `cron-parser` after every run, rather than a
      background library polling every second). **Next backup in** (a live countdown) only
      appears alongside a genuine Started/Stopped reading.
    - The update-check status line ("No new update available." / "A server update is
      available.") - compares this profile's installed build id against the latest one
      Steam has published, polled every 30 minutes straight from SteamCMD (anonymous
      login, `+app_info_print 2430930`, no download involved). SteamCMD needs to be
      configured in Settings for this to resolve to anything.

    To the right of these fields, separated by a vertical divider, a **File Shortcuts**
    column stacks three buttons vertically, no explanatory text: **INI Config**
    (`ShooterGame/Saved/Config/WindowsServer`, where `GameUserSettings.ini`/`Game.ini`
    live), **Save ARKs** (`ShooterGame/Saved/SavedArks`, the map save data), and
    **Save Game** (`ShooterGame/Saved/SaveGames`, mod-specific persistent data) - all just
    open the OS file explorer at that path, the app never edits anything in them itself.

  - **Config file lock**: `GameUserSettings.ini`/`Game.ini` are set read-only 5 seconds
    after a server starts, and set back to writable 5 seconds after it fully stops
    (`src/main/lib/iniLock.ts`, driven off the same status events described above - the 5s
    margin on both ends gives the ARK process, and the OS's own file handle cleanup, a
    moment of slack around the transition instead of racing it). This is an OS-level
    read-only attribute toggle (`fs.chmod`), so it's respected by Notepad and most editors
    that overwrite a file in place, but not by editors that save via a temp-file-then-rename
    (e.g. VS Code) - it's a deterrent against editing a running server's config by accident,
    not a hard guarantee. Nothing in this app ever writes these files itself, so the lock
    can never block a legitimate in-app write. A quick restart just re-locks the files once
    it's running again rather than briefly unlocking them mid-restart. If the Manager
    crashes or is force-quit while a server was running (and its config was locked), every
    non-running profile's config gets unlocked once at the next Manager startup as a safety
    net, so a crash can't leave the files stuck read-only. Controlled by **Lock config files
    while a server is running** in the app-wide Settings view (on by default) - turning it
    off immediately unlocks every profile's config files, including ones currently running,
    and locking stays off until it's turned back on.
  - **Server Statistics**: three sparkline charts (CPU %, RAM in MB, connected players),
    stacked with no gap between them and the metric name on the left of each row rather
    than above it. An **Enable stats** checkbox (`ServerProfile.statsEnabled`, off by
    default) turns on continuous background sampling for this server: every 5s while it's
    running, `src/main/lib/monitor.ts` records a CPU/RAM/player sample straight to a
    persistent, global history file (`src/main/lib/statsHistory.ts`), independent of
    whether this tab - or the Manager itself - is even open. That's a real behavior change
    from a per-browser-tab feature: history now survives closing the tab, switching
    profiles, and restarting the Manager, and every server sharing this toggle draws from
    one combined disk budget (**Stats history size limit (MB)** and **Stats history
    retention (hours)** in the app-wide Settings view, defaults 1024/1GB and 24h - see
    below) rather than each keeping its own separate quota.
    A **Time Scale** selector (**1m/5m/15m/1h/6h/12h/24h/All**) picks how far back to query -
    "All" means every sample ever recorded for this server, no lower bound. Whichever scale
    is picked, the Analytics tab asks the main process for at most 500 points spanning that
    window; a query covering more raw samples than that gets bucketed and averaged down to
    500 on the main-process side before it's ever sent to the renderer, so switching to
    "All" over weeks of history is never slow to fetch or render just because there's a lot
    of it. The chosen scale is still remembered per server in local storage, so it stays on
    whatever you last picked instead of resetting to the 12h default the next time you open
    the tab. Hovering a row shows a vertical guide line plus a small tooltip with the clock
    time and value of the nearest point. The CPU row's scale adapts to the highest value
    actually seen in the current window (with a small floor so a near-idle server's jitter
    doesn't get blown up to fill the whole row) rather than always spanning a fixed 0-100%
    range, so a server that never spikes past e.g. 40% still uses the chart's full height
    instead of hugging the bottom - RAM already worked this way. Not capped at 100%: CPU
    usage is measured per-process across all cores, so a multi-threaded server can
    legitimately read well above 100%, and every row's points are clamped to stay within
    the chart's own height regardless of scale, so nothing ever draws outside its row. The
    Players row scales the same way, to the highest player count actually seen in the
    window - never to the server's configured max slot count, which against a 70-slot cap
    made 0 vs 1 connected player an invisible 1/70th blip regardless of how full the chart
    otherwise looked. A
    gap large enough to represent several missing points in a row (server stopped for a
    while, stats disabled and re-enabled, ...) - scaled to how far apart points actually are
    at the current resolution, not a fixed threshold, since "All" over weeks and "6h" sample
    at very different granularities - breaks the line into a separate segment instead of
    connecting them with a straight slope, so the chart never draws a misleading diagonal
    bridging two readings that aren't actually part of the same continuous run. Each point
    is placed by its real timestamp within the selected window rather than spaced evenly by
    index, so a window that isn't fully populated yet only draws a line across the portion
    of the chart that has real data instead of stretching a handful of samples across the
    whole width. Deliberately hand-rolled inline SVGs, not a full-page chart library, to
    keep this "a small graph" rather than the whole page. The tab itself just polls its
    query every 5s while open and renders whatever comes back - all the actual sampling
    keeps running in the main process regardless of which tab (if any) is open.
- **Open profiles folder** — a button in the app-wide Settings view opens the folder
  holding this app's own data file (profiles, app settings, which pid belongs to which
  running server): a single `config.json`, written by `electron-store` at Electron's
  standard per-OS user-data location. It's already plain JSON, just one shared file for
  everything rather than one file per profile like an exported profile.
- **Start Manager when you log into Windows** — a checkbox in the app-wide Settings view,
  backed by Electron's own `app.setLoginItemSettings`. Applied both right away when you
  save Settings and again at every app launch, so it stays in sync even if the OS-level
  registration was changed outside the app. Opens the normal window on login (no
  minimized/background mode yet).
- **Delay between auto-started servers** — a number input (seconds, default 10) in the
  app-wide Settings view. Only matters for profiles with "Start this server when the
  Manager starts" enabled (Server Management tab): the delay is waited before starting the
  first such profile too (not just between subsequent ones), giving the Manager's own
  monitoring time to finish initializing first so that server's telemetry is picked up
  correctly from the start instead of racing a start triggered the instant the app launches.
  Each subsequent enabled profile then waits this same delay after the previous one.
- **Manager updates** — a "Check for updates" button in the app-wide Settings view, next
  to the current version. Built on `electron-updater` against this repo's GitHub
  Releases, with live status (checking / downloading with a percentage / up to date /
  error) pushed to the button's status line as it progresses. Checking and downloading
  are automatic, but installing is a deliberate second step: once a download finishes, a
  separate **Restart & install now** button appears - the app never quits and restarts on
  its own, so it can't cut off unsaved changes elsewhere in the app (e.g. a SteamCMD path
  typed but not yet saved) mid-edit. Only works in an installed build (the NSIS installer
  or the portable exe, both produced by `npm run dist`), not when running from source
  with `npm run dev`, since there's no update feed to read from in that case. See
  [Publishing a release](#publishing-a-release) for how a new version actually reaches
  this button.
- **Profile Management** — a dashboard header button opens a dedicated view to **Copy**
  or **Move** an entire server install (every file under its install folder - binaries,
  saves, configs, all of it) to a different folder:
  - **Copy** duplicates it as a brand new, independent profile (fresh id) - the original
    is left untouched.
  - **Move** relocates (and optionally renames) the same profile in place - nothing is
    duplicated.
  Both require the server to be stopped first, reject a destination that already has
  files in it, and reject picking the current install folder as the destination. A move
  tries a plain rename first and only falls back to a real copy-then-delete if that fails
  across drives/filesystems (`EXDEV`). No app restart is needed either way - saving the
  resulting profile goes through the same path as any other Settings change, so its
  backup schedule/watchers etc. get reapplied against the new location automatically.
- **Export / import a profile as a file** — a server's Settings tab has an "Export
  profile..." button that saves its whole config (ports, mods, cluster, extra settings -
  everything except backups/logs) as a JSON file; the dashboard's "Import profile file..."
  button loads one back in as a new profile (a fresh id, deduplicated name if it collides
  with an existing one, and run through the same migration as profiles loaded from the
  store, so a file exported by an older version of the app still imports cleanly).
- **Server Controls** — bulk actions across every profile at once: Start All, Restart All,
  and Stop All only touch the profiles actually in the relevant state (e.g. Restart All
  skips already-stopped servers). Update All updates every stopped server in parallel
  (each is a separate anonymous-login SteamCMD process, so this is safe). Stop+Update+
  Restart All stops whichever servers are currently running, updates every profile, then
  starts back up only the ones that were running beforehand. Each server's "View update
  log" button shows the last SteamCMD run's output (logged to
  `logs/steamcmd-update-<profileId>.log` inside the "Data files location", see Settings
  below), so an update failure is
  diagnosable instead of just a raw exit code. SteamCMD's own piped console output is
  known to be unreliable on Windows and often carries nothing useful, so this log also
  includes whatever SteamCMD wrote to its own `logs/content_log.txt` (next to the
  SteamCMD executable) during that run. Before each update, a stuck
  `steamapps/appmanifest_2430930.acf` (SteamCMD's documented "StateFlags 6" state - it
  otherwise makes every later attempt fail instantly with the same error, regardless of
  whether the original problem is still there) is detected and deleted automatically so
  the update can actually run. After the run, the manifest is also checked to decide
  success/failure alongside the process's own exit code - SteamCMD can relaunch itself
  mid-run to self-update, and the originally spawned process (the one whose exit code gets
  tracked) can then exit with a stale/misleading non-zero code even though the whole chain
  went on to complete successfully afterwards; if the manifest shows no update pending,
  that's treated as success regardless. If the configured SteamCMD path no longer points
  at an actual executable (e.g. a packaged build's managed SteamCMD copy got wiped by
  reinstalling/updating the Manager itself), Update fails immediately with a clear
  "SteamCMD not found at ..." message instead of a raw `ENOENT` - reinstall or re-point
  SteamCMD via the SteamCMD menu to fix it.
- **Add firewall rule for SteamCMD** (SteamCMD menu, Windows only) — adds Windows Firewall
  allow rules (inbound + outbound) for whichever `steamcmd.exe` is configured above, useful
  if update failures turn out to be network-related. Prompts once for admin rights (UAC)
  just for that action - the app itself keeps running unelevated the rest of the time.
- **Global Performance** (dashboard sidebar, above Official Server Status) — a compact stats card
  showing totals across every visible (non-hidden) server: **Servers running** (with the
  total server count alongside it), **Players**, **CPU**, and **RAM** - the same
  `useServerStatuses` live-status data every server card already renders, just summed
  client-side rather than a new backend aggregation. Reuses the Group Console's own
  `.group-console-cluster-stats` grid styling, so it reads as the same kind of summary box
  rather than a bespoke widget. Updates live as server statuses change, same as everything
  else fed by that hook.
- **Official Server Status** (dashboard sidebar) — fetches Wildcard's official ARK:SA
  server status feed (`https://cdn2.arkdedicated.com/asa/officialserverstatus.ini`).
  Despite the `.ini` extension, the file isn't key/value INI - it's a single line like
  `ARK Official Server Network Status: <RichColor Color="0, 1, 0, 1">Online (v92.25)</>`,
  which is parsed with a dedicated regex into a label, status, version, and the
  `RichColor` (four 0-1 floats, Unreal Engine's usual color format) converted into a CSS
  `rgb()`/`rgba()` color, then shown as "Official Server Network Status : Online
  (92.25)" in that color. A Refresh button re-fetches on demand.
- **Settings** (dashboard) — laid out as a few labeled cards (Data & Storage, Startup &
  Safety, Web Dashboard, ...) that wrap across the window instead of one long column of
  unrelated fields, same treatment as the per-server Settings/Server Management tabs
  (`.app-settings-view` in `styles.css`). Lets you override the "Data files location"
  (default:
  Documents/ARK Server Manager), the folder `maps.json`, `customMaps.json`, the managed
  SteamCMD install, per-profile update logs, and any future editable/generated files live
  in. Changing it only affects where the app looks going forward - it doesn't move
  existing files to the new folder for you. A **Stats history size limit (MB)** field
  (default 1024 / 1GB) caps the combined size of every server's persisted CPU/RAM/player
  history (`src/main/lib/statsHistory.ts`, see Analytics tab below) - one shared budget
  across every server with stats collection enabled, not a per-server quota; the oldest
  samples, from whichever server they belong to, are trimmed first once it's exceeded.
  Alongside it, a **Stats history retention (hours)** field (`AppSettings.statsHistoryMaxAgeHours`,
  default 24) independently drops any sample older than that many hours regardless of how
  much of the size budget above is still free - this is what actually bounds how much a
  long-running Manager ever has to read and parse to answer a stats query, since the size
  cap alone still lets the file (and the in-memory cache mirroring it) grow arbitrarily
  large if nothing ever collects enough data to hit it. The check only runs at most once
  every 5 minutes (and only once something has actually been read into memory), so it
  doesn't rewrite the file on every single sample. Set it to 0 to disable age-based
  trimming and fall back to the size cap alone. The app-wide Settings screen itself is
  organized into four sub-tabs - **General** (Data & Storage, Startup & Safety), **Web
  Dashboard**, **Access Tokens** (both the access token and API key lists, described below),
  and **Updates** - rather than one long scrolling page, so a specific setting is a click
  away instead of a scroll. This is also where the **web dashboard** is
  enabled - the only place in this app for a live console feed and RCON, on purpose (the
  desktop app itself has no console/RCON tab). It's a plain HTTP server built into the
  Manager (no separate process), serving a page with a sidebar that starts with, in order,
  **Dashboard** (admin-tier tokens only - see roles below) and **Cluster Dashboard** - the
  latter is the main/landing view every page load opens on, with nothing else in the
  sidebar yet besides Dashboard. **Dashboard** replicates the desktop Manager's own
  Dashboard page as a card grid, grouped the same way (ungrouped servers first, then each
  Dashboard group as its own labeled section) - each card shows State/Version/Players/CPU/
  RAM and the same Start/Stop/Restart/Update/Update Restart action menu (the "⋮" button) as
  the mobile Group Console's own cards below, but no **Manage** button - clicking a card
  (outside that menu) selects that server and jumps straight to its Console, exactly like
  tapping a mobile Group Console card already does. It's built from the exact same
  `buildServerCardMobile` card renderer as that mobile view, just laid out as a responsive
  grid instead of one mobile column. A single separator, then one flat group of eight
  per-server tabs, in this order - **Console**, **Analytics**, **Settings**, **Mods**,
  **Backup**, **Map Management**, **Server Management**, **Update Log** - only appears in
  the sidebar once a server has actually been clicked (a card inside a group's mobile Group
  Console, the Dashboard tab above, or any of these eight tabs' own server picker, top-right
  of the header, once one of them is reachable some other way). Of those eight, **Settings**,
  **Mods**, **Map Management**, and **Update Log** additionally require the connecting
  token/key to be role `admin` or `globalAdmin` (or no login requirement at all, in which
  case every route is effectively `globalAdmin`) - see **Access tokens** further below for
  what each of the four roles can reach. **Server Management** requires `moderator`
  or higher (a narrower tier than the other four admin-only tabs) through its own dedicated
  `GET`/`POST /api/servers/:id/servermanagement` route - a whitelist of just the fields that
  tab edits, never the rest of the profile the admin-only `/profile` route exposes.
  **Console**, **Analytics**, and **Backup** stay available to any role, same as before. This
  is a deliberate gate, not just a first-load default: a plain `selectView('console')` call
  still works even while its nav button is hidden (so drilling in via a card always works),
  but nothing pre-selects a server on load the way earlier versions of this page did - every
  one of these views starts genuinely empty until you choose a server yourself. These eight
  tabs are only ever in the sidebar while you're actually looking at one of them - navigating
  back to **Dashboard** or **Cluster Dashboard** hides them again rather than leaving them
  parked in the sidebar for the rest of the page's session, so those two overview tabs stay
  focused on servers in general rather than whichever one you last drilled into. Clicking a
  card again (from either overview) reselects that server and reveals the eight tabs once
  more, landing on Console. Losing the currently-selected server out from under you (e.g.
  that profile gets deleted) falls back to Cluster Dashboard the same way, which also hides
  the tabs. Every one of the eight tabs carries an
  identical **server picker** dropdown at the top-right of its own header (`.server-picker` -
  `margin-left: auto` pushes it to the far right of the flex header row), listing every
  server by plain name only (no "(running)"/state suffix cluttering it up - that's what each
  tab's own content already shows), grouped into `<optgroup>`s by Dashboard group exactly
  like the Settings tab's own Map dropdown groups Official/Custom maps - ungrouped servers
  listed bare above the first optgroup, each group's servers in the same order the desktop
  dashboard shows them in. Switching it on any one of the eight instantly switches all the
  others to the same server too (`syncServerPickers`), so hopping from, say, Analytics
  straight to that same server's Mods tab, or over to a completely different server's
  Settings, never requires detouring back through Cluster Dashboard first:
  - **Cluster Dashboard** - a mobile-adapted version of the desktop Manager's own Cluster
    Dashboard page, not just a per-server card grid: one summary row per Dashboard group
    (ungrouped servers get their own "Ungrouped" row), same shape as the desktop version -
    how many of the group's servers are online (offline count in parens, green), combined
    players/max, combined CPU%, combined RAM - computed client-side from the same
    `/api/servers` poll the Console view already uses, no separate request. Hidden
    profiles never appear here, same as everywhere else in this page. On a screen at least
    701px wide (the same breakpoint the rest of this page's mobile layout switches on), each
    row with at least one server online also gets the same **Server Statistics** chart as
    the desktop Manager's own Cluster Dashboard - CPU/RAM/Players sparklines with a
    **Time Scale** selector (**1m/5m/15m/1h/6h/12h/24h/All**) above the cards and a hover tooltip on each
    chart, built from the same SVG-path math (`sparkline.ts`/`ServerStatsChart.tsx`)
    reimplemented in this page's own vanilla JS. Unlike the mobile layout's other data, the
    chart's history isn't sampled or accumulated in the browser at all - it's fetched from
    the same persistent, main-process stats store the desktop Manager itself records to
    (`GET /api/groups/:group/stats`, backed by `src/main/lib/statsHistory.ts`), once per
    group per poll (every 5s), server-downsampled to at most 500 points regardless of the
    selected scale. That means every viewer of this page, and the desktop Manager, all see
    the exact same recorded history - not a separate per-browser copy - and only servers
    with stats collection enabled (the Analytics tab's toggle) contribute to a group's chart.
    Only the selected time scale itself is remembered in this browser's `localStorage`. Each
    poll updates a row's numbers and chart in place (existing text/SVG elements, not a torn
    down and rebuilt card) - rebuilding the whole card list from scratch every 5s used to
    blank each card for the moment between that rebuild and the chart's own re-fetch
    resolving, a distracting flicker even though nothing had actually changed.
    Narrower than 701px, the chart and time-scale selector don't render at all, keeping the
    mobile layout to the plain numeric totals. Tapping a row (outside the chart, which has its own click
    handler so it doesn't also trigger this) drills into that group's own **mobile Group
    Console**, which mirrors the desktop Manager's Group Console feature-for-feature:
    - A merged, chronological log feed across every server in the group, each line tagged
      `[Server Name]` in the same turquoise as the desktop Group Console (with a space
      before whatever follows it - label or, for the label-less START/STOP lines described
      below, straight into the text), backed by two new endpoints -
      `GET /api/groups/:group/events` (the merged backlog, reusing
      `src/main/lib/groupConsole.ts`'s `getGroupConsoleBacklog`) and
      `GET /api/groups/:group/events/stream` (the live merged tail, reusing that same file's
      `watchGroupConsole` - one `watchLogFile` per running server in the group, exactly like
      the desktop Group Console's own IPC channel, just reached over HTTP/SSE instead).
      Ungrouped is addressed as the literal path segment `_ungrouped_` (an actual empty
      segment invites double-slash URL edge cases). Each line shows its date as **DD/MM**
      next to the timestamp, same as the desktop version, since a merged feed can span more
      than a day. On a phone, the feed's text drops to the same smaller size the
      single-server Console view's own console already uses below 700px, so more history
      fits without either view feeling inconsistent.
    - A "Show:" row of checkboxes (persisted in this device's `localStorage`, independent of
      the page's own admin-controlled per-label setting) includes three categories no real
      log line produces - **START**, **STOP**, and **UPDATE** - synthetic lines this page
      injects itself the moment a group member's live status actually transitions to
      running/stopped, colored green/red/blue, with no visible label tag (just the colored
      text) though the label still exists for the filter checkboxes. A plain Update finishing
      (no restart) goes 'updating' -> 'stopped' and logs as UPDATE rather than STOP, so it
      doesn't read as the server stopping twice in a row. A **Show ▾** button next to the group name
      collapses/expands the whole checkbox row - same collapse-to-`localStorage` pattern as
      the single-server Console view's own **Events ▾** toggle, independent key so
      collapsing one doesn't affect the other. That same row ends with an **Auto-scroll**
      checkbox (unchecked by default, persisted the same way) - only when checked does a new
      merged event jump the feed to the bottom; opening the group console always jumps to the
      latest backlog entry first regardless.
    - Whenever any server's status transitions to running or stopped - not just a member of
      the currently-open group, and not for the in-between
      starting/stopping/updating/restarting states - a toast pops (green "started" / red
      "stopped" / blue "updated"), and if that server belongs to the group whose console is
      currently open, the matching START/STOP/UPDATE line lands in its feed at the same
      moment. Each server's
      last-seen state is tracked for as long as the tab stays open (not tied to which view
      is active), so a transition that happens while you're looking at a different tab still
      gets caught the moment you look back.
    - A compact aggregate stats box below the header (online/offline, players, CPU, RAM -
      the same numbers as that group's row on the list above); smaller padding and text on a
      phone, where screen space is tighter, than on desktop.
    - The feed and RCON bar sit in the same `.panel.console-panel`/`.content-row`/`.side-col`
      layout the single-server Console view already uses: a wide console column that
      actually gets the room (flex-grown to fill the available height on desktop, a fixed
      generous fraction of the screen on mobile, same as that view), next to a **Servers ▾**
      column of one card per server (live status badge, Game Version, players/max, CPU/RAM)
      - collapsible on both desktop and mobile via the header button, same
      collapse-to-`localStorage` mechanism as the filters toggle and the single-server
      view's own **Status ▾** column toggle, so the console can have the whole width to
      itself when you don't need the per-server detail. On desktop this reproduces the
      Manager's own Group Console shape (console on the left, a divider, server info on the
      right); on mobile the column stacks below the console instead, same responsive
      behavior the single-server Console view already has for its own side column.
      Tapping a card opens that server's own Console view (same place the row's click used
      to go before this feature); tapping the **⋮** button on a card instead opens a small
      action sheet - **Start**, **Stop**, **Restart**, **Update**, and **Update Restart**,
      the same five actions, enabled/disabled rules, and color coding (green/red/amber/blue/
      cyan) as the desktop Manager's own Group Console context menu - reusing the exact
      same `/api/servers/:id/start|stop|restart|update|stop-update-restart` routes the
      single-server Console view's own buttons already call. There's no right-click on a
      phone, so a button is the mobile equivalent; the sheet is positioned from wherever
      that button is, clamped to stay within the screen so a card near the bottom edge never
      opens a menu that's partly or fully unreachable (`position: fixed` doesn't respond to
      page scroll, so an unclamped menu could otherwise land below the visible viewport with
      no way to reach it).
    - An RCON command bar below the feed, inside the same console column: a target dropdown
      (every server in the group, plus an **ALL** option) and a text field - sending to ALL
      fans the same command out to every server in the group at once (one
      `/api/servers/:id/rcon` call per server, same as the desktop version's fan-out), with
      each server's individual result shown above the bar.
  - **Console** - the per-server console/RCON view (what this page originally was, and what
    the sidebar button used to be labeled **Dashboard** - renamed since "Dashboard" already
    means the desktop app's own main page, and this view has nothing to do with that one).
    Still reachable directly once a server is selected, just no longer the tab this page
    opens on. Its Status box shows **State** as the same colored
    pill badge as the Group Console's own server cards instead of plain text, plus **Version** (the
    Game Version, e.g. "92.28") alongside Players/CPU/RAM - both boxes pull from the same
    `/api/servers` response, so they always agree. Its server picker (top-right of the
    header, listing profiles in the same order as the desktop dashboard and grouped into
    `<optgroup>`s the same way - ungrouped first in their reordered position, then each group
    alphabetically, leaving out anything marked **Hidden** - options show the plain server
    name only, no "(running)"/state suffix, since every tab that has one already shows state
    some other way) is the same shared `.server-picker` every one of the eight per-server
    tabs carries, not something unique to this view.
  - A live, color-coded event feed - only the event label is colored (plus the player's
    name specifically for JOIN/LEFT), not the whole line. It tails the server's
    `ShooterGame.log` file directly on every page load/reconnect (the same per-connection
    approach the standalone Python dashboard this replaces used), classifying each
    interesting line into JOIN/LEFT/CHAT/CMD (admin commands)/WARN (structure
    destroyed)/KILL/TAME/SAVE/CRYO (freeze)/MISSION/READY and filtering out the engine's
    internal noise - independent of whether the Manager's own process tracking currently
    considers that server running. A "Show:" row of checkboxes lets you hide individual
    categories from the feed; this is server-side and persisted, applied to the backlog
    and the live stream alike, so a disabled category is simply never sent to the
    browser. That row also ends with an **Auto-scroll** checkbox (client-side only,
    unchecked by default) - only when checked does a new event jump the feed to the
    bottom; selecting a server always jumps its console to the latest backlog entry first
    regardless. An **Events** button next to that row collapses/expands the whole checkbox
    row (handy on a small screen); the collapsed/expanded state is remembered in
    `localStorage`. Whenever the Manager (re)starts that server - Start, Restart, or the
    restart step of Stop+Update+Restart, from this page, the desktop app, or a bot calling
    the [API](#web-dashboard-api-for-bots--other-tools) - the feed clears and starts fresh
    for the new session instead of mixing its lines in with the previous one's, since the
    Manager knows the exact moment it spawns a new process for that profile. As a backup
    for a restart the Manager didn't itself trigger, the feed also clears when it notices
    `ShooterGame.log` itself has been replaced (its inode changed, not just its size, so a
    fast restart can't be missed).
  - An RCON command box right below the feed - commands sent and their responses appear
    as entries in that same feed, in order.
  - A small **Status** box in the right-hand column, above the online players panel -
    state, player count, CPU%, and RAM for the selected server, each on its own line
    instead of one long line squeezed into the header (that's what it used to be), followed
    by **Uptime** - live, ticking every second while the server is running, same "0d 2h 3m
    4s" format as the desktop Manager's own Analytics tab, computed from the `startedAt`
    timestamp now included in every `/api/servers` entry; shows "-" when the server isn't
    running. A **Status ▾** button in the header, next to the **Events ▾** filter toggle, collapses/
    expands that whole right-hand column (both boxes together), for more room for the
    console - handy on a small screen; remembered in `localStorage` like the Events
    collapse toggle.
  - An **online players** panel below that, refreshed every few seconds via RCON
    `ListPlayers`. Right-click a player for **Copy ID** (their EOS unique id, to the
    clipboard - falls back to a `document.execCommand`-based copy when the page isn't in
    a secure context, e.g. reached via a LAN IP over plain http, since `navigator.clipboard`
    isn't available there) or **Kick** (red, asks to confirm, then sends RCON
    `KickPlayer <id>`).
  - **Start / Stop / Restart / Stop+Update+Restart** buttons in the header, for the
    currently selected server - the same actions as the desktop app's own per-profile
    buttons and bulk "…All" actions, reusing the exact same underlying logic (both call
    into `src/main/lib/serverActions.ts`, so starting/stopping the CPU/RAM monitor stays
    in sync regardless of which UI triggered it). Buttons enable/disable based on the
    server's current state, same rules as the desktop app (Start only when stopped,
    Stop/Restart only when running, Stop+Update+Restart disabled mid-update). Stop and
    Restart wait only for SaveWorld's RCON outcome before responding (usually a couple of
    seconds) - a toast warns if that couldn't be confirmed - then the rest keeps running
    in the background; Stop+Update+Restart responds immediately once kicked off without
    waiting for any of it, since a SteamCMD update alone can take minutes. Either way the
    button doesn't hang; the Status box and player panel simply update on their next
    poll as the state actually changes (stopping → updating → starting → running). There's also
    a standalone update endpoint (`POST /api/servers/:id/update`, no button on the page
    itself - Stop+Update+Restart already covers the interactive case) meant for external
    automation, e.g. a Discord bot on the same machine calling into this same API - see
    [Web dashboard API](#web-dashboard-api-for-bots--other-tools) below.
  - The selected server is remembered across page reloads (via `localStorage`), so
    reopening or refreshing the dashboard reselects the same server instead of always
    falling back to the first one in the list.
  - Responsive layout below 700px wide (phones/small tablets): the sidebar becomes a
    horizontal bar across the top instead of a left column, and the console and online
    players panels stack vertically instead of side by side, with the console on top and
    the player list below it as a horizontally wrapping row of names instead of a tall
    vertical list. The desktop layout is a fixed-viewport "app" (nothing outside a panel
    scrolls); on mobile the page scrolls normally instead, since a panel that isn't
    explicitly height-capped kept turning out to grow past the screen with nothing able to
    reach the overflow - everything except the console just flows and the page grows to
    fit it. The live console feed keeps a fixed height (55% of the screen's height) so it
    stays a compact, auto-scrolling box instead of growing to fit however many backlog
    lines happen to be loaded - relying on flex-grow to size it dynamically here turned out
    not to reliably bound it on real mobile browsers the way it does on desktop, even
    though it worked in every headless test; an explicit height sidesteps that. Its text is
    also a size smaller there than on desktop, so a long line (a lot of the ARK log's own
    lines run long) wraps across fewer rows and more of the recent history fits in that
    fixed-height box at once.
  - **Analytics** - a **Server Status** box first (State as the same colored pill badge
    used elsewhere/Players/CPU/RAM/Version/Uptime, live-ticking every second off `startedAt`
    exactly like Console's own Status box/Backup task status and Next backup in, reusing the
    exact same `GET /api/servers/:id/backups/status` route the Backup tab itself calls,
    rather than a separate endpoint) - the same fields the desktop Manager's own Analytics
    tab shows under its own "Server Status" heading, minus PID/build ID/the file-shortcut
    buttons/the update-check panel, none of which have a meaningful remote equivalent.
    **Backup task status** is colored the same way as the desktop tab's own field
    (`status-ok`/`status-warn`/`status-offline` - green when a schedule is armed, amber when
    enabled but not currently active, red/muted when the server itself is offline). Below
    that, a **Time Scale** row (1m through All, a separate button set and a separate
    per-profile `localStorage` key from the Cluster Dashboard's, so picking a scale here
    doesn't change what a group's own chart shows) with an **Enable stats collection**
    checkbox to its right (shortened from "Enable stats collection for this server" - the tab
    itself already makes clear which server it's for) - mirrors the desktop Analytics tab's
    own toggle (`ServerProfile.statsEnabled`); unlike that checkbox, toggling it here is
    itself a profile write, so it goes through the same admin-gated `POST
    /api/servers/:id/profile` route as Settings/Mods and is disabled client-side for any role
    below admin (the tab itself stays open to every role, same as Console/Backup - viewing an
    already-enabled server's history, or its Status box, needs no special permission). Below
    that, the same CPU/RAM/Players sparkline chart as the Cluster Dashboard's own per-group
    chart above, just fed one server's own history instead of several summed together -
    literally the same `buildClusterChart`/`buildSparkline` drawing code, reused rather than
    reimplemented. A `GET /api/servers/:id/stats` route (`readonly`, backed by the same
    `readStatsHistory` the desktop Manager's own IPC channel calls) feeds the chart,
    downsampled to the same 500-point budget and polled every 5s while the tab is open. Once
    stats are enabled but no samples exist yet, the chart area shows "Collecting data..." only
    while the server is actually running - a stopped server instead shows "Server isn't
    running - start it to see live stats.", matching the desktop Analytics tab's own
    conditional, rather than perpetually implying data collection is imminent for a server
    that isn't even up.
  - **Backup** - a backup menu matching the desktop app's own Backups tab, always showing
    whichever server its own picker (or any of the other seven tabs' pickers, kept in sync)
    currently has selected - switching servers anywhere, including via a Cluster Dashboard
    card click, updates this view too. A **Backup Settings** section (admin/globalAdmin only
    - hidden entirely for lower roles, same pattern as Settings/Mods) lets an admin token
    edit the backup directory, max backups to keep, the scheduled-backup toggle and its cron
    expression, and the player-profile-backup toggle/per-player retention count, each saving
    immediately on change through the same admin-gated `POST /api/servers/:id/profile` route
    as Settings/Mods - full parity with the desktop tab's own settings form, short of the
    **Browse...** directory picker button (no local file-system dialog to open remotely; type
    the path directly instead). Below that, the same directory/retention/schedule summary
    line as before (now doubling as live confirmation that a setting just saved actually
    took). Every other role sees that summary line only, exactly as before - everything the
    rest of this view's own routes can do is act on backups that already exist
    (create/restore/delete), not reconfigure how they're taken. A **Create backup now** button
    and **Refresh** button sit above a three-column row - matching the desktop Backups tab's
    own World Backups/Player Profile Backups/Backup Process Log layout (45%/30%/25% of the
    row's width, since world backup file names run longer than the other two columns need):
    **World Backups** (file name, size, creation time, each row with its own **Restore** and
    **Delete** actions, both confirming before acting), **Player Profile Backups** (a
    dropdown of every player who has at least one backup, with its own **Refresh** button,
    next to a checkbox-selectable table of that player's backups and **Restore
    selected backup**/**Delete selected backup(s)** buttons above it - restoring or deleting
    a player backup reuses the exact same `/backups/restore`/`/backups/delete` routes as
    World Backups, since both are just a file path to either function), and **Backup Process
    Log** - polling every 5s while this view is active. Restore/Delete on both backup tables
    are admin/globalAdmin only, same as the desktop app's own equivalent actions; every other
    role sees the tables read-only. On a phone, the World Backups table only shows the 10
    most recent by default (however many the retention setting actually keeps could be a lot
    more than that, and scrolling through all of them just to reach the log below gets old
    fast) - a **Show all N backups** button underneath reveals the rest, toggling back to
    **Show fewer**; desktop always shows the full list, no cap (the Player Profile Backups
    table has no such cap - a single player's own backup count rarely gets that large). All
    of it backed by the same `backup.ts`/`schedule.ts`/`playerBackup.ts` functions the
    desktop Backups tab uses, reused directly since the web dashboard runs in the same
    process. No remote equivalent for the desktop tab's **Open backup folder** button on
    either table, same as everywhere else on this page a local file-system dialog would be
    needed.
  - **Settings**, **Mods**, **Map Management**, and **Update Log** - admin-only tabs (role
    `admin`/`globalAdmin`, or no login requirement at all) that let an admin token do
    essentially everything the desktop Manager's own per-server Settings/Mods/Map
    Management/Update Log tabs can, without any local file-system access (no directory/file
    picker, no "open folder" button - those stay desktop-only, they have no remote
    equivalent). Each follows whatever server is currently selected exactly like Backup
    above, with the same "No server selected - choose one above." fallback. **Settings**
    covers Name/Install directory/ports/Platform/Max Players/Map (official + custom, from the
    same `maps.json`/`customMaps.json` the desktop Manager reads)/Mod Map/Beta/culture/
    BattlEye/RCON Tribe Log/Force Respawn Dinos/No Sound/Max Dino Level/Dashboard group/Extra
    launch arguments/Cluster settings. **Mods** is the same enable/passive/dev checkboxes, name, and
    mod ID table as the desktop tab, add/remove included. **Map Management** creates/lists/
    deletes `SavedArks/<folder>/<file>` placeholders. **Update Log** is a read-only view of
    the last SteamCMD run's output, refreshing every few seconds while open, same as the
    desktop tab's live-updating version. Every field saves immediately on change (no separate
    Save button), each through its own `POST /api/servers/:id/profile` call (Mods reuses this
    same route; Map Management gets its own `GET`/`POST /api/servers/:id/mapfolders` and
    `POST .../mapfolders/delete`; Settings additionally reads `GET /api/maps` for its Map
    dropdown) - all gated by `requireRole(req, res, 'admin')` server-side regardless of what
    the sidebar does or doesn't show client-side, and still scoped by a token's per-profile
    access list the same as every other per-server route on this page.
  - **Server Management** - a `moderator`-and-above tab (a wider tier than the four above -
    moderators are meant to reach it), covering the startup/crash-watchdog/zombie-detection
    toggles, the cluster console archive size, and the scheduled Restart/Dino Wipe
    day-and-time pickers, including the same live "Next shutdown/dinowipe in: DD:HH:MM:SS"
    countdown as the desktop tab - `computeNextOccurrence`/`formatCountdown`
    (`shared/scheduleTime.ts`) hand-ported into this page's own vanilla-JS client script
    (which has no module system to import the real ones from) and ticking once a second
    while this tab is open, same cadence as desktop. Unlike the four admin-only tabs above,
    it has its own dedicated `GET`/`POST /api/servers/:id/servermanagement` route rather than
    reusing the generic `/profile` route - a hardcoded whitelist of just the fields this tab
    edits, so a moderator-tier credential reaching it can never read or write anything else
    on the profile (install directory, ports, mods, backup settings, etc. all stay behind the
    admin-only `/profile` route). Saves immediately on change, same as the other tabs.
  - Every one of these routes - `/profile`, `/servermanagement`, and the Backup tab's own
    settings fields - keeps the desktop Manager itself fully in sync with an edit made here,
    the same two ways an edit made in the desktop app itself already does: any restart/dino
    wipe/backup schedule or the player-profile-backup watcher gets re-armed against the new
    values immediately (not just on the Manager's next restart), and every open desktop
    window's own profile list updates live too - a field changed from a phone shows up in the
    Manager's Settings/Server Management/Backups tab (if it's open to that same server)
    without needing a manual refresh. The second part is a small dedicated event
    (`profileEvents` in `store.ts`, forwarded to every renderer window as `IPC.profilesChanged`)
    that fires on every profile save regardless of what triggered it, specifically so this
    doesn't require the web dashboard's HTTP routes to know anything about the desktop UI at
    all.
  - Cluster Dashboard is always the tab this page opens on - there's no remembered-last-view
    restore across reloads the way earlier versions of this page had. The eight per-server
    tabs above only ever enter the sidebar through an explicit click on a card in a group's
    mobile Group Console - nothing pre-selects a server on load, unlike before. Once a
    server has been selected at least once this session, those tabs (and their shared
    server pickers) stay in the sidebar even if the selection is later cleared (e.g. that
    profile got deleted or hidden out from under the page) - only the currently active view
    falls back to Cluster Dashboard in that case, not
    the whole sidebar collapsing back to just Cluster Dashboard.
  - **Host** controls who can reach the page at all - `127.0.0.1` (default) keeps it
    reachable from this machine only. Setting it to `0.0.0.0` (all interfaces) or one
    specific local IP makes it reachable from other devices on your local network, which
    Settings shows a warning for once set unless **Require access token** (below) is also
    on: by default the page has no authentication of its own, so that's full RCON/admin
    control of your servers available to anyone who can reach that address - only do this
    on a network you trust. Settings lists this machine's own local IPs as a hint for what
    to type in. Enabling/disabling, or changing the host or port, takes effect immediately
    on Save, no restart needed.
  - **Require access token (HTTPS)** - a checkbox in Settings, off by default (nothing
    changes for existing setups unless you turn it on). Turning it on does two things:
    switches the dashboard from plain HTTP to `https://` using a self-signed certificate the
    Manager generates and caches itself (`<data folder>/certs/`, regenerated automatically
    if this machine's local IPs change; browsers will show a "not trusted" warning the first
    time you visit - that's expected for a self-signed cert, click through, or install
    `certs/cert.pem` as trusted on a device if you'd rather not see it again), and requires
    every browser to present a valid access token before the page or any of its API routes
    respond to anything. This is what makes it reasonable to expose the dashboard outside
    your LAN (e.g. via router port forwarding) - without it, anyone who can reach the
    address has full control either way. There are no accounts, usernames, or passwords
    anywhere in this app - just tokens.
    - **Access tokens** are managed only from this Settings screen, never from the
      dashboard page itself - so having a token never grants the ability to create or
      revoke tokens, that always requires being at the machine running the Manager. Each
      token has a label (just for telling tokens apart, e.g. "My laptop") and one of four
      roles, highest to lowest: **Global Admin** (everything, on every server, always -
      the only role that ignores the per-server scoping described below even if one is
      set on the token), **Admin** (the exact same full permission set as Global Admin -
      Settings/Mods/Map Management/Update Log, full remote profile editing - but restricted
      to whichever servers the token is scoped to, same as every other role), **Moderator**
      (Console/Analytics/Backup/Cluster Dashboard plus **Server Management** - start/stop/
      restart/update a server, send RCON commands, create backups - but not restore or
      delete them, not Settings/Mods/Map Management/Update Log, and not the event-label
      filter checkboxes, which are shared/global rather than per-token), and **Read-only**
      (Cluster Dashboard plus a server's console feed and online players list, with every
      action hidden - no Backup section, no Start/Stop/RCON, no Kick, nothing that writes).
      A token created before this four-tier split existed keeps working exactly as it did:
      a stored `admin` role becomes **Global Admin** (it already meant unrestricted access
      before per-server scoping existed) and a stored `operator` role becomes **Moderator**,
      migrated automatically the first time the Manager reads the stored lists after
      updating, no action needed - and, critically, only that once, ever: a token created
      afterward with the (also now-legitimate) `admin` role is never itself touched by this
      migration, so creating a new **Admin** token keeps it exactly that, not silently
      promoted to Global Admin the way an earlier version of this migration incorrectly did
      on every single read. Role checks happen on the server for every route regardless of
      what the page shows - the
      client-side hiding is just so a role never sees a button that would fail if clicked. A
      token's full value (`ark_<id>_<secret>`) is shown exactly once, right after creating it
      - only its hash is ever stored, so a lost token can't be recovered, only revoked and
      replaced with a new one. To use one, paste it into the small prompt the dashboard page
      shows the first time a browser opens it without a token; that browser then remembers it
      (in its own `localStorage`, never a cookie or server-side session) until it's cleared,
      the token is revoked from Settings, or **Log out** is clicked - unlike a login session,
      a stored token survives a Manager restart or the dashboard being turned off and back
      on, so a browser only has to paste it in once.
    - Each access token can also be scoped to a chosen subset of servers, via a dropdown
      next to the label/role fields when creating one - a button showing the current
      selection ("All servers", one name, or a count) opens a scrollable checklist, one
      checkbox per server, rather than requiring Ctrl/Cmd-click. Nothing checked, the
      default, means every server - including ones added later, same as a token created
      before this existed. Choosing **Global Admin** hides/disables this picker entirely
      (it shows "All servers" and can't be changed) since that role structurally ignores
      scoping either way - pick **Admin** instead for a token that should be limited to
      specific servers while still having full permissions on them. This is enforced on the
      server for every route that operates on a specific server or group, not just filtered
      out of what the dashboard page displays - a direct API call for a server outside a
      token's scope gets the same 404 as a genuinely unknown server, rather than exposing
      that the server exists at all. The tokens table shows each one's scope as "All" or the
      list of server names it's restricted to.
    - An existing token's role and server scope (and an API key's role) can be changed any
      time via **Edit** in its table row, which swaps that row for the same role/scope
      picker the create form uses, with **Save**/**Cancel** in place of the label/Create
      button - no need to delete and recreate a token just to widen or narrow what it can
      do. Saving only ever changes the role/scope fields; the token's own secret (and so the
      value already pasted into a browser, or configured into a bot) is untouched, so editing
      permissions never logs anyone out or breaks an existing integration the way
      delete-and-recreate would.
    - **API keys** (also managed only from this Settings screen, kept as their own separate
      list from access tokens) are the same idea, but for scripts/bots that call the
      dashboard's HTTP API directly rather than a person's browser - e.g. a Discord bot
      posting server status. Each key has a label, a role (same four as access tokens - Admin
      and Global Admin behave identically for a key, since keys aren't scoped to specific
      servers the way access tokens can be), and is sent as `Authorization: Bearer <key>`
      exactly like an access token is - the server checks a presented Bearer credential
      against both lists, so either kind works anywhere the other does. A key's full value is
      shown exactly once at creation, same as an access token, and its role can likewise be
      changed any time via **Edit** without touching its secret.
- **Cluster** — an optional, per-server section (Settings tab) for cross-server transfers:
  Cluster ID (`-clusterid=`), Dedicated Cluster Directory (`-ClusterDirOverride=`, with a
  folder picker), No Transfer From Filtering (`-NoTransferFromFiltering`), and External IP
  (`-ServerIP=`). All four only apply when the section's enable checkbox is on, and are
  placed before "Extra launch arguments" in the final command line.
- **Server Platform** — PC or ALL (crossplay), passed as `-ServerPlatform=`.
- **Max Players** — passed as `-WinLiveMaxPlayers=` (defaults to 70).
- **Extra Settings** (Settings tab) — Culture Settings (None/English/French, passed as
  `-culture=en`/`-culture=fr`, omitted entirely when set to None), Disable BattlEye
  (`-NoBattlEye`), RCON Tribe Log (`-servergamelogincludetribelogs` +
  `-ServerRCONOutputTribeLogs`), Force Respawn Wild Dinos (`-ForceRespawnDinos`), No
  Sound (`-nosound`), and Max Dino Level (`-DestroyTamesOverLevel=<value>`, omitted
  entirely when left blank). RCON itself is always on (the Manager depends on it for
  Stop/Restart and the web dashboard) and can't be turned off, so there's no toggle or
  indicator for it in the UI at all.
- **Server Management tab** — **Manager Startup**, **Anti-Crash Watchdog**, **Zombie
  Detection**, and **Cluster Console Log Archive** share one **Startup & Watchdog** card
  (in that order, each its own labeled subsection with a one-line description rather than
  a full paragraph). The two schedules - **Restart** (renamed from "Server Shutdown,
  Update, and Startup") and **Dino Wipe** - share their own **Advanced Schedule** card
  right after the Watchdog group, again as labeled subsections rather than two separate
  cards. None of the underlying behavior changed - just how it's grouped and worded on the
  page. Each schedule's day-of-week checkboxes (Sun-Sat) sit on their own row below the
  enable checkbox + time input, rather than sharing a row with them and wrapping onto a
  second, misaligned row once the card isn't wide enough for all nine controls at once. An
  **Anti-Crash Watchdog** checkbox, independent per profile:
  when enabled, if this server is found to have gone from `running` (i.e. fully Started, not
  merely `starting`) straight to `stopped` with no deliberate action in between, it's
  restarted automatically 15 seconds after detection. A crash during startup itself (never
  reaching `running` in the first place) is a startup failure, not "a running server that
  crashed" - deliberately not retried, since blindly retrying every 15s would just loop
  forever on a fundamentally broken config. The running→stopped transition is only ever
  reached for a genuinely confirmed crash to begin with - Stop, Kill, Restart, Update, and
  the scheduled restart below all set a `stopping`/`restarting` status before ever touching
  the process (see "Tolerates a process hand-off..." above for how a stopped status gets to
  be trustworthy in the first place), so none of those are ever mistaken for one; Stop,
  Kill, and Restart also explicitly cancel any already-pending auto-restart themselves as a
  second layer of certainty, on top of never being able to trigger a new one. The checkbox
  is re-checked right before the restart actually fires, so turning it off during the 15s
  wait cancels it too.
- **Zombie Detection** — the Watchdog above deliberately leaves a startup failure alone (see
  just above); this is its counterpart for that exact gap. Independent per profile, active
  only during the window between the process spawning (`starting`) and the Manager
  confirming it actually finished loading (`running`) - armed the moment a profile enters
  `starting`, and disarmed the instant it leaves `starting` for any reason. If it's still
  stuck `starting` after a configurable timeout (default 10 minutes), the process is killed
  as a zombie caught in an endless startup loop, optionally (a separate checkbox, per
  profile) followed by an automatic restart attempt once the kill is confirmed complete.
  Both the enabled flag and the auto-restart choice are re-checked right before they'd take
  effect, same as the Watchdog above.
- The Server Management tab also has a "Start this server when the Manager starts" checkbox
  (not to be confused with "Start Manager when you log into Windows" in Settings, which is
  about the Manager application itself): when enabled, this server is started automatically
  every time the Manager app launches - skipped if it's already running (e.g. re-adopted
  from a previous Manager session that never actually stopped it). Waits for the "Delay
  between auto-started servers" setting in Settings (default 10s) before starting - even if
  it's the only enabled profile - so the Manager's own monitoring has time to finish
  initializing first and picks up this server's telemetry correctly from the start. When
  several profiles have this enabled, they start one after another, each waiting that same
  delay after the previous one. Also home to two independent time/day-of-week schedules,
  each with a live "next occurrence" countdown (`DD:HH:MM:SS`):
  - **Scheduled restart** ("Shutdown server at:" + Sun-Sat day checkboxes) gracefully
    stops the server (SaveWorld confirmed, then DoExit - the same path as the manual Stop
    button) at that time on the selected days, then optionally, in order: **Update server
    from steam after shutdown** (runs the same SteamCMD update as the Update button) and
    **Start server after shutdown**. When the update option is on, it waits 10 seconds
    after the shutdown before starting SteamCMD (`src/main/lib/scheduledActions.ts`,
    `POST_STOP_UPDATE_DELAY_MS`) - a grace period for the OS to fully release the install
    directory's file handles (log/save files) rather than racing SteamCMD against a
    process that just exited. The server is locked from being started manually (Dashboard,
    server page, or the web dashboard) for that whole 10s window, not just while SteamCMD
    is actually running - the same `isUpdating` guard the manual Update button itself uses
    is reserved as soon as the shutdown completes, so a manual Start can't sneak in and race
    the scheduled update. Since this runs unattended, its outcome (success, or a
    failure - including one that never even got to spawn SteamCMD, e.g. no SteamCMD path
    configured) is appended to that server's usual update log, viewable in that server's
    **Update Log** tab, the same place a manual Update's output shows up.
  - **Scheduled dino wipe** is independent of the restart above: its own time/day picker
    that just sends RCON `DestroyWildDinos` directly, while the server is running - no
    shutdown involved.
  Both schedules are profile settings like any other (included in profile export/import)
  and save immediately on every change - no separate Save button, and no need to restart
  the server or the Manager for a change to take effect.
- **Update / install via SteamCMD** — a per-server button runs
  `steamcmd +force_install_dir <install dir> +login anonymous +app_update 2430930 validate +quit`.
  A **Beta** field at the end of the Settings tab's Server block (a checkbox plus a
  branch-name text entry) inserts `-beta <name>` right before `validate` when checked and a
  name is given, targeting that beta branch instead of the default/public one - same command
  otherwise. Works for a first-time install into an empty folder too - the button reads **Install**
  instead of **Update** until the server executable is actually found in the install
  directory, then switches over automatically. Disabled while the server is running or
  already updating. The dashboard's own **SteamCMD** menu can either download and
  manage its own SteamCMD copy (one click, no setup) or point at an existing install you
  already have. The managed copy installs into a `steamcmd` folder inside the "Data files
  location" (see Settings below - Documents/ARK Server Manager by default), not next to
  the packaged app's executable: electron-builder's NSIS installer wipes the install
  folder's contents on every update/rebuild, which was silently deleting a managed
  SteamCMD copy kept there while the saved SteamCMD path setting kept pointing at the
  now-gone location. Each server's **Update Log** tab shows its last install/update run and
  refreshes itself live - the main process pushes an event the moment new output is written,
  rather than the tab polling on a timer, so a scheduled update's outcome shows up as it
  happens whether or not the tab was already open when it started (previously this was a
  toggleable panel on the Dashboard card itself, which only refreshed live while left open
  there). A failed attempt is retried automatically, up to 3 attempts total, before actually
  reporting an error - a stale/freshly-installed SteamCMD's very first run in a while often
  has to self-update itself first, which tends to fail once (exit code 7) before succeeding
  right after, so a single failure isn't necessarily the final outcome. A successful
  attempt - including the very first one - never triggers a retry. The update log shows
  every attempt, marked with a "Retrying" line in between.
- **Map Management tab** — type a folder name and a `.ark` file name (e.g. `Svartalfheim` /
  `Svartalfheim_WP.ark`) and click **Add map** to create `SavedArks/<folder>/<file>` under
  this server's install directory - an empty placeholder, just enough for a custom map to
  exist before its mod is actually installed (add that mod in the Mods tab afterwards -
  that's what downloads the real map and keeps it up to date). Below that, every subfolder
  already under `SavedArks` is listed (name + creation date, click a row to select it) with
  **Open map folder** and **Delete selected map** acting on whichever one is selected.
  Folder/file names are limited to a plain name - no path separators or `..` - since
  they're used to build a path on disk.
- **Update Log tab** — this server's last SteamCMD install/update run (manual or
  scheduled), moved here from a toggleable panel on the Dashboard card so it's always
  reachable and always live-refreshing rather than only while that panel happened to be
  left open - see "Update / install via SteamCMD" above for the retry/live-refresh
  behavior itself, which is unchanged.

## Manager Log

A page (sidebar **Log** button, alongside Dashboard and Cluster Dashboard) recording
everything the Manager itself does - Start/Stop/Kill/Restart (manual, from either the
Dashboard or the web dashboard), a scheduled restart's stop/update/start sequence, a
backup's save/zip sequence (manual or scheduled) and a restore, a SteamCMD update (manual
or scheduled, success or failure), and an Anti-Crash Watchdog-triggered restart -
independent of any one server's own ShooterGame.log or SteamCMD update log, and persisted
across Manager restarts (`src/main/lib/managerLog.ts`, `logs/manager.jsonl` under the Data
files location, capped at a fixed 5 MB with the oldest entries trimmed automatically once
exceeded - not a per-server setting like the cluster log archive, since this is
Manager-wide activity expected to accumulate slowly). A single action (e.g. a plain Start)
is one line; a multi-step task (the scheduled restart's Stopping/Stopped/Updating/Started
sequence, a backup's Started/Completed sequence, or the Watchdog's detected/restarting
sequence) shares one `taskId` under the hood so the page groups them under one header
showing the task's name (e.g. "Scheduled Restart — ServerName") with each step listed
underneath, rather than as unrelated lines. Grouping looks a `taskId` up across every group
seen so far, not just the most recently added one - several scheduled backups for different
servers can fire at the same moment and interleave their Started/Completed lines
chronologically, so a single backup's two lines are rarely adjacent in the raw log; only
checking the last group would otherwise split them into separate single-line groups instead
of merging like an uninterrupted, single-server scheduled restart's steps already do. Each
group is colored by event category - Start
green, Stop red, Restart orange, Kill dark red, Update light blue (matching the same colors
used for those actions elsewhere in the app), Scheduled Restart cyan, Backup purple,
Restore pink, and Anti-Crash Watchdog red - a left border plus the header text, so the kind
of event registers at a glance without reading every label. The category is inferred from
the `taskId`'s own prefix (`start-`, `backup-`, `crash-watch-`, ...) client-side, so it's
purely a display concern - an older log entry from before this existed, or any other
prefix, just renders uncolored instead of breaking. Refreshes live while the page is open -
the main process pushes each new entry as it's recorded, the same push pattern as the
Backups tab's own process log. Entries are set in a smaller, tighter font (rather than the
app's normal text size) so more of them fit on screen at once, especially on a large
monitor. An **Auto-scroll** checkbox next to the page title (unchecked by default) is the
only thing that scrolls the feed to the newest entry as new ones arrive - left off, new
entries still append live but the page stays exactly where you scrolled it, so reading
through older activity isn't constantly interrupted by a jump to the bottom. Opening the
page itself always jumps to the newest entry first either way, so it never opens on the
oldest recorded activity.

## Prerequisites

- Node.js 20+
- SteamCMD, only if you want to use the in-app Update button: either let the app install
  its own copy from the dashboard's **SteamCMD** menu, or point SteamCMD path there at an
  existing `steamcmd.exe`/`steamcmd.sh`. Otherwise you can keep managing installs yourself and just
  point a profile's Install directory at an existing one.

## Getting started

```bash
npm install
npm run dev      # launches the app with hot reload
```

Other scripts:

```bash
npm run typecheck   # type-check main/preload/renderer
npm run build        # production build into out/
npm test             # unit tests for the pure logic (launch args incl. cluster flags, RCON parsing, backup rotation, profile migration, SteamCMD args/paths, process adoption, startup log-file watching, live console event parsing, web dashboard HTTP routes)
npm run dist          # package a Windows installer + portable .exe into release/ (must be run on Windows)
```

`npm run dist` produces both an NSIS installer and a standalone portable `.exe` (via
`electron-builder`) in `release/`. It has to run on an actual Windows machine - cross-
building Windows targets from Linux/macOS needs Wine for the code-signing step, which
isn't set up here. The portable `.exe` is the easiest way to right-click → "Run as
administrator" without installing anything.

## Publishing a release

For the in-app **Check for updates** button (see Features above) to find a new version,
a build has to actually reach this repo's [GitHub
Releases](https://github.com/RaptorSauvage/bober-server-manager/releases) - `electron-builder`
is already configured (`build.publish` in `package.json`) to look there.

1. Bump `version` in `package.json` (electron-updater compares this against the latest
   release's tag, so it has to actually increase - plain semver, no `v` prefix needed in
   the field itself).
2. On Windows, with a `GH_TOKEN` environment variable set to a GitHub personal access
   token that can push releases to this repo:
   ```bash
   npm run build
   npx electron-builder --win --publish always
   ```
   `--publish always` uploads the installer, the portable exe, and the `latest.yml`
   metadata file electron-updater actually reads, as a new draft/published GitHub Release
   tagged with the `package.json` version. Without a `GH_TOKEN` (e.g. just running
   `npm run dist`), electron-builder still builds normally into `release/` but skips
   publishing - you'd need to attach the installer and `latest.yml` from `release/` to a
   GitHub Release by hand for the update check to see it.
3. Every installed copy of the Manager will then find it next time someone clicks
   **Check for updates**. There's no forced/background check on a schedule - it's
   deliberately opt-in per click, same as the SteamCMD update button for the ARK server
   itself.

Since the repo is public, no token is needed on the *reading* side - `electron-updater`
downloads release assets anonymously, `GH_TOKEN` is only for the publish step above.

## Setting up a server profile

From the dashboard, click **+ Add server**, then open it and fill in the **Settings**
tab:

- Every tab auto-saves immediately - there's no Save button anywhere in a server's own
  tabs (Settings, Mods, Backups, Server Management), and no debounce delay either: each
  field/checkbox/reorder/drag is written to disk the moment you make it, the same way the
  Server Management tab always has. Saving a profile also re-applies its backup/restart/
  dino-wipe schedules and the player-backup watcher, so this happens on every edit, not
  just eventually.
- The Settings and Server Management tabs both lay their sections out as wrapping cards
  (`.server-settings-tab`/`.server-management-tab` in `styles.css`) rather than one narrow
  column down the left with the rest of the window empty - each section keeps a consistent
  width and the sections flow across the available width, as many per row as fit, dropping
  to fewer (down to one) on a narrower window.
- Settings groups **Name**, **Install directory**, **Game/RCON ports**, **Server
  Platform**, **Max Players**, **Map**, and **Mod Map** together into one **Server**
  section (which also holds the **Export profile...** button at its end, rather than as a
  separate row below every section), followed by **Extra Settings** (which also holds
  **Extra launch arguments** at its end, rather than as its own standalone field below every
  section) and then **Cluster** last - all three sections share the same card treatment,
  with **Map** and **Mod Map** nested together in their own boxed subgroup within the
  **Server** section, since a custom map's Workshop mod id only matters alongside the Map
  it's paired with. **Dashboard group** (Extra Settings) has no explanatory text under it -
  see "Dashboard" above for what it does.
  **Install directory** is the folder containing `ShooterGame/Binaries/...` for that
  server instance - **Browse...** opens a folder picker; pasting a path works too, and a
  surrounding pair of quotes (e.g. from Windows Explorer's "Copy as path") is stripped
  automatically so that doesn't silently break detection. **Game/RCON ports** and
  **Server Platform** (PC/ALL): RCON authenticates using `ServerAdminPassword` from that
  install's `GameUserSettings.ini` - set it there, not in this app - and must be reachable
  on `127.0.0.1` (start/stop rely on it to save the world before shutting down).
- **Map**: a dropdown with two groups, **Official** (from `maps.json`) and **Custom**
  (from `customMaps.json`) - same folder (Documents/ARK Server Manager by default - not
  next to the Manager executable, since electron-builder's NSIS installer wipes that
  folder's contents on every update; Documents is untouched by that and by swapping the
  portable exe) and shape for both files, just two separate lists. A seed list of the
  official maps is created in `maps.json` on first run; `customMaps.json` starts empty
  since custom/modded maps are specific to whatever Workshop mods you use - add a line for
  each (its real map identifier, exactly like an official map's, plus a display name) with
  no app update needed. Either group is a plain, direct pick: selecting one just sets this
  server's map, same as picking an official one always did - there's no more indirection
  through Mod Map below. A profile's current map is always shown even if it isn't (or
  isn't yet) in either file. Next to the dropdown, **Open Folder** opens that same
  Documents/ARK Server Manager folder directly (so you can edit `maps.json`/
  `customMaps.json` by hand without hunting for the path yourself), and **Refresh** reloads
  both files on demand after an edit.
- **Mod Map** - a separate "Enable Modded Map" toggle for Workshop-based custom maps that
  also need their mod id passed explicitly: paste the mod's Workshop id and, while enabled,
  it's passed as `-MapModID=<id>` alongside the Map value above. Fully manual and
  independent from Map - nothing else in this app ever reads, writes, or clears it besides
  you typing into it and toggling the checkbox.
- Backups always read/write `ShooterGame/Saved/SavedArks/<map>` under the install
  directory - only the profile's own map subfolder, not the whole `SavedArks` folder (it
  can hold other maps' saves too, e.g. on a shared cluster install). This location is
  fixed by ARK:SA and isn't a configurable field. `.arkrbf` files (ARK's own transient
  rollback data, not useful in a backup) are left out of the zip. Backup directory,
  retention, and scheduling live in the **Backups** tab, not here; you must set a backup
  directory there before creating a backup. The Backups tab's list and the maxBackups
  retention limit both just take every `.zip` file sitting in that backup directory,
  whatever its name - including ones from a previous manager tool, or dropped in by hand.
  There's no separate "own vs. legacy" tracking: everything in that folder counts the
  same, and once you're past the configured limit the oldest file(s) - by whoever created
  them - get deleted to make room, so keep a server's backup directory dedicated to that
  server if you don't want unrelated zips swept up in its retention.

## Web dashboard API (for bots / other tools)

Everything the web dashboard page itself calls is plain JSON over HTTP - nothing
dashboard-page-specific about it, so any other local process (a Discord bot, a script,
`curl`) on the same machine can call it too, once **Settings → Enable web dashboard** is
on. Base URL is `http://<host>:<port>` using whatever Host/Port you set there (defaults
to `http://127.0.0.1:8090`) - or `https://` if **Require access token** is also on. With
that off (the default), there's no authentication at all - the same posture as RCON
itself, appropriate for `127.0.0.1` or a trusted LAN, never the open internet. With it on,
every route below needs a valid Bearer credential, with enough role to match the table in
the Settings section above:
- **API key** (the option meant for a bot/script) - create one in **Settings → API keys**,
  then send `Authorization: Bearer <key>` on every request. Keeps working across Manager
  restarts.
- **Access token** (what a browser uses, but works identically for a script) - create one
  in **Settings → Web dashboard access tokens**, then send it the same way:
  `Authorization: Bearer <token>`. There's no separate login step or cookie for either
  kind - the server checks a presented Bearer credential against both lists, so an access
  token works anywhere an API key does and vice versa; they're only kept as separate lists
  for organizing who has what.
- `GET /api/whoami` - what the dashboard page itself calls right after a browser pastes in
  a token, to learn its role. Returns
  `{ "role": "globalAdmin" | "admin" | "moderator" | "readonly" }` for any valid credential,
  401 for an invalid or missing one - useful for a script to sanity-check a key/token before
  using it for anything else.

| Method | Path | Body | Response | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/whoami` | — | `{ role }` | 401 if the presented key/token is missing or invalid |
| GET | `/api/servers` | — | `[{ id, name, group, maxPlayers, state, players, cpu, memoryMB, startedAt, gameVersion }]` | `id` is what every other endpoint below expects; `group` is the Manager's dashboard group name (empty string when ungrouped); `startedAt` (epoch ms, or `null`) feeds the Status panel's live Uptime field |
| GET | `/api/groups/:group/events` | — | Same shape as `/api/servers/:id/events` below, plus `profileId`/`profileName` on each event | Merged, date+time-sorted backlog across every server in the group. `:group` is the group name, or the literal `_ungrouped_` for the ungrouped bucket |
| GET | `/api/groups/:group/events/stream` | — | `text/event-stream`, one `data:` line per merged event (same shape as the backlog above) | Only tails servers in the group that are actually running, starting/stopping individual tailers live as they start/stop while the connection is open. With auth on, `EventSource` can't set an `Authorization` header, so this route (and the per-server one below) also accepts the credential as a `?token=` query parameter |
| POST | `/api/servers/:id/start` | — | `{ ok, error? }` | 400 with `error` if it can't start right now (e.g. an update is running) |
| POST | `/api/servers/:id/stop` | — | `{ ok: true, saved: boolean }` | Waits for SaveWorld's RCON outcome (`saved`) before responding, then returns - the rest of the shutdown keeps running in the background; state changes (`stopping` → `stopped`) show up in the next `GET /api/servers` poll. `saved: false` means RCON was unreachable or the save failed, so it skipped straight to the grace-period/force-kill fallback |
| POST | `/api/servers/:id/restart` | — | `{ ok: true, saved: boolean }` | Same as stop above, for the shutdown half - responds once `saved` is known, then the restart (including starting back up) continues in the background |
| POST | `/api/servers/:id/update` | — | `{ ok: true }` | Runs the SteamCMD update alone; fails quietly (logged in the Manager's own console) if the server is currently running - stop it first |
| POST | `/api/servers/:id/stop-update-restart` | — | `{ ok: true }` | Stops if running, updates, starts back up - the single-server "do everything" action |
| POST | `/api/servers/:id/rcon` | `{ "command": "Broadcast hello" }` | `{ ok, response? , error? }` | Same RCON connection the page's own console box uses |
| GET | `/api/servers/:id/players` | — | `[{ name, id }]` | Fresh `ListPlayers` call every time, not cached |
| GET | `/api/servers/:id/backups/status` | — | `{ backupDir, maxBackups, scheduleEnabled, scheduleCron, scheduleActive, nextRunAt, playerProfileBackupEnabled, playerProfileBackupMaxPerPlayer }` | Read-only - mirrors the Backups tab's settings; an `admin`/`globalAdmin` credential can change them via `POST /api/servers/:id/profile` (not listed here - same generic route Settings/Mods use) |
| GET | `/api/servers/:id/backups` | — | `[{ fileName, filePath, sizeBytes, createdAt }]` | Same list the Backups tab shows |
| POST | `/api/servers/:id/backups` | — | `{ ok, entry? , error? }` | Creates a backup now (sends RCON SaveWorld first, same as the desktop app); 400 if no backup directory is set |
| POST | `/api/servers/:id/backups/restore` | `{ "filePath": "..." }` | `{ ok, error? }` | Same restore-blocked-while-running guard as the desktop app |
| POST | `/api/servers/:id/backups/delete` | `{ "filePath": "..." }` | `{ ok, error? }` | Deletes one backup file |
| GET | `/api/servers/:id/backups/log` | — | `[{ timestamp, level, message }]` | The same Backup Process Log shown in the Backups tab / web Backup view |

A minimal example from a Node.js bot (works the same from Python, or any HTTP client):

```js
const BASE = 'http://127.0.0.1:8090'

async function startServer(profileId) {
  const res = await fetch(`${BASE}/api/servers/${profileId}/start`, { method: 'POST' })
  return res.json() // { ok: true } or { ok: false, error: '...' }
}

async function findProfileIdByName(name) {
  const servers = await (await fetch(`${BASE}/api/servers`)).json()
  return servers.find((s) => s.name === name)?.id
}
```

- **Manager-wide: worked around a field that silently stops accepting keystrokes after a
  confirm dialog, not disabled-looking, just unresponsive.** Reported as intermittent and
  not tied to any one field - "I can type into it once, then never again, all over the
  app." The lead: `window.confirm()` in Electron isn't an in-page dialog, it's a real native
  OS one, and Electron/Windows sometimes fails to hand OS-level keyboard focus back to the
  main window once it closes - the window looks completely normal afterward (nothing
  disabled), but no text field anywhere accepts keystrokes until it's explicitly refocused
  (e.g. alt-tabbing away and back). Every `confirm(...)` call in the app (delete/force-kill
  prompts - Dashboard, Minecraft Dashboard, Backups, Player Backups, Map Management, access
  tokens, API keys) now goes through a new `confirmAction()` helper
  (`src/renderer/src/lib/confirmAction.ts`) that calls a new `system:focus-window` IPC
  handler (`ipc/system.ts`) right after, explicitly re-focusing the main window. The
  existing file/folder pickers (`dialog.ts`) - also real native dialogs - got the same
  `mainWindow.focus()` call added directly on the main-process side. This is the most
  likely cause given the symptoms (unresponsive but not disabled, happens after a
  destructive-action prompt, affects arbitrary fields afterward rather than one specific
  one) and the fix is safe either way (an explicit refocus is a no-op if focus was never
  actually lost) - but it's a strong lead based on the reported symptoms, not something
  confirmed by reproducing it directly, since this environment has no display to test
  Electron's actual window-focus behavior in. Please confirm whether this actually resolves
  it after updating.

## Notes / limitations

- Tested with `npm run typecheck`, `npm run build`, and `npm test` in this environment,
  which has no display and no real ARK:SA install — so the actual Electron window and
  real start/stop/RCON/backup behavior against a live server have **not** been visually
  verified. Please run `npm run dev` on your machine, point a profile at a real
  install, and try Start/Stop/RCON/Backup end-to-end.
- The exact ARK launch command-line flags can change between game updates
  (`src/main/lib/serverProcess.ts`, `buildLaunchArgs`); use the profile's "Extra launch
  arguments" field if your install needs something different.
- The player-profile-backup join/leave line format, the ".profilebak filename equals the
  UniqueNetId" mapping, and ARK writing that file itself around both events were all
  confirmed against a real setup, not guessed - but if a future ARK:SA update changes any
  of that, the parser (`parsePlayerConnectionEvents` in
  `src/main/lib/playerConnectionWatcher.ts`) simply stops matching lines and the feature
  quietly does nothing rather than backing up the wrong file.
- Out of scope for this version: remote/SSH or Docker-based control, and multi-user/remote
  web access (this is a single-user local desktop app).
- Because the server survives the Manager closing, deleting a profile does **not** stop
  its server if one is running — it only removes the profile from the app. Stop or Kill it
  first if you actually want it gone.
- **If Update repeatedly fails** (SteamCMD exit codes 7/8, or "Failed to get manifest
  request code, 'Access Denied'" in the update log) even though the exact same command
  works fine run manually: check that your antivirus (e.g. Malwarebytes) isn't silently
  blocking the Manager's `.exe` and/or `cmd.exe`/`steamcmd.exe` - add an exception for both
  and retry. This was confirmed as the actual root cause in one real case, after disk
  space, admin rights, and a stuck SteamCMD manifest state had all been ruled out first.
- **The "New update" check** (`updateCheck.ts`) used to intermittently show "Could not
  find a public branch build id in SteamCMD's app_info_print output." even though Update
  itself worked fine - it listened for the child process's `exit` event, which can fire
  before all of stdout has actually been delivered, occasionally truncating the (fairly
  large) `app_info_print` dump right before the section this reads. Fixed by switching to
  `close` (which Node guarantees fires only once all stdio data has arrived), matching the
  same fix already applied to the real update/download path in `steamcmd.ts`.
- **Multi-game support**, being built incrementally on the `multi-game-support` branch.
  Every server profile carries a `game` field (`shared/games.ts`'s registry) - `'ark-ascended'`
  for every profile saved before this existed (backfilled automatically, and persisted to
  disk the first time any profile list is read after updating - `store.ts`'s
  `migrateProfilesToDiskOnce`, same one-time-flag pattern as the role migration below - so
  `config.json` reflects it after simply opening the app once, no manual edit needed).
  **ARK: Survival Evolved is now a second, real, launchable game** alongside ARK: Survival
  Ascended (Palworld remains planned, listed for visibility only in Settings' **Games**
  section but not yet creatable; Minecraft is real too now, but as its own separate
  top-level menu rather than a third entry in this picker - see **Minecraft support**
  below for why):
  - The Settings tab's **Server** section has a **Game** picker; switching it clears the Map
    field (the two games' map ids don't match, e.g. `TheIsland_WP` vs `TheIsland`) and
    refetches that game's own map list.
  - "Import existing server" auto-detects which game an install directory belongs to from
    its executable (`ArkAscendedServer.exe`/`ShooterGameServer.exe` on Windows, no extension
    on Linux) - no need to say up front which one it is.
  - ARK: Survival Evolved's dedicated server installs/updates via SteamCMD app id `376030`
    (ARK: Survival Ascended's `2430930`) into its own `appmanifest_376030.acf`, so the two
    can coexist. Its map list defaults to the classic un-suffixed names (`TheIsland`,
    `TheCenter`, `ScorchedEarth_P`, `Ragnarok`, `Aberration_P`, `Extinction`, `Valguero_P`,
    `CrystalIsles`, `Genesis`, `Gen2`, `LostIsland`, `Fjordur`) and is stored separately
    (`maps-ark-evolved.json`, next to the existing `maps.json` which stays ARK: Survival
    Ascended's and untouched).
  - ARK: Survival Evolved needs a `QueryPort` distinct from the game port (ARK: Survival
    Ascended merged the two) - the Settings tab shows a **Query port** field only for a game
    that needs it (`GameDefinition.usesQueryPort`).
  - ARK: Survival Evolved's launch line differs from ARK: Survival Ascended's in a few more
    ways, confirmed against a real, working `ShooterGameServer.exe` command line (not just
    docs): it omits `?listen` and `-server -log` entirely, adds `-servergamelog` instead (the
    flag that actually makes it write `ShooterGame.log`, which `startServer`'s
    startup-complete-marker watch depends on), and passes `MaxPlayers=` inline in the
    `?`-string rather than `-WinLiveMaxPlayers=` (an ARK: Survival Ascended/crossplay-only
    flag). ARK: Survival Ascended's launch line is unchanged.
  - A new **Server Password** profile field (the join/connect password, distinct from the RCON
    admin password) is shown in the Settings tab and always passed as `ServerPassword=` inline
    in the `?`-string for ARK: Survival Evolved - a mandatory argument there per a real working
    command line, so it's always emitted (even blank, which just means no join password). Not
    emitted, and the field stays hidden, for ARK: Survival Ascended. A profile migrated from
    before this field existed backfills it to blank.
    - A **Session Name** field/`SessionName=` argument was added alongside this at first, then
      removed again: `GameUserSettings.ini`'s `SessionSettings.SessionName` already covers the
      in-game display name for both games, so the launch-arg duplicate for ARK: Survival
      Evolved was unnecessary. `migrateProfile` drops a stray `sessionName` from any profile
      that still has one on disk from that brief window.
  - ARK: Survival Evolved's launch line's exact **argument order** matters, confirmed the hard
    way: an earlier version reused ARK: Survival Ascended's ordering (`RCONEnabled=` right
    after `QueryPort=`, `-servergamelog` right after the map string) and that reproducibly
    caused a blocking `Plugin 'RuntimeMeshComponent' failed to load` dialog on launch - since
    the Manager starts the process detached with no visible window, nothing was there to
    dismiss it and the server hung forever. `buildLaunchArgs` now builds ARK: Survival
    Evolved's `?`-string (`Port=`, `QueryPort=`, `RCONPort=`, `RCONEnabled=`, `MaxPlayers=`,
    `ServerAdminPassword=`, `ServerPassword=` - `SessionName=` was here too at first, since
    removed, see above) and flag order (`-NoBattlEye`,
    `-ForceRespawnDinos`, `-servergamelog`, `-servergamelogincludetribelogs`,
    `-ServerRCONOutputTribeLogs`) to match a real, confirmed-working command line exactly,
    pinned by a dedicated test. Why order affects a native plugin load isn't obvious, but the
    fix is empirically confirmed. ARK: Survival Ascended's order is unchanged.
  - A handful of ARK: Survival Ascended launch flags have **unconfirmed** ARK: Survival
    Evolved support and are simply never emitted for it, rather than guessed at: crossplay
    (`-ServerPlatform=` - the Settings tab hides that field for ARK: Survival Evolved too),
    `-DestroyTamesOverLevel=` (Max Dino Level, also hidden), and passive/dev mods
    (`-passivemods=`/the `-dev` suffix - a passive-flagged mod on an ARK: Survival Evolved
    profile loads as a normal active mod instead of being silently dropped). These were
    confirmed against public documentation (Steam community discussions, LinuxGSM's ARK:SE
    docs, community wikis - the ARK wiki itself was unreachable from the environment this
    was built in), not a real running ARK: Survival Evolved install - worth double-checking
    against one before relying on it for a production server.
  - The "New update" check (SteamCMD `app_info_print` polling) and every server card's game
    icon (desktop Dashboard grid and the Web Dashboard's own cards, served from a new
    `GET /game-icons/<fileName>` route with the same ETag/no-cache pattern as `/favicon.png`)
    are both correctly scoped per game now instead of assuming ARK: Survival Ascended.
  - The Settings tab has a new **Debug** section showing the exact executable path and launch
    argument list `Start` would run right now, including unsaved edits above (a new
    `server:preview-launch-command` IPC call runs `getExecutablePath`/`buildLaunchArgs` against
    the live form state, debounced 300ms) - a **Copy** button copies the full command line.
    Added directly off the back of the `RuntimeMeshComponent` argument-order issue above, so a
    similarly obscure launch failure can be diagnosed by comparing this against a known-working
    command line instead of guessing blind.
  - `buildLaunchArgs` now drops an exact-duplicate flag rather than emitting it twice, found via
    that same Debug box on a real profile whose **Extra launch arguments** field still had
    `-servergamelog`/`-nosound` typed in manually from before the Manager started adding them
    natively for ARK: Survival Evolved - the leftover text and the native flag were both firing,
    putting `-servergamelog` on the command line twice. Only exact duplicates are dropped (first
    occurrence kept), so this is a no-op for a profile whose `extraArgs` doesn't overlap with
    anything the Manager already emits. It doesn't fix a *missing* `ServerAdminPassword=` on the
    command line, though - that's read straight from `GameUserSettings.ini` (`readAdminPassword`,
    same for both games, by design - see `config.ts`), so a server whose ini doesn't have one set
    yet (e.g. a first launch of a fresh install, before the ini has even been created) launches
    without it. `rcon.ts` already surfaces that case with a clear
    "No ServerAdminPassword set in this server's GameUserSettings.ini" error when a
    Manager-driven RCON command (Stop/Restart/etc.) is attempted against it.
  - `startServer` now spawns with `cwd` set to the executable's own directory (`Win64`/`Linux`)
    rather than the install root three folders up. Every community-standard ARK launch script
    `cd`s into that folder before running the exe (a manually confirmed working launch was run
    from inside its own `Win64` folder, cmd's prompt showing as much), so this keeps the
    Manager's spawn matching that exactly instead of leaving the working directory as one more
    unverified difference from a known-working reference. Applies to both games.
  - **ARK: Survival Evolved now launches through a temporary `.bat` file, run via
    `cmd.exe /d /c <path>`, instead of a direct `spawn()` of the exe** - every established ARK:
    Survival Evolved server manager launches this way, per further research into how they do
    it. The `.bat` (regenerated fresh on every start, at a stable per-profile path under the OS
    temp dir - `writeLaunchBatchFile` in `serverProcess.ts`) contains just a `cd /d` into the
    executable's own directory followed by the exact, unquoted command line, matching a
    confirmed-working launch byte-for-byte - this is what a person typing the command directly
    at a `cmd` prompt actually gets, and sidesteps needing Node's own Windows argument quoting
    (which wraps a space-containing argument like `SessionName=<value with spaces>` in double
    quotes - correct for a well-behaved argv parser, but plausibly mishandled by ARK: Survival
    Evolved's much older, less rigorous command-line parsing) to line up with what it expects.
    ARK: Survival Ascended is unaffected - still a direct `spawn()`, still with
    `windowsVerbatimArguments: true` (a harmless no-op there, since its arguments never contain
    a bare space) kept for parity.
    - The tricky part: this makes `cmd.exe`, not `ShooterGameServer.exe`, the process Node
      actually spawned - `child.pid` is cmd.exe's own pid, which would misreport CPU/RAM as
      cmd.exe's near-zero usage and, if killed directly, could orphan the real game process
      instead of stopping it (Windows doesn't kill a process's children when the process itself
      is killed). `watchForBatchPidHandoff` polls (every 2s, the same `findListeningPid`
      netstat-based technique `handleUnexpectedExit`'s hand-off already used) for whichever
      process actually holds the RCON port, and once found, re-points this profile's tracked
      pid at it and nulls out the stored process handle - the exact same re-attach shape
      `handleUnexpectedExit` uses for its own hand-off case - so `killServer`/the force-kill
      fallback end up targeting the real pid directly instead of the cmd.exe wrapper. Until that
      first poll succeeds, CPU/RAM monitoring is simply unavailable (`pidTracked` stays false)
      rather than showing cmd.exe's misleading numbers. `child.on('exit')` still correctly
      signals a real stop either way, since `cmd /c` waits for its child before exiting itself.
    - **Confirmed working end-to-end against a real Windows ARK: Survival Evolved install**:
      launches, is connectable in-game, and the pid hand-off below eventually completes so
      CPU/RAM monitoring comes online.
    - `watchForBatchPidHandoff` logs its progress to the **Manager Log**, under an
      `ARK: Survival Evolved pid handoff` task: the wrapper pid it started from, what
      `findListeningPid` returned on each of its first 10 attempts (~20s - capped so a
      persistently-failing hand-off can't flood the log for as long as the server stays up),
      and the real pid once found. A real ARK: Survival Evolved world can take well past 20s
      to open its RCON port (30-90s+ isn't unusual) - the hand-off itself never gives up
      (keeps retrying every 2s indefinitely), and past that initial 20s window the log gets a
      periodic reminder every ~30s that it's still looking, rather than either going silent
      (which looked exactly like it had given up, in a real report where it just needed more
      time) or framing anything as a final failure (it never is one).
  - The game-version display (Analytics tab, read from `ShooterGame.log`'s `ARK Version:
    X.Y` line) needed no ARK: Survival Evolved-specific work at all - confirmed against a
    real ARK: Survival Evolved log line (`[2026.09.28-13.19.58:026][  0]ARK Version:
    358.24`), the exact same regex already matched it.
  - A new **Auto Manage Mod** checkbox (Settings tab, Extra Settings, right before Dashboard
    group - ARK: Survival Evolved only) passes `-automanagedmods`, telling the server to
    download/update its own workshop mods itself instead of relying on them being
    pre-installed.
  - **ARK: Survival Evolved has no command-line mechanism for mods at all - confirmed, not
    just unconfirmed support as before.** It has neither passive mods nor a `-dev` suffix
    either, so the desktop Mods tab hides both columns for it. Its mods are instead written,
    only when a mods edit is actually the thing being saved (the dedicated Mods tab save, and
    the Web Dashboard's Mods tab, which posts `{mods: ...}` to the same profile-save route),
    to:
    - `GameUserSettings.ini`'s `[ServerSettings]` → `ActiveMods=<id>,<id>,...` (comma-separated,
      enabled mods only, in order)
    - `Game.ini`'s `[ModInstaller]` → one `ModIDS=<id>` line per enabled mod
    - `gameConfigWrite.ts`'s `syncAseModsToIni` does this surgically - editing only the lines
      that belong to those exact keys, not parsing+re-stringifying the whole file with the
      `ini` package (which would reorder/reformat every other section, comment and key the
      user has in a file they hand-edit themselves) - and creates the
      `Config/WindowsServer` folder tree if it doesn't exist yet (a profile whose install has
      never been started once). This is the first thing in the app that writes to either
      file - previously strictly read-only, since ARK: Survival Ascended's mods are
      launch-flag only and never needed it.
    - **Fixed a clobbering bug found via live testing before it ever shipped**: `syncAseModsToIni`
      was originally wired into every generic profile save (`profiles:save`, profile import, the
      Web Dashboard's own generic profile-save route) rather than just the dedicated mods-save
      paths. That meant saving any unrelated field - even the very first save of a brand-new
      profile - rewrote `ActiveMods=`/`[ModInstaller]` from `profile.mods`, silently overwriting
      real pre-existing ini content. Fixed by removing the call from every generic save path and
      keeping it only where a mods edit is actually the save in question; the Web Dashboard's
      shared `/api/servers/:id/profile` route now only syncs when the posted body actually has a
      `mods` key.
  - The desktop Mods tab now also **reads mods back out of the ini**: opening it for an ARK:
    Survival Evolved profile calls `reconcileAseModsFromIni`, which picks up any mod id already
    present in `ActiveMods=` that the Manager doesn't know about yet (added by hand-editing the
    ini, or from before the profile was ever opened here) and adds it as a new enabled entry.
    Additive only - it never removes or disables an existing entry, since a disabled mod is
    *correctly* absent from `ActiveMods=`, not a state to "fix". Wired via a new
    `mods:reconcile-from-ini` IPC call (`ipc/mods.ts`); not yet exposed on the Web Dashboard's
    Mods tab.
  - **Not yet done**: the Web Dashboard's own Settings tab (editing a profile from a
    browser) doesn't expose the Game/Query port fields, the new Server Password/Auto Manage
    Mod fields, or a game-aware map list the way the desktop Settings tab now does - it still
    assumes ARK: Survival Ascended for those. Its own Mods tab also still shows the
    passive/dev toggles and the `-mods=`/`-passivemods=` wording for an ARK: Survival Evolved
    profile (the desktop one now hides/rewords all of that) - inert rather than incorrect,
    since nothing reads them for it, but not hidden yet - and it has no equivalent of the
    reconcile-from-ini pickup either.

- **Minecraft support (MVP)**, built as a deliberately separate system from the ARK side of
  the app rather than a third `GameDefinition` entry - `MinecraftProfile`
  (`shared/minecraft.ts`) is its own type, its own `electron-store` collection
  (`minecraftProfiles`), its own IPC namespace (`ipc/minecraft.ts`, `window.api.minecraft.*`),
  and its own top-level menu - an **ARK / MC** switch group at the top of the sidebar,
  separated from the Dashboard/Cluster Dashboard/Log page nav below it by a divider (it
  toggles the whole app's mode, not a page within one - see `GameSwitch` in `App.tsx`).
  ARK: Survival Evolved and ARK: Survival Ascended share
  enough (engine lineage, launch style, RCON, log format) that unifying them into one
  `ServerProfile` shape made sense; Minecraft shares almost none of that - no SteamCMD, no
  fixed executable name, no `?param=` launch line, a completely different config/log format -
  so forcing it into `ServerProfile` would have meant either polluting it with fields that
  mean nothing for ARK, or a discriminated union touching every one of its consumers.
  - **Import, not install-from-scratch.** The whole point of this feature (per how it was
    scoped) is pointing the Manager at a Minecraft server folder someone already set up
    themselves, the same way MCSS does it - not driving a fresh install. "Import existing
    server" opens a folder picker; `isValidMinecraftInstall`/`detectMinecraftProfile`
    (`minecraftDetect.ts`) accept it if `server.properties`, `eula.txt`, a jar, or a launch
    script is found directly in its root (not recursively - avoids picking up an unrelated
    jar from a `mods`/`plugins`/`libraries` folder), then build a best-effort profile that's
    saved right away and opens straight into its Settings tab for review/correction - same
    "detect, save, review" flow as ARK's own import, and every Settings field auto-saves on
    change so a correction overwrites the initial guess immediately. "+ Add server" skips
    detection entirely for a from-scratch/manual entry.
  - **Dual launch mode - the Forge problem.** Vanilla/Fabric/Paper/Spigot are all a single
    directly-runnable jar, so `launchMode: 'jar'` has the Manager build
    `java -Xms.. -Xmx.. <extra JVM args> -jar <jar> <extra program args>` itself. Modern Forge
    (1.17+) ships no such jar at all - just a generated launch script plus argfiles/a
    `libraries/` folder - so `launchMode: 'script'` instead just executes an existing
    `run.bat`/`run.sh`/`start.bat`/`start.sh` as-is (via `cmd.exe /d /c` on Windows, same
    launch shape as ARK: Survival Evolved's own `.bat` launch - see `writeLaunchBatchFile` in
    `serverProcess.ts`), letting it handle its own classpath/JVM args. This also works as a
    general escape hatch for any other custom start script. `detectMinecraftLaunchable`
    prefers a script over a jar when both exist, since a script's presence is the strongest
    signal of "this needs Forge-style handling."
  - **server.properties is read live, never duplicated.** `MinecraftProfile` deliberately does
    not store its own copy of the server port, RCON port/password/enabled, motd, or max
    players - `minecraftProperties.ts` reads `server.properties` fresh on every call instead
    (a small hand-written parser, not the `ini` package - Java's flat `key=value` properties
    format has no `[Section]` headers and treats `#`/`!` as comments, not `;`). Same "the user
    manages this file themselves" philosophy as ARK's own `GameUserSettings.ini` handling -
    toggling `enable-rcon` or changing `rcon.password` while the server's running takes effect
    on the Manager's very next RCON attempt, with nothing to keep in sync.
  - **stdin is the primary command channel, RCON is secondary.** Unlike ARK's dedicated server
    (which doesn't read stdin at all on Windows, forcing RCON/log-file-only control),
    Minecraft/Java server processes support piped stdio reliably - `minecraftProcess.ts` spawns
    with `stdio: 'pipe'` and the Console tab's command box, and the graceful `stop` shutdown,
    both write straight to the running process's stdin. This works whether or not RCON is even
    enabled in `server.properties`. `minecraftRcon.ts`'s `sendMinecraftRconCommand` (same
    ECONNRESET-safe `rcon-client` connection pattern as ARK's `rcon.ts`) is used only for the
    player-list poll (`list`, parsed by `parseMinecraftPlayerList`) that feeds the Console tab
    and Dashboard cards' CPU/RAM/player stats, when RCON happens to be enabled.
  - **Live console, not a tailed log file.** Since stdio piping works reliably here (unlike
    ARK), the Console tab reads the process's own piped stdout/stderr directly rather than
    tailing `logs/latest.log` the way ARK's `ShooterGame.log` is tailed - simpler, and it also
    means a script-launched (Forge) server's output is captured too, without needing to know
    Forge's own log file layout. Kept as an in-memory ring buffer (500 lines) per server,
    intentionally not written to disk (see MVP scope cuts below).
  - **Graceful stop, not a phased save/exit handshake.** Minecraft's own `stop` command already
    saves the world, kicks players, and exits entirely on its own, so `stopServer` just writes
    it to stdin and waits (30s grace period, then force-kills) - there's no ARK-style
    `SaveWorld`-confirm-then-`DoExit` handshake to phase, since there's nothing to confirm
    separately.
  - **Script-mode pid tracking, and memory actually taking effect in script mode** (both
    fixed after a real report: CPU/RAM shown not matching the actual server, and memory
    fields not being editable at all).
    - On Windows, `launchMode: 'script'` spawns via `cmd.exe /d /c <script>`, and cmd.exe
      spawns java as a *child* process rather than replacing itself the way a POSIX shell's
      `exec` would - so the pid Node hands back is cmd.exe's own wrapper pid, not java's.
      Reading CPU/RAM off that pid showed cmd.exe's own near-zero usage instead of the real
      server's - exactly the mismatch reported. Fixed with the same technique (and same
      root cause) as ARK: Survival Evolved's own `.bat` launch:
      `watchForScriptPidHandoff` in `minecraftProcess.ts` polls (via the already-existing
      `findListeningPid` from `serverProcess.ts`) for whichever pid is actually holding the
      server's own port (`getMinecraftServerPort`) once it starts listening, and switches
      tracking to it. Until that handoff completes, CPU/RAM are left blank rather than
      shown wrong (`isPidTracked` gates `minecraftMonitor.ts`'s stats read); force-kill and
      the stop-timeout fallback now also target this tracked pid rather than the wrapper, so
      killing a script-launched server actually kills java instead of orphaning it running
      in the background.
    - The Settings tab used to disable the memory/extra-JVM-args fields entirely whenever
      `launchMode` was `'script'`, reasoning "the script already encodes its own memory
      args" - true for a fully custom script, but wrong for the common case: modern Forge's
      own generated `run.bat`/`run.sh` reads a `user_jvm_args.txt` argfile for exactly
      `-Xms`/`-Xmx`/extra JVM args (the official mechanism, not a workaround). The fields
      are no longer disabled; `startServer` now calls `writeUserJvmArgs`
      (`minecraftProperties.ts`) to (over)write that file with the profile's current values
      before every script-mode start, so editing memory in Settings takes effect on Forge's
      own generated script. Harmless no-op for an older Forge version or a fully custom
      script that doesn't happen to read that file.
  - **Explicitly cut from this first pass** (all real, deliberate scope cuts, not oversights -
    the infrastructure that made each of these work for ARK is straightforward to point at
    Minecraft later): no backups, no crash-watch/zombie detection, no persisted CPU/RAM/player
    history (only shown live while the Manager is open), no Web Dashboard integration.
    Scheduled restart and cross-restart re-adoption, both cut here originally, were added in
    a follow-up pass - see the next bullet.

- **Minecraft follow-up: server type on the card, re-adoption across a Manager restart,
  tab rework (Start Settings / Server Settings / Server Management).** Four asks from a real
  report, after using the MVP above for a bit.
  - **Server type shown on the Dashboard card**, replacing the previous jar/script file name
    display. `detectMinecraftServerType` (`minecraftDetect.ts`) is a pure, best-effort guess
    from the jar/script's own file name - it looks for `fabric`/`paper`/`spigot`/`bukkit`/
    `forge` as substrings, falls back to `forge` for any other launchMode `'script'` name
    (the actual reason that mode exists - see the MVP bullet above), and `vanilla` otherwise.
    Purely cosmetic (`MinecraftProfile.serverType`, a new field) - never affects how the
    server actually launches - and has a manual override dropdown in Start Settings for when
    the guess is wrong, right next to a description saying so.
  - **Re-adopts a still-running server across a Manager restart**, closing the MVP's own gap.
    Same shape as ARK's `adoptPersistedProcesses`: `startServer` now also persists its pid/
    start time (`store.ts`'s new `minecraftRunningPids`/`minecraftRunningStartedAt`, same
    write-resilience wrapper as ARK's own), and `adoptPersistedMinecraftProcesses`
    (`minecraftProcess.ts`, called from `main/index.ts` at boot) re-attaches to any pid still
    alive. An adopted server has no live `ChildProcess` handle (`RunningMinecraftServer.process`
    is now nullable) - so no piped stdout for the Console tab and no stdin to send commands
    to. `sendStdinCommand`/`stopServer`'s graceful stop and the IPC send-command handler all
    fall back to RCON (if enabled) for one of these; the Console tab shows a plain note
    instead of a silently-empty feed (`MinecraftServerStatus.consoleAvailable`). Force-kill
    and the stop-timeout fallback already went through a tracked pid rather than the child
    handle (see the script-mode pid-tracking fix above), so they needed no further change
    beyond `waitForExitOrKill`/`killServer` also finalizing the entry's bookkeeping manually
    for a null `process` (a live one already does this via its own `child.on('exit')`).
  - **Scheduled restart**, a new **Server Management** tab - `minecraftScheduledActions.ts`
    is the restart half only of ARK's own `scheduledActions.ts` (no SteamCMD-equivalent
    update step to schedule around, and no dino-wipe equivalent), reusing the exact same
    day-of-week + time cron mechanism (`shared/scheduleTime.ts`'s `buildDayOfWeekCron`,
    `node-cron`) and the renderer's existing `ScheduleDaysPicker` component unchanged. New
    `MinecraftProfile` fields: `scheduledRestartEnabled`/`Time`/`Days`/`StartAfter` (the last
    one, unchecked, turns it into a plain scheduled shutdown with no restart).
    `startOnManagerLaunch` moved here too from Start Settings, matching ARK's own tab layout.
  - **Server Settings, a new tab that edits server.properties itself** - the "Settings" tab
    is renamed **Start Settings** (it only ever covered how the Manager launches the process:
    jar/script, memory, ...) to make room for it. `upsertServerPropertiesKeys`
    (`minecraftProperties.ts`) is a line-based, non-destructive write: each key's existing
    `key=value` line has just its value replaced, a key with no existing line is appended,
    and everything else in the file (comments, ordering, a plugin's own custom key) is left
    untouched - never a full rewrite from parsed data, which would have silently dropped all
    of that. The tab itself mirrors MCSS's own property editor layout (Gameplay/Appearance/
    World/Networking/Miscellaneous sections, booleans as checkboxes) via two new IPC calls
    (`minecraft.properties.get`/`save`, `ipc/minecraft.ts`) - Minecraft only re-reads this
    file at its own startup, so an edit here takes effect on the server's next start, not
    live, same as editing it by hand always did.

- **Minecraft follow-up 2: layout fix, address on the card, fuller console, chat mode, icon switch.**
  - **Fixed the Server Settings tab's broken layout** (a real report, with a screenshot
    showing a large blank area and the sections not lining up). Root cause: the intro
    paragraph ("You are editing server.properties...") was a direct child of the flex-wrap
    row (`.server-settings-tab`) with no width rule of its own, so the browser sized it by
    its *unwrapped, single-line* intrinsic width - a very wide phantom flex item that pushed
    every section after it onto its own row with a large gap. The same row-wrap layout is
    shared with Server Management's `.schedule-section` row, so the CSS fix (an explicit
    `flex: 1 1 100%` for any stray `.empty-state`/`.error-message` text directly in either
    row, matching the rule that already existed just for `.error-message`) was applied to
    both, defensively.
  - **Dashboard card shows player count and a clickable IP:Port**, next to the existing
    server type - the port is read once per profile via the new `minecraft.properties.get`
    call (server-port from server.properties), the host is the machine's own first
    non-internal local network IP (`webDashboard.getLocalIps()`, already used elsewhere -
    reused rather than duplicated). Click copies `<ip>:<port>` to the clipboard (a brief
    "Copied!" replaces the text), meant for handing straight to a friend to connect with -
    `localhost` wouldn't work for anyone but the host machine, which is why this doesn't
    just show that instead.
  - **Console tab now fills the available window height** instead of leaving a large empty
    area below a fixed `60vh` box, regardless of window size.
  - **Chat mode** - a new checkbox next to Auto-scroll; while checked, whatever's typed into
    the command box is sent as `say <text>` (a broadcast chat message) instead of being sent
    as a raw server command, so the same box doubles as a way to talk to players without
    typing `say ` by hand every time.
  - **ARK/MC sidebar switch now uses icons instead of text** - the existing ARK: Survival
    Evolved game icon (already bundled for the Dashboard's own per-card game icon) for ARK,
    and a new bundled Minecraft icon (`assets/games/minecraft.png`) for MC - dimmed when not
    the active mode, full opacity when active, same "muted until active" language as the
    rest of the sidebar.

- **Minecraft follow-up 3: fixed a real crash (blank window) on Server Management, card
  reorder, trimmed descriptions.**
  - **Fixed a genuine crash**, reported as the whole Manager window going completely
    blank the instant Server Management was opened. Root cause: `serverType` and every
    `scheduledRestart*` field were added to `MinecraftProfile` in later passes, and unlike
    ARK's `ServerProfile` (which backfills newly-added fields on every read via
    `migrateProfile`, called from `listProfiles()`), nothing did the equivalent for
    Minecraft profiles - so a profile saved before those fields existed genuinely has
    `scheduledRestartDays: undefined` at runtime, despite the stored type claiming
    otherwise. `ScheduleDaysPicker` calls `.includes()` directly on that prop with no
    guard, so opening the tab threw an uncaught exception during render, and with no error
    boundary anywhere in the app, React just unmounts the entire tree - a blank window is
    exactly what an uncaught render error looks like here. Fixed with a new
    `migrateMinecraftProfile` (`minecraftProfileMigration.ts`), mirroring ARK's own
    `migrateProfile` exactly, wired into `listMinecraftProfiles()` in `store.ts`.
  - **Dashboard card: players moved next to CPU, Address moved to its own line below
    everything.** The 2-column info grid is now CPU/Players (when running) then Type/RAM,
    instead of Type/Address/Players/CPU/RAM all interleaved in one grid - Address sits on
    its own full-width line underneath the grid instead.
  - **Trimmed two descriptions down to just the parameter name/a one-line hint**: the
    Console tab's "Chat mode" checkbox no longer has a `(sends as /say)` parenthetical next
    to its label, and Server Settings' Online Mode hint was cut from a long paragraph
    (cracked servers, minecraft.net downtime, ...) down to one line.

- **Dashboard groups: reorderable, collapse persists, minimized groups skip the aggregate views.**
  - Groups on the Dashboard can now be dragged to reorder (same `⠿` drag-handle pattern as
    server cards), persisted manager-wide as `AppSettings.groupOrder`. A group not yet in that
    list falls back to alphabetical order, appended after every explicitly-ordered one, so a
    brand new group name just appears without needing to be added to the order first.
  - Collapsing/expanding a group (the native `<details>` triangle) now persists too
    (`AppSettings.collapsedGroups`) - previously the `open` attribute was hardcoded, so any
    re-render (a status tick, a new profile) silently re-expanded a group the user had just
    collapsed.
  - A collapsed group's servers are also left out of the Cluster Dashboard
    (`ClusterDataView.tsx`) and both of the Web Dashboard's own aggregate views (its
    "Dashboard" card-grid tab and its own "Cluster Dashboard" tab) - not just visually
    minimized on the Manager's own Dashboard. The server itself stays fully manageable
    everywhere else (still listed in every Web Dashboard server picker, still reachable by
    its own direct Console/Settings/etc.) - only the aggregate summary views skip it. The Web
    Dashboard's `/api/servers` response carries a new `groupCollapsed` boolean per server for
    this, computed server-side from the same `AppSettings.collapsedGroups`.

- **New Manager-wide setting: "Show the server's own console/debug window"** (Settings →
  General → Startup & Safety, `AppSettings.showServerConsoleWindow`, default on - unchanged
  behavior). Both games allocate their own small-font console window the moment their exe is
  spawned (ARK: Survival Evolved's through the `.bat`/cmd.exe it launches via, ARK: Survival
  Ascended's directly) - there's no launch flag that suppresses it and no way to resize its
  font from the Manager. Unchecking this passes Node's own `windowsHide` to both spawn calls
  instead, which stops Windows from ever creating the window - the server itself, and its own
  log file, are unaffected either way. No-op on non-Windows.

- **ARK: Survival Evolved: Backup tab's Player Profile Backups section removed.** Its own
  `.profilebak`/log format for this isn't verified the way ARK: Survival Ascended's is (see
  `GameDefinition.supportsPlayerProfileBackups`, already `false` for it) - the desktop
  Backups tab now actually hides the whole section (checkbox, backups-to-keep field, and the
  browse/restore panel) instead of showing controls for a feature that was already a silent
  no-op. The Web Dashboard's own Backup tab still shows it unconditionally for every game -
  not yet fixed there (same class of gap as the "Not yet done" note above).

- **ARK: Survival Evolved: update checking turned off.** Its dedicated server is no longer
  developed - SteamCMD's public branch build id for it essentially never changes, so
  comparing against it had nothing useful to say and could only ever show a permanently-stale
  "No new update available." New `GameDefinition.supportsUpdateCheck` flag (`false` for it,
  `true` for ARK: Survival Ascended) gates both the background poller (`updateCheck.ts`, was
  polling SteamCMD for every SteamCMD-based game every 30 minutes regardless of whether
  anything displayed it) and the Analytics tab's "New update"/"A server update is available"
  panel. The SteamCMD **install/update** button itself (Dashboard card, Update Log tab) is
  untouched - installing/updating ARK: Survival Evolved's server files still works exactly as
  before, this only turns off the separate "is a newer build available" check.

- **ARK: Survival Evolved: game version display made more robust, cause of the original
  report not conclusively found.** A real report said the Analytics/Dashboard version display
  still wasn't updating for ARK: Survival Evolved servers, even after the earlier fix that
  confirmed the version-line regex itself matches a real log line
  (`serverVersion.test.ts`). Static review of the whole pipeline (log path, the edge-triggered
  cache in `serverVersionWatcher.ts`, the 'running'-transition/fallback timing, the .bat/pid
  hand-off code) found nothing ARK: Survival Evolved-specific - every step is shared,
  game-agnostic code already exercised by ARK: Survival Ascended working correctly. One real
  gap was found and fixed regardless: `IPC.serverGetGameVersion` only ever returned whatever
  `serverVersionWatcher.ts`'s edge-triggered state tracking had already cached, so if that
  tracking ever missed the right transition for any reason, the polling both the Dashboard and
  Analytics tab already do would keep re-reading the same stale (possibly still-null) cache
  forever rather than ever re-checking the log file directly. It now falls back to a live log
  read whenever nothing's cached yet, caching whatever it finds - this can only help, but
  wasn't confirmed to be *the* cause, since the mechanism this replaces looked structurally
  sound on inspection. If the version still doesn't appear after this, that points at
  something below this app's own version-reading code (e.g. the log file's actual on-disk
  path/content on a real installation) rather than the cache/polling layer.

- **Root cause found for both the empty console and the missing version: `-log` is required
  after all.** A previous pass here considered and rejected adding `-log` back to ARK:
  Survival Evolved's launch args, on the strength of a test that encoded an earlier
  real-hardware confirmation that it was deliberately left out. A real report has since
  confirmed the opposite: without it, `ShooterGame.log` - the file the Manager's Console/
  Cluster Console/Web Dashboard console and version detection all read - never fills in the
  way the Manager needs, even though `-servergamelog` is also passed. `-servergamelog` turns
  out to control a separate, dated tribe-log feature (`ServerGame.<date>.txt`), not the
  engine's own log; `-log` is what actually was missing. `buildLaunchArgs` now pushes both for
  ARK: Survival Evolved (`-servergamelog` for the tribe logs, `-log` right after it for the
  engine log), and `launchArgs.test.ts` is updated to match. The earlier "-log deliberately
  omitted" confirmation was apparently about getting the server to *launch* successfully, not
  about whether the file the Manager reads actually fills in - two different things that
  happened to get conflated.

- **ARK: Survival Evolved: Zombie Detection now also watches for a frozen world while
  running, not just a stuck startup.** A real report described a server that stayed "running"
  (process alive, sometimes still RCON-reachable) with its actual game loop frozen - the
  existing Zombie Detection (`zombieDetection.ts`) only ever watched the `starting` phase, so
  it had nothing to say about that. It now also arms, ARK: Survival Evolved only, the moment a
  profile reaches `running`: every minute it checks whether `ShooterGame.log` has grown at all
  since the last check; if it stays exactly the same size for a full
  `zombieDetectionTimeoutMinutes`, that's treated as a frozen world tick and killed the same
  way (optionally auto-restarted), reusing the same settings already on the Server Management
  tab. A momentarily-unreadable log (a stat error, a rotation race) is never itself treated as
  zombie evidence - only a confirmed *unchanged* size counts, so a transient glitch can't cause
  a false-positive kill. ARK: Survival Ascended doesn't get this second watch - its own
  startup-stuck check already covers the zombie scenario actually reported for it, and this
  would otherwise be an unverified, unrequested behavior change. (The specific example log line
  a report pointed at - a seasonal "Set `<event>` event location: ..." line written once during
  world init - wasn't used as the literal signal: it's not confirmed to repeat during normal
  running, and every seasonal event's location line apparently gets logged at boot regardless
  of the calendar, so hardcoding one particular event's text would be both fragile and
  unnecessary. Watching whether the log is growing *at all* is the same idea, generalized
  safely to whatever a real server actually logs on its own.)

- **ARK: Survival Evolved: join/leave events now show up in the Console/Cluster Console/Web
  Dashboard.** With `-log` now filling in `ShooterGame.log` for it, a real excerpt showed its
  join/leave wording is simply different from ARK: Survival Ascended's, not just delayed -
  `logEvents.ts`'s `JOIN_LEFT_RE` requires a `[UniqueNetId: ... Platform: ...]` bracket ARK:
  Survival Evolved never writes at all. It instead logs `<Player> joined/left this ARK!
  (<SteamID64>)` with an optional trailing `(TribeID: <id>)`, on a plain line with no bracket
  - now matched by a new `JOIN_LEFT_ALT_RE`, tried whenever the first one doesn't match. The
  same real excerpt also showed ARK: Survival Evolved writing a second, earlier line for the
  very same join/leave (inner-timestamped, no Steam ID, no bracket either) - deliberately left
  unmatched by requiring the Steam ID group, the same "avoid a duplicate" pattern already used
  for "Frozen by ID" just below it, rather than emitting the same join/leave twice. Kill events
  needed no change - `rest.includes('was killed by')` already isn't wording-specific enough to
  care which game wrote it, confirmed against a real (RichColor-wrapped, tribe/day-prefixed)
  ARK: Survival Evolved kill line and its plainer global-log echo, both already categorized
  correctly (if the tribe-log-styled one is displayed with a bit of leftover
  `Tribe X, ID Y: Day N, HH:MM:SS:` prefix and a stray trailing `)` from the engine's own
  formatting - cosmetic, not a bug, and not new to ARK: Survival Evolved).

- **Fixed a real bug, unrelated to ARK: Survival Evolved specifically: RCON could flood the
  console with uncaught "read ECONNRESET" exceptions.** A real report showed dozens of these
  in the Manager's own terminal/command-prompt window (not crashing it, but clearly a bug) -
  traced to a genuine gap in the `rcon-client` package. `sendRconCommand` (`rcon.ts`) already
  attached a no-op `'error'` listener to guard against exactly this, but only *after*
  `Rcon.connect()` resolved - and `connect()` itself authenticates over the socket as its last
  step. A connection reset during that authentication exchange fires the socket's `'error'`
  event - which `rcon-client` re-emits on the `Rcon` instance's own `EventEmitter` - before
  `connect()`'s promise (and therefore our listener) exists yet. With no listener at that
  moment, Node's default behavior for an unhandled `'error'` event is to throw, once per RCON
  call that happens to land in that window - and RCON gets polled every few seconds. Fixed by
  constructing the `Rcon` instance directly (`new Rcon(config)`) and attaching the listener
  *before* calling `.connect()`, rather than using the `Rcon.connect(config)` static helper -
  closes the window entirely rather than narrowing it. Reproduced and locked in with a real
  test (`tests/rcon.test.ts`): a fake TCP server that accepts the connection and resets it the
  moment it receives the auth packet, confirmed to genuinely throw an uncaught `ECONNRESET`
  against the pre-fix code and pass cleanly against the fix.

- **Fixed a much bigger bug in the same family: a Windows disk-write failure could break
  actual server actions, not just spam the console.** A real report showed a raw libuv
  "UNKNOWN: unknown error, write" (a generic Windows I/O failure - a full disk, a locked
  file, antivirus, a dropped network drive, ...) thrown from `logManagerEvent` during a Stop,
  and separately from `recordStatSample` inside `monitor.ts`'s `tick()` - and, worse, a server
  stuck showing as running in the UI long after it had actually stopped, with every further
  action against it (Kill included) failing the same way. Every one of these best-effort,
  secondary persistence calls previously let a disk-level failure throw straight out:
  - `logManagerEvent` (`managerLog.ts`) is called directly from `doStartServer`/
    `doStopServer`/`doKillServer`/... - a throw there turned an action that had *already
    succeeded* into a reported failure, since in every one of those the real work (actually
    stopping/killing the process) runs before the logging call.
  - `recordStatSample` (`statsHistory.ts`) runs inside `monitor.ts`'s `tick()`, called as
    `void tick(profile)` - not awaited or caught by anything - so a throw there became an
    unhandled promise rejection, once per running stats-enabled profile, every ~5 seconds.
  - `appendEventsToArchive` (`clusterLogArchive.ts`) runs as a listener on the shared
    `serverEvents` `EventEmitter` (`registerClusterLogArchiveWatch`) - and a listener that
    throws synchronously aborts that same `emit()` call for every other listener registered
    after it, on that exact status change, for every running profile roughly every 2 seconds.
  - **The likely actual explanation for the stuck-as-running server**: `serverProcess.ts`'s
    `finalizeStopped` (and `startServer`'s own success path) call `setRunningPid`/
    `setRunningStartedAt` (`store.ts`, persisted via `electron-store`) *immediately before*
    `emitStatus()` - the one call that actually updates the renderer's view of a server's
    state. If either persist call threw, `emitStatus()` right after it never ran at all,
    leaving the UI showing the previous state indefinitely even though the Manager's own
    internal tracking (`running.delete(profileId)`, run just before) had already moved on.
  
  All four now catch and log to `console.error` instead of throwing - persisting a log entry,
  a stats sample, an archived event, or the running-pid bookkeeping used only to re-adopt a
  process after a Manager restart, is allowed to fail without taking the actual action (or
  another module's unrelated `serverEvents` listener) down with it. Each fix has its own test
  simulating the write failure directly (`vi.spyOn` on `fs.appendFileSync`/`writeFileSync` or,
  for `store.ts`, `Store.prototype.set`) and asserting the surrounding call no longer throws -
  including, for the archive listener specifically, a test proving a later-registered
  `serverEvents` listener still fires when an earlier one's write fails, the exact class of
  bug this was.

- **Follow-up: the same class of bug existed on the read side too, and a real report showed
  it - fixed the same way.** Once writes stopped throwing, reads started showing up in the
  same report instead: `readAllSamples` (`statsHistory.ts`, behind the `stats-history:get`
  IPC handler the Analytics tab/Cluster Dashboard poll every 5s), `readManagerLog`
  (`managerLog.ts`, the Manager Log view's own read), and `readFileTail` (`logEvents.ts`,
  shared by the desktop Console tab, the Web Dashboard's console, and the Cluster Data group
  console) all called `fs.readFileSync`/`fs.readSync` unguarded. All three now catch and log
  to `console.error`, returning an empty result (`[]`/`''`) instead of throwing back out.
  `readAllSamples` needed one extra bit of care its write-side counterpart didn't: on a read
  failure it deliberately does *not* cache the empty result the way it does for "the file
  genuinely doesn't exist yet" - caching `[]` there would make every future read look
  identical to "no history" forever, even once the disk recovers, and would make
  `recordStatSample`'s own cache-append logic start accumulating into a wrongly-reset empty
  cache in the meantime. A test locks this in: a failed read returns `[]` once, but a real
  sample recorded before the failure is still there on the very next successful read.

  **This pattern - the exact same generic Windows I/O error (`UNKNOWN`, `errno: -4094`) now
  hitting reads *and* writes, across the Manager's own data directory, repeatedly rather than
  as a one-off - stopped looking like something more exception-handling can fix.** The same
  report also showed `restoreBackup` (`backup.ts`) failing with the identical error code from
  inside a third-party zip-extraction call, writing into the *server's own* install directory
  - a completely different location from the Manager's own data folder that every fix above
  touches. A restore that can't write its extracted files is a genuine failure with nothing to
  gracefully degrade to (unlike a log line or a stats sample, there's no correct "pretend it
  worked" for a restore), so that one is already surfacing correctly as a reported error
  rather than crashing anything - it's included here only as evidence of how broad this is.
  Two unrelated directories on the same machine, both reads and writes, recurring rather than
  transient: this points at something below the app entirely (the disk itself full or
  failing, a sync client like OneDrive holding files open, antivirus actively blocking I/O to
  these paths, or a dropped network drive) rather than a specific code path still left to
  harden.

- **Second follow-up, and the actual resolution.** Disk space was fine (checked, plenty free
  on every drive) and CrystalDiskInfo showed the physical drive itself (an internal NVMe,
  ruling out the "flaky external/virtual disk" theory) as healthy - yet the exact same error
  kept recurring, next caught crashing `'server:start'` itself: `readIniFile` (`config.ts`,
  used by `readAdminPassword`, called from `buildLaunchArgs` on every single start) threw
  straight out, meaning a server couldn't even be started while this was happening. Also
  hardened the same way while already in the area, all on the same "a real report showed
  this recurring" evidence: `getInstalledBuildId`/`checkInstallUpToDate`/`readUpdateLog`/
  `readNewContentLog`/`clearStuckManifest` (`steamcmd.ts`, the Dashboard's Install-vs-Update
  state and the Update Log tab), `readMapDefinitionsFile` (`jsonListFile.ts`, maps.json/
  customMaps.json - including the write that creates the file fresh on its very first read),
  and `upsertIniKey`/`upsertIniRepeatedKey` (`gameConfigWrite.ts`, ARK: Survival Evolved's
  mod-save writes) - the last of which needed the same care as `readAllSamples` above, for
  an even higher-stakes reason: falling back to `''` on a read failure the way a genuinely
  missing file is handled would make the subsequent write think there was nothing in the
  file to begin with, and overwrite the user's real `GameUserSettings.ini`/`Game.ini`
  content with just the one key being upserted - actual data loss, not just a missed update.
  It now aborts the write entirely (leaving the file untouched) when the read that's
  supposed to feed it fails, locked in by a test that writes real content, fails the read,
  and asserts the file is still exactly what it was before.

  It turned out to be exactly the kind of thing this pattern pointed at: **a reboot of the
  machine resolved it.** Not a disk fault, not something in the app - a stuck driver/OS-level
  I/O state that a restart cleared. Every fix in both of these sessions stands regardless -
  they're general resilience against a real, reproducible class of failure (a disk-level
  read/write erroring out transiently), not specific to this one report's eventual cause, and
  cost nothing when nothing's wrong.

- **Minecraft follow-up 4: dashboard card polish, a Backup tab, a persistent+colorized console.**
  - **Card header gets the MC icon** (`assets/games/minecraft.png`, already bundled for the
    sidebar switch) next to the server name, same placement as ARK's own `server-card-game-icon`.
    **Address moved back inside the dark info panel** as its own full-width row (`.server-card-info-address`,
    `grid-column: 1 / -1`) alongside CPU/Players/Type/RAM instead of sitting in a separate div
    below it, and **Players is now always shown** (a `-` placeholder when the status doesn't
    have a player list yet) instead of being hidden entirely until the first status tick with
    a non-empty list.
  - **New Backup tab**, modeled on ARK's own Backups tab but backing up the *world* instead of
    a map's SavedArks folder: two new `MinecraftProfile` fields (`backupDir`, `maxBackups`,
    plus `backupSchedule`/`backupScheduleEnabled` for the same optional cron-driven automatic
    backups ARK has - all four backfilled in `migrateMinecraftProfile` for any profile saved
    before this pass). `minecraftBackup.ts`'s `worldDirs()` reads `level-name` from
    server.properties (defaulting to `world`, same as the vanilla server itself) and backs up
    whichever of `<level-name>`/`<level-name>_nether`/`<level-name>_the_end` actually exist -
    every server type (vanilla/Paper/Spigot/Forge/Fabric) uses this same per-dimension folder
    convention. While the server's running, `createMinecraftBackup` sends `save-off` then
    `save-all flush` (stdin first, RCON fallback - `sendSaveCommand`) and waits a short settle
    before zipping, then re-enables autosave with `save-on` - best-effort rather than
    cancel-on-failure like ARK's own SaveGame/RCON gate, since Minecraft's autosave already
    runs on its own every few minutes regardless, so the worst case here is a backup that's a
    few seconds staler than requested. `minecraftBackupSchedule.ts` mirrors ARK's own
    `schedule.ts` self-arming-setTimeout mechanism (armed only while the server is running,
    re-armed on every status transition into 'running'). New IPC namespace
    (`window.api.minecraft.backup.*`, `ipc/minecraftBackup.ts`) and renderer tab
    (`MinecraftServerDetail/BackupsTab.tsx` + `BackupLogPanel.tsx`), placed before Server
    Management in the tab list.
  - **The console backlog now survives a Manager restart** (and the Minecraft server's own
    restarts too) instead of resetting to empty every time - previously an in-memory ring
    buffer (`consoleBacklogs` Map in `minecraftProcess.ts`) that was explicitly cleared on
    every `startServer()` call and lost outright on a Manager restart. Replaced with
    `minecraftConsoleArchive.ts`, a JSON-Lines file per profile under `getDataDir()` with the
    same size-capped rolling-window trim as ARK's own `clusterLogArchive.ts` (bounded
    read+rewrite only on the rare append that actually crosses the cap, not on every line).
    `startServer()` no longer clears anything on a fresh start, so the archive spans multiple
    server sessions, not just the Manager's own uptime.
  - **Console lines are now color-coded**, matching the screenshots that drove this request:
    a small `classifyConsoleLine` helper in `ConsoleTab.tsx` checks (in priority order, since
    several of these are still logged at plain INFO level) a graceful shutdown starting
    ("Stopping the server") and `/ERROR]`/`/WARN]` for red/red/orange, the "Done (...)! For
    help" ready line for green, "joined the game" for cyan, and "left the game"/"lost
    connection"/"disconnected" for orange - everything else stays the default color. Purely
    cosmetic CSS classes (`.mc-console-line--*`), no change to what's actually stored/sent.

- **Minecraft follow-up 5: card info order, bulk Server Controls, Global Performance, console
  controls repositioned.**
  - **Dashboard card's info panel reordered** to CPU/RAM then Players/Type, with Address still
    its own full-width row underneath - just a JSX reorder (`MinecraftDashboard.tsx`), the grid
    itself is unchanged.
  - **New "Server Controls" bulk-action section** above the server grid, mirroring ARK's own
    (`Dashboard.tsx`) but with only Start All/Restart All/Stop All - no Update All or
    Stop+Update+Restart All, since Minecraft has no SteamCMD-equivalent update step. There's no
    single-profile restart IPC for Minecraft the way ARK has `window.api.server.restart`, so
    Restart All is a plain stop-then-start per running profile, the same sequencing
    `minecraftScheduledActions.ts`'s own scheduled restart already uses.
  - **New "Global Performance" sidebar block**, same `official-status-panel`/
    `group-console-cluster-stats` markup and aggregation (servers running/total, total
    players, total CPU%, total RAM) as ARK's Dashboard, computed across every visible
    Minecraft profile's live status.
  - **Console tab's Chat mode/Auto-scroll checkboxes moved below the feed, right-aligned**
    (new `.mc-console-controls` modifier on the existing `.group-console-filters` row) instead
    of sitting above it - matches the user's own screenshot of the desired layout.
  - **Removed the Console tab's re-adopted-session description paragraph** ("This server was
    already running before the Manager (re)started...") - same ongoing trend of trimming
    explanatory text the user doesn't want cluttering the UI.

- **Fixed: restarting several ARK servers close together left only 1-2 of them actually
  coming back up.** A real report: manually restarting multiple servers resulted in most of
  them just never starting, with no error shown. Investigated and ruled out: port conflicts
  between profiles (confirmed unique), a shared/global RCON connection (each call opens its
  own `Rcon` instance), and a RAM ceiling (the reporting machine had 128GB). The remaining,
  consistent explanation: ARK's own world-loading is heavy enough - much of it
  single-threaded - that several servers spawning in the same instant can starve each other
  out for CPU badly enough that some never finish loading at all.
  - **`serverProcess.ts`'s `startServer` now goes through a global (not per-profile) spawn
    queue** (`reserveSpawnSlot`/`nextSpawnSlotAt`) that enforces at least
    `AppSettings.serverAutoStartStaggerSeconds` between any two ARK servers' actual OS-level
    process spawn - covering every path that can start several close together: a manual
    Start/Restart click, the Dashboard's bulk Start All/Restart All, a scheduled restart, and
    a crash-watch/zombie-detection auto-restart - not just `startOnManagerLaunch` (which
    already staggered itself via `autoStart.ts`, and keeps doing so unchanged; the two don't
    double up in practice since autoStart's own pacing already satisfies this queue by the
    time each of its calls reaches `startServer`). The first start in a batch is never
    delayed - only one requested while another is still within the stagger window waits.
  - A still-queued (not yet actually spawned) start is tracked in the same `running` map as a
    live one, with a new `cancelQueuedSpawn` escape hatch - so a Stop/Kill requested during
    the wait cancels it outright instead of racing the queued spawn and starting it anyway
    right after being told to stop. `getStatus()` reports `starting` consistently through the
    wait too, instead of `stopped` just because nothing had spawned yet.
  - Reused the existing `serverAutoStartStaggerSeconds` setting (renamed in the Settings UI to
    "Minimum delay between servers starting") rather than adding a second one, since it's the
    same underlying concern - Minecraft is unaffected (its own, separate `minecraftProcess.ts`
    was never part of this).
  - New `tests/serverSpawnStagger.test.ts` covers the queue directly: a lone start is never
    delayed, a second one requested immediately after waits out the full stagger, a third
    stacks behind the second (not the first), a well-spaced start incurs no wait, and
    stopping/killing a still-queued start cancels it without ever spawning. Also patched 5
    existing test files (`serverProcessBatchLaunch`, `startServerSpawnOptions`,
    `stopServerPhased`, `findListeningPid`, `unexpectedExit`) to reset the new queue's module
    state between tests - its 10s default stagger would otherwise leak from one `it()` into
    the next real-timer test in the same file and silently defer a spawn they expected
    synchronously.

- **Minecraft Dashboard groups**, matching ARK's own Dashboard group system - `MinecraftProfile.group`
  (set via the Start Settings tab's "Dashboard group" field) already existed but the Minecraft
  Dashboard never actually grouped anything by it. Same markup/behavior as ARK: collapsible
  `<details className="server-group">` sections, a drag handle on each group's summary to
  reorder groups, and collapse state that persists across restarts. Kept in two new,
  Minecraft-only settings (`minecraftGroupOrder`/`minecraftCollapsedGroups`) rather than
  sharing ARK's `groupOrder`/`collapsedGroups`, since an ARK group and a Minecraft group
  happening to share a name shouldn't share display order or collapse state. No new CSS -
  `.server-group`/`.drag-handle`/`.hidden-servers` were already generic, not ARK-specific.

- **Minecraft mod/plugin browsing and installation, v1 (Modrinth only) - new Mods tab.**
  CurseForge is a deliberate follow-up, not implemented here: it needs its own API key
  (register as a developer at console.curseforge.com) and its own client module, while
  Modrinth's v2 API needs no key at all. Everything below is organized so adding CurseForge
  later means a second client module plus a branch in `minecraftMods.ts`, not touching
  `shared/minecraftMods.ts`'s already source-agnostic shapes.
  - **New `MinecraftProfile.minecraftVersion` field** (Start Settings) - a real, previously
    entirely missing prerequisite: nothing else in this app tracks a server's actual Minecraft
    game version, but Modrinth needs it to filter compatible mod/plugin versions. Free text
    (e.g. "1.20.1"), no auto-detection in this pass; the Mods tab shows a clear empty-state
    message asking for it instead of guessing wrong.
  - **`src/main/lib/modrinthClient.ts`**, a thin wrapper around Modrinth's public v2 REST API
    (confirmed directly against Modrinth's own open-source backend models, not just third-party
    docs, since the v2/v3 split made some of the publicly written docs ambiguous). Loader to
    Modrinth "category" facet mapping: Fabric/Forge get their own single category; Paper and
    Spigot share one OR-ed group (`paper`/`spigot`/`bukkit`) since plugins are broadly
    cross-compatible across those three and splitting them would just hide results that work
    fine. Vanilla/unknown get no loader facet at all (and never reach this client - the Mods
    tab and `minecraftMods.ts` both gate on `supportsMinecraftMods` first).
  - **Excludes client-only content, as requested** - `server_side:unsupported` is filtered out
    directly in the search facets (`server_side: required` or `optional` only), not as a
    post-filter, so a mod that does nothing on a dedicated server never shows up as installable
    in the first place.
  - **Dependency resolution, a real first pass, not just planned** -
    `resolveModInstallPlan` in `minecraftMods.ts` walks a version's own `dependencies` and
    recursively resolves every `required` one to an installable version (by exact `version_id`
    when pinned, otherwise the latest compatible version of that `project_id`), skipping
    anything already installed or already queued in the same run (dedup, with a depth cap as a
    cycle safety net - confirmed against a diamond-dependency graph and a direct A-depends-on-B-
    depends-on-A cycle in tests). `embedded` dependencies are skipped outright (already bundled
    in the parent jar); `optional` ones are never auto-installed, just surfaced in the result so
    the Mods tab can tell the user what they could add by hand; `incompatible` ones are only
    reported when the conflicting project is already installed - a warning, not a block.
  - **Install/remove/enable-disable**: downloads the version's primary file (`fetch` +
    `arrayBuffer` + `writeFileSync`, same pattern as `steamcmdInstaller.ts`'s own download),
    verified against Modrinth's own published sha512/sha1 hash before being kept - a corrupted
    download is discarded rather than left as a jar the server might fail to load. Writes to
    `mods/` (Forge/Fabric) or `plugins/` (Paper/Spigot) under the server's install directory.
    Disabling renames the file to add a `.disabled` suffix rather than deleting it (every
    loader only loads `.jar` files from that folder), so re-enabling needs no re-download, and
    updating an already-disabled mod preserves that - it doesn't silently come back enabled.
  - **No version picker in this pass** - Install/Update always resolve to the latest
    compatible version, the same simplification ARK's own mod system already makes (an id,
    no picker there either). A real gap to revisit, not an oversight.
  - New `tests/modrinthClient.test.ts` (facet-building), `tests/minecraftModInstallPlan.test.ts`
    (the dependency-walk algorithm itself, including the diamond-graph and cycle cases, with no
    network/fs touched at all), and `tests/minecraftMods.test.ts` (install/remove/enable-disable/
    update-check against a real temp directory, with Modrinth's own HTTP calls mocked).

- **Recognizes mods/plugins already sitting in the folder, not just ones installed through the
  Mods tab.** `profile.installedMods` used to be the only source of truth, which meant a jar
  dropped in by hand - or installed before this feature existed - simply wasn't tracked. Fixed
  by hashing every untracked `.jar`/`.jar.disabled` file in the mods/plugins folder (sha1) and
  batch-looking the hashes up against Modrinth's `/version_files` endpoint - the same
  identification mechanism Modrinth's own official launcher uses. Matches are adopted straight
  into `profile.installedMods`; anything that doesn't match (CurseForge-sourced, hand-built, or
  genuinely not on Modrinth) is left alone and reported as an `unidentifiedCount` instead of
  silently doing nothing.
  - `getModrinthVersionsFromHashes` in `modrinthClient.ts` wraps the batched `POST
    /v2/version_files` call (`{algorithm, hashes}` -> `Record<hash, Version>`).
    `scanForInstalledMods` in `minecraftMods.ts` does the scanning/hashing/adopting; a new
    `requireLoaderSupportsMods` guard replaces the stricter `requireModsSupported` for this one
    operation specifically, since identifying a file by hash doesn't need
    `profile.minecraftVersion` the way picking a *compatible* version for search/install does -
    so scanning now works even before that field is filled in.
  - Runs automatically whenever the Mods tab opens for a profile, plus an explicit "Rescan
    folder" button for files added while the tab is already open. The Browse Modrinth section
    still asks for a Minecraft version (search needs it to filter compatible versions), but the
    Installed section and its Rescan button no longer wait on it.
  - New `tests/minecraftModScan.test.ts`: hash-match adoption, skip-already-tracked,
    unidentified-count reporting (profile left untouched), `.disabled`-suffix enabled-state
    handling, no API call when nothing is untracked, and works with no `minecraftVersion` set.

- **Fix: scanning a folder with several untracked mods could trip Modrinth's rate limit
  (HTTP 429), reported live by a user with a sizeable mods folder.** Two causes, both fixed:
  - Scanning used to fetch each adopted mod's project info one request at a time
    (`getModrinthProject` in a loop) - a folder with a dozen unrecognized mods meant a dozen
    sequential requests on top of the batched hash lookup. Replaced with a new
    `getModrinthProjects(ids)` in `modrinthClient.ts` (`GET /v2/projects?ids=[...]`, Modrinth's
    own batch counterpart to `/project/{id}`), so `scanForInstalledMods` now costs exactly two
    Modrinth requests total regardless of how many mods it finds: one for the hashes, one for
    every matched project's info (deduplicated, since several versions can belong to the same
    project).
  - There was no recovery from a 429 at all - any transient rate-limit hit failed the whole
    scan outright. `modrinthFetch` (and the raw `/version_files` POST) now retry on 429, waiting
    out the response's `Retry-After` header when present or an exponential backoff otherwise, up
    to 3 retries before actually giving up - self-heals from Modrinth's normal per-minute
    throttling instead of surfacing it as an error.
  - New tests in `tests/modrinthClient.test.ts` (waits out `Retry-After` and retries
    successfully; gives up and throws after exhausting retries) and
    `tests/minecraftModScan.test.ts` (batches the project lookup into one deduplicated call for
    several matched mods).

- **Fix: no visible way to get to the one thing blocking "Browse Modrinth" (install search).**
  A user reported "I don't see a way to add mods" - turned out their server's Minecraft version
  just wasn't set yet, so the Mods tab correctly showed the explanatory message
  ("Set this server's Minecraft version in Start Settings...") but gave no way to act on it
  without manually switching tabs and finding the right field. Added a "Go to Start Settings"
  button under that message (and under the similar "Set Server type to..." message), which jumps
  straight to the Start Settings tab - `MinecraftServerDetail/index.tsx` now passes
  `onGoToStartSettings` down to `ModsTab` instead of just rendering it blind.

- **Four more fixes/additions after a live screenshot (256 installed mods) surfaced them:**
  - **Mod icons weren't loading (broken-image placeholders everywhere).** The renderer's CSP
    (`src/renderer/index.html`) was `default-src 'self'` with no `img-src` at all, which blocks
    `<img>` loads too - Modrinth's icon CDN (`cdn.modrinth.com`) was silently refused by the
    browser, not by anything in this app's own code. Added
    `img-src 'self' data: https://cdn.modrinth.com`. Also added an `onError` handler on both mod
    icon `<img>` tags so a URL that fails to load (dead link, network hiccup) just hides itself
    instead of showing a broken-image icon regardless.
  - **Mods the scan can't identify now still show up in the table, instead of only being
    counted.** `MinecraftModSource` gained a third value, `'unknown'` - not a future source like
    CurseForge, but what `scanForInstalledMods` now assigns to an untracked file whose hash
    doesn't match anything Modrinth knows about. It's still added to `profile.installedMods`
    (synthetic `projectId: "local:<fileName>"`, title falls back to the file name, empty
    version fields), so it still shows up, and because remove/enable-disable already worked
    generically off `projectId`/`fileName`, those just work for it too with no special-casing.
    The Status column shows "Unidentified" (muted, with a tooltip explaining why) instead of
    "Up to date". `checkMinecraftModUpdates` skips `source: 'unknown'` entries (no real Modrinth
    id to check) rather than firing a doomed `/project/local:x.jar/version` request for each
    one. `MinecraftModScanResult.unidentifiedCount` is gone - the same information now comes
    from filtering `adopted` by `source`.
  - **Display bug: Version/Status/Actions columns were stretched out with a dead gap before the
    buttons.** The `mc-mods-table`s had no explicit column widths, so the browser's auto table
    layout gave the empty-header actions column (and the short Version/Status columns) far more
    room than their content needed, pushing the Enable/Disable/Remove buttons away from the row
    they belonged to. New `.mc-mods-col-narrow` class (`width: 1%; white-space: nowrap`) on
    those columns makes them hug their content, so Name/Description (the one column that should
    be wide) absorbs the leftover space instead.
  - **"Open mods folder" / "Open server folder" buttons** - jumping to `mods/`/`plugins/` (or
    the server's install directory) used to mean finding the path by hand. New
    `openMinecraftModsFolder` (`minecraftMods.ts`, creates the folder first if it doesn't exist
    yet) and `openMinecraftServerRootFolder` (`minecraftBackup.ts`, next to the existing
    `openMinecraftBackupFolder`) both just wrap `shell.openPath`, same pattern as every other
    "open folder" button in this app. Buttons added to the Mods tab's Installed section and the
    top of Server Settings, respectively.
  - New tests: `tests/minecraftModScan.test.ts` (unidentified files adopted as `source:
    'unknown'`, mixed identified/unidentified scan, `openMinecraftModsFolder`),
    `tests/minecraftMods.test.ts` (`checkMinecraftModUpdates` skips `'unknown'` entries), and
    new `tests/minecraftServerFolder.test.ts` (`openMinecraftServerRootFolder`).

- **Fix (follow-up): the column-width fix above wasn't enough on its own - Disable/Remove
  (and Update, when present) were still stacking vertically instead of sitting side by side,
  inflating every row's height.** `mc-mods-col-narrow`'s `width: 1%` only works if the column's
  *content* can report an honest minimum width - but the actions cell's `.backup-management-
  actions` has `flex-wrap: wrap`, and a wrapping flex container's min-content width is just its
  single largest item, not the combined width of everything in it (wrapping means it's always
  "allowed" to fall back to one item per line). So the column collapsed to fit one button, and
  the rest wrapped onto their own lines underneath. Added `.mc-mods-table .backup-management-
  actions { flex-wrap: nowrap }` to force one line - three short buttons always fit, and that
  was the whole point of giving the column minimal width in the first place.

- **CurseForge integration, v1 (search, install, update) - the planned follow-up from the
  original Modrinth-only Mods tab is now real.** Gated behind a user-provided API key
  (`AppSettings.curseforgeApiKey`) since CurseForge's Core API requires one, unlike Modrinth's.
  **Get a free key at `console.curseforge.com`**: sign in with a CurseForge/Overwolf account,
  open **API Keys** in the left sidebar, click **Generate new API key**, give it any name, and
  agree to the non-commercial terms - the key shown there goes straight into Settings → General
  → Integrations. Leaving it empty skips CurseForge entirely (not an error) - Modrinth search
  keeps working exactly as before.
  - **`src/main/lib/curseforgeClient.ts`**, a thin wrapper around the CurseForge Core API
    (`api.curseforge.com/v1`), mirroring modrinthClient.ts's own shape (raw CurseForge shapes
    in, this app's own normalized shapes out - handled in minecraftMods.ts, not here). Minecraft
    is game id `432`; Forge/Fabric content is CurseForge "class" `6` (Mods), Paper/Spigot
    content is class `4471` (Bukkit Plugins) - there's no single "mod" class the way Modrinth's
    v2 API flattens it. `modLoaderType` (1 Forge, 4 Fabric) filters search/files for those two;
    Paper/Spigot plugins aren't loader-filtered on CurseForge at all, so it's omitted for them.
    `getCurseForgeModFiles` sorts by `fileDate` itself (CurseForge doesn't guarantee an order)
    so `[0]` is reliably "the latest compatible file" - same "no version picker" simplification
    used everywhere else in this app's mod system.
  - **Search merges both sources** - `searchMinecraftMods` always searches Modrinth, and also
    CurseForge once a key is set, combining and sorting the results by downloads (each tagged
    with its own `source` so the UI can label it). A CurseForge mod with
    `allowModDistribution: false` (the author opted out of third-party downloads) is filtered
    out of results entirely - this app has no file to offer for it anyway. A CurseForge search
    failure (bad key, network hiccup) is logged and dropped rather than failing the whole
    search - Modrinth's own results still come back.
  - **Install/update dependency resolution, same shape as Modrinth's, adapted to CurseForge's
    own model** - `resolveCurseForgeInstallPlan` (mirrors `resolveModInstallPlan`) walks a
    file's `dependencies` (`{modId, relationType}` pairs, not Modrinth's richer
    `{project_id, version_id, dependency_type}`): relationType `3` (RequiredDependency) is
    walked and installed (always the dependency's own latest compatible file - there's no
    per-version pin like Modrinth's `version_id`), `2` (Optional) is surfaced not installed,
    `5` (Incompatible) is a warning only if already installed, and `1`/`4`/`6` (EmbeddedLibrary/
    Tool/Include) are skipped outright. Same depth cap, same dedup-by-already-queued-or-
    installed reasoning, confirmed against the same diamond-graph and cycle test cases as the
    Modrinth version.
  - **`installMinecraftMod`/`updateMinecraftMod` now take a `source` parameter** (IPC/preload/
    `ModsTab.tsx` all updated to pass it through - a search result or an installed entry always
    has its own `source` handy, so this never needs guessing). The original Modrinth install
    function was renamed to `installModrinthMod` (no longer exported) and `installMinecraftMod`
    is now a small dispatcher by source; `'unknown'` throws (there's nothing to install from an
    entry with no real backing id).
  - **Downloads verified against CurseForge's own sha1 hash when published**, same discard-on-
    mismatch behavior as Modrinth's own download path. A file with no `downloadUrl` at all
    (author disabled distribution) fails with a clear message pointing at downloading it from
    CurseForge directly and using Rescan folder instead - not silently skipped.
  - **`checkMinecraftModUpdates` branches per installed entry's `source`** - Modrinth entries
    check Modrinth, CurseForge entries check CurseForge (and are skipped, not failed, if the API
    key was cleared since they were installed), `'unknown'` entries are skipped as before.
  - **Not in this pass**: recognizing already-installed CurseForge mods during a folder scan.
    CurseForge's own file-identification endpoint (`/fingerprints`, confirmed and wired up as
    `getCurseForgeFingerprintMatches`) needs a murmur2 hash of the file with whitespace bytes
    stripped, not a simple file hash - computing one isn't implemented yet, so a CurseForge-
    sourced file sitting in the folder still gets adopted as `source: 'unknown'` by
    `scanForInstalledMods`, same as before this pass. A real, clearly-scoped follow-up.
  - New `tests/curseforgeClient.test.ts` (class/loader-type selection, API key header, 401/403
    error message, file sorting, empty-fingerprint-list shortcut),
    `tests/curseforgeInstallPlan.test.ts` (the dependency-walk algorithm - all the same cases as
    Modrinth's own test file, including the diamond graph and cycle), and
    `tests/minecraftModsCurseForge.test.ts` (search merging/sorting/filtering/fallback, install
    with and without a required dependency, rejecting a no-distribution file, update-check
    flagging and API-key-cleared skip).

- **Fix: "Check for updates" could crash outright with HTTP 429s for a profile with a large
  mods folder (one real report had 256 Modrinth-sourced mods), and the scan/batch-project fix
  from the previous round didn't cover this path at all - it only fixed scanning.**
  `checkMinecraftModUpdates` fired one request per installed mod via a bare
  `Promise.all(installedMods.map(...))` - every request in the very same tick, with no pacing
  and no per-item isolation. Two separate problems, both fixed:
  - **No pacing at all** - hundreds of simultaneous requests blew straight through Modrinth's
    300/minute budget on the very first tick, so most of them hit 429 immediately (the
    retry-with-backoff added previously only helps a request that's occasionally rate-limited,
    not literally all of them bursting at once - its 3-retry budget doesn't scale to that much
    contention). New `mapWithRateLimit` paces *dispatching* each mod's check (default 4/second,
    safely under budget) while still letting each one run concurrently once started - a check
    over 256 mods now takes about a minute instead of failing outright, but it actually
    finishes.
  - **One mod's failure killed every other mod's result** - `Promise.all` rejects on the first
    rejection, so even with pacing, a single mod that still ends up rate-limited (or hits any
    other transient error) would throw away the results already computed for every other mod in
    the batch. Each mod's check is now wrapped in its own try/catch inside the mapper - a
    failure just means that one mod is skipped this round (no update badge until the next
    "Check for updates" click), not that the whole feature errors out.
  - New tests in `tests/minecraftMods.test.ts` (one mod's request failing doesn't take out the
    other mod's result).

- **Fix (the real cause this time, confirmed from a live screenshot of 357 installed mods):
  the Installed table's Name column had no width constraint at all, so on a wide window it
  absorbed every pixel of leftover space - Source/Version/Status/the action buttons ended up
  pushed almost entirely off to the right, with a huge empty gap inside the Name column before
  them.** The previous two rounds (narrow-column widths, then flex-wrap: nowrap) were each
  real bugs and genuinely needed fixing, but neither was *this* - the data was always correctly
  aligned under its own headers, the headers themselves just ended up bunched together far to
  the right because Name, the one column with no explicit width, grew to fill 100% of whatever
  space the other (intentionally narrow) columns didn't need. Fixed with two changes in
  `styles.css`: `.mc-mods-table` now has `max-width: 1040px` (the section around it stays
  full-width, matching the rest of this app - just the table itself stops growing past a
  reasonable size), and a new `.mc-mods-col-name` (`width: 38%`) on the Name header in both
  tables gives the browser an explicit hint instead of leaving it to soak up 100% of whatever's
  left.

- **Follow-up fix: still a visible gap between Name and Source after the above, confirmed from
  another screenshot.** `.mc-mods-table` still had `width: 100%`, so even capped at 1040px the
  table was *forced* to reach that width regardless of whether its content needed it - most mod
  names are short, so `.mc-mods-col-name`'s 38% share was still mostly empty space most rows
  didn't need. Removed `width: 100%` entirely (keeping only `max-width: 1040px` as a safety
  cap) so the table defaults to shrinking-to-fit the sum of its columns' actual content widths
  instead of being stretched to a fixed width no matter what - `.mc-mods-col-name` is now just
  `white-space: nowrap` (hug the longest name actually present, same "don't reserve a fixed
  share" reasoning as the narrow columns) rather than a fixed 38%. The Browse Modrinth/
  CurseForge results table is the one exception that still wants `width: 100%` - its
  Description column is prose that should wrap within the available width rather than render
  as one unbroken max-content-width line - so it gets a new `.mc-mods-table--browse` modifier
  class restoring that, while the Installed table (no Description column, nothing that
  benefits from stretching) stays shrink-to-fit.

- **Follow-up fix #2: still a gap after the above too, confirmed from a third screenshot - and
  this one's actually just inherent to how tables work, not a bug to "fix" the same way.**
  `white-space: nowrap` on the Name column meant it still sized itself to whichever single mod
  had the longest name across the *entire* 357-mod list ("Beautiful Enchanted Books [MOD
  EDITION]", in that screenshot) - a table column's width is shared by every row, so every
  other, normally-short-named row necessarily had a big dead gap before Source started no
  matter what. The only real fix is to stop letting one outlier dictate the column's width at
  all: `.mc-mods-col-name` now has `max-width: 260px`, and an overflowing name truncates with
  an ellipsis (new `.mc-mod-title` span wrapping the title text, `overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap`, plus `min-width: 0` on both the span and
  `.mc-mod-name-cell` - a flex item's default min-width is its content's natural width, which
  silently defeats `text-overflow: ellipsis` by letting the cell grow past the column's
  max-width instead of actually truncating). The full name is still available as a native
  `title` attribute tooltip on hover. Same treatment in both tables (Browse results and
  Installed).

- **Rebuilt the Mods tab's two tables as CSS Grid instead of `<table>`, after a fourth
  screenshot showed the same shape of gap again despite the fix directly above.** Each of the
  three previous rounds fixed a real, distinct bug (narrow-column width hints, then flex-wrap
  collapsing the actions column, then the table being force-stretched, then one outlier mod
  name sizing the whole column) - but they kept recurring because the underlying mechanism,
  HTML table auto-layout, fundamentally sizes a column from the single most demanding piece of
  content anywhere in that column, across every row at once. There's no way to tell a `<table>`
  "give normal rows a normal width and only truncate the outlier" - short of the per-cell
  `max-width` + ellipsis combination already in place, which *should* have been the final word,
  but kept interacting with table layout in ways that were hard to fully pin down without
  physically running it. Replaced both tables with CSS Grid (`.mc-mods-grid`,
  `grid-template-columns` declaring each column's width once and for all) - header and every
  data row are literally just a flat sequence of same-sized div children of one grid container
  (the `Fragment`-per-row markup in `ModsTab.tsx`, no `<tr>` wrapper), so a column's width is
  now entirely independent of what any row's content does; it can never be widened by one
  outlier or collapsed by `flex-wrap`, because nothing about Grid's explicit track sizing model
  works that way to begin with. `mc-mods-grid--browse` (`minmax(0,260px) minmax(0,1fr) 100px
  110px auto`) keeps Description as the one wrapping/flexible column; `mc-mods-grid--installed`
  (`minmax(0,1fr) 100px 150px 130px auto`) gives Name the flexible share instead. The
  `mc-mod-title` ellipsis-plus-tooltip treatment from the previous fix carries over unchanged
  (still needed - Grid doesn't make genuinely long content disappear, it just stops that
  content from distorting every other row).

- **Follow-up: the Grid version was still sitting cramped on the left of a wide window, not
  using the available width.** `.mc-mods-grid` kept the old `max-width: 1040px` cap from the
  `<table>` era, carried over without reconsidering it. That cap existed because a `<table>`'s
  `width: 100%` was unpredictable (the exact bug this whole thread of fixes was chasing) - but
  Grid's `fr` units don't have that problem: `minmax(0, 1fr)` is a deterministic share of
  whatever width the grid actually has, regardless of any row's content, so there's no outlier-
  content failure mode to reintroduce by letting it stretch. `.mc-mods-grid` now has
  `width: 100%` (with a much larger `max-width: 1600px` just as a sanity cap for a genuinely
  huge monitor) - the flexible column (Description in the Browse grid, Name in the Installed
  grid) now actually fills the section's width instead of leaving most of the window empty.

- **CurseForge fingerprint matching for scanForInstalledMods - the deliberate follow-up flagged
  in the CurseForge v1 entry above is now implemented.** A file Modrinth's hash lookup didn't
  recognize used to become `source: 'unknown'` outright, even if it was actually a CurseForge
  mod the app could have identified. Now, when `AppSettings.curseforgeApiKey` is set, anything
  still unmatched after the Modrinth pass gets a second pass against CurseForge's own file-
  identification scheme before falling back to `'unknown'`.
  - **New `src/main/lib/curseforgeFingerprint.ts`**: CurseForge doesn't use a normal file hash
    for this - it's MurmurHash2 (32-bit, the original Austin Appleby algorithm, seed `1`)
    computed over the file's bytes with whitespace bytes (tab/LF/CR/space) stripped out first.
    This is CurseForge's own published algorithm (the same one their official app and every
    third-party CurseForge-aware launcher uses), not something invented here -
    `computeCurseForgeFingerprint(buffer)` implements it directly against the reference
    description. *Caveat worth being upfront about*: this sandbox has no network access to
    CurseForge to validate the implementation against a real server response, so it's verified
    here by internal consistency (determinism, the whitespace-stripping behavior specifically,
    tail-byte handling for lengths not a multiple of 4) rather than a known-good fingerprint
    value from a real file. If it doesn't actually match anything on a real mods folder, that's
    the first thing to double-check.
  - **`scanForInstalledMods` reads each file's bytes once**, computing both the sha1 (for
    Modrinth) and the CurseForge fingerprint (for CurseForge) from the same buffer, rather than
    reading the file twice for two different identification schemes.
  - **Only fingerprints for files Modrinth didn't already match are sent to CurseForge** -
    consistent with the whole app's existing "don't cost more requests than necessary" pattern
    (the same reasoning as the earlier Modrinth batch-project fix for this same function).
  - **New `getCurseForgeMods` batch function** (`POST /v1/mods`, CurseForge's own counterpart to
    Modrinth's `/projects`) fetches every matched mod's title/slug/icon in one request instead
    of one per match - the exact N+1 mistake already fixed once for Modrinth's own scan path,
    avoided here from the start instead of needing a second round of discovery.
  - **A CurseForge fingerprint-check failure doesn't lose the Modrinth matches already found** -
    wrapped in its own try/catch (logged as a soft warning), same "one source's failure
    shouldn't take down the other's results" reasoning used for the search path's own
    CurseForge try/catch.
  - New `tests/curseforgeFingerprint.test.ts` (determinism, different-content differences, the
    whitespace-stripping behavior specifically, tail-byte lengths, always-unsigned-32-bit) and
    new tests in `tests/minecraftModScan.test.ts` (no CurseForge key - no CurseForge calls made;
    a fingerprint match adopts as `source: 'curseforge'`; only unmatched files' fingerprints are
    sent; still falls back to `'unknown'` when CurseForge also finds nothing; a CurseForge
    failure doesn't lose the Modrinth-matched results).

- **Fix: CurseForge fingerprint matching never actually found anything, even for a mod
  confirmed to be on CurseForge (findable by searching for it by name in the Browse tab).** Not
  a bug in the fingerprint algorithm itself - that part was verified independently (see below) -
  but in `scanForInstalledMods`'s own tracking logic, and it's a bug that predates CurseForge
  support entirely: `trackedFileNames` (now `settledFileNames`) was built from *every* installed
  mod's file name, `source: 'unknown'` included. Once a file got adopted as `'unknown'` on some
  earlier scan (back when only Modrinth hash-matching existed, or before a CurseForge key was
  ever configured), it counted as "tracked" from then on - so `listUntrackedModFiles` excluded
  it from every future scan, permanently. The file was never wrong about being unidentified at
  the time; it just could never be re-examined later, even after this app gained a second
  identification method entirely.
  - **Fixed by splitting "tracked" into two states**: only a real match (`source: 'modrinth'` or
    `'curseforge'`) is now treated as settled and excluded from re-scanning; a `'unknown'` entry
    is included in `untracked` again on every scan, so it gets a fresh shot at both Modrinth and
    CurseForge matching each time - a newly-configured API key, or a mod that's since been
    published, can now actually fix a previously-"Unidentified" row. A file still unmatched
    isn't re-added as a duplicate (its existing `'unknown'` entry is just left alone); a file
    that *does* get matched this time has its stale `'unknown'` entry replaced by the real one,
    rather than ending up tracked twice under the same file name.
  - **Verifying the fingerprint algorithm itself, since no network access to CurseForge exists
    in this sandbox to test against a live response**: cross-checked the core MurmurHash2
    implementation against an independent npm package's own published test vector (input bytes
    `[1,2,3,4]`, seed `0`, expected output `1487941662`) - confirmed to match exactly, so the
    hashing math itself is correct. The CurseForge-specific details (seed `1`; the four
    whitespace byte values `0x09`/`0x0a`/`0x0d`/`0x20` stripped before hashing; the
    `/v1/fingerprints` endpoint path; the request body `{fingerprints: [...]}`; the `File`
    object's `fileFingerprint` field name) were each independently confirmed against a public
    OpenAPI spec and multiple third-party CurseForge API client libraries' own documentation,
    not just a single source. None of that pointed to a bug - which is what led to looking at
    the tracking logic instead, and that's where the actual bug was.
  - New tests in `tests/minecraftModScan.test.ts`: a file previously adopted as `'unknown'` gets
    re-examined and upgraded to `'curseforge'` once a match exists; an `'unknown'` entry that's
    still unmatched isn't duplicated or re-reported as newly adopted on a later scan.

- **Addition: a mod published identically on both Modrinth and CurseForge used to just show
  one of the two in the Source column, since a file already matched by Modrinth was never even
  checked against CurseForge.** `scanForInstalledMods` now checks CurseForge fingerprints for
  *every* untracked file, not just the ones Modrinth missed - a file matched by both (same
  bytes, so the same sha1 *and* the same CurseForge fingerprint) keeps Modrinth as its primary
  `source` (the one actually used for install/update, since Modrinth needs no API key), but
  gains a new `alsoOn: ['curseforge']`. The Mods tab's Source column now shows "Modrinth,
  CurseForge" for that case instead of silently implying it's Modrinth-only.
  - `InstalledMinecraftMod.alsoOn?: MinecraftModSource[]` - purely informational, only set by a
    scan that actually checked both sources for that exact file; an entry from before this
    existed (or one `source`'s match from a profile that's never had a CurseForge key
    configured) won't have it retroactively without a fresh Rescan.
  - New `installedSourceLabel` in `ModsTab.tsx` joins `source` and `alsoOn` for display
    (`"Modrinth, CurseForge"`) instead of the plain single-source `sourceLabel`.
  - New tests in `tests/minecraftModScan.test.ts`: CurseForge fingerprints are now sent for
    every untracked file including Modrinth-matched ones; a dual match sets `alsoOn` on the
    Modrinth-sourced entry rather than creating a second, competing entry for the same file.

- **Fix: the Mods grid still didn't fill the window's width on a 2K monitor, and a mod already
  on both Modrinth and CurseForge still didn't show "Modrinth, CurseForge" for an older,
  already-settled entry.**
  - **Grid width**: `.mc-mods-grid` had carried over a `max-width: 1600px` sanity cap from the
    original `<table>`-era CSS. Grid's `fr`-based columns are safe to stretch arbitrarily wide
    (see the comment above the rule) - there's no outlier-content failure mode to reintroduce,
    unlike the old table's `width: 100%` - so the cap is just gone now; the grid fills whatever
    width `.server-detail` actually has.
  - **Retroactive cross-listing**: the previous `alsoOn` fix (above) only checked a file against
    CurseForge *while it was still `untracked`* - i.e. the first time it's ever seen, or while
    it's sitting as an unidentified `'unknown'` entry. A mod already settled as `source:
    'modrinth'` from a scan that predates the `alsoOn` feature (or predates a CurseForge key
    being configured at all) is excluded from `untracked` by `settledFileNames` and was never
    re-examined by any later Rescan, so it could never retroactively gain its CurseForge
    cross-listing - exactly the case reported. `scanForInstalledMods` now also runs a new
    `crossCheckSettledModrinthModsAgainstCurseForge` pass first (only when a CurseForge key is
    configured): every already-settled `source: 'modrinth'` entry whose `alsoOn` is still
    `undefined` has its on-disk file's fingerprint computed and checked against CurseForge in
    one batched call. A match backfills `alsoOn: ['curseforge']`; no match sets `alsoOn: []`
    (explicitly empty, not left `undefined`) so it's marked "already checked" and never
    re-queried on every future scan - only entries truly never checked are considered each time.
    Deliberately one-directional for now (Modrinth-primary entries checked against CurseForge,
    not the reverse), since that's the concrete case reported.
  - New tests in `tests/minecraftModScan.test.ts`: an already-settled Modrinth entry gets
    `alsoOn: ['curseforge']` backfilled on the next scan when CurseForge has a fingerprint match
    for its file; one with no match gets `alsoOn: []` and is never sent to CurseForge again on a
    subsequent scan.

- **Fix: stopping a modded (Forge) Minecraft server on Windows left the Manager stuck showing
  "Stopping" forever, even though the server itself had already fully exited.** A `launchMode:
  'script'` launch on Windows runs through a `cmd.exe` wrapper (`entry.process` in
  `minecraftProcess.ts`) that spawns the real java process as its own child rather than
  replacing itself the way a POSIX shell's `exec` does - `watchForScriptPidHandoff` already
  corrects the *tracked pid* to the real java one once it's found listening on the port, but
  `entry.process` itself stays the wrapper forever. Stop/kill used to finalize "stopped" only
  from `entry.process`'s own `'exit'` event - and some servers' generated `run.bat` ends in a
  `pause` (or similar) that blocks forever on a piped, non-interactive stdin once java has
  already exited, since there's nothing left to ever supply the keystroke it's waiting for. So
  `cmd.exe` never actually exits, that event never fires, and the Manager waits on it forever.
  - `waitForExitOrKill` now also polls `isPidAlive(entry.pid)` (the real tracked pid) in
    parallel with waiting for `entry.process`'s own `'exit'` - whichever happens first resolves
    it. Once the real pid is confirmed gone, a still-alive wrapper is force-killed directly
    (rather than left running forever in the background), which in turn makes it actually emit
    `'exit'` and run the cleanup already registered on it in `startServer`.
  - `killServer` (the force-kill/Kill button path) now also force-kills the wrapper pid
    directly alongside the real one, rather than relying on the wrapper to exit by itself once
    its child is gone.
  - New `tests/minecraftProcessWindowsScriptWrapperHang.test.ts`: pins `platform: 'win32'` and
    fakes the `cmd.exe` wrapper/real-java-pid split directly (same technique
    `tests/findListeningPid.test.ts` uses for ARK's equivalent handoff logic) to reproduce a
    wrapper that never emits its own `'exit'` event while the real pid it spawned does exit -
    confirmed to fail without this fix (`stopServer` never resolves away from `'stopping'`) and
    pass with it.

- **Fix: a long-standing regression of the manager-wide input-freeze bug (`bb7204c` - a text
  field silently stops accepting keystrokes after certain actions, Electron/Windows sometimes
  failing to hand OS-level keyboard focus back to the main window once a native modal closes).**
  That fix covered every `window.confirm()` call site and the file/folder pickers, but missed
  one real native modal that predates it: the Windows UAC elevation prompt triggered by
  `firewall.ts`'s "Add firewall rule for SteamCMD" button (`Start-Process -Verb RunAs`) never
  refocused the main window afterward - same class of OS-level dialog as the ones already
  fixed, so triggering it reproduced the exact same "fields silently stop accepting keystrokes"
  symptom through an unfixed path. `registerSteamcmdInstallHandlers` now takes the
  `BrowserWindow` itself (previously just its `webContents`) and calls `mainWindow.focus()`
  right after `addFirewallRulesForSteamCmd` settles, success/failure/cancellation alike - same
  pattern as `confirmAction()` and `dialog.ts`'s pickers.

- **Change: the Mods tab's Source column shows each mod source's own logo instead of its
  plain-text name.** User-provided logo files (`forge.png`, `Modrinth_Logo.png` - added at the
  repo root for this) moved into `src/renderer/src/assets/mod-sources/` as
  `forge.png`/`modrinth.png`. Note `forge.png` is actually the Forge *mod loader*'s anvil logo,
  not CurseForge's own brand logo - used here for CurseForge anyway at the user's explicit
  request, since no CurseForge-specific logo was provided.
  - New `SourceIcon`/`InstalledSourceIcons` in `ModsTab.tsx` replace the old plain-text
    `sourceLabel`/`installedSourceLabel` helpers in both grids' Source column - the name is
    still there as the image's `alt`/`title` (a tooltip, and not lost for accessibility). The
    Installed grid's cross-listed case (`alsoOn`) now renders every logo that applies
    side by side instead of a comma-joined "Modrinth, CurseForge" string.
  - New `.mc-mod-source-cell`/`.mc-mod-source-icon` CSS - a small (22px) `object-fit: contain`
    icon, with `flex-wrap: wrap` on the cell itself for the Installed grid's multi-logo case.
  - Scoped to the Source column cells only, per explicit confirmation - the "Browse Modrinth
    [& CurseForge]" section headings/paragraphs above the grid stay as plain text.

- **Fix: a mod available on both Modrinth and CurseForge showed up as two separate, identically-
  named rows in the Mods tab's Browse search results.** Unlike `scanForInstalledMods` (which has
  an actual file to hash/fingerprint and so can *confirm* two hits are the same mod),
  `searchMinecraftMods` only has each source's own search metadata to go on - there's no shared
  cross-platform id to match on at search time. New `mergeDuplicateSearchResults` in
  `minecraftMods.ts` merges hits that share an exact, case-insensitive title into a single row -
  Modrinth kept as the primary/installable one when both are present (same "no API key needed"
  preference used everywhere else that picks between the two sources), with the other source(s)
  attached as a new, purely informational `MinecraftModSearchResult.alsoAvailableOn` field (same
  role as `InstalledMinecraftMod`'s own `alsoOn`) - Install still always uses the primary row's
  own source/projectId, this isn't a source picker. Traded off deliberately: a coincidentally
  same-titled but actually different mod from each source would get merged too, in exchange for
  not showing an obvious true-positive duplicate twice.
  - `ModsTab.tsx`'s old single-source `SourceIcon` usage in the Browse grid is now the same
    `SourceIcons` (plural) component already used for the Installed grid's `alsoOn` case, so a
    merged row shows every applicable logo side by side there too.
  - New tests in `tests/minecraftModsCurseForge.test.ts`: a same-titled hit from both sources
    merges into one row with `alsoAvailableOn` set (case-insensitive); two hits with genuinely
    different titles are left as two separate rows.

- **Fix: stopping a server correctly (the Forge "stuck on Stopping" fix above) now showed
  "Process exited with code 1" in red on the server card, even though the stop completed
  exactly as asked.** `child.on('exit')` unconditionally treated any non-zero/non-null exit code
  as an error worth surfacing - that used to be a safe assumption, but `waitForExitOrKill`/
  `killServer` now force-kill a hung Windows script-mode wrapper (cmd.exe) directly once the
  real server pid is confirmed gone (see the fix above), and a forcibly-terminated process's own
  exit code is whatever the OS reports for that (code 1 on Windows), not 0 - even on a
  completely clean, deliberate stop. The handler now checks whether the status was already
  `'stopping'` (set by `stopServer`/`killServer` before they ever touch the process) before
  attaching a `lastError` - the same "expected vs. a surprise" distinction ARK's own
  `serverProcess.ts` already makes for its equivalent handler. An exit seen from `'starting'`/
  `'running'` (nobody asked for it) still surfaces the error as before.
  - New tests in `tests/minecraftProcess.test.ts`: a deliberate `stopServer()` reports no
    `lastError` even when the underlying process's own exit code is non-zero; an unexpected
    exit while still `'running'` still does. Listens to the `'status'` event directly rather
    than `getStatus()` afterward, since the running-process bookkeeping (and the `lastError` it
    carried) is already cleared by the time a caller could poll for it - same for every other
    exit path, not something this fix changed.

- **Change: CurseForge is now preferred over Modrinth whenever a mod is found on both and a
  CurseForge API key is configured** (explicit user request - previously Modrinth was always
  kept as the "primary" source when the two overlapped, reasoning that it needs no API key;
  that default no longer applies once the user has actually set one up). Three places this
  shows up, all gated on a key being configured (nothing changes with no key set, same as
  before):
  - `mergeDuplicateSearchResults` (Browse search results): the merged row now keeps the
    CurseForge hit as primary/installable, with Modrinth attached via `alsoAvailableOn` instead
    of the other way around.
  - `scanForInstalledMods`'s own fingerprint-matching loop: a file matched by both sources
    during a scan is now adopted as `source: 'curseforge'` with `alsoOn: ['modrinth']`, not the
    reverse.
  - The retroactive backfill (previously `crossCheckSettledModrinthModsAgainstCurseForge`, now
    `preferCurseForgeForSettledModrinthMods`) no longer just tags `alsoOn` on an already-settled
    Modrinth entry - it fully promotes it to `source: 'curseforge'` (fetching the real CurseForge
    metadata via `getCurseForgeMods`, same as a fresh scan would) so a mod installed via Modrinth
    before a CurseForge key existed gets the same treatment on its next Rescan as a brand new
    match would. The "already checked, no match" `alsoOn: []` sentinel (vs. `undefined` meaning
    never checked) still works the same way to avoid re-querying every scan.
  - Updated `tests/minecraftModScan.test.ts`/`tests/minecraftModsCurseForge.test.ts` for the new
    CurseForge-primary expectations in all three spots.

- **Addition: ARK: Survival Ascended's own Mods tab is now "visual" too (user request, now that
  the CurseForge integration built for the Minecraft tab is confirmed working) - a real icon/
  name resolved from CurseForge next to a mod id, and a "Search CurseForge" section to find and
  add a mod by name instead of hunting for a bare numeric id on CurseForge's website yourself.**
  ARK: Survival Evolved is deliberately untouched - its own mod ids are Steam Workshop ids, a
  completely different namespace CurseForge knows nothing about; every addition below is gated
  on `!isEvolved`.
  - New `src/main/lib/arkMods.ts`: `searchArkMods(query)` (new `searchCurseForgeArkMods` in
    `curseforgeClient.ts`, ARK:SA's own CurseForge counterpart to `searchCurseForgeMods`) and
    `getArkModsInfo(modIds)` (batched, via the already game-agnostic `getCurseForgeMods` - no
    new client code needed for this half) for enriching every mod id already in a profile's
    list, not just ones added via search. Both return empty (not an error) with no CurseForge
    key configured; `getArkModsInfo` also silently drops any non-numeric id (e.g. an
    Evolved-style Steam Workshop id, or just garbage) before ever calling CurseForge with it.
  - **ARK: Survival Ascended's own CurseForge game id (83374) isn't in CurseForge's official
    docs** (their public docs only show Minecraft's 432 as a worked example) - this is
    community-sourced, corroborated by two independent reports of a running ARK:SA server's own
    mod tooling using `"gameId": 83374`, and by player reports that CurseForge-downloaded ARK:SA
    mods land in a folder literally named `83374` inside the game's own Mods directory
    (CurseForge's own on-disk convention is `<gameId>/<modId>`). No `classId` is sent for ARK:SA
    searches - unlike Minecraft (several CurseForge "classes": Mods, Bukkit Plugins, ...),
    ARK:SA's own CurseForge listing has exactly one content type ("Mods"), so there was nothing
    to disambiguate and guessing a wrong numeric classId risked silently returning zero results
    instead of everything.
  - New IPC: `ark-mods:search`/`ark-mods:info` (`src/main/ipc/arkMods.ts`,
    `window.api.arkMods.search`/`.info`), new shared types `ArkModSearchResult`/
    `ArkModInfo`/`ArkModInfoMap` in `shared/types.ts` - deliberately a much thinner shape than
    `MinecraftModSearchResult`: nothing here picks a version/loader-compatible file, since ARK
    mods aren't actually downloaded/installed through this app at all (the server fetches its
    own mods by id at startup) - it's purely "what is this id called and what does it look
    like," enough to prefill `ServerMod.id`/`.name` from a real search hit.
  - `ServerDetail/ModsTab.tsx`: a new "Search CurseForge" section (hidden entirely for ARK:SE,
    and showing a "set a key in Settings" hint instead of results when no key is configured)
    lists hits with icon/name/summary/downloads and an Add button (disabled, labeled "Added",
    once that id is already in the list) - Add prefills both id and name, unlike the existing
    manual "Mod ID" input which only ever took a bare id. The existing mod table's own Mod ID
    column now also shows a resolved icon/name next to every row it can identify (looked up for
    every id already in the list, keyed on a sorted/joined id string so toggling Enabled/
    Passive/Dev, renaming, or reordering doesn't re-trigger a lookup for a set of ids that
    hasn't actually changed) - this doesn't touch the existing free-text Mod Name field at all,
    it's a separate, purely informational hint.
  - New `tests/arkMods.test.ts` and new tests in `tests/curseforgeClient.test.ts` for the new
    search/info functions (mapping, empty-list/no-request behavior with no API key, non-numeric
    id filtering, dedup). No renderer component test suite exists in this project to extend for
    the `ModsTab.tsx` changes themselves (same as every other UI-only change here) - `npm run
    typecheck`/`build` both pass, but this wasn't visually verified running the actual app (no
    display in this environment to drive Electron's UI with).

- **Follow-up, from a real screenshot of the above: the free-text Mod Name field was redundant
  once a resolved CurseForge name already existed, and the table's right-most Actions column
  (↑/↓/⤒/Remove) was visibly misaligned from the rest of the row once a row's resolved name got
  long.** Both ARK: Survival Ascended's own CurseForge enrichment and the Minecraft Mods tab hit
  the exact same underlying issue the Minecraft tab already had to fix once before (see its own
  "CSS Grid, not a `<table>`" entry above) - so the fix is the same one, applied here too.
  - **ARK: Survival Ascended's Name column is no longer an editable text input.** It now shows
    the real icon + name resolved from CurseForge (falling back to whatever label a mod already
    had, typed in before this feature existed, if CurseForge hasn't resolved it) - purely
    informational, same as the Minecraft Mods tab's own Name cell. **ARK: Survival Evolved is
    unaffected and keeps its editable free-text Name field exactly as before** - it has no
    CurseForge data to show instead, since its mod ids are Steam Workshop ids.
  - **The whole mods list is now a CSS Grid** (`ark-mods-grid`/`ark-mods-grid--ascended`/
    `ark-mods-grid--evolved` in `styles.css`, `ModsTab.tsx`'s own `<table>` replaced with the
    same Fragment-per-row flat-children markup the Minecraft tab's grid already uses) instead of
    an HTML `<table>` - this is what actually fixes the reported Actions-column misalignment,
    not a tweak to the old table's own CSS, for the same reason incremental table-CSS patches
    never fully fixed it for the Minecraft tab either: a column's width in table auto-layout
    depends on content across every row at once, which Grid's explicit per-track
    `grid-template-columns` doesn't.

- **Fix: the CurseForge-resolved icon never actually showed up, in either ARK's new Mods tab
  enrichment/search or (very possibly, silently, just never reported) the Minecraft Mods tab's
  own CurseForge results.** `index.html`'s CSP `img-src` only allow-listed the one specific host
  `https://media.forgecdn.net`, picked without ever having a live response to confirm it against
  (no network access to CurseForge from this sandbox - see the fingerprint-algorithm
  verification entry above for the same caveat on a different piece of CurseForge integration
  work). CurseForge's own CDN serves different asset kinds from different `forgecdn.net`
  subdomains (e.g. `edge.forgecdn.net` for file downloads) - if mod logos are served from a
  different one than `media.`, the CSP silently blocked every one of them, with the `<img>`
  tag's own `onError` handler just hiding the broken image rather than surfacing anything. Now
  `https://*.forgecdn.net` (wildcard subdomain) instead of the one specific hostname, so this
  class of bug can't recur for whichever subdomain CurseForge actually uses for a given asset.

- **Fix: once the icon fix above actually showed CurseForge-resolved names, ARK: Survival
  Ascended's Mods grid had a big dead gap between a short Name and the Mod ID/Actions columns
  pinned at the far right.** `ark-mods-grid--ascended`/`--evolved`'s own Name track was
  `minmax(0, 1fr)` - the same "give the primary column the whole leftover share" choice that's
  correct for the Minecraft Mods tab's own Name column (genuinely the widest, most-attention-
  grabbing thing in that grid), but wrong here: most real ARK mod names are much shorter than
  the row is wide, so claiming all the leftover space just pushed Mod ID/Actions far off to the
  right with nothing filling the space between. Name is now capped (`minmax(0, 360px)`) like
  Mod ID already was, instead of an `fr` track - with no `fr` track left at all, the grid's
  columns size to their own content/cap and stop, so any genuinely leftover width (a very wide
  window, or every mod in the list having a short name) just sits unused past the last column
  instead of being forced into a gap mid-row.

- **Change: ARK's Mods grid is now centered in the tab (with `max-width: 1100px` + `margin: 0
  auto`) on a wide window instead of sitting pinned to the left, and the Mod ID column's text
  is centered within its own column rather than left-aligned** (user request, follow-up to the
  gap fix above - once nothing stretched the grid to fill the tab's full width, the leftover
  space all sat to its right instead of being split evenly on both sides).

- **Fix, from a real screenshot of the centering change above: the "Add mod ID" input row
  stayed pinned to the tab's own left edge while the grid below it centered itself, visibly
  misaligned from it - and capping Name to stop it stretching to a multi-thousand-pixel-wide
  browser's own edge had shrunk the whole table down to a visibly tiny, overly-narrow block
  once an outer centered cap existed to constrain it anyway.**
  - New `.ark-mods-list` wrapper (`ModsTab.tsx`) now holds the "Add mod ID" row and the grid
    together, with the `max-width: 1200px; margin: 0 auto` centering living on *it* instead of
    on the grid and `.mods-add` separately - centering two siblings independently, each with
    its own (different) max-width, centers them on the same point but leaves their *left edges*
    different, which is exactly what read as misaligned. Both now share one bounding box.
  - Name's column track is back to `minmax(0, 1fr)` instead of the capped `minmax(0, 360px)`
    from the gap fix above - with `.ark-mods-list` already capping/centering the *overall*
    layout so nothing stretches all the way out to a wide browser's own edge, letting Name claim
    the rest of that already-bounded width is the right amount of stretch: comfortably sized
    without reproducing the original edge-to-edge gap problem the cap was there to fix.

- **Fix: still reported "too shrunk" after the 1200px cap above, on a wide enough monitor.**
  `.ark-mods-list`'s `max-width` is now a percentage (`95%`) rather than another fixed pixel
  guess - after two rounds of a fixed cap (1100px, then 1200px) each getting reported as too
  narrow on a wide enough window, a percentage scales with however wide the window actually is
  instead of requiring yet another pixel number to guess at, while still leaving a modest,
  proportional margin on both sides rather than stretching flush to the tab's own edges.

- **Fix: even the percentage cap above still came back as "hasn't moved" on a confirmed-
  maximized 2K monitor with a confirmed-current build.** Three different `.ark-mods-list` width
  values in a row (1100px, 1200px, 95%) all reportedly rendered identically, which stopped being
  explainable by the cap value itself and started pointing at centering a capped width not
  taking effect correctly in this specific layout (`.ark-mods-list` is a flex item of
  `.mods-tab`'s column flex layout - an arrangement not otherwise used elsewhere in this app).
  Rather than keep guessing at why without being able to inspect the live DOM, `.ark-mods-list`
  now just matches the Minecraft Mods tab's own grid exactly: no cap, `width: 100%`, Name a real
  `minmax(0, 1fr)` track - the one arrangement already proven to behave correctly on this exact
  CSS Grid architecture (confirmed working there across this whole session). If filling the
  available width turns out to need centered margins again once that's confirmed actually
  working, that's a much smaller, easier follow-up than continuing to guess at cap values that
  may not even have been the real constraint.

- **Fix: confirmed from the above - dropping the cap entirely did visibly fill the tab
  edge-to-edge (user: "back to square one"), proving a flex item's own `width` genuinely
  applies in `.ark-mods-list` (a flex item of `.mods-tab`'s column layout). In hindsight, the
  actual likely culprit all along was `margin: 0 auto` itself never centering it - each of the
  three earlier capped attempts could easily have been correctly narrowed but left flush-left
  instead of centered, which would explain three cosmetically-similar "hasn't moved" results
  between slightly different cap values.** `.ark-mods-list` now uses `align-self: center`
  (overriding just this one flex item's own cross-axis alignment, overriding `.mods-tab`'s
  default `align-items: stretch`) instead of relying on auto margins absorbing leftover space -
  a more direct mechanism with less indirection to silently fail - alongside a generous
  `max-width: 1600px` cap, picked now that dropping the cap entirely confirmed the available
  width is genuinely wide enough for 1600px to read as "spread out," not "shrunk."

- **Change: ARK's Mods grid now shows Mod ID before Name** (user request) - both the header row
  and each data row in `ModsTab.tsx` swap their order, and `grid-template-columns` in
  `styles.css` (`ark-mods-grid--ascended`/`--evolved`) swaps the two columns' tracks to match.

- **Change: the Copy/Paste Mod List feature now works with bare mod ids, one per line, instead
  of the full `{id, name, enabled, passive, dev}` JSON it used to round-trip** (user request -
  now that the Mods tab resolves a mod's real name from CurseForge automatically, there was
  nothing left worth carrying along with the id). `serializeMods`/`parseImportedMods`
  (`src/main/lib/modsExport.ts`) rewritten accordingly:
  - **Copy** now writes just `mods.map(m => m.id).join('\n')` instead of the old JSON blob.
  - **Paste** splits on any run of non-digit characters (not strictly newlines), so a list
    copied as `"123, 456 789"` parses the same as one id per line - the point of dropping the
    structured JSON format entirely is accepting an id list from *anywhere* one already exists
    (a wiki page, a Discord message, a friend's own modpack list), not just this app's own
    previous export. Every parsed id becomes a fresh entry with the same enabled/not-passive/
    not-dev defaults `addMod`'s own manual single-id path already uses, deduplicated, with a
    clear error if the pasted text has no numeric ids in it at all.
  - Updated copy/paste section text in `ModsTab.tsx` to describe the new format; rewrote
    `tests/modsExport.test.ts` for the new behavior (separators, dedup, defaults, the empty-
    result error case) in place of the old JSON-round-trip/validation tests.

- **The web dashboard (`src/main/lib/webDashboard.ts`) now lists, starts, stops, and remote-
  controls Minecraft servers too, not just ARK ones - and its ARK Mods tab gained the same
  CurseForge search/icon/resolved-name enrichment the desktop app's own `ModsTab.tsx` already
  had (see the entries above).** Two separate requests handled together since both touch the
  same file: "adapt the web dashboard to Minecraft servers, and to the recent ARK-side
  novelties."
  - **Core dispatch strategy**: rather than building a second, fully parallel Minecraft UI
    tree in the dashboard's single-file client (which would have meant 1500+ new lines, on
    the order of the desktop app's own separate `MinecraftServerDetail/*` React tree), every
    route that already returns a shape close enough to be shared (`ServerStatus` ≈
    `MinecraftServerStatus`; `RconResult`/`BackupEntry`/`BackupLogEntry` are the exact same
    shared types both games' backend modules already use) now dispatches internally by game
    type and returns that same shape either way - so the dashboard's existing generic
    client-side rendering (it already carried `gameIconUrl`/`gameDisplayName` per server, to
    tell ARK: Survival Ascended and ARK: Survival Evolved icons apart) picks up Minecraft
    servers correctly with little to no client-side change for the core views.
  - **What now works for a Minecraft server, same as ARK**: `GET /api/servers` lists it
    (icon from a new `/game-icons/minecraft.png`, `minecraft.png` copied into `build/games/`
    since it previously only existed in the renderer's own bundled Vite assets, never in the
    `extraResources`-copied folder the dashboard and packaged app both actually read icons
    from); Dashboard/Cluster cards and the Console view's status panel show it with zero
    extra client code since both already rendered off the generic shape; the Console view's
    live event stream tails Minecraft's own stdout via `minecraftConsoleEvents`/
    `minecraftServerEvents` (every line wrapped as a generic `{label: 'LOG', cls: 'log', ...}`
    `LogEvent`, since Minecraft's console has no ARK-style JOIN/CHAT/KILL/etc. categorization
    to parse into); Start/Stop dispatch to `doStartMinecraftServer`/`doStopMinecraftServer`;
    the RCON command box tries the live process's stdin first
    (`sendStdinCommand`, same priority order the desktop Console tab's own command box and
    `ipc/minecraft.ts` already use), falling back to real RCON
    (`sendMinecraftRconCommand`) only for a re-adopted server with no live process handle;
    `GET .../players` parses Minecraft's own `list` RCON response
    (`parseMinecraftPlayerList`, already existed) into the same `{name, id}[]` shape ARK's
    route returns.
  - **What's explicitly not available for a Minecraft server yet, and says so rather than
    guessing or silently no-op'ing**: `POST .../restart`, `.../update`, and
    `.../stop-update-restart` all return `400` with a clear message (Minecraft has no restart
    action and no auto-update mechanism in this Manager - a server jar is swapped by hand) -
    and the Console view's Restart/Update Restart buttons, plus the Dashboard/Cluster card's
    "⋮" action-sheet entries for them, are hidden entirely for a Minecraft server rather than
    shown disabled. The six other admin-only tabs that only ever made sense for an ARK
    profile's own on-disk layout - Settings, Mods, Backups, Analytics, Map Management, Server
    Management, Update Log - each now show a plain "Not available for Minecraft servers yet -
    only Console/start/stop currently work here" message and hide their form instead of
    fetching a route built for a `ServerProfile` and either 404ing or rendering garbage for a
    `MinecraftProfile`.
  - **ARK Mods tab CurseForge port**: three new admin-gated routes mirror the arkMods.ts
    functions the desktop app's ModsTab already called over IPC - `GET /api/arkmods/status`
    (`{ hasCurseForgeKey }`, never the key itself, so the client can show/hide the search
    section the same way the desktop tab does for `hasCurseForgeKey`), `GET
    /api/servers/:id/mods/search?q=...` (`searchArkMods`), and `POST
    /api/servers/:id/mods/info` (`{ modIds }` → `getArkModsInfo`). The Mods view's HTML
    gained a collapsible "Search CurseForge" section (hidden entirely for an ARK: Survival
    Evolved profile, whose mod ids are a Steam Workshop namespace with nothing CurseForge
    could resolve) and the table's Name column now shows the resolved icon+name for ARK:
    Survival Ascended (falling back to whatever label a mod already had, same as the desktop
    tab) instead of staying an editable text input - which stays exactly as it was for ARK:
    Survival Evolved. The table's Mod ID/Name column order was also swapped to match the
    desktop tab's own recent reordering (see "ARK's Mods grid now shows Mod ID before Name"
    above). The Mods tab, like the other five admin tabs above, shows the same "not available
    for Minecraft servers yet" message for a Minecraft server - Minecraft's own mod browsing
    wasn't part of this round.
  - New tests in `tests/webDashboard.test.ts`: a `describe('Minecraft servers', ...)` block
    (`/api/servers` listing, backlog/live-stream events incl. the `reset` event on
    restart, start/stop dispatch, the three 400 routes, RCON stdin-then-fallback, player
    list parsing) plus three new admin-route tests for `/api/arkmods/status` and the two
    mods routes (mocking `../src/main/lib/arkMods` directly rather than hitting real
    CurseForge). `npm run typecheck`, the full `npx vitest run` (863 tests), and `npm run
    build` all pass - this wasn't visually verified in a real browser against a live
    Minecraft server, since this environment has no display, but the server-side behavior
    is covered by real HTTP requests against a real `http.Server` (this codebase's own
    established testing pattern for this file, not a new one introduced here).

- **Follow-up: the web dashboard's ARK Mods tab gained the move-to-top/up/down reorder
  buttons the desktop app's own ModsTab already had (user-reported gap), and Minecraft
  servers are now fully separated from ARK ones in the web dashboard - their own "Minecraft
  Servers" list and their own five admin tabs (Start Settings/Server Settings/Mods/Backup/
  Server Management), matching the desktop Manager's own separate Minecraft section instead
  of the six-way "not available for Minecraft servers yet" placeholder the previous entry
  above left in place.**
  - **ARK Mods reorder buttons**: `renderModsTable()`'s Actions column now has the same
    ⤒/↑/↓ trio as the desktop `ModsTab.tsx` (move to top, swap with the previous/next row),
    each disabled at the respective end of the list, alongside the existing Remove button -
    all three just `saveMods()` a reordered copy of the array, reusing the exact same save
    path every other mods edit here already goes through.
  - **Minecraft/ARK separation on the server-list views**: `renderDashboardCards`/
    `renderClusterCards` (ARK's Dashboard/Cluster Dashboard) now filter `latestServers` to
    `isArkServerEntry` before rendering, and a new **Minecraft Servers** nav tab/view
    (`renderMcDashboardCards`, sharing the same card-grid renderer via a new
    `renderServerCardsGrid` helper both call into) shows Minecraft servers on their own,
    filtered by the new `isMcServerEntry`. Clicking a card in either list still jumps straight
    to the shared Console tab (already correctly dispatches by game - see the previous
    entry), same as before.
  - **Five new Minecraft-specific admin tabs**, in their own always-visible sidebar section
    (unlike ARK's per-server tabs, which stay hidden outside a server-scoped view) with their
    own server pickers populated from Minecraft profiles only (`MC_SERVER_PICKERS`,
    `populatePickerGroup` factored out of the old single-purpose `populateServerPickers` so
    both picker groups share the same optgroup-by-dashboard-group logic) - all syncing to the
    one shared `currentId` the ARK pickers already use, so a card click in either list and a
    picker change in either tab group stay in agreement:
    - **MC Start Settings** (admin+, mirrors the desktop `StartSettingsTab.tsx`): name,
      server type, Minecraft version, install directory, launch mode (jar/script) and its
      file name, min/max memory, extra JVM/program arguments, dashboard group, hidden -
      against a new, intentionally unrestricted `GET`/`POST /api/servers/:id/mc-startsettings`
      (same "admin can change any field" shape as ARK's own `/profile` route, just backed by
      `getMinecraftProfile`/`saveMinecraftProfile` instead).
    - **MC Server Settings** (moderator+, mirrors `ServerSettingsTab.tsx`): every
      server.properties field the desktop tab edits (gameplay/appearance/world/networking/
      misc - ~35 fields), generated client-side from a `MC_PROPERTIES_SECTIONS` data array
      (type + label + default + options, mirroring the desktop tab's own per-field objects)
      rather than hand-writing 35 inputs, against new `GET`/`POST
      /api/servers/:id/mc-serversettings` (`readServerProperties`/
      `upsertServerPropertiesKeys`, both already existed for `minecraftProperties.ts`).
    - **MC Backup** (moderator+ for list/create, admin+ for restore/delete - same split as
      ARK's own Backups tab): backup directory/retention/schedule (saved through
      mc-startsettings, same as ARK's own backup settings going through the admin-only
      `/profile`), create-now, the backup table, and the backup process log - against new
      `GET`/`POST /api/servers/:id/mc-backups`, `.../mc-backups/restore`,
      `.../mc-backups/delete`, `.../mc-backups/log`, wired to the already-existing
      `minecraftBackup.ts` functions (`createMinecraftBackup`/`listMinecraftBackups`/etc. -
      built in an earlier round for the desktop `BackupsTab.tsx`, never exposed over HTTP
      until now). No player-profile-backups panel - Minecraft has no equivalent feature.
    - **MC Server Management** (moderator+, mirrors `ServerManagementTab.tsx`): start-on-
      Manager-launch and the scheduled-restart day/time picker (with its own live countdown,
      reusing the exact same `buildDayCheckboxes`/`computeNextOccurrence`/`formatCountdown`
      helpers ARK's own Server Management view already defined) - against new `GET`/`POST
      /api/servers/:id/mc-management`, a narrow whitelist route mirroring ARK's own
      `/servermanagement` pattern exactly, just with Minecraft's much shorter field list (no
      crash-watch/zombie-detection/dino-wipe - Minecraft has neither).
    - **MC Mods** (admin+, mirrors `ModsTab.tsx`'s Modrinth/CurseForge integration): search
      (both sources, CurseForge only once a key is configured - same `searchMinecraftMods`
      the desktop tab already calls), install (walking required dependencies automatically,
      same as desktop), per-mod enable/disable and remove, "Rescan folder" (adopts untracked
      files already sitting in mods/plugins), and "Check for updates" (per-mod update badge,
      with an inline Update action) - against six new routes (`GET .../mc-mods`, `GET
      .../mc-mods/search`, `POST .../mc-mods/install`, `.../remove`, `.../enabled`,
      `.../rescan`, `GET .../mc-mods/updatecheck`), all thin wrappers around the existing
      `minecraftMods.ts` functions. A server type with no mod/plugin ecosystem (vanilla,
      Forge/Fabric/Paper/Spigot's own `unknown`) gets the same clear error message
      (`requireLoaderSupportsMods`'s own text) as the desktop tab, surfaced in the search/
      rescan/install error areas rather than a separate "unsupported" banner.
  - **Role tiers** match what was asked: MC Start Settings and MC Mods stay admin+ only (same
    tier as ARK's own Settings/Mods); MC Server Settings, MC Backup, and MC Server Management
    are moderator+ - a step more permissive than their ARK counterparts (ARK's Settings/Mods
    are both admin-only with no moderator-accessible equivalent at all) per what was
    specifically asked for Minecraft.
  - New `describe('Minecraft-specific tabs', ...)` block in `tests/webDashboard.test.ts`
    (profile/properties/management/backups/mods routes, including the "no mod ecosystem"
    error path for every mod action against the mock profile's `serverType: 'vanilla'`) plus
    role-gating tests in the auth-enabled describe block (moderator blocked from admin-only
    mc-startsettings/mc-mods, readonly blocked from moderator-only mc-serversettings/
    mc-management/creating an mc-backup). `npm run typecheck`, the full `npx vitest run` (895
    tests), and `npm run build` all pass.
  - **This round's client-side changes were additionally verified in a real headless
    Chromium** (Playwright, pre-installed in this environment) rather than relying on
    typecheck/build alone the way every earlier client-side-only round in this file had to -
    a temporary, not-committed test drove every new/changed nav tab end to end (Dashboard →
    card click → Console → every ARK per-server tab incl. the new mod-reorder buttons;
    Minecraft Servers → card click → Console → every new MC tab, editing a field on each to
    exercise the save path too) against the real rendered page, asserting zero `pageerror`/
    `console.error` events. It came back clean on the first fully-corrected run (the only
    flagged "error" was Chrome's own generic network-failure log for the one expected 400 -
    searching Mods for the mock profile's `serverType: 'vanilla'`, which has no mod ecosystem
    by design) - genuine evidence this round's ~1600 lines of new client JS run without a
    runtime exception, not just that they parse and typecheck.

- **"+ Add server" on the Minecraft Dashboard now fetches (or, for Forge/Spigot, downloads
  and runs an installer for) the right server files for a brand-new server, instead of
  always creating a completely blank profile with nothing on disk.** Previously, setting up a
  new Minecraft server from scratch meant installing it by hand outside the Manager first,
  then either "Import existing server" or configuring every field manually - there was no
  install-from-scratch path for any server type.
  - **New `shared/minecraftInstall.ts`**: `MinecraftInstallableType` (every real
    `MinecraftServerType` except `'unknown'`), `MinecraftVersionOption`,
    `MinecraftInstallParams` (serverType/minecraftVersion/installDir/acceptEula),
    `MinecraftInstallResult` (installDir/launchMode/jarFileName/scriptFileName/
    minecraftVersion/serverType) - the shape both `window.api.minecraft.install` and the new
    main-process modules below share.
  - **New `src/main/lib/minecraftInstallClient.ts`**: thin fetch wrappers around each loader's
    own official (or de-facto-standard) public API/distribution channel - Mojang's version
    manifest for vanilla, PaperMC's download API for Paper, FabricMC's meta API for Fabric
    (whose `.../server/jar` endpoint builds a ready-to-run server jar on the fly - no separate
    installer step needed, unlike Forge), and Forge's own Maven `maven-metadata.xml` (parsed
    with a plain regex - a flat, machine-generated, single-level list, not worth a real XML
    parser for) since Forge publishes no JSON API at all. Spigot has no download endpoint
    whatsoever - its own license terms require building it locally from Mojang's mappings via
    BuildTools.jar, so there's nothing to "fetch" for it beyond that one fixed jar; the actual
    build happens in `minecraftInstall.ts` below.
  - **New `src/main/lib/minecraftInstall.ts`**: `listInstallableMinecraftVersions(serverType)`
    (dispatches to the right client function per loader - Forge's own listing additionally
    walks the last ~20 Vanilla release versions checking each one's Maven metadata, since
    Forge has no "list every Minecraft version it ever targeted" endpoint, only a flat combo
    list filterable by one Minecraft version at a time) and
    `installMinecraftServerFiles(params)`, which refuses outright - before downloading
    anything - if `acceptEula` isn't `true` ("you must accept the Minecraft EULA to
    continue", linking to the real EULA) or no version was picked, then dispatches per
    `serverType`:
    - **vanilla/Paper**: download the server jar, verified against the checksum each API
      actually publishes for it (sha1 for vanilla, sha256 for Paper) - a corrupted/truncated
      download is discarded with a clear error rather than left as a jar the server might
      fail to load.
    - **Fabric**: downloads the on-the-fly-built `fabric-server-launch.jar` - no checksum to
      verify against, since Fabric's meta server generates it per request rather than
      publishing one fixed artifact.
    - **Forge**: downloads the installer jar, runs `java -jar forge-installer.jar
      --installServer` (failing clearly up front, before any download, if `java` isn't on
      PATH at all - `requireExecutableOnPath`), then reuses the *existing*
      `detectMinecraftLaunchable` (minecraftDetect.ts, already used by the Settings tab's
      "Re-detect" button) to figure out whether the result is a script (modern Forge) or a
      jar (older Forge), rather than re-implementing that detection a second time.
    - **Spigot**: downloads BuildTools.jar and runs `java -jar BuildTools.jar --rev
      <version>` (failing clearly up front if either `java` or `git` - BuildTools needs both
      - isn't on PATH), then looks for the `spigot-<version>.jar` it produces. This is a
      genuinely heavy operation (BuildTools clones and compiles from source, routinely taking
      several minutes) - the install dialog says so, and recommends Paper (a faster,
      drop-in-compatible alternative most servers prefer today) as the first-listed option
      instead.
    Every step logs to the Manager Log (`logManagerEvent`) the same way every other
    long-running operation in this app does, and `eula.txt` is only ever written after every
    other step has already succeeded.
  - **New IPC**: `minecraft-install:list-versions`/`minecraft-install:run`
    (`src/main/ipc/minecraftInstall.ts`, registered in `ipc/index.ts`), exposed as
    `window.api.minecraft.install.{listVersions,run}` - doesn't create or save a
    `MinecraftProfile` itself, mirroring `profiles.importFromInstall`'s "caller reviews/saves
    the result" pattern; the renderer builds the profile from `createDefaultMinecraftProfile`
    plus whatever `install.run` returned.
  - **New `InstallMinecraftServerPanel.tsx`**, opened from "+ Add server" on
    `MinecraftDashboard.tsx` (replacing the old instant blank-profile creation as the primary
    path): name, server type (with a one-line hint per type, Spigot's explaining the
    BuildTools trade-off above), Minecraft version (fetched live for whichever type is
    selected, re-fetched on every type change), install directory (text field + the existing
    folder-picker dialog), and the required EULA checkbox, with an inline progress line while
    installing and a "Configure manually" link back to the old blank-profile path for a
    server whose files will be set up by hand afterward (e.g. a modpack's own custom launch
    script) - the install path was added as the new default, not a replacement, for every
    other way of getting a server into this app.
  - **Verified against mocked network/process boundaries, not real network access**: this
    sandbox's own proxy policy blocks every one of these APIs outright (confirmed via
    `curl`/the proxy's own status endpoint - `connect_rejected` for
    piston-meta.mojang.com/api.papermc.io/meta.fabricmc.net/maven.minecraftforge.net alike),
    so every client function and the install orchestration were written against each
    project's own published, versioned public documentation and tested with a mocked
    `fetch`/`child_process` (new `tests/minecraftInstallClient.test.ts` and
    `tests/minecraftInstall.test.ts`, 16+18 tests - URL construction, response parsing,
    checksum verification success/failure, the EULA/missing-version/missing-executable
    refusal paths, and the full install flow for all five server types) - the same "confirmed
    against docs, not a live response" caveat this codebase's CurseForge fingerprint
    algorithm already carries. **Please run an install of each type end to end on a machine
    with real internet access (and, for Forge/Spigot, a JDK + Git on PATH) before relying on
    it** - `npm run typecheck`, the full `npx vitest run` (929 tests), and `npm run build` all
    pass, but none of that proves the real Mojang/PaperMC/FabricMC/Forge endpoints still look
    exactly like their own documentation says today, and the renderer side (a desktop Electron
    dialog, not the web dashboard) wasn't visually verified either - this environment has no
    display to drive the actual app's UI in.

- **NeoForge support, for both mods and server install - the mod/plugin ecosystem's modern
  successor to Forge, added as a full peer of every other `MinecraftServerType` rather than
  bolted on separately.** `MinecraftServerType` gained `'neoforge'`, threaded through every
  place the other loader types already were:
  - **Mod search**: Modrinth's own `neoforge` loader category (`loaderCategoriesFor`) and
    CurseForge's own `modLoaderType` enum value 6 (`modLoaderTypeFor`) - both confirmed
    against each API's own public documentation, same caveat as everywhere else in this app
    that talks to either (no live network access to verify from this sandbox).
    `supportsMinecraftMods`/`modTargetDir` (mods/ folder, same as Forge/Fabric) both updated
    too, so the Mods tab (desktop and web dashboard alike) just works for a NeoForge profile
    with no further changes - they already dispatch on `serverType` generically.
  - **Detection fix**: `detectMinecraftServerType`'s jar/script-name heuristic checked
    `name.includes('forge')` before a NeoForge-specific check existed - since `"neoforge"`
    contains `"forge"` as a substring, every NeoForge jar/script was being silently
    misclassified as plain Forge. Now checks `neoforge` first. NeoForge's own generated
    `run.sh`/`run.bat` is named identically to modern Forge's (no "neoforge" in the name at
    all), so the file name alone can't disambiguate a script launch either way -
    `detectMinecraftServerType` now optionally takes `installDir` and checks for
    `libraries/net/neoforged` (vs Forge's own `libraries/net/minecraftforge`) when the name
    alone isn't enough, a reliable signal neither installer's own file naming carries.
  - **Install from scratch**: new `minecraftInstallClient.ts` functions
    (`listNeoForgeVersions`/`neoForgeInstallerUrl`/`neoForgeVersionToMinecraftVersion`) and
    `minecraftInstall.ts`'s `installNeoForgeServer` - same installer-jar-then-
    `--installServer` flow as Forge's own install path (NeoForge's installer is a fork of
    Forge's), reusing the exact same `detectMinecraftLaunchable` call afterward to figure out
    the result. The one real difference from Forge: NeoForge's own `maven-metadata.xml` lists
    plain build versions with no Minecraft version combined into the string at all (Forge's
    lists `<mcVersion>-<forgeVersion>` combos) - `neoForgeVersionToMinecraftVersion` derives
    the Minecraft version from the build version per NeoForge's own documented scheme
    (`<mcMinor>.<mcPatch>.<build>`, e.g. "21.1.72" → Minecraft 1.21.1), and the version
    picker's label spells out the derived version alongside the raw build string so it isn't
    just a bare, meaningless-looking number. Covers the modern NeoForge versioning scheme
    (Minecraft 1.20.2 onward, the vast majority of real NeoForge usage) - 1.20.1's own
    legacy-numbered NeoForge builds (a narrow historical case, published under a different
    Maven artifact with Forge-style combo versioning) aren't covered.
  - **UI**: `'neoforge'` added to every `MinecraftServerType` picker (desktop Start Settings,
    the install dialog, the web dashboard's own MC Start Settings) and the "not available"
    guidance text on the Mods tab that used to say "Forge/Fabric/Paper/Spigot".
  - **Icon**: a user-provided `neoforge.png` is now a proper asset
    (`src/renderer/src/assets/games/neoforge.png` for the desktop app, `build/games/
    neoforge.png` served by the web dashboard's existing `/game-icons/<fileName>` route -
    same mechanism `minecraft.png` already used, just added to its known-file-names
    allow-list). New `MINECRAFT_SERVER_TYPE_ICONS` (a deliberately sparse
    `Partial<Record<MinecraftServerType, string>>` - every other type has no icon asset yet
    and just keeps showing its plain text label, nothing degrades) wires it into the three
    spots asked for: the Minecraft Dashboard's server card Type line, the Server type picker
    in Start Settings/the install dialog (shown as a live preview next to the dropdown, since
    a native `<select>` can't show an icon per `<option>`), and the Mods tab's Browse header -
    all three mirrored into the web dashboard too (its own MC Start Settings type picker and
    MC Mods search header), with a new `serverType` field added to its `/api/servers`
    Minecraft payload so the client has something to key the icon off.
  - New tests: `detectMinecraftServerType`'s substring-bug fix and the `installDir`-based
    script disambiguation (`tests/minecraftDetect.test.ts`), every new
    `minecraftInstallClient.ts` function (`tests/minecraftInstallClient.test.ts`), the
    `installNeoForgeServer`/`listInstallableMinecraftVersions('neoforge')` dispatch paths
    including the missing-Java and bad-version-string failure cases
    (`tests/minecraftInstall.test.ts`), `modTargetDir`'s mods/ folder for NeoForge
    (`tests/minecraftMods.test.ts`), the Modrinth/CurseForge loader mappings
    (`tests/modrinthClient.test.ts`/`tests/curseforgeClient.test.ts`), and the web
    dashboard's `/game-icons/neoforge.png` route (`tests/webDashboard.test.ts`) - 946 tests
    total now. **This round's web dashboard icon wiring was additionally verified in a real
    headless Chromium** (same approach as the Minecraft-tabs round above): selected a NeoForge
    profile, confirmed the icon actually renders at `/game-icons/neoforge.png` in both the MC
    Start Settings picker and the Mods browse header, and confirmed it disappears again live
    (no page reload) when switching the type dropdown to a type with no icon - zero
    `pageerror` events. `npm run typecheck` and `npm run build` both pass too.

- **The web dashboard now has the same ARK/Minecraft game switcher as the desktop Manager, and
  its Minecraft tabs only ever show up once that switcher is on Minecraft** (user request, from
  a screenshot of the desktop app's own sidebar icon-button pair): "make the MC tabs show only
  for MC servers, and separate MC from ARK the way the Manager does." Previously both games'
  entire nav button lists sat in the sidebar at once, with only each server picker filtered by
  game - there was no actual mode switch, just two parallel sets of always-visible buttons.
  - **Markup**: the sidebar's ARK nav buttons are now wrapped in `<div id="nav-group-ark">` and
    the Minecraft ones in `<div id="nav-group-minecraft">` (both `class="nav-group"`), with a
    new `<div id="game-switch">` - two icon buttons (`#game-switch-ark`/`#game-switch-minecraft`,
    reusing the existing `/game-icons/ark-evolved.png` and `/game-icons/minecraft.png` routes) -
    placed above both groups, directly mirroring `App.tsx`'s own `GameSwitch` component and its
    `.app-sidebar-game-switch` styling (same active-state border/background treatment, copied
    into the dashboard's embedded CSS rather than reinvented).
  - **Client JS**: a new `gameMode` variable (`'ark' | 'minecraft'`, defaults to `'ark'`) and
    `selectGameMode(mode)` function toggles each switch button's `.active` class, shows/hides
    the two `.nav-group` divs via `style.display`, and jumps to that game's own default view
    (`cluster` for ARK, `mcdashboard` for Minecraft) - the same one-mode-at-a-time behavior as
    the desktop app's `gameMode === 'minecraft'` branch in `App.tsx`, just toggling visibility
    instead of swapping out a whole React tree. The page now calls `selectGameMode('ark')` on
    load instead of calling `applyActiveView()` directly (redundant once `selectGameMode`
    already calls `selectView`, which calls `applyActiveView` itself).
  - **Keeping Console reachable**: Console is a genuinely shared view (one implementation, one
    SSE stream, used by both games) and its own nav button lives in the ARK group - which
    disappears once Minecraft mode hides that whole group. Rather than duplicating the Console
    view or filtering its shared server dropdown by game (both considered and rejected as scope
    beyond what was asked), the Minecraft nav group simply gained its own second button
    (`#nav-mc-console`, first item in the group) pointing at the exact same `view-console`
    section, so Console stays one click away in either mode.
  - **Deliberately left alone**: the individual Minecraft nav buttons still don't get ARK's
    per-view contextual hide/show (`SERVER_SCOPED_VIEWS`/`updateServerScopedNavVisibility`) -
    that's an existing, separate design decision from the round that first split Minecraft out
    of ARK, reaffirmed rather than changed here. Role-based hiding (`canAdmin`/`canOperate`
    toggling individual MC button visibility) composes fine underneath the new group-level
    `display:none`, since nested `display:none` hides regardless of a child's own display value.
  - **Verified**: a temporary headless-Chromium check (same harness as prior rounds, deleted
    after use) loaded the dashboard, confirmed the ARK group is visible and the Minecraft group
    hidden by default with the ARK switch button marked active, clicked the Minecraft switch
    button and confirmed the groups swapped and its button became active, clicked the new MC
    Console button and confirmed the shared Console view actually opened, then switched back to
    ARK and confirmed the groups swapped back correctly - zero `pageerror`/console-error events
    throughout. `npm run typecheck`, the full `npx vitest run` (946 tests, all passing,
    including the existing `tests/webDashboard.test.ts` suite unaffected by the markup
    restructure), and `npm run build` all pass too.

- **The remaining `MinecraftServerType` icons - Vanilla, Paper, Fabric, Spigot, and Forge -
  filling in the gap NeoForge's own round left behind** (user-provided assets, pushed straight
  to the repo root as `vanilla.png`/`paper.png`/`fabric.png`/`spigot.jpg`; Forge reuses the
  existing `assets/mod-sources/forge.png` art per the user's own suggestion, rather than
  needing a new asset). `MINECRAFT_SERVER_TYPE_ICONS` (`minecraftServerTypeIcons.ts`) is no
  longer a near-empty `Partial` with just NeoForge in it - every real `MinecraftServerType`
  now has an icon, so it's "sparse" only in the formal sense that `'unknown'` still has none.
  - **Assets**: the four new files copied into `assets/games/` (desktop bundle) and
    `build/games/` (the web dashboard's own `/game-icons/<fileName>` route, read from disk at
    runtime rather than bundled) - same dual-location pattern NeoForge's icon already
    established. Forge's icon is a second copy of `assets/mod-sources/forge.png` under
    `assets/games/forge.png`/`build/games/forge.png`: same artwork, reused for two different
    meanings (the CurseForge mod-source logo there, the Forge loader-type icon here) rather
    than invented from scratch.
  - **One real code gap this exposed**: `spigot.jpg` is a JPEG, and the web dashboard's
    `/game-icons/<fileName>` route was hardcoded to always answer `Content-Type: image/png`
    regardless of the actual file - harmless for every icon so far since they all happened to
    be PNGs, but wrong for a JPEG. Fixed by picking the content type from the file extension
    (`image/jpeg` for `.jpg`/`.jpeg`, `image/png` otherwise) rather than hardcoding one value.
  - **Wiring**: all six loader types (`vanilla`/`paper`/`fabric`/`forge`/`neoforge`/`spigot`)
    added to the web dashboard's own `MC_SERVER_TYPE_ICON_URLS` map, which already drove both
    the MC Start Settings type picker's live icon preview and the Mods tab's Browse header icon
    generically - no call-site changes needed there, same as the desktop side's
    `MINECRAFT_SERVER_TYPE_ICONS` map already driving the Dashboard card's Type line, the
    Server type picker (Start Settings/install dialog), and the Mods tab's Browse header for
    every type at once. Added a `declare module '*.jpg'` to `assets.d.ts` (only `*.png` existed
    there before, since Spigot's icon is this app's first non-PNG asset import).
  - **Verified**: new `tests/webDashboard.test.ts` cases cover all five new icon routes,
    including that `/game-icons/spigot.jpg` actually answers `image/jpeg` (not the old
    hardcoded `image/png`). A temporary headless-Chromium check (deleted after use) selected
    the Minecraft server in MC Start Settings, stepped the Server type dropdown through all six
    loader types, and confirmed the live icon preview's `src` and visibility updated correctly
    for every one of them - zero `pageerror`/console-error events. `npm run typecheck`, the
    full `npx vitest run` (now 951 tests, all passing), and `npm run build` all pass too.

- **Four requests handled together since they all touch the same install/loader-version
  machinery: a real bug fix for Paper installs, full SpongeVanilla/SpongeForge support, and a
  two-selector Minecraft-version/loader-version picker (with a star on the recommended build)
  replacing the old single free-text or single-combo-string pickers everywhere a Minecraft
  server's version is chosen.**
  - **Bug fix: `Error invoking remote method 'minecraft-install:list-versions': ... HTTP 410`
    for Paper.** PaperMC fully sunset their v2 API (`api.papermc.io`) - every endpoint there
    now answers 410 Gone, which is exactly what broke every Paper install/version-list call.
    Migrated `minecraftInstallClient.ts`'s entire Paper section to PaperMC's own documented
    replacement, the "Fill" v3 API (`https://fill.papermc.io/v3`) - a genuinely different
    shape, not just a renamed host: versions come grouped by family, builds carry an explicit
    `channel` (STABLE/BETA/ALPHA) instead of a bare build-number list, and each build's own
    download entry already has a ready-to-fetch URL + sha256 (no separate "build download
    url" endpoint needed the way v2 required). `getLatestPaperBuild` now picks the newest
    STABLE-channel build (falling back to the newest of any channel for a very fresh Minecraft
    version with no STABLE build yet) instead of just the highest build number, matching
    Fill's own documented `jq` example for "latest stable build". New `getPaperBuild`/
    `listPaperBuildOptions` support picking (and starring the recommended) a specific build,
    for the new loader-version selector below.
  - **SpongeVanilla and SpongeForge** (user-provided `sponge.png`, user explicitly chose both
    variants after being told the tradeoff): added as two separate `MinecraftServerType`
    values rather than one ambiguous "sponge" - SpongeVanilla is a standalone single-jar
    server (installed the same one-step way as vanilla/Paper/Fabric); SpongeForge is a mod
    that needs a real Forge server installed first, so `installSpongeForgeServer` runs the
    normal Forge install path, then downloads the SpongeForge jar straight into the resulting
    `mods/` folder on top of it. **This is the least-verified integration in the app, more so
    than NeoForge originally was**: SpongePowered's own dedicated downloads API could not be
    confirmed live at all (its Vue frontend repo is archived, and the backend it reads from
    documents its production host only in an unconfirmed `openapi.yaml`, which didn't even
    resolve via DNS when checked) - used their Maven repo directly instead
    (`repo.spongepowered.org`), the same `maven-metadata.xml` approach already used for Forge/
    NeoForge, confirmed via SpongePowered's own current GitHub README (its "Latest Builds"
    badges link straight into that Maven repo's browser, with group id `org.spongepowered` and
    artifact ids `spongevanilla`/`spongeforge`, version format `<mcVersion>-<build>`). What is
    genuinely NOT confirmed: the exact published jar file name for a given version (assumed to
    be the plain Maven default, `<artifactId>-<version>.jar`, no classifier) - if a Sponge
    install 404s on the actual jar download (as opposed to failing to list versions), that
    assumption is the first thing to check. SpongeForge's own required Forge version isn't
    exposed by Sponge's Maven listing either, so `installSpongeForgeServer` installs whichever
    Forge build is "recommended" for the same Minecraft version instead - a reasonable
    default, not a verified-compatible pairing. Wired into every existing per-type surface:
    `supportsMinecraftMods`, `modTargetDir` (`mods/`, same as Forge/Fabric - Sponge's plugin
    loading follows Forge's folder convention, not Bukkit's `plugins/`), Modrinth's `sponge`
    loader category (shared by both variants - SpongeAPI plugins are implementation-agnostic),
    CurseForge (no real Sponge content category there, falls back to the generic Mods class
    with no loader-type filter), the jar-name detection heuristic (`spongeforge` checked
    before plain `forge`, since it contains "forge" as a substring - same trap NeoForge's own
    detection fix addressed previously), and the shared `sponge.png` icon (one SpongePowered
    logo for both variants, same dual-location `assets/games/`/`build/games/` pattern as every
    other loader icon).
  - **Two-selector version picker, replacing the old single picker everywhere a Minecraft
    server's version is chosen** (user request, explicitly confirmed for both "+ Add server"
    and Start Settings after a design-tradeoff question): a Minecraft-version `<select>` plus,
    for every type except vanilla/Spigot (`supportsLoaderVersionSelection` in
    `shared/minecraftInstall.ts` - those two publish exactly one artifact per Minecraft
    version, nothing further to choose), a second loader/build-version `<select>` populated
    once the first is picked, with a ★ next to whichever option counts as "recommended" for
    that loader. Previously Forge/NeoForge crammed both into one flat list of
    `"<mcVersion>-<build>"`-style combo strings - genuinely confusing to pick from, and
    impossible to extend to a real "recommended build" star at all. New
    `listInstallableLoaderVersions(serverType, minecraftVersion)` (`minecraftInstall.ts`)
    joins the existing `listInstallableMinecraftVersions`, both now exposed over IPC
    (`window.api.minecraft.install.listLoaderVersions`) and, for the web dashboard (which has
    no IPC boundary - everything already runs in the main process), two new HTTP routes
    (`GET /api/mc-install/versions`/`loaderversions`, admin-gated like MC Start Settings
    itself). What actually marks a build "recommended" varies by loader, documented at each
    call site rather than faked uniformly: **Forge** has a real, official signal - its own
    `promotions_slim.json` (`<mcVersion>-recommended`, falling back to `<mcVersion>-latest` if
    Forge hasn't picked one for a very fresh Minecraft version yet); **Paper** uses its Fill
    API's own STABLE channel; **Fabric** uses its own `stable` flag; **NeoForge and Sponge**
    have no such signal at all, so the newest build is starred instead as a best-effort
    default, called out as exactly that (not an official recommendation) in both the code
    comments and the picker's own behavior.
  - **Start Settings** (`StartSettingsTab.tsx` desktop, `mcss-version`/`mcss-loaderversion`
    web dashboard) gained a new `MinecraftProfile.loaderVersion?` field to hold the second
    selector's pick - purely informational (same "cosmetic, corrects itself, nothing reads it"
    status as `serverType` itself already had), optional so it's a no-op for every server that
    predates this field. Both pickers fall back to a free-text field only for `serverType:
    'unknown'` (not a real loader to ask an install API about at all); for every real loader
    type, a value the server already had that isn't (or isn't yet) in the live list is kept as
    an extra synthetic option rather than silently dropped, so an older/custom value a server
    was already set to never just vanishes from the dropdown.
  - **"+ Add server"** (`InstallMinecraftServerPanel.tsx`) carries the picked `loaderVersion`
    through to `installMinecraftServerFiles`, and the resulting profile now starts with its
    own `loaderVersion` already filled in from whatever was actually installed - `MinecraftInstallResult`
    gained the same field for this.
  - **Verified**: full rewrite of `tests/minecraftInstallClient.test.ts`'s Paper section for
    the new Fill v3 shapes (including the STABLE-fallback and specific-build-fetch paths) and
    new tests for every new function (`listPaperBuildOptions`, `listFabricLoaderOptions`,
    `listForgeMinecraftVersions`/`listForgeLoaderOptions` including the promotions-file
    fallback and failure path, `listNeoForgeMinecraftVersions`/`listNeoForgeLoaderOptions`,
    the whole new Sponge client section); `tests/minecraftInstall.test.ts` rewritten for the
    new `(minecraftVersion, loaderVersion)` parameter shape across every loader (including the
    "resolves the recommended/newest build itself when loaderVersion is omitted" path for
    Forge/NeoForge/SpongeVanilla) plus new SpongeVanilla/SpongeForge install tests; new
    per-type cases added to `tests/minecraftDetect.test.ts` (the SpongeForge/"forge" substring
    trap), `tests/minecraftMods.test.ts`, `tests/modrinthClient.test.ts`, and
    `tests/curseforgeClient.test.ts` - 985 tests total now. A temporary headless-Chromium check
    (deleted after use) drove the web dashboard's MC Start Settings end to end: confirmed
    SpongeVanilla/SpongeForge appear in the Server type picker, the Minecraft-version select
    populates live from a mocked install API and keeps the server's existing value selected,
    the loader-version select shows up with a ★ on the mocked "recommended" option, picking
    one actually persists `loaderVersion` through the save route, and switching to vanilla
    correctly hides the loader-version row entirely - zero `pageerror` events. The desktop
    React side (`InstallMinecraftServerPanel.tsx`/`StartSettingsTab.tsx`) was **not** visually
    verified in a real renderer - same standing limitation as every other desktop-only change
    in this project (no display to drive the actual Electron window from this sandbox) - only
    typechecked and reasoned through against the same APIs the web dashboard check exercised
    live. `npm run typecheck`, the full `npx vitest run`, and `npm run build` all pass.

- **A real, separate "Plugins" tab, distinct from "Mods"** (user request - asked after being
  told the tradeoff against just relabeling the one existing tab, and explicitly chose a
  genuinely separate tab over a dynamic rename). The Mods tab's own content (search/install,
  installed list, rescan, update check) was already fully generic - it already said "mods/
  plugins" everywhere rather than assuming one or the other - so this is purely a navigation/
  labeling split, not a new feature: a server's own ecosystem decides which single tab it
  gets, never both. New `minecraftModEcosystem(serverType)` (`shared/minecraftMods.ts`)
  returns `'mods'` for Forge/Fabric/NeoForge, `'plugins'` for Paper/Spigot/SpongeVanilla/
  **and** SpongeForge (Sponge calls its own extensions "plugins" regardless of which
  implementation hosts them - this app's existing SpongeForge mod search already only ever
  searched the `sponge` Modrinth category, never a separate Forge-mod one, so "Plugins" was
  already the only ecosystem it actually offered), and `null` for vanilla/unknown.
  - **Desktop** (`MinecraftServerDetail/index.tsx`): the tab list is now computed from
    `profile.serverType` instead of a static array - a genuinely different `MinecraftTabKey`
    (`'mods'` or `'plugins'`) appears depending on the ecosystem, both rendering the exact
    same `ModsTab` component underneath. Switching a server's own type in Start Settings away
    from whichever tab is currently open doesn't force-navigate away from it (an accepted,
    pre-existing-pattern edge case, not a crash) - same as every other tab already behaves
    when its own preconditions change out from under it.
  - **Web dashboard**: kept the existing single, always-visible nav button/view (its own
    earlier design decision - MC nav buttons don't currently get per-selected-server
    visibility at all, see the game-switcher round) rather than introducing that just for
    this, but its label now switches live between "MC Mods" and "MC Plugins" (button text and
    the view's own heading) based on whichever server is actually selected - functionally the
    same outcome as the desktop's separate tab keys, since only one ecosystem is ever
    relevant for a given selected server anyway.
  - **Verified**: new `tests/minecraftModEcosystem.test.ts` covers every server type's
    mapping - 988 tests total now. A temporary headless-Chromium check (deleted after use)
    selected a Forge server and confirmed both the nav button and the view heading read "MC
    Mods", then selected a Paper server and confirmed both switched live to "MC Plugins" -
    zero `pageerror`/console-error events. The desktop tab-key split was only typechecked, not
    visually verified (no React testing setup exists in this project, and no display to drive
    the actual renderer from this sandbox - same standing limitation noted throughout this
    round). `npm run typecheck`, the full `npx vitest run`, and `npm run build` all pass.

- **Real bug fix, surfaced by the Plugins tab split above: the Plugins tab's own search was
  silently only ever able to find mods, never actual plugins** (user report: "you replaced
  the Mods tab with Plugins for Sponge, and this tab searches for mods"). The root cause
  predates the Plugins tab itself - `buildModrinthFacets` (`modrinthClient.ts`) has always
  hardcoded its search to `project_type:mod`, on the documented (but wrong) assumption that
  Modrinth's v2 API has no separate project type for plugins at all. Confirmed against
  Modrinth's own source (`labrinth`/`knossos`): `plugin` and `datapack` are genuinely distinct
  project types in their real data model - Bukkit/Spigot/Paper/Sponge loaders are explicitly
  linked to `project_type: "plugin"`, not `"mod"`. The v2 API's *response* serializer rewrites
  that field to the string `"mod"` in what it hands back to an already-fetched hit (so nothing
  client-side ever saw `"plugin"` as a value) - but that rewrite is cosmetic on the way out
  only, never applied to search filtering itself, so a `facets` query literally filtering on
  `project_type:mod` was excluding every real plugin from every search, for every server type,
  the entire time this app has had mod/plugin search at all (not something the Sponge/Plugins
  round introduced - it just made the gap directly visible for the first time, since Paper/
  Spigot's own `['paper','spigot','bukkit']` loader-category facet coincidentally still
  matched a handful of crossover/mistagged results before, giving a false impression of
  "mostly working"). Fixed by OR'ing both real project types in the same facet group
  (`['project_type:mod', 'project_type:plugin']`) - confirmed correct against Modrinth's own
  frontend code, which does exactly this when it wants to cover more than one content type at
  once. `tests/modrinthClient.test.ts` updated for the corrected facet shape, across both a
  mod-ecosystem loader and a plugin-ecosystem one (so it can't silently regress back to
  excluding plugins again for just one of the two tabs) - 989 tests total now. `npm run
  typecheck`, the full `npx vitest run`, and `npm run build` all pass. Not verified against a
  real Modrinth search response (no network access from this sandbox, same standing caveat as
  every API client in this codebase) - please confirm Paper/Spigot/Sponge search results
  actually include real plugins now, on a machine with real internet access.

- **Follow-up to the Plugins-tab split above: SpongeForge gets a genuinely separate "Mods"
  tab AND "Plugins" tab, each with its own independent search/install** (user correction -
  the previous round's dynamic-label approach on the web dashboard, and even the desktop's
  one-component-two-labels framing, didn't go far enough: SpongeForge really does run two
  independent ecosystems at once - its own Sponge plugin layer, and the Forge mod layer it's
  actually built on - and the user explicitly wanted both searchable separately, not one tab
  that just changes its label).
  - **Core model**: new `minecraftServerSupportsEcosystem(serverType, ecosystem)` (shared/
    minecraftMods.ts) - true for a type's one matching ecosystem same as before, but true for
    **both** `'mods'` and `'plugins'` specifically for `spongeforge`. Every search/install
    function from the Mods tab down to the Modrinth/CurseForge clients now takes an explicit
    `ecosystem` parameter deciding which loader category to filter by - `loaderCategoriesFor`/
    `modLoaderTypeFor`/`classIdFor` all gained a second parameter, where SpongeForge is the one
    real case `serverType` alone no longer determines (`ecosystem: 'mods'` → plain `forge`
    category/loader type; `ecosystem: 'plugins'` → `sponge` category, no CurseForge loader
    type, same as SpongeVanilla).
  - **Tracking which ecosystem each installed entry belongs to**: `InstalledMinecraftMod`
    gained an optional `ecosystem` field - set directly from the search/tab context for an
    explicit install (the UI already knows which tab initiated it, so no guessing needed),
    and derived best-effort from the matched version/file's own loader tags
    (`ecosystemFromLoaderTags`, reading Modrinth's `loaders` field or CurseForge's
    `gameVersions` array) when `scanForInstalledMods` adopts an untracked file with no tab
    context to trust. An entry whose ecosystem genuinely can't be determined is shown in
    *every* ecosystem tab a server type offers rather than hidden from any of them - the same
    "never silently hide a mod" philosophy already used for `source: 'unknown'` entries.
    `updateMinecraftMod`/`checkMinecraftModUpdates` read each entry's own stored tag rather
    than asking the caller to pick again.
  - **Desktop** (`ModsTab.tsx`): takes the `ecosystem` prop that was already added in the
    previous round and now actually uses it end to end - passes it into every search/install
    IPC call, and filters which slice of `profile.installedMods` its own "Installed" grid
    shows (`installedModsFor`). For SpongeForge, `MinecraftServerDetail/index.tsx` now renders
    two fully independent `ModsTab` instances (one per tab) instead of one component whose
    label happened to change - each with its own search box, its own search results, and its
    own filtered Installed list.
  - **Web dashboard**: replaced last round's single "always-relabeled" MC Mods view with two
    real, independent views - a genuinely new `view-mc-plugins`/`nav-mc-plugins` alongside the
    existing `view-mc-mods`/`nav-mc-mods` (both admin-gated, both always visible within
    Minecraft mode like every other MC nav button). The entire client-side controller (search,
    install, installed-list render, rescan, update-check) was refactored from one hardcoded
    set of functions into `createMcModEcosystemView(ecosystem, ids)`, instantiated twice -
    each instance owns its own DOM element refs and closure state, so the two tabs genuinely
    don't share so much as a search box. Both still hit the exact same backend routes
    (`/api/servers/:id/mc-mods/search`/`install`), now carrying an `ecosystem` query param/
    body field; the "list installed" route is unchanged (still returns the full list) and each
    view filters its own slice client-side, same reasoning as the desktop side. Each view also
    shows a clear "this server type has no \"X\" ecosystem" message (rather than an empty
    search box) when the currently selected server doesn't actually offer that ecosystem -
    true for most types in one direction, false for both at once only for SpongeForge.
  - **Two real bugs found and fixed along the way**: (1) a stray backtick inside a new code
    comment inside the client `<script>` template literal silently terminated the whole
    template early, breaking the entire dashboard - same class of mistake flagged and fixed in
    an earlier round, now doubly confirmed as a real hazard specific to this file's
    architecture (the syntax-check script this project already uses catches it immediately,
    but it's easy to introduce by hand). (2) `ecosystemFromLoaderTags` crashed on a CurseForge
    fingerprint match whose response happened to omit `gameVersions` (an edge case a stricter
    mock fixture exposed) - fixed to tolerate a missing/non-array input and tag the result
    `ecosystem: undefined` instead of crashing the whole scan silently back to "unknown". (3)
    *Found via an actual browser check, not inspection*: `sponge.png` was never added to
    `KNOWN_GAME_ICON_FILE_NAMES` in the round that introduced it - `/game-icons/sponge.png`
    (used by both the MC Start Settings type picker and, now, both Mods/Plugins tabs' Browse
    headers) was 404ing the entire time despite the file existing on disk. Fixed, and a new
    `tests/webDashboard.test.ts` case added alongside the other per-loader icon routes so this
    can't quietly regress again.
  - **Verified**: new SpongeForge-specific tests in `tests/minecraftMods.test.ts` (rejecting a
    search/install for an ecosystem a type genuinely doesn't have; a SpongeForge install
    tagging its result with whichever ecosystem was asked for), `tests/minecraftModScan.test.ts`
    (ecosystem derived correctly from a Modrinth match's `loaders` field; a CurseForge match
    with no `gameVersions` at all still adopts instead of crashing), `tests/curseforgeClient.test.ts`
    (SpongeForge's split modLoaderType/classId behavior per ecosystem), and
    `tests/minecraftModEcosystem.test.ts` (`minecraftServerSupportsEcosystem` covering every
    type, including SpongeForge's both-at-once case) - 1000 tests total now. A temporary
    headless-Chromium check (deleted after use) drove the full real-world scenario end to end:
    a Forge server shows Mods-only (Plugins tab shows the "no ecosystem" message and vice
    versa for a Paper server), a SpongeForge server shows **both** tabs fully populated at
    once with correctly separated Installed lists (a Forge-tagged mod only ever appears under
    Mods, a Sponge-tagged plugin only under Plugins), and searching from each tab independently
    sends its own distinct `ecosystem` value to the backend - zero `pageerror`/console-error/
    bad-response events once the sponge.png bug above was caught and fixed. The desktop side's
    two-instance rendering was only typechecked, not visually verified (same standing
    limitation as every desktop-only change in this project). `npm run typecheck`, the full
    `npx vitest run`, and `npm run build` all pass.

- **Follow-up correctness fix: the Plugins tab's CurseForge search was still returning real
  Forge/Fabric mods for Sponge** (user correction - the dual-ecosystem rebuild above was
  structurally right, but one mapping inside it was still wrong: `classIdFor(serverType,
  ecosystem)` fell back to CurseForge's generic "Mods" class (id 6) whenever no dedicated
  CurseForge class existed for the requested ecosystem+type combo - true for Sponge's
  `'plugins'` ecosystem, since CurseForge has no "Sponge Plugins" class at all, unlike Paper/
  Spigot's real `BUKKIT_PLUGINS_CLASS_ID`. That fallback was a deliberate but wrong tradeoff
  from the previous round (its own doc comment even predicted the risk and dismissed it) -
  in practice it meant every CurseForge search from the Plugins tab, for SpongeVanilla or
  SpongeForge, actually queried CurseForge's real Forge/Fabric Mods class and returned
  genuine mod content mislabeled as plugin results. Modrinth's own side was unaffected (it
  has a real `sponge` category already).
  - **Fix** (`src/main/lib/curseforgeClient.ts`): `classIdFor` now returns `number | undefined`
    - `undefined` means "no real CurseForge class exists for this combination," returned for
    `ecosystem: 'plugins'` on every server type except Paper/Spigot. `searchCurseForgeMods`
    (its only caller) now checks for `undefined` first and returns `[]` immediately, skipping
    the CurseForge fetch entirely, instead of coercing `undefined` into the literal string
    `"undefined"` as a query param.
  - **Verified**: updated the two `tests/curseforgeClient.test.ts` cases that previously
    asserted the old (buggy) `classId === '6'` fallback for Sponge's plugin ecosystem - they
    now assert no CurseForge fetch happens at all for that case (both the plain SpongeVanilla
    case and SpongeForge's own `'plugins'` half, which still correctly makes one real fetch
    for its `'mods'` half). `npm run typecheck`, the full `npx vitest run` (1000 tests), and
    `npm run build` all still pass.

- **Correction to the fix immediately above: CurseForge's Plugins class isn't Paper/Spigot-
  only - it's one generic class shared by every server-side plugin platform, Sponge
  included** (user correction - "curseforge a une section plugins": CurseForge genuinely has
  a Plugins section, so skipping the CurseForge search entirely for Sponge, as the previous
  round just shipped, was throwing away real results instead of fixing the mislabeling). On
  reflection, CurseForge's class taxonomy for Minecraft only ever splits "Mods" (class 6,
  Forge/Fabric/NeoForge) from "Plugins" (class 4471) - that second class's URL slug is
  `bukkit-plugins`, a naming leftover from when Bukkit was the only plugin API CurseForge
  supported, but the class itself was never split per plugin platform the way Mods is split
  from Plugins. Sponge plugins that do exist on CurseForge are filed under that same class,
  not a separate one - so the right fix was to route Sponge's `'plugins'` ecosystem to the
  same class Paper/Spigot already use, not to treat it as unmapped.
  - **Fix** (`src/main/lib/curseforgeClient.ts`): renamed `BUKKIT_PLUGINS_CLASS_ID` to
    `PLUGINS_CLASS_ID` and `classIdFor` now returns it for `ecosystem: 'plugins'` on *every*
    server type, not just Paper/Spigot - back to a plain `number` return (no more `undefined`
    case to special-case). `searchCurseForgeMods` reverted to its simpler pre-"skip" form.
    `modLoaderTypeFor` is unaffected - CurseForge's Plugins class still isn't split by
    loader/platform, so no `modLoaderType` param is sent for any plugin-ecosystem search,
    Sponge included, same as it always was for Paper/Spigot.
  - **Verified**: updated `tests/curseforgeClient.test.ts`'s Sponge cases back to asserting a
    real CurseForge fetch happens with `classId=4471` and no `modLoaderType` (both the plain
    SpongeVanilla case and SpongeForge's own `'plugins'` half). `npm run typecheck`, the full
    `npx vitest run` (1000 tests), and `npm run build` all pass. Not re-verified in a live
    browser against CurseForge's real API (no network access in this environment) - please
    confirm on a machine with real internet access that Sponge plugin search now returns
    genuine Sponge-platform plugins (mixed in among Bukkit/Spigot/Paper results under the
    same class, since CurseForge itself doesn't separate them further).

- **Discord bot integration: the standalone Python "Bober" status bot is now a native part
  of the Manager**, ported to TypeScript rather than kept as a separate hand-run Python
  project with its own venv/`.env` (user request - "intègre entièrement" after discussing
  the tradeoffs). Full French user-facing strings preserved throughout (every embed, every
  slash command reply) - this was a mechanical port, not a rewrite "in the spirit of".
  - **Architecture: a genuinely separate OS process, not code living inside the Manager's
    own main process** - decided after discussing the tradeoff explicitly with the user. A
    bug in ~3000 lines of Discord-API logic (a bad embed, a Discord API hiccup, a rogue
    slash command handler) can now never take down server management/monitoring/the web
    dashboard, and the reverse also holds - the bot process can keep running and even
    report "Manager unreachable" on Discord if the Manager itself crashes, instead of just
    going silent. The cost: the bot talks to the Manager purely over its own existing local
    Web Dashboard HTTP API rather than calling internal functions directly - judged well
    worth it for the isolation.
  - **The real simplification this unlocked**: the standalone bot had to open its own RCON
    sockets and re-implement Minecraft's Server List Ping protocol, because it had no
    relationship with the Manager by default. Since this version is *spawned by* the
    Manager, it doesn't need any of that - `GET /api/servers` (the same route the browser
    dashboard already polls) gives it the full live ARK+Minecraft server list, state,
    players and version in one call, and `POST /api/servers/:id/rcon` (the same route the
    desktop Console tab's command box already uses) covers `/rcon`, `/rconall`,
    `/dinowipe`, `/saveworld` and `/adminchat` - all just different text commands through
    that one existing endpoint. No RCON library, no Minecraft ping protocol, and critically
    **no more manual per-server config** - the old bot needed `ARK_SERVER_N_NAME/IP/
    RCON_PORT/RCON_PASSWORD/MAP/MAX_PLAYERS` typed into `.env` for every single server; this
    version needs none of that, it just asks the Manager.
  - **No manual API key copy-pasting either**: the old bot needed a Web Dashboard API key
    created by hand in Settings and pasted into `.env`. This version auto-provisions one
    internally (`src/main/lib/discordBot.ts`'s `ensureApiKey`, reusing the exact same
    `generateApiKeyId`/`generateApiKeySecret`/`hashPassword`/`buildApiKey`/
    `saveWebDashboardApiKey` functions Settings' own "create API key" button calls) labeled
    "Discord Bot (interne)" in that same key list, minted fresh (old one revoked) every time
    the bot (re)starts - a stored `secretHash` can't be turned back into the plaintext key
    the bot needs to send, so reusing one across restarts isn't possible anyway, and these
    keys are never shown to the user beyond that label. When Settings' "Require access
    token" is off, no key is sent at all (matching the Web Dashboard API's own no-auth-by-
    default posture). The CurseForge module also reuses the Mods tab's existing
    `curseforgeApiKey` setting rather than asking for a second key just for this.
  - **Build pipeline**: `src/bot/` is a separate TypeScript module tree, bundled by
    **esbuild** (`scripts/build-bot.mjs` → `out/bot/index.js`) rather than folded into
    electron-vite's own Rollup-based main build - discord.js has internal circular
    `require()`s (`Base` ↔ `Channel` ↔ `GuildChannel` ↔ `util`) that Rollup's commonjs
    plugin reorders into a broken init sequence (`TypeError: Class extends value undefined`,
    confirmed by actually trying it), which esbuild doesn't hit since it preserves real
    `require()` semantics. `zlib-sync`/`bufferutil`/`utf-8-validate` (optional native
    speedups `@discordjs/ws` tries behind its own try/catch) are marked external on both
    the esbuild and - briefly, before the esbuild switch - Rollup side, since they're never
    actually installed here. The Manager's main process spawns the bundle via Node's
    `child_process.fork()` with `ELECTRON_RUN_AS_NODE=1` (Electron's documented pattern for
    a plain-Node helper process) - verified end to end with a real `fork()` call under
    Electron's own binary, not just a typecheck.
  - **Supervisor** (`src/main/lib/discordBot.ts`): `applyDiscordBotSettings` (called on every
    Settings save, same unconditional-reapply pattern `applyWebDashboardSettings` already
    uses, and once at Manager startup) starts/stops the bot to match
    `discordBotEnabled`+a non-empty token. Config is written to a JSON file in the Manager's
    data dir and passed as the child's first argv (not an env var or an IPC message - the
    bot can always re-read its own current config on a restart without depending on timing
    with the parent). stdout/stderr are piped into the existing Manager Log
    (`logManagerEvent`/`newTaskId`, tagged "Bot Discord") rather than a new log sink. The
    bot process is deliberately **not** killed when the Manager quits - same "survives the
    Manager closing" philosophy already applied to game server processes, and the one thing
    that makes "report Manager unreachable" above actually possible.
  - **Ported 1:1** (new `src/bot/` files): `managerApiClient.ts` (the HTTP client described
    above, tolerating the Manager's self-signed cert via `undici`'s `Agent` when Settings'
    HTTPS mode is on), `statusEmbeds.ts`/`externalStatus.ts` (EOS/AWS/Cloudflare/Xbox Live/
    Minecraft Auth checks, verbatim), `curseforge.ts`/`curseforgeCheck.ts` (the HTML→Discord-
    Markdown changelog converter, changelog splitting, the periodic update-check loop),
    `maintenanceState.ts`/`schedule.ts` (in-memory only, not persisted - matches the
    standalone bot's own documented behavior, not a regression), and every slash command
    (`src/bot/commands/`): `/status`, `/statusserveur`, `/statusmc`, `/maintenance` (on/off/
    all), `/maintenancemc` (on/off/all), `/botmaintenance`, `/check` (on/off), `/schedule`
    (dinowipe/list/cancel), `/dinowipe`, `/saveworld`, `/adminchat`, `/adminchatall`,
    `/rcon`, `/rconall`, `/start`, `/stop`, `/restart`, `/update`, `/updaterestart`,
    `/setchannel`, `/addmod`, `/removemod`, `/listmods`, `/testmod` - same whitelists
    (`MAINTENANCE_WHITELIST`/`MANAGER_WHITELIST`, now Settings fields instead of `.env`
    lists), same autocomplete behavior (now sourced from the live `/api/servers` list
    instead of a static one), same per-server maintenance/check-disabled overrides on the
    status lines.
  - **Settings UI**: a new "Discord Bot" tab in the desktop Settings screen (token, dev
    guild id, both clusters' channel/refresh/embed/check settings, the two whitelists as
    comma-separated id fields, CurseForge module toggle/default mods/check interval, plus a
    live running/error status line and a "Restart bot" button) - shares the existing
    Settings form/save button rather than a separate dialog.
  - **Verified**: 50 new tests across `tests/discordBot*.test.ts` - the CurseForge HTML→
    Markdown converter and changelog splitter against known input/output pairs, the status-
    embed line-building logic for every server state (running/maintenance/each Manager
    state/check-disabled-filtered-out) and both clusters, the Manager API client's 401/403/
    network-error handling and request shapes (mocked `fetch`), the server-list cache's ARK/
    Minecraft split and name lookup, maintenance-state get/set, and the main-process
    supervisor's config-building and API-key-provisioning logic (mocked `electron`/store/
    `child_process.fork`) - including that a stale previous API key is actually revoked, not
    just replaced. `npm run typecheck`, the full `npx vitest run` (1050 tests), and `npm run
    build` all pass; the bundled `out/bot/index.js` was run standalone and via a real
    `fork()` + `ELECTRON_RUN_AS_NODE` call (both fail cleanly on `discord.com` DNS resolution
    in this network-sandboxed environment - no Discord token/live gateway connection could
    be tested here). **Not verified**: an actual Discord server receiving real slash
    commands, embeds rendering correctly in a real Discord client, or the full start/stop/
    RCON round trip against a real running ARK/Minecraft server - please run this against a
    real bot token and real servers before relying on it.

- **Follow-up to the Discord bot integration above: `/check off` is now persistent** (user
  request, closing a gap flagged right after the integration landed). The standalone bot
  had both a static, persistent `DISABLED_SERVERS` list in `.env` *and* a separate, non-
  persistent `/check on/off` toggle layered on top of it - the port above only carried over
  the non-persistent toggle, so a bot restart silently un-excluded every server `/check off`
  had hidden. Rather than reintroducing a second, static config list, the toggle itself now
  persists - one mechanism instead of two.
  - **Fix** (`src/bot/maintenanceState.ts`): new `initMaintenanceState(stateDir)`, called
    once at startup (`src/bot/index.ts`, right after `loadConfig()`), loads the disabled-
    server id set from `disabled_servers.json` in the bot's own state dir - same file-based
    persistence style already used by the CurseForge module's two JSON files, same
    tolerate-a-missing-or-malformed-file-without-crashing behavior. `setCheckDisabled` now
    writes the updated set back to that file on every call. Every other maintenance flag
    (ARK/Minecraft maintenance, the bot's own maintenance mode) stays deliberately in-memory
    only, unchanged - this fix is scoped to `/check` alone, not a general persistence pass.
  - **Verified**: three new tests in `tests/discordBotMaintenanceState.test.ts` - a
    simulated restart (`initMaintenanceState` called again against the same state dir)
    correctly reloads what was persisted rather than starting empty, a fresh/empty state
    dir starts with nothing disabled, and a malformed `disabled_servers.json` is ignored
    (logged, not thrown) rather than crashing the bot on startup. `npm run typecheck`, the
    full `npx vitest run` (1053 tests), and `npm run build` all pass.

- **Real bug, found by the user: autocomplete on every `serveur:` option showed nothing**
  (e.g. typing `/check on serveur:`). Every slash command's autocomplete handler read from
  `serverCache.ts`'s in-memory cache but never refreshed it itself - that cache is only
  populated by `/status`/`/statusmc` actually being run, or by the auto-refreshed embed
  loop (which only exists at all when a status channel is configured). A bot that had just
  started, with no status channel set and nobody having run `/status` yet, had a
  permanently empty cache - every autocomplete dropdown across every command stayed empty
  until one of those happened to run once.
  - **Fix**: every `autocomplete` handler (`src/bot/commands/*.ts`, 11 call sites across
    `statusCommands.ts`, `maintenanceCommands.ts`, `scheduleCommands.ts`, `adminCommands.ts`,
    `managerCommands.ts`) now calls `refreshServerCache(config)` itself before building
    suggestions, the same one-call, localhost-only round trip `/status` already does -
    comfortably inside Discord's ~3s autocomplete response budget. `execute` handlers were
    unaffected (they already refreshed the cache themselves); this was purely an
    autocomplete-specific gap, caught because every one of them had quietly skipped the
    `config` parameter their own type signature already offered.
  - `npm run typecheck`, the full `npx vitest run` (1053 tests), and `npm run build` all
    pass. Autocomplete itself can't be exercised by the existing test suite (it needs a real
    Discord interaction), so this is typechecked/built but not independently tested beyond
    the existing `refreshServerCache`/`autocompleteServerNames` unit coverage - please
    confirm in Discord that `serveur:` now suggests servers immediately after a fresh bot
    start, with no status channel configured and no `/status` run first.

- **Two real bugs found from the user's own first real run of the bot** (live logs against
  a real Discord bot token and a real Manager - the first actual runtime signal this
  integration has had, everything before this was typecheck/build/mocked-fetch only).
  - **AWS Health check always failed to parse**: `Impossible de récupérer le statut AWS :
    Unexpected token '�'...`, every single cycle. The real
    `health.aws.amazon.com/public/currentevents` endpoint serves its JSON with a leading
    UTF-8 BOM (`﻿`) - `response.json()` calls `JSON.parse` on the raw text without
    stripping it, so parsing failed deterministically, not as a flaky network hiccup. Fixed
    (`src/bot/externalStatus.ts`) with a `fetchJsonWithTimeout` helper that reads the body
    as text and strips a leading BOM before `JSON.parse`, now used by the EOS, AWS and
    Cloudflare checks (the three that parse JSON - Xbox/Official Network/Minecraft Auth only
    ever read raw text, unaffected). New `tests/discordBotExternalStatus.test.ts` (8 tests,
    first real coverage for this file) locks in the BOM-prefixed case for all three, plus
    the AWS Middle-East-filtering logic and the official-network "Offline" keyword
    matching - none of `externalStatus.ts` had test coverage before, since this bug is
    exactly the kind unit tests against *mocked* fetch responses can't catch on their own
    (nothing I wrote would have thought to prepend a BOM) - this one only surfaced from an
    actual run against the real endpoint.
  - **"ARK Server Manager injoignable (fetch failed)" gave no way to diagnose why**: undici's
    `fetch` wraps every connection-level failure (refused, DNS, TLS...) in a generic
    `TypeError: fetch failed`, with the actually useful reason (e.g. `connect ECONNREFUSED
    127.0.0.1:8090`) sitting on `err.cause`, which `managerApiClient.ts` was dropping -
    every real failure logged identically regardless of cause. Now included in the error
    message. This doesn't fix the user's underlying "can't reach the Manager" symptom by
    itself (still being tracked down - likely the Web Dashboard not actually enabled/running
    at the configured port, or a mismatched port) but the next occurrence will say exactly
    why instead of just "fetch failed". New test in
    `tests/discordBotManagerApiClient.test.ts` confirms `err.cause`'s message is now
    surfaced. `npm run typecheck`, the full `npx vitest run` (1062 tests), and `npm run
    build` all pass.

- **Found the actual root cause of the "ARK Server Manager injoignable" reports above:
  the bot's Manager API URL hardcoded `127.0.0.1`, ignoring Settings' own Web Dashboard
  Host field entirely.** Node's `http(s).Server.listen(port, host)` only binds to the
  exact host given - `'127.0.0.1'` (default) and `'0.0.0.0'` (every interface, wildcard)
  both still accept a `127.0.0.1` connection, but a specific LAN IP (a real, supported
  choice in that same Settings tab, for exposing the dashboard to other devices) binds
  *only* that interface. With that configured, the dashboard was genuinely running and
  reachable from a browser, while the bot's hardcoded `127.0.0.1` got `ECONNREFUSED` every
  single cycle - exactly the symptom reported (confirmed enabled, on the right port,
  `/check` and everything else still empty).
  - **Fix** (`src/main/lib/discordBot.ts`): new `managerApiHost(settings)` uses the
    configured `webDashboardHost` directly whenever it's a specific address, falling back
    to `127.0.0.1` only for an empty value or the `0.0.0.0` wildcard - connecting to a
    machine's own LAN IP from itself always works, so there's no real reason to special-
    case `127.0.0.1` beyond those two cases. Replaces the previous unconditional
    `127.0.0.1`.
  - **Verified**: two new tests in `tests/discordBot.test.ts` - a specific LAN-IP host
    produces that exact `managerApiUrl`, and both an empty host and the `0.0.0.0` wildcard
    still fall back to `127.0.0.1`. `npm run typecheck`, the full `npx vitest run` (1064
    tests), and `npm run build` all pass. Still not independently confirmed against the
    user's own exact Settings (their Host value wasn't shared) - if `webDashboardHost` was
    actually left at the default `127.0.0.1` the whole time, this fix doesn't explain their
    specific case and the search continues from there.

- **Found why none of the three fixes above actually changed anything for the user despite
  repeated pulls/rebuilds/restarts: `npm run dev` never rebuilds the bot bundle at all.**
  Only `npm run build` ran `scripts/build-bot.mjs`; `"dev": "electron-vite dev"` only
  rebuilds `src/main`/`src/preload`/the renderer. Anyone iterating via `npm run dev` (as
  opposed to a full `npm run build` + launching the packaged app) had `out/bot/index.js`
  permanently frozen at whichever `npm run build` last touched it, however many times they
  edited `src/bot/`, pulled, or restarted the Manager - explaining the identical "fetch
  failed"/AWS-BOM log lines surviving three separate fix attempts untouched.
  - **Fix**: `"dev": "node scripts/build-bot.mjs && electron-vite dev"` - rebuilds the bot
    bundle once up front every time `npm run dev` starts. It still won't live-reload on a
    further `src/bot/` edit while that same `dev` session keeps running (esbuild's script
    runs standalone, outside electron-vite's own watch pipeline) - restart `npm run dev`
    itself to pick up a bot-side change, same restart-to-reload expectation as any other
    main-process edit already has by convention here.
  - **Verified**: ran `npm run dev` with `out/bot/` deleted first and confirmed
    `out/bot/index.js` is rebuilt before `electron-vite dev` itself starts. `npm run
    typecheck`, the full `npx vitest run` (1064 tests), and `npm run build` all still pass.
- **Added a "Stop bot" button** next to "Restart bot" in the Discord Bot Settings tab (user
  request) - stops the running process immediately without touching the Enabled checkbox,
  for a quick "turn it off right now" independent of Settings' own save-to-apply flow. The
  next Settings save (or a Manager restart) still respawns it if that checkbox is still
  checked - this is a one-shot stop, not a persisted "stay disabled" state; also offered
  when the checkbox was just unchecked but not yet saved, so a stale running process from
  before that doesn't require a save just to stop it. New `discordBotStop` IPC channel
  wrapping the already-existing `stopDiscordBot()`.

- **The AWS BOM fix above wasn't enough - the real response has more than one leading BOM-
  like character.** After the Manager-host fix landed, the user's logs showed "ARK Server
  Manager injoignable" finally gone, but the exact same AWS JSON parse error survived
  unchanged - stripping a single leading `﻿` wasn't enough, because a real capture of
  the response showed *two* in a row (the log's mangled `´┐¢´┐¢` - two repeated garbled
  sequences - was the actual clue, missed the first time). Rather than keep guessing exactly
  how many BOM characters (or what else) precedes the real JSON, `fetchJsonWithTimeout`
  (`src/bot/externalStatus.ts`) now finds the first `[` or `{` anywhere in the response text
  and parses from there, discarding everything before it unconditionally - correct no
  matter what junk precedes it or how much of it there is, since every endpoint this helper
  is used for always returns a JSON array or object at the top level.
  - **Verified**: two new tests in `tests/discordBotExternalStatus.test.ts` - two leading
    BOM characters in a row, and a response prefixed with arbitrary non-BOM junk text
    (neither of which the previous single-character strip would have handled). `npm run
    typecheck`, the full `npx vitest run` (1066 tests), and `npm run build` all pass.
- **Root-caused why three straight fix attempts kept showing identically unchanged log
  lines, independent of the `npm run dev` bundling gap found earlier**: the user had been
  stuck on an unrelated, several-messages-long `git pull`/merge-conflict/stash tangle in
  their own local checkout the entire time (conflict markers repeatedly reappearing in
  `package.json`/`package-lock.json` from a stale `git stash` entry predating this whole
  integration) - every rebuild in between was still running pre-fix code because the pull
  that would have brought each fix in kept failing. Once that was cleared up (dropping the
  stale stash, whose only contents were exactly the already-reconciled `package.json`/
  `package-lock.json`, and completing the pending merge commit), the Manager-connectivity
  fix was confirmed working immediately (the "injoignable" warning disappeared from the
  user's own logs) - the AWS BOM issue surviving that same pull is what led to this round's
  fix above actually being a real, previously-masked second bug, not a repeat of the first.

- **The bracket-search fix above wasn't the end of it either: AWS's response fails to parse
  for a *third*, different reason past the leading junk** - after the fix above landed, the
  user's log showed the mangled leading characters finally gone (`fetchJsonWithTimeout` is
  working), but a new parse error further into the text, right around where the real JSON
  content starts. Diagnosing this exactly from the log alone has hit the same wall twice
  now: Windows console encoding mangles non-ASCII bytes into unreadable mojibake
  (`´┐¢`-style garbage) before they ever reach the pasted log, so two different real
  problems have now been misread as "the same BOM issue" from the log text alone.
  - **Fix** (`src/bot/externalStatus.ts`): `fetchJsonWithTimeout` now catches its own
    `JSON.parse` failure and re-throws with a `JSON.stringify`-escaped preview of the
    exact text it tried to parse (safe regardless of console encoding, since
    `JSON.stringify` always escapes non-printable/non-ASCII characters to `\uXXXX`) plus
    the literal Unicode code points of its first 20 characters as plain numbers - something
    no console encoding mismatch can mangle. The next occurrence will log the actual bytes
    unambiguously instead of needing yet another round of guessing from mangled terminal
    output.
  - **Verified**: new test in `tests/discordBotExternalStatus.test.ts` asserts on the
    literal code point number (`65533`, i.e. `�`) rather than the character itself -
    deliberately, since asserting on the raw character would have the exact same source-
    encoding fragility this fix exists to route around. `npm run typecheck`, the full `npx
    vitest run` (1067 tests), and `npm run build` all pass. Still not root-caused: the next
    real log line is needed to actually fix whatever this third issue turns out to be -
    this round only guarantees that log line will be legible.

- **The actual root cause of the entire AWS saga, finally found via the diagnostic above:
  the real response is UTF-16LE-encoded, not UTF-8.** The user's next log line showed the
  code points `91,0,123,0,34,0,100,0,...` - `[`, NUL, `{`, NUL, `"`, NUL, `d`, NUL... a
  `0x00` byte after every single ASCII character, the unmistakable signature of ASCII-range
  text encoded as UTF-16LE. `fetch`'s `response.text()` always decodes as UTF-8 with no way
  to override it, and the endpoint declares no charset to reveal otherwise - every earlier
  "BOM" theory in this saga was real evidence of the *same* underlying misdecoding, just
  misread as a narrower leading-prefix issue because a console encoding mismatch (separately
  confirmed) kept mangling the raw bytes before they ever reached a readable log line.
  - **Fix** (`src/bot/externalStatus.ts`): new `readResponseText(response)` reads the raw
    bytes via `response.arrayBuffer()` and picks the correct decoder itself - a real UTF-16LE/
    UTF-16BE/UTF-8 BOM first, then falls back to detecting *unmarked* UTF-16LE by the same
    "every other byte is zero" shape confirmed above (the real AWS response has no BOM at
    all). Used everywhere this file reads a response body as text - not just the JSON checks
    (EOS/AWS/Cloudflare), but also the plain-text ones (Official Network ASA, Xbox Live) that
    could have silently matched nothing against a misdecoded body the exact same way, just
    without an exception to surface it. `fetchJsonWithTimeout`'s bracket-search and
    diagnostic-logging from the last two rounds stay in place as a defensive second layer -
    harmless, and correct decoding should make them unnecessary in practice now.
  - **Verified**: rewrote `tests/discordBotExternalStatus.test.ts`'s fake-response helper to
    go through real byte encoding/decoding (`Buffer`-based) instead of plain JS string
    literals standing in for "already decoded" text, a more faithful test of the actual code
    path - plus new cases for genuinely UTF-16LE-encoded responses, with and without a BOM
    (the no-BOM case is the exact shape confirmed from the real AWS response), for both
    `queryAwsStatus` and `queryOfficialNetworkStatus`. 14 tests in that file now, 1070 total.
    `npm run typecheck`, the full `npx vitest run`, and `npm run build` all pass.

- **Discord status embeds now show each Manager group as its own field, instead of lumping
  every server into one combined "Cluster" field** (user request, confirmed working against
  their own 13-server cluster right after the whole connectivity saga above finally
  resolved) - mirrors the desktop Dashboard/Cluster Dashboard, which already visually
  separates a "Testing" group (or any other) from the main one.
  - **`src/bot/statusEmbeds.ts`**: new `groupServersByGroup` groups the visible server list
    by the Manager's own `group` field (already part of `ManagerServerInfo`, sourced
    straight from `/api/servers`), preserving the order servers already arrive in rather
    than re-sorting - `/api/servers` already returns them pre-sorted by group
    (`sortProfilesForDisplay`), so a simple order-preserving group-by keeps both the
    within-group order and the group order itself correct with no separate "group order"
    setting to fetch just for this. An empty/unset group name falls back to the "Cluster"
    label, matching the Manager's own default. `buildStatusEmbed` now emits one `📡
    <group name>` field per group instead of a single hardcoded `📡 Cluster` field (the
    aggregate "Status Cluster" line in the Système field is unchanged - still computed
    across every visible server regardless of group); `buildMinecraftStatusEmbed` got the
    same treatment with `⛏️ <group name>` fields, for consistency with the ARK side (the
    Minecraft Dashboard already supports its own groups too, via `minecraftGroupOrder`/
    `minecraftCollapsedGroups`, so the same gap would have surfaced there next).
  - **Verified**: 4 new tests in `tests/discordBotStatusEmbeds.test.ts` - multiple groups
    render as separate, correctly-named fields with the right servers in each, a server
    with no group set still falls back to a "Cluster" field, group order is preserved
    rather than alphabetized, and the same grouping works for the Minecraft embed. All
    existing tests (which only ever used a single implicit group) still pass unchanged -
    1074 tests total. `npm run typecheck`, the full `npx vitest run`, and `npm run build`
    all pass.

- **Fixed: Discord status embed group fields didn't respect the Manager's own configured
  group order** (user report, with a screenshot showing "Cluster, PTR, Testing" instead of
  the expected "Testing" before "PTR") - the previous entry above assumed `/api/servers`
  "already returns them pre-sorted by group" via `sortProfilesForDisplay`; that assumption
  was wrong. Reading `sortProfilesForDisplay` (and `sortMinecraftProfilesForDisplay`) in
  `src/main/lib/webDashboard.ts` showed they sort group names **alphabetically**
  (`groupNames.sort()`), not by `settings.groupOrder`/`minecraftGroupOrder` - that's exactly
  why "PTR" sorted before "Testing". The desktop Dashboard never relies on that API-level
  order for its own display either: `Dashboard.tsx`/`MinecraftDashboard.tsx` each re-derive
  their own `groupNames` client-side from `settings.groupOrder`/`minecraftGroupOrder`
  (explicitly-ordered names first, then any other group appended alphabetically) - the same
  logic the bot needed, just never wired up for it.
  - **`shared/discordBot.ts`**: `DiscordBotConfig` gained `groupOrder: string[]` and
    `minecraftGroupOrder: string[]`, mirroring `AppSettings`'s own fields of the same name.
  - **`src/main/lib/discordBot.ts`**: `buildConfig` now passes `settings.groupOrder` and
    `settings.minecraftGroupOrder` straight through into the bot's config file.
  - **`src/bot/statusEmbeds.ts`**: new `orderGroupNames(groupNames, groupOrder)` applies the
    exact same ordering as the desktop Dashboard (explicitly-ordered names first in that
    order, everything else appended alphabetically); `groupServersByGroup` now takes a
    `groupOrder` argument and returns its `Map` built in that resolved order instead of
    insertion order. `buildStatusEmbed` passes `config.groupOrder`, `buildMinecraftStatusEmbed`
    passes `config.minecraftGroupOrder`. The stale doc comment claiming `/api/servers`
    "already returns them pre-sorted by group" was corrected.
  - **Verified**: updated the now-incorrect "preserves the order groups already arrive in"
    test to reflect the real default (alphabetical, since `groupOrder` is empty unless set)
    and added two new tests - one confirming an explicit `groupOrder` of `['Testing', 'PTR']`
    produces `Testing, PTR, Cluster` (the user's exact reported scenario) for the ARK embed,
    and one confirming `minecraftGroupOrder` works the same way for the Minecraft embed.
    1076 tests total, all passing. `npm run typecheck`, the full `npx vitest run`, and
    `npm run build` all pass. **Not yet verified**: the user hasn't confirmed against their
    live bot yet - needs a `git pull` + rebuild + bot restart on their end, same as every
    other round.

- **Added: "Keep running in the background when the window is closed" (close-to-tray)**
  (user request) - closing the window no longer has to quit the app; it can now hide to a
  system tray icon instead, so every managed server, the web dashboard, and the Discord bot
  all keep running in the background. Off by default - closing the window still quits the
  app exactly as before unless the user opts in.
  - **`shared/types.ts`**: new `AppSettings.closeToTrayEnabled: boolean`.
  - **`src/main/store.ts`**: default `false` added in both `getSettings()`'s merge-defaults
    object and the `electron-store` schema's own defaults, same pattern as every other
    settings field.
  - **`src/main/index.ts`**: a module-level `isQuitting` flag, set from `app.on('before-quit', ...)`
    (which always fires before Electron tries to close any window, so it's already correct
    by the time a window's own `close` handler runs - no race between "real quit" and "just
    closing the window"). The main window's `close` handler now checks
    `!isQuitting && getSettings().closeToTrayEnabled` (read fresh on every close, not cached,
    so toggling the setting takes effect on the very next close without a restart) - if both
    hold, `event.preventDefault()` and `mainWindow.hide()` instead of letting it actually
    close. A `Tray` (reusing the same `iconPath` as the window's own icon) is created once,
    with a context menu offering "Ouvrir Bober Server Manager" (show + focus the window) and
    "Quitter" (`app.quit()` - the only way to actually exit while this setting is on);
    left-clicking the tray icon also shows/focuses the window, matching the Windows
    convention. `window-all-closed`'s existing quit-on-close behavior is untouched and still
    applies exactly as before whenever the setting is off.
  - **`src/renderer/src/pages/DataSettingsView.tsx`**: new checkbox in the "Startup & Safety"
    section of Settings > General, right under "Start Manager when you log into Windows",
    with an explanation of what stays running and how to actually quit (the tray menu).
  - **`src/renderer/src/pages/SteamCmdView.tsx`**, **`tests/webDashboard.test.ts`**,
    **`tests/discordBot.test.ts`**: added the new field (defaulting to `false`) to every
    other full `AppSettings` literal in the codebase, so TypeScript keeps enforcing that
    none of them silently drift out of sync with the real shape.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1076 tests, unchanged -
    this feature has no isolated unit to test, since it's pure Electron window/tray
    wiring), and `npm run build` all pass. **Not yet verified**: no automated test covers
    actual tray behavior (Electron's `Tray`/`BrowserWindow` aren't something `vitest` can
    exercise headlessly) - needs the user to confirm in the real app that closing the
    window with the setting on hides it to the tray instead of quitting, that the tray
    icon's "Ouvrir" reopens the window, and that "Quitter" actually exits (including
    stopping the Discord bot/web dashboard along with the rest of the process).

- **Fixed: renaming or deleting a server made every text field/checkbox in the app stop
  responding, until a workaround was found** (user report: "quand je fais une action de
  changement de nom de serveur ou de suppression, les paramètre à texte et à coché ne
  fonctionne plus"). A real production bug, not a misreport - just a much harder one to
  pin down than it first looked, because the obvious theories were all wrong:
  - Not a main-process deadlock: a 2-second heartbeat logged straight to the terminal (a
    throwaway diagnostic added specifically to test this) kept ticking the entire time the
    app was "frozen," proving the main process's event loop was never blocked.
  - Not a stuck IPC call either: once the user got DevTools open (the app disables
    Electron's default menu, which is what normally wires up F12/Ctrl+Shift+I - had to add
    `mainWindow.webContents.openDevTools({ mode: 'detach' })` in dev mode just to see the
    renderer's own console at all) and found the Console panel's level filter was silently
    hiding "5 hidden" messages, every diagnostic breadcrumb through the full
    save/delete/move IPC round trip printed cleanly on both the main and renderer side -
    the operation itself always completed successfully.
  - The actual bug only showed up once the user ran `document.hasFocus()` live in that same
    DevTools console right after a delete's `confirm()` dialog closed: `false`. The
    renderer's own document had lost focus and never gotten it back - a known
    Electron/Windows issue already partially addressed in this codebase
    (`confirmAction.ts`/`dialog.ts`'s existing `mainWindow.focus()` calls), but evidently
    not reliably enough. Manually alt-tabbing away and back fixed it every time; a plain
    `mainWindow.focus()` + `mainWindow.webContents.focus()` call (tried first, see the
    now-superseded focus-only commit on this branch) did not - consistent with Windows'
    anti-focus-stealing protection, which can silently no-op `SetForegroundWindow` for a
    background process reclaiming focus on its own, even over its own window.
  - **`src/main/lib/windowFocus.ts`** (new): `forceRefocus(mainWindow)` calls
    `mainWindow.minimize()` + `mainWindow.restore()` (or just `restore()` if already
    minimized) before `focus()`/`webContents.focus()` - forcing the same genuine OS-level
    foreground transition alt-tabbing does, rather than asking Windows nicely via a plain
    `.focus()` call it's free to ignore.
  - **`src/main/ipc/system.ts`**, **`src/main/ipc/dialog.ts`**, **`src/main/ipc/steamcmdInstall.ts`**:
    all three existing refocus-after-a-native-dialog call sites (`appFocusWindow` behind
    `confirmAction()`, the file/folder picker dialogs, the SteamCMD firewall UAC prompt)
    now call the shared `forceRefocus()` instead of each duplicating a plain `.focus()`.
  - Renaming a server turned out not to be a separate cause - editing the Name field itself
    never calls any native dialog - it just surfaced the *already*-broken focus state left
    over from an earlier Delete in the same session, which is why the user saw both
    actions "break" typing.
  - **Diagnostic trail, since this took several rounds to actually pin down**: a
    2-second main-process heartbeat + step-by-step `[DIAG]` logging through every
    `profiles.save`/`delete`/`move`/`copy` IPC handler (both ARK and, once the user
    mentioned testing both games, the equivalent Minecraft handlers/renderer call sites
    too) + an auto-opened detached DevTools window in dev mode - all added temporarily
    across several commits on this branch and fully removed again once
    `document.hasFocus()` gave the real answer.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1076 tests, unchanged -
    no automated test can drive real OS-level window focus), and `npm run build` all pass.
    The user confirmed live, after pulling this exact fix, that deleting a server no longer
    leaves any field unresponsive ("c'est fix !").

- **Moved Settings (and Log) into a sidebar shared by both game modes, instead of being
  reachable only from ARK's own Dashboard header** (user request, right after confirming the
  focus fix above - turned out to be why "close to tray" looked broken too: it couldn't be
  reached/enabled at all while in Minecraft mode). Before this, `App.tsx`'s render short-
  circuited into a completely separate Minecraft branch (just `GameSwitch`, nothing else) and
  reached `showSteamCmd`/`showDataSettings`/`showProfileManagement` only afterward - which
  meant those checks, and the Settings/Log buttons that set them, never ran at all while
  `gameMode === 'minecraft'`.
  - **`src/renderer/src/App.tsx`**: moved the `showSteamCmd`/`showDataSettings`/
    `showProfileManagement` checks to the very top of the render, before the
    `gameMode === 'minecraft'` branch, so they work as top-level screens reachable from
    either mode (SteamCMD and Profile Management stay ARK-only in practice, since nothing in
    Minecraft mode links to them, but Settings now does from both). Added a
    `.app-sidebar-settings` button (pinned to the sidebar's bottom via CSS `margin-top:
    auto`) to both the ARK and Minecraft sidebars. Minecraft's sidebar also gained a
    "Minecraft Servers"/"Log" pair mirroring ARK's own Dashboard/Log buttons (both toggle
    the same shared `mainPage` state, swapping `MinecraftDashboard` for `ManagerLogView` in
    the content area) - the Manager Log is global, not per-game, so there was no reason it
    should only be visible from ARK mode either.
  - **`src/renderer/src/pages/Dashboard.tsx`**: removed the now-redundant `onOpenDataSettings`
    prop and its "Settings" header button (moved, not duplicated) - SteamCMD and Profile
    Management stay as ARK Dashboard header buttons, unchanged.
  - **`src/renderer/src/styles.css`**: new `.app-sidebar-settings` rule.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1076 tests, unchanged - no
    existing test touched `Dashboard`'s removed prop or `App.tsx`'s render order), and
    `npm run build` all pass. **Not yet verified**: needs the user to confirm Settings and
    Log are both reachable from Minecraft mode now, and that ARK mode still looks/behaves
    identically (Settings moved from the Dashboard header into the sidebar).

- **Web Dashboard: hid Minecraft's per-server nav tabs until an actual MC server is
  selected, matching ARK's own tabs** (user screenshot showing Console/MC Start Settings/MC
  Server Settings/MC Mods/MC Plugins/MC Backup/MC Server Management all visible at once from
  the plain "Minecraft Servers" overview, with nothing selected). This was a deliberate,
  explicitly-documented design choice when the Minecraft section was first built (the whole
  `nav-group-minecraft` was gated only by game mode, not by `activeView` the way ARK's own
  `SERVER_SCOPED_VIEWS` already gates its per-server tabs) - revisited now that it's visibly
  inconsistent with ARK's own behavior.
  - **`src/main/lib/webDashboard.ts`**: `updateServerScopedNavVisibility()` (recomputed on
    every nav click, same as ARK's own tabs already were) now also shows/hides
    `navMcConsoleBtn` and the new `mcAdminNavBtns`/`mcModeratorNavBtns` arrays based on
    whether `activeView` is `'console'` or in `MC_SERVER_SCOPED_VIEWS` - replacing the old
    one-time `if (role && !canAdmin) { ... }` hides (which, being one-time, could never
    re-show a button once hidden - now folded into the same per-view/per-role check ARK's
    tabs use). The underlying per-server views were already architecturally ready for this:
    each one (`loadMcStartSettingsView()` etc.) already has its own server picker and a
    "No Minecraft server selected" placeholder, and `selectServer()`/`currentId` were
    already shared across both games - the nav buttons just weren't deferring to any of
    that.
  - **Mobile**: also found and fixed a real (if narrow) gap while reviewing the dashboard's
    existing `@media (max-width: 700px)` block for this - `#token-gate` (the access-token
    login screen, the very first thing a mobile viewer with "Require access token" on would
    see) had a fixed `width: 320px` form plus 28px padding per side, needing 376px to avoid
    overflowing - wider than several real phones (iPhone SE and older/budget Android are
    320-360px). Now `width: auto; max-width: 320px; padding: 20px` on mobile. The rest of
    the dashboard, including every MC view above, turned out to already inherit solid mobile
    behavior for free - they're all built from the same generic classes
    (`.settings-form`/`.settings-grid2`/`.form-actions`/`.data-table`/`.admin-tab-content`/
    `.content-row`/`.server-picker`/etc.) the existing mobile breakpoint already covers, and
    the action-sheet/context-menu popups were already clamped to the viewport. No sweeping
    rewrite needed - the groundwork was already there, just not applied to the Minecraft
    nav tabs or the token gate.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1076 tests, unchanged -
    this is plain client-side JS/CSS embedded in a template string with no dedicated test
    harness, same as the rest of `webDashboard.ts`'s browser-side code), and `npm run build`
    all pass. **Not yet verified**: needs the user to confirm in a real browser that the MC
    nav tabs now stay hidden on "Minecraft Servers" and reappear once a server's Console (or
    one of its own tabs) is open, and that the token gate no longer overflows on a phone.

- **Grouped the desktop Log/Settings sidebar buttons together at the bottom, instead of Log
  sitting up with the main nav and only Settings pinned to the bottom edge** (user request,
  right after the previous "move Settings/Log into a shared sidebar" round). The earlier fix
  had Settings alone carrying `margin-top: auto`, which does push it to the very bottom, but
  left Log up with Dashboard/Cluster Dashboard/Minecraft Servers - visually separated from
  Settings by whatever empty space the sidebar had, rather than sitting directly above it as
  a pair.
  - **`src/renderer/src/styles.css`**: renamed `.app-sidebar-settings` to `.app-sidebar-log`
    and moved the `margin-top: auto`/`border-top` from Settings onto Log instead - the first
    item of a bottom-pinned pair carries the auto-margin, so Log gets pushed down and
    Settings (last in the DOM, no special margin needed) just follows immediately after it.
  - **`src/renderer/src/App.tsx`**: moved the class from the Settings `<button>` to the Log
    `<button>` in both the ARK and Minecraft sidebars (merging it with the existing
    conditional `active` class via a template string, since Log already needed one).
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1076 tests, unchanged),
    and `npm run build` all pass. **Not yet verified**: needs the user to confirm Log now
    sits directly above Settings, both grouped at the sidebar's bottom, in both game modes.

- **Confirmed: "close to tray" (the earlier Settings > Startup & Safety feature) works** -
  the user reported it still quitting the app entirely instead of hiding to the tray even
  after enabling it and confirmed Settings was now reachable (the previous round's fix).
  Added temporary `[DIAG]` logging at both ends of the round trip (what the Settings save
  IPC handler receives/persists/reads back, and what the window's own `close` handler sees
  for `isQuitting`/`closeToTrayEnabled`) to find where the value was getting lost between
  Save and the next close. First confirmed real: a close right after toggling+saving showed
  `closeToTrayEnabled: false` at close time despite having just been saved `true`. Asked the
  user to redo the exact sequence in one continuous session (toggle → Save → close, no
  navigating elsewhere in between) with a fresh `git reset --hard` + full reinstall/rebuild -
  it then worked. No code change happened between the failing and passing attempts (only the
  diagnostic logging), so the earlier failure was most likely a stale build/store from the
  git sync issues earlier in this session (the repeated stray-merge-commit problem) rather
  than an actual bug in the close-to-tray logic itself - removed the logging now that it's
  confirmed working.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1076 tests, unchanged),
    and `npm run build` all pass. The user confirmed live ("c'est fix") that closing the
    window now hides it to the tray as intended.

- **Merged `multi-game-support` into `claude/ark-ascended-server-control-a03zpe`** (the
  default branch) - 105 commits, 210 files, bringing multi-game support, the Discord bot,
  the web dashboard's Minecraft views/mobile work, close-to-tray, and the rest of this
  session's fixes off the feature branch. One conflict (`README.md`, both branches had
  appended their own entries past a shared point) resolved by keeping both histories.
  Verified post-merge: `npm install`, `npm run typecheck`, the full `npx vitest run` (1076
  tests), and `npm run build` all pass clean.

- **Fixed: the Discord bot posted a brand new status message instead of editing the
  existing one, spamming the channel** (user report: "il refait de nouveau message pour
  les status discord au lieu de les éditer de temps en temps"). Root cause:
  `statusRefresh.ts`'s `statusMessage`/`mcStatusMessage` were in-memory only, reset to
  `null` on every bot restart - and the bot restarts far more often than a crash/manual
  restart would suggest, since `discordBot.ts`'s `startDiscordBot` always stops and
  re-spawns it on every single Settings save. On restart, with no memory of the real
  message, it fell back to scanning the channel's last 20 messages for one of the bot's
  own embeds - which silently created a *new* message (instead of finding the real one)
  whenever that search missed: the status embed had scrolled past the last 20 messages
  (other channel activity), or multiple stale candidates from earlier misses confused the
  `.find()`. Each miss both spammed the channel and made the next restart's search even
  more likely to miss again.
  - **`src/bot/statusMessageState.ts`** (new): persists the ARK/Minecraft status message
    ids to `status_messages.json` in the bot's own state dir, mirroring
    `maintenanceState.ts`'s disabled-servers persistence pattern exactly
    (`initStatusMessageState(stateDir)` loads it at startup, `setPersisted*MessageId`
    writes through on every change). `src/bot/index.ts` calls `initStatusMessageState`
    right alongside the existing `initMaintenanceState`.
  - **`src/bot/statusRefresh.ts`**: new `reacquireStatusMessage()` helper tries the exact
    persisted id first via `channel.messages.fetch(id)` - precise, no guessing - and only
    falls back to the old 20-message history scan if there's no persisted id yet
    (upgrading from before this existed) or the persisted message was deleted; whatever it
    finds that way gets persisted too, so the guessing is at most a one-time cost per
    channel from here on. Both `refreshStatusMessage`/`refreshMinecraftStatusMessage` now
    persist the id immediately whenever they create a message, in both the normal "no
    message yet" path and the edit-failed-so-send-a-replacement fallback path.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1082 tests - 6 new ones
    in `tests/discordBotStatusMessageState.test.ts`, following the same
    survives-a-simulated-restart/malformed-file/independent-ids pattern as
    `discordBotMaintenanceState.test.ts`), and `npm run build` all pass. **Not yet
    verified**: `statusRefresh.ts` itself has no test coverage (predates this fix, same gap
    as before - discord.js's Client/TextChannel/Message are heavy to mock) and the user
    hasn't yet confirmed in their real server that a Settings save (which restarts the bot)
    no longer posts a duplicate status message.

- **Added a single-instance lock, after a real report of two instances running at once**
  (Chromium "Unable to move the cache: Accès refusé" / "Gpu Cache Creation failed" errors
  in the log, which turned out to be two Electron processes fighting over the same userData
  folder - confirmed by the user checking Task Manager). "Close to tray" (added earlier this
  session) made this much easier to hit than before: the window hiding instead of quitting
  means a background instance can keep running invisibly, so re-launching (e.g. `npm run
  dev` again, for another round of testing) silently starts a second, fully independent
  instance - including a second Discord bot child process connected to the same token at
  the same time, which could easily reintroduce the duplicate-status-message problem fixed
  above from a completely different angle.
  - **`src/main/index.ts`**: `app.requestSingleInstanceLock()` is checked first, before
    anything else in the file runs - a failed lock means another instance already holds it,
    so this one calls `process.exit(0)` immediately (a hard synchronous exit, not
    `app.quit()`, specifically so none of this file's side effects - adopting persisted
    server processes, starting the web dashboard, spawning the Discord bot - run even once
    in a doomed second instance before a scheduled quit would have taken effect). On the
    surviving first instance, `app.on('second-instance', ...)` now shows/focuses its window
    whenever a second launch is attempted - the same `showAndFocusMainWindow()` helper the
    tray's "Ouvrir"/click handler already used, now shared by both via a new
    `mainWindowRef` instead of each capturing its own closure over the window.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1082 tests, unchanged -
    this is pure Electron app-lifecycle wiring with no isolated unit to test), and
    `npm run build` all pass. **Not yet verified**: needs the user to confirm that launching
    a second instance now just brings the first one's window to the front instead of
    actually starting a second process.

- **Added a server search box to both Dashboards** (user request, after a brainstorm about
  Manager additions - a 13+-server ARK cluster makes finding one specific server by
  scrolling/expanding groups tedious). Matches on name or group, case-insensitively, live as
  you type - no IPC round trip, purely client-side over the profiles already in memory.
  - **`src/renderer/src/pages/Dashboard.tsx`** and **`MinecraftDashboard.tsx`** (identical
    treatment in both, matching their already-identical group/search-adjacent structure):
    new `searchQuery` state and a `matchesSearch(profile)` helper (name-or-group substring
    match, always `true` when the box is empty so normal browsing is untouched). Applied to
    the ungrouped grid, each group's grid, and the hidden-servers grid. A group with zero
    matches isn't rendered at all while searching (instead of showing an empty summary), and
    any group that does match is forced `open` regardless of its own collapsed state - a
    match sitting inside a collapsed group would otherwise be invisible, the opposite of
    what a search is for. A dedicated empty state ("No server matches ...") covers the
    all-groups-filtered-out case, distinct from the existing "no profiles yet"/"everything's
    hidden" messages.
  - **`src/renderer/src/styles.css`**: new `.dashboard-search` input, sized to grow between
    the page title and the action buttons (`flex: 1 1 auto` with a sensible min/max width)
    rather than defaulting to a cramped intrinsic width; `.dashboard-header` and
    `.dashboard-header-actions` picked up the small adjustments (`gap`, `flex-shrink: 0`)
    needed to fit a third flex child cleanly.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1082 tests, unchanged -
    this is renderer-only UI filtering with no isolated unit to test, same gap as the rest
    of these two components), and `npm run build` all pass. **Not yet verified**: needs the
    user to confirm the search box behaves correctly on their real cluster (filters as
    expected, auto-expands matching groups, clears back to normal when emptied) in both ARK
    and Minecraft mode.

- **Added cluster backup export/import** (first of a batch the user approved after a
  "compare with AMP/Pterodactyl/Nitrado-style panels" brainstorm). Bundles every ARK and
  Minecraft profile plus the Manager's own Settings into a single JSON file - for migrating
  to another machine or just keeping a full snapshot, rather than exporting profiles one at
  a time (the existing per-profile export/import this reuses the migration/rename logic
  from). Only the Manager's own configuration travels, not the actual server files (an
  imported profile's `installDir` still points wherever it lived when exported).
  - **`shared/types.ts`**: new `ClusterBundle` (`version`, `exportedAt`, `profiles`,
    `minecraftProfiles`, `settings`) and `ClusterImportResult` types; `IPC.clusterExport`/
    `clusterImport` and `dialogSaveClusterBundleFile`/`dialogSelectClusterBundleFile`
    channels; `Api.cluster`/`Api.dialog`'s two new methods.
  - **`src/main/lib/clusterExport.ts`** (new): `serializeClusterBundle()` gathers
    `listProfiles()`/`listMinecraftProfiles()`/`getSettings()` into one pretty-printed JSON
    blob. `parseClusterBundle(fileContent, existingNames, existingMinecraftNames)` validates
    the shape, then runs each profile through the exact same per-profile treatment
    `profileExport.ts`'s `parseImportedProfile` already does (its own `migrateProfile`/
    `migrateMinecraftProfile`, a fresh `randomUUID()`, and `uniqueProfileName` against a
    running set that grows as it goes - so two colliding imported profiles both get
    suffixed, not just the one colliding with something already there) - ARK and Minecraft
    name collisions are tracked completely independently, matching how the two games never
    share a name-uniqueness pool anywhere else in the app either. Settings pass through
    unvalidated; the caller decides whether to actually apply them.
  - **`src/main/ipc/cluster.ts`** (new): `clusterExport` just writes the serialized bundle
    to the chosen path. `clusterImport` parses it, `saveProfile`/`saveMinecraftProfile`s
    every profile in it (plus `applyBackupSchedule`/`applyScheduledRestart`/
    `applyScheduledDinoWipe` per ARK profile and the Minecraft equivalents - the same
    side-effects `profilesImportFromFile`/`minecraftProfilesSave` already apply to a single
    imported/saved profile), and only touches Settings (`saveSettings` + the same
    `applyWebDashboardSettings`/`applyDiscordBotSettings`/`applyLaunchOnStartup`/
    `applyIniLockSetting` calls `settings.ts`'s own save handler makes) when the caller
    opted in via `includeSettings`.
  - **`src/main/ipc/dialog.ts`**: two new dialogs (`Export cluster backup` with a dated
    default filename `bober-cluster-backup-YYYY-MM-DD.json`, `Import cluster backup`),
    both refocusing the window afterward like every other dialog here already does.
  - **`src/renderer/src/pages/DataSettingsView.tsx`**: new "Cluster Backup" section (General
    tab, right after "Server profiles") - Export/Import buttons, a checkbox ("Also replace
    my current Settings with the ones from the backup", unchecked by default - profiles
    always import, but overwriting live settings like the Discord bot token or web
    dashboard port is opt-in and `confirmAction`-gated), and a status/error line. Doesn't
    need to manually refresh `App.tsx`'s profile lists after an import - `saveProfile`/
    `saveMinecraftProfile`'s existing `profileEvents`/`minecraftProfileEvents` broadcast
    (built for the web dashboard's HTTP API edits to show up live in this window) already
    covers it for free.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1091 tests - 9 new ones in
    `tests/clusterExport.test.ts` covering invalid JSON/wrong shape, migration + fresh ids,
    independent ARK/Minecraft name-collision handling including two colliding imports
    against each other not just an existing name, settings passed through unchanged, and the
    exportedAt fallback), and `npm run build` all pass. **Not yet verified**: needs the user
    to confirm a real export/import round trip (profiles show up correctly, no accidental
    collisions, Settings only change when the checkbox was on).

- **Added a Discord chat bridge, plus a tame/tamed-dino-death/mission admin events channel**
  (user-suggested feature, after being asked for ideas - "ça serait cool de faire la même
  fonction pour les tame, mort, mission dans un channel admin"; "un salon par cluster" when
  asked whether to scope channels per-server or globally). Two independent, opt-in channel ids
  on each ARK profile, under Settings' Cluster section: a Chat Channel (relays this server's
  in-game chat to Discord and back) and an Events Channel (posts TAME, a tamed dino's death,
  and MISSION log lines). Deliberately per-*profile* fields, not a new cluster entity - same
  convention this app already uses for clusterId/clusterDirOverride, where every server in a
  cluster is expected to carry the same value rather than there being one normalized "cluster"
  record anywhere. Setting the same channel id on every profile in a cluster is what makes it
  "one salon par cluster" in practice.
  - **`shared/types.ts`**: new `ServerProfile.discordChatChannelId`/`discordEventsChannelId`
    (both default `''`, meaning off). Migration backfill.
  - **`src/renderer/src/pages/ServerDetail/SettingsTab.tsx`** + **`webDashboard.ts`**'s own
    mirrored Settings form: two new inputs in the Cluster card on both surfaces, not gated by
    "Enable cluster" (a standalone, non-clustered server can use either feature too).
  - **`shared/discordBot.ts`**: `ManagerServerInfo` gains the same two optional fields;
    **`webDashboard.ts`**'s `GET /api/servers` ARK mapping populates them from the profile, so
    the bot's own periodic server-cache poll (already happening for the status embeds) picks
    them up for free - no new IPC or polling needed.
  - **`src/main/lib/discordChatBridgeWatch.ts`** (new) - the outbound half (game -> Discord).
    Same per-server start/stop-on-status-event shape as `playerJoinAlertWatch.ts`, tailing
    `ShooterGame.log` via the same `watchLogFile`/`parseLogChunk` primitives
    `groupConsole.ts`'s Cluster Data console already uses - CHAT lines go to
    `discordChatChannelId`; TAME and MISSION lines go to `discordEventsChannelId`; a KILL line
    only goes there when `isTamedDinoKillEvent` recognizes it as a *tamed* dino's death (" -
    Lvl <n>" in the text, ARK's own tamed-dino naming convention) rather than one of the
    hundreds of wild-vs-wild deaths an active server logs per day - the specific filter the
    user asked for after being warned how noisy the unfiltered version would be. A no-op
    (costs nothing) for any profile with neither channel id set.
  - **`src/main/lib/discordBot.ts`**: new `notifyGameEvent(channelId, kind, text)`, same fork-
    IPC-message shape as the existing `notifyPlayerJoin` (a log line can happen at any moment,
    so this bypasses the config file the bot only reads once at its own startup).
  - **`src/bot/index.ts`**: handles the new `'gameEvent'` message type, posting to whichever
    channel id it names (💀/🦖/🎯 prefix per kind, 'chat' posted as-is for a plain bridge
    look). The inbound half (Discord -> game) is a new `Events.MessageCreate` listener:
    ignores the bot's own messages, matches the message's channel id against every ARK
    server's cached `discordChatChannelId` (`serversForChatChannel`, `serverCache.ts` - can
    match more than one profile at once, the whole point of sharing one channel across a
    cluster), and relays via RCON `ServerChat <DiscordName> (Discord) - <message>` through the
    same Manager API passthrough `/adminchat` already uses. **Requires enabling "Message
    Content Intent" for this bot application in the Discord Developer Portal** (Bot page,
    Privileged Gateway Intents) - without it, Discord delivers every guild message with
    `.content` blanked out and the bridge silently relays nothing. The bot's own intents list
    grew from Guilds-only to include GuildMessages + MessageContent to support this; it still
    never reads member lists or anything beyond messages in channels it's already in.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1243 tests - 8 new ones in
    `tests/discordChatBridgeWatch.test.ts` for `isTamedDinoKillEvent` and `routeGameEvent`'s
    label-by-label routing including the wild-vs-tamed KILL split, 1 new one in
    `tests/discordBotServerCache.test.ts` for `serversForChatChannel` matching several ARK
    servers sharing one channel id while ignoring Minecraft entries and other channels), and
    `npm run build` (including the bot's own bundle) all pass. **Not yet verified**: needs the
    user to actually enable the Message Content privileged intent in the Developer Portal and
    confirm a real two-way chat round trip and real tame/kill/mission posts.

- **Added a live per-server player roster with Kick/Ban/Whitelist, plus a tracking-only
  whitelist** (user-suggested feature, after being asked for ideas - "on peut faire en sorte
  que ça affiche par serveur et qu'on peut kick/ban/ajout whitelist depuis ce menu"). The
  Players screen's existing Bans/Activity tabs only ever showed the Manager's own merged,
  persisted records - neither fetched who's actually connected right now, and there was no
  way to kick a player from the desktop app at all (the web dashboard already had Kick/Ban via
  a right-click menu on its own live `/api/servers/:id/players` route - this ports that same
  idea to the desktop app's own screen, as inline row buttons instead of a context menu).
  Whitelist is new entirely - deliberately tracking-only (a shared note of known/trusted
  players), not an actual join restriction; ARK does have a real one (`-exclusivejoin` + a
  `PlayersExclusiveJoinList.txt` file) but that's a bigger, separate feature this doesn't
  attempt.
  - **`shared/types.ts`**: new `WhitelistedPlayer` (`id`, `name`, `addedAt`, `profileIds[]` -
    same merge-across-servers shape as `BannedPlayer`, minus `reason`) and `PlayerRosterEntry`
    (`id`, `name` - one row of a live `ListPlayers` result). New IPC channels
    `player-whitelist:list/add/remove` and `player-roster:list/kick`, plus matching
    `Api.playerWhitelist`/`Api.playerRoster` blocks.
  - **`src/main/store.ts`**: new `playerWhitelist: WhitelistedPlayer[]` store key and
    `listWhitelistedPlayers`/`recordWhitelistedPlayer`/`removeWhitelistedPlayerProfile` -
    identical upsert-across-servers/drop-when-empty shape as the existing ban-list functions.
  - **`src/main/ipc/playerWhitelist.ts`** (new): thin IPC wrapper around the store functions
    above - no RCON call at all, unlike `playerBans.ts`'s `BanPlayer`/`UnbanPlayer`.
  - **`src/main/ipc/playerRoster.ts`** (new): `list(profileId)` sends RCON `ListPlayers` and
    parses it via the existing `parsePlayerListWithIds` (already built for the web dashboard's
    own Kick action); `kick(profileId, playerId)` sends RCON `KickPlayer <id>` - nothing
    persisted, the player can simply reconnect.
  - **`src/renderer/src/pages/PlayerRosterPanel.tsx`** (new): a per-server picker plus the
    live roster table, refreshed on a 15s timer while open, with Kick/Ban/Whitelist buttons on
    each row.
  - **`src/renderer/src/pages/PlayerWhitelistPanel.tsx`** (new): the persisted whitelist's own
    view/manage screen - same manual add-by-id form + grouped server picker + "currently
    whitelisted" table layout as `PlayerBansPanel.tsx`, minus the `reason` field and the RCON
    call.
  - **`PlayersView.tsx`**: two new sidebar entries, "Live Players" (now the default tab) and
    "Whitelist", alongside the existing Bans/Activity.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1234 tests - 4 new ones in
    `tests/store.test.ts` for the whitelist store functions, mirroring the existing ban-list
    ones), and `npm run build` all pass. **Not yet verified**: needs the user to confirm Kick/
    Ban/Whitelist actually work against a real running server from the new Live Players tab.

- **Correction to the two beta-branch fixes below: `-beta none` isn't actually the right value
  - it's `-beta public`** (user pushback: "il est pas censé avoir de -beta si on veut revenir
  aux update normale" - prompted checking the actual SteamCMD convention instead of assuming).
  `none` shows up in some older community guides for switching off a beta, but isn't a
  documented branch name the way `public` is - this app's own `updateCheck.ts` already reads
  `"public"` as the literal branch key out of SteamCMD's `app_info_print` output
  (`branches { public { buildid ... } }`), which is the authoritative source for what Valve
  actually calls the default branch, not a guess. Omitting `-beta` entirely remains wrong for
  the same reason as before (see the entry below) - this only corrects *which* value an
  explicit `-beta` should carry when no specific beta is wanted.
  - **`src/main/lib/steamcmd.ts`**: `buildUpdateArgs` now passes `-beta public` (via a new
    `PUBLIC_BRANCH` constant) instead of `-beta none` when the profile's beta toggle is off.
    `clearMismatchedBetaManifest`'s own comparison logic needed no change - it already worked
    in terms of the manifest's own `BetaKey` being empty/absent for "on the public branch",
    never by comparing against the literal string passed on the command line.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1232 tests -
    `tests/steamcmd.test.ts`'s `buildUpdateArgs` suite updated to assert `-beta public`), and
    `npm run build` all pass. **Not yet verified**: needs the user to confirm a real update
    with beta off actually lands on the true public build.

- **The `-beta none` fix below wasn't enough on its own - found the actual reason it kept
  sticking** (user report, right after the fix below shipped: "quand j'update le serveur ça
  revient pas à la version précédente", then "ça revient à une version très ultérieur" - a
  server updating back onto a *later* build than its own public one is exactly what landing on
  a beta looks like, since beta branches normally run ahead of the public one). Passing
  `-beta none` on the command line turned out not to be reliable by itself: SteamCMD can keep
  honoring whatever beta is already recorded in the install's own `appmanifest_<id>.acf`
  (`UserConfig.BetaKey`) instead of actually switching away from it, regardless of what
  `-beta` says on that run's command line.
  - **`src/main/lib/steamcmd.ts`**: new `readManifestBetaKey(manifestContent)` (parses
    `UserConfig.BetaKey`, trimmed, `''` if absent/blank) and `clearMismatchedBetaManifest`,
    called right alongside the existing `clearStuckManifest` at the start of every update
    attempt - compares the manifest's own recorded `BetaKey` against what this update is about
    to request and, only on a mismatch, deletes the manifest outright so the upcoming
    `validate` does a full clean resync against the actually-requested branch and writes a
    fresh manifest with no stale `BetaKey`. A one-time cost only when the beta selection is
    actually changing (off → on, on → a different name, or on → off) - an ordinary update
    whose manifest already agrees with the profile's current beta setting is untouched, same
    as before.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1232 tests - 3 new ones in
    `tests/steamcmd.test.ts` for `readManifestBetaKey` itself, and 4 new ones in
    `tests/steamcmdRetry.test.ts`'s real `updateServer` + mocked-`spawn` harness - confirming
    the manifest is actually deleted on disk when its `BetaKey` doesn't match what the profile
    now wants, in both directions (a stale beta vs. none wanted, and switching between two
    different betas), and left alone when it already agrees), and `npm run build` all pass.
    **Not yet verified**: needs the user to confirm a real update on an affected profile
    actually lands back on the real public build this time, not just an immediate re-run of
    the same (now manifest-less) update.

- **Fixed: every server update was silently running on a beta branch, crashing servers whose
  mods weren't available on it** (user report: "l'update des serveurs sont tous avec la beta
  activé alors qu'elle n'est pas activé pour ces profils", followed by "les serveurs crash car
  les mods ne sont pas dispo"). `buildUpdateArgs` (`steamcmd.ts`) only ever added `-beta <name>`
  when a profile's own `steamBetaEnabled` was on, and simply *omitted* the flag otherwise -
  which turned out not to mean "use the public branch". Every profile updates through the same
  single, shared, anonymously-logged-in SteamCMD installation (one global `steamCmdPath`
  setting, not one per server) - and SteamCMD/Steam remembers the last beta selected for a
  given app under that login. Once *any* profile had ever updated with a beta enabled, that
  selection stuck for that app across *every other profile's* updates too, since none of them
  ever explicitly said otherwise - "not passing `-beta`" is not the same thing to SteamCMD as
  "clear whatever beta was selected before".
  - **`src/main/lib/steamcmd.ts`**: `buildUpdateArgs` now always passes an explicit `-beta`,
    with `none` when the profile isn't opted into one, instead of omitting the flag - the only
    way to actually force SteamCMD back to the public branch rather than hoping it already was
    there.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1225 tests -
    `tests/steamcmd.test.ts`'s `buildUpdateArgs` suite updated to assert the explicit
    `-beta none` instead of its absence), and `npm run build` all pass. **Not yet verified**:
    needs the user to confirm a real update on a non-beta profile stays on the public branch
    now, including one that follows a profile that had beta enabled.

- **Fixed, again: the Discord bot abandoned its status message and started posting new ones**
  (user report with full logs - a run of `Connect Timeout Error`s around 06:53-06:57 right
  before `mcStatusChannelId`/`statusChannelId` edits, matching a gap where the user found an
  orphaned old message and a new one in its place). A *different* root cause from the earlier
  "Discord bot posted a brand new status message instead of editing" fix above (that one was
  AWS's malformed JSON response breaking the server-status fetch itself) - this one was in
  `refreshStatusMessage`/`refreshMinecraftStatusMessage`'s own error handling:
  `statusMessage.edit(...)` failing for *any* reason - including a plain transient network
  timeout, Discord having a bad moment, anything - fell back to `channel.send(...)`, creating
  and persisting a brand new message every time, regardless of whether the old one was still
  perfectly fine. During a multi-minute run of timeouts, every refresh cycle's failed edit
  silently abandoned whatever message was being edited and started a fresh one, orphaning the
  one before it.
  - **`src/bot/statusRefresh.ts`**: new `isUnknownMessageError(err)` - true only for a real
    Discord `DiscordAPIError` with `RESTJSONErrorCodes.UnknownMessage` (10008, the message was
    actually deleted or the channel/guild no longer has it). Both refresh functions' catch
    blocks now only fall back to `channel.send(...)` when this is true; any other failure
    (the transient case this bug was actually about) just logs a "will retry next refresh"
    warning and leaves the in-memory `statusMessage`/`mcStatusMessage` untouched, so the next
    scheduled refresh retries `.edit()` against the exact same message instead of starting a
    new one.
  - **`src/main/lib/serverProcess.ts`**: unrelated to the bug above, but visible in the same
    log dump - a `MaxListenersExceededWarning: 11 status listeners added` on `serverEvents`.
    Not an actual leak (every permanent listener - crashWatch, iniLock,
    serverVersionWatcher, playerJoinAlertWatch, playerActivityWatch, zombieDetection,
    playerBackupWatch, the backup schedule, the IPC status broadcast - is added exactly once
    at startup, not accumulated over time), just more independent features sharing one
    `EventEmitter` than Node's conservative default of 10 - `serverEvents.setMaxListeners(30)`
    silences the spurious warning.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1225 tests - 4 new ones in
    `tests/statusRefresh.test.ts` for `isUnknownMessageError` against a real constructed
    `DiscordAPIError` for both the Unknown Message and a different code, a plain transient
    `Error` that isn't a `DiscordAPIError` at all, and non-Error values), and `npm run build`
    (including the bot's own bundle) all pass. **Not yet verified**: needs the user to confirm
    a real network blip during a status refresh no longer orphans the existing message.

- **Added an "only if a server update is available" condition to the scheduled restart**
  (user request - "add a scheduled restart with the condition that there's an update
  available, at a configured time"). A third opt-in condition alongside the existing "only if
  no players are connected" one, on the same Restart schedule (Server Management tab) rather
  than a separate mechanism - when checked, a restart that comes due with nothing new to
  install is skipped entirely for that occurrence (no stop/update/start at all) and simply
  tried again at the schedule's next occurrence, the same way the player-count condition
  already behaves. ARK: Survival Ascended only - the only game `GameDefinition.
  supportsUpdateCheck` is true for; the checkbox itself is hidden for ARK: Survival Evolved
  rather than shown and silently never firing.
  - **`shared/types.ts`**: new `ServerProfile.scheduledRestartOnlyIfUpdateAvailable: boolean`,
    right next to `scheduledRestartOnlyIfEmpty` which it joins (both can be on at once - the
    restart only runs once every enabled condition passes).
  - **`src/main/lib/profileMigration.ts`**: backfills it to `false` for existing profiles.
  - **`src/main/lib/updateCheck.ts`**: new `isUpdateAvailable(installedBuildId, latestBuildId)`
    - the same comparison `UpdateCheckPanel.tsx` already does in the renderer for the
    Analytics tab's "New update" status, pulled out as its own pure function so it's testable
    without a real SteamCMD poll - and `isUpdateAvailableForProfile(profile)`, which wires it
    up to a profile's own cached latest build id (`getLatestBuildIdCache`) and installed build
    id (`getInstalledBuildId`, steamcmd.ts), short-circuiting to `false` before ever touching
    disk when nothing's been polled yet or the game doesn't support update checking at all.
    "Unknown" deliberately means "don't restart" here (unlike `scheduledRestartOnlyIfEmpty`,
    there's no live question this can ask the server the way RCON `ListPlayers` can) - a false
    positive restart is the one outcome that can't just be fixed by waiting for the next
    occurrence.
  - **`src/main/lib/scheduledActions.ts`**: `runScheduledRestart` checks
    `isUpdateAvailableForProfile(profile)` right after the existing "only if empty" guard
    (before doing anything at all) when the new flag is on, logging why and returning early
    exactly like that guard does.
  - **`src/renderer/src/pages/ServerDetail/ServerManagementTab.tsx`**: new checkbox next to
    "Only if no players are connected" inside the Restart `ScheduleDaysPicker`, gated behind
    `getGameDefinition(profile.game).supportsUpdateCheck`.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1221 tests - 5 new ones in
    `tests/updateCheck.test.ts` for `isUpdateAvailable`'s four known/unknown combinations plus
    `isUpdateAvailableForProfile`'s game-support and fresh-cache short-circuits; 4 new ones in
    `tests/scheduledActions.test.ts` covering skip-when-unavailable, restart-when-available,
    never-checking-when-the-flag-is-off, and combining with `scheduledRestartOnlyIfEmpty`; 1
    new one in `tests/profileMigration.test.ts` for the backfill), and `npm run build` all
    pass. **Not yet verified**: needs the user to confirm a real scheduled restart actually
    skips with no update pending and fires once SteamCMD's public branch build id actually
    changes.

- **Added Notepad++-style syntax coloring to both editors, and opened them up to `.json` and
  `.log` files** (user feedback on the file browser port below - "add Notepad++'s color
  codes" and "make it so .json and .log files can be opened too").
  - **`shared/syntaxHighlight.ts`** (new): pure, per-line tokenizer - `languageForPath(path)`
    picks `ini`/`json`/`log`/`plain` from the extension, `tokenizeLine(line, language)` splits
    one line into `{text, type}` tokens (`section`/`comment`/`key`/`punctuation`/`string`/
    `number`/`boolean`/`timestamp`/`error`/`warn`/`info`/`plain`). Regex-based, not a real
    parser - deliberately tolerant of invalid/in-progress JSON (a stray mid-edit syntax error
    must not break the coloring) and cheap enough to re-run on every keystroke. The JSON
    string pattern doesn't special-case an escaped quote inside a string value, a deliberate
    simplification covered in its own doc comment.
  - **`src/main/lib/fileBrowser.ts`**: `isIniPath` split into `isIniPath`/`isJsonPath`/
    `isLogPath`, plus `isEditableTextPath` (`.ini`+`.json`, gates saving) and
    `isOpenableTextPath` (+`.log`, gates opening). `.log` is deliberately read-only - a
    running server may still be appending to the same file, and saving stale editor content
    back over it would silently erase whatever it wrote in the meantime.
  - **Both editors** (`FilesTab.tsx` on desktop, the web dashboard's own client script): the
    single `<textarea>` now sits on top of a same-sized, identically-styled `<pre>` that
    renders the colored tokens behind it - the textarea's own text is transparent (only the
    caret/selection show) so the colors show through while the textarea stays fully editable;
    both layers share the same font/padding/wrapping so they stay pixel-aligned as the user
    types, and their scroll position is kept in sync the same way the line-number gutter's
    already was. Opening a `.log` file hides the Save button and History section and makes the
    textarea read-only, instead of letting a save silently fail against the backend's new
    `.log` rejection.
  - **The web dashboard's client script needed its own hand-written copy** of the tokenizer
    (same algorithm, plain JS instead of a TS import) since that whole script is a
    string literal served as-is, not bundled code - and writing it exposed a sharper version
    of the escaping hazard the previous entry's `\n`-in-gutter bug already surfaced: *any*
    single backslash followed by a letter inside this file's enclosing template literal gets
    consumed by that literal's own escape processing, not just the "obviously special" ones
    like `\n` - `\d`, `\s`, and even `\]` inside a character class all silently lose their
    backslash too (turning `\d+` into a literal `d+`, `[{}[\],:]` into a corrupted character
    class) unless doubled to `\\d`, `\\s`, `\\]`. `node --check` happily accepts the corrupted
    version since the result is still syntactically valid JS, just semantically wrong - it was
    actually caught by a new test (see below) that runs the real served tokenizer and compares
    its output to `shared/syntaxHighlight.ts`'s, not by the syntax check.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1209 tests - 15 new ones in
    `tests/syntaxHighlight.test.ts` for the tokenizer itself; new/updated cases in
    `tests/fileBrowser.test.ts` and `tests/webDashboard.test.ts` for the widened `.ini`/
    `.json`/`.log` gating; one new `tests/webDashboard.test.ts` test that extracts the web
    dashboard's served tokenizer function and actually runs it in a fresh Node process against
    the same cases as `tests/syntaxHighlight.test.ts`, to catch the two drifting apart - this
    is the test that caught the `\d`/`\]` escaping bugs above before they shipped), and `npm
    run build` all pass, including the standing `node --check` regression test against the
    dashboard's served `<script>` content. **Not yet verified**: needs the user to confirm the
    colors and the `.json`/`.log` opening work correctly in a real browser/`npm run dev`.

- **Ported the file browser to the desktop Manager and gave both editors a Notepad++-style
  multi-tab layout** (user feedback on the batch above - "add the File Browser to the
  Manager too", plus "make the editing zone bigger and screen-responsive, with a button to
  go back to the previous file" and "take inspiration from Notepad++'s UI").
  - **`src/main/lib/fileBrowser.ts`** (new): the file-browser/`.ini`-editor/history logic that
    used to live inline in `webDashboard.ts`'s route handlers (`listFileBrowserEntries`,
    `resolveFileBrowserPath`, `deleteFileBrowserFile`, `readIniFile`, `writeIniFile`,
    `listIniHistory`, `diffIniHistoryEntry`, `restoreIniHistoryEntry`) extracted into a shared
    module with no HTTP-specific code, so the desktop app and the web dashboard call the exact
    same functions instead of risking two implementations quietly disagreeing on what's safe
    to read/write/delete. `webDashboard.ts`'s 7 file-browser/ini routes now call into it
    instead of containing the logic themselves; `sendFileDownload` stayed behind since it's
    HTTP-response-specific.
  - **`shared/types.ts`**: `FileBrowserEntry`/`FileBrowserListing`/`ConfigFileHistorySummary`
    types, plus 8 new IPC channels and an `Api.fileBrowser` bridge interface (`list`, `open`,
    `delete`, `readIni`, `writeIni`, `iniHistory`, `iniHistoryDiff`, `iniRestore`).
  - **`src/main/ipc/fileBrowser.ts`** (new) + **`src/preload/index.ts`**: desktop IPC handlers
    wrapping the shared `fileBrowser.ts` functions, resolving each profile's `installDir`
    first. `open` uses Electron's `shell.openPath` - the desktop equivalent of the web
    dashboard's Download link, since there's no browser to download through and the file is
    already on disk.
  - **`src/renderer/src/pages/ServerDetail/FilesTab.tsx`** (new) + a new "Files" tab in
    `ServerDetail/index.tsx`: the desktop mirror of the web dashboard's own Files tab - browse
    the install directory, open/delete files, and edit `.ini` files, with the same
    History/diff/restore the web version has.
  - **Notepad++-style multi-tab editor, on both the desktop Manager and the web dashboard**:
    several `.ini` files can now be open at once, each its own tab with a dirty indicator
    (`•`) and a close (`×`) button, plus a persistent "📁 Files" tab to get back to the folder
    view without losing the other open tabs - replacing the old single-file editor that had no
    way back to a previously opened file short of re-browsing to it. Both editors also gained a
    line-number gutter (a plain scroll-synced `<div>`, not a full code-editor dependency, to
    avoid the cursor/IME risk a contenteditable-based approach could introduce) and a taller,
    viewport-relative editing area (`height: 55-60vh`) instead of a small fixed-height
    textarea.
  - Fixed a pre-existing gap found while styling the new desktop Files tab: `.data-table` -
    used by the already-shipped Player Bans/Activity tables - had never actually been defined
    in the desktop renderer's `styles.css`, only in the web dashboard's own embedded
    stylesheet, so those two tables had been rendering completely unstyled in the desktop app.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1187 tests - 16 new ones in
    `tests/fileBrowser.test.ts` for the extracted module, covering listing, path-traversal
    rejection, delete-refuses-folders, read/write with history snapshotting including a
    brand-new file with nothing to snapshot yet, non-.ini rejection on both read and write,
    diffing and restoring a history entry, and a 404-equivalent for a bogus or cross-profile
    entry id), and `npm run build` all pass, including the standing `node --check` regression
    test against the web dashboard's served `<script>` content - which caught a real bug
    during this change: a literal `\n` typed in the TypeScript source for the new gutter
    renderer was being consumed by the enclosing template literal's own escape processing
    before ever reaching the served JS, so it had to be written as `\\n` to survive as a
    literal newline escape in the output. **Not yet verified**: needs the user to confirm the
    desktop Files tab and both tabbed editors work correctly in `npm run dev`.

- **Merged the Players screens, redesigned the ban picker, and overhauled the RCON
  scheduler's trigger** (user feedback on the batch above, after seeing it in `npm run dev` -
  not part of the original approved list, three related UI requests addressed together).
  - **Merged "Player Bans" + "Player Activity" into one "Players" screen.** They were two
    separate top-level buttons/screens; now one "Players" button opens a screen with its own
    small left sidebar (Bans/Activity) to switch between them, since both are ARK-only and
    both operate on the same profile list.
    - **`src/renderer/src/pages/PlayerBansView.tsx`** / **`PlayerActivityView.tsx`**: deleted,
      replaced by **`PlayerBansPanel.tsx`** / **`PlayerActivityPanel.tsx`** - the same content,
      minus the `onBack`/header wrapper (now owned by the container below) and minus the
      `onBack` prop entirely.
    - **`src/renderer/src/pages/PlayersView.tsx`** (new): the container - header with Back,
      then a `.players-view-body` flex row (`.players-view-sidebar` + `.players-view-content`)
      switching between the two panels via local `useState`, not a route/top-level screen each.
    - **`src/renderer/src/App.tsx`** / **`Dashboard.tsx`**: `showPlayerBans`/
      `showPlayerActivity` collapsed into one `showPlayers` state; the Dashboard header's two
      buttons collapsed into one "Players" button.
    - **`src/renderer/src/styles.css`**: new `.players-view-body`/`.players-view-sidebar`/
      `.players-view-content` rules - deliberately not a reuse of `.app-shell`/`.app-sidebar`
      (those set `min-height: 100vh`, which would fight this nested view's own header above it
      for vertical space), but visually matching `.app-sidebar`'s own button styling.
  - **Redesigned the ban picker** (inside `PlayerBansPanel.tsx`). The server picker used to be
    one long scrollable checkbox list; it's now columns of checkboxes grouped by each server's
    Dashboard group (ungrouped servers get their own first column), same ungrouped-then-
    alphabetical ordering `Dashboard.tsx`'s own server grid already uses, plus an "All"/
    "Deselect all" toggle button and a "`N` of `M` selected" counter. New
    `.ban-picker-columns`/`.ban-picker-column`/`.ban-picker-option` CSS rules (flex-wrap row of
    columns, each a vertical list).
  - **Overhauled the Scheduled RCON Commands trigger** (MCSS-inspired, adapted to ARK - kept
    to enriching each entry's own trigger rather than rebuilding the whole feature as a
    multi-job task system; Restart/Dino Wipe/Maintenance stay as they are). Each entry now
    picks one of three trigger types instead of always being a day/time schedule, plus a
    player-presence condition and a manual trigger:
    - **`shared/types.ts`**: new `ScheduledRconTriggerType` (`'fixedTime' | 'interval' |
      'timeless'`) and `ScheduledRconPlayerRequirement` (`'always' | 'onlyIfEmpty' |
      'onlyIfPlayers'`) - the latter generalizes `scheduledRestartOnlyIfEmpty`'s own idea to a
      three-way condition instead of a single boolean. `ScheduledRconCommand` gains
      `triggerType`, `intervalSeconds` (used only when `triggerType` is `'interval'`), and
      `playerRequirement`; `time`/`days` are now used only when `triggerType` is `'fixedTime'`.
    - **`src/main/lib/profileMigration.ts`**: new `migrateScheduledRconCommand()` backfills
      every existing entry to `triggerType: 'fixedTime'`, `intervalSeconds: 60`,
      `playerRequirement: 'always'` - `'fixedTime'`/`'always'` is exactly what every entry
      already did, so this migration never changes any existing entry's actual behavior.
    - **`src/main/lib/scheduledActions.ts`**: `applyScheduledRconCommands` now branches on
      `triggerType` - `'fixedTime'` keeps the existing `node-cron` mechanism; `'interval'` uses
      a plain `setInterval(fn, intervalSeconds * 1000)` (a new `rconIntervalTasks` map,
      parallel to the existing `rconCommandTasks` cron map - `clearScheduledRconCommands` now
      clears both) that keeps firing for as long as the server's running, not a one-shot delay
      after start; `'timeless'` schedules nothing at all. A new shared
      `fireScheduledRconCommand(profile, entry)` (used by both trigger kinds) checks
      `isRunning` then `playerRequirementSatisfied` (`'always'` skips the check entirely;
      `'onlyIfEmpty'`/`'onlyIfPlayers'` call the same `listPlayers` the conditional restart
      already uses) before actually sending the command.
    - **`src/renderer/src/pages/ServerDetail/ServerManagementTab.tsx`**: "Scheduled RCON
      Commands" moved out of the "Advanced Schedule" card into its own top-level
      `.schedule-section` (its "own block", separate from Restart/Dino Wipe/Maintenance). Each
      entry now shows three `.rcon-trigger-card` buttons (Fixed Time/Interval/Timeless,
      MCSS-style) that swap in the relevant sub-fields below them (the existing
      `ScheduleDaysPicker` for Fixed Time; an Enabled checkbox + "Every (seconds)" number input
      for Interval; just an Enabled checkbox for Timeless, which has nothing else to configure),
      a `playerRequirement` `<select>`, and a "Run now" button. "Run now" calls the existing
      `window.api.groupConsole.sendRcon(profileId, command)` directly - deliberately bypassing
      `playerRequirement` entirely (clicking it is already the user choosing to run it right
      now, not waiting for the trigger's own condition) and is the only way a `'timeless'`
      entry ever actually fires.
    - **`src/renderer/src/styles.css`**: new `.rcon-entry`/`.rcon-trigger-cards`/
      `.rcon-trigger-card` rules for the three-card trigger picker.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1171 tests - 16 in
    `tests/scheduledRconCommands.test.ts` now split across fixedTime/timeless/interval
    describe blocks, covering the three player-requirement outcomes, interval firing
    repeatedly under fake timers and stopping on `clearScheduledRconCommands`, and a timeless
    entry never scheduling anything; 2 new ones in `tests/profileMigration.test.ts` for the
    per-entry backfill and its no-op on an already-current entry), and `npm run build` all
    pass. **Not yet verified**: needs the user to confirm the merged Players screen, the
    grouped ban picker, and all three RCON trigger types (including a real "Run now" and a
    real Interval firing repeatedly) work correctly in `npm run dev`.

- **Added config file edit history and diff** (third and last of the "Fichiers & config"
  category, and the last item of the entire user-approved batch - "compare with AMP/
  Pterodactyl/Nitrado-style panels" brainstorm → Fichiers & Config/Planification/Divers/
  Joueurs approved → all 11 items now shipped). Every save made through the raw .ini editor
  above now keeps the version it's about to overwrite, so nothing typed into that textarea is
  ever truly gone - a "History" list under the editor shows each past save with a diff
  against the current file and a one-click restore. Scoped deliberately to the editor's own
  saves only (not every .ini write anywhere in the app) - see `ConfigFileHistoryEntry`'s own
  doc comment for why that's the coherent boundary, not a gap.
  - **`shared/textDiff.ts`** (new): pure `computeLineDiff(oldText, newText)` - classic LCS
    (longest-common-subsequence) dynamic-programming line diff, correct for an inserted or
    deleted line shifting everything below it (a naive index-by-index comparison would mark
    every subsequent line as "changed" instead of just the one that actually moved).
    Returns `null` above `MAX_DIFF_LINES` (2000) on either side rather than letting the O(n·m)
    table allocate tens of millions of cells for a file nobody would read as a diff anyway.
  - **`shared/types.ts`**: new `ConfigFileHistoryEntry` (`id`, `profileId`, `path`, `content`,
    `savedAt`).
  - **`src/main/store.ts`**: `configFileHistory: ConfigFileHistoryEntry[]` schema field.
    `recordConfigFileHistory(profileId, path, content)` appends a snapshot, trimming that
    same `(profileId, path)` pair's own oldest entries past 20 - a per-file cap, not a global
    one, so one frequently-edited file can't crowd every other file's history out entirely.
    `listConfigFileHistory(profileId, path)` (newest first) and `getConfigFileHistoryEntry(id)`
    read it back.
  - **`src/main/lib/webDashboard.ts`**: the existing `POST .../ini` route now reads the
    file's current content (if any - a first-ever edit has nothing to snapshot, not an error)
    and calls `recordConfigFileHistory` right before overwriting it. Three new admin-gated
    routes: `GET .../ini/history?path=` lists `{id, savedAt}` only (never the full content -
    that would make the list grow with every edit ever made); `GET .../ini/history-diff?id=`
    diffs that one entry's content against the file's current content via `computeLineDiff`;
    `POST .../ini/restore {id}` writes that entry's content back as current - which, being
    itself just another overwrite, first snapshots whatever was current right before the
    restore, so a restore is itself undoable the same way any other save is.
  - **Web dashboard client**: new "History" list under the raw .ini editor panel, each entry
    a timestamp with "View diff" (renders colored +/-/unchanged lines) and "Restore" (confirms,
    then reloads the editor with the restored content) buttons. Saving now refreshes the
    history list in place instead of closing the editor, so the newly-created entry is visible
    immediately.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1159 tests - 6 new ones in
    `tests/textDiff.test.ts` for `computeLineDiff` itself, including the inserted/deleted-line-
    shift case and the `MAX_DIFF_LINES` cutoff; 3 in `tests/store.test.ts` for list/get/record
    and the per-file cap; 10 in `tests/webDashboard.test.ts`'s `raw .ini editor routes` describe
    block for the history list, the diff, the restore round trip - including that a restore
    itself creates a second history entry - and 404s on an unknown entry/server), and `npm run
    build` all pass, including the standing `node --check` regression test against the
    dashboard's served `<script>` content. **Not yet verified**: needs the user to confirm the
    History list, diff view, and restore all work correctly against a real edited `.ini` file
    in a real browser.

- **Added a raw .ini editor in the web dashboard** (second of the "Fichiers & config"
  category in the user-approved batch, right on top of the file browser above it). Clicking
  a `.ini` file in the Files tab now opens its raw text in an editable textarea instead of
  only offering Download/Delete - edit `GameUserSettings.ini`/`Game.ini` (or any other `.ini`
  under the install directory) directly from the browser, no download/edit-locally/re-upload
  round trip needed.
  - **`src/main/lib/webDashboard.ts`**: new `isIniPath(p)` helper (case-insensitive `.ini`
    extension check) gates two new routes, both `requireRole(..., 'admin')` and
    `resolveSafePath`-contained like the file browser routes right above them. `GET
    /api/servers/:id/ini?path=` returns `{ content: <raw utf-8 text> }`; `POST .../ini
    {path, content}` overwrites the file verbatim. Both 400 on a non-`.ini` path rather than
    silently becoming a generic arbitrary-file read/write primitive. Writing while
    `iniLockEnabled` has made the file read-only (see `iniLock.ts`) fails the same way any
    other write to a locked file would - `fs.writeFileSync` throws, caught and reported like
    every other failure here, nothing ini-lock-specific needed.
  - **Web dashboard client**: new `files-ini-editor` panel in the Files view (a `<textarea>`
    plus Save/Cancel) - a `.ini` file's name cell in the table is now clickable
    (`isIniFileName`) the same way a folder's already was, opening the panel in place of the
    table rather than navigating away from it. Closes itself (`closeFilesIniEditor`) on
    Cancel, on a successful Save, or whenever the folder view reloads out from under it
    (breadcrumb click, server switch) so it can never show stale content for a path that's no
    longer the one on screen.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1143 tests - 8 new ones in
    `tests/webDashboard.test.ts`'s new "raw .ini editor routes" describe block covering a
    read/write round trip, the non-.ini rejection on both routes, path-traversal rejection on
    both, and 404 for an unknown server), and `npm run build` all pass, including the
    standing `node --check` regression test against the dashboard's served `<script>`
    content (see the file browser entry above for why that test exists at all). **Not yet
    verified**: needs the user to confirm editing and saving a real `.ini` file through the
    browser actually persists and that the edited server picks the change up correctly.

- **Added a web dashboard file browser** (first of the "Fichiers & config" category in the
  user-approved batch). Browses a server's whole install directory remotely - navigate
  folders, download or delete individual files - without needing a separate FTP/SFTP/RDP
  setup just to grab or clear out a file. Works for both ARK and Minecraft (the backend
  resolves either via `findAnyServer`), unlike every other item in this batch so far which was
  ARK-only.
  - **`src/main/lib/pathSanitize.ts`**: new `resolveSafePath(baseDir, relativePath)` - joins
    `relativePath` onto `baseDir` and throws unless the result actually stays inside it
    (`resolved === base || resolved.startsWith(base + path.sep)`, not a bare `startsWith`,
    which would wrongly let `../ark-install-dir-evil` through against a base of
    `ark-install-dir`). Rejects an absolute `relativePath` outright (POSIX leading slash,
    Windows drive letter, or UNC `\\\\`) rather than letting `path.resolve` silently replace
    `baseDir` with it - checked independently of the current platform's own `path.isAbsolute`,
    so a Windows-style absolute path is still caught when this runs in CI on Linux, not just
    in production on Windows.
  - **`src/main/lib/webDashboard.ts`**: three new routes, all gated `requireRole(..., 'admin')`
    like every other route that can touch arbitrary files (restore/delete backup) - installDir
    can contain anything, and `resolveSafePath` only guarantees containment, not that
    everything in there is safe to hand out. `GET /api/servers/:id/files?path=` lists a
    directory (`{name, isDir, size, mtime}` per entry); `GET .../files/download?path=` streams
    a file as an attachment (`filename*=UTF-8''...` alongside a quote-stripped plain
    `filename` fallback); `POST .../files/delete {path}` removes a file - deliberately files
    only (checked via `fs.statSync(...).isFile()`), never a folder, so a wrong click from a
    remote web UI can't turn into a recursive directory wipe. `listFileBrowserEntries`/
    `sendFileDownload` are defined as free functions outside the main request-handler
    function rather than inline, since that function's own local `path` (the URL's pathname -
    `const path = url.pathname`) shadows the `node:path` module import for its entire scope.
  - **`src/renderer/src/pages/ServerDetail/ServerManagementTab.tsx`**: not touched - this is a
    web-dashboard-only feature (the desktop app already has a native file system/Explorer to
    browse the same install directory locally, so there's no equivalent need there).
  - **Web dashboard client** (the hand-written HTML/JS template in webDashboard.ts - see
    README's own architecture note on that file): new "Files" nav button/view, wired through
    every per-server-view touchpoint the existing Map Management view already has (admin nav
    gating, `SERVER_SCOPED_VIEWS`, its own server picker kept in sync with the other seven,
    `applyActiveView`/`selectServer` dispatch). Breadcrumb navigation (click any segment to
    jump there), a table sorted folders-first-then-alphabetical with a clickable folder name
    to descend into it, a Download link per file (carries `?token=` when auth is on, since a
    plain `<a href>` navigation can't set an `Authorization` header the way this client's
    patched `window.fetch` does for everything else), and a Delete button per file.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1135 tests - 14 new ones:
    7 in `tests/pathSanitize.test.ts` for `resolveSafePath` itself, including the sibling-
    directory-name-prefix false-positive case and both absolute-path syntaxes; 11 in
    `tests/webDashboard.test.ts`'s new "file browser routes" describe block covering list/
    download/delete success and 404/400/traversal-rejection cases, plus 2 role-gating checks
    in the auth-enabled suite), and `npm run build` all pass. Also added a standing
    regression test (`node --check` against the dashboard's actual served `<script>` content)
    - nothing else in this codebase ever executes or lints that hand-written client JS at
    build time, so a stray syntax error in it would otherwise only ever surface as a silent
    blank page in a real browser. **Not yet verified**: needs the user to confirm the Files
    tab actually renders and works end-to-end in a real browser (breadcrumb navigation,
    download, delete) against both a real ARK and Minecraft server.

- **Added a chained scheduled maintenance task** (third and last of the "Planification"
  category in the user-approved batch). The existing restart schedule already does Stop +
  optional Update + optional Start, but as separately toggleable options on one schedule -
  this adds a second, independent schedule that always runs the full pipeline, with a backup
  step folded in: Stop → Backup → Update → Start, every time, in that exact order. The two
  schedules are completely independent (a server can have both configured, firing at
  different times for different purposes) rather than the backup step being bolted onto the
  existing restart schedule as yet another checkbox.
  - **`shared/types.ts`**: new `ServerProfile.scheduledMaintenanceEnabled`/
    `scheduledMaintenanceTime`/`scheduledMaintenanceDays` fields - same shape as
    `scheduledDinoWipe*`/`scheduledRestart*` above them.
  - **`src/main/lib/profileMigration.ts`**: backfills them to off/00:00/no days.
  - **`src/main/lib/scheduledActions.ts`**: `runScheduledMaintenance(profile)` - stops the
    server, calls the same `createBackup()` the Backups tab's manual button and the cron
    backup schedule already use (catching and logging a failure rather than letting it abort
    the rest of the chain - the update and restart matter more than one missed backup),
    updates via SteamCMD (same `setUpdating` lock + `POST_STOP_UPDATE_DELAY_MS` grace period
    `runScheduledRestart` already uses, reused as-is), then starts the server back up -
    always all four steps, never separately toggleable, since that's the entire point of a
    "chained" task as opposed to the existing restart schedule's pick-your-own-steps design.
    `applyScheduledMaintenance`/`clearScheduledMaintenance` wire it to its own `node-cron`
    task, same mechanism as every other schedule in this file.
  - **`src/main/ipc/profiles.ts`** / **`cluster.ts`** / **`src/main/lib/webDashboard.ts`** /
    **`src/main/index.ts`**: `applyScheduledMaintenance`/`clearScheduledMaintenance` added at
    every existing call site of the RCON scheduler added just above this (same five spots).
  - **`src/renderer/src/pages/ServerDetail/ServerManagementTab.tsx`**: new "Scheduled
    Maintenance (Stop → Backup → Update → Start)" subsection, reusing `ScheduleDaysPicker`
    exactly like Restart/Dino Wipe/the RCON scheduler above it.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1114 tests - 4 new ones in
    `tests/scheduledActions.test.ts` covering the not-running guard, the full stop→backup→
    update→start order, the chain continuing when the backup step fails, and the update lock
    being released even when the update itself throws), and `npm run build` all pass. Also
    fixed the same two pre-existing test fixtures (`profileMigration.test.ts`,
    `profileExport.test.ts`) the RCON scheduler's own entry above already needed to touch
    once for its own new field - caught by `npm run typecheck`, not a silent gap. **Not yet
    verified**: needs the user to confirm a real scheduled maintenance run actually goes
    through all four steps in order against a live server.

- **Added a conditional scheduled restart** (second of the "Planification" category in the
  user-approved batch). The existing scheduled restart always fires at its configured time
  regardless of who's online, kicking everyone off mid-session - this adds an opt-in "Only if
  no players are connected" condition so a restart due while someone's actually playing is
  skipped entirely for that occurrence (no stop/update/start at all) and simply tried again
  at the schedule's next occurrence, rather than forced through or retried sooner.
  - **`shared/types.ts`**: new `ServerProfile.scheduledRestartOnlyIfEmpty: boolean` field,
    right next to `scheduledRestartUpdateAfter`/`scheduledRestartStartAfter` which it joins.
  - **`src/main/lib/profileMigration.ts`**: backfills it to `false` for existing profiles.
  - **`src/main/lib/scheduledActions.ts`**: `runScheduledRestart` now checks `listPlayers(profile)`
    (the same RCON `ListPlayers` call the web dashboard's own live player list already uses)
    before doing anything at all when this flag is on - any player still connected skips the
    whole restart (stop/update/start, all of it) with a Manager Log entry explaining why,
    rather than partially running or guessing who to wait for.
  - **`src/renderer/src/pages/ServerDetail/ServerManagementTab.tsx`**: new checkbox inside the
    existing Restart `ScheduleDaysPicker`, alongside "Update server from steam after
    shutdown"/"Start server after shutdown".
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1110 tests - 3 new ones in
    `tests/scheduledActions.test.ts` covering the skip-when-occupied case, the normal-restart-
    when-empty case, and that the player list isn't even checked when the flag is off), and
    `npm run build` all pass. **Not yet verified**: needs the user to confirm a real scheduled
    restart actually skips while someone's connected and fires normally once they leave.

- **Added a generic RCON command scheduler** (first of the "Planification" category in the
  user-approved batch). The existing Restart/Dino Wipe schedules (Server Management tab) each
  do exactly one hardcoded thing - this adds any number of arbitrary RCON commands, each on
  its own independent day/time schedule, for anything else you'd otherwise have to remember to
  send by hand (a `ServerChat` reminder, an extra `SaveWorld` on its own cadence, etc). ARK
  only - RCON scheduling has no Minecraft equivalent in this app (`minecraftScheduledActions.ts`
  only has a restart schedule, no RCON-command concept at all).
  - **`shared/types.ts`**: new `ScheduledRconCommand` type (`id`, `label`, `command`, `time`,
    `days`, `enabled`) and `ServerProfile.scheduledRconCommands: ScheduledRconCommand[]` -
    stored on the profile itself (like `scheduledRestart*`/`scheduledDinoWipe*`), not a
    separate store list, since each entry's inherently tied to one server's own schedule.
  - **`src/main/lib/profileMigration.ts`**: backfills `scheduledRconCommands` to `[]` for any
    profile saved before this existed.
  - **`src/main/lib/scheduledActions.ts`**: `applyScheduledRconCommands(profile)` - same
    `node-cron` mechanism `applyScheduledDinoWipe` already uses, but keyed by
    `` `${profileId}::${entryId}` `` (not just `profileId`) since there can be any number of
    these per profile, and iterating every enabled entry with a non-blank command and a valid
    cron expression (skipping anything disabled, blank, or with no days selected) to schedule
    its own `cron.schedule` call sending that exact command via `sendRconCommand` - only while
    the server's actually running, same guard the dino wipe schedule already has.
    `clearScheduledRconCommands(profileId)` stops and removes every task whose key starts with
    that profile's id, leaving every other profile's entries untouched. Guards
    `profile.scheduledRconCommands ?? []` the same way `buildDayOfWeekCron` already guards its
    own `days` param - some existing test fixtures (and any raw partial patch) can still reach
    this at runtime without the field despite the type.
  - **`src/main/ipc/profiles.ts`** / **`cluster.ts`** / **`src/main/lib/webDashboard.ts`** /
    **`src/main/index.ts`**: `applyScheduledRconCommands`/`clearScheduledRconCommands` added
    at every single existing call site of `applyScheduledDinoWipe`/`clearScheduledDinoWipe`
    (save, delete, copy, move, import-from-file, cluster import, the web dashboard's own save
    route, and the startup loop over every profile) - same lifecycle, same places.
  - **`src/renderer/src/pages/ServerDetail/ServerManagementTab.tsx`**: new "Scheduled RCON
    Commands" subsection under "Advanced Schedule", right after Dino Wipe - a label + command
    input per entry, reusing the existing `ScheduleDaysPicker` component for each entry's own
    day/time picker (complete with its own live countdown), an Add/Remove button per entry.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1107 tests - 6 new ones in
    `tests/scheduledRconCommands.test.ts` covering per-entry scheduling, skipping disabled/
    blank/no-days entries, the RCON command actually firing - and not firing when the server
    isn't running - and `clearScheduledRconCommands` only touching its own profile's tasks),
    and `npm run build` all pass. Also fixed four pre-existing test fixtures
    (`profileMigration.test.ts`, `profileExport.test.ts`, and two `ServerProfile`-shaped
    object literals this feature's new required field exposed) that needed the new field
    added to stay in sync with the real type - caught by `npm run typecheck` itself, not a
    silent gap. **Not yet verified**: needs the user to confirm a real scheduled command
    actually fires in-game at the configured time.

- **Added player activity/playtime tracking** (fifth of the user-approved batch, "Joueurs"
  category, and the last of that category - see the centralized ban list and the Discord join
  alert above for the other two). Tracks how long each player's actually been connected,
  merged across every ARK server, for a Dashboard/community-manager view of who's actually
  playing rather than just who's online right now. ARK only, same scope reasoning as the two
  features above it (the join/leave log line is ARK-specific).
  - **`shared/types.ts`**: new `PlayerActivityRecord` (`id`, `name`, `totalPlaytimeMs`,
    `sessionCount`, `lastSeenAt`, `profileIds`) - the aggregated, merged-across-servers total,
    built only from *closed* sessions (a currently-connected player's in-progress session
    doesn't count until they leave) - and `PlayerActivitySession` (`id`, `profileId`,
    `playerId`, `playerName`, `joinedAt`, `leftAt`) - one closed session, kept as a capped
    recent-activity log rather than an unbounded history. `IPC.playerActivityList`/
    `playerActivitySessions` channels; `Api.playerActivity`'s two read-only methods. New
    `AppSettings.playerActivityTrackingEnabled` field (off by default).
  - **`src/main/store.ts`**: `playerActivity: Record<string, PlayerActivityRecord>` (keyed by
    Steam/EOS id) and `playerSessions: PlayerActivitySession[]` (capped at 300, oldest trimmed
    first) schema fields. `recordPlayerSession(profileId, playerId, playerName, joinedAt,
    leftAt)` folds the session's duration into the player's aggregated record (creating one on
    their first-ever session, clamping a negative duration to 0 rather than letting a clock
    skew subtract from the total) and appends it to the capped log; `listPlayerActivity()`/
    `listPlayerSessions(limit = 50)` read them back, the latter most-recent-first.
  - **`src/main/lib/playerActivityWatch.ts`** (new): same serverEvents-driven lifecycle wiring
    and global-Settings-toggle gating as `playerJoinAlertWatch.ts`, but tracks *open* sessions
    instead of just matching a watchlist - a `Map<profileId, Map<uniqueNetId, {joinedAt,
    playerName}>>` holds everyone currently connected per server; a `joined` event opens one
    (restarting the clock rather than stacking a second if one was already open for that id -
    covers a missed `left`, e.g. a crash), a `left` event closes the matching one and calls
    `recordPlayerSession`. A `left` with nothing open (connected before this watch started) is
    silently skipped rather than guessed; a session still open when the server stops is
    dropped the same way, rather than timed against a leave that never actually happened.
    `syncAllPlayerActivityWatches()` re-evaluates every running ARK profile at once.
  - **`src/main/ipc/playerActivity.ts`** (new): two read-only handlers over the store
    functions above - nothing to add/remove here, unlike every other player-list feature this
    session has added, since this is collected data rather than user-managed entries.
  - **`src/main/index.ts`**: `registerPlayerActivityWatch()` at startup, plus
    `startPlayerActivityWatch(profile)` alongside the other player watchers for a server
    that's already running when the Manager (re)starts.
  - **`src/main/ipc/settings.ts`**: calls `syncAllPlayerActivityWatches()` right after saving
    Settings, same immediate-effect reasoning as the Discord join alert above.
  - **`src/renderer/src/pages/PlayerActivityView.tsx`** (new): read-only screen, two tables -
    aggregated totals (sorted by total playtime, descending) and the last 50 sessions. No
    form at all, unlike `PlayerBansView`/`WatchedPlayersSection` - there's nothing to create or
    delete here.
  - **`src/renderer/src/pages/Dashboard.tsx`** / **`App.tsx`**: new "Player Activity" button
    next to "Player Bans" in the ARK Dashboard's header, and a `showPlayerActivity` top-level
    screen state at the same tier as the rest.
  - **`src/renderer/src/pages/DataSettingsView.tsx`**: new "Track player activity/playtime
    (ARK)" checkbox in the General tab (not the Discord Bot tab - this works independently of
    whether the bot's even enabled), right after "Show the server's own console/debug window".
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1101 tests - 3 new ones in
    `tests/store.test.ts` covering cross-server total/session-count accumulation, the recent-
    sessions log, and the negative-duration clamp), and `npm run build` all pass. **Not yet
    verified**: needs the user to confirm real playtime actually accumulates correctly across
    a join/leave cycle and across a Manager restart with a player still connected.

- **Added a Discord alert when a watched player joins** (fourth of the user-approved batch,
  "Joueurs" category). Watch a list of names/ids in Settings and get pinged in a Discord
  channel the moment one of them joins any ARK server - previously the only way to know was
  watching the web dashboard's live player list yourself. ARK only (the join/leave log line
  this reuses from `playerConnectionWatcher.ts` is ARK-specific - see `playerBackupWatch.ts`,
  the only other consumer of that watcher, for the same scope).
  - **`shared/types.ts`**: new `WatchedPlayerAlert` type (`id`, `value`, `label`, `createdAt`)
    - `value` is matched case-insensitively against either the joining player's name or their
    Steam/EOS id. `IPC.watchedPlayersList`/`watchedPlayersAdd`/`watchedPlayersRemove` channels;
    `Api.watchedPlayers`'s three methods. New `AppSettings.discordBotPlayerAlertEnabled`/
    `discordBotPlayerAlertChannelId` fields.
  - **`shared/discordBot.ts`**: `DiscordBotConfig.playerAlertChannelId` - only set when the
    feature's enabled, same as every other optional channel id already on this type.
  - **`src/main/store.ts`**: new `watchedPlayers: WatchedPlayerAlert[]` schema field (default
    `[]`) plus `listWatchedPlayers()`/`addWatchedPlayer()`/`removeWatchedPlayer()` - a plain
    add/list/remove-by-id list, no merging logic needed (unlike `BannedPlayer` above, there's
    nothing here to merge across servers in the first place).
  - **`src/main/ipc/watchedPlayers.ts`** (new): thin CRUD handlers over the store functions -
    `add` generates the `id`/`createdAt` here (`randomUUID()`, same as every other IPC-layer-
    generated id in the app) rather than inside store.ts.
  - **`src/main/lib/playerJoinAlertWatch.ts`** (new): mirrors `playerBackupWatch.ts`'s
    serverEvents-driven start/stop-alongside-the-server-lifecycle wiring, but gated on a
    global Settings toggle (`discordBotPlayerAlertEnabled`) rather than a per-profile field,
    since there's no reason to pick and choose which servers in a cluster to watch - the
    whole point is not having to guess which one the watched player will actually join.
    `playerMatchesWatchlist(event, watchlist)` is kept as a standalone pure function (unit
    tested on its own) rather than inlined into the watch callback, which instead calls
    `listWatchedPlayers()` fresh on every join rather than snapshotting it at watch-start
    time - so editing the list takes effect on the very next join with no restart needed.
    `syncAllPlayerJoinAlertWatches()` re-evaluates every running ARK profile at once (called
    from the Settings save handler) since the toggle lives in Settings, not per-profile.
  - **`src/main/lib/discordBot.ts`**: `buildConfig` now sets `playerAlertChannelId`; new
    `notifyPlayerJoin(serverName, playerName, uniqueNetId)` sends a plain fork IPC message to
    the already-running bot child process (`child.send({ type: 'playerJoinAlert', ... })`) -
    unlike every other field on `DiscordBotConfig`, a join can happen at any moment while the
    bot's already up, so this can't wait for the config file the bot only ever reads once at
    its own startup.
  - **`src/bot/statusEmbeds.ts`**: new `buildPlayerJoinAlertEmbed(serverName, playerName,
    uniqueNetId)` - a small embed, consistent with every other embed this file already builds.
  - **`src/bot/index.ts`**: `process.on('message')` now also handles a `playerJoinAlert`
    message type (alongside the existing `stop` one) - looks up `config.playerAlertChannelId`
    in `client.channels.cache` (same lookup `statusRefresh.ts` already uses for its own
    channels), warns to the log instead of crashing if the channel's missing/not text-based.
  - **`src/main/index.ts`**: `registerPlayerJoinAlertWatch()` called once at startup, and
    `startPlayerJoinAlertWatch(profile)` added alongside the existing
    `startMonitoring`/`startPlayerBackupWatch` calls for a server already running when the
    Manager (re)starts.
  - **`src/main/ipc/settings.ts`**: calls `syncAllPlayerJoinAlertWatches()` right after saving
    Settings, so toggling the feature on/off takes effect on already-running servers
    immediately instead of only on their next restart.
  - **`src/renderer/src/pages/WatchedPlayersSection.tsx`** (new): the watchlist's own
    add/remove table, same `accounts-section`/`accounts-add-form`/`accounts-table` styling
    `AccessTokensSection.tsx` already established - rendered standalone (own IPC, not part of
    the Settings form/Save button) right under the Discord Bot tab's form, exactly where
    `AccessTokensSection`/`ApiKeysSection` already render under the Access Tokens tab.
  - **`src/renderer/src/pages/DataSettingsView.tsx`**: new "Player join alert (ARK only)"
    section in the Discord Bot tab - an Enable checkbox and a channel id field, both disabled
    until `discordBotEnabled` (and the checkbox itself) is on, same disabled-cascade pattern
    every other sub-feature in this tab already uses.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1098 tests - 5 new ones:
    4 in `tests/playerJoinAlertWatch.test.ts` for `playerMatchesWatchlist`'s name/id/case-
    insensitive/no-match/empty-list behavior, 1 in `tests/store.test.ts` for the watchlist's
    add/list/remove), and `npm run build` all pass. **Not yet verified**: needs the user to
    confirm a real join from a watched player actually posts to the configured Discord
    channel, and that toggling the feature mid-session (no restart) takes effect.

- **Added a centralized player ban list** (third of the user-approved batch, "Joueurs"
  category). ARK's own `BanPlayer`/`UnbanPlayer` RCON commands only ever touch one server's
  own local ban file, so banning someone who hops between servers in a cluster meant
  repeating it everywhere by hand. This merges every ban into one id-keyed list instead -
  ban once per server from either surface and it shows up as a single row listing every
  server it applies to. Minecraft isn't covered (different ban command/id shape entirely) -
  ARK-only for now.
  - **`shared/types.ts`**: new `BannedPlayer` type (`id`, `name`, `reason`, `bannedAt`,
    `profileIds: string[]`); `IPC.playerBansList`/`playerBansBan`/`playerBansUnban` channels;
    `Api.playerBans`'s three new methods.
  - **`src/main/store.ts`**: new `playerBans: BannedPlayer[]` schema field (default `[]`).
    `listPlayerBans()` reads it; `recordPlayerBan(playerId, playerName, reason, profileId)`
    either updates an existing row's name/reason/timestamp and appends `profileId` to its
    `profileIds` (if not already there) or creates a new row; `removePlayerBanProfile(playerId,
    profileId)` strips that one profile id out and drops the row entirely once its
    `profileIds` is empty - an unban on the last remaining server removes the player from the
    list, not just from that server.
  - **`src/main/ipc/playerBans.ts`** (new): `list` returns the store list as-is; `ban`/`unban`
    send the real RCON command (`BanPlayer`/`UnbanPlayer`) via `sendRconCommand` first and only
    update the store on success, so a row never claims a ban the server didn't actually apply.
  - **`src/main/lib/webDashboard.ts`**: new `POST /api/servers/:id/ban` route (ARK only,
    `moderator`+ like Kick), right after the existing `/rcon` route - sends `BanPlayer <id>`
    and records it via `recordPlayerBan` on success. The player context menu's `showContextMenu`
    function gets a new "Ban" button next to the existing "Kick" one, gated behind the same
    `canOperate` check the Kick button already uses (`moderator`/`admin`/`globalAdmin`) - prompts
    for an optional reason (`prompt()`, Cancel aborts without calling the API) then posts to the
    new route and toasts the result.
  - **`src/renderer/src/pages/PlayerBansView.tsx`** (new): desktop management screen - since
    there's no live player list anywhere in the desktop app (only the web dashboard has one),
    banning here means typing in a player id by hand and picking one or more servers to send
    `BanPlayer` to; the table below lists every current ban with a per-server unban button.
  - **`src/renderer/src/App.tsx`** / **`Dashboard.tsx`**: new `showPlayerBans` state at the same
    top-level tier as Settings/What's New (reachable from either game mode, though the feature
    itself is ARK-only), and a "Player Bans" button next to "Profile Management" in the ARK
    Dashboard's header.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1093 tests - 2 new ones in
    `tests/store.test.ts` covering the cross-server merge and the row disappearing once its last
    profile is unbanned), and `npm run build` all pass. **Not yet verified**: needs the user to
    confirm a real ban/unban round trip from both the desktop Player Bans screen and the web
    dashboard's right-click menu.

- **Added a "What's New" page in the app** (second of the user-approved batch) - a
  non-technical, curated changelog shown inside the Manager itself, distinct from this
  README (which documents every change in full engineering/file-by-file detail for whoever
  develops this next, not something to hand a user).
  - **`shared/changelog.ts`** (new): `CHANGELOG: ChangelogEntry[]` (`date`, `title`,
    `details: string[]`), newest first. Seeded with user-facing summaries of this session's
    changes going back to the group-order fix, plus two older, undated ("Earlier") entries
    for the native Discord bot integration and Minecraft support - deliberately left
    without a specific date rather than guessing one, since this file doesn't have the real
    date either happened and fabricating one would just be wrong. The doc comment at the
    top asks for a new entry here alongside each README one that's actually worth telling a
    user about (skipping pure refactors/internal fixes).
  - **`src/renderer/src/pages/ChangelogView.tsx`** (new): renders the list as simple cards
    (date, title, bullet points) - same `.server-detail`/`.server-detail-header` wrapper
    every other standalone screen here already uses (SteamCmdView/DataSettingsView/
    ProfileManagementView), so it gets the same header/Back button look for free.
  - **`src/renderer/src/App.tsx`**: new `showChangelog` state, checked at the same top-level
    tier as Settings/SteamCMD/Profile Management (reachable from either game mode). Added a
    "What's New" button as the new first item of the sidebar's bottom-pinned group, right
    above Log/Settings, in both the ARK and Minecraft sidebars.
  - **`src/renderer/src/styles.css`**: renamed `.app-sidebar-log` to the more accurate
    `.app-sidebar-bottom-group` (it now anchors three buttons, not just Log) and moved the
    `margin-top: auto` onto whichever is first in the DOM - still What's New in both
    sidebars after this change, no behavior difference, just a rename for clarity. New
    `.changelog-list`/`.changelog-entry`/`.changelog-entry-header`/`.changelog-date` rules
    for the new page's card layout.
  - **Verified**: `npm run typecheck`, the full `npx vitest run` (1091 tests, unchanged -
    this is static content plus simple rendering, no isolated unit to test), and
    `npm run build` all pass. **Not yet verified**: needs the user to confirm the new
    sidebar button/page look right in both game modes.
