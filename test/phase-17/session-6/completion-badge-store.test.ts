import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { formatCompletionDuration, COMPLETION_WORDS } from '@/lib/format-utils'

/**
 * Session 6: Completion Badge — Store Layer Tests
 *
 * These tests verify:
 * 1. SessionStatus type includes 'completed'
 * 2. setSessionStatus accepts optional word and durationMs metadata
 * 3. sessionStatuses entries store the full SessionStatusEntry object
 * 4. formatCompletionDuration correctly formats durations
 * 5. COMPLETION_WORDS contains 10 fun words
 * 6. getWorktreeStatus aggregation handles 'completed' correctly
 */

// Mock useSessionStore which is imported by useWorktreeStatusStore
vi.mock('@/stores/useSessionStore', () => {
  const sessionsByWorktree = new Map<string, Array<{ id: string }>>()
  sessionsByWorktree.set('wt-1', [{ id: 'session-1' }, { id: 'session-2' }, { id: 'session-3' }])
  sessionsByWorktree.set('wt-2', [{ id: 'session-4' }])

  return {
    useSessionStore: {
      getState: () => ({
        sessionsByWorktree
      })
    }
  }
})

// Helper to get fresh state after mutations
const getState = () => useWorktreeStatusStore.getState()

describe('Session 6: Completion Badge Store', () => {
  beforeEach(() => {
    // Reset store state between tests
    const store = getState()
    for (const key of Object.keys(store.sessionStatuses)) {
      store.clearSessionStatus(key)
    }
  })

  describe('setSessionStatus with completed and metadata', () => {
    test('stores completed status with word and durationMs metadata', () => {
      getState().setSessionStatus('s1', 'completed', { word: 'Brewed', durationMs: 23000 })
      expect(getState().sessionStatuses['s1']).toEqual(
        expect.objectContaining({
          status: 'completed',
          word: 'Brewed',
          durationMs: 23000
        })
      )
    })

    test('stores completed status with only word metadata', () => {
      getState().setSessionStatus('s1', 'completed', { word: 'Shipped' })
      const entry = getState().sessionStatuses['s1']
      expect(entry?.status).toBe('completed')
      expect(entry?.word).toBe('Shipped')
      expect(entry?.durationMs).toBeUndefined()
    })

    test('stores completed status with only durationMs metadata', () => {
      getState().setSessionStatus('s1', 'completed', { durationMs: 5000 })
      const entry = getState().sessionStatuses['s1']
      expect(entry?.status).toBe('completed')
      expect(entry?.word).toBeUndefined()
      expect(entry?.durationMs).toBe(5000)
    })

    test('works without metadata (backward compat)', () => {
      getState().setSessionStatus('s1', 'working')
      expect(getState().sessionStatuses['s1']).toEqual(
        expect.objectContaining({
          status: 'working'
        })
      )
      expect(getState().sessionStatuses['s1']?.word).toBeUndefined()
      expect(getState().sessionStatuses['s1']?.durationMs).toBeUndefined()
    })

    test('timestamp is always included', () => {
      const before = Date.now()
      getState().setSessionStatus('s1', 'completed', { word: 'Built', durationMs: 10000 })
      const after = Date.now()
      const entry = getState().sessionStatuses['s1']
      expect(entry?.timestamp).toBeGreaterThanOrEqual(before)
      expect(entry?.timestamp).toBeLessThanOrEqual(after)
    })

    test('null status clears the entry', () => {
      getState().setSessionStatus('s1', 'completed', { word: 'Forged', durationMs: 1000 })
      getState().setSessionStatus('s1', null)
      expect(getState().sessionStatuses['s1']).toBeNull()
    })

    test('existing status types still work with metadata param', () => {
      getState().setSessionStatus('s1', 'planning')
      expect(getState().sessionStatuses['s1']?.status).toBe('planning')

      getState().setSessionStatus('s1', 'answering')
      expect(getState().sessionStatuses['s1']?.status).toBe('answering')

      getState().setSessionStatus('s1', 'unread')
      expect(getState().sessionStatuses['s1']?.status).toBe('unread')
    })
  })

  describe('getWorktreeStatus priority with completed', () => {
    test('completed is lower priority than working', () => {
      getState().setSessionStatus('session-1', 'completed', { word: 'Built', durationMs: 5000 })
      getState().setSessionStatus('session-2', 'working')
      expect(getState().getWorktreeStatus('wt-1')).toBe('working')
    })

    test('completed is lower priority than planning', () => {
      getState().setSessionStatus('session-1', 'completed', { word: 'Built', durationMs: 5000 })
      getState().setSessionStatus('session-2', 'planning')
      expect(getState().getWorktreeStatus('wt-1')).toBe('planning')
    })

    test('completed is lower priority than answering', () => {
      getState().setSessionStatus('session-1', 'completed', { word: 'Built', durationMs: 5000 })
      getState().setSessionStatus('session-2', 'answering')
      expect(getState().getWorktreeStatus('wt-1')).toBe('answering')
    })

    test('completed is higher priority than unread', () => {
      getState().setSessionStatus('session-1', 'completed', { word: 'Built', durationMs: 5000 })
      getState().setSessionStatus('session-2', 'unread')
      expect(getState().getWorktreeStatus('wt-1')).toBe('completed')
    })

    test('completed returns when it is the only status', () => {
      getState().setSessionStatus('session-1', 'completed', { word: 'Crafted', durationMs: 15000 })
      expect(getState().getWorktreeStatus('wt-1')).toBe('completed')
    })

    test('full priority chain: answering > planning > working > completed > unread > null', () => {
      // Just completed
      getState().setSessionStatus('session-1', 'completed', { word: 'Built', durationMs: 5000 })
      expect(getState().getWorktreeStatus('wt-1')).toBe('completed')

      // Add unread — completed still wins
      getState().setSessionStatus('session-2', 'unread')
      expect(getState().getWorktreeStatus('wt-1')).toBe('completed')

      // Add working — working wins over completed
      getState().setSessionStatus('session-3', 'working')
      expect(getState().getWorktreeStatus('wt-1')).toBe('working')

      // Change to planning — planning wins
      getState().setSessionStatus('session-3', 'planning')
      expect(getState().getWorktreeStatus('wt-1')).toBe('planning')

      // Change to answering — answering wins
      getState().setSessionStatus('session-3', 'answering')
      expect(getState().getWorktreeStatus('wt-1')).toBe('answering')
    })
  })

  describe('formatCompletionDuration', () => {
    test('formats seconds correctly', () => {
      expect(formatCompletionDuration(23000)).toBe('23s')
      expect(formatCompletionDuration(1000)).toBe('1s')
      expect(formatCompletionDuration(59000)).toBe('59s')
    })

    test('rounds sub-second to nearest second', () => {
      expect(formatCompletionDuration(500)).toBe('1s')
      expect(formatCompletionDuration(1500)).toBe('2s')
    })

    test('formats 0ms as 0s', () => {
      expect(formatCompletionDuration(0)).toBe('0s')
    })

    test('formats minutes correctly', () => {
      expect(formatCompletionDuration(60000)).toBe('1m')
      expect(formatCompletionDuration(120000)).toBe('2m')
    })

    test('rounds seconds to nearest minute', () => {
      expect(formatCompletionDuration(90000)).toBe('2m')
      expect(formatCompletionDuration(75000)).toBe('1m')
    })

    test('formats hours correctly', () => {
      expect(formatCompletionDuration(3600000)).toBe('1h')
      expect(formatCompletionDuration(7200000)).toBe('2h')
    })
  })

  describe('COMPLETION_WORDS', () => {
    test('has at least 10 entries', () => {
      expect(COMPLETION_WORDS.length).toBeGreaterThanOrEqual(10)
    })

    test('all entries are non-empty strings', () => {
      for (const word of COMPLETION_WORDS) {
        expect(typeof word).toBe('string')
        expect(word.length).toBeGreaterThan(0)
      }
    })

    test('contains expected bee-themed words', () => {
      expect(COMPLETION_WORDS).toContain('Brewed')
      expect(COMPLETION_WORDS).toContain('Buzzed')
      expect(COMPLETION_WORDS).toContain('Hived')
      expect(COMPLETION_WORDS).toContain('Honeyed')
      expect(COMPLETION_WORDS).toContain('Swarmed')
    })
  })
})
