import { create } from 'zustand'
import { useSessionStore } from './useSessionStore'
import { useConnectionStore } from './useConnectionStore'
import { lastSendMode, userExplicitSendTimes } from '@/lib/message-send-times'
import { notifyKanbanSessionSync } from './store-coordination'
import { dbApi } from '@/api/db-api'
import { higherPriority, type SessionStatusType } from '@shared/types/session-status'

// Re-exported from the shared definition so existing importers keep working.
export type { SessionStatusType }

// Last userExplicitSendTimes value already attributed to a session_working
// notification, per session. Each send stamp may mark at most one working
// transition as explicit (the elapsed timer still owns the stamp itself, so
// it is never deleted) — later streaming re-emits and status replays within
// the freshness window must not reopen a done/merged ticket.
const consumedExplicitSendTimes = new Map<string, number>()

// One-shot explicit markers for working transitions whose send bookkeeping
// cannot use userExplicitSendTimes: a queued user follow-up drains long after
// the user typed it, and stamping the shared map at dispatch would restart
// the elapsed timer that map exists to drive. The next working/planning
// status emitted for the session consumes the marker.
const pendingExplicitWorking = new Set<string>()

/**
 * Mark the next working/planning status for this session as caused by an
 * explicit user send. Call right before setSessionStatus when dispatching a
 * user-authored message that has no fresh userExplicitSendTimes stamp (e.g.
 * draining the follow-up queue).
 */
export function markNextWorkingStatusExplicit(sessionId: string): void {
  pendingExplicitWorking.add(sessionId)
}

export interface SessionStatusEntry {
  status: SessionStatusType
  timestamp: number
  word?: string
  durationMs?: number
  tokenDelta?: number
  reason?: string
  hookEventName?: string
  hookPath?: string
  toolName?: string
  plan?: string
}

export type MergeConflictFlow =
  | { phase: 'starting' }
  | { phase: 'running'; sessionId: string; seenBusy: boolean }
  | { phase: 'refreshing' }

export interface SessionBackgroundWork {
  runningShells: number
  runningMonitors: number
  runningSubagents: number
}

interface WorktreeStatusState {
  // sessionId → status info (null means no status / cleared)
  sessionStatuses: Record<string, SessionStatusEntry | null>
  // sessionId → live background subagent/shell/monitor counts, reported by both
  // the claude-cli hook path and the Claude SDK path (entries are dropped when
  // all counts reach zero)
  backgroundWorkBySession: Record<string, SessionBackgroundWork>
  // worktreeId → epoch ms of last message activity
  lastMessageTimeByWorktree: Record<string, number>
  // worktreeId → sessionId for active review sessions
  reviewSessionByWorktree: Record<string, string>
  // worktreeId → sessionId for completed review sessions (in-memory only)
  completedReviewSessionByWorktree: Record<string, string>
  // worktreeId → sessionId for active conflict-fix sessions
  mergeConflictSessionByWorktree: Record<string, string>
  // worktreeId → current conflict-fix flow phase
  mergeConflictFlowByWorktree: Record<string, MergeConflictFlow>
  // ticketId → worktreeId whose conflicts should be surfaced on that ticket
  mergeConflictWorktreeByTicket: Record<string, string>

  // Actions
  setSessionStatus: (
    sessionId: string,
    status: SessionStatusType | null,
    metadata?: {
      word?: string
      durationMs?: number
      tokenDelta?: number
      reason?: string
      hookEventName?: string
      hookPath?: string
      toolName?: string
      plan?: string
      taskNotification?: boolean
    }
  ) => void
  setSessionBackgroundWork: (sessionId: string, work: SessionBackgroundWork) => void
  clearSessionStatus: (sessionId: string) => void
  clearWorktreeUnread: (worktreeId: string) => void
  getWorktreeStatus: (worktreeId: string) => SessionStatusType | null
  getConnectionStatus: (connectionId: string) => SessionStatusType | null
  getWorktreeCompletedEntry: (worktreeId: string) => SessionStatusEntry | null
  setLastMessageTime: (worktreeId: string, timestamp: number) => void
  getLastMessageTime: (worktreeId: string) => number | null
  setReviewSession: (worktreeId: string, sessionId: string) => void
  clearReviewSession: (worktreeId: string) => void
  clearCompletedReviewSession: (worktreeId: string) => void
  setMergeConflictSession: (worktreeId: string, sessionId: string) => void
  clearMergeConflictSession: (worktreeId: string) => void
  setMergeConflictFlow: (worktreeId: string, flow: MergeConflictFlow | null) => void
  setMergeConflictWorktreeForTicket: (ticketId: string, worktreeId: string | null) => void
  isWorktreeBeingReviewed: (worktreeId: string) => boolean
}

