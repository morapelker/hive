import type { PetState, PetStatusPayload } from '@shared/types/pet'
import type { SessionStatusEntry, SessionStatusType } from '@/stores/useWorktreeStatusStore'

const STATUS_PRIORITY: Record<SessionStatusType, number> = {
  answering: 8,
  command_approval: 7,
  permission: 6,
  planning: 5,
  working: 4,
  plan_ready: 3,
  completed: 2,
  unread: 1
}

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
}

interface Candidate {
  status: SessionStatusType
  sourceWorktreeId: string | null
  priority: number
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

  for (const [worktreeId, sessions] of input.worktreeSessions.entries()) {
    const status = bestStatusForSessions(sessions, input.sessionStatuses)
    if (!status) continue
    best = chooseBetter(best, {
      status,
      sourceWorktreeId: worktreeId,
      priority: STATUS_PRIORITY[status]
    })
  }

  for (const connection of input.connections) {
    const sessions = input.connectionSessions.get(connection.id) ?? []
    const status = bestStatusForSessions(sessions, input.sessionStatuses)
    if (!status) continue
    best = chooseBetter(best, {
      status,
      sourceWorktreeId: connection.members[0]?.worktree_id ?? null,
      priority: STATUS_PRIORITY[status]
    })
  }

  if (!best) return { state: 'idle', sourceWorktreeId: null }

  const state = PET_STATE_BY_STATUS[best.status]
  return {
    state,
    sourceWorktreeId: state === 'idle' ? null : best.sourceWorktreeId
  }
}
