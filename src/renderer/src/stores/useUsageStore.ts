import { create } from 'zustand'
import { type AgentSdk, isClaudeFamily } from '@shared/types/agent-sdk'
import type {
  UsageData,
  AnthropicRateLimitInfo,
  AnthropicRateLimitState,
  OpenAIUsageData,
  UsageProvider,
  SavedAccountDTO
} from '@shared/types/usage'
import { accountApi } from '@/api/account-api'
import { usageApi } from '@/api/usage-api'

export type { UsageData, UsageProvider, AnthropicRateLimitInfo, AnthropicRateLimitState }

interface UsageState {
  anthropicUsage: UsageData | null
  anthropicLastFetchedAt: number | null
  anthropicIsLoading: boolean
  anthropicLastError: string | null
  anthropicLastRetryAfter: number | null
  anthropicRateLimit: AnthropicRateLimitState | null

  openaiUsage: OpenAIUsageData | null
  openaiLastFetchedAt: number | null
  openaiIsLoading: boolean
  openaiLastError: string | null

  activeProvider: UsageProvider
  savedAccounts: Record<UsageProvider, SavedAccountDTO[]>
  savedAccountLoadErrors: Record<UsageProvider, string | null>
  refreshingProviders: Record<UsageProvider, boolean>
  refreshingAccountIds: Set<string>

  loadSavedAccounts: (provider?: UsageProvider) => Promise<void>
  refreshAllForProvider: (provider: UsageProvider) => Promise<void>
  refreshSavedAccount: (id: string) => Promise<void>
  removeSavedAccount: (id: string) => Promise<void>
  fetchUsageForProvider: (provider: UsageProvider) => Promise<void>
  forceRefreshProvider: (provider: UsageProvider) => Promise<void>
  setActiveProvider: (provider: UsageProvider) => void
  setAnthropicRateLimit: (info: AnthropicRateLimitInfo) => void
  fetchUsage: () => Promise<void>
}

const DEBOUNCE_MS = 180_000 // 3 minutes
const FORCE_REFRESH_FLOOR_MS = 5_000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function retryAfterFetchedAt(retryAfter: number | undefined): number | null {
  return retryAfter === undefined ? null : Date.now() - DEBOUNCE_MS + retryAfter * 1000
}

