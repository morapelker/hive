export interface ScopedUsageWindow {
  label: string
  used_percent: number
  resets_at: string | null
}

export interface UsageData {
  five_hour: { utilization: number; resets_at: string }
  seven_day: { utilization: number; resets_at: string }
  extra_usage?: {
    is_enabled: boolean
    utilization: number
    used_credits: number
    monthly_limit: number
  }
  scoped?: ScopedUsageWindow[]
}

export interface UsageResult {
  success: boolean
  data?: UsageData
  error?: string
  retryAfter?: number
  rotated?: ClaudeRefreshResult
  needsLogin?: boolean
}

export interface ClaudeRefreshResult {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope?: string
  /**
   * The refresh token that was actually passed into the refresh call that
   * produced this result — NOT necessarily the token read before the fetch
   * started (some other process may have rotated it in between). Callers
   * that persist rotated live tokens must race-check against this token,
   * not against a pre-read one, or a burned refresh token can be left live.
   */
  rotatedFrom: string
}

export type AnthropicRateLimitType = 'five_hour' | 'seven_day'

export interface AnthropicRateLimitInfo {
  status: string
  resetsAt: number
  rateLimitType: AnthropicRateLimitType
  isUsingOverage?: boolean
  overageStatus?: string
}

export interface AnthropicRateLimitWindow {
  status: string
  resetsAt: number
  isUsingOverage?: boolean
  overageStatus?: string
}

export interface AnthropicRateLimitState {
  fiveHour?: AnthropicRateLimitWindow
  sevenDay?: AnthropicRateLimitWindow
  updatedAt: number
}

export type UsageProvider = 'anthropic' | 'openai'
export type SavedUsageStatus = 'ok' | 'stale' | 'error'

export interface OpenAIUsageData {
  plan_type: string
  rate_limit: {
    primary_window: {
      used_percent: number
      limit_window_seconds: number
      reset_after_seconds: number
      reset_at: number
    } | null
    secondary_window: {
      used_percent: number
      limit_window_seconds: number
      reset_after_seconds: number
      reset_at: number
    } | null
  }
  credits?: { has_credits: boolean; unlimited: boolean; balance: string | null }
}

export interface OpenAIUsageResult {
  success: boolean
  data?: OpenAIUsageData
  error?: string
  rotated?: {
    accessToken: string
    refreshToken: string
    idToken?: string
    /** See `ClaudeRefreshResult.rotatedFrom` — same rationale, Codex side. */
    rotatedFrom: string
  }
  needsLogin?: boolean
}

export interface SavedAccountDTO {
  id: string
  provider: UsageProvider
  email: string
  last_usage: UsageData | OpenAIUsageData | null
  last_fetched_at: string | null
  status: SavedUsageStatus
  last_error: string | null
  created_at: string
  plan: string | null
}

export interface FetchForAccountResult {
  success: boolean
  data?: UsageData | OpenAIUsageData
  error?: string
  retryAfter?: number
  status: SavedUsageStatus
  needsLogin?: boolean
}

export interface RefreshAllResultItem {
  accountId: string
  success: boolean
  error?: string
  retryAfter?: number
}

export type LoginState = 'launching' | 'waiting' | 'exchanging' | 'done' | 'failed' | 'cancelled'

export interface LoginStatusDTO {
  loginId: string
  provider: UsageProvider
  state: LoginState
  email: string | null
  error: string | null
}
