import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { useContextStore } from '../../../src/renderer/src/stores/useContextStore'
import { extractTokens, extractCost } from '../../../src/renderer/src/lib/token-utils'

beforeEach(() => {
  vi.clearAllMocks()

  useContextStore.setState({
    tokensBySession: {},
    costBySession: {},
    modelLimits: {}
  })
})

describe('Session 1: Context Calculation Fix', () => {
  describe('useContextStore', () => {
    test('setSessionTokens replaces (not accumulates) tokens', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setSessionTokens('s1', {
          input: 100,
          output: 50,
          reasoning: 10,
          cacheRead: 30,
          cacheWrite: 20
        })
      })
      act(() => {
        store.setSessionTokens('s1', {
          input: 200,
          output: 80,
          reasoning: 0,
          cacheRead: 50,
          cacheWrite: 10
        })
      })
      const usage = store.getContextUsage('s1', 'model1')
      // Should be 200+80+0+50+10 = 340, NOT 300+130+10+80+30 = 550
      expect(usage.used).toBe(340)
    })

    test('getContextUsage computes correct total with all 5 categories', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setModelLimit('model1', 200000)
        store.setSessionTokens('s1', {
          input: 15000,
          output: 2000,
          reasoning: 500,
          cacheRead: 3000,
          cacheWrite: 1500
        })
      })
      const usage = store.getContextUsage('s1', 'model1')
      expect(usage.used).toBe(22000) // 15000+2000+500+3000+1500
      expect(usage.percent).toBe(11) // Math.round(22000/200000*100)
    })

    test('cost tracks per session', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setSessionCost('s1', 0.01)
        store.addSessionCost('s1', 0.005)
      })
      const usage = store.getContextUsage('s1', 'model1')
      expect(usage.cost).toBeCloseTo(0.015)
    })

    test('resetSessionTokens clears both tokens and cost', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setSessionTokens('s1', {
          input: 100,
          output: 50,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
        store.setSessionCost('s1', 0.01)
      })

      act(() => {
        store.resetSessionTokens('s1')
      })

      expect(useContextStore.getState().tokensBySession['s1']).toBeUndefined()
      expect(useContextStore.getState().costBySession['s1']).toBeUndefined()
    })

    test('addSessionCost initializes from zero for new session', () => {
      const store = useContextStore.getState()
      act(() => {
        store.addSessionCost('s1', 0.005)
      })
      expect(useContextStore.getState().costBySession['s1']).toBeCloseTo(0.005)
    })

    test('setSessionCost replaces existing cost', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setSessionCost('s1', 0.01)
        store.setSessionCost('s1', 0.02)
      })
      expect(useContextStore.getState().costBySession['s1']).toBeCloseTo(0.02)
    })

    test('usage percent is 0 when no limit set', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setSessionTokens('s1', {
          input: 1000,
          output: 500,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
      })
      const usage = store.getContextUsage('s1', 'unknown-model')
      expect(usage.used).toBe(1500)
      expect(usage.percent).toBe(0)
    })

    test('usage percent caps at 100', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setModelLimit('model1', 100)
        store.setSessionTokens('s1', {
          input: 200,
          output: 100,
          reasoning: 50,
          cacheRead: 0,
          cacheWrite: 0
        })
      })
      const usage = store.getContextUsage('s1', 'model1')
      expect(usage.percent).toBe(100)
    })
  })

  describe('extractTokens', () => {
    test('parses standard token format', () => {
      const result = extractTokens({
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 30, write: 20 } }
      })
      expect(result).toEqual({
        input: 100,
        output: 50,
        reasoning: 10,
        cacheRead: 30,
        cacheWrite: 20
      })
    })

    test('returns null when no tokens', () => {
      expect(extractTokens({})).toBeNull()
    })

    test('returns null when all zeros', () => {
      const result = extractTokens({
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      })
      expect(result).toBeNull()
    })

    test('handles missing cache field', () => {
      const result = extractTokens({ tokens: { input: 100, output: 50 } })
      expect(result).toEqual({ input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    })

    test('handles missing reasoning field', () => {
      const result = extractTokens({
        tokens: { input: 100, output: 50, cache: { read: 10, write: 5 } }
      })
      expect(result).toEqual({ input: 100, output: 50, reasoning: 0, cacheRead: 10, cacheWrite: 5 })
    })

    test('handles partial cache field', () => {
      const result = extractTokens({ tokens: { input: 100, output: 50, cache: { read: 10 } } })
      expect(result).toEqual({ input: 100, output: 50, reasoning: 0, cacheRead: 10, cacheWrite: 0 })
    })

    test('handles tokens field as undefined', () => {
      expect(extractTokens({ tokens: undefined })).toBeNull()
    })

    test('parses tokens nested under info (DB/streaming format)', () => {
      const result = extractTokens({
        info: {
          tokens: { input: 500, output: 200, reasoning: 50, cache: { read: 100, write: 30 } }
        }
      })
      expect(result).toEqual({
        input: 500,
        output: 200,
        reasoning: 50,
        cacheRead: 100,
        cacheWrite: 30
      })
    })

    test('prefers top-level tokens over info.tokens', () => {
      const result = extractTokens({
        tokens: { input: 100, output: 50 },
        info: { tokens: { input: 999, output: 999 } }
      })
      expect(result).toEqual({
        input: 100,
        output: 50,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0
      })
    })
  })

  describe('extractCost', () => {
    test('extracts numeric cost', () => {
      expect(extractCost({ cost: 0.025 })).toBe(0.025)
    })

    test('returns 0 for missing cost', () => {
      expect(extractCost({})).toBe(0)
    })

    test('returns 0 for non-numeric cost', () => {
      expect(extractCost({ cost: 'high' })).toBe(0)
    })

    test('returns 0 for null cost', () => {
      expect(extractCost({ cost: null })).toBe(0)
    })

    test('extracts cost nested under info', () => {
      expect(extractCost({ info: { cost: 0.035 } })).toBe(0.035)
    })

    test('prefers top-level cost over info.cost', () => {
      expect(extractCost({ cost: 0.01, info: { cost: 0.99 } })).toBe(0.01)
    })
  })
})