export const useUsageStore = create<UsageState>()((set, get) => ({
  anthropicUsage: null,
  anthropicLastFetchedAt: null,
  anthropicIsLoading: false,
  anthropicLastError: null,
  anthropicLastRetryAfter: null,
  anthropicRateLimit: null,

  openaiUsage: null,
  openaiLastFetchedAt: null,
  openaiIsLoading: false,
  openaiLastError: null,

  activeProvider: 'anthropic',
  savedAccounts: { anthropic: [], openai: [] },
  savedAccountLoadErrors: { anthropic: null, openai: null },
  refreshingProviders: { anthropic: false, openai: false },
  refreshingAccountIds: new Set<string>(),

  loadSavedAccounts: async (provider?: UsageProvider) => {
    try {
      const accounts = await accountApi.listSaved(provider)
      if (provider) {
        set((state) => ({
          savedAccounts: { ...state.savedAccounts, [provider]: accounts },
          savedAccountLoadErrors: { ...state.savedAccountLoadErrors, [provider]: null }
        }))
        return
      }

      set({
        savedAccounts: {
          anthropic: accounts.filter((account) => account.provider === 'anthropic'),
          openai: accounts.filter((account) => account.provider === 'openai')
        },
        savedAccountLoadErrors: { anthropic: null, openai: null }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (provider) {
        set((state) => ({
          savedAccountLoadErrors: { ...state.savedAccountLoadErrors, [provider]: message }
        }))
      } else {
        set({
          savedAccountLoadErrors: { anthropic: message, openai: message }
        })
      }
      throw error
    }
  },

  refreshAllForProvider: async (provider: UsageProvider) => {
    const state = get()
    if (state.refreshingProviders[provider]) return

    const accountIds = state.savedAccounts[provider].map((account) => account.id)
    set((current) => ({
      refreshingProviders: { ...current.refreshingProviders, [provider]: true },
      refreshingAccountIds: new Set([...current.refreshingAccountIds, ...accountIds])
    }))

    try {
      await usageApi.refreshAllForProvider(provider)
      await get().loadSavedAccounts(provider)
    } finally {
      set((current) => {
        const nextIds = new Set(current.refreshingAccountIds)
        accountIds.forEach((id) => nextIds.delete(id))
        return {
          refreshingProviders: { ...current.refreshingProviders, [provider]: false },
          refreshingAccountIds: nextIds
        }
      })
    }
  },

  refreshSavedAccount: async (id: string) => {
    const state = get()
    const provider = (['anthropic', 'openai'] as UsageProvider[]).find((p) =>
      state.savedAccounts[p].some((account) => account.id === id)
    )

    set((current) => ({
      refreshingAccountIds: new Set([...current.refreshingAccountIds, id])
    }))
    try {
      await usageApi.fetchForAccount(id)
      await get().loadSavedAccounts(provider)
    } finally {
      set((current) => {
        const nextIds = new Set(current.refreshingAccountIds)
        nextIds.delete(id)
        return { refreshingAccountIds: nextIds }
      })
    }
  },

  removeSavedAccount: async (id: string) => {
    await accountApi.removeSaved(id)
    await get().loadSavedAccounts()
  },

  fetchUsageForProvider: async (provider: UsageProvider) => {
    const state = get()

    if (provider === 'anthropic') {
      if (state.anthropicIsLoading) return
      if (state.anthropicLastFetchedAt && Date.now() - state.anthropicLastFetchedAt < DEBOUNCE_MS)
        return

      set({ anthropicIsLoading: true, anthropicLastError: null })
      let succeeded = false
      try {
        const result = await usageApi.fetch()
        if (result.success) {
          set({
            anthropicUsage: result.data ?? null,
            anthropicLastError: null,
            anthropicLastRetryAfter: null
          })
          succeeded = true
          get()
            .loadSavedAccounts(provider)
            .catch(() => {})
        } else {
          const retryFetchedAt = retryAfterFetchedAt(result.retryAfter)
          set({
            anthropicLastError: result.error ?? 'Unknown error',
            anthropicLastRetryAfter: result.retryAfter ?? null,
            ...(retryFetchedAt !== null ? { anthropicLastFetchedAt: retryFetchedAt } : {})
          })
        }
      } catch (err) {
        set({ anthropicLastError: errorMessage(err), anthropicLastRetryAfter: null })
      } finally {
        set({
          anthropicIsLoading: false,
          ...(succeeded ? { anthropicLastFetchedAt: Date.now() } : {})
        })
      }
    } else {
      if (state.openaiIsLoading) return
      if (state.openaiLastFetchedAt && Date.now() - state.openaiLastFetchedAt < DEBOUNCE_MS) return

      set({ openaiIsLoading: true, openaiLastError: null })
      let succeeded = false
      try {
        const result = await usageApi.fetchOpenai()
        if (result.success) {
          set({ openaiUsage: result.data ?? null, openaiLastError: null })
          succeeded = true
          get()
            .loadSavedAccounts(provider)
            .catch(() => {})
        } else {
          set({ openaiLastError: result.error ?? 'Unknown error' })
        }
      } catch (err) {
        set({ openaiLastError: errorMessage(err) })
      } finally {
        set({
          openaiIsLoading: false,
          ...(succeeded ? { openaiLastFetchedAt: Date.now() } : {})
        })
      }
    }
  },

  forceRefreshProvider: async (provider: UsageProvider) => {
    const state = get()

    if (provider === 'anthropic') {
      if (state.anthropicIsLoading) return
      if (
        state.anthropicLastRetryAfter !== null &&
        state.anthropicLastFetchedAt &&
        Date.now() - state.anthropicLastFetchedAt < DEBOUNCE_MS
      )
        return
      if (
        state.anthropicLastFetchedAt &&
        state.anthropicLastError === null &&
        Date.now() - state.anthropicLastFetchedAt < FORCE_REFRESH_FLOOR_MS
      )
        return

      set({ anthropicIsLoading: true, anthropicLastError: null })
      let succeeded = false
      try {
        const result = await usageApi.fetch()
        if (result.success) {
          set({
            anthropicUsage: result.data ?? null,
            anthropicLastError: null,
            anthropicLastRetryAfter: null
          })
          succeeded = true
          get()
            .loadSavedAccounts(provider)
            .catch(() => {})
        } else {
          const retryFetchedAt = retryAfterFetchedAt(result.retryAfter)
          set({
            anthropicLastError: result.error ?? 'Unknown error',
            anthropicLastRetryAfter: result.retryAfter ?? null,
            ...(retryFetchedAt !== null ? { anthropicLastFetchedAt: retryFetchedAt } : {})
          })
        }
      } catch (err) {
        set({ anthropicLastError: errorMessage(err), anthropicLastRetryAfter: null })
      } finally {
        set({
          anthropicIsLoading: false,
          ...(succeeded ? { anthropicLastFetchedAt: Date.now() } : {})
        })
      }
    } else {
      if (state.openaiIsLoading) return

      set({ openaiIsLoading: true, openaiLastError: null })
      let succeeded = false
      try {
        const result = await usageApi.fetchOpenai()
        if (result.success) {
          set({ openaiUsage: result.data ?? null, openaiLastError: null })
          succeeded = true
          get()
            .loadSavedAccounts(provider)
            .catch(() => {})
        } else {
          set({ openaiLastError: result.error ?? 'Unknown error' })
        }
      } catch (err) {
        set({ openaiLastError: errorMessage(err) })
      } finally {
        set({
          openaiIsLoading: false,
          ...(succeeded ? { openaiLastFetchedAt: Date.now() } : {})
        })
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

  setAnthropicRateLimit: (info: AnthropicRateLimitInfo) => {
    set((state) => {
      const now = Date.now()
      const nowSeconds = now / 1000
      const current = state.anthropicRateLimit
      const next: AnthropicRateLimitState = {
        ...(current ?? { updatedAt: now }),
        updatedAt: now
      }

      const windowKey = info.rateLimitType === 'five_hour' ? 'fiveHour' : 'sevenDay'
      if (info.resetsAt >= nowSeconds) {
        next[windowKey] = {
          status: info.status,
          resetsAt: info.resetsAt,
          isUsingOverage: info.isUsingOverage,
          overageStatus: info.overageStatus
        }
      } else {
        delete next[windowKey]
      }

      if (next.fiveHour?.resetsAt !== undefined && next.fiveHour.resetsAt < nowSeconds) {
        delete next.fiveHour
      }
      if (next.sevenDay?.resetsAt !== undefined && next.sevenDay.resetsAt < nowSeconds) {
        delete next.sevenDay
      }

      return {
        anthropicRateLimit: next.fiveHour || next.sevenDay ? next : null,
        anthropicLastFetchedAt: now
      }
    })
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
  if (isClaudeFamily(session.agent_sdk)) {
    return 'anthropic'
  }
  if (session.model_provider_id === 'openai') return 'openai'
  if (session.model_id?.startsWith('gpt')) return 'openai'
  return 'anthropic'
}

export function resolveDefaultUsageProvider(
  agentSdk: AgentSdk
): UsageProvider {
  if (agentSdk === 'codex') return 'openai'
  return 'anthropic'
}

function hasUsageWindow(value: unknown): value is { utilization: number; resets_at: string } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.utilization === 'number' && typeof record.resets_at === 'string'
}

function isAnthropicUsageData(value: unknown): value is UsageData {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return hasUsageWindow(record.five_hour) && hasUsageWindow(record.seven_day)
}

export function normalizeUsage(
  provider: UsageProvider,
  anthropicUsage: UsageData | null | undefined,
  openaiUsage: OpenAIUsageData | null | undefined
): UsageData | null {
  if (provider === 'anthropic') {
    return isAnthropicUsageData(anthropicUsage) ? anthropicUsage : null
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
