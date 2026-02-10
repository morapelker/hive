import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// Session mode type
export type SessionMode = 'build' | 'plan'

// Session type matching the database schema
interface Session {
  id: string
  worktree_id: string | null
  project_id: string
  name: string | null
  status: 'active' | 'completed' | 'error'
  opencode_session_id: string | null
  mode: SessionMode
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface SessionState {
  // Data - keyed by worktree ID
  sessionsByWorktree: Map<string, Session[]>
  // Tab order - keyed by worktree ID, array of session IDs
  tabOrderByWorktree: Map<string, string[]>
  // Mode per session - keyed by session ID
  modeBySession: Map<string, SessionMode>
  // Pending initial messages - keyed by session ID (e.g., code review prompts)
  pendingMessages: Map<string, string>
  isLoading: boolean
  error: string | null

  // UI State
  activeSessionId: string | null
  activeWorktreeId: string | null
  // Persisted: last active session per worktree
  activeSessionByWorktree: Record<string, string>

  // Actions
  loadSessions: (worktreeId: string, projectId: string) => Promise<void>
  createSession: (
    worktreeId: string,
    projectId: string
  ) => Promise<{ success: boolean; session?: Session; error?: string }>
  closeSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>
  reopenSession: (
    sessionId: string,
    worktreeId: string
  ) => Promise<{ success: boolean; error?: string }>
  setActiveSession: (sessionId: string | null) => void
  setActiveWorktree: (worktreeId: string | null) => void
  updateSessionName: (sessionId: string, name: string) => Promise<boolean>
  reorderTabs: (worktreeId: string, fromIndex: number, toIndex: number) => void
  getSessionsForWorktree: (worktreeId: string) => Session[]
  getTabOrderForWorktree: (worktreeId: string) => string[]
  getSessionMode: (sessionId: string) => SessionMode
  toggleSessionMode: (sessionId: string) => Promise<void>
  setSessionMode: (sessionId: string, mode: SessionMode) => Promise<void>
  setPendingMessage: (sessionId: string, message: string) => void
  consumePendingMessage: (sessionId: string) => string | null
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      // Initial state
      sessionsByWorktree: new Map(),
      tabOrderByWorktree: new Map(),
      modeBySession: new Map(),
      pendingMessages: new Map(),
      isLoading: false,
      error: null,
      activeSessionId: null,
      activeWorktreeId: null,
      activeSessionByWorktree: {},

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
              newTabOrderMap.set(
                worktreeId,
                sortedSessions.map((s) => s.id)
              )
            } else {
              // Sync tab order with actual sessions (remove deleted, add new)
              const existingOrder = newTabOrderMap.get(worktreeId)!
              const sessionIds = new Set(sortedSessions.map((s) => s.id))
              const validOrder = existingOrder.filter((id) => sessionIds.has(id))
              const newIds = sortedSessions
                .map((s) => s.id)
                .filter((id) => !validOrder.includes(id))
              newTabOrderMap.set(worktreeId, [...validOrder, ...newIds])
            }

            // Populate mode map from loaded sessions
            const newModeMap = new Map(state.modeBySession)
            for (const session of sortedSessions) {
              if (!newModeMap.has(session.id)) {
                newModeMap.set(session.id, session.mode || 'build')
              }
            }

            // Set active session if none selected and sessions exist
            let activeSessionId = state.activeSessionId
            if (
              state.activeWorktreeId === worktreeId &&
              !activeSessionId &&
              sortedSessions.length > 0
            ) {
              // Try to restore persisted active session
              const persistedSessionId = state.activeSessionByWorktree[worktreeId]
              const sessionExists =
                persistedSessionId && sortedSessions.some((s) => s.id === persistedSessionId)

              if (sessionExists) {
                activeSessionId = persistedSessionId
              } else {
                const tabOrder = newTabOrderMap.get(worktreeId)!
                activeSessionId = tabOrder[0] || sortedSessions[0].id
              }
            }

