import { useCallback, useMemo } from 'react'
import { Hourglass, Loader2, MessageCircleQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'
import { spawnedRunTickets } from '@/lib/document-flow/run-children'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { KanbanTicket } from '../../../../main/db/types'
import { useTicketSessionState } from './useTicketSessionState'

// The sessions started from a run's dashboard once the run ended (its migrations, its manual
// steps, a new session on its branch) each have a ticket of their own, a child of the run's
// ticket. While such a session runs, the run's card names its ticket under the run's own state:
// one row per session, which opens that ticket like its card would. The run's items are not
// listed here; the label above counts them.

/** What a row says about its session; null when the session is not running (no row). */
type SpawnedSessionState = 'working' | 'needs_you' | 'waiting'

const STATE_CLASS: Record<SpawnedSessionState, string> = {
  working: 'text-blue-500',
  needs_you: 'text-orange-500',
  waiting: 'text-muted-foreground'
}

const STATE_HINT: Record<SpawnedSessionState, string> = {
  working: 'Working',
  needs_you: 'Waiting for you',
  waiting: 'Waiting on background work'
}

function SpawnedSessionRow({ ticket }: { ticket: KanbanTicket }): React.JSX.Element | null {
  const sessionState = useTicketSessionState(ticket.current_session_id)
  const open = useCallback(
    (e: React.MouseEvent) => {
      // Dependency mode: the click is the board's, for the run's card the row sits in.
      if (useKanbanStore.getState().dependencyMode?.active) return
      e.stopPropagation()
      useKanbanStore.getState().setSelectedTicketRef({
        projectId: ticket.project_id,
        ticketId: ticket.id
      })
    },
    [ticket.project_id, ticket.id]
  )
  // A session parked on its own background work is not over: its ticket waits In Progress.
  const parked = ticket.column === 'in_progress' && ticket.awaiting_completion
  const state: SpawnedSessionState | null =
    sessionState === 'needs_you' || sessionState === 'working'
      ? sessionState
      : parked
        ? 'waiting'
        : null
  if (!state) return null
  return (
    <button
      type="button"
      onClick={open}
      title={`${ticket.title} · ${STATE_HINT[state]}`}
      data-testid={`kanban-docflow-run-spawned-session-${ticket.id}`}
      data-session-state={state}
      className={cn(
        'flex w-full min-w-0 items-center gap-1 text-left text-[11px] font-medium hover:underline',
        STATE_CLASS[state]
      )}
    >
      {state === 'working' && <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />}
      {state === 'needs_you' && <MessageCircleQuestion className="h-2.5 w-2.5 shrink-0" />}
      {state === 'waiting' && <Hourglass className="h-2.5 w-2.5 shrink-0" />}
      <span className="truncate">{ticket.title}</span>
    </button>
  )
}

interface DocumentRunSpawnedSessionsProps {
  runId: string
  /** The run's own ticket (external_provider 'document-run'). */
  runTicket: KanbanTicket
}

export function DocumentRunSpawnedSessions({
  runId,
  runTicket
}: DocumentRunSpawnedSessionsProps): React.JSX.Element | null {
  const projectTickets = useKanbanStore(
    useCallback((s) => s.tickets.get(runTicket.project_id), [runTicket.project_id])
  )
  // Until the run is loaded its items are not known, so neither is which child is one of them.
  const items = useDocumentFlowStore(useCallback((s) => s.runsById[runId]?.items, [runId]))
  const spawned = useMemo(
    () =>
      projectTickets && items
        ? spawnedRunTickets(projectTickets, runTicket.id, items).filter(
            (ticket) => ticket.current_session_id
          )
        : [],
    [projectTickets, items, runTicket.id]
  )
  // The rows are inside the run's card: a click, a press or a right-click on one must not open
  // the run, start a right-button drag or raise the run's context menu.
  const stop = useCallback((e: React.SyntheticEvent) => {
    if (useKanbanStore.getState().dependencyMode?.active) return
    e.stopPropagation()
  }, [])

  if (runTicket.archived_at || spawned.length === 0) return null

  return (
    <div
      data-testid={`kanban-docflow-run-spawned-${runTicket.id}`}
      onClick={stop}
      onMouseDown={stop}
      onContextMenu={stop}
      // Hidden while no row is drawn: every session it could name is over.
      className="relative z-[3] mt-1.5 flex flex-col gap-1 empty:hidden"
    >
      {spawned.map((ticket) => (
        <SpawnedSessionRow key={ticket.id} ticket={ticket} />
      ))}
    </div>
  )
}
