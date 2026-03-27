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
}
