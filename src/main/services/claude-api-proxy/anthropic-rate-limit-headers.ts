/**
 * Pure parsing of what the local Claude API proxy observes on each exchange:
 * the `anthropic-ratelimit-unified-*` response headers (subscription usage)
 * and the `account_uuid` Claude Code puts in the request body's
 * `metadata.user_id`.
 *
 * Header facts (validated against claude 2.1.287 and raw captures):
 * - `-5h-utilization` / `-7d-utilization` are FRACTIONS 0..1 (the CLI renders
 *   `Math.floor(x * 100)`); `/api/oauth/usage` reports 0..100 percent.
 * - `-5h-reset` / `-7d-reset` / `-reset` are unix epoch SECONDS.
 * - `-status` is `allowed | allowed_warning | rejected`; `-representative-claim`
 *   names the binding window (`five_hour`, `seven_day`,
 *   `seven_day_overage_included` = the Fable bucket, `seven_day_opus`, ...).
 * - Model-scoped weekly buckets ride as `-7d_<bucket>-*` (`7d_oi` = overage
 *   included = Fable). No per-model header exists for every model, so the
 *   polled `limits[]` stays the source for anything not listed here.
 * - Present on `/v1/messages` 200s and on plan-limit 429s; absent on
 *   `count_tokens`, `/api/hello`, and temporary-throttle 429s.
 */
import type { ScopedUsageWindow, UsageData } from '@shared/types/usage'

export const UNIFIED_HEADER_PREFIX = 'anthropic-ratelimit-unified-'

export type UnifiedRateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected'

export interface UnifiedRateLimitWindow {
  /** Percent 0..100 (header fraction × 100), when the header was present. */
  utilizationPercent: number | null
  /** Unix epoch seconds, when the header was present. */
  resetsAt: number | null
  status: UnifiedRateLimitStatus | null
  surpassedThreshold: number | null
}

export interface UnifiedRateLimitSnapshot {
  fiveHour?: UnifiedRateLimitWindow
  sevenDay?: UnifiedRateLimitWindow
  /** Model-scoped weekly buckets keyed by the header bucket id (`oi`, `opus`, `sonnet`, ...). */
  scoped: Record<string, UnifiedRateLimitWindow>
  /** Overall verdict for the request. */
  status: UnifiedRateLimitStatus | null
  /** Which window the overall verdict describes. */
  representativeClaim: string | null
  /** Reset of the representative window (epoch seconds). */
  resetsAt: number | null
  overage: {
    status: UnifiedRateLimitStatus | null
    resetsAt: number | null
    disabledReason: string | null
    utilizationPercent: number | null
  }
}

type HeaderValue = string | string[] | undefined

function first(value: HeaderValue): string | null {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null
  return typeof value === 'string' ? value : null
}

function parseNumber(value: string | null): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** Fraction 0..1 → percent 0..100. Tolerates a server that already sent percent. */
function parseUtilizationPercent(value: string | null): number | null {
  const parsed = parseNumber(value)
  if (parsed === null || parsed < 0) return null
  const percent = parsed > 1 ? parsed : parsed * 100
  return Math.round(percent * 100) / 100
}

function parseStatus(value: string | null): UnifiedRateLimitStatus | null {
  if (value === 'allowed' || value === 'allowed_warning' || value === 'rejected') return value
  return null
}

/** Epoch seconds; a server sending milliseconds is normalized. */
function parseEpochSeconds(value: string | null): number | null {
  const parsed = parseNumber(value)
  if (parsed === null || parsed <= 0) return null
  return parsed > 1e12 ? Math.round(parsed / 1000) : Math.round(parsed)
}

type WindowSuffix = 'utilization' | 'reset' | 'status' | 'surpassed-threshold'

function emptyWindow(): UnifiedRateLimitWindow {
  return { utilizationPercent: null, resetsAt: null, status: null, surpassedThreshold: null }
}

