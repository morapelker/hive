import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

/**
 * Session 6: Permission Requested Status
 *
 * These tests verify:
 * 1. 'permission' is a valid SessionStatusType
 * 2. 'permission' has the same priority as 'answering' (highest — immediate return)
 * 3. setSessionStatus accepts 'permission' status
 * 4. getWorktreeStatus correctly aggregates 'permission' priority
 * 5. 'permission' takes priority over working, planning, completed, and unread
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

// Helper to get fresh state after mutations
const getState = () => useWorktreeStatusStore.getState()

describe('Session 6: Permission Requested Status', () => {
  beforeEach(() => {
    // Reset store state between tests
    const store = getState()
    for (const key of Object.keys(store.sessionStatuses)) {
      store.clearSessionStatus(key)
    }
  })

  describe('permission status type', () => {
    test('setSessionStatus accepts permission status', () => {
      getState().setSessionStatus('session-1', 'permission')
      expect(getState().sessionStatuses['session-1']).toEqual(
        expect.objectContaining({
          status: 'permission'
        })
      )
    })

    test('permission status includes timestamp', () => {
      const before = Date.now()
      getState().setSessionStatus('session-1', 'permission')
      const after = Date.now()
      const entry = getState().sessionStatuses['session-1']
      expect(entry?.timestamp).toBeGreaterThanOrEqual(before)
      expect(entry?.timestamp).toBeLessThanOrEqual(after)
    })

    test('clearSessionStatus clears permission status', () => {
      getState().setSessionStatus('session-1', 'permission')
      getState().clearSessionStatus('session-1')
      expect(getState().sessionStatuses['session-1']).toBeNull()
    })

    test('permission can be overwritten by working status', () => {
      getState().setSessionStatus('session-1', 'permission')
      getState().setSessionStatus('session-1', 'working')
      expect(getState().sessionStatuses['session-1']?.status).toBe('working')
    })

    test('permission can be overwritten by planning status', () => {
      getState().setSessionStatus('session-1', 'permission')
      getState().setSessionStatus('session-1', 'planning')
      expect(getState().sessionStatuses['session-1']?.status).toBe('planning')
    })
  })

  describe('getWorktreeStatus priority with permission', () => {
    test('permission has same priority as answering — returns immediately', () => {
      getState().setSessionStatus('session-1', 'permission')
      expect(getState().getWorktreeStatus('wt-1')).toBe('permission')
    })

    test('permission takes priority over working', () => {
      getState().setSessionStatus('session-1', 'working')
      getState().setSessionStatus('session-2', 'permission')
      expect(getState().getWorktreeStatus('wt-1')).toBe('permission')
    })

    test('permission takes priority over planning', () => {
      getState().setSessionStatus('session-1', 'planning')
      getState().setSessionStatus('session-2', 'permission')
      expect(getState().getWorktreeStatus('wt-1')).toBe('permission')
    })

    test('permission takes priority over completed', () => {
      getState().setSessionStatus('session-1', 'completed', { word: 'Built', durationMs: 5000 })
      getState().setSessionStatus('session-2', 'permission')
      expect(getState().getWorktreeStatus('wt-1')).toBe('permission')
    })

    test('permission takes priority over unread', () => {
      getState().setSessionStatus('session-1', 'unread')
      getState().setSessionStatus('session-2', 'permission')
      expect(getState().getWorktreeStatus('wt-1')).toBe('permission')
    })

    test('first permission/answering found wins (iteration order)', () => {
      // Both permission and answering have immediate-return priority.
      // Whichever is encountered first in session iteration wins.
      getState().setSessionStatus('session-1', 'permission')
      getState().setSessionStatus('session-2', 'answering')
      const result = getState().getWorktreeStatus('wt-1')
      // session-1 is iterated first, so 'permission' is returned
      expect(result).toBe('permission')
    })

    test('answering found first wins over later permission', () => {
      getState().setSessionStatus('session-1', 'answering')
      getState().setSessionStatus('session-2', 'permission')
      const result = getState().getWorktreeStatus('wt-1')
      expect(result).toBe('answering')
    })

    test('worktree with no permission returns null when no other statuses', () => {
      expect(getState().getWorktreeStatus('wt-1')).toBeNull()
    })

    test('clearing permission reverts worktree status to next priority', () => {
      getState().setSessionStatus('session-1', 'permission')
      getState().setSessionStatus('session-2', 'working')
      expect(getState().getWorktreeStatus('wt-1')).toBe('permission')

      // Clear permission — working should take over
      getState().clearSessionStatus('session-1')
      expect(getState().getWorktreeStatus('wt-1')).toBe('working')
    })
  })
})
