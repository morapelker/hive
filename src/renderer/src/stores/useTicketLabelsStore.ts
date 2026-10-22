import { create } from 'zustand'
import { ticketLabelsApi } from '@/api/ticket-labels-api'
import {
  SAVED_TICKET_LABELS_MAX,
  normalizeTicketLabelName,
  ticketLabelNameKey,
  type SavedTicketLabel,
  type SavedTicketLabelCreate,
  type SavedTicketLabelUpdate
} from '@shared/lib/ticket-labels'
import { useKanbanStore } from './useKanbanStore'

/**
 * The board-level label dialog that is open. `create` attaches the new label to one ticket
 * (`mode` picks the initial state of "Save for reuse"); `manage` edits the catalog. The ref
 * carries the project because markdown ticket ids are only unique per project.
 */
export type TicketLabelDialog =
  | { kind: 'create'; projectId: string; ticketId: string; mode: 'saved' | 'once' }
  | { kind: 'manage' }

interface TicketLabelsState {
  /** The machine-wide saved-label catalog, in its sort order. One-offs are never here. */
  labels: SavedTicketLabel[]
  /** The catalog has been fetched at least once. */
  loaded: boolean
  dialog: TicketLabelDialog | null

  /** Fetches the catalog. Never rejects: a failure is logged and leaves the current list. */
  load: () => Promise<void>
  /** Fetches the catalog unless it is loaded or a fetch is already running. */
  ensureLoaded: () => Promise<void>
  /** Rejects with a user-facing message (empty name, name clash, full catalog). */
  create: (data: SavedTicketLabelCreate) => Promise<SavedTicketLabel>
  /** Rename and/or recolour; rewrites the loaded tickets that carry the label. */
  update: (id: string, data: SavedTicketLabelUpdate) => Promise<void>
  /** Deletes the label and takes it off every loaded ticket. */
  remove: (id: string) => Promise<void>
  /** The new catalog order (unknown ids ignored, unlisted ones keep their order after it). */
  reorder: (ids: string[]) => Promise<void>
  /** Saved label id -> number of tickets that carry it (archived included). */
  usage: () => Promise<Record<string, number>>
  openDialog: (dialog: TicketLabelDialog) => void
  closeDialog: () => void
}

// Catalog writes in flight, and a counter bumped whenever one begins or ends. A list response
// is applied only when no write began or ended during its round-trip and none is still pending:
// the optimistic catalog is newer than anything the server sent before the write landed.
let writesInFlight = 0
let writeSeq = 0
let loadPromise: Promise<void> | null = null
// load() was called again while a fetch was in flight (a db:changed event): fetch once more.
let reloadRequested = false
// A list response was dropped because a write was in flight: fetch again once writes settle.
let reloadWhenSettled = false

function beginWrite(): () => void {
  writesInFlight++
  writeSeq++
  let ended = false
  return () => {
    if (ended) return
    ended = true
    writesInFlight--
    writeSeq++
    if (writesInFlight === 0 && reloadWhenSettled) {
      reloadWhenSettled = false
      void useTicketLabelsStore.getState().load()
    }
  }
}

function nameClashError(name: string): Error {
  return new Error(`A label named "${name}" already exists`)
}

/**
 * The checked, normalised name of a create or rename. Mirrors the DB's rules so the dialog
 * gets an immediate answer; the DB's unique name key still decides a race between windows.
 */
function checkedLabelName(
  catalog: readonly SavedTicketLabel[],
  name: string,
  exceptId?: string
): string {
  const normalized = normalizeTicketLabelName(name)
  if (normalized.length === 0) throw new Error('Label name is required')
  const key = ticketLabelNameKey(normalized)
  if (catalog.some((label) => label.id !== exceptId && ticketLabelNameKey(label.name) === key)) {
    throw nameClashError(normalized)
  }
  return normalized
}

/** The catalog ids in their new order: the listed known ids, then the rest as they were. */
function fullCatalogOrder(catalog: readonly SavedTicketLabel[], ids: readonly string[]): string[] {
  const known = new Set(catalog.map((label) => label.id))
  const listed = [...new Set(ids)].filter((id) => known.has(id))
  const placed = new Set(listed)
  return [...listed, ...catalog.filter((label) => !placed.has(label.id)).map((label) => label.id)]
}

/** The catalog sorted by `order` (ids it does not list go last, as they were), renumbered. */
function sortCatalog(
  catalog: readonly SavedTicketLabel[],
  order: readonly string[]
): SavedTicketLabel[] {
  const position = new Map(order.map((id, index) => [id, index]))
  return catalog
    .map((label, index) => ({ label, at: position.get(label.id) ?? order.length + index }))
    .sort((a, b) => a.at - b.at)
    .map(({ label }, index) =>
      label.sort_order === index ? label : { ...label, sort_order: index }
    )
}

