import { CornerDownRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TICKET_KEY_COLOR_CLASS, ticketKeyColorStyle } from '@/lib/ticket-key-color'
import { ticketKeyVisible } from '@/lib/ticket-key-display'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { isDocumentRunTicket } from '@shared/document-flow/run-ticket'
import { ticketKeyOf } from '@shared/ticket-key'
import type { KanbanTicket } from '../../../../main/db/types'

export { ticketKeyVisible }

/**
 * The Jira-like ticket key (`TD-12`) as a small identifier chip.
 *
 * Reads as an identifier rather than prose: monospace, tabular digits, uppercase, muted on a
 * faint tinted background. Renders nothing when the ticket has no key — markdown-backed cards
 * and rows from older builds or peers carry null prefix/number — so every surface can mount it
 * unconditionally. The "Ticket IDs" setting narrows it further: never, or only on orchestrator
 * (Implement document) run tickets and their children.
 *
 * A run's key is painted in a colour hashed from the key (lib/ticket-key-color.ts): the run's
 * own chip and the "parent ›" segment on each of its children share it, so one glance tells
 * which cards belong to which run. Deliberately non-interactive (the card hosting it is
 * draggable) but text-selectable so the key can be copied.
 */

const chipClass =
  'inline-flex items-center rounded-[4px] bg-muted/70 px-1 py-px font-mono text-[10px] font-medium uppercase tabular-nums tracking-tight leading-[1.3] text-muted-foreground shrink-0 select-text'

const variantClass = {
  card: '',
  modal: 'text-[11px] px-1.5'
} as const

/** A coloured segment is its own small chip inside the row, so the tint has a shape. */
const coloredSegmentClass = `rounded-[3px] px-1 -mx-px font-semibold ${TICKET_KEY_COLOR_CLASS}`

export type TicketKeyBadgeTicket = Pick<
  KanbanTicket,
  'ticket_prefix' | 'ticket_number' | 'parent_ticket_key' | 'external_provider' | 'external_id'
>

interface TicketKeyBadgeProps {
  ticket: TicketKeyBadgeTicket
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
  const display = useSettingsStore((s) => s.ticketKeyDisplay)
  const key = ticketKeyOf(ticket)
  if (!key || !ticketKeyVisible(display, ticket)) return null

  const parentKey = showParent ? ticket.parent_ticket_key : null
  const isRun = isDocumentRunTicket(ticket)

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
            className={cn('inline-flex items-center gap-px', coloredSegmentClass)}
            style={ticketKeyColorStyle(parentKey)}
          >
            <CornerDownRight className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} aria-hidden />
            {parentKey}
          </span>
          <span aria-hidden className="px-0.5 text-muted-foreground/40">
            ›
          </span>
        </>
      )}
      <span
        data-testid="ticket-key"
        title={isRun ? `Orchestrator ${key}` : `Ticket ${key}`}
        className={cn(isRun && coloredSegmentClass)}
        style={isRun ? ticketKeyColorStyle(key) : undefined}
      >
        {key}
      </span>
    </span>
  )
}