            return {
              sessionsByWorktree: newSessionsMap,
              tabOrderByWorktree: newTabOrderMap,
              modeBySession: newModeMap,
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
            name: `New session - ${new Date().toISOString()}`
          })

          set((state) => {
            const newSessionsMap = new Map(state.sessionsByWorktree)
            const existingSessions = newSessionsMap.get(worktreeId) || []
            newSessionsMap.set(worktreeId, [session, ...existingSessions])

            // Add to tab order at the end
            const newTabOrderMap = new Map(state.tabOrderByWorktree)
            const existingOrder = newTabOrderMap.get(worktreeId) || []
            newTabOrderMap.set(worktreeId, [...existingOrder, session.id])

            // Initialize mode for new session
            const newModeMap = new Map(state.modeBySession)
            newModeMap.set(session.id, session.mode || 'build')

            return {
              sessionsByWorktree: newSessionsMap,
              tabOrderByWorktree: newTabOrderMap,
              modeBySession: newModeMap,
              activeSessionId: session.id,
              activeSessionByWorktree: {
                ...state.activeSessionByWorktree,
                [worktreeId]: session.id
              }
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
              const filtered = sessions.filter((s) => s.id !== sessionId)
              if (filtered.length !== sessions.length) {
                newSessionsMap.set(worktreeId, filtered)

                // Update tab order
                const tabOrder = newTabOrderMap.get(worktreeId) || []
                const sessionIndex = tabOrder.indexOf(sessionId)
                const newOrder = tabOrder.filter((id) => id !== sessionId)
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

            // Update persisted active session mapping
            const newActiveByWorktree = { ...state.activeSessionByWorktree }
            for (const [worktreeId] of newSessionsMap.entries()) {
              if (newActiveByWorktree[worktreeId] === sessionId) {
                if (newActiveSessionId) {
                  newActiveByWorktree[worktreeId] = newActiveSessionId
                } else {
                  delete newActiveByWorktree[worktreeId]
                }
              }
            }

            return {
              sessionsByWorktree: newSessionsMap,
              tabOrderByWorktree: newTabOrderMap,
              activeSessionId: newActiveSessionId,
              activeSessionByWorktree: newActiveByWorktree
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
        const worktreeId = get().activeWorktreeId
        if (sessionId && worktreeId) {
          set((state) => ({
            activeSessionId: sessionId,
            activeSessionByWorktree: {
              ...state.activeSessionByWorktree,
              [worktreeId]: sessionId
            }
          }))
        } else {
          set({ activeSessionId: sessionId })
        }
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
            // Try to restore persisted active session for this worktree
            const persistedSessionId = state.activeSessionByWorktree[worktreeId]
            const sessionExists =
              persistedSessionId && existingSessions.some((s) => s.id === persistedSessionId)

            if (sessionExists) {
              set({ activeSessionId: persistedSessionId })
            } else {
              // Fallback to first tab
              const tabOrder = state.tabOrderByWorktree.get(worktreeId) || []
              const activeId =
                tabOrder[0] || (existingSessions.length > 0 ? existingSessions[0].id : null)
              set({ activeSessionId: activeId })
            }
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
                const updated = sessions.map((s) => (s.id === sessionId ? { ...s, name } : s))
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

          if (
            fromIndex < 0 ||
            fromIndex >= order.length ||
            toIndex < 0 ||
            toIndex >= order.length
          ) {
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
      },

      // Get session mode (defaults to 'build')
      getSessionMode: (sessionId: string): SessionMode => {
        return get().modeBySession.get(sessionId) || 'build'
      },

      // Toggle session mode between build and plan
      toggleSessionMode: async (sessionId: string) => {
        const currentMode = get().modeBySession.get(sessionId) || 'build'
        const newMode: SessionMode = currentMode === 'build' ? 'plan' : 'build'

        // Update local state immediately
        set((state) => {
          const newModeMap = new Map(state.modeBySession)
          newModeMap.set(sessionId, newMode)
          return { modeBySession: newModeMap }
        })

        // Persist to database
        try {
          await window.db.session.update(sessionId, { mode: newMode })
        } catch (error) {
          console.error('Failed to persist session mode:', error)
        }
      },

      // Set session mode explicitly
      setSessionMode: async (sessionId: string, mode: SessionMode) => {
        set((state) => {
          const newModeMap = new Map(state.modeBySession)
          newModeMap.set(sessionId, mode)
          return { modeBySession: newModeMap }
        })

        try {
          await window.db.session.update(sessionId, { mode })
        } catch (error) {
          console.error('Failed to persist session mode:', error)
        }
      },

      // Set a pending initial message for a session (e.g., code review prompt)
      setPendingMessage: (sessionId: string, message: string) => {
        set((state) => {
          const newMap = new Map(state.pendingMessages)
          newMap.set(sessionId, message)
          return { pendingMessages: newMap }
        })
      },

      // Consume (get and remove) a pending message for a session
      consumePendingMessage: (sessionId: string): string | null => {
        const message = get().pendingMessages.get(sessionId) || null
        if (message) {
          set((state) => {
            const newMap = new Map(state.pendingMessages)
            newMap.delete(sessionId)
            return { pendingMessages: newMap }
          })
        }
        return message
      }
    }),
    {
      name: 'hive-session-tabs',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        activeSessionByWorktree: state.activeSessionByWorktree
      })
    }
  )
)
