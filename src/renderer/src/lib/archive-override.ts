// Shift-dragging a ticket from Merged to Done is the override: throw the ticket out with
// whatever its branches still hold. No pull, no commit step, no merge step — the
// merge-on-done dialog opens straight on archive/keep for every worktree the ticket has
// (one for a worktree ticket, "Archive all" for a connection ticket's members).
import { connectionApi } from '@/api/connection-api'
import { dbApi } from '@/api/db-api'
import { resolveTicketConnectionId } from '@/lib/connection-merge'
import { useKanbanStore, type PendingDoneMoveWorktree } from '@/stores/useKanbanStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket, Worktree } from '../../../main/db/types'

/**
 * A worktree the override may offer to archive: still there, not on its way out already,
 * and never a project's default worktree (archive deletes the branch).
 */
async function archivableWorktree(worktreeId: string): Promise<Worktree | null> {
  if (useWorktreeStore.getState().archivingWorktreeIds.has(worktreeId)) return null
  const worktree = await dbApi.worktree.get<Worktree>(worktreeId)
  if (!worktree || worktree.status !== 'active' || worktree.is_default) return null
  return worktree
}

/**
 * Every worktree of the ticket that can be archived, unchecked: its own, or — for a
 * connection ticket, which has a session but no worktree — each member of the connection.
 */
async function archiveOverrideTargets(ticket: KanbanTicket): Promise<PendingDoneMoveWorktree[]> {
  if (ticket.worktree_id) {
    const worktree = await archivableWorktree(ticket.worktree_id)
    return worktree ? [{ worktreeId: worktree.id, projectId: worktree.project_id }] : []
  }
  const connectionId = await resolveTicketConnectionId(ticket.current_session_id)
  if (!connectionId) return []
  const result = await connectionApi.get(connectionId)
  if (!result.success || !result.connection) {
    if (result.error === 'Connection not found') return []
    throw new Error(result.error ?? 'Could not retrieve connection members')
  }
  if (result.connection.status === 'archived') return []
  const memberWorktreeIds = [...new Set(result.connection.members.map((m) => m.worktree_id))]
  const worktrees = await Promise.all(memberWorktreeIds.map(archivableWorktree))
  return worktrees.flatMap((w) => (w ? [{ worktreeId: w.id, projectId: w.project_id }] : []))
}

/**
 * Open the archive/keep step for the ticket's worktrees, skipping the commit and merge
 * checks. Returns true when the dialog has the move (it lands the ticket in Done once the
 * last worktree was archived or kept); false when the ticket has nothing left to archive
 * and the caller moves it. Rejects when the ticket's worktrees cannot be looked up.
 */
export async function queueArchiveOverride(args: {
  ticket: KanbanTicket
  sortOrder: number
}): Promise<boolean> {
  const { ticket, sortOrder } = args
  const [first, ...rest] = await archiveOverrideTargets(ticket)
  if (!first) return false
  useKanbanStore.getState().setPendingDoneMove({
    ticketId: ticket.id,
    projectId: ticket.project_id,
    sortOrder,
    targetColumn: 'done',
    skipMergeChecks: true,
    // A connection ticket names each member: the dialog takes them one by one, and offers
    // "Archive all" for the rest. A worktree ticket is resolved from its own worktree_id.
    ...(ticket.worktree_id
      ? {}
      : {
          worktreeId: first.worktreeId,
          worktreeProjectId: first.projectId,
          remainingWorktrees: rest,
          offerArchive: true
        })
  })
  return true
}
