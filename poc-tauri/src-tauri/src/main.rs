// This PoC exists to answer one question before committing to a real Tauri migration: can a
// Rust shell spawn and talk to a persistent Node sidecar that runs the EXISTING, UNMODIFIED
// application logic (src/main/store.ts), and get a real result back into a Tauri webview via
// an ordinary `invoke()` call? Everything here is scoped to proving exactly that round trip -
// window chrome, menus, the tray, and the other ~34 IPC modules are deliberately out of scope.
//
// Two message shapes travel over the sidecar's stdout, matching sidecar.ts: a response (has
// "id", answers one specific `call()`) and a push event (has "event" instead, unsolicited -
// forwarded here to the webview as an ordinary Tauri event via `app.emit`). profiles_save
// below proves the write path (request carries params, not just a method name) and the push
// path (store.ts's real `profileEvents` 'changed' emitter reaching the webview live) together.
// log_record proves a second, independent push source (lib/managerLog.ts's own
// `managerLogEvents`) multiplexes over the exact same stdout pipe/app.emit forwarding, by
// event name alone - the shape every one of the real app's several live-update channels needs.
// console_backlog/console_watch/console_append_test_line are the actual headline case: the
// real per-server live console feed, via the exact unmodified watchLogFile/parseLogChunkWithDate
// functions the desktop Manager's own Console tab uses - see sidecar.ts's own doc comment.
//
// Everything above is one direction: Rust calls the sidecar. folders_open_profiles proves the
// other direction too - the sidecar calling BACK into Rust for a real native action (opening a
// path in the system file manager, via tauri-plugin-opener) and getting a real result back,
// which real lib files that call Electron's `shell.*` (systemFolders.ts, backup.ts, ...) need.
// It reuses the exact same stdio pipe: a "shell-request" push event going out one way, an
// ordinary `{id, result}`/`{id, error}` line coming back the other - see rpcToRust.ts.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::{Emitter, Manager};
use rfd::FileDialog;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

#[derive(Serialize)]
struct RpcRequest<'a> {
    id: i64,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

struct RpcResponse {
    id: i64,
    result: Option<Value>,
    error: Option<String>,
}

/// A derived `#[serde(default)] result: Option<Value>` can't tell "the sidecar sent
/// `{"result": null}`" (a real, legitimate value - e.g. `steamcmd.getUpdateLog` honestly
/// returning `null` for a profile that's never been updated) apart from "the sidecar sent no
/// `result` key at all" (a real bug - see sidecar.ts's own comment on the identical
/// `backup.delete`/`backup.restore` mistake this PoC already hit once): serde's `Option<T>`
/// deserializer treats a JSON `null` the same as the field being absent, collapsing both to
/// `None` - confirmed by actually deserializing both shapes and comparing, not assumed from
/// serde's docs. Deserializing into a `Map` first and reading `.get("result")` keeps that
/// distinction (`Some(&Value::Null)` vs `None`), which a derived `Option<Value>` field cannot.
impl<'de> Deserialize<'de> for RpcResponse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error as _;
        let map = serde_json::Map::deserialize(deserializer)?;
        let id = map
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| D::Error::custom("RpcResponse missing integer \"id\" field"))?;
        Ok(RpcResponse {
            id,
            result: map.get("result").cloned(),
            error: map.get("error").and_then(Value::as_str).map(String::from)
        })
    }
}

#[derive(Deserialize)]
struct PushEvent {
    event: String,
    data: Value,
}

/// The nested payload of a `{event: "shell-request", data: {...}}` push line - the sidecar
/// asking Rust to perform a real native action and report back. See rpcToRust.ts.
#[derive(Deserialize)]
struct ShellRequest {
    id: i64,
    method: String,
    params: Value,
}

type PendingMap = Arc<Mutex<HashMap<i64, mpsc::Sender<RpcResponse>>>>;
/// Shared with the background reader task so it can write shell-request responses back onto
/// the sidecar's stdin itself, from inside the same task that's reading its stdout.
type SharedChild = Arc<Mutex<CommandChild>>;

/// Owns the sidecar child (via tauri-plugin-shell's `CommandChild`, not a raw `std::process`
/// handle - see "Sidecar packaging" in README.md) plus the map a background async task
/// (spawned alongside this in `spawn_sidecar`) uses to resolve each response, by id, back to
/// the `call()` that's waiting on it - stdin writes happen on whichever thread calls a Tauri
/// command, stdout reads happen continuously on the one task, so the two need a shared,
/// lockable map rather than a direct return value. `child` is an `Arc` (not a bare `Mutex`)
/// because the reader task needs its own handle to write shell-request responses back onto the
/// same stdin this struct's own `call()` writes to.
struct SidecarHandle {
    child: SharedChild,
    next_id: AtomicI64,
    pending: PendingMap,
}

/// Writes one JSON-RPC-shaped line to the sidecar's stdin - shared by `SidecarHandle::call`
/// (Rust calling the sidecar) and the reader task's shell-request handling (answering the
/// sidecar calling Rust), since both are just "serialize this, write it, done."
fn write_line(child: &SharedChild, value: &impl Serialize) -> Result<(), String> {
    let line = serde_json::to_string(value).map_err(|e| e.to_string())? + "\n";
    child.lock().unwrap().write(line.as_bytes()).map_err(|e| e.to_string())
}

impl SidecarHandle {
    fn call(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        self.call_with_timeout(method, params, 5)
    }

    // A real report during testing: Stop (and Restart/Kill/Update) returned "sidecar did not
    // respond within 5s" every time, even though the real stop sequence (RCON SaveWorld, a
    // 30s settle so the save actually finishes writing before the process dies, a graceful-exit
    // wait, then up to 10s more to confirm a force-kill took effect - see SAVE_SETTLE_MS/
    // FORCE_KILL_CONFIRM_MS in serverProcess.ts, STOP_GRACE_MS in minecraftProcess.ts) was still
    // genuinely running in the sidecar the whole time. The flat 5s timeout this originally
    // shipped with was sized for "a cheap store read/write" (see its own old comment) - true for
    // the ~170 other commands, never true for server lifecycle ones. Rust still gave up and
    // surfaced an error after 5s regardless, confusing the UI with a stale/wrong state until the
    // real completion arrived later via the 'server-status' push event.
    fn call_with_timeout(&self, method: &str, params: Option<Value>, timeout_secs: u64) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);

        write_line(&self.child, &RpcRequest { id, method, params })?;

        // The sidecar is a local child process - a genuinely hung sidecar (crashed, bad bundle,
        // ...) should still surface as an error eventually, not hang the UI forever waiting on a
        // response that will never come, hence a bound here at all rather than none.
        let response = rx
            .recv_timeout(std::time::Duration::from_secs(timeout_secs))
            .map_err(|_| format!("sidecar did not respond within {timeout_secs}s"))?;

        match (response.result, response.error) {
            (Some(result), _) => Ok(result),
            (None, Some(err)) => Err(err),
            (None, None) => Err("sidecar returned neither a result nor an error".to_string()),
        }
    }

    // A real report: Stop appeared to freeze the *entire* app (every page, every button, not
    // just that one server's card) for as long as call_with_timeout's own timeout - which
    // disappeared entirely once that timeout was long enough to actually notice (bumped from 5s
    // to 90s for Stop specifically, see server_stop's own comment). call_with_timeout's blocking
    // rx.recv_timeout() runs on whatever thread Tauri dispatches a plain (non-async)
    // #[tauri::command] fn on - empirically, for this app's IPC setup, that's a thread the
    // window's own event loop depends on, so blocking it for any real stretch freezes the whole
    // window, not just the view this one command's result feeds. The other ~170 commands never
    // surfaced this because their 5s timeout (and realistically sub-second actual duration) was
    // short enough not to be noticed as a freeze rather than a brief stutter - this is the same
    // underlying issue, just far more visible on a 90s wait than a 5s one.
    //
    // Used only by the handful of commands whose real duration can plausibly run into the
    // minutes (server lifecycle, real downloads) - moves the actual blocking wait onto a genuine
    // background thread via spawn_blocking, so the calling `async fn` command can properly
    // `.await` it instead of blocking whatever thread invoked it. Left call_with_timeout itself
    // untouched (still sync/blocking) rather than converting every command to async, since the
    // other ~170 callers never reported this and converting all of them is a much larger, far
    // riskier change for no observed benefit.
    async fn call_async(&self, method: &str, params: Option<Value>, timeout_secs: u64) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);

        write_line(&self.child, &RpcRequest { id, method, params })?;

        let response = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(timeout_secs))
        })
        .await
        .map_err(|e| format!("internal error waiting for the sidecar's response: {e}"))?
        .map_err(|_| format!("sidecar did not respond within {timeout_secs}s"))?;

        match (response.result, response.error) {
            (Some(result), _) => Ok(result),
            (None, Some(err)) => Err(err),
            (None, None) => Err("sidecar returned neither a result nor an error".to_string()),
        }
    }
}

