// Deleting a run's own ticket (a document run's, or an orchestrator's) deletes the run and leaves
// its tickets on the board. The confirmation asks whether they go too, wherever the run is
// deleted from on this Mac: the menu of its ticket on the board, and its dashboard. This is what
// "and its tickets" does, and what it reports.
//
// The run goes first: the server refuses to delete one that is running or migrating, and then
// nothing is deleted at all. Its tickets follow as board tickets always are deleted, one by one
// through the board's store, so each closes its session and loses its dependency links; their
// branches and worktrees are kept, as for any deleted ticket.
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePrdFlowStore } from '@/stores/usePrdFlowStore'
import type { KanbanTicket } from '../../../../main/db/types'
import { ticketsOfRun } from './run-children'

/** The run whose tickets are meant: the run (null once only its ticket is left) and its ticket. */
export interface RunTicketsTarget {
  runId: string | null
  /** The run's own ticket: never one of "its tickets". */
  ticketId: string | null
  projectId: string
}

/** The run's tickets on this Mac's board now (see `ticketsOfRun`); read at call time. */
export function runTicketsOnBoard(target: RunTicketsTarget): KanbanTicket[] {
  const tickets = useKanbanStore.getState().tickets.get(target.projectId) ?? []
  const items = target.runId
    ? (useDocumentFlowStore.getState().runsById[target.runId]?.items ?? [])
    : []
  return ticketsOfRun(tickets, target.ticketId, items)
}

/** How many of the run's tickets went with it, and how many are still on the board. */
export interface RunTicketsDeletion {
  deleted: number
  failed: number
}

/**
 * Delete a run with `deleteRun`, then every ticket of it that is on the board. Rejects, with
 * nothing deleted, when the run could not be deleted. A ticket that could not be is counted
 * and stays on the board; the others still go.
 */
export async function deleteRunWithTickets(
  target: RunTicketsTarget,
  deleteRun: () => Promise<void>
): Promise<RunTicketsDeletion> {
  // Read before the run goes: its items name the tickets, and the server takes an orchestrator's
  // tickets off its ticket as it deletes it
  const tickets = runTicketsOnBoard(target)
  await deleteRun()
  const outcome: RunTicketsDeletion = { deleted: 0, failed: 0 }
  // One at a time: each delete is optimistic over the project's whole list, and a failed one
  // puts back the list as it was when it began
  for (const ticket of tickets) {
    try {
      await useKanbanStore.getState().deleteTicket(ticket.id, ticket.project_id)
      // A PRD flow saved for later goes with its ticket
      usePrdFlowStore.getState().removeDraft(ticket.id)
      outcome.deleted += 1
    } catch {
      outcome.failed += 1
    }
  }
  return outcome
}

const ticketCount = (count: number): string => `${count} ticket${count === 1 ? '' : 's'}`

/** The two ways to delete a run that has tickets on the board; `noun` as in "Delete <noun>". */
export function runTicketsDeleteLabels(
  noun: string,
  count: number
): { runOnly: string; withTickets: string } {
  return {
    runOnly: `Delete ${noun} only`,
    withTickets: `Delete ${noun} and ${ticketCount(count)}`
  }
}

/** What to tell the user once the run is gone; `kind` as a sentence starts ("Orchestrator"). */
export function describeRunTicketsDeletion(
  kind: string,
  outcome: RunTicketsDeletion
): { level: 'success' | 'warning'; message: string } {
  const { deleted, failed } = outcome
  if (failed > 0) {
    return {
      level: 'warning',
      message: `${kind} deleted, but ${failed} of its ${ticketCount(deleted + failed)} could not be deleted.`
    }
  }
  return {
    level: 'success',
    message: deleted > 0 ? `${kind} and ${ticketCount(deleted)} deleted` : `${kind} deleted`
  }
}
