import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { toast } from '@/lib/toast'
import { registerConnectionClear, clearWorktreeSelection } from './store-coordination'
import { useKanbanStore } from './useKanbanStore'
import { connectionApi } from '@/api/connection-api'
import { worktreeApi } from '@/api/worktree-api'

// Connection types matching the database schema
interface ConnectionMemberEnriched {
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

interface Connection {
  id: string
  name: string
  custom_name: string | null
  status: 'active' | 'archived'
  path: string
  color: string | null
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

  // Connection Mode (inline sidebar selection)
  connectionModeActive: boolean
  connectionModeSourceWorktreeId: string | null
  connectionModeSelectedIds: Set<string>
  connectionModeSubmitting: boolean

  // Actions
  loadConnections: () => Promise<void>
  createConnection: (worktreeIds: string[]) => Promise<string | null>
  deleteConnection: (connectionId: string) => Promise<void>
  addMember: (connectionId: string, worktreeId: string) => Promise<void>
  removeMember: (connectionId: string, worktreeId: string) => Promise<void>
  updateConnectionMembers: (connectionId: string, desiredWorktreeIds: string[]) => Promise<boolean>
  quickCreateConnection: (
    projects: { id: string; path: string; name: string }[]
  ) => Promise<string | null>
  selectConnection: (id: string | null) => void

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

      createConnection: async (worktreeIds: string[]) => {
        try {
          const result = await connectionApi.create(worktreeIds)
          if (!result.success || !result.connection) {
            toast.error(`Failed to create connection: ${result.error || 'Unknown error'}`)
            return null
          }
          const connection = result.connection
          set((state) => ({
            connections: [...state.connections, connection],
            selectedConnectionId: connection.id
          }))
          // Deconflict: clear worktree selection synchronously (same tick)
          clearWorktreeSelection()

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

      quickCreateConnection: async (projects: { id: string; path: string; name: string }[]) => {
        if (projects.length < 2) {
          return null
        }

        // Dynamic import to avoid a store cycle; fireSetupScript is a module-level export.
        const { useWorktreeStore, fireSetupScript } = await import('./useWorktreeStore')

        const created: {
          project: { id: string; path: string; name: string }
          worktree: { id: string; path: string; branch_name: string }
        }[] = []

        // Best-effort rollback of every already-created worktree (per-item try/catch).
        const rollback = async (): Promise<void> => {
          for (const { project, worktree } of created) {
            try {
              const deleteResult = await worktreeApi.delete({
                worktreeId: worktree.id,
                worktreePath: worktree.path,
                branchName: worktree.branch_name,
                projectPath: project.path,
                archive: false
              })
              if (deleteResult.success) {
                useWorktreeStore.getState().removeWorktreeFromProject(project.id, worktree.id)
              }
            } catch {
              // Ignore rollback failures — this is a best-effort cleanup.
            }
          }
        }

        for (const project of projects) {
          const result = await worktreeApi.create({
            projectId: project.id,
            projectPath: project.path,
            projectName: project.name
          })
          if (!result.success || !result.worktree) {
            await rollback()
            toast.error(
              `Failed to create worktree in "${project.name}": ${result.error ?? 'Unknown error'}`
            )
            return null
          }
          // Insert WITHOUT selecting — deliberately NOT the createWorktree action, which
          // selects the new worktree and closes open file tabs.
          useWorktreeStore.getState().addWorktreeToProject(project.id, result.worktree)
          created.push({ project, worktree: result.worktree })
        }

        // Only fire setup scripts once every worktree has been created successfully — the
        // per-project create loop above can still fail partway through and roll back
        // (delete) earlier directories, and we don't want setup scripts racing that deletion.
        for (const { project, worktree } of created) {
          fireSetupScript(project.id, worktree.id, worktree.path)
        }

        const connectionId = await get().createConnection(created.map((c) => c.worktree.id))
        if (!connectionId) {
          // createConnection already surfaced its own error toast — just undo the worktrees.
          await rollback()
          return null
        }

        return connectionId
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

      selectConnection: (id: string | null) => {
        set({ selectedConnectionId: id })
        if (id) {
          // Deconflict: clear worktree selection synchronously (same tick)
          clearWorktreeSelection()
          // Close pinned board when entering connection mode (matches worktree behavior)
          const kanbanState = useKanbanStore.getState()
          if (kanbanState.isPinnedBoardActive) {
            kanbanState.togglePinnedBoard()
          }
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
registerConnectionClear(() => useConnectionStore.setState({ selectedConnectionId: null }))
