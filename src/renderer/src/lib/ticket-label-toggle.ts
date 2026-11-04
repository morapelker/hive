// src/renderer/src/lib/ticket-label-toggle.ts

/**
 * Writes one tick or untick of the Labels menu (or the label the create dialog just made, or a
 * one-off the dialog just edited) to its ticket.
 *
 * The menu stays open, so labels get ticked in quick succession. Each toggle waits for the
 * previous one on the same ticket, so the writes reach the server in the order they were made,
 * and computes the new list when its turn comes: the first of a burst from the latest store
 * ticket, each one queued behind it from the list the previous one wrote. The store copy is not
 * safe to build on mid-burst: a board reload fetched before that write, or another update's
 * rollback, may have put an older list back meanwhile, and sending a list built on it would
 * silently undo the earlier toggle. Once the queue drains the store is the base again, so edits
 * made elsewhere are picked up.
 *
 * updateTicket is optimistic and, on failure, restores a snapshot of the whole project taken
 * when it started — which can undo, on screen, a toggle that succeeded meanwhile. So after a
 * failure the project's tickets are reloaded from the DB before the next toggle runs.
 *
 * Label names are never logged: the failure toast is generic and the error is not printed.
 */

import {
  ticketLabelCatalogOrder,
  ticketLabelsOf,
  type TicketLabel
} from '@shared/lib/ticket-labels'
import { reloadBoard } from '@/lib/board-reload'
import { toast } from '@/lib/toast'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useTicketLabelsStore } from '@/stores/useTicketLabelsStore'
import {
  editedTicketLabels,
  nextTicketLabels,
  type TicketLabelSession
} from './ticket-label-session'

export interface TicketLabelTarget {
  projectId: string
  ticketId: string
}

/**
 * What a toggle did: `applied` when the ticket's labels were written, `unchanged` when there was
 * nothing to write (the ticket or the edited label is gone, the label is already in that state,
 * the ticket is full, or another of its labels has the name), `failed` when the write failed
 * (after the failure toast and the reload).
 */
export type TicketLabelWriteOutcome = 'applied' | 'unchanged' | 'failed'

/** The tail of each ticket's queue, by `${projectId}:${ticketId}` (dropped once it drains). */
const queues = new Map<string, Promise<TicketLabelWriteOutcome>>()

/**
 * The labels the queue last wrote, by the same key: the base of the next toggle while the queue
 * has not drained. Dropped with the queue, and after a failed write (the reload is the truth).
 */
const lastWritten = new Map<string, readonly TicketLabel[]>()

/** The ticket's labels after a write, from the list it applies to; that list itself for none. */
type TicketLabelChange = (
  current: readonly TicketLabel[],
  catalogOrder: ReadonlyMap<string, number>
) => readonly TicketLabel[]

/**
 * Ticks (`on`) or unticks `label` on the ticket, after any toggle of the same ticket still
 * pending. `session` is the open menu's memory (ticket-label-session.ts), which places a
 * one-off ticked back where it was. A failed write shows a toast and reloads the project's
 * tickets. Never rejects: resolves with the outcome once the write (or the reload) is done.
 */
export function setTicketLabel(
  ref: TicketLabelTarget,
  label: TicketLabel,
  on: boolean,
  session: TicketLabelSession
): Promise<TicketLabelWriteOutcome> {
  return queueTicketLabelWrite(ref, (current, catalogOrder) =>
    nextTicketLabels(current, label, on, session, catalogOrder)
  )
}

/**
 * Replaces the ticket's label of `label.id` with `label`, in place, after any write of the same
 * ticket still pending. Fails and resolves the way setTicketLabel does.
 */
export function editTicketLabel(
  ref: TicketLabelTarget,
  label: TicketLabel
): Promise<TicketLabelWriteOutcome> {
  return queueTicketLabelWrite(ref, (current) => editedTicketLabels(current, label))
}

function queueTicketLabelWrite(
  ref: TicketLabelTarget,
  change: TicketLabelChange
): Promise<TicketLabelWriteOutcome> {
  const key = `${ref.projectId}:${ref.ticketId}`
  // The queue never stalls: the next toggle runs even if this one threw unexpectedly.
  const outcome = (queues.get(key) ?? Promise.resolve())
    .then(() => applyTicketLabelChange(key, ref, change))
    .catch((): TicketLabelWriteOutcome => {
      lastWritten.delete(key)
      return 'failed'
    })
  queues.set(key, outcome)
  void outcome.then(() => {
    if (queues.get(key) !== outcome) return
    queues.delete(key)
    lastWritten.delete(key)
  })
  return outcome
}

async function applyTicketLabelChange(
  key: string,
  { projectId, ticketId }: TicketLabelTarget,
  change: TicketLabelChange
): Promise<TicketLabelWriteOutcome> {
  const ticket = useKanbanStore
    .getState()
    .tickets.get(projectId)
    ?.find((t) => t.id === ticketId)
  // Deleted, archived out of view or moved away while queued: nothing left to label.
  if (!ticket) return 'unchanged'

  // Mid-burst, the previous toggle's list: the store copy may have been put back since.
  const current = lastWritten.get(key) ?? ticketLabelsOf(ticket)
  const catalogOrder = ticketLabelCatalogOrder(useTicketLabelsStore.getState().labels)
  const next = change(current, catalogOrder)
  if (next === current) return 'unchanged'

  try {
    await useKanbanStore.getState().updateTicket(ticketId, projectId, { labels: [...next] })
  } catch {
    lastWritten.delete(key)
    toast.error("Couldn't update labels")
    // Waits for the project's other optimistic writes first, so it cannot clobber them.
    await reloadBoard(projectId).catch(() => {})
    return 'failed'
  }
  lastWritten.set(key, next)
  return 'applied'
}
