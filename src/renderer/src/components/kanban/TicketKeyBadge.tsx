import { CornerDownRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ticketKeyOf } from '@shared/ticket-key'
import type { KanbanTicket } from '../../../../main/db/types'

/**
 * The Jira-like ticket key (`TD-12`) as a small identifier chip.
 *
 * Reads as an identifier rather than prose: monospace, tabular digits, uppercase, muted on a
 * faint tinted background. Renders nothing when the ticket has no key — markdown-backed cards
 * and rows from older builds or peers carry null prefix/number — so every surface can mount it
 * unconditionally. An orchestrator child shows its parent run's key first, dimmer, so it is
 * obvious which run the ticket belongs to.
 *
 * Deliberately non-interactive (the card hosting it is draggable) but text-selectable so the
 * key can be copied.
 */

const chipClass =
  'inline-flex items-center rounded-[4px] bg-muted/70 px-1 py-px font-mono text-[10px] font-medium uppercase tabular-nums tracking-tight leading-[1.3] text-muted-foreground shrink-0 select-text'

const variantClass = {
  card: '',
  modal: 'text-[11px] px-1.5'
} as const

interface TicketKeyBadgeProps {
  ticket: Pick<KanbanTicket, 'ticket_prefix' | 'ticket_number' | 'parent_ticket_key'>
  variant?: 'card' | 'modal'
  className?: string
  /** Show the parent run's key before the own key (default). Off for compact list rows. */
  showParent?: boolean
}

export function TicketKeyBadge({
  ticket,
  variant = 'card',
  className,
  showParent = true
}: TicketKeyBadgeProps): React.JSX.Element | null {
  const key = ticketKeyOf(ticket)
  if (!key) return null

  const parentKey = showParent ? ticket.parent_ticket_key : null

  return (
    <span
      className={cn(chipClass, variantClass[variant], className)}
      data-testid="ticket-key-badge"
    >
      {parentKey && (
        <>
          <span
            data-testid="ticket-parent-key"
            title={`Part of orchestrator ${parentKey}`}
            className="inline-flex items-center gap-px text-muted-foreground/60"
          >
            <CornerDownRight className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} aria-hidden />
            {parentKey}
          </span>
          <span aria-hidden className="px-0.5 text-muted-foreground/40">
            ›
          </span>
        </>
      )}
      <span data-testid="ticket-key" title={`Ticket ${key}`}>
        {key}
      </span>
    </span>
  )
}
