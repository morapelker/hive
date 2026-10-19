import type { PetState, PetStatusPayload } from '@shared/types/pet'
import type { SessionStatusEntry, SessionStatusType } from '@/stores/useWorktreeStatusStore'
import { STATUS_PRIORITY } from '@shared/types/session-status'
import { collectInProgressSessionIds } from '@/lib/in-progress-sessions'

const PET_STATE_BY_STATUS: Record<SessionStatusType, PetState> = {
  answering: 'question',
  command_approval: 'permission',
  permission: 'permission',
  planning: 'working',
  working: 'working',
  plan_ready: 'plan_ready',
  completed: 'idle',
  unread: 'idle'
}

type SessionRef = { id: string }
type ConnectionRef = { id: string; members: Array<{ worktree_id: string }> }

export interface PetAggregateInput {
  sessionStatuses: Record<string, SessionStatusEntry | null>
  worktreeSessions: Map<string, SessionRef[]>
  connectionSessions: Map<string, SessionRef[]>
  connections: ConnectionRef[]
  /**
   * sessionId → worktreeId of every ticket in the board's in-progress column
   * (see lib/in-progress-sessions). Those sessions are in progress whatever
   * their status says: a paused one animates the pet as working.
   */
  inProgressTicketSessions?: ReadonlyMap<string, string | null>
}

interface Candidate {
  status: SessionStatusType
  sourceWorktreeId: string | null
  priority: number
}

/**
 * Statuses as the pet should see them: an in-progress session whose own
 * status would read as idle (paused behind a monitor/wakeup, or parked in the
 * in-progress column after a stop) is shown working. Attention states
 * (question, permission, plan ready) are kept — they outrank working anyway.
 */
function effectiveStatuses(
  sessionStatuses: Record<string, SessionStatusEntry | null>,
  inProgressIds: ReadonlySet<string>
): Record<string, SessionStatusEntry | null> {
  if (inProgressIds.size === 0) return sessionStatuses
  const effective: Record<string, SessionStatusEntry | null> = { ...sessionStatuses }
  for (const sessionId of inProgressIds) {
    const entry = sessionStatuses[sessionId]
    if (!entry || PET_STATE_BY_STATUS[entry.status] !== 'idle') continue
    effective[sessionId] = { ...entry, status: 'working' }
  }
  return effective
}

function bestStatusForSessions(
  sessions: SessionRef[],
  sessionStatuses: Record<string, SessionStatusEntry | null>
): SessionStatusType | null {
  let best: SessionStatusType | null = null

  for (const session of sessions) {
    const status = sessionStatuses[session.id]?.status
    if (!status) continue
    if (!best || STATUS_PRIORITY[status] > STATUS_PRIORITY[best]) {
      best = status
    }
  }

  return best
}

function chooseBetter(current: Candidate | null, next: Candidate): Candidate {
  if (!current) return next
  return next.priority > current.priority ? next : current
}

export function aggregatePetStatus(input: PetAggregateInput): PetStatusPayload {
  let best: Candidate | null = null
  const inProgressIds = collectInProgressSessionIds(
    input.sessionStatuses,
    input.inProgressTicketSessions
  )
  const workingSessionCount = inProgressIds.size
  const statuses = effectiveStatuses(input.sessionStatuses, inProgressIds)
  // Sessions the loaded worktrees/connections account for; an in-progress
  // session outside them (its worktree's sessions never loaded) still gets a
  // candidate below, located by its ticket's worktree.
  const placedSessionIds = new Set<string>()

  for (const [worktreeId, sessions] of input.worktreeSessions.entries()) {
    for (const session of sessions) placedSessionIds.add(session.id)
    const status = bestStatusForSessions(sessions, statuses)
    if (!status) continue
    best = chooseBetter(best, {
      status,
      sourceWorktreeId: worktreeId,
      priority: STATUS_PRIORITY[status]
    })
  }

  for (const connection of input.connections) {
    const sessions = input.connectionSessions.get(connection.id) ?? []
    for (const session of sessions) placedSessionIds.add(session.id)
    const status = bestStatusForSessions(sessions, statuses)
    if (!status) continue
    best = chooseBetter(best, {
      status,
      sourceWorktreeId: connection.members[0]?.worktree_id ?? null,
      priority: STATUS_PRIORITY[status]
    })
  }

  for (const sessionId of inProgressIds) {
    if (placedSessionIds.has(sessionId)) continue
    const status = statuses[sessionId]?.status
    if (!status) continue
    best = chooseBetter(best, {
      status,
      sourceWorktreeId: input.inProgressTicketSessions?.get(sessionId) ?? null,
      priority: STATUS_PRIORITY[status]
    })
  }

  if (!best) return { state: 'idle', sourceWorktreeId: null, workingSessionCount }

  const state = PET_STATE_BY_STATUS[best.status]
  return {
    state,
    sourceWorktreeId: state === 'idle' ? null : best.sourceWorktreeId,
    workingSessionCount
  }
}
