export interface UsageData {
  five_hour: { utilization: number; resets_at: string }
  seven_day: { utilization: number; resets_at: string }
  extra_usage?: {
    is_enabled: boolean
    utilization: number
    used_credits: number
    monthly_limit: number
  }
}

export interface UsageResult {
  success: boolean
  data?: UsageData
  error?: string
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
  }
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
}

export interface FetchForAccountResult {
  success: boolean
  data?: UsageData | OpenAIUsageData
  error?: string
  status: SavedUsageStatus
}

export interface RefreshAllResultItem {
  accountId: string
  success: boolean
  error?: string
}
