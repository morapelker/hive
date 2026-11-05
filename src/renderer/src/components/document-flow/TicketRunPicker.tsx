import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, Loader2, Lock, Search } from 'lucide-react'
import { TicketKeyBadge } from '@/components/kanban/TicketKeyBadge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import type { KanbanTicketColumn } from '../../../../main/db/types'
import { pluralize } from './document-flow-ui'
import {
  NO_ORCHESTRATABLE_TICKETS,
  describeMissingBlockers,
  missingBlockers,
  ticketLabel,
  ticketMatchesSearch,
  unresolvedBlockers
} from './ticket-run-ui'
import { useBoardTicketsForRun, type BoardTicketsForRun } from './useTicketRunBoard'

const NO_TICKET_IDS: string[] = []

type ColumnFilter = Exclude<KanbanTicketColumn, 'merged'>

const COLUMN_FILTERS: { key: ColumnFilter; label: string; color: string; active: string }[] = [
  {
    key: 'todo',
    label: 'To Do',
    color: 'border-zinc-600 text-zinc-400',
    active: 'border-zinc-400 bg-zinc-400/15 text-zinc-200'
  },
  {
    key: 'in_progress',
    label: 'In Progress',
    color: 'border-blue-600/50 text-blue-400/70',
    active: 'border-blue-500 bg-blue-500/15 text-blue-300'
  },
  {
    key: 'review',
    label: 'Review',
    color: 'border-amber-600/50 text-amber-400/70',
    active: 'border-amber-500 bg-amber-500/15 text-amber-300'
  },
  {
    key: 'done',
    label: 'Done',
    color: 'border-border text-muted-foreground/70',
    active: 'border-muted-foreground/50 bg-transparent text-foreground'
  }
]

/** Merged tickets read as Done here, as they do on a board without the Merged column. */
const filterColumnOf = (column: KanbanTicketColumn): ColumnFilter =>
  column === 'merged' ? 'done' : column

export interface TicketRunPickerProps {
  projectId: string
  /** The run the tickets would join: its own tickets show checked and locked. */
  runId?: string | null
  selectedIds: readonly string[]
  onSelectedIdsChange: (ids: string[]) => void
  /** Shown when the board has nothing that could join (default: the wizard's copy). */
  emptyMessage?: string
  /** The board as `useBoardTicketsForRun` reads it, when the caller already holds it. */
  board?: BoardTicketsForRun
}

/**
 * Pick board tickets for an orchestrator: search by title or key, filter by column (To Do to
 * start with; In Progress shows the queued ones, which have not started), check the ones to
 * run. Tickets that cannot join stay listed, unchecked and locked, with the reason; a run's own
 * ticket and shell command tickets are not listed at all. When a picked ticket waits on the
 * board for tickets left out, a note offers to add them, so the run can honour the dependency.
 */
