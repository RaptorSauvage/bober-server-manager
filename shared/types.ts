// Types shared between the Electron main process, the preload bridge and the
// React renderer. Keeping a single source of truth here avoids the two sides
// of the IPC boundary drifting apart.

import type { GameId } from './games'
import type { DiffLine } from './textDiff'
import type { MinecraftProfile, MinecraftServerStatus, MinecraftConsoleLine, MinecraftPropertiesData } from './minecraft'
import type {
  MinecraftModSource,
  MinecraftModSearchResult,
  MinecraftModInstallResult,
  MinecraftModUpdateCheckResult,
  MinecraftModScanResult,
  MinecraftModEcosystem
} from './minecraftMods'
import type { MinecraftInstallableType, MinecraftInstallParams, MinecraftInstallResult, MinecraftVersionOption } from './minecraftInstall'

export interface ServerProfile {
  id: string
  name: string
  /** Which game this profile launches (see shared/games.ts). Defaults to 'ark-ascended' for
   *  every profile saved before multi-game support existed. */
  game: GameId
  /** Root install directory, containing ShooterGame/Binaries/... */
  installDir: string
  /** Whether the SteamCMD update/install below targets a beta branch instead of the
   *  default/public one. */
  steamBetaEnabled: boolean
  /** Beta branch name, passed as `-beta <name>` right before `validate` in the SteamCMD
   *  update command when steamBetaEnabled is on. */
  steamBetaName: string
  /** Map identifier passed on the command line, e.g. "TheIsland_WP" */
  map: string
  /** Whether a modded map overrides the map above */
  moddedMapEnabled: boolean
  /** Workshop mod id for the modded map, passed as -MapModID=<id> when moddedMapEnabled */
  moddedMapId: string
  gamePort: number
  rconPort: number
  /** Separate query port some games need (ARK: Survival Evolved's -QueryPort=<n>) - unused
   *  for a game whose GameDefinition.usesQueryPort is false (ARK: Survival Ascended merged
   *  it into gamePort). Always present so every profile has a stable shape either way. */
  queryPort: number
  /** Crossplay setting passed as -ServerPlatform=<value> (ARK: Survival Ascended only - see
   *  buildLaunchArgs). */
  serverPlatform: 'PC' | 'ALL'
  /** Passed as -WinLiveMaxPlayers=<n> */
  maxPlayers: number
  /** Directory backups are written to */
  backupDir: string
  /** How many backups to keep per profile before pruning the oldest */
  maxBackups: number
  /** Optional cron expression for automatic backups, e.g. every 6 hours */
  backupSchedule?: string
  /** Whether the cron schedule above is actually active */
  backupScheduleEnabled: boolean
  /**
   * When true, backs up a player's .arkprofile file (from SavedArks/<map>) into a
   * dedicated per-player folder under the backup directory whenever the server's own
   * log shows them joining or leaving - detected by tailing ShooterGame.log, not RCON
   * polling.
   */
  playerProfileBackupEnabled: boolean
  /** How many of the snapshots above to keep per player before pruning the oldest */
  playerProfileBackupMaxPerPlayer: number
  /**
   * Mods, in load order. For ARK: Survival Ascended, only enabled mods are passed via the
   * server's `-mods=`/`-passivemods=` launch flags (it does not use GameUserSettings.ini for
   * mods at all - the launch flags are the only mechanism). ARK: Survival Evolved has no
   * command-line mechanism for mods and doesn't support passive/dev mods either - only
   * enabled mods are instead written to GameUserSettings.ini's `ActiveMods=` and Game.ini's
   * `[ModInstaller]` block (see gameConfigWrite.ts), which is the only thing that actually
   * makes a Mods tab change apply the next time it starts.
   */
  mods: ServerMod[]
  /** Whether the cluster options below are actually applied at launch */
  clusterEnabled: boolean
  /** Passed as -clusterid=<id> when clusterEnabled */
  clusterId: string
  /** Passed as -ClusterDirOverride=<path> when clusterEnabled and non-empty */
  clusterDirOverride: string
  /** Passed as -NoTransferFromFiltering when clusterEnabled */
  noTransferFromFiltering: boolean
  /** Passed as -ServerIP=<ip> when clusterEnabled and non-empty */
  externalIp: string
  /** Discord channel id the chat bridge relays this server's in-game chat to (and relays
   *  Discord messages posted there back into the game as ServerChat) - see
   *  discordChatBridgeWatch.ts. Not launch-related, unlike most of this Cluster group, but
   *  kept here since it's meant to be set to the same value on every profile in a cluster,
   *  same convention as clusterDirOverride/clusterId above - one shared chat channel per
   *  cluster, not a separate one per server. Blank disables the bridge for this profile. */
  discordChatChannelId: string
  /** Discord channel id TAME/tamed-dino-death/MISSION events from this server's log get
   *  posted to - same per-cluster convention as discordChatChannelId above, and independent
   *  of it (a server can have one, both, or neither set). Blank disables this for this
   *  profile. */
  discordEventsChannelId: string
  /** When true, the Discord bot treats this server as if it doesn't exist at all: left out of
   *  the ARK status embed, out of the bot's presence player count, and out of every admin
   *  slash command's own server autocomplete (/check, /restart, /rcon, ...) - filtered once at
   *  the bot's own server cache (src/bot/serverCache.ts's refreshServerCache) so every single
   *  consumer sees the same exclusion automatically. Independent of discordChatChannelId/
   *  discordEventsChannelId above (which already individually gate the chat/events relay per
   *  server) and of AppSettings.discordBotDisplayEnabled/discordBotArkCheckEnabled (which are
   *  global, Manager-wide switches, not per-server) - this is the per-server equivalent. */
  discordBotExcluded: boolean
  /** Passed as -culture=<value> when not 'none' */
  cultureSettings: 'none' | 'en' | 'fr'
  /** Passed as -NoBattlEye when true */
  disableBattlEye: boolean
  /** Passed as -servergamelogincludetribelogs -ServerRCONOutputTribeLogs when true */
  rconTribeLog: boolean
  /** Passed as -ForceRespawnDinos when true */
  forceRespawnDinos: boolean
  /** Passed as -nosound when true */
  noSound: boolean
  /** Passed as -DestroyTamesOverLevel=<value> when non-empty */
  maxDinoLevel: string
  /** Join/connect password (distinct from the RCON/admin one above), passed as
   *  ServerPassword=<value> inline in the map's ?-string. A mandatory argument for ARK:
   *  Survival Evolved (always emitted, even blank meaning no password) - not currently
   *  emitted for ARK: Survival Ascended. */
  serverPassword: string
  /** ARK: Survival Evolved only - passed as -automanagedmods when true, telling the server to
   *  download/update its own workshop mods (from ActiveMods=, see ServerMod below) instead of
   *  relying on them being pre-installed. Unused by ARK: Survival Ascended. */
  autoManageMods: boolean
  /** Free-form extra launch arguments appended to the command line */
  extraArgs: string
  /**
   * Scheduled restart: gracefully stops the server at `scheduledRestartTime` on the
   * selected days, optionally updates it via SteamCMD and/or starts it back up.
   */
  scheduledRestartEnabled: boolean
  /** 24h "HH:MM" */
  scheduledRestartTime: string
  /** Days it fires on, 0=Sunday..6=Saturday */
  scheduledRestartDays: number[]
  scheduledRestartUpdateAfter: boolean
  scheduledRestartStartAfter: boolean
  /** When true, a scheduled restart that fires while any player is still connected (per RCON
   *  ListPlayers) is skipped entirely for that occurrence - no stop/update/start at all,
   *  logged and left for the schedule's next occurrence rather than retried sooner. */
  scheduledRestartOnlyIfEmpty: boolean
  /** When true, a scheduled restart that fires with no server update actually available (per
   *  SteamCMD's cached public-branch build id vs. this profile's own installed build id - see
   *  isUpdateAvailableForProfile in updateCheck.ts) is skipped entirely for that occurrence,
   *  the same way scheduledRestartOnlyIfEmpty skips one with players still connected. Only
   *  meaningful for a game that supports update checking at all (GameDefinition.
   *  supportsUpdateCheck - ARK: Survival Ascended, not Evolved); combines with
   *  scheduledRestartOnlyIfEmpty when both are on, rather than replacing it. */
  scheduledRestartOnlyIfUpdateAvailable: boolean
  /** Scheduled dino wipe - independent of the restart above: sends RCON DestroyWildDinos
   *  at `scheduledDinoWipeTime` on the selected days, while the server is running. */
  scheduledDinoWipeEnabled: boolean
  /** 24h "HH:MM" */
  scheduledDinoWipeTime: string
  /** Days it fires on, 0=Sunday..6=Saturday */
  scheduledDinoWipeDays: number[]
  /** Generic RCON command scheduler - independent of (and in addition to) the dedicated
   *  restart/dino-wipe schedules above, for anything else you'd otherwise have to remember to
   *  run by hand (a ServerChat reminder, SaveWorld on its own cadence, etc). Any number of
   *  entries, each with its own command/time/days/enabled - see scheduledActions.ts. */
  scheduledRconCommands: ScheduledRconCommand[]
  /** Chained maintenance task - independent of the restart/dino wipe/RCON schedules above:
   *  at the configured time, stops the server, takes a backup (same createBackup() the
   *  Backups tab's manual button and the cron backup schedule both already use), updates it
   *  via SteamCMD, then starts it back up - a single fixed pipeline, not separately
   *  toggleable steps like the restart schedule's "update after"/"start after" options,
   *  since the whole point is running all four in that exact order. See
   *  runScheduledMaintenance in scheduledActions.ts. */
  scheduledMaintenanceEnabled: boolean
  /** 24h "HH:MM" */
  scheduledMaintenanceTime: string
  /** Days it fires on, 0=Sunday..6=Saturday */
  scheduledMaintenanceDays: number[]
  /** Anti-crash watchdog: when a server that was running is found stopped without ever
   *  passing through a deliberate `stopping`/`restarting` state first (i.e. a confirmed,
   *  unexpected crash - see handleUnexpectedExit in serverProcess.ts), restart it
   *  automatically after a short delay. Deliberate Stop/Kill/Restart/Update/scheduled
   *  restart are never mistaken for a crash, since each of those always sets `stopping` or
   *  `restarting` before touching the process. Independent per profile. */
  crashWatchEnabled: boolean
  /** Zombie detection: active only during the `starting` phase (from the process spawning
   *  until the startup-complete log marker confirms `running`, or the server otherwise
   *  leaves `starting` for any reason) - if it's still stuck in `starting` after
   *  `zombieDetectionTimeoutMinutes`, the process is killed as a zombie stuck in an endless
   *  loop, optionally followed by an automatic restart attempt. Independent per profile. */
  zombieDetectionEnabled: boolean
  /** Minutes to wait in `starting` before treating it as a zombie. Default 10. */
  zombieDetectionTimeoutMinutes: number
  /** Whether to attempt starting the server again right after killing a detected zombie. */
  zombieDetectionAutoRestart: boolean
  /** Max size (MB) of this server's permanent Cluster Console log archive
   *  (clusterLogArchive.ts) before its oldest events are trimmed to make room - a rolling
   *  window, not a hard cutoff that stops archiving. The archive only ever holds already-
   *  parsed, displayable events (one per line, as JSON) - not raw ShooterGame.log text - so
   *  the internal engine noise that makes up most of the raw file never counts against this
   *  limit in the first place. Unlike ShooterGame.log itself, the archive is never reset by
   *  a server restart, so the group console's backlog can span further back than the current
   *  session. Always on, no separate enable toggle - this is passive background logging, not
   *  an automated action like the watchdog/zombie features above. Default 10, configurable
   *  1-100 (enforced by the Server Management tab's input, not this type itself). */
  clusterLogArchiveMaxSizeMB: number
  /** When true, this server is started automatically when the Manager application itself
   *  launches (not to be confused with AppSettings.launchOnStartup, which is about the
   *  Manager launching at OS login). Staggered against other auto-start profiles by
   *  AppSettings.serverAutoStartStaggerSeconds. Skipped if the server is already running
   *  (re-adopted from a previous Manager session). */
  startOnManagerLaunch: boolean
  /** When true, hidden from the main dashboard grid (and bulk "...All" actions) without
   *  deleting it or touching whatever server process is actually running - just a way to
   *  declutter the main list for a profile you're not actively using right now. */
  hidden: boolean
  /** Free-form dashboard grouping label. Empty (the default) means "no group" - shown
   *  directly in the main grid. Any other value collects every profile sharing it into
   *  its own collapsible section on the dashboard, named after the group. */
  group: string
  /** When true, this server's CPU/RAM/player count are sampled continuously in the main
   *  process (src/main/lib/statsHistory.ts) and persisted to disk, independent of whether
   *  any Analytics tab or Cluster Dashboard is currently open to see them live. Shares one
   *  global size budget (AppSettings.statsHistoryMaxSizeMB) across every profile that has
   *  this on. Default off - a server's owner opts in per profile. */
  statsEnabled: boolean
}

