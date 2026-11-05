import { useCallback, useMemo } from 'react'
import { ChevronRight, MessageCircleQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IndeterminateProgressBar } from '@/components/sessions/IndeterminateProgressBar'
import { TicketKeyBadge } from '@/components/kanban/TicketKeyBadge'
import {
  CHILD_COLUMNS,
  childColumnCounts,
  runChildrenOf
} from '@/lib/document-flow/run-children'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type { SessionStatusType } from '@shared/types/session-status'
import type { KanbanTicket, KanbanTicketColumn } from '../../../../main/db/types'
import { pluralize } from './document-flow-ui'

// The tickets of an "Implement document" run, folded into the run's card on the board (the
// "Group document run tickets" setting): a strip under the run's body with a header that says
// how many rows there are and in which columns, and — once opened — one compact row per
// ticket: its key, its title and where it stands (queued, at work, waiting for an answer, in
// review, merged, done). A row opens its ticket like a card would; the strip is collapsed unless
// the user opened it (useDocumentFlowStore.expandedRunTickets, persisted).

const COLUMN_LABEL: Record<KanbanTicketColumn, string> = {
  todo: 'Queued',
  in_progress: 'In progress',
  review: 'Review',
  merged: 'Merged',
  done: 'Done'
}

const COLUMN_TITLE: Record<KanbanTicketColumn, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  merged: 'Merged',
  done: 'Done'
}

const COLUMN_DOT_CLASS: Record<KanbanTicketColumn, string> = {
  todo: 'bg-muted-foreground/45',
  in_progress: 'bg-blue-500',
  review: 'bg-orange-500',
  merged: 'bg-violet-500',
  done: 'bg-emerald-500'
}

/** Statuses of a session that wait on the user: a question, a permission, a command approval. */
const NEEDS_YOU_STATUSES = new Set<SessionStatusType>(['answering', 'permission', 'command_approval'])
/** Statuses of a session at work. */
const WORKING_STATUSES = new Set<SessionStatusType>(['working', 'planning'])

type ChildSessionState = 'needs_you' | 'working' | 'error' | null

/**
 * What a ticket's session is doing, from the stores every card reads: waiting on the user
 * (a pending question, or a status that needs an answer), at work, errored, or nothing of note.
 */
function useChildSessionState(sessionId: string | null): ChildSessionState {
  const hasQuestion = useQuestionStore(
    useCallback(
      (state) => !!sessionId && (state.pendingBySession.get(sessionId)?.length ?? 0) > 0,
      [sessionId]
    )
  )
  const status = useWorktreeStatusStore(
    useCallback(
      (state) => (sessionId ? (state.sessionStatuses[sessionId]?.status ?? null) : null),
      [sessionId]
    )
  )
  const errored = useSessionStore(
    useCallback(
      (state) => {
        if (!sessionId) return false
        for (const sessions of state.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === sessionId)
          if (found) return found.status === 'error'
        }
        for (const sessions of state.sessionsByConnection.values()) {
          const found = sessions.find((s) => s.id === sessionId)
          if (found) return found.status === 'error'
        }
        return false
      },
      [sessionId]
    )
  )
  // A Claude CLI API failure (rate limit, server error) is not a session status: it ends the
  // turn as `completed` and is kept apart, as on a card, whose red perimeter reads it too.
  const hasApiError = useWorktreeStatusStore(
    useCallback(
      (state) => !!sessionId && state.sessionApiErrors[sessionId] !== undefined,
      [sessionId]
    )
  )
  if (hasQuestion || (status && NEEDS_YOU_STATUSES.has(status))) return 'needs_you'
  if (errored || hasApiError) return 'error'
  if (status && WORKING_STATUSES.has(status)) return 'working'
  return null
}

/** How many of the rows' sessions wait on the user: the header says so even when collapsed. */
function useNeedsYouCount(children: KanbanTicket[]): number {
  const sessionIds = useMemo(
    () => children.map((c) => c.current_session_id).filter((id): id is string => !!id),
    [children]
  )
  // Each selector returns one string (a stable snapshot), never a fresh array: a selector that
  // returned a new array on every read would re-render without end.
  const withQuestion = useQuestionStore(
    useCallback(
      (state) =>
        sessionIds
          .filter((id) => (state.pendingBySession.get(id)?.length ?? 0) > 0)
          .join('\n'),
      [sessionIds]
    )
  )
  const withStatus = useWorktreeStatusStore(
    useCallback(
      (state) =>
        sessionIds
          .filter((id) => {
            const status = state.sessionStatuses[id]?.status
            return !!status && NEEDS_YOU_STATUSES.has(status)
          })
          .join('\n'),
      [sessionIds]
    )
  )
  return new Set([...withQuestion.split('\n'), ...withStatus.split('\n')].filter(Boolean)).size
}

interface DocumentRunChildRowProps {
  ticket: KanbanTicket
}

