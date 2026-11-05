/**
 * Thin wrappers around the public, no-API-key APIs each Minecraft server flavor's files are
 * published through - same "return the source's own shape, let the caller normalize" split as
 * modrinthClient.ts/curseforgeClient.ts. Picked for being the official or de-facto-standard
 * distribution channel for each loader:
 *  - vanilla: Mojang's own version manifest (https://minecraft.wiki/w/Version_manifest.json)
 *  - paper: PaperMC's own "Fill" v3 API (https://fill.papermc.io/v3 - see its own section
 *    below for why; the older v2 API at api.papermc.io is permanently gone, see the top-of-
 *    file history note)
 *  - fabric: FabricMC's own meta API (https://fabricmc.net/wiki/documentation:fabric_meta)
 *  - forge: Forge's own Maven (no JSON API for the version list - maven-metadata.xml is the
 *    only machine-readable listing Forge publishes; "recommended"/"latest" per Minecraft
 *    version, though, IS a real documented endpoint - promotions_slim.json, see below)
 *  - neoforge: NeoForge's own Maven, same shape as Forge's - except its metadata lists plain
 *    build versions with no Minecraft version combined into the string (see
 *    neoForgeVersionToMinecraftVersion below for how the two relate), and there's no
 *    promotions-file equivalent marking one build "recommended"
 *  - spigot: no download API at all - Spigot's own license terms require building it
 *    yourself from Mojang's mappings via BuildTools.jar (https://www.spigotmc.org/wiki/buildtools/),
 *    so installMinecraftServerFiles (minecraftInstall.ts) runs that instead of downloading a
 *    prebuilt jar.
 *  - spongevanilla / spongeforge: SpongePowered's own dedicated downloads API looks dead (its
 *    Vue frontend repo is archived, and its backend's documented production host doesn't
 *    resolve at all) - using their Maven repo directly instead (repo.spongepowered.org),
 *    the same maven-metadata.xml approach already used for Forge/NeoForge above. This is the
 *    least-verified integration in this file, even more so than NeoForge originally was -
 *    see its own section below for exactly what is and isn't confirmed.
 *
 * None of these endpoints could be reached from the sandbox this was written in (outbound
 * network access to piston-meta.mojang.com/fill.papermc.io/meta.fabricmc.net/
 * maven.minecraftforge.net/maven.neoforged.net/repo.spongepowered.org is all blocked by this
 * environment's own proxy policy) - every shape below follows each project's own published,
 * versioned public documentation (or, for Sponge, GitHub-hosted README/build file evidence -
 * see its own section), the same "confirmed against docs, not a live response" caveat already
 * true of this codebase's CurseForge fingerprint algorithm (see curseforgeFingerprint.ts).
 * Please confirm an install of each type actually works end to end on a machine with real
 * internet access.
 *
 * History: Paper's original client here used the v2 API (api.papermc.io) - that API was
 * fully sunset and started returning HTTP 410 Gone for every request, breaking every real
 * Paper install. Migrated to the "Fill" v3 API, PaperMC's own documented replacement.
 */

const USER_AGENT = 'RaptorSauvage/bober-server-manager (Bober Server Manager; github.com/RaptorSauvage/bober-server-manager)'

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) {
    throw new Error(`Request to ${url} failed (HTTP ${response.status})`)
  }
  return response.json() as Promise<T>
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) {
    throw new Error(`Request to ${url} failed (HTTP ${response.status})`)
  }
  return response.text()
}

// ---- Vanilla (Mojang) -------------------------------------------------------------------

interface MojangVersionManifestEntry {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  url: string
}

interface MojangVersionManifest {
  latest: { release: string; snapshot: string }
  versions: MojangVersionManifestEntry[]
}

export interface MojangVersionDownload {
  url: string
  sha1: string
  size: number
}

interface MojangVersionDetail {
  downloads: { server?: MojangVersionDownload }
}

const MOJANG_VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

/** Release versions only (no snapshots/betas/alphas) - newest first, same order the manifest
 *  itself already lists them in. */
export async function listVanillaVersions(): Promise<MojangVersionManifestEntry[]> {
  const manifest = await fetchJson<MojangVersionManifest>(MOJANG_VERSION_MANIFEST_URL)
  return manifest.versions.filter((v) => v.type === 'release')
}

