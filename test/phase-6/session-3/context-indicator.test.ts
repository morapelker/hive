import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { getModelLimitKey, useContextStore } from '../../../src/renderer/src/stores/useContextStore'

beforeEach(() => {
  vi.clearAllMocks()

  // Reset store to initial state
  useContextStore.setState({
    tokensBySession: {},
    modelBySession: {},
    costBySession: {},
    modelLimits: {}
  })
})

describe('Session 3: Context Indicator', () => {
  describe('useContextStore - setSessionTokens', () => {
    test('setSessionTokens replaces (not accumulates) tokens', () => {
      act(() => {
        useContextStore.getState().setSessionTokens('session-1', {
          input: 100,
          output: 50,
          reasoning: 0,
          cacheRead: 10,
          cacheWrite: 5
        })
      })

      act(() => {
        useContextStore.getState().setSessionTokens('session-1', {
          input: 200,
          output: 100,
          reasoning: 50,
          cacheRead: 20,
          cacheWrite: 10
        })
      })

      const state = useContextStore.getState()
      const tokens = state.tokensBySession['session-1']
      // Should be REPLACED, not accumulated
      expect(tokens.input).toBe(200)
      expect(tokens.output).toBe(100)
      expect(tokens.reasoning).toBe(50)
      expect(tokens.cacheRead).toBe(20)
      expect(tokens.cacheWrite).toBe(10)
    })

    test('setSessionTokens sets snapshot for new session', () => {
      act(() => {
        useContextStore.getState().setSessionTokens('new-session', {
          input: 500,
          output: 200,
          reasoning: 100,
          cacheRead: 50,
          cacheWrite: 25
        })
      })

      const tokens = useContextStore.getState().tokensBySession['new-session']
      expect(tokens.input).toBe(500)
      expect(tokens.output).toBe(200)
      expect(tokens.reasoning).toBe(100)
      expect(tokens.cacheRead).toBe(50)
      expect(tokens.cacheWrite).toBe(25)
    })

    test('setSessionTokens tracks sessions independently', () => {
      act(() => {
        useContextStore.getState().setSessionTokens('session-a', {
          input: 100,
          output: 50,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
        useContextStore.getState().setSessionTokens('session-b', {
          input: 200,
          output: 100,
          reasoning: 50,
          cacheRead: 10,
          cacheWrite: 5
        })
      })

      const state = useContextStore.getState()
      expect(state.tokensBySession['session-a'].input).toBe(100)
      expect(state.tokensBySession['session-b'].input).toBe(200)
    })
  })

  describe('useContextStore - getContextUsage', () => {
    test('getContextUsage returns correct percentage with all 5 categories', () => {
      act(() => {
        useContextStore.getState().setModelLimit('claude-opus', 200000)
        useContextStore.getState().setSessionTokens('session-1', {
          input: 80000,
          output: 15000,
          reasoning: 5000,
          cacheRead: 1000,
          cacheWrite: 500
        })
      })

      const usage = useContextStore.getState().getContextUsage('session-1', 'claude-opus')
      // Context window = input + cacheRead + cacheWrite = 80000 + 1000 + 500 = 81500
      // (output and reasoning excluded — they don't occupy the context window)
      expect(usage.used).toBe(81500)
      expect(usage.limit).toBe(200000)
      expect(usage.percent).toBe(41)
    })

    test('getContextUsage returns null usage when no limit is known', () => {
      act(() => {
        useContextStore.getState().setSessionTokens('session-1', {
          input: 100,
          output: 50,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
      })

      const usage = useContextStore.getState().getContextUsage('session-1', 'unknown-model')
      // Context window = input only = 100 (output excluded)
      expect(usage.used).toBe(100)
      expect(usage.limit).toBeUndefined()
      expect(usage.percent).toBeNull()
    })

    test('getContextUsage can exceed 100 percent', () => {
      act(() => {
        useContextStore.getState().setModelLimit('claude-opus', 100)
        useContextStore.getState().setSessionTokens('session-1', {
          input: 200,
          output: 100,
          reasoning: 50,
          cacheRead: 0,
          cacheWrite: 0
        })
      })

      const usage = useContextStore.getState().getContextUsage('session-1', 'claude-opus')
      // Context window = input only = 200 (output/reasoning excluded)
      expect(usage.percent).toBe(200)
    })

    test('getContextUsage returns zeros for unknown session', () => {
      act(() => {
        useContextStore.getState().setModelLimit('claude-opus', 200000)
      })

      const usage = useContextStore.getState().getContextUsage('nonexistent', 'claude-opus')
      expect(usage.used).toBe(0)
      expect(usage.limit).toBe(200000)
      expect(usage.percent).toBe(0)
    })

    test('getContextUsage includes token breakdown', () => {
      act(() => {
        useContextStore.getState().setModelLimit('model-1', 200000)
        useContextStore.getState().setSessionTokens('session-1', {
          input: 1000,
          output: 500,
          reasoning: 200,
          cacheRead: 100,
          cacheWrite: 50
        })
      })

      const usage = useContextStore.getState().getContextUsage('session-1', 'model-1')
      expect(usage.tokens.input).toBe(1000)
      expect(usage.tokens.output).toBe(500)
      expect(usage.tokens.reasoning).toBe(200)
      expect(usage.tokens.cacheRead).toBe(100)
      expect(usage.tokens.cacheWrite).toBe(50)
    })

    test('getContextUsage includes cost', () => {
      act(() => {
        useContextStore.getState().setModelLimit('model-1', 200000)
        useContextStore.getState().setSessionTokens('session-1', {
          input: 1000,
          output: 500,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
        useContextStore.getState().setSessionCost('session-1', 0.025)
      })

      const usage = useContextStore.getState().getContextUsage('session-1', 'model-1')
      expect(usage.cost).toBeCloseTo(0.025)
    })
  })

  describe('useContextStore - resetSessionTokens', () => {
    test('resetSessionTokens clears session data', () => {
      act(() => {
        useContextStore.getState().setSessionTokens('session-1', {
          input: 100,
          output: 50,
          reasoning: 0,
          cacheRead: 10,
          cacheWrite: 5
        })
      })

      expect(useContextStore.getState().tokensBySession['session-1']).toBeDefined()

      act(() => {
        useContextStore.getState().resetSessionTokens('session-1')
      })

      expect(useContextStore.getState().tokensBySession['session-1']).toBeUndefined()
    })

    test('resetSessionTokens also clears cost', () => {
      act(() => {
        useContextStore.getState().setSessionTokens('session-1', {
          input: 100,
          output: 50,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
        useContextStore.getState().setSessionCost('session-1', 0.01)
      })

      act(() => {
        useContextStore.getState().resetSessionTokens('session-1')
      })

      expect(useContextStore.getState().costBySession['session-1']).toBeUndefined()
    })

    test('resetSessionTokens does not affect other sessions', () => {
      act(() => {
        useContextStore.getState().setSessionTokens('session-1', {
          input: 100,
          output: 50,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
        useContextStore.getState().setSessionTokens('session-2', {
          input: 200,
          output: 100,
          reasoning: 50,
          cacheRead: 0,
          cacheWrite: 0
        })
      })

      act(() => {
        useContextStore.getState().resetSessionTokens('session-1')
      })

      expect(useContextStore.getState().tokensBySession['session-1']).toBeUndefined()
      expect(useContextStore.getState().tokensBySession['session-2'].input).toBe(200)
    })
  })

  describe('useContextStore - setModelLimit', () => {
    test('setModelLimit stores limit correctly', () => {
      act(() => {
        useContextStore.getState().setModelLimit('claude-opus', 200000)
      })

      expect(useContextStore.getState().modelLimits[getModelLimitKey('claude-opus')]).toBe(200000)
    })

    test('setModelLimit handles multiple models', () => {
      act(() => {
        useContextStore.getState().setModelLimit('claude-opus', 200000)
        useContextStore.getState().setModelLimit('claude-sonnet', 180000)
      })

      expect(useContextStore.getState().modelLimits[getModelLimitKey('claude-opus')]).toBe(200000)
      expect(useContextStore.getState().modelLimits[getModelLimitKey('claude-sonnet')]).toBe(180000)
    })

    test('setModelLimit overwrites previous limit', () => {
      act(() => {
        useContextStore.getState().setModelLimit('claude-opus', 200000)
        useContextStore.getState().setModelLimit('claude-opus', 300000)
      })

      expect(useContextStore.getState().modelLimits[getModelLimitKey('claude-opus')]).toBe(300000)
    })
  })

  describe('Color thresholds', () => {
    test('percentage 30 is in green zone (0-60)', () => {
      act(() => {
        useContextStore.getState().setModelLimit('model', 200000)
        useContextStore.getState().setSessionTokens('s1', {
          input: 60000,
          output: 10000,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
      })

      const usage = useContextStore.getState().getContextUsage('s1', 'model')
      // Context window = input only = 60000 → 30%
      expect(usage.percent).toBe(30)
    })

    test('percentage 70 is in yellow zone (60-80)', () => {
      act(() => {
        useContextStore.getState().setModelLimit('model', 200000)
        useContextStore.getState().setSessionTokens('s1', {
          input: 140000,
          output: 20000,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
      })

      const usage = useContextStore.getState().getContextUsage('s1', 'model')
      // Context window = input only = 140000 → 70%
      expect(usage.percent).toBe(70)
    })

    test('percentage 85 is in orange zone (80-90)', () => {
      act(() => {
        useContextStore.getState().setModelLimit('model', 200000)
        useContextStore.getState().setSessionTokens('s1', {
          input: 170000,
          output: 20000,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
      })

      const usage = useContextStore.getState().getContextUsage('s1', 'model')
      // Context window = input only = 170000 → 85%
      expect(usage.percent).toBe(85)
    })

    test('percentage 95 is in red zone (90-100)', () => {
      act(() => {
        useContextStore.getState().setModelLimit('model', 200000)
        useContextStore.getState().setSessionTokens('s1', {
          input: 190000,
          output: 20000,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
      })

      const usage = useContextStore.getState().getContextUsage('s1', 'model')
      // Context window = input only = 190000 → 95%
      expect(usage.percent).toBe(95)
    })
  })

  describe('useContextStore - cost tracking', () => {
    test('setSessionCost sets cost for session', () => {
      act(() => {
        useContextStore.getState().setSessionCost('s1', 0.01)
      })

      expect(useContextStore.getState().costBySession['s1']).toBeCloseTo(0.01)
    })

    test('addSessionCost accumulates cost', () => {
      act(() => {
        useContextStore.getState().setSessionCost('s1', 0.01)
        useContextStore.getState().addSessionCost('s1', 0.005)
      })

      expect(useContextStore.getState().costBySession['s1']).toBeCloseTo(0.015)
    })

    test('addSessionCost works on new session', () => {
      act(() => {
        useContextStore.getState().addSessionCost('s1', 0.02)
      })

      expect(useContextStore.getState().costBySession['s1']).toBeCloseTo(0.02)
    })
  })
})
