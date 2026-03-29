import { useCallback } from 'react'
import { useContextStore } from '@/stores/useContextStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { tokenBaselines, sumAllTokens } from '@/lib/token-baselines'
import { formatTokenCount } from '@/lib/format-utils'

/**
 * Returns a formatted token-delta string for the given session, or null.
 *
 * When active (session is busy): computes live delta from useContextStore
 * tokens minus the baseline snapshot taken at send time.
 *
 * When inactive: reads the frozen tokenDelta from the completed
 * SessionStatusEntry in useWorktreeStatusStore.
 *
 * Mirrors the useSessionTimer pattern.
 */
export function useSessionTokenDelta(
  sessionId: string | null,
  isActive: boolean
): string | null {
  // Subscribe to live token updates only when active
  const tokens = useContextStore(
    useCallback(
      (state) => {
        if (!isActive || !sessionId) return undefined
        return state.tokensBySession[sessionId]
      },
      [sessionId, isActive]
    )
  )

  // Subscribe to frozen delta from completed status entry when inactive
  const frozenDelta = useWorktreeStatusStore(
    useCallback(
      (state) => {
        if (isActive || !sessionId) return undefined
        return state.sessionStatuses[sessionId]?.tokenDelta
      },
      [sessionId, isActive]
    )
  )

  // Live mode: compute delta from current tokens minus baseline
  if (isActive && sessionId) {
    const current = sumAllTokens(tokens)
    const baseline = tokenBaselines.get(sessionId) ?? 0
    const delta = current - baseline
    if (delta <= 0) return null
    return formatTokenCount(delta)
  }

  // Frozen mode: read from completed status entry
  if (frozenDelta !== undefined && frozenDelta > 0) {
    return formatTokenCount(frozenDelta)
  }

  return null
}
