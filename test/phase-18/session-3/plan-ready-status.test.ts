import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type { SessionStatusType } from '@/stores/useWorktreeStatusStore'
import { lastSendMode } from '@/lib/message-send-times'

/**
 * Session 3: Plan Ready Status
 *
 * These tests verify:
 * 1. 'plan_ready' is a valid SessionStatusType
 * 2. getWorktreeStatus derives plan_ready from lastSendMode (the mode at send time)
 * 3. Sending in build mode after a plan completes shows "Ready", not "Plan ready"
 * 4. plan_ready has correct priority in the status aggregation
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

describe('Session 3: Plan Ready Status', () => {
  beforeEach(() => {
    const store = getState()
    for (const key of Object.keys(store.sessionStatuses)) {
      store.clearSessionStatus(key)
    }
    lastSendMode.clear()
  })

  describe('plan_ready as a valid status type', () => {
    test('plan_ready is a valid SessionStatusType', () => {
      const validStatus: SessionStatusType = 'plan_ready'
      expect(validStatus).toBe('plan_ready')
    })
  })

  describe('plan_ready derived from lastSendMode', () => {
    test('returns plan_ready when completed session was sent in plan mode', () => {
      lastSendMode.set('session-1', 'plan')
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Crafted',
        durationMs: 5000
      })
      expect(getState().getWorktreeStatus('wt-1')).toBe('plan_ready')
    })

    test('returns completed when completed session was sent in build mode', () => {
      lastSendMode.set('session-1', 'build')
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Built',
        durationMs: 5000
      })
      expect(getState().getWorktreeStatus('wt-1')).toBe('completed')
    })

    test('returns completed when no lastSendMode recorded (defaults to build)', () => {
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Shipped',
        durationMs: 3000
      })
      expect(getState().getWorktreeStatus('wt-1')).toBe('completed')
    })
  })

  describe('user workflow: plan → switch to build → execute', () => {
    test('plan completes → plan_ready, then build completes → completed', () => {
      // Step 1: User sends in plan mode
      lastSendMode.set('session-1', 'plan')
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Crafted',
        durationMs: 5000
      })
      expect(getState().getWorktreeStatus('wt-1')).toBe('plan_ready')

      // Step 2: User switches to build mode and types "go"
      lastSendMode.set('session-1', 'build')
      getState().setSessionStatus('session-1', 'working')
      expect(getState().getWorktreeStatus('wt-1')).toBe('working')

      // Step 3: Build completes → should be 'completed' (Ready)
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Built',
        durationMs: 3000
      })
      expect(getState().getWorktreeStatus('wt-1')).toBe('completed')
    })
  })

  describe('multiple sessions in same worktree', () => {
    test('idle plan-mode session does not pollute build-mode completed session', () => {
      // session-1: sent in build mode, completed
      // session-2: was previously used in plan mode but is idle
      lastSendMode.set('session-1', 'build')
      lastSendMode.set('session-2', 'plan')
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Built',
        durationMs: 5000
      })
      // Only session-1 is completed (in build mode) — should be 'completed'
      expect(getState().getWorktreeStatus('wt-1')).toBe('completed')
    })

    test('plan_ready when one completed session was sent in plan mode', () => {
      lastSendMode.set('session-1', 'plan')
      lastSendMode.set('session-2', 'build')
      getState().setSessionStatus('session-1', 'completed', { word: 'Crafted', durationMs: 5000 })
      getState().setSessionStatus('session-2', 'completed', { word: 'Built', durationMs: 3000 })
      expect(getState().getWorktreeStatus('wt-1')).toBe('plan_ready')
    })
  })

  describe('priority ordering', () => {
    test('answering overrides plan_ready', () => {
      lastSendMode.set('session-1', 'plan')
      getState().setSessionStatus('session-1', 'completed', { word: 'Crafted', durationMs: 5000 })
      getState().setSessionStatus('session-2', 'answering')
      expect(getState().getWorktreeStatus('wt-1')).toBe('answering')
    })

    test('planning overrides plan_ready', () => {
      lastSendMode.set('session-1', 'plan')
      getState().setSessionStatus('session-1', 'completed', { word: 'Crafted', durationMs: 5000 })
      getState().setSessionStatus('session-2', 'planning')
      expect(getState().getWorktreeStatus('wt-1')).toBe('planning')
    })

    test('working overrides plan_ready', () => {
      lastSendMode.set('session-1', 'plan')
      getState().setSessionStatus('session-1', 'completed', { word: 'Crafted', durationMs: 5000 })
      getState().setSessionStatus('session-2', 'working')
      expect(getState().getWorktreeStatus('wt-1')).toBe('working')
    })
  })

  describe('getWorktreeCompletedEntry unaffected', () => {
    test('returns raw completed entry even when plan_ready is derived', () => {
      lastSendMode.set('session-1', 'plan')
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Crafted',
        durationMs: 5000
      })
      expect(getState().getWorktreeStatus('wt-1')).toBe('plan_ready')
      const entry = getState().getWorktreeCompletedEntry('wt-1')
      expect(entry?.status).toBe('completed')
      expect(entry?.word).toBe('Crafted')
    })
  })
})
