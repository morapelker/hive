import { useMemo } from 'react'
import { PenLine, Plus, Settings2, Tag } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { useTicketLabelsStore, type TicketLabelDialog } from '@/stores/useTicketLabelsStore'
import { setTicketLabel } from '@/lib/ticket-label-toggle'
import {
  canAddTicketLabel,
  isTicketLabelNameTaken,
  ticketOnlyLabelRows,
  type TicketLabelSession
} from '@/lib/ticket-label-session'
import type { TicketLabel } from '@shared/lib/ticket-labels'
import { TicketLabelChip } from './TicketLabelChip'
import { catalogIdsOf, savedTicketLabelsOf } from './ticket-label-catalog'

const NO_SESSION: TicketLabelSession = []

const REMOVED_ROW_TITLE = 'Removed — tick to restore; it is gone once this menu closes'

const NAME_TAKEN_TITLE = 'Already on this ticket'

// A disabled row ignores the pointer, so its hover text would never show: this one lets the
// pointer through (Radix still neither focuses nor selects a disabled item)
const NAME_TAKEN_ROW_CLASS = 'data-[disabled]:pointer-events-auto'

/** Opens a board-level label dialog once the menu has closed (see the action items below). */
function openDialogAfterMenu(dialog: TicketLabelDialog): void {
  requestAnimationFrame(() => useTicketLabelsStore.getState().openDialog(dialog))
}

interface TicketLabelsMenuProps {
  projectId: string
  ticketId: string
  /** The ticket's labels now (the card's live copy). */
  labels: readonly TicketLabel[]
  /** The open menu's one-off memory (useTicketLabelSession, owned by the card). */
  session: TicketLabelSession | null
}

/**
 * The rows of the Labels submenu. Mounted only while the submenu is open, so it is the one
 * place that subscribes to the catalog: hundreds of cards on a board do not re-render when a
 * label is renamed.
 *
 * Rows never move or vanish while the menu is open: ticking keeps the menu open (the item's
 * onSelect is prevented) for several picks, and an unticked one-off stays listed, faded, until
 * the menu closes.
 */
export function TicketLabelsMenuItems({ projectId, ticketId, labels, session }: TicketLabelsMenuProps) {
  const catalog = useTicketLabelsStore(savedTicketLabelsOf)
  const loaded = useTicketLabelsStore((s) => s.loaded)
  const catalogIds = useMemo(() => catalogIdsOf(catalog), [catalog])

  const memory = session ?? NO_SESSION
  const attached = new Set(labels.map((label) => label.id))
  const ticketOnlyRows = ticketOnlyLabelRows(memory, labels, catalogIds)
  const canAdd = canAddTicketLabel(labels)
  const hasSavedSection = !loaded || catalog.length > 0

  // The toggle module serialises writes per ticket and reports a failure itself (its promise
  // never rejects); the menu has no use for the outcome
  const toggle = (label: TicketLabel, on: boolean): void => {
    void setTicketLabel({ projectId, ticketId }, label, on, memory)
  }

  return (
    <>
      {!loaded && catalog.length === 0 && (
        <ContextMenuItem disabled className="text-xs text-muted-foreground">
          Loading…
        </ContextMenuItem>
      )}
      {catalog.map((saved) => {
        const checked = attached.has(saved.id)
        // Another label on the ticket has this name (a one-off may share a saved name)
        const nameTaken = !checked && isTicketLabelNameTaken(labels, saved)
        return (
          <ContextMenuCheckboxItem
            key={saved.id}
            data-testid={`ctx-label-${saved.id}`}
            textValue={saved.name}
            checked={checked}
            disabled={!checked && (!canAdd || nameTaken)}
            className={cn(nameTaken && NAME_TAKEN_ROW_CLASS)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) =>
              toggle({ id: saved.id, kind: 'saved', name: saved.name, color: saved.color }, on)
            }
          >
            <TicketLabelChip
              label={saved}
              title={nameTaken ? NAME_TAKEN_TITLE : undefined}
              className="max-w-[200px]"
            />
          </ContextMenuCheckboxItem>
        )
      })}

      {ticketOnlyRows.length > 0 && (
        <>
          {hasSavedSection && <ContextMenuSeparator />}
          <ContextMenuLabel className="py-1 text-[10px] font-semibold tracking-wider">
            This ticket only
          </ContextMenuLabel>
          {ticketOnlyRows.map(({ label, checked }) => {
            // A label of this name went on after this one came off
            const nameTaken = !checked && isTicketLabelNameTaken(labels, label)
            return (
              <ContextMenuCheckboxItem
                key={label.id}
                data-testid={`ctx-label-${label.id}`}
                data-removed={checked ? undefined : ''}
                textValue={label.name}
                checked={checked}
                disabled={!checked && (!canAdd || nameTaken)}
                className={cn(nameTaken && NAME_TAKEN_ROW_CLASS)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) => toggle(label, on)}
              >
                <TicketLabelChip
                  label={label}
                  dimmed={!checked}
                  title={checked ? undefined : nameTaken ? NAME_TAKEN_TITLE : REMOVED_ROW_TITLE}
                  className="max-w-[200px]"
                />
              </ContextMenuCheckboxItem>
            )
          })}
        </>
      )}

      {loaded && catalog.length === 0 && ticketOnlyRows.length === 0 && (
        <ContextMenuItem disabled className="text-xs text-muted-foreground">
          No labels yet
        </ContextMenuItem>
      )}

      {/* The actions close the menu (no preventDefault) and open a board-level dialog on the
          next frame: opening a Radix dialog while the menu is still tearing down can leave
          the body's pointer-events locked and the two fighting over focus */}
      <ContextMenuSeparator />
      <ContextMenuItem
        data-testid="ctx-label-new"
        disabled={!canAdd}
        onSelect={() => openDialogAfterMenu({ kind: 'create', projectId, ticketId, mode: 'saved' })}
        className="gap-2"
      >
        <Plus className="h-3.5 w-3.5" />
        New label…
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="ctx-label-one-off"
        disabled={!canAdd}
        onSelect={() => openDialogAfterMenu({ kind: 'create', projectId, ticketId, mode: 'once' })}
        className="gap-2"
      >
        <PenLine className="h-3.5 w-3.5" />
        One-off label…
      </ContextMenuItem>
      {catalog.length > 0 && (
        <ContextMenuItem
          data-testid="ctx-labels-manage"
          onSelect={() => openDialogAfterMenu({ kind: 'manage' })}
          className="gap-2"
        >
          <Settings2 className="h-3.5 w-3.5" />
          Manage labels…
        </ContextMenuItem>
      )}
    </>
  )
}

/**
 * The "Labels" entry of a local ticket's context menu: the trigger (with the number of labels
 * the ticket carries) and the submenu. Not offered on another Mac's tickets: their labels are
 * drawn read-only.
 */
export function TicketLabelsSubmenu(props: TicketLabelsMenuProps) {
  const count = props.labels.length
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger
        data-testid="ctx-labels-submenu"
        // The count sits right before the chevron: the chevron gives up its own auto margin
        className={cn('gap-2', count > 0 && '[&>svg:last-child]:ml-0')}
      >
        <Tag className="h-3.5 w-3.5" />
        Labels
        {count > 0 && (
          <span
            data-testid="ctx-labels-count"
            className="ml-auto pl-2 text-[11px] tabular-nums text-muted-foreground"
          >
            {count}
          </span>
        )}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="min-w-[220px] max-w-[280px] max-h-[360px] overflow-y-auto">
        <TicketLabelsMenuItems {...props} />
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}
