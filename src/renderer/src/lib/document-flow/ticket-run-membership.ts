// Which run a board ticket belongs to, as the board needs to know it: the card's "Orchestrator"
// menu (open the run, add the ticket to one, take it out again), the guards that keep a ticket
// an orchestrator will launch from being launched by hand as well (a drop on In Progress, a
// right-drag, the modal's Send, `launchTicketWithModel`), and the move of a ticket to another
// Mac. Reads the runs this renderer loaded (`useDocumentFlowStore.runsById`, every run since the
// runner hook loads them all at start); pure over the `runsById` it is given, so a test passes
// its own. Membership is the item's `ticket_id`, which both board backends keep (a markdown
// board has no `parent_ticket_id`), so it holds for a document run's task tickets as much as for
// the tickets an orchestrator adopted, and an orchestrator adopts neither. The launch and move
// guards are an orchestrator's alone: a document run's task tickets do what they always did.

import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { awaitsLaunch } from '@shared/document-flow/planning'
import {
  canAddTicketsToRun,
  runKindLabel,
  runOwnsItsTickets,
  type TicketRunOwner
} from '@shared/document-flow/ticket-runs'
import {
  isTicketRun,
  type DocumentRun,
  type DocumentRunDetail,
  type DocumentRunItem
} from '@shared/types/document-flow'

type RunsById = Record<string, DocumentRunDetail>

/** A ticket's place in a run: the run and the item that stands for the ticket. */
export interface TicketRunMembership {
  run: DocumentRun
  item: DocumentRunItem
}

const currentRuns = (): RunsById => useDocumentFlowStore.getState().runsById

const newestFirst = (a: DocumentRunDetail, b: DocumentRunDetail): number =>
  b.run.created_at.localeCompare(a.run.created_at)

/**
 * The run item that stands for `ticketId`, in a run that still owns its tickets (see
 * `runOwnsItsTickets`: before launch, running or paused), or null when no such run has it. A
 * ticket is in one owning run at a time; should two claim it (rows from before that rule),
 * the newest wins. With `anyStatus`, a run that ended counts as well (still the newest first):
 * what "Open orchestrator" follows once the run is over.
 */
export function runItemOfTicket(
  ticketId: string,
  runsById: RunsById = currentRuns(),
  options: { anyStatus?: boolean } = {}
): TicketRunMembership | null {
  if (!ticketId) return null
  const candidates = Object.values(runsById)
    .filter((detail) => options.anyStatus || runOwnsItsTickets(detail.run.status))
    .sort(newestFirst)
  for (const detail of candidates) {
    const item = detail.items.find((candidate) => candidate.ticket_id === ticketId)
    if (item) return { run: detail.run, item }
  }
  return null
}

/** The run that holds `ticketId` now, as `ticketRunRefusal` takes it; null when none does. */
export function ticketRunOwnerOf(
  ticketId: string,
  runsById: RunsById = currentRuns()
): TicketRunOwner | null {
  const membership = runItemOfTicket(ticketId, runsById)
  if (!membership) return null
  const { run } = membership
  return { runId: run.id, title: runTitle(run), status: run.status }
}

/** The run's title for copy: its own, else what it is ("Orchestrator", "Document run"). */
export function runTitle(run: Pick<DocumentRun, 'title' | 'source_kind'>): string {
  return run.title.trim() || runKindLabel(run)
}

/**
 * The run launches the item itself: the run still owns its tickets, the item is part of it
 * (selected), and it has not launched yet — it waits for its dependencies or a slot, or its
 * launch failed with no session and Retry sends it back (`awaitsLaunch`). Every item of a run
 * still in preview waits for the run's launch.
 */
export function isAwaitingRunLaunch(membership: TicketRunMembership | null): boolean {
  if (!membership) return false
  const { run, item } = membership
  if (!item.selected || !runOwnsItsTickets(run.status)) return false
  return run.status === 'preview' || awaitsLaunch(item)
}

/**
 * Why `ticketId` cannot be launched by hand now, or null when it can: the orchestrator it is
 * part of launches it (see `isAwaitingRunLaunch`), or is launching it this moment (the item is
 * `launching`: its worktree and session are being made, and the ticket still sits in To Do
 * with no session), and a second launch beside the run's would leave two sessions on one
 * ticket, the run waiting on a session it never made. Says how to get it back: Remove lets the
 * ticket go. A document run's task ticket is not refused here: it launches as it always has.
 * The run's own launch passes `orchestrated` and never asks. Cheap: one scan of the loaded
 * runs, no request.
 */
export function orchestratorLaunchRefusal(
  ticketId: string,
  runsById: RunsById = currentRuns()
): string | null {
  const membership = runItemOfTicket(ticketId, runsById)
  if (!membership || !isTicketRun(membership.run)) return null
  const { run, item } = membership
  if (item.selected && item.status === 'launching') {
    return `${item.key} is being launched by the orchestrator “${runTitle(run)}”.`
  }
  if (!isAwaitingRunLaunch(membership)) return null
  return `${item.key} is part of the orchestrator “${runTitle(run)}”: it launches when the run gets to it. Remove it from the orchestrator to launch it yourself.`
}

/**
 * The orchestrators of `projectId` that take more tickets now (`canAddTicketsToRun`: made from
 * board tickets, before launch, running, paused or finished but not cancelled), newest first.
 */
export function addableTicketRuns(
  projectId: string,
  runsById: RunsById = currentRuns()
): DocumentRun[] {
  return Object.values(runsById)
    .filter((detail) => detail.run.project_id === projectId && canAddTicketsToRun(detail.run))
    .sort(newestFirst)
    .map((detail) => detail.run)
}

/**
 * Whether a finished orchestrator is known to have nothing left to resume on: its integration
 * worktree (or instance) was archived, with the merge of the run's ticket, or it never had one.
 * The server refuses more tickets then, so no entry point offers them. Lists that have not
 * loaded yet refuse nothing; the server has the last word either way.
 */
export function integrationCheckoutGone(
  run: Pick<DocumentRun, 'integration_worktree_id' | 'integration_connection_id'>,
  worktrees: readonly { id: string }[] | undefined,
  connectionIds: ReadonlySet<string> | undefined
): boolean {
  if (run.integration_connection_id) {
    return connectionIds !== undefined && !connectionIds.has(run.integration_connection_id)
  }
  if (!run.integration_worktree_id) return true
  return (
    worktrees !== undefined &&
    !worktrees.some((worktree) => worktree.id === run.integration_worktree_id)
  )
}