export interface MapDefinition {
  /** Internal map identifier passed on the command line, e.g. "TheIsland_WP" */
  id: string
  /** Human-readable label shown in the map selector */
  displayName: string
  /** Custom/modded maps only - a CurseForge/Workshop mod id. Selecting this map in a
   *  server's Settings tab automatically adds this mod to that server's mod list if it isn't
   *  there already. Official maps (maps.json) never have this. */
  modId?: string
}

export interface ServerMod {
  id: string
  /** User-supplied label, purely cosmetic - not looked up automatically. */
  name?: string
  enabled: boolean
  /** ARK: Survival Ascended only - when true, the id is passed via -passivemods= instead of
   *  -mods=. ARK: Survival Evolved has no such concept; ignored for it. */
  passive: boolean
  /** ARK: Survival Ascended only - when true, the id is passed as "<id>-dev" so ARK loads the
   *  mod's in-development build. ARK: Survival Evolved has no such concept; ignored for it. */
  dev: boolean
}

/** One CurseForge search hit for ARK: Survival Ascended's own Mods tab - Ascended's mods are
 *  CurseForge project ids referenced directly (no file download through this app the way
 *  Minecraft mods get, see arkMods.ts's own doc comment), so this is deliberately a much
 *  thinner shape than MinecraftModSearchResult: nothing here is used to pick a version/loader-
 *  compatible file, it's purely "what is this id called and what does it look like" so Add can
 *  prefill ServerMod.id/name from a real search hit instead of the user typing a bare numeric
 *  id in by hand. ARK: Survival Evolved isn't covered at all - its own mod ids are Steam
 *  Workshop ids, a completely different namespace CurseForge knows nothing about. */
export interface ArkModSearchResult {
  id: string
  name: string
  summary: string
  iconUrl?: string
  downloads: number
}

/** Just enough to show next to a mod id already in the table - looked up by id for every
 *  ServerMod in an ARK: Survival Ascended profile's list, same "enrich what's already there"
 *  idea as ArkModSearchResult but for ids that didn't come from a search (typed by hand, or
 *  added before this feature existed). Keyed by ServerMod.id in ArkModInfoMap below. */
export interface ArkModInfo {
  name: string
  iconUrl?: string
}

/** CurseForge mod ids this app doesn't recognize (not every id is necessarily a real,
 *  still-published CurseForge project) are simply absent from the map - callers fall back to
 *  the bare id, same as before this feature existed. */
export type ArkModInfoMap = Record<string, ArkModInfo>

export type ServerRunState = 'stopped' | 'starting' | 'running' | 'stopping' | 'restarting' | 'updating' | 'error'

export interface AppSettings {
  /** Path to the steamcmd executable (steamcmd.exe on Windows, steamcmd.sh on Linux). */
  steamCmdPath: string
  /**
   * Base folder for editable JSON config files (maps.json, customMaps.json, and any future
   * ones). Empty means "use the default" (Documents/ARK Server Manager).
   */
  dataDir: string
  /** Whether the local browser-accessible web dashboard (live console + RCON) is running. */
  webDashboardEnabled: boolean
  /** Port the web dashboard listens on. */
  webDashboardPort: number
  /**
   * Interface the web dashboard binds to. '127.0.0.1' (default) - this machine only.
   * '0.0.0.0' or a specific local IP makes it reachable from other devices on the LAN -
   * there's no login of its own, so that's a deliberate, explicit choice.
   */
  webDashboardHost: string
  /** Event labels (JOIN, CHAT, ...) hidden from the web dashboard's live feed. */
  webDashboardDisabledLabels: string[]
  /** Whether the Manager registers itself to launch automatically when you log into
   *  Windows (or the equivalent on macOS/Linux), via Electron's own login-item API. */
  launchOnStartup: boolean
  /** When true, clicking the window's close button hides it to a system tray icon instead
   *  of quitting the app - every managed server keeps running either way (they're tracked
   *  independently of the window), but this also keeps the Discord bot and web dashboard
   *  alive in the background. Quitting for real is only ever done from the tray icon's own
   *  "Quit" menu item. Defaults to false - closing the window quits the app, as before. */
  closeToTrayEnabled: boolean
  /** When true, the web dashboard requires a valid access token (see
   *  WebDashboardAccessToken) and switches to HTTPS with a self-signed certificate - meant
   *  for exposing it outside the LAN. When false (default), it behaves exactly as before:
   *  no auth, plain HTTP. */
  webDashboardAuthEnabled: boolean
  /** Minimum delay, in seconds, between any two ARK servers actually spawning their OS
   *  process - enforced globally by serverProcess.ts's own spawn queue (reserveSpawnSlot),
   *  not just for ServerProfile.startOnManagerLaunch's own staggering (which still paces
   *  its own calls on top of this). Covers every path that can start several servers close
   *  together: Manager-launch auto-start, a manual Start/Restart click, the Dashboard's bulk
   *  Start All/Restart All, a scheduled restart, and a crash-watch/zombie-detection
   *  auto-restart. ARK's own world-loading is heavy enough (often single-threaded) that
   *  several spawning in the same instant can starve each other out badly enough that some
   *  never finish loading at all - a real report showed restarting several servers manually
   *  resulting in only 1-2 of them actually coming back up. The first spawn in a batch is
   *  never delayed; only one requested while another is still within this window is. */
  serverAutoStartStaggerSeconds: number
  /** When true (default), a server's GameUserSettings.ini/Game.ini are set read-only while
   *  it's running (see src/main/lib/iniLock.ts) - a deterrent against editing a running
   *  server's config by accident. Turning this off unlocks every profile's config files
   *  right away, including ones currently running. */
  iniLockEnabled: boolean
  /** Global cap (MB) on the combined size of every profile's persisted CPU/RAM/player
   *  history (src/main/lib/statsHistory.ts), shared across every profile with
   *  ServerProfile.statsEnabled on - not a per-server quota. Once exceeded, the oldest
   *  samples (from whichever profile they belong to) are trimmed first. Default 1024 (1GB). */
  statsHistoryMaxSizeMB: number
  /** Global age cap (hours) on the same persisted CPU/RAM/player history - a sample older
   *  than this is trimmed regardless of how far the size cap above still has to go. Keeps
   *  a long-running Manager's stats file (and the read/parse cost of ever touching it) from
   *  growing indefinitely just because nothing has hit the byte budget yet. Default 24. */
  statsHistoryMaxAgeHours: number
  /** When true (default), a running server's own console window is left visible (Windows
   *  only - both games allocate one the moment their exe is spawned, regardless of any
   *  launch flag). Unchecking spawns it with Node's `windowsHide` instead, since there's no
   *  way to resize its font from here and no ARK launch flag suppresses the window itself. */
  showServerConsoleWindow: boolean
  /** Manager-wide display order for server groups (ServerProfile.group values) on the
   *  Dashboard. A group name not listed here falls back to alphabetical order, appended
   *  after every explicitly-ordered one - so a brand new group shows up without needing to
   *  be added here first. */
  groupOrder: string[]
  /** Group names created explicitly (File > Manage Groups, or "New group..." from a server
   *  card's own menu) - kept even while the group has no servers in it yet/anymore, so an
   *  empty group a user just made still shows up on the Dashboard ready to receive servers,
   *  instead of silently disappearing until something's actually assigned to it. */
  registeredGroups: string[]
  /** Group names currently collapsed on the Dashboard. A collapsed group's servers are also
   *  left out of the Cluster Dashboard and the Web Dashboard's own Dashboard tab, not just
   *  visually minimized on the Manager's own Dashboard. */
  collapsedGroups: string[]
  /** Same as groupOrder, but for the Minecraft Dashboard's own groups (MinecraftProfile.group
   *  values) - kept separate rather than sharing groupOrder, since an ARK group and a
   *  Minecraft group happening to share a name shouldn't share a display order. */
  minecraftGroupOrder: string[]
  /** Same as collapsedGroups, but for the Minecraft Dashboard - there's no Cluster Dashboard/
   *  Web Dashboard aggregate view for Minecraft yet, so this only affects the Minecraft
   *  Dashboard's own display. */
  minecraftCollapsedGroups: string[]
  /** CurseForge Core API key, needed for the Mods tab to also search/install from CurseForge
   *  (Modrinth needs no key at all). Get one free at https://console.curseforge.com/ - sign in
   *  with a CurseForge/Overwolf account, "API Keys" in the left sidebar, "Generate new API
   *  key", give it any name, agree to the terms (for non-commercial use), and the key shown
   *  there is a plain API key - paste it here. Empty means CurseForge search is skipped
   *  entirely (Modrinth results alone), not an error. */
  curseforgeApiKey: string

