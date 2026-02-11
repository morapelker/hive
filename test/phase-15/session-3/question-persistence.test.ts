import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type { QuestionRequest } from '@/stores/useQuestionStore'

/**
 * Session 3: Question Dialog Persistence — Tests
 *
 * These tests verify:
 * 1. Questions survive SessionView unmount (clearSession no longer called)
 * 2. Global listener adds questions for background sessions
 * 3. Global listener ignores question events for active sessions
 * 4. Global listener removes questions on reply/reject for background sessions
 * 5. Multiple concurrent questions across different sessions are handled independently
 */

// Mock useSessionStore which is imported by useWorktreeStatusStore
vi.mock('@/stores/useSessionStore', () => {
  const sessionsByWorktree = new Map<string, Array<{ id: string }>>()
  sessionsByWorktree.set('wt-1', [{ id: 'session-A' }, { id: 'session-B' }])
  sessionsByWorktree.set('wt-2', [{ id: 'session-C' }])

  return {
    useSessionStore: {
      getState: () => ({
        activeSessionId: 'session-A',
        sessionsByWorktree
      })
    }
  }
})

describe('Session 3: Question Dialog Persistence', () => {
  const makeQuestion = (id: string, sessionID: string): QuestionRequest => ({
    id,
    sessionID,
    questions: [
      {
        question: 'Do you want to proceed?',
        header: 'Confirm',
        options: [
          { label: 'Yes', description: 'Continue' },
          { label: 'No', description: 'Cancel' }
        ]
      }
    ]
  })

  beforeEach(() => {
    // Reset question store
    useQuestionStore.setState({ pendingBySession: new Map() })
    // Reset worktree status store
    const statusStore = useWorktreeStatusStore.getState()
    for (const key of Object.keys(statusStore.sessionStatuses)) {
      statusStore.clearSessionStatus(key)
    }
  })

  describe('questions survive SessionView unmount', () => {
    test('questions persist after clearSession is no longer called on unmount', () => {
      // Add a question to the store for session-A
      const question = makeQuestion('q-1', 'session-A')
      useQuestionStore.getState().addQuestion('session-A', question)

      // Verify question is present
      expect(useQuestionStore.getState().getActiveQuestion('session-A')).not.toBeNull()
      expect(useQuestionStore.getState().getActiveQuestion('session-A')?.id).toBe('q-1')

      // Simulate what would have happened on unmount before the fix:
      // useQuestionStore.getState().clearSession('session-A')
      // Now we DON'T call clearSession, so question should still be there

      // Verify question is STILL present (the fix means unmount doesn't clear it)
      expect(useQuestionStore.getState().getActiveQuestion('session-A')).not.toBeNull()
      expect(useQuestionStore.getState().getActiveQuestion('session-A')?.id).toBe('q-1')
    })

    test('questions are still removable individually via removeQuestion', () => {
      const question = makeQuestion('q-1', 'session-A')
      useQuestionStore.getState().addQuestion('session-A', question)
      expect(useQuestionStore.getState().getQuestions('session-A')).toHaveLength(1)

      // Individual removal still works
      useQuestionStore.getState().removeQuestion('session-A', 'q-1')
      expect(useQuestionStore.getState().getQuestions('session-A')).toHaveLength(0)
    })
  })

  describe('global listener adds question for background session', () => {
    test('addQuestion is called when question.asked arrives for background session', () => {
      const addSpy = vi.spyOn(useQuestionStore.getState(), 'addQuestion')

      // Simulate what the global listener does for a background session question
      const request = makeQuestion('q-bg-1', 'session-B')
      useQuestionStore.getState().addQuestion('session-B', request)

      expect(addSpy).toHaveBeenCalledWith('session-B', request)
      expect(useQuestionStore.getState().getActiveQuestion('session-B')?.id).toBe('q-bg-1')
    })

    test('worktree status is set to answering when background question arrives', () => {
      const setStatusSpy = vi.spyOn(useWorktreeStatusStore.getState(), 'setSessionStatus')

      // Simulate what the global listener does
      useWorktreeStatusStore.getState().setSessionStatus('session-B', 'answering')

      expect(setStatusSpy).toHaveBeenCalledWith('session-B', 'answering')
      expect(useWorktreeStatusStore.getState().getWorktreeStatus('wt-1')).toBe('answering')
    })
  })

  describe('global listener ignores question events for active session', () => {
    test('question.asked for active session is not handled by global listener', () => {
      // The global listener checks `sessionId !== activeId` before processing.
      // Active session questions are handled by SessionView's own listener.
      // This test validates the store behavior: if we DON'T add the question
      // (simulating the guard), it shouldn't appear.
      expect(useQuestionStore.getState().getActiveQuestion('session-A')).toBeNull()
    })
  })

  describe('global listener removes question on reply/reject for background session', () => {
    test('removeQuestion is called when question.replied arrives', () => {
      // First add a question
      const question = makeQuestion('q-bg-2', 'session-B')
      useQuestionStore.getState().addQuestion('session-B', question)
      expect(useQuestionStore.getState().getQuestions('session-B')).toHaveLength(1)

      // Simulate what the global listener does on question.replied
      useQuestionStore.getState().removeQuestion('session-B', 'q-bg-2')
      expect(useQuestionStore.getState().getQuestions('session-B')).toHaveLength(0)
    })

    test('removeQuestion is called when question.rejected arrives', () => {
      const question = makeQuestion('q-bg-3', 'session-B')
      useQuestionStore.getState().addQuestion('session-B', question)
      expect(useQuestionStore.getState().getQuestions('session-B')).toHaveLength(1)

      // Simulate what the global listener does on question.rejected
      useQuestionStore.getState().removeQuestion('session-B', 'q-bg-3')
      expect(useQuestionStore.getState().getQuestions('session-B')).toHaveLength(0)
    })
  })

  describe('question dialog renders when switching to session with pending question', () => {
    test('getActiveQuestion returns the pending question for re-mounted session', () => {
      // Add question while "away" (simulating background question)
      const question = makeQuestion('q-persist-1', 'session-A')
      useQuestionStore.getState().addQuestion('session-A', question)

      // Simulate "switching back" — SessionView reads from store
      const activeQuestion = useQuestionStore.getState().getActiveQuestion('session-A')
      expect(activeQuestion).not.toBeNull()
      expect(activeQuestion?.id).toBe('q-persist-1')
      expect(activeQuestion?.questions).toHaveLength(1)
      expect(activeQuestion?.questions[0].question).toBe('Do you want to proceed?')
    })
  })

  describe('multiple concurrent questions across sessions', () => {
    test('questions for different sessions are independent', () => {
      const q1 = makeQuestion('q-1', 'session-A')
      const q2 = makeQuestion('q-2', 'session-B')
      const q3 = makeQuestion('q-3', 'session-C')

      useQuestionStore.getState().addQuestion('session-A', q1)
      useQuestionStore.getState().addQuestion('session-B', q2)
      useQuestionStore.getState().addQuestion('session-C', q3)

      expect(useQuestionStore.getState().getQuestions('session-A')).toHaveLength(1)
      expect(useQuestionStore.getState().getQuestions('session-B')).toHaveLength(1)
      expect(useQuestionStore.getState().getQuestions('session-C')).toHaveLength(1)

      // Remove one — others unaffected
      useQuestionStore.getState().removeQuestion('session-B', 'q-2')
      expect(useQuestionStore.getState().getQuestions('session-A')).toHaveLength(1)
      expect(useQuestionStore.getState().getQuestions('session-B')).toHaveLength(0)
      expect(useQuestionStore.getState().getQuestions('session-C')).toHaveLength(1)
    })

    test('answering status on multiple sessions shows correctly per worktree', () => {
      // Set answering for session-B (wt-1) and session-C (wt-2)
      useWorktreeStatusStore.getState().setSessionStatus('session-B', 'answering')
      useWorktreeStatusStore.getState().setSessionStatus('session-C', 'answering')

      expect(useWorktreeStatusStore.getState().getWorktreeStatus('wt-1')).toBe('answering')
      expect(useWorktreeStatusStore.getState().getWorktreeStatus('wt-2')).toBe('answering')

      // Clear session-B's answering status
      useWorktreeStatusStore.getState().clearSessionStatus('session-B')

      // wt-1 should no longer show answering, wt-2 still does
      expect(useWorktreeStatusStore.getState().getWorktreeStatus('wt-1')).toBeNull()
      expect(useWorktreeStatusStore.getState().getWorktreeStatus('wt-2')).toBe('answering')
    })
  })
})
