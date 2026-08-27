import type { KanbanTicket } from '../../../main/db/types'
import type { SidebarHoverTarget } from '@/stores/useKanbanStore'

/** Worktree a queued ticket will launch on (`pending_launch_config.worktree`), if any. */
export function getQueuedWorktreeId(ticket: Pick<KanbanTicket, 'pending_launch_config'>): string | null {
  if (!ticket.pending_launch_config) return null
  try {
    const config = JSON.parse(ticket.pending_launch_config) as {
      worktree?: { type: 'new'; sourceBranch: string } | { type: 'existing'; worktreeId: string }
    }
    return config.worktree?.type === 'existing' ? config.worktree.worktreeId : null
  } catch {
    return null
  }
}

/**
 * Project / worktree matching for the sidebar hover highlight. Connection
 * targets are resolved separately by the caller because they need session and
 * connection-member data from other stores.
 */
export function isTicketLinkedToSidebarTarget(
  ticket: Pick<KanbanTicket, 'project_id' | 'worktree_id' | 'pending_launch_config'>,
  target: SidebarHoverTarget | null
): boolean {
  if (!target) return false
  switch (target.kind) {
    case 'project':
      return ticket.project_id === target.id
    case 'worktree':
      // Worktree hover is worktree-agnostic: highlight every ticket of the
      // owning project. Fall back to exact worktree matching only when the
      // project could not be resolved.
      if (target.projectId) return ticket.project_id === target.projectId
      return ticket.worktree_id === target.id || getQueuedWorktreeId(ticket) === target.id
    default:
      return false
  }
}
