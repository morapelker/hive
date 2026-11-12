// The tickets of an "Implement document" run (its task and fix tickets, `parent_ticket_id` =
// the run's own ticket) are not laid out as cards of their own: the board folds them into the
// run's card, where they show as compact rows under a collapsible strip (DocumentRunChildren).
// This module decides which tickets fold and in what order; the board and the card both read it
// so a ticket is never shown twice or not at all.
import { isDocumentRunTicket } from '@shared/document-flow/run-ticket'
import type { DocumentRunItem } from '@shared/types/document-flow'
import type { KanbanTicket, KanbanTicketColumn } from '../../../../main/db/types'

/** Board order of the columns: a run's rows are listed in it, queued first, done last. */
export const CHILD_COLUMN_ORDER: Record<KanbanTicketColumn, number> = {
  todo: 0,
  in_progress: 1,
  review: 2,
  merged: 3,
  done: 4
}

export const CHILD_COLUMNS: KanbanTicketColumn[] = ['todo', 'in_progress', 'review', 'merged', 'done']

export type ChildColumnCounts = Record<KanbanTicketColumn, number>

/**
 * The run tickets of a project that have rows to fold: on the board (not archived) and marked
 * as a document run. A child of any other parent — a run ticket that was archived or deleted,
 * or a parent that is not a run — stays a card of its own, so nothing is hidden from the board.
 */
function foldingRunTicketIds(tickets: readonly KanbanTicket[]): Set<string> {
  const ids = new Set<string>()
  for (const ticket of tickets) {
    if (isDocumentRunTicket(ticket) && !ticket.archived_at) ids.add(ticket.id)
  }
  return ids
}

/** Whether a ticket is a row of a folding run of the same project. */
function foldsInto(ticket: KanbanTicket, runIds: ReadonlySet<string>): boolean {
  return (
    !!ticket.parent_ticket_id && !ticket.archived_at && runIds.has(ticket.parent_ticket_id)
  )
}

/** The ids of every ticket of the project the board shows inside its run's card, not as a card. */
export function nestedRunChildIds(tickets: readonly KanbanTicket[]): Set<string> {
  const runIds = foldingRunTicketIds(tickets)
  const nested = new Set<string>()
  if (runIds.size === 0) return nested
  for (const ticket of tickets) {
    if (foldsInto(ticket, runIds)) nested.add(ticket.id)
  }
  return nested
}

/** Column order first, then the board's manual order within a column. */
export function compareRunChildren(a: KanbanTicket, b: KanbanTicket): number {
  return (
    CHILD_COLUMN_ORDER[a.column] - CHILD_COLUMN_ORDER[b.column] ||
    a.sort_order - b.sort_order ||
    a.created_at.localeCompare(b.created_at)
  )
}

/** The rows of one run's card, in the order they are listed. */
export function runChildrenOf(
  tickets: readonly KanbanTicket[],
  runTicketId: string
): KanbanTicket[] {
  return tickets
    .filter((t) => t.parent_ticket_id === runTicketId && !t.archived_at)
    .sort(compareRunChildren)
}

/**
 * The tickets of a run that stand for none of its items: the sessions started from the run's
 * dashboard once it ended (its migrations, its manual steps, a new session on its branch),
 * each made a child of the run's own ticket. The run's card names the ones whose session is
 * running (DocumentRunSpawnedSessions); the run's items are counted in its label instead.
 * Oldest first, so a row keeps its place while others come and go.
 */
export function spawnedRunTickets(
  tickets: readonly KanbanTicket[],
  runTicketId: string,
  items: readonly Pick<DocumentRunItem, 'ticket_id' | 'fix_ticket_id'>[]
): KanbanTicket[] {
  const itemTicketIds = new Set<string>()
  for (const item of items) {
    if (item.ticket_id) itemTicketIds.add(item.ticket_id)
    if (item.fix_ticket_id) itemTicketIds.add(item.fix_ticket_id)
  }
  return tickets
    .filter(
      (t) => t.parent_ticket_id === runTicketId && !t.archived_at && !itemTicketIds.has(t.id)
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/** How many rows sit in each column: the strip's header says it even when collapsed. */
export function childColumnCounts(children: readonly KanbanTicket[]): ChildColumnCounts {
  const counts: ChildColumnCounts = { todo: 0, in_progress: 0, review: 0, merged: 0, done: 0 }
  for (const child of children) counts[child.column] += 1
  return counts
}
