import { useEffect, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import {
  addingTicketsResumesRun,
  canAddTicketsToRun,
  runKindLabel
} from '@shared/document-flow/ticket-runs'
import type { DocumentRun } from '@shared/types/document-flow'
import { pluralize } from './document-flow-ui'
import { addTicketsLabel, orderTicketIdsForRun } from './ticket-run-ui'
import { TicketRunPicker } from './TicketRunPicker'
import { useBoardTicketsForRun } from './useTicketRunBoard'

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

interface AddRunTicketsDialogProps {
  run: DocumentRun
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** What adding tickets does to the run, by where the run stands. */
function describeAdding(run: DocumentRun): string {
  if (run.status === 'preview') {
    return 'They join the tickets you are reviewing, each with its board dependencies on the tickets of the run.'
  }
  if (addingTicketsResumesRun(run)) {
    return 'The run is finished. Adding tickets resumes it: they launch on its integration branch, which already holds the work merged so far.'
  }
  if (run.status === 'paused') {
    return 'The run is paused: they launch from its integration branch once it resumes, as soon as their dependencies are merged and a slot is free; tickets already at work are not touched.'
  }
  return "They launch from the run's integration branch as soon as their dependencies are merged and a slot is free; tickets already at work are not touched."
}

/**
 * "Add tickets" of a run made from board tickets: pick more of the project's board tickets
 * (the run's own are shown checked and locked) and the run adopts them, in dependency order.
 * Before launch they join the preview; while the run goes they launch when their turn comes;
 * a finished run (completed, with or without issues) resumes for them. A cancelled run, or
 * one whose migrations are running, takes none.
 */
export function AddRunTicketsDialog({
  run,
  open,
  onOpenChange
}: AddRunTicketsDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="flex max-h-[80vh] max-w-xl flex-col"
        data-docflow-dialog=""
        data-testid="docflow-add-tickets-dialog"
      >
        <DialogHeader>
          <DialogTitle>Add tickets to {run.title || runKindLabel(run)}</DialogTitle>
          <DialogDescription>{describeAdding(run)}</DialogDescription>
        </DialogHeader>
        {/* Mounted with the content, so every opening starts from a fresh pick and board. */}
        <AddRunTicketsBody
          run={run}
          busy={busy}
          onBusyChange={setBusy}
          onDone={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function AddRunTicketsBody({
  run,
  busy,
  onBusyChange,
  onDone,
  onCancel
}: {
  run: DocumentRun
  busy: boolean
  onBusyChange: (busy: boolean) => void
  onDone: () => void
  onCancel: () => void
}): React.JSX.Element {
  const addRunTickets = useDocumentFlowStore((s) => s.addRunTickets)
  const board = useBoardTicketsForRun(run.project_id, run.id)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const picked = selectedIds.filter((id) => board.refusalOf(id) === null)
  const allowed = canAddTicketsToRun(run)
  const resumes = addingTicketsResumesRun(run)

  // The run may change under the open dialog (it launched, finished, was cancelled).
  useEffect(() => {
    if (!allowed) setSelectedIds([])
  }, [allowed])

  const submit = async (): Promise<void> => {
    if (picked.length === 0 || busy) return
    const ordered = orderTicketIdsForRun(
      picked,
      board.tickets.map((ticket) => ticket.id),
      board.blockersOf
    )
    onBusyChange(true)
    try {
      const detail = await addRunTickets(run.id, ordered)
      toast.success(
        `Added ${pluralize(ordered.length, 'ticket')} to ${detail.run.title || runKindLabel(detail.run)}`
      )
      onDone()
    } catch (cause) {
      toast.error(`Could not add the tickets: ${errorMessage(cause)}`)
    } finally {
      onBusyChange(false)
    }
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {allowed ? (
          <TicketRunPicker
            projectId={run.project_id}
            runId={run.id}
            selectedIds={selectedIds}
            onSelectedIdsChange={setSelectedIds}
            emptyMessage="Every ticket on the board is in a run already or has been launched. Create tickets on the board, then come back."
            board={board}
          />
        ) : (
          <p
            className="text-[12px] text-muted-foreground"
            data-testid="docflow-add-tickets-refused"
          >
            {run.status === 'cancelled'
              ? 'This run was cancelled; it takes no more tickets.'
              : run.migration_session_id
                ? 'Wait for the migrations of this run to finish.'
                : 'This run takes no tickets.'}
          </p>
        )}
      </div>
      {allowed && resumes && (
        <p
          className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-[12px] leading-snug text-blue-500"
          data-testid="docflow-add-tickets-resume-note"
        >
          The run resumes: these tickets launch on its integration branch.
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          data-testid="docflow-add-tickets-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="docflow-add-tickets-confirm"
          disabled={!allowed || picked.length === 0 || busy}
          onClick={() => void submit()}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {addTicketsLabel(picked.length, resumes)}
        </Button>
      </DialogFooter>
    </>
  )
}
