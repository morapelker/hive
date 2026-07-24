import { useEffect } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useUsageStore, resolveUsageProvider } from '@/stores/useUsageStore'
import { useAccountScheduleStore, getActiveUsagePercent } from '@/stores/useAccountScheduleStore'
import type { UsageProvider } from '@shared/types/usage'

const CHECK_INTERVAL_MS = 30_000
// While a session is actively running, keep usage fresh even when no prompt
// completes — long runs can burn through a window without ever going idle,
// and usage-based scheduled switches need current numbers to fire mid-session.
const SESSION_USAGE_REFRESH_MS = 5 * 60_000
// Once utilization gets within these margins of an armed usage-based switch
// threshold, a 5-minute sampling gap can blow far past the threshold before
// the switch fires — tighten to every 2 minutes in the last 10 points and
// every minute in the last 3 (still only while a session is running for the
// provider).
const NEAR_THRESHOLD_MARGIN_PERCENT = 10
const NEAR_THRESHOLD_REFRESH_MS = 2 * 60_000
const IMMINENT_THRESHOLD_MARGIN_PERCENT = 3
const IMMINENT_THRESHOLD_REFRESH_MS = 60_000

/** Threshold of the armed usage-based switch (auto-switch or usage schedule), if any. */
function armedUsageThresholdPercent(provider: UsageProvider): number | null {
  const { autoSwitch, schedules } = useAccountScheduleStore.getState()
  const auto = autoSwitch[provider]
  if (auto) return auto.thresholdPercent
  const schedule = schedules[provider]
  if (schedule?.mode === 'usage') return schedule.thresholdPercent
  return null
}

function usageRefreshIntervalMs(provider: UsageProvider): number {
  const threshold = armedUsageThresholdPercent(provider)
  if (threshold === null) return SESSION_USAGE_REFRESH_MS
  const percent = getActiveUsagePercent(provider)
  if (percent === null || percent < threshold - NEAR_THRESHOLD_MARGIN_PERCENT) {
    return SESSION_USAGE_REFRESH_MS
  }
  if (percent >= threshold - IMMINENT_THRESHOLD_MARGIN_PERCENT) {
    return IMMINENT_THRESHOLD_REFRESH_MS
  }
  return NEAR_THRESHOLD_REFRESH_MS
}

function providersWithRunningSessions(): Set<UsageProvider> {
  const providers = new Set<UsageProvider>()
  const { sessionStatuses } = useWorktreeStatusStore.getState()
  const runningIds = Object.entries(sessionStatuses)
    .filter(([, entry]) => entry?.status === 'working' || entry?.status === 'planning')
    .map(([sessionId]) => sessionId)
  if (runningIds.length === 0) return providers

  const sessionStore = useSessionStore.getState()
  const allSessions = [
    ...[...sessionStore.sessionsByWorktree.values()].flat(),
    ...[...sessionStore.sessionsByConnection.values()].flat()
  ]
  for (const id of runningIds) {
    const session = allSessions.find((s) => s.id === id)
    if (session) providers.add(resolveUsageProvider(session))
  }
  return providers
}

/**
 * Drives scheduled account switches (see useAccountScheduleStore) and the
 * mid-session usage refresh. Mount once at the app root.
 */
export function useAccountScheduleRunner(): void {
  useEffect(() => {
    // Failed fetches don't advance lastFetchedAt, so gate on our own attempt
    // time too — otherwise a flaky network turns the 5-minute refresh into
    // polling on every tick.
    const lastAttemptAt: Partial<Record<UsageProvider, number>> = {}

    const tick = (): void => {
      const usageStore = useUsageStore.getState()
      for (const provider of providersWithRunningSessions()) {
        const lastFetchedAt =
          provider === 'anthropic'
            ? usageStore.anthropicLastFetchedAt
            : usageStore.openaiLastFetchedAt
        const lastActivity = Math.max(lastFetchedAt ?? 0, lastAttemptAt[provider] ?? 0)
        if (Date.now() - lastActivity >= usageRefreshIntervalMs(provider)) {
          lastAttemptAt[provider] = Date.now()
          // fetchUsageForProvider is silent on failure and debounce-safe, so a
          // flaky refresh never toasts every 5 minutes.
          usageStore.fetchUsageForProvider(provider).catch(() => {})
        }
      }
      useAccountScheduleStore
        .getState()
        .checkSchedules()
        .catch(() => {})
    }

    tick()
    const interval = setInterval(tick, CHECK_INTERVAL_MS)

    // Evaluate schedules the moment fresh usage data or account-list changes
    // land (e.g. the target of a pending schedule was removed) instead of
    // waiting for the next tick.
    const unsubscribe = useUsageStore.subscribe((state, prevState) => {
      if (
        state.anthropicUsage !== prevState.anthropicUsage ||
        state.openaiUsage !== prevState.openaiUsage ||
        state.savedAccounts !== prevState.savedAccounts
      ) {
        useAccountScheduleStore
          .getState()
          .checkSchedules()
          .catch(() => {})
      }
    })

    return () => {
      clearInterval(interval)
      unsubscribe()
    }
  }, [])
}
