/**
 * Tracks per-session token baselines for delta computation.
 *
 * Written at every user-send site (alongside userExplicitSendTimes).
 * Read by useSessionTokenDelta to compute live token deltas.
 */
import { useContextStore, type TokenInfo } from '@/stores/useContextStore'

/** Baseline total-token sum at the time the user last sent a message. */
export const tokenBaselines = new Map<string, number>()

/** Sum all five token fields into a single number. */
export function sumAllTokens(t: TokenInfo | undefined): number {
  if (!t) return 0
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite
}

/** Snapshot the current cumulative token total as the baseline for this session. */
export function snapshotTokenBaseline(sessionId: string): void {
  const tokens = useContextStore.getState().tokensBySession?.[sessionId]
  tokenBaselines.set(sessionId, sumAllTokens(tokens))
}

/** Compute the token delta (current total minus baseline). Never negative. */
export function computeTokenDelta(sessionId: string): number {
  const tokens = useContextStore.getState().tokensBySession?.[sessionId]
  const current = sumAllTokens(tokens)
  const baseline = tokenBaselines.get(sessionId) ?? 0
  return Math.max(0, current - baseline)
}
