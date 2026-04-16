import { create } from 'zustand'
import type { UsageData, OpenAIUsageData, UsageProvider } from '@shared/types/usage'

export type { UsageData, UsageProvider }

interface UsageState {
  anthropicUsage: UsageData | null
  anthropicLastFetchedAt: number | null
  anthropicIsLoading: boolean

  openaiUsage: OpenAIUsageData | null
  openaiLastFetchedAt: number | null
  openaiIsLoading: boolean

  activeProvider: UsageProvider

  fetchUsageForProvider: (provider: UsageProvider) => Promise<void>
  forceRefreshProvider: (provider: UsageProvider) => Promise<void>
  setActiveProvider: (provider: UsageProvider) => void
  fetchUsage: () => Promise<void>
}

const DEBOUNCE_MS = 180_000 // 3 minutes

export const useUsageStore = create<UsageState>()((set, get) => ({
  anthropicUsage: null,
  anthropicLastFetchedAt: null,
  anthropicIsLoading: false,

  openaiUsage: null,
  openaiLastFetchedAt: null,
  openaiIsLoading: false,

  activeProvider: 'anthropic',

  fetchUsageForProvider: async (provider: UsageProvider) => {
    const state = get()

    if (provider === 'anthropic') {
      if (state.anthropicIsLoading) return
      if (state.anthropicLastFetchedAt && Date.now() - state.anthropicLastFetchedAt < DEBOUNCE_MS)
        return

      set({ anthropicIsLoading: true })
      try {
        const result = await window.usageOps.fetch()
        if (result.success) {
          set({ anthropicUsage: result.data ?? null })
        }
      } finally {
        set({ anthropicIsLoading: false, anthropicLastFetchedAt: Date.now() })
      }
    } else {
      if (state.openaiIsLoading) return
      if (state.openaiLastFetchedAt && Date.now() - state.openaiLastFetchedAt < DEBOUNCE_MS) return

      set({ openaiIsLoading: true })
      try {
        const result = await window.usageOps.fetchOpenai()
        if (result.success) {
          set({ openaiUsage: result.data ?? null })
        }
      } finally {
        set({ openaiIsLoading: false, openaiLastFetchedAt: Date.now() })
      }
    }
  },

  forceRefreshProvider: async (provider: UsageProvider) => {
    const state = get()

    if (provider === 'anthropic') {
      if (state.anthropicIsLoading) return

      set({ anthropicIsLoading: true })
      try {
        const result = await window.usageOps.fetch()
        if (result.success) {
          set({ anthropicUsage: result.data ?? null })
        }
      } finally {
        set({ anthropicIsLoading: false, anthropicLastFetchedAt: Date.now() })
      }
    } else {
      if (state.openaiIsLoading) return

      set({ openaiIsLoading: true })
      try {
        const result = await window.usageOps.fetchOpenai()
        if (result.success) {
          set({ openaiUsage: result.data ?? null })
        }
      } finally {
        set({ openaiIsLoading: false, openaiLastFetchedAt: Date.now() })
      }
    }
  },

  setActiveProvider: (provider: UsageProvider) => {
    set({ activeProvider: provider })

    const state = get()
    const lastFetched =
      provider === 'anthropic' ? state.anthropicLastFetchedAt : state.openaiLastFetchedAt
    const isStale = !lastFetched || Date.now() - lastFetched >= DEBOUNCE_MS

    if (isStale) {
      state.fetchUsageForProvider(provider).catch(() => {})
    }
  },

  fetchUsage: async () => {
    const { activeProvider, fetchUsageForProvider } = get()
    await fetchUsageForProvider(activeProvider)
  }
}))

// --- Exported helpers ---

interface SessionLike {
  agent_sdk?: string | null
  model_provider_id?: string | null
  model_id?: string | null
}

export function resolveUsageProvider(session: SessionLike): UsageProvider {
  if (session.agent_sdk === 'claude-code') return 'anthropic'
  if (session.model_provider_id === 'openai') return 'openai'
  if (session.model_id?.startsWith('gpt')) return 'openai'
  return 'anthropic'
}

export function resolveDefaultUsageProvider(
  agentSdk: 'opencode' | 'claude-code' | 'codex' | 'terminal'
): UsageProvider {
  if (agentSdk === 'codex') return 'openai'
  return 'anthropic'
}

export function normalizeUsage(
  provider: UsageProvider,
  anthropicUsage: UsageData | null | undefined,
  openaiUsage: OpenAIUsageData | null | undefined
): UsageData | null {
  if (provider === 'anthropic') {
    return anthropicUsage ?? null
  }

  if (!openaiUsage) return null

  const rateLimit = openaiUsage.rate_limit
  const primary = rateLimit?.primary_window
  const secondary = rateLimit?.secondary_window

  return {
    five_hour: {
      utilization: primary ? primary.used_percent : 0,
      resets_at: primary ? new Date(primary.reset_at * 1000).toISOString() : ''
    },
    seven_day: {
      utilization: secondary ? secondary.used_percent : 0,
      resets_at: secondary ? new Date(secondary.reset_at * 1000).toISOString() : ''
    }
  }
}
