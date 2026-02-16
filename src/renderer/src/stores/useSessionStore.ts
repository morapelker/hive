import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { SelectedModel } from './useSettingsStore'
import { useGitStore } from './useGitStore'
import { useWorktreeStore } from './useWorktreeStore'

// Session mode type
export type SessionMode = 'build' | 'plan'

// Pending plan approval state (from ExitPlanMode blocking tool)
export interface PendingPlan {
  requestId: string
  planContent: string
  toolUseID: string
}

// Session type matching the database schema
interface Session {
  id: string
  worktree_id: string | null
  project_id: string
  connection_id: string | null
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
  // Pending plan approvals - keyed by session ID (from ExitPlanMode blocking tool)
  pendingPlans: Map<string, PendingPlan>
  isLoading: boolean
  error: string | null

  // UI State
  activeSessionId: string | null
  activeWorktreeId: string | null
  // Persisted: last active session per worktree
  activeSessionByWorktree: Record<string, string>

  // Connection session state
  sessionsByConnection: Map<string, Session[]>
  tabOrderByConnection: Map<string, string[]>
  activeSessionByConnection: Record<string, string> // persisted
  activeConnectionId: string | null

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
  // Plan approval
  setPendingPlan: (sessionId: string, plan: PendingPlan) => void
  clearPendingPlan: (sessionId: string) => void
  getPendingPlan: (sessionId: string) => PendingPlan | null

  // Connection session actions
  loadConnectionSessions: (connectionId: string) => Promise<void>
  createConnectionSession: (
    connectionId: string
  ) => Promise<{ success: boolean; session?: Session; error?: string }>
  setActiveConnectionSession: (sessionId: string | null) => void
  setActiveConnection: (connectionId: string | null) => void
  getSessionsForConnection: (connectionId: string) => Session[]
  getTabOrderForConnection: (connectionId: string) => string[]
  reorderConnectionTabs: (connectionId: string, fromIndex: number, toIndex: number) => void
  closeOtherConnectionSessions: (connectionId: string, keepSessionId: string) => Promise<void>
  closeConnectionSessionsToRight: (connectionId: string, fromSessionId: string) => Promise<void>
}