/** Not every version has a server download at all (very old versions pre-date a standalone
 *  server jar) - returns undefined rather than throwing, so the caller can give a clear
 *  "this version has no server download" error instead of a confusing one. */
export async function getVanillaServerDownload(versionManifestUrl: string): Promise<MojangVersionDownload | undefined> {
  const detail = await fetchJson<MojangVersionDetail>(versionManifestUrl)
  return detail.downloads.server
}

// ---- Paper (PaperMC "Fill" v3 API) ---------------------------------------------------------
//
// PaperMC's older v2 API (api.papermc.io) has been fully sunset - every endpoint there now
// answers HTTP 410 Gone. Its documented replacement is the "Fill" API
// (https://docs.papermc.io/misc/downloads-service/, base https://fill.papermc.io/v3) - a
// genuinely different shape, not just a renamed host: versions are grouped by family (e.g.
// "1.21" -> ["1.21", "1.21.1", ...]), builds carry an explicit `channel`
// (ALPHA/BETA/STABLE/RECOMMENDED - Paper itself only ever uses STABLE in practice) instead of
// a bare build-number list, and each build's own download entry already contains a
// ready-to-fetch URL (on fill-data.papermc.io) plus its sha256 - no separate "builds" call to
// resolve a download URL from a build number the way v2 needed.

interface PaperFillProject {
  versions: Record<string, string[]>
}

interface PaperFillBuildDownload {
  name: string
  url: string
  checksums: { sha256: string }
}

interface PaperFillBuild {
  id: number
  channel: 'ALPHA' | 'BETA' | 'STABLE' | 'RECOMMENDED'
  downloads: Record<string, PaperFillBuildDownload>
}

const PAPER_FILL_BASE = 'https://fill.papermc.io/v3/projects/paper'
/** The download key for the server jar itself, per Fill's own documented example - a build's
 *  `downloads` map can carry other keys too (e.g. a mojang-mappings jar), not needed here. */
const PAPER_SERVER_DOWNLOAD_KEY = 'server:default'

/** Newest first - versions are grouped oldest-family-first, oldest-within-family-first in
 *  Fill's own response, so flattening in order and reversing produces newest-first overall
 *  (the same assumption the old v2 client made about its own `versions` array). */
export async function listPaperVersions(): Promise<string[]> {
  const data = await fetchJson<PaperFillProject>(PAPER_FILL_BASE)
  return Object.values(data.versions).flat().reverse()
}

/** Every build Fill has recorded for a Minecraft version, newest first - Fill's own `/builds`
 *  endpoint already returns them this way (see Fill's own doc example, which takes builds[0]
 *  after filtering for the newest). */
export async function listPaperBuilds(version: string): Promise<PaperFillBuild[]> {
  return fetchJson<PaperFillBuild[]>(`${PAPER_FILL_BASE}/versions/${encodeURIComponent(version)}/builds`)
}

/** The newest STABLE-channel build for a Paper version (falling back to the newest build of
 *  any channel if none is marked STABLE yet, e.g. a very fresh Minecraft version) - Fill's
 *  own documented example does exactly this client-side filter, there's no dedicated
 *  "/latest-stable" endpoint. Returns the download's own ready-made URL directly - Fill
 *  doesn't need a separate "build download URL" builder the way the old v2 API did. */
export async function getLatestPaperBuild(
  version: string
): Promise<{ build: number; fileName: string; sha256: string; url: string }> {
  const builds = await listPaperBuilds(version)
  const build = builds.find((b) => b.channel === 'STABLE') ?? builds[0]
  if (!build) {
    throw new Error(`No Paper builds found for Minecraft ${version}.`)
  }
  const download = build.downloads[PAPER_SERVER_DOWNLOAD_KEY]
  if (!download) {
    throw new Error(`Paper build ${build.id} for Minecraft ${version} has no server download.`)
  }
  return { build: build.id, fileName: download.name, sha256: download.checksums.sha256, url: download.url }
}

/** Build-version options for the Install dialog's/Start Settings' second selector - every
 *  build Fill has for this Minecraft version, newest first, with the first STABLE one (if any)
 *  starred as recommended. */
export async function listPaperBuildOptions(version: string): Promise<Array<{ id: string; label: string; recommended: boolean }>> {
  const builds = await listPaperBuilds(version)
  const firstStableId = builds.find((b) => b.channel === 'STABLE')?.id
  return builds.map((b) => ({
    id: String(b.id),
    label: `Build ${b.id} (${b.channel.toLowerCase()})`,
    recommended: b.id === firstStableId
  }))
}

