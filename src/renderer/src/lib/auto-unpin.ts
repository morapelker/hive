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
 *
 * A move to Done that never reaches that step (the ticket ran on the base branch, its worktree
 * is archived already, nothing has its base branch checked out, "Move to Done anyway"...) gets
 * the same question in a dialog of its own (UnpinOnDoneDialog), asked once the ticket is in
 * Done: see `watchDoneMovesForUnpin`.
 */
import { useMemo } from 'react'
import { create } from 'zustand'
import { ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { isProjectPinned, setProjectPinned, type PinnableProject } from '@/lib/project-pin'
import {
  subscribeTicketTransitions,
  type TicketColumnTransition
} from '@/lib/ticket-transition-events'

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

const NONE: ReadonlySet<string> = new Set()

/** The scope of a move that is over: its ticket is in Done already and nothing is archived. */
export function settledUnpinScope(projectId: string): UnpinOfferScope {
  return { projectId, landingTicketIds: NONE, archivedWorktreeIds: NONE }
}

/** What the unpin check reads from the stores. */
interface UnpinOfferState {
  project: { id: string; name: string; kind?: 'git' | 'connection' } | undefined
  /** The project is on the Pinned Board. */
  pinned: boolean
  pinnedWorktreeIds: ReadonlySet<string>
  tickets: readonly TicketLike[] | undefined
  worktrees: readonly { id: string }[] | undefined
}

/** The unpin check itself: the project to make the offer for, or null. */
function resolveUnpinOffer(
  scope: UnpinOfferScope | null,
  { project, pinned, pinnedWorktreeIds, tickets, worktrees }: UnpinOfferState
): PinnableProject | null {
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
}

/**
 * The project to offer the unpin for ("Archive & Unpin" in the archive step, the question of
 * UnpinOnDoneDialog), or null when there is nothing to offer. Follows the board, the pins and
 * the worktrees while the offer is open.
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

  return useMemo(
    () => resolveUnpinOffer(scope, { project, pinned, pinnedWorktreeIds, tickets, worktrees }),
    [scope, project, pinned, tickets, worktrees, pinnedWorktreeIds]
  )
}

/** `useUnpinOffer` outside React: the check against the stores as they are now. */
function currentUnpinOffer(scope: UnpinOfferScope): PinnableProject | null {
  const pins = usePinnedStore.getState()
  return resolveUnpinOffer(scope, {
    project: useProjectStore.getState().projects.find((p) => p.id === scope.projectId),
    pinned: pins.pinnedProjectIds.has(scope.projectId),
    pinnedWorktreeIds: pins.pinnedWorktreeIds,
    tickets: useKanbanStore.getState().tickets.get(scope.projectId),
    worktrees: useWorktreeStore.getState().worktreesByProject.get(scope.projectId)
  })
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

// ── The offer outside the archive step ───────────────────────────────────────────────────

/** A ticket that reached Done without the archive step, in a project the unpin check passes. */
export interface UnpinOnDoneOffer {
  projectId: string
  ticketId: string
  ticketTitle: string
}

/** The question UnpinOnDoneDialog has on screen (or holds back behind the merge dialog). */
export const useUnpinOnDoneStore = create<{ offer: UnpinOnDoneOffer | null }>()(() => ({
  offer: null
}))

/** Closes the question without unpinning anything. */
export function dismissUnpinOnDone(): void {
  if (useUnpinOnDoneStore.getState().offer) useUnpinOnDoneStore.setState({ offer: null })
}

/** True while the question is up (board-idle's "nothing highlighted"). */
export function hasUnpinOnDoneOffer(): boolean {
  return useUnpinOnDoneStore.getState().offer !== null
}

interface TicketRef {
  projectId: string
  ticketId: string
}

/** Tickets the archive step is moving right now, by ticket key (counted: a move can overlap). */
const archiveStepMoves = new Map<string, number>()

/**
 * Runs a move the archive step of MergeOnDoneDialog makes (Keep, Archive, Archive all). That
 * step was shown, with "Archive & Unpin" on it whenever the project qualified, so the ticket
 * landing in Done is not followed by the question again.
 */
export async function answeredByArchiveStep<T>(
  ticket: TicketRef | undefined,
  move: () => Promise<T>
): Promise<T> {
  if (!ticket) return move()
  const key = ticketKey(ticket.projectId, ticket.ticketId)
  archiveStepMoves.set(key, (archiveStepMoves.get(key) ?? 0) + 1)
  try {
    return await move()
  } finally {
    const left = (archiveStepMoves.get(key) ?? 1) - 1
    if (left > 0) archiveStepMoves.set(key, left)
    else archiveStepMoves.delete(key)
  }
}

function offerUnpinOnDone(transition: TicketColumnTransition): void {
  // Only a move the person at this desktop made: they are there to answer
  if (transition.to !== 'done' || !transition.interactive) return
  const { projectId, ticketId } = transition
  if (archiveStepMoves.has(ticketKey(projectId, ticketId))) return
  if (!currentUnpinOffer(settledUnpinScope(projectId))) return
  useUnpinOnDoneStore.setState({
    offer: { projectId, ticketId, ticketTitle: transition.ticket.title }
  })
}

/**
 * Asks whether to unpin the project when a ticket is moved to Done without the archive step
 * and the unpin check of that step passes. For UnpinOnDoneDialog, while it is mounted: the
 * returned function stops watching and withdraws a question nobody is left to show.
 */
export function watchDoneMovesForUnpin(): () => void {
  const unsubscribe = subscribeTicketTransitions(offerUnpinOnDone)
  return () => {
    unsubscribe()
    dismissUnpinOnDone()
  }
}
