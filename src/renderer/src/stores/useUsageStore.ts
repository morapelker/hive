import { create } from 'zustand'
import { type AgentSdk, isClaudeFamily, isCodexFamily } from '@shared/types/agent-sdk'
import {
  customProviderUsageToUsageProvider,
  findCustomProvider
} from '@shared/types/custom-provider'
import type {
  UsageData,
  UsageWindow,
  AnthropicRateLimitInfo,
  AnthropicRateLimitState,
  OpenAIUsageData,
  UsageProvider,
  SavedAccountDTO,
  RefreshAllResultItem
} from '@shared/types/usage'
import type { ClaudeLiveUsagePayload } from '@shared/types/claude-live-usage'
import { accountApi } from '@/api/account-api'
import { usageApi } from '@/api/usage-api'
import { reportActiveAccountsSnapshot } from '@/lib/hive-account-report'
import { toast } from '@/lib/toast'
import { useLoginStore } from './useLoginStore'
import { useAccountStore } from './useAccountStore'
import { useSettingsStore } from './useSettingsStore'

export type { UsageData, UsageProvider, AnthropicRateLimitInfo, AnthropicRateLimitState }

interface UsageState {
  anthropicUsage: UsageData | null
  anthropicLastFetchedAt: number | null
  anthropicIsLoading: boolean
  anthropicLastError: string | null
  anthropicLastRetryAfter: number | null
  anthropicRateLimit: AnthropicRateLimitState | null
  /** True when the CURRENT anthropicUsage object was produced by a live
   * usage fetch of the active account; false when it was seeded from a saved
   * account's cache (post-switch). A property of the object itself — not of
   * event ordering — so the burn-rate predictor can decide "anchor and
   * calibrate" vs "re-anchor only" without inferring history from
   * timestamps (which retryAfter back-dating corrupts) or counters (which
   * fetches outside the predictor's observation window desynchronize). */
  anthropicUsageFromFetch: boolean
  /** Epoch ms of the last successful anthropic account switch. Sessions
   * created before this hold the PREVIOUS account's credentials — their
   * rate-limit events must not be attributed to the current account. */
  anthropicAccountSwitchedAt: number | null
  /** Last time ANY early-refresh trigger (rate-limit event or the burn-rate
   * predictor) attempted a fetch. One shared timestamp floors all early
   * paths together: during a failure storm lastFetchedAt never advances,
   * and per-path floors would let the paths pair up requests under the
   * advertised 30s endpoint floor. */
  anthropicEarlyRefreshAttemptAt: number | null
  /** Epoch ms of the last live (proxy-observed) usage update applied to the
   * ACTIVE account. While recent, the polled refresh cadence and the burn-rate
   * predictor stand down: every API response already brings exact numbers. */
  anthropicLiveUpdatedAt: number | null

  openaiUsage: OpenAIUsageData | null
  openaiLastFetchedAt: number | null
  openaiIsLoading: boolean
  openaiLastError: string | null

  activeProvider: UsageProvider
  savedAccounts: Record<UsageProvider, SavedAccountDTO[]>
  /** True once savedAccounts[provider] reflects a successful load — an empty
   * list is only meaningful (e.g. "the account really is gone") when set. */
  savedAccountsLoaded: Record<UsageProvider, boolean>
  savedAccountLoadErrors: Record<UsageProvider, string | null>
  refreshingProviders: Record<UsageProvider, boolean>
  refreshingAccountIds: Set<string>
  removingAccountIds: Set<string>
  switchingAccountIds: Set<string>

