import type { MinecraftServerType } from '@shared/minecraft'
import type { MinecraftModEcosystem } from '@shared/minecraftMods'

/**
 * Thin wrapper around Modrinth's public v2 REST API (https://docs.modrinth.com) - no API key
 * required, unlike CurseForge (a planned follow-up, not implemented yet - see
 * shared/minecraftMods.ts). Deliberately returns Modrinth's own raw shapes (snake_case field
 * names and all) rather than normalizing here - minecraftMods.ts is the one place that
 * converts into this app's own MinecraftModSearchResult/InstalledMinecraftMod shapes, so a
 * second source (CurseForge) only means adding its own client module plus a branch there,
 * never touching this file.
 */

const API_BASE = 'https://api.modrinth.com/v2'

/** Modrinth asks API consumers to identify themselves via User-Agent - see
 *  https://docs.modrinth.com/api/ (rate-limiting/etiquette section). */
const USER_AGENT = 'RaptorSauvage/bober-server-manager (Bober Server Manager; github.com/RaptorSauvage/bober-server-manager)'

export interface ModrinthSearchHit {
  project_id: string
  slug: string
  title: string
  description: string
  icon_url: string | null
  downloads: number
  client_side: string
  server_side: string
}

interface ModrinthSearchResponse {
  hits: ModrinthSearchHit[]
  offset: number
  limit: number
  total_hits: number
}

export interface ModrinthVersionFile {
  hashes: Record<string, string>
  url: string
  filename: string
  primary: boolean
  size: number
}

export type ModrinthDependencyType = 'required' | 'optional' | 'incompatible' | 'embedded'

export interface ModrinthDependency {
  version_id: string | null
  project_id: string | null
  file_name: string | null
  dependency_type: ModrinthDependencyType
}

export interface ModrinthVersion {
  id: string
  project_id: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  version_type: 'release' | 'beta' | 'alpha'
  date_published: string
  files: ModrinthVersionFile[]
  dependencies: ModrinthDependency[]
}

export interface ModrinthProject {
  id: string
  slug: string
  title: string
  description: string
  icon_url: string | null
  client_side: string
  server_side: string
}

/**
 * Maps a (server type, ecosystem) pair to the Modrinth "category" facet value(s) that
 * identify a mod/plugin's loader - the v2 API lumps loaders into the same `categories` facet
 * type as everything else (confirmed against Modrinth's own search result model, which
 * extends `categories` with `loaders` for v2 responses). Paper and Spigot share one facet
 * group since Paper plugins are themselves Spigot/Bukkit-API-compatible and most plugin
 * authors tag for all three interchangeably - splitting them would just hide results that do
 * work.
 *
 * `ecosystem` matters for SpongeForge specifically - the one server type with two real,
 * independently-searchable ecosystems at once (see minecraftServerSupportsEcosystem):
 * `ecosystem: 'plugins'` searches its own Sponge plugin layer (`sponge` category, same as
 * SpongeVanilla), `ecosystem: 'mods'` searches the Forge-mod layer it actually runs on top of
 * (plain `forge`). For every other type, `ecosystem` is redundant with `serverType` alone
 * (there's only ever one to ask for) - callers always have a concrete value either way, from
 * minecraftModEcosystem/minecraftServerSupportsEcosystem.
 *
 * Vanilla and unknown have no mod/plugin ecosystem at all - callers should never reach this
 * for those (minecraftMods.ts guards it before ever calling into this client), but an empty
 * array here means "no loader facet" rather than silently matching everything.
 */
export function loaderCategoriesFor(serverType: MinecraftServerType, ecosystem: MinecraftModEcosystem): string[] {
  if (ecosystem === 'plugins') {
    if (serverType === 'paper' || serverType === 'spigot') return ['paper', 'spigot', 'bukkit']
    // SpongeVanilla and SpongeForge share one category - SpongeAPI plugins are
    // implementation-agnostic, a plugin tagged 'sponge' runs on either.
    if (serverType === 'spongevanilla' || serverType === 'spongeforge') return ['sponge']
    return []
  }
  // ecosystem === 'mods'
  switch (serverType) {
    case 'fabric':
      return ['fabric']
    case 'forge':
      return ['forge']
    case 'neoforge':
      return ['neoforge']
    case 'spongeforge':
      return ['forge']
    default:
      return []
  }
}

/**
 * Builds the `facets` search param - a JSON array of arrays, where entries within one inner
 * array are OR'd together and the outer arrays are AND'd (confirmed against Modrinth's own
 * facet-parsing code: outer = AND, inner = OR).
 *
 * Bug fix: this used to filter to `project_type:mod` only, on the (wrong) assumption that v2's
 * API flattened "plugin"/"datapack" into "mod" with no separate project type to filter by at
 * all. In reality, Modrinth's real data model (confirmed against their own labrinth/knossos
 * source) has always kept `plugin` as its own, genuinely distinct project_type - Bukkit/
 * Spigot/Paper/Sponge content is tagged `plugin`, not `mod`. v2's response *serializer*
 * rewrites that field to the string "mod" in what it hands back to the client (so an already-
 * fetched hit/version never shows "plugin" as its type), but that rewrite is purely cosmetic
 * on the way out - it is NOT applied to search filtering, so a `facets` query still filtering
 * on literal `project_type:mod` was silently excluding every real plugin from every search for
 * a Paper/Spigot/Sponge server - the Plugins tab was, in effect, only ever able to find mods.
 * Fixed by OR'ing both real project types in the same facet group, the same way Modrinth's own
 * frontend does when it wants to cover more than one content type at once.
 *
 * The `server_side` facet is the one piece of filtering the user explicitly asked for:
 * excludes anything that does nothing on a dedicated server (a pure client-side content/UI
 * mod reports `server_side: "unsupported"`) - kept in the search query itself rather than
 * filtered after the fact, so pagination/limit counts stay meaningful.
 */
