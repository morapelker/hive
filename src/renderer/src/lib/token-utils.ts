import type { SessionModelRef, TokenInfo } from '@/stores/useContextStore'

export interface SelectedModelRef {
  providerID: string
  modelID: string
  variant?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Extract token info from a parsed OpenCode message JSON object.
 * Checks both top-level `tokens` and nested `info.tokens` paths,
 * since the format varies between DB-stored messages and streaming events.
 * Returns null if no tokens are present or all values are zero.
 */
export function extractTokens(messageData: Record<string, unknown>): TokenInfo | null {
  // Check both top-level and nested under info (OpenCode uses both formats)
  const info = asRecord(messageData.info)
  const tokens = asRecord(messageData.tokens ?? info?.tokens)
  if (!tokens) return null

  const cache = asRecord(tokens.cache)
  const result: TokenInfo = {
    input: toNumber(tokens.input),
    output: toNumber(tokens.output),
    reasoning: toNumber(tokens.reasoning),
    cacheRead:
      toNumber(tokens.cacheRead) || toNumber(tokens.cache_read) || toNumber(cache?.read) || 0,
    cacheWrite:
      toNumber(tokens.cacheWrite) || toNumber(tokens.cache_write) || toNumber(cache?.write) || 0
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
  const info = asRecord(messageData.info)
  const cost = messageData.cost ?? info?.cost
  return typeof cost === 'number' ? cost : 0
}

/**
 * Extract provider/model identity from a parsed OpenCode message JSON object.
 * Checks both top-level fields and nested `info` fields.
 */
export function extractModelRef(messageData: Record<string, unknown>): SessionModelRef | null {
  const info = asRecord(messageData.info)

  const providerID = messageData.providerID ?? info?.providerID
  const modelID = messageData.modelID ?? info?.modelID

  if (typeof providerID !== 'string' || typeof modelID !== 'string') {
    return null
  }

  if (!providerID || !modelID) {
    return null
  }

  return { providerID, modelID }
}

/**
 * Extract full model selection (provider/model + optional variant) from a
 * parsed OpenCode message JSON object.
 */
export function extractSelectedModel(
  messageData: Record<string, unknown>
): SelectedModelRef | null {
  const info = asRecord(messageData.info)
  const modelRecord = asRecord(messageData.model) ?? asRecord(info?.model)

  const providerFromModel = modelRecord?.providerID
  const modelIdFromModel = modelRecord?.modelID ?? modelRecord?.id

  let providerID =
    typeof providerFromModel === 'string'
      ? providerFromModel
      : typeof messageData.providerID === 'string'
        ? messageData.providerID
        : typeof info?.providerID === 'string'
          ? info.providerID
          : undefined

  let modelID =
    typeof modelIdFromModel === 'string'
      ? modelIdFromModel
      : typeof messageData.modelID === 'string'
        ? messageData.modelID
        : typeof info?.modelID === 'string'
          ? info.modelID
          : undefined

  const modelString =
    typeof messageData.model === 'string'
      ? messageData.model
      : typeof info?.model === 'string'
        ? info.model
        : undefined

  if ((!providerID || !modelID) && modelString) {
    const [providerPart, modelPart] = modelString.split('/')
    if (providerPart && modelPart) {
      providerID = providerID ?? providerPart
      modelID = modelID ?? modelPart
    }
  }

  if (!providerID || !modelID) {
    return null
  }

  const variantCandidate =
    typeof modelRecord?.variant === 'string'
      ? modelRecord.variant
      : typeof messageData.variant === 'string'
        ? messageData.variant
        : typeof info?.variant === 'string'
          ? info.variant
          : undefined

  return {
    providerID,
    modelID,
    ...(variantCandidate ? { variant: variantCandidate } : {})
  }
}
