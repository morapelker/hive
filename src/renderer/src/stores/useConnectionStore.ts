import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { toast } from '@/lib/toast'
import {
  registerConnectionClear,
  registerConnectionSavedProjectResolver,
  clearWorktreeSelection,
  clearDataProjectSelection
} from './store-coordination'
import { useKanbanStore } from './useKanbanStore'
import { connectionApi } from '@/api/connection-api'

export type ConnectionGitView = 'connection' | 'base'

// Connection types matching the database schema
export interface ConnectionMemberEnriched {
  id: string
  connection_id: string
  worktree_id: string
  project_id: string
  symlink_name: string
  added_at: string
  worktree_name: string
  worktree_branch: string
  worktree_path: string
  project_name: string
}

export interface Connection {
  id: string
  name: string
  custom_name: string | null
  status: 'active' | 'archived'
  path: string
  color: string | null
  /** Saved-connection project this connection is an instance of (null/absent = ad-hoc). */
  saved_project_id?: string | null
  /** 1 = base instance of a connection project (members = each member project's default worktree). */
  is_base?: number
  created_at: string
  updated_at: string
  members: ConnectionMemberEnriched[]
}

interface ConnectionState {
  // Data
  connections: Connection[]
  isLoading: boolean
  error: string | null
  loaded: boolean

  // UI State
  selectedConnectionId: string | null
  /**
   * What the git side (Changes / branch diff / push-pull) shows for the
   * selected connection: 'connection' = the member worktrees the connection is
   * made of; 'base' = each member project's default worktree (its base branch)
   * instead, even though no connection actually combines them. Set by
   * cmd+shift+click on a connection ticket; any plain selectConnection() (e.g.
   * re-tapping the connection in the sidebar) returns to 'connection'.
   * Not persisted.
   */
  connectionGitView: ConnectionGitView

  // Connection Mode (inline sidebar selection)
  connectionModeActive: boolean
  connectionModeSourceWorktreeId: string | null
  connectionModeSelectedIds: Set<string>
  connectionModeSubmitting: boolean

  // Actions
  loadConnections: () => Promise<void>
  createConnection: (
    worktreeIds: string[],
    opts?: { savedProjectId?: string }
  ) => Promise<string | null>
  deleteConnection: (connectionId: string) => Promise<void>
  addMember: (connectionId: string, worktreeId: string) => Promise<void>
  removeMember: (connectionId: string, worktreeId: string) => Promise<void>
  updateConnectionMembers: (connectionId: string, desiredWorktreeIds: string[]) => Promise<boolean>
  quickCreateConnection: (
    projects: { id: string; path: string; name: string }[],
    opts?: { savedProjectId?: string }
  ) => Promise<string | null>
  duplicateConnection: (connectionId: string) => Promise<string | null>
  saveConnectionAsProject: (connectionId: string) => Promise<string | null>
  /**
   * Replace a connection project's member projects. Future instances (ticket launches, "+",
   * the base) use the new set; already-created instances keep their members.
   */
  updateConnectionProjectMembers: (
    projectId: string,
    memberProjectIds: string[]
  ) => Promise<boolean>
  selectConnection: (id: string | null, opts?: { gitView?: ConnectionGitView }) => void

  // Rename
  renameConnection: (connectionId: string, customName: string | null) => Promise<void>

