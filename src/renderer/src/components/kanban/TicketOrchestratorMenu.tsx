import { ExternalLink, ListMinus, Plus, Workflow } from 'lucide-react'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { toast } from '@/lib/toast'
import {
  addableTicketRuns,
  integrationCheckoutGone,
  runItemOfTicket,
  runTitle
} from '@/lib/document-flow/ticket-run-membership'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { awaitsLaunch } from '@shared/document-flow/planning'
import {
  addingTicketsResumesRun,
  runKindLabel,
  ticketRunRefusal,
  type TicketRunOwner
} from '@shared/document-flow/ticket-runs'
import type { DocumentRun } from '@shared/types/document-flow'
import type { KanbanTicket } from '../../../../main/db/types'
import { useRunCheckouts } from './useRunCheckouts'

/** How many orchestrators the submenu lists to add the ticket to (newest first). */
const ORCHESTRATOR_MENU_RUN_LIMIT = 5

// A disabled row says why under its label: Radix gives a disabled item no pointer events, so a
// hover text would never show.
function ReasonLine({ reason }: { reason: string }) {
  return <span className="max-w-[260px] text-[11px] text-muted-foreground">{reason}</span>
}

const errorText = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message ? err.message : fallback

/**
 * The card's "Orchestrator" submenu, for a ticket an agent works on (the card hides it for a
 * run's own ticket, a shell command's ticket, an archived or a remote one): start an
 * orchestrator from the ticket, add it to one of the project's orchestrators, open the run it
 * is part of, or take it out again while it has not launched. The rows are mounted only while
 * the submenu is open, so only then does the card read the runs.
 */
export function TicketOrchestratorSubmenu({ ticket }: { ticket: KanbanTicket }) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger data-testid="ctx-orchestrator-submenu" className="gap-2">
        <Workflow className="h-3.5 w-3.5" />
        Orchestrator
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <TicketOrchestratorMenuItems ticket={ticket} />
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}

function TicketOrchestratorMenuItems({ ticket }: { ticket: KanbanTicket }) {
  const runsById = useDocumentFlowStore((s) => s.runsById)
  const { worktrees, connectionIds } = useRunCheckouts(ticket.project_id)

  // The run that holds the ticket now (one at a time), and the newest run it was ever part of
  // (what "Open" follows once that run is over)
  const membership = runItemOfTicket(ticket.id, runsById)
  const lastMembership = membership ?? runItemOfTicket(ticket.id, runsById, { anyStatus: true })
  const owner: TicketRunOwner | null = membership
    ? { runId: membership.run.id, title: runTitle(membership.run), status: membership.run.status }
    : null
  const newRefusal = ticketRunRefusal(ticket, owner)
  // A run that has it is opened, not offered again: the one that holds it now, and a finished
  // one it is still an item of (skipped, say), where adding it would change nothing (the
  // server leaves a ticket already in the run as it is) yet say the run resumes. A finished
  // one with no checkout left to resume on is not offered either, nor does it take a slot from
  // a run that can still take the ticket: the server would refuse the add
  const addable = addableTicketRuns(ticket.project_id, runsById)
    .filter(
      (run) =>
        run.id !== owner?.runId &&
        !runsById[run.id]?.items.some((item) => item.ticket_id === ticket.id) &&
        !(addingTicketsResumesRun(run) && integrationCheckoutGone(run, worktrees, connectionIds))
    )
    .slice(0, ORCHESTRATOR_MENU_RUN_LIMIT)
  const removable =
    membership !== null && membership.run.source_kind === 'tickets' && awaitsLaunch(membership.item)

  const handleNew = (): void => {
    useDocumentFlowStore.getState().openWizard(ticket.project_id, null, {
      source: 'tickets',
      preselectedTicketIds: [ticket.id]
    })
  }

  const handleAdd = async (run: DocumentRun): Promise<void> => {
    const resumes = addingTicketsResumesRun(run)
    try {
      await useDocumentFlowStore.getState().addRunTickets(run.id, [ticket.id])
      toast.success(
        resumes ? `Added to “${runTitle(run)}”; the run resumes` : `Added to “${runTitle(run)}”`
      )
    } catch (err) {
      toast.error(errorText(err, 'Could not add the ticket to the orchestrator'))
    }
  }

  const handleRemove = async (): Promise<void> => {
    if (!membership) return
    const { run, item } = membership
    try {
      await useDocumentFlowStore.getState().removeRunItem(run.id, item.id)
      toast.success(`Removed from “${runTitle(run)}”`)
    } catch (err) {
      toast.error(errorText(err, 'Could not remove the ticket from the orchestrator'))
    }
  }

  return (
    <>
      <ContextMenuItem
        data-testid="ctx-orchestrator-new"
        disabled={newRefusal !== null}
        onClick={handleNew}
        className="flex-col items-start gap-0.5"
      >
        <span className="flex items-center gap-2">
          <Plus className="h-3.5 w-3.5" />
          New orchestrator from this ticket…
        </span>
        {newRefusal && <ReasonLine reason={newRefusal} />}
      </ContextMenuItem>

      {addable.length > 0 && <ContextMenuSeparator />}
      {addable.map((run) => {
        const refusal = ticketRunRefusal(ticket, owner, run.id)
        return (
          <ContextMenuItem
            key={run.id}
            data-testid={`ctx-orchestrator-add-${run.id}`}
            textValue={run.title}
            disabled={refusal !== null}
            onClick={() => void handleAdd(run)}
            className="flex-col items-start gap-0.5"
          >
            <span className="flex max-w-[260px] items-center gap-2">
              <Workflow className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Add to “{runTitle(run)}”</span>
            </span>
            {refusal ? (
              <ReasonLine reason={refusal} />
            ) : (
              addingTicketsResumesRun(run) && <ReasonLine reason="It finished: the run resumes." />
            )}
          </ContextMenuItem>
        )
      })}

      {lastMembership && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            data-testid="ctx-orchestrator-open"
            onClick={() =>
              useDocumentFlowStore
                .getState()
                .openRun(lastMembership.run.project_id, lastMembership.run.id)
            }
            className="gap-2"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open {runKindLabel(lastMembership.run).toLowerCase()}
          </ContextMenuItem>
        </>
      )}
      {removable && (
        <ContextMenuItem
          data-testid="ctx-orchestrator-remove"
          onClick={() => void handleRemove()}
          className="gap-2"
        >
          <ListMinus className="h-3.5 w-3.5" />
          Remove from orchestrator
        </ContextMenuItem>
      )}
    </>
  )
}
