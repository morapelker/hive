import { create } from 'zustand'

export interface TokenInfo {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
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
  // Per-session cumulative cost
  costBySession: Record<string, number>
  // Model context limits (modelId -> contextLimit)
  modelLimits: Record<string, number>
  // Actions
  setSessionTokens: (sessionId: string, tokens: TokenInfo) => void // REPLACE, not add
  addSessionCost: (sessionId: string, cost: number) => void
  setSessionCost: (sessionId: string, cost: number) => void
  resetSessionTokens: (sessionId: string) => void
  setModelLimit: (modelId: string, limit: number) => void
  // Derived
  getContextUsage: (
    sessionId: string,
    modelId: string
  ) => {
    used: number
    limit: number
    percent: number
    tokens: TokenInfo
    cost: number
  }
}

export const useContextStore = create<ContextState>()((set, get) => ({
  tokensBySession: {},
  costBySession: {},
  modelLimits: {},

  setSessionTokens: (sessionId: string, tokens: TokenInfo) => {
    set((state) => ({
      tokensBySession: {
        ...state.tokensBySession,
        [sessionId]: { ...tokens }
      }
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
      const { [sessionId]: _removedCost, ...restCost } = state.costBySession
      void _removedTokens
      void _removedCost
      return { tokensBySession: restTokens, costBySession: restCost }
    })
  },

  setModelLimit: (modelId: string, limit: number) => {
    set((state) => ({
      modelLimits: {
        ...state.modelLimits,
        [modelId]: limit
      }
    }))
  },

  getContextUsage: (sessionId: string, modelId: string) => {
    const state = get()
    const tokens = state.tokensBySession[sessionId] ?? { ...EMPTY_TOKENS }
    const limit = state.modelLimits[modelId] ?? 0
    const cost = state.costBySession[sessionId] ?? 0
    const used =
      tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0

    return { used, limit, percent, tokens, cost }
  }
}))
