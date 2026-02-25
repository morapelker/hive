import { create } from 'zustand'
import { toast } from '@/lib/toast'
import { useWorktreeStore } from './useWorktreeStore'

interface PinnedState {
  pinnedWorktreeIds: Set<string>
  pinnedConnectionIds: Set<string>
  loaded: boolean

  loadPinned: () => Promise<void>
  pinWorktree: (id: string) => Promise<void>
  unpinWorktree: (id: string) => Promise<void>
  pinConnection: (id: string) => Promise<void>
  unpinConnection: (id: string) => Promise<void>
  /** Remove a worktree from pinned state (local only, no IPC). Use when the item is archived/deleted. */
  removeWorktree: (id: string) => void
  /** Remove a connection from pinned state (local only, no IPC). Use when the item is deleted. */
  removeConnection: (id: string) => void
  isWorktreePinned: (id: string) => boolean
  isConnectionPinned: (id: string) => boolean
}

export const usePinnedStore = create<PinnedState>()((set, get) => ({
  pinnedWorktreeIds: new Set<string>(),
  pinnedConnectionIds: new Set<string>(),
  loaded: false,

  loadPinned: async () => {
    try {
      const [pinnedWorktrees, pinnedConnections] = await Promise.all([
        window.db.worktree.getPinned(),
        window.connectionOps.getPinned()
      ])

      const worktreeIds = new Set(pinnedWorktrees.map((wt) => wt.id))
      const connectionIds = new Set(pinnedConnections.map((c) => c.id))

      // Ensure parent projects have their worktrees loaded so PinnedList can look them up
      const loaded = useWorktreeStore.getState().worktreesByProject
      const projectsToLoad = new Set<string>()
      for (const wt of pinnedWorktrees) {
        if (!loaded.has(wt.project_id)) {
          projectsToLoad.add(wt.project_id)
        }
      }
      await Promise.all(
        [...projectsToLoad].map((pid) =>
          useWorktreeStore.getState().loadWorktrees(pid)
        )
      )

      set({ pinnedWorktreeIds: worktreeIds, pinnedConnectionIds: connectionIds, loaded: true })
    } catch {
      // Fallback silently if DB query fails
      set({ loaded: true })
    }
  },

  pinWorktree: async (id: string) => {
    const result = await window.db.worktree.setPinned(id, true)
    if (result.success) {
      set((state) => {
        const next = new Set(state.pinnedWorktreeIds)
        next.add(id)
        return { pinnedWorktreeIds: next }
      })
    } else {
      toast.error(result.error || 'Failed to pin worktree')
    }
  },

  unpinWorktree: async (id: string) => {
    const result = await window.db.worktree.setPinned(id, false)
    if (result.success) {
      set((state) => {
        const next = new Set(state.pinnedWorktreeIds)
        next.delete(id)
        return { pinnedWorktreeIds: next }
      })
    } else {
      toast.error(result.error || 'Failed to unpin worktree')
    }
  },

  pinConnection: async (id: string) => {
    const result = await window.connectionOps.setPinned(id, true)
    if (result.success) {
      set((state) => {
        const next = new Set(state.pinnedConnectionIds)
        next.add(id)
        return { pinnedConnectionIds: next }
      })
    } else {
      toast.error(result.error || 'Failed to pin connection')
    }
  },

  unpinConnection: async (id: string) => {
    const result = await window.connectionOps.setPinned(id, false)
    if (result.success) {
      set((state) => {
        const next = new Set(state.pinnedConnectionIds)
        next.delete(id)
        return { pinnedConnectionIds: next }
      })
    } else {
      toast.error(result.error || 'Failed to unpin connection')
    }
  },

  removeWorktree: (id: string) => {
    set((state) => {
      if (!state.pinnedWorktreeIds.has(id)) return state
      const next = new Set(state.pinnedWorktreeIds)
      next.delete(id)
      return { pinnedWorktreeIds: next }
    })
  },

  removeConnection: (id: string) => {
    set((state) => {
      if (!state.pinnedConnectionIds.has(id)) return state
      const next = new Set(state.pinnedConnectionIds)
      next.delete(id)
      return { pinnedConnectionIds: next }
    })
  },

  isWorktreePinned: (id: string) => {
    return get().pinnedWorktreeIds.has(id)
  },

  isConnectionPinned: (id: string) => {
    return get().pinnedConnectionIds.has(id)
  }
}))