// Helper: find a session across both worktree and connection maps
function findSessionScope(
  state: SessionState,
  sessionId: string
): { type: 'worktree'; scopeId: string } | { type: 'connection'; scopeId: string } | null {
  for (const [worktreeId, sessions] of state.sessionsByWorktree.entries()) {
    if (sessions.some((s) => s.id === sessionId)) {
      return { type: 'worktree', scopeId: worktreeId }
    }
  }
  for (const [connectionId, sessions] of state.sessionsByConnection.entries()) {
    if (sessions.some((s) => s.id === sessionId)) {
      return { type: 'connection', scopeId: connectionId }
    }
  }
  return null
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      // Initial state
      sessionsByWorktree: new Map(),
      tabOrderByWorktree: new Map(),
      modeBySession: new Map(),
      pendingMessages: new Map(),
      pendingPlans: new Map(),
      isLoading: false,
      error: null,
      activeSessionId: null,
      activeWorktreeId: null,
      activeSessionByWorktree: {},

      // Connection session state
      sessionsByConnection: new Map(),
      tabOrderByConnection: new Map(),
      activeSessionByConnection: {},
      activeConnectionId: null,

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
      // Scope-agnostic: works for both worktree and connection sessions
      closeSession: async (sessionId: string) => {
        try {
          // Mark session as completed instead of deleting
          // This preserves it in session history
          await window.db.session.update(sessionId, {
            status: 'completed',
            completed_at: new Date().toISOString()
          })

          set((state) => {
            const newWorktreeSessionsMap = new Map(state.sessionsByWorktree)
            const newWorktreeTabOrderMap = new Map(state.tabOrderByWorktree)
            const newConnectionSessionsMap = new Map(state.sessionsByConnection)
            const newConnectionTabOrderMap = new Map(state.tabOrderByConnection)
            let newActiveSessionId = state.activeSessionId

            // Check worktree sessions first
            let foundInWorktree = false
            for (const [worktreeId, sessions] of newWorktreeSessionsMap.entries()) {
              const filtered = sessions.filter((s) => s.id !== sessionId)
              if (filtered.length !== sessions.length) {
                foundInWorktree = true
                newWorktreeSessionsMap.set(worktreeId, filtered)

                // Update tab order
                const tabOrder = newWorktreeTabOrderMap.get(worktreeId) || []
                const sessionIndex = tabOrder.indexOf(sessionId)
                const newOrder = tabOrder.filter((id) => id !== sessionId)
                newWorktreeTabOrderMap.set(worktreeId, newOrder)

                // If closing the active session, select another one
                if (state.activeSessionId === sessionId) {
                  if (newOrder.length > 0) {
                    const newIndex = Math.min(sessionIndex, newOrder.length - 1)
                    newActiveSessionId = newOrder[newIndex]
                  } else {
                    newActiveSessionId = null
                  }
                }
                break
              }
            }

            // Check connection sessions if not found in worktree
            if (!foundInWorktree) {
              for (const [connectionId, sessions] of newConnectionSessionsMap.entries()) {
                const filtered = sessions.filter((s) => s.id !== sessionId)
                if (filtered.length !== sessions.length) {
                  newConnectionSessionsMap.set(connectionId, filtered)

                  // Update tab order
                  const tabOrder = newConnectionTabOrderMap.get(connectionId) || []
                  const sessionIndex = tabOrder.indexOf(sessionId)
                  const newOrder = tabOrder.filter((id) => id !== sessionId)
                  newConnectionTabOrderMap.set(connectionId, newOrder)

                  // If closing the active session, select another one
                  if (state.activeSessionId === sessionId) {
                    if (newOrder.length > 0) {
                      const newIndex = Math.min(sessionIndex, newOrder.length - 1)
                      newActiveSessionId = newOrder[newIndex]
                    } else {
                      newActiveSessionId = null
                    }
                  }
                  break
                }
              }
            }

            // Update persisted active session mappings
            const newActiveByWorktree = { ...state.activeSessionByWorktree }
            for (const [worktreeId] of newWorktreeSessionsMap.entries()) {
              if (newActiveByWorktree[worktreeId] === sessionId) {
                if (newActiveSessionId) {
                  newActiveByWorktree[worktreeId] = newActiveSessionId
                } else {
                  delete newActiveByWorktree[worktreeId]
                }
              }
            }

            const newActiveByConnection = { ...state.activeSessionByConnection }
            for (const [connectionId] of newConnectionSessionsMap.entries()) {
              if (newActiveByConnection[connectionId] === sessionId) {
                if (newActiveSessionId) {
                  newActiveByConnection[connectionId] = newActiveSessionId
                } else {
                  delete newActiveByConnection[connectionId]
                }
              }
            }

            return {
              sessionsByWorktree: newWorktreeSessionsMap,
              tabOrderByWorktree: newWorktreeTabOrderMap,
              sessionsByConnection: newConnectionSessionsMap,
              tabOrderByConnection: newConnectionTabOrderMap,
              activeSessionId: newActiveSessionId,
              activeSessionByWorktree: newActiveByWorktree,
              activeSessionByConnection: newActiveByConnection
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
        const state = get()
        const worktreeId = state.activeWorktreeId
        const connectionId = state.activeConnectionId

        if (sessionId && worktreeId) {
          set((state) => ({
            activeSessionId: sessionId,
            activeSessionByWorktree: {
              ...state.activeSessionByWorktree,
              [worktreeId]: sessionId
            }
          }))
        } else if (sessionId && connectionId) {
          set((state) => ({
            activeSessionId: sessionId,
            activeSessionByConnection: {
              ...state.activeSessionByConnection,
              [connectionId]: sessionId
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

        set({ activeWorktreeId: worktreeId, activeConnectionId: null })

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

      // Update session name (scope-agnostic)
      updateSessionName: async (sessionId: string, name: string) => {
        try {
          const updatedSession = await window.db.session.update(sessionId, { name })
          if (updatedSession) {
            const scope = findSessionScope(get(), sessionId)

            set((state) => {
              // Update in worktree sessions
              const newWorktreeSessionsMap = new Map(state.sessionsByWorktree)
              for (const [wtId, sessions] of newWorktreeSessionsMap.entries()) {
                const updated = sessions.map((s) => (s.id === sessionId ? { ...s, name } : s))
                if (updated.some((s, i) => s !== sessions[i])) {
                  newWorktreeSessionsMap.set(wtId, updated)
                }
              }

              // Update in connection sessions
              const newConnectionSessionsMap = new Map(state.sessionsByConnection)
              for (const [connId, sessions] of newConnectionSessionsMap.entries()) {
                const updated = sessions.map((s) => (s.id === sessionId ? { ...s, name } : s))
                if (updated.some((s, i) => s !== sessions[i])) {
                  newConnectionSessionsMap.set(connId, updated)
                }
              }

              return {
                sessionsByWorktree: newWorktreeSessionsMap,
                sessionsByConnection: newConnectionSessionsMap
              }
            })

            // Append non-default session titles to the worktree (updates store + DB)
            const isDefault = /^Session \d+$/.test(name)
            if (!isDefault && scope?.type === 'worktree') {
              useWorktreeStore.getState().appendSessionTitle(scope.scopeId, name)
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

      // Set model for a specific session (per-session model selection, scope-agnostic)
      setSessionModel: async (sessionId: string, model: SelectedModel) => {
        // Update local state immediately (search both maps)
        set((state) => {
          const newWorktreeSessionsMap = new Map(state.sessionsByWorktree)
          for (const [worktreeId, sessions] of newWorktreeSessionsMap.entries()) {
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
              newWorktreeSessionsMap.set(worktreeId, updated)
            }
          }

          const newConnectionSessionsMap = new Map(state.sessionsByConnection)
          for (const [connectionId, sessions] of newConnectionSessionsMap.entries()) {
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
              newConnectionSessionsMap.set(connectionId, updated)
            }
          }

          return {
            sessionsByWorktree: newWorktreeSessionsMap,
            sessionsByConnection: newConnectionSessionsMap
          }
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

        // Also persist as the worktree's last-used model (only for worktree sessions)
        const scope = findSessionScope(get(), sessionId)
        if (scope?.type === 'worktree') {
          try {
            await window.db.worktree.updateModel({
              worktreeId: scope.scopeId,
              modelProviderId: model.providerID,
              modelId: model.modelID,
              modelVariant: model.variant ?? null
            })
            useWorktreeStore.getState().updateWorktreeModel(scope.scopeId, model)
          } catch {
            /* non-critical */
          }
        }
      },

      // Keep opencode_session_id in sync in-memory after connect/reconnect (scope-agnostic)
      setOpenCodeSessionId: (sessionId: string, opencodeSessionId: string | null) => {
        set((state) => {
          let updatedAny = false

          // Check worktree sessions
          const newWorktreeSessionsMap = new Map(state.sessionsByWorktree)
          for (const [worktreeId, sessions] of newWorktreeSessionsMap.entries()) {
            const updatedSessions = sessions.map((s) => {
              if (s.id !== sessionId) return s
              updatedAny = true
              return { ...s, opencode_session_id: opencodeSessionId }
            })
            if (updatedAny) {
              newWorktreeSessionsMap.set(worktreeId, updatedSessions)
              return { sessionsByWorktree: newWorktreeSessionsMap }
            }
          }

          // Check connection sessions
          const newConnectionSessionsMap = new Map(state.sessionsByConnection)
          for (const [connectionId, sessions] of newConnectionSessionsMap.entries()) {
            const updatedSessions = sessions.map((s) => {
              if (s.id !== sessionId) return s
              updatedAny = true
              return { ...s, opencode_session_id: opencodeSessionId }
            })
            if (updatedAny) {
              newConnectionSessionsMap.set(connectionId, updatedSessions)
              return { sessionsByConnection: newConnectionSessionsMap }
            }
          }

          return {}
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
      },

      // Plan approval state management
      setPendingPlan: (sessionId: string, plan: PendingPlan) => {
        set((state) => {
          const newMap = new Map(state.pendingPlans)
          newMap.set(sessionId, plan)
          return { pendingPlans: newMap }
        })
      },

      clearPendingPlan: (sessionId: string) => {
        set((state) => {
          const newMap = new Map(state.pendingPlans)
          newMap.delete(sessionId)
          return { pendingPlans: newMap }
        })
      },

      getPendingPlan: (sessionId: string): PendingPlan | null => {
        return get().pendingPlans.get(sessionId) ?? null
      },

      // ─── Connection session actions ──────────────────────────────────────

      // Load active sessions for a connection
      loadConnectionSessions: async (connectionId: string) => {
        set({ isLoading: true, error: null })
        try {
          const sessions = await window.db.session.getActiveByConnection(connectionId)
          const sortedSessions = sessions.sort(
            (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
          )

          set((state) => {
            const newSessionsMap = new Map(state.sessionsByConnection)
            newSessionsMap.set(connectionId, sortedSessions)

            // Initialize or sync tab order
            const newTabOrderMap = new Map(state.tabOrderByConnection)
            if (!newTabOrderMap.has(connectionId)) {
              newTabOrderMap.set(
                connectionId,
                sortedSessions.map((s) => s.id)
              )
            } else {
              const existingOrder = newTabOrderMap.get(connectionId)!
              const sessionIds = new Set(sortedSessions.map((s) => s.id))
              const validOrder = existingOrder.filter((id) => sessionIds.has(id))
              const newIds = sortedSessions
                .map((s) => s.id)
                .filter((id) => !validOrder.includes(id))
              newTabOrderMap.set(connectionId, [...validOrder, ...newIds])
            }

            // Populate mode map
            const newModeMap = new Map(state.modeBySession)
            for (const session of sortedSessions) {
              if (!newModeMap.has(session.id)) {
                newModeMap.set(session.id, session.mode || 'build')
              }
            }

            // Set active session if in connection context
            let activeSessionId = state.activeSessionId
            if (
              state.activeConnectionId === connectionId &&
              !activeSessionId &&
              sortedSessions.length > 0
            ) {
              const persistedSessionId = state.activeSessionByConnection[connectionId]
              const sessionExists =
                persistedSessionId && sortedSessions.some((s) => s.id === persistedSessionId)

              if (sessionExists) {
                activeSessionId = persistedSessionId
              } else {
                const tabOrder = newTabOrderMap.get(connectionId)!
                activeSessionId = tabOrder[0] || sortedSessions[0].id
              }
            }

            return {
              sessionsByConnection: newSessionsMap,
              tabOrderByConnection: newTabOrderMap,
              modeBySession: newModeMap,
              isLoading: false,
              activeSessionId
            }
          })
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to load connection sessions',
            isLoading: false
          })
        }
      },

      // Create a session scoped to a connection
      createConnectionSession: async (connectionId: string) => {
        try {
          // Look up the connection to get the first member's project_id
          const result = await window.connectionOps.get(connectionId)
          if (!result.success || !result.connection || result.connection.members.length === 0) {
            return { success: false, error: result.error || 'Connection has no members' }
          }

          const projectId = result.connection.members[0].project_id

          // Determine default model from global setting
          let defaultModel: { providerID: string; modelID: string; variant?: string } | null = null
          try {
            const { useSettingsStore } = await import('./useSettingsStore')
            const globalModel = useSettingsStore.getState().selectedModel
            if (globalModel) {
              defaultModel = globalModel
            }
          } catch {
            /* non-critical */
          }

          const existingSessions = get().sessionsByConnection.get(connectionId) || []
          const sessionNumber = existingSessions.length + 1

          const session = await window.db.session.create({
            worktree_id: null,
            project_id: projectId,
            connection_id: connectionId,
            name: `Session ${sessionNumber}`,
            ...(defaultModel
              ? {
                  model_provider_id: defaultModel.providerID,
                  model_id: defaultModel.modelID,
                  model_variant: defaultModel.variant ?? null
                }
              : {})
          })

          set((state) => {
            const newSessionsMap = new Map(state.sessionsByConnection)
            const existing = newSessionsMap.get(connectionId) || []
            newSessionsMap.set(connectionId, [session, ...existing])

            const newTabOrderMap = new Map(state.tabOrderByConnection)
            const existingOrder = newTabOrderMap.get(connectionId) || []
            newTabOrderMap.set(connectionId, [...existingOrder, session.id])

            const newModeMap = new Map(state.modeBySession)
            newModeMap.set(session.id, session.mode || 'build')

            return {
              sessionsByConnection: newSessionsMap,
              tabOrderByConnection: newTabOrderMap,
              modeBySession: newModeMap,
              activeSessionId: session.id,
              activeSessionByConnection: {
                ...state.activeSessionByConnection,
                [connectionId]: session.id
              }
            }
          })

          return { success: true, session }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create connection session'
          }
        }
      },

      // Set active session in connection context
      setActiveConnectionSession: (sessionId: string | null) => {
        const connectionId = get().activeConnectionId
        if (sessionId && connectionId) {
          set((state) => ({
            activeSessionId: sessionId,
            activeSessionByConnection: {
              ...state.activeSessionByConnection,
              [connectionId]: sessionId
            }
          }))
        } else {
          set({ activeSessionId: sessionId })
        }
      },

      // Set active connection and restore its last active session
      setActiveConnection: (connectionId: string | null) => {
        const state = get()

        if (connectionId === state.activeConnectionId) return

        set({ activeConnectionId: connectionId, activeWorktreeId: null })

        if (connectionId) {
          const existingSessions = state.sessionsByConnection.get(connectionId)
          if (existingSessions) {
            const persistedSessionId = state.activeSessionByConnection[connectionId]
            const sessionExists =
              persistedSessionId && existingSessions.some((s) => s.id === persistedSessionId)

            if (sessionExists) {
              set({ activeSessionId: persistedSessionId })
            } else {
              const tabOrder = state.tabOrderByConnection.get(connectionId) || []
              const activeId =
                tabOrder[0] || (existingSessions.length > 0 ? existingSessions[0].id : null)
              set({ activeSessionId: activeId })
            }
          } else {
            set({ activeSessionId: null })
          }
        } else {
          set({ activeSessionId: null })
        }
      },

      // Get sessions for a connection
      getSessionsForConnection: (connectionId: string) => {
        return get().sessionsByConnection.get(connectionId) || []
      },

      // Get tab order for a connection
      getTabOrderForConnection: (connectionId: string) => {
        return get().tabOrderByConnection.get(connectionId) || []
      },

      // Reorder connection tabs
      reorderConnectionTabs: (connectionId: string, fromIndex: number, toIndex: number) => {
        set((state) => {
          const newTabOrderMap = new Map(state.tabOrderByConnection)
          const order = [...(newTabOrderMap.get(connectionId) || [])]

          if (
            fromIndex < 0 ||
            fromIndex >= order.length ||
            toIndex < 0 ||
            toIndex >= order.length
          ) {
            return state
          }

          const [removed] = order.splice(fromIndex, 1)
          order.splice(toIndex, 0, removed)

          newTabOrderMap.set(connectionId, order)
          return { tabOrderByConnection: newTabOrderMap }
        })
      },

      // Close all connection sessions except the kept one
      closeOtherConnectionSessions: async (connectionId: string, keepSessionId: string) => {
        const tabOrder = [...(get().tabOrderByConnection.get(connectionId) || [])]
        for (const sessionId of tabOrder) {
          if (sessionId !== keepSessionId) {
            await get().closeSession(sessionId)
          }
        }
        set({ activeSessionId: keepSessionId })
      },

      // Close connection sessions to the right of the given one
      closeConnectionSessionsToRight: async (connectionId: string, fromSessionId: string) => {
        const tabOrder = [...(get().tabOrderByConnection.get(connectionId) || [])]
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
        activeSessionByWorktree: state.activeSessionByWorktree,
        activeSessionByConnection: state.activeSessionByConnection
      })
    }
  )
)
