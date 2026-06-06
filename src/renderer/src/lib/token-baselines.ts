/**
 * Tracks per-session token baselines for delta computation.
 *
 * Written at every user-send site (alongside userExplicitSendTimes).
 * Read by useSessionTokenDelta to compute live token deltas.
 */
import { useContextStore, type TokenInfo } from '@/stores/useContextStore'

/** Baseline total-token sum at the time the user last sent a message. */
export const tokenBaselines = new Map<string, number>()
export const tokenFieldBaselines = new Map<string, TokenInfo>()

/** Sum all five token fields into a single number. */
export function sumAllTokens(t: TokenInfo | undefined): number {
  if (!t) return 0
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite
}

/** Snapshot the current cumulative token total as the baseline for this session. */
export function snapshotTokenBaseline(sessionId: string): void {
  const tokens = useContextStore.getState().tokensBySession?.[sessionId]
  tokenBaselines.set(sessionId, sumAllTokens(tokens))
  tokenFieldBaselines.set(sessionId, tokens ? { ...tokens } : { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
}

/** Compute the token delta (current total minus baseline). Never negative. */
export function computeTokenDelta(sessionId: string): number {
  const tokens = useContextStore.getState().tokensBySession?.[sessionId]
  const current = sumAllTokens(tokens)
  const baseline = tokenBaselines.get(sessionId) ?? 0
  return Math.max(0, current - baseline)
}

export function computeTokenFieldDelta(sessionId: string): TokenInfo {
  const tokens = useContextStore.getState().tokensBySession?.[sessionId] ?? {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0
  }
  const baseline = tokenFieldBaselines.get(sessionId) ?? {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0
  }
  return {
    input: Math.max(0, tokens.input - baseline.input),
    output: Math.max(0, tokens.output - baseline.output),
    reasoning: Math.max(0, tokens.reasoning - baseline.reasoning),
    cacheRead: Math.max(0, tokens.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, tokens.cacheWrite - baseline.cacheWrite)
  }
}
