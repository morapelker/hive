import type { SessionStatusType } from '@shared/types/session-status'
import type { SessionStatusEntry } from '@/stores/useWorktreeStatusStore'
import type { KanbanTicket } from '../../../main/db/types'

/**
 * The app-wide definition of a session that is "in progress" — what the pet's
 * working animation, the session counter next to the Projects loader, the
 * keep-awake mug, and the powerSaveBlocker all agree on.
 *
 * A session is in progress when any of these hold:
 *
 * 1. It is streaming right now ('working' / 'planning').
 * 2. Its last Claude CLI Stop was only a pause: a Monitor watch, a background
 *    subagent/workflow, or a scheduled wakeup is pending and will wake the
 *    agent again (`completion === 'waiting'`). Nothing streams while it waits,
 *    but the run is not over.
 * 3. It is the current session of a ticket sitting in the board's in-progress
 *    column. The board is the user-facing truth for what is in progress; a
 *    ticket parked there with the "still waiting" hourglass (or blocked on a
 *    question/permission) is in progress even though its status is not
 *    'working'. Only sessions the app knows about this run count (the status
 *    store holds an entry for them) — a ticket whose session died with a
 *    previous app run is not a live session.
 */

type InProgressTicketRef = Pick<
  KanbanTicket,
  'column' | 'current_session_id' | 'worktree_id' | 'archived_at'
>

export function isStreamingStatus(status: SessionStatusType | null | undefined): boolean {
  return status === 'working' || status === 'planning'
}

/** The turn ended, but something pending (monitor, subagent, wakeup) will resume it. */
export function isPausedSessionEntry(entry: SessionStatusEntry | null | undefined): boolean {
  return entry?.status === 'completed' && entry.completion === 'waiting'
}

/**
 * sessionId → worktreeId for every live (non-archived) ticket in the
 * in-progress column that is linked to a session.
 */
export function collectInProgressTicketSessions(
  ticketsByProject: Iterable<readonly InProgressTicketRef[]>
): Map<string, string | null> {
  const sessions = new Map<string, string | null>()
  for (const tickets of ticketsByProject) {
    for (const ticket of tickets) {
      if (ticket.column !== 'in_progress' || ticket.archived_at) continue
      if (!ticket.current_session_id) continue
      if (!sessions.has(ticket.current_session_id) || ticket.worktree_id) {
        sessions.set(ticket.current_session_id, ticket.worktree_id)
      }
    }
  }
  return sessions
}

/** Whether a single known session (it has a status entry) is in progress. */
export function isSessionEntryInProgress(
  sessionId: string,
  entry: SessionStatusEntry | null | undefined,
  inProgressTicketSessions?: ReadonlyMap<string, string | null> | ReadonlySet<string>
): boolean {
  if (!entry) return false
  return (
    isStreamingStatus(entry.status) ||
    isPausedSessionEntry(entry) ||
    inProgressTicketSessions?.has(sessionId) === true
  )
}

/** Ids of every in-progress session (see the module doc for the definition). */
export function collectInProgressSessionIds(
  sessionStatuses: Record<string, SessionStatusEntry | null>,
  inProgressTicketSessions?: ReadonlyMap<string, string | null> | ReadonlySet<string>
): Set<string> {
  const ids = new Set<string>()
  for (const [sessionId, entry] of Object.entries(sessionStatuses)) {
    if (isSessionEntryInProgress(sessionId, entry, inProgressTicketSessions)) ids.add(sessionId)
  }
  return ids
}

/** Number of in-progress sessions across the whole app. */
export function countInProgressSessions(
  sessionStatuses: Record<string, SessionStatusEntry | null>,
  ticketsByProject: Iterable<readonly InProgressTicketRef[]>
): number {
  return collectInProgressSessionIds(
    sessionStatuses,
    collectInProgressTicketSessions(ticketsByProject)
  ).size
}
