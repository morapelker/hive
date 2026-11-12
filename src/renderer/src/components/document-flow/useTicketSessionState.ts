import { useCallback } from 'react'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type { SessionStatusType } from '@shared/types/session-status'

/** Statuses of a session that wait on the user: a question, a permission, a command approval. */
export const NEEDS_YOU_STATUSES = new Set<SessionStatusType>([
  'answering',
  'permission',
  'command_approval'
])
/** Statuses of a session at work. */
const WORKING_STATUSES = new Set<SessionStatusType>(['working', 'planning'])

export type TicketSessionState = 'needs_you' | 'working' | 'error' | null

/**
 * What a ticket's session is doing, from the stores every card reads: waiting on the user
 * (a pending question, or a status that needs an answer), at work, errored, or nothing of note.
 * Read by the rows a run's card draws for other tickets: the ones folded into it, and the
 * sessions started from its dashboard.
 */
export function useTicketSessionState(sessionId: string | null): TicketSessionState {
  const hasQuestion = useQuestionStore(
    useCallback(
      (state) => !!sessionId && (state.pendingBySession.get(sessionId)?.length ?? 0) > 0,
      [sessionId]
    )
  )
  const status = useWorktreeStatusStore(
    useCallback(
      (state) => (sessionId ? (state.sessionStatuses[sessionId]?.status ?? null) : null),
      [sessionId]
    )
  )
  const errored = useSessionStore(
    useCallback(
      (state) => {
        if (!sessionId) return false
        for (const sessions of state.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === sessionId)
          if (found) return found.status === 'error'
        }
        for (const sessions of state.sessionsByConnection.values()) {
          const found = sessions.find((s) => s.id === sessionId)
          if (found) return found.status === 'error'
        }
        return false
      },
      [sessionId]
    )
  )
  // A Claude CLI API failure (rate limit, server error) is not a session status: it ends the
  // turn as `completed` and is kept apart, as on a card, whose red perimeter reads it too.
  const hasApiError = useWorktreeStatusStore(
    useCallback(
      (state) => !!sessionId && state.sessionApiErrors[sessionId] !== undefined,
      [sessionId]
    )
  )
  if (hasQuestion || (status && NEEDS_YOU_STATUSES.has(status))) return 'needs_you'
  if (errored || hasApiError) return 'error'
  if (status && WORKING_STATUSES.has(status)) return 'working'
  return null
}
