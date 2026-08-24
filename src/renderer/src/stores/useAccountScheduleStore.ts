import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  OpenAIUsageData,
  RefreshAllResultItem,
  SavedAccountDTO,
  UsageData,
  UsageProvider
} from '@shared/types/usage'
import { toast } from '@/lib/toast'
import {
  getMaxUsagePercent,
  isProvablyAtOrAbove,
  scoreAccountHeadroom
} from '@/lib/auto-switch-score'
import { useUsageStore, normalizeUsage } from './useUsageStore'
import { useAccountStore } from './useAccountStore'

export type ScheduleMode = 'time' | 'usage'

export interface ScheduledSwitch {
  provider: UsageProvider
  accountId: string
  email: string | null
  mode: ScheduleMode
  /** Epoch ms at which a 'time' schedule fires */
  executeAt: number | null
  /** Utilization percent (0-100) at or above which a 'usage' schedule fires */
  thresholdPercent: number | null
  createdAt: number
  /** Set after a failed switch attempt — don't retry before this time */
  notBefore?: number
}

/**
 * Provider-global "keep me on whichever account has the most headroom" mode:
 * when the ACTIVE account crosses thresholdPercent, refresh the saved
 * accounts that could plausibly be viable and hop to the best-scoring one —
 * then stay armed for the next crossing. Mutually exclusive with a
 * per-account ScheduledSwitch.
 */
export interface AutoSwitchConfig {
  provider: UsageProvider
  /** Utilization percent (0-100) at or above which the hop is triggered */
  thresholdPercent: number
  createdAt: number
  /** Set after a failed attempt (or an empty candidate pool) — don't retry before this time */
  notBefore?: number
}

interface AccountScheduleState {
  schedules: Partial<Record<UsageProvider, ScheduledSwitch>>
  autoSwitch: Partial<Record<UsageProvider, AutoSwitchConfig>>

  scheduleByTime: (
    provider: UsageProvider,
    accountId: string,
    email: string | null,
    delayMs: number
  ) => void
  scheduleByUsage: (
    provider: UsageProvider,
    accountId: string,
    email: string | null,
    thresholdPercent: number
  ) => void
  cancelSchedule: (provider: UsageProvider) => void
  /** Enable auto-switch (or update its threshold). Replaces any pending schedule. */
  setAutoSwitch: (provider: UsageProvider, thresholdPercent: number) => void
  disableAutoSwitch: (provider: UsageProvider) => void
  checkSchedules: () => Promise<void>
}

const PROVIDERS: UsageProvider[] = ['anthropic', 'openai']

// A reset time in the past means the cached utilization predates the window's
// reset and no longer reflects reality (mirrors UsageIndicator's staleness
// rule). null is NOT stale: it means "no active window".
function isResetInPast(resetsAt: string | null | undefined): boolean {
  if (!resetsAt) return false
  const time = new Date(resetsAt).getTime()
  return !isNaN(time) && time < Date.now()
}

/**
 * 100 when the Claude SDK has reported a live rejected rate-limit window that
 * hasn't reset yet — the account is provably exhausted even if the polled
 * usage snapshot still says less. Cleared on account switch.
 */
function anthropicRejectedOverlay(): number | null {
  const rateLimit = useUsageStore.getState().anthropicRateLimit
  if (!rateLimit) return null
  const nowSeconds = Date.now() / 1000
  const rejected = [rateLimit.fiveHour, rateLimit.sevenDay].some(
    (window) => window !== undefined && window.status === 'rejected' && window.resetsAt > nowSeconds
  )
  return rejected ? 100 : null
}

/**
 * Highest current utilization across ALL of the active account's usage bars
 * for the provider — 5h, 7d, and any scoped windows (Fable, etc.) — the
 * number a 'usage' schedule is compared against. A live rejected rate-limit
 * event counts as 100 (anthropic only). Returns null when no fresh usage
 * data is available.
 */
export function getActiveUsagePercent(provider: UsageProvider): number | null {
  const overlay = provider === 'anthropic' ? anthropicRejectedOverlay() : null
  const state = useUsageStore.getState()
  const usage = normalizeUsage(provider, state.anthropicUsage, state.openaiUsage)
  if (!usage) return overlay
  const windows = [
    usage.five_hour,
    usage.seven_day,
    ...(usage.scoped ?? []).map((s) => ({ utilization: s.used_percent, resets_at: s.resets_at }))
  ].filter((w) => w && !isResetInPast(w.resets_at))
  if (windows.length === 0) return overlay
  const max = Math.max(...windows.map((w) => w.utilization))
  return overlay === null ? max : Math.max(max, overlay)
}

function activeEmailFor(provider: UsageProvider): string | null {
  const state = useAccountStore.getState()
  return provider === 'anthropic' ? state.anthropicEmail : state.openaiEmail
}

