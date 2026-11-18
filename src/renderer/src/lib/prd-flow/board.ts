import { useKanbanStore } from '@/stores/useKanbanStore'
import type { KanbanTicket } from '../../../../main/db/types'

// The board as a PRD flow touches it. The driver's ports (./live-ports), the start (./start) and
// the card's actions (./actions) read the flow's ticket and move it through here, so that all
// of them make the same move.

/** The flow's ticket as this page's board has it; null when it is not there (or not loaded yet). */
export function findPrdFlowTicket(projectId: string, ticketId: string): KanbanTicket | null {
  return (
    useKanbanStore
      .getState()
      .tickets.get(projectId)
      ?.find((ticket) => ticket.id === ticketId) ?? null
  )
}

/**
 * Puts the ticket at the top of the column, and nothing else: its session is neither closed nor
 * revived, and nothing that follows a finished ticket is set off.
 */
export function movePrdFlowTicket(
  projectId: string,
  ticketId: string,
  column: 'in_progress' | 'review'
): Promise<void> {
  const store = useKanbanStore.getState()
  return store.moveTicket(
    ticketId,
    projectId,
    column,
    store.computeSortOrder(store.getTicketsByColumn(projectId, column), 0),
    { skipCompletionEffects: true, keepSession: true }
  )
}
