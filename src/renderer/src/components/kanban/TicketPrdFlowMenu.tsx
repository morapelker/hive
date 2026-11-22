import { FileText, Pencil, Play, RotateCw, X } from 'lucide-react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { cancelPrdFlow, retryPrdFlow } from '@/lib/prd-flow/actions'
import {
  discardPrdFlowDraft,
  launchSavedPrdFlowDraft,
  useLivePrdFlowDraft
} from '@/lib/prd-flow/draft'
import { usePrdFlowStore, useTicketPrdFlow } from '@/stores/usePrdFlowStore'
import type { KanbanTicket } from '../../../../main/db/types'

/**
 * The card's items for a ticket made with "New PRD → orchestrator ticket…". While its flow
 * is on: "Retry PRD flow" once the flow stopped and needs the person, "Cancel PRD flow" for as
 * long as the ticket has a flow. Cancelling forgets the flow and nothing else: the ticket and
 * its session stay as they are. While it is a draft that was saved for later: "Edit PRD
 * draft…" (the form it was saved from), "Launch PRD flow", and "Convert to ordinary ticket",
 * which forgets the draft and keeps the ticket. A ticket with neither gets none of them.
 */
export function TicketPrdFlowMenuItems({
  ticket,
  archived = false
}: {
  ticket: KanbanTicket
  /** The card is shown as archived: a draft is not offered there. */
  archived?: boolean
}) {
  const flow = useTicketPrdFlow(ticket.id)
  const liveDraft = useLivePrdFlowDraft(ticket)
  const draft = archived ? null : liveDraft

  if (!flow) {
    if (!draft) return null
    return (
      <>
        <ContextMenuItem
          data-testid="ctx-prd-draft-edit"
          onSelect={() => usePrdFlowStore.getState().openDialog(ticket.project_id, ticket.id)}
          className="gap-2"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit PRD draft…
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="ctx-prd-draft-launch"
          onSelect={() => void launchSavedPrdFlowDraft(ticket.id)}
          className="gap-2"
        >
          <Play className="h-3.5 w-3.5" />
          Launch PRD flow
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="ctx-prd-draft-discard"
          onSelect={() => discardPrdFlowDraft(ticket.id)}
          className="gap-2"
        >
          <FileText className="h-3.5 w-3.5" />
          Convert to ordinary ticket
        </ContextMenuItem>
      </>
    )
  }

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