  /** Whether the Discord bot integration (src/bot/) is spawned alongside the Manager - see
   *  src/main/lib/discordBot.ts. Off by default: it needs a real Discord bot token before
   *  there's anything useful for it to do. */
  discordBotEnabled: boolean
  discordBotToken: string
  /** Optional - syncs slash commands instantly to this one Discord server instead of
   *  waiting for the ~1h global sync (useful while testing). */
  discordBotDevGuildId: string
  discordBotStatusChannelId: string
  discordBotRefreshSeconds: number
  discordBotStatusEmbedTitle: string
  discordBotStatusEmbedDescription: string
  discordBotStatusEmbedColor: string
  discordBotArkCheckEnabled: boolean
  discordBotMcStatusChannelId: string
  discordBotMcRefreshSeconds: number
  discordBotMcStatusEmbedTitle: string
  discordBotMcStatusEmbedDescription: string
  discordBotMcStatusEmbedColor: string
  discordBotMcCheckEnabled: boolean
  /** Master switch over everything the bot actually *displays* (the ARK/Minecraft status
   *  embeds, its own Discord presence/activity text, and the chat/events relay) - distinct
   *  from discordBotEnabled above (whether the bot process runs at all): turning this off
   *  keeps slash commands, CurseForge update checks, player-join alerts, scheduled actions
   *  etc. all working exactly as before, it just silences the bot's own visible output. Off
   *  overrides every one of the three sub-toggles below and discordBotArkCheckEnabled/
   *  discordBotMcCheckEnabled regardless of their own state; on, each still applies
   *  individually - see discordBot.ts's buildConfig for where the combination happens. */
  discordBotDisplayEnabled: boolean
  /** Sub-toggle for the bot's own Discord presence/activity text (e.g. "Surveille N
   *  survivants") - see statusRefresh.ts's updateBotPresence. Off clears any activity
   *  already showing rather than leaving a stale one in place. */
  discordBotPresenceEnabled: boolean
  /** Sub-toggle for the chat/events relay (per-profile discordChatChannelId/
   *  discordEventsChannelId in both directions) - see discordChatBridgeWatch.ts
   *  (game -> Discord, via notifyGameEvent in discordBot.ts) and the bot's own
   *  Events.MessageCreate handler (Discord -> game). A profile's own channel ids still need
   *  to be set independently for anything to actually relay; this is a single override to
   *  silence all of them at once without clearing each profile's own configuration. */
  discordBotChatBridgeEnabled: boolean
  /** Discord user ids (decimal strings - snowflakes exceed Number's safe integer range)
   *  allowed to use every admin command (/maintenance, /dinowipe, /saveworld, /adminchat,
   *  /rcon, /schedule, /check, /botmaintenance, /setchannel, /addmod, /removemod). Empty
   *  means nobody can - the bot logs a warning on startup in that case. */
  discordBotMaintenanceWhitelistIds: string[]
  /** Separate, smaller whitelist for /start /stop /restart /update /updaterestart only -
   *  anyone already in discordBotMaintenanceWhitelistIds also has access automatically. */
  discordBotManagerWhitelistIds: string[]
  /** The bot's own CurseForge mod-update-notification module - independent of the Mods tab's
   *  curseforgeApiKey above, but reuses that same key rather than asking for a second one. */
  discordBotCurseforgeModuleEnabled: boolean
  discordBotCurseforgeDefaultModIds: string[]
  discordBotCurseforgeCheckIntervalMinutes: number
  /** The "player joined" alert (ARK only) - see WatchedPlayerAlert and
   *  playerJoinAlertWatch.ts. Off by default, same reasoning as discordBotEnabled: no point
   *  running the watch until there's a channel to post to and at least one watched player. */
  discordBotPlayerAlertEnabled: boolean
  discordBotPlayerAlertChannelId: string
  /** Player activity/playtime tracking (ARK only) - see playerActivityWatch.ts. Off by
   *  default, same reasoning as every other opt-in background watcher in this app: no point
   *  tailing every ARK server's log for this until someone actually wants the data. */
  playerActivityTrackingEnabled: boolean
  /** Id of the Web Dashboard API key auto-provisioned for the bot's own use (see
   *  discordBot.ts) - only meaningful when webDashboardAuthEnabled is also on. Empty means
   *  none has been provisioned yet (or auth is off, so none is needed). Internal bookkeeping,
   *  never shown as an editable field in Settings. */
  discordBotApiKeyId: string
}

/** Four tiers, highest to lowest: `globalAdmin` (everything, every server, regardless of any
 *  `profileIds` scoping on the credential - the only role that ignores it), `admin` (the same
 *  full permission set as globalAdmin, but restricted to whichever servers the credential is
 *  scoped to via `profileIds`, exactly like every other role already is), `moderator` (start/
 *  stop/RCON/create-backup plus the Console/Analytics/Backup/Server Management/Cluster
 *  Dashboard views - everything but Settings/Mods/Map Management/Update Log), `readonly` (view
 *  only, no actions). Legacy stored values from before this 4-tier split - `'admin'` (which
 *  used to mean unrestricted) and `'operator'` - are migrated lazily on read; see
 *  migrateLegacyRole in store.ts. */
export type WebDashboardRole = 'globalAdmin' | 'admin' | 'moderator' | 'readonly'

/**
 * A browser access token for the web dashboard page itself - pasted once into the browser
 * (stored in that browser's own localStorage, never a cookie/session) and sent back as
 * `Authorization: Bearer ark_<id>_<secret>` on every request from then on, exactly like a
 * WebDashboardApiKey but kept in its own separate list: this is what a *person* pastes into
 * their browser, an API key is what a *script/bot* is configured with. Managed only from
 * the Manager's own Settings screen - the dashboard page itself never creates/edits/deletes
 * tokens, only presents one. Keeping token management desktop-only means granting/revoking
 * browser access always requires local access to the machine running the Manager, never
 * just a web session.
 */
export interface WebDashboardAccessToken {
  id: string
  /** Free-form label so more than one token stays identifiable (e.g. "My laptop"). */
  label: string
  /** Never sent to the renderer - see WebDashboardAccessTokenSummary for what it gets instead. */
  secretHash: string
  role: WebDashboardRole
  /** Which server profiles this token can see/act on - `null` means every profile (the
   *  default, and the only behavior before this field existed, so older stored tokens with
   *  no field at all keep working exactly as before). An empty array also means every
   *  profile, matching the Settings UI's "nothing checked = all servers" picker. Enforced
   *  server-side on every route that operates on a specific profile or group, not just
   *  filtered out of the dashboard's own UI. */
  profileIds: string[] | null
  createdAt: number
}

/** WebDashboardAccessToken with the secret hash stripped out, for the renderer/Settings UI. */
export type WebDashboardAccessTokenSummary = Omit<WebDashboardAccessToken, 'secretHash'>

/**
 * A centralized ban entry (ARK only for now - `BanPlayer`/`UnbanPlayer` via RCON, keyed by
 * Steam/EOS id) - ARK itself only ever writes a ban to the one server it was issued on, each
 * server keeping its own separate list with no awareness of the others. This is the Manager's
 * own merged view across every server it's actually been applied to, so banning on one server
 * (or several at once) and reviewing/undoing it later doesn't mean hunting through each
 * server's own banlist individually.
 */
export interface BannedPlayer {
  /** Steam/EOS id - what ARK's BanPlayer/UnbanPlayer/KickPlayer commands actually take. */
  id: string
  /** Last known in-game name - purely a label, ARK's own ban list only ever keys by id. */
  name: string
  reason: string
  bannedAt: number
  /** Which ARK server profiles this id has actually been banned on. */
  profileIds: string[]
}

/**
 * A simple tracking list (ARK only), parallel to BannedPlayer but deliberately not enforced
 * server-side - unlike Ban (a real RCON BanPlayer call), "whitelisting" someone here is just a
 * note for admins ("this id is known/trusted"), not an actual join restriction. ARK does have
 * a real join-restriction mechanism (ExclusiveJoin + a PlayersExclusiveJoinList.txt file), but
 * that's a bigger, separate feature this deliberately doesn't attempt - see the Players screen
 * for where this is surfaced.
 */
export interface WhitelistedPlayer {
  /** Steam/EOS id. */
  id: string
  /** Last known in-game name - purely a label, same as BannedPlayer.name. */
  name: string
  addedAt: number
  /** Which ARK server profiles this id has been added to the whitelist on. */
  profileIds: string[]
}

/** One row of a server's live RCON `ListPlayers` roster - see parsePlayerListWithIds
 *  (rcon.ts), which is what actually produces these on the main-process side. */
export interface PlayerRosterEntry {
  id: string
  name: string
}

/**
 * A player watched for the Discord "player join" alert (ARK only - see
 * playerConnectionWatcher.ts, which this reuses). `value` is matched case-insensitively
 * against either the joining player's in-game name or their Steam/EOS id, against every
 * running ARK server at once - not scoped to one profile, since the point is to be notified
 * no matter which server in the cluster that person joins.
 */
export interface WatchedPlayerAlert {
  id: string
  /** The in-game name or Steam/EOS id to watch for. */
  value: string
  /** Free-text label purely for display in the list (e.g. who this actually is/why they're
   *  watched) - never matched against, unlike value. */
  label: string
  createdAt: number
}

/**
 * Event Scheduler (ARK only, Tools menu) - automatically adds a set of CurseForge mod ids
 * to the target servers' mod lists when the event starts, and removes them again when it
 * ends (e.g. a seasonal event like "Fear Ascended" for Halloween). Cluster-wide, not tied to
 * one profile - see src/main/lib/modEvents.ts for the scheduling engine.
 */
export interface ModEvent {
  id: string
  name: string
  /** CurseForge mod ids - the same id format ServerMod.id already uses. */
  modIds: string[]
  /** When true, startAt/endAt's year is ignored - the event fires every year on the same
   *  month/day/hour/minute instead of once. A preset holiday event (Halloween, Christmas,
   *  ...) is normally recurring; a one-off is not. */
  recurringYearly: boolean
  /** ISO 8601 datetime the event activates (mods added) at. */
  startAt: string
  /** ISO 8601 datetime the event deactivates (mods removed) at. */
  endAt: string
  /** 'all' = every ARK profile, now and any created later; an array = only those profile
   *  ids, fixed at save time (a profile deleted afterward is just silently skipped when the
   *  event fires). */
  targetServers: 'all' | string[]
  /** If true, a running target server is stopped before the mods are added at the event's
   *  start, then started back up afterward - so the mod actually takes effect immediately
   *  instead of only on the next manual restart. If false, the mod list is updated but a
   *  running server is left alone. */
  shutdownOnStart: boolean
  /** Same idea as shutdownOnStart, for removing the mods when the event ends. */
  shutdownOnEnd: boolean
  enabled: boolean
}

export type ModEventAction = 'activated' | 'deactivated'