function applyWindowHeader(
  window: UnifiedRateLimitWindow,
  suffix: WindowSuffix,
  value: string | null
): void {
  switch (suffix) {
    case 'utilization':
      window.utilizationPercent = parseUtilizationPercent(value)
      return
    case 'reset':
      window.resetsAt = parseEpochSeconds(value)
      return
    case 'status':
      window.status = parseStatus(value)
      return
    case 'surpassed-threshold':
      window.surpassedThreshold = parseNumber(value)
      return
  }
}

function hasAnyValue(window: UnifiedRateLimitWindow): boolean {
  return (
    window.utilizationPercent !== null ||
    window.resetsAt !== null ||
    window.status !== null ||
    window.surpassedThreshold !== null
  )
}

const WINDOW_HEADER = /^(5h|7d|7d_[a-z0-9]+)-(utilization|reset|status|surpassed-threshold)$/

/**
 * Parse the unified rate-limit headers of one response. Returns null when the
 * response carries none (so callers can skip the exchange cheaply).
 */
export function parseUnifiedRateLimitHeaders(
  headers: Record<string, HeaderValue>
): UnifiedRateLimitSnapshot | null {
  let sawAny = false
  const snapshot: UnifiedRateLimitSnapshot = {
    scoped: {},
    status: null,
    representativeClaim: null,
    resetsAt: null,
    overage: { status: null, resetsAt: null, disabledReason: null, utilizationPercent: null }
  }
  const windows: Record<string, UnifiedRateLimitWindow> = {}

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    if (!name.startsWith(UNIFIED_HEADER_PREFIX)) continue
    const key = name.slice(UNIFIED_HEADER_PREFIX.length)
    const value = first(rawValue)
    sawAny = true

    const windowMatch = WINDOW_HEADER.exec(key)
    if (windowMatch) {
      const [, windowKey, suffix] = windowMatch
      windows[windowKey] ??= emptyWindow()
      applyWindowHeader(windows[windowKey], suffix as WindowSuffix, value)
      continue
    }

    switch (key) {
      case 'status':
        snapshot.status = parseStatus(value)
        break
      case 'representative-claim':
        snapshot.representativeClaim = value?.trim() || null
        break
      case 'reset':
        snapshot.resetsAt = parseEpochSeconds(value)
        break
      case 'overage-status':
        snapshot.overage.status = parseStatus(value)
        break
      case 'overage-reset':
        snapshot.overage.resetsAt = parseEpochSeconds(value)
        break
      case 'overage-disabled-reason':
        snapshot.overage.disabledReason = value?.trim() || null
        break
      case 'overage-utilization':
        snapshot.overage.utilizationPercent = parseUtilizationPercent(value)
        break
      default:
        // fallback-percentage, upgrade-paths, grace-*, slow-*: not usage.
        break
    }
  }

  if (!sawAny) return null

  for (const [windowKey, window] of Object.entries(windows)) {
    if (!hasAnyValue(window)) continue
    if (windowKey === '5h') snapshot.fiveHour = window
    else if (windowKey === '7d') snapshot.sevenDay = window
    else snapshot.scoped[windowKey.slice('7d_'.length)] = window
  }

  return snapshot
}

/** Display labels the usage popover already uses for model-scoped windows. */
const SCOPED_BUCKET_LABELS: Record<string, string> = {
  // "overage included" — the Fable weekly bucket (representative-claim seven_day_overage_included).
  oi: 'Fable',
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet'
}

export function scopedBucketLabel(bucket: string): string | null {
  return SCOPED_BUCKET_LABELS[bucket.toLowerCase()] ?? null
}

function epochSecondsToIso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString()
}

type UnifiedRateLimitWindowWithUsage = UnifiedRateLimitWindow & { utilizationPercent: number }

function hasUsageNumbers(
  window: UnifiedRateLimitWindow | undefined
): window is UnifiedRateLimitWindowWithUsage {
  return window !== undefined && window.utilizationPercent !== null
}

/**
 * Whether the snapshot carries anything worth persisting as usage (a 5h or 7d
 * utilization, or a scoped bucket with a known label). A bare `-status` header
 * without numbers isn't a usage update.
 */