/** Download info for one specific build (picked from the second selector), rather than
 *  always the latest - same shape as getLatestPaperBuild above. */
export async function getPaperBuild(version: string, build: number): Promise<{ build: number; fileName: string; sha256: string; url: string }> {
  const builds = await listPaperBuilds(version)
  const match = builds.find((b) => b.id === build)
  if (!match) {
    throw new Error(`Paper build ${build} for Minecraft ${version} was not found.`)
  }
  const download = match.downloads[PAPER_SERVER_DOWNLOAD_KEY]
  if (!download) {
    throw new Error(`Paper build ${build} for Minecraft ${version} has no server download.`)
  }
  return { build: match.id, fileName: download.name, sha256: download.checksums.sha256, url: download.url }
}

// ---- Fabric (FabricMC) --------------------------------------------------------------------

interface FabricGameVersion {
  version: string
  stable: boolean
}

interface FabricLoaderVersion {
  version: string
  stable: boolean
}

interface FabricInstallerVersion {
  version: string
  stable: boolean
}

const FABRIC_META_BASE = 'https://meta.fabricmc.net/v2/versions'

/** Newest-first, stable Minecraft versions only - Fabric's own meta already orders them this
 *  way. */
export async function listFabricGameVersions(): Promise<string[]> {
  const versions = await fetchJson<FabricGameVersion[]>(`${FABRIC_META_BASE}/game`)
  return versions.filter((v) => v.stable).map((v) => v.version)
}

/** The newest stable Fabric loader version - Fabric's own meta lists the loader for a given
 *  Minecraft version at a separate endpoint, but the loader itself isn't Minecraft-version-
 *  specific (it's resolved against the game jar at launch), so the plain `/loader` listing
 *  (newest first) is enough; the mcVersion path parameter below exists only to fail clearly
 *  for a Minecraft version Fabric has no loader builds recorded for at all. */
export async function getLatestFabricLoaderVersion(mcVersion: string): Promise<string> {
  const loaders = await fetchJson<Array<{ loader: FabricLoaderVersion }>>(`${FABRIC_META_BASE}/loader/${encodeURIComponent(mcVersion)}`)
  const stable = loaders.find((l) => l.loader.stable) ?? loaders[0]
  if (!stable) {
    throw new Error(`Fabric has no loader builds for Minecraft ${mcVersion}.`)
  }
  return stable.loader.version
}

/** Loader-version options for the Install dialog's/Start Settings' second selector - every
 *  loader version Fabric's meta lists for this Minecraft version, newest first (Fabric's own
 *  meta already orders them this way), with the first `stable: true` one starred as
 *  recommended - same "stable flag IS the real signal" reasoning getLatestFabricLoaderVersion
 *  above already uses, just exposing the whole list instead of picking one. */
export async function listFabricLoaderOptions(mcVersion: string): Promise<Array<{ id: string; label: string; recommended: boolean }>> {
  const loaders = await fetchJson<Array<{ loader: FabricLoaderVersion }>>(`${FABRIC_META_BASE}/loader/${encodeURIComponent(mcVersion)}`)
  const firstStableVersion = loaders.find((l) => l.loader.stable)?.loader.version
  return loaders.map((l) => ({
    id: l.loader.version,
    label: l.loader.stable ? `${l.loader.version} (stable)` : l.loader.version,
    recommended: l.loader.version === firstStableVersion
  }))
}

export async function getLatestFabricInstallerVersion(): Promise<string> {
  const installers = await fetchJson<FabricInstallerVersion[]>(`${FABRIC_META_BASE}/installer`)
  const stable = installers.find((i) => i.stable) ?? installers[0]
  if (!stable) {
    throw new Error('Fabric has no installer builds available.')
  }
  return stable.version
}

/** Fabric's meta server can build a ready-to-run server jar on the fly from these three
 *  versions - no separate installer step needed, unlike Forge. */
export function fabricServerJarUrl(mcVersion: string, loaderVersion: string, installerVersion: string): string {
  return `${FABRIC_META_BASE}/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installerVersion)}/server/jar`
}

// ---- Forge (Minecraft Forge) ---------------------------------------------------------------

