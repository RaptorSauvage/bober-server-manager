import type { OfficialServerStatus } from '@shared/types'

/**
 * Official ARK:SA server status feed, published by Wildcard/Snail Games. Despite the
 * .ini extension, the actual content isn't key/value INI - it's a single line like:
 *   ARK Official Server Network Status: <RichColor Color="0, 1, 0, 1">Online (v92.25)</>
 * where the RichColor's 4 components are 0-1 floats (Unreal Engine's usual color format).
 */
export const OFFICIAL_SERVER_STATUS_URL = 'https://cdn2.arkdedicated.com/asa/officialserverstatus.ini'

const STATUS_LINE_REGEX =
  /^(.*?):\s*<RichColor Color="([^"]+)">\s*(.*?)\s*\(v?([\d.]+)\)\s*<\/>\s*$/i

/** Converts a RichColor "r, g, b[, a]" string (each component 0-1) into a CSS rgb()/rgba() color. */
export function richColorToCss(richColor: string): string {
  const [r, g, b, a] = richColor.split(',').map((part) => Number(part.trim()))
  const to255 = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 255)
  if (a !== undefined && a < 1) {
    return `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${a})`
  }
  return `rgb(${to255(r)}, ${to255(g)}, ${to255(b)})`
}

export function parseOfficialServerStatus(content: string): OfficialServerStatus {
  const match = content.trim().match(STATUS_LINE_REGEX)
  if (!match) {
    throw new Error('Unrecognized official server status format')
  }
  const [, label, richColor, status, version] = match
  return {
    label: label.trim(),
    status: status.trim(),
    version: version.trim(),
    color: richColorToCss(richColor)
  }
}

export async function fetchOfficialServerStatus(): Promise<OfficialServerStatus> {
  // No timeout here used to mean a slow/filtered connection (a strict firewall, bad DNS, ...)
  // could hang this call - and so the whole Dashboard mount that awaits it - for minutes instead
  // of failing fast. Bounded to a plain 8s so a dead network surfaces as a quick error, same as
  // every other real network call in this app (SteamCMD, Modrinth/CurseForge) already does.
  const response = await fetch(OFFICIAL_SERVER_STATUS_URL, { signal: AbortSignal.timeout(8000) })
  if (!response.ok) {
    throw new Error(`Failed to fetch official server status (HTTP ${response.status})`)
  }
  const content = await response.text()
  return parseOfficialServerStatus(content)
}
