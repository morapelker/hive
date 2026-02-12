import { describe, test, expect, beforeEach } from 'vitest'
import { useQuestionStore } from '@/stores/useQuestionStore'
import type { QuestionRequest } from '@/stores/useQuestionStore'

describe('Session 1: Question Store & IPC', () => {
  describe('useQuestionStore', () => {
    beforeEach(() => {
      useQuestionStore.setState({ pendingBySession: new Map() })
    })

    test('addQuestion stores a question for a session', () => {
      const request: QuestionRequest = {
        id: 'q1',
        sessionID: 's1',
        questions: [{ question: 'Pick one', header: 'Choice', options: [] }]
      }
      useQuestionStore.getState().addQuestion('hive-1', request)
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(1)
    })

    test('addQuestion prevents duplicates', () => {
      const request: QuestionRequest = { id: 'q1', sessionID: 's1', questions: [] }
      useQuestionStore.getState().addQuestion('hive-1', request)
      useQuestionStore.getState().addQuestion('hive-1', request)
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(1)
    })

    test('removeQuestion removes by ID', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 's1', questions: [] })
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q2', sessionID: 's1', questions: [] })
      useQuestionStore.getState().removeQuestion('hive-1', 'q1')
      const remaining = useQuestionStore.getState().getQuestions('hive-1')
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe('q2')
    })

    test('getActiveQuestion returns first pending question', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 's1', questions: [] })
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q2', sessionID: 's1', questions: [] })
      expect(useQuestionStore.getState().getActiveQuestion('hive-1')?.id).toBe('q1')
    })

    test('getActiveQuestion returns null when no questions', () => {
      expect(useQuestionStore.getState().getActiveQuestion('hive-1')).toBeNull()
    })

    test('clearSession removes all questions for a session', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 's1', questions: [] })
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q2', sessionID: 's1', questions: [] })
      useQuestionStore.getState().clearSession('hive-1')
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(0)
    })

    test('removeQuestion cleans up session key when last question removed', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 's1', questions: [] })
      useQuestionStore.getState().removeQuestion('hive-1', 'q1')
      expect(useQuestionStore.getState().pendingBySession.has('hive-1')).toBe(false)
    })

    test('questions for different sessions are isolated', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 's1', questions: [] })
      useQuestionStore
        .getState()
        .addQuestion('hive-2', { id: 'q2', sessionID: 's2', questions: [] })
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(1)
      expect(useQuestionStore.getState().getQuestions('hive-2')).toHaveLength(1)
      useQuestionStore.getState().clearSession('hive-1')
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(0)
      expect(useQuestionStore.getState().getQuestions('hive-2')).toHaveLength(1)
    })
  })

  describe('IPC layer (type verification)', () => {
    test('questionReply type accepts correct arguments', () => {
      // Type-level verification: ensure the declarations compile correctly
      // by constructing a conforming mock. If the types are wrong, this won't compile.
      const mockReply: typeof window.opencodeOps.questionReply = async (
        _requestId: string,
        _answers: string[][],
        _worktreePath?: string
      ) => ({ success: true })
      expect(mockReply).toBeDefined()
    })

    test('questionReject type accepts correct arguments', () => {
      const mockReject: typeof window.opencodeOps.questionReject = async (
        _requestId: string,
        _worktreePath?: string
      ) => ({ success: true })
      expect(mockReject).toBeDefined()
    })
  })
})
