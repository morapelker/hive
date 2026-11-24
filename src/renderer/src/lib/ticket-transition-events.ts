import type { KanbanTicket, KanbanTicketColumn } from '../../../main/db/types'

// Ticket column transitions as this renderer performs them: useKanbanStore's moveTicket and
// updateTicket announce every column change here once the backend accepted it, with the column
// the ticket left and the one it entered. Every renderer-driven move goes through those two
// actions (a drag, the ticket modal, a session finishing, the PR merge, the reload-time
// reconcile), so a subscriber sees "in_progress → review" exactly when the app advanced the
// ticket. Moves made behind the renderer's back (an edit of a markdown card) are not announced:
// nothing here observed them.
//
// Listeners must never throw into a store action; a failing listener is dropped for that
// event and reported on the console.

export interface TicketColumnTransition {
  ticketId: string
  projectId: string
  from: KanbanTicketColumn
  to: KanbanTicketColumn
  /** The ticket as the store held it before the move (title, session, worktree, mode). */
  ticket: KanbanTicket
  /**
   * The person at this desktop asked for the move and is there to answer a question about it
   * (whether to unpin a project whose last open ticket reached Done). Set by the moves that can
   * end there: a drop, the ticket modal's Move to Done, the merge-on-done dialog, Merge PR.
   * Absent for moves nobody here is watching (document-run batches, the runner, rollbacks,
   * session events).
   */
  interactive?: boolean
  at: number
}

type Listener = (transition: TicketColumnTransition) => void

const listeners = new Set<Listener>()

export function subscribeTicketTransitions(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Announces a column change the backend accepted; a no-op when the column did not change. */
export function emitTicketTransition(input: Omit<TicketColumnTransition, 'at'>): void {
  if (input.from === input.to) return
  const transition: TicketColumnTransition = { ...input, at: Date.now() }
  for (const listener of listeners) {
    try {
      listener(transition)
    } catch (error) {
      console.warn('[ticket-transitions] a listener failed', error)
    }
  }
}

/** Tests only. */
export function resetTicketTransitionListenersForTests(): void {
  listeners.clear()
}
