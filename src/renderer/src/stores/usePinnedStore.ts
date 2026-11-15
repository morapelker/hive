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
  /**
   * Pin or unpin several worktrees (git project) or instances (connection project) of ONE
   * project as a single change: every id is persisted, then the store changes once. When an
   * id fails, the ones already written are put back and the store is left as it was. Shows no
   * toast: the caller reports. Use `setProjectPinned` (lib/project-pin) for the user action.
   */
  setProjectPins: (change: ProjectPinChange) => Promise<ProjectPinResult>
}

export interface ProjectPinChange {
  /** The project whose board joins (pinned) or leaves (unpinned) the pinned board. */
  projectId: string
  kind: 'worktree' | 'connection'
  /** Pinning: the ids to pin. Unpinning: EVERY pinned worktree / instance of the project. */
  ids: string[]
  pinned: boolean
}

export interface ProjectPinResult {
  success: boolean
  error?: string
}

async function persistPin(
  kind: ProjectPinChange['kind'],
  id: string,
  pinned: boolean
): Promise<ProjectPinResult> {
  try {
    const result =
      kind === 'worktree'
        ? await dbApi.worktree.setPinned(id, pinned)
        : await connectionApi.setPinned(id, pinned)
    return result?.success ? { success: true } : { success: false, error: result?.error }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
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
  },

  setProjectPins: async ({ projectId, kind, ids, pinned }: ProjectPinChange) => {
    const written: string[] = []
    for (const id of ids) {
      const result = await persistPin(kind, id, pinned)
      if (!result.success) {
        // All or nothing: put back what was already written, best effort.
        await Promise.all(written.map((done) => persistPin(kind, done, !pinned)))
        return result
      }
      written.push(id)
    }

    set((state) => {
      const nextIds = new Set(
        kind === 'worktree' ? state.pinnedWorktreeIds : state.pinnedConnectionIds
      )
      for (const id of ids) {
        if (pinned) nextIds.add(id)
        else nextIds.delete(id)
      }
      const nextProjectIds = new Set(state.pinnedProjectIds)
      if (pinned) nextProjectIds.add(projectId)
      else nextProjectIds.delete(projectId)
      return kind === 'worktree'
        ? { pinnedWorktreeIds: nextIds, pinnedProjectIds: nextProjectIds }
        : { pinnedConnectionIds: nextIds, pinnedProjectIds: nextProjectIds }
    })
    return { success: true }
  }
}))
