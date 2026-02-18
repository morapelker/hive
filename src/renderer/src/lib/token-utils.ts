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

function firstFiniteNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return 0
}

/**
 * Extract token info from a parsed message JSON object.
 * Checks multiple paths to handle format differences between SDKs:
 *   - OpenCode: `tokens` / `info.tokens` with `cacheRead`, `cacheWrite`
 *   - Claude Code: `usage` / `info.usage` with `cacheRead`, `cacheCreation`
 * Returns null if no tokens are present or all values are zero.
 */
export function extractTokens(messageData: Record<string, unknown>): TokenInfo | null {
  const info = asRecord(messageData.info)
  const contextWindow = asRecord(messageData.context_window ?? info?.context_window)
  const currentUsage = asRecord(contextWindow?.current_usage)
  // OpenCode uses `tokens`/`info.tokens`; Claude Code uses `usage`/`info.usage`
  const tokens = asRecord(
    messageData.tokens ?? info?.tokens ?? messageData.usage ?? info?.usage ?? currentUsage
  )
  if (!tokens) return null

  const cache = asRecord(tokens.cache)
  const result: TokenInfo = {
    input: firstFiniteNumber(tokens.input, tokens.input_tokens, tokens.inputTokens),
    output: firstFiniteNumber(tokens.output, tokens.output_tokens, tokens.outputTokens),
    reasoning: firstFiniteNumber(tokens.reasoning, tokens.reasoning_tokens, tokens.reasoningTokens),
    cacheRead: firstFiniteNumber(
      tokens.cacheRead,
      tokens.cache_read,
      tokens.cacheReadInputTokens,
      tokens.cache_read_input_tokens,
      cache?.read
    ),
    cacheWrite: firstFiniteNumber(
      tokens.cacheWrite,
      tokens.cache_write,
      tokens.cacheWriteInputTokens,
      tokens.cache_write_input_tokens,
      cache?.write,
      // Claude Code SDK uses "cacheCreation" instead of "cacheWrite"
      tokens.cacheCreation,
      tokens.cache_creation,
      tokens.cacheCreationInputTokens,
      tokens.cache_creation_input_tokens
    )
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
  const modelObj = asRecord(messageData.model) ?? asRecord(info?.model)

  const providerFromModel = modelObj?.providerID
  const modelFromModel = modelObj?.modelID ?? modelObj?.id

  let providerID =
    (typeof providerFromModel === 'string' ? providerFromModel : undefined) ??
    (typeof messageData.providerID === 'string' ? messageData.providerID : undefined) ??
    (typeof info?.providerID === 'string' ? info.providerID : undefined)
  let modelID =
    (typeof modelFromModel === 'string' ? modelFromModel : undefined) ??
    (typeof messageData.modelID === 'string' ? messageData.modelID : undefined) ??
    (typeof info?.modelID === 'string' ? info.modelID : undefined)

  const modelString =
    (typeof messageData.model === 'string' ? messageData.model : undefined) ??
    (typeof info?.model === 'string' ? info.model : undefined)

  if ((!providerID || !modelID) && modelString) {
    const [providerPart, modelPart] = modelString.split('/')
    if (providerPart && modelPart) {
      providerID = providerID ?? providerPart
      modelID = modelID ?? modelPart
    }
  }

  if (typeof providerID !== 'string' || typeof modelID !== 'string') {
    return null
  }

  if (!providerID || !modelID) {
    return null
  }

  return { providerID, modelID }
}

export interface ModelUsageEntry {
  modelName: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUSD: number
  contextWindow: number
}

/**
 * Extract per-model usage from result message's modelUsage field.
 * The SDK result message includes a `modelUsage` map keyed by model name,
 * each with token counts and `contextWindow` (the model's context limit).
 * Returns null if no modelUsage is present.
 */
export function extractModelUsage(messageData: Record<string, unknown>): ModelUsageEntry[] | null {
  const info = asRecord(messageData.info)
  const modelUsage = asRecord(messageData.modelUsage ?? info?.modelUsage)
  if (!modelUsage) return null

  const entries: ModelUsageEntry[] = []
  for (const [modelName, value] of Object.entries(modelUsage)) {
    const usage = asRecord(value)
    if (!usage) continue
    entries.push({
      modelName,
      inputTokens: toNumber(usage.inputTokens),
      outputTokens: toNumber(usage.outputTokens),
      cacheReadInputTokens: toNumber(usage.cacheReadInputTokens),
      cacheCreationInputTokens: toNumber(usage.cacheCreationInputTokens),
      costUSD: toNumber(usage.costUSD),
      contextWindow: toNumber(usage.contextWindow)
    })
  }
  return entries.length > 0 ? entries : null
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
