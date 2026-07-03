import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

/**
 * Bump worktree.last_message_at to "now" when a prompt is being sent.
 *
 * Worktree-bound sessions update their own worktree. Connection-bound sessions
 * fan out to every member worktree. Board-assistant sessions pass neither value
 * and intentionally become a no-op.
 *
 * Every bump also touches the project's default (main, no-worktree) row so the
 * project keeps its recency for sorting even after the worktree is archived.
 */
export function bumpWorktreeLastMessage(opts: {
  worktreeId?: string | null
  connectionId?: string | null
  timestamp?: number
}): void {
  const timestamp = opts.timestamp ?? Date.now()
  const setLastMessageTime = useWorktreeStatusStore.getState().setLastMessageTime

  const bumpProjectDefault = (projectId: string, alreadyBumpedId: string): void => {
    const defaultWorktree = useWorktreeStore.getState().getDefaultWorktree(projectId)
    if (defaultWorktree && defaultWorktree.id !== alreadyBumpedId) {
      setLastMessageTime(defaultWorktree.id, timestamp)
    }
  }

  if (opts.worktreeId) {
    setLastMessageTime(opts.worktreeId, timestamp)

    const { worktreesByProject } = useWorktreeStore.getState()
    for (const [projectId, worktrees] of worktreesByProject) {
      if (worktrees.some((w) => w.id === opts.worktreeId)) {
        bumpProjectDefault(projectId, opts.worktreeId)
        break
      }
    }
    return
  }

  if (opts.connectionId) {
    const connection = useConnectionStore
      .getState()
      .connections.find((item) => item.id === opts.connectionId)
    if (!connection) return

    for (const member of connection.members) {
      setLastMessageTime(member.worktree_id, timestamp)
      bumpProjectDefault(member.project_id, member.worktree_id)
    }
  }
}
