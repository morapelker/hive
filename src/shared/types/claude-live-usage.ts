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
  /** The Anthropic `account_uuid` from the request's `metadata.user_id`. */
  accountUuid: string
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
}

export function isClaudeLiveUsagePayload(value: unknown): value is ClaudeLiveUsagePayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  if (payload.provider !== 'anthropic') return false
  if (typeof payload.accountId !== 'string' || typeof payload.email !== 'string') return false
  if (typeof payload.accountUuid !== 'string' || typeof payload.observedAt !== 'number')
    return false
  if (typeof payload.isLiveAccount !== 'boolean') return false
  if (payload.liveEmail !== null && typeof payload.liveEmail !== 'string') return false
  if (typeof payload.usage !== 'object' || payload.usage === null) return false
  if (typeof payload.rateLimit !== 'object' || payload.rateLimit === null) return false
  const usage = payload.usage as Record<string, unknown>
  return typeof usage.five_hour === 'object' && typeof usage.seven_day === 'object'
}
