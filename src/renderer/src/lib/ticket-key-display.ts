// The "Ticket IDs" setting (never / orchestrator tickets only / always) decides where a ticket's
// key (TD-12) appears. TicketKeyBadge reads it for every chip; the helpers here cover the places
// that put the key into plain text — toasts, a session header, a dialog description — so no
// surface shows an ID the setting says to hide.
//
// "Orchestrator tickets only" means exactly that: a run's own ticket shows its key, and each of
// the run's children shows the key of the run it belongs to — never its own. Every other ticket
// shows nothing.
import { useSettingsStore, type TicketKeyDisplay } from '@/stores/useSettingsStore'
import { isDocumentRunTicket } from '@shared/document-flow/run-ticket'
import { ticketKeyOf, type TicketKeyFields } from '@shared/ticket-key'

/** What the visibility rule looks at; every field but the key halves is optional (reduced shapes). */
export interface TicketKeyDisplayFields extends TicketKeyFields {
  parent_ticket_key?: string | null
  external_provider?: string | null
  external_id?: string | null
}

type TicketKeyDisplayRuleFields = Pick<
  TicketKeyDisplayFields,
  'parent_ticket_key' | 'external_provider' | 'external_id'
>

/** The segments the setting lets a surface show for one ticket; either may be null. */
export interface VisibleTicketKeys {
  /** The ticket's own key (`TD-12`). */
  key: string | null
  /** The key of the orchestrator run the ticket belongs to (`TD-7`). */
  parentKey: string | null
}

/** Whether the setting lets this ticket show its own key. */
export function ticketKeyVisible(
  display: TicketKeyDisplay,
  ticket: TicketKeyDisplayRuleFields
): boolean {
  if (display === 'always') return true
  if (display === 'never') return false
  return isDocumentRunTicket(ticket)
}

/** Whether the setting lets this ticket show the key of the run it belongs to. */
export function parentTicketKeyVisible(
  display: TicketKeyDisplay,
  ticket: TicketKeyDisplayRuleFields
): boolean {
  return display !== 'never' && !!ticket.parent_ticket_key
}

const currentDisplay = (): TicketKeyDisplay => useSettingsStore.getState().ticketKeyDisplay

/** Both segments the setting allows for this ticket, each null when hidden or missing. */
export function visibleTicketKeysOf(
  ticket: TicketKeyDisplayFields,
  display: TicketKeyDisplay = currentDisplay()
): VisibleTicketKeys {
  const key = ticketKeyOf(ticket)
  return {
    key: key && ticketKeyVisible(display, ticket) ? key : null,
    parentKey: parentTicketKeyVisible(display, ticket) ? ticket.parent_ticket_key! : null
  }
}

/** `TD-12` when the setting shows this ticket's own key, null otherwise. */
export function visibleTicketKeyOf(
  ticket: TicketKeyDisplayFields,
  display: TicketKeyDisplay = currentDisplay()
): string | null {
  return visibleTicketKeysOf(ticket, display).key
}

/**
 * The title with the key the setting shows for this ticket: `TD-12 · Title` when its own key is
 * shown, `TD-7 › Title` for an orchestrator child that only shows the run it belongs to, the
 * bare title otherwise.
 */
export function visibleTicketTitle(
  ticket: TicketKeyDisplayFields & { title: string },
  fallbackTitle = 'A ticket',
  display: TicketKeyDisplay = currentDisplay()
): string {
  const title = ticket.title.trim() || fallbackTitle
  const { key, parentKey } = visibleTicketKeysOf(ticket, display)
  if (key) return `${key} · ${title}`
  if (parentKey) return `${parentKey} › ${title}`
  return title
}
