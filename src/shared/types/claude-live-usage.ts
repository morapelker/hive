import type { AnthropicRateLimitWindow, UsageData } from './usage'

/**
 * Published by the Electron main process every time the local Claude API
 * proxy observes an Anthropic response carrying `anthropic-ratelimit-unified-*`
 * headers. The payload is already attributed to the managed account whose
 * `account_uuid` rode in the request body — NOT necessarily the currently
 * selected account (a session still streaming on the previous account after a
 * switch keeps reporting for that previous account).
 */
export const CLAUDE_LIVE_USAGE_CHANNEL = 'usage:claudeLive'

export interface ClaudeLiveUsageRateLimit {
  fiveHour?: AnthropicRateLimitWindow
  sevenDay?: AnthropicRateLimitWindow
}

export interface ClaudeLiveUsagePayload {
  provider: 'anthropic'
  /** `saved_usage_accounts.id` of the attributed account (the `SavedAccountDTO.id`). */
  accountId: string
  /** Lowercased account email, matching `SavedAccountDTO.email` / the live-identity email. */
  email: string
  /**
   * The `account_uuid` the client reported in the request's `metadata.user_id`,
   * if any. Informational only: a running CLI keeps reporting the account it
   * started on even after it adopts another account's token, so attribution
   * goes by the credential the request carried, not by this.
   */
  accountUuid: string | null
  /**
   * True when the request's account is the one currently signed in (decided
   * in the main process against the CLI's own identity file, which an account
   * switch rewrites before it reports success). Only then may the renderer
   * touch the live slot behind the bottom bar; the saved-account row updates
   * either way.
   */
  isLiveAccount: boolean
  /** The signed-in account's lowercased email at observation time, if known. */
  liveEmail: string | null
  /** The merged usage snapshot now stored on the account's cache row. */
  usage: UsageData
  /** Per-window status/reset as the rate-limit overlay understands it (epoch seconds). */
  rateLimit: ClaudeLiveUsageRateLimit
  /** Epoch ms at which the proxy saw the upstream response headers. */
  observedAt: number
  /**
   * The session whose debug log the reading came from (a Code Mode session, which does not
   * go through the proxy). Absent for a reading the proxy saw. It lets the usage UI take
   * back "Live" when that session's log stops giving readings
   * (`CLAUDE_LIVE_USAGE_HEALTH_CHANNEL`).
   */
  sessionId?: string
}

export function isClaudeLiveUsagePayload(value: unknown): value is ClaudeLiveUsagePayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  if (payload.provider !== 'anthropic') return false
  if (typeof payload.accountId !== 'string' || typeof payload.email !== 'string') return false
  if (payload.accountUuid !== null && typeof payload.accountUuid !== 'string') return false
  if (typeof payload.observedAt !== 'number') return false
  if (payload.sessionId !== undefined && typeof payload.sessionId !== 'string') return false
  if (typeof payload.isLiveAccount !== 'boolean') return false
  if (payload.liveEmail !== null && typeof payload.liveEmail !== 'string') return false
  if (typeof payload.usage !== 'object' || payload.usage === null) return false
  if (typeof payload.rateLimit !== 'object' || payload.rateLimit === null) return false
  const usage = payload.usage as Record<string, unknown>
  // Each window is an object or null (null = the plan has no such window);
  // `typeof null === 'object'` already admits null, but a missing key does
  // not pass — the payload must say something about both windows.
  return (
    'five_hour' in usage &&
    typeof usage.five_hour === 'object' &&
    'seven_day' in usage &&
    typeof usage.seven_day === 'object'
  )
}

/**
 * Published by the Electron main process when the debug log of a Code Mode session stops
 * giving usage readings, and when it gives them again (Code Mode T18; PRD FR-30, FR-31).
 * While a session is degraded its usage comes from the usage poll alone, so the usage UI
 * must not go on saying "Live" because of the last reading that session gave.
 */
export const CLAUDE_LIVE_USAGE_HEALTH_CHANNEL = 'usage:claudeLiveHealth'

/**
 * Why a session's debug log gives no readings: missing or empty after a completed turn;
 * responses logged and none readable; deleted for its size; refused as not safe to read.
 */
export type ClaudeLiveUsageDegradedReason =
  'log-empty' | 'unparsed-responses' | 'hard-cap' | 'unsafe-file'

export interface ClaudeLiveUsageHealthPayload {
  provider: 'anthropic'
  /** The session, as `ClaudeLiveUsagePayload.sessionId` names it. */
  sessionId: string
  /** True: no live readings from this session until further notice. False: they are back. */
  degraded: boolean
  reason: ClaudeLiveUsageDegradedReason | null
  /** Epoch ms of the change. */
  at: number
}

const DEGRADED_REASONS: ReadonlySet<string> = new Set([
  'log-empty',
  'unparsed-responses',
  'hard-cap',
  'unsafe-file'
])

export function isClaudeLiveUsageHealthPayload(
  value: unknown
): value is ClaudeLiveUsageHealthPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  if (payload.provider !== 'anthropic') return false
  if (typeof payload.sessionId !== 'string' || payload.sessionId === '') return false
  if (typeof payload.degraded !== 'boolean' || typeof payload.at !== 'number') return false
  return payload.degraded
    ? typeof payload.reason === 'string' && DEGRADED_REASONS.has(payload.reason)
    : payload.reason === null
}

/**
 * Published by the Electron main process when live usage for Code Mode sessions has been
 * switched off for the installed version of the Claude CLI: three launches in a row gave no
 * readings with it (Code Mode T19; PRD FR-32). New Code Mode sessions then start without a
 * debug log, and their usage comes from the usage poll, until the CLI or the app is updated.
 *
 * It is the cue to tell the person, once. The event can be published more than once for one
 * switch-off (to every window, and again with a later launch while nobody has been told):
 * whoever receives it asks `usageOps.claimCodeModeUsageUnavailableNotice`, which answers with
 * the notice exactly once.
 */
export const CLAUDE_CODE_MODE_USAGE_UNAVAILABLE_CHANNEL = 'usage:claudeCodeModeLiveUsageUnavailable'

export interface ClaudeCodeModeUsageUnavailablePayload {
  provider: 'anthropic'
  /** The version of the Claude CLI the debug log gave no readings with, e.g. `2.1.326`. */
  cliVersion: string
}

export function isClaudeCodeModeUsageUnavailablePayload(
  value: unknown
): value is ClaudeCodeModeUsageUnavailablePayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  return (
    payload.provider === 'anthropic' &&
    typeof payload.cliVersion === 'string' &&
    payload.cliVersion !== ''
  )
}
