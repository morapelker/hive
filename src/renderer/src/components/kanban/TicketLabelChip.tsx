import { cn } from '@/lib/utils'
import { TICKET_LABEL_CHIP_BASE, ticketLabelChipColorClass } from '@/lib/ticket-label-colors'
import type { TicketLabel } from '@shared/lib/ticket-labels'

interface TicketLabelChipProps {
  /** A ticket's label or a catalog entry: only the name and the colour are drawn. */
  label: Pick<TicketLabel, 'name' | 'color'>
  className?: string
  /** Faded: a label the open Labels menu still lists but the ticket no longer carries. */
  dimmed?: boolean
  /** Hover text; the name by default, so a truncated chip can still be read in full. */
  title?: string
}

/**
 * One ticket label as the board draws it: the name in capitals (CSS only — the text stays as
 * typed, so copying it, typeahead and screen readers get the real name) on its colour's tint.
 * The same chip is the card's, the menu row's and the dialogs' live preview, so what you pick
 * is exactly what the card shows. Never interactive on its own.
 */
export function TicketLabelChip({ label, className, dimmed, title }: TicketLabelChipProps) {
  return (
    <span
      data-testid="ticket-label-chip"
      title={title ?? label.name}
      className={cn(
        TICKET_LABEL_CHIP_BASE,
        ticketLabelChipColorClass(label.color),
        dimmed && 'opacity-60',
        className
      )}
    >
      <span className="truncate">{label.name}</span>
    </span>
  )
}

interface TicketLabelRowProps {
  labels: readonly TicketLabel[]
  className?: string
}

/**
 * The card's label row: every label, in the ticket's order, wrapping onto more lines rather
 * than hiding any behind a "+N". Renders nothing for a ticket without labels, so the card keeps
 * no empty gap. The chips are display-only: the card stays one click / drag target, and labels
 * change only through the context menu (the path that can undo an accidental removal).
 */
export function TicketLabelRow({ labels, className }: TicketLabelRowProps) {
  if (labels.length === 0) return null
  return (
    <div
      data-testid="ticket-labels"
      className={cn('mt-1.5 flex flex-wrap items-center gap-1', className)}
    >
      {labels.map((label) => (
        <TicketLabelChip key={label.id} label={label} />
      ))}
    </div>
  )
}