export function snapshotHasUsage(snapshot: UnifiedRateLimitSnapshot): boolean {
  if (hasUsageNumbers(snapshot.fiveHour) || hasUsageNumbers(snapshot.sevenDay)) return true
  return Object.entries(snapshot.scoped).some(
    ([bucket, window]) => scopedBucketLabel(bucket) !== null && hasUsageNumbers(window)
  )
}

/**
 * Merge a header snapshot into the account's last polled usage. The headers
 * only describe the windows they name; everything else (`extra_usage`, other
 * `scoped` entries) is carried over from `previous` so the popover never loses
 * the Fable/extra-usage rows between polls.
 */
export function mergeUnifiedSnapshotIntoUsage(
  previous: UsageData | null,
  snapshot: UnifiedRateLimitSnapshot
): UsageData {
  const fiveHour = hasUsageNumbers(snapshot.fiveHour)
    ? {
        utilization: snapshot.fiveHour.utilizationPercent,
        resets_at: epochSecondsToIso(snapshot.fiveHour.resetsAt)
      }
    : (previous?.five_hour ?? { utilization: 0, resets_at: null })
  const sevenDay = hasUsageNumbers(snapshot.sevenDay)
    ? {
        utilization: snapshot.sevenDay.utilizationPercent,
        resets_at: epochSecondsToIso(snapshot.sevenDay.resetsAt)
      }
    : (previous?.seven_day ?? { utilization: 0, resets_at: null })

  const scoped: ScopedUsageWindow[] = previous?.scoped ? previous.scoped.map((w) => ({ ...w })) : []
  for (const [bucket, window] of Object.entries(snapshot.scoped)) {
    const label = scopedBucketLabel(bucket)
    if (label === null || !hasUsageNumbers(window)) continue
    const next: ScopedUsageWindow = {
      label,
      used_percent: window.utilizationPercent,
      resets_at: epochSecondsToIso(window.resetsAt)
    }
    const index = scoped.findIndex((w) => w.label.toLowerCase() === label.toLowerCase())
    if (index === -1) scoped.push(next)
    else scoped[index] = next
  }

  const merged: UsageData = { five_hour: fiveHour, seven_day: sevenDay }
  if (previous?.extra_usage) merged.extra_usage = { ...previous.extra_usage }
  if (scoped.length > 0) merged.scoped = scoped
  return merged
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USER_ID_KEY = Buffer.from('"user_id"')
// How far past the `"user_id"` key the (escaped) JSON string can extend.
const USER_ID_WINDOW_BYTES = 4096

function decodeUserIdValue(window: string): string | null {
  // `"user_id": "<escaped JSON>"` — the value is a JSON string literal, so
  // JSON.parse of the quoted literal yields the inner JSON text.
  const match = /^"user_id"\s*:\s*("(?:\\.|[^"\\])*")/.exec(window)
  if (!match) return null
  try {
    const inner = JSON.parse(match[1]) as unknown
    if (typeof inner !== 'string') return null
    const parsed = JSON.parse(inner) as { account_uuid?: unknown }
    const uuid = parsed?.account_uuid
    return typeof uuid === 'string' && UUID_PATTERN.test(uuid) ? uuid.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Extract Claude Code's `account_uuid` from a `/v1/messages` request body
 * without parsing the whole (often multi-megabyte) JSON document: locate the
 * `"user_id"` key with a byte search and decode just that string literal. The
 * key normally sits near the end of the body (after `messages`), so a prefix
 * scan would miss it. Returns null for bodies without one (API-key users,
 * non-CLI clients, `count_tokens` probes).
 */
export function extractClaudeAccountUuid(body: Buffer): string | null {
  let at = body.indexOf(USER_ID_KEY)
  while (at !== -1) {
    const window = body.toString('utf8', at, Math.min(at + USER_ID_WINDOW_BYTES, body.length))
    const uuid = decodeUserIdValue(window)
    if (uuid !== null) return uuid
    at = body.indexOf(USER_ID_KEY, at + USER_ID_KEY.length)
  }
  return null
}
