import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

/**
 * Session 7: Worktree Status Store Extensions — Tests
 *
 * These tests verify:
 * 1. The store accepts 'planning' and 'answering' as valid status values
 * 2. getWorktreeStatus returns correct priority: answering > planning > working > unread > null
 * 3. Existing 'working' and 'unread' behavior is unchanged
 */

// Mock useSessionStore which is imported by useWorktreeStatusStore
vi.mock('@/stores/useSessionStore', () => {
  const sessionsByWorktree = new Map<string, Array<{ id: string }>>()
  sessionsByWorktree.set('wt-1', [{ id: 'session-1' }, { id: 'session-2' }, { id: 'session-3' }])
  sessionsByWorktree.set('wt-2', [{ id: 'session-4' }])

  return {
    useSessionStore: {
      getState: () => ({
        sessionsByWorktree,
        getSessionMode: () => 'build'
      })
    }
  }
})

describe('Session 7: Worktree Status Store Extensions', () => {
  beforeEach(() => {
    // Reset store state between tests
    const store = useWorktreeStatusStore.getState()
    // Clear all session statuses
    for (const key of Object.keys(store.sessionStatuses)) {
      store.clearSessionStatus(key)
    }
  })

  describe('setSessionStatus accepts new types', () => {
    test('accepts planning status', () => {
      const { setSessionStatus } = useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'planning')
      expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']?.status).toBe(
        'planning'
      )
    })

    test('accepts answering status', () => {
      const { setSessionStatus } = useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'answering')
      expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']?.status).toBe(
        'answering'
      )
    })

    test('still accepts working status', () => {
      const { setSessionStatus } = useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'working')
      expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']?.status).toBe('working')
    })

    test('still accepts unread status', () => {
      const { setSessionStatus } = useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'unread')
      expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']?.status).toBe('unread')
    })

    test('accepts null to clear status', () => {
      const { setSessionStatus } = useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'working')
      setSessionStatus('session-1', null)
      expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']).toBeNull()
    })
  })

  describe('getWorktreeStatus priority logic', () => {
    test('answering has highest priority', () => {
      const { setSessionStatus, getWorktreeStatus } = useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'working')
      setSessionStatus('session-2', 'answering')
      setSessionStatus('session-3', 'unread')
      expect(getWorktreeStatus('wt-1')).toBe('answering')
    })

    test('planning takes priority over working', () => {
      const { setSessionStatus, getWorktreeStatus } = useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'working')
      setSessionStatus('session-2', 'planning')
      expect(getWorktreeStatus('wt-1')).toBe('planning')
    })

    test('working takes priority over unread', () => {
      const { setSessionStatus, getWorktreeStatus } = useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'unread')
      setSessionStatus('session-2', 'working')
      expect(getWorktreeStatus('wt-1')).toBe('working')
    })

    test('unread returned when no active statuses', () => {
      const { setSessionStatus, getWorktreeStatus } = useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'unread')
      expect(getWorktreeStatus('wt-1')).toBe('unread')
    })

    test('returns null when no statuses set', () => {
      const { getWorktreeStatus } = useWorktreeStatusStore.getState()
      expect(getWorktreeStatus('wt-1')).toBeNull()
    })

    test('answering beats planning, working, and unread combined', () => {
      const { setSessionStatus, getWorktreeStatus } = useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'planning')
      setSessionStatus('session-2', 'working')
      setSessionStatus('session-3', 'answering')
      expect(getWorktreeStatus('wt-1')).toBe('answering')
    })

    test('planning beats working and unread', () => {
      const { setSessionStatus, getWorktreeStatus } = useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'working')
      setSessionStatus('session-2', 'unread')
      setSessionStatus('session-3', 'planning')
      expect(getWorktreeStatus('wt-1')).toBe('planning')
    })

    test('returns null for unknown worktree', () => {
      const { getWorktreeStatus } = useWorktreeStatusStore.getState()
      expect(getWorktreeStatus('nonexistent-wt')).toBeNull()
    })
  })

  describe('clearSessionStatus', () => {
    test('clears status and affects getWorktreeStatus', () => {
      const { setSessionStatus, clearSessionStatus, getWorktreeStatus } =
        useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'answering')
      expect(getWorktreeStatus('wt-1')).toBe('answering')
      clearSessionStatus('session-1')
      expect(getWorktreeStatus('wt-1')).toBeNull()
    })
  })

  describe('clearWorktreeUnread', () => {
    test('only clears unread statuses, not active ones', () => {
      const { setSessionStatus, clearWorktreeUnread, getWorktreeStatus } =
        useWorktreeStatusStore.getState()
      setSessionStatus('session-1', 'working')
      setSessionStatus('session-2', 'unread')
      clearWorktreeUnread('wt-1')
      // working should remain
      expect(getWorktreeStatus('wt-1')).toBe('working')
    })
  })
})