export const useWorktreeStatusStore = create<WorktreeStatusState>((set, get) => ({
  sessionStatuses: {},
  backgroundWorkBySession: {},
  lastMessageTimeByWorktree: {},
  reviewSessionByWorktree: {},
  completedReviewSessionByWorktree: {},
  mergeConflictSessionByWorktree: {},
  mergeConflictFlowByWorktree: {},
  mergeConflictWorktreeByTicket: {},

  setSessionStatus: (
    sessionId: string,
    status: SessionStatusType | null,
    metadata?: {
      word?: string
      durationMs?: number
      tokenDelta?: number
      reason?: string
      hookEventName?: string
      hookPath?: string
      toolName?: string
      plan?: string
      taskNotification?: boolean
    }
  ) => {
    set((state) => {
      const next: Partial<WorktreeStatusState> = {
        sessionStatuses: {
          ...state.sessionStatuses,
          [sessionId]: status ? { status, timestamp: Date.now(), ...metadata } : null
        }
      }

      // Auto-clear review session when its session completes or is cleared
      if (status === 'completed' || status === null) {
        for (const [wtId, sId] of Object.entries(state.reviewSessionByWorktree)) {
          if (sId === sessionId) {
            const { [wtId]: _, ...rest } = state.reviewSessionByWorktree
            next.reviewSessionByWorktree = rest
            // When a review completes, save its session ID so the card can show "Go to review"
            if (status === 'completed') {
              next.completedReviewSessionByWorktree = {
                ...state.completedReviewSessionByWorktree,
                [wtId]: sessionId
              }
            }
            break
          }
        }
      }

      return next
    })

    // ── Kanban coordination: notify kanban store of relevant status changes ──
    if (status === 'completed') {
      const mode = lastSendMode.get(sessionId) as 'build' | 'plan' | undefined
      notifyKanbanSessionSync(sessionId, {
        type: 'session_completed',
        sessionMode: mode,
        tokenDelta: metadata?.tokenDelta
      })
    } else if (status === 'plan_ready') {
      notifyKanbanSessionSync(sessionId, { type: 'plan_ready' })
    } else if (status === 'working' || status === 'planning') {
      // A working status counts as an explicit user follow-up when it either
      // immediately follows a user-initiated send (every send path writes
      // userExplicitSendTimes right before flipping the status) or carries a
      // UserPromptSubmit hook event (prompts typed straight into a CLI
      // terminal). Background task-notification auto-resumes are never
      // explicit, and each send stamp is consumed by the first working
      // transition it explains, so streaming re-emits and status replays can
      // never pull a ticket out of done/merged.
      let explicitSend = false
      if (metadata?.taskNotification !== true) {
        const oneShotMarker = pendingExplicitWorking.delete(sessionId)
        const explicitSendAt = userExplicitSendTimes.get(sessionId)
        const hasUnconsumedSend =
          explicitSendAt !== undefined &&
          Date.now() - explicitSendAt < 15_000 &&
          consumedExplicitSendTimes.get(sessionId) !== explicitSendAt
        if (hasUnconsumedSend) {
          consumedExplicitSendTimes.set(sessionId, explicitSendAt)
        }
        // reason === 'claude_cli_plan_followup': plan feedback typed into the
        // CLI terminal, detected by the transcript watcher when the
        // UserPromptSubmit hook is delayed or unavailable — a genuine user
        // send with neither stamp nor hook event.
        explicitSend =
          oneShotMarker ||
          hasUnconsumedSend ||
          metadata?.hookEventName === 'UserPromptSubmit' ||
          metadata?.reason === 'claude_cli_plan_followup'
      }
      notifyKanbanSessionSync(sessionId, { type: 'session_working', explicitSend })
    } else if (status === null) {
      // A cleared status means the run is gone (canceled dispatch, teardown,
      // interrupt) — pending unloaded-project reopen recoveries die with it.
      notifyKanbanSessionSync(sessionId, { type: 'status_cleared' })
    }
  },

  setSessionBackgroundWork: (sessionId: string, work: SessionBackgroundWork) => {
    set((state) => {
      if (work.runningShells === 0 && work.runningMonitors === 0 && work.runningSubagents === 0) {
        if (!(sessionId in state.backgroundWorkBySession)) return {}
        const { [sessionId]: _, ...rest } = state.backgroundWorkBySession
        return { backgroundWorkBySession: rest }
      }
      return {
        backgroundWorkBySession: {
          ...state.backgroundWorkBySession,
          [sessionId]: work
        }
      }
    })
  },

  clearSessionStatus: (sessionId: string) => {
    set((state) => ({
      sessionStatuses: {
        ...state.sessionStatuses,
        [sessionId]: null
      }
    }))
    // Mirror setSessionStatus(sessionId, null): the run is gone, so pending
    // unloaded-project reopen recoveries must not outlive it.
    notifyKanbanSessionSync(sessionId, { type: 'status_cleared' })
  },

  clearWorktreeUnread: (worktreeId: string) => {
    const { sessionStatuses } = get()
    const sessionStore = useSessionStore.getState()
    const sessions = sessionStore.sessionsByWorktree.get(worktreeId) || []

    const updates: Record<string, null> = {}
    for (const s of sessions) {
      const st = sessionStatuses[s.id]?.status
      if (st === 'unread' || st === 'completed') {
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

    // ── Connection status (takes priority over worktree's own sessions) ──
    const connections = useConnectionStore.getState().connections
    const parentConnectionIds = connections
      .filter((c) => c.members.some((m) => m.worktree_id === worktreeId))
      .map((c) => c.id)

    if (parentConnectionIds.length > 0) {
      let bestConnectionStatus: SessionStatusType | null = null
      for (const connId of parentConnectionIds) {
        const connStatus = get().getConnectionStatus(connId)
        if (connStatus) {
          bestConnectionStatus = higherPriority(bestConnectionStatus, connStatus)
        }
      }
      if (bestConnectionStatus !== null) return bestConnectionStatus
    }

    // ── Worktree's own session status (fallback) ──
    const sessionStore = useSessionStore.getState()
    const sessions = sessionStore.sessionsByWorktree.get(worktreeId) || []
    const sessionIds = sessions.map((s) => s.id)

    let hasPlanning = false
    let hasWorking = false
    let hasPlanReady = false
    let hasCompleted = false
    let latestUnread: SessionStatusEntry | null = null

    for (const id of sessionIds) {
      const entry = sessionStatuses[id]
      if (!entry) continue

      // answering/command_approval/permission have the highest priority — return immediately
      if (
        entry.status === 'answering' ||
        entry.status === 'command_approval' ||
        entry.status === 'permission'
      )
        return entry.status
      if (entry.status === 'planning') hasPlanning = true
      if (entry.status === 'working') hasWorking = true
      if (entry.status === 'plan_ready') hasPlanReady = true
      if (entry.status === 'completed') hasCompleted = true

      // Track the latest unread
      if (entry.status === 'unread') {
        if (!latestUnread || entry.timestamp > latestUnread.timestamp) {
          latestUnread = entry
        }
      }
    }

    // Priority: answering > planning > working > plan_ready > completed > unread > null
    if (hasPlanning) return 'planning'
    if (hasWorking) return 'working'
    if (hasPlanReady) return 'plan_ready'

    // Derive plan_ready from the mode the user last sent a message in.
    // If the last message was sent in plan mode and the session completed,
    // show "Plan ready". Otherwise show normal "Ready".
    if (hasCompleted) {
      const completedInPlan = sessions.some(
        (s) => sessionStatuses[s.id]?.status === 'completed' && lastSendMode.get(s.id) === 'plan'
      )
      return completedInPlan ? 'plan_ready' : 'completed'
    }

    return latestUnread ? 'unread' : null
  },

  getConnectionStatus: (connectionId: string): SessionStatusType | null => {
    const { sessionStatuses } = get()
    const sessionStore = useSessionStore.getState()
    const sessions = sessionStore.sessionsByConnection.get(connectionId) || []
    const sessionIds = sessions.map((s) => s.id)

    let hasPlanning = false
    let hasWorking = false
    let hasPlanReady = false
    let hasCompleted = false
    let latestUnread: SessionStatusEntry | null = null

    for (const id of sessionIds) {
      const entry = sessionStatuses[id]
      if (!entry) continue

      if (
        entry.status === 'answering' ||
        entry.status === 'command_approval' ||
        entry.status === 'permission'
      )
        return entry.status
      if (entry.status === 'planning') hasPlanning = true
      if (entry.status === 'working') hasWorking = true
      if (entry.status === 'plan_ready') hasPlanReady = true
      if (entry.status === 'completed') hasCompleted = true

      if (entry.status === 'unread') {
        if (!latestUnread || entry.timestamp > latestUnread.timestamp) {
          latestUnread = entry
        }
      }
    }

    if (hasPlanning) return 'planning'
    if (hasWorking) return 'working'
    if (hasPlanReady) return 'plan_ready'

    if (hasCompleted) {
      const completedInPlan = sessions.some(
        (s) => sessionStatuses[s.id]?.status === 'completed' && lastSendMode.get(s.id) === 'plan'
      )
      return completedInPlan ? 'plan_ready' : 'completed'
    }

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
    dbApi.worktree.update(worktreeId, { last_message_at: next }).catch(() => {})
  },

  getLastMessageTime: (worktreeId: string) => {
    return get().lastMessageTimeByWorktree[worktreeId] ?? null
  },

  setReviewSession: (worktreeId: string, sessionId: string) => {
    set((state) => {
      // Clear any completed review for this worktree when a new review starts
      const { [worktreeId]: _, ...restCompleted } = state.completedReviewSessionByWorktree
      return {
        reviewSessionByWorktree: {
          ...state.reviewSessionByWorktree,
          [worktreeId]: sessionId
        },
        completedReviewSessionByWorktree: restCompleted
      }
    })
  },

  clearReviewSession: (worktreeId: string) => {
    set((state) => {
      const { [worktreeId]: _, ...rest } = state.reviewSessionByWorktree
      return { reviewSessionByWorktree: rest }
    })
  },

  clearCompletedReviewSession: (worktreeId: string) => {
    set((state) => {
      const { [worktreeId]: _, ...rest } = state.completedReviewSessionByWorktree
      return { completedReviewSessionByWorktree: rest }
    })
  },

  setMergeConflictSession: (worktreeId: string, sessionId: string) => {
    set((state) => ({
      mergeConflictSessionByWorktree: {
        ...state.mergeConflictSessionByWorktree,
        [worktreeId]: sessionId
      }
    }))
  },

  clearMergeConflictSession: (worktreeId: string) => {
    set((state) => {
      const { [worktreeId]: _, ...rest } = state.mergeConflictSessionByWorktree
      return { mergeConflictSessionByWorktree: rest }
    })
  },

  setMergeConflictFlow: (worktreeId: string, flow: MergeConflictFlow | null) => {
    set((state) => {
      if (!flow) {
        const { [worktreeId]: _, ...rest } = state.mergeConflictFlowByWorktree
        return { mergeConflictFlowByWorktree: rest }
      }
      return {
        mergeConflictFlowByWorktree: {
          ...state.mergeConflictFlowByWorktree,
          [worktreeId]: flow
        }
      }
    })
  },

  setMergeConflictWorktreeForTicket: (ticketId: string, worktreeId: string | null) => {
    set((state) => {
      if (!worktreeId) {
        const { [ticketId]: _, ...rest } = state.mergeConflictWorktreeByTicket
        return { mergeConflictWorktreeByTicket: rest }
      }
      return {
        mergeConflictWorktreeByTicket: {
          ...state.mergeConflictWorktreeByTicket,
          [ticketId]: worktreeId
        }
      }
    })
  },

  isWorktreeBeingReviewed: (worktreeId: string): boolean => {
    return worktreeId in get().reviewSessionByWorktree
  }
}))

/**
 * Total live background work (subagents, shells, monitors). Activity indicators
 * that must outlive a turn's result read this, since background work keeps
 * going after it.
 */
export function countBackgroundWork(work: SessionBackgroundWork | undefined): number {
  if (!work) return 0
  return work.runningSubagents + work.runningShells + work.runningMonitors
}

declare global {
  interface Window {
    __hive_useWorktreeStatusStore__?: typeof useWorktreeStatusStore
  }
}

const importMeta = import.meta as ImportMeta & { env?: { DEV?: boolean } }

if (importMeta.env?.DEV && typeof window !== 'undefined') {
  window.__hive_useWorktreeStatusStore__ = useWorktreeStatusStore
}
