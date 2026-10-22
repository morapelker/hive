import type { SavedTicketLabel } from '@shared/lib/ticket-labels'

const NO_SAVED_LABELS: readonly SavedTicketLabel[] = []

/**
 * The saved-label catalog as the labels store holds it — a zustand selector for the label
 * menu and dialogs. Empty until it loads; tolerant of a store that holds no list (a test's
 * hand-set state), since a card's context menu must never throw over the catalog.
 */
export function savedTicketLabelsOf(state: {
  labels: readonly SavedTicketLabel[] | null | undefined
}): readonly SavedTicketLabel[] {
  return Array.isArray(state.labels) ? state.labels : NO_SAVED_LABELS
}

/** The ids in a catalog, for telling saved labels from ticket-only ones. */
export function catalogIdsOf(catalog: readonly SavedTicketLabel[]): ReadonlySet<string> {
  return new Set(catalog.map((label) => label.id))
}
