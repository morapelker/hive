/**
 * Auto-unpin: the counterpart of auto-pin (lib/auto-pin). A project is put on the Pinned Board
 * while it is being worked on; once its last ticket outside the Done column is moved to Done
 * and archived, nothing of it is in progress any more, so the Archive step of that move
 * (MergeOnDoneDialog) offers "Archive & Unpin" next to the plain archive.
 *
 * The offer is made only when unpinning is a real choice:
 * - the project is on the Pinned Board, and stays on it once the worktrees are archived (a pin
 *   that sits on a worktree being archived goes away with it, asked or not);
 * - no other ticket of the project is in To do, In progress, Review or Merged.
 */
import { useMemo } from 'react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { isProjectPinned, setProjectPinned, type PinnableProject } from '@/lib/project-pin'

interface TicketLike {
  id: string
  column: string
  archived_at: string | null
}

/**
 * Whether any ticket is still outside the Done column (to do, in progress, review or merged).
 * `landing` are tickets on their way to Done: they do not count.
 */
export function hasOpenTickets(
  tickets: readonly TicketLike[] | undefined,
  landing?: ReadonlySet<string>
): boolean {
  return (tickets ?? []).some(
    (ticket) => !ticket.archived_at && ticket.column !== 'done' && !landing?.has(ticket.id)
  )
}

/** What an archive action of a move to Done is about to do. */
export interface UnpinOfferScope {
  /** The project of the ticket being moved. */
  projectId: string
  /** Every ticket the action lands in Done. */
  landingTicketIds: ReadonlySet<string>
  /** Every worktree the action archives. */
  archivedWorktreeIds: ReadonlySet<string>
}

/**
 * The project to offer "Archive & Unpin" for, or null when the archive step stays as it is.
 * Follows the board, the pins and the worktrees while the step is open.
 */
export function useUnpinOffer(scope: UnpinOfferScope | null): PinnableProject | null {
  const projectId = scope?.projectId
  const pinned = usePinnedStore((s) => (projectId ? s.pinnedProjectIds.has(projectId) : false))
  const pinnedWorktreeIds = usePinnedStore((s) => s.pinnedWorktreeIds)
  const tickets = useKanbanStore((s) => (projectId ? s.tickets.get(projectId) : undefined))
  const worktrees = useWorktreeStore((s) =>
    projectId ? s.worktreesByProject.get(projectId) : undefined
  )
  const project = useProjectStore((s) =>
    projectId ? s.projects.find((candidate) => candidate.id === projectId) : undefined
  )

  return useMemo(() => {
    if (!scope || !project || !pinned) return null
    if (hasOpenTickets(tickets, scope.landingTicketIds)) return null
    const kind = project.kind === 'connection' ? 'connection' : 'git'
    if (kind === 'git') {
      // The pins the store can place: when every one of them sits on a worktree that is being
      // archived, the project leaves the board with the archive and there is nothing to ask.
      const pins = (worktrees ?? []).filter((worktree) => pinnedWorktreeIds.has(worktree.id))
      if (pins.length > 0 && pins.every((pin) => scope.archivedWorktreeIds.has(pin.id))) {
        return null
      }
    }
    return { id: project.id, name: project.name, kind }
  }, [scope, project, pinned, tickets, worktrees, pinnedWorktreeIds])
}

/**
 * Take the project off the Pinned Board once the move to Done went through: only while nothing
 * of it is left outside Done. A queue that went on instead (a branch picked up work), a ticket
 * that did not move or one that showed up meanwhile keeps the project pinned.
 * Resolves to whether it was unpinned. Never throws.
 */
export async function unpinIdleProject(project: PinnableProject): Promise<boolean> {
  if (hasOpenTickets(useKanbanStore.getState().tickets.get(project.id))) return false
  if (!isProjectPinned(project.id)) return false
  return setProjectPinned(project, false)
}