#[tauri::command]
fn profiles_list(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("profiles.list", None)
}

#[tauri::command]
fn profiles_save(profile: Value, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("profiles.save", Some(profile))
}

#[tauri::command]
fn profiles_import_from_file(file_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("profiles.importFromFile", Some(serde_json::json!({ "filePath": file_path })))
}

#[tauri::command]
fn profiles_copy(
    profile_id: String,
    dest_install_dir: String,
    new_name: String,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "profiles.copy",
        Some(serde_json::json!({ "profileId": profile_id, "destInstallDir": dest_install_dir, "newName": new_name })),
    )
}

/// CreateServerWizard's "copy config from an existing server" option. Found missing from
/// this PoC during the IPC-surface audit.
#[tauri::command]
fn profiles_copy_config_from(
    source_profile_id: String,
    dest_profile_id: String,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "profiles.copyConfigFrom",
        Some(serde_json::json!({ "sourceProfileId": source_profile_id, "destProfileId": dest_profile_id })),
    )
}

#[tauri::command]
fn profiles_move(
    profile_id: String,
    dest_install_dir: String,
    new_name: String,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "profiles.move",
        Some(serde_json::json!({ "profileId": profile_id, "destInstallDir": dest_install_dir, "newName": new_name })),
    )
}

/// Backs the real, unmodified ProfileManagementView.tsx's window.api.dialog.selectDirectory() -
/// the first command in this PoC with NO sidecar involvement at all. The real dialog.ts
/// (src/main/ipc/dialog.ts) is a main-process/window-level concern in Electron too (it calls
/// Electron's own `dialog.showOpenDialog` directly against a `BrowserWindow` handle, not
/// through any lib/*.ts business-logic file) - so the natural Tauri port is a native dialog
/// plugin invoked straight from Rust, same shape as the real app's architecture, not a sidecar
/// RPC call standing in for something it never was.
#[tauri::command]
fn dialog_select_directory() -> Option<String> {
    FileDialog::new()
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

/// The real forceRefocus() (lib/windowFocus.ts) sequence - factored out so
/// steamcmd_add_firewall_rule can also call it unconditionally (success or error), the same
/// way the real ipc/steamcmdInstall.ts handler calls forceRefocus(mainWindow) in a `finally`
/// block around its own firewall call, not just window_focus's own direct command below.
fn refocus_window(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    // Mirrors forceRefocus()'s own branching exactly: already-minimized just needs unminimize(),
    // anything else goes through a real minimize()-then-unminimize() transition first - the part
    // that actually matters, per that function's own comment (focus() alone wasn't enough).
    if window.is_minimized().map_err(|e| e.to_string())? {
        window.unminimize().map_err(|e| e.to_string())?;
    } else {
        window.minimize().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
    }
    window.set_focus().map_err(|e| e.to_string())
}

/// Backs the real, unmodified confirmAction()'s `window.api.system.focusWindow()` call - the
/// other main-process/window-level-only command in this PoC alongside dialog_select_directory,
/// with no sidecar involvement, because the real forceRefocus() (lib/windowFocus.ts) is exactly
/// that in the real app too: a window-handle operation, not business logic. Real native calls,
/// not a no-op stub: minimize()+unminimize()+set_focus(), the same real-OS-level-foreground-
/// transition sequence forceRefocus() uses (a plain focus() alone wasn't enough on a real
/// Electron/Windows repro - see that function's own comment).
#[tauri::command]
fn window_focus(app_handle: tauri::AppHandle) -> Result<(), String> {
    refocus_window(&app_handle)
}

/// Backs SteamCmdView.tsx's "Browse..." button (window.api.dialog.selectFile) - the same
/// architectural class as dialog_select_directory: a native dialog with no sidecar
/// involvement, since the real dialog.ts is a main-process/window-level concern in Electron
/// too.
#[tauri::command]
fn dialog_select_file() -> Option<String> {
    FileDialog::new()
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// Backs Dashboard.tsx's "+ Add Profile" wizard's "Import from file..." button
/// (window.api.dialog.selectProfileFile) - same architectural class as dialog_select_file, a
/// real .json filter matching the real dialog.ts's own showOpenDialog filters.
#[tauri::command]
fn dialog_select_profile_file() -> Option<String> {
    FileDialog::new()
        .add_filter("JSON", &["json"])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// Backs IniTemplatesView.tsx's "Import from file..." buttons (window.api.dialog.selectIniFile)
/// - same architectural class as dialog_select_file, with a real .ini filter matching the real
/// dialog.ts's own showOpenDialog filters.
#[tauri::command]
fn dialog_select_ini_file() -> Option<String> {
    FileDialog::new()
        .add_filter("INI files", &["ini"])
        .add_filter("All files", &["*"])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn player_roster_list(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("playerRoster.list", Some(serde_json::json!({ "profileId": profile_id })))
}

/// Backs ServerDetail/SettingsTab.tsx's "Export..." button (window.api.dialog.saveProfileFile) -
/// same architectural class as dialog_select_file/dialog_select_ini_file (native dialog, no
/// sidecar involvement), but a save dialog rather than a pick dialog, matching the real
/// dialog.ts's own showSaveDialog call with a suggested default filename.
#[tauri::command]
fn dialog_save_profile_file(default_name: String) -> Option<String> {
    FileDialog::new()
        .set_file_name(&format!("{}.json", default_name))
        .add_filter("JSON", &["json"])
        .save_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// Backs DataSettingsView.tsx's "Export cluster backup" button (window.api.dialog.
/// saveClusterBundleFile) - a sixth sidecar-free native dialog, same architectural class as
/// dialog_save_profile_file. The real dialog.ts computes a date-stamped default filename
/// (`bober-cluster-backup-<date>.json`) - simplified to a fixed name here rather than pulling
/// in a date-formatting crate just for a suggested filename; the actual porting question this
/// PoC cares about (a real native save dialog reachable from the sidecar-free command class)
/// is unaffected either way.
#[tauri::command]
fn dialog_save_cluster_bundle_file() -> Option<String> {
    FileDialog::new()
        .set_file_name("bober-cluster-backup.json")
        .add_filter("JSON", &["json"])
        .save_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// Backs DataSettingsView.tsx's "Import cluster backup" button
/// (window.api.dialog.selectClusterBundleFile) - a seventh sidecar-free native dialog, same
/// architectural class as dialog_select_file/dialog_select_ini_file.
#[tauri::command]
fn dialog_select_cluster_bundle_file() -> Option<String> {
    FileDialog::new()
        .add_filter("JSON", &["json"])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn player_roster_kick(
    profile_id: String,
    player_id: String,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "playerRoster.kick",
        Some(serde_json::json!({ "profileId": profile_id, "playerId": player_id })),
    )
}

#[tauri::command]
fn player_bans_ban(
    profile_id: String,
    player_id: String,
    player_name: String,
    reason: String,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "playerBans.ban",
        Some(serde_json::json!({ "profileId": profile_id, "playerId": player_id, "playerName": player_name, "reason": reason })),
    )
}

#[tauri::command]
fn player_whitelist_list(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("playerWhitelist.list", None)
}

#[tauri::command]
fn player_whitelist_add(
    profile_id: String,
    player_id: String,
    player_name: String,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "playerWhitelist.add",
        Some(serde_json::json!({ "profileId": profile_id, "playerId": player_id, "playerName": player_name })),
    )
}

#[tauri::command]
fn player_whitelist_remove(
    profile_id: String,
    player_id: String,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "playerWhitelist.remove",
        Some(serde_json::json!({ "profileId": profile_id, "playerId": player_id })),
    )
}

#[tauri::command]
fn log_record(message: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("log.record", Some(Value::String(message)))
}

/// Backs the real, unmodified ManagerLogView.tsx's window.api.managerLog.getLog() - see "A real
/// React page" in README.md.
#[tauri::command]
fn manager_log_get_all(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("log.getAll", None)
}

/// Calls the real, unmodified `startServer()`/`stopServer()`/`getStatus()` from
/// serverProcess.ts - the actual headline capability of a "server manager", proven for the
/// first time in this PoC. See sidecar.ts's own comment on `server.start`/`server.stop` for
/// what standalone testing stands in for (no real game server binary in this sandbox) and what
/// it does/doesn't confirm.
#[tauri::command]
fn server_start(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("server.start", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
async fn server_stop(profile_id: String, sidecar: tauri::State<'_, SidecarHandle>) -> Result<Value, String> {
    // SAVE_SETTLE_MS (30s) + graceful-exit wait + FORCE_KILL_CONFIRM_MS (10s) - see call_async's own comment.
    sidecar.call_async("server.stop", Some(serde_json::json!({ "profileId": profile_id })), 90).await
}

#[tauri::command]
async fn server_restart(profile_id: String, sidecar: tauri::State<'_, SidecarHandle>) -> Result<Value, String> {
    // A stop sequence followed immediately by a start - roughly double server_stop's own budget.
    sidecar.call_async("server.restart", Some(serde_json::json!({ "profileId": profile_id })), 150).await
}

#[tauri::command]
async fn server_kill(profile_id: String, sidecar: tauri::State<'_, SidecarHandle>) -> Result<Value, String> {
    // No SaveWorld settle to wait for, just FORCE_KILL_CONFIRM_MS (10s) plus margin.
    sidecar.call_async("server.kill", Some(serde_json::json!({ "profileId": profile_id })), 30).await
}

#[tauri::command]
async fn server_update(profile_id: String, sidecar: tauri::State<'_, SidecarHandle>) -> Result<Value, String> {
    // A real SteamCMD download - minutes for a large/modded server, not seconds.
    sidecar.call_async("server.update", Some(serde_json::json!({ "profileId": profile_id })), 3600).await
}

#[tauri::command]
fn server_status(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("server.status", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn settings_get(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("settings.get", None)
}

#[tauri::command]
fn settings_save(settings: Value, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("settings.save", Some(settings))
}

#[tauri::command]
fn profiles_delete(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("profiles.delete", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn profiles_reorder(ordered_ids: Vec<String>, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("profiles.reorder", Some(serde_json::json!({ "orderedIds": ordered_ids })))
}

#[tauri::command]
fn system_stats_get_static_info(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("systemStats.getStaticInfo", None)
}

#[tauri::command]
fn system_stats_get_network_usage(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("systemStats.getNetworkUsage", None)
}

/// Dashboard's "ARK Official Server Network" status banner - a real outbound fetch against
/// arkdedicated.com's own status feed. Found missing from this PoC during the IPC-surface audit.
#[tauri::command]
fn official_server_status_get(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("officialServerStatus.get", None)
}

#[tauri::command]
fn stats_history_get(
    profile_id: String,
    since_ms: Option<i64>,
    max_points: Option<i64>,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "statsHistory.get",
        Some(serde_json::json!({ "profileId": profile_id, "sinceMs": since_ms, "maxPoints": max_points })),
    )
}

#[tauri::command]
fn backup_get_schedule_status(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("backup.getScheduleStatus", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn server_get_installed_build_id(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("server.getInstalledBuildId", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn server_get_game_version(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("server.getGameVersion", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn steamcmd_get_latest_build_id(
    game: String,
    branch: Option<String>,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call("steamcmd.getLatestBuildId", Some(serde_json::json!({ "game": game, "branch": branch })))
}

#[tauri::command]
fn system_open_server_config_folder(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("system.openServerConfigFolder", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn system_open_server_saved_arks_folder(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("system.openServerSavedArksFolder", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn system_open_server_save_games_folder(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("system.openServerSaveGamesFolder", Some(serde_json::json!({ "profileId": profile_id })))
}

/// Backs BackupsTab.tsx/PlayerBackupsSection.tsx/BackupLogPanel.tsx - a seventh real page.
/// See sidecar.ts's own comment on `backup.create`/`playerBackup.listFolders` for what's
/// genuinely new here (a real RCON SaveWorld + 40s settle + real zip, and a real unzip-over-
/// SavedArks restore) versus every earlier round's reads.
#[tauri::command]
fn backup_create(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("backup.create", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn backup_list(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("backup.list", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn backup_delete(file_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("backup.delete", Some(serde_json::json!({ "filePath": file_path })))
}

#[tauri::command]
fn backup_restore(profile_id: String, file_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("backup.restore", Some(serde_json::json!({ "profileId": profile_id, "filePath": file_path })))
}

#[tauri::command]
fn backup_open_folder(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("backup.openFolder", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn backup_get_log(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("backup.getLog", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn player_backup_list_folders(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("playerBackup.listFolders", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn player_backup_list(profile_id: String, folder_key: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("playerBackup.list", Some(serde_json::json!({ "profileId": profile_id, "folderKey": folder_key })))
}

#[tauri::command]
fn player_backup_open_folder(profile_id: String, folder_key: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("playerBackup.openFolder", Some(serde_json::json!({ "profileId": profile_id, "folderKey": folder_key })))
}

/// Backs UpdateLogTab.tsx - an eighth real page. See sidecar.ts's own comment on
/// `steamcmd.getUpdateLog` for why this honestly returns null in this sandbox (no real
/// SteamCMD install, so `updateServer()` never gets far enough to write a log).
#[tauri::command]
fn steamcmd_get_update_log(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("steamcmd.getUpdateLog", Some(serde_json::json!({ "profileId": profile_id })))
}

/// Test-only - see sidecar.ts's `steamcmd.appendTestUpdateLogLine` comment.
#[tauri::command]
fn steamcmd_append_test_update_log_line(profile_id: String, line: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("steamcmd.appendTestUpdateLogLine", Some(serde_json::json!({ "profileId": profile_id, "line": line })))
}

/// Backs MapManagementTab.tsx - a ninth real page. See sidecar.ts's own comment: no push
/// event here, the first real page in a few rounds that doesn't need one.
#[tauri::command]
fn map_management_list(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("mapManagement.list", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn map_management_create(profile_id: String, folder_name: String, file_name: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call(
        "mapManagement.create",
        Some(serde_json::json!({ "profileId": profile_id, "folderName": folder_name, "fileName": file_name })),
    )
}

#[tauri::command]
fn map_management_delete(profile_id: String, folder_name: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("mapManagement.delete", Some(serde_json::json!({ "profileId": profile_id, "folderName": folder_name })))
}

#[tauri::command]
fn map_management_open_folder(profile_id: String, folder_name: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("mapManagement.openFolder", Some(serde_json::json!({ "profileId": profile_id, "folderName": folder_name })))
}

/// Backs ServerManagementTab.tsx's "Run now" button - a tenth real page. See sidecar.ts's own
/// comment: groupConsoleRconSend is a thin wrapper around the same real sendRconCommand()
/// player_roster_kick/player_bans_ban already call.
#[tauri::command]
fn group_console_rcon_send(profile_id: String, command: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("groupConsole.rconSend", Some(serde_json::json!({ "profileId": profile_id, "command": command })))
}

/// Backs WatchedPlayersSection.tsx - an eleventh real page.
#[tauri::command]
fn watched_players_list(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("watchedPlayers.list", None)
}

#[tauri::command]
fn watched_players_add(value: String, label: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("watchedPlayers.add", Some(serde_json::json!({ "value": value, "label": label })))
}

#[tauri::command]
fn watched_players_remove(id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("watchedPlayers.remove", Some(serde_json::json!({ "id": id })))
}

/// Backs PlayerActivityPanel.tsx - a twelfth real page, read-only.
#[tauri::command]
fn player_activity_list(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("playerActivity.list", None)
}

#[tauri::command]
fn player_activity_sessions(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("playerActivity.sessions", None)
}

/// Backs PlayerBansPanel.tsx - a fourteenth real page.
#[tauri::command]
fn player_bans_list(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("playerBans.list", None)
}

#[tauri::command]
fn player_bans_unban(profile_id: String, player_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("playerBans.unban", Some(serde_json::json!({ "profileId": profile_id, "playerId": player_id })))
}

/// Backs ClusterDataView.tsx - a fifteenth real page.
#[tauri::command]
fn stats_history_get_for_groups(
    group_profile_ids: std::collections::HashMap<String, Vec<String>>,
    since_ms: Option<i64>,
    max_points: Option<i64>,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "statsHistory.getForGroups",
        Some(serde_json::json!({ "groupProfileIds": group_profile_ids, "sinceMs": since_ms, "maxPoints": max_points })),
    )
}

/// Single-group sibling of stats_history_get_for_groups above (ClusterConsole/ClusterDataView's
/// merged-cluster view). Found missing from this PoC during the IPC-surface audit.
#[tauri::command]
fn stats_history_get_for_group(
    profile_ids: Vec<String>,
    since_ms: Option<i64>,
    max_points: Option<i64>,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "statsHistory.getForGroup",
        Some(serde_json::json!({ "profileIds": profile_ids, "sinceMs": since_ms, "maxPoints": max_points })),
    )
}

/// Backs SteamCmdView.tsx - a sixteenth real page. See sidecar.ts's own comment:
/// steamcmd_install is the first real outbound-network-call command in this whole PoC.
#[tauri::command]
fn steamcmd_managed_status(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("steamcmd.managedStatus", None)
}

#[tauri::command]
async fn steamcmd_install(sidecar: tauri::State<'_, SidecarHandle>) -> Result<Value, String> {
    // Downloads the real SteamCMD binary - same "minutes, not seconds" reasoning as server_update.
    sidecar.call_async("steamcmd.install", None, 600).await
}

/// Calls refocus_window unconditionally, success or error alike (the sidecar call's own
/// result still wins if both fail) - the same as the real ipc/steamcmdInstall.ts handler's
/// own `finally { forceRefocus(mainWindow) }` around this exact call. See sidecar.ts's own
/// comment on why that part had to move to the Rust side.
#[tauri::command]
fn steamcmd_add_firewall_rule(
    steam_cmd_path: String,
    app_handle: tauri::AppHandle,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    let result = sidecar.call("steamcmd.addFirewallRule", Some(serde_json::json!({ "steamCmdPath": steam_cmd_path })));
    let refocus_result = refocus_window(&app_handle);
    result.and_then(|v| refocus_result.map(|_| v))
}

/// Backs GroupConsoleView.tsx - a seventeenth real page. See sidecar.ts's own comment:
/// real, unmodified getGroupConsoleBacklog()/watchGroupConsole() from lib/groupConsole.ts.
#[tauri::command]
fn group_console_subscribe(profile_ids: Vec<String>, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("groupConsole.subscribe", Some(serde_json::json!({ "profileIds": profile_ids })))
}

#[tauri::command]
fn group_console_unsubscribe(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("groupConsole.unsubscribe", None)
}

/// Backs EventSchedulerView.tsx - a nineteenth real page. See sidecar.ts's own comment:
/// real, unmodified armModEvent/disarmModEvent/armAllModEvents from lib/modEvents.ts.
#[tauri::command]
fn mod_events_list(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("modEvents.list", None)
}

#[tauri::command]
fn mod_events_save(event: Value, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("modEvents.save", Some(event))
}

#[tauri::command]
fn mod_events_delete(id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("modEvents.delete", Some(serde_json::json!({ "id": id })))
}

#[tauri::command]
fn mod_events_history(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("modEvents.history", None)
}

/// Backs MapManagerView.tsx - a twentieth real page. See sidecar.ts's own comment: real,
/// unmodified listMaps()/listCustomMaps()/addCustomMap()/updateCustomMap()/deleteCustomMap().
#[tauri::command]
fn maps_list(game: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("maps.list", Some(serde_json::json!({ "game": game })))
}

#[tauri::command]
fn custom_maps_list(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("customMaps.list", None)
}

#[tauri::command]
fn custom_maps_add(entry: Value, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("customMaps.add", Some(entry))
}

#[tauri::command]
fn custom_maps_update(original_id: String, entry: Value, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("customMaps.update", Some(serde_json::json!({ "originalId": original_id, "entry": entry })))
}

#[tauri::command]
fn custom_maps_delete(id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("customMaps.delete", Some(serde_json::json!({ "id": id })))
}

/// Backs IniTemplatesView.tsx - a twenty-first real page. See sidecar.ts's own comment: the
/// first real code in this whole PoC to write directly into a real GameUserSettings.ini/
/// Game.ini file.
#[tauri::command]
fn ini_templates_get_generic(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("iniTemplates.getGeneric", None)
}

#[tauri::command]
fn ini_templates_save_generic(content: Value, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("iniTemplates.saveGeneric", Some(content))
}

#[tauri::command]
fn ini_templates_get_override(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("iniTemplates.getOverride", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn ini_templates_save_override(override_entry: Value, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("iniTemplates.saveOverride", Some(override_entry))
}

#[tauri::command]
fn ini_templates_delete_override(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("iniTemplates.deleteOverride", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn ini_templates_apply(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("iniTemplates.apply", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn ini_templates_apply_all(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("iniTemplates.applyAll", None)
}

#[tauri::command]
fn ini_templates_read_file(file_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("iniTemplates.readFile", Some(serde_json::json!({ "filePath": file_path })))
}

/// Backs ServerDetail/FilesTab.tsx - a twenty-second real page. See sidecar.ts's own comment:
/// real, unmodified lib/fileBrowser.ts functions, mirroring ipc/fileBrowser.ts's handlers
/// exactly, including fileBrowser_open's real shell.openPath round trip through Rust.
#[tauri::command]
fn file_browser_list(profile_id: String, relative_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("fileBrowser.list", Some(serde_json::json!({ "profileId": profile_id, "relativePath": relative_path })))
}

#[tauri::command]
fn file_browser_open(profile_id: String, relative_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("fileBrowser.open", Some(serde_json::json!({ "profileId": profile_id, "relativePath": relative_path })))
}

#[tauri::command]
fn file_browser_delete(profile_id: String, relative_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("fileBrowser.delete", Some(serde_json::json!({ "profileId": profile_id, "relativePath": relative_path })))
}

#[tauri::command]
fn file_browser_read_ini(profile_id: String, relative_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("fileBrowser.readIni", Some(serde_json::json!({ "profileId": profile_id, "relativePath": relative_path })))
}

#[tauri::command]
fn file_browser_write_ini(
    profile_id: String,
    relative_path: String,
    content: String,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "fileBrowser.writeIni",
        Some(serde_json::json!({ "profileId": profile_id, "relativePath": relative_path, "content": content })),
    )
}

#[tauri::command]
fn file_browser_ini_history(profile_id: String, relative_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("fileBrowser.iniHistory", Some(serde_json::json!({ "profileId": profile_id, "relativePath": relative_path })))
}

#[tauri::command]
fn file_browser_ini_history_diff(profile_id: String, entry_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("fileBrowser.iniHistoryDiff", Some(serde_json::json!({ "profileId": profile_id, "entryId": entry_id })))
}

#[tauri::command]
fn file_browser_ini_restore(profile_id: String, entry_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("fileBrowser.iniRestore", Some(serde_json::json!({ "profileId": profile_id, "entryId": entry_id })))
}

/// Backs ServerDetail/ModsTab.tsx - a twenty-third real page. See sidecar.ts's own comment:
/// real, unmodified gameConfigWrite.ts/modsExport.ts/arkMods.ts functions.
#[tauri::command]
fn mods_save(profile_id: String, mods: Value, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("mods.save", Some(serde_json::json!({ "profileId": profile_id, "mods": mods })))
}

#[tauri::command]
fn mods_parse_text(text: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("mods.parseText", Some(serde_json::json!({ "text": text })))
}

#[tauri::command]
fn mods_reconcile_from_ini(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("mods.reconcileFromIni", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn ark_mods_search(query: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("arkMods.search", Some(serde_json::json!({ "query": query })))
}

#[tauri::command]
fn ark_mods_info(mod_ids: Vec<String>, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("arkMods.info", Some(serde_json::json!({ "modIds": mod_ids })))
}

/// Backs ServerDetail/SettingsTab.tsx - a twenty-fourth real page. See sidecar.ts's own
/// comment: real, unmodified serverProcess.ts/systemFolders.ts/profileExport.ts functions.
#[tauri::command]
fn server_preview_launch_command(profile: Value, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("server.previewLaunchCommand", Some(profile))
}

#[tauri::command]
fn system_open_data_dir_folder(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("system.openDataDirFolder", None)
}

#[tauri::command]
fn profiles_export(profile_id: String, file_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("profiles.export", Some(serde_json::json!({ "profileId": profile_id, "filePath": file_path })))
}

/// Backs DataSettingsView.tsx - a twenty-sixth real page. See sidecar.ts's own comment: real,
/// unmodified store.ts/webDashboard.ts/discordBot.ts/launchOnStartup.ts/iniLock.ts/
/// playerJoinAlertWatch.ts/playerActivityWatch.ts/dataDir.ts/appUpdater.ts/clusterExport.ts/
/// auth.ts functions.
#[tauri::command]
fn data_dir_get_default(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("dataDir.getDefault", None)
}

#[tauri::command]
fn web_dashboard_get_local_ips(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("webDashboard.getLocalIps", None)
}

#[tauri::command]
fn discord_bot_status(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("discordBot.status", None)
}

#[tauri::command]
fn discord_bot_restart(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("discordBot.restart", None)
}

#[tauri::command]
fn discord_bot_stop(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("discordBot.stop", None)
}

#[tauri::command]
fn app_update_get_version(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("appUpdate.getVersion", None)
}

#[tauri::command]
fn app_update_check(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("appUpdate.check", None)
}

#[tauri::command]
fn app_update_status(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("appUpdate.status", None)
}

#[tauri::command]
fn app_update_install(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("appUpdate.install", None)
}

#[tauri::command]
fn cluster_export(file_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("cluster.export", Some(serde_json::json!({ "filePath": file_path })))
}

#[tauri::command]
fn cluster_import(file_path: String, include_settings: bool, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call(
        "cluster.import",
        Some(serde_json::json!({ "filePath": file_path, "includeSettings": include_settings })),
    )
}

#[tauri::command]
fn web_dashboard_access_tokens_list(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("webDashboardAccessTokens.list", None)
}

#[tauri::command]
fn web_dashboard_access_tokens_create(
    label: String,
    role: String,
    profile_ids: Option<Vec<String>>,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "webDashboardAccessTokens.create",
        Some(serde_json::json!({ "label": label, "role": role, "profileIds": profile_ids })),
    )
}

#[tauri::command]
fn web_dashboard_access_tokens_update(
    id: String,
    updates: Value,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call("webDashboardAccessTokens.update", Some(serde_json::json!({ "id": id, "updates": updates })))
}

#[tauri::command]
fn web_dashboard_access_tokens_delete(id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("webDashboardAccessTokens.delete", Some(serde_json::json!({ "id": id })))
}

#[tauri::command]
fn web_dashboard_api_keys_list(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("webDashboardApiKeys.list", None)
}

#[tauri::command]
fn web_dashboard_api_keys_create(label: String, role: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("webDashboardApiKeys.create", Some(serde_json::json!({ "label": label, "role": role })))
}

#[tauri::command]
fn web_dashboard_api_keys_update(id: String, updates: Value, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("webDashboardApiKeys.update", Some(serde_json::json!({ "id": id, "updates": updates })))
}

#[tauri::command]
fn web_dashboard_api_keys_delete(id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("webDashboardApiKeys.delete", Some(serde_json::json!({ "id": id })))
}

/// Backs InstallMinecraftServerPanel.tsx - a twenty-seventh real page. See sidecar.ts's own
/// comment: real, unmodified lib/minecraftInstall.ts/minecraftInstallClient.ts functions.
#[tauri::command]
fn minecraft_install_list_versions(server_type: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.install.listVersions", Some(serde_json::json!({ "serverType": server_type })))
}

#[tauri::command]
fn minecraft_install_list_loader_versions(
    server_type: String,
    minecraft_version: String,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "minecraft.install.listLoaderVersions",
        Some(serde_json::json!({ "serverType": server_type, "minecraftVersion": minecraft_version })),
    )
}

#[tauri::command]
async fn minecraft_install_run(params: Value, sidecar: tauri::State<'_, SidecarHandle>) -> Result<Value, String> {
    // Downloads a real server jar/installer - same "minutes, not seconds" reasoning as server_update.
    sidecar.call_async("minecraft.install.run", Some(params), 3600).await
}

/// Backs MinecraftServerDetail/ServerManagementTab.tsx - a twenty-eighth real page, and the
/// Minecraft profile CRUD foundation (list/save/delete) every future Minecraft-side round
/// reuses. See sidecar.ts's own comment: real, unmodified store.ts/minecraftScheduledActions.ts/
/// minecraftBackupSchedule.ts functions.
#[tauri::command]
fn minecraft_profiles_list(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.profiles.list", None)
}

#[tauri::command]
fn minecraft_profiles_save(profile: Value, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.profiles.save", Some(profile))
}

#[tauri::command]
fn minecraft_profiles_delete(id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.profiles.delete", Some(serde_json::json!({ "id": id })))
}

/// Backs MinecraftServerDetail/ConsoleTab.tsx - a twenty-ninth real page. See sidecar.ts's own
/// comment: real, unmodified lib/minecraftProcess.ts/minecraftRcon.ts functions.
#[tauri::command]
fn minecraft_server_get_status(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.server.getStatus", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn minecraft_server_send_command(
    profile_id: String,
    command: String,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "minecraft.server.sendCommand",
        Some(serde_json::json!({ "profileId": profile_id, "command": command })),
    )
}

#[tauri::command]
fn minecraft_console_get_backlog(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.console.getBacklog", Some(serde_json::json!({ "profileId": profile_id })))
}

/// Backs MinecraftServerDetail/StartSettingsTab.tsx - a thirtieth real page. See sidecar.ts's
/// own comment: real, unmodified lib/minecraftDetect.ts function.
#[tauri::command]
fn minecraft_detect_launchable(install_dir: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.detectLaunchable", Some(serde_json::json!({ "installDir": install_dir })))
}

/// Backs MinecraftServerDetail/BackupLogPanel.tsx - a thirty-first real page. See sidecar.ts's
/// own comment: real, unmodified lib/minecraftBackup.ts's getMinecraftBackupLog().
#[tauri::command]
fn minecraft_backup_get_log(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.backup.getLog", Some(serde_json::json!({ "profileId": profile_id })))
}

/// Test-only - see sidecar.ts's `minecraft.backup.appendTestLogLine` comment.
#[tauri::command]
fn minecraft_backup_append_test_log_line(
    profile_id: String,
    message: String,
    sidecar: tauri::State<SidecarHandle>
) -> Result<Value, String> {
    sidecar.call(
        "minecraft.backup.appendTestLogLine",
        Some(serde_json::json!({ "profileId": profile_id, "message": message }))
    )
}

/// Backs MinecraftServerDetail/BackupsTab.tsx - a thirty-second real page. Same shape as
/// backup_create/backup_list/backup_delete/backup_restore/backup_open_folder above (ARK's own).
#[tauri::command]
fn minecraft_backup_create(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.backup.create", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn minecraft_backup_list(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.backup.list", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn minecraft_backup_delete(file_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.backup.delete", Some(serde_json::json!({ "filePath": file_path })))
}

#[tauri::command]
fn minecraft_backup_restore(profile_id: String, file_path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call(
        "minecraft.backup.restore",
        Some(serde_json::json!({ "profileId": profile_id, "filePath": file_path }))
    )
}

#[tauri::command]
fn minecraft_backup_open_folder(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.backup.openFolder", Some(serde_json::json!({ "profileId": profile_id })))
}

/// Backs MinecraftServerDetail/ServerSettingsTab.tsx - a thirty-third real page.
#[tauri::command]
fn minecraft_open_server_folder(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.openServerFolder", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn minecraft_properties_get(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.properties.get", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn minecraft_properties_save(profile_id: String, updates: Value, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call(
        "minecraft.properties.save",
        Some(serde_json::json!({ "profileId": profile_id, "updates": updates }))
    )
}

/// Backs MinecraftServerDetail/ModsTab.tsx - a thirty-fourth real page.
#[tauri::command]
fn minecraft_mods_search(profile_id: String, query: String, ecosystem: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call(
        "minecraft.mods.search",
        Some(serde_json::json!({ "profileId": profile_id, "query": query, "ecosystem": ecosystem }))
    )
}

#[tauri::command]
fn minecraft_mods_install(
    profile_id: String,
    source: String,
    project_id: String,
    ecosystem: String,
    sidecar: tauri::State<SidecarHandle>
) -> Result<Value, String> {
    sidecar.call(
        "minecraft.mods.install",
        Some(serde_json::json!({ "profileId": profile_id, "source": source, "projectId": project_id, "ecosystem": ecosystem }))
    )
}

#[tauri::command]
fn minecraft_mods_remove(profile_id: String, project_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call(
        "minecraft.mods.remove",
        Some(serde_json::json!({ "profileId": profile_id, "projectId": project_id }))
    )
}

#[tauri::command]
fn minecraft_mods_set_enabled(
    profile_id: String,
    project_id: String,
    enabled: bool,
    sidecar: tauri::State<SidecarHandle>
) -> Result<Value, String> {
    sidecar.call(
        "minecraft.mods.setEnabled",
        Some(serde_json::json!({ "profileId": profile_id, "projectId": project_id, "enabled": enabled }))
    )
}

#[tauri::command]
fn minecraft_mods_check_updates(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.mods.checkUpdates", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
async fn minecraft_mods_update(
    profile_id: String,
    source: String,
    project_id: String,
    sidecar: tauri::State<'_, SidecarHandle>
) -> Result<Value, String> {
    sidecar
        .call_async(
            "minecraft.mods.update",
            Some(serde_json::json!({ "profileId": profile_id, "source": source, "projectId": project_id })),
            600
        )
        .await
}

#[tauri::command]
fn minecraft_mods_scan(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.mods.scan", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
fn minecraft_mods_open_folder(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.mods.openFolder", Some(serde_json::json!({ "profileId": profile_id })))
}

/// Backs MinecraftDashboard.tsx - a thirty-sixth real page, and the actual headline case for
/// the Minecraft side (a real spawned process, same role as server_start/stop/kill already
/// proven extensively on the ARK side).
#[tauri::command]
fn minecraft_server_start(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.server.start", Some(serde_json::json!({ "profileId": profile_id })))
}

#[tauri::command]
async fn minecraft_server_stop(profile_id: String, sidecar: tauri::State<'_, SidecarHandle>) -> Result<Value, String> {
    // STOP_GRACE_MS (30s) plus margin - same reasoning as server_stop's own comment.
    sidecar.call_async("minecraft.server.stop", Some(serde_json::json!({ "profileId": profile_id })), 60).await
}

#[tauri::command]
async fn minecraft_server_kill(profile_id: String, sidecar: tauri::State<'_, SidecarHandle>) -> Result<Value, String> {
    sidecar.call_async("minecraft.server.kill", Some(serde_json::json!({ "profileId": profile_id })), 30).await
}

#[tauri::command]
fn minecraft_profiles_import(install_dir: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("minecraft.profiles.importFromInstall", Some(serde_json::json!({ "installDir": install_dir })))
}

/// Backs the real-data-migration tool's "Scan for an existing install" step - see
/// sidecar/legacyImport.ts's own top comment for why this checks two candidate folders.
#[tauri::command]
fn legacy_import_detect(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("legacyImport.detect", None)
}

/// Same read-only preview, for a manually-picked folder (native dialog fallback) instead of one
/// of the two guessed candidates.
#[tauri::command]
fn legacy_import_preview(path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("legacyImport.preview", Some(serde_json::json!({ "path": path })))
}

/// The actual write path - imports profiles/Minecraft profiles from the given legacy folder's
/// real config.json through the real saveProfile()/saveMinecraftProfile(), skipping ids the
/// current store already has.
#[tauri::command]
fn legacy_import_run(path: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("legacyImport.run", Some(serde_json::json!({ "path": path })))
}

/// Backs App.tsx's own direct window.api.server.isInstalled call - the real top-level shell
/// computes installedById for every profile itself, not left to a per-page wrapper.
#[tauri::command]
fn server_is_installed(profile_id: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("server.isInstalled", Some(serde_json::json!({ "profileId": profile_id })))
}

/// Backs App.tsx's own window.api.appStartup.isComplete - see sidecar.ts's own comment on why
/// this sidecar marks its startup complete right after its own init rather than replicating
/// every real step of main/index.ts's own boot chain.
#[tauri::command]
fn app_startup_is_complete(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("appStartup.isComplete", None)
}

/// Backs the real TitleBar.tsx's own minimize/maximize/close buttons - found only once the
/// real App.tsx (which renders TitleBar.tsx, unlike any single-page entry in this PoC) was
/// actually mounted and threw `window.api.windowControls.isMaximized is not a function`. Same
/// sidecar-free native-window-handle class as window_focus above, not business logic.
#[tauri::command]
fn window_minimize(app_handle: tauri::AppHandle) -> Result<(), String> {
    app_handle
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?
        .minimize()
        .map_err(|e| e.to_string())
}

/// Toggles maximize/unmaximize and pushes the real app's own `window-maximized-changed` event
/// right after - the real Electron app gets this from OS-level 'maximize'/'unmaximize' window
/// hooks, but with this window frameless (`decorations: false`, matching the real app's own
/// custom-title-bar design) the custom title bar's button is the only way this state ever
/// changes, so firing the push from here covers every real case, not just a shortcut.
#[tauri::command]
fn window_toggle_maximize(app_handle: tauri::AppHandle) -> Result<(), String> {
    let window = app_handle.get_webview_window("main").ok_or_else(|| "no main window".to_string())?;
    let now_maximized = if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())?;
        false
    } else {
        window.maximize().map_err(|e| e.to_string())?;
        true
    };
    app_handle.emit("window-maximized-changed", now_maximized).map_err(|e| e.to_string())
}

#[tauri::command]
fn window_close(app_handle: tauri::AppHandle) -> Result<(), String> {
    app_handle
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?
        .close()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn window_is_maximized(app_handle: tauri::AppHandle) -> Result<bool, String> {
    app_handle
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?
        .is_maximized()
        .map_err(|e| e.to_string())
}

/// Backs TitleBar.tsx's File > Quit - the real ipc/system.ts's own app.quit() equivalent.
#[tauri::command]
fn app_quit(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}

/// Backs TitleBar.tsx's File > Toggle DevTools - this PoC already runs with devtools enabled
/// (Cargo.toml's `features = ["devtools"]`, used throughout every earlier round's own testing),
/// so this is a real, working toggle, not a stub.
#[tauri::command]
fn app_open_dev_tools(app_handle: tauri::AppHandle) -> Result<(), String> {
    let window = app_handle.get_webview_window("main").ok_or_else(|| "no main window".to_string())?;
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
    Ok(())
}

/// Test-only - see sidecar.ts's `server.installTestExecutable` comment.
#[tauri::command]
fn server_install_test_executable(
    profile_id: String,
    with_startup_marker: Option<bool>,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "server.installTestExecutable",
        Some(serde_json::json!({ "profileId": profile_id, "withStartupMarker": with_startup_marker })),
    )
}

#[tauri::command]
fn console_backlog(install_dir: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("console.backlog", Some(serde_json::json!({ "installDir": install_dir })))
}

#[tauri::command]
fn console_watch(install_dir: String, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("console.watch", Some(serde_json::json!({ "installDir": install_dir })))
}

#[tauri::command]
fn console_append_test_line(
    install_dir: String,
    message: String,
    sidecar: tauri::State<SidecarHandle>,
) -> Result<Value, String> {
    sidecar.call(
        "console.appendTestLine",
        Some(serde_json::json!({ "installDir": install_dir, "message": message })),
    )
}

/// Calls the real, unmodified `openProfilesFolder()` from lib/systemFolders.ts - which itself
/// calls `shell.openPath` (via electronShim.ts/rpcToRust.ts), round-tripping back into this
/// same process to actually perform the native "open in the file manager" call this one
/// Rust-side command can't do on the sidecar's behalf any other way.
#[tauri::command]
fn folders_open_profiles(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("folders.openProfiles", None)
}

/// Calls the real, unmodified `startDiscordBot()` from lib/discordBot.ts - proving the Discord
/// bot subsystem, not just the main-process logic the rest of this PoC covers. No Rust-side
/// involvement beyond the ordinary RPC round trip: discordBot.ts's own `fork()` call spawns the
/// bot as a grandchild of this sidecar entirely on the Node side (see sidecar.ts's own comment).
#[tauri::command]
fn bot_start(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("bot.start", None)
}

#[tauri::command]
fn bot_stop(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("bot.stop", None)
}

#[tauri::command]
fn bot_status(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("bot.status", None)
}

/// Calls the real, unmodified `applyWebDashboardSettings()`/`getWebDashboardStatus()` from
/// lib/webDashboard.ts - the third real subsystem from the original size estimate. Unlike the
/// bot, this one is an in-process http.Server/https.Server in the real app too, not a forked
/// child - so no fork()/SEA interaction to worry about, just the ordinary RPC round trip.
#[tauri::command]
fn dashboard_start(port: i64, sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("dashboard.start", Some(serde_json::json!({ "port": port })))
}

#[tauri::command]
fn dashboard_stop(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("dashboard.stop", None)
}

#[tauri::command]
fn dashboard_status(sidecar: tauri::State<SidecarHandle>) -> Result<Value, String> {
    sidecar.call("dashboard.status", None)
}

/// Spawns the sidecar through tauri-plugin-shell's real sidecar mechanism and a background
/// async task that owns reading its stdout for the app's whole lifetime: a line with an "id"
/// resolves the matching `call()` via `pending`, a line with an "event" instead gets forwarded
/// to the webview as a same-named Tauri event.
///
/// Default path: `app.shell().sidecar("sidecar-bin")`, which resolves to
/// `binaries/sidecar-bin-<target-triple>` per `tauri.conf.json`'s `bundle.externalBin` - the
/// real mechanism a shipped build uses (see "Sidecar packaging" in README.md), not a
/// source-tree path main.rs has to know about by convention. That file has to exist before
/// `cargo build` even starts (Tauri checks for it at build time, not just at runtime) - run
/// `sidecar/build-sea.mjs` first.
///
/// `SIDECAR_PATH` still overrides for dev iteration without rebuilding the SEA binary each
/// time `sidecar.ts` changes: when set, it's spawned as a plain `node <path>` command instead,
/// through the plugin's generic `app.shell().command(...)` (same `Command`/`CommandEvent` API,
/// so the rest of this function doesn't need to know which mode it's in).
fn spawn_sidecar(app: &tauri::App) -> SidecarHandle {
    let sidecar_command = match std::env::var("SIDECAR_PATH") {
        Ok(path) => {
            // Dev iteration only - matches Electron's own dev-mode cwd (wherever `electron .`
            // was run from: the repo root). Found via a real bug: webDashboard.ts's favicon
            // read (real, unmodified) resolves to `path.join(process.cwd(), 'build/icon.png')`
            // whenever app.isPackaged is false (electronShim.ts's own `isPackaged: false`
            // always takes this branch) - without this, the sidecar's cwd is wherever Rust
            // itself happened to be run from, which has no `build/icon.png` relative to it at
            // all, so the web dashboard's browser tab showed no favicon. The packaged
            // `sidecar-bin` branch below is untouched: a real install has no repo checkout to
            // point at, and `process.resourcesPath` (the branch that actually matters once
            // genuinely packaged) isn't affected by this at all.
            let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            app.shell().command("node").arg(path).current_dir(repo_root)
        }
        Err(_) => app
            .shell()
            .sidecar("sidecar-bin")
            .expect("failed to resolve the 'sidecar-bin' sidecar - check tauri.conf.json's bundle.externalBin and run sidecar/build-sea.mjs first"),
    };

    // Node's libuv threadpool defaults to only 4 worker threads, shared by every async fs/dns
    // call the sidecar makes. Found via a real freeze report: isValidArkInstall() (now async,
    // see detect.ts) checks every profile's install on launch - with a handful of sandbox
    // profiles on fast local disk that's unnoticeable, but with 6-20+ real profiles, each
    // async fs.promises.access() call still individually slow (a real Windows machine with
    // antivirus real-time scanning intercepting each disk access), only 4 can run at once, so
    // the rest queue behind them - confirmed by Task Manager showing near-0% CPU on both this
    // process and the sidecar during the freeze (I/O-wait, not a compute-bound loop). Raising
    // this lets far more of those checks actually run concurrently instead of queueing.
    let sidecar_command = sidecar_command.env("UV_THREADPOOL_SIZE", "64");

    // Fixes the real bug documented in README.md's "The Discord bot subsystem": discordBot.ts's
    // fork() silently can't launch a different script from inside this sidecar once it's a SEA
    // binary. BOT_LAUNCH_COMMAND (a small, opt-in override added to the real discordBot.ts -
    // zero behavior change when unset) tells it to spawn this specific binary by path instead.
    //
    // Resolved through the real `bundle.externalBin` mechanism this time (tauri.conf.json now
    // lists "binaries/bot-bin" alongside "binaries/sidecar-bin") - not the dev-only
    // CARGO_MANIFEST_DIR shortcut an earlier version of this function used, which would have
    // resolved to a source-tree path that doesn't exist once genuinely installed. Tauri's own
    // build script copies `binaries/bot-bin-<target-triple>` to a plain `bot-bin` next to the
    // compiled executable - in `target/debug/` during `cargo build` and in `usr/bin/` (Linux) of
    // a real `cargo tauri build` bundle alike - which is exactly the convention
    // tauri-plugin-shell's own (private) sidecar-path resolution uses internally, replicated
    // here by hand since there's no public API to ask it for a resolved path without spawning.
    let bot_bin_path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(if cfg!(windows) { "bot-bin.exe" } else { "bot-bin" })));
    let sidecar_command = match bot_bin_path {
        Some(path) if path.exists() => sidecar_command.env("BOT_LAUNCH_COMMAND", path),
        _ => sidecar_command,
    };

    let (mut rx, child) = sidecar_command
        .spawn()
        .unwrap_or_else(|e| panic!("failed to spawn sidecar: {e}"));
    let child: SharedChild = Arc::new(Mutex::new(child));

    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let reader_pending = pending.clone();
    let reader_child = child.clone();
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let Ok(raw) = serde_json::from_str::<Value>(&line) else {
                        eprintln!("sidecar: unparseable line: {line}");
                        continue;
                    };
                    if raw.get("id").is_some() {
                        let Ok(response) = serde_json::from_value::<RpcResponse>(raw) else {
                            eprintln!("sidecar: malformed response line: {line}");
                            continue;
                        };
                        if let Some(tx) = reader_pending.lock().unwrap().remove(&response.id) {
                            let _ = tx.send(response);
                        }
                    } else {
                        let Ok(push) = serde_json::from_value::<PushEvent>(raw) else {
                            eprintln!("sidecar: malformed push-event line: {line}");
                            continue;
                        };
                        if push.event == "shell-request" {
                            let Ok(request) = serde_json::from_value::<ShellRequest>(push.data) else {
                                eprintln!("sidecar: malformed shell-request data: {line}");
                                continue;
                            };
                            let response = handle_shell_request(&app_handle, &request.method, &request.params);
                            eprintln!("sidecar shell-request '{}' -> {:?}", request.method, response);
                            let payload = match response {
                                Ok(result) => serde_json::json!({ "id": request.id, "result": result }),
                                Err(error) => serde_json::json!({ "id": request.id, "error": error }),
                            };
                            if let Err(e) = write_line(&reader_child, &payload) {
                                eprintln!("failed to write shell-request response to sidecar stdin: {e}");
                            }
                        } else if let Err(e) = app_handle.emit(&push.event, push.data) {
                            eprintln!("failed to forward sidecar event '{}' to the webview: {e}", push.event);
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprint!("{}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Error(err) => eprintln!("sidecar process error: {err}"),
                CommandEvent::Terminated(payload) => {
                    eprintln!("sidecar process terminated: {payload:?}");
                    break;
                }
                _ => {}
            }
        }
    });

    SidecarHandle {
        child,
        next_id: AtomicI64::new(1),
        pending,
    }
}

/// Performs the real native action a sidecar's `shell-request` push event asked for, and
/// returns what to send back on its stdin. Only "openPath" exists so far, since that's the
/// only `shell.*` method any real lib file actually calls (confirmed by grepping - see
/// README.md's "Where the real Electron coupling lives").
fn handle_shell_request(app_handle: &tauri::AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "openPath" => {
            let path = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "shell-request 'openPath': missing or non-string 'path' param".to_string())?;
            app_handle
                .opener()
                .open_path(path, None::<&str>)
                .map(|_| Value::Bool(true))
                .map_err(|e| e.to_string())
        }
        other => Err(format!("unknown shell-request method '{other}'")),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = spawn_sidecar(app);
            app.manage(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            profiles_list,
            profiles_save,
            profiles_copy,
            profiles_move,
            profiles_copy_config_from,
            dialog_select_directory,
            dialog_select_file,
            dialog_select_ini_file,
            dialog_save_profile_file,
            dialog_save_cluster_bundle_file,
            dialog_select_cluster_bundle_file,
            window_focus,
            player_roster_list,
            player_roster_kick,
            player_bans_ban,
            player_whitelist_list,
            player_whitelist_add,
            player_whitelist_remove,
            log_record,
            manager_log_get_all,
            server_start,
            server_stop,
            server_restart,
            server_kill,
            server_update,
            server_status,
            server_install_test_executable,
            settings_get,
            settings_save,
            profiles_delete,
            profiles_reorder,
            system_stats_get_static_info,
            system_stats_get_network_usage,
            official_server_status_get,
            stats_history_get,
            stats_history_get_for_group,
            backup_get_schedule_status,
            server_get_installed_build_id,
            server_get_game_version,
            steamcmd_get_latest_build_id,
            system_open_server_config_folder,
            system_open_server_saved_arks_folder,
            system_open_server_save_games_folder,
            console_backlog,
            console_watch,
            console_append_test_line,
            folders_open_profiles,
            bot_start,
            bot_stop,
            bot_status,
            dashboard_start,
            dashboard_stop,
            dashboard_status,
            backup_create,
            backup_list,
            backup_delete,
            backup_restore,
            backup_open_folder,
            backup_get_log,
            player_backup_list_folders,
            player_backup_list,
            player_backup_open_folder,
            steamcmd_get_update_log,
            steamcmd_append_test_update_log_line,
            map_management_list,
            map_management_create,
            map_management_delete,
            map_management_open_folder,
            group_console_rcon_send,
            watched_players_list,
            watched_players_add,
            watched_players_remove,
            player_activity_list,
            player_activity_sessions,
            player_bans_list,
            player_bans_unban,
            stats_history_get_for_groups,
            steamcmd_managed_status,
            steamcmd_install,
            steamcmd_add_firewall_rule,
            group_console_subscribe,
            group_console_unsubscribe,
            mod_events_list,
            mod_events_save,
            mod_events_delete,
            mod_events_history,
            maps_list,
            custom_maps_list,
            custom_maps_add,
            custom_maps_update,
            custom_maps_delete,
            ini_templates_get_generic,
            ini_templates_save_generic,
            ini_templates_get_override,
            ini_templates_save_override,
            ini_templates_delete_override,
            ini_templates_apply,
            ini_templates_apply_all,
            ini_templates_read_file,
            file_browser_list,
            file_browser_open,
            file_browser_delete,
            file_browser_read_ini,
            file_browser_write_ini,
            file_browser_ini_history,
            file_browser_ini_history_diff,
            file_browser_ini_restore,
            mods_save,
            mods_parse_text,
            mods_reconcile_from_ini,
            ark_mods_search,
            ark_mods_info,
            server_preview_launch_command,
            system_open_data_dir_folder,
            profiles_export,
            data_dir_get_default,
            web_dashboard_get_local_ips,
            discord_bot_status,
            discord_bot_restart,
            discord_bot_stop,
            app_update_get_version,
            app_update_check,
            app_update_status,
            app_update_install,
            cluster_export,
            cluster_import,
            web_dashboard_access_tokens_list,
            web_dashboard_access_tokens_create,
            web_dashboard_access_tokens_update,
            web_dashboard_access_tokens_delete,
            web_dashboard_api_keys_list,
            web_dashboard_api_keys_create,
            web_dashboard_api_keys_update,
            web_dashboard_api_keys_delete,
            minecraft_install_list_versions,
            minecraft_install_list_loader_versions,
            minecraft_install_run,
            minecraft_profiles_list,
            minecraft_profiles_save,
            minecraft_profiles_delete,
            minecraft_server_get_status,
            minecraft_server_send_command,
            minecraft_console_get_backlog,
            minecraft_detect_launchable,
            minecraft_backup_get_log,
            minecraft_backup_append_test_log_line,
            minecraft_backup_create,
            minecraft_backup_list,
            minecraft_backup_delete,
            minecraft_backup_restore,
            minecraft_backup_open_folder,
            minecraft_open_server_folder,
            minecraft_properties_get,
            minecraft_properties_save,
            minecraft_mods_search,
            minecraft_mods_install,
            minecraft_mods_remove,
            minecraft_mods_set_enabled,
            minecraft_mods_check_updates,
            minecraft_mods_update,
            minecraft_mods_scan,
            minecraft_mods_open_folder,
            minecraft_server_start,
            minecraft_server_stop,
            minecraft_server_kill,
            minecraft_profiles_import,
            legacy_import_detect,
            legacy_import_preview,
            legacy_import_run,
            server_is_installed,
            app_startup_is_complete,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_is_maximized,
            app_quit,
            app_open_dev_tools,
            dialog_select_profile_file,
            profiles_import_from_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
