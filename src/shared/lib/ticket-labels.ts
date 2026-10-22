// src/shared/lib/ticket-labels.ts

/**
 * Ticket labels: short coloured tags drawn on a kanban card in capitals ("WAITING FOR JOY").
 * They are display-only — like the ticket's note, a label MUST NOT reach any LLM prompt, the
 * markdown card file (agents read it) or the autocomplete corpus.
 *
 * A ticket carries its labels as self-contained snapshots (kanban_tickets.labels and, on a
 * markdown board, markdown_kanban_card_state.labels — JSON arrays), so every consumer (the card,
 * another Mac's view of the board, a move, a backup) draws them without the catalog.
 *
 * - A saved label (`kind: 'saved'`) points by id into the machine-wide catalog (ticket_labels).
 *   Renaming, recolouring, reordering or deleting it there rewrites the snapshots.
 * - A one-off label (`kind: 'once'`) lives only inside its ticket's JSON: it is never a catalog
 *   row, never offered on another ticket's menu, and once removed there is no record of it.
 *
 * Shared by the main process (persistence), the server child (zod, peers, backup) and the
 * renderer, so this file must stay free of node- and DOM-only imports.
 */

/** The preset palette (tokens, stored as is). Each is tuned for both themes in the renderer. */
export const TICKET_LABEL_COLORS = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink'
] as const

export type TicketLabelColor = (typeof TICKET_LABEL_COLORS)[number]

export type TicketLabelKind = 'saved' | 'once'

/** Longest label name, in characters (code points) after normalising. */
export const TICKET_LABEL_NAME_MAX = 32

/** Most labels one ticket carries; extra entries are dropped when parsing. */
export const TICKET_LABELS_MAX = 20

/** Most saved labels in the catalog. */
export const SAVED_TICKET_LABELS_MAX = 200

/** A colour token: a known palette entry, or (from a newer build) an unknown one kept as is. */
const COLOR_TOKEN_RE = /^[a-z][a-z0-9-]{0,23}$/

const ID_MAX = 64

/** A label as a ticket carries it. */
export interface TicketLabel {
  /** kind 'saved': the ticket_labels row id. kind 'once': a random id inside this ticket only. */
  id: string
  kind: TicketLabelKind
  /** As typed (normalised, never upper-cased): the card draws it in capitals with CSS. */
  name: string
  /** A TicketLabelColor; an unknown token (from a newer build) is kept and drawn as gray. */
  color: string
}

/** A catalog entry (ticket_labels row). */
export interface SavedTicketLabel {
  id: string
  name: string
  color: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface SavedTicketLabelCreate {
  name: string
  color: TicketLabelColor
}

export interface SavedTicketLabelUpdate {
  name?: string
  color?: TicketLabelColor
}

/** What a catalog edit changed, applied to every ticket that carries the label. */
export type SavedTicketLabelChange =
  | { type: 'update'; label: Pick<SavedTicketLabel, 'id' | 'name' | 'color'> }
  | { type: 'delete'; id: string }
  | { type: 'reorder'; ids: readonly string[] }

/** The result of a catalog edit that may rewrite tickets: the projects whose tickets changed. */
export interface SavedTicketLabelMutationResult {
  label: SavedTicketLabel | null
  affectedProjectIds: string[]
}

export function isTicketLabelColor(value: unknown): value is TicketLabelColor {
  return typeof value === 'string' && (TICKET_LABEL_COLORS as readonly string[]).includes(value)
}

export function isTicketLabelColorToken(value: unknown): value is string {
  return typeof value === 'string' && COLOR_TOKEN_RE.test(value)
}

/** NFKC, trimmed, inner whitespace collapsed to one space, cut to TICKET_LABEL_NAME_MAX. */
export function normalizeTicketLabelName(value: string): string {
  const collapsed = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  const chars = Array.from(collapsed)
  return chars.length > TICKET_LABEL_NAME_MAX
    ? chars.slice(0, TICKET_LABEL_NAME_MAX).join('').trimEnd()
    : collapsed
}

/**
 * The case-insensitive identity of a name ("Joy", " JOY " and "joy" are one label). Computed in
 * JS because SQLite's NOCASE only folds ASCII.
 */
export function ticketLabelNameKey(value: string): string {
  return normalizeTicketLabelName(value).toLowerCase()
}

/** One entry, normalised; null when it is not a usable label. */
export function parseTicketLabel(value: unknown): TicketLabel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const { id, kind, name, color } = entry
  if (typeof id !== 'string' || id.length === 0 || id.length > ID_MAX) return null
  if (kind !== 'saved' && kind !== 'once') return null
  if (typeof name !== 'string') return null
  const normalized = normalizeTicketLabelName(name)
  if (normalized.length === 0) return null
  return { id, kind, name: normalized, color: isTicketLabelColorToken(color) ? color : 'gray' }
}

