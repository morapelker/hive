import { create } from 'zustand'
import { useSessionStore } from './useSessionStore'

interface SessionStatus {
  status: 'working' | 'unread'
  timestamp: number
}

interface WorktreeStatusState {
  // sessionId → status info (null means no status / cleared)
  sessionStatuses: Record<string, SessionStatus | null>

  // Actions
  setSessionStatus: (sessionId: string, status: 'working' | 'unread' | null) => void
  clearSessionStatus: (sessionId: string) => void
  clearWorktreeUnread: (worktreeId: string) => void
  getWorktreeStatus: (worktreeId: string) => 'working' | 'unread' | null
}

export const useWorktreeStatusStore = create<WorktreeStatusState>((set, get) => ({
  sessionStatuses: {},

  setSessionStatus: (sessionId: string, status: 'working' | 'unread' | null) => {
    set((state) => ({
      sessionStatuses: {
        ...state.sessionStatuses,
        [sessionId]: status ? { status, timestamp: Date.now() } : null
      }
    }))
  },

  clearSessionStatus: (sessionId: string) => {
    set((state) => ({
      sessionStatuses: {
        ...state.sessionStatuses,
        [sessionId]: null
      }
    }))
  },

  clearWorktreeUnread: (worktreeId: string) => {
    const { sessionStatuses } = get()
    const sessionStore = useSessionStore.getState()
    const sessions = sessionStore.sessionsByWorktree.get(worktreeId) || []

    const updates: Record<string, null> = {}
    for (const s of sessions) {
      if (sessionStatuses[s.id]?.status === 'unread') {
        updates[s.id] = null
      }
    }

    if (Object.keys(updates).length > 0) {
      set((state) => ({
        sessionStatuses: { ...state.sessionStatuses, ...updates }
      }))
    }
  },

  getWorktreeStatus: (worktreeId: string): 'working' | 'unread' | null => {
    const { sessionStatuses } = get()
    // Get all sessions for this worktree from the session store
    const sessionStore = useSessionStore.getState()
    const sessions = sessionStore.sessionsByWorktree.get(worktreeId) || []
    const sessionIds = sessions.map((s) => s.id)

    let latestUnread: SessionStatus | null = null

    for (const id of sessionIds) {
      const entry = sessionStatuses[id]
      if (!entry) continue

      // If any session is working, return 'working' immediately
      if (entry.status === 'working') return 'working'

      // Track the latest unread
      if (entry.status === 'unread') {
        if (!latestUnread || entry.timestamp > latestUnread.timestamp) {
          latestUnread = entry
        }
      }
    }

    return latestUnread ? 'unread' : null
  }
}))
