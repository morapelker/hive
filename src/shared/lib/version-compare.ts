interface ParsedVersion {
  core: number[]
  prerelease: string[]
}

function parseVersion(raw: string): ParsedVersion {
  const cleaned = raw.trim().replace(/^v/i, '')
  const dashIndex = cleaned.indexOf('-')
  const core = dashIndex === -1 ? cleaned : cleaned.slice(0, dashIndex)
  const prerelease = dashIndex === -1 ? [] : cleaned.slice(dashIndex + 1).split('.')
  const coreParts = core.split('.').map((segment) => {
    const value = Number.parseInt(segment, 10)
    return Number.isFinite(value) ? value : 0
  })
  return { core: coreParts, prerelease }
}

/**
 * Minimal semver-ish comparison for Hive app versions ("1.2.34",
 * "1.3.0-canary.2"). Returns negative when a < b, 0 when equal, positive when
 * a > b. Org admins type minimum versions by hand, so malformed segments
 * compare as 0 instead of throwing — enforcement must never crash on junk.
 */
export function compareAppVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const coreLength = Math.max(pa.core.length, pb.core.length)
  for (let i = 0; i < coreLength; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0)
    if (diff !== 0) return diff
  }
  // Same core: a release outranks any of its prereleases (1.3.0 > 1.3.0-canary.1).
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  const preLength = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < preLength; i++) {
    const sa = pa.prerelease[i]
    const sb = pb.prerelease[i]
    // Semver: a shorter prerelease list sorts before a longer one.
    if (sa === undefined) return -1
    if (sb === undefined) return 1
    const aNumeric = /^\d+$/.test(sa)
    const bNumeric = /^\d+$/.test(sb)
    if (aNumeric && bNumeric) {
      const diff = Number.parseInt(sa, 10) - Number.parseInt(sb, 10)
      if (diff !== 0) return diff
    } else if (aNumeric) {
      // Semver: numeric identifiers sort before alphanumeric ones.
      return -1
    } else if (bNumeric) {
      return 1
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1
    }
  }
  return 0
}