  // Connection Mode Actions
  enterConnectionMode: (sourceWorktreeId: string) => void
  exitConnectionMode: () => void
  toggleConnectionModeWorktree: (worktreeId: string) => void
  finalizeConnection: () => Promise<void>
}

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set, get) => ({
      // Initial state
      connections: [],
      isLoading: false,
      error: null,
      loaded: false,
      selectedConnectionId: null,
      connectionGitView: 'connection',

      // Connection mode initial state
      connectionModeActive: false,
      connectionModeSourceWorktreeId: null,
      connectionModeSelectedIds: new Set<string>(),
      connectionModeSubmitting: false,

      loadConnections: async () => {
        set({ isLoading: true, error: null })
        try {
          const result = await connectionApi.getAll()
          if (!result.success) {
            set({
              error: result.error || 'Failed to load connections',
              isLoading: false,
              loaded: true
            })
            return
          }
          set({ connections: result.connections || [], isLoading: false, loaded: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          set({ error: message, isLoading: false, loaded: true })
        }
      },

      createConnection: async (worktreeIds: string[], opts?: { savedProjectId?: string }) => {
        try {
          const result = await connectionApi.create(worktreeIds, opts)
          if (!result.success || !result.connection) {
            toast.error(`Failed to create connection: ${result.error || 'Unknown error'}`)
            return null
          }
          const connection = result.connection
          set((state) => ({
            connections: [...state.connections, connection],
            selectedConnectionId: connection.id,
            connectionGitView: 'connection'
          }))
          // Deconflict: clear worktree selection synchronously (same tick)
          clearWorktreeSelection()
          clearDataProjectSelection()

          toast.success(`Connection "${connection.name}" created`)
          return connection.id
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(`Failed to create connection: ${message}`)
          return null
        }
      },

      deleteConnection: async (connectionId: string) => {
        try {
          const result = await connectionApi.delete(connectionId)
          if (!result.success) {
            toast.error(result.error || 'Failed to delete connection')
            return
          }
          // Remove from pinned list if pinned
          const { usePinnedStore } = await import('./usePinnedStore')
          usePinnedStore.getState().removeConnection(connectionId)

          set((state) => {
            const connections = state.connections.filter((c) => c.id !== connectionId)
            const selectedConnectionId =
              state.selectedConnectionId === connectionId ? null : state.selectedConnectionId
            return { connections, selectedConnectionId }
          })
          toast.success('Connection deleted')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(`Failed to delete connection: ${message}`)
        }
      },

      addMember: async (connectionId: string, worktreeId: string) => {
        try {
          const addResult = await connectionApi.addMember(connectionId, worktreeId)
          if (!addResult.success) {
            toast.error(`Failed to add member: ${addResult.error || 'Unknown error'}`)
            return
          }
          // Reload the specific connection to get updated members
          const result = await connectionApi.get(connectionId)
          if (result.success && result.connection) {
            set((state) => ({
              connections: state.connections.map((c) =>
                c.id === connectionId ? result.connection! : c
              )
            }))
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(`Failed to add member: ${message}`)
        }
      },

      removeMember: async (connectionId: string, worktreeId: string) => {
        try {
          const result = await connectionApi.removeMember(connectionId, worktreeId)
          if (!result.success) {
            toast.error(`Failed to remove member: ${result.error || 'Unknown error'}`)
            return
          }
          if (result.connectionDeleted) {
            // Connection was deleted because it was the last member
            // Remove from pinned list if pinned
            const { usePinnedStore } = await import('./usePinnedStore')
            usePinnedStore.getState().removeConnection(connectionId)

            set((state) => {
              const connections = state.connections.filter((c) => c.id !== connectionId)
              const selectedConnectionId =
                state.selectedConnectionId === connectionId ? null : state.selectedConnectionId
              return { connections, selectedConnectionId }
            })
          } else {
            // Reload the connection to get updated members
            const getResult = await connectionApi.get(connectionId)
            if (getResult.success && getResult.connection) {
              set((state) => ({
                connections: state.connections.map((c) =>
                  c.id === connectionId ? getResult.connection! : c
                )
              }))
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(`Failed to remove member: ${message}`)
        }
      },

      updateConnectionMembers: async (connectionId: string, desiredWorktreeIds: string[]) => {
        const currentConnection = get().connections.find((c) => c.id === connectionId)
        if (!currentConnection) {
          toast.error('Connection not found')
          return false
        }

        const currentIds = new Set(currentConnection.members.map((m) => m.worktree_id))
        const desiredSet = new Set(desiredWorktreeIds)

        const toAdd = desiredWorktreeIds.filter((id) => !currentIds.has(id))
        const toRemove = Array.from(currentIds).filter((id) => !desiredSet.has(id))

        if (toAdd.length === 0 && toRemove.length === 0) {
          return true
        }

        try {
          // Apply the full member diff in a single batched RPC (history recorded once server-side).
          const result = await connectionApi.updateMembers(connectionId, desiredWorktreeIds)
          if (!result.success) {
            toast.error(`Failed to update connection: ${result.error || 'Unknown error'}`)
            // The server applies adds-then-removes non-transactionally, so a reported failure
            // may still have partially persisted. Resync from the server (best-effort) so the
            // renderer doesn't keep showing stale members.
            try {
              const resynced = await connectionApi.get(connectionId)
              if (resynced.success && resynced.connection) {
                const updated = resynced.connection
                set((state) => ({
                  connections: state.connections.map((c) => (c.id === connectionId ? updated : c))
                }))
              }
            } catch {
              // Ignore resync failures — this is best-effort only.
            }
            return false
          }
          if (result.connectionDeleted) {
            // Connection was deleted server-side — mirror the removeMember cleanup path.
            const { usePinnedStore } = await import('./usePinnedStore')
            usePinnedStore.getState().removeConnection(connectionId)

            set((state) => {
              const connections = state.connections.filter((c) => c.id !== connectionId)
              const selectedConnectionId =
                state.selectedConnectionId === connectionId ? null : state.selectedConnectionId
              return { connections, selectedConnectionId }
            })
          } else if (result.connection) {
            const updated = result.connection
            set((state) => ({
              connections: state.connections.map((c) => (c.id === connectionId ? updated : c))
            }))
          }
          toast.success('Connection updated')
          return true
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(`Failed to update connection: ${message}`)
          return false
        }
      },

      // The New Connection dialog's flow — a fresh worktree per project, then one connection —
      // lives in lib/connection-create so the agent and the phone create connections the same
      // way. This action adds the dialog's UI: select the new connection and toast.
      quickCreateConnection: async (
        projects: { id: string; path: string; name: string }[],
        opts?: { savedProjectId?: string }
      ) => {
        if (projects.length < 2) {
          return null
        }

        // Dynamic import avoids a store cycle (the helper imports this store).
        const { createConnectionFromProjects } = await import('@/lib/connection-create')
        const result = await createConnectionFromProjects(projects, opts)
        if (!result.ok) {
          toast.error(result.error)
          return null
        }

        set({ selectedConnectionId: result.connectionId, connectionGitView: 'connection' })
        // Deconflict: clear worktree selection synchronously (same tick)
        clearWorktreeSelection()
        clearDataProjectSelection()
        toast.success(`Connection "${result.connectionName}" created`)
        return result.connectionId
      },

      // A fresh connection over the same member projects on brand-new worktrees —
      // the same thing as picking those projects in the New Connection dialog.
      duplicateConnection: async (connectionId: string) => {
        const source = get().connections.find((c) => c.id === connectionId)
        if (!source) {
          toast.error('Connection not found')
          return null
        }

        // Dynamic import avoids a store cycle.
        const { useProjectStore } = await import('./useProjectStore')
        const projectsById = new Map(useProjectStore.getState().projects.map((p) => [p.id, p]))

        const projects: { id: string; path: string; name: string }[] = []
        for (const projectId of new Set((source.members || []).map((m) => m.project_id))) {
          const project = projectsById.get(projectId)
          if (!project) {
            toast.error('Failed to duplicate connection: a member project no longer exists')
            return null
          }
          projects.push({ id: project.id, path: project.path, name: project.name })
        }
        if (projects.length < 2) {
          toast.error('A connection needs at least 2 projects to be duplicated')
          return null
        }

        // An instance of a connection project duplicates into another instance of it.
        return get().quickCreateConnection(
          projects,
          source.saved_project_id ? { savedProjectId: source.saved_project_id } : undefined
        )
      },

      saveConnectionAsProject: async (connectionId: string) => {
        try {
          const result = await connectionApi.saveAsProject(connectionId)
          if (!result.success || !result.project) {
            toast.error(result.error || 'Failed to save connection as project')
            return null
          }
          const project = result.project

          // Mirror the linked connection locally (it becomes the project's first instance)
          if (result.connection) {
            const updated = result.connection
            set((state) => ({
              connections: state.connections.map((c) => (c.id === connectionId ? updated : c))
            }))
          } else {
            set((state) => ({
              connections: state.connections.map((c) =>
                c.id === connectionId ? { ...c, saved_project_id: project.id } : c
              )
            }))
          }
          // The project's base instance (member default worktrees) — upsert without
          // selecting. It may BE the source connection (a connection already spanning
          // the member default worktrees is promoted rather than duplicated), so
          // replace an existing row instead of skipping it.
          const baseConnection = result.baseConnection
          if (baseConnection) {
            set((state) =>
              state.connections.some((c) => c.id === baseConnection.id)
                ? {
                    connections: state.connections.map((c) =>
                      c.id === baseConnection.id ? baseConnection : c
                    )
                  }
                : { connections: [...state.connections, baseConnection] }
            )
          }
          // The source connection may already be pinned: it is now an instance of
          // the new project, so the pinned board scope must pick the project up.
          const { usePinnedStore } = await import('./usePinnedStore')
          if (usePinnedStore.getState().isConnectionPinned(connectionId)) {
            void usePinnedStore.getState().loadPinned()
          }

          // Insert + select the new project (dynamic import avoids a store cycle)
          const { useProjectStore } = await import('./useProjectStore')
          const projectStore = useProjectStore.getState()
          useProjectStore.setState((state) => ({
            projects: [project, ...state.projects],
            expandedProjectIds: new Set([...state.expandedProjectIds, project.id])
          }))
          projectStore.selectProject(project.id)
          // Board-first entity: clear connection selection so its board shows
          get().selectConnection(null)
          const { useWorktreeStore } = await import('./useWorktreeStore')
          useWorktreeStore.getState().selectWorktreeOnly(null)

          toast.success(`Saved "${project.name}" as a project`)
          return project.id
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(`Failed to save connection as project: ${message}`)
          return null
        }
      },

      updateConnectionProjectMembers: async (projectId: string, memberProjectIds: string[]) => {
        try {
          const result = await connectionApi.updateProjectMembers(projectId, memberProjectIds)
          if (!result.success || !result.project) {
            toast.error(`Failed to update connection: ${result.error || 'Unknown error'}`)
            return false
          }
          const project = result.project
          // Refresh the project row (dynamic import avoids a store cycle)
          const { useProjectStore } = await import('./useProjectStore')
          useProjectStore.setState((state) => ({
            projects: state.projects.map((p) =>
              p.id === project.id ? { ...p, member_project_ids: project.member_project_ids } : p
            )
          }))
          // The base instance was rebuilt over the new members: re-list connections.
          await get().loadConnections()
          return true
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(`Failed to update connection: ${message}`)
          return false
        }
      },

      renameConnection: async (connectionId: string, customName: string | null) => {
        try {
          const result = await connectionApi.rename(connectionId, customName)
          if (!result.success) {
            toast.error(result.error || 'Failed to rename connection')
            return
          }
          if (result.connection) {
            set((state) => ({
              connections: state.connections.map((c) =>
                c.id === connectionId ? { ...c, custom_name: result.connection!.custom_name } : c
              )
            }))
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(`Failed to rename connection: ${message}`)
        }
      },

      enterConnectionMode: (sourceWorktreeId: string) => {
        set({
          connectionModeActive: true,
          connectionModeSourceWorktreeId: sourceWorktreeId,
          connectionModeSelectedIds: new Set([sourceWorktreeId]),
          connectionModeSubmitting: false
        })
      },

      exitConnectionMode: () => {
        set({
          connectionModeActive: false,
          connectionModeSourceWorktreeId: null,
          connectionModeSelectedIds: new Set<string>(),
          connectionModeSubmitting: false
        })
      },

      toggleConnectionModeWorktree: (worktreeId: string) => {
        const { connectionModeSourceWorktreeId, connectionModeSelectedIds } = get()
        // Source worktree cannot be unchecked
        if (worktreeId === connectionModeSourceWorktreeId) return

        const next = new Set(connectionModeSelectedIds)
        if (next.has(worktreeId)) {
          next.delete(worktreeId)
        } else {
          next.add(worktreeId)
        }
        set({ connectionModeSelectedIds: next })
      },

      finalizeConnection: async () => {
        const { connectionModeSelectedIds, createConnection } = get()
        if (connectionModeSelectedIds.size < 2) return

        set({ connectionModeSubmitting: true })
        try {
          const worktreeIds = Array.from(connectionModeSelectedIds)
          const connectionId = await createConnection(worktreeIds)
          if (connectionId) {
            get().exitConnectionMode()
          } else {
            set({ connectionModeSubmitting: false })
          }
        } catch {
          set({ connectionModeSubmitting: false })
        }
      },

      selectConnection: (id: string | null, opts?: { gitView?: ConnectionGitView }) => {
        // A plain (re)selection always lands on the connection's own branches;
        // only an explicit gitView request shows the members' base branches.
        set({
          selectedConnectionId: id,
          connectionGitView: id ? (opts?.gitView ?? 'connection') : 'connection'
        })
        if (id) {
          // Deconflict: clear worktree selection synchronously (same tick)
          clearWorktreeSelection()
          clearDataProjectSelection()
          // Close pinned board when entering connection mode (matches worktree
          // behavior); idempotent close, not a toggle, so it can't race other
          // queued closes back to active.
          useKanbanStore.getState().closePinnedBoard()
        }
      }
    }),
    {
      name: 'hive-connections',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        selectedConnectionId: state.selectedConnectionId
      })
    }
  )
)

// Register the connection-clear callback so useWorktreeStore can call it synchronously
registerConnectionClear(() =>
  useConnectionStore.setState({ selectedConnectionId: null, connectionGitView: 'connection' })
)

// Let usePinnedStore map pinned connections → their connection project (pinned board scope)
registerConnectionSavedProjectResolver(
  (connectionId) =>
    useConnectionStore.getState().connections.find((c) => c.id === connectionId)
      ?.saved_project_id ?? null
)