export function TicketRunPicker({
  projectId,
  runId = null,
  selectedIds,
  onSelectedIdsChange,
  emptyMessage = NO_ORCHESTRATABLE_TICKETS,
  board: givenBoard
}: TicketRunPickerProps): React.JSX.Element {
  const ownBoard = useBoardTicketsForRun(projectId, runId, { load: !givenBoard })
  const board = givenBoard ?? ownBoard
  const { loaded, tickets, ticketsById, blockersOf, refusalOf } = board
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<ReadonlySet<ColumnFilter>>(() => new Set(['todo']))
  // The run's own tickets show checked (and locked): they are in it already.
  const runTicketIds = useDocumentFlowStore(
    useShallow((state) =>
      runId
        ? (state.runsById[runId]?.items.flatMap((item) =>
            item.ticket_id ? [item.ticket_id] : []
          ) ?? NO_TICKET_IDS)
        : NO_TICKET_IDS
    )
  )

  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const inThisRun = (ticketId: string): boolean => runTicketIds.includes(ticketId)
  const canJoin = useCallback((ticketId: string) => refusalOf(ticketId) === null, [refusalOf])
  const joinableCount = tickets.filter((ticket) => canJoin(ticket.id)).length
  const pickedCount = selectedIds.filter(canJoin).length

  // The column filter never hides a picked ticket (one preselected from its card, a blocker
  // "Add them" brought in): it counts towards the run, so it must be there to review and uncheck.
  const visible = tickets.filter(
    (ticket) =>
      (filters.size === 0 ||
        filters.has(filterColumnOf(ticket.column)) ||
        selected.has(ticket.id)) &&
      ticketMatchesSearch(ticket, query)
  )

  const boardOrder = useMemo(() => tickets.map((ticket) => ticket.id), [tickets])
  const missing = useMemo(
    () => missingBlockers(selectedIds.filter(canJoin), blockersOf, canJoin, boardOrder),
    [selectedIds, canJoin, blockersOf, boardOrder]
  )
  const missingNote = describeMissingBlockers(missing.dependents, (ticketId) => {
    const ticket = ticketsById.get(ticketId)
    return ticket ? ticketLabel(ticket) : 'A ticket'
  })

  const toggle = (ticketId: string): void => {
    onSelectedIdsChange(
      selected.has(ticketId)
        ? selectedIds.filter((id) => id !== ticketId)
        : [...selectedIds, ticketId]
    )
  }

  const toggleFilter = (column: ColumnFilter): void => {
    setFilters((current) => {
      const next = new Set(current)
      if (!next.delete(column)) next.add(column)
      return next
    })
  }

  if (!loaded) {
    return (
      <p
        className="flex items-center gap-2 py-4 text-[12px] text-muted-foreground"
        data-testid="docflow-ticket-picker-loading"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading the board…
      </p>
    )
  }

  if (tickets.length === 0) {
    return (
      <p
        className="rounded-[8px] border border-dashed border-border px-4 py-6 text-center text-[12px] leading-relaxed text-muted-foreground"
        data-testid="docflow-ticket-picker-empty"
      >
        {emptyMessage}
      </p>
    )
  }

  return (
    <div className="space-y-2" data-testid="docflow-ticket-picker">
      {joinableCount === 0 && (
        <p
          className="text-[12px] leading-relaxed text-muted-foreground"
          data-testid="docflow-ticket-picker-empty"
        >
          {emptyMessage}
        </p>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          aria-label="Search tickets"
          placeholder="Search by title or key…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full rounded-md border border-input bg-input/30 py-1.5 pl-8 pr-3 text-[13px] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          data-testid="docflow-ticket-picker-search"
        />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Columns">
        {COLUMN_FILTERS.map((column) => {
          const active = filters.has(column.key)
          return (
            <button
              key={column.key}
              type="button"
              aria-pressed={active}
              onClick={() => toggleFilter(column.key)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:opacity-80',
                active ? column.active : column.color
              )}
              data-testid={`docflow-ticket-picker-column-${column.key}`}
            >
              {column.label}
            </button>
          )
        })}
      </div>

      <div
        className="max-h-[280px] divide-y divide-border overflow-y-auto rounded-[8px] border border-border"
        role="group"
        aria-label="Board tickets"
      >
        {visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            {query.trim() || filters.size > 0
              ? 'No tickets match the search or the columns chosen.'
              : 'No tickets on this board.'}
          </p>
        ) : (
          visible.map((ticket) => {
            const refusal = refusalOf(ticket.id)
            const member = refusal !== null && inThisRun(ticket.id)
            const checked = member || (refusal === null && selected.has(ticket.id))
            const blockers = unresolvedBlockers(ticket.id, blockersOf, ticketsById)
            const queued = ticket.column === 'in_progress' && !ticket.current_session_id
            return (
              <button
                key={ticket.id}
                type="button"
                role="checkbox"
                aria-checked={checked}
                disabled={refusal !== null}
                title={refusal ?? undefined}
                onClick={() => toggle(ticket.id)}
                className={cn(
                  'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors disabled:cursor-not-allowed',
                  checked && !member ? 'bg-blue-500/10' : 'hover:bg-muted/50',
                  refusal !== null && 'hover:bg-transparent'
                )}
                data-testid={`docflow-ticket-row-${ticket.id}`}
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                    checked ? 'border-blue-500 bg-blue-500' : 'border-muted-foreground/30',
                    refusal !== null && 'opacity-50'
                  )}
                >
                  {checked && <Check className="h-3 w-3 text-white" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'flex min-w-0 items-center gap-1.5',
                      refusal !== null && !member && 'opacity-60'
                    )}
                  >
                    <TicketKeyBadge ticket={ticket} showParent={false} />
                    <span className="truncate text-[13px] text-foreground">
                      {ticket.title || 'Untitled ticket'}
                    </span>
                  </span>
                  {refusal !== null && (
                    <span
                      className="mt-0.5 flex items-center gap-1 text-[11px] leading-snug text-muted-foreground"
                      data-testid={`docflow-ticket-row-refusal-${ticket.id}`}
                    >
                      {!member && <Lock className="h-2.5 w-2.5 shrink-0" />}
                      {refusal}
                    </span>
                  )}
                </span>
                {queued && refusal === null && (
                  <span className="shrink-0 rounded border border-blue-500/40 px-1.5 py-px text-[10px] text-blue-400">
                    queued
                  </span>
                )}
                {blockers.length > 0 && (
                  <span
                    className="shrink-0 text-[11px] text-muted-foreground"
                    title={`Waits on the board for ${blockers.map(ticketLabel).join(', ')}`}
                    data-testid={`docflow-ticket-row-blockers-${ticket.id}`}
                  >
                    blocked by {blockers.length}
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>

      {missingNote && (
        <div
          className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[12px] leading-snug text-amber-600 dark:text-amber-400"
          data-testid="docflow-ticket-picker-missing-blockers"
        >
          <span className="min-w-0 flex-1">{missingNote}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 shrink-0 px-2 text-[12px]"
            data-testid="docflow-ticket-picker-add-blockers"
            onClick={() => onSelectedIdsChange([...selectedIds, ...missing.closure])}
          >
            Add them
          </Button>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground" data-testid="docflow-ticket-picker-count">
        {pickedCount > 0 ? `${pluralize(pickedCount, 'ticket')} selected` : 'No tickets selected'}
      </p>
    </div>
  )
}
