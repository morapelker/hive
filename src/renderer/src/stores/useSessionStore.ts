import { create } from 'zustand'

// Session type matching the database schema
interface Session {
  id: string
  worktree_id: string | null
  project_id: string
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface SessionState {
  // Data - keyed by worktree ID
  sessionsByWorktree: Map<string, Session[]>
  // Tab order - keyed by worktree ID, array of session IDs
  tabOrderByWorktree: Map<string, string[]>
  isLoading: boolean
  error: string | null

  // UI State
  activeSessionId: string | null
  activeWorktreeId: string | null

  // Actions
  loadSessions: (worktreeId: string, projectId: string) => Promise<void>
  createSession: (worktreeId: string, projectId: string) => Promise<{ success: boolean; session?: Session; error?: string }>
  closeSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>
  reopenSession: (sessionId: string, worktreeId: string) => Promise<{ success: boolean; error?: string }>
  setActiveSession: (sessionId: string | null) => void
  setActiveWorktree: (worktreeId: string | null) => void
  updateSessionName: (sessionId: string, name: string) => Promise<boolean>
  reorderTabs: (worktreeId: string, fromIndex: number, toIndex: number) => void
  getSessionsForWorktree: (worktreeId: string) => Session[]
  getTabOrderForWorktree: (worktreeId: string) => string[]
}

// Helper to generate session name based on timestamp
function generateSessionName(): string {
  const now = new Date()
  const hours = now.getHours().toString().padStart(2, '0')
  const minutes = now.getMinutes().toString().padStart(2, '0')
  return `Session ${hours}:${minutes}`
}

export const useSessionStore = create<SessionState>((set, get) => ({
  // Initial state
  sessionsByWorktree: new Map(),
  tabOrderByWorktree: new Map(),
  isLoading: false,
  error: null,
  activeSessionId: null,
  activeWorktreeId: null,

  // Load sessions for a worktree from database (only active sessions for tabs)
  loadSessions: async (worktreeId: string, _projectId: string) => {
    set({ isLoading: true, error: null })
    try {
      // Only load active sessions - completed sessions appear in history only
      const sessions = await window.db.session.getActiveByWorktree(worktreeId)
      // Sort by updated_at descending (most recent first)
      const sortedSessions = sessions.sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      )

      set((state) => {
        const newSessionsMap = new Map(state.sessionsByWorktree)
        newSessionsMap.set(worktreeId, sortedSessions)

        // Initialize tab order if not exists - use session IDs in sorted order
        const newTabOrderMap = new Map(state.tabOrderByWorktree)
        if (!newTabOrderMap.has(worktreeId)) {
          newTabOrderMap.set(worktreeId, sortedSessions.map(s => s.id))
        } else {
          // Sync tab order with actual sessions (remove deleted, add new)
          const existingOrder = newTabOrderMap.get(worktreeId)!
          const sessionIds = new Set(sortedSessions.map(s => s.id))
          const validOrder = existingOrder.filter(id => sessionIds.has(id))
          const newIds = sortedSessions.map(s => s.id).filter(id => !validOrder.includes(id))
          newTabOrderMap.set(worktreeId, [...validOrder, ...newIds])
        }

        // Set active session if none selected and sessions exist
        let activeSessionId = state.activeSessionId
        if (state.activeWorktreeId === worktreeId && !activeSessionId && sortedSessions.length > 0) {
          const tabOrder = newTabOrderMap.get(worktreeId)!
          activeSessionId = tabOrder[0] || sortedSessions[0].id
        }

        return {
          sessionsByWorktree: newSessionsMap,
          tabOrderByWorktree: newTabOrderMap,
          isLoading: false,
          activeSessionId
        }
      })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load sessions',
        isLoading: false
      })
    }
  },

