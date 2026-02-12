import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { COMPLETION_WORDS } from '@/lib/format-utils'

/**
 * Session 7: Completion Badge — UI Integration Tests
 *
 * These tests verify:
 * 1. WorktreeItem shows "Ready" for completed status (no badge in sidebar)
 * 2. Completion badge persists until next message (no auto-clear timeout)
 * 3. Starting new streaming clears completion badge
 * 4. Background sessions track duration and show completion badge
 * 5. Source files contain correct completion badge implementations
 */

// Mock useSessionStore
vi.mock('@/stores/useSessionStore', () => {
  const sessionsByWorktree = new Map<string, Array<{ id: string }>>()
  sessionsByWorktree.set('wt-1', [{ id: 'session-1' }, { id: 'session-2' }])

  return {
    useSessionStore: {
      getState: () => ({
        sessionsByWorktree,
        activeSessionId: 'session-1',
        getSessionMode: () => 'build'
      })
    }
  }
})

// Helper to get fresh state after mutations
const getState = () => useWorktreeStatusStore.getState()

describe('Session 7: Completion Badge UI', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    const store = getState()
    for (const key of Object.keys(store.sessionStatuses)) {
      store.clearSessionStatus(key)
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('WorktreeItem displayStatus with completed', () => {
    // The sidebar now shows "Ready" for completed status (badge only shown inline in SessionView)
    function deriveDisplayStatus(
      isArchiving: boolean,
      worktreeStatus: string | null
    ): { displayStatus: string; statusClass: string } {
      return isArchiving
        ? { displayStatus: 'Archiving', statusClass: 'font-semibold text-muted-foreground' }
        : worktreeStatus === 'answering'
          ? { displayStatus: 'Answer questions', statusClass: 'font-semibold text-amber-500' }
          : worktreeStatus === 'planning'
            ? { displayStatus: 'Planning', statusClass: 'font-semibold text-blue-400' }
            : worktreeStatus === 'working'
              ? { displayStatus: 'Working', statusClass: 'font-semibold text-primary' }
              : { displayStatus: 'Ready', statusClass: 'text-muted-foreground' }
    }

    test('completed status shows Ready in sidebar', () => {
      const result = deriveDisplayStatus(false, 'completed')
      expect(result.displayStatus).toBe('Ready')
    })

    test('archiving still takes priority', () => {
      const result = deriveDisplayStatus(true, 'completed')
      expect(result.displayStatus).toBe('Archiving')
    })

    test('existing statuses still work', () => {
      expect(deriveDisplayStatus(false, 'working').displayStatus).toBe('Working')
      expect(deriveDisplayStatus(false, 'planning').displayStatus).toBe('Planning')
      expect(deriveDisplayStatus(false, 'answering').displayStatus).toBe('Answer questions')
      expect(deriveDisplayStatus(false, null).displayStatus).toBe('Ready')
    })
  })

  describe('Completion badge persistence', () => {
    test('completion badge persists indefinitely until next message', () => {
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Brewed',
        durationMs: 23000
      })

      // Even after a long time, badge should still be present
      vi.advanceTimersByTime(120_000)
      expect(getState().sessionStatuses['session-1']?.status).toBe('completed')
      expect(getState().sessionStatuses['session-1']?.word).toBe('Brewed')
    })

    test('completion badge clears when new message starts (busy event)', () => {
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Buzzed',
        durationMs: 10000
      })
      expect(getState().sessionStatuses['session-1']?.status).toBe('completed')

      // Simulate busy event — sets working
      getState().setSessionStatus('session-1', 'working')
      expect(getState().sessionStatuses['session-1']?.status).toBe('working')
      expect(getState().sessionStatuses['session-1']?.word).toBeUndefined()
      expect(getState().sessionStatuses['session-1']?.durationMs).toBeUndefined()
    })

    test('background session badge also persists', () => {
      getState().setSessionStatus('session-2', 'completed', {
        word: COMPLETION_WORDS[0],
        durationMs: 15000
      })

      // Even after a long time, badge should still be present
      vi.advanceTimersByTime(120_000)
      expect(getState().sessionStatuses['session-2']?.status).toBe('completed')
    })
  })

  describe('Starting new streaming clears completion badge', () => {
    test('busy event transitions from completed to working', () => {
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Hived',
        durationMs: 10000
      })
      expect(getState().sessionStatuses['session-1']?.status).toBe('completed')

      // Simulate session.status busy event
      getState().setSessionStatus('session-1', 'working')
      expect(getState().sessionStatuses['session-1']?.status).toBe('working')
      // Metadata should be gone
      expect(getState().sessionStatuses['session-1']?.word).toBeUndefined()
      expect(getState().sessionStatuses['session-1']?.durationMs).toBeUndefined()
    })
  })

  describe('getWorktreeCompletedEntry', () => {
    test('returns the completed entry with metadata', () => {
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Foraged',
        durationMs: 45000
      })
      const entry = getState().getWorktreeCompletedEntry('wt-1')
      expect(entry).not.toBeNull()
      expect(entry?.word).toBe('Foraged')
      expect(entry?.durationMs).toBe(45000)
    })

    test('returns null when no sessions are completed', () => {
      getState().setSessionStatus('session-1', 'working')
      const entry = getState().getWorktreeCompletedEntry('wt-1')
      expect(entry).toBeNull()
    })

    test('returns null for unknown worktree', () => {
      const entry = getState().getWorktreeCompletedEntry('nonexistent')
      expect(entry).toBeNull()
    })
  })

  describe('Source file verification', () => {
    test('SessionView imports COMPLETION_WORDS', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sessionViewSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )
      expect(sessionViewSource).toContain('COMPLETION_WORDS')
      expect(sessionViewSource).toContain("from '@/lib/format-utils'")
    })

    test('SessionView uses shared messageSendTimes for duration tracking', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sessionViewSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )
      expect(sessionViewSource).toContain('messageSendTimes')
      expect(sessionViewSource).toContain("from '@/lib/message-send-times'")
    })

    test('SessionView sets completed status on idle without auto-clear timeout', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sessionViewSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )
      expect(sessionViewSource).toContain("'completed'")
      expect(sessionViewSource).toContain('word, durationMs')
      // Should NOT have 30-second auto-clear timeout
      expect(sessionViewSource).not.toContain('Auto-clear completion badge after 30 seconds')
    })

    test('SessionView sets send time in handleSend', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sessionViewSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )
      expect(sessionViewSource).toContain('messageSendTimes.set(sessionId, Date.now())')
    })

    test('useOpenCodeGlobalListener uses shared messageSendTimes', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const globalListenerSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/hooks/useOpenCodeGlobalListener.ts'),
        'utf-8'
      )
      expect(globalListenerSource).toContain('COMPLETION_WORDS')
      expect(globalListenerSource).toContain("'completed'")
      expect(globalListenerSource).toContain('messageSendTimes')
      // Should NOT have its own tracking or 30-second timeout
      expect(globalListenerSource).not.toContain('backgroundStreamingStartTimes')
      expect(globalListenerSource).not.toContain('30_000')
    })

    test('WorktreeItem shows Ready for completed (no bee icon or completion text)', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const worktreeItemSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )
      // Should NOT have bee icon, completion formatting, or completed entry
      expect(worktreeItemSource).not.toContain('beeIcon')
      expect(worktreeItemSource).not.toContain('formatCompletionDuration')
      expect(worktreeItemSource).not.toContain('getWorktreeCompletedEntry')
      expect(worktreeItemSource).not.toContain('#C15F3C')
    })
  })
})
