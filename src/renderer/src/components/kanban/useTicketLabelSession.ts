import { useCallback, useEffect, useState } from 'react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useTicketLabelsStore } from '@/stores/useTicketLabelsStore'
import {
  extendTicketLabelSession,
  openTicketLabelSession,
  type TicketLabelSession
} from '@/lib/ticket-label-session'
import { ticketLabelsOf, type TicketLabel } from '@shared/lib/ticket-labels'
import { catalogIdsOf, savedTicketLabelsOf } from './ticket-label-catalog'

const NO_LABELS: readonly TicketLabel[] = []

/** The ids of the catalog the store holds right now (outside React). */
const currentCatalogIds = (): ReadonlySet<string> =>
  catalogIdsOf(savedTicketLabelsOf(useTicketLabelsStore.getState()))

interface TicketLabelSessionOptions {
  projectId: string
  ticketId: string
  /** The ticket's labels as the card has them (undefined on a row from an older build). */
  labels: readonly TicketLabel[] | undefined
  /** False for a ticket whose menu has no Labels submenu (another Mac's): no session then. */
  enabled: boolean
}

/**
 * The one-off memory of the card's Labels menu, owned by the card's ROOT context menu: Radix
 * unmounts the submenu's content whenever the pointer leaves it, so a memory kept there would
 * forget a removed one-off while the menu is still open. Wire `onMenuOpenChange` to the root
 * <ContextMenu onOpenChange>.
 *
 * On open it snapshots the ticket's ticket-only labels (from the store, the freshest copy);
 * while open it remembers any that appear (a one-off ticked back on, or one added elsewhere);
 * on close it drops everything — the state is the only place a removed one-off is held, so the
 * next opening cannot list it.
 */
export function useTicketLabelSession({
  projectId,
  ticketId,
  labels,
  enabled
}: TicketLabelSessionOptions): {
  session: TicketLabelSession | null
  onMenuOpenChange: (open: boolean) => void
} {
  const [session, setSession] = useState<TicketLabelSession | null>(null)
  const current = labels ?? NO_LABELS
  const isOpen = session !== null

  const onMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!open || !enabled) {
        setSession(null)
        return
      }
      // The board loads the catalog on mount; this covers a failed or raced first load
      useTicketLabelsStore.getState().ensureLoaded().catch(() => undefined)
      const latest = useKanbanStore
        .getState()
        .tickets.get(projectId)
        ?.find((t) => t.id === ticketId)
      setSession(
        openTicketLabelSession(latest ? ticketLabelsOf(latest) : current, currentCatalogIds())
      )
    },
    [enabled, projectId, ticketId, current]
  )

  // While the menu is open, a ticket-only label that shows up on the ticket joins the memory,
  // so unticking it later keeps its row
  useEffect(() => {
    if (!isOpen) return
    const catalogIds = currentCatalogIds()
    setSession((prev) => (prev === null ? prev : extendTicketLabelSession(prev, current, catalogIds)))
  }, [isOpen, current])

  return { session, onMenuOpenChange }
}
