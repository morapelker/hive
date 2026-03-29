import { describe, test, expect, vi, beforeEach } from 'vitest'
import { formatTokenCount } from '@/lib/format-utils'

describe('formatTokenCount', () => {
  test('returns integer string for values below 1000', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(1)).toBe('1')
    expect(formatTokenCount(42)).toBe('42')
    expect(formatTokenCount(999)).toBe('999')
  })

  test('switches to k notation at exactly 1000', () => {
    expect(formatTokenCount(1000)).toBe('1.0k')
  })

  test('formats k notation with 1 decimal place', () => {
    expect(formatTokenCount(1100)).toBe('1.1k')
    expect(formatTokenCount(1500)).toBe('1.5k')
    expect(formatTokenCount(9999)).toBe('10.0k')
    expect(formatTokenCount(12500)).toBe('12.5k')
    expect(formatTokenCount(999900)).toBe('999.9k')
  })

  test('switches to m notation at 1,000,000', () => {
    expect(formatTokenCount(1000000)).toBe('1.0m')
  })

  test('formats m notation with 1 decimal place', () => {
    expect(formatTokenCount(1500000)).toBe('1.5m')
    expect(formatTokenCount(2300000)).toBe('2.3m')
  })
})

import {
  tokenBaselines,
  sumAllTokens,
  snapshotTokenBaseline,
  computeTokenDelta
} from '@/lib/token-baselines'
import { useContextStore } from '@/stores/useContextStore'

// Mock useConnectionStore (imported transitively by useWorktreeStatusStore)
vi.mock('@/stores/useConnectionStore', () => ({
  useConnectionStore: { getState: () => ({ connections: [] }) }
}))

// Mock useSessionStore (imported transitively by useWorktreeStatusStore)
vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      sessionsByWorktree: new Map(),
      sessionsByConnection: new Map(),
      getSessionMode: () => 'build'
    })
  }
}))

describe('sumAllTokens', () => {
  test('sums all five token fields', () => {
    expect(
      sumAllTokens({ input: 100, output: 200, reasoning: 50, cacheRead: 30, cacheWrite: 20 })
    ).toBe(400)
  })

  test('returns 0 for undefined', () => {
    expect(sumAllTokens(undefined)).toBe(0)
  })
})

describe('snapshotTokenBaseline / computeTokenDelta', () => {
  beforeEach(() => {
    tokenBaselines.clear()
    useContextStore.getState().resetSessionTokens('test-session')
  })

  test('snapshotTokenBaseline captures current total as baseline', () => {
    useContextStore
      .getState()
      .setSessionTokens('test-session', {
        input: 100,
        output: 50,
        reasoning: 0,
        cacheRead: 10,
        cacheWrite: 5
      })

    snapshotTokenBaseline('test-session')
    expect(tokenBaselines.get('test-session')).toBe(165)
  })

  test('snapshotTokenBaseline stores 0 when no tokens exist', () => {
    snapshotTokenBaseline('test-session')
    expect(tokenBaselines.get('test-session')).toBe(0)
  })

  test('computeTokenDelta returns current minus baseline', () => {
    useContextStore
      .getState()
      .setSessionTokens('test-session', {
        input: 100,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0
      })
    snapshotTokenBaseline('test-session')

    useContextStore
      .getState()
      .setSessionTokens('test-session', {
        input: 200,
        output: 100,
        reasoning: 50,
        cacheRead: 0,
        cacheWrite: 0
      })

    expect(computeTokenDelta('test-session')).toBe(250)
  })

  test('computeTokenDelta returns 0 when no baseline exists', () => {
    expect(computeTokenDelta('test-session')).toBe(0)
  })

  test('computeTokenDelta never returns negative', () => {
    useContextStore
      .getState()
      .setSessionTokens('test-session', {
        input: 500,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0
      })
    snapshotTokenBaseline('test-session')

    useContextStore.getState().clearSessionTokenSnapshot('test-session')

    expect(computeTokenDelta('test-session')).toBe(0)
  })
})