/** A saved account's cached usage in the common (anthropic-shaped) form. */
function savedAccountUsage(provider: UsageProvider, account: SavedAccountDTO): UsageData | null {
  if (!account.last_usage) return null
  if (provider === 'anthropic') {
    return normalizeUsage(provider, account.last_usage as UsageData, null)
  }
  return normalizeUsage(provider, null, account.last_usage as OpenAIUsageData)
}

/**
 * Saved-account ids a candidate sweep may skip: the active account (never a
 * candidate) plus accounts whose cached usage PROVES they are at/over the
 * threshold until a known future reset — refreshing those is a wasted
 * request. Undefined before the first successful account-list load (nothing
 * to prove non-viability from — callers fall back to the full sweep).
 */
export function computeSweepExclusions(
  provider: UsageProvider,
  thresholdPercent: number,
  activeEmail: string | null
): string[] | undefined {
  const usageState = useUsageStore.getState()
  if (!usageState.savedAccountsLoaded[provider]) return undefined
  const nowMs = Date.now()
  return usageState.savedAccounts[provider]
    .filter((account) => {
      if (activeEmail !== null && account.email === activeEmail) return true
      const usage = savedAccountUsage(provider, account)
      if (!usage) return false
      return isProvablyAtOrAbove(usage, thresholdPercent, nowMs)
    })
    .map((account) => account.id)
}

// Cached rows at least this fresh count as already-refreshed during the
// trigger-time candidate sweep (the runner pre-warms them while usage sits
// near the threshold), collapsing the sweep to a DB read instead of a serial
// fetch of every account right when the switch is urgent.
export const TRIGGER_SWEEP_MAX_AGE_MS = 180_000

// A due schedule whose switch attempt failed is retried, but not more often
// than this — a persistently failing switch shouldn't toast every tick.
const RETRY_DELAY_MS = 5 * 60_000

// Re-entrancy guard: checkSchedules can be triggered by both the interval
// tick and usage-store updates while a switch is still in flight.
const executingProviders = new Set<UsageProvider>()

/** Test hook: the guard lives outside the store, so setState can't reset it. */
export function resetExecutingProvidersForTests(): void {
  executingProviders.clear()
}

