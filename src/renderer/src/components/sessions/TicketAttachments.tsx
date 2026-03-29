import { X, KanbanSquare } from 'lucide-react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { Attachment } from './AttachmentPreview'

// ── Column labels for ticket attachment cards ───────────────────────
const COLUMN_LABELS: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done'
}

interface TicketAttachmentsProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
}

export function TicketAttachments({
  attachments,
  onRemove
}: TicketAttachmentsProps): React.JSX.Element | null {
  const ticketAttachments = attachments.filter(
    (a): a is Extract<Attachment, { kind: 'ticket' }> => a.kind === 'ticket'
  )
  if (ticketAttachments.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mb-2" data-testid="ticket-attachments">
      {ticketAttachments.map((t) => {
        // Look up the ticket's current column from the kanban store (read-only)
        const allTickets = useKanbanStore.getState().tickets
        let columnLabel = ''
        for (const tickets of allTickets.values()) {
          const found = tickets.find((kt) => kt.id === t.ticketId)
          if (found) {
            columnLabel = COLUMN_LABELS[found.column] ?? found.column
            break
          }
        }

        return (
          <div
            key={t.id}
            className="group relative flex flex-col gap-1 px-3 py-2 rounded-lg bg-background border border-border text-sm max-w-[400px] min-w-[220px]"
            data-testid="attachment-item-ticket"
          >
            <div className="flex items-center gap-2">
              <KanbanSquare className="h-3.5 w-3.5 shrink-0 text-blue-400" />
              <span className="font-medium text-foreground truncate">{t.title}</span>
              <button
                onClick={() => onRemove(t.id)}
                className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {columnLabel && (
              <span className="text-xs text-muted-foreground">{columnLabel}</span>
            )}
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
}
