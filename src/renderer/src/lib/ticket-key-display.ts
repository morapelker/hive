// The "Ticket IDs" setting (never / orchestrator tickets only / always) decides where a ticket's
// key (TD-12) appears. TicketKeyBadge reads it for every chip; the helpers here cover the places
// that put the key into plain text — toasts, a session header, a dialog description — so no
// surface shows an ID the setting says to hide.
import { useSettingsStore, type TicketKeyDisplay } from '@/stores/useSettingsStore'
import { isDocumentRunTicket } from '@shared/document-flow/run-ticket'
import { ticketKeyOf, ticketTitleWithKey, type TicketKeyFields } from '@shared/ticket-key'

/** What the visibility rule looks at; every field but the key halves is optional (reduced shapes). */
export interface TicketKeyDisplayFields extends TicketKeyFields {
  parent_ticket_key?: string | null
  external_provider?: string | null
  external_id?: string | null
}

/** Whether the setting lets this ticket show its key: a run's ticket and its children always qualify. */
export function ticketKeyVisible(
  display: TicketKeyDisplay,
  ticket: Pick<TicketKeyDisplayFields, 'parent_ticket_key' | 'external_provider' | 'external_id'>
): boolean {
  if (display === 'always') return true
  if (display === 'never') return false
  return isDocumentRunTicket(ticket) || !!ticket.parent_ticket_key
}

const currentDisplay = (): TicketKeyDisplay => useSettingsStore.getState().ticketKeyDisplay

/** `TD-12` when the setting shows it for this ticket, null otherwise. */
export function visibleTicketKeyOf(
  ticket: TicketKeyDisplayFields,
  display: TicketKeyDisplay = currentDisplay()
): string | null {
  const key = ticketKeyOf(ticket)
  return key && ticketKeyVisible(display, ticket) ? key : null
}

/** `TD-12 · Title` when the setting shows the key for this ticket, the bare title otherwise. */
export function visibleTicketTitle(
  ticket: TicketKeyDisplayFields & { title: string },
  fallbackTitle = 'A ticket',
  display: TicketKeyDisplay = currentDisplay()
): string {
  return ticketKeyVisible(display, ticket)
    ? ticketTitleWithKey(ticket, fallbackTitle)
    : ticket.title.trim() || fallbackTitle
}
