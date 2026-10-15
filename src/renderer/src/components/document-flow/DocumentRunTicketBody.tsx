import {
  AlertTriangle,
  CircleCheck,
  CircleSlash,
  FileText,
  Loader2,
  MessageCircleQuestion,
  Pause,
  Zap
} from 'lucide-react'
import { ticketPillBaseClass, ticketPillClass } from '@/components/kanban/pill'
import { cn } from '@/lib/utils'
import { IndeterminateProgressBar } from '@/components/sessions/IndeterminateProgressBar'
import {
  documentNameFromPath,
  isUnlaunchedCardPhase,
  pluralize,
  type RunBoardCardState
} from './document-flow-ui'
import type { DocumentRunTicketView } from './useDocumentRunTicket'

const LABEL_CLASSES: Record<RunBoardCardState['phase'], string> = {
  extracting: 'text-blue-500',
  ready: 'text-emerald-500',
  extract_failed: 'text-red-500',
  running: 'text-blue-500',
  paused: 'text-muted-foreground',
  completed: 'text-emerald-500',
  issues: 'text-red-500',
  cancelled: 'text-muted-foreground',
  migrating: 'text-fuchsia-500'
}

type MovingPhase = 'extracting' | 'running' | 'migrating'

// A run that is no longer moving shows how far it got: merged of total, in its phase's color.
// Before launch the bar is full in the state's color: green once ready, red when it failed.
const STILL_BAR_CLASSES: Record<Exclude<RunBoardCardState['phase'], MovingPhase>, string> = {
  ready: 'bg-emerald-500',
  extract_failed: 'bg-red-500',
  paused: 'bg-muted-foreground/40',
  completed: 'bg-emerald-500',
  issues: 'bg-red-500',
  cancelled: 'bg-muted-foreground/40'
}

const isMovingPhase = (phase: RunBoardCardState['phase']): phase is MovingPhase =>
  phase === 'extracting' || phase === 'running' || phase === 'migrating'

/** How full the still bar is: merged of total once launched; full before launch (its color says the state). */
function stillBarWidth(state: RunBoardCardState): string {
  if (isUnlaunchedCardPhase(state.phase)) return '100%'
  return `${state.total > 0 ? (state.merged / state.total) * 100 : 0}%`
}

/** The count at the right of the label: merged of total once launched, the tickets to launch before. */
function countLabel(state: RunBoardCardState): string | null {
  if (state.phase === 'ready') return pluralize(state.total, 'ticket')
  if (isUnlaunchedCardPhase(state.phase)) return null
  return `${state.merged}/${state.total} merged`
}

interface DocumentRunTicketBodyProps {
  runId: string
  view: DocumentRunTicketView
  /** The document the run was made from; named in the card's footer when known. */
  documentPath?: string | null
  /** The card wears a red perimeter: the footer says "Error" in place of the document. */
  error?: boolean
}

/**
 * The body of a run's ticket card, under the ticket's own title: the "Document run" marker,
 * one progress bar (moving while the run is on, like any ticket at work, and again in its own
 * color while a session executes the run's migrations), the sessions at work or waiting for an
 * answer (or how the run ended) and merged of total, then a footer naming the document.
 */
export function DocumentRunTicketBody({
  runId,
  view,
  documentPath = null,
  error = false
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
        {/* Every parallel slot is held: the tag, in the gold of the frame, is the only place
            the card mentions the cap. Only a run at work can be at it, so it never meets the
            "Needs you" of a paused run. */}
        {state?.atCap && (
          <span
            className={cn(
              ticketPillBaseClass,
              'ml-auto shrink-0 border-(--elite-gold)/40 bg-(--elite-gold)/10 text-(--elite-gold)'
            )}
            title="Every parallel slot is taken; the next ticket starts when one frees up"
            data-testid={`kanban-docflow-run-at-cap-${runId}`}
          >
            <Zap className="h-2.5 w-2.5 shrink-0" fill="currentColor" strokeWidth={0} />
            At cap
          </span>
        )}
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
          {isMovingPhase(state.phase) ? (
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
                style={{ width: stillBarWidth(state) }}
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
              {state.phase === 'extracting' && (
                <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />
              )}
              {state.phase === 'ready' && <CircleCheck className="h-2.5 w-2.5 shrink-0" />}
              {state.phase === 'extract_failed' && (
                <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
              )}
              <span className="truncate">{state.label}</span>
            </span>
            {countLabel(state) !== null && (
              <span
                className="ml-auto shrink-0 text-muted-foreground"
                data-testid={`kanban-docflow-run-progress-${runId}`}
              >
                {countLabel(state)}
              </span>
            )}
          </div>
        </>
      )}
      {(error || documentPath) && (
        <div
          className="mt-[7px] flex items-center gap-1"
          data-testid={`kanban-docflow-run-footer-${runId}`}
        >
          {error ? (
            <span
              className={cn(
                ticketPillBaseClass,
                'border-red-500/25 bg-transparent px-1.5 text-[9px] text-red-500'
              )}
            >
              <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
              Error
            </span>
          ) : (
            <span
              className={cn(ticketPillClass, 'min-w-0 max-w-full px-1.5 text-[9px]')}
              title={documentPath ?? undefined}
            >
              <FileText className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{documentNameFromPath(documentPath ?? '')}</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}
