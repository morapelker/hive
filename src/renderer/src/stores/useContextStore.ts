import { create } from 'zustand'

interface TokenInfo {
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
  // Per-session cumulative tokens
  tokensBySession: Record<string, TokenInfo>
  // Model context limits (modelId -> contextLimit)
  modelLimits: Record<string, number>
  // Actions
  addMessageTokens: (sessionId: string, tokens: TokenInfo) => void
  resetSessionTokens: (sessionId: string) => void
  setModelLimit: (modelId: string, limit: number) => void
  // Derived
  getContextUsage: (sessionId: string, modelId: string) => { used: number; limit: number; percent: number; tokens: TokenInfo }
}

export const useContextStore = create<ContextState>()((set, get) => ({
  tokensBySession: {},
  modelLimits: {},

  addMessageTokens: (sessionId: string, tokens: TokenInfo) => {
    set((state) => {
      const existing = state.tokensBySession[sessionId] ?? { ...EMPTY_TOKENS }
      return {
        tokensBySession: {
          ...state.tokensBySession,
          [sessionId]: {
            input: existing.input + tokens.input,
            output: existing.output + tokens.output,
            reasoning: existing.reasoning + tokens.reasoning,
            cacheRead: existing.cacheRead + tokens.cacheRead,
            cacheWrite: existing.cacheWrite + tokens.cacheWrite
          }
        }
      }
    })
  },

  resetSessionTokens: (sessionId: string) => {
    set((state) => {
      const { [sessionId]: _removed, ...rest } = state.tokensBySession
      void _removed
      return { tokensBySession: rest }
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
    const used = tokens.input + tokens.output + tokens.cacheRead
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0

    return { used, limit, percent, tokens }
  }
}))
