import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { toast } from '@/lib/toast'
import { registerConnectionClear, clearWorktreeSelection } from './store-coordination'
import { translate } from '@/i18n/useI18n'
import { DEFAULT_LOCALE } from '@/i18n/messages'
import { useSettingsStore } from './useSettingsStore'

function t(key: string, params?: Record<string, string | number | boolean>): string {
  const locale = useSettingsStore.getState().locale ?? DEFAULT_LOCALE
  return translate(locale, key, params)
}

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
  updateConnectionMembers: (connectionId: string, desiredWorktreeIds: string[]) => Promise<void>
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
      selectedConnectionId: null,

      // Connection mode initial state
      connectionModeActive: false,
      connectionModeSourceWorktreeId: null,
      connectionModeSelectedIds: new Set<string>(),
      connectionModeSubmitting: false,

      loadConnections: async () => {
        set({ isLoading: true, error: null })
        try {
          const result = await window.connectionOps.getAll()
          if (!result.success) {
            set({ error: result.error || 'Failed to load connections', isLoading: false })
            return
          }
          set({ connections: result.connections || [], isLoading: false })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          set({ error: message, isLoading: false })
        }
      },

      createConnection: async (worktreeIds: string[]) => {
        try {
          const result = await window.connectionOps.create(worktreeIds)
          if (!result.success || !result.connection) {
            toast.error(
              t('connectionStore.toasts.createError', {
                error: result.error || t('connectionStore.toasts.unknownError')
              })
            )
            return null
          }
          const connection = result.connection
          set((state) => ({
            connections: [...state.connections, connection],
            selectedConnectionId: connection.id
          }))
          // Deconflict: clear worktree selection synchronously (same tick)
          clearWorktreeSelection()

          toast.success(t('connectionStore.toasts.createSuccess', { name: connection.name }))
          return connection.id
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(t('connectionStore.toasts.createError', { error: message }))
          return null
        }
      },

      deleteConnection: async (connectionId: string) => {
        try {
          const result = await window.connectionOps.delete(connectionId)
          if (!result.success) {
            toast.error(
              result.error
                ? t('connectionStore.toasts.deleteErrorWithReason', { error: result.error })
                : t('connectionStore.toasts.deleteError')
            )
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
          toast.success(t('connectionStore.toasts.deleteSuccess'))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(t('connectionStore.toasts.deleteErrorWithReason', { error: message }))
        }
      },

      addMember: async (connectionId: string, worktreeId: string) => {
        try {
          const addResult = await window.connectionOps.addMember(connectionId, worktreeId)
          if (!addResult.success) {
            toast.error(
              t('connectionStore.toasts.addMemberError', {
                error: addResult.error || t('connectionStore.toasts.unknownError')
              })
            )
            return
          }
          // Reload the specific connection to get updated members
          const result = await window.connectionOps.get(connectionId)
          if (result.success && result.connection) {
            set((state) => ({
              connections: state.connections.map((c) =>
                c.id === connectionId ? result.connection! : c
              )
            }))
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(t('connectionStore.toasts.addMemberError', { error: message }))
        }
      },

      removeMember: async (connectionId: string, worktreeId: string) => {
        try {
          const result = await window.connectionOps.removeMember(connectionId, worktreeId)
          if (!result.success) {
            toast.error(
              t('connectionStore.toasts.removeMemberError', {
                error: result.error || t('connectionStore.toasts.unknownError')
              })
            )
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
            const getResult = await window.connectionOps.get(connectionId)
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
          toast.error(t('connectionStore.toasts.removeMemberError', { error: message }))
        }
      },

      updateConnectionMembers: async (connectionId: string, desiredWorktreeIds: string[]) => {
        const currentConnection = get().connections.find((c) => c.id === connectionId)
        if (!currentConnection) {
          toast.error(t('connectionStore.toasts.notFound'))
          return
        }

        const currentIds = new Set(currentConnection.members.map((m) => m.worktree_id))
        const desiredSet = new Set(desiredWorktreeIds)

        const toAdd = desiredWorktreeIds.filter((id) => !currentIds.has(id))
        const toRemove = Array.from(currentIds).filter((id) => !desiredSet.has(id))

        if (toAdd.length === 0 && toRemove.length === 0) {
          return
        }

        try {
          // Add new members first (to avoid transiently having 0 members)
          for (const id of toAdd) {
            const addResult = await window.connectionOps.addMember(connectionId, id)
            if (!addResult.success) {
              toast.error(
                t('connectionStore.toasts.addMemberError', {
                  error: addResult.error || t('connectionStore.toasts.unknownError')
                })
              )
              return
            }
          }
          // Remove departing members
          for (const id of toRemove) {
            const removeResult = await window.connectionOps.removeMember(connectionId, id)
            if (!removeResult.success) {
              toast.error(
                t('connectionStore.toasts.removeMemberError', {
                  error: removeResult.error || t('connectionStore.toasts.unknownError')
                })
              )
              return
            }
          }
          // Reload the connection to get final state
          const result = await window.connectionOps.get(connectionId)
          if (result.success && result.connection) {
            set((state) => ({
              connections: state.connections.map((c) =>
                c.id === connectionId ? result.connection! : c
              )
            }))
          }
          toast.success(t('connectionStore.toasts.updateSuccess'))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(t('connectionStore.toasts.updateError', { error: message }))
        }
      },

      renameConnection: async (connectionId: string, customName: string | null) => {
        try {
          const result = await window.connectionOps.rename(connectionId, customName)
          if (!result.success) {
            toast.error(
              result.error
                ? t('connectionStore.toasts.renameErrorWithReason', { error: result.error })
                : t('connectionStore.toasts.renameError')
            )
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
          toast.error(t('connectionStore.toasts.renameErrorWithReason', { error: message }))
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
