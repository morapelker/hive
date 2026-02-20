import { create } from 'zustand'
import { useWorktreeStore } from './useWorktreeStore'
import { useSessionStore } from './useSessionStore'

const ONE_HOUR_MS = 60 * 60 * 1000
const STORAGE_KEY = 'hive-recent-visible'

interface RecentState {
  recentVisible: boolean
  recentWorktreeIds: Set<string>
  recentConnectionIds: Set<string>

  toggleRecent: () => void
  populateRecent: () => Promise<void>
  addWorktreeToRecent: (id: string) => void
  addConnectionToRecent: (id: string) => void
  clearRecent: () => void
}

export const useRecentStore = create<RecentState>()((set, get) => ({
  recentVisible: (() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })(),
  recentWorktreeIds: new Set<string>(),
  recentConnectionIds: new Set<string>(),

  toggleRecent: () => {
    const current = get().recentVisible
    const next = !current

    try {
      localStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      // ignore storage errors
    }

    if (next) {
      // Turning on — populate from last hour then set visible
      set({ recentVisible: true })
      get().populateRecent()
    } else {
      // Turning off — clear sticky sets
      set({
        recentVisible: false,
        recentWorktreeIds: new Set(),
        recentConnectionIds: new Set()
      })
    }
  },

  populateRecent: async () => {
    const now = Date.now()
    const cutoff = now - ONE_HOUR_MS

    // Query DB for ALL worktrees with recent AI activity (not just expanded ones)
    const worktreeIds = new Set<string>()
    try {
      const recentWorktrees = await window.db.worktree.getRecentlyActive(cutoff)

      // Ensure parent projects have their worktrees loaded in the store
      // so RecentList can look them up (collapsed projects aren't loaded yet)
      const loaded = useWorktreeStore.getState().worktreesByProject
      const projectsToLoad = new Set<string>()
      for (const wt of recentWorktrees) {
        worktreeIds.add(wt.id)
        if (!loaded.has(wt.project_id)) {
          projectsToLoad.add(wt.project_id)
        }
      }
      await Promise.all(
        [...projectsToLoad].map((pid) =>
          useWorktreeStore.getState().loadWorktrees(pid)
        )
      )
    } catch {
      // Fallback silently if DB query fails
    }

    // Scan connection sessions for recent activity
    const connectionIds = new Set<string>()
    const sessionsByConnection = useSessionStore.getState().sessionsByConnection
    for (const [connectionId, sessions] of sessionsByConnection) {
      for (const session of sessions) {
        if (session.updated_at) {
          const updatedAt = new Date(session.updated_at).getTime()
          if (updatedAt > cutoff) {
            connectionIds.add(connectionId)
            break
          }
        }
      }
    }

    set({
      recentWorktreeIds: worktreeIds,
      recentConnectionIds: connectionIds
    })
  },

  addWorktreeToRecent: (id: string) => {
    set((state) => {
      if (state.recentWorktreeIds.has(id)) return state
      const next = new Set(state.recentWorktreeIds)
      next.add(id)
      return { recentWorktreeIds: next }
    })
  },

  addConnectionToRecent: (id: string) => {
    set((state) => {
      if (state.recentConnectionIds.has(id)) return state
      const next = new Set(state.recentConnectionIds)
      next.add(id)
      return { recentConnectionIds: next }
    })
  },

  clearRecent: () => {
    set({
      recentWorktreeIds: new Set(),
      recentConnectionIds: new Set()
    })
  }
}))
// Note: auto-populate on startup is handled by a useEffect in RecentList,
// which runs after React mount — avoiding race conditions with other stores.
