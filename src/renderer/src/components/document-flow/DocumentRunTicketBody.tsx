import { CircleSlash, FileText, MessageCircleQuestion, Pause } from 'lucide-react'
import { ticketPillClass } from '@/components/kanban/pill'
import { cn } from '@/lib/utils'
import { IndeterminateProgressBar } from '@/components/sessions/IndeterminateProgressBar'
import type { RunBoardCardState } from './document-flow-ui'
import type { DocumentRunTicketView } from './useDocumentRunTicket'

const LABEL_CLASSES: Record<RunBoardCardState['phase'], string> = {
  running: 'text-blue-500',
  paused: 'text-muted-foreground',
  completed: 'text-emerald-500',
  issues: 'text-amber-500',
  cancelled: 'text-muted-foreground',
  migrating: 'text-fuchsia-500'
}

type MovingPhase = 'running' | 'migrating'

// A run that is no longer moving shows how far it got: merged of total, in its phase's color
const STILL_BAR_CLASSES: Record<Exclude<RunBoardCardState['phase'], MovingPhase>, string> = {
  paused: 'bg-muted-foreground/40',
  completed: 'bg-emerald-500',
  issues: 'bg-amber-500',
  cancelled: 'bg-muted-foreground/40'
}

interface DocumentRunTicketBodyProps {
  runId: string
  view: DocumentRunTicketView
}

/**
 * The body of a run's ticket card, under the ticket's own title: the "Document run" marker,
 * one progress bar (moving while the run is on, like any ticket at work, and again in its own
 * color while a session executes the run's migrations), the sessions at work or waiting for an
 * answer (or how the run ended) and merged of total.
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
        {/* A run at work says so in its label; a paused one's label is taken by "Paused" */}
        {state?.waitingOnUser && state.paused && (
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
          {state.phase === 'running' || state.phase === 'migrating' ? (
            <div data-testid={`kanban-docflow-run-bar-${runId}`} data-moving="">
              <IndeterminateProgressBar
                mode="build"
                isAsking={state.waitingOnUser}
                isRunningMigrations={state.phase === 'migrating'}
                className="mt-2 w-full"
              />
            </div>
          ) : (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={state.total}
              aria-valuenow={state.merged}
              data-testid={`kanban-docflow-run-bar-${runId}`}
              className="mt-2 h-[3px] overflow-hidden rounded-[2px] bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]"
            >
              <div
                className={cn('h-full rounded-[2px]', STILL_BAR_CLASSES[state.phase])}
                style={{ width: `${state.total > 0 ? (state.merged / state.total) * 100 : 0}%` }}
              />
            </div>
          )}
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
