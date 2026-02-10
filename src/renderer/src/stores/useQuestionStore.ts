import { create } from 'zustand'

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: { messageID: string; callID: string }
}

export type QuestionAnswer = string[]

interface QuestionStore {
  pendingBySession: Map<string, QuestionRequest[]>
  addQuestion: (sessionId: string, request: QuestionRequest) => void
  removeQuestion: (sessionId: string, requestId: string) => void
  getQuestions: (sessionId: string) => QuestionRequest[]
  getActiveQuestion: (sessionId: string) => QuestionRequest | null
  clearSession: (sessionId: string) => void
}

export const useQuestionStore = create<QuestionStore>((set, get) => ({
  pendingBySession: new Map(),

  addQuestion: (sessionId, request) =>
    set((state) => {
      const map = new Map(state.pendingBySession)
      const existing = map.get(sessionId) || []
      if (existing.some((q) => q.id === request.id)) return state
      map.set(sessionId, [...existing, request])
      return { pendingBySession: map }
    }),

  removeQuestion: (sessionId, requestId) =>
    set((state) => {
      const map = new Map(state.pendingBySession)
      const existing = map.get(sessionId) || []
      const filtered = existing.filter((q) => q.id !== requestId)
      if (filtered.length === 0) {
        map.delete(sessionId)
      } else {
        map.set(sessionId, filtered)
      }
      return { pendingBySession: map }
    }),

  getQuestions: (sessionId) => get().pendingBySession.get(sessionId) || [],

  getActiveQuestion: (sessionId) => {
    const questions = get().pendingBySession.get(sessionId) || []
    return questions[0] || null
  },

  clearSession: (sessionId) =>
    set((state) => {
      const map = new Map(state.pendingBySession)
      map.delete(sessionId)
      return { pendingBySession: map }
    })
}))
