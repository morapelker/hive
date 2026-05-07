import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

/**
 * Bump worktree.last_message_at to "now" when a prompt is being sent.
 *
 * Worktree-bound sessions update their own worktree. Connection-bound sessions
 * fan out to every member worktree. Board-assistant sessions pass neither value
 * and intentionally become a no-op.
 */
export function bumpWorktreeLastMessage(opts: {
  worktreeId?: string | null
  connectionId?: string | null
  timestamp?: number
}): void {
  const timestamp = opts.timestamp ?? Date.now()
  const setLastMessageTime = useWorktreeStatusStore.getState().setLastMessageTime

  if (opts.worktreeId) {
    setLastMessageTime(opts.worktreeId, timestamp)
    return
  }

  if (opts.connectionId) {
    const connection = useConnectionStore
      .getState()
      .connections.find((item) => item.id === opts.connectionId)
    if (!connection) return

    for (const member of connection.members) {
      setLastMessageTime(member.worktree_id, timestamp)
    }
  }
}