const FORGE_MAVEN_METADATA_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'

/** Forge has no JSON API - maven-metadata.xml lists every published `<mcVersion>-<forgeVersion>`
 *  combination as a flat `<version>` list, oldest first. Parsed with a plain regex rather than
 *  an XML library: the file is simple, uniform, machine-generated Maven metadata (no
 *  attributes, no nesting beyond one level), not arbitrary/untrusted XML worth a real parser
 *  for. */
/** Full `<mcVersion>-<forgeVersion>` combo strings, newest-published-first. Shared by
 *  listForgeVersionsForMinecraft (filters by mcVersion) and listForgeLoaderOptions (strips the
 *  mcVersion prefix back off) so both work from one fetch of the same, single, flat metadata
 *  file rather than each fetching it separately. */
async function listAllForgeCombosRaw(): Promise<string[]> {
  const xml = await fetchText(FORGE_MAVEN_METADATA_URL)
  const matches = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
  // Newest-published-first - maven-metadata.xml lists them oldest-first.
  return matches.reverse()
}

export async function listForgeVersionsForMinecraft(mcVersion: string): Promise<string[]> {
  const prefix = `${mcVersion}-`
  return (await listAllForgeCombosRaw()).filter((v) => v.startsWith(prefix))
}

export function forgeInstallerUrl(mcVersion: string, forgeVersion: string): string {
  const full = `${mcVersion}-${forgeVersion}`
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`
}

const FORGE_PROMOTIONS_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'

interface ForgePromotions {
  promos: Record<string, string>
}

/** Forge's own documented "which build is recommended" signal
 *  (https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json's sibling -
 *  promotions_slim.json is the stable, documented one) - keyed `"<mcVersion>-recommended"` and
 *  `"<mcVersion>-latest"`, each mapping to a bare forgeVersion (no mcVersion prefix). "latest"
 *  always exists once Forge has published anything for that mcVersion at all; "recommended"
 *  only exists once Forge's own team has actually marked one (very fresh Minecraft versions
 *  can have "latest" builds for weeks before a "recommended" one is chosen). */
async function getForgePromotions(): Promise<ForgePromotions> {
  return fetchJson<ForgePromotions>(FORGE_PROMOTIONS_URL)
}

/** Loader-version options for the Install dialog's/Start Settings' second selector - every
 *  published Forge version for this Minecraft version, newest first, with whichever one
 *  Forge's own promotions file marks "recommended" (falling back to "latest" if Forge hasn't
 *  picked a recommended build for this mcVersion yet) starred. */
export async function listForgeLoaderOptions(mcVersion: string): Promise<Array<{ id: string; label: string; recommended: boolean }>> {
  const prefix = `${mcVersion}-`
  const combos = (await listAllForgeCombosRaw()).filter((v) => v.startsWith(prefix))
  const forgeVersions = combos.map((combo) => combo.slice(prefix.length))

  let recommendedVersion: string | undefined
  try {
    const promotions = await getForgePromotions()
    recommendedVersion = promotions.promos[`${mcVersion}-recommended`] ?? promotions.promos[`${mcVersion}-latest`]
  } catch {
    // Best-effort - the version list itself is still useful with no star at all if the
    // promotions file is unreachable/changed shape.
  }

  return forgeVersions.map((v) => ({ id: v, label: v, recommended: v === recommendedVersion }))
}

// ---- NeoForge (NeoForged) ------------------------------------------------------------------

const NEOFORGE_MAVEN_METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'

/**
 * Unlike Forge, NeoForge's own maven-metadata.xml (1.20.2 onward - NeoForge didn't exist
 * before that) lists plain build versions with no Minecraft version combined into the
 * string at all (e.g. "21.1.72", not "1.21.1-21.1.72") - see neoForgeVersionToMinecraftVersion
 * below for how the two actually relate. Parsed the same plain-regex way as Forge's own
 * maven-metadata.xml, for the same reason (simple, uniform, machine-generated, not arbitrary
 * XML worth a real parser for).
 */
export async function listNeoForgeVersions(): Promise<string[]> {
  const xml = await fetchText(NEOFORGE_MAVEN_METADATA_URL)
  const matches = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
  // Newest-published-first - maven-metadata.xml lists them oldest-first.
  return matches.reverse()
}

export function neoForgeInstallerUrl(neoForgeVersion: string): string {
  return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoForgeVersion}/neoforge-${neoForgeVersion}-installer.jar`
}

