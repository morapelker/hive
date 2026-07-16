import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { UsageProvider } from '@shared/types/usage'
import { toast } from '@/lib/toast'
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

interface AccountScheduleState {
  schedules: Partial<Record<UsageProvider, ScheduledSwitch>>

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
 * Highest current utilization across ALL of the active account's usage bars
 * for the provider — 5h, 7d, and any scoped windows (Fable, etc.) — the
 * number a 'usage' schedule is compared against. Returns null when no fresh
 * usage data is available.
 */
export function getActiveUsagePercent(provider: UsageProvider): number | null {
  const state = useUsageStore.getState()
  const usage = normalizeUsage(provider, state.anthropicUsage, state.openaiUsage)
  if (!usage) return null
  const windows = [
    usage.five_hour,
    usage.seven_day,
    ...(usage.scoped ?? []).map((s) => ({ utilization: s.used_percent, resets_at: s.resets_at }))
  ].filter((w) => w && !isResetInPast(w.resets_at))
  if (windows.length === 0) return null
  return Math.max(...windows.map((w) => w.utilization))
}

function activeEmailFor(provider: UsageProvider): string | null {
  const state = useAccountStore.getState()
  return provider === 'anthropic' ? state.anthropicEmail : state.openaiEmail
}

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

      scheduleByTime: (provider, accountId, email, delayMs) => {
        set((state) => ({
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
        }))
      },

      scheduleByUsage: (provider, accountId, email, thresholdPercent) => {
        set((state) => ({
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
        }))
      },

      cancelSchedule: (provider) => {
        set((state) => {
          const { [provider]: _, ...rest } = state.schedules
          return { schedules: rest }
        })
      },

      checkSchedules: async () => {
        for (const provider of PROVIDERS) {
          const schedule = get().schedules[provider]
          if (!schedule || executingProviders.has(provider)) continue
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
          // from. An empty list is ambiguous (may simply not be loaded yet),
          // so only a non-empty list is treated as authoritative here; the
          // empty case is resolved by the reload below once the schedule is due.
          const knownAccounts = useUsageStore.getState().savedAccounts[provider]
          if (
            knownAccounts.length > 0 &&
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
      partialize: (state) => ({ schedules: state.schedules })
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