  loadSavedAccounts: (provider?: UsageProvider) => Promise<void>
  /** Resolves with the per-account fetch outcomes, or null when a sweep for
   * the provider was already running (nothing was refreshed by this call). */
  refreshAllForProvider: (
    provider: UsageProvider,
    excludeAccountIds?: string[],
    opts?: { maxAgeMs?: number }
  ) => Promise<RefreshAllResultItem[] | null>
  refreshSavedAccount: (id: string, opts?: { userInitiated?: boolean }) => Promise<void>
  removeSavedAccount: (id: string) => Promise<void>
  /** Resolves true when the switch op succeeded (failures also toast). */
  switchAccount: (id: string) => Promise<boolean>
  /** opts.minIntervalMs overrides the 3-minute debounce floor (still never
   * fetching more often than the given interval) — used by the burn-rate
   * predictor and rate-limit events for targeted early refreshes. */
  fetchUsageForProvider: (
    provider: UsageProvider,
    opts?: { minIntervalMs?: number }
  ) => Promise<void>
  forceRefreshProvider: (provider: UsageProvider) => Promise<void>
  setActiveProvider: (provider: UsageProvider) => void
  /** opts.triggerRefresh (default true): a warning/rejected window pulls a
   * fresh usage snapshot; the live proxy path passes false — its numbers are
   * already current. */
  setAnthropicRateLimit: (info: AnthropicRateLimitInfo, opts?: { triggerRefresh?: boolean }) => void
  /** A per-response usage update from the local Claude API proxy, already
   * attributed to the account whose credentials made the request. Updates
   * that account's saved row; mirrors into the live slot only when it is the
   * active account. */
  applyClaudeLiveUsage: (payload: ClaudeLiveUsagePayload) => void
  /** Called when the active Anthropic identity changed hands OUTSIDE a
   * Hive-initiated switch (external `claude login` observed via an email
   * change). Applies the same invalidation an internal switch does. */
  noteExternalAnthropicAccountSwitch: () => void
  fetchUsage: () => Promise<void>
}

// Exported so the popover's "Refreshing in…" countdown can model the floor
// this debounce puts under the scheduled refresh cadence.
export const USAGE_FETCH_DEBOUNCE_MS = 180_000 // 3 minutes
const DEBOUNCE_MS = USAGE_FETCH_DEBOUNCE_MS

// Floor for predictor/rate-limit-event driven early refreshes: they may
// bypass the 3-minute debounce, but never hit the usage endpoint more often
// than this.
export const EARLY_USAGE_REFRESH_FLOOR_MS = 30_000

