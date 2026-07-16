import { useEffect } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useUsageStore, resolveUsageProvider } from '@/stores/useUsageStore'
import { useAccountScheduleStore } from '@/stores/useAccountScheduleStore'
import type { UsageProvider } from '@shared/types/usage'

const CHECK_INTERVAL_MS = 30_000
// While a session is actively running, keep usage fresh even when no prompt
// completes — long runs can burn through a window without ever going idle,
// and usage-based scheduled switches need current numbers to fire mid-session.
const SESSION_USAGE_REFRESH_MS = 5 * 60_000

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
        if (Date.now() - lastActivity >= SESSION_USAGE_REFRESH_MS) {
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
