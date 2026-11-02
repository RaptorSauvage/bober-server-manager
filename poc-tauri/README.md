# Tauri shell PoC

This PoC's originally-scoped exploration is complete - see `MIGRATION-PLAN.md` for what's
actually left to turn this into a shipped, Electron-replacing app (Windows-first).

Answers one question before committing to a real Electron → Tauri migration: can a Rust shell
spawn and talk to a persistent Node sidecar running the **existing, unmodified** application
logic, and get a real result back into a Tauri webview through an ordinary `invoke()` call?

This is scoped to exactly that round trip, now covering the actual headline case as well as the
supporting ones: a plain read (`profiles.list`), a write with parameters (`profiles.save`), two
independent push sources proving the mechanism generalizes (`profiles-changed` wrapping
`store.ts`'s own `profileEvents`, `manager-log-entry` wrapping `lib/managerLog.ts`'s own
`managerLogEvents`) - and now the real per-server **live console feed** itself
(`console.backlog`/`console.watch`, via `serverProcess.ts`'s real `watchLogFile` and
`lib/logEvents.ts`'s real `parseLogChunkWithDate`, both unmodified), which is what all of the
above was standing in for. All of that is Rust calling the sidecar; `folders_open_profiles`
proves the **other direction** too - the sidecar calling back into Rust for a real native action
(`lib/systemFolders.ts`'s real `openProfilesFolder()`, via Electron's `shell.openPath`) and
getting a real result back, over the same stdio pipe - see "The reverse direction" below.
`bot_start`/`bot_stop`/`bot_status` go beyond the main-process logic entirely: the real,
unmodified Discord bot subsystem (`lib/discordBot.ts` + `src/bot/`), which turned out to need no
porting work at all - and surfaced a genuinely significant SEA-packaging limitation along the
way, see "The Discord bot subsystem" below. `dashboard_start`/`dashboard_stop`/
`dashboard_status` prove the third and last subsystem from the original size estimate - the web
dashboard (`lib/webDashboard.ts`) - confirmed with a real HTTP client against the real embedded
dashboard page and the real `/api/servers` endpoint, see "The web dashboard subsystem" below.
Everything above is business logic; `manager-log.html` answers a different question - does the
real **UI** run against this architecture - by mounting the real, unmodified
`src/renderer/src/pages/ManagerLogView.tsx` against a `window.api` shim backed by Tauri instead
of Electron's `contextBridge`, see "A real React page" below. Window chrome, the menu bar, the
tray, the rest of the real renderer (`App.tsx`, routing, ~30 other pages), and the other ~34 IPC
modules in `src/main/ipc/` are still deliberately out of scope. The sixteenth (see "A sixteenth
real page" below) made this PoC's first real **outbound network call** - a genuine `fetch()`
straight to Valve's own CDN - and hit a real, honest network failure in this sandbox, not a bug.

## What's here

- `src-tauri/` - a minimal Tauri 2 app, using `tauri-plugin-shell`'s real sidecar mechanism (not
  a hand-rolled `std::process::Command`) to spawn the sidecar on startup - see "Sidecar
  packaging" below. `src/main.rs` keeps a background async task reading the sidecar's stdout
  that routes each line either to the pending `call()` it answers (has an `"id"`), a
  `"shell-request"` (the sidecar calling back into Rust - see "The reverse direction" below), or
  out to the webview as an ordinary Tauri event (any other `"event"`), and exposes one hundred
  and five Tauri commands: `profiles_list`, `profiles_save` (takes a profile object), `profiles_copy`/
  `profiles_move` (take `profileId`/`destInstallDir`/`newName` - see "A second real page" below),
  `log_record` (takes a message string), `manager_log_get_all` (see "A real React page" below),
  `server_start`/`server_stop`/`server_restart`/`server_kill`/`server_update`/`server_status`
  (all take a `profileId` - see "A fifth real page" below for `restart`/`kill`/`update`) and
  `server_install_test_executable` (test-only - see "The actual headline case" below),
  `console_backlog`/`console_watch` (both take an `installDir`),
  `console_append_test_line` (test-only - see below), `folders_open_profiles`,
  `bot_start`/`bot_stop`/`bot_status` (see "The Discord bot subsystem" below),
  `dashboard_start`/`dashboard_stop`/`dashboard_status` (see "The web dashboard subsystem"
  below), `dialog_select_directory` - the first command with no sidecar involvement at all,
  calling `tauri-plugin-dialog` straight from Rust (see "A second real page" below), and, for
  player management (see "A third real page" and "A fourth real page" below),
  `player_roster_list`/`player_roster_kick`/`player_bans_ban`/
  `player_whitelist_list`/`player_whitelist_add`/`player_whitelist_remove` plus `window_focus` -
  the second command with no
  sidecar involvement, backing `confirmAction()`'s real window-focus-loss workaround. The fifth
  real page (see below) added `settings_get`/`settings_save`, `profiles_delete`/
  `profiles_reorder`, and `system_stats_get_static_info`/`system_stats_get_network_usage`. The
  sixth (see below) added `stats_history_get`, `backup_get_schedule_status`,
  `server_get_installed_build_id`/`server_get_game_version`, `steamcmd_get_latest_build_id`, and
  `system_open_server_config_folder`/`system_open_server_saved_arks_folder`/
  `system_open_server_save_games_folder`. The seventh (see "A seventh real page" below) added
  `backup_create`/`backup_list`/`backup_delete`/`backup_restore`/`backup_open_folder`/
  `backup_get_log` and `player_backup_list_folders`/`player_backup_list`/
  `player_backup_open_folder`. The eighth (see "An eighth real page" below) added
  `steamcmd_get_update_log` and `steamcmd_append_test_update_log_line` (test-only). The ninth
  (see "A ninth real page" below) added `map_management_list`/`map_management_create`/
  `map_management_delete`/`map_management_open_folder`. The tenth (see "A tenth real page"
  below) added `group_console_rcon_send`. Round eleven through fourteen (see "A batch of four
  smaller real pages" below) added `watched_players_list`/`watched_players_add`/
  `watched_players_remove`, `player_activity_list`/`player_activity_sessions`, and
  `player_bans_list`/`player_bans_unban` (`player_bans_ban` already existed, see "A third real
  page"). `ChangelogView.tsx` needed no new command at all - zero `window.api` calls. The
  fifteenth (see "A fifteenth real page" below) added `stats_history_get_for_groups`. The
  sixteenth (see "A sixteenth real page" below) added `dialog_select_file` (the third command
  with no sidecar involvement, a sibling of `dialog_select_directory`), `steamcmd_managed_status`,
  `steamcmd_install`, and `steamcmd_add_firewall_rule`. The seventeenth (see "A seventeenth real
  page" below) added `group_console_subscribe`/`group_console_unsubscribe` (`group_console_rcon_send`
  already existed, see "A tenth real page" above). The eighteenth (see "An eighteenth real page"
  below) added none at all - a pure frontend composition of four already-proven pages. The
  nineteenth (see "A nineteenth real page" below) added `mod_events_list`/`mod_events_save`/
  `mod_events_delete`/`mod_events_history`. The twentieth (see "A twentieth real page" below)
  added `maps_list`, `custom_maps_list`/`custom_maps_add`/`custom_maps_update`/
  `custom_maps_delete`. The twenty-first (see "A twenty-first real page" below) added
  `dialog_select_ini_file` (a fourth sidecar-free command) and `ini_templates_get_generic`/
  `ini_templates_save_generic`/`ini_templates_get_override`/`ini_templates_save_override`/
  `ini_templates_delete_override`/`ini_templates_apply`/`ini_templates_apply_all`/
  `ini_templates_read_file`. The twenty-second (see "A twenty-second real page" below) added
  `file_browser_list`/`file_browser_open`/`file_browser_delete`/`file_browser_read_ini`/
  `file_browser_write_ini`/`file_browser_ini_history`/`file_browser_ini_history_diff`/
  `file_browser_ini_restore` - reaching the round-number hundredth Tauri command in this PoC.
  The twenty-third (see "A twenty-third real page" below) added `mods_save`/`mods_parse_text`/
  `mods_reconcile_from_ini`/`ark_mods_search`/`ark_mods_info`. The twenty-fourth (see "A
  twenty-fourth real page" below) added `dialog_save_profile_file` (a fifth sidecar-free
  command) and `server_preview_launch_command`/`system_open_data_dir_folder`/`profiles_export`
  - one hundred and eight Tauri commands total. The twenty-fifth (see "A twenty-fifth real
  page" below) added none at all - a pure frontend composition of eight already-proven pages,
  same shape as the eighteenth round. The twenty-sixth (see "A twenty-sixth real page" below)
  added `settings_save` (reusing an existing command), `data_dir_get_default`,
  `web_dashboard_get_local_ips`, `discord_bot_status`/`discord_bot_restart`/`discord_bot_stop`,
  `app_update_get_version`/`app_update_check`/`app_update_status`/`app_update_install`,
  `cluster_export`/`cluster_import`, `web_dashboard_access_tokens_list`/`_create`/`_update`/
  `_delete`, `web_dashboard_api_keys_list`/`_create`/`_update`/`_delete`, and two more
  sidecar-free dialogs (`dialog_save_cluster_bundle_file`/`dialog_select_cluster_bundle_file`,
  a sixth and seventh) - one hundred and thirty Tauri commands total. The twenty-seventh (see
  "A twenty-seventh real page" below) added `minecraft_install_list_versions`/
  `minecraft_install_list_loader_versions`/`minecraft_install_run` - one hundred and
  thirty-three Tauri commands total. The twenty-eighth (see "A twenty-eighth real page" below)
  added `minecraft_profiles_list`/`minecraft_profiles_save`/`minecraft_profiles_delete` - the
  Minecraft profile CRUD foundation - one hundred and thirty-six Tauri commands total. The
  twenty-ninth (see "A twenty-ninth real page" below) added `minecraft_server_get_status`/
  `minecraft_server_send_command`/`minecraft_console_get_backlog` - one hundred and
  thirty-nine Tauri commands total. The thirtieth (see "A thirtieth real page" below) added
  `minecraft_detect_launchable` - one hundred and forty Tauri commands total. The thirty-first
  (see "A thirty-first real page" below) added `minecraft_backup_get_log` and a test-only
  `minecraft_backup_append_test_log_line` - one hundred and forty-two Tauri commands total. The
  thirty-second (see "A thirty-second real page" below) added `minecraft_backup_create`/
  `minecraft_backup_list`/`minecraft_backup_delete`/`minecraft_backup_restore`/
  `minecraft_backup_open_folder` - one hundred and forty-seven Tauri commands total. The
  thirty-third (see "A thirty-third real page" below) added `minecraft_open_server_folder`/
  `minecraft_properties_get`/`minecraft_properties_save` - one hundred and fifty Tauri commands
  total. The thirty-fourth (see "A thirty-fourth real page" below) added
  `minecraft_mods_search`/`minecraft_mods_install`/`minecraft_mods_remove`/
  `minecraft_mods_set_enabled`/`minecraft_mods_check_updates`/`minecraft_mods_update`/
  `minecraft_mods_scan`/`minecraft_mods_open_folder` - one hundred and fifty-eight Tauri
  commands total. The thirty-fifth (see "A thirty-fifth real page" below) added none at all -
  a pure frontend composition of six already-proven tabs, same shape as the twenty-fifth round.
  The thirty-sixth and last (see "A thirty-sixth real page" below) added `minecraft_server_start`/
  `minecraft_server_stop`/`minecraft_server_kill`/`minecraft_profiles_import` - one hundred and
  sixty-two Tauri commands total.
- `sidecar/sidecar.ts` - a newline-delimited-JSON RPC server over stdin/stdout. Imports
  `listProfiles`/`saveProfile`/`profileEvents` from **the real, untouched `src/main/store.ts`**,
  `logManagerEvent`/`managerLogEvents` from **the real, untouched
  `src/main/lib/managerLog.ts`**, `watchLogFile`/`getLogFilePath`/`startServer`/`stopServer`/
  `getStatus`/`serverEvents`/`getExecutablePath`/`adoptPersistedProcesses` (from
  **`src/main/lib/serverProcess.ts`**, 980 lines - see "The actual headline case" and "Surviving
  a crash" below), `getRunningPids`/`getRunningStartedAt` (from **the same, already-imported
  `src/main/store.ts`**) plus `readLogBacklog`/`parseLogChunkWithDate`/
  `createLogEventCaches` (from **`src/main/lib/logEvents.ts`**), `openProfilesFolder` (from
  **`src/main/lib/systemFolders.ts`**), `copyProfile`/`moveProfile` (from
  **`src/main/lib/profileCopyMove.ts`**, see "A second real page" below),
  `sendRconCommand`/`parsePlayerListWithIds` (from **`src/main/lib/rcon.ts`**),
  `recordPlayerBan`/`listWhitelistedPlayers`/`recordWhitelistedPlayer`/
  `removeWhitelistedPlayerProfile` (from the same,
  already-imported **`src/main/store.ts`** - see "A third real page" below),
  `startDiscordBot`/`stopDiscordBot`/
  `getDiscordBotStatus` (from **`src/main/lib/discordBot.ts`**, see "The Discord bot subsystem"
  below), and `applyWebDashboardSettings`/`stopWebDashboard`/`getWebDashboardStatus` (from
  **`src/main/lib/webDashboard.ts`**, 8200+ lines, see "The web dashboard subsystem" below) -
  none of it stubs or rewrites; every emitter is wired
  straight to a push-event line (`profiles-changed`, `manager-log-entry`, `console-line`,
  `server-status`), so
  every real write's/parsed log line's/status change's side effect reaches the webview the same way it would via
  Electron's `webContents.send`. `sidecar/electronShim.ts` stands in for the Electron APIs that
  import chain actually calls directly (`app.getPath`, a minimal `ipcMain` stub `electron-store`
  itself needs, and `shell.openPath` - see "Findings" below and "The reverse direction" below) -
  see "electron-store's own fallback" below for a wrinkle this found and a real crash it caused
  once genuinely installed. `sidecar/rpcToRust.ts` holds the small bit of plumbing
  `shell.openPath` needs to call back into Rust over the same stdio pipe (see "The reverse
  direction"). `sidecar/build.mjs` bundles it all with esbuild, aliasing `electron` → the shim
  and pointing esbuild at the project's own `tsconfig.node.json` (see "Findings" below for why),
  into a single dependency-free `dist/sidecar.cjs`. `sidecar/sea-config.json` +
  `sidecar/build-sea.mjs` turn that bundle into `dist/sidecar-bin` - a standalone executable
  with Node itself embedded, via Node's own SEA (Single Executable Applications) feature - so
  `main.rs` can spawn it directly with no `node` on the target machine at all (see "Sidecar
  packaging" below). `sidecar/build-bot.mjs` separately bundles the real, unmodified
  `src/bot/index.ts` (mirroring the real repo's own `scripts/build-bot.mjs`) into
  `sidecar/bot/index.js`, the exact relative path `lib/discordBot.ts`'s own `botScriptPath()`
  expects; `sidecar/build-bot-sea.mjs` packages that into its own separate SEA binary,
  `sidecar/bot/bot-bin` - see "The Discord bot subsystem" below for why. The web dashboard
  needed no separate build step at all - `webDashboard.ts` is just
  another file `sidecar/build.mjs`'s existing esbuild bundle already pulls in.
- `frontend/index.html` - a bare page (not the real React UI): calls `invoke('profiles_list')`
  on load; buttons call `invoke('profiles_save', { profile })`, `invoke('log_record', {
  message })`, `invoke('console_watch', { installDir })`, `invoke('console_append_test_line',
  { installDir, message })`, `invoke('server_install_test_executable')`/`invoke('server_start')`/
  `invoke('server_stop')`/`invoke('server_status')` (see "The actual headline case" below),
  `invoke('folders_open_profiles')`, `invoke('bot_start')`/
  `invoke('bot_stop')`/`invoke('bot_status')`, and `invoke('dashboard_start')`/
  `invoke('dashboard_stop')`/`invoke('dashboard_status')`; `listen('profiles-changed',
  ...)`/`listen('manager-log-entry', ...)`/`listen('console-line', ...)`/`listen('server-status',
  ...)` handlers update their
  own section the moment each push event arrives - independent of any button, proving the
  live-update path for all four. `frontend/manager-log.html` +
  `frontend/manager-log-entry.tsx` are different: not hand-written for this PoC at all, beyond a
  tiny `window.api` shim - they mount the real, unmodified
  `src/renderer/src/pages/ManagerLogView.tsx` - see "A real React page" below.
  `frontend/profile-management.html` + `frontend/profile-management-entry.tsx` do the same for
  the real, unmodified `src/renderer/src/pages/ProfileManagementView.tsx` - see "A second real
  page" below. `frontend/player-roster.html` + `frontend/player-roster-entry.tsx` do the same
  for the real, unmodified `src/renderer/src/pages/PlayerRosterPanel.tsx` - see "A third real
  page" below. `frontend/player-whitelist.html` + `frontend/player-whitelist-entry.tsx` do the
  same for the real, unmodified `src/renderer/src/pages/PlayerWhitelistPanel.tsx` - see "A
  fourth real page" below. `frontend/build-react.mjs` bundles all four entries with esbuild (JSX
  support, the same `@shared/*` alias handling as the other build scripts).

## Running it

```sh
node sidecar/build-bot.mjs      # bundles sidecar/bot/index.js (needed before the first bot_start call)
node sidecar/build-bot-sea.mjs  # optional: packages that as sidecar/bot/bot-bin (fixes SEA + fork(), see below)
node sidecar/build.mjs          # bundles sidecar/dist/sidecar.cjs
node sidecar/build-sea.mjs      # builds dist/sidecar-bin AND copies it into src-tauri/binaries/
node frontend/build-react.mjs   # bundles manager-log.js (needed before opening manager-log.html)
cd src-tauri && cargo build     # or: cargo tauri dev, if the Tauri CLI is installed
./target/debug/tauri_poc_shell
```

`build-bot-sea.mjs` is optional - skip it and `bot_start` falls back to `discordBot.ts`'s normal
`fork()` behavior, which leaks a duplicate idle sidecar process instead of running the bot (see
"The Discord bot subsystem"); run it, and `main.rs` picks up `sidecar/bot/bot-bin` automatically
if it exists at build time, no extra flag needed.

`build-sea.mjs` is **not optional** before the first `cargo build`: `tauri.conf.json` declares
`bundle.externalBin: ["binaries/sidecar-bin"]`, and Tauri's own build script checks that
`src-tauri/binaries/sidecar-bin-<target-triple>` exists *at `cargo build` time*, not just at
runtime - `cargo build` fails outright (`resource path ... doesn't exist`) if that file is
missing, before any of this PoC's own code even runs. Re-run `build-sea.mjs` whenever
`sidecar.ts` changes; `cargo build` doesn't need to re-run unless `main.rs`/`Cargo.toml`
changed too, since Tauri just copies whatever's already in `binaries/`.

Set `SIDECAR_PATH` to a `node <path>`-style path (pointing at `dist/sidecar.cjs`) to skip all
of that and run the sidecar straight through a locally-installed `node` during iteration - no
`cargo build` needed at all when only `sidecar.ts` changes, and no `binaries/` setup required
first. `main.rs` reads this env var at startup, not compile time, and spawns it through the
plugin's generic `command()` API instead of `sidecar()` when it's set (see "Sidecar packaging").

Linux build needs `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `libsoup-3.0-dev`,
`libjavascriptcoregtk-4.1-dev`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, and
the usual `build-essential`. Windows needs Rust (via rustup), the "Desktop development with
C++" workload from the Visual Studio Build Tools (the MSVC linker - plain VS Code is not
enough, confirmed by actually hitting `error: linker 'link.exe' not found` without it), and
WebView2 (present by default on Windows 10 21H2+/11).

`icons/icon.ico` has to exist alongside `icons/icon.png` - found by actually building on
Windows, where `tauri-build` needs it (by that exact conventional path) to generate the
`.exe`'s Windows Resource file; the Linux build never asked for it because WebKitGTK has no
equivalent step. Regenerated here with `convert icon.png -define
icon:auto-resize=256,128,64,48,32,16 icon.ico` (ImageMagick).

`sidecar/build-sea.mjs`/`build-bot-sea.mjs`'s `npx postject@latest ...` call needs
`shell: true` on Windows - found on a real Windows machine running `node sidecar\build-sea.mjs`
directly (not through `cargo build`): it failed with `spawnSync npx ENOENT`, even though typing
`npx` into that exact same terminal works fine. `execFileSync`'s default direct-exec (no shell)
doesn't resolve `npx.cmd` the way a shell does - Windows' `CreateProcess` doesn't apply
`PATHEXT` on its own. Fixed by passing `shell: process.platform === 'win32'`, which routes the
call through `cmd.exe` only on Windows; Linux/macOS, which already worked without it, are
unaffected since the condition is false there.

To build and install a real package instead of just running the dev binary (`cargo install
tauri-cli --version "^2.0.0"` once, then):

```sh
cd src-tauri && cargo tauri build --bundles deb   # needs build-sea.mjs run first, same as above
sudo dpkg -i target/release/bundle/deb/tauri-poc-shell_0.1.0_amd64.deb
```

See "Actually bundled and installed with `cargo tauri build`" below before trusting a `cargo
build` dev run alone - it hid a real crash-on-install bug that only the actual bundle surfaced.

`bundle.targets` also lists `"msi"` and `"nsis"` now, for a real Windows installer (`.msi` via
WiX, `.exe` via NSIS) instead of just the dev binary - confirmed safe to add from this Linux
sandbox: a plain `cargo tauri build` (no `--bundles` override) here still only builds the `.deb`,
silently skipping the Windows-only targets rather than erroring, so this doesn't change the
Linux build path at all. Building the `.msi`/`.exe` themselves still needs an actual Windows
machine to confirm - same category of gap as everything else under "Windows/macOS parity beyond
the one round already run" in "What this doesn't prove yet".

## Result

**Confirmed on real Windows (WebView2), not just this Linux sandbox:** the window opens clean
(dark background, correct icon, no white flash), the read path shows "Got 0 profile(s)..." on
load, and clicking "Save a test profile" **visually** updates the push-status line to the live
'profiles-changed' confirmation with the new entry in the list - the one thing the Linux/Xvfb
run below couldn't show directly. That closes the last open question from this PoC: the full
read + write + push round trip works end to end, through a real OS-provided webview, not just
through on-disk evidence.

**The read path** (`profiles_list`) is confirmed both by screenshot and by watching it run: the
webview calls `invoke('profiles_list')` → Rust writes a JSON-RPC request to the sidecar's stdin
→ the sidecar runs the real `listProfiles()` (full `electron-store` load, migrations,
everything `store.ts` normally does) → the response comes back over stdout → Rust resolves the
pending call → the webview renders it.

**The write + push path** (`profiles_save` → real `saveProfile()` → real `profileEvents`
→ `profiles-changed` event → the webview's `listen()` handler) was first confirmed on this
Linux sandbox by the resulting on-disk state rather than a screenshot (see "A rendering dead
end" below for why), then confirmed visually for real on Windows/WebView2 as noted above.
Triggering the button's handler on a timer and checking `~/.config/ark-server-manager-
nodejs/config.json` afterward showed the new profile, written with a timestamp matching that
exact run, through `saveProfile`'s *full* migration/defaulting pipeline (`queryPort`,
`maxPlayers`, every other field `migrateProfile` normally fills in) - not a partial or
stubbed write.

No code in `src/main/store.ts` was changed for any of this - only `app.getPath('documents')`
needed a stand-in to run outside Electron (see `electronShim.ts`).

**The live console feed** - the actual headline case, not a stand-in for it - is confirmed the
same way: a synthetic ShooterGame.log-shaped file (no real ARK server in this sandbox) run
through the real `readLogBacklog` for the backlog, then the real `watchLogFile` polling + real
`parseLogChunkWithDate` parsing for the live feed. A scripted standalone test (spawn the
sidecar, send `console.watch`, wait past one real poll tick, send
`console.appendTestLine`, wait past the next tick) produced exactly one `console-line` push
event, correctly parsed as a `CHAT` entry with the right player name and timestamp - the real
regex-based parser (the same one the desktop Console tab and Web Dashboard both already use),
not a simplified one written for this PoC. The Tauri command wiring (`console_backlog`/
`console_watch`/`console_append_test_line`) compiles and the app starts cleanly with it, but -
unlike `profiles_save` - wasn't separately re-verified through a live button click on Windows,
since it's structurally identical to that already-Windows-confirmed command (same `call()`
path, same param-passing shape); the sidecar-level logic underneath it is what's actually new,
and that's what got the scripted test.

**Later update - now also confirmed live through the real webview on Linux, not just
standalone.** `index.html`'s own `listen('console-line', ...)` handler was never actually
re-tested after "A fifth real page" found and fixed the missing `capabilities/default.json`
(every `listen()` call in this PoC, `console-line` included, was being silently rejected until
then - see that section). Clicked "Start watching the test log," waited past one real 2-second
poll tick, clicked "Simulate a server writing a line," and the real feed updated live on screen:
"Live line received via 'console-line' push event," with the real parsed `CHAT` entry prepended
to the list - closing the one push-event type in this PoC that had only ever been confirmed
standalone.

Screenshot of the read path (Linux, WebKitGTK, via Xvfb - `Got 0 profile(s)` because this
sandbox has no real profiles.json, not because anything failed):

`Tauri shell PoC - real store.ts through a Node sidecar` / `Got 0 profile(s) from the real
store.ts, via the Rust shell -> Node sidecar round trip.`

### The reverse direction (sidecar calling Rust)

Everything above is one direction: Rust calls the sidecar, the sidecar answers or pushes
events. Real lib files that call Electron's `shell.*` (`systemFolders.ts`, `backup.ts`,
`mapManagement.ts`, ...) need the opposite direction too - `shell.openPath` is a native "open
this in the system file manager" call only the Rust shell can actually make, so the sidecar has
to ask Rust to do it and wait for a real answer, not fire-and-forget. Grepping every real call
site (`grep -rn "shell\.\(openPath\|showItemInFolder\)" src/main/lib/`) turned up only
`shell.openPath`, always in the same `await`-and-check-the-error-string shape, across 7 call
sites in 6 files - `showItemInFolder` isn't used anywhere, so that's the one method this needed
to prove.

**Architecture**: reuses the exact same bidirectional stdio pipe instead of opening a second
channel. `electronShim.ts`'s `shell.openPath(path)` calls `rpcToRust.ts`'s `callRust()`, which
sends a push-event-shaped line out on stdout (`{event: "shell-request", data: {id, method,
params}}` - using the event-name slot, not the RPC-method slot, since the sidecar is the one
initiating this time) and returns a `Promise` that resolves when a matching response arrives
back on stdin. `main.rs`'s reader task now recognizes `event === "shell-request"` specially:
instead of forwarding it to the webview like any other push event, it calls the real
`tauri-plugin-opener` crate (`app_handle.opener().open_path(path, None)`) and writes a plain
`{id, result}`/`{id, error}` line back onto the sidecar's own stdin - indistinguishable on the
wire from a response to an RPC call *Rust* itself made, except it's a separate id
counter/pending map going the other way, and `sidecar.ts`'s own line handler tells the two
apart by one rule: a line with a `"method"` field is a command from Rust, a line without one is
a response to one of the sidecar's own outgoing requests.

This needed `SidecarHandle.child` to become an `Arc<Mutex<CommandChild>>` shared between the
code that writes outgoing RPC requests and the reader task that now also writes shell-request
responses, both onto the same stdin.

**Proven real, not a mocked test, by porting an actual real file**: `folders_open_profiles`
calls `sidecar.ts`'s `folders.openProfiles` RPC method, which calls the real, unmodified
`openProfilesFolder()` from `lib/systemFolders.ts` - not a synthetic test method standing in
for the mechanism. That function itself calls `shell.openPath` internally; this PoC's code
never calls `shell.openPath` directly.

**Confirmed three ways**, each isolating a different layer:
1. A standalone Node script spawning `dist/sidecar.cjs` directly and acting as a fake Rust
   peer (reading the outgoing `shell-request` line, writing back a synthetic `{id, result:
   true}` response) confirmed the TypeScript side's id-correlation and promise resolution, for
   both the success and error-propagation paths, with no Rust involved at all.
2. Running the actual compiled Tauri app under Xvfb and clicking (via a temporary `setTimeout`
   trigger, reverted before committing) confirmed the real round trip end to end: Rust's stderr
   logged `sidecar shell-request 'openPath' -> Err("Launcher \"gio\" \"open\"
   \"/root/.tauri-poc-bober-manager\" failed with ExitStatus(unix_wait_status(512))")` - a real
   attempt by the real `tauri-plugin-opener` crate to run `gio open` against the real path
   `electronShim.ts`'s `app.getPath('userData')` resolves to, failing only because this headless
   sandbox has no GUI session/file manager registered to handle it (the same category of
   sandbox-specific gap as the WebKitGTK rendering limitation below, not an architecture bug).
3. The error correctly reached all the way back down through `write_line` → the sidecar's
   stdin → `resolveRustResponse` → the rejected `callRust()` promise → `shell.openPath`
   returning that message as a string (matching real Electron's own `shell.openPath` contract)
   → `openProfilesFolder()` throwing it → the RPC response's `error` field → the webview's
   `.catch()` handler, which is the complete real error-propagation path a real migration needs,
   not just the happy path.

This Rust-side `eprintln!` logging of every shell-request's outcome was kept in `main.rs`
(not reverted) - genuinely useful visibility into a native call that has no other feedback
path from inside this architecture.

### The Discord bot subsystem (a real packaging bug, found and fixed)

Everything above is the "main process logic" sidecar. The original size/migration estimate also
counted two more real subsystems - the Discord bot and the web dashboard - as separate sidecars,
listed in "What this doesn't prove yet" as completely untouched. This proves the bot one, and
the result was better *and* worse than expected: better, because it needed **zero porting work**
at all; worse, because it surfaced a real, consequential bug in this PoC's own SEA packaging
that the main-process sidecar's own tests never would have caught.

**Better than expected - already decoupled.** `grep -rl "from 'electron'" src/bot/` returns
nothing: the bot (`src/bot/`, ~3000 lines, `discord.js`) has zero Electron imports. It already
runs as its own OS process today, `fork()`ed by `lib/discordBot.ts` with `ELECTRON_RUN_AS_NODE=1`
specifically so it can't take the Manager down if it crashes, talking to the Manager purely over
the existing Web Dashboard HTTP API - not Electron IPC at all. `sidecar/build-bot.mjs` bundles
`src/bot/index.ts` completely unmodified (same esbuild config as the real repo's own
`scripts/build-bot.mjs`) into `sidecar/bot/index.js`, and `sidecar.ts`'s `bot.start`/`bot.stop`/
`bot.status` RPC methods call the real, unmodified `startDiscordBot()`/`stopDiscordBot()`/
`getDiscordBotStatus()` from `lib/discordBot.ts` directly - no shim, no stub, no new glue beyond
the three one-line RPC methods themselves. `startDiscordBot()` round-trips through the real
`saveSettings()`/`getSettings()` (flipping `discordBotEnabled`/`discordBotToken` on, the same
shape the real Settings UI would send) and reuses the exact same `manager-log-entry` push event
already proven for `log.record` - `discordBot.ts`'s own `logManagerEvent` calls on start/exit
reached the webview with no new wiring at all.

**Confirmed under `SIDECAR_PATH` dev mode** (plain `node`, not the SEA binary): a standalone
script acting as a fake Rust peer showed the complete real lifecycle - `bot.start` → real
`fork()` → the real bundled bot process actually starts, reads its config, attempts
`client.login()` against Discord's real gateway, and (no outbound DNS to discord.com in this
sandbox) fails with `getaddrinfo ENOTFOUND discord.com`, exiting cleanly with code 1. That
exit is caught by `discordBot.ts`'s own real `proc.on('exit', ...)` handler, which pushes a
second real `manager-log-entry` event and updates `lastError` - all unmodified code, reproduced
through the real compiled Tauri app running under Xvfb (checked via the real
`~/Documents/.../logs/manager.jsonl` file, not a screenshot, for the same reason as "A rendering
dead end" below): `"Démarrage du bot Discord..."` then `"Le bot Discord s'est arrêté (code 1)."`,
exactly matching the standalone result.

**Worse than expected - a real bug, found by running the actually-installed thing, not the dev
build** (same lesson as "Actually bundled and installed with `cargo tauri build`" above, this
time without even needing `cargo tauri build` - the plain dev binary already showed it once
pointed at the default SEA sidecar instead of `SIDECAR_PATH`): calling `bot.start` against the
**default** sidecar (the compiled SEA binary, not `SIDECAR_PATH` dev mode) spawns a process that
prints `sidecar: ready` - the *main sidecar's own* startup banner, not anything from
`sidecar/bot/index.js` - and then just sits there, alive, doing nothing, forever. Confirmed with
a minimal, decisive test: running `./sidecar-bin /path/to/bot/index.js /path/to/config.json`
directly (extra positional args most Node programs would treat as `process.argv`) behaves
identically to running `./sidecar-bin` with no arguments at all. **Node's SEA packaging bakes in
one fixed entry point and ignores any script-path argument entirely** - there is no way to tell
a SEA binary "run this other file instead." `fork()`'s whole mechanism is built on the opposite
assumption (re-execute `process.execPath` with a *different* module path as the first argument),
so `lib/discordBot.ts`'s `fork(botScriptPath(), [configPath], ...)` - completely correct, and
exactly how every other Node program spawns a worker script - silently does the wrong thing the
moment `process.execPath` is a SEA binary instead of a real `node`: it leaks a second, idle copy
of the *main* sidecar process instead of running the bot, with no error anywhere (not even in
`discordBot.ts`'s own `proc.on('error', ...)` handler - `fork()` itself reports success, because
from the OS's perspective a process genuinely did start).

This is a materially different kind of finding than everything above: not a config quirk or
a sandbox limitation, but a real architectural incompatibility between two pieces of this PoC
that each work fine on their own - Node SEA packaging (proven solid for the main sidecar) and
`fork()`-based worker spawning (proven solid as *application code*, unmodified, under `node`).

**Fixed and validated, not just diagnosed** - this is the one place in the whole PoC where a
real `src/main/lib/` file needed an actual code change, not just a shim or new RPC glue, so it's
worth being explicit about exactly what changed and why. `lib/discordBot.ts`'s `fork()` call now
checks an optional `BOT_LAUNCH_COMMAND` environment variable first: unset (every normal build,
including every real Electron build - Electron's own executable is never a SEA binary), nothing
changes at all, same `fork(botScriptPath(), ...)` as before; set, it calls
`spawn(launchCommand, [configPath], { stdio: [..., 'ipc'], env: {...} })` instead - an explicit
path to spawn rather than an implicit re-exec of `process.execPath`, with the `'ipc'` stdio slot
so `child.send()`/the exit/stdout/stderr handling all keep working exactly as `fork()` already
provided them. Fifteen lines, reviewed against the existing test suite (`npx vitest run
tests/discordBot.test.ts`: 16/16 still pass) and `npx tsc --noEmit -p tsconfig.node.json` (clean)
before being trusted.

`sidecar/build-bot-sea.mjs` packages the bot (`sidecar/bot/index.js`) as its own separate SEA
binary (`sidecar/bot/bot-bin`), the same `--experimental-sea-config`/`postject` steps as
`build-sea.mjs` uses for the main sidecar, and copies it to
`src-tauri/binaries/bot-bin-<target-triple>`. `tauri.conf.json`'s `bundle.externalBin` now lists
`"binaries/bot-bin"` alongside `"binaries/sidecar-bin"` - the real mechanism this time, not the
dev-only `CARGO_MANIFEST_DIR` shortcut an earlier version of this fix used (which would have
resolved to a source-tree path that doesn't exist once genuinely installed, quietly leaving
`bot_start` broken again the moment anyone actually shipped a bundle). `main.rs`'s
`spawn_sidecar` now resolves `bot-bin`'s real location the same way `tauri-plugin-shell`'s own
(private) sidecar-path resolution does internally - `std::env::current_exe()?.parent()?.join(...)`
- replicated by hand since there's no public API to ask for a resolved path without spawning, and
confirmed by reading the plugin's own source rather than guessing. Only passed as
`BOT_LAUNCH_COMMAND` when that file actually exists, so a plain `cargo build` without ever
running `build-bot-sea.mjs` still works exactly as before (confirmed: removed `bot-bin`,
rebuilt, ran clean).

**Confirmed fixed through the real, compiled app, both in dev mode and as a genuinely installed
package - not just standalone.** Dev mode: `cargo build` copies `binaries/bot-bin-<triple>` to a
plain `bot-bin` right next to `target/debug/tauri_poc_shell`, confirmed on disk before even
running anything; then, with no manual env vars set, `bot_start` against the **default SEA
sidecar** showed the real bot's own distinctive log line (`"Connexion à Discord impossible :
getaddrinfo ENOTFOUND discord.com"`, timestamped, not `"sidecar: ready"`) in `manager.jsonl`,
followed by a clean exit and no leaked process - the same correct behavior `SIDECAR_PATH` dev
mode always had, now also working under the packaging mode that actually ships. Then
`cargo tauri build --bundles deb` (87 MiB now, two embedded Node runtimes): `dpkg --contents`
confirmed `usr/bin/bot-bin` genuinely inside the package next to `usr/bin/sidecar-bin`, and after
a real `dpkg -i` install, running `/usr/bin/bot-bin` directly (standalone, the exact binary the
installed app would resolve to) reproduced the identical real failure - the same evidence
`Command::env()` receives the right path either way, dev or installed, from the same
`current_exe()`-relative logic.

### The web dashboard subsystem

The third and last subsystem from the original size estimate. `lib/webDashboard.ts` is big
(8200+ lines) and pulls in a large slice of `src/main/lib/` transitively (`serverActions.ts`,
`backup.ts`, `rcon.ts`, `groupConsole.ts`, `statsHistory.ts`, `fileBrowser.ts`, ...) - it's the
real app's entire Web Dashboard HTTP API and embedded frontend in one file, not a small
single-purpose module like the others this PoC has ported so far.

**Architecturally different from the bot in one important way, confirmed by just reading it
rather than assuming**: unlike the bot, the web dashboard was never a separate OS process even
in the real app - `startWebDashboard()`/`stopWebDashboard()` just create a plain
`http.Server`/`https.Server` (Node's own built-in modules) **in the same process** as
everything else, listening on a port directly. There's no `fork()` anywhere in this file, so
none of "The Discord bot subsystem"'s SEA-packaging problem applies here at all - this is just
more functions this sidecar can call, the same shape as `systemFolders.ts`.

**Added to `sidecar.ts` and it bundled clean on the first try** - no missing-module errors, no
new Electron-shim gaps (the existing `app.getPath` coverage was already enough), despite the
large transitive import graph. `dashboard.start`/`dashboard.stop`/`dashboard.status` call the
real, unmodified `applyWebDashboardSettings()`/`stopWebDashboard()`/`getWebDashboardStatus()`
directly, through the same real `saveSettings()`/`getSettings()` round trip as every other real
subsystem this PoC touches.

**Confirmed the most thoroughly of anything in this PoC, because it's the one subsystem a real
HTTP client can check without any webview/Xvfb involvement at all.** Standalone (a fake-Rust-peer
script, same technique as "The reverse direction"): `dashboard.start` → a real `http.Server`
actually listening on `127.0.0.1:18090` → a real `GET /api/servers` returns `200` with a real
`[]` (correctly empty, no profiles exist) → a real `GET /` returns the real embedded dashboard
page (`<title>Bober Server Manager - Web Console</title>`, not a stand-in) → `dashboard.stop` →
a follow-up request gets a real `ECONNREFUSED`, proving the server genuinely stopped, not just
that the RPC call returned. Then reproduced through the **actual compiled Tauri app**, started
for real (`./target/debug/tauri_poc_shell`, default sidecar - the SEA binary, not
`SIDECAR_PATH`), triggered via `invoke('dashboard_start')`, and checked with a plain `curl` from
a completely separate terminal, entirely outside the app: `curl http://127.0.0.1:18090/`
returned the real dashboard HTML, `curl http://127.0.0.1:18090/api/servers` returned the real
`[]`. This sidesteps "A rendering dead end" below entirely - no screenshot, no on-disk-state
proxy, no WebKitGTK repaint question at all, just an ordinary HTTP response from a real server
running inside the real app.

Unlike the Discord bot, **nothing broke here** - worth stating plainly rather than only ever
reporting bugs: a 8200-line file with a large transitive dependency graph, including several
subsystems this PoC hasn't touched directly yet (`serverActions.ts`, `backup.ts`, `rcon.ts`, the
group console, stats history, the file browser), bundled and ran correctly the first time it was
tried, serving real HTTP responses through every layer of this PoC's architecture (Rust shell →
sidecar → real app code → real HTTP server → real HTTP client) with zero new workarounds needed.

### A real React page

Every proof above is about the application logic underneath the UI - `frontend/index.html` has
always been a bare, hand-written page, not the real renderer, standing in for the question "does
the architecture carry a real call correctly," not "does the real UI work against it." This is
the first time that second question gets a real answer: can an actual, unmodified page from
`src/renderer/src/` run against a Tauri `window.api` shim instead of Electron's
`contextBridge`-exposed one?

**Picked `ManagerLogView.tsx`** (`src/renderer/src/pages/`, 146 lines) deliberately: it's small
and self-contained (no imports beyond React and a shared type), and it corresponds exactly to a
subsystem this PoC had already proven at the RPC layer (`log.record`/`manager-log-entry`), so
porting it tests the UI layer specifically, not a new backend capability bundled in with it. It
calls exactly two methods - `window.api.managerLog.getLog()` and
`window.api.managerLog.onLogChanged(callback)` - everything else in the file (its own grouping
logic, its own date/time formatting, its own JSX, its own CSS class names) is real, unmodified
production code.

**The port is almost entirely on the Rust/sidecar side, not the component.** `sidecar.ts` gained
one line (`'log.getAll': () => readManagerLog()`, the real, already-imported-from-the-same-file
function backing the real preload's `managerLogGet` IPC handler) and `main.rs` one matching
`manager_log_get_all` command. `poc-tauri/frontend/manager-log-entry.tsx` (new) defines a
`window.api` object with exactly the two methods `ManagerLogView.tsx` calls - `getLog` forwards
to `invoke('manager_log_get_all')`, `onLogChanged` forwards to
`listen('manager-log-entry', ...)` - then imports the real component unmodified and mounts it
with `createRoot`. `poc-tauri/frontend/build-react.mjs` bundles that entry with esbuild
(`jsx: 'automatic'`, the same `@shared/*` alias handling as the other build scripts) into
`manager-log.js`, served by Tauri as a second page (`manager-log.html`) alongside `index.html` -
`frontendDist` is a whole directory, so this needed no `tauri.conf.json` changes at all.

**Confirmed with real data, not an empty state.** Seeded a real entry into the real
`manager.jsonl` first (piping a `log.record` call directly into the SEA sidecar binary,
standalone), then pointed the app's main window at `manager-log.html` directly (a temporary
`tauri.conf.json` window `url` override, reverted immediately after) and screenshotted the
result under Xvfb. The real component rendered the real seeded entry correctly - its own
"Manager Log" header, its own description paragraph, its own task-grouping with the real
`taskLabel` ("Tauri PoC") and the exact seeded message text - all through `getLog()`'s real
`invoke` → Rust → sidecar → `readManagerLog()` → the real JSONL file round trip. This is a
first-frame screenshot (see "A rendering dead end" below for why that's the reliable one in this
sandbox), so it directly confirms the read path; the live-push path (`onLogChanged`) wasn't
separately re-screenshotted, since it's structurally identical to the already-proven
`listen('manager-log-entry', ...)` call `index.html`'s own vanilla-JS listener already uses -
the new code here is purely the `window.api` wrapper around it, not the event delivery itself.

This doesn't generalize to "the whole real UI runs on Tauri" by itself - one small, read-heavy
page is not the real `App.tsx` with its routing, Context providers, and ~30 other pages each
touching a different slice of `window.api`. What it does show is the actual *shape* of that
port: no change to the real component, a `window.api` object built to the same surface the real
preload already defines, and the Rust/sidecar side doing the same kind of one-line RPC-method
addition this whole PoC has done repeatedly elsewhere - not a rewrite of the UI layer, just
another thin transport swap underneath it.

### A rendering dead end (and why it doesn't undercut the result above)

Confirming the write+push path visually turned into its own small investigation. In order:

1. `xdotool click` at the button's screen coordinates did nothing - no error, no state change at
   all, not even a focus ring.
2. Focusing the window first and clicking by window-relative coordinates got a focus ring to
   appear on the button, but still no click handler firing.
3. Switched to triggering the save on a `setTimeout` instead of a real click, to isolate "is
   input simulation the problem" from "does the write+push path work" - still nothing changed
   on screen after waiting well past the timer.
4. That ruled out input simulation specifically, which pointed at something more fundamental:
   edited `frontend/index.html` **without** rebuilding the Rust binary first, assuming
   `frontendDist` is read live from disk. It isn't - Tauri embeds it at `cargo build` time, so
   every edit needs a rebuild before it's visible, which this PoC's own first few check-ins
   quietly got right only by accident (the README already said `cargo build` in "Running it").
   After rebuilding, the on-disk write started happening on schedule (see above) - the
   architecture worked the whole time.
5. What still never changed was the **screen**. Checked the actual file on disk (not the
   screenshot) and found the write already there, timestamped to the right second. So the
   webview's JS executed, `invoke`/the event listener both did their job, and the DOM almost
   certainly updated - but WebKitGTK never repainted the X window to reflect it. Tried
   `LIBGL_ALWAYS_SOFTWARE=1` (cleared the DRI3/EGL warnings) and forcing a relayout via
   `xdotool windowsize` (a common repaint trigger) - neither changed the screenshot. The first
   frame painted correctly every time; nothing after that ever did.

Read together, this looks like a software-rendering compositing limit specific to WebKitGTK
under a bare Xvfb (no window manager, no real GPU) in this particular sandbox, not a problem
with the Tauri/sidecar architecture itself - the filesystem was a more reliable witness than a
screenshot here, and it said the write and the push event both landed. **Confirmed**: a real
Windows/WebView2 run showed the push-status line update live on screen after clicking the
button, exactly as expected - the gap this section describes was specific to this Linux
sandbox's rendering, not the architecture.

**Update - this conclusion doesn't generalize as broadly as stated above.** "A fourth real page,
and a correction to 'A rendering dead end'" (further down) found a real post-write repaint in
this same sandbox, using the same `setTimeout`-triggered approach step 3 above already tried.
The exact difference between the two tests was never isolated - treat "no repaint after the
first frame" as something to re-check with a fresh screenshot, not an assumption to build on.

**Second update - the real root cause, found in "A fifth real page" (further down): this was
never a WebKitGTK rendering limit at all.** `src-tauri/capabilities/` didn't exist - no
capabilities file had ever been created in this PoC - and Tauri 2 silently rejects
`window.__TAURI__.event.listen(...)` (the exact call this section's `pushStatusEl` handler and
every other live-update page in this PoC depends on) without one:
`event.listen not allowed. Permissions associated with this command: core:event:allow-listen,
core:event:default`. The write genuinely landed (confirmed on disk, as step 5 above found), but
the push event was never delivered to this page's JS at all - not "delivered but unpainted." This
also fully reconciles the apparent contradiction with the update above: "A fourth real page"'s
repaint-that-worked was triggered from a click handler's own `invoke()` response, never through
`listen()` - a completely different, never-blocked code path - which is exactly why it worked
while this section's `listen()`-dependent push did not. Fixed with
`capabilities/default.json`; re-running this exact scenario (a real click on "Save a test
profile") after the fix shows the live update correctly, on screen, in this same sandbox. See "A
fifth real page" for the full investigation.

### A second real page: write paths and a native dialog

`ManagerLogView.tsx` above was deliberately the easy case: read-only, one subsystem already
proven at the RPC layer, no native OS interaction. `ProfileManagementView.tsx`
(`src/renderer/src/pages/`, 165 lines) was picked next specifically because it isn't that - it's
a write path (copy/move an entire server install) with a native folder-picker dialog in front of
it, which is architecturally new territory for this PoC in two ways at once.

**The write side is the same shape as everything else.** `window.api.profiles.copy`/`.move` call
the real, unmodified `copyProfile()`/`moveProfile()` from `lib/profileCopyMove.ts` - a file with
zero Electron coupling already (confirmed earlier by reading it in full) - through two new
sidecar RPC methods (`profiles.copy`/`profiles.move`) and two matching `main.rs` commands
(`profiles_copy`/`profiles_move`), exactly the same `invoke → Rust → sidecar → real function`
shape `profiles_list`/`profiles_save` already proved. One deliberate scoping cut: the real
`ipc/profiles.ts` handler also re-runs `applyBackupSchedule`/`syncPlayerBackupWatch`/
`applyScheduledRestart`/`applyScheduledDinoWipe`/`applyScheduledRconCommands`/
`applyScheduledMaintenance` on the result, re-arming file watchers and cron-like timers against
the profile's new path - left out here since there's no real server process or backup content in
this sandbox to observe it against, and it isn't what this increment tests. A real migration
still has to port that wiring; it's the same kind of real file-copy/move operation as any other,
not a new question about the architecture.

**Confirmed against real files, not a mocked response.** Standalone, piping JSON-RPC lines
directly into the SEA sidecar binary (same technique as seeding `manager.jsonl` earlier): seeded
a profile pointing at `/tmp/poc-profile-src` (two real files in it), called `profiles.copy` with
a new destination, and confirmed on disk - not just in the RPC response - that
`/tmp/poc-profile-dest-copy` now contains byte-identical copies of both files and the source is
untouched. Then called `profiles.move`: the destination got the files, `newName` was reflected in
the result, and critically `/tmp/poc-profile-src` **no longer exists** - `fs.promises.rename`'s
real behavior, not a copy pretending to be a move. `config.json` (the real electron-store-backed
file) gained the new/renamed profile entries both times, through the exact same `saveProfile()`
this PoC's very first round already proved.

**The native dialog is the actually new architectural shape.** Every prior proof in this PoC -
`profiles.*`, `log.*`, `console.*`, the bot, the web dashboard - is a sidecar RPC call with Rust
as a thin passthrough. `window.api.dialog.selectDirectory()` isn't: the real `dialog.ts`
(`src/main/ipc/dialog.ts`, read in full earlier) calls Electron's `dialog.showOpenDialog`
directly against a `BrowserWindow` handle - it's a main-process/window-level concern in the real
app too, with zero business-logic file in between. So `dialog_select_directory` in `main.rs` is
the first command in this PoC with **no sidecar involvement at all**: a plain `#[tauri::command]`
calling `tauri-plugin-dialog`'s `app_handle.dialog().file().blocking_pick_folder()` straight from
Rust - matching the real app's own architecture rather than inventing a sidecar round trip for
something that was never routed through one.

**Confirmed: real data renders through both commands together.** Pointed the main window at a
new `profile-management.html` (same temporary-`tauri.conf.json`-`url`, reverted-after technique
as `manager-log.html`) and screenshotted under Xvfb. First attempt showed the dropdown populated
with the real seeded profile name but nothing below it - traced to a wrapper-only bug (not in the
real component): the real `App.tsx` only ever mounts `ProfileManagementView` after its own
app-wide `profiles` state is already loaded, but this PoC's thin `ProfileManagementPage` wrapper
was mounting it immediately with an empty array and filling `profiles` in after
`invoke('profiles_list')` resolved - and `ProfileManagementView`'s own `selectedId` state is
seeded from `profiles[0]` only once, at mount, so it never picked up the real data once it
arrived. Fixed by gating the mount on the fetch resolving first (`profile-management-entry.tsx`),
matching the real app's own mount order instead of working around the component. After the fix,
the re-screenshot shows the complete real form: the real dropdown, "Current install folder:
/tmp/poc-profile-dest-move" (the exact path the standalone `profiles.move` test above produced),
the copy/move radio buttons, and the destination/name fields - the real, unmodified component
rendering real data through both the sidecar RPC path and (indirectly, via the same `profiles`
state) the architecture the native-dialog command will feed into.

**The native dialog itself does not complete in this sandbox - and fails differently than
`shell.openPath` did.** Called `dialog_select_directory` directly (a minimal temporary test page,
same `tauri.conf.json`-`url` technique, invoking it on load and recording the result in the
window title) and waited 10+ seconds: the window title never changed - no result, no error.
Screenshotting mid-wait showed the main window's content had gone blank white (not just
unrepainted, as in "A rendering dead end" above - genuinely blank), and `xdotool search` found
two new, unnamed X windows appear alongside the main one that weren't there before the call. Read
together, this looks like `blocking_pick_folder()` genuinely attempting to create a native dialog
surface - unlike `shell.openPath`'s `gio open`, which failed fast and cleanly with no GUI session
at all - and then blocking indefinitely waiting for a human click that can never come
unattended, rather than erroring out. This is a sandbox-only gap, not a sign the plugin is wired
wrong (the call compiles, the command registers, and something real happens on calling it,
which is more than "nothing happens"); it just means this one piece - unlike every other native
call this PoC has made - needs a real desktop session with a human at the keyboard to confirm the
happy path, something to flag honestly rather than paper over with a synthetic "it returned
`null`" result this sandbox didn't actually produce.

This round's overall shape: a write path through the sidecar ports exactly like a read path did,
with one real scoping cut (schedule re-arming) worth remembering for a real migration; a
main-process-only concern (the native dialog) ports as a main-process-only Rust command, not a
sidecar call, because that's what the real app's own architecture already says to do; and a
wrapper-only ordering bug was caught and fixed specifically *because* this PoC insists on
screenshotting real data through the real component, rather than trusting it compiles correctly.

### The actual headline case: starting and stopping a real server process

Every proof so far has been about *reading* or *writing data* - profiles, logs, console output,
even the bot and web dashboard subsystems are ultimately about moving information around. None of
it has touched the one thing a "server manager" actually exists to do: start and stop a real
server process. `lib/serverProcess.ts` (980 lines - PID tracking, RCON-confirmed graceful
shutdown with a force-kill fallback, a staggered spawn queue, crash/adoption handling) had been
completely untouched until this round.

**`startServer()`/`stopServer()`/`getStatus()` are real, unmodified, and need no Electron shim at
all.** `startServer()` does a plain `child_process.spawn(getExecutablePath(profile),
buildLaunchArgs(profile), { cwd, detached, stdio: 'ignore' })` - no `app.*`/`shell.*` coupling
anywhere in this path, confirmed by the fact that porting it needed zero additions to
`electronShim.ts`. `getExecutablePath` is already platform-aware
(`def.executableWin`/`def.executableLinux` per game, from `shared/games.ts`) - on this Linux
sandbox it resolves to each game's real `executableLinux` path (e.g.
`ShooterGame/Binaries/Linux/ArkAscendedServer` under the profile's `installDir`), so there was no
Windows-only code path to work around for this proof. Two new sidecar RPC methods
(`server.start`/`server.stop`, taking a `profileId` and resolving the real profile the same way
`profiles.copy`/`.move` already do) and three matching `main.rs` commands
(`server_start`/`server_stop`/`server_status`) are the entire port - same thin-wrapper shape as
every other subsystem in this PoC.

**No real ARK/Minecraft dedicated server binary exists in this sandbox, so standalone/compiled-app
testing needed a stand-in - the same role `console.appendTestLine` already played for log output,
now for the process side.** A test-only third RPC method, `server.installTestExecutable`, writes
a tiny long-running shell script to the real, unmodified `getExecutablePath(profile)`'s resolved
path (`#!/bin/sh` + a `sleep`-forever loop, exiting cleanly on SIGTERM like a real game server
does). Nothing about `startServer()`/`stopServer()` themselves is faked or stubbed - only the
"game server" they spawn is synthetic, exactly the same honesty boundary the console-feed proof
already drew.

**Confirmed standalone, piping JSON-RPC lines directly into the SEA sidecar binary (one
continuous session, start through stop):** `server.start` really spawns the fake script as a real
OS process - `ps` showed the exact real command line `buildLaunchArgs()` produced
(`TheIsland_WP?listen?Port=7777?RCONEnabled=True?RCONPort=27020 -server -log
-ServerPlatform=PC -WinLiveMaxPlayers=70`) running under a genuine new PID. Two `server-status`
push events arrived unprompted (`starting` with no pid, then `starting` with the real pid) -
`emitStatus()`'s own two-stage shape, reached through this sidecar exactly like
`profiles-changed`/`manager-log-entry` were. `server.stop` ran the real shutdown sequence:
`sendRconCommand(profile, 'SaveWorld')` failed immediately (no `ServerAdminPassword` on this fake
profile, so `rcon.ts` never even opens a socket) and was then correctly skipped to the
grace-period wait rather than treated as license to send `DoExit` - `waitForExitOrKill` waited out
the full `graceMs`, sent one SIGTERM, and `getStatus()` afterward (checked both via the push event
and a fresh `server.status` call) correctly reported `stopped`, confirmed independently against
the real OS process list (the pid was genuinely gone, not just marked gone in the store).

**A real bug this found in testing, not in the port:** the stand-in script's first version
ignored SIGTERM entirely (to deliberately exercise the force-kill path, or so the thinking went).
That made `stopServer()` take the full `graceMs` *plus* `FORCE_KILL_CONFIRM_MS` (10 seconds,
hardcoded in `serverProcess.ts`) to resolve - because `waitForExitOrKill`'s "force kill" is
actually just **one** `child.kill()` call (SIGTERM, Node's default signal) followed by a poll with
a 10-second give-up, not an escalation to SIGKILL. If a real game server process ever truly
ignored SIGTERM, `stopServer()` would still resolve as `stopped` after that 10-second give-up -
`finalizeStopped`/`running.delete` run unconditionally once `giveUp` fires - while the actual OS
process kept running, orphaned, outside the Manager's tracking. Real ARK/Minecraft dedicated
servers do exit on SIGTERM (this is airplane-visible AAA-game-server behavior, not something that
needs re-confirming here), so this almost certainly never happens in practice - but it's a real
property of the unmodified shutdown code, found by testing with a deliberately misbehaving
stand-in, not a flaw introduced by this port. Fixed the stand-in to exit on SIGTERM (what a real
server actually does) for the rest of this round's testing, once the finding was noted.

**Confirmed through the real compiled app, not just standalone.** Ran the actual
`tauri_poc_shell` binary under Xvfb with a temporary, immediately-reverted `setTimeout` chain in
`index.html` driving Save → Install fake executable → Start → (2s later) Stop - the same
"temporary trigger, verified on disk, reverted before commit" technique established in "A real
rendering dead end," here checking the real OS process list instead of the filesystem.
`ps aux | grep ArkAscendedServer` showed nothing at t=3s (before Start), the real spawned process
(exact real command line) at t=5s, and nothing again at t=11s (after Stop's grace period and
SIGTERM) - end to end through the real webview → `invoke()` → Rust → sidecar → `startServer()`/
`stopServer()` round trip, not just the standalone sidecar test above.

**What this doesn't prove yet, beyond "no real game server binary":** the Windows-only
`.bat`-launch path for ARK: Survival Evolved (`launchViaBatch`, untested - this sandbox is Linux
and the test profile used `ark-ascended`, which never takes that branch), and no UI page calls
any of this yet (`Dashboard.tsx`, 758 lines, is where the real Start/Stop/Restart buttons live -
out of scope for this round, which proved the RPC layer first, the same order bot/web-dashboard
were proven in before any UI). `adoptPersistedProcesses`, the staggered spawn queue, and
`watchLogFileForMarker`'s "fully started" detection - all initially on this list too - are now
proven; see directly below and "A server that actually finishes starting" further down.

**The staggered multi-server spawn queue (`reserveSpawnSlot`), confirmed with two separate
profiles and zero code changes - this is existing, already-wired behavior, not a new port.**
Seeded two profiles with their own fake executables and called `server.start` on each back to
back (real `serverAutoStartStaggerSeconds` default: 10s, left unmodified rather than overridden
for a faster test). The first server's response carried a real pid immediately, same as every
single-server test above. The second's response, by contrast, had **no `pid` field at all** -
exactly `startServer()`'s `queuedStatus` shape (`{ profileId, state: 'starting', startedAt }`,
nothing else) - and only one `server-status` push event fired at request time instead of two,
confirming it took the queued branch, not the immediate-spawn one. A second push event for the
queued server then arrived on its own, unprompted, ~10 seconds later, this time carrying a real
pid - `doSpawn()` actually running via the `setTimeout` callback `startServer()`'s queuing branch
schedules. Checked against the real OS process list to rule out a fluke in the push-event timing
alone: `ps -eo pid,lstart` showed the first server's process started at `13:52:47` and the
second's at `13:52:57` - a genuine 10-second gap between two real OS-level spawns, driven by the
*first* server's own `startedAt` (the "global, not per-profile" queue the function's own comment
describes), not by when the second request happened to arrive.

### Surviving a crash: reattaching to a server the Manager lost track of

A running ARK/Minecraft server process is deliberately `detached`/`.unref()`'d from the Manager
in `startServer()` specifically so it survives the Manager itself crashing or being force-closed
- a real reliability promise of the app, not an incidental detail. `adoptPersistedProcesses()`
(`serverProcess.ts`) is the other half of that promise: on startup, the real app re-attaches to
any pid it finds still alive in the persisted store, so a relaunch doesn't "forget" about a
server that's still running and let a user accidentally start a second instance on the same
ports. This was flagged as unproven in every earlier round of this PoC - closing it here.

**Wired in exactly where the real app wires it, adapted for this architecture's equivalent of "app
startup."** The real `index.ts` calls `adoptPersistedProcesses(profiles, getRunningPids(),
getRunningStartedAt())` once, after registering its own status watchers and before anything else
touches server state. `sidecar.ts` now calls the same real, unmodified function the same way, at
sidecar module load - the right analog, since a new sidecar process only ever starts exactly when
the real app's main process would (a fresh launch, not a page reload or webview reconnect), so
"the Manager restarts" and "a new sidecar process starts" are the same event here.
`getRunningPids`/`getRunningStartedAt` are the real, already-imported-from-the-same-file
`store.ts` functions - no new real-code imports needed beyond `adoptPersistedProcesses` itself.

**Confirmed standalone: start a server, crash the sidecar (not a graceful stop), confirm the real
process survives, start a brand new sidecar, confirm it reports `running` with zero calls to
`server.start`.** Session A seeded a profile, installed the fake executable, and called
`server.start` (real pid, confirmed as before). Session A was then killed with `SIGKILL` - not
`server.stop`, an actual simulated crash - and the fake server process was confirmed still alive
on the real OS process list immediately after. A brand new sidecar process (session B) was then
started against the same persisted store: **before even printing its own "ready" line**, it
emitted a `server-status` push event showing `state: "running"` with the exact same real pid -
`adoptPersistedProcesses` running synchronously at module load, exactly mirroring the real app's
own startup-order comment. A plain `server.status` call confirmed the same thing on request.
Calling `server.stop` from session B then exercised the *other* real code path this proof reaches
that every earlier round hadn't: `waitForExitOrKill`'s "adopted process" branch (`entry.process
=== null`, since this sidecar never spawned it - it only inherited the pid), which polls
`isPidAlive`/calls `killByPid` instead of using `child.kill()`/a `child.once('exit', ...)`
listener. That path ran correctly too: the real OS process was confirmed gone afterward.
Reproduced identically against both the dev bundle (`node dist/sidecar.cjs`) and the real SEA
binary (`dist/sidecar-bin`) - not just one packaging mode.

**Confirmed through the real compiled app, not just standalone - a genuine "kill the whole app,
relaunch it" test, not a simulation of one.** Using the same temporary-`setTimeout`-trigger,
reverted-before-commit technique as the server start/stop proof above: app instance #1 (Save →
Install → Start) was launched under Xvfb, confirmed via the real process list to have spawned the
fake server, then killed outright with `SIGKILL` - not just the sidecar this time, the whole
`tauri_poc_shell` process tree, actually simulating a Manager crash rather than a graceful close.
The fake server process was confirmed still alive afterward (reparented to init, `ps` showing its
real ppid changed). A second, completely fresh app instance (#2) was then launched against the
same on-disk profile store, with a different temporary trigger (`server_status` then
`server_stop`) - by the time it was checked, the real OS process was gone, meaning the real
webview → `invoke('server_status')`/`invoke('server_stop')` → Rust → the brand-new sidecar's own
`adoptPersistedProcesses` → real `killByPid` chain all ran correctly, end to end, through two
genuinely separate app processes sharing only the same on-disk store - not two RPC calls against
one long-lived sidecar, which is what every other proof in this PoC so far has actually been
testing.

### A server that actually finishes starting

Every server-lifecycle proof so far left status stuck at `starting` forever, by design: the fake
stand-in executable never wrote anything resembling a real ARK engine log, so
`watchLogFileForMarker()` - the real function that watches for the exact line
(`"Server has completed startup and is now advertising for join"`) a real server writes once it's
actually done loading, and flips status to `running` - never had anything to find. That was
flagged honestly each time as a real gap, not quietly accepted as permanent: a real server
*does* write that line, so there was an honest way to simulate it after all, the same way
`console.appendTestLine` already simulates realistic log output elsewhere in this PoC.

**`server.installTestExecutable` gained an opt-in `withStartupMarker` flag** (plumbed through the
matching `server_install_test_executable` Tauri command too). When set, the generated stand-in
script does two additional things a real ARK server's own launch already does: creates its log
file immediately on startup (empty), then - a few seconds later, from a backgrounded subshell -
appends the real startup-complete line to it. `watchLogFileForMarker()`/`markReady()` themselves
are untouched; only the test fixture that feeds them changed.

**A real ordering bug was found and fixed in the test fixture itself, not in the port.** The
first version appended the marker line to the log file without creating it first.
`watchLogFile()`'s own polling logic treats its *first* successful read of a file as nothing more
than a size baseline (see its own comment on this) - never calling back with "new" content on
that first tick, by design, so a Manager restart doesn't treat a server's entire pre-existing log
as a flood of brand-new lines. That meant a marker line present the very first time the file was
ever seen got silently absorbed into that baseline and never reported as a chunk at all. A real
ARK server could never trigger this - its log exists and is already growing well before the
startup-complete line appears in it - so this was purely an artifact of the fake script creating
the file and writing the marker in the same instant. Fixed by having the script create the
(empty) log file immediately and append the marker only after a delay, matching a real server's
actual shape and giving `watchLogFile` an earlier, uneventful baseline tick to work from first.

**Confirmed standalone: the real `starting` → `running` transition, driven by the real marker
detection, not a timeout.** Seeded a profile, installed the fixture with the marker flag set, and
called `server.start`: the usual two `server-status` push events arrived immediately (`starting`,
then `starting` with a real pid), then a **third**, unprompted, about four seconds later -
`state: "running"`, same pid - `watchLogFileForMarker()` detecting the real log line
`watchLogFile`'s own 2-second poll tick picked up and calling the real `markReady()`. Confirmed
independently by reading the fake server's own log file afterward: it contained exactly the one
real startup-complete line the script wrote. `STARTUP_FALLBACK_MS` (`serverProcess.ts`'s own
safety net for a server that never logs a recognizable startup line - 5 minutes) was not
separately re-timed - 300 real seconds of idle waiting to confirm a plain `setTimeout` fires on
schedule wouldn't have told this PoC anything a close reading of the unmodified constant doesn't
already say with the same confidence.

**Confirmed through the real compiled app too**, using the same temporary-trigger-under-Xvfb
technique as every other server-lifecycle proof: `server_install_test_executable` was called with
the marker flag through the real webview → `invoke()` → Rust → sidecar chain, and the real fake
server's log file was confirmed, a few seconds after Start, to contain the real startup-complete
line - end to end through the actual compiled app, not just the standalone sidecar test above.

### A third real page, in a different subsystem: player management

Every page ported so far has been about profiles (read-only logs, then copy/move). Player
management is a genuinely different real domain - a live RCON-driven roster plus the Manager's
own persisted ban/whitelist records - backed by three separate real IPC modules
(`ipc/playerRoster.ts`/`playerBans.ts`/`playerWhitelist.ts`) this PoC had never touched.
`PlayerRosterPanel.tsx` (198 lines) was picked specifically because it mixes both shapes in one
page: `playerRoster.list`/`.kick` and `playerBans.ban` all gate on a real `sendRconCommand()` call
succeeding first, while `playerWhitelist.add` is tracking-only and never touches RCON at all (see
that file's own doc comment on why) - a real, fully successful write every time, next to three
real, honestly-RCON-gated ones.

**The port is the same thin-wrapper shape as every other subsystem in this PoC, applied to a
third real file.** Four new sidecar RPC methods (`playerRoster.list`/`.kick`,
`playerBans.ban`, `playerWhitelist.add`) each mirror their real `ipc/*.ts` handler's body exactly
- same real functions (`sendRconCommand`, `parsePlayerListWithIds`, `recordPlayerBan`,
`recordWhitelistedPlayer`, all imported unmodified), same order, same success/failure shape -
and four matching `main.rs` commands. `confirmAction()` (the real, unmodified
`lib/confirmAction.ts` every Kick/Ban/Whitelist-adjacent action in the real app calls before
acting) needed one more real native command: `window.api.system.focusWindow()`, backing the real
Electron/Windows focus-loss workaround (`lib/windowFocus.ts`'s `forceRefocus()`) - ported as
`window_focus`, a Rust-only command with no sidecar involvement (same architectural class as
`dialog_select_directory`: a window-handle operation, not business logic), replicating
`forceRefocus()`'s own real minimize-then-unminimize-then-focus sequence via Tauri's window API
rather than a no-op stub.

**Confirmed standalone: a real successful write, and two real, honest RCON failures - not three
stubs with different labels.** `playerWhitelist.add` against a seeded fake profile produced a
real `recordWhitelistedPlayer()` write, confirmed independently by reading the real
`config.json`'s own `playerWhitelist` array afterward (real `addedAt` timestamp, real
`profileIds`). A follow-up `playerWhitelist.list` call confirmed it persisted. `playerRoster.list`
against the same profile returned `[]` - not an error - exactly matching the real handler's own
`result.ok && result.response ? parsePlayerListWithIds(result.response) : []`: RCON genuinely
failed (no `ServerAdminPassword` on this fake profile, `rcon.ts` never opens a socket), and the
real handler's own graceful-degradation shape swallowed that into an empty roster rather than
throwing. `playerBans.ban` against the same profile, by contrast, *did* throw - its own real gate
requires the RCON call to succeed before it ever reaches `recordPlayerBan()` - producing the exact
same `"No ServerAdminPassword set in this server's GameUserSettings.ini"` message `stopServer()`'s
RCON `SaveWorld` attempt already surfaced in an earlier round. Three different real outcomes from
three real code paths, not one simulated behavior repeated three times.

**Confirmed through the real compiled app too, including a real limitation worth stating
honestly.** Seeded the same profile, pointed the main window at `player-roster.html` directly
(the same technique as the other two real-page proofs) and screenshotted under Xvfb: the real,
unmodified component rendered a real server card - "POC Test Server (0)" - "No players connected
right now.", the exact same graceful-empty-roster outcome the standalone test already produced,
now through the genuine webview → `invoke()` → Rust → sidecar chain. **The real Kick/Ban/Whitelist
buttons themselves were not reachable this way** - they only render inside a live roster row,
and a live roster row only exists when RCON actually returns connected players, which needs a
real ARK server this sandbox fundamentally cannot provide (the same category of gap as the native
folder picker's happy path). Rather than leave that corner unconfirmed, a temporary
invoke-directly trigger (same revert-before-commit discipline as every other temporary trigger in
this PoC) called `player_whitelist_add` straight through the real webview, bypassing the
unreachable UI row - and the real `config.json` gained the real new entry afterward, confirming
the Rust-level plumbing specifically (not just the sidecar logic the standalone test already
covered) reaches the real store write end to end.

### A fourth real page, and a correction to "A rendering dead end"

`PlayerWhitelistPanel.tsx` (179 lines) was picked specifically because it's the first page in
this PoC whose real write-path buttons are reachable with **no** RCON, no live server, nothing
this sandbox can't provide - `list`/`add`/`remove` are a plain centralized, tracking-only
electron-store CRUD (see that file's own doc comment on why it never touches RCON, unlike
`PlayerBansPanel.tsx`'s parallel page). That made it the first real opportunity all PoC to
actually test *clicking through the real rendered form itself*, rather than falling back to a
direct `invoke()` bypass the way every previous write-path proof in this PoC (including the one
immediately above) ultimately had to.

**`playerWhitelist.remove` (plus a `playerWhitelist.list` Tauri command the earlier round never
needed) is the only new real-code surface this page needed** - `list`/`add` were already proven
in "A third real page." `removeWhitelistedPlayerProfile()` is called exactly as the real handler
calls it. Standalone, a full real CRUD cycle (list → add → list confirms it → remove → list
confirms it's gone) ran cleanly against the SEA binary, no new ground beyond what the previous
round had already shown for `add`.

**A real correction to "A rendering dead end," found by accident while confirming this page's
write path.** A temporary script (revert-before-commit, as always) drove the real, unmodified
form through genuine DOM APIs: the native `HTMLInputElement` value setter + a dispatched `input`
event (the standard way to make a controlled React input see a programmatic value change), a real
`checkbox.click()`, and a real `button.click()` found by its exact text. The real `onClick`
handler fired, called the real `window.api.playerWhitelist.add` -> real `invoke()` -> Rust ->
sidecar -> `recordWhitelistedPlayer()` chain, and **the screen visibly updated to show it**: two
screenshots taken a second apart showed the same real post-add state - the form's inputs cleared,
the checkbox unchecked, and a real new row in the "Whitelisted (1)" table with the real entered
id/name and a real timestamp. That directly contradicts "A rendering dead end"'s own
conclusion - and that section had *already* ruled out input-simulation as the variable (its own
step 3 used a `setTimeout`-triggered save, not a simulated click, and still saw no repaint), so
"xdotool vs. a real DOM method" isn't a sufficient explanation either; this round's trigger used
the same `setTimeout` + same-origin JS approach that round already tried and found didn't help.
What's actually different between the two tests - this page vs. `index.html`, this round's exact
Xvfb invocation vs. that one's, or something else entirely - hasn't been isolated, and this
README won't guess at a root cause it didn't actually verify. What's now owed an honest update is
the conclusion itself: "WebKitGTK never repaints after the first frame in this sandbox" is **not
a safe assumption going forward** - it held for one specific test and was stated more broadly
than the evidence supported. Future rounds of this PoC should screenshot again after a write,
rather than assuming it is futile.

**Later update - the actual difference, found in "A fifth real page" (further down): this page's
write path never went through `listen()` at all.** `playerWhitelist.add`'s result reaches the
screen through the click handler's own `window.api.playerWhitelist.add(...)` → `invoke()` →
`.then(setState)` chain - an ordinary request/response round trip, same as any other button click
in this PoC. `index.html`'s `pushStatusEl` update in "A rendering dead end," by contrast, only
ever happens inside a `listen('profiles-changed', ...)` callback - a push event delivered
unprompted, outside any click. Those are genuinely different code paths, and only the second one
was broken: `src-tauri/capabilities/` didn't exist anywhere in this PoC until that round, so
every `event.listen()` call (and only `event.listen()` - plain `invoke()` calls were never
ACL-gated) was being silently rejected. This page's repaint always worked because it was never
exercising the broken path in the first place - not because WebKitGTK's repaint behavior was
inconsistent between the two tests. (One unrelated cosmetic wrinkle in this round's screenshot:
the new row's Name/Id cells rendered visually blank while `On`/`Since` didn't - likely a quirk in
this PoC's own hand-written approximate CSS for this one page, not a defect in the real
component, since the underlying data was independently confirmed correct via the real
`config.json` file regardless.)

### Measured, on this Linux sandbox

- Release binary (`src-tauri/target/release/tauri_poc_shell`): **11 MB**, vs. `node_modules/electron`'s 266 MB.
- Sidecar bundle (`sidecar/dist/sidecar.cjs`, includes `electron-store` and its deps): **392 KB**.
- Idle RSS: shell **~145 MB**, Node sidecar **~48 MB** (~193 MB combined), measured via
  WebKitGTK with software rendering (no GPU passthrough in this sandbox - `libEGL warning: DRI3
  error`). **Do not take this as the Windows number** - WebView2 on Windows shares the
  system Edge/Chromium runtime already installed on the machine rather than embedding its own
  copy the way Electron does, and runs with real GPU acceleration on real hardware; both cut
  against this measurement in opposite, hard-to-predict ways. The disk-size comparison above is
  solid regardless of platform; the RAM comparison needs a real Windows run to mean anything.

### Sidecar packaging (Node SEA)

The dev setup above (`SIDECAR_PATH` pointing at `dist/sidecar.cjs`, run via `node`) was always
flagged in this README as "not how a shipped build would locate it" - this is that gap closed,
at least on Linux. Node's own SEA (Single Executable Applications) feature, stable since Node
20 and confirmed present here on Node 22.22.0, bundles the Node runtime itself plus
`dist/sidecar.cjs` into one standalone executable:

```sh
node --experimental-sea-config sea-config.json   # writes dist/sea-prep.blob
cp "$(command -v node)" dist/sidecar-bin
npx postject dist/sidecar-bin NODE_SEA_BLOB dist/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```
(scripted as `build-sea.mjs`, run after `build.mjs`).

**Confirmed working, not just built:** piping a raw JSON-RPC line into the resulting
`dist/sidecar-bin` directly (no `node` invocation) returned a correct `profiles.list` response.

**The honest tradeoff this surfaces:** `dist/sidecar-bin` is **~119 MB**, because it embeds a
full copy of the Node runtime (the `node` binary on this machine is ~123 MB; the SEA blob adds
~400 KB on top of that for the actual application code). That's not a packaging inefficiency to
fix later - it's the actual cost of "no `node` needed on the target machine," here or with any
other approach (a bundled portable Node runtime next to a plain `.cjs` would cost the same
~120 MB, just as two files instead of one). Combined with the 11 MB shell, that's **~130 MB**
total for this one sidecar - still well under Electron's 266 MB, but nowhere near the "11 MB
shell + 392 KB sidecar" numbers above might imply on their own if read without this section.
Two sidecars built this way (main process logic, bot - see "The Discord bot subsystem" below),
each embedding its own full Node copy, would start to erode the size advantage this whole
migration is supposed to deliver - worth weighing against a single shared sidecar process
serving both roles instead of one SEA binary per role. The web dashboard turned out not to add
a third: see "The web dashboard subsystem" below - it's an in-process `http.Server`, not a
separate process, so it rides along in the main sidecar's own SEA binary for free.

### Wired into Tauri's real `externalBin` mechanism, not just spawned by path

The SEA binary above was initially spawned with a hand-rolled `std::process::Command` pointed
at a source-tree path - functional, but explicitly flagged as not the real packaging mechanism.
That gap is now closed: `main.rs` spawns the sidecar through `tauri-plugin-shell`'s actual
sidecar API (`app.shell().sidecar("sidecar-bin")`, added as a dependency), and
`tauri.conf.json` declares `bundle.externalBin: ["binaries/sidecar-bin"]` - the real,
documented mechanism for shipping a non-Rust helper binary inside a Tauri app. `build-sea.mjs`
now also copies its output to `src-tauri/binaries/sidecar-bin-<target-triple>` (queried via
`rustc -vV`'s `host:` line), the exact filename convention Tauri's build script requires.

Rewriting the Rust side for this meant swapping the manual `Child`/`ChildStdin`/`BufReader`
plumbing for the plugin's own `Command`/`CommandChild`/`CommandEvent` types - a different API
shape (`CommandEvent::Stdout`/`Stderr`/`Error`/`Terminated` arrive over an async
`tauri::async_runtime::Receiver` instead of a blocking `BufReader::lines()` iterator on a
dedicated thread), but the same JSON-RPC protocol underneath, so `sidecar.ts` needed no changes
at all.

**Confirmed, not just compiled:** rebuilt and ran the app under Xvfb again with this change in
place. `pstree` showed the same result as before - `sidecar-bin` as a direct child of
`tauri_poc_shell`, no `node` anywhere - but this time resolved through the real `externalBin`
path instead of a hardcoded one. The read path was re-confirmed via the "Got 0 profile(s)..."
screenshot. The write + push path was re-confirmed the same way as the original write+push
verification: a temporary `setTimeout`-triggered save (reverted before committing, same
technique as the original "rendering dead end" investigation below), checked against the
on-disk store file - the full real `saveProfile()` migration/defaulting pipeline ran and wrote
correctly through this new transport, with no errors in the sidecar's inherited stderr.

**Still open:** `SIDECAR_PATH` dev iteration now goes through `app.shell().command("node")`
instead of a raw `Command::new("node")` - same idea, different API, not separately
stress-tested beyond compiling and being structurally identical to the `sidecar()` path above.
Code-signing and auto-update remain completely untouched. The actual bundling step
(`cargo tauri build`) is covered next - it found a real bug `cargo build` never could.

### Actually bundled and installed with `cargo tauri build` - and a real bug it found

Everything above was still `cargo build` + running the raw binary from `target/debug/` - never
the real packaging command, and never a real install. That gap is closed too: installed the
`tauri-cli` (`cargo install tauri-cli --version "^2.0.0"`), set `bundle.active: true` and
`bundle.targets: ["deb"]` in `tauri.conf.json` (plus `bundle.icon`, which Tauri's bundler
requires explicitly - the dev-mode `cargo build` path never asked for it), and ran
`cargo tauri build --bundles deb`.

**It worked, genuinely**: a 44.5 MiB `.deb` came out, and `dpkg --contents` confirms the sidecar
binary is really inside it as an ordinary installed file, not just referenced:

```
usr/bin/tauri_poc_shell      14.9 MB
usr/bin/sidecar-bin         123.9 MB   <- the SEA binary, renamed from sidecar-bin-<triple>
usr/share/applications/tauri-poc-shell.desktop
usr/share/icons/hicolor/256x256/apps/tauri_poc_shell.png
```

Installed it for real with `dpkg -i` (not just unpacked - a real `apt`/`dpkg` install,
registered in the package database) and ran `/usr/bin/tauri_poc_shell` directly, from `/tmp`,
with none of this PoC's source tree on the path anywhere.

**It crashed on first launch.** Not a cosmetic issue - the sidecar died immediately:

```
Error: Project name could not be inferred. Please specify the `projectName` option.
    at new Conf (dist/sidecar.cjs:10010:19)
    at new ElectronStore (dist/sidecar.cjs:10437:9)
```

This is exactly the kind of thing this whole PoC methodology exists to catch: every earlier
check in this README ran the sidecar from inside the source checkout, where `conf` (the package
behind `electron-store`) could silently find *some* `package.json` nearby and infer a project
name from it when its own Electron-detection failed over to that fallback - the "harmless for
this PoC" wrinkle already documented under "Findings" below. Once genuinely installed to
`/usr/bin`, with no `package.json` anywhere nearby, that fallback has nothing to find and
throws instead of silently working. The gap between "runs from a checkout" and "runs once
installed" was real, and only running the actual installed binary surfaced it.

**Root cause, traced into `electron-store`'s own source** (`node_modules/electron-store/index.js`):
its constructor only uses `app.getPath('userData')` as the data directory when **both**
`ipcMain` and `app` are truthy (`else if (ipcMain && app) { defaultCwd = app.getPath('userData') }`) -
otherwise `cwd` is left `undefined` and `conf` falls through to its own broken inference.
`electronShim.ts` only ever exported `app`, never `ipcMain`, so that branch was always being
skipped - the shim's `getPath('userData')` value was being computed correctly and then never
used, every single time, including in every earlier check in this README that happened to still
work.

**Fixed entirely inside `electronShim.ts` - no change to the real `store.ts` needed**: added a
minimal `ipcMain` stub (just a no-op `.on()`, enough to satisfy `electron-store`'s own internal
`ipcMain.on('electron-store-get-data', ...)` registration) and an `app.getVersion()` stub
(also called in that same code path). That's the one-line condition electron-store actually
checks - once `ipcMain` exists, it takes the `app.getPath('userData')` branch as intended, and
the separately-documented "electron-store's own fallback" wrinkle is now also fully resolved as
a side effect, not just "harmless."

**Confirmed, not just patched**: rebuilt, reinstalled the `.deb` (`dpkg -i` over the broken one),
and reran `/usr/bin/tauri_poc_shell` from `/tmp` again. Clean `sidecar: ready`, no errors. Both
the read path (screenshot, `Got 0 profile(s)...`) and the write + full migration pipeline
(temporary `setTimeout` trigger, reverted before committing, checked against
`~/.tauri-poc-bober-manager/config.json`) were re-verified against the actually-installed
binary, not the dev build.

### A fifth real page: wiring the real Start/Stop/Restart/Kill/Update buttons

"The actual headline case" above proved `startServer()`/`stopServer()`/`getStatus()` at the RPC
layer but left a gap open on purpose: "no UI page calls any of this yet." This round closes it -
`Dashboard.tsx` (`src/renderer/src/pages/`, 758 lines), completely unmodified, is now mounted for
real and its Start/Stop/Restart/Kill/Update buttons drive a real OS process through a click, not
through the RPC layer directly.

**The orchestration layer underneath is a different, more complete real file than the one "The
actual headline case" called directly.** The real desktop IPC handler
(`ipc/serverProcess.ts`) doesn't call `serverProcess.ts`'s `startServer()`/`stopServer()`
directly either - it goes through `lib/serverActions.ts`'s `doStartServer`/`doStopServer`/
`doRestartServer`/`doKillServer`/`doUpdateServer`, which wrap those calls with the CPU/RAM/
player-list monitor (`lib/monitor.ts`), crash-watch cancellation (`lib/crashWatch.ts`), and a
Manager activity-log entry for every action. None of that was exercised by the earlier round at
all - `sidecar.ts`'s `server.start`/`server.stop` now call `doStartServer`/`doStopServer`
instead, and gained `server.restart`/`server.kill`/`server.update` alongside them, all real,
unmodified functions, mirroring the exact call chain the real `ipc/serverProcess.ts` handler
uses. `doUpdateServer` calls the real SteamCMD `updateServer()`, which fails fast and honestly
("Set the SteamCMD path in Settings before updating.") with no real SteamCMD in this sandbox -
the same category of honestly-gated path as the RCON-dependent player-management calls.

**Confirmed standalone first, including a real subsystem this PoC had never touched: the CPU/RAM
monitor.** Piped JSON-RPC directly into the SEA binary: `server.start` on a stand-in executable
with the real startup-complete marker (same fixture as "A server that actually finishes
starting") produced the real `starting` → `running` transition, and ~5 seconds later - the
monitor's own 5-second self-rescheduling tick - a real `server-status` push arrived with
`cpu`/`memoryMB`/`memoryPercent` populated from a genuine `pidusage` read of the spawned PID, and
`players: []` from `listPlayers()`'s real RCON-failure fallback (no RCON server exists here
either). `server.restart`/`server.kill` were confirmed the same way, including a correctly
guarded `server.update` rejection ("Stop the server before updating it." while running, the real
SteamCMD-path error once stopped).

**`Dashboard.tsx` itself takes `profiles`/`statuses`/`maps`/`staticInfo`/`installedById`/
`gameVersionById`/`refreshInstalled` as plain props** - `App.tsx` owns and lifts all of that so
it survives Dashboard's own unmount/remount on every server-detail visit (see its own doc
comments). `dashboard-entry.tsx`'s wrapper stands in for that slice of `App.tsx` specifically:
`installedById`/`gameVersionById`/`refreshInstalled` are left empty/no-op (they only affect the
Update button's label and a version string, not the actual action), and the "+ Add Profile"
wizard stays out of scope (same native-folder-picker gap as "A second real page"). `maps` is a
one-entry stand-in, not real `maps.json` data. `staticInfo` and `HardwareStatsBar`'s network
figures are real, though - pulled through two new commands (`system_stats_get_static_info`/
`system_stats_get_network_usage`) backing the real, previously-untouched `lib/systemStats.ts`
(a fourth subsystem from the original Electron-coupling survey below, confirmed sidecar-portable
like the other three).

**esbuild has no default loader for the binary assets this page is the first to import.**
`Dashboard.tsx`/`HardwareStatsBar.tsx`/`lib/gameIcons.ts` import `.png` icons directly - no
earlier page in this PoC did - and a plain `esbuild` build failed outright with `No loader is
configured for ".png" files`, something the real app's own Vite build handles transparently.
Fixed in `build-react.mjs` with `loader: { '.png': 'dataurl' }`, inlining each icon as a base64
data URI in the page's own bundled `.js` rather than introducing a second kind of build output
(loose files) for one page.

**A real gap found and fixed in the wrapper, not the real code: `useServerStatuses`.** A first
version of `dashboard-entry.tsx` hand-rolled its own `statuses` state from nothing but the
`server-status` push listener - and a server adopted from a still-alive previous run (see
"Surviving a crash") showed as permanently "stopped" even though the real process was running.
Root cause: `adoptPersistedProcesses()` emits its one-time `running` status at sidecar startup,
well before the webview has finished loading and attached any listener - a push with no replay,
missed by construction. The real `App.tsx` doesn't have this bug because it never relies on the
push alone: `lib/useServerStatuses.ts` (32 lines) also pulls `window.api.server.status(id)` once
per profile on mount. Swapping in that real, unmodified hook (adding `server.status`/
`onStatusChanged` to the `window.api` shim) fixed it - confirmed by killing just the Tauri app
process (not the server, which survives detached - see "Surviving a crash"), relaunching, and
screenshotting a freshly-opened window that correctly showed "running" with the real uptime
immediately, no push required.

**Confirmed end to end through the real compiled app: a real click spawns and kills a real OS
process.** Seeded a profile and the real stand-in executable (with a startup marker) into the
same `~/.tauri-poc-bober-manager/config.json` this PoC's own standalone sidecar tests and the
real packaged app both read (same data directory, same file - `electronShim.ts`'s
`POC_USER_DATA`), then launched the real compiled app under Xvfb with a temporary auto-click
script (reverted before committing - see "A rendering dead end" below for why a real
`element.click()`, not `xdotool`, is this PoC's established technique). The real Start button's
`onClick` → `window.api.server.start` → `invoke('server_start')` → the real `doStartServer` chain
produced a real OS process, confirmed via the actual process list (`ps aux`), with the card
correctly showing `running`, the real uptime, and real `cpu`/`memoryMB` figures a few seconds
later via the monitor's own push. The real Stop button, clicked on a separately re-launched app
instance that re-adopted the still-running process, correctly showed `stopping` immediately and
then `stopped` ~15 seconds later (the real `stopServer()` default `graceMs`, with no RCON to
respond to `SaveWorld`/`DoExit`) - confirmed by the process actually disappearing from `ps aux`
at that point, not just the badge changing.

**Found and fixed a gap in the PoC's own Tauri setup, not in the real app: no `capabilities/*.json`
file existed anywhere in `src-tauri/`, at all, until this round.** Debugging why the real Stop
button's `server-status` push (see above) never visibly updated the UI - initially suspected to
be the same WebKitGTK repaint question as "A rendering dead end" below - a bare
`window.__TAURI__.event.listen(...)` call, written directly into `dashboard.html` with its
promise's resolution/rejection made visible in a plain `<div>` (bypassing React entirely, to rule
out a repaint problem specifically), came back **rejected**: `event.listen not allowed.
Permissions associated with this command: core:event:allow-listen, core:event:default`. Tauri 2's
permission system denies every core-plugin-exposed JS API - `event.listen` among them - unless a
capability file explicitly grants it; this PoC had never created one. Custom `#[tauri::command]`
functions (every `invoke(...)` call this whole PoC has made) are **not** ACL-gated the same way,
which is exactly why none of them ever surfaced this: `profiles_list`, `server_start`, all of it,
worked from the very first round regardless. `listen()` is the one JS-visible API this PoC uses
that goes through a plugin, not a custom command - and it was being silently rejected the entire
time. Fixed with one new file, `src-tauri/capabilities/default.json`, granting `core:default`/
`core:event:default`/`core:window:default` to the `main` window. Confirmed the fix is real, not
just locally plausible, by re-running the *exact* scenario "A rendering dead end" originally
documented as unrepaintable - `index.html`'s own `listen('profiles-changed', ...)` handler,
triggered by a real click on "Save a test profile" - and this time the page visibly updated live:
"Live update received via 'profiles-changed' push event (2 profile(s)) - not from a button
click." See the correction note added to that section below; this explains the original finding
far better than a WebKitGTK compositing limit does.

**Two follow-ups, confirmed in a later session.** First, the live console feed
(`listen('console-line', ...)`) had only ever been confirmed standalone (see "The live console
feed" above) - re-tested through the real webview now that the capabilities fix is in place
(start watching, wait a poll tick, simulate a line), and it updates live on screen too, closing
the one push-event type in this PoC that was still only standalone-confirmed. Second, the two
pieces of `Dashboard.tsx`'s own UI this round deliberately left unclicked that don't actually
need a native dialog - the card menu's Group submenu and a group's own bulk Start/Stop buttons -
got the same real-click treatment: `setProfileGroup` (a real `profiles.save` write) moved the
real seeded profile into the already-registered "PoC Group" through the real dropdown, and that
group's `startAll`/`stopAll` (the same `window.api.server.*` calls the single-card buttons use,
mapped over the group's members) spawned and killed the real OS process exactly like the
single-card round did - confirmed the same way, `ps aux` and the status badge agreeing. One
practical lesson from building the test script itself: `document.querySelector('.server-card-v2')`
picks whichever profile happens to render first, not a chosen one - worth remembering for any
later round that scripts a click against "the" card rather than a specifically identified one.

**A third follow-up, in the same later session: drag-to-reorder.** Seeded a second ungrouped test
profile (the existing two were down to one ungrouped card each, after the group-assignment
follow-up above, and reordering a one-item list proves nothing) and dispatched real
`DragEvent('dragstart')`/`DragEvent('dragover')`/`DragEvent('drop')` directly on the two card DOM
nodes - a `DataTransfer` object is required to even construct a `DragEvent`, but
`Dashboard.tsx`'s own handlers never read it, only a `dragId` kept in component state via
`onDragStart`, so this needed no special handling. The real `onDrop` → `handleDrop` →
`window.api.profiles.reorder` → `invoke('profiles_reorder')` → the real `setProfileOrder()`/
`reorderProfiles()` chain fired correctly: the two cards visibly swapped on screen, and -
checked independently, not just trusted from the screenshot - `config.json` on disk shows the
same swapped order afterward. This was the last piece of `Dashboard.tsx`'s own UI flagged as
unattempted; see the updated "What this doesn't prove yet" entry above for what's left in this
PoC overall (two items now, both needing a real desktop session/Windows machine this sandbox
can't provide, not further sandboxed testing).

### A sixth real page, and a PoC-wide bug in how errors cross the Tauri bridge

`AnalyticsTab.tsx` (`src/renderer/src/pages/ServerDetail/`, 321 lines) was picked specifically
because it pulls together five real subsystems in one page, none of them touched by this PoC
before: `lib/statsHistory.ts` (the **read** side of the CPU/RAM/player history `monitor.ts`'s
`recordStatSample` already writes - see "A fifth real page" above - proving the write-then-read
round trip, not just the write), `lib/schedule.ts`'s `getBackupScheduleStatus` (the Backup
Status panel), `lib/steamcmd.ts`'s `getInstalledBuildId` and `lib/serverVersion.ts`'s
`getGameVersion` (mirroring the real `ipc/serverProcess.ts` handlers' own cache-then-live-read
order exactly), `lib/updateCheck.ts`'s `getLatestBuildIdCache` (a pure cache read backing the
nested `UpdateCheckPanel` component), and three more `lib/systemFolders.ts` functions (the same
`shell.openPath` round trip `openProfilesFolder` already proved, three more real call sites of
it). None of them are Electron-coupled.

**Confirmed standalone first, including a genuine write-then-read round trip.** Piped JSON-RPC
into the SEA binary: enabled `statsEnabled` on a seeded profile, started the real stand-in
executable, and after the monitor's own 5-second tick, `statsHistory.get` returned the exact
real samples `recordStatSample` had just written - `cpu`/`memoryMB`/`players`, real timestamps,
nothing synthesized for the read side.

**Found and fixed a real wiring gap doing the same for `backup.getScheduleStatus`: it reported
`{ active: false }` even with a running server and a real cron schedule saved.** Unlike every
other push source in this PoC, `lib/schedule.ts`'s own `serverEvents.on('status', ...)`
subscription is **not** a module-load side effect - it only happens once
`registerBackupScheduleWatcher()` is actually called, the same real `index.ts` startup-order
requirement `adoptPersistedProcesses()` already has. Importing `getBackupScheduleStatus` alone
left nothing ever subscribed to real status transitions. Fixed by calling
`registerBackupScheduleWatcher()` once at sidecar startup (same place as
`adoptPersistedProcesses()`), and by adding `applyBackupSchedule(profile)` to `sidecar.ts`'s
`profiles.save` - the real `ipc/profiles.ts` handler calls it too, and this PoC's own
`profiles.save` had never needed it before now. Re-confirmed standalone: with both fixes,
`backup.getScheduleStatus` correctly reports `{ active: true, nextRunAt: <real cron next-fire
time> }` once the server transitions to `running`.

**Confirmed through the real compiled app**, pointing the main window at a new `analytics.html`
(same temporary-`tauri.conf.json`-`url` technique as every other page): the real form rendered
with real data throughout - the real CPU model/RAM figures carried over from `systemStats.ts`,
the real two recorded stats samples, "Enable stats" genuinely checked (the real
`profile.statsEnabled`), and `UpdateCheckPanel`'s own honest `"Checking..."` state (correctly
stuck there forever in this sandbox, since nothing here ever arms the real background SteamCMD
poller that would populate `getLatestBuildIdCache` - the same category of honestly-unconfirmable
gap as the native dialog's happy path, not a bug).

**The actual headline finding of this round: Tauri's `invoke()` does not reject with an
`Error`.** Clicking the real "INI Config" file-shortcut button (no real config folder exists for
this test profile) correctly reached the real, unmodified `openServerConfigFolder()` and
correctly rejected with its real message - confirmed directly against
`window.__TAURI__.core.invoke()`, bypassing React entirely, specifically to rule out a repaint
question first (see "A rendering dead end"/"A fifth real page" above for why that was the first
suspect). But the real component's own `{configFolderError && <p className="error-message">
{configFolderError}</p>}` display never appeared on screen. Traced to the exact type: Tauri's
`invoke()` rejects a Rust `Err(String)` with the **bare string itself**, not an `Error` instance
- confirmed with `typeof err === 'string'`, `err instanceof Error === false`,
`err.message === undefined`. Every real component in this app was written against Electron's
`ipcRenderer.invoke()` convention instead, where a rejection **is** a real `Error` - the
universal `catch (err) { setX((err as Error).message) }` pattern used across the whole real
renderer (this exact page's `configFolderError`, `Dashboard.tsx`'s `actionErrors`,
`ProfileManagementView`'s import error, ...) silently reads `undefined` on a Tauri rejection
instead of throwing or warning. No earlier round had actually clicked a real button through to a
real failure and checked the screen for the error text - every earlier error path was either
confirmed at the raw RPC/`invoke()` level only, or happened to be a success path on screen.

**Fixed once, centrally, not by touching the real components.** Added
`frontend/lib/tauriInvoke.ts`, a five-line `wrapInvoke()` that catches a non-`Error` rejection
and re-throws a real `Error` with the same message - applied to **every** entry file in this
PoC (`const invoke = wrapInvoke(window.__TAURI__.core.invoke)` in place of the old
`const { invoke } = window.__TAURI__.core`), not just this round's new one, since the gap was
always there in all five earlier pages' shims, just never exercised. Re-confirmed through the
real app: the same "INI Config" click now shows the real error text, in red, exactly where the
unmodified component puts it. A real migration would make this same fix once, at the transport
layer `invoke` is imported from, rather than touching every individual `catch` block in the real
renderer - which is exactly what this fix does.

### A seventh real page: world/player backups, the heaviest write path yet

`BackupsTab.tsx` (`src/renderer/src/pages/ServerDetail/`, 342 lines) was picked because it's the
heaviest real write path this PoC has ported: `createBackup()` really sends an RCON `SaveWorld`
when the server is running, waits a real 40-second settle, then zips real files off disk with
`archiver`; `restoreBackup()` really extracts a real zip straight over `SavedArks` with
`adm-zip`. It also mounts two more real, unmodified child components itself -
`PlayerBackupsSection.tsx` and `BackupLogPanel.tsx` - neither needed its own entry file, both
just call the same `window.api.backup`/`window.api.playerBackup` methods `BackupsTab` already
calls. Nine new sidecar RPC methods (`backup.create`/`.list`/`.delete`/`.restore`/`.openFolder`/
`.getLog`, `playerBackup.listFolders`/`.list`/`.openFolder`) each mirror their real
`ipc/backup.ts`/`ipc/playerBackup.ts` handler's body exactly - same real `lib/backup.ts`/
`lib/playerBackup.ts` functions, same `requireProfile`-then-call shape - plus two more push
events (`backup-created`/`backup-log-entry`, wrapping `lib/backup.ts`'s own `backupEvents`
`EventEmitter`, the same module-level-subscription shape as `profileEvents`/`managerLogEvents`/
`serverEvents` - no explicit "arm" call needed here, unlike `lib/schedule.ts`'s own subscription).

**Confirmed standalone first, a full real write cycle - not a single call in isolation.** Piped
JSON-RPC straight into the SEA binary against a seeded profile pointed at a real `SavedArks`
fixture (server stopped, so no RCON needed): `backup.create` produced a real `.zip`, with real
`backup-created`/`backup-log-entry` push events and a real `lib/managerLog.ts` entry alongside it
- all from the real, unmodified `createBackup()`, not a stand-in. `backup.list` read it back.
Deleted the save file from disk, called `backup.restore` with the just-created backup's path, and
the real file was back - a genuine round trip, confirmed by checking the filesystem directly, not
just trusting the RPC said "ok". `playerBackup.listFolders`/`.list`/`.openFolder` were confirmed
the same way against a fabricated player-backup folder (no real RCON player-connect event exists
in this sandbox to drive `backupPlayerProfile()` itself - same category of gap as every other
RCON-gated path in this PoC).

**Found and fixed a response-shape bug identical in kind to `log.record`'s own, found by actually
driving the RPC round trip rather than reading the handler's source.** `backup.delete`/
`backup.restore`'s sidecar methods originally just called `deleteBackup()`/`restoreBackup()`
directly and returned whatever they resolved to - `void`, same as the real functions. A real
`backup.restore` call genuinely put the deleted file back on disk (confirmed on the filesystem),
but the RPC response line itself read `{"id":6}` - no `result`, no `error` - which
`SidecarHandle::call` on the Rust side treats as `Err("sidecar returned neither a result nor an
error")` unconditionally, regardless of whether the real operation actually succeeded. Fixed the
same way `log.record` already was: both methods now return `{ ok: true }` explicitly after
calling the real (still unmodified) function.

**Confirmed through the real compiled app, including the full click-through cycle, not just a
read.** Seeded a profile with a real backup already on disk (so the initial screenshot shows real
data, not an empty state), pointed the main window at a new `backups.html`
(`?profile=poc-test-server`, same temporary-`tauri.conf.json`-`url` technique as every other
page) and screenshotted under Xvfb: the real, unmodified form rendered the real backup settings
(backup directory, max backups, the cron schedule from "A sixth real page"), the real world-backup
table (one real `.zip`, real size, real creation time), the real Player Profile Backups section
(a real player folder picked from a dropdown, a real per-player backup listed), and the real
Backup Process Log panel correctly showing "No backup activity yet" (an honest result, not a bug -
`getBackupLog`'s in-memory log is per-sidecar-process, as the panel's own real copy says, and this
was a fresh process from an earlier standalone run that wrote the on-disk data). A real click on
"Create backup now" then produced, live on screen: a new row at the top of the world-backup table
(the real `backup-created` push event driving `BackupsTab`'s own `onCreated` reload, not a manual
refresh) and a real log line in the Backup Process Log panel (the real `backup-log-entry` push
event reaching `BackupLogPanel`'s own `onLogChanged` handler) - both push-driven UI updates firing
correctly in the real running app, not just confirmed standalone. A further real click sequence -
select the new row's checkbox, click "Delete selected backup" - removed it from both the real
table on screen and the real file on disk, the table correctly settling back to showing just the
original backup. Not separately exercised through the real UI: the `canRestore` gate's disabled
state while a server is running (the underlying `restoreBackup()` guard - `isRunning(profile.id)`
throwing "Stop the server before restoring a backup." - is the same real code path `stopServer()`
itself already relies on elsewhere in this PoC, not new, untested logic), and the native "Browse…"
folder picker (same category of gap as "A second real page"'s own dialog happy path).

### An eighth real page, and a PoC-wide bug in how a legitimate `null` crosses the Tauri bridge

`UpdateLogTab.tsx` (`src/renderer/src/pages/ServerDetail/`, 52 lines) is the smallest page this
PoC has ported, and was picked specifically because its real contract includes a legitimate
`null`: `readUpdateLog(profileId): string | null` from `lib/steamcmd.ts` - real, unmodified,
backing `window.api.steamcmd.getUpdateLog`/`.onUpdateLogChanged` - returns `null` for any
profile that's never been updated, which `updateServer()` (already called by this PoC's
`server.update`) can never leave this sandbox in any other state, since it fails fast with "Set
the SteamCMD path in Settings before updating." before ever writing a log file (no real SteamCMD
install here). Wired one new RPC method (`steamcmd.getUpdateLog`) and one more independent push
source (`lib/steamcmd.ts`'s own `steamcmdUpdateEvents`, same module-level-subscription shape as
every push source except `lib/schedule.ts`'s), plus a test-only `steamcmd.appendTestUpdateLogLine`
(writes straight to the real log path and emits the real event) standing in for a real update run,
the same honest-simulation role `console.appendTestLine`/`server.installTestExecutable` already
play elsewhere in this PoC.

**The actual headline finding of this round: a legitimate JSON `null` result is indistinguishable,
on the Rust side, from the sidecar having sent no result at all.** `RpcResponse`'s
`#[serde(default)] result: Option<Value>` field - written for the bug class "A JSON-RPC response
needs a concrete, non-`undefined` result" already names (see `log.record`'s and
`backup.delete`/`backup.restore`'s own fixes) - turns out to have the opposite gap too: serde's
derived `Option<T>` deserializer treats a JSON `null` value the **same as the field being
absent**, both collapsing to `None`. Confirmed directly, not assumed from docs: deserializing
`{"id":1,"result":null}` and `{"id":2}` through the exact same derived struct produced identical
`result: None, error: None` output for both. `SidecarHandle::call`'s own match arm -
`(None, None) => Err("sidecar returned neither a result nor an error")` - then treats a real,
honest `readUpdateLog` → `null` exactly like a sidecar bug, rejecting the `invoke()` promise with
an opaque error instead of resolving it with `null`. Since `UpdateLogTab.tsx`'s own
`.then((log) => setLogContent(log ?? '...'))` chain has no `.catch()` (same as every other real
component in this PoC, none of which were written expecting a rejection on a normal, successful
read), the real effect would have been silent: the log panel stuck at its initial empty string,
on every single profile that's never been updated - the common case, not an edge case.

**Fixed with a custom `Deserialize` impl for `RpcResponse`, not a sidecar-side workaround.**
Wrapping every legitimately-`null`-returning sidecar method's result (the way `backup.delete`
wraps `void` in `{ ok: true }`) would work too, but only for methods whose authors remember to -
exactly the kind of per-call-site discipline this PoC's own fixes have otherwise tried to avoid
needing. The real fix belongs at the transport layer: `RpcResponse` now deserializes the whole
line into a `serde_json::Map` first and reads `result`/`error` via `.get()`, which (confirmed by
the same direct test) correctly returns `Some(&Value::Null)` for a present-but-null key and `None`
only when the key is genuinely absent - the distinction the derived `Option<Value>` field could
never make. `SidecarHandle::call`'s own match logic needed no change at all once that distinction
reached it correctly.

**Confirmed through the real compiled app, both the fix and the honest `null` case itself.**
Pointed the main window at a profile that has never been updated (`update-log.html?profile=...`,
same temporary-`tauri.conf.json`-`url` technique as every other page) and screenshotted under
Xvfb: the real, unmodified component correctly rendered "No update log yet - run Update at least
once." - not stuck empty, not an unhandled-rejection console error - confirming the fix handles
the honest `null` path, not just the already-has-data path. Re-pointed at `poc-test-server` (which
already had two real lines on disk from an earlier standalone round) and the real content rendered
too. A temporary trigger button (revert-before-commit, as always) calling
`steamcmd_append_test_update_log_line` twice, clicked through the real running app, produced two
real new lines appearing live on screen between clicks - the real `steamcmd-update-log-changed`
push event reaching the real, unmodified `onUpdateLogChanged` handler, confirmed the same way
every other live-push page in this PoC has been.

### A ninth real page: no push event this time, and a bug avoided by applying an earlier lesson

`MapManagementTab.tsx` (`src/renderer/src/pages/ServerDetail/`, 135 lines) was picked specifically
because it's the first real page in a few rounds with **no** live push source to wire - real,
unmodified `lib/mapManagement.ts`'s `listMapFolders`/`createMapFolder`/`deleteMapFolder`/
`openMapFolder` are a plain request/response CRUD over a server's `SavedArks` subfolders, proving
this PoC's architecture doesn't force every page into the push-event shape, just supports it when
a real page needs one. Four new sidecar RPC methods mirror `ipc/mapManagement.ts`'s handler
bodies exactly, same `requireProfile`-then-call shape as every other subsystem here.

**Applied "A JSON-RPC response needs a concrete, non-`undefined` result" before hitting it a third
time, not after.** `createMapFolder`/`deleteMapFolder` are real `void`-returning functions, the
exact shape that bit `backup.delete`/`backup.restore` in "A seventh real page" (and `log.record`
before that). Both sidecar methods were written with an explicit `{ ok: true }` return from the
start this round, rather than discovering the same gap a third time by actually driving the call
and finding a malformed response line. The one new real-code surface this page needed -
`sanitizeMapFolderName()`'s path-traversal guard - was confirmed standalone with a genuinely
malicious input (`folderName: "../evil"`), which correctly threw the real
`"\"../evil\" isn't a valid folder/file name."` error rather than writing outside `SavedArks`.

**Confirmed through the real compiled app, a full create → list → select → delete cycle, not just
a read.** Pointed the main window at `map-management.html?profile=poc-test-server` (same
temporary-`tauri.conf.json`-`url` technique as every other page) and drove the real, unmodified
form through genuine typed input (`xdotool type` into the real controlled inputs, not a
programmatic value set) and real clicks: "No map folders under SavedArks yet." on first load, a
real "Svartalfheim" folder appearing in the table with a real creation timestamp after "Add map",
row selection enabling "Open map folder"/"Delete selected map", and the table correctly emptying
back to the real empty state after a real click through `confirmAction()`'s native `window.confirm()`
dialog and "Delete selected map" - all against the real filesystem, confirmed by rendered state on
screen between each step rather than assumed from the RPC layer alone.

### A tenth real page: mostly a settings form, plus a live client-side countdown and a "Run now" button

`ServerManagementTab.tsx` (`src/renderer/src/pages/ServerDetail/`, 396 lines) was picked because
it's the biggest real page this PoC has ported yet, and a different shape from every earlier one:
nearly all of it - startup/watchdog toggles, zombie detection, the cluster log archive size,
scheduled restart/dino wipe/maintenance - is just more `ServerProfile` fields, already fully
covered by the real, already-proven `window.api.profiles.save`. No new real-code surface needed
for any of that; the port is almost entirely "does a big, varied real form round-trip through a
write path this PoC proved in round one." It also mounts a second real, unmodified component for
the first time without a dedicated entry file - `ScheduleDaysPicker.tsx` (time/day picker, shared
between the Restart and Dino Wipe sections) - which has **zero** `window.api` involvement at all:
its own live "next occurrence" countdown is pure client-side date math (`@shared/scheduleTime`'s
`computeNextOccurrence`/`formatCountdown`), the first real page in this PoC proven to tick purely
in the browser, no Rust/sidecar round trip per tick.

**The one genuinely new real call: a scheduled RCON command entry's "Run now" button.** Traced
`window.api.groupConsole.sendRcon` to `ipc/groupConsole.ts`'s `groupConsoleRconSend` handler and
found it's a thin wrapper around the exact same real `sendRconCommand()` `playerRoster.kick`/
`playerBans.ban` already call in "A third real page" - one more real call site of an
already-proven function, not new RCON code. Wired as `groupConsole.rconSend` with zero new
imports in `sidecar.ts`.

**Confirmed standalone first:** `groupConsole.rconSend` against the seeded test profile produced
the same real, honest `{ ok: false, error: "No ServerAdminPassword set..." }` this PoC's other
RCON-gated calls already surface (no real `ServerAdminPassword` on this fake profile) - a real
result object, not a thrown error, matching the real handler's own shape exactly. A `profiles.save`
round trip with a real `scheduledRconCommands` entry and `crashWatchEnabled: true` confirmed the
big-form write path independently of any UI.

**Confirmed through the real compiled app**, including the live countdown actually ticking and
the real honest RCON failure landing on screen. Pointed the main window at
`server-management.html?profile=poc-test-server` and screenshotted under Xvfb: the real form
rendered with the real seeded state (`crashWatchEnabled` genuinely checked, from the standalone
round above), and two screenshots taken ~2 seconds apart after checking "Shutdown server at"
and a day showed the real countdown - `01:23:34:27` then `01:23:34:25` - ticking down on its own,
confirmed by a real second-by-second difference, not assumed from the component reading
correctly. Scrolling to Scheduled RCON Commands showed the real `scheduledRconCommands` entry
from the standalone round, correctly rendered (label, command, "Timeless" trigger active,
enabled). A real click on "Run now" produced, live on screen, the exact same honest RCON failure
text the standalone call already proved - the real click → `window.api.groupConsole.sendRcon` →
`invoke()` → Rust → sidecar → `sendRconCommand()` chain, rendered by the unmodified component's
own `runResults` display, not a stub.

### A batch of four smaller real pages: eleventh through fourteenth

Four more real, unmodified pages in one round, each smaller and more narrowly scoped than the
last few - a deliberate change of pace to cover breadth (more of the real renderer, more of
`store.ts`'s own surface) rather than depth, after several rounds that each went deep on one
substantial subsystem.

- **`ChangelogView.tsx`** (31 lines) - the cheapest page this PoC has ported: **zero**
  `window.api` calls, zero sidecar RPC methods, zero new Tauri commands. It just renders real,
  static content from the real, unmodified `@shared/changelog`'s `CHANGELOG` constant. Confirmed
  through the real compiled app under Xvfb: the real entries (dates, titles, bullet lists)
  rendered correctly with no shim object at all - proving this PoC's rendering pipeline handles a
  page with no IPC surface whatsoever, not just the ten before it that all needed one.
- **`WatchedPlayersSection.tsx`** (85 lines) - the watchlist for the "player joined" Discord
  alert, a different real `store.ts`-backed subsystem from `playerWhitelist` (tracking who to
  *alert on*, not who's allowed to connect). `watchedPlayers.list`/`.add`/`.remove` are plain
  `store.ts` CRUD, same shape as every other one in this PoC. Confirmed through the real app: a
  real add (typed input, not programmatic) produced a real new row, and a real remove - through
  `confirmAction()`'s native `window.confirm()` and the already-proven `window_focus` command -
  correctly emptied it back out, both checked against the real list on screen, not just the RPC
  response.
- **`PlayerActivityPanel.tsx`** (100 lines) - read-only aggregated playtime, a third distinct
  real player subsystem (after bans/whitelist and watched-players). `playerActivity.list`/
  `.sessions` are plain reads with nothing to write. Confirmed through the real app: the real,
  honest empty state ("No activity recorded yet - enable...") rendered correctly, matching
  standalone - nothing in this sandbox ever enables activity tracking, so an empty, honest result
  is the correct outcome here, not a gap.
- **`PlayerBansPanel.tsx`** (185 lines) - the centralized cross-server ban list.
  `playerBans.ban` was already proven in "A third real page" (`PlayerRosterPanel.tsx`'s own ban
  button uses the same real RPC); this page needed two more real call sites of the same real
  subsystem - `playerBans.list` (a plain read) and `playerBans.unban` (mirrors `ban`'s own real
  RCON-gate-then-write shape: a real `UnbanPlayer` RCON call must succeed before the local ban
  record is removed). Confirmed through the real app: the real cross-server group picker
  (Ungrouped/"PoC Group" columns) rendered correctly with the real seeded profiles, and a real
  click on "Ban" (typed player id, one server selected) produced, live on screen, the same honest
  `"No ServerAdminPassword set..."` RCON failure this PoC has surfaced before - confirming
  `wrapInvoke()`'s fix (from "A sixth real page") still correctly turns the bare-string rejection
  into real `Error` text on a brand new page, not just the ones it was written against.

No new bugs found this round - all four pages reused subsystems and fix patterns this PoC had
already proven, which is itself worth stating plainly: not every round needs to find something
new to be worth doing.

### A fifteenth real page: the Cluster Dashboard, reusing two components with zero window.api of their own

`ClusterDataView.tsx` (`src/renderer/src/pages/`, 170 lines) - the "Cluster Dashboard" showing
merged per-group CPU/RAM/player totals plus a history chart - was picked because it reuses two
real, unmodified pieces this PoC had already separately proven need no `window.api` of their own:
`useServerStatuses.ts` (the hook behind every live status badge, from "A fifth real page") and
`ServerStatsChart.tsx` (pure SVG rendering, from "A sixth real page"). The one genuinely new real
call is `readClusterStatsHistoryForGroups` - the read-every-group-at-once sibling of
`readStatsHistory`, reading the same real `stats-history.jsonl` file once and summing it per
dashboard group instead of per profile.

**Confirmed standalone first:** against the real seeded profiles (one in "PoC Group", two
ungrouped), `statsHistory.getForGroups` correctly summed the one real stats sample this PoC's
monitor ever recorded (back in "A fifth real page") into its group's bucket, and returned a real
empty array for the ungrouped bucket (which never had stats-enabled profiles) - not a thrown
error, the real honest shape for a group with no history.

**Confirmed through the real compiled app**, including the live-reused components and the real
chart actually drawing real data. Pointed the main window at `cluster-data.html` (same temporary-
`tauri.conf.json`-`url` technique as every other page) and screenshotted under Xvfb: the real,
unmodified form rendered both real groups with their real totals (0 running, 0 CPU/RAM/players,
matching the real seeded state) and the real time-scale selector. The default "12h" scale showed
no chart (the one real sample on disk predates that window), which is itself the correct, honest
behavior - `history.length > 0` gating the chart is real component logic, not a bug. Clicking
"All" correctly re-queried and showed the real chart rendering the real sample (CPU 0%, RAM 2 MB,
Players 0, labeled rather than drawn as a line since `ServerStatsChart.tsx`'s own line-drawing
needs at least two points - real, correct behavior for genuinely sparse data, not a bug).

### A sixteenth real page: the first real outbound network call, and a real honest network failure

`SteamCmdView.tsx` (`src/renderer/src/pages/`, the managed-SteamCMD settings page) was picked
specifically because `lib/steamcmdInstaller.ts`'s `installManagedSteamCmd()` is the first real
function in this whole PoC that makes a genuine **outbound network call** - a real `fetch()`
straight to Valve's own CDN (`steamcdn-a.akamaihd.net`), downloading the real SteamCMD archive to
disk and extracting it - rather than talking to the local filesystem, a local RCON socket, or a
local OS process the way every one of the first fifteen pages did. `lib/firewall.ts`'s
`addFirewallRulesForSteamCmd()` is real too, and real-honestly platform-gated: it rejects
immediately on anything but `win32`, the exact branch this Linux sandbox exercises - matching the
same category of honest platform gap as `dialog_select_directory`'s own Windows-only firewall API
mention. `window.api.dialog.selectFile` backs "Browse..." - a new sibling of
`dialog_select_directory` ("A second real page"), the same architectural class: a native dialog
with zero sidecar involvement, backed by a new `dialog_select_file` Rust command
(`tauri-plugin-dialog`'s `blocking_pick_file()`).

One real refactor came out of wiring `steamcmd_add_firewall_rule`: the real
`FirewallSettingsPanel.tsx`'s equivalent flow calls `forceRefocus()` (`windowFocus.ts`) in a
`finally` block around the firewall IPC call, to recover window focus after the real Windows UAC
prompt steals it. That workaround can't live in the sidecar - there's no window handle on that
side of this architecture, same reasoning as `window_focus` itself needing to be Rust-only. The
existing `window_focus` Tauri command's body was extracted into a small private
`refocus_window(app_handle)` helper, so `steamcmd_add_firewall_rule` can call it directly after
the sidecar call completes (success or failure alike, mirroring the real `finally` semantics)
without duplicating the refocus logic.

**Confirmed standalone first**, deliberately, before investing in the full frontend/Xvfb build,
specifically because the real network behavior in this sandbox was unknown going in:
`steamcmd.managedStatus` correctly returned `null` (nothing installed yet, the real honest
first-run state), and `steamcmd.install` made a real `fetch()` attempt that failed after roughly
60-100ms with `"fetch failed"` - this sandbox's outbound network policy doesn't permit arbitrary
third-party domains like Valve's CDN. This is the same category of honest result as every other
platform/network gap this PoC has already documented (no real SteamCMD, no real ARK/Minecraft
binary, no real Discord, no Windows-only firewall API) - the real function's real behavior (a real
network attempt, a real propagated failure) was correctly exercised; the limitation is the
sandbox's network policy, not the port.

**Confirmed through the real compiled app**, matching the standalone result exactly: pointed the
main window at `steamcmd.html` and screenshotted under Xvfb - the real, unmodified form rendered
the real default `C:\SteamCMD\steamcmd.exe` path (from `AppSettings`'s own default) and the
"Not installed yet" state correctly. Clicking "Install managed SteamCMD" produced the real
`"fetch failed"` error text on screen, the same string the standalone run surfaced, proving the
real error crosses the sidecar → Rust → webview round trip intact for a real network-layer
failure, not just the RCON/filesystem/process failures this PoC had exercised before. The native
"Browse..." file picker and the Windows-only firewall rule button were not clicked through to
completion in this sandbox - same already-documented architectural gap as the folder picker's own
happy path in "A second real page" (a human click a headless Xvfb session can't provide) and the
firewall API's own Windows-only gate.

### A seventeenth real page: merging every server in a group's live log feed into one view

`GroupConsoleView.tsx` (`src/renderer/src/pages/`) was picked specifically because "A fifteenth
real page"'s own `cluster-data-entry.tsx` had honestly left it unported - `ClusterDataView.tsx`'s
`onOpenGroup` just logged to the console instead of navigating anywhere, since this page didn't
exist in the PoC yet. It merges the live log feed of every server in a dashboard group into one
chronological view, tagged per-server, plus an RCON bar (send to one server or the whole group)
and a sidebar with live per-server status/version/resource cards and a right-click
start/stop/restart/update context menu. Real, unmodified `getGroupConsoleBacklog()`/
`watchGroupConsole()` from `lib/groupConsole.ts` turned out to need no new underlying real
subsystem at all - they're themselves just orchestration over the exact same
`watchLogFile`/`parseLogChunkWithDate`/`readLogBacklog` this PoC's own `console.watch`/
`console.backlog` ("The actual headline case") already proved, one `watchLogFile` tailer per
*running* profile in the group (started/stopped live off the same real `serverEvents` 'status'
emitter every other live status view in this PoC already subscribes to), each event tagged with
which profile it came from before being multiplexed onto one push event
(`group-console-event`). `groupConsole.rconSend` had already been proven in "A tenth real page" -
reused unmodified, no new sidecar code for it at all.

**Confirmed standalone first**: `groupConsole.subscribe` against the real seeded profiles
(one in "PoC Group", two ungrouped) correctly returned an empty backlog array (no profile in this
sandbox has ever had a real server log with content), and `groupConsole.rconSend` reproduced the
same real `"No ServerAdminPassword..."` RCON failure this PoC has surfaced many times before -
nothing new to find in the RPC layer this round.

**Confirmed through the real compiled app**, and more thoroughly than most earlier rounds since
this page happens to combine several already-proven real subsystems at once: pointed the main
window at `groupconsole.html` (`?group=` picks which dashboard group to open, defaulting to the
first one found) and screenshotted under Xvfb - the real, unmodified form rendered "PoC Group"
with its one real profile, correct event-label checkboxes, and the real cluster-stats sidebar (1
off, 0 players, 0% CPU, 0 MB). A real RCON send through the real RCON bar reproduced the same
honest `"No ServerAdminPassword..."` failure on screen. Right-clicking the server summary card
opened the real context menu with the real enabled/disabled button states for a stopped server
(Start/Update enabled, Stop/Restart disabled); clicking **Start** drove the real, already-proven
`doStartServer()` orchestration end to end - a real OS process actually spawned (confirmed in
`ps aux`, the same stand-in test executable "The actual headline case" installed), the sidebar
card's badge genuinely transitioned stopped → starting → running with real live CPU/RAM readings,
and - the one piece of this page's own logic nothing in this PoC had exercised before - a real
synthetic `"Real App Dashboard Test started"` line appeared in the feed itself, confirming the
component's own client-side status-transition-to-log-line logic (comparing against its
module-scope `lastKnownStates` map) fires correctly against a real status push, not just its
real-code RPC calls. Stopped the real process afterward (`pkill`) to leave the sandbox clean. No
new bug this round - every real call site reused an already-proven real subsystem or push
pattern; the only genuinely new code was the per-profile event multiplexing itself, which worked
correctly on the first real run.

### An eighteenth real page: zero new real code, proving real tab-switching composes already-proven pages

`PlayersView.tsx` (`src/renderer/src/pages/`, 59 lines) merges four already-fully-proven real
pages - `PlayerRosterPanel.tsx` ("A third real page"), `PlayerBansPanel.tsx` ("A fourteenth real
page"), `PlayerWhitelistPanel.tsx` ("A fourth real page"), `PlayerActivityPanel.tsx` ("A twelfth
real page") - behind one sidebar-tabbed screen. Picked specifically because it needed **no new
sidecar RPC method and no new Rust command at all** - the first page in this whole PoC where
that's true - `groupconsole-entry.tsx`'s own `window.api` is simply the union of all four
already-ported pages' own entry files, unchanged. The only thing actually new to prove is whether
real client-side tab-switching (mounting/unmounting a different real child component on each
click, not just one page in isolation) behaves correctly against this architecture.

**Confirmed through the real compiled app** (no standalone round needed, nothing new at the RPC
layer to test in isolation): pointed the main window at `players.html` and screenshotted under
Xvfb - the real, unmodified form rendered the real "Live Players" tab by default with all three
real seeded profiles (including the real collapsible "PoC Group" `<details>` section
`PlayerRosterPanel.tsx` already drew in "A third real page"). Clicking through Bans, Whitelist,
and Activity in turn correctly mounted each real child fresh each time - the real cross-server ban
picker, the real tracking-only whitelist form, and the real honest "no activity recorded yet -
enable ... in Settings" empty state, each exactly matching that page's own already-proven
standalone screenshot. No new bug - this round existed specifically to prove composition, not new
real-code surface, and found nothing wrong with it.

### A nineteenth real page: a subsystem that reconciles itself immediately, not just on a live push or a click

`EventSchedulerView.tsx` (`src/renderer/src/pages/`) schedules a set of CurseForge mod ids to be
automatically added to target servers' mod lists when an event starts, and removed again when it
ends. Picked specifically because `lib/modEvents.ts`'s real `armModEvent()`/`armAllModEvents()`
own real `node-cron` schedules and `setTimeout`s (not Electron APIs - confirmed, same as every
other "is this really just Node" check this PoC runs before porting) that fire a real
reconciliation pass (`applyModEventChange`) the moment an event is saved *or* the sidecar itself
starts - a genuinely different trigger shape from every real-time-update subsystem this PoC had
ported before (a live push event reacting to something that already happened, or an RPC call
reacting to a click): here, *saving* the event is itself what can immediately mutate real state
elsewhere in the app, with no further action needed. This also makes it the first page in this
PoC whose real form uses a native `<input type="datetime-local">` and the first needing a modal
(`wizard-overlay`/`wizard-modal`) - new CSS to write, but zero new sidecar wiring for either; both
are plain HTML/React, no `window.api` involved.

**Confirmed standalone first**, deliberately, specifically to observe the real reconciliation
side effect under controlled conditions before risking it through a real UI click: saving an
event with a `startAt` in the past correctly triggered an *immediate* real reconciliation -
`123456` was really appended to all three real seeded profiles' own `mods` arrays (not simulated),
a real `manager-log-entry` push (`"Mod(s) added: 123456"`) and three real `profiles-changed`
pushes fired (one per profile actually saved), and a real history entry was recorded - all from
one `modEvents.save` call, with no explicit "apply now" step anywhere in the real code. Manually
reverted the real profiles' `mods` arrays back to empty afterward (direct config edit, the same
category of sandbox cleanup as reverting `tauri.conf.json` between rounds) to keep later rounds'
screenshots honest, since `modEvents.delete` (confirmed separately, see below) only removes the
*event* - the real UI's own delete-confirmation text says plainly it "does not undo any mods it
already added/removed," and this PoC's standalone run exercised exactly that real behavior.

**Confirmed through the real compiled app**, this time with a deliberately *future*-dated event
(`startAt`/`endAt` both well ahead) specifically to observe the opposite real code path without
touching the real seeded profiles' mods again: pointed the main window at `event-scheduler.html`
and screenshotted under Xvfb - the real, unmodified empty state, then the real "+ New Event"
modal, with real native date-picker widgets (WebKitGTK's own calendar popups, not a custom
component) actually used to pick a real future date in each field. Submitting created a real event
that correctly showed status "Scheduled" (not "Active") in the real table - `isEventActive()`'s
own client-side logic correctly read a future `startAt` and did **not** trigger reconciliation
this time, confirmed by the real seeded profiles' `mods` arrays staying empty afterward. The real
History tab correctly showed the one real history entry from the earlier standalone round, with
real server names resolved from real profile ids. Did not click through to a real `Delete Event`
confirmation in this round - `deleteEvent()` goes through the real `confirmAction()` -> native
`window.confirm()`, an unconfirmed happy path in a headless Xvfb session (same already-documented
category of gap as the native folder/file pickers), so cleanup was done directly against the real
config file instead, the same way the mod-list cleanup was. No new bug this round - the one thing
genuinely worth finding (immediate reconciliation on save) is real, documented component/library
behavior working exactly as designed, not a defect.

### A twentieth real page: a different real file-backed subsystem, and the clearest confirmation yet of where data actually lands

`MapManagerView.tsx` (`src/renderer/src/pages/`) lists every official map (read-only, shipped
`maps.json`, one per game, merged into one row per map across ARK: Survival Ascended and Evolved)
alongside a fully editable custom/modded map database (`customMaps.json`). Picked specifically
because it's a different real file-backed subsystem from every one of the (many) `store.ts`-backed
ones this PoC has ported so far - `lib/maps.ts`'s `listMaps()` and `lib/customMaps.ts`'s
`listCustomMaps`/`addCustomMap`/`updateCustomMap`/`deleteCustomMap` go through
`jsonListFile.ts`'s own read/parse/write helpers and `getDataDir()`, not `electron-store`/`conf` -
proving that second real persistence path ports with zero Electron coupling too, not just the
first. Reuses the `wizard-overlay`/`wizard-modal` CSS "A nineteenth real page" introduced, and the
`map-manager-table` class this PoC's own `MapManagementTab.tsx` port had already named (a
coincidence of the real app's own CSS, not shared markup - the two features aren't related).

**Confirmed standalone first**: `maps.list` returned the real shipped map list for each game (14
ASA maps, 12 ASE maps, real ids like `TheIsland_WP`/`TheIsland`), and a full
add → update → delete cycle against `customMaps.list` round-tripped correctly with no manual
cleanup needed afterward (unlike the last two rounds) - `deleteCustomMap`'s own real behavior
already leaves nothing behind.

**Confirmed through the real compiled app**, and this time deliberately pushed further than a
standalone call alone would show: the real, unmodified page correctly rendered and merged all 15
official map rows (`Valguero` and `Astraeos` each correctly showing a real `-` for the game that
doesn't have them) ahead of a real empty custom-maps state. Clicking "+ Add Map", filling the real
modal, and saving produced a real new row on screen - and, checked directly on disk, a real write
to `customMaps.json`. That file's real location (found by searching the filesystem, not assumed)
turned out to be `~/Documents/ARK Server Manager/customMaps.json` - confirming, independently and
for a second real subsystem, the exact same `getDataDir()` → `app.getPath('documents')` path this
PoC's own "Findings" section already documented for `lib/managerLog.ts` going through
`electronShim.ts` correctly from the start. Editing that same row through the real "Edit" button
and real pre-filled form produced a second real write, confirmed again on disk. Did not click
through "Delete" in this round - same already-documented `confirmAction()` → native
`window.confirm()` gap as `EventSchedulerView`'s own delete button - cleanup done directly against
the real file instead. No new bug - every real call site behaved exactly as its own standalone
test predicted.

### A twenty-first real page: the first real code to write directly into a GameUserSettings.ini/Game.ini

`IniTemplatesView.tsx` (`src/renderer/src/pages/`) writes a cluster-wide generic
GameUserSettings.ini/Game.ini template, plus an optional per-server override, merged key-by-key
into each real profile's real config files - an existing key is updated right where it already
sits, a new one is inserted into its section, and the override wins over the generic template for
anything both set. `getIniTemplateGeneric`/`saveIniTemplateGeneric`/`getIniTemplateOverride`/
`saveIniTemplateOverride`/`deleteIniTemplateOverride` (`store.ts`) are the same real
electron-store CRUD shape this PoC has proven many times already; the genuinely new real code is
`applyIniTemplate`/`applyIniTemplateToAll` (`lib/iniTemplates.ts`) - the first thing in this whole
PoC to write directly into a real `GameUserSettings.ini`/`Game.ini`, via `gameConfigWrite.ts`'s
`upsertIniKeys`: a real surgical in-place key update or section insert, not a template engine
standing in for the real merge logic. Also added a fourth sidecar-free native-dialog command,
`dialog_select_ini_file` (backs "Import from file..."), the same architectural shape as
`dialog_select_file`/`dialog_select_directory`, with a real `.ini` file filter.

**Confirmed standalone first**, specifically to see what applying a template against a profile
with no config file yet actually does before risking it through the real UI: saving a generic
template then calling `apply` against a real seeded profile succeeded cleanly and genuinely
**created** `ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini` from nothing -
`upsertIniKeys`'s own `tryReadExistingContent` treats a missing file as a legitimate empty
starting point (not an error), so a first-ever apply is real, honest file creation, not a
failure. `applyAll` correctly produced the same real result across every seeded profile in one
call. Reverted the created files and the saved template afterward to keep the sandbox clean.

**Confirmed through the real compiled app**, deliberately exercising a different template content
than the standalone round to also confirm the one field actually typed is the one that lands (and
nothing phantom from a `placeholder` leaks in): typed a real `[ServerSettings]`/
`DifficultyOffset=1.0` block into the real GameUserSettings.ini textarea only (leaving Game.ini's
textarea genuinely empty, not just showing its own placeholder text), clicked "Save Generic
Template" (real "Saved" confirmation appeared), then clicked "Apply" on one real server row (real
"Applied" status appeared). Checked directly on disk: a real `GameUserSettings.ini` was created
with exactly the typed key plus the real forced `SessionName=<profile name>` line - and, correctly,
no `Game.ini` was created at all, since that template field's real saved value was still empty
(only its placeholder text had ever been visible, never actually saved) - `applyIniTemplate`'s own
`gameEntries.length > 0` gate correctly skipped it. Opening "Edit Override" also rendered the real
per-server override modal correctly, pre-filled from the real (empty) saved state. Reverted the
real created file and the real saved template afterward. No new bug - every real call site
(including the one genuinely new behavior, honest file creation) matched its own standalone
prediction exactly.

### A twenty-second real page: a Notepad++-style editor, and the hundredth Tauri command

`ServerDetail/FilesTab.tsx` is a file browser over the server's own real install directory with
a Notepad++-inspired tabbed editor for `.ini`/`.json` files (`.log` files open read-only) -
multiple files open at once, real line numbers, real syntax-colored overlay highlighting, and
the same real history/diff/restore `IniTemplatesView.tsx` already proved a narrower slice of
("A twenty-first real page"). Real, unmodified `listFileBrowserEntries`/
`resolveFileBrowserPath`/`deleteFileBrowserFile`/`readIniFile`/`writeIniFile`/`listIniHistory`/
`diffIniHistoryEntry`/`restoreIniHistoryEntry` (`lib/fileBrowser.ts`), mirroring the real
`ipc/fileBrowser.ts` handlers' exact bodies - including `fileBrowser.open`, which calls the real
`shell.openPath` straight from the sidecar (via `electronShim.ts`'s shim, already resolved to a
real round trip through Rust in "The reverse direction") - a new real call site of that
mechanism, not a new one. Reaches the round-number hundredth Tauri command this PoC has needed.

**Confirmed standalone first**: a full real create → list → read → edit → save → history →
diff → restore → delete cycle against a test `.ini` file round-tripped exactly as the real
component's own logic predicts - a real history entry recorded on each save, a real diff showing
`-`/`+` lines for the changed key, and a real restore producing the exact original content back.
`fileBrowser.open`'s own real `shell.openPath` round trip was deliberately left untested here (it
needs a live Rust side to answer the request, which a standalone sidecar process doesn't have) -
confirmed instead only through the real compiled app, the correct way to exercise it.

**Confirmed through the real compiled app**, with a real pre-seeded `.ini` file (this sandbox
otherwise has none, with no real ARK server having ever run here) to browse to and click: the
real, unmodified file browser correctly listed real folders down to a real
`GameUserSettings.ini`, with its real size and modified time. Clicking it opened the real
tabbed editor with real line-numbered syntax highlighting; editing `ServerPVE=False` to `True`
showed the real dirty-tab dot, and clicking "Save" produced a real write confirmed on disk, a
real history entry, and a real "View diff" showing the exact changed line. Clicking "Restore"
correctly reverted the real file back to its original content on disk - confirmed both on screen
and by reading the file directly - and itself added a second real history entry first (matching
the real restore confirmation's own "current content will be saved to history first" text).
No new bug - every real call site behaved exactly as its own standalone prediction, now also
confirmed through a real sequence of real clicks rather than direct RPC calls.

### A twenty-third real page: the opposite honest-network-gap shape from SteamCMD's own

`ServerDetail/ModsTab.tsx` is the per-server mod list, with real per-game branching between ARK:
Survival Ascended (`-mods=`/`-passivemods=` launch flags, real CurseForge search/enrichment) and
ARK: Survival Evolved (real `GameUserSettings.ini`'s `ActiveMods=`/`Game.ini`'s
`[ModInstaller]`, via the same real `gameConfigWrite.ts` functions `applyModEventChange`
("A nineteenth real page") already called internally - new direct real call sites of them here,
not a new mechanism). Picked specifically because `arkMods.search`/`arkMods.info`
(`lib/arkMods.ts`, the real CurseForge API client) are the **opposite** honest-network-gap shape
from `SteamCmdView.tsx`'s own `installManagedSteamCmd()` ("A sixteenth real page"): where that
function always makes a real `fetch()` attempt (and fails honestly only once the request is
already in flight), these two real functions check for a configured CurseForge API key *first*
and return gracefully empty with **no network attempt made at all** when none is set - this
sandbox's own real, honest state, confirmed by reading `curseforgeApiKey` directly rather than
assumed.

**Confirmed standalone first**: `arkMods.search`/`arkMods.info` both returned real empty
results with no CurseForge key configured, `mods.parseText` correctly parsed a real
comma/newline-mixed id list, and a full real `mods.save` → `mods.reconcileFromIni` → `mods.save`
(revert) cycle round-tripped cleanly with nothing left behind - `syncAseModsToIni`'s own
real no-op-for-Ascended behavior confirmed by no stray `.ini` file appearing anywhere in the
sandbox afterward.

**Confirmed through the real compiled app**: the real, unmodified form correctly rendered the
honest "Set a CurseForge API key..." empty state for the search section (no CurseForge key in
this sandbox), typing a real mod id and clicking "Add" produced a real new row with the real
honest `—` placeholder for its unresolved name (no CurseForge lookup possible without a key,
exactly matching the standalone result), and the real write landed on disk - confirmed directly
in the real profile's own `mods` array. Clicking "Remove" correctly produced a second real write
back to an empty list, confirmed again on disk, leaving the sandbox exactly as it started. No new
bug - every real call site, including the deliberately-contrasted honest network-gap shape, 
matched its own standalone prediction.

### A twenty-fourth real page: a debounced live preview, and a fifth sidecar-free dialog

`ServerDetail/SettingsTab.tsx` is the main per-server settings form - the first real page in this
PoC with a debounced derived-state effect: every form edit re-calls
`window.api.server.previewLaunchCommand(form)` 300ms after the last keystroke, which round-trips
through the sidecar to the real, unmodified `getExecutablePath()`/`buildLaunchArgs()`
(`lib/serverProcess.ts`) - the exact same function pair `startServer()` itself calls, so the
textarea genuinely shows what would be launched, not a parallel reimplementation of the flag
logic. `window.api.system.openDataDirFolder` is a third real call site of the
`shell.openPath` round trip (see "The reverse direction") through a function
(`lib/systemFolders.ts`'s `openDataDirFolder`) never exercised by an earlier round.
`window.api.profiles.export`/`dialog.saveProfileFile` are the new pieces: `profiles.export`
round-trips through the sidecar to the real, unmodified `serializeProfile()`
(`lib/profileExport.ts`) and a plain `fs.writeFileSync` (same shape as `ipc/profiles.ts`'s own
handler), while `dialog.saveProfileFile` is a **fifth sidecar-free command**
(`dialog_save_profile_file`), same architectural class as `dialog_select_directory`/
`dialog_select_file`/`dialog_select_ini_file`/`window_focus` - the real `dialog.ts` is a
main-process/window-level concern in Electron too, so a native Save-File dialog invoked straight
from Rust is the natural port, not a sidecar RPC call standing in for something it never was.
Everything else on the page (`maps.list`, `customMaps.list`, `profiles.save`, `mods.save`,
`dialog.selectDirectory`) is already proven by earlier rounds and reused unchanged.

**Confirmed standalone first**: `server.previewLaunchCommand` returned the real, correct
executable path and flag list for a real test profile (the same exact ARK: Survival Ascended
`?Port=`/`?RCONPort=` query-string-then-flags shape "The actual headline case" already proved
`startServer()` itself produces), and `profiles.export` wrote a real pretty-printed
`serializeProfile()` JSON file to disk - confirmed by reading it back directly, not just trusting
the RPC's `{ ok: true }`. `system.openDataDirFolder` correctly produced the real
`shell-request`/`openPath` push event (same mechanism "The reverse direction" proved, a new
caller rather than a new path) - left unresolved in the standalone harness exactly as expected,
since nothing on the Node side is listening for the Rust reply outside the real compiled app.

**Confirmed through the real compiled app**: the real, unmodified form rendered every seeded
field correctly (name, install dir, ports, max players, group, cluster/Discord settings), the
debounced launch-command preview computed and displayed the real live command within the full
Rust+sidecar pipeline (not just standalone) using the exact buildLaunchArgs() output, and an
edited Name field produced a real `profiles.save` write confirmed directly in
`~/.tauri-poc-bober-manager/config.json` on disk (both before and after reverting it back for
cleanup). Clicking "Export profile..." correctly invoked the real `dialog_save_profile_file`
Rust command - but hit the exact same sandbox limitation "A second real page" already documented
for `dialog_select_directory`: the native dialog does not visibly render or complete in this
no-window-manager Xvfb sandbox (no new X11 window ever appeared, confirmed via `xdotool search`),
and unlike the earlier pick dialogs, this save dialog left the whole webview unresponsive to
further input until the app was killed - a stricter version of the same already-known
architectural gap, not a new one: GTK's save-file chooser evidently blocks harder than its
pick-folder/pick-file siblings did when there's no window manager to host it. No new bug in the
ported logic itself - every real call site that could be confirmed (the preview, the save, the
openDataDirFolder push event) matched its own standalone prediction exactly; only the native
dialog's own happy path remains unconfirmed, same class of gap as every other picker in this PoC.

### A twenty-fifth real page: the tab shell itself, zero new backend

`ServerDetail/index.tsx` is the ARK detail page's own left-nav tab shell - the piece every one of
this PoC's per-tab rounds (Analytics, Mods, Backups, Settings, Server Management, Map Management,
Update Log, Files) has been standing in for with its own dedicated entry file and URL override so
far. Picked specifically because it's a pure composition: the real, unmodified component just
holds a `tab` state and mounts one of eight already-proven real child components, each already
individually confirmed down to the real RPC call - so this round's own `window.api` is the exact
union of all eight earlier entry files' surfaces, with zero new sidecar RPC methods or Rust
commands. `frontend/server-detail.html`'s stylesheet is itself a merge of all eight tabs' own
`<style>` blocks (deduplicated by selector, last-definition-wins, 115 unique rules from an
original 8×~100-line spread) plus the real shell CSS (`.settings-nav`/`.settings-content`/...)
copied from `src/renderer/src/styles.css` with its `var(--bg)`/`var(--panel)`/etc. custom
properties translated to the same literal hex values this PoC's merged stylesheet already uses
for them (confirmed identical by reading the real `:root` block directly, not assumed).

**Confirmed through the real compiled app** (no standalone round needed - there's no new RPC
surface to test in isolation): the real, unmodified shell rendered its left nav with the correct
three real groups (Overview/Configuration/Maintenance/Files) and all eight real tab buttons: the
default Analytics tab mounted correctly, and clicking through Settings, Mods, Map Management,
Backups, Update Log, Server Management, and Files each correctly unmounted the previous real tab
component and mounted the next, every one rendering its own real seeded data exactly as its own
earlier round already proved standalone - the merged stylesheet held up across all eight without
a single unstyled or misrendered element. No new bug - the real tab-switching logic itself needed
no changes, and every already-proven `window.api` method remained reachable, unchanged, from
inside the composed shell.

### A twenty-sixth real page: the widest backend surface yet, and a real new bug

`DataSettingsView.tsx` is the app-wide Settings screen - by far the widest real backend surface
wired in a single round so far: `settings.save` (the real `ipc/settings.ts` handler body, with
every real follow-up re-application it does - web dashboard, Discord bot, launch-on-startup, ini
lock, player-join-alert/player-activity watchers), `dataDir.getDefault`, `webDashboard.
getLocalIps`, `discordBot.restart`, the real `lib/appUpdater.ts` (`appUpdate.getVersion`/
`.status`/`.check`/`.install`), `cluster.export`/`.import` (the first real call site in this PoC
to touch the Minecraft profile store - `listMinecraftProfiles`/`saveMinecraftProfile`/
`applyMinecraftScheduledRestart`/`applyMinecraftBackupSchedule` - proving that subsystem ports
with zero changes too, not just the ARK one every earlier round exercised), and the
`webDashboardAccessTokens`/`webDashboardApiKeys` CRUD its two real child components
(`AccessTokensSection.tsx`, `ApiKeysSection.tsx`) need. Two new sidecar-free native dialogs
(`dialog_save_cluster_bundle_file`/`dialog_select_cluster_bundle_file`) round out the set - 130
Tauri commands total. `electronShim.ts` grew a third stub method, `app.setLoginItemSettings`
(a no-op; `applyLaunchOnStartup` already wraps its one call to it in a try/catch for exactly
this "unsupported environment" case in the real app too).

**`checkForUpdate()` is safe to call for real in this sandbox, confirmed by reading its own
source first, not assumed.** It checks the real `app.isPackaged` *before* ever touching
`electron-updater`'s `autoUpdater`, and `electronShim.ts`'s `isPackaged` is always `false` - so
calling it deterministically takes the real, honest "Update checks only work in a packaged
build, not in dev." error path, the same shape as every other build-vs-dev honest gate in the
real app, never a PoC-only stand-in. `installDownloadedUpdate()` is wired too, for completeness,
but unreachable in practice: the real UI only enables its button once status reaches
`'downloaded'`, which `checkForUpdate()` can never reach here.

**Confirmed standalone first**: `settings.save` round-tripped a full real settings object with
no error (the new `electronShim.app.setLoginItemSettings` stub absorbing `applyLaunchOnStartup`'s
call cleanly); `webDashboardAccessTokens.create`/`webDashboardApiKeys.create` each produced a
real generated secret and a real hash-backed summary; `appUpdate.check` produced exactly the
predicted honest error, both as its RPC result and as a real `app-update-status-changed` push
event; `cluster.export` wrote a real pretty-printed bundle to disk; `cluster.import`'d (with
`includeSettings: false`) added three real renamed-on-collision duplicate profiles, firing a
real `profiles-changed` event per profile and running every one of the four new real
`applyScheduled*` functions without error - all three were then deleted again via
`profiles.delete` and the sandbox confirmed back to its exact starting profile count.

**Confirmed through the real compiled app - a real new bug found and fixed, not another honest
gap.** Every tab except one rendered its real seeded data correctly on first try: Application
(real `dataDir.getDefault`/stats-history settings), Web Dashboard (the real local IP from
`getLocalNetworkIps()`), Access Tokens (both real child sections; created and deleted a real
access token end to end, including the real "shown once" secret), and Updates (the real
`checkForUpdate()` honest-error path described above). Clicking **Discord Bot**, however, blank-
screened the whole page - a genuine React unmount, confirmed via the real WebKitGTK inspector
(`Inspect Element`'s Console panel): `TypeError: undefined is not an object (evaluating
'window.api.watchedPlayers.list')`, thrown inside `WatchedPlayersSection.tsx` (also rendered on
this tab, same as `AccessTokensSection.tsx`/`ApiKeysSection.tsx` on the Access Tokens tab) -
`data-settings-entry.tsx` had simply never declared `window.api.watchedPlayers`/`system.
focusWindow` (`confirmAction()`'s own native-window-focus workaround, used by this section's
"Remove" button). **Fixed** by adding both, reusing the already-proven `watched_players_list`/
`_add`/`_remove`/`window_focus` Rust commands from "An eleventh real page" - no new backend
needed, just a missing frontend declaration. Re-confirmed clean afterward: all five tabs render,
including a real watched-player entry from an earlier round showing correctly.

**A second, purely investigative issue the first fix's own re-test surfaced: a stale embedded
bundle, not a stale webview cache.** After editing and rebuilding `data-settings-entry.tsx`
(`node frontend/build-react.mjs`) but *before* re-running `cargo build`, the exact same crash
persisted - including after fully clearing WebKitGTK's on-disk cache
(`~/.local/share/com.bober.tauripoc/WebKitCache`, confirmed via `find`/`rm -rf` and a fresh
process launch). The real cause: this PoC's `tauri.conf.json` has no `devUrl` configured, so
`frontendDist` is embedded into the compiled binary by `tauri-build`'s `build.rs` at `cargo
build` time - editing a `.js` file on disk afterward has no effect until Rust is rebuilt, even
though the file is served from that same path at runtime. Re-running `cargo build` alone (no
code change needed beyond the one already made) picked up the fix immediately. Worth recording
as its own finding: a future round that edits only `frontend/*.tsx` must still run `cargo build`
before re-testing in the compiled app, not just `node frontend/build-react.mjs` - the standalone
sidecar harness never has this problem (it runs the bundled `.cjs` directly off disk), which is
exactly why this didn't surface until the first real multi-tab round that also happened to need
a post-hoc frontend fix.

### A twenty-seventh real page: the first real Minecraft-specific subsystem, and a `.jpg` icon

`InstallMinecraftServerPanel.tsx` is the "+ Add server" install-from-scratch wizard for a brand
new Minecraft server - the first page in this PoC to exercise `lib/minecraftInstall.ts`/
`minecraftInstallClient.ts` (real, unmodified), which fetch/build the right files for
vanilla/Paper/Fabric/Forge/NeoForge/Spigot/Sponge servers. Picked specifically because
`minecraftInstallClient.ts`'s own top-of-file comment already flags that none of this code had
ever been verified against the real Mojang/Paper/Fabric/Forge/NeoForge/Sponge APIs *from the
real app's own development sandbox either* - this PoC's network-less sandbox hitting the same
honest failure is the same category of gap the real codebase already carries, not a new one, and
this round is the first time any of this ~870-line subsystem has actually been exercised at all,
in either environment. Also the first page needing a `.jpg` icon asset (Spigot's own) alongside
the already-proven `.png` ones - `build-react.mjs`'s esbuild `loader` map just needed a second
entry (`{'.jpg': 'dataurl'}`), no new mechanism.

**Confirmed standalone first**: `minecraft.install.listVersions`/`.listLoaderVersions` both
returned the real, honest `"fetch failed"` error (no network access in this sandbox) in well
under a second for every loader type tried (vanilla, paper) - fast and deterministic, not a
hang, confirmed worth proceeding to the full compiled-app round without risk.

**Confirmed through the real compiled app**: the real, unmodified wizard rendered correctly on
load, including the real per-type icon (Paper's `.png`, then Spigot's `.jpg` after switching
types, both inline `data:` URIs baked into the bundle) and the real type-specific hint text:
switching to Spigot correctly hid the "Loader / build version" selector entirely (matching
`supportsLoaderVersionSelection()`'s real logic) and the real `listVersions('spigot')` call
fired fresh, producing the same honest `"fetch failed"`. Filling in a name/install directory,
checking the EULA box, and clicking **Install** correctly hit the real component's own
`handleInstall()` validation guard - `"Pick a Minecraft version first."` - rather than ever
reaching `window.api.minecraft.install.run(...)`, because `minecraftVersion` can never get
auto-selected from an empty `versions` list when every real version fetch has already failed.
Confirmed no file or directory was created at the chosen install path - the real guard blocked
before any real I/O, exactly as a real offline user would experience it. No new bug - the real
validation logic, the real per-type UI branching, and the real honest network failure all
matched their own standalone predictions.

### A twenty-eighth real page: the first real Minecraft profile this PoC has ever had

`MinecraftServerDetail/ServerManagementTab.tsx` is the Minecraft side's own startup/scheduled-
restart settings tab - picked specifically because it's small (86 lines) and reuses the already-
proven `ServerDetail/ScheduleDaysPicker.tsx` component unchanged, which let this round focus on
standing up something every later Minecraft-side round will need: the Minecraft profile CRUD
foundation itself (`minecraft.profiles.list`/`.save`/`.delete`, plus a `minecraft-profiles-
changed` push event mirroring `profiles-changed`'s own shape). This sandbox has never had a real
Minecraft profile before this round (`minecraftProfiles: 0` confirmed directly in `config.json`
after every earlier round that touched the Minecraft store only in passing - "A twenty-sixth
real page"'s `cluster.import`). `ipc/minecraft.ts`'s own `minecraftProfilesSave` handler calls
the exact same `applyMinecraftScheduledRestart`/`applyMinecraftBackupSchedule` pair already
imported for that round's `cluster.import` - new direct call sites, not a new mechanism.

**Confirmed standalone first**: a real `minecraft.profiles.save` round-trip (create, update with
`scheduledRestartEnabled: true`, delete) fired a real `minecraft-profiles-changed` push event at
each step and left the sandbox back at zero Minecraft profiles afterward.

**Confirmed through the real compiled app**: a thin wrapper entry seeded one real Minecraft
profile via the real, unmodified `createDefaultMinecraftProfile()` (`lib/minecraftProfile.ts`)
plus a real `minecraft.profiles.save` call, then mounted the real `ServerManagementTab.tsx`
against it - the first page in this PoC's history where a Minecraft profile, not an ARK one, is
what's being edited. Enabling the scheduled-restart checkbox, picking Monday, and leaving the
default time correctly started the real live countdown (`computeNextOccurrence`/
`formatCountdown`, both real, unmodified, from `shared/scheduleTime.ts`) ticking down to the
real next Monday midnight, and the resulting write - `scheduledRestartEnabled: true`,
`scheduledRestartDays: [1]` - was confirmed directly in `config.json`'s `minecraftProfiles`
array, not just trusted from the UI. No new bug - the real scheduled-restart logic, the real
shared countdown math, and the real reused `ScheduleDaysPicker` component all matched their ARK-
side behavior exactly, with zero changes needed for the Minecraft side's own field names.

### A twenty-ninth real page: a real third-party UI library, and a CSS-import build gap

`MinecraftServerDetail/ConsoleTab.tsx` is the Minecraft side's live console - unlike ARK's own
Group Console (a tailed, parsed log file), it reads straight off the server process's piped
stdout and renders with `xterm.js` (`@xterm/xterm` + `@xterm/addon-fit`), the same real terminal-
emulator library Pterodactyl's panel uses, not a React list of `<div>` lines. The first page in
this PoC to pull in a real third-party UI library rather than plain DOM/CSS, and the first to hit
a build gap neither `.png`/`.jpg` assets nor any real-code import before it had: the real,
unmodified component's own `import '@xterm/xterm/css/xterm.css'` line has no equivalent in
esbuild the way it does in the real app's Vite build (which injects a stylesheet as a module
side effect automatically) - a plain `esbuild` call fails outright on it, same root cause as the
`.png`/`.jpg` loader gaps, a third file type this time. Fixed with `loader: { '.css': 'empty' }`
(makes the import a harmless no-op in the bundled JS) plus the real `xterm.css` file itself
copied byte-for-byte from `node_modules/@xterm/xterm/css/xterm.css` into
`frontend/xterm.css` and linked via a plain `<link rel="stylesheet">` in `minecraft-console.html`
- xterm.js genuinely needs this CSS to lay out correctly (cursor positioning, viewport sizing),
not just for cosmetics, so discarding it outright the way `'empty'` does for the *import
statement itself* would have left a visually broken terminal, not just an unstyled one.

**Confirmed through the real compiled app** (no standalone round needed - every real call this
page makes was already proven by earlier rounds; this one is about the real rendering stack,
not new backend surface): the real, unmodified `ConsoleTab.tsx` mounted a real `xterm.js`
terminal instance with the real `xterm.css` applied - confirmed visually, the terminal rendered
with correct sizing and the real monospace font, not a collapsed or unstyled `<div>` - and
correctly showed the real honest `"No console output yet - start the server to see it."`
placeholder (real `getConsoleBacklog()` returning empty, `state === 'stopped'`). The command
input below it correctly showed `"Server is not running"` and a disabled Send button, matching
the real component's own `state !== 'running'` gate exactly - confirming the real
`useMinecraftServerStatuses` hook (shared with every other Minecraft-side page that will need
live status) round-trips through the full Rust+sidecar pipeline too, not just standalone. No new
bug - the only genuinely new thing this round found was a build-tooling gap, not a logic one.

### A thirtieth real page: the Minecraft server's own launch/startup settings

`MinecraftServerDetail/StartSettingsTab.tsx` - server type, Minecraft version, install directory,
jar/script launch mode, memory, extra JVM/program arguments, dashboard group, and the "Re-detect
from install directory" button. Reuses three already-proven real call sites wholesale
(`minecraft.install.listVersions`/`listLoaderVersions` from "A twenty-seventh real page",
`minecraft.profiles.save` from "A twenty-eighth real page") plus one genuinely new one:
`lib/minecraftDetect.ts`'s `detectMinecraftLaunchable(installDir)` - a plain `fs.readdirSync`-
based filename heuristic with no Electron coupling at all, backing the re-detect button.

**Confirmed standalone:** pointed it at a real directory containing a real
`paper-1.20.1-196.jar`, got back `{"launchMode":"jar","jarFileName":"paper-1.20.1-196.jar",
"scriptFileName":"","serverType":"paper"}` - the real filename heuristic correctly inferred
`"paper"` from the jar name. A nonexistent directory correctly returned `null`.

**Confirmed through the real compiled app:** the real, unmodified `StartSettingsTab.tsx`
rendered every section (Server/Launch/Extra Settings) with real seeded-profile values. Picking
"Paper" from the real server-type `<select>` correctly triggered a real
`minecraft.install.listVersions('paper')` call and rendered the same honest `"fetch failed"`
this sandbox has produced for every real network call since "A twenty-seventh real page" - not a
silent failure, the real component's own error-display path. Typing the real test directory's
path into "Install directory" and clicking "Re-detect from install directory" correctly called
the real `detectMinecraftLaunchable()` through the full Rust+sidecar pipeline and filled "Jar
file name" with the real `paper-1.20.1-196.jar` it found on disk - confirming this round's one
new call site, not just the three reused ones, actually works end to end. No new bug.

### A thirty-first real page: the Minecraft backup process log, and a live-push round trip verified via devtools

`MinecraftServerDetail/BackupLogPanel.tsx` - a small (53-line), self-contained live log of a
backup's save-off → save-all flush → settle → zip → save-on sequence, the Minecraft-side twin of
ARK's own already-proven `ServerDetail/BackupLogPanel.tsx`. Backed by `lib/minecraftBackup.ts`'s
real, unmodified `getMinecraftBackupLog()` (an in-memory `Map<profileId, BackupLogEntry[]>`, not
disk-backed) and its own `minecraftBackupEvents` 'log' emitter - the same request/response +
push-event shape ARK's backup log already proved, applied to Minecraft's own in-memory log store
for the first time.

Unlike every other push event this PoC has exercised so far, nothing in the currently-ported
Minecraft subsystem can legitimately trigger one yet - `createMinecraftBackup()` (the real
function that would call `logMinecraftBackup()`) lives in `BackupsTab.tsx`/`ModsTab.tsx`
territory, still unported. Rather than leave the live-push half of this page's contract
unconfirmed, added one test-only sidecar method, `minecraft.backup.appendTestLogLine`, that
calls the real `logMinecraftBackup()` directly - not a synthetic line format to parse (unlike
`console.appendTestLine`'s own test-only method from "A sixth real page", which has to fabricate
a line the real log parser accepts), just the real logging function itself, invoked for test
purposes. Exposed as `minecraft_backup_append_test_log_line`, the same test-only pattern
`server.installTestExecutable`/`console.appendTestLine` already established.

**Confirmed standalone:** `minecraft.backup.getLog` returns `[]` for a profile with no log
entries yet (matches the real function's own `?? []` fallback); `appendTestLogLine` followed by
`getLog` round-trips the real entry correctly.

**Confirmed through the real compiled app, including the live push path:** the real, unmodified
`BackupLogPanel.tsx` rendered its honest `"No backup activity yet."` empty state on mount. With
WebKitGTK's own Inspect Element → Console open (same technique as "A sixth real page"'s original
bug hunt), typing `window.__TAURI__.core.invoke('minecraft_backup_append_test_log_line', {
profileId, message })` by hand and pressing enter made the real log entry appear in the running
panel within about a second, correctly timestamped and formatted (`9:45:00 PM  Disabling
autosave and flushing the world to disk (save-all flush)...`) with no page reload - confirming
the full push-event pipeline end to end for this new real call pair: sidecar
`EventEmitter.emit('log', ...)` → Rust `app.emit` forwarding → `window.__TAURI__.event.listen`
→ the real component's own `setEntries` state update. No new bug - the only thing unconfirmed is
what triggers this log in practice (a real `createMinecraftBackup()` run), which needs
`BackupsTab.tsx` itself, still unported.

### A thirty-second real page: real world backup CRUD, and a confirm() bug this PoC's own Tauri shim surfaced

`MinecraftServerDetail/BackupsTab.tsx` - the Minecraft-side twin of ARK's own already-proven
`BackupsTab.tsx` (see "A seventh real page"), backed by the rest of `lib/minecraftBackup.ts`'s
real, unmodified exports: `createMinecraftBackup()` (zips the real world dimension folders with
`archiver`, no RCON `SaveWorld` step the way ARK's own has - Minecraft's save-off/save-all flush
already happens over stdin/RCON, proven in "A twenty-ninth real page"), `listMinecraftBackups()`,
`deleteMinecraftBackup()`, `restoreMinecraftBackup()` (extracts a real zip back over the install
directory with `adm-zip`), and `openMinecraftBackupFolder()`. Composes the already-proven
`BackupLogPanel.tsx` directly as a child, and the already-proven `useMinecraftServerStatuses`
hook for its "stop the server before restoring" gate - neither needed a new window.api surface.

**Confirmed standalone:** `minecraft.backup.create` against a real test `world/` folder produced
a real, valid zip on disk; `.list`/`.delete` round-tripped it correctly.

**Confirmed through the real compiled app:** pre-seeded a real profile (standalone, before
launch - same technique as every other round's config.json verification, just used to seed
instead of just read) with a real `installDir` containing a real `world/level.dat` and a real
`backupDir`, since this tab itself has no install-directory field of its own. Clicking "Create
backup now" produced a real zip, the table updated live via the real `onCreated` push event with
no manual refresh, and the composed `BackupLogPanel.tsx` showed the real honest log trail
("Server is not running - backing up the world files as they are on disk." →
"Zipping world into ...zip..." → "Backup created: ...zip (0.0 MB)") - confirming the two
thirty-first-round push events actually fire from a real operation, not just the test-only
trigger. Selecting the row and clicking "Delete selected backup" correctly emptied the table.

**A genuine bug, not an environment limitation:** clicking "Restore selected backup" showed no
visible confirmation dialog at all, yet modifying the real world file and clicking the button
again made it visibly revert to the backup's content - the restore ran regardless. Root cause,
confirmed via devtools: `confirmAction()` (`lib/confirmAction.ts`, shared with every
destructive-action button ARK's own pages already use) calls the bare, synchronous
`window.confirm(message)` and checks its return value truthily - but Tauri 2's dialog plugin
polyfills `window.confirm` into an **async** function returning a `Promise`, which this PoC's
`capabilities/default.json` never granted (`dialog:allow-confirm` etc.), so it immediately
rejects with "dialog.message not allowed" - confirmed by typing `confirm('test')` into the
console directly. `confirmAction()` never awaits that promise, so `!confirmAction(message)` sees
a truthy `Promise` object, not a boolean, and the `if (!confirmAction(...)) return` guard never
fires - the destructive action proceeds exactly as if the user had clicked "OK", with no
dialog, no error, and no way to actually cancel. Unlike the native file-dialog gaps (which fail
loudly - frozen webview, or a real `"fetch failed"`-style error), this one fails *silently in
the dangerous direction*: every `confirmAction()`-gated button in this whole PoC (ARK's own
backup/profile-delete buttons included, not just this round's) has been proceeding without real
confirmation since the very first round that used one, and nothing in any prior round's testing
happened to notice because the described (removal/overwrite) action is also the one being
intentionally tested. A real migration would need either `dialog:allow-confirm` granted and
`confirmAction()` rewritten to `await` the real Tauri dialog API, or a custom in-page confirm
modal - not a one-line fix, since the whole call site is written against a synchronous contract
Tauri doesn't honor.

**A second, more ordinary finding:** "Open backup folder" produced a real, honest error -
`Launcher "gio" "open" ".../backups" failed with ExitStatus(unix_wait_status(512))` - the same
category of gap as every other `shell.openPath` call in a sandbox with no real desktop file
manager (see "The reverse direction"), surfaced correctly through the catch path this time,
unlike the confirm() bug above.

### A thirty-third real page: the server.properties editor, writing straight to a real file

`MinecraftServerDetail/ServerSettingsTab.tsx` - a large, purely declarative form (every field
driven by a typed `BoolField`/`TextField`/`NumberField`/`SelectField` description, not
hand-written per-field JSX) over the real server.properties file, backed by two real,
unmodified pieces: `lib/minecraftProperties.ts`'s `readServerProperties()`/
`upsertServerPropertiesKeys()` (plain line-based `key=value` parsing and in-place rewriting,
preserving comments/ordering/unknown keys exactly - the Minecraft-side equivalent of ARK's own
`gameConfigWrite.ts`) and `lib/minecraftBackup.ts`'s `openMinecraftServerRootFolder()` (the
`shell.openPath` round trip, same as "A thirty-second real page"'s backup-folder button, a
different real function this time).

**Confirmed standalone:** read a real test `server.properties` file (every documented vanilla
key, generated by hand to match a real file's shape) correctly; a save updated only the
requested keys, leaving the rest - including comments and line order - byte-identical.

**Confirmed through the real compiled app:** pre-seeded a profile pointing at that real file
(same technique as "A thirty-second real page"). The real, unmodified component rendered every
field correctly with the real file's actual values. Editing the Motd text field, toggling the
Hardcore checkbox, and changing the Gamemode `<select>` to "creative" each independently wrote
through to the real file on disk immediately (no debounce, no explicit Save button - this tab
saves on every single field change, confirmed by re-reading the file after each one), each write
touching only its own key and leaving every other line untouched. "Open server folder" produced
the same honest `shell.openPath`/`gio` failure as "A thirty-second real page", confirming it's a
property of the sandbox (no real desktop file manager), not of either specific real function
that calls it. No new bug.

### A thirty-fourth real page: Modrinth/CurseForge mod management, and a harness bug that looked like a Tauri bug

`MinecraftServerDetail/ModsTab.tsx` - the largest Minecraft-side tab yet (460 lines), backed by
the real, unmodified `lib/minecraftMods.ts` (1187 lines: Modrinth/CurseForge search, install,
update, and hash-based folder scanning). Reuses the already-proven `window.api.settings.get()`
(the CurseForge-API-key gate) and `confirmAction()`, plus the established `.png`/`.jpg` ->
`dataurl` asset-loader pattern for the real Modrinth/CurseForge source-logo PNGs and per-loader
server-type icons.

**Confirmed standalone:** against a real `mods/` folder containing a real (fake-content) jar,
`minecraft.mods.scan` and `minecraft.mods.search` both hit the same honest "fetch failed" this
sandbox produces for every real network call (Modrinth's hash-lookup and search APIs) -
`scanForInstalledMods()` needs network access even just to *identify* an untracked file, not
only to install one. The purely offline operations - `setEnabled` (renames
`<file>.jar` <-> `<file>.jar.disabled` on disk) and `remove` (deletes the file) - both round-
tripped correctly against a real pre-tracked entry with no network involved at all.

**Confirmed through the real compiled app:** the real, unmodified `ModsTab.tsx` rendered the
pre-tracked mod correctly (title, "Unidentified" status, Disable/Remove buttons). Search
produced the same honest "fetch failed", visibly surfaced through the component's own
`error-message` paragraph. "Open folder" hit the same `shell.openPath`/`gio` failure as the
backup/server-settings folders - a third different real function confirming the same sandbox
limitation. Disable correctly renamed the real file on disk and the button flipped to "Enable",
reflecting the real returned profile.

**A debugging detour worth recording, since it could be mistaken for a new Tauri-shim finding:**
clicking "Remove" first appeared to silently do nothing - no file deleted, no visible error. This
was *not* a repeat of "A thirty-second real page"'s `confirmAction()`/`window.confirm()` bug:
devtools showed a second, different unhandled rejection underneath the familiar `dialog.message
not allowed` one - `TypeError: undefined is not an object (evaluating
'window.api.system.focusWindow')`, thrown from inside `confirmAction()` itself
(`lib/confirmAction.ts` calls `window.api.system.focusWindow()` unconditionally after
`window.confirm()`). This entry file's own `window.api` declaration had simply omitted
`system.focusWindow` - a real, already-proven call this PoC's own harness forgot to wire up for
this one page, not a defect in the real app. Fixed by adding it (reusing the already-proven
`window_focus` Rust command, as other entries already do); "Remove" then worked exactly like "A
thirty-second real page"'s "Restore" - the file was deleted with no visible confirmation
dialog, the same `confirmAction()` bug, now reproduced a second time on a second real page. A
good reminder that an entry wrapper's own `window.api` surface is itself something to get
wrong, and that devtools' full list of unhandled rejections - not just the first one - is worth
reading before concluding what broke.

### A thirty-fifth real page: the real tab-switching shell, composing all six Minecraft tabs

`MinecraftServerDetail/index.tsx` - the Minecraft-side twin of "A twenty-fifth real page"
(`ServerDetail/index.tsx`'s own ARK tab-shell composition). No new real backend surface at all:
every tab it renders (`ConsoleTab`, `StartSettingsTab`, `ServerSettingsTab`, `ModsTab`,
`BackupsTab`, `ServerManagementTab`) is already individually proven, so this entry is simply
their `window.api` union. The genuinely new thing this round proves is the shell itself: the
real grouped left nav (Overview/Configuration/Maintenance), the `tab` state switching which
child actually mounts, and `tabsFor()`'s per-server-type branching (a `forge` profile correctly
shows "Mods", not "Plugins" - SpongeForge's own both-at-once case remains unexercised, no profile
of that type has exercised this PoC yet).

**Confirmed through the real compiled app** (no standalone round needed, same reasoning as "A
twenty-fifth real page"): clicked through all six tabs in the real sidebar - each one's already-
proven content rendered correctly, with the active item highlighted. The one thing a standalone
single-tab entry could never prove: clicking "Go to Start Settings" from `ModsTab.tsx`'s own
no-version-set empty state (`onGoToStartSettings`) performed a real **in-app** tab switch - the
sidebar's own "Start Settings" item lit up active and the real `StartSettingsTab.tsx` mounted in
place, confirming the cross-tab callback itself (not just each tab in isolation) works unmodified
against this architecture. No new bug.

### A thirty-sixth and last real page: MinecraftDashboard.tsx, and the actual headline case for Minecraft

`MinecraftDashboard.tsx` - the server list, composing two more already-proven real components
unmodified (`HardwareStatsBar.tsx`, `InstallMinecraftServerPanel.tsx`) plus `tabsFor` from the
already-proven `MinecraftServerDetail/index.tsx`. The one genuinely new real backend surface:
`lib/minecraftActions.ts`'s `doStartMinecraftServer`/`doStopMinecraftServer`/
`doKillMinecraftServer` → `lib/minecraftProcess.ts`'s `startServer`/`stopServer`/`killServer` -
**the actual headline case for the Minecraft side**, a real spawned process, monitored, and
`lib/minecraftDetect.ts`'s `detectMinecraftProfile`/`isValidMinecraftInstall` for the "Import
existing server" button. This is the last page in this PoC's entire original scope - every real
page identified at the start of this exploration has now been ported.

**Confirmed standalone**, using a real stand-in shell script (`launchMode: 'script'`, the same
role `server.installTestExecutable` plays on the ARK side, written fresh for this round since no
Minecraft equivalent existed yet) that traps `SIGTERM`, prints the real `Done (2.345s)! For help,
type "help"` ready-marker `startServer()`'s own `READY_MARKER` regex matches, and exits on a
real `stop` command read from stdin: the full real lifecycle fired correctly end to end -
`starting` → real console lines captured from the spawned process's piped stdout → the real
ready-marker regex flipping the status to `running` → a real graceful stdin `"stop"` → the
script exiting cleanly → `stopped`, with real `manager-log-entry` events at each step. Kill
(`SIGTERM` sent directly via pid, no stdin command) and `importFromInstall` (both a real valid
detection and the real honest validation error for an invalid folder) were also confirmed
standalone.

**Confirmed through the real compiled app:** the real, unmodified `MinecraftDashboard.tsx`
rendered a full real dashboard - `HardwareStatsBar.tsx` showing genuinely real hardware ("4
Cores / 4 Threads • Intel Xeon® Processor", "15.7 GB total RAM") and live-polling real network
throughput (watched the numbers update from "-" to real KB/s figures), real grouped/hidden
server sections (a `<details>` toggle, a drag handle, bulk start/stop/restart per group), and
the real card "..." menu correctly reusing `tabsFor()` to omit "Mods" for a `vanilla`-type
profile (no ecosystem) - the same per-server-type branching "A thirty-fifth real page" already
proved, now exercised from a second, independent call site. Clicking the real Start button on a
profile pointed at the stand-in script produced the exact same lifecycle confirmed standalone,
this time visible live in the UI: the status badge flipped `stopped` → `starting` → `running`,
real CPU/memory stat tiles went from `-` to live `0%`/`2 MB` (a real `pidusage` read off the
actual spawned process), and Stop correctly returned everything to `stopped`. No new bug - one
minor, expected real quirk noted: the Uptime tile briefly shows a negative value right after a
very recent start, because `now` (the tile's own 30-second-interval clock) is captured at page
mount, before the server's own real `startedAt` timestamp exists; it self-corrects on the next
tick, exactly as the component's own code comment says it's designed to.

This closes out the originally-identified scope of this PoC: every real page in both the ARK and
Minecraft sides of the application has now been proven to run its real, unmodified business
logic through this Rust/Tauri + Node-sidecar architecture, including the two actual headline
cases (ARK's own real spawned-process lifecycle, proven earlier, and this round's Minecraft
equivalent) that the whole exploration set out to answer.

### Closing the confirmAction()/window.confirm() bug for real, not just documenting it

Every "What this doesn't prove yet" entry above was something this sandbox structurally can't
reach - a real desktop session, a real credential, a real game binary. The confirm() bug wasn't
one of those: it was a genuine, fixable bug in how this PoC wired up Tauri's dialog plugin, so
once asked to actually close out the PoC's own remaining scope (rather than just the 36 pages),
this was the one item worth fixing for real instead of filing away.

Root cause, precisely: `tauri-plugin-dialog` doesn't just expose a `dialog.confirm()` API for
code that opts in - registering it at all (`.plugin(tauri_plugin_dialog::init())`) makes the
plugin inject a script into *every* webview that unconditionally overwrites `window.confirm`,
`window.alert`, and `window.prompt` with async, Promise-returning versions, regardless of
whether any frontend code ever imports the plugin's JS API. That override is what broke
`confirmAction()`'s synchronous contract - no amount of granting `dialog:allow-confirm` would
have fixed it, since even a successfully-resolving `window.confirm()` would still return a
`Promise`, not a `boolean`, to code written assuming the real browser/Electron contract.

The fix: stop using `tauri-plugin-dialog` at all. The six `dialog_select_*`/`dialog_save_*`
commands only ever needed `rfd` (`tauri-plugin-dialog` is itself a thin wrapper around `rfd`
internally) - switching them to call `rfd::FileDialog` directly, and dropping the
`tauri-plugin-dialog` dependency and its `.plugin(...)` registration entirely, removes the
injected script with it. `window.confirm()`/`window.alert()`/`window.prompt()` go back to being
whatever WebKitGTK's (or WebView2's) own native implementation does - a real, synchronous,
blocking OS dialog, the same contract Electron's `window.confirm()` already has, with zero
changes needed to `confirmAction()` or any other real file.

Confirmed two ways through the real compiled app, not just by reading the diff: typing
`typeof window.confirm('test-sync-confirm')` into devtools now pops a real native "JavaScript -
tauri://localhost" dialog with Cancel/OK buttons (not an instant rejected Promise), and the
expression only resolves - to the real string `"boolean"` - after that dialog is actually
dismissed. Then, against `WatchedPlayersSection.tsx` (unmodified, the same real
`confirmAction()`-gated `handleRemove` every destructive button in this PoC shares): clicking
"Remove" on a real tracked entry now pops the real "Stop watching "TestPlayer123"?" dialog;
clicking **Cancel** left the entry genuinely untouched in the list (the exact case that
silently failed before - the whole point of the original bug); clicking **Remove** again and
then **OK** genuinely deleted it. Both the "cancel actually cancels" and "confirm still works"
halves of the real contract are now proven, not just the second one.

### A real data-migration tool, not just a plan for one

`MIGRATION-PLAN.md` (new, see that file for the full production-migration roadmap this section
is one piece of) names real data migration as a genuine gap, and the gap turned out to have a
real wrinkle worth fixing in code rather than just describing: `electronShim.ts`'s own
`POC_USER_DATA` path can't just be pointed at the real Electron app's actual userData folder,
because that folder's exact name isn't a safe guess - Electron's `app.getPath('userData')`
derives from `app.getName()`, which defaults to reading package.json's own `name` field
(`"ark-server-manager"`), while electron-builder's `productName`
(`"Bober Server Manager"`) is what often actually shows up on disk depending on exact
packaging config. Guessing wrong risks silently missing a real user's real profiles.

`sidecar/legacyImport.ts` (three new RPC methods, `legacyImport.detect`/`.preview`/`.run`, plus
three matching `main.rs` commands and a new "Legacy data import" section in `index.html`) checks
both candidate folder names per OS instead of assuming one, previews a manually-picked folder
(the already-fixed native directory dialog) as a fallback, and imports real ARK/Minecraft
profiles through the real `migrateProfile()`/`migrateMinecraftProfile()` then
`saveProfile()`/`saveMinecraftProfile()` - the same functions every other real write in this
PoC already goes through - skipping, not overwriting, ids the current store already has.
Confirmed idempotent (importing the same fake legacy install twice imports once, skips the
second time) both standalone and through the real compiled app via devtools-driven `invoke()`
calls (the manual-browse button's own native-dialog happy path has the same "needs a real
desktop click" gap as every other native picker in this PoC - see "What this doesn't prove
yet"). Found and fixed a real bug along the way: a deliberately bare-bones legacy-shaped
profile (missing `backupDir`/`clusterDirOverride`, fields that may not exist in truly old
on-disk data) crashed `saveProfile()`'s own sanitization step with
`Cannot read properties of undefined (reading 'trim')`, because `migrateProfile()` itself
never defaults `backupDir` - in normal real-app use the React form that produces a profile
object always initializes it first, a guarantee a raw imported JSON file doesn't carry. Fixed
in the importer (defaulting the three fields `stripWrappingQuotes()` touches before writing),
not in any real app file. Only profiles/Minecraft profiles plus a best-effort `customMaps.json`
copy are covered so far - see `MIGRATION-PLAN.md`'s own data-migration section for what's left
(bans, whitelist, watchlist, and access tokens were added in a later round - see "Extending the
legacy import" below) - 176 Tauri commands total now (counted directly from `main.rs`'s own
`generate_handler!` list, not carried forward by arithmetic from the thirty-sixth page's own
count above, which this correction doesn't revisit).

### Extending the legacy import to bans, whitelist, watchlist, and access tokens

The data-migration tool above only imported ARK/Minecraft profiles at first. Extended it to
`playerBans`/`playerWhitelist` (looped once per legacy `profileId` through the real
`recordPlayerBan()`/`recordWhitelistedPlayer()`, since those are keyed by player id with a
`profileIds` array rather than a flat list - the real functions' own upsert-merge logic handles
this correctly when called once per profile, while this importer's own "never touch an id
already present" guarantee stays intact), `watchedPlayers` (flat, via the real
`addWatchedPlayer()` directly), and `webDashboardAccessTokens` (importing the real `secretHash`
as-is, not regenerating it, so an already-distributed token keeps authenticating against the
new app with nothing to reconfigure). `legacyImport.detect`/`.preview` now report counts for
all six data kinds, and `index.html`'s own UI text reflects them. Confirmed standalone and
through the real compiled app: all six kinds import correctly on a first run and are correctly
skipped (not duplicated) on a second run against the same fixture.

### The real App.tsx shell, not one more per-page wrapper

Every earlier round in this PoC mounted exactly one real page inside its own small wrapper -
each with its own hand-written partial `window.api` union, correct for that one page but never
meant to be the app's actual bridge. This round mounts the real, completely unmodified
`src/renderer/src/App.tsx` (609 lines) itself - the actual top-level shell every one of those
pages normally lives inside - via a new `poc-tauri/frontend/app-entry.tsx` + `app.html`.

**No router or Context providers needed, it turns out.** Confirmed by reading the real
`src/renderer/src/main.tsx` this entry mirrors exactly: a plain
`ReactDOM.createRoot(...).render(<App />)` inside `React.StrictMode`, nothing else. `App.tsx`
is one large component that owns its own page-switching state via plain `useState` and calls
`window.api` directly for what it needs itself (profile lists, map definitions, per-profile
install/version checks, startup-complete gating), rendering whichever already-proven real page
the user has navigated to.

**The real fix this PoC's own `MIGRATION-PLAN.md` calls for, built for real:**
`poc-tauri/frontend/lib/windowApi.ts` - one complete `window.api` bridge, mechanically merged
from every one of the ~36 existing per-page unions (not re-derived from scratch), that
`installWindowApi()` installs once at mount. Also the first page in this PoC to load the real
`app.css` (`styles.css`, copied byte-for-byte as `app-styles.css`) instead of staying
deliberately unstyled - this round proves the real layout renders correctly, not just the logic
underneath it.

**Real gaps found only once the real shell was actually mounted**, never exercised by any
single-page entry before because they're called by `App.tsx` itself or by components it renders
unconditionally that no earlier round ever mounted standalone (`TitleBar.tsx` in particular -
no per-page wrapper renders its own title bar):
- `window.api.server.isInstalled` / `window.api.appStartup.isComplete`/`.onComplete` - called
  directly by `App.tsx`. This sidecar has no real multi-step boot chain to replicate (re-attach
  processes, start the web dashboard, arm the scheduler, auto-start servers, ...) the way the
  real `main/index.ts` does, so it marks its own startup complete right after its own init
  finishes - an honest stand-in, not a replica of every real step. `isValidArkInstall()`
  (`lib/detect.ts`) backs `isInstalled`, real and unmodified.
- `window.api.windowControls.{minimize,toggleMaximize,close,isMaximized,onMaximizedChange}`,
  `window.api.system.{quit,openDevTools}` - the real `TitleBar.tsx`'s own minimize/maximize/
  close buttons and File menu. Same sidecar-free native-window-handle class as `window_focus`
  (five new Rust commands, no sidecar involvement) - and `window_toggle_maximize` is the first
  command in this entire PoC to push an event (`window-maximized-changed`) straight from Rust
  to the webview, not relayed from the sidecar like every other push event so far, since this
  is pure window state the sidecar has no reason to know about. With the window now frameless
  (`decorations: false`, matching the real app's own custom-title-bar design - temporarily set
  during this round's testing, reverted after since the PoC's shared `tauri.conf.json` window
  config also needs to serve every un-chromed demo page), the custom title bar's button is the
  only way this state ever changes, so firing the push from there covers every real case for
  this architecture.
- `window.api.dialog.selectProfileFile` / `window.api.profiles.importFromFile` - the real
  "+ Add Profile" wizard's "Import from file..." button, explicitly left out of scope by the
  original `dashboard-entry.tsx` round ("needs the native folder/file picker"). Backed by the
  real, unmodified `parseImportedProfile()` (`lib/profileExport.ts`), never called anywhere
  else in this PoC until now.
- `window.api.systemStats.get` - `App.tsx` itself calls this exact channel name, a separate IPC
  channel (`IPC.systemStatsGet`) from `getStaticInfo()`'s own `IPC.systemStatsGetStaticInfo` -
  but the real main-process handler for both is the identical `getSystemStaticInfo()` (see
  `src/main/ipc/systemStats.ts`), a naming inconsistency already present in the real app, not
  introduced here. Reuses the same Tauri command rather than adding a redundant one.

**Confirmed through the real compiled app, not just a clean build:** real-styled title bar
("File"/"Tools"/"Help", version badge, bell/notifications icon, minimize/maximize/close), real
sidebar (ARK/Minecraft game-mode icons plus cluster/players/settings icons below), real
Dashboard with live CPU/Memory/Network stat tiles and real seeded server cards grouped by their
real group name. Clicking the Minecraft sidebar icon switched the whole app to the real
`MinecraftDashboard.tsx` in place (real empty state, real live network numbers continuing to
update) - confirmed real in-app `useState`-driven navigation, not a page reload. Clicking a
server card's "..." menu showed the real eight-tab list (Analytics/Settings/Mods/Map
Management/Backups/Update Log/Server Management/Files); clicking "Settings" navigated into the
real `ServerDetail/SettingsTab.tsx` with the real seeded profile's real data displayed
(install dir, ports, map, max players); clicking "Mods" in the grouped sidebar switched tabs in
place with no reload; "Back" returned to the real Dashboard, live stats still updating. The
`windowControls.toggleMaximize()`/`isMaximized()` RPC round trip itself completed with no error
either way, but this headless Xvfb sandbox has no real window manager to actually track
maximize/unmaximize geometry against, so the visible before/after state couldn't be confirmed
here - same already-documented category of gap as the native file/folder pickers, not a new
kind of limitation.

## Findings from actually running this, not from reading docs

- **Tauri event names reject dots.** `app.emit("profiles.changed", ...)` fails at runtime with
  `only alphanumeric, '-', '/', ':', '_' permitted for event names` - caught immediately
  because the whole call is wrapped and logged rather than ignored (see `main.rs`). Renamed to
  `profiles-changed`. A real migration would need this as a known constraint when choosing
  event names for every IPC channel being ported, not just this one.
- **~~`electron-store`'s own "am I really in Electron" check ignores a stubbed `app.getPath`~~ -
  root-caused and fixed, not just worked around.** The first write landed at
  `~/.config/ark-server-manager-nodejs/config.json` - not `electronShim.ts`'s intended
  `~/.tauri-poc-bober-manager`. Originally documented as "harmless for this PoC" (the data still
  round-tripped, just to the wrong directory) - that assessment didn't survive contact with a
  real install: see "Actually bundled and installed with `cargo tauri build`" above, where the
  exact same root cause crashed the sidecar outright once there was no `package.json` nearby for
  `conf`'s fallback to find. Traced into `electron-store`'s actual source
  (`node_modules/electron-store/index.js`): it only uses `app.getPath('userData')` when
  **both** `ipcMain` and `app` are truthy, and `electronShim.ts` only ever exported `app`.
  Fixed with a minimal `ipcMain` stub in the shim itself - zero changes to the real `store.ts`.
  Worth contrasting with `lib/managerLog.ts`'s own `getDataDir()` → `app.getPath('documents')`
  call, which *did* go through the shim correctly from the start (confirmed: a real `log.record`
  call landed at `~/Documents/ARK Server Manager/logs/manager.jsonl`, exactly where
  `electronShim.ts` says it should) - this quirk was specific to `electron-store`'s own
  Electron-detection logic, not a general problem with stubbing `app.getPath`.
- **A JSON-RPC response needs a concrete, non-`undefined` result.** `log.record`'s handler
  originally returned whatever `logManagerEvent(...)` resolves to, which is `void` -
  `JSON.stringify({ id, result: undefined })` silently drops the `result` key entirely, leaving
  a response line with neither `result` nor `error`, which Rust's `RpcResponse` (at the time,
  no `#[serde(default)]` on either field) would fail to deserialize. Fixed two ways: the
  handler now returns `{ ok: true }` instead of the bare promise result, and `RpcResponse`'s
  fields got `#[serde(default)]` as a second line of defense for any future handler that makes
  the same mistake.
- **esbuild doesn't resolve the project's own `@shared/*` tsconfig path alias on its own.**
  Bundling `serverProcess.ts`/`logEvents.ts` (needed for the console feed) failed outright -
  `Could not resolve "@shared/types"`/`"@shared/games"` - the instant they were imported,
  because esbuild has no built-in tsconfig-paths support; it needs to be told explicitly. Fixed
  by pointing esbuild's own `tsconfig` option at the project's real `tsconfig.node.json`
  (reusing the existing mapping as the source of truth) rather than hand-declaring
  `@shared/*` → `shared/*` a second time in `build.mjs`, which could drift from the real one. A
  real migration bundling more of `src/main/lib/` would hit this on the first file that uses
  the alias, not something specific to these two files.
- **esbuild has no default loader for binary assets either - same root cause as the alias issue
  above, different file type.** `Dashboard.tsx`'s own `.png` icon imports (the first page in this
  PoC to import one) failed outright with `No loader is configured for ".png" files`, since
  esbuild, unlike the real app's Vite build, doesn't infer one. Fixed with
  `loader: { '.png': 'dataurl' }` in `build-react.mjs`. See "A fifth real page" above.
- **Tauri 2's permission system silently blocks `event.listen()` with no `capabilities/*.json`
  file at all - and this PoC had never created one, in any round.** Every `invoke('custom_command')`
  call worked regardless (app-defined commands aren't ACL-gated), which is exactly why this went
  unnoticed for five rounds: nothing ever surfaced an error, the push events just never arrived.
  Mistaken at first for a WebKitGTK rendering limitation (see "A rendering dead end"'s original
  write-up) until a bare `listen()` call's own rejected promise was actually inspected. Fixed with
  one `capabilities/default.json` file granting `core:default`/`core:event:default`/
  `core:window:default` to the main window. See "A fifth real page" above for the full
  investigation and the retroactive re-confirmation against the original failing scenario.
- **Unlike `lib/*.ts`'s other `serverEvents.on(...)` subscribers, `lib/schedule.ts`'s is gated
  behind a function call, not a module-load side effect - importing just the status-reading
  function left it silently never subscribed.** `registerBackupScheduleWatcher()` has to be
  called once, same as `adoptPersistedProcesses()`. See "A sixth real page" above.
- **Tauri's `invoke()` rejects a failed command with the bare value the Rust side returned (a
  plain string here), not an `Error` instance - unlike Electron's `ipcRenderer.invoke()`, which
  every real component in this app was written against.** The universal
  `catch (err) { setX((err as Error).message) }` pattern used across the whole real renderer
  silently reads `undefined` on a Tauri rejection, with no thrown error and no console warning -
  just a UI that never shows the real failure text. Affects every error-display call site in
  every page this PoC has mounted, not just the one that happened to surface it. Fixed once,
  centrally, with `frontend/lib/tauriInvoke.ts`'s `wrapInvoke()`, applied to all six entry
  files' `invoke` bindings. See "A sixth real page" above for the full investigation.
- **A second instance of "a JSON-RPC response needs a concrete, non-`undefined` result"
  (above), caught only by actually driving the call end to end.** `backup.delete`/
  `backup.restore` mirror `deleteBackup()`/`restoreBackup()`'s own real `void` return - a real
  restore genuinely put a deleted file back on disk, but the response line itself carried
  neither `result` nor `error`, which the Rust side reads as a failure unconditionally. The
  real file being right there on disk is exactly why a type signature alone (`void`, same as
  `log.record`'s own handler originally had) doesn't surface this - only calling the RPC method
  and checking the actual response line does. See "A seventh real page" above.
- **The opposite direction of the same class of bug: a legitimate JSON `null` result is
  indistinguishable from no result at all, confirmed by deserializing both shapes side by side
  and comparing.** `#[serde(default)] result: Option<Value>` collapses `{"result": null}` and a
  response with no `"result"` key at all to the identical `None` - so `readUpdateLog()`'s real,
  honest `null` (a profile that's never been updated, the common case, not an edge case) read on
  the Rust side exactly like a sidecar bug. Fixed at the transport layer (a custom `Deserialize`
  reading the raw `Map` via `.get()`, which does preserve the distinction), not by wrapping every
  legitimately-nullable method's result - the same kind of per-call-site fix the two bullets
  above needed, which this one deliberately avoided needing again. See "An eighth real page"
  above.
- **A debounced derived-state effect (re-fetch 300ms after the last edit) ports with zero
  changes, and genuinely reflects unsaved form state, not just the last-saved profile.** The
  real `SettingsTab.tsx` recomputes `server.previewLaunchCommand(form)` from `form`, not
  `profile` - confirmed live in the real compiled app, typing into the Name field and watching
  the already-displayed launch command (which doesn't even reference the name) stay stable while
  other field edits (ports, max players) immediately redrove a fresh real `buildLaunchArgs()`
  call once the debounce elapsed. See "A twenty-fourth real page" above.
- **Not every native dialog fails the same way in this sandbox - `blocking_save_file()` is
  strictly worse than `blocking_pick_folder()`/`blocking_pick_file()`/`blocking_pick_file()`
  with filters, confirmed by comparing their actual effect on the running app, not assumed from
  the shared "native dialog" category.** The pick dialogs ("A second real page",
  `dialog_select_ini_file`) leave the rest of the app responsive even though the dialog itself
  never visibly renders; `dialog_save_profile_file` froze the entire webview to further input
  until the process was killed - confirmed by typing into an unrelated, already-focused text
  field immediately after clicking "Export profile..." and observing no character landed, where
  the same action worked before the click. See "A twenty-fourth real page" above.
- **~~A third, worse-than-either native-dialog failure mode: `window.confirm()` doesn't freeze
  and doesn't error - it silently never blocks anything at all~~ - found, root-caused, and then
  genuinely fixed, not just documented.** Unlike the pick/save dialogs above, `tauri-plugin-
  dialog`'s injected script replaces `window.confirm()` with an async function returning a
  `Promise` that immediately rejects (this PoC's `capabilities/default.json` never granted
  `dialog:allow-confirm`). Every real `confirmAction()` call site (`lib/confirmAction.ts`, used
  by every destructive-action button across both ARK's and Minecraft's pages, not just this
  round's) calls it synchronously and checks the return value truthily - a `Promise` object is
  truthy, so the `if (!confirmAction(...)) return` guard these buttons all share never fired,
  and the destructive action proceeded exactly as if the user had confirmed, with nothing in the
  UI suggesting anything went differently than normal. Confirmed by modifying a real file on
  disk, clicking "Restore selected backup" with no visible dialog, and watching the file revert
  anyway - see "A thirty-second real page" below for the full root-cause trace. **Fixed** by
  dropping `tauri-plugin-dialog` entirely (its injected script is what overwrites `window.confirm`
  unconditionally, independent of any permission grant) and calling `rfd` directly from the six
  native-dialog commands instead - see "Closing the confirmAction()/window.confirm() bug for
  real" above for the fix and its own real-dialog, real-Cancel, real-OK confirmation.

## What this doesn't prove yet

- **~~Nothing about Windows specifically~~ - now built and run on real Windows too.** Confirmed
  working end to end (read, write, push event, all visually) via WebView2, after fixing two
  Windows-only build issues this surfaced: the MSVC linker (`error: linker 'link.exe' not
  found` without the "Desktop development with C++" Build Tools workload) and a missing
  `icons/icon.ico` (see "Running it"). The RAM numbers below are still Linux-only, though -
  that specific measurement still needs a real run on the Windows machine to mean anything.
- **~~Nothing about streaming~~ - the live console feed itself is now covered**, via the real
  `watchLogFile`/`parseLogChunkWithDate` (see "Result" above) - the stdin/stdout JSON-RPC shape
  does carry a continuous stream of small push events correctly, not just a single
  "entity changed" event. Still nothing about the other ~33 IPC modules specifically (group
  console, stats history, Discord bot status, ...), though they're the same two shapes
  (request/response or push) this PoC has now exercised at least once each.
- **~~Nothing about packaging/bundling the sidecar~~ - all three parts now proven**: the sidecar
  runs as one self-contained executable with no system `node` dependency (Node SEA); it's
  spawned through Tauri's real `bundle.externalBin`/`tauri-plugin-shell` sidecar mechanism, not
  a hardcoded path; and `cargo tauri build --bundles deb` genuinely bundles it into an
  installable `.deb` that runs correctly once `dpkg -i`'d for real - see "Sidecar packaging"
  above, specifically "Actually bundled and installed with `cargo tauri build`", which is also
  where a real crash-on-fresh-install bug got found and fixed. Still outstanding: code-signing
  and auto-update, and the equivalent bundling step on Windows (`.msi`/`.exe` via WiX/NSIS) and
  macOS (`.app`/`.dmg`) - only the Linux `.deb` target has been tried. `SIDECAR_PATH` is still a
  dev-time escape hatch for iterating without rebuilding the SEA binary each time.
- **~~Nothing about `shell.*` calls~~ - proven for `shell.openPath`, the only one any real file
  uses.** See "The reverse direction" above: the sidecar can call back into Rust for a real
  native action and get a real result (success or a real error string) back, through the same
  stdio pipe, with no change to the real file that calls it (`lib/systemFolders.ts`'s
  `openProfilesFolder()`, unmodified). This actually overturns this PoC's own earlier
  speculation in the table below - see the note under it.
- **~~Nothing about the bot sidecar~~ - proven, including a real bug and a validated fix.** See
  "The Discord bot subsystem" above: `lib/discordBot.ts` + `src/bot/` have no Electron coupling
  at all - but `fork()` silently can't spawn a different script from a Node SEA binary (it just
  relaunches the SEA binary's own embedded entry point instead), which would have broken the bot
  subsystem the moment the main sidecar ships as a SEA binary. Fixed with a small, tested,
  opt-in change to the real `discordBot.ts` (15 lines, zero behavior change when unset, existing
  test suite still green) - the *one* real file this whole PoC needed to actually modify, not
  just call unmodified.
- **~~Nothing about the webdashboard sidecar~~ - proven, and it isn't actually a separate
  sidecar at all.** See "The web dashboard subsystem" above: `lib/webDashboard.ts` (8200+
  lines) is an in-process `http.Server`/`https.Server` even in the real app, not a forked
  process like the bot, so none of the SEA/`fork()` problem applies. Confirmed with a real HTTP
  client against the real embedded dashboard page and a real `/api/servers` response, both
  standalone and through the actual compiled app via plain `curl` - and unlike the bot, nothing
  broke; it bundled and ran correctly on the first try despite pulling in a large slice of
  `src/main/lib/` transitively. All three subsystems from the original size estimate (main
  process logic, bot, web dashboard) are now proven.
- **~~Nothing about the real renderer~~ - proven for four real, unmodified pages across two
  subsystems, read-only, write-path, and live/polled.** See "A real React page", "A second real
  page", "A third real page", and "A fourth real page" above: `ManagerLogView.tsx` (read-only),
  `ProfileManagementView.tsx` (copy/move + a native dialog), `PlayerRosterPanel.tsx` (RCON
  roster/kick/ban, a different real subsystem entirely), and `PlayerWhitelistPanel.tsx`
  (tracking-only add/remove, no RCON), all completely unmodified, render correctly against a
  `window.api` shim built to the same surface the real preload already exposes, backed by
  Tauri's `invoke`/`listen` instead of Electron's `contextBridge`. Confirmed with real
  seeded/moved/written data through the real compiled app, screenshotted (including catching and
  fixing a wrapper-only mount-order bug the second page's screenshot surfaced - see "A second
  real page" - and a real correction to this PoC's own earlier "rendering dead end" finding,
  found while confirming the fourth page's write path - see "A fourth real page"). Still nothing
  about the rest of the real renderer - `App.tsx`'s routing/layout, Context providers, or any of
  the other ~26 pages, each touching a different (and in several cases much larger) slice of
  `window.api` than these four do - four pages across two different subsystems confirm the
  *shape* of the port generalizes past the easiest case, not that every page ports this cheaply.
- **~~Nothing about native OS dialogs~~ - proven architecturally, not proven end-to-end in this
  sandbox.** See "A second real page" above: `dialog_select_directory` is wired correctly (the
  command registers, compiles, and calling it visibly does something - a real dialog attempt, not
  a no-op), and it's the right architectural shape (a Rust-only command, matching the real
  `dialog.ts`'s own main-process-only design, no sidecar involved). What's unconfirmed is the
  happy path itself: `tauri-plugin-dialog`'s `blocking_pick_folder()` blocks indefinitely in this
  headless Xvfb sandbox waiting for a human click that can't happen unattended, unlike
  `shell.openPath`'s clean, fast failure. Needs a real desktop session (the same way the Windows
  numbers above needed a real machine) to confirm a folder actually gets picked and returned.
- **~~Nothing about starting/stopping a real server process~~ - proven, standalone and through
  the real compiled app.** See "The actual headline case" above: `startServer()`/`stopServer()`/
  `getStatus()` from `lib/serverProcess.ts` (980 lines, completely untouched until this round)
  spawn, track, and shut down a real OS process with no Electron coupling to shim at all. No real
  ARK/Minecraft dedicated server binary exists in this sandbox, so a test-only stand-in script
  stood in for one at the real, unmodified `getExecutablePath()`'s resolved path - confirmed with
  a genuine spawned PID, the real launch command line from `buildLaunchArgs()`, real
  `server-status` push events, and a real graceful-then-SIGTERM shutdown that left no orphaned
  process behind, both standalone (piping JSON-RPC directly into the SEA binary) and through the
  actual compiled Tauri app under Xvfb (confirmed via the real OS process list appearing then
  disappearing, not a screenshot). Found one real property of the unmodified shutdown code along
  the way: `stopServer()`'s "force kill" is a single SIGTERM with a 10-second give-up, not an
  escalation to SIGKILL - a process that ignored SIGTERM would be reported `stopped` without
  actually being dead. Still unconfirmed: the Windows-only ARK: Survival Evolved `.bat`-launch
  path. ~~No UI page calls any of this yet~~ - closed in "A fifth real page" below: the real
  `Dashboard.tsx` Start/Stop/Restart/Kill/Update buttons now drive this exact RPC layer (through
  the more complete `lib/serverActions.ts` orchestration, not `serverProcess.ts` directly - see
  that section), confirmed with a real click producing a real spawned/killed OS process through
  the actual compiled app, not just the RPC layer in isolation.
- **~~Nothing about surviving a Manager crash~~ - proven, with a genuine two-separate-app-process
  test, not a simulation of one.** See "Surviving a crash" above: `adoptPersistedProcesses()` is
  now wired into `sidecar.ts` at the same point the real `index.ts` calls it, and confirmed to
  correctly re-attach to a still-alive server process - both standalone (two separate sidecar
  processes, the second started after `SIGKILL`ing the first) and through the real compiled app
  (two separate `tauri_poc_shell` processes, the first `SIGKILL`ed outright, the second launched
  completely fresh). This also exercised `waitForExitOrKill`'s "adopted process" code branch for
  the first time in this PoC (`killByPid` instead of `child.kill()`) - a genuinely different
  shutdown path than the one `startServer()`/`stopServer()` within a single session uses.
- **~~Nothing about the multi-server spawn queue~~ - proven, with zero code changes.** See "The
  staggered multi-server spawn queue" above: starting two different profiles back to back showed
  the real, unmodified `reserveSpawnSlot()`/`queuedStatus` behavior - the second server's own
  `server.start` response carried no pid at all, and its real OS process didn't spawn until the
  real default 10-second stagger window had elapsed, confirmed against both the push-event timing
  and the real OS process list's own start timestamps (10 seconds apart, driven by the *first*
  server's `startedAt`, matching the function's own "global, not per-profile" queue design).
- **~~Nothing about a server actually finishing startup~~ - proven, standalone and through the
  real compiled app.** See "A server that actually finishes starting" above:
  `watchLogFileForMarker()`'s real `starting` → `running` transition, driven by the real
  startup-complete log line a real ARK server writes, not a timeout - the fake stand-in script
  gained an opt-in flag to write that same real line a few seconds after launch, the same kind
  of honest simulation `console.appendTestLine` already does elsewhere in this PoC. Found and
  fixed a real ordering bug in the test fixture itself along the way (not the port): writing the
  marker into a log file `watchLogFile` had never successfully polled even once got silently
  absorbed into its own first "establish a size baseline" tick and never reported - fixed by
  having the fixture create the log file immediately and append the marker only after a delay,
  matching a real server's own shape (log already exists and is growing before that line
  appears).
- **~~Nothing about player management~~ - proven, a different real subsystem from everything
  above, with one real, honestly-stated UI-reachability gap.** See "A third real page" above:
  `PlayerRosterPanel.tsx`, completely unmodified, renders a real server card against real data -
  `playerRoster.list` gracefully returning an empty roster, exactly matching the real handler's
  own RCON-failure fallback, not a stub. A real, fully successful write path (`playerWhitelist.
  add`, tracking-only, no RCON) was confirmed both standalone and through the real app (the real
  `config.json`'s `playerWhitelist` array gaining a real entry). Two more real, honestly-RCON-
  gated paths (`playerRoster.kick`, `playerBans.ban`) were confirmed standalone only, throwing
  the real `"No ServerAdminPassword..."` error `stopServer()` already surfaced - their real UI
  buttons only render inside a live roster row, which needs a real RCON-speaking server this
  sandbox can't provide, so that specific button-click path stays unconfirmed, same category of
  gap as the native folder picker's happy path. Also added the real `window_focus` command
  (`confirmAction()`'s focus-loss workaround), the second command in this PoC needing no sidecar
  at all.
- **~~Nothing about the real Start/Stop/Restart/Kill/Update buttons, or live push events actually
  reaching any webview~~ - both proven, and a PoC-wide bug fixed along the way.** See "A fifth
  real page" above: a real click on the real `Dashboard.tsx` buttons now drives a real OS process
  through `lib/serverActions.ts`'s orchestration layer (CPU/RAM monitor included, via a genuine
  `pidusage` reading), confirmed end to end including the process actually dying on screen and in
  `ps aux` together. Finding this required discovering that `src-tauri/capabilities/` had never
  existed in this PoC at all - every `window.__TAURI__.event.listen(...)` call, in every page,
  in every prior round, was being silently rejected by Tauri's permission system, which "A
  rendering dead end"'s original investigation mistook for a WebKitGTK compositing limit. Fixed
  with one `capabilities/default.json` file; re-confirmed the fix against that section's own
  original scenario, not just this round's new one. Also later confirmed: the live console feed
  (`listen('console-line', ...)`, `index.html`'s own test) through the real webview, the one
  push-event type in this PoC that had only ever been confirmed standalone - a real click on
  "Start watching the test log" then "Simulate a server writing a line" produced a real live
  update on screen, the same capabilities fix covering it too. ~~Per-group bulk actions never
  clicked~~ - also closed: a real click through the card menu's Group submenu (`setProfileGroup`,
  a real `profiles.save` write) moved a real profile into the already-registered "PoC Group," and
  that group's own bulk Start/Stop buttons (`startAll`/`stopAll`, the same `window.api.server.*`
  calls the single-card buttons use, just mapped over every profile in the group) correctly
  spawned and killed the real OS process, confirmed the same way as the single-card round - `ps
  aux` and the real status badge agreeing. ~~Drag-to-reorder never attempted~~ - also closed: real
  `DragEvent`s (`dragstart`/`dragover`/`drop`, a `DataTransfer` object required to construct them
  but never read by the handlers, which only track a `dragId` in component state) dispatched
  directly on two real card DOM nodes fired the real `onDragStart`/`onDrop` handlers, and the real
  `profiles.reorder` → `setProfileOrder()`/`reorderProfiles()` write landed - confirmed not just
  by the cards visibly swapping on screen but by the actual persisted profile order in
  `config.json` on disk afterward. Still unconfirmed: the Windows-only `.bat` launch path (same
  gap as above), and the "+ Add Profile" wizard (native dialogs, same gap as "A second real
  page") - the only two gaps left in this PoC that are architectural (need a real desktop
  session/Windows machine), not just "not yet clicked."
- **~~Nothing about stats history, backup scheduling, or build/version info~~ - proven, a sixth
  real page, with a PoC-wide bug fixed along the way.** See "A sixth real page" above:
  `AnalyticsTab.tsx` confirmed a genuine write-then-read round trip through `lib/statsHistory.ts`
  (real samples `monitor.ts` wrote, read back through the real chart's own data path), and found
  a second real-code wiring gap (`registerBackupScheduleWatcher()` never called) alongside the
  capabilities one from the previous round. The bigger finding: Tauri's `invoke()` rejects with
  a bare value, not an `Error`, breaking the `(err as Error).message` pattern every real
  component's error-display code uses - affecting every earlier page's own error UI too, not
  just this one, fixed once centrally rather than per-page. Still honestly unconfirmed in this
  sandbox: `UpdateCheckPanel`'s actual "update available" state, since nothing here ever arms
  the real background SteamCMD poller that would populate it - same category of gap as
  `doUpdateServer`'s own SteamCMD-not-installed error, not a new kind of limitation.
- **~~Nothing about world/player backups~~ - proven, a seventh real page, the heaviest write path
  in this PoC, and a response-shape bug fixed along the way.** See "A seventh real page" below:
  `BackupsTab.tsx` (plus the two real child components it mounts itself,
  `PlayerBackupsSection.tsx`/`BackupLogPanel.tsx`) confirmed a real create → real zip →
  real-event-driven list refresh → real select → real delete cycle, and a real restore that put a
  deleted file back on disk, all through the actual compiled app, not just standalone. Found and
  fixed a second instance of the exact class of bug "A JSON-RPC response needs a concrete,
  non-`undefined` result" already names: `backup.delete`/`backup.restore` mirror `deleteBackup()`/
  `restoreBackup()`'s own real `void` return, which always read on the Rust side as "neither a
  result nor an error" - an error, even on a genuine success - until both methods were given a
  concrete `{ ok: true }` return, the same fix `log.record` already needed.
- **~~Nothing about the SteamCMD update log~~ - proven, an eighth real page, and the opposite
  flavor of the same response-shape bug class.** See "An eighth real page" above:
  `UpdateLogTab.tsx` confirmed `readUpdateLog()`'s real, honest `null` result (every profile in
  this sandbox, since `updateServer()` never gets far enough to write a log without a real
  SteamCMD install) reaches the webview correctly as `null`, not a synthesized Rust-side error -
  found and fixed only because `Option<Value>`'s derived deserializer collapses a present JSON
  `null` the same as an absent field, confirmed by deserializing both shapes side by side. Also
  confirmed the live push path (`steamcmdUpdateEvents`/`onUpdateLogChanged`) through the real
  running app with a temporary test trigger, since no real SteamCMD run exists in this sandbox to
  drive it honestly.
- **~~Nothing about per-server map management~~ - proven, a ninth real page, and the first with
  no push event to wire.** See "A ninth real page" above: `MapManagementTab.tsx`'s real
  create/list/delete/open-folder cycle was confirmed through genuine typed input and real clicks
  in the actual compiled app - a new folder appearing with a real timestamp, selection enabling
  the right buttons, deletion correctly emptying the table back out. The real path-traversal
  guard (`sanitizeMapFolderName`) was confirmed with a genuinely malicious input, not just read
  from source. No new bug this round - `createMapFolder`/`deleteMapFolder`'s `void` return was
  wrapped in `{ ok: true }` from the start, applying the lesson "A seventh real page" paid for.
- **~~Nothing about a big settings-form page, or a page whose own child component needs no
  window.api at all~~ - both proven, a tenth real page.** See "A tenth real page" above:
  `ServerManagementTab.tsx`'s many schedule/watchdog fields all round-trip through the
  already-proven `profiles.save`, and its mounted `ScheduleDaysPicker.tsx` ticks a real live
  countdown with zero sidecar/Rust involvement per tick - confirmed by two screenshots ~2
  seconds apart showing the countdown's seconds genuinely decrease. The one new real call
  (`groupConsole.rconSend`, a scheduled RCON entry's "Run now") turned out to be the same real
  `sendRconCommand()` "A third real page" already proved, confirmed with a real honest RCON
  failure landing on screen through a real click.
- **~~Nothing about a page with zero window.api calls, the watched-players/player-activity/
  cross-server-bans subsystems~~ - all four proven in one batch, eleventh through fourteenth.**
  See "A batch of four smaller real pages" above: `ChangelogView.tsx` needed no shim at all and
  still rendered real static content correctly; `WatchedPlayersSection.tsx`'s real add/remove
  cycle and `PlayerBansPanel.tsx`'s real cross-server ban picker + honest RCON failure were both
  confirmed through real clicks in the actual app; `PlayerActivityPanel.tsx`'s real, honest empty
  state matched standalone. No new bugs this round - every page reused an already-proven real
  subsystem or fix pattern.
- **~~Nothing about the Cluster Dashboard, or a page reusing components that need no window.api
  of their own~~ - proven, a fifteenth real page.** See "A fifteenth real page" above:
  `ClusterDataView.tsx` reuses `useServerStatuses.ts` and `ServerStatsChart.tsx` unmodified, and
  its one new real call (`readClusterStatsHistoryForGroups`) correctly summed real per-group
  history, confirmed through the real compiled app including the real chart switching from "no
  data in this window" to actually drawing the real sample after clicking "All".
- **~~Nothing about a real outbound network call~~ - proven, a sixteenth real page, with a real
  honest network failure rather than a simulated one.** See "A sixteenth real page" above:
  `SteamCmdView.tsx`'s managed-install flow made this PoC's first genuine `fetch()` to a
  third-party CDN, confirmed both standalone and through the real compiled app with the exact
  same `"fetch failed"` text reaching the screen - this sandbox's network policy doesn't permit
  arbitrary outbound HTTPS to Valve's CDN, the same honest-gap category as every other
  platform/network limitation this PoC has already documented, not a new kind of bug. Also added
  a third sidecar-free Rust command (`dialog_select_file`, a sibling of
  `dialog_select_directory`) and refactored `window_focus`'s body into a reusable
  `refocus_window()` helper so the new Windows-only firewall command could call it too. Still
  unconfirmed: a real successful SteamCMD download (needs a sandbox with outbound access to
  Valve's CDN, or a real desktop run), the native file-picker's happy path (same gap as the
  folder picker), and the Windows-only firewall rule itself (needs a real Windows machine, same
  gap as the Windows firewall mention under `dialog_select_directory`).
- **~~Nothing about merging several servers' live log feeds into one view~~ - proven, a
  seventeenth real page, closing a gap "A fifteenth real page" had honestly left open.** See
  "A seventeenth real page" above: `GroupConsoleView.tsx`'s real `watchGroupConsole()`/
  `getGroupConsoleBacklog()` needed no new underlying subsystem at all - just real per-profile
  orchestration over the exact `watchLogFile`/`parseLogChunkWithDate` plumbing "The actual
  headline case" already proved, now multiplexed across several profiles onto one push event.
  Confirmed through the real compiled app including a real click-driven Start that spawned a
  real OS process, a real live status badge transition, and the component's own real
  status-transition-to-log-line synthesis firing correctly on a real push. No new bug found -
  every real call site this page needed had already been proven by an earlier round.
- **~~Nothing about real tab-switching composing several already-proven pages into one
  screen~~ - proven, an eighteenth real page, the first needing zero new real code anywhere.**
  See "An eighteenth real page" above: `PlayersView.tsx` merges `PlayerRosterPanel.tsx`/
  `PlayerBansPanel.tsx`/`PlayerWhitelistPanel.tsx`/`PlayerActivityPanel.tsx` behind one sidebar,
  and needed no new sidecar RPC method or Rust command at all - just the union of four already-
  proven `window.api` surfaces. Confirmed through the real compiled app: all four tabs correctly
  mounted their real child fresh on each click, each matching that page's own earlier standalone
  screenshot exactly. No new bug - this round tested composition itself, not new real-code
  surface.
- **~~Nothing about a subsystem that reconciles its own state immediately on save, not just on a
  live push or a click~~ - proven, a nineteenth real page.** See "A nineteenth real page" above:
  `EventSchedulerView.tsx`'s real `armModEvent()` (real `node-cron`/`setTimeout`, no Electron
  coupling) fires a real reconciliation the instant a past-dated event is saved - confirmed
  standalone, where it genuinely added a real mod id to all three real seeded profiles in one
  call, then confirmed through the real compiled app with a future-dated event correctly staying
  "Scheduled" and leaving those same real profiles untouched. First page needing a real native
  `<input type="datetime-local">` and a modal dialog, both proven with zero new sidecar wiring.
  The real `Delete Event` button's own `window.confirm()` round trip specifically wasn't
  re-clicked, but the underlying bug it would have hit is now fixed project-wide - see "Closing
  the confirmAction()/window.confirm() bug for real" above, confirmed on a different real
  `confirmAction()` button. Still unconfirmed: the `shutdownOnStart`/`shutdownOnEnd` real stop-then-start
  cycle specifically from this subsystem (the underlying `startServer`/`stopServer` calls
  themselves are already proven elsewhere in this PoC, just not triggered from this code path).
- **~~Nothing about a second real file-backed persistence path, independent of
  electron-store~~ - proven, a twentieth real page.** See "A twentieth real page" above:
  `MapManagerView.tsx`'s real `listMaps()`/`listCustomMaps()`/`addCustomMap()`/
  `updateCustomMap()`/`deleteCustomMap()` go through `jsonListFile.ts`'s own read/parse/write
  helpers and `getDataDir()`, not `conf`/`electron-store` - a different real persistence
  mechanism from every `store.ts`-backed subsystem this PoC had ported before, confirmed to need
  zero Electron coupling too. A real add and a real edit through the real compiled app each
  produced a real write to the real `~/Documents/ARK Server Manager/customMaps.json` on disk,
  independently re-confirming `getDataDir()`'s own real path for a second subsystem (the first
  being `lib/managerLog.ts`, see "Findings" above). The real `Delete` button's own
  `window.confirm()` round trip specifically wasn't re-clicked, same as `EventSchedulerView`'s
  own - but see the confirm() bug fix above for why it's no longer expected to silently fail.
- **~~Nothing about writing directly into a real GameUserSettings.ini/Game.ini~~ - proven, a
  twenty-first real page.** See "A twenty-first real page" above: `IniTemplatesView.tsx`'s real
  `applyIniTemplate()`/`applyIniTemplateToAll()` (`lib/iniTemplates.ts`) surgically update an
  existing key in place or insert a new one into its section via `gameConfigWrite.ts`'s
  `upsertIniKeys` - the first real code in this whole PoC to touch a real ARK config file
  directly, not a stand-in. Confirmed standalone that a first-ever apply genuinely **creates**
  the real file from nothing (an honest, documented real behavior, not a bug), then confirmed
  through the real compiled app with a real typed template, a real "Apply" click, and a real
  file checked on disk afterward - including confirming a field whose textarea only ever showed
  placeholder text correctly produced no file at all for it. Added a fourth sidecar-free native
  dialog command (`dialog_select_ini_file`). Still unconfirmed: the real "Import from file..."
  button's native dialog happy path (same gap as every other native picker in this PoC) and the
  real per-server override actually winning over the generic template in one applied result
  (both were exercised independently, just not together in the same real apply).
- **~~Nothing about a full file browser + Notepad++-style editor with history/diff/restore~~ -
  proven, a twenty-second real page, reaching the hundredth Tauri command.** See "A
  twenty-second real page" above: `ServerDetail/FilesTab.tsx`'s real
  `listFileBrowserEntries`/`readIniFile`/`writeIniFile`/`listIniHistory`/`diffIniHistoryEntry`/
  `restoreIniHistoryEntry` (`lib/fileBrowser.ts`) round-tripped correctly both standalone and
  through the real compiled app - a real click-driven edit, save, diff, and restore, each
  confirmed against the real file on disk, not just the UI's own state. `fileBrowser.open`'s
  real `shell.openPath` call reuses the exact reverse-direction mechanism "The reverse
  direction" already proved, a new real call site rather than a new one. Still unconfirmed:
  the real native OS "Open" action's own visible result (the same category of gap as every
  other `shell.openPath`/native-dialog call in this PoC - this sandbox has no desktop session
  to observe it opening in), and the `.log`-file read-only path specifically (no real log file
  was browsed to this round, though `console.*`'s own log parsing is already proven elsewhere).
- **~~Nothing about the per-server mod list, or CurseForge-backed search with no key
  configured~~ - proven, a twenty-third real page.** See "A twenty-third real page" above:
  `ModsTab.tsx`'s real `gameConfigWrite.ts`/`modsExport.ts`/`arkMods.ts` functions round-tripped
  correctly both standalone and through the real compiled app, including a real add/write and a
  real remove/write each confirmed on disk. `arkMods.search`/`arkMods.info` showed the honest
  *opposite* network-gap shape from SteamCMD's own always-attempts `fetch()` - a real
  key-configured check first, no network attempt at all without one, confirmed by this
  sandbox's own real unset `curseforgeApiKey`. Still unconfirmed: a real CurseForge-key-present
  search/enrichment result (needs a real API key, which this PoC has deliberately never had
  configured, the same category of gap as every other "needs a real external credential" case).
- **~~Nothing about the main per-server settings form, or a debounced live-preview effect~~ -
  proven, a twenty-fourth real page.** See "A twenty-fourth real page" above: the real,
  unmodified `SettingsTab.tsx` rendered every seeded field correctly, the debounced
  `server.previewLaunchCommand` effect computed and displayed the real live launch command
  within the full compiled app (not just standalone), and a field edit produced a real
  `profiles.save` write confirmed on disk. Still unconfirmed: the real `dialog_save_profile_file`
  Save-File dialog's own happy path (same architectural gap as every other native picker in this
  PoC, but a stricter failure mode - see its own bullet above) and `window.api.system
  .openDataDirFolder`'s real OS-level "open in file manager" result (same already-accepted gap
  as every other `shell.openPath` call site - this sandbox has no desktop session to observe it
  opening in).
- **~~Nothing about the real tab-switching shell that ties every per-server tab together~~ -
  proven, a twenty-fifth real page.** See "A twenty-fifth real page" above:
  `ServerDetail/index.tsx`'s real nav correctly mounted/unmounted all eight already-proven real
  tabs in the full compiled app, with zero new backend surface needed. Still unconfirmed:
  `AnalyticsTab`'s/`BackupsTab`'s own live server-status push updates and the native
  dialogs reachable from inside the composed shell (same already-documented gaps as their own
  standalone rounds, not new ones introduced by composing them).
- **~~Nothing about the app-wide Settings screen, Discord bot settings, access tokens/API keys,
  cluster export/import, or app updates~~ - proven, a twenty-sixth real page.** See "A
  twenty-sixth real page" above: every tab's real backend surface was confirmed, including a
  real access-token create/delete round trip, a real cluster export/import cycle (cleaned up
  afterward), and the real `checkForUpdate()` honest dev-mode gate. One real bug was found and
  fixed along the way (a missing `window.api.watchedPlayers`/`system.focusWindow` declaration
  crashing the Discord Bot tab), not an architectural gap. Still unconfirmed: the two new native
  cluster-bundle dialogs' own happy path (same gap as every other picker in this PoC), a real
  CurseForge-key-present Discord bot update-notification flow, and `checkForUpdate()`'s actual
  download/install behavior in a packaged build (this sandbox has never built a packaged
  release, the same category of gap as "needs a real external credential/environment" cases
  elsewhere in this PoC).
- **~~Nothing about the Minecraft server-install subsystem~~ - proven, a twenty-seventh real
  page.** See "A twenty-seventh real page" above: the real wizard, its real per-type UI
  branching, and the real `minecraft.install.*` RPC methods all confirmed, hitting the same
  honest "fetch failed" the real codebase's own author already flagged as unverified even in
  their own dev environment. Still entirely unconfirmed: the actual download/build result for
  any of the seven server types (needs real network access this sandbox has never had, the
  same category of gap as SteamCMD's own install path), and the entire rest of the Minecraft
  subsystem (`MinecraftDashboard.tsx` and the other seven `MinecraftServerDetail/*.tsx` files
  remain completely unported).
- **~~Nothing about a real Minecraft profile actually existing, or the Minecraft-side scheduled
  restart logic~~ - proven, a twenty-eighth real page.** See "A twenty-eighth real page" above:
  the Minecraft profile CRUD foundation (list/save/delete + push event) and the real scheduled-
  restart write-through both confirmed, including a direct `config.json` read of the resulting
  Minecraft profile. Still unconfirmed: `startOnManagerLaunch`'s actual effect (needs a real
  Manager startup sequence this PoC's sidecar-per-standalone-process model doesn't have), and
  the rest of `MinecraftServerDetail/` (`BackupLogPanel.tsx`, `BackupsTab.tsx`, `ModsTab.tsx`,
  `ServerSettingsTab.tsx`, `StartSettingsTab.tsx`, `index.tsx`) and `MinecraftDashboard.tsx`.
- **~~Nothing about the Minecraft live console, or a real third-party UI library like xterm.js~~
  - proven, a twenty-ninth real page.** See "A twenty-ninth real page" above: the real,
  unmodified `xterm.js` terminal rendered correctly with its real CSS, and the real honest
  "server not running" placeholder/disabled-input state matched the component's own logic
  exactly. Still unconfirmed: what a real live console feed (actual game-server stdout lines)
  looks like rendered through `xterm.js` - needs a real running Minecraft server process, the
  same category of gap as ARK's own live-console round before its stand-in script existed.
- **~~Nothing about the Minecraft launch/startup settings tab, or `lib/minecraftDetect.ts`~~ -
  proven, a thirtieth real page.** See "A thirtieth real page" above: the real, unmodified
  `StartSettingsTab.tsx` rendered correctly, the real `detectMinecraftLaunchable()` correctly
  identified a real test jar's filename and server type through the full pipeline, and the real
  version-list fetch hit the same honest "fetch failed" every other real network call in this
  sandbox does. Still unconfirmed: a real jar/script install with a genuinely different directory
  layout per server type (Forge/NeoForge's own launcher scripts vs. a plain `server.jar`), and
  the rest of `MinecraftServerDetail/` (`BackupLogPanel.tsx`, `BackupsTab.tsx`, `ModsTab.tsx`,
  `ServerSettingsTab.tsx`, `index.tsx`) and `MinecraftDashboard.tsx` remain completely unported.
- **~~Nothing about the Minecraft backup log, or a live push event with no real trigger yet~~ -
  proven, a thirty-first real page.** See "A thirty-first real page" above: the real, unmodified
  `BackupLogPanel.tsx` rendered its honest empty state, and a real log entry pushed through the
  full sidecar→Rust→webview pipeline (triggered by hand via devtools, since no real
  `createMinecraftBackup()` call path exists yet) appeared live with no reload. Still unconfirmed:
  what actually triggers this log in normal use - needs `BackupsTab.tsx` itself, plus the rest of
  `MinecraftServerDetail/` (`BackupsTab.tsx`, `ModsTab.tsx`, `ServerSettingsTab.tsx`, `index.tsx`)
  and `MinecraftDashboard.tsx`, still completely unported.
- **~~Nothing about real world backup create/restore/delete, or what actually triggers the
  backup log~~ - proven, a thirty-second real page, and a real confirm() bug found.** See
  "A thirty-second real page" above: `createMinecraftBackup()`/`listMinecraftBackups()`/
  `deleteMinecraftBackup()`/`restoreMinecraftBackup()`/`openMinecraftBackupFolder()` all
  confirmed through the real compiled app against a real world folder, including the composed
  `BackupLogPanel.tsx` showing the real log trail from an actual backup run. Also found: every
  `confirmAction()`-gated destructive action in this entire PoC (not just this round's) has been
  silently skipping its own confirmation since the first round that used one, because Tauri's
  dialog plugin breaks `window.confirm()`'s synchronous contract - see the dedicated Findings
  bullet above, now marked fixed. Still unconfirmed: `ModsTab.tsx`, `ServerSettingsTab.tsx`, `index.tsx` (the tab
  shell itself, which needs both of those first) and `MinecraftDashboard.tsx`.
- **~~Nothing about the server.properties editor~~ - proven, a thirty-third real page.** See
  "A thirty-third real page" above: every field type (text/checkbox/select) correctly read and
  wrote the real file in place, preserving comments and untouched keys, confirmed by re-reading
  the real file from disk after each edit. Still unconfirmed: `ModsTab.tsx`, `index.tsx` (the
  tab shell, which needs `ModsTab.tsx` to compose fully) and `MinecraftDashboard.tsx`.
- **~~Nothing about Modrinth/CurseForge mod management~~ - proven, a thirty-fourth real page.**
  See "A thirty-fourth real page" above: scan/search hit the same honest "fetch failed" every
  other real network call in this sandbox does (confirmed standalone and through the compiled
  app), while the purely offline operations (enable/disable, remove) round-tripped correctly
  against a real file on disk - including a second real reproduction of "A thirty-second real
  page"'s `confirmAction()` bug, this time on the Remove button. All six `MinecraftServerDetail/`
  tabs are now individually proven - only `index.tsx` (the tab-shell composition itself, now
  unblocked) and `MinecraftDashboard.tsx` remain unported.
- **~~Nothing about the real Minecraft tab-switching shell, or a cross-tab navigation
  callback~~ - proven, a thirty-fifth real page.** See "A thirty-fifth real page" above: all six
  tabs mounted correctly through the real composed shell, including a real in-app tab switch
  triggered from inside `ModsTab.tsx` itself (`onGoToStartSettings`). Only `MinecraftDashboard.tsx`
  (694 lines) remains completely unported - the last unexercised page in this entire PoC's scope.
- **~~Nothing about MinecraftDashboard.tsx, or a real spawned Minecraft process~~ - proven, a
  thirty-sixth and last real page.** See "A thirty-sixth real page" above: the real server list,
  real hardware/network telemetry, real grouping/hiding, and - the actual headline case for the
  Minecraft side - a real process spawned, monitored, and gracefully stopped via stdin, confirmed
  both standalone (a purpose-built stand-in script, the Minecraft-side twin of
  `server.installTestExecutable`) and live in the compiled app. This was the last page in this
  PoC's original scope - every real page on both the ARK and Minecraft sides has now been proven.
  What remains genuinely unconfirmed is everything this PoC's own sandbox structurally cannot
  reach, not anything left unexplored: real third-party API responses (Steam/CurseForge/Mojang/
  Modrinth), a real ARK/Minecraft dedicated server binary's actual runtime behavior, Windows/
  macOS parity beyond the one Windows round already run, and a packaged installer's own update
  path - see the rest of this section, above, for each of those individually.

## Where the real Electron coupling lives

Only two files are touched by Electron's `app` module in the startup path this PoC actually
exercises: `src/main/lib/dataDir.ts` (`app.getPath('documents')`) and `electron-store`'s own
internal default (`app.getPath('userData')`), both satisfied by `sidecar/electronShim.ts`'s
two-line stand-in.

A quick `grep -rl "from 'electron'" src/main/lib/` turns up 12 files total (out of ~80 in that
directory) - a cheap, worthwhile sanity check before assuming "keep 100% of the business logic"
is realistic beyond this one PoC's slice:

| What it imports | Files | Sidecar-portable? |
| --- | --- | --- |
| `app` (`getPath`/`isPackaged`) | `dataDir.ts`, `appUpdater.ts`, `discordBot.ts`, `launchOnStartup.ts`, `webDashboard.ts`, `systemFolders.ts` | Yes - same `electronShim.ts` pattern as this PoC already proves |
| `shell` (`openPath` - `showItemInFolder` isn't actually called anywhere) | `backup.ts`, `mapManagement.ts`, `minecraftBackup.ts`, `minecraftMods.ts`, `playerBackup.ts`, `systemFolders.ts` | ~~Needs a real native call, not a stub - these particular calls would need to move to a Tauri command instead of staying in these files as-is~~ **Proven wrong by building it: sidecar-portable too, with zero changes to these files** - see "The reverse direction" above |
| `BrowserWindow` (type only) | `windowFocus.ts` | N/A - window-focus logic belongs in the shell anyway, not a sidecar concern |

So the actual finding is better than "two files": every `app.*` use across the whole `lib/`
directory is the same shape this PoC already handles, and every `shell.*` use turns out to be
the same shape too, once there's a real bidirectional channel - this table's own first guess
(struck through above rather than deleted) assumed `shell.*` call sites would need to move out
of these files and into a Tauri command, because "only the Rust shell can make the native
call." Building it showed that's not actually required: `electronShim.ts`'s `shell.openPath`
round-trips to Rust transparently, so `backup.ts`/`mapManagement.ts`/etc. would port completely
unmodified, exactly like every `app.*`-shaped file above - worth keeping the wrong guess
visible, not just the corrected answer.

## The IPC-surface audit: closing the real `window.api` bridge against the real `Api` interface

`frontend/lib/windowApi.ts` (see "The real App.tsx shell" above) was built by mechanically
merging every earlier per-page entry file's own partial `window.api` implementation - correct
for the thirty-six pages this PoC had already exercised one at a time, but never checked as a
whole against the one piece of real source code that actually defines the full surface:
`shared/types.ts`'s own `export interface Api { ... }`, the same type the real preload and every
real page already compile against. Two real crashes already surfaced this gap once each
(`window.api.windowControls.isMaximized` and `window.api.systemStats.get`, both fixed during the
App.tsx round above) - worth closing properly rather than waiting for the user's own test pass to
find the next one.

Read the real `Api` interface in full (all ~40 namespaces, ~150 methods) and diffed it against
`windowApi.ts` twice: once by hand against a handful of namespaces that looked under-covered,
then exhaustively via two small extraction scripts (leaf method names and top-level namespace
names, pulled from both files with the same regex and compared with `comm`) - a flattened,
lossy check (it can't catch a wrong namespace placement if the method name happens to exist
elsewhere too) but cheap enough to run against the entire interface rather than a sample, and a
second, independent pass from the targeted manual one. Cross-checked every finding against the
real `src/preload/index.ts` and the real `src/main/ipc/*.ts` handler it backs, not just the type
declaration, the same lesson "A sixteenth real page"'s `systemStats.get`/`getStaticInfo` naming
mismatch already taught: the type, the preload, and the real IPC channel name can each diverge
from each other, and only reading all three together catches which one is real.

Found and fixed four real gaps, none of them previously exercised by any of this PoC's thirty-six
pages:

- **`profiles.copyConfigFrom`** - `CreateServerWizard.tsx`'s "copy config from an existing
  server" option, entirely missing from `windowApi.ts`. Backed by the real, unmodified
  `copyProfileConfigFiles()` (`src/main/lib/profileConfigCopy.ts`), the same function the real
  IPC handler calls. Added `profiles.copyConfigFrom` to the sidecar, `profiles_copy_config_from`
  to the Rust shell, and the bridge method itself; tested standalone against the sidecar (copied
  config files between two real sandbox profiles without error).
- **`statsHistory.getForGroup`** (singular) - the single-group sibling of the already-implemented
  `getForGroups` (plural), used by `ClusterConsole.tsx`/other single-cluster views distinct from
  the Cluster Dashboard's every-group-at-once view this PoC's "fifteenth real page" already
  proved. Backed by the real, unmodified `readClusterStatsHistory()`, already imported by the
  real preload one line above the already-ported `readClusterStatsHistoryForGroups`. Added the
  same three-layer passthrough; tested standalone (returned `[]` for an empty profile-id list
  without error, the expected shape for no matching samples).
- **`officialServerStatus.get`** - the Dashboard's "ARK Official Server Network" status banner, an
  entire namespace missing from `windowApi.ts` (not just a method on an existing one). Backed by
  the real, unmodified `fetchOfficialServerStatus()` (`src/main/lib/officialServerStatus.ts`), a
  real outbound fetch against `arkdedicated.com`'s own status feed - the same "needs real internet
  this sandbox doesn't have" shape as every other real third-party network call this PoC has
  already hit (SteamCMD, Modrinth/CurseForge). Tested standalone: the real fetch logic runs and
  rejects with a plain `fetch failed` (this sandbox has no route to `arkdedicated.com`), which is
  the correct, honest failure mode - not a code bug, and not something to work around.
- **`steamcmd.onUpdateLogChanged`'s callback type** - the real `Api` interface and the real
  preload both type this callback's single argument as `profileId: string`; `windowApi.ts` had it
  typed as `log: string`. Checked the real wiring in `src/main/ipc/steamcmdInstall.ts`
  (`webContents.send(IPC.steamcmdUpdateLogChanged, profileId)`) to confirm which name is actually
  correct - it's `profileId` - and found this PoC's own sidecar/push-event wiring
  (`sidecar.ts`'s `steamcmdUpdateEvents.on('log', (profileId) => send({ ..., data: profileId }))`)
  already sent the right value under the wrong parameter name. A type-only fix (the callback is
  generic at runtime, so nothing was actually broken for a user), but worth matching the real
  contract exactly rather than leaving a misleading name in place.

Also corrected `statsHistory.getForGroups`' own parameter type while in the area: typed as
`groupProfileIds: string[]` in `windowApi.ts`, but both the real `Api` interface and the real IPC
handler (`src/main/ipc/statsHistory.ts`) type it as `groupProfileIds: Record<string, string[]>`
(a map of group name to that group's profile ids, not a flat list) - another type-only mismatch,
since the value is passed straight through at runtime regardless of its declared type, but one
that would have misled anyone reading the bridge's own types as documentation.

Rebuilt all three layers (sidecar → React → `cargo build`, in that order - `frontendDist` is
embedded into the compiled Rust binary, not read live, so skipping the Rust rebuild after a
frontend-only change silently keeps serving the old bundle) with a clean build at each step.
Tested the three new/changed sidecar methods standalone, against the real sidecar bundle, by
spawning it as a plain child process and driving its stdin/stdout JSON-RPC protocol directly
(bypassing the GUI entirely for this check, since the point was verifying the real backend logic
executes without crashing, not re-proving the already-proven transport) - `profiles.copyConfigFrom`
and `statsHistory.getForGroup` returned cleanly, `officialServerStatus.get` reproduced the
expected sandbox-network failure. Relaunched the full compiled app afterward (Xvfb + the real
binary) to confirm a clean `sidecar: ready` startup with no console errors, same as every earlier
round in this PoC.

With the exhaustive namespace/method-name diff coming back clean (every real namespace and every
real leaf method name from the full `Api` interface now has a same-named counterpart in
`windowApi.ts`, including the four gaps above), this closes the IPC-surface audit this PoC's own
"Fini le portage" round opened: **178 Tauri commands total** (counted directly from `main.rs`'s
own `generate_handler!` list, same discipline as every earlier count in this document - not
carried forward by arithmetic from the 176 figure above).