/**
 * The saved-label catalog (ticket_labels): one list for every project on this Mac, so unlike
 * favourites nothing is persisted locally — it always comes from the DB.
 *
 * Rename, recolour, reorder and delete are optimistic and roll back on failure. Once the DB
 * confirms, the change is mirrored on the loaded tickets through
 * useKanbanStore.applySavedLabelChange: the DB rewrote their label snapshots, but this
 * renderer ignores the db:changed events it caused itself, so the board would keep showing
 * the old names otherwise.
 */
export const useTicketLabelsStore = create<TicketLabelsState>()((set, get) => ({
  labels: [],
  loaded: false,
  dialog: null,

  load: () => {
    if (loadPromise) {
      reloadRequested = true
      return loadPromise
    }
    loadPromise = (async () => {
      try {
        for (;;) {
          reloadRequested = false
          const seqAtStart = writeSeq
          const labels = await ticketLabelsApi.list()
          if (writesInFlight > 0) {
            // The response may predate a write still in flight; the last write to settle
            // fetches again.
            reloadWhenSettled = true
            return
          }
          // A write landed during the round-trip, or a newer change was announced: the
          // response may be older than what the store shows, so fetch again.
          if (writeSeq !== seqAtStart || reloadRequested) continue
          // A malformed answer must not leave the menus without a list to map over
          set({ labels: Array.isArray(labels) ? labels : [], loaded: true })
          return
        }
      } catch (err) {
        console.error('Failed to load ticket labels:', err)
      } finally {
        loadPromise = null
      }
    })()
    return loadPromise
  },

  ensureLoaded: () => {
    if (get().loaded) return Promise.resolve()
    return loadPromise ?? get().load()
  },

  create: async (data) => {
    const catalog = get().labels
    const name = checkedLabelName(catalog, data.name)
    if (catalog.length >= SAVED_TICKET_LABELS_MAX) throw new Error('Too many labels')

    const end = beginWrite()
    try {
      const created = await ticketLabelsApi.create({ name, color: data.color })
      set((state) => ({
        labels: [...state.labels.filter((label) => label.id !== created.id), created]
      }))
      return created
    } finally {
      end()
    }
  },

  update: async (id, data) => {
    const previous = get().labels.find((label) => label.id === id)
    const patch: SavedTicketLabelUpdate = {}
    if (data.name !== undefined) patch.name = checkedLabelName(get().labels, data.name, id)
    if (data.color !== undefined) patch.color = data.color
    if (
      previous &&
      (patch.name ?? previous.name) === previous.name &&
      (patch.color ?? previous.color) === previous.color
    ) {
      return
    }

    const end = beginWrite()
    set((state) => ({
      labels: state.labels.map((label) => (label.id === id ? { ...label, ...patch } : label))
    }))
    try {
      const { label: updated } = await ticketLabelsApi.update(id, patch)
      if (!updated) {
        // Deleted from another window meanwhile: its tickets were rewritten by that delete.
        set((state) => ({ labels: state.labels.filter((label) => label.id !== id) }))
        return
      }
      set((state) => ({
        labels: state.labels.map((label) => (label.id === id ? updated : label))
      }))
      useKanbanStore.getState().applySavedLabelChange({
        type: 'update',
        label: { id, name: updated.name, color: updated.color }
      })
    } catch (err) {
      if (previous) {
        set((state) => ({
          labels: state.labels.map((label) => (label.id === id ? previous : label))
        }))
      }
      throw err
    } finally {
      end()
    }
  },

  remove: async (id) => {
    const index = get().labels.findIndex((label) => label.id === id)
    const removed = index === -1 ? undefined : get().labels[index]

    const end = beginWrite()
    set((state) => ({ labels: state.labels.filter((label) => label.id !== id) }))
    try {
      await ticketLabelsApi.delete(id)
      useKanbanStore.getState().applySavedLabelChange({ type: 'delete', id })
    } catch (err) {
      if (removed) {
        set((state) => {
          if (state.labels.some((label) => label.id === id)) return state
          const labels = [...state.labels]
          labels.splice(Math.min(index, labels.length), 0, removed)
          return { labels }
        })
      }
      throw err
    } finally {
      end()
    }
  },

  reorder: async (ids) => {
    const before = get().labels
    const order = fullCatalogOrder(before, ids)
    if (order.every((id, index) => before[index]?.id === id)) return
    const previousOrder = before.map((label) => label.id)

    const end = beginWrite()
    set((state) => ({ labels: sortCatalog(state.labels, order) }))
    try {
      await ticketLabelsApi.reorder(order)
      useKanbanStore.getState().applySavedLabelChange({ type: 'reorder', ids: order })
    } catch (err) {
      set((state) => ({ labels: sortCatalog(state.labels, previousOrder) }))
      throw err
    } finally {
      end()
    }
  },

  usage: () => ticketLabelsApi.usage(),

  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set((state) => (state.dialog === null ? state : { dialog: null }))
}))