/** One past firing of a ModEvent - shown in the Event Scheduler's own History tab. */
export interface ModEventHistoryEntry {
  id: string
  eventId: string
  /** Copied at fire time rather than looked up live, so history still reads correctly after
   *  the event itself is renamed or deleted. */
  eventName: string
  action: ModEventAction
  timestamp: number
  /** Every profile id the event actually targeted this firing (after resolving 'all'). */
  profileIds: string[]
  /** Profile id -> error message, for any target that failed - a per-server failure doesn't
   *  stop the others from being processed, so this can be non-empty alongside a firing that
   *  still succeeded for every other target. */
  errors?: Record<string, string>
}

/** Internal scheduling-engine bookkeeping (src/main/lib/modEvents.ts) - which boundary
 *  (start or end trigger instant) was last actually processed for a given event, so a
 *  restart/re-arm only replays a transition that's genuinely new, not one already handled.
 *  Without this, reconciling against "what should be true right now" on every arm would
 *  silently undo a mod a user removed/added by hand partway through an event's window.
 *  Purely internal - never exposed through the Api surface, the renderer has no use for it. */
export interface ModEventSchedulerState {
  /** ISO instant of the boundary (a specific start-or-end occurrence) that was last
   *  processed for this event. */
  lastBoundaryAt: string
  lastAction: ModEventAction
}

/**
 * INI Templates (ARK only, Tools menu) - a cluster-wide "generic" template plus an optional
 * per-profile "override", each raw GameUserSettings.ini/Game.ini text written verbatim
 * (comments and all) as its own block at the end of a profile's real config files, the
 * override's block after the generic one so it wins for any key both define - see
 * src/main/lib/iniTemplates.ts. Lets a shared base config (rates, difficulty, rules, ...) be
 * written once (or imported from a file the user already has) and reused across every
 * server, with only the genuinely server-specific lines kept in that one profile's own
 * override.
 */
export interface IniTemplateContent {
  gameUserSettingsIni: string
  gameIni: string
}

export interface IniTemplateProfileOverride extends IniTemplateContent {
  profileId: string
  /** The name written to SessionName when this override is applied, independent of the
   *  profile's own name in the Manager - e.g. a short internal label in the sidebar
   *  ("Island") vs a longer public name in the server browser ("[EU] My Cluster - Island
   *  PvE"). Blank (the default) falls back to the profile's own name, same as before this
   *  field existed. */
  sessionName: string
}

/** Per-profile result of applying the INI templates - surfaced by the "Apply to All" bulk
 *  action, which can't just throw on the first failure the way a single-profile Apply does. */
export interface IniTemplateApplyResult {
  profileId: string
  profileName: string
  ok: boolean
  error?: string
}

/** What generatePendingIniTemplate staged for one profile - real file paths (relative to that
 *  profile's own installDir, the same convention fileBrowser.open takes) for whatever
 *  `*.pending.ini` files it wrote, so the view can offer to open them in the user's own editor
 *  before confirmPendingIniTemplate replaces the real files with their content. `gameIniPath`
 *  is null when the merged template has no Game.ini entries at all - same case applyIniTemplate
 *  itself skips touching Game.ini for. */
export interface IniTemplatePendingResult {
  profileId: string
  gameUserSettingsIniPath: string
  gameIniPath: string | null
}

/**
 * One entry of a server's generic RCON command scheduler (ARK only) - see
 * ServerProfile.scheduledRconCommands and scheduledActions.ts's own applyScheduledRconCommands.
 */
/** MCSS-inspired trigger shape, adapted to ARK: 'fixedTime' fires at a day/time like the
 *  Restart/Dino Wipe schedules; 'interval' repeats continuously every `intervalSeconds`
 *  while the server's running (not a one-shot delay after start); 'timeless' never fires on
 *  its own - the entry exists only to be triggered manually ("Run now"). */
export type ScheduledRconTriggerType = 'fixedTime' | 'interval' | 'timeless'

/** Gates a trigger on who's connected at fire time, same idea as
 *  scheduledRestartOnlyIfEmpty but generalized to any of the three states a check could
 *  care about, not just "empty". 'always' matches every prior entry's behavior (the default
 *  for anything migrated from before this existed). */
export type ScheduledRconPlayerRequirement = 'always' | 'onlyIfEmpty' | 'onlyIfPlayers'

export interface ScheduledRconCommand {
  id: string
  /** Free-text label purely for display (e.g. "Nightly save") - the command itself is what
   *  actually runs, this is never parsed/matched against anything. */
  label: string
  /** Sent via RCON exactly as typed - whatever ARK's RCON console would accept. */
  command: string
  triggerType: ScheduledRconTriggerType
  /** 24h "HH:MM", same format as scheduledRestartTime/scheduledDinoWipeTime - only used
   *  when triggerType is 'fixedTime'. */
  time: string
  /** Days it fires on, 0=Sunday..6=Saturday - only used when triggerType is 'fixedTime'. */
  days: number[]
  /** Only used when triggerType is 'interval'. */
  intervalSeconds: number
  playerRequirement: ScheduledRconPlayerRequirement
  enabled: boolean
}

/**
 * Aggregated playtime for one player (ARK only), merged across every server they've played
 * on - keyed by Steam/EOS id, same merge-across-servers reasoning as BannedPlayer above.
 * Built from closed sessions only (see PlayerActivitySession) - a player currently connected
 * doesn't show their in-progress session's time here until they leave.
 */
export interface PlayerActivityRecord {
  id: string
  /** Last known in-game name - purely a label, like BannedPlayer.name. */
  name: string
  totalPlaytimeMs: number
  sessionCount: number
  lastSeenAt: number
  profileIds: string[]
}

/** One closed join-to-leave session, kept as a capped recent-activity log (see
 *  recordPlayerSession in store.ts for the cap) - mainly so the Player Activity screen can
 *  show something more concrete than just a running total. */
export interface PlayerActivitySession {
  id: string
  profileId: string
  playerId: string
  playerName: string
  joinedAt: number
  leftAt: number
}

/**
 * A snapshot of a config file's content right before the raw .ini editor (web dashboard or
 * desktop Manager - see src/main/lib/fileBrowser.ts, shared between the two) overwrote it -
 * only edits made through that editor are tracked; every other way a .ini file gets written
 * in this app (the structured Settings forms, mod toggles rewriting ActiveMods=, etc.) goes
 * through its own targeted key writes rather than a free-form overwrite, so there's no
 * single "previous full content" moment worth snapshotting there the way there is for a raw
 * edit.
 */
export interface ConfigFileHistoryEntry {
  id: string
  profileId: string
  /** Relative to the profile's installDir - same shape the ini read/write calls take. */
  path: string
  content: string
  savedAt: number
}

/** One entry of a file-browser directory listing - see FileBrowserListing/fileBrowser.ts. */
export interface FileBrowserEntry {
  name: string
  isDir: boolean
  size: number
  mtime: number
}

export interface FileBrowserListing {
  path: string
  entries: FileBrowserEntry[]
}

/** `ConfigFileHistoryEntry` without `content`/`profileId` - what a history *list* actually
 *  needs (see listIniHistory in fileBrowser.ts for why the full content isn't included). */
export interface ConfigFileHistorySummary {
  id: string
  savedAt: number
}

/**
 * A programmatic credential for the web dashboard's HTTP API - meant for scripts/bots
 * that can't drive a login form/session cookie the way a browser does. Presented as
 * `Authorization: Bearer ark_<id>_<secret>`; `id` is looked up directly (not scanned) and
 * `secret` is checked against `secretHash` the same way an account's password is. Like
 * accounts, managed only from the Manager's own Settings screen - never exposed over the
 * dashboard's own HTTP API.
 */
export interface WebDashboardApiKey {
  id: string
  /** Free-form label so more than one key stays identifiable (e.g. "Discord bot"). */
  label: string
  /** Never sent to the renderer - see WebDashboardApiKeySummary for what it gets instead. */
  secretHash: string
  role: WebDashboardRole
  createdAt: number
}

/** WebDashboardApiKey with the secret hash stripped out, for the renderer/Settings UI. */
export type WebDashboardApiKeySummary = Omit<WebDashboardApiKey, 'secretHash'>

export interface ServerStatus {
  profileId: string
  state: ServerRunState
  pid?: number
  startedAt?: number
  cpu?: number
  memoryMB?: number
  memoryPercent?: number
  players?: string[]
  lastError?: string
  /** Set whenever the last attempt to read CPU/RAM (pidusage) failed, with its raw error
   *  message - surfaced in the UI so a persistent failure (e.g. a missing OS tool) is
   *  diagnosable without needing the Manager's own console output. Cleared once a reading
   *  succeeds again. */
  statsError?: string
}

export interface BackupEntry {
  fileName: string
  filePath: string
  createdAt: number
  sizeBytes: number
}

/** One step of a backup's SaveGame -> settle -> zip sequence, for the Backups tab's
 *  process log - so a scheduled/automatic backup (which nobody's watching happen) can
 *  still be monitored/debugged after the fact instead of being a black box. */
export interface BackupLogEntry {
  timestamp: number
  level: 'info' | 'error'
  message: string
}

/** One subfolder directly under SavedArks - for the Settings tab's Map Management section,
 *  which browses/creates/deletes them (e.g. to pre-create a custom map's empty save folder
 *  before its mod is installed). */
export interface MapFolderEntry {
  name: string
  createdAt: number
}

/** For the Analytics tab's "Backup Status" panel. */
export interface BackupScheduleStatus {
  /** Whether the schedule is actually running right now (enabled, valid cron, applied). */
  active: boolean
  /** Epoch ms of the next scheduled run, or null if inactive/unparseable. */
  nextRunAt: number | null
}

/** Polled every 30 minutes from SteamCMD (anonymous, no download) for the Analytics tab's
 *  "update available" check - see src/main/lib/updateCheck.ts. Scoped to one branch (the
 *  public one by default, or a profile's own beta branch) - a beta-pinned profile is never
 *  compared against the public branch's build id, only its own branch's. */
export interface LatestBuildIdCache {
  buildId: string | null
  /** When that value was captured (epoch ms), or null before the first check. */
  checkedAt: number | null
  /** The last check's failure, if the most recent attempt didn't produce a build id. */
  error: string | null
}

/** Progress of a Manager self-update, driven by electron-updater against this repo's
 *  GitHub Releases - see src/main/lib/appUpdater.ts. Pushed to the renderer as it changes
 *  so the Settings button can show live status instead of just the final result. */
export interface AppUpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  /** The update's version, once known (from 'available' onward). */
  version?: string
  /** Download progress 0-100, while state is 'downloading'. */
  percent?: number
  error?: string
}

/** One player's backup folder, for a "pick a player" selector next to the world backup list. */
export interface PlayerBackupFolder {
  /** Raw folder name - pass back to playerBackup.list/openFolder as-is. */
  key: string
  playerName: string
  uniqueNetId: string
}