function DocumentRunChildRow({ ticket }: DocumentRunChildRowProps): React.JSX.Element {
  const sessionState = useChildSessionState(ticket.current_session_id)
  const open = useCallback(
    (e: React.MouseEvent) => {
      if (useKanbanStore.getState().dependencyMode?.active) return
      e.stopPropagation()
      useKanbanStore.getState().setSelectedTicketRef({
        projectId: ticket.project_id,
        ticketId: ticket.id
      })
    },
    [ticket.project_id, ticket.id]
  )
  const settled = ticket.column === 'merged' || ticket.column === 'done'
  return (
    <button
      type="button"
      onClick={open}
      data-testid={`kanban-docflow-run-child-${ticket.id}`}
      // The row's own ticket identity, as a card carries it: in dependency mode the click
      // bubbles to the board, which reads the closest of these — the row's ticket, not the
      // run's whose card it sits in — and the dependency lines are drawn to the row.
      data-ticket-id={ticket.id}
      data-project-id={ticket.project_id}
      data-ticket-key={ticketKey(ticket.project_id, ticket.id)}
      data-column={ticket.column}
      data-session-state={sessionState ?? undefined}
      className="flex w-full items-center gap-1.5 rounded-[5px] border border-border bg-card px-1.5 py-1 text-left text-[11px] leading-snug transition-colors hover:border-muted-foreground/35"
    >
      <TicketKeyBadge ticket={ticket} showParent={false} className="mb-0" />
      <span className={cn('min-w-0 flex-1 truncate', settled && 'text-muted-foreground')}>
        {ticket.title}
      </span>
      {sessionState === 'working' && (
        <IndeterminateProgressBar mode="build" className="w-8 shrink-0" />
      )}
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] font-medium text-muted-foreground',
          sessionState === 'needs_you' && 'text-orange-500',
          sessionState === 'working' && 'text-blue-500',
          sessionState === 'error' && 'text-red-500'
        )}
      >
        {sessionState === 'needs_you' ? (
          <>
            <MessageCircleQuestion className="h-3 w-3" />
            Needs you
          </>
        ) : sessionState === 'working' ? (
          'Working'
        ) : sessionState === 'error' ? (
          'Error'
        ) : (
          <>
            <i className={cn('inline-block h-1.5 w-1.5 rounded-full', COLUMN_DOT_CLASS[ticket.column])} />
            {COLUMN_LABEL[ticket.column]}
          </>
        )}
      </span>
    </button>
  )
}

interface DocumentRunChildrenProps {
  /** The run's own ticket (external_provider 'document-run'). */
  runTicket: KanbanTicket
}

export function DocumentRunChildren({ runTicket }: DocumentRunChildrenProps): React.JSX.Element | null {
  const enabled = useSettingsStore((s) => s.nestDocumentRunTickets)
  // A board search lays the rows out as cards again (every match is a card); no strip then.
  const searchActive = useKanbanStore((s) => s.boardSearch.open && s.boardSearch.query.trim().length > 0)
  const projectTickets = useKanbanStore(
    useCallback((s) => s.tickets.get(runTicket.project_id), [runTicket.project_id])
  )
  const children = useMemo(
    () => (projectTickets ? runChildrenOf(projectTickets, runTicket.id) : []),
    [projectTickets, runTicket.id]
  )
  const expanded = useDocumentFlowStore((s) => !!s.expandedRunTickets[runTicket.id])
  const needsYou = useNeedsYouCount(children)

  const toggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      useDocumentFlowStore.getState().toggleRunTicketsExpanded(runTicket.id)
    },
    [runTicket.id]
  )
  // The strip is inside the run's card: a click, a press or a right-click on it must not open
  // the run, start a right-button drag or raise the run's context menu.
  const stop = useCallback((e: React.SyntheticEvent) => {
    if (useKanbanStore.getState().dependencyMode?.active) return
    e.stopPropagation()
  }, [])

  // An archived run folds nothing (nestedRunChildIds): its tickets keep their own cards, so a
  // strip on its card in Done's archive would show each of them twice.
  if (!enabled || searchActive || runTicket.archived_at || children.length === 0) return null

  const counts = childColumnCounts(children)

  return (
    <div
      data-testid={`kanban-docflow-run-children-${runTicket.id}`}
      data-expanded={expanded ? '' : undefined}
      onClick={stop}
      onMouseDown={stop}
      onContextMenu={stop}
      className="relative z-[3] -mb-2.5 -ml-[34px] -mr-3 mt-2 rounded-b-[5px] border-t border-border bg-muted/40"
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        data-testid={`kanban-docflow-run-children-toggle-${runTicket.id}`}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')}
          strokeWidth={2.5}
        />
        <span>{pluralize(children.length, 'ticket')}</span>
        {needsYou > 0 && (
          <span
            className="inline-flex items-center gap-0.5 text-orange-500"
            title={`${pluralize(needsYou, 'ticket')} waiting for you`}
            data-testid={`kanban-docflow-run-children-needs-you-${runTicket.id}`}
          >
            <MessageCircleQuestion className="h-3 w-3" />
            {needsYou}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] tabular-nums">
          {CHILD_COLUMNS.filter((column) => counts[column] > 0).map((column) => (
            <span
              key={column}
              className="inline-flex items-center gap-1"
              title={COLUMN_TITLE[column]}
              data-testid={`kanban-docflow-run-children-count-${runTicket.id}-${column}`}
            >
              <i className={cn('inline-block h-1.5 w-1.5 rounded-full', COLUMN_DOT_CLASS[column])} />
              {counts[column]}
            </span>
          ))}
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-1 px-2 pb-2">
          {children.map((child) => (
            <DocumentRunChildRow key={child.id} ticket={child} />
          ))}
        </div>
      )}
    </div>
  )
}
