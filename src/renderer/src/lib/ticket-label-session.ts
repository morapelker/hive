// src/renderer/src/lib/ticket-label-session.ts

/**
 * The open Labels menu's short memory of a ticket's one-off labels.
 *
 * The menu lists the catalog's labels (always) and, under "This ticket only", the labels that
 * live on this ticket alone: one-offs, and the rare saved label whose catalog entry is gone. A
 * row unticked while the menu is open stays listed, unticked, so an accidental tap can be undone
 * by ticking it again (the exact label comes back, same id, same place). The memory belongs to
 * one opening of the menu: when it closes the memory is dropped, so a removed one-off is gone
 * for good — no store, no storage, no undo stack holds it.
 *
 * Pure functions; the card keeps the session in React state for as long as its menu is open.
 */

import {
  TICKET_LABELS_MAX,
  sortTicketLabels,
  ticketLabelNameKey,
  type TicketLabel
} from '@shared/lib/ticket-labels'

/** The ticket-only labels the open menu remembers, in the order it lists them. */
export type TicketLabelSession = readonly TicketLabel[]

export interface TicketLabelRow {
  readonly label: TicketLabel
  readonly checked: boolean
}

/** A label listed under "This ticket only": a one-off, or a saved label the catalog lost. */
export function isTicketOnlyLabel(label: TicketLabel, catalogIds: ReadonlySet<string>): boolean {
  return label.kind === 'once' || !catalogIds.has(label.id)
}

/** The memory as the menu opens: the ticket's ticket-only labels, in their order. */
export function openTicketLabelSession(
  current: readonly TicketLabel[],
  catalogIds: ReadonlySet<string>
): TicketLabelSession {
  return current.filter((label) => isTicketOnlyLabel(label, catalogIds))
}

/**
 * The memory after the ticket changed while the menu is open: a ticket-only label that appeared
 * (a one-off just created from the menu) is remembered too, so unticking it keeps its row.
 * Returns the same array when nothing is new.
 */
export function extendTicketLabelSession(
  session: TicketLabelSession,
  current: readonly TicketLabel[],
  catalogIds: ReadonlySet<string>
): TicketLabelSession {
  const known = new Set(session.map((label) => label.id))
  const added = current.filter(
    (label) => isTicketOnlyLabel(label, catalogIds) && !known.has(label.id)
  )
  return added.length === 0 ? session : [...session, ...added]
}

/**
 * The "This ticket only" rows: every remembered label (ticked when still on the ticket). One the
 * catalog knows by now (the catalog loaded after the menu opened) is a saved row instead.
 */
export function ticketOnlyLabelRows(
  session: TicketLabelSession,
  current: readonly TicketLabel[],
  catalogIds: ReadonlySet<string>
): TicketLabelRow[] {
  const byId = new Map(current.map((label) => [label.id, label]))
  const rows: TicketLabelRow[] = session
    .filter((label) => isTicketOnlyLabel(label, catalogIds))
    .map((label) => {
      const live = byId.get(label.id)
      return { label: live ?? label, checked: live !== undefined }
    })
  const listed = new Set(session.map((label) => label.id))
  for (const label of current) {
    if (isTicketOnlyLabel(label, catalogIds) && !listed.has(label.id)) {
      rows.push({ label, checked: true })
    }
  }
  return rows
}

/** False when the ticket already carries the most labels it may. */
export function canAddTicketLabel(current: readonly TicketLabel[]): boolean {
  return current.length < TICKET_LABELS_MAX
}

/**
 * True when another label on the ticket (a different id) already has this label's name,
 * case-insensitively. Ticking it would draw a second, identical chip (saved and one-off chips
 * look the same), so the menu disables such a row, as the create dialog refuses the name.
 */
export function isTicketLabelNameTaken(
  current: readonly TicketLabel[],
  label: Pick<TicketLabel, 'id' | 'name'>
): boolean {
  const key = ticketLabelNameKey(label.name)
  return current.some((entry) => entry.id !== label.id && entry.name.toLowerCase() === key)
}

/**
 * The ticket's labels after ticking (`on`) or unticking a label, in canonical order: saved labels
 * in catalog order, then the ticket-only ones in the order the menu lists them — so a one-off
 * ticked back returns to the place it had. Returns `current` itself when nothing changes
 * (already in that state, full, or another label on the ticket already has the name).
 */
export function nextTicketLabels(
  current: readonly TicketLabel[],
  label: TicketLabel,
  on: boolean,
  session: TicketLabelSession,
  catalogOrder: ReadonlyMap<string, number>
): readonly TicketLabel[] {
  const present = current.some((entry) => entry.id === label.id)
  if (!on) return present ? current.filter((entry) => entry.id !== label.id) : current
  if (present || !canAddTicketLabel(current) || isTicketLabelNameTaken(current, label)) {
    return current
  }

  const catalogIds = new Set(catalogOrder.keys())
  if (!isTicketOnlyLabel(label, catalogIds)) {
    return sortTicketLabels([...current, label], catalogOrder)
  }

  // Ticket-only labels follow the menu's order: remembered ones by their place in the session,
  // anything the session does not know after them, in the order the ticket has it.
  const place = new Map(session.map((entry, index) => [entry.id, index]))
  const saved = current.filter((entry) => !isTicketOnlyLabel(entry, catalogIds))
  const ticketOnly = [...current.filter((entry) => isTicketOnlyLabel(entry, catalogIds)), label]
  const ordered = ticketOnly
    .map((entry, index) => ({ entry, index, at: place.get(entry.id) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ entry }) => entry)
  return sortTicketLabels([...saved, ...ordered], catalogOrder)
}