export interface RconResult {
  ok: boolean
  response?: string
  error?: string
}

export const IPC = {
  profilesList: 'profiles:list',
  profilesSave: 'profiles:save',
  profilesDelete: 'profiles:delete',
  profilesImport: 'profiles:import',
  profilesReorder: 'profiles:reorder',
  profilesExport: 'profiles:export',
  profilesImportFromFile: 'profiles:import-from-file',
  profilesCopy: 'profiles:copy',
  profilesMove: 'profiles:move',
  profilesCopyConfigFrom: 'profiles:copy-config-from',
  /** Pushed to every renderer window whenever the stored profile list actually changes -
   *  regardless of what triggered it (this window's own IPC calls, or a write from the web
   *  dashboard's HTTP API, which never goes through IPC at all) - so an edit made from the
   *  web dashboard shows up live in the desktop app without needing a restart or manual
   *  refresh. */
  profilesChanged: 'profiles:changed',

  dialogSelectDirectory: 'dialog:select-directory',
  dialogSelectFile: 'dialog:select-file',
  dialogSaveProfileFile: 'dialog:save-profile-file',
  dialogSelectProfileFile: 'dialog:select-profile-file',

  serverStart: 'server:start',
  serverStop: 'server:stop',
  serverRestart: 'server:restart',
  serverKill: 'server:kill',
  serverUpdate: 'server:update',
  serverIsInstalled: 'server:is-installed',
  serverStatus: 'server:status',
  serverStatusChanged: 'server:status-changed',
  serverGetInstalledBuildId: 'server:get-installed-build-id',
  serverGetGameVersion: 'server:get-game-version',
  serverPreviewLaunchCommand: 'server:preview-launch-command',

  modsSave: 'mods:save',
  modsParseText: 'mods:parse-text',
  modsReconcileFromIni: 'mods:reconcile-from-ini',
  arkModsSearch: 'ark-mods:search',
  arkModsInfo: 'ark-mods:info',

  backupCreate: 'backup:create',
  backupList: 'backup:list',
  backupRestore: 'backup:restore',
  backupDelete: 'backup:delete',
  backupOpenFolder: 'backup:open-folder',
  backupCreated: 'backup:created',
  backupScheduleStatus: 'backup:schedule-status',
  backupLogGet: 'backup:log-get',
  backupLogChanged: 'backup:log-changed',

  playerBackupFoldersList: 'player-backup:folders-list',
  playerBackupList: 'player-backup:list',
  playerBackupOpenFolder: 'player-backup:open-folder',

  settingsGet: 'settings:get',
  settingsSave: 'settings:save',

  steamcmdInstall: 'steamcmd:install',
  steamcmdManagedStatus: 'steamcmd:managed-status',
  steamcmdUpdateLog: 'steamcmd:update-log',
  steamcmdUpdateLogChanged: 'steamcmd:update-log-changed',
  steamcmdAddFirewallRule: 'steamcmd:add-firewall-rule',
  steamcmdLatestBuildId: 'steamcmd:latest-build-id',

  mapsList: 'maps:list',
  customMapsList: 'custom-maps:list',
  customMapsAdd: 'custom-maps:add',
  customMapsUpdate: 'custom-maps:update',
  customMapsDelete: 'custom-maps:delete',
  dataDirGetDefault: 'data-dir:get-default',

  officialServerStatusGet: 'official-server-status:get',
  systemStatsGet: 'system-stats:get',
  systemStatsGetNetworkUsage: 'system-stats:get-network-usage',

  webDashboardStatus: 'web-dashboard:status',
  webDashboardLocalIps: 'web-dashboard:local-ips',

  webDashboardAccessTokensList: 'web-dashboard-access-tokens:list',
  webDashboardAccessTokensCreate: 'web-dashboard-access-tokens:create',
  webDashboardAccessTokensUpdate: 'web-dashboard-access-tokens:update',
  webDashboardAccessTokensDelete: 'web-dashboard-access-tokens:delete',

  webDashboardApiKeysList: 'web-dashboard-api-keys:list',
  webDashboardApiKeysCreate: 'web-dashboard-api-keys:create',
  webDashboardApiKeysUpdate: 'web-dashboard-api-keys:update',
  webDashboardApiKeysDelete: 'web-dashboard-api-keys:delete',

  playerBansList: 'player-bans:list',
  playerBansBan: 'player-bans:ban',
  playerBansUnban: 'player-bans:unban',

  playerWhitelistList: 'player-whitelist:list',
  playerWhitelistAdd: 'player-whitelist:add',
  playerWhitelistRemove: 'player-whitelist:remove',

  playerRosterList: 'player-roster:list',
  playerRosterKick: 'player-roster:kick',

  watchedPlayersList: 'watched-players:list',
  watchedPlayersAdd: 'watched-players:add',
  watchedPlayersRemove: 'watched-players:remove',

  modEventsList: 'mod-events:list',
  modEventsSave: 'mod-events:save',
  modEventsDelete: 'mod-events:delete',
  modEventsHistoryList: 'mod-events:history-list',

  iniTemplatesGetGeneric: 'ini-templates:get-generic',
  iniTemplatesSaveGeneric: 'ini-templates:save-generic',
  iniTemplatesGetOverride: 'ini-templates:get-override',
  iniTemplatesSaveOverride: 'ini-templates:save-override',
  iniTemplatesDeleteOverride: 'ini-templates:delete-override',
  iniTemplatesApply: 'ini-templates:apply',
  iniTemplatesApplyAll: 'ini-templates:apply-all',
  iniTemplatesGeneratePending: 'ini-templates:generate-pending',
  iniTemplatesGetPendingStatus: 'ini-templates:get-pending-status',
  iniTemplatesConfirmPending: 'ini-templates:confirm-pending',
  iniTemplatesDiscardPending: 'ini-templates:discard-pending',

  playerActivityList: 'player-activity:list',
  playerActivitySessions: 'player-activity:sessions',

  fileBrowserList: 'file-browser:list',
  fileBrowserOpen: 'file-browser:open',
  fileBrowserDelete: 'file-browser:delete',
  fileBrowserReadIni: 'file-browser:read-ini',
  fileBrowserWriteIni: 'file-browser:write-ini',
  fileBrowserIniHistory: 'file-browser:ini-history',
  fileBrowserIniHistoryDiff: 'file-browser:ini-history-diff',
  fileBrowserIniRestore: 'file-browser:ini-restore',

  discordBotStatus: 'discord-bot:status',
  discordBotRestart: 'discord-bot:restart',
  discordBotStop: 'discord-bot:stop',

  appOpenProfilesFolder: 'app:open-profiles-folder',
  appOpenDataDirFolder: 'app:open-data-dir-folder',
  appFocusWindow: 'app:focus-window',
  appQuit: 'app:quit',
  appOpenDevTools: 'app:open-dev-tools',
  serverOpenConfigFolder: 'server:open-config-folder',
  serverOpenSavedArksFolder: 'server:open-savedarks-folder',
  serverOpenSaveGamesFolder: 'server:open-savegames-folder',

  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowMaximizedChanged: 'window:maximized-changed',

  mapManagementList: 'map-management:list',
  mapManagementCreate: 'map-management:create',
  mapManagementDelete: 'map-management:delete',
  mapManagementOpenFolder: 'map-management:open-folder',

  appUpdateGetVersion: 'app-update:get-version',
  appUpdateCheck: 'app-update:check',
  appUpdateInstall: 'app-update:install',
  appUpdateStatus: 'app-update:status',
  appUpdateStatusChanged: 'app-update:status-changed',

  appStartupStatus: 'app-startup:status',
  appStartupStatusChanged: 'app-startup:status-changed',

  groupConsoleSubscribe: 'group-console:subscribe',
  groupConsoleUnsubscribe: 'group-console:unsubscribe',
  groupConsoleEvent: 'group-console:event',
  groupConsoleRconSend: 'group-console:rcon-send',

  managerLogGet: 'manager-log:get',
  managerLogChanged: 'manager-log:changed',

  statsHistoryGet: 'stats-history:get',
  statsHistoryGetForGroup: 'stats-history:get-for-group',
  statsHistoryGetForGroups: 'stats-history:get-for-groups',

  minecraftProfilesList: 'minecraft-profiles:list',
  minecraftProfilesSave: 'minecraft-profiles:save',
  minecraftProfilesDelete: 'minecraft-profiles:delete',
  minecraftProfilesImport: 'minecraft-profiles:import',
  minecraftProfilesChanged: 'minecraft-profiles:changed',
  minecraftDetectLaunchable: 'minecraft:detect-launchable',
  minecraftOpenServerFolder: 'minecraft:open-server-folder',
  minecraftServerStart: 'minecraft-server:start',
  minecraftServerStop: 'minecraft-server:stop',
  minecraftServerKill: 'minecraft-server:kill',
  minecraftServerStatus: 'minecraft-server:status',
  minecraftServerStatusChanged: 'minecraft-server:status-changed',
  minecraftServerSendCommand: 'minecraft-server:send-command',
  minecraftConsoleBacklog: 'minecraft-console:backlog',
  minecraftConsoleLine: 'minecraft-console:line',
  minecraftPropertiesGet: 'minecraft-properties:get',
  minecraftPropertiesSave: 'minecraft-properties:save',

  minecraftBackupCreate: 'minecraft-backup:create',
  minecraftBackupList: 'minecraft-backup:list',
  minecraftBackupRestore: 'minecraft-backup:restore',
  minecraftBackupDelete: 'minecraft-backup:delete',
  minecraftBackupOpenFolder: 'minecraft-backup:open-folder',
  minecraftBackupCreated: 'minecraft-backup:created',
  minecraftBackupScheduleStatus: 'minecraft-backup:schedule-status',
  minecraftBackupLogGet: 'minecraft-backup:log-get',
  minecraftBackupLogChanged: 'minecraft-backup:log-changed',

  minecraftModsSearch: 'minecraft-mods:search',
  minecraftModsInstall: 'minecraft-mods:install',
  minecraftModsRemove: 'minecraft-mods:remove',
  minecraftModsSetEnabled: 'minecraft-mods:set-enabled',
  minecraftModsCheckUpdates: 'minecraft-mods:check-updates',
  minecraftModsUpdate: 'minecraft-mods:update',
  minecraftModsScan: 'minecraft-mods:scan',
  minecraftModsOpenFolder: 'minecraft-mods:open-folder',

  minecraftInstallListVersions: 'minecraft-install:list-versions',
  minecraftInstallListLoaderVersions: 'minecraft-install:list-loader-versions',
  minecraftInstallRun: 'minecraft-install:run',

  clusterExport: 'cluster:export',
  clusterImport: 'cluster:import',
  dialogSaveClusterBundleFile: 'dialog:save-cluster-bundle-file',
  dialogSelectClusterBundleFile: 'dialog:select-cluster-bundle-file',
  dialogSelectIniFile: 'dialog:select-ini-file',
  iniTemplatesReadFile: 'ini-templates:read-file'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface ImportResult {
  profile: ServerProfile
  profiles: ServerProfile[]
}

/** A whole-cluster backup file - every ARK and Minecraft profile plus the Manager's own
 *  settings, bundled into one JSON file (see src/main/lib/clusterExport.ts). Meant for
 *  migrating/restoring the Manager's own configuration, not the actual game server files
 *  (installDir still points at wherever those lived on the machine the backup was made on -
 *  same scope as the existing single-profile export/import, just for everything at once). */
export interface ClusterBundle {
  version: 1
  exportedAt: string
  profiles: ServerProfile[]
  minecraftProfiles: MinecraftProfile[]
  settings: AppSettings
}

export interface ClusterImportResult {
  profiles: ServerProfile[]
  minecraftProfiles: MinecraftProfile[]
  settings: AppSettings
  addedProfileCount: number
  addedMinecraftProfileCount: number
  settingsReplaced: boolean
}

/** A single classified, human-readable line parsed out of a server's ShooterGame.log. */
export interface LogEvent {
  /** Short uppercase category, e.g. "JOIN", "CHAT", "KILL" - drives the CSS class/color. */
  label: string
  /** Lowercase CSS class suffix (log-event-<cls>) matching `label`. */
  cls: string
  /** Human-readable, already-formatted display text. */
  text: string
  /** Local time the line was logged, "HH:MM:SS". */
  ts: string
}

/**
 * Invisible markers wrapping a player's name inside a JOIN/LEFT LogEvent's `text`, so the
 * UI can color just that portion (the rest of the line stays the default text color)
 * without having to guess where a name starts/ends. Shared between the parser (main) and
 * the renderers (the web dashboard page and the Cluster Data group console) that both need
 * to strip them back out while building the DOM. Never rendered as literal characters.
 */
export const PLAYER_NAME_OPEN = '\u0001'
export const PLAYER_NAME_CLOSE = '\u0002'

/** A LogEvent tagged with which server it came from - used by the Cluster Data group
 *  console, which merges the live feed of every server in a group into one chronological
 *  view. */
export interface GroupConsoleEvent extends LogEvent {
  /** The log line's date (ARK's own "YYYY.MM.DD" format). LogEvent.ts alone is HH:MM:SS -
   *  fine for ordering one server's own feed (it always arrives in order), but not enough
   *  to correctly merge multiple servers' backlogs, which can individually span more than
   *  a single day. */
  date: string
  profileId: string
  profileName: string
}

/**
 * One entry in the Manager's own activity log (src/main/lib/managerLog.ts) - what the
 * Manager itself did (Start/Stop/Kill/Restart, a scheduled restart, a backup), separate
 * from any one server's own ShooterGame.log or per-server SteamCMD update log. Every entry
 * belongs to a `taskId`: a single manual action (e.g. a plain Start) is a task with exactly
 * one entry, while a multi-step task (a scheduled restart's stop/update/start sequence, a
 * backup's save/zip sequence) reuses the same taskId across several entries so the Manager
 * Log view can group them under one `taskLabel` header instead of showing each step as an
 * unrelated line.
 */
export interface ManagerLogEntry {
  id: string
  /** The entry's date (ARK log style "YYYY.MM.DD") - same reasoning as GroupConsoleEvent's
   *  own `date` field: `ts` alone (HH:MM:SS) isn't enough to order entries spanning more
   *  than a day. */
  date: string
  ts: string
  taskId: string
  taskLabel: string
  message: string
  level: 'info' | 'error'
}

/**
 * One point of a server's (or a cluster group's summed) CPU/RAM/player history, as returned
 * by src/main/lib/statsHistory.ts. `time` is the point's own timestamp - for a query
 * spanning more history than the requested point budget, this is already downsampled
 * (bucketed and averaged/summed server-side), so the array is never larger than the
 * `maxPoints` the caller asked for regardless of how much raw history it's built from.
 */
export interface StatSample {
  time: number
  cpu: number
  memoryMB: number
  players: number
}

/** Official ARK:SA server status feed, parsed from its "<RichColor>" formatted line. */
export interface OfficialServerStatus {
  /** e.g. "ARK Official Server Network Status" */
  label: string
  /** e.g. "Online" */
  status: string
  /** e.g. "92.25" */
  version: string
  /** CSS rgb()/rgba() color converted from the feed's 0-1 float RichColor */
  color: string
}

/** One-time static machine info for the Dashboard's hardware stats bar - CPU model/core
 *  count, total RAM/module type, and the primary network interface's name/speed. Fetched
 *  once per Manager session and never re-polled (see src/main/lib/systemStats.ts's own doc
 *  comment for why: polling `systeminformation`'s *live* usage numbers every few seconds
 *  triggered antivirus false positives on Windows). The bar's actual "usage" numbers come
 *  from the managed ARK servers' own CPU/RAM instead, already available from their status. */
export interface SystemStaticInfo {
  cpuModel: string
  physicalCores: number | null
  logicalCores: number
  totalMemoryBytes: number
  memoryType: string | null
  memorySpeedMHz: number | null
  networkInterfaceLabel: string | null
  networkSpeedMbps: number | null
}

/** A live sample of the primary network interface's throughput, in bytes/sec each way -
 *  see src/main/lib/systemStats.ts's getNetworkUsage() doc comment for the background-query
 *  tradeoff this (re-)introduces. Null on the very first sample of a Manager session, since
 *  a rate needs two readings apart to compute - populated from the second poll onward. */
export interface NetworkUsage {
  rxBytesPerSec: number | null
  txBytesPerSec: number | null
}

/** The contextBridge API surface exposed by the preload script as `window.api`. */
export interface Api {
  profiles: {
    list: () => Promise<ServerProfile[]>
    save: (profile: ServerProfile) => Promise<ServerProfile[]>
    delete: (id: string) => Promise<ServerProfile[]>
    importFromInstall: (installDir: string) => Promise<ImportResult>
    reorder: (orderedIds: string[]) => Promise<ServerProfile[]>
    export: (profileId: string, filePath: string) => Promise<void>
    importFromFile: (filePath: string) => Promise<ImportResult>
    copy: (profileId: string, destInstallDir: string, newName: string) => Promise<ImportResult>
    move: (profileId: string, destInstallDir: string, newName: string) => Promise<ImportResult>
    /** Best-effort copy of GameUserSettings.ini/Game.ini from one profile's install into
     *  another's - the "Create New Server" wizard's "copy configuration from an existing
     *  server" path, run after the new profile's own fresh SteamCMD install finishes. */
    copyConfigFrom: (sourceProfileId: string, destProfileId: string) => Promise<void>
    /** Fires with the full, current profile list whenever it changes for any reason,
     *  including a save made through the web dashboard's HTTP API rather than this window's
     *  own IPC calls. */
    onChanged: (callback: (profiles: ServerProfile[]) => void) => () => void
  }
  dialog: {
    selectDirectory: () => Promise<string | null>
    selectFile: () => Promise<string | null>
    saveProfileFile: (defaultName: string) => Promise<string | null>
    selectProfileFile: () => Promise<string | null>
    saveClusterBundleFile: () => Promise<string | null>
    selectClusterBundleFile: () => Promise<string | null>
    selectIniFile: () => Promise<string | null>
  }
  cluster: {
    export: (filePath: string) => Promise<void>
    import: (filePath: string, options: { includeSettings: boolean }) => Promise<ClusterImportResult>
  }
  server: {
    start: (profileId: string) => Promise<ServerStatus>
    stop: (profileId: string) => Promise<ServerStatus>
    restart: (profileId: string) => Promise<ServerStatus>
    kill: (profileId: string) => Promise<ServerStatus>
    update: (profileId: string) => Promise<void>
    isInstalled: (profileId: string) => Promise<boolean>
    status: (profileId: string) => Promise<ServerStatus>
    onStatusChanged: (callback: (status: ServerStatus) => void) => () => void
    getInstalledBuildId: (profileId: string) => Promise<string | null>
    /** The human-readable game version (e.g. "92.28"), read from the running server's own
     *  console window title - Windows-only, and null until the server is running and that
     *  title has actually been set (a few seconds into startup). */
    getGameVersion: (profileId: string) => Promise<string | null>
    /** Computes the executable path and exact launch argument list for `profile` without
     *  starting it - what startServer would actually run, for a debug/preview display. Takes
     *  the profile directly (not a saved profileId) so it reflects unsaved edits too. */
    previewLaunchCommand: (profile: ServerProfile) => Promise<{ executable: string; args: string[] }>
  }
  mods: {
    save: (profileId: string, mods: ServerMod[]) => Promise<ServerProfile>
    /** Parses/validates a pasted mod list (the same JSON shape `JSON.stringify(mods, null,
     *  2)` produces) - shares the exact validation `mods:import-from-file` used to have, just
     *  reached from pasted text instead of a file. Throws with a readable message on
     *  malformed input rather than silently dropping bad entries. */
    parseText: (text: string) => Promise<ServerMod[]>
    /** ARK: Survival Evolved only - reads GameUserSettings.ini's ActiveMods= and adds any mod
     *  id found there that isn't already in the profile's mods list yet, as a new enabled
     *  entry (never removes or disables an existing one - additive only, so a mod the
     *  Manager already knows about but currently has disabled, which is why it's correctly
     *  absent from ActiveMods=, is never touched). A no-op, returning the profile unchanged,
     *  for ARK: Survival Ascended or when there's nothing new to add. */
    reconcileFromIni: (profileId: string) => Promise<ServerProfile>
  }
  arkMods: {
    /** Searches CurseForge for ARK: Survival Ascended mods by name - empty results (not an
     *  error) when no CurseForge API key is configured, same "best effort" shape as the
     *  Minecraft Mods tab's own search. ARK: Survival Evolved isn't supported - don't call
     *  this for an Evolved profile. */
    search: (query: string) => Promise<ArkModSearchResult[]>
    /** Batch look-up, keyed by id, for every id actually present on CurseForge - used to show
     *  a real name/icon next to mod ids already in a profile's list (typed by hand, or added
     *  before this feature existed), not just ones added via search above. */
    info: (modIds: string[]) => Promise<ArkModInfoMap>
  }
  backup: {
    create: (profileId: string) => Promise<BackupEntry>
    list: (profileId: string) => Promise<BackupEntry[]>
    delete: (filePath: string) => Promise<void>
    restore: (profileId: string, filePath: string) => Promise<void>
    openFolder: (profileId: string) => Promise<void>
    onCreated: (callback: (profileId: string) => void) => () => void
    getScheduleStatus: (profileId: string) => Promise<BackupScheduleStatus>
    getLog: (profileId: string) => Promise<BackupLogEntry[]>
    onLogChanged: (callback: (profileId: string, entry: BackupLogEntry) => void) => () => void
  }
  playerBackup: {
    listFolders: (profileId: string) => Promise<PlayerBackupFolder[]>
    list: (profileId: string, folderKey: string) => Promise<BackupEntry[]>
    openFolder: (profileId: string, folderKey: string) => Promise<void>
  }
  settings: {
    get: () => Promise<AppSettings>
    save: (settings: AppSettings) => Promise<AppSettings>
  }
  steamcmd: {
    install: () => Promise<string>
    managedStatus: () => Promise<string | null>
    getUpdateLog: (profileId: string) => Promise<string | null>
    onUpdateLogChanged: (callback: (profileId: string) => void) => () => void
    addFirewallRule: (steamCmdPath: string) => Promise<void>
    getLatestBuildId: (game: GameId, branch?: string) => Promise<LatestBuildIdCache>
  }
  maps: {
    list: (game: GameId) => Promise<MapDefinition[]>
  }
  customMaps: {
    list: () => Promise<MapDefinition[]>
    /** Each returns the full, updated custom maps list - same "server hands back fresh
     *  state" pattern as profiles.save/delete. Throws (shown as an error message by the
     *  caller) on a blank id/name or an id collision. */
    add: (entry: { id: string; displayName: string; modId?: string }) => Promise<MapDefinition[]>
    update: (originalId: string, entry: { id: string; displayName: string; modId?: string }) => Promise<MapDefinition[]>
    delete: (id: string) => Promise<MapDefinition[]>
  }
  dataDir: {
    getDefault: () => Promise<string>
  }
  officialServerStatus: {
    get: () => Promise<OfficialServerStatus>
  }
  systemStats: {
    get: () => Promise<SystemStaticInfo>
    /** Polled on an interval by the Dashboard's hardware stats bar - deliberately not as
     *  frequent as the CPU/RAM numbers (which are free, already-pushed data), since each
     *  call here does spawn a background OS query. See getNetworkUsage()'s doc comment. */
    getNetworkUsage: () => Promise<NetworkUsage>
  }
  webDashboard: {
    getStatus: () => Promise<{ running: boolean; error: string | null; host: string | null }>
    getLocalIps: () => Promise<string[]>
  }
  webDashboardAccessTokens: {
    list: () => Promise<WebDashboardAccessTokenSummary[]>
    create: (
      label: string,
      role: WebDashboardRole,
      profileIds: string[] | null
    ) => Promise<{ token: string; tokens: WebDashboardAccessTokenSummary[] }>
    /** Changes an existing token's role/label/server scope in place - the token's own
     *  secret (and so the value already pasted into a browser) is untouched, so this never
     *  logs anyone out the way delete-and-recreate would. */
    update: (
      id: string,
      updates: { label?: string; role?: WebDashboardRole; profileIds?: string[] | null }
    ) => Promise<WebDashboardAccessTokenSummary[]>
    delete: (id: string) => Promise<WebDashboardAccessTokenSummary[]>
  }
  webDashboardApiKeys: {
    list: () => Promise<WebDashboardApiKeySummary[]>
    /** Resolves with the full plaintext key, shown to the user exactly once - only its
     *  hash is ever stored, so it can't be retrieved again after this. */
    create: (label: string, role: WebDashboardRole) => Promise<{ key: string; keys: WebDashboardApiKeySummary[] }>
    /** Same idea as webDashboardAccessTokens.update - changes role/label without touching
     *  the key's own secret. */
    update: (id: string, updates: { label?: string; role?: WebDashboardRole }) => Promise<WebDashboardApiKeySummary[]>
    delete: (id: string) => Promise<WebDashboardApiKeySummary[]>
  }
  playerBans: {
    list: () => Promise<BannedPlayer[]>
    /** Sends BanPlayer over RCON to the given profile, then records/extends the
     *  centralized entry for this id (creating one if this is the first time it's been
     *  banned anywhere). Throws (rather than updating the list) if the RCON command itself
     *  failed, same as every other sendRconCommand-backed action in the app. */
    ban: (profileId: string, playerId: string, playerName: string, reason: string) => Promise<BannedPlayer[]>
    /** Sends UnbanPlayer over RCON to the given profile, then removes that profile from the
     *  entry (dropping the entry entirely once no profile is left). */
    unban: (profileId: string, playerId: string) => Promise<BannedPlayer[]>
  }
  /** Tracking-only, unlike playerBans - see WhitelistedPlayer's own doc comment for why
   *  add/remove here never touch RCON at all. */
  playerWhitelist: {
    list: () => Promise<WhitelistedPlayer[]>
    add: (profileId: string, playerId: string, playerName: string) => Promise<WhitelistedPlayer[]>
    remove: (profileId: string, playerId: string) => Promise<WhitelistedPlayer[]>
  }
  /** One server's own live connected-player list, straight from RCON ListPlayers - distinct
   *  from playerBans/playerActivity, which are the Manager's own persisted, cross-server
   *  records. Desktop mirror of the web dashboard's own players route/context menu. */
  playerRoster: {
    list: (profileId: string) => Promise<PlayerRosterEntry[]>
    /** Sends KickPlayer over RCON - nothing persisted, the player can simply reconnect. */
    kick: (profileId: string, playerId: string) => Promise<void>
  }
  watchedPlayers: {
    list: () => Promise<WatchedPlayerAlert[]>
    add: (value: string, label: string) => Promise<WatchedPlayerAlert[]>
    remove: (id: string) => Promise<WatchedPlayerAlert[]>
  }
  playerActivity: {
    list: () => Promise<PlayerActivityRecord[]>
    /** Most recent sessions first, capped (see recordPlayerSession in store.ts). */
    sessions: () => Promise<PlayerActivitySession[]>
  }
  /** Event Scheduler (Tools menu, ARK only) - see ModEvent's own doc comment. */
  modEvents: {
    list: () => Promise<ModEvent[]>
    /** Upserts by id - an id not already in the list is a new event. Re-arms that event's
     *  schedule immediately (see src/main/lib/modEvents.ts), so an edit to an already-armed
     *  event takes effect without restarting the Manager. */
    save: (event: ModEvent) => Promise<ModEvent[]>
    delete: (id: string) => Promise<ModEvent[]>
    /** Most recent firings first. */
    history: () => Promise<ModEventHistoryEntry[]>
  }
  /** INI Templates (Tools menu, ARK only) - see IniTemplateContent's own doc comment. */
  iniTemplates: {
    getGeneric: () => Promise<IniTemplateContent>
    saveGeneric: (content: IniTemplateContent) => Promise<IniTemplateContent>
    getOverride: (profileId: string) => Promise<IniTemplateProfileOverride | null>
    /** Saving blank text for both files and a blank sessionName is treated as "no override" -
     *  deletes it rather than keeping an empty record around, same as
     *  saveWebDashboardAccessToken's siblings don't store a token with nothing meaningful
     *  left in it. */
    saveOverride: (override: IniTemplateProfileOverride) => Promise<IniTemplateProfileOverride[]>
    deleteOverride: (profileId: string) => Promise<IniTemplateProfileOverride[]>
    /** Applies the generic template plus this one profile's own override - rejects with a
     *  readable error (e.g. the config dir is locked while the server's running) on failure. */
    apply: (profileId: string) => Promise<void>
    /** Same, for every ARK profile at once - never rejects itself; each profile's own
     *  success/failure is reported in the returned array instead. Deliberately still a direct
     *  write, skipping the generate/confirm staging below - see applyIniTemplateToAll's own
     *  doc comment for why. */
    applyAll: () => Promise<IniTemplateApplyResult[]>
    /** Reads back an existing .ini file's raw text, picked via dialog.selectIniFile - lets
     *  a template/override textarea be filled from a file the user already has on disk
     *  instead of retyping it. Rejects with a readable error if the file can't be read. */
    readFile: (filePath: string) => Promise<string>
    /** Stages the generic template plus this profile's own override into `*.pending.ini` files
     *  next to its real GameUserSettings.ini/Game.ini, without touching the real files yet -
     *  open the returned path(s) with fileBrowser.open to hand-check or tweak the merged
     *  result before calling confirmPending. Rejects with a readable error on a staging write
     *  failure, same cases apply() itself can fail on. */
    generatePending: (profileId: string) => Promise<IniTemplatePendingResult>
    /** Whatever's currently staged for this profile, or null if nothing is - lets the view
     *  restore "pending, ready to confirm" after navigating away and back without re-staging. */
    getPendingStatus: (profileId: string) => Promise<IniTemplatePendingResult | null>
    /** Replaces the real GameUserSettings.ini/Game.ini with their staged `*.pending.ini`
     *  content verbatim (hand-edits included) and removes the pending files. Rejects if
     *  nothing was staged (generatePending wasn't called, or was already confirmed/discarded). */
    confirmPending: (profileId: string) => Promise<void>
    /** Discards whatever's staged for this profile without touching its real config files -
     *  a no-op if nothing was staged. */
    discardPending: (profileId: string) => Promise<void>
  }
  /** Desktop mirror of the web dashboard's own Files tab - same underlying logic
   *  (src/main/lib/fileBrowser.ts), exposed over IPC instead of HTTP. Every call can reject;
   *  the renderer catches it like any other IPC call here, there's no {ok, error} wrapper the
   *  way the HTTP routes need for a response body. */
  fileBrowser: {
    list: (profileId: string, relativePath: string) => Promise<FileBrowserListing>
    /** Opens the file with its OS-associated app (Electron's shell.openPath) - the desktop
     *  equivalent of the web dashboard's "Download" link, since there's no browser to
     *  download through and the file's already right there on disk. */
    open: (profileId: string, relativePath: string) => Promise<void>
    delete: (profileId: string, relativePath: string) => Promise<void>
    readIni: (profileId: string, relativePath: string) => Promise<string>
    writeIni: (profileId: string, relativePath: string, content: string) => Promise<void>
    iniHistory: (profileId: string, relativePath: string) => Promise<ConfigFileHistorySummary[]>
    iniHistoryDiff: (profileId: string, entryId: string) => Promise<DiffLine[]>
    iniRestore: (profileId: string, entryId: string) => Promise<void>
  }
  discordBot: {
    status: () => Promise<{ running: boolean; error: string | null }>
    /** Re-applies the current settings - picks up a config change without needing to
     *  re-save Settings, and recovers after a crash shown in the Manager Log. */
    restart: () => Promise<{ running: boolean; error: string | null }>
    /** Stops the bot process immediately without touching the Enabled checkbox - the next
     *  Settings save (or Manager restart) respawns it if that checkbox is still on. */
    stop: () => Promise<{ running: boolean; error: string | null }>
  }
  system: {
    openProfilesFolder: () => Promise<void>
    openDataDirFolder: () => Promise<void>
    openServerConfigFolder: (profileId: string) => Promise<void>
    openServerSavedArksFolder: (profileId: string) => Promise<void>
    openServerSaveGamesFolder: (profileId: string) => Promise<void>
    /** Explicitly re-focuses the main window - a workaround for Electron/Windows sometimes
     *  not returning OS-level keyboard focus to the renderer after a native modal closes
     *  (window.confirm() is one; the file/folder pickers in dialog.ts already call this on
     *  the main-process side directly). See confirmAction() in the renderer. */
    focusWindow: () => Promise<void>
    /** File > Quit in the custom title bar - same as the tray's own "Quit", a real app.quit()
     *  rather than the window's close-to-tray behavior. */
    quit: () => Promise<void>
    /** Toggles the renderer's DevTools - the custom title bar replaces Electron's own
     *  application menu entirely, which also takes the default F12/Ctrl+Shift+I DevTools
     *  accelerator with it (main/index.ts re-adds the shortcut directly; this is the
     *  menu-driven way to get there, for diagnosing a rendering bug only visible from the
     *  renderer's own console). */
    openDevTools: () => Promise<void>
  }
  /** The custom title bar's own minimize/maximize/close, now that the window runs frameless
   *  (frame: false) to draw a themed bar instead of the OS one. */
  windowControls: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<void>
    /** Same as the old native title bar's close button - still goes through the window's
     *  'close' handler, so close-to-tray (Settings > Startup & Safety) still applies. */
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    onMaximizedChange: (callback: (maximized: boolean) => void) => () => void
  }
  mapManagement: {
    list: (profileId: string) => Promise<MapFolderEntry[]>
    create: (profileId: string, folderName: string, fileName: string) => Promise<void>
    delete: (profileId: string, folderName: string) => Promise<void>
    openFolder: (profileId: string, folderName: string) => Promise<void>
  }
  appUpdate: {
    getVersion: () => Promise<string>
    check: () => Promise<void>
    install: () => Promise<void>
    getStatus: () => Promise<AppUpdateStatus>
    onStatusChanged: (callback: (status: AppUpdateStatus) => void) => () => void
  }
  /** Whether main/index.ts's own app.whenReady() startup sequence (re-attaching to
   *  already-running servers, starting the Web Dashboard, arming the Event Scheduler, ...)
   *  has fully finished - distinct from whether the renderer's own first profiles/settings
   *  IPC calls have resolved, which can happen earlier now that sequence yields between
   *  steps instead of blocking start to finish. The renderer's loading screen waits on this
   *  too, so it covers the whole startup instead of disappearing early. */
  appStartup: {
    isComplete: () => Promise<boolean>
    onComplete: (callback: () => void) => () => void
  }
  groupConsole: {
    /** Starts tailing every given profile's log and resolves with its current backlog
     *  (merged across all of them, sorted by timestamp) - replaces whatever subscription
     *  was previously active, if any. */
    subscribe: (profileIds: string[]) => Promise<GroupConsoleEvent[]>
    /** Stops the active subscription's tailers. Safe to call with nothing subscribed. */
    unsubscribe: () => Promise<void>
    onEvent: (callback: (event: GroupConsoleEvent) => void) => () => void
    /** Sends an RCON command to one server in the group - never rejects, the result's
     *  `ok`/`error` says whether it actually succeeded. */
    sendRcon: (profileId: string, command: string) => Promise<RconResult>
  }
  managerLog: {
    getLog: () => Promise<ManagerLogEntry[]>
    onLogChanged: (callback: (entry: ManagerLogEntry) => void) => () => void
  }
  statsHistory: {
    /** `sinceMs: null` means "since the earliest recorded sample" (the "All" time scale). */
    get: (profileId: string, sinceMs: number | null, maxPoints?: number) => Promise<StatSample[]>
    getForGroup: (profileIds: string[], sinceMs: number | null, maxPoints?: number) => Promise<StatSample[]>
    /** Same as getForGroup, but for every dashboard group in one call - reads and parses
     *  the shared stats-history file once for all of them instead of once per group. Keyed
     *  by the same group name (trimmed ServerProfile.group, '' for ungrouped) passed in. */
    getForGroups: (
      groupProfileIds: Record<string, string[]>,
      sinceMs: number | null,
      maxPoints?: number
    ) => Promise<Record<string, StatSample[]>>
  }
  minecraft: {
    profiles: {
      list: () => Promise<MinecraftProfile[]>
      save: (profile: MinecraftProfile) => Promise<MinecraftProfile[]>
      delete: (id: string) => Promise<MinecraftProfile[]>
      /** Points at an existing, already-set-up Minecraft server folder and returns a
       *  best-effort profile detected from it (see minecraftDetect.ts) - not yet saved,
       *  the same "review before it's real" pattern as ServerProfile's own import. */
      importFromInstall: (installDir: string) => Promise<MinecraftProfile>
      onChanged: (callback: (profiles: MinecraftProfile[]) => void) => () => void
    }
    /** Re-detects the launchable jar/script (and server type guess) in installDir - used by
     *  the Settings tab's "Re-detect" button after the user changes files on disk outside
     *  the Manager. */
    detectLaunchable: (installDir: string) => Promise<{
      launchMode: MinecraftProfile['launchMode']
      jarFileName: string
      scriptFileName: string
      serverType: MinecraftProfile['serverType']
    } | null>
    /** Opens the server's own install directory (jar/script, world, mods/plugins,
     *  server.properties) in the OS file explorer. */
    openServerFolder: (profileId: string) => Promise<void>
    server: {
      start: (profileId: string) => Promise<MinecraftServerStatus>
      stop: (profileId: string) => Promise<MinecraftServerStatus>
      kill: (profileId: string) => Promise<MinecraftServerStatus>
      getStatus: (profileId: string) => Promise<MinecraftServerStatus>
      onStatusChanged: (callback: (status: MinecraftServerStatus) => void) => () => void
      /** Writes straight to the running process's stdin, falling back to RCON (if enabled)
       *  when there's no live stdin - a server re-adopted from a previous Manager session
       *  (see adoptPersistedMinecraftProcesses) has none. Never rejects, the result's
       *  `ok`/`error` says whether it actually succeeded. */
      sendCommand: (profileId: string, command: string) => Promise<RconResult>
    }
    console: {
      getBacklog: (profileId: string) => Promise<MinecraftConsoleLine[]>
      onLine: (callback: (profileId: string, line: MinecraftConsoleLine) => void) => () => void
    }
    /** The Server Settings tab's editor for server.properties itself - separate from the
     *  `profiles` CRUD above, since these fields live in a file MinecraftProfile
     *  deliberately doesn't duplicate (see minecraftProperties.ts). */
    properties: {
      get: (profileId: string) => Promise<MinecraftPropertiesData>
      /** Merges `updates` into server.properties (existing lines' values are replaced in
       *  place, a key with no existing line is appended) and returns the file's full,
       *  freshly-read contents afterward. */
      save: (profileId: string, updates: MinecraftPropertiesData) => Promise<MinecraftPropertiesData>
    }
    /** World backups - same shape as the top-level `backup` API, but zips the world's
     *  dimension folders (see minecraftBackup.ts's worldDirs) instead of ARK's SavedArks. */
    backup: {
      create: (profileId: string) => Promise<BackupEntry>
      list: (profileId: string) => Promise<BackupEntry[]>
      delete: (filePath: string) => Promise<void>
      restore: (profileId: string, filePath: string) => Promise<void>
      openFolder: (profileId: string) => Promise<void>
      onCreated: (callback: (profileId: string) => void) => () => void
      getScheduleStatus: (profileId: string) => Promise<BackupScheduleStatus>
      getLog: (profileId: string) => Promise<BackupLogEntry[]>
      onLogChanged: (callback: (profileId: string, entry: BackupLogEntry) => void) => () => void
    }
    /** Mod/plugin browsing and installation (Modrinth and CurseForge - see
     *  shared/minecraftMods.ts; CurseForge results/installs only happen once
     *  AppSettings.curseforgeApiKey is set). `profile.installedMods` is the source of truth
     *  for what's installed; every call here returns the updated profile so the caller can
     *  just pass it to onProfileChange instead of re-fetching the whole profile list. */
    mods: {
      /** Searches Modrinth, plus CurseForge too if an API key is configured - results from
       *  both are merged and sorted by downloads, each tagged with its own `source`.
       *  `ecosystem` picks which of the server's own Mods/Plugins tabs this search is for -
       *  see minecraftServerSupportsEcosystem in shared/minecraftMods.ts; rejected if this
       *  server type doesn't actually have that ecosystem. */
      search: (profileId: string, query: string, ecosystem: MinecraftModEcosystem) => Promise<MinecraftModSearchResult[]>
      install: (
        profileId: string,
        source: MinecraftModSource,
        projectId: string,
        ecosystem: MinecraftModEcosystem
      ) => Promise<{ profile: MinecraftProfile; result: MinecraftModInstallResult }>
      remove: (profileId: string, projectId: string) => Promise<MinecraftProfile>
      setEnabled: (profileId: string, projectId: string, enabled: boolean) => Promise<MinecraftProfile>
      checkUpdates: (profileId: string) => Promise<MinecraftModUpdateCheckResult[]>
      update: (
        profileId: string,
        source: MinecraftModSource,
        projectId: string
      ) => Promise<{ profile: MinecraftProfile; result: MinecraftModInstallResult }>
      /** Recognizes mods/plugins already sitting in the folder that weren't installed
       *  through this tab - see minecraftMods.ts's scanForInstalledMods. */
      scan: (profileId: string) => Promise<{ profile: MinecraftProfile; result: MinecraftModScanResult }>
      /** Opens the mods/plugins folder (mods/ or plugins/, depending on server type) in the
       *  OS file explorer. */
      openFolder: (profileId: string) => Promise<void>
    }
    /** Fetches/builds the right server files for a brand-new server (vanilla/Paper/Fabric
     *  download a prebuilt jar; Forge downloads and runs its own installer; Spigot downloads
     *  and runs BuildTools, which compiles it locally per Spigot's own license terms) - the
     *  "+ Add server" flow's alternative to "Import existing server" for a folder that has
     *  nothing in it yet. Doesn't create or save a MinecraftProfile itself; the caller does
     *  that with the returned launchMode/jarFileName/scriptFileName/minecraftVersion/
     *  serverType, same "caller saves" pattern as profiles.importFromInstall. */
    install: {
      listVersions: (serverType: MinecraftInstallableType) => Promise<MinecraftVersionOption[]>
      /** Loader/build-version options for the second selector, once a Minecraft version has
       *  been picked in the first - empty for vanilla/Spigot (see
       *  supportsLoaderVersionSelection in shared/minecraftInstall.ts). */
      listLoaderVersions: (serverType: MinecraftInstallableType, minecraftVersion: string) => Promise<MinecraftVersionOption[]>
      run: (params: MinecraftInstallParams) => Promise<MinecraftInstallResult>
    }
  }
}
