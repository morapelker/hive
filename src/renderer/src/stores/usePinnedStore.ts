import { create } from 'zustand'
import { toast } from '@/lib/toast'
import { useWorktreeStore } from './useWorktreeStore'
import { dbApi } from '@/api/db-api'
import { connectionApi } from '@/api/connection-api'
import { resolveConnectionSavedProjectId } from './store-coordination'

interface PinnedState {
  pinnedWorktreeIds: Set<string>
  pinnedConnectionIds: Set<string>
  pinnedProjectIds: Set<string>
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

/**
 * Find the project_id for a given worktree ID by scanning worktrees already
 * loaded in the worktree store. Returns undefined when the project's worktrees
 * haven't been loaded yet (safe to ignore — an unloaded worktree can't be in
 * any pinned list).
 */
function findProjectIdForWorktree(worktreeId: string): string | undefined {
  const worktreesByProject = useWorktreeStore.getState().worktreesByProject
  for (const worktrees of worktreesByProject.values()) {
    for (const wt of worktrees) {
      if (wt.id === worktreeId) return wt.project_id
    }
  }
  return undefined
}

/**
 * The connection project (projects.kind === 'connection') a pinned connection is
 * an instance of — pinning any instance scopes that project's board onto the
 * pinned board, exactly like pinning any worktree does for a git project.
 * Resolved through store-coordination (registered by useConnectionStore).
 */
function findSavedProjectIdForConnection(connectionId: string): string | undefined {
  return resolveConnectionSavedProjectId(connectionId) ?? undefined
}

export const usePinnedStore = create<PinnedState>()((set, get) => ({
  pinnedWorktreeIds: new Set<string>(),
  pinnedConnectionIds: new Set<string>(),
  pinnedProjectIds: new Set<string>(),
  loaded: false,

  loadPinned: async () => {
    try {
      const [pinnedWorktrees, pinnedConnections] = await Promise.all([
        dbApi.worktree.getPinned<{ id: string; project_id: string }>(),
        connectionApi.getPinned()
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
        [...projectsToLoad].map((pid) => useWorktreeStore.getState().loadWorktrees(pid))
      )

      // Derive project IDs directly from the fetched pinned worktrees (which have project_id)
      const projectIds = new Set(pinnedWorktrees.map((wt) => wt.project_id))
      // ...plus the connection projects whose instances are pinned
      for (const connection of pinnedConnections) {
        if (connection.saved_project_id) projectIds.add(connection.saved_project_id)
      }

      set({
        pinnedWorktreeIds: worktreeIds,
        pinnedConnectionIds: connectionIds,
        pinnedProjectIds: projectIds,
        loaded: true
      })
    } catch {
      // Fallback silently if DB query fails
      set({ loaded: true })
    }
  },

  pinWorktree: async (id: string) => {
    const result = await dbApi.worktree.setPinned(id, true)
    if (result.success) {
      const projectId = findProjectIdForWorktree(id)
      set((state) => {
        const nextWorktreeIds = new Set(state.pinnedWorktreeIds)
        nextWorktreeIds.add(id)
        const nextProjectIds = new Set(state.pinnedProjectIds)
        if (projectId) nextProjectIds.add(projectId)
        return { pinnedWorktreeIds: nextWorktreeIds, pinnedProjectIds: nextProjectIds }
      })
    } else {
      toast.error(result.error || 'Failed to pin worktree')
    }
  },

  unpinWorktree: async (id: string) => {
    const result = await dbApi.worktree.setPinned(id, false)
    if (result.success) {
      const projectId = findProjectIdForWorktree(id)
      set((state) => {
        const nextWorktreeIds = new Set(state.pinnedWorktreeIds)
        nextWorktreeIds.delete(id)
        const nextProjectIds = new Set(state.pinnedProjectIds)
        if (projectId) {
          const projectStillPinned = [...nextWorktreeIds].some(
            (wid) => findProjectIdForWorktree(wid) === projectId
          )
          if (!projectStillPinned) nextProjectIds.delete(projectId)
        }
        return { pinnedWorktreeIds: nextWorktreeIds, pinnedProjectIds: nextProjectIds }
      })
    } else {
      toast.error(result.error || 'Failed to unpin worktree')
    }
  },

  pinConnection: async (id: string) => {
    const result = await connectionApi.setPinned(id, true)
    if (result.success) {
      const savedProjectId = findSavedProjectIdForConnection(id)
      set((state) => {
        const next = new Set(state.pinnedConnectionIds)
        next.add(id)
        const nextProjectIds = new Set(state.pinnedProjectIds)
        if (savedProjectId) nextProjectIds.add(savedProjectId)
        return { pinnedConnectionIds: next, pinnedProjectIds: nextProjectIds }
      })
    } else {
      toast.error(result.error || 'Failed to pin connection')
    }
  },

  unpinConnection: async (id: string) => {
    const result = await connectionApi.setPinned(id, false)
    if (result.success) {
      const savedProjectId = findSavedProjectIdForConnection(id)
      set((state) => {
        const next = new Set(state.pinnedConnectionIds)
        next.delete(id)
        const nextProjectIds = new Set(state.pinnedProjectIds)
        if (savedProjectId) {
          const projectStillPinned = [...next].some(
            (cid) => findSavedProjectIdForConnection(cid) === savedProjectId
          )
          if (!projectStillPinned) nextProjectIds.delete(savedProjectId)
        }
        return { pinnedConnectionIds: next, pinnedProjectIds: nextProjectIds }
      })
    } else {
      toast.error(result.error || 'Failed to unpin connection')
    }
  },

  removeWorktree: (id: string) => {
    const projectId = findProjectIdForWorktree(id)
    set((state) => {
      if (!state.pinnedWorktreeIds.has(id)) return state
      const nextWorktreeIds = new Set(state.pinnedWorktreeIds)
      nextWorktreeIds.delete(id)
      const nextProjectIds = new Set(state.pinnedProjectIds)
      if (projectId) {
        const projectStillPinned = [...nextWorktreeIds].some(
          (wid) => findProjectIdForWorktree(wid) === projectId
        )
        if (!projectStillPinned) nextProjectIds.delete(projectId)
      }
      return { pinnedWorktreeIds: nextWorktreeIds, pinnedProjectIds: nextProjectIds }
    })
  },

  removeConnection: (id: string) => {
    // Resolve BEFORE the caller drops the connection from its store (callers
    // invoke this first, so the lookup still sees the row).
    const savedProjectId = findSavedProjectIdForConnection(id)
    set((state) => {
      if (!state.pinnedConnectionIds.has(id)) return state
      const next = new Set(state.pinnedConnectionIds)
      next.delete(id)
      const nextProjectIds = new Set(state.pinnedProjectIds)
      if (savedProjectId) {
        const projectStillPinned = [...next].some(
          (cid) => findSavedProjectIdForConnection(cid) === savedProjectId
        )
        if (!projectStillPinned) nextProjectIds.delete(savedProjectId)
      }
      return { pinnedConnectionIds: next, pinnedProjectIds: nextProjectIds }
    })
  },

  isWorktreePinned: (id: string) => {
    return get().pinnedWorktreeIds.has(id)
  },

  isConnectionPinned: (id: string) => {
    return get().pinnedConnectionIds.has(id)
  }
}))