/**
 * NeoForge's own documented version scheme (https://docs.neoforged.net/docs/gettingstarted/versioning/):
 * `<mcMinor>.<mcPatch>.<build>`, where the Minecraft version is `1.<mcMinor>` if `<mcPatch>`
 * is `0`, else `1.<mcMinor>.<mcPatch>` - e.g. "21.1.72" is Minecraft 1.21.1, "20.2.86" is
 * Minecraft 1.20.2. Used to fill MinecraftProfile.minecraftVersion (needed by the Mods tab to
 * filter compatible mod versions) from the one version string NeoForge's own maven actually
 * publishes - there's no separate "which Minecraft version is this" field anywhere in its
 * metadata to read instead. Throws rather than guessing if a version string doesn't match
 * this scheme at all (a version NeoForge itself never published, or a scheme change this
 * hasn't been updated for).
 */
export function neoForgeVersionToMinecraftVersion(neoForgeVersion: string): string {
  const match = /^(\d+)\.(\d+)\./.exec(neoForgeVersion)
  if (!match) {
    throw new Error(`Not a recognized NeoForge version ("<mcMinor>.<mcPatch>.<build>" expected): ${neoForgeVersion}`)
  }
  const [, mcMinor, mcPatch] = match
  return mcPatch === '0' ? `1.${mcMinor}` : `1.${mcMinor}.${mcPatch}`
}

/** NeoForge build options for one Minecraft version, newest first - unlike Forge, NeoForge
 *  publishes no promotions-file equivalent marking one build "recommended", so the newest
 *  build for this Minecraft version is starred instead, as a best-effort default rather than
 *  an official signal (documented here, and again at the one call site, so this distinction
 *  isn't lost). */
export async function listNeoForgeLoaderOptions(mcVersion: string): Promise<Array<{ id: string; label: string; recommended: boolean }>> {
  const all = await listNeoForgeVersions()
  const forThisVersion = all.filter((v) => {
    try {
      return neoForgeVersionToMinecraftVersion(v) === mcVersion
    } catch {
      return false
    }
  })
  return forThisVersion.map((v, index) => ({ id: v, label: v, recommended: index === 0 }))
}

/** Minecraft versions NeoForge has at least one published build for, newest first - derived
 *  the same way listForgeMinecraftVersions is (see its own doc comment for the ordering
 *  caveat), just grouped by the derived mcVersion instead of a literal string prefix. */
export async function listNeoForgeMinecraftVersions(): Promise<string[]> {
  const all = await listNeoForgeVersions()
  const seen = new Set<string>()
  const result: string[] = []
  for (const v of all) {
    let mcVersion: string
    try {
      mcVersion = neoForgeVersionToMinecraftVersion(v)
    } catch {
      continue
    }
    if (!seen.has(mcVersion)) {
      seen.add(mcVersion)
      result.push(mcVersion)
    }
  }
  return result
}

/** Minecraft versions Forge has at least one published build for, newest first - derived by
 *  grouping every combo's own mcVersion prefix and keeping each one's first appearance
 *  (listAllForgeCombosRaw is already newest-build-first, so the first combo seen for a given
 *  mcVersion is that version's newest build). Not a perfectly guaranteed ordering - Forge
 *  could in principle publish a build for an older Minecraft version after a newer version's
 *  build already exists - but close enough for a dropdown's default ordering, same caveat as
 *  everywhere else in this file that orders by "whatever the source happened to list last". */
export async function listForgeMinecraftVersions(): Promise<string[]> {
  const combos = await listAllForgeCombosRaw()
  const seen = new Set<string>()
  const result: string[] = []
  for (const combo of combos) {
    const dash = combo.indexOf('-')
    if (dash === -1) continue
    const mcVersion = combo.slice(0, dash)
    if (!seen.has(mcVersion)) {
      seen.add(mcVersion)
      result.push(mcVersion)
    }
  }
  return result
}

