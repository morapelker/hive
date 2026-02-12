import { create } from 'zustand'
import { useSessionStore } from './useSessionStore'

export type SessionStatusType = 'working' | 'planning' | 'answering' | 'unread' | 'completed'

export interface SessionStatusEntry {
  status: SessionStatusType
  timestamp: number
  word?: string
  durationMs?: number
}

interface WorktreeStatusState {
  // sessionId → status info (null means no status / cleared)
  sessionStatuses: Record<string, SessionStatusEntry | null>
  // worktreeId → epoch ms of last message activity
  lastMessageTimeByWorktree: Record<string, number>

  // Actions
  setSessionStatus: (
    sessionId: string,
    status: SessionStatusType | null,
    metadata?: { word?: string; durationMs?: number }
  ) => void
  clearSessionStatus: (sessionId: string) => void
  clearWorktreeUnread: (worktreeId: string) => void
  getWorktreeStatus: (worktreeId: string) => SessionStatusType | null
  getWorktreeCompletedEntry: (worktreeId: string) => SessionStatusEntry | null
  setLastMessageTime: (worktreeId: string, timestamp: number) => void
  getLastMessageTime: (worktreeId: string) => number | null
}

export const useWorktreeStatusStore = create<WorktreeStatusState>((set, get) => ({
  sessionStatuses: {},
  lastMessageTimeByWorktree: {},

  setSessionStatus: (
    sessionId: string,
    status: SessionStatusType | null,
    metadata?: { word?: string; durationMs?: number }
  ) => {
    set((state) => ({
      sessionStatuses: {
        ...state.sessionStatuses,
        [sessionId]: status ? { status, timestamp: Date.now(), ...metadata } : null
      }
    }))
  },

  clearSessionStatus: (sessionId: string) => {
    set((state) => ({
      sessionStatuses: {
        ...state.sessionStatuses,
        [sessionId]: null
      }
    }))
  },

  clearWorktreeUnread: (worktreeId: string) => {
    const { sessionStatuses } = get()
    const sessionStore = useSessionStore.getState()
    const sessions = sessionStore.sessionsByWorktree.get(worktreeId) || []

    const updates: Record<string, null> = {}
    for (const s of sessions) {
      if (sessionStatuses[s.id]?.status === 'unread') {
        updates[s.id] = null
      }
    }

    if (Object.keys(updates).length > 0) {
      set((state) => ({
        sessionStatuses: { ...state.sessionStatuses, ...updates }
      }))
    }
  },

  getWorktreeStatus: (worktreeId: string): SessionStatusType | null => {
    const { sessionStatuses } = get()
    // Get all sessions for this worktree from the session store
    const sessionStore = useSessionStore.getState()
    const sessions = sessionStore.sessionsByWorktree.get(worktreeId) || []
    const sessionIds = sessions.map((s) => s.id)

    let hasPlanning = false
    let hasWorking = false
    let hasCompleted = false
    let latestUnread: SessionStatusEntry | null = null

    for (const id of sessionIds) {
      const entry = sessionStatuses[id]
      if (!entry) continue

      // answering has the highest priority — return immediately
      if (entry.status === 'answering') return 'answering'
      if (entry.status === 'planning') hasPlanning = true
      if (entry.status === 'working') hasWorking = true
      if (entry.status === 'completed') hasCompleted = true

      // Track the latest unread
      if (entry.status === 'unread') {
        if (!latestUnread || entry.timestamp > latestUnread.timestamp) {
          latestUnread = entry
        }
      }
    }

    if (hasPlanning) return 'planning'
    if (hasWorking) return 'working'
    if (hasCompleted) return 'completed'
    return latestUnread ? 'unread' : null
  },

  getWorktreeCompletedEntry: (worktreeId: string): SessionStatusEntry | null => {
    const { sessionStatuses } = get()
    const sessionStore = useSessionStore.getState()
    const sessions = sessionStore.sessionsByWorktree.get(worktreeId) || []

    for (const s of sessions) {
      const entry = sessionStatuses[s.id]
      if (entry?.status === 'completed') return entry
    }
    return null
  },

  setLastMessageTime: (worktreeId: string, timestamp: number) => {
    const prev = get().lastMessageTimeByWorktree[worktreeId] ?? 0
    const next = Math.max(prev, timestamp)
    if (next === prev && prev !== 0) return // no change

    set((state) => ({
      lastMessageTimeByWorktree: {
        ...state.lastMessageTimeByWorktree,
        [worktreeId]: next
      }
    }))

    // Persist to SQLite (fire-and-forget)
    window.db?.worktree?.update(worktreeId, { last_message_at: next }).catch(() => {})
  },

  getLastMessageTime: (worktreeId: string) => {
    return get().lastMessageTimeByWorktree[worktreeId] ?? null
  }
}))
