import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { formatRelativeTime } from '@/lib/format-utils'

/**
 * Session 7: Last Message Time Store — Tests
 *
 * These tests verify:
 * 1. formatRelativeTime returns correct strings for all time brackets
 * 2. setLastMessageTime stores the latest timestamp per worktree (max logic)
 * 3. getLastMessageTime returns stored timestamp or null
 */

// Mock useSessionStore which is imported by useWorktreeStatusStore
vi.mock('@/stores/useSessionStore', () => {
  const sessionsByWorktree = new Map<string, Array<{ id: string }>>()
  sessionsByWorktree.set('wt-1', [{ id: 'session-1' }, { id: 'session-2' }])
  sessionsByWorktree.set('wt-2', [{ id: 'session-3' }])

  return {
    useSessionStore: {
      getState: () => ({
        sessionsByWorktree
      })
    }
  }
})

describe('Session 7: Last Message Time Store', () => {
  beforeEach(() => {
    // Reset store state between tests
    const store = useWorktreeStatusStore.getState()
    for (const key of Object.keys(store.sessionStatuses)) {
      store.clearSessionStatus(key)
    }
    // Reset lastMessageTimeByWorktree by setting state directly
    useWorktreeStatusStore.setState({ lastMessageTimeByWorktree: {} })
  })

  describe('formatRelativeTime', () => {
    test('returns "now" for < 1 minute', () => {
      expect(formatRelativeTime(Date.now() - 30000)).toBe('now')
    })

    test('returns "now" for 0ms difference', () => {
      expect(formatRelativeTime(Date.now())).toBe('now')
    })

    test('returns "Xm" for minutes', () => {
      expect(formatRelativeTime(Date.now() - 5 * 60000)).toBe('5m')
    })

    test('returns "1m" for exactly 1 minute', () => {
      expect(formatRelativeTime(Date.now() - 60000)).toBe('1m')
    })

    test('returns "59m" for 59 minutes', () => {
      expect(formatRelativeTime(Date.now() - 59 * 60000)).toBe('59m')
    })

    test('returns "Xh" for hours', () => {
      expect(formatRelativeTime(Date.now() - 3 * 3600000)).toBe('3h')
    })

    test('returns "1h" for exactly 1 hour', () => {
      expect(formatRelativeTime(Date.now() - 60 * 60000)).toBe('1h')
    })

    test('returns "23h" for 23 hours', () => {
      expect(formatRelativeTime(Date.now() - 23 * 3600000)).toBe('23h')
    })

    test('returns "Xd" for days', () => {
      expect(formatRelativeTime(Date.now() - 2 * 86400000)).toBe('2d')
    })

    test('returns "1d" for exactly 1 day', () => {
      expect(formatRelativeTime(Date.now() - 24 * 3600000)).toBe('1d')
    })

    test('returns "6d" for 6 days', () => {
      expect(formatRelativeTime(Date.now() - 6 * 86400000)).toBe('6d')
    })

    test('returns "Xw" for weeks', () => {
      expect(formatRelativeTime(Date.now() - 14 * 86400000)).toBe('2w')
    })

    test('returns "1w" for exactly 7 days', () => {
      expect(formatRelativeTime(Date.now() - 7 * 86400000)).toBe('1w')
    })
  })

  describe('setLastMessageTime', () => {
    test('stores timestamp for worktree', () => {
      const store = useWorktreeStatusStore.getState()
      store.setLastMessageTime('wt-1', 1000)
      expect(store.getLastMessageTime('wt-1')).toBe(1000)
    })

    test('keeps max timestamp (newer overwrites older)', () => {
      const store = useWorktreeStatusStore.getState()
      store.setLastMessageTime('wt-1', 1000)
      store.setLastMessageTime('wt-1', 2000)
      expect(useWorktreeStatusStore.getState().getLastMessageTime('wt-1')).toBe(2000)
    })

    test('keeps max timestamp (older does not overwrite newer)', () => {
      const store = useWorktreeStatusStore.getState()
      store.setLastMessageTime('wt-1', 2000)
      store.setLastMessageTime('wt-1', 1000) // older
      expect(useWorktreeStatusStore.getState().getLastMessageTime('wt-1')).toBe(2000)
    })

    test('stores independent timestamps per worktree', () => {
      const store = useWorktreeStatusStore.getState()
      store.setLastMessageTime('wt-1', 1000)
      store.setLastMessageTime('wt-2', 2000)
      expect(useWorktreeStatusStore.getState().getLastMessageTime('wt-1')).toBe(1000)
      expect(useWorktreeStatusStore.getState().getLastMessageTime('wt-2')).toBe(2000)
    })
  })

  describe('getLastMessageTime', () => {
    test('returns null for unknown worktree', () => {
      expect(useWorktreeStatusStore.getState().getLastMessageTime('unknown')).toBeNull()
    })

    test('returns stored timestamp', () => {
      useWorktreeStatusStore.getState().setLastMessageTime('wt-1', 12345)
      expect(useWorktreeStatusStore.getState().getLastMessageTime('wt-1')).toBe(12345)
    })
  })
})
