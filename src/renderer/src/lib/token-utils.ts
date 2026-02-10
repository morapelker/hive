import type { TokenInfo } from '@/stores/useContextStore'

/**
 * Extract token info from a parsed OpenCode message JSON object.
 * Checks both top-level `tokens` and nested `info.tokens` paths,
 * since the format varies between DB-stored messages and streaming events.
 * Returns null if no tokens are present or all values are zero.
 */
export function extractTokens(messageData: Record<string, unknown>): TokenInfo | null {
  // Check both top-level and nested under info (OpenCode uses both formats)
  const info = messageData.info as Record<string, unknown> | undefined
  const tokens = (messageData.tokens ?? info?.tokens) as Record<string, unknown> | undefined
  if (!tokens) return null

  const cache = tokens.cache as Record<string, number> | undefined
  const result: TokenInfo = {
    input: (tokens.input as number) || 0,
    output: (tokens.output as number) || 0,
    reasoning: (tokens.reasoning as number) || 0,
    cacheRead: cache?.read || 0,
    cacheWrite: cache?.write || 0
  }

  const total =
    result.input + result.output + result.reasoning + result.cacheRead + result.cacheWrite
  return total > 0 ? result : null
}

/**
 * Extract cost from a parsed OpenCode message JSON object.
 * Checks both top-level `cost` and nested `info.cost` paths.
 * Returns 0 if no cost is present.
 */
export function extractCost(messageData: Record<string, unknown>): number {
  const info = messageData.info as Record<string, unknown> | undefined
  const cost = messageData.cost ?? info?.cost
  return typeof cost === 'number' ? cost : 0
}
