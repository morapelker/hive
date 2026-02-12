import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { formatCompletionDuration, COMPLETION_WORDS } from '@/lib/format-utils'

/**
 * Session 7: Completion Badge — UI Integration Tests
 *
 * These tests verify:
 * 1. WorktreeItem renders completion text with word and duration
 * 2. Completion badge auto-clears after 30 seconds
 * 3. Starting new streaming clears completion badge
 * 4. Background sessions show completion badge then transition to unread
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
    // Unit test the display derivation logic including completed status
    function deriveDisplayStatus(
      isArchiving: boolean,
      worktreeStatus: string | null,
      completedEntry?: { word?: string; durationMs?: number } | null
    ): { displayStatus: string; statusClass: string } {
      return isArchiving
        ? { displayStatus: 'Archiving', statusClass: 'font-semibold text-muted-foreground' }
        : worktreeStatus === 'answering'
          ? { displayStatus: 'Answer questions', statusClass: 'font-semibold text-amber-500' }
          : worktreeStatus === 'planning'
            ? { displayStatus: 'Planning', statusClass: 'font-semibold text-blue-400' }
            : worktreeStatus === 'working'
              ? { displayStatus: 'Working', statusClass: 'font-semibold text-primary' }
              : worktreeStatus === 'completed'
                ? {
                    displayStatus: `${completedEntry?.word ?? 'Worked'} for ${formatCompletionDuration(completedEntry?.durationMs ?? 0)}`,
                    statusClass: 'font-semibold text-[#C15F3C]'
                  }
                : { displayStatus: 'Ready', statusClass: 'text-muted-foreground' }
    }

    test('completed status shows word and duration', () => {
      const result = deriveDisplayStatus(false, 'completed', {
        word: 'Brewed',
        durationMs: 23000
      })
      expect(result.displayStatus).toBe('Brewed for 23s')
      expect(result.statusClass).toContain('text-[#C15F3C]')
    })

    test('completed status with minutes', () => {
      const result = deriveDisplayStatus(false, 'completed', {
        word: 'Crafted',
        durationMs: 120000
      })
      expect(result.displayStatus).toBe('Crafted for 2m')
    })

    test('completed status with hours', () => {
      const result = deriveDisplayStatus(false, 'completed', {
        word: 'Built',
        durationMs: 3600000
      })
      expect(result.displayStatus).toBe('Built for 1h')
    })

    test('completed status defaults to "Worked" when word is missing', () => {
      const result = deriveDisplayStatus(false, 'completed', { durationMs: 5000 })
      expect(result.displayStatus).toBe('Worked for 5s')
    })

    test('completed status defaults to 0s when durationMs is missing', () => {
      const result = deriveDisplayStatus(false, 'completed', { word: 'Shipped' })
      expect(result.displayStatus).toBe('Shipped for 0s')
    })

    test('completed status defaults to "Worked for 0s" with no entry', () => {
      const result = deriveDisplayStatus(false, 'completed', null)
      expect(result.displayStatus).toBe('Worked for 0s')
    })

    test('archiving still takes priority over completed', () => {
      const result = deriveDisplayStatus(true, 'completed', { word: 'Built', durationMs: 5000 })
      expect(result.displayStatus).toBe('Archiving')
    })

    test('existing statuses still work', () => {
      expect(deriveDisplayStatus(false, 'working').displayStatus).toBe('Working')
      expect(deriveDisplayStatus(false, 'planning').displayStatus).toBe('Planning')
      expect(deriveDisplayStatus(false, 'answering').displayStatus).toBe('Answer questions')
      expect(deriveDisplayStatus(false, null).displayStatus).toBe('Ready')
    })
  })

  describe('Completion badge auto-clear (30 seconds)', () => {
    test('completion badge clears after 30 seconds for active session', () => {
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Brewed',
        durationMs: 23000
      })

      // Simulate what SessionView does: schedule auto-clear
      const sessionId = 'session-1'
      setTimeout(() => {
        const current = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
        if (current?.status === 'completed') {
          useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
        }
      }, 30_000)

      // Before 30s — badge should still be there
      vi.advanceTimersByTime(29_999)
      expect(getState().sessionStatuses['session-1']?.status).toBe('completed')

      // After 30s — badge should be cleared
      vi.advanceTimersByTime(2)
      expect(getState().sessionStatuses['session-1']).toBeNull()
    })

    test('background completion transitions to unread after 30 seconds', () => {
      const sessionId = 'session-2'
      const word = COMPLETION_WORDS[0]
      getState().setSessionStatus(sessionId, 'completed', { word, durationMs: 0 })

      // Simulate what global listener does: transition to unread after 30s
      setTimeout(() => {
        const current = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
        if (current?.status === 'completed') {
          useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'unread')
        }
      }, 30_000)

      // Before 30s — completed badge
      vi.advanceTimersByTime(29_999)
      expect(getState().sessionStatuses[sessionId]?.status).toBe('completed')

      // After 30s — transitions to unread (not null)
      vi.advanceTimersByTime(2)
      expect(getState().sessionStatuses[sessionId]?.status).toBe('unread')
    })

    test('auto-clear does not fire if status changed before timeout', () => {
      const sessionId = 'session-1'
      getState().setSessionStatus(sessionId, 'completed', {
        word: 'Built',
        durationMs: 5000
      })

      // Schedule auto-clear (mimicking SessionView)
      setTimeout(() => {
        const current = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
        if (current?.status === 'completed') {
          useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
        }
      }, 30_000)

      // Start new streaming before 30s — sets working
      vi.advanceTimersByTime(5_000)
      getState().setSessionStatus(sessionId, 'working')

      // After 30s — auto-clear should NOT fire because status is no longer 'completed'
      vi.advanceTimersByTime(25_001)
      expect(getState().sessionStatuses[sessionId]?.status).toBe('working')
    })
  })

  describe('Starting new streaming clears completion badge', () => {
    test('busy event transitions from completed to working', () => {
      getState().setSessionStatus('session-1', 'completed', {
        word: 'Shipped',
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
        word: 'Forged',
        durationMs: 45000
      })
      const entry = getState().getWorktreeCompletedEntry('wt-1')
      expect(entry).not.toBeNull()
      expect(entry?.word).toBe('Forged')
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
    let sessionViewSource: string
    let globalListenerSource: string
    let worktreeItemSource: string

    test('load source files', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const basePath = path.resolve(__dirname, '../../../src/renderer/src')

      sessionViewSource = fs.readFileSync(
        path.resolve(basePath, 'components/sessions/SessionView.tsx'),
        'utf-8'
      )
      globalListenerSource = fs.readFileSync(
        path.resolve(basePath, 'hooks/useOpenCodeGlobalListener.ts'),
        'utf-8'
      )
      worktreeItemSource = fs.readFileSync(
        path.resolve(basePath, 'components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )

      expect(sessionViewSource).toBeTruthy()
      expect(globalListenerSource).toBeTruthy()
      expect(worktreeItemSource).toBeTruthy()
    })

    test('SessionView imports COMPLETION_WORDS', async () => {
      const fs = await import('fs')
      const path = await import('path')
      sessionViewSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )
      expect(sessionViewSource).toContain('COMPLETION_WORDS')
      expect(sessionViewSource).toContain("from '@/lib/format-utils'")
    })

    test('SessionView has streamingStartTimeRef', async () => {
      const fs = await import('fs')
      const path = await import('path')
      sessionViewSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )
      expect(sessionViewSource).toContain('streamingStartTimeRef')
      expect(sessionViewSource).toContain('useRef<number | null>(null)')
    })

    test('SessionView sets completed status on idle', async () => {
      const fs = await import('fs')
      const path = await import('path')
      sessionViewSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )
      expect(sessionViewSource).toContain("'completed'")
      expect(sessionViewSource).toContain('word, durationMs')
      expect(sessionViewSource).toContain('30_000')
    })

    test('SessionView records busy start time', async () => {
      const fs = await import('fs')
      const path = await import('path')
      sessionViewSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )
      expect(sessionViewSource).toContain('streamingStartTimeRef.current = Date.now()')
    })

    test('useOpenCodeGlobalListener sets completed for background sessions', async () => {
      const fs = await import('fs')
      const path = await import('path')
      globalListenerSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/hooks/useOpenCodeGlobalListener.ts'),
        'utf-8'
      )
      expect(globalListenerSource).toContain('COMPLETION_WORDS')
      expect(globalListenerSource).toContain("'completed'")
      expect(globalListenerSource).toContain('30_000')
      // Background sessions should transition to unread, not clear
      expect(globalListenerSource).toContain("'unread'")
    })

    test('WorktreeItem renders completed status with bee icon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      worktreeItemSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )
      expect(worktreeItemSource).toContain('beeIcon')
      expect(worktreeItemSource).toContain("worktreeStatus === 'completed'")
      expect(worktreeItemSource).toContain('#C15F3C')
      expect(worktreeItemSource).toContain('formatCompletionDuration')
      expect(worktreeItemSource).toContain('getWorktreeCompletedEntry')
    })

    test('WorktreeItem excludes completed from default icon condition', async () => {
      const fs = await import('fs')
      const path = await import('path')
      worktreeItemSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )
      expect(worktreeItemSource).toContain("worktreeStatus !== 'completed'")
    })
  })
})