export function buildModrinthFacets(serverType: MinecraftServerType, minecraftVersion: string, ecosystem: MinecraftModEcosystem): string {
  const facets: string[][] = [
    ['project_type:mod', 'project_type:plugin'],
    ['server_side:required', 'server_side:optional']
  ]
  const loaderCategories = loaderCategoriesFor(serverType, ecosystem)
  if (loaderCategories.length > 0) facets.push(loaderCategories.map((c) => `categories:${c}`))
  if (minecraftVersion.trim()) facets.push([`versions:${minecraftVersion.trim()}`])
  return JSON.stringify(facets)
}

const MAX_RATE_LIMIT_RETRIES = 3

/** Modrinth's rate limit (300 req/min per IP) is easy to hit when scanning several servers'
 *  mods/plugins folders back to back - each used to cost its own per-project request too (see
 *  getModrinthProjects below). Rather than hard-failing on a transient 429, wait out the
 *  `Retry-After` the server asks for (falling back to a short exponential backoff if it didn't
 *  send one) and try again a few times before giving up for real. */
async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('Retry-After'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
  return 1000 * 2 ** attempt
}

async function fetchWithRateLimitRetry(url: string | URL, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const response = await fetch(url, init)
    if (response.status !== 429 || attempt === MAX_RATE_LIMIT_RETRIES) return response
    await wait(retryDelayMs(response, attempt))
  }
  // Unreachable - the loop above always returns by its last iteration.
  throw new Error(`Modrinth request failed: ${label}`)
}

async function modrinthFetch<T>(path: string, searchParams: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE}${path}`)
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value)
  const response = await fetchWithRateLimitRetry(url, { headers: { 'User-Agent': USER_AGENT } }, path)
  if (!response.ok) {
    throw new Error(`Modrinth request failed (HTTP ${response.status}): ${path}`)
  }
  return (await response.json()) as T
}

export async function searchModrinthProjects(
  query: string,
  serverType: MinecraftServerType,
  minecraftVersion: string,
  ecosystem: MinecraftModEcosystem,
  limit = 20
): Promise<ModrinthSearchHit[]> {
  const response = await modrinthFetch<ModrinthSearchResponse>('/search', {
    query,
    facets: buildModrinthFacets(serverType, minecraftVersion, ecosystem),
    limit: String(limit)
  })
  return response.hits
}

/** Compatible versions for one project, newest first (Modrinth's own default ordering) -
 *  `[0]` is "the latest compatible version" wherever this app needs just that. */
export async function getModrinthProjectVersions(
  projectId: string,
  serverType: MinecraftServerType,
  minecraftVersion: string,
  ecosystem: MinecraftModEcosystem
): Promise<ModrinthVersion[]> {
  const params: Record<string, string> = {}
  const loaderCategories = loaderCategoriesFor(serverType, ecosystem)
  if (loaderCategories.length > 0) params.loaders = JSON.stringify(loaderCategories)
  if (minecraftVersion.trim()) params.game_versions = JSON.stringify([minecraftVersion.trim()])
  return modrinthFetch<ModrinthVersion[]>(`/project/${encodeURIComponent(projectId)}/version`, params)
}

export async function getModrinthVersion(versionId: string): Promise<ModrinthVersion> {
  return modrinthFetch<ModrinthVersion>(`/version/${encodeURIComponent(versionId)}`, {})
}

export async function getModrinthProject(projectId: string): Promise<ModrinthProject> {
  return modrinthFetch<ModrinthProject>(`/project/${encodeURIComponent(projectId)}`, {})
}

/** Same data as getModrinthProject, but for many projects in one request - the batch
 *  counterpart that keeps scanForInstalledMods from costing one `/project/{id}` call per
 *  adopted mod (easy to hit Modrinth's rate limit with a folder full of them). Returns `[]`
 *  up front for an empty list, same reasoning as getModrinthVersionsFromHashes below. */
export async function getModrinthProjects(projectIds: string[]): Promise<ModrinthProject[]> {
  if (projectIds.length === 0) return []
  return modrinthFetch<ModrinthProject[]>('/projects', { ids: JSON.stringify(projectIds) })
}

/**
 * Identifies files already sitting in a server's mods/plugins folder (installed by hand,
 * outside this app, or before this feature existed) by file hash - the same mechanism
 * Modrinth's own official app/launchers use to recognize an existing install. Confirmed
 * against Modrinth's backend source directly (`POST /v2/version_files`, body
 * `{ algorithm, hashes }`, response keyed by the hash each caller supplied) rather than just
 * third-party docs. Returns an empty object up front for an empty `hashes` list - the real
 * endpoint would just 200 with `{}` too, but this skips the round trip entirely for the
 * common case of nothing new to identify.
 */
export async function getModrinthVersionsFromHashes(
  hashes: string[],
  algorithm: 'sha1' | 'sha512' = 'sha1'
): Promise<Record<string, ModrinthVersion>> {
  if (hashes.length === 0) return {}
  const response = await fetchWithRateLimitRetry(
    `${API_BASE}/version_files`,
    {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ algorithm, hashes })
    },
    '/version_files'
  )
  if (!response.ok) {
    throw new Error(`Modrinth request failed (HTTP ${response.status}): /version_files`)
  }
  return (await response.json()) as Record<string, ModrinthVersion>
}
