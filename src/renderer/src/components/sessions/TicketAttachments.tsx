import { memo } from 'react'
import { X, KanbanSquare } from 'lucide-react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { TicketKeyBadge } from '../kanban/TicketKeyBadge'
import type { TicketAttachment } from './AttachmentPreview'
import type { KanbanTicket } from '../../../../main/db/types'

// ── Column labels for ticket attachment cards ───────────────────────
const COLUMN_LABELS: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done'
}

interface TicketAttachmentsProps {
  ticketAttachments: TicketAttachment[]
  onRemove: (id: string) => void
}

export const TicketAttachments = memo(function TicketAttachments({
  ticketAttachments,
  onRemove
}: TicketAttachmentsProps): React.JSX.Element | null {
  if (ticketAttachments.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mb-2" data-testid="ticket-attachments">
      {ticketAttachments.map((t) => {
        // Look up the live ticket in the kanban store (read-only) for its column and key;
        // the attachment itself only carries the title captured when it was attached.
        const allTickets = useKanbanStore.getState().tickets
        let liveTicket: KanbanTicket | undefined
        for (const tickets of allTickets.values()) {
          liveTicket = tickets.find((kt) => kt.id === t.ticketId)
          if (liveTicket) break
        }
        const columnLabel = liveTicket
          ? (COLUMN_LABELS[liveTicket.column] ?? liveTicket.column)
          : ''

        return (
          <div
            key={t.id}
            className="group relative flex flex-col gap-1 px-3 py-2 rounded-lg bg-background border border-border text-sm max-w-[400px] min-w-[220px]"
            data-testid="attachment-item-ticket"
          >
            <div className="flex items-center gap-2">
              <KanbanSquare className="h-3.5 w-3.5 shrink-0 text-blue-400" />
              {liveTicket && <TicketKeyBadge ticket={liveTicket} showParent={false} />}
              <span className="font-medium text-foreground truncate">{t.title}</span>
              <button
                onClick={() => onRemove(t.id)}
                className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {columnLabel && <span className="text-xs text-muted-foreground">{columnLabel}</span>}
            {t.description && (
              <span className="text-xs text-muted-foreground line-clamp-2">
                {t.description.length > 120 ? t.description.slice(0, 120) + '...' : t.description}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
})
