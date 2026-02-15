import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { SelectedModel } from './useSettingsStore'
import { useGitStore } from './useGitStore'
import { useWorktreeStore } from './useWorktreeStore'

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
  agent_sdk: 'opencode' | 'claude-code'
  mode: SessionMode
  model_provider_id: string | null
  model_id: string | null
  model_variant: string | null
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
  setSessionModel: (sessionId: string, model: SelectedModel) => Promise<void>
  setOpenCodeSessionId: (sessionId: string, opencodeSessionId: string | null) => void
  setPendingMessage: (sessionId: string, message: string) => void
  consumePendingMessage: (sessionId: string) => string | null
  closeOtherSessions: (worktreeId: string, keepSessionId: string) => Promise<void>
  closeSessionsToRight: (worktreeId: string, fromSessionId: string) => Promise<void>
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
          // Determine default model: worktree's last-used model > global setting
          let defaultModel: { providerID: string; modelID: string; variant?: string } | null = null

          // Priority 1: worktree's last-used model
          const worktree = useWorktreeStore.getState().worktreesByProject
          let worktreeRecord:
            | {
                last_model_provider_id: string | null
                last_model_id: string | null
                last_model_variant: string | null
              }
            | undefined
          for (const worktrees of worktree.values()) {
            worktreeRecord = worktrees.find((w) => w.id === worktreeId)
            if (worktreeRecord) break
          }
          if (worktreeRecord?.last_model_id) {
            defaultModel = {
              providerID: worktreeRecord.last_model_provider_id!,
              modelID: worktreeRecord.last_model_id,
              variant: worktreeRecord.last_model_variant ?? undefined
            }
          }

          // Priority 2: global default
          if (!defaultModel) {
            const { useSettingsStore } = await import('./useSettingsStore')
            const globalModel = useSettingsStore.getState().selectedModel
            if (globalModel) {
              defaultModel = globalModel
            }
          }

          const existingSessions = get().sessionsByWorktree.get(worktreeId) || []
          const sessionNumber = existingSessions.length + 1

          // Resolve default agent SDK from settings
          const { useSettingsStore } = await import('./useSettingsStore')
          const defaultAgentSdk = useSettingsStore.getState().defaultAgentSdk ?? 'opencode'

          const session = await window.db.session.create({
            worktree_id: worktreeId,
            project_id: projectId,
            name: `Session ${sessionNumber}`,
            agent_sdk: defaultAgentSdk,
            ...(defaultModel
              ? {
                  model_provider_id: defaultModel.providerID,
                  model_id: defaultModel.modelID,
                  model_variant: defaultModel.variant ?? null
                }
              : {})
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

          // If this session was a PR-creating session, cancel the PR flow
          const gitStore = useGitStore.getState()
          for (const [worktreeId, prInfo] of gitStore.prInfo.entries()) {
            if (prInfo.sessionId === sessionId && prInfo.state === 'creating') {
              gitStore.setPrState(worktreeId, { state: 'none' })
              break
            }
          }

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
            // Find the worktree_id for this session before updating store
            let worktreeId: string | null = null
            for (const [wtId, sessions] of get().sessionsByWorktree.entries()) {
              if (sessions.some((s) => s.id === sessionId)) {
                worktreeId = wtId
                break
              }
            }

            set((state) => {
              const newSessionsMap = new Map(state.sessionsByWorktree)
              for (const [wtId, sessions] of newSessionsMap.entries()) {
                const updated = sessions.map((s) => (s.id === sessionId ? { ...s, name } : s))
                if (updated.some((s, i) => s !== sessions[i])) {
                  newSessionsMap.set(wtId, updated)
                }
              }
              return { sessionsByWorktree: newSessionsMap }
            })

            // Append non-default session titles to the worktree (updates store + DB)
            const isDefault = /^Session \d+$/.test(name)
            if (!isDefault && worktreeId) {
              useWorktreeStore.getState().appendSessionTitle(worktreeId, name)
            }

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

      // Set model for a specific session (per-session model selection)
      setSessionModel: async (sessionId: string, model: SelectedModel) => {
        // Update local state immediately
        set((state) => {
          const newSessionsMap = new Map(state.sessionsByWorktree)
          for (const [worktreeId, sessions] of newSessionsMap.entries()) {
            const updated = sessions.map((s) =>
              s.id === sessionId
                ? {
                    ...s,
                    model_provider_id: model.providerID,
                    model_id: model.modelID,
                    model_variant: model.variant ?? null
                  }
                : s
            )
            if (updated.some((s, i) => s !== sessions[i])) {
              newSessionsMap.set(worktreeId, updated)
            }
          }
          return { sessionsByWorktree: newSessionsMap }
        })

        // Persist to database
        try {
          await window.db.session.update(sessionId, {
            model_provider_id: model.providerID,
            model_id: model.modelID,
            model_variant: model.variant ?? null
          })
        } catch (error) {
          console.error('Failed to persist session model:', error)
        }

        // Push to agent backend (SDK-aware)
        try {
          // Find the session's SDK to route correctly
          let agentSdk: 'opencode' | 'claude-code' = 'opencode'
          for (const sessions of get().sessionsByWorktree.values()) {
            const found = sessions.find((s) => s.id === sessionId)
            if (found?.agent_sdk) {
              agentSdk = found.agent_sdk
              break
            }
          }
          await window.opencodeOps.setModel({ ...model, agentSdk })
        } catch (error) {
          console.error('Failed to push model to agent backend:', error)
        }

        // Update global last-used model so new worktrees inherit it
        try {
          const { useSettingsStore } = await import('./useSettingsStore')
          useSettingsStore.getState().updateSetting('selectedModel', model)
        } catch {
          /* non-critical */
        }

        // Also persist as the worktree's last-used model
        const session = get().sessionsByWorktree
        let worktreeId: string | null = null
        for (const [wtId, sessions] of session.entries()) {
          if (sessions.some((s) => s.id === sessionId)) {
            worktreeId = wtId
            break
          }
        }
        if (worktreeId) {
          try {
            await window.db.worktree.updateModel({
              worktreeId,
              modelProviderId: model.providerID,
              modelId: model.modelID,
              modelVariant: model.variant ?? null
            })
            useWorktreeStore.getState().updateWorktreeModel(worktreeId, model)
          } catch {
            /* non-critical */
          }
        }
      },

      // Keep opencode_session_id in sync in-memory after connect/reconnect
      setOpenCodeSessionId: (sessionId: string, opencodeSessionId: string | null) => {
        set((state) => {
          const newSessionsMap = new Map(state.sessionsByWorktree)
          let updatedAny = false

          for (const [worktreeId, sessions] of newSessionsMap.entries()) {
            const updatedSessions = sessions.map((s) => {
              if (s.id !== sessionId) return s
              updatedAny = true
              return {
                ...s,
                opencode_session_id: opencodeSessionId
              }
            })

            if (updatedAny) {
              newSessionsMap.set(worktreeId, updatedSessions)
              break
            }
          }

          return updatedAny ? { sessionsByWorktree: newSessionsMap } : {}
        })
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
      },

      // Close all sessions except the kept one
      closeOtherSessions: async (worktreeId: string, keepSessionId: string) => {
        const tabOrder = [...(get().tabOrderByWorktree.get(worktreeId) || [])]
        for (const sessionId of tabOrder) {
          if (sessionId !== keepSessionId) {
            await get().closeSession(sessionId)
          }
        }
        // Ensure the kept session is active
        set({ activeSessionId: keepSessionId })
      },

      // Close all sessions to the right of the given one in tab order
      closeSessionsToRight: async (worktreeId: string, fromSessionId: string) => {
        const tabOrder = [...(get().tabOrderByWorktree.get(worktreeId) || [])]
        const index = tabOrder.indexOf(fromSessionId)
        if (index === -1) return
        const toClose = tabOrder.slice(index + 1)
        for (const sessionId of toClose) {
          await get().closeSession(sessionId)
        }
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