// ---- Sponge (SpongeVanilla / SpongeForge) --------------------------------------------------
//
// SpongePowered's own dedicated downloads API could not be confirmed live: its Vue frontend
// repo (SpongeDownloads) is archived, and the backend it reads from (SystemOfADownload)
// documents its production host only in an openapi.yaml spec, not its README - that host
// didn't even resolve via DNS when checked. Using their Maven repo directly instead
// (repo.spongepowered.org), the same approach already used for Forge/NeoForge above - this
// much IS confirmed live and current: SpongePowered's own active monorepo
// (github.com/SpongePowered/Sponge)'s README links its own "latest builds" badges straight
// into this Maven repo's browser UI, with group id org.spongepowered and artifact ids
// spongevanilla/spongeforge, filtered by a `<mcVersion>-*` version pattern - the exact same
// `<mcVersion>-<build>` combo shape Forge's own maven-metadata.xml already uses. What is NOT
// confirmed: the exact published jar file name for a given version (assumed here to be the
// standard Maven default, `<artifactId>-<version>.jar`, with no extra classifier) - if an
// install 404s downloading the jar itself (as opposed to failing to list versions at all),
// that filename assumption is the first thing to check and fix.
//
// SpongeForge additionally needs a separately-installed Forge server matching its own
// required Forge version - which Sponge's Maven version string does NOT encode (only the
// release's *download filename* on spongepowered.org's own downloads page does, per
// https://docs.spongepowered.org/7.4.0/en/versions/filenames.html, and that's a different,
// human-facing naming scheme from the Maven artifact version used here). Rather than parsing
// that separate filename scheme (not available from the Maven listing this reads at all),
// installSpongeForgeServer (minecraftInstall.ts) installs whichever Forge build this app's
// own listForgeLoaderOptions already considers "recommended" for the same Minecraft version,
// then drops the SpongeForge jar into mods/ on top of it - correct for the common case, but
// not a verified-compatible pairing the way a real "requires Forge build X" field would be.

const SPONGE_MAVEN_BASE = 'https://repo.spongepowered.org/repository/maven-public/org/spongepowered'

async function listSpongeCombosRaw(artifactId: 'spongevanilla' | 'spongeforge'): Promise<string[]> {
  const xml = await fetchText(`${SPONGE_MAVEN_BASE}/${artifactId}/maven-metadata.xml`)
  const matches = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
  // Newest-published-first - maven-metadata.xml lists them oldest-first, same as Forge's.
  return matches.reverse()
}

function groupComboVersionsByMcVersion(combos: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const combo of combos) {
    const dash = combo.indexOf('-')
    if (dash === -1) continue
    const mcVersion = combo.slice(0, dash)
    const buildVersion = combo.slice(dash + 1)
    const existing = groups.get(mcVersion)
    if (existing) existing.push(buildVersion)
    else groups.set(mcVersion, [buildVersion])
  }
  return groups
}

export async function listSpongeMinecraftVersions(artifactId: 'spongevanilla' | 'spongeforge'): Promise<string[]> {
  return [...groupComboVersionsByMcVersion(await listSpongeCombosRaw(artifactId)).keys()]
}

/** Build-version options for one Minecraft version - newest first, with the newest one
 *  starred as recommended (no official "recommended build" signal exists for Sponge, same
 *  best-effort-default caveat as NeoForge's own listNeoForgeLoaderOptions above). */
export async function listSpongeLoaderOptions(
  artifactId: 'spongevanilla' | 'spongeforge',
  mcVersion: string
): Promise<Array<{ id: string; label: string; recommended: boolean }>> {
  const builds = groupComboVersionsByMcVersion(await listSpongeCombosRaw(artifactId)).get(mcVersion) ?? []
  return builds.map((v, index) => ({ id: v, label: v, recommended: index === 0 }))
}

/** Direct Maven-layout download URL for one Sponge build - see this section's own top-of-
 *  comment for why the exact file name is an unverified assumption rather than something read
 *  off a real API response. */
export function spongeDownloadUrl(artifactId: 'spongevanilla' | 'spongeforge', mcVersion: string, buildVersion: string): string {
  const version = `${mcVersion}-${buildVersion}`
  return `${SPONGE_MAVEN_BASE}/${artifactId}/${version}/${artifactId}-${version}.jar`
}

// ---- Spigot (BuildTools) -------------------------------------------------------------------

/** The one thing Spigot actually ships as a fixed download - everything else (the server jar
 *  itself) is compiled locally by this, against Mojang's own mappings, per Spigot's license
 *  terms. See minecraftInstall.ts's installSpigotServer for the actual build step. */
export const SPIGOT_BUILDTOOLS_URL = 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar'
