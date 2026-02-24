import { create } from 'zustand'

export interface CommandApprovalRequest {
  id: string
  sessionID: string
  toolName: string
  commandStr: string
  input: Record<string, unknown>
  patternSuggestions: string[]
  tool?: {
    messageID: string
    callID: string
  }
}

interface CommandApprovalStore {
  pendingBySession: Map<string, CommandApprovalRequest[]>
  addApproval: (sessionId: string, request: CommandApprovalRequest) => void
  removeApproval: (sessionId: string, requestId: string) => void
  getApprovals: (sessionId: string) => CommandApprovalRequest[]
  getActiveApproval: (sessionId: string) => CommandApprovalRequest | null
  clearSession: (sessionId: string) => void
}

export const useCommandApprovalStore = create<CommandApprovalStore>((set, get) => ({
  pendingBySession: new Map(),

  addApproval: (sessionId, request) =>
    set((state) => {
      const map = new Map(state.pendingBySession)
      const existing = map.get(sessionId) || []
      if (existing.some((a) => a.id === request.id)) return state
      map.set(sessionId, [...existing, request])
      return { pendingBySession: map }
    }),

  removeApproval: (sessionId, requestId) =>
    set((state) => {
      const map = new Map(state.pendingBySession)
      const existing = map.get(sessionId) || []
      const filtered = existing.filter((a) => a.id !== requestId)
      if (filtered.length === 0) {
        map.delete(sessionId)
      } else {
        map.set(sessionId, filtered)
      }
      return { pendingBySession: map }
    }),

  getApprovals: (sessionId) => get().pendingBySession.get(sessionId) || [],

  getActiveApproval: (sessionId) => {
    const approvals = get().pendingBySession.get(sessionId) || []
    return approvals[0] || null
  },

  clearSession: (sessionId) =>
    set((state) => {
      const map = new Map(state.pendingBySession)
      map.delete(sessionId)
      return { pendingBySession: map }
    })
}))