// How long a live (proxy-observed) usage update counts as current. Within
// this window the usage popover says "Live" instead of counting down to the
// next poll and the burn-rate predictor skips its early sampling.
export const LIVE_USAGE_FRESH_MS = 2 * 60_000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function providerLabel(provider: UsageProvider): string {
  return provider === 'anthropic' ? 'Claude' : 'OpenAI'
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
  anthropicUsageFromFetch: false,
  anthropicAccountSwitchedAt: null,
  anthropicEarlyRefreshAttemptAt: null,
  anthropicLiveUpdatedAt: null,

  openaiUsage: null,
  openaiLastFetchedAt: null,
  openaiIsLoading: false,
  openaiLastError: null,

  activeProvider: 'anthropic',
  savedAccounts: { anthropic: [], openai: [] },
  savedAccountsLoaded: { anthropic: false, openai: false },
  savedAccountLoadErrors: { anthropic: null, openai: null },
  refreshingProviders: { anthropic: false, openai: false },
  refreshingAccountIds: new Set<string>(),
  removingAccountIds: new Set<string>(),
  switchingAccountIds: new Set<string>(),

  loadSavedAccounts: async (provider?: UsageProvider) => {
    try {
      const accounts = await accountApi.listSaved(provider)
      if (provider) {
        set((state) => ({
          savedAccounts: { ...state.savedAccounts, [provider]: accounts },
          savedAccountsLoaded: { ...state.savedAccountsLoaded, [provider]: true },
          savedAccountLoadErrors: { ...state.savedAccountLoadErrors, [provider]: null }
        }))
        return
      }

      set({
        savedAccounts: {
          anthropic: accounts.filter((account) => account.provider === 'anthropic'),
          openai: accounts.filter((account) => account.provider === 'openai')
        },
        savedAccountsLoaded: { anthropic: true, openai: true },
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

  refreshAllForProvider: async (
    provider: UsageProvider,
    excludeAccountIds?: string[],
    opts?: { maxAgeMs?: number }
  ) => {
    const state = get()
    if (state.refreshingProviders[provider]) return null

    const excluded = new Set(excludeAccountIds ?? [])
    const accountIds = state.savedAccounts[provider]
      .filter((account) => !excluded.has(account.id))
      .map((account) => account.id)
    set((current) => ({
      refreshingProviders: { ...current.refreshingProviders, [provider]: true },
      refreshingAccountIds: new Set([...current.refreshingAccountIds, ...accountIds])
    }))

    try {
      const results = await usageApi.refreshAllForProvider(
        provider,
        excludeAccountIds,
        opts?.maxAgeMs
      )
      await get().loadSavedAccounts(provider)
      return results
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

  refreshSavedAccount: async (id: string, opts?: { userInitiated?: boolean }) => {
    const state = get()
    const provider = (['anthropic', 'openai'] as UsageProvider[]).find((p) =>
      state.savedAccounts[p].some((account) => account.id === id)
    )
    const userInitiated = opts?.userInitiated ?? false
    const account = provider ? state.savedAccounts[provider].find((a) => a.id === id) : undefined

    set((current) => ({
      refreshingAccountIds: new Set([...current.refreshingAccountIds, id])
    }))
    // Guards the live-usage mirror below: a switch completing while this
    // request is in flight means the response may describe an account that
    // is no longer active — and the active-email read alone can miss that
    // (the post-switch email refresh is itself async).
    const switchEpoch = get().anthropicAccountSwitchedAt
    try {
      const result = await usageApi.fetchForAccount(id, userInitiated)
      const switchedMidFlight =
        provider === 'anthropic' && get().anthropicAccountSwitchedAt !== switchEpoch
      if (result.success && result.data && provider && account && !switchedMidFlight) {
        // The bottom usage bar reads the provider's live usage, not the saved
        // account row — when the refreshed account is the active one, mirror
        // the fresh data so both views agree. Re-read the LIVE identity
        // first: the cached email can lag an external `claude login`
        // performed outside Hive, which no switch epoch covers.
        await useAccountStore
          .getState()
          .fetchEmail(provider)
          .catch(() => {})
        const accountState = useAccountStore.getState()
        const activeEmail =
          provider === 'anthropic' ? accountState.anthropicEmail : accountState.openaiEmail
        if (activeEmail !== null && activeEmail === account.email) {
          if (provider === 'anthropic') {
            set({
              anthropicUsage: result.data as UsageData,
              anthropicLastError: null,
              anthropicLastRetryAfter: null,
              anthropicLastFetchedAt: Date.now(),
              anthropicUsageFromFetch: true
            })
          } else {
            set({
              openaiUsage: result.data as OpenAIUsageData,
              openaiLastError: null,
              openaiLastFetchedAt: Date.now()
            })
          }
        }
      }
      if (result.needsLogin && userInitiated && provider) {
        useLoginStore
          .getState()
          .startLogin(provider, account?.email)
          .catch(() => {})
      } else if (!result.success && userInitiated) {
        toast.error(
          `${providerLabel(provider ?? 'anthropic')} account refresh failed: ${result.error ?? 'Unknown error'}`
        )
      }
    } catch (err) {
      if (userInitiated) {
        toast.error(
          `${providerLabel(provider ?? 'anthropic')} account refresh failed: ${errorMessage(err)}`
        )
      }
    } finally {
      // Reload in its own catch so a reload hiccup after a SUCCESSFUL fetch
      // can't reach the catch above and mis-toast a 'refresh failed'.
      await get()
        .loadSavedAccounts(provider)
        .catch(() => {})
      set((current) => {
        const nextIds = new Set(current.refreshingAccountIds)
        nextIds.delete(id)
        return { refreshingAccountIds: nextIds }
      })
    }
  },

  removeSavedAccount: async (id: string) => {
    const state = get()
    const provider = (['anthropic', 'openai'] as UsageProvider[]).find((p) =>
      state.savedAccounts[p].some((account) => account.id === id)
    )
    const account = provider ? state.savedAccounts[provider].find((a) => a.id === id) : undefined

    set((current) => ({
      removingAccountIds: new Set([...current.removingAccountIds, id])
    }))
    try {
      await accountApi.removeSaved(id)
      toast.success(`Removed ${account?.email ?? 'account'}`)
    } catch (err) {
      toast.error(`Failed to remove account: ${errorMessage(err)}`)
    } finally {
      set((current) => {
        const nextIds = new Set(current.removingAccountIds)
        nextIds.delete(id)
        return { removingAccountIds: nextIds }
      })
      await get()
        .loadSavedAccounts(provider)
        .catch(() => {})
    }
  },

  switchAccount: async (id: string) => {
    const state = get()
    const provider = (['anthropic', 'openai'] as UsageProvider[]).find((p) =>
      state.savedAccounts[p].some((account) => account.id === id)
    )
    const account = provider ? state.savedAccounts[provider].find((a) => a.id === id) : undefined

    set((current) => ({
      switchingAccountIds: new Set([...current.switchingAccountIds, id])
    }))
    try {
      const result = await accountApi.switchAccount(id)
      if (result.success) {
        // Toast success off the op result FIRST — before the post-switch
        // reloads, each wrapped in its own catch so a reload hiccup after a
        // SUCCESSFUL switch can't reach the catch below and mis-toast a
        // 'Switch failed'.
        toast.success(`Switched to ${account?.email ?? 'account'}`)
        if (provider === 'anthropic') {
          // The rate-limit overlay (and its rejected=100% signal) belongs to
          // the account we just left — clearing it stops an immediate
          // re-trigger against the fresh account. The switch timestamp lets
          // the event listener keep ignoring late events from sessions that
          // still hold the previous account's credentials. And the current
          // usage object no longer describes the live account, so it must
          // not pass for fetch data: a switch without a seed (manual,
          // scheduled, or a target with no cached usage) would otherwise let
          // the predictor anchor the OLD account's percent as a calibration
          // baseline for the new account's first fetch.
          // All fetch gates are per-ACCOUNT state: the old account's 429
          // Retry-After (and its back-dated debounce timestamp) or a burned
          // event-attempt slot must not delay sampling the account we just
          // switched to.
          set({
            anthropicRateLimit: null,
            anthropicAccountSwitchedAt: Date.now(),
            anthropicUsageFromFetch: false,
            anthropicLastRetryAfter: null,
            anthropicLastFetchedAt: null,
            anthropicEarlyRefreshAttemptAt: null,
            anthropicLiveUpdatedAt: null
          })
        }
        if (provider) {
          await useAccountStore
            .getState()
            .fetchEmail(provider)
            .catch(() => {})
          void reportActiveAccountsSnapshot()
          await get()
            .loadSavedAccounts(provider)
            .catch(() => {})
          get()
            .forceRefreshProvider(provider)
            .catch(() => {})
        }
        return true
      } else {
        toast.error(`Switch failed: ${result.error ?? 'Unknown error'}`)
      }
    } catch (err) {
      toast.error(`Switch failed: ${errorMessage(err)}`)
    } finally {
      set((current) => {
        const nextIds = new Set(current.switchingAccountIds)
        nextIds.delete(id)
        return { switchingAccountIds: nextIds }
      })
    }
    return false
  },

  fetchUsageForProvider: async (provider: UsageProvider, opts?: { minIntervalMs?: number }) => {
    const state = get()
    const minIntervalMs = opts?.minIntervalMs ?? DEBOUNCE_MS

    if (provider === 'anthropic') {
      if (state.anthropicIsLoading) return
      // A pending Retry-After deadline was encoded against the FULL debounce
      // (retryAfterFetchedAt back-dates lastFetchedAt so that
      // fetchedAt + DEBOUNCE_MS = deadline) — a shorter predictor/rate-limit
      // floor must not cut it open, or we hammer an endpoint that just told
      // us to wait.
      const effectiveMinMs = state.anthropicLastRetryAfter !== null ? DEBOUNCE_MS : minIntervalMs
      if (
        state.anthropicLastFetchedAt &&
        Date.now() - state.anthropicLastFetchedAt < effectiveMinMs
      )
        return

      set({ anthropicIsLoading: true, anthropicLastError: null })
      let succeeded = false
      let discardedStale = false
      // Guard against a switch completing while this request is in flight:
      // the response then describes the account we just LEFT, and applying
      // it would restore the old account's numbers as live fetch data.
      const switchEpoch = get().anthropicAccountSwitchedAt
      try {
        const result = await usageApi.fetch()
        if (get().anthropicAccountSwitchedAt !== switchEpoch) {
          discardedStale = true
          return
        }
        if (result.success) {
          set({
            anthropicUsage: result.data ?? null,
            anthropicLastError: null,
            anthropicLastRetryAfter: null,
            anthropicUsageFromFetch: true
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
        // The switch's own forceRefreshProvider no-oped on our loading flag,
        // and the discarded response applied nothing — refetch the NEW
        // account now that the slot is free, or seeded/blank usage would
        // linger until some other trigger fires.
        if (discardedStale) {
          get()
            .fetchUsageForProvider('anthropic', { minIntervalMs: EARLY_USAGE_REFRESH_FLOOR_MS })
            .catch(() => {})
        }
      }
    } else {
      if (state.openaiIsLoading) return
      if (state.openaiLastFetchedAt && Date.now() - state.openaiLastFetchedAt < minIntervalMs)
        return

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
      ) {
        const remainingMs = state.anthropicLastFetchedAt + DEBOUNCE_MS - Date.now()
        const retrySeconds = Math.max(1, Math.ceil(remainingMs / 1000))
        toast.error(`Rate limited — retry in ${retrySeconds}s`)
        return
      }

      set({ anthropicIsLoading: true, anthropicLastError: null })
      let succeeded = false
      let discardedStale = false
      // Guard against a switch completing while this request is in flight:
      // the response then describes the account we just LEFT, and applying
      // it would restore the old account's numbers as live fetch data.
      const switchEpoch = get().anthropicAccountSwitchedAt
      try {
        const result = await usageApi.fetch()
        if (get().anthropicAccountSwitchedAt !== switchEpoch) {
          discardedStale = true
          return
        }
        if (result.success) {
          set({
            anthropicUsage: result.data ?? null,
            anthropicLastError: null,
            anthropicLastRetryAfter: null,
            anthropicUsageFromFetch: true
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
          toast.error(
            `${providerLabel(provider)} usage refresh failed: ${result.error ?? 'Unknown error'}`
          )
        }
      } catch (err) {
        const message = errorMessage(err)
        set({ anthropicLastError: message, anthropicLastRetryAfter: null })
        toast.error(`${providerLabel(provider)} usage refresh failed: ${message}`)
      } finally {
        set({
          anthropicIsLoading: false,
          ...(succeeded ? { anthropicLastFetchedAt: Date.now() } : {})
        })
        // See fetchUsageForProvider: a discarded stale response must hand
        // its loading slot to a fresh fetch of the new account.
        if (discardedStale) {
          get()
            .fetchUsageForProvider('anthropic', { minIntervalMs: EARLY_USAGE_REFRESH_FLOOR_MS })
            .catch(() => {})
        }
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
          toast.error(
            `${providerLabel(provider)} usage refresh failed: ${result.error ?? 'Unknown error'}`
          )
        }
      } catch (err) {
        const message = errorMessage(err)
        set({ openaiLastError: message })
        toast.error(`${providerLabel(provider)} usage refresh failed: ${message}`)
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

  setAnthropicRateLimit: (info: AnthropicRateLimitInfo, opts?: { triggerRefresh?: boolean }) => {
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
        anthropicRateLimit: next.fiveHour || next.sevenDay ? next : null
      }
    })
    // A warning/rejected event means the polled snapshot is behind reality —
    // pull a fresh one now (floored, so an event storm can't hammer the
    // endpoint) instead of extending the debounce and flying blind. The
    // fresh percent is what lets the auto-switcher fire before/at exhaustion.
    // The floor gates on ATTEMPT time: failed fetches never advance
    // lastFetchedAt, and an event storm against a failing endpoint would
    // otherwise retry on every single event.
    if (info.status !== 'allowed' && opts?.triggerRefresh !== false) {
      const nowMs = Date.now()
      const {
        anthropicEarlyRefreshAttemptAt: lastAttempt,
        anthropicLastFetchedAt,
        anthropicLastRetryAfter,
        anthropicIsLoading
      } = get()
      // Only record an attempt when the fetch itself would actually run —
      // mirroring ALL of its gates (the Retry-After path enforces the full
      // debounce, and an in-flight fetch no-ops). Burning the attempt slot
      // on a guaranteed no-op would defer the next real sample by up to
      // another full floor while usage is climbing.
      const fetchFloorMs =
        anthropicLastRetryAfter !== null ? DEBOUNCE_MS : EARLY_USAGE_REFRESH_FLOOR_MS
      const fetchGateOpen =
        !anthropicIsLoading &&
        (anthropicLastFetchedAt === null || nowMs - anthropicLastFetchedAt >= fetchFloorMs)
      if (
        fetchGateOpen &&
        (lastAttempt === null || nowMs - lastAttempt >= EARLY_USAGE_REFRESH_FLOOR_MS)
      ) {
        set({ anthropicEarlyRefreshAttemptAt: nowMs })
        get()
          .fetchUsageForProvider('anthropic', { minIntervalMs: EARLY_USAGE_REFRESH_FLOOR_MS })
          .catch(() => {})
      }
    }
  },

  noteExternalAnthropicAccountSwitch: () => {
    // An internal switch just marked the epoch and its own email refresh is
    // what surfaced the change — don't re-mark, or the post-switch fetch's
    // provenance (and its freshly cleared gates) would be wiped again.
    const lastSwitch = get().anthropicAccountSwitchedAt
    if (lastSwitch !== null && Date.now() - lastSwitch < 5_000) return
    set({
      anthropicRateLimit: null,
      anthropicAccountSwitchedAt: Date.now(),
      anthropicUsageFromFetch: false,
      anthropicLastRetryAfter: null,
      anthropicLastFetchedAt: null,
      anthropicEarlyRefreshAttemptAt: null,
      anthropicLiveUpdatedAt: null
    })
  },

  applyClaudeLiveUsage: (payload: ClaudeLiveUsagePayload) => {
    if (payload.provider !== 'anthropic') return
    const email = payload.email.toLowerCase()

    // 1. The attributed account's row in the popover — every account, active
    //    or not, since a session can keep streaming on the account the user
    //    just switched away from. Only the usage snapshot changes: the row's
    //    last_fetched_at/status describe the usage-endpoint poll, which still
    //    owns the fields the response headers lack (extra usage, per-model
    //    windows) and must keep running on its own clock.
    let rowFound = false
    set((state) => {
      const rows = state.savedAccounts.anthropic
      const index = rows.findIndex(
        (row) => row.id === payload.accountId || row.email.toLowerCase() === email
      )
      if (index === -1) return {}
      rowFound = true
      const next = [...rows]
      next[index] = { ...rows[index], last_usage: payload.usage }
      return { savedAccounts: { ...state.savedAccounts, anthropic: next } }
    })
    if (!rowFound && get().savedAccountsLoaded.anthropic) {
      // A row the list has not seen yet (first request of a freshly captured
      // account): pull the list so it appears with its usage.
      get()
        .loadSavedAccounts('anthropic')
        .catch(() => {})
    }

    // 2. The live slot behind the bottom bar — only for the account that is
    //    signed in NOW. Decided in the main process against the CLI's own
    //    identity file (rewritten by a switch before it reports success), so
    //    an in-flight session on the account we just left can never repaint
    //    the bar or re-arm its rejected overlay against the new account.
    if (!payload.isLiveAccount) return
    const switchedAt = get().anthropicAccountSwitchedAt
    // Observed before this renderer stamped its switch: the main-side
    // liveness verdict predates the switch (coalescing adds latency), so the
    // data may describe the previous account. Drop it; the next response on
    // the new account arrives within seconds.
    if (switchedAt !== null && payload.observedAt < switchedAt) return

    if (
      payload.liveEmail !== null &&
      useAccountStore.getState().anthropicEmail !== payload.liveEmail
    ) {
      // The cached active email lags (switch still refreshing it, or an
      // external `claude login`): the identity file is authoritative. An
      // email-to-email change drives the external-switch invalidation.
      useAccountStore.setState({ anthropicEmail: payload.liveEmail })
    }

    const now = Date.now()
    // Not anthropicLastFetchedAt / anthropicLastRetryAfter: those gate the
    // usage-endpoint poll, which must keep its cadence (and its Retry-After
    // back-dating) while live data flows — a /v1/messages response says
    // nothing about that endpoint's own throttle, so its error stays
    // visible until the deadline passes.
    set((state) => {
      const retryPending =
        state.anthropicLastRetryAfter !== null &&
        state.anthropicLastFetchedAt !== null &&
        now - state.anthropicLastFetchedAt < DEBOUNCE_MS
      return {
        anthropicUsage: payload.usage,
        anthropicUsageFromFetch: true,
        anthropicLiveUpdatedAt: now,
        ...(retryPending ? {} : { anthropicLastError: null })
      }
    })
    // Per-window status/reset for the overlay (also what clears a stale
    // rejected overlay once a window is allowed again). No early poll: the
    // numbers that poll would fetch are the ones we just applied.
    const { fiveHour, sevenDay } = payload.rateLimit
    if (fiveHour) {
      get().setAnthropicRateLimit(
        { ...fiveHour, rateLimitType: 'five_hour' },
        { triggerRefresh: false }
      )
    }
    if (sevenDay) {
      get().setAnthropicRateLimit(
        { ...sevenDay, rateLimitType: 'seven_day' },
        { triggerRefresh: false }
      )
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
  custom_provider_id?: string | null
  model_provider_id?: string | null
  model_id?: string | null
}

/**
 * Resolve a custom claude-cli provider's usage attribution from settings.
 * Returns undefined when the id doesn't reference a launchable provider
 * (deleted, stale, or blank command — the spawn degrades those to plain
 * claude) so callers fall back to the plain agent-SDK resolution.
 */
function resolveCustomProviderUsage(
  customProviderId: string | null | undefined
): UsageProvider | null | undefined {
  if (!customProviderId) return undefined
  const provider = findCustomProvider(useSettingsStore.getState().customProviders, customProviderId)
  if (!provider || !provider.command.trim()) return undefined
  return customProviderUsageToUsageProvider(provider.usageProvider)
}

/** Null means "no usage account to refresh" (custom provider attributed to none). */
export function resolveUsageProvider(session: SessionLike): UsageProvider | null {
  const customUsage = resolveCustomProviderUsage(session.custom_provider_id)
  if (customUsage !== undefined) return customUsage
  if (isClaudeFamily(session.agent_sdk)) {
    return 'anthropic'
  }
  if (isCodexFamily(session.agent_sdk)) return 'openai'
  if (session.model_provider_id === 'openai') return 'openai'
  if (session.model_id?.startsWith('gpt')) return 'openai'
  return 'anthropic'
}

/** Null means "no usage account to refresh" (custom provider attributed to none). */
export function resolveDefaultUsageProvider(
  agentSdk: AgentSdk,
  customProviderId?: string | null
): UsageProvider | null {
  const customUsage = resolveCustomProviderUsage(customProviderId)
  if (customUsage !== undefined) return customUsage
  if (isCodexFamily(agentSdk)) return 'openai'
  return 'anthropic'
}

function hasUsageWindow(value: unknown): value is UsageWindow {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  // resets_at is legitimately null (or absent) for a window with no active
  // session — the API sends { utilization: 0, resets_at: null } for an idle
  // 5h window. Only reject a present, non-string, non-null resets_at.
  return (
    typeof record.utilization === 'number' &&
    (record.resets_at === null ||
      record.resets_at === undefined ||
      typeof record.resets_at === 'string')
  )
}

/**
 * A window slot as `/api/oauth/usage` sends it: a window object, or null when
 * the plan has no such window — Anthropic dropped the 5h limit from many
 * plans, and those accounts get `five_hour: null`. Null is a valid, meaningful
 * value here ("no window"), not a missing one, so it must not reject the body.
 */
function isUsageWindowOrNull(value: unknown): value is UsageWindow | null {
  return value === null || hasUsageWindow(value)
}

function isAnthropicUsageData(value: unknown): value is UsageData {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  // Both keys must be PRESENT: the usage endpoint always sends them (each an
  // object or null), so a body missing either is not usage at all — e.g. an
  // error envelope — and must not reach the bar as if it were.
  return (
    'five_hour' in record &&
    'seven_day' in record &&
    isUsageWindowOrNull(record.five_hour) &&
    isUsageWindowOrNull(record.seven_day)
  )
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