  // Create a new session
  createSession: async (worktreeId: string, projectId: string) => {
    try {
      const session = await window.db.session.create({
        worktree_id: worktreeId,
        project_id: projectId,
        name: generateSessionName()
      })

      set((state) => {
        const newSessionsMap = new Map(state.sessionsByWorktree)
        const existingSessions = newSessionsMap.get(worktreeId) || []
        newSessionsMap.set(worktreeId, [session, ...existingSessions])

        // Add to tab order at the end
        const newTabOrderMap = new Map(state.tabOrderByWorktree)
        const existingOrder = newTabOrderMap.get(worktreeId) || []
        newTabOrderMap.set(worktreeId, [...existingOrder, session.id])

        return {
          sessionsByWorktree: newSessionsMap,
          tabOrderByWorktree: newTabOrderMap,
          activeSessionId: session.id
        }
      })

      return { success: true, session }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create session'
      }
    }
  },

  // Close a session tab (removes from tab view, keeps in database for history)
  closeSession: async (sessionId: string) => {
    try {
      // Mark session as completed instead of deleting
      // This preserves it in session history
      await window.db.session.update(sessionId, {
        status: 'completed',
        completed_at: new Date().toISOString()
      })

      set((state) => {
        const newSessionsMap = new Map(state.sessionsByWorktree)
        const newTabOrderMap = new Map(state.tabOrderByWorktree)
        let newActiveSessionId = state.activeSessionId

        for (const [worktreeId, sessions] of newSessionsMap.entries()) {
          const filtered = sessions.filter(s => s.id !== sessionId)
          if (filtered.length !== sessions.length) {
            newSessionsMap.set(worktreeId, filtered)

            // Update tab order
            const tabOrder = newTabOrderMap.get(worktreeId) || []
            const sessionIndex = tabOrder.indexOf(sessionId)
            const newOrder = tabOrder.filter(id => id !== sessionId)
            newTabOrderMap.set(worktreeId, newOrder)

            // If closing the active session, select another one
            if (state.activeSessionId === sessionId) {
              if (newOrder.length > 0) {
                // Select the session at the same index, or the last one
                const newIndex = Math.min(sessionIndex, newOrder.length - 1)
                newActiveSessionId = newOrder[newIndex]
              } else {
                newActiveSessionId = null
              }
            }
          }
        }

        return {
          sessionsByWorktree: newSessionsMap,
          tabOrderByWorktree: newTabOrderMap,
          activeSessionId: newActiveSessionId
        }
      })

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to close session'
      }
    }
  },

  // Reopen a closed session (from history) - marks as active and adds to tabs
  reopenSession: async (sessionId: string, worktreeId: string) => {
    try {
      // Mark session as active again
      const updatedSession = await window.db.session.update(sessionId, {
        status: 'active',
        completed_at: null
      })

      if (!updatedSession) {
        return { success: false, error: 'Session not found' }
      }

      set((state) => {
        const newSessionsMap = new Map(state.sessionsByWorktree)
        const existingSessions = newSessionsMap.get(worktreeId) || []

        // Only add if not already in the list
        if (!existingSessions.some((s) => s.id === sessionId)) {
          newSessionsMap.set(worktreeId, [updatedSession, ...existingSessions])
        }

        // Add to tab order
        const newTabOrderMap = new Map(state.tabOrderByWorktree)
        const existingOrder = newTabOrderMap.get(worktreeId) || []
        if (!existingOrder.includes(sessionId)) {
          newTabOrderMap.set(worktreeId, [...existingOrder, sessionId])
        }

        return {
          sessionsByWorktree: newSessionsMap,
          tabOrderByWorktree: newTabOrderMap,
          activeSessionId: sessionId,
          activeWorktreeId: worktreeId
        }
      })

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reopen session'
      }
    }
  },

  // Set active session
  setActiveSession: (sessionId: string | null) => {
    set({ activeSessionId: sessionId })
  },

  // Set active worktree and load its sessions
  setActiveWorktree: (worktreeId: string | null) => {
    const state = get()

    if (worktreeId === state.activeWorktreeId) return

    set({ activeWorktreeId: worktreeId })

    if (worktreeId) {
      // Check if we already have sessions for this worktree
      const existingSessions = state.sessionsByWorktree.get(worktreeId)
      if (existingSessions) {
        // Use existing tab order to set active session
        const tabOrder = state.tabOrderByWorktree.get(worktreeId) || []
        const activeId = tabOrder[0] || (existingSessions.length > 0 ? existingSessions[0].id : null)
        set({ activeSessionId: activeId })
      } else {
        // Clear active session until sessions are loaded
        set({ activeSessionId: null })
      }
    } else {
      set({ activeSessionId: null })
    }
  },

  // Update session name
  updateSessionName: async (sessionId: string, name: string) => {
    try {
      const updatedSession = await window.db.session.update(sessionId, { name })
      if (updatedSession) {
        set((state) => {
          const newSessionsMap = new Map(state.sessionsByWorktree)
          for (const [worktreeId, sessions] of newSessionsMap.entries()) {
            const updated = sessions.map(s => s.id === sessionId ? { ...s, name } : s)
            if (updated.some((s, i) => s !== sessions[i])) {
              newSessionsMap.set(worktreeId, updated)
            }
          }
          return { sessionsByWorktree: newSessionsMap }
        })
        return true
      }
      return false
    } catch {
      return false
    }
  },

  // Reorder tabs
  reorderTabs: (worktreeId: string, fromIndex: number, toIndex: number) => {
    set((state) => {
      const newTabOrderMap = new Map(state.tabOrderByWorktree)
      const order = [...(newTabOrderMap.get(worktreeId) || [])]

      if (fromIndex < 0 || fromIndex >= order.length || toIndex < 0 || toIndex >= order.length) {
        return state
      }

      // Remove from old position and insert at new position
      const [removed] = order.splice(fromIndex, 1)
      order.splice(toIndex, 0, removed)

      newTabOrderMap.set(worktreeId, order)
      return { tabOrderByWorktree: newTabOrderMap }
    })
  },

  // Get sessions for a worktree
  getSessionsForWorktree: (worktreeId: string) => {
    return get().sessionsByWorktree.get(worktreeId) || []
  },

  // Get tab order for a worktree
  getTabOrderForWorktree: (worktreeId: string) => {
    return get().tabOrderByWorktree.get(worktreeId) || []
  }
}))
