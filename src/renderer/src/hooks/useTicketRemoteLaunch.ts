import { useEffect } from 'react'
import { useRemoteLaunchStore } from '@/stores/useRemoteLaunchStore'
import type { RemoteLaunchClientInfo } from '@shared/types/remote-launch'
import type { KanbanTicket } from '../../../main/db/types'

/**
 * Resolves the client-role remote-launch info for a ticket's current session,
 * when the ticket's `current_session_id` points at a remote launch (i.e. the
 * ticket has no local worktree).
 *
 * Three states:
 * - `undefined` — the session's `remote_launch` column hasn't been fetched
 *   yet. Consumers that would mount local-session UI (e.g. the claude-cli
 *   terminal portal) must NOT treat this like "not remote": remote client
 *   sessions have no local worktree, so that UI can never work for them.
 * - `null` — checked: not a remote launch (ordinary local ticket).
 * - info — a remote (client-role) launch; `stoppedAt` set once stopped.
 *
 * Triggers `useRemoteLaunchStore.ensureLoaded` for the session — cached and
 * deduped in the store, so it's safe to call from every card/modal that
 * mounts this hook for the same ticket.
 */
export function useTicketRemoteLaunch(
  ticket: KanbanTicket
): RemoteLaunchClientInfo | null | undefined {
  const sessionId = !ticket.worktree_id ? ticket.current_session_id : null

  const remoteInfo = useRemoteLaunchStore((state) =>
    sessionId ? state.remoteBySessionId[sessionId] : null
  )

  useEffect(() => {
    if (!sessionId) return
    void useRemoteLaunchStore.getState().ensureLoaded(sessionId)
  }, [sessionId])

  return remoteInfo
}