/**
 * Tolerant reader for a ticket's labels: accepts the stored JSON string, an already-parsed
 * array, null or anything else. Keeps valid entries only (the first occurrence of an id wins),
 * at most TICKET_LABELS_MAX, and never throws. Used on read AND on write. Names are not
 * de-duplicated here: a rename that collides with a one-off on some ticket must not silently
 * drop the one-off (the create dialog keeps a name from being added twice).
 */
export function parseTicketLabels(value: unknown): TicketLabel[] {
  let parsed: unknown = value
  if (typeof value === 'string') {
    if (value.trim() === '') return []
    try {
      parsed = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []

  const labels: TicketLabel[] = []
  const ids = new Set<string>()
  for (const raw of parsed) {
    if (labels.length >= TICKET_LABELS_MAX) break
    const label = parseTicketLabel(raw)
    if (!label || ids.has(label.id)) continue
    ids.add(label.id)
    labels.push(label)
  }
  return labels
}

/** The labels of a ticket; [] for a row from an older build (another Mac) that has none. */
export function ticketLabelsOf(ticket: { labels?: readonly TicketLabel[] | null }): readonly TicketLabel[] {
  return ticket.labels ?? []
}

/** Catalog id -> position, for sorting a ticket's saved labels the way the catalog lists them. */
export function ticketLabelCatalogOrder(
  catalog: ReadonlyArray<Pick<SavedTicketLabel, 'id'>>
): ReadonlyMap<string, number> {
  return new Map(catalog.map((label, index) => [label.id, index]))
}

/**
 * The canonical order of a ticket's labels: saved labels in catalog order (one whose id the
 * catalog does not know keeps its place after the known ones), then one-offs in the order they
 * are in. Stable; returns the same array when it is already in order.
 */
export function sortTicketLabels<T extends TicketLabel>(
  labels: readonly T[],
  catalogOrder: ReadonlyMap<string, number>
): readonly T[] {
  const rank = (label: T, index: number): [number, number] => {
    if (label.kind === 'once') return [2, index]
    const position = catalogOrder.get(label.id)
    return position === undefined ? [1, index] : [0, position]
  }
  const ranked = labels.map((label, index) => ({ label, key: rank(label, index) }))
  ranked.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])
  const sorted = ranked.map((entry) => entry.label)
  return sorted.every((label, index) => label === labels[index]) ? labels : sorted
}

/**
 * A ticket's labels after a catalog edit. Returns the same array when the edit does not touch
 * this ticket, so callers can skip unchanged rows (and keep object identity in the renderer).
 * A reorder needs the catalog's new order of ids.
 */
export function applySavedTicketLabelChange(
  labels: readonly TicketLabel[],
  change: SavedTicketLabelChange
): readonly TicketLabel[] {
  switch (change.type) {
    case 'update': {
      const { id, name, color } = change.label
      let changed = false
      const next = labels.map((label) => {
        if (label.kind !== 'saved' || label.id !== id) return label
        if (label.name === name && label.color === color) return label
        changed = true
        return { ...label, name, color }
      })
      return changed ? next : labels
    }
    case 'delete': {
      const next = labels.filter((label) => !(label.kind === 'saved' && label.id === change.id))
      return next.length === labels.length ? labels : next
    }
    case 'reorder':
      return sortTicketLabels(labels, ticketLabelCatalogOrder(change.ids.map((id) => ({ id }))))
  }
}

/** True when the ticket's labels already include this name (case-insensitively). */
export function hasTicketLabelNamed(labels: readonly TicketLabel[], name: string): boolean {
  const key = ticketLabelNameKey(name)
  return labels.some((label) => label.name.toLowerCase() === key)
}

/**
 * A copy for another ticket (duplicate, model variants): saved labels as they are, every one-off
 * re-issued under a new id so the two tickets' one-offs are independent.
 */
export function copyTicketLabelsForNewTicket(
  labels: readonly TicketLabel[],
  newId: () => string
): TicketLabel[] {
  return labels.map((label) => (label.kind === 'once' ? { ...label, id: newId() } : { ...label }))
}