export const useAccountScheduleStore = create<AccountScheduleState>()(
  persist(
    (set, get) => ({
      schedules: {},
      autoSwitch: {},

      scheduleByTime: (provider, accountId, email, delayMs) => {
        set((state) => {
          const { [provider]: _, ...autoRest } = state.autoSwitch
          return {
            autoSwitch: autoRest,
            schedules: {
              ...state.schedules,
              [provider]: {
                provider,
                accountId,
                email,
                mode: 'time' as const,
                executeAt: Date.now() + delayMs,
                thresholdPercent: null,
                createdAt: Date.now()
              }
            }
          }
        })
      },

      scheduleByUsage: (provider, accountId, email, thresholdPercent) => {
        set((state) => {
          const { [provider]: _, ...autoRest } = state.autoSwitch
          return {
            autoSwitch: autoRest,
            schedules: {
              ...state.schedules,
              [provider]: {
                provider,
                accountId,
                email,
                mode: 'usage' as const,
                executeAt: null,
                thresholdPercent: Math.min(100, Math.max(1, Math.round(thresholdPercent))),
                createdAt: Date.now()
              }
            }
          }
        })
      },

      cancelSchedule: (provider) => {
        set((state) => {
          const { [provider]: _, ...rest } = state.schedules
          return { schedules: rest }
        })
      },

      setAutoSwitch: (provider, thresholdPercent) => {
        set((state) => {
          const { [provider]: _, ...scheduleRest } = state.schedules
          return {
            schedules: scheduleRest,
            autoSwitch: {
              ...state.autoSwitch,
              [provider]: {
                provider,
                thresholdPercent: Math.min(100, Math.max(1, Math.round(thresholdPercent))),
                createdAt: Date.now()
              }
            }
          }
        })
      },

      disableAutoSwitch: (provider) => {
        set((state) => {
          const { [provider]: _, ...rest } = state.autoSwitch
          return { autoSwitch: rest }
        })
      },

      checkSchedules: async () => {
        for (const provider of PROVIDERS) {
          if (executingProviders.has(provider)) continue

          // Auto-switch mode is mutually exclusive with a per-account
          // schedule — when armed, it owns this provider's evaluation.
          const auto = get().autoSwitch[provider]
          if (auto) {
            if (auto.notBefore !== undefined && Date.now() < auto.notBefore) continue
            const percent = getActiveUsagePercent(provider)
            if (percent === null || percent < auto.thresholdPercent) continue

            const backOff = (): void => {
              set((state) => {
                const current = state.autoSwitch[provider]
                if (!current || current.createdAt !== auto.createdAt) return state
                return {
                  autoSwitch: {
                    ...state.autoSwitch,
                    [provider]: { ...current, notBefore: Date.now() + RETRY_DELAY_MS }
                  }
                }
              })
            }

            executingProviders.add(provider)
            try {
              // Without knowing which account is active we can't exclude it
              // from the candidate pool (risking a pointless self-switch) —
              // resolve the email first, fetching it if the store has none.
              let activeEmail = activeEmailFor(provider)
              if (activeEmail === null) {
                await useAccountStore
                  .getState()
                  .fetchEmail(provider)
                  .catch(() => {})
                activeEmail = activeEmailFor(provider)
              }
              if (activeEmail === null) {
                toast.error('Auto-switch: could not identify the active account')
                backOff()
                continue
              }

              // Refresh saved accounts so the pick is based on live numbers —
              // but only the ones with a chance of being viable. A usage
              // window only accrues until its (known, future) reset time, so
              // an account whose cached utilization is already at/over the
              // threshold provably stays there: refreshing it is a wasted
              // request. Anything short of that proof — unknown usage, a
              // passed or missing reset time — stays in the sweep, and the
              // active account is skipped (it is never a candidate). Before
              // the first successful account-list load there is nothing to
              // prove non-viability from — fall back to the full sweep.
              const excludeAccountIds = computeSweepExclusions(
                provider,
                auto.thresholdPercent,
                activeEmail
              )
              // Even when every known account is excluded the (then refresh-
              // free) sweep still runs: the main process lists accounts from
              // the DB, so it refreshes anything this renderer hasn't seen
              // yet, and the post-sweep reload revalidates the cached list.

              let results: RefreshAllResultItem[] | null = null
              let sweepFailed = false
              try {
                results = await useUsageStore
                  .getState()
                  .refreshAllForProvider(provider, excludeAccountIds, {
                    maxAgeMs: TRIGGER_SWEEP_MAX_AGE_MS
                  })
              } catch {
                sweepFailed = true
              }

              // The sweep awaited an IPC round-trip — the user may have
              // toggled auto-switch off (or re-armed it) in the meantime.
              const latest = get().autoSwitch[provider]
              if (!latest || latest.createdAt !== auto.createdAt) continue

              if (sweepFailed) {
                backOff()
                continue
              }
              // Another sweep was already in flight: its numbers may be
              // mid-write, so skip this round and re-evaluate next tick.
              if (results === null) continue

              const succeededIds = new Set(
                results.filter((r) => r.success).map((r) => r.accountId)
              )
              const now = Date.now()
              // Eligible: the refresh succeeded, the token is valid, it's not
              // the account we're leaving, its windows carry CURRENT data
              // (all-expired resets right after a refresh means its live usage
              // is unknown, not zero), and it isn't itself at/over the
              // threshold (hopping there would immediately re-trigger).
              const candidates = useUsageStore
                .getState()
                .savedAccounts[provider].filter(
                  (a) => succeededIds.has(a.id) && a.status === 'ok' && a.email !== activeEmail
                )
                .map((a) => ({ account: a, usage: savedAccountUsage(provider, a) }))
                .filter((c): c is { account: SavedAccountDTO; usage: UsageData } => c.usage !== null)
                .filter((c) => {
                  const maxPercent = getMaxUsagePercent(c.usage, now)
                  return maxPercent !== null && maxPercent < latest.thresholdPercent
                })

              if (candidates.length === 0) {
                toast.error(
                  `Auto-switch: no other account below ${latest.thresholdPercent}% usage to switch to`
                )
                backOff()
                continue
              }

              let best = candidates[0]
              let bestScore = scoreAccountHeadroom(best.usage, now)
              for (const candidate of candidates.slice(1)) {
                const score = scoreAccountHeadroom(candidate.usage, now)
                if (score > bestScore) {
                  best = candidate
                  bestScore = score
                }
              }

              // switchAccount toasts success/failure itself, and the mode
              // stays armed either way. Both outcomes pause re-evaluation so
              // a persistent problem doesn't retry (and toast) every tick.
              const switched = await useUsageStore.getState().switchAccount(best.account.id)
              if (switched && best.account.last_usage) {
                // Seed the active-usage slot from the account we just picked:
                // until the post-switch refresh lands (it can fail or be rate
                // limited indefinitely), the slot would otherwise keep the
                // PREVIOUS account's exhausted numbers and hop away from a
                // healthy account on every cooldown expiry. A successful
                // refresh simply overwrites the seed with live data.
                if (provider === 'anthropic') {
                  useUsageStore.setState({
                    anthropicUsage: best.account.last_usage as UsageData,
                    // Seeded cache, not live data: the burn-rate predictor
                    // must re-anchor on it without calibrating.
                    anthropicUsageFromFetch: false
                  })
                } else {
                  useUsageStore.setState({
                    openaiUsage: best.account.last_usage as OpenAIUsageData
                  })
                }
              }
              backOff()
            } finally {
              executingProviders.delete(provider)
            }
            continue
          }

          const schedule = get().schedules[provider]
          if (!schedule) continue
          if (schedule.notBefore !== undefined && Date.now() < schedule.notBefore) continue

          // Already on the target account (e.g. the user switched manually) —
          // the schedule is moot, drop it silently.
          const activeEmail = activeEmailFor(provider)
          if (schedule.email !== null && activeEmail !== null && schedule.email === activeEmail) {
            get().cancelSchedule(provider)
            continue
          }

          // Target removed while still pending (e.g. via the remove-account
          // UI): cancel right away rather than at due time — a usage schedule
          // that never fires would otherwise linger with no row to cancel it
          // from. Only a successfully loaded list is authoritative (even when
          // empty, e.g. the last account was removed); before the first load
          // the check is deferred to the due-time reload below.
          const usageState = useUsageStore.getState()
          const knownAccounts = usageState.savedAccounts[provider]
          if (
            usageState.savedAccountsLoaded[provider] &&
            !knownAccounts.some((a) => a.id === schedule.accountId)
          ) {
            get().cancelSchedule(provider)
            toast.error(
              `Scheduled switch canceled: ${schedule.email ?? 'account'} is no longer saved`
            )
            continue
          }

          let due = false
          if (schedule.mode === 'time') {
            due = schedule.executeAt !== null && Date.now() >= schedule.executeAt
          } else {
            const percent = getActiveUsagePercent(provider)
            due =
              percent !== null &&
              schedule.thresholdPercent !== null &&
              percent >= schedule.thresholdPercent
          }
          if (!due) continue

          // Re-entrancy during the awaits below is blocked by executingProviders,
          // so the schedule can stay in place until the switch outcome is known —
          // a transient failure must not silently drop the user's schedule.
          executingProviders.add(provider)
          try {
            // Make sure the target account still exists before switching.
            let accounts = useUsageStore.getState().savedAccounts[provider]
            if (!accounts.some((a) => a.id === schedule.accountId)) {
              try {
                await useUsageStore.getState().loadSavedAccounts(provider)
              } catch {
                // Can't tell whether the account is gone — keep the schedule
                // and let a later check retry.
                continue
              }
              accounts = useUsageStore.getState().savedAccounts[provider]

              // The reload awaited an IPC round-trip — the user may have
              // canceled or replaced the schedule in the meantime.
              const latest = get().schedules[provider]
              if (!latest || latest.createdAt !== schedule.createdAt) continue
            }

            if (!accounts.some((a) => a.id === schedule.accountId)) {
              get().cancelSchedule(provider)
              toast.error(
                `Scheduled switch canceled: ${schedule.email ?? 'account'} is no longer saved`
              )
              continue
            }

            // switchAccount toasts success/failure itself. Both outcome paths
            // guard on createdAt: the user may have replaced the schedule
            // while the switch was in flight, and the replacement must survive.
            const switched = await useUsageStore.getState().switchAccount(schedule.accountId)
            if (switched) {
              set((state) => {
                const current = state.schedules[provider]
                if (!current || current.createdAt !== schedule.createdAt) return state
                const { [provider]: _, ...rest } = state.schedules
                return { schedules: rest }
              })
            } else {
              // Keep the schedule but back off so a persistent failure doesn't
              // retry (and toast) on every tick.
              set((state) => {
                const current = state.schedules[provider]
                if (!current || current.createdAt !== schedule.createdAt) return state
                return {
                  schedules: {
                    ...state.schedules,
                    [provider]: { ...current, notBefore: Date.now() + RETRY_DELAY_MS }
                  }
                }
              })
            }
          } finally {
            executingProviders.delete(provider)
          }
        }
      }
    }),
    {
      name: 'hive-account-switch-schedules',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ schedules: state.schedules, autoSwitch: state.autoSwitch })
    }
  )
)

/** Human-readable description of a pending schedule, e.g. "in 42m" / "at 80% usage". */
export function describeSchedule(schedule: ScheduledSwitch, nowMs: number): string {
  if (schedule.mode === 'usage') {
    return `at ${schedule.thresholdPercent}% usage`
  }
  const remainingMs = Math.max(0, (schedule.executeAt ?? nowMs) - nowMs)
  const totalMinutes = Math.ceil(remainingMs / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return `in ${hours}h ${String(minutes).padStart(2, '0')}m`
  if (totalMinutes > 0) return `in ${totalMinutes}m`
  return 'in <1m'
}
