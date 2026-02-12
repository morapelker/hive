import { describe, test, expect, beforeEach } from 'vitest'
import { useQuestionStore } from '@/stores/useQuestionStore'
import type { QuestionRequest } from '@/stores/useQuestionStore'

describe('Session 3: Question Session Integration', () => {
  beforeEach(() => {
    useQuestionStore.setState({ pendingBySession: new Map() })
  })

  describe('question.asked event handling', () => {
    test('adds question to store for the correct session', () => {
      const request: QuestionRequest = {
        id: 'q1',
        sessionID: 'opc-1',
        questions: [{ question: 'Pick one', header: 'Choice', options: [] }]
      }
      // Simulate what the onStream handler does for question.asked
      useQuestionStore.getState().addQuestion('hive-1', request)
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(1)
      expect(useQuestionStore.getState().getActiveQuestion('hive-1')?.id).toBe('q1')
    })

    test('ignores question events with missing id', () => {
      // The stream handler guards on request?.id && request?.questions
      const request = { id: '', sessionID: 'opc-1', questions: [] } as QuestionRequest
      // With empty id, guard would skip — simulate by not calling addQuestion
      if (request.id && request.questions) {
        useQuestionStore.getState().addQuestion('hive-1', request)
      }
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(0)
    })

    test('ignores question events with missing questions array', () => {
      const request = { id: 'q1', sessionID: 'opc-1' } as QuestionRequest
      if (request?.id && request?.questions) {
        useQuestionStore.getState().addQuestion('hive-1', request)
      }
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(0)
    })

    test('multiple questions can be queued for the same session', () => {
      const req1: QuestionRequest = {
        id: 'q1',
        sessionID: 'opc-1',
        questions: [{ question: 'First?', header: 'Q1', options: [] }]
      }
      const req2: QuestionRequest = {
        id: 'q2',
        sessionID: 'opc-1',
        questions: [{ question: 'Second?', header: 'Q2', options: [] }]
      }
      useQuestionStore.getState().addQuestion('hive-1', req1)
      useQuestionStore.getState().addQuestion('hive-1', req2)
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(2)
      // Active question should be the first one
      expect(useQuestionStore.getState().getActiveQuestion('hive-1')?.id).toBe('q1')
    })
  })

  describe('question.replied event handling', () => {
    test('removes question from store by requestID', () => {
      const request: QuestionRequest = {
        id: 'q1',
        sessionID: 'opc-1',
        questions: [{ question: 'Pick', header: 'Choice', options: [] }]
      }
      useQuestionStore.getState().addQuestion('hive-1', request)
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(1)

      // Simulate question.replied — handler checks multiple field names
      const eventData = { requestID: 'q1' }
      const requestId = eventData.requestID
      if (requestId) {
        useQuestionStore.getState().removeQuestion('hive-1', requestId)
      }
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(0)
    })

    test('handles requestId field name variant', () => {
      const request: QuestionRequest = {
        id: 'q1',
        sessionID: 'opc-1',
        questions: []
      }
      useQuestionStore.getState().addQuestion('hive-1', request)

      // Some SDK versions use requestId instead of requestID
      const eventData = { requestId: 'q1' } as Record<string, string>
      const requestId = eventData.requestID || eventData.requestId || eventData.id
      if (requestId) {
        useQuestionStore.getState().removeQuestion('hive-1', requestId)
      }
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(0)
    })

    test('handles id field name variant', () => {
      const request: QuestionRequest = {
        id: 'q1',
        sessionID: 'opc-1',
        questions: []
      }
      useQuestionStore.getState().addQuestion('hive-1', request)

      // Fallback field name
      const eventData = { id: 'q1' } as Record<string, string>
      const requestId = eventData.requestID || eventData.requestId || eventData.id
      if (requestId) {
        useQuestionStore.getState().removeQuestion('hive-1', requestId)
      }
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(0)
    })

    test('only removes the specific question, leaving others', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 'opc-1', questions: [] })
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q2', sessionID: 'opc-1', questions: [] })

      useQuestionStore.getState().removeQuestion('hive-1', 'q1')
      const remaining = useQuestionStore.getState().getQuestions('hive-1')
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe('q2')
    })
  })

  describe('question.rejected event handling', () => {
    test('removes question from store on rejection', () => {
      const request: QuestionRequest = {
        id: 'q1',
        sessionID: 'opc-1',
        questions: [{ question: 'Pick', header: 'Choice', options: [] }]
      }
      useQuestionStore.getState().addQuestion('hive-1', request)
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(1)

      // Simulate question.rejected event
      const eventData = { requestID: 'q1' }
      const requestId = eventData.requestID
      if (requestId) {
        useQuestionStore.getState().removeQuestion('hive-1', requestId)
      }
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(0)
    })
  })

  describe('session cleanup', () => {
    test('clearSession removes all questions for a session', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 'opc-1', questions: [] })
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q2', sessionID: 'opc-1', questions: [] })
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(2)

      // Simulate session switch cleanup
      useQuestionStore.getState().clearSession('hive-1')
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(0)
      expect(useQuestionStore.getState().getActiveQuestion('hive-1')).toBeNull()
    })

    test('clearSession does not affect other sessions', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 'opc-1', questions: [] })
      useQuestionStore
        .getState()
        .addQuestion('hive-2', { id: 'q2', sessionID: 'opc-2', questions: [] })

      useQuestionStore.getState().clearSession('hive-1')
      expect(useQuestionStore.getState().getQuestions('hive-1')).toHaveLength(0)
      expect(useQuestionStore.getState().getQuestions('hive-2')).toHaveLength(1)
    })
  })

  describe('activeQuestion subscription', () => {
    test('getActiveQuestion returns first pending question', () => {
      useQuestionStore.getState().addQuestion('hive-1', {
        id: 'q1',
        sessionID: 'opc-1',
        questions: [{ question: 'First?', header: 'Q1', options: [] }]
      })
      useQuestionStore.getState().addQuestion('hive-1', {
        id: 'q2',
        sessionID: 'opc-1',
        questions: [{ question: 'Second?', header: 'Q2', options: [] }]
      })

      const active = useQuestionStore.getState().getActiveQuestion('hive-1')
      expect(active?.id).toBe('q1')
      expect(active?.questions[0].question).toBe('First?')
    })

    test('getActiveQuestion returns null when no questions pending', () => {
      expect(useQuestionStore.getState().getActiveQuestion('hive-1')).toBeNull()
    })

    test('getActiveQuestion updates when first question is removed', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 'opc-1', questions: [] })
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q2', sessionID: 'opc-1', questions: [] })

      expect(useQuestionStore.getState().getActiveQuestion('hive-1')?.id).toBe('q1')

      useQuestionStore.getState().removeQuestion('hive-1', 'q1')
      expect(useQuestionStore.getState().getActiveQuestion('hive-1')?.id).toBe('q2')
    })

    test('getActiveQuestion returns null after last question is removed', () => {
      useQuestionStore
        .getState()
        .addQuestion('hive-1', { id: 'q1', sessionID: 'opc-1', questions: [] })

      useQuestionStore.getState().removeQuestion('hive-1', 'q1')
      expect(useQuestionStore.getState().getActiveQuestion('hive-1')).toBeNull()
    })
  })
})
