import { CircleSlash, FileText, MessageCircleQuestion, Pause } from 'lucide-react'
import { ticketPillClass } from '@/components/kanban/pill'
import { cn } from '@/lib/utils'
import { RunProgressBar } from './RunProgressBar'
import type { RunBoardCardState } from './document-flow-ui'
import type { DocumentRunTicketView } from './useDocumentRunTicket'

const LABEL_CLASSES: Record<RunBoardCardState['phase'], string> = {
  running: 'text-blue-500',
  paused: 'text-muted-foreground',
  completed: 'text-emerald-500',
  issues: 'text-amber-500',
  cancelled: 'text-muted-foreground'
}

interface DocumentRunTicketBodyProps {
  runId: string
  view: DocumentRunTicketView
}

/**
 * The body of a run's ticket card, under the ticket's own title: the "Document run" marker,
 * the progress bar, the sessions at work (or how the run ended) and merged of total.
 */
export function DocumentRunTicketBody({
  runId,
  view
}: DocumentRunTicketBodyProps): React.JSX.Element {
  const { state, missing } = view
  return (
    <div
      className="mt-1.5"
      data-testid={`kanban-docflow-run-${runId}`}
      data-phase={state?.phase}
      data-waiting-on-user={state?.waitingOnUser ? '' : undefined}
      data-paused={state?.paused ? '' : undefined}
      data-run-missing={missing ? '' : undefined}
    >
      <div className="flex items-center gap-1.5">
        <span className={ticketPillClass} data-testid={`kanban-docflow-run-marker-${runId}`}>
          <FileText className="h-2.5 w-2.5" />
          Document run
        </span>
        {state?.waitingOnUser && (
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-orange-500"
            data-testid={`kanban-docflow-run-needs-you-${runId}`}
          >
            <MessageCircleQuestion className="h-3 w-3" />
            Needs you
          </span>
        )}
      </div>
      {missing && (
        <p
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
          data-testid={`kanban-docflow-run-missing-${runId}`}
        >
          <CircleSlash className="h-3 w-3" />
          Run record missing
        </p>
      )}
      {state && (
        <>
          <RunProgressBar segments={state.segments} className="mt-2" />
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] tabular-nums">
            <span
              className={cn(
                'inline-flex min-w-0 items-center gap-1 font-medium',
                state.waitingOnUser && !state.paused
                  ? 'text-orange-500'
                  : LABEL_CLASSES[state.phase]
              )}
              data-testid={`kanban-docflow-run-running-${runId}`}
            >
              {state.paused && <Pause className="h-2.5 w-2.5 shrink-0" />}
              <span className="truncate">{state.label}</span>
            </span>
            <span
              className="ml-auto shrink-0 text-muted-foreground"
              data-testid={`kanban-docflow-run-progress-${runId}`}
            >
              {state.merged}/{state.total} merged
            </span>
          </div>
        </>
      )}
    </div>
  )
}
