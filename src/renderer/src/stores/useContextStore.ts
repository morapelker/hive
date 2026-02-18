import { create } from 'zustand'

export interface TokenInfo {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface SessionModelRef {
  providerID: string
  modelID: string
}

export function getModelLimitKey(modelID: string, providerID?: string): string {
  return `${providerID ?? '*'}::${modelID}`
}

const EMPTY_TOKENS: TokenInfo = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0
}

interface ContextState {
  // Per-session token snapshot (last assistant message with tokens > 0)
  tokensBySession: Record<string, TokenInfo>
  // Provider/model identity for each session token snapshot
  modelBySession: Record<string, SessionModelRef>
  // Per-session cumulative cost
  costBySession: Record<string, number>
  // Model context limits (providerID::modelID -> contextLimit)
  modelLimits: Record<string, number>
  // Actions
  setSessionTokens: (sessionId: string, tokens: TokenInfo, model?: SessionModelRef) => void
  addSessionCost: (sessionId: string, cost: number) => void
  setSessionCost: (sessionId: string, cost: number) => void
  resetSessionTokens: (sessionId: string) => void
  setModelLimit: (modelId: string, limit: number, providerID?: string) => void
  // Derived
  getContextUsage: (
    sessionId: string,
    fallbackModelId: string,
    fallbackProviderId?: string
  ) => {
    used: number
    limit?: number
    percent: number | null
    tokens: TokenInfo
    cost: number
    model?: SessionModelRef
  }
}

export const useContextStore = create<ContextState>()((set, get) => ({
  tokensBySession: {},
  modelBySession: {},
  costBySession: {},
  modelLimits: {},

  setSessionTokens: (sessionId: string, tokens: TokenInfo, model?: SessionModelRef) => {
    set((state) => ({
      tokensBySession: {
        ...state.tokensBySession,
        [sessionId]: { ...tokens }
      },
      modelBySession: model
        ? {
            ...state.modelBySession,
            [sessionId]: model
          }
        : state.modelBySession
    }))
  },

  addSessionCost: (sessionId: string, cost: number) => {
    set((state) => ({
      costBySession: {
        ...state.costBySession,
        [sessionId]: (state.costBySession[sessionId] ?? 0) + cost
      }
    }))
  },

  setSessionCost: (sessionId: string, cost: number) => {
    set((state) => ({
      costBySession: {
        ...state.costBySession,
        [sessionId]: cost
      }
    }))
  },

  resetSessionTokens: (sessionId: string) => {
    set((state) => {
      const { [sessionId]: _removedTokens, ...restTokens } = state.tokensBySession
      const { [sessionId]: _removedModel, ...restModel } = state.modelBySession
      const { [sessionId]: _removedCost, ...restCost } = state.costBySession
      void _removedTokens
      void _removedModel
      void _removedCost
      return {
        tokensBySession: restTokens,
        modelBySession: restModel,
        costBySession: restCost
      }
    })
  },

  setModelLimit: (modelId: string, limit: number, providerID?: string) => {
    set((state) => ({
      modelLimits: {
        ...state.modelLimits,
        [getModelLimitKey(modelId, providerID)]: limit
      }
    }))
  },

  getContextUsage: (sessionId: string, fallbackModelId: string, fallbackProviderId?: string) => {
    const state = get()
    const tokens = state.tokensBySession[sessionId] ?? { ...EMPTY_TOKENS }
    const model =
      state.modelBySession[sessionId] ??
      (fallbackModelId
        ? {
            providerID: fallbackProviderId ?? '*',
            modelID: fallbackModelId
          }
        : undefined)

    const limit = model
      ? (state.modelLimits[getModelLimitKey(model.modelID, model.providerID)] ??
        state.modelLimits[getModelLimitKey(model.modelID)])
      : undefined
    const cost = state.costBySession[sessionId] ?? 0
    // Context window = total prompt tokens (input + cached).
    // Output and reasoning are generated tokens — they don't occupy the context window.
    const used = tokens.input + tokens.cacheRead + tokens.cacheWrite
    const percent = typeof limit === 'number' && limit > 0 ? Math.round((used / limit) * 100) : null

    return { used, limit, percent, tokens, cost, model }
  }
}))
