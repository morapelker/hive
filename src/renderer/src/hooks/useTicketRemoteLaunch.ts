import { useEffect } from 'react'
import { useRemoteLaunchStore } from '@/stores/useRemoteLaunchStore'
import type { RemoteLaunchClientInfo } from '@shared/types/remote-launch'
import type { KanbanTicket } from '../../../main/db/types'

/**
 * Resolves the client-role remote-launch info for a ticket's current session,
 * when the ticket's `current_session_id` points at a remote launch (i.e. the
 * ticket has no local worktree). Returns null for ordinary local tickets, or
 * while the store hasn't loaded the session's `remote_launch` column yet.
 *
 * Triggers `useRemoteLaunchStore.ensureLoaded` for the session — cached and
 * deduped in the store, so it's safe to call from every card/modal that
 * mounts this hook for the same ticket.
 */
export function useTicketRemoteLaunch(ticket: KanbanTicket): RemoteLaunchClientInfo | null {
  const sessionId = !ticket.worktree_id ? ticket.current_session_id : null

  const remoteInfo = useRemoteLaunchStore((state) =>
    sessionId ? (state.remoteBySessionId[sessionId] ?? null) : null
  )

  useEffect(() => {
    if (!sessionId) return
    void useRemoteLaunchStore.getState().ensureLoaded(sessionId)
  }, [sessionId])

  return remoteInfo
}
