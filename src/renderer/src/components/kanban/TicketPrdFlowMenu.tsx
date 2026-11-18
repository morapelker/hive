import { RotateCw, X } from 'lucide-react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { cancelPrdFlow, retryPrdFlow } from '@/lib/prd-flow/actions'
import { useTicketPrdFlow } from '@/stores/usePrdFlowStore'
import type { KanbanTicket } from '../../../../main/db/types'

/**
 * The card's two items for a ticket made with "New PRD → orchestrator ticket…": "Retry PRD
 * flow" while the flow stopped and needs the person, "Cancel PRD flow" for as long as the
 * ticket has a flow. Cancelling forgets the flow and nothing else: the ticket and its session
 * stay as they are. A ticket with no flow gets neither.
 */
export function TicketPrdFlowMenuItems({ ticket }: { ticket: KanbanTicket }) {
  const flow = useTicketPrdFlow(ticket.id)
  if (!flow) return null

  return (
    <>
      {flow.status === 'needs_attention' && (
        <ContextMenuItem
          data-testid="ctx-prd-flow-retry"
          onSelect={() => void retryPrdFlow(ticket.id)}
          className="gap-2"
        >
          <RotateCw className="h-3.5 w-3.5" />
          Retry PRD flow
        </ContextMenuItem>
      )}
      <ContextMenuItem
        data-testid="ctx-prd-flow-cancel"
        onSelect={() => void cancelPrdFlow(ticket.id)}
        className="gap-2 text-destructive focus:text-destructive"
      >
        <X className="h-3.5 w-3.5" />
        Cancel PRD flow
      </ContextMenuItem>
    </>
  )
}
