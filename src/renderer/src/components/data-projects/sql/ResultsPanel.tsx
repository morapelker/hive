// Bottom half of a query tab: one result tab per result set (a statement may produce several,
// e.g. MySQL CALL) plus Messages (affected rows, notices, errors with their position, what was
// declined/blocked/cancelled), a status line for the visible result (rows, the "Limited to N ·
// Load more · Load all" chip, time, ClickHouse read stats, the executed SQL when the server ran a
// rewrite), copy/export menus, and the running overlay with an elapsed timer and Cancel.
//
// The loaded rows can be sorted (header click, shift-click adds a column, a third click clears)
// and narrowed (the "Filter rows" box, and "Filter by this value" chips from the cell menu)
// without running anything again; that view is kept per result set until the next run. Copy and
// "Save as" then take the rows as shown; "Export all" re-runs the statement on the server (with
// the run's database and PostgreSQL schema), unsorted and unfiltered.
//
// Row detail (the header's panel toggle, or Space in the grid): every column of the focused row
// in a side panel next to the grid, read-only here; arrow keys in the grid move the row.
//
// The header row is a container: below ~520px the Copy / Export labels collapse to icons so the
// result tabs, the filter box and both menus stay reachable next to the assistant panel.

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  Copy,
  Download,
  Filter,
  Loader2,
  PanelRight,
  Search,
  Square,
  X,
  XCircle
} from 'lucide-react'
import type {
  DataProject,
  DataRowsResult,
  DataStatementResult,
  SqlDialect
} from '@shared/data-projects/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ShortcutHint } from '@/components/ui/shortcut-hint'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import type { QueryRunTarget, QueryTabRun } from '@/stores/useDataWorkspaceStore'
import { ResultGrid, type ResultGridHandle } from '../grid/ResultGrid'
import { cellDisplayText } from '../grid/cell-format'
import { useRowDetailOpen } from '../grid/row-detail'
import {
  applyClientView,
  EMPTY_CLIENT_VIEW,
  isClientFilterActive,
  nextClientSort,
  withValueFilter,
  type ClientView
} from '../grid/client-view'
import { formatRows, type CopyFormat } from '../grid/export-format'
import { FULL_EXPORT_FORMATS, saveVisibleResults, startFullExport } from '../shared/export-actions'
import { formatBytes, formatCount, formatDuration } from '../shared/format-utils'
import { SqlText } from '../shared/SqlText'
import { StatementBadge } from '../shared/StatementBadge'

export interface ResultsPanelProps {
  project: DataProject
  dialect: SqlDialect
  tabTitle: string
  run: QueryTabRun | undefined
  onSelectResult: (index: number) => void
  /** Re-runs one statement with another auto-limit (null = none). */
  onRerun: (target: QueryRunTarget, limit: number | null) => void
  onCancel: () => void
  /** Moves the editor cursor to a statement's error. */
  onShowError: (statement: DataStatementResult) => void
  className?: string
}

interface ResultSet {
  statement: DataStatementResult
  output: DataRowsResult
}

const COPY_FORMATS: Array<{ format: CopyFormat; label: string }> = [
  { format: 'tsv', label: 'TSV' },
  { format: 'csv', label: 'CSV' },
  { format: 'json', label: 'JSON' },
  { format: 'sql', label: 'SQL INSERT' },
  { format: 'markdown', label: 'Markdown' }
]

function Elapsed({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [])
  return <span className="tabular-nums">{formatDuration(Math.max(0, now - since))}</span>
}

const firstLine = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

function outcomeText(st: DataStatementResult): string {
  const out = st.output
  if (!out) return st.error ? 'Failed' : 'No result'
  switch (out.kind) {
    case 'rows':
      return `${formatCount(out.rows.length)} ${out.rows.length === 1 ? 'row' : 'rows'}${out.truncated ? ` (limited to ${formatCount(out.limit)})` : ''}`
    case 'command': {
      const parts: string[] = []
      if (out.message) parts.push(out.message)
      if (out.affectedRows !== undefined && out.affectedRows !== null) {
        parts.push(
          `${formatCount(out.affectedRows)} ${out.affectedRows === 1 ? 'row' : 'rows'} affected`
        )
      }
      if (out.lastInsertId) parts.push(`last insert id ${out.lastInsertId}`)
      return parts.join(' · ') || 'OK'
    }
    case 'documents':
      return `${formatCount(out.documents.length)} documents`
    case 'value':
      return 'Value'
  }
}

function MessagesView({
  run,
  dialect,
  onShowError
}: {
  run: QueryTabRun
  dialect: SqlDialect
  onShowError: (statement: DataStatementResult) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  return (
    <div
      className="min-h-0 flex-1 overflow-auto p-2 text-[12px]"
      data-testid="data-project-messages"
    >
      {run.status === 'declined' && (
        <div
          className="mb-2 flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-muted-foreground"
          data-testid="data-project-messages-declined"
        >
          <CircleSlash className="h-3.5 w-3.5" />
          Not run: the confirmation was cancelled.
        </div>
      )}
      {run.status === 'blocked' && (
        <div
          className="mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-300"
          data-testid="data-project-messages-blocked"
        >
          <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Blocked: {run.blockedReason || 'refused by the safe mode'}. Nothing ran.</span>
        </div>
      )}
      {run.status === 'cancelled' && (
        <div
          className="mb-2 flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-muted-foreground"
          data-testid="data-project-messages-cancelled"
        >
          <CircleSlash className="h-3.5 w-3.5" />
          Cancelled
          {run.statements.length
            ? ` after ${run.statements.length} statement${run.statements.length === 1 ? '' : 's'}`
            : ''}
          .
        </div>
      )}
      {run.status === 'error' && run.error && (
        <div
          className="mb-2 flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-red-700 dark:text-red-300"
          data-testid="data-project-messages-error"
        >
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-pre-wrap break-words">{run.error}</span>
        </div>
      )}
      {run.inTransaction && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5" />A transaction is open on this connection: run
          COMMIT or ROLLBACK.
        </div>
      )}
      <ul className="space-y-1">
        {run.statements.map((st, i) => {
          const failed = !!st.error
          const showExecuted = expanded.has(i)
          return (
            <li
              key={`${st.index}-${i}`}
              className="rounded-md border border-border/70 px-2 py-1.5"
              data-testid={`data-project-message-${i}`}
            >
              <div className="flex items-center gap-2">
                {failed ? (
                  <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                )}
                <StatementBadge classification={st.classification} />
                <span className="truncate font-mono text-muted-foreground" title={st.text}>
                  {firstLine(st.text)}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                  {formatDuration(st.durationMs)}
                </span>
              </div>
              <div
                className={cn(
                  'mt-0.5 pl-[22px]',
                  failed ? 'text-red-600 dark:text-red-400' : 'text-foreground'
                )}
              >
                {failed && st.error ? (
                  <button
                    type="button"
                    className="text-left hover:underline"
                    onClick={() => onShowError(st)}
                    data-testid={`data-project-message-error-${i}`}
                    title="Show in the editor"
                  >
                    {st.error.code ? `[${st.error.code}] ` : ''}
                    {st.error.message}
                    {st.error.position !== undefined
                      ? ` (at character ${st.error.position + 1})`
                      : ''}
                  </button>
                ) : (
                  outcomeText(st)
                )}
              </div>
              {failed && (st.error?.detail || st.error?.hint) && (
                <div className="mt-0.5 pl-[22px] text-muted-foreground">
                  {st.error?.detail && <div>Detail: {st.error.detail}</div>}
                  {st.error?.hint && <div>Hint: {st.error.hint}</div>}
                </div>
              )}
              {st.output?.kind === 'value' && (
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/50 p-1.5 pl-[22px] font-mono">
                  {JSON.stringify(st.output.value, null, 2)}
                </pre>
              )}
              {st.notices?.map((n, k) => (
                <div key={k} className="mt-0.5 pl-[22px] text-muted-foreground">
                  NOTICE: {n}
                </div>
              ))}
              {st.stats &&
                (st.stats.rowsRead !== undefined || st.stats.bytesRead !== undefined) && (
                  <div className="mt-0.5 pl-[22px] text-muted-foreground">
                    Read {formatCount(st.stats.rowsRead ?? null)} rows
                    {st.stats.bytesRead !== undefined
                      ? ` · ${formatBytes(st.stats.bytesRead)}`
                      : ''}
                  </div>
                )}
              {st.executedText && st.executedText !== st.text && (
                <div className="mt-0.5 pl-[22px]">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setExpanded((set) => {
                        const next = new Set(set)
                        if (next.has(i)) next.delete(i)
                        else next.add(i)
                        return next
                      })
                    }
                  >
                    {showExecuted ? 'Hide' : 'Show'} the executed SQL
                  </button>
                  {showExecuted && (
                    <SqlText
                      text={st.executedText}
                      dialect={dialect}
                      className="mt-1 rounded bg-muted/50 p-1.5"
                    />
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {run.statements.length === 0 && run.status === 'ok' && (
        <div className="text-muted-foreground">Nothing to run.</div>
      )}
    </div>
  )
}

/** Search box of the loaded rows: typing is debounced so 100k rows are not scanned per key. */
function QuickFilter({
  value,
  onChange
}: {
  value: string
  onChange: (text: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  // What this box last sent: only a change from elsewhere (another result set, Clear filters)
  // overwrites the draft, never the echo of our own debounced send while typing goes on.
  const sent = useRef(value)
  useEffect(() => {
    if (value === sent.current) return
    sent.current = value
    setDraft(value)
  }, [value])
  const send = (text: string): void => {
    sent.current = text
    onChange(text)
  }
  useEffect(() => {
    if (draft === sent.current) return
    const timer = window.setTimeout(() => send(draft), 150)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])
  return (
    <div className="relative min-w-[64px] max-w-56 flex-1 @[520px]/rp:w-44 @[520px]/rp:flex-none">
      <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && draft) {
            e.stopPropagation()
            setDraft('')
            send('')
          } else if (e.key === 'Enter') send(draft)
        }}
        placeholder="Filter rows…"
        title="Show only loaded rows containing this text (nothing is run again)"
        data-testid="data-project-results-filter"
        className="h-6 w-full rounded-md border border-input bg-transparent pl-6 pr-1.5 text-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
    </div>
  )
}

export function ResultsPanel({
  project,
  dialect,
  tabTitle,
  run,
  onSelectResult,
  onRerun,
  onCancel,
  onShowError,
  className
}: ResultsPanelProps): React.JSX.Element {
  const resultSets = useMemo<ResultSet[]>(
    () =>
      (run?.statements ?? []).flatMap((statement) =>
        statement.output?.kind === 'rows' ? [{ statement, output: statement.output }] : []
      ),
    [run?.statements]
  )
  const [showExecuted, setShowExecuted] = useState(false)
  const [rowDetailOpen, setRowDetailOpen] = useRowDetailOpen()
  const gridRef = useRef<ResultGridHandle>(null)
  const active = run && run.activeResult >= 0 ? resultSets[run.activeResult] : undefined
  const failures = run?.statements.filter((s) => s.error).length ?? 0

  // Client-side sort / filter per result set of the current run (a new run starts clean).
  const [views, setViews] = useState<{ runId: number; byResult: Record<number, ClientView> }>({
    runId: -1,
    byResult: {}
  })
  const view =
    run && views.runId === run.runId
      ? (views.byResult[run.activeResult] ?? EMPTY_CLIENT_VIEW)
      : EMPTY_CLIENT_VIEW
  const setView = (update: (view: ClientView) => ClientView): void => {
    if (!run) return
    const index = run.activeResult
    setViews((s) => {
      const byResult = s.runId === run.runId ? s.byResult : {}
      return {
        runId: run.runId,
        byResult: { ...byResult, [index]: update(byResult[index] ?? EMPTY_CLIENT_VIEW) }
      }
    })
  }
  const deferredView = useDeferredValue(view)
  const order = useMemo(
    () =>
      active ? applyClientView(active.output.rows, active.output.columns, deferredView) : null,
    [active, deferredView]
  )
  const shownRows = useMemo(
    () => (active ? (order ? order.map((i) => active.output.rows[i]) : active.output.rows) : []),
    [active, order]
  )
  const filtering = isClientFilterActive(view)

  if (!run) {
    return (
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-[12px] text-muted-foreground',
          className
        )}
        data-testid="data-project-results-empty"
      >
        <div>
          <ShortcutHint label="⌘↵" className="ml-0 mr-1" /> runs the statement under the cursor (or
          the selection)
        </div>
        <div>
          <ShortcutHint label="⇧⌘↵" className="ml-0 mr-1" /> runs everything ·{' '}
          <ShortcutHint label="⌘." className="ml-0 mr-1" /> cancels
        </div>
      </div>
    )
  }

  const insertTable = active?.output.columns[0]?.table
    ? {
        name: active.output.columns[0].table,
        schema: active.output.columns[0].schema,
        database: active.output.columns[0].database
      }
    : undefined
  const resultName = `${tabTitle}${resultSets.length > 1 ? `-${(run.activeResult ?? 0) + 1}` : ''}`
  const rerunTarget = (st: DataStatementResult): QueryRunTarget => ({
    text: st.text,
    from: run.target.from + st.start,
    to: run.target.from + st.end,
    mode: 'current'
  })

  const copyAll = async (format: CopyFormat): Promise<void> => {
    if (!active) return
    const text = formatRows(format, active.output.columns, shownRows, {
      dialect,
      table: insertTable,
      header: true
    })
    if (await copyTextToClipboard(text))
      toast.success(`${formatCount(shownRows.length)} rows copied`)
    else toast.error('Could not copy to the clipboard')
  }
  const rowsLabel = filtering
    ? `Shown rows (${formatCount(shownRows.length)} of ${formatCount(active?.output.rows.length ?? 0)})`
    : `Loaded rows (${formatCount(active?.output.rows.length ?? 0)})`

  return (
    <div
      className={cn('relative flex min-h-0 flex-1 flex-col', className)}
      data-testid="data-project-results"
    >
      <div className="@container/rp flex h-8 shrink-0 items-center border-b border-border bg-card">
        <div className="flex h-full min-w-[96px] flex-1 items-center overflow-x-auto [scrollbar-width:none]">
          {resultSets.map((set, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onSelectResult(i)}
              data-testid={`data-project-result-tab-${i}`}
              className={cn(
                'relative flex h-full shrink-0 items-center gap-1.5 border-r border-border px-3 text-[12px]',
                run.activeResult === i
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {resultSets.length > 1 ? `Result ${i + 1}` : 'Result'}
              <span className="text-[10px] text-muted-foreground">
                {formatCount(set.output.rows.length, true)}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => onSelectResult(-1)}
            data-testid="data-project-result-tab-messages"
            className={cn(
              'relative flex h-full shrink-0 items-center gap-1.5 border-r border-border px-3 text-[12px]',
              run.activeResult === -1
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Messages
            {failures > 0 && (
              <span className="rounded-full bg-red-500/20 px-1.5 text-[10px] font-semibold text-red-600 dark:text-red-400">
                {failures}
              </span>
            )}
          </button>
        </div>
        {active && (
          <div className="flex min-w-0 shrink items-center justify-end gap-0.5 px-1">
            <QuickFilter value={view.text} onChange={(text) => setView((v) => ({ ...v, text }))} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-1.5 text-[12px] @[520px]/rp:px-2"
                  title="Copy rows"
                  data-testid="data-project-results-copy"
                >
                  <Copy className="h-3.5 w-3.5" />
                  <span className="hidden @[520px]/rp:inline">Copy</span>
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                  {filtering ? 'Copy the shown rows as' : 'Copy all rows as'}
                </DropdownMenuLabel>
                {COPY_FORMATS.map((f) => (
                  <DropdownMenuItem
                    key={f.format}
                    onSelect={() => void copyAll(f.format)}
                    data-testid={`data-project-results-copy-${f.format}`}
                  >
                    {f.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-1.5 text-[12px] @[520px]/rp:px-2"
                  title="Export rows"
                  data-testid="data-project-results-export"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span className="hidden @[520px]/rp:inline">Export</span>
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[240px]">
                <DropdownMenuLabel>{rowsLabel}</DropdownMenuLabel>
                {COPY_FORMATS.filter((f) => f.format !== 'tsv').map((f) => (
                  <DropdownMenuItem
                    key={f.format}
                    onSelect={() =>
                      void saveVisibleResults(
                        active.output.columns,
                        shownRows,
                        f.format,
                        resultName,
                        {
                          dialect,
                          table: insertTable
                        }
                      )
                    }
                    data-testid={`data-project-results-save-${f.format}`}
                  >
                    Save as {f.label}…
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>All rows (runs the statement again, no limit)</DropdownMenuLabel>
                {FULL_EXPORT_FORMATS.map((f) => (
                  <DropdownMenuItem
                    key={f.format}
                    onSelect={() =>
                      void startFullExport({
                        dataProjectId: project.id,
                        source: {
                          kind: 'query',
                          text: active.statement.text,
                          ...(run.database ? { database: run.database } : {}),
                          // A fresh server connection: without the run's schema an unqualified
                          // PG table outside the default search_path would not be found.
                          ...(run.schema ? { schema: run.schema } : {})
                        },
                        format: f.format
                      })
                    }
                    data-testid={`data-project-results-export-${f.format}`}
                  >
                    Export all as {f.label}…
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-6 shrink-0 px-1.5 text-[12px]',
                rowDetailOpen && 'bg-accent text-foreground'
              )}
              onClick={() => {
                setRowDetailOpen(!rowDetailOpen)
                gridRef.current?.focus()
              }}
              aria-pressed={rowDetailOpen}
              title="Row detail: every column of the selected row (Space)"
              data-testid="data-project-results-row-detail"
            >
              <PanelRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {active && view.values.length > 0 && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-card px-2 py-1 text-[11px]"
          data-testid="data-project-results-value-filters"
        >
          <Filter className="h-3 w-3 text-muted-foreground" />
          {view.values.map((f) => (
            <span
              key={f.col}
              className="flex max-w-[240px] items-center gap-1 rounded-full bg-sky-500/15 py-0.5 pl-2 pr-1 text-sky-700 dark:text-sky-300"
            >
              <span className="truncate font-mono">
                {active.output.columns[f.col]?.name} ={' '}
                {f.value === null ? 'NULL' : cellDisplayText(f.value, 60)}
              </span>
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-sky-500/20"
                title="Remove this filter"
                onClick={() =>
                  setView((v) => ({ ...v, values: v.values.filter((x) => x.col !== f.col) }))
                }
                data-testid={`data-project-results-value-filter-remove-${f.col}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="ml-1 text-muted-foreground hover:text-foreground"
            onClick={() => setView((v) => ({ ...v, values: [], text: '' }))}
          >
            Clear filters
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        {active ? (
          <ResultGrid
            ref={gridRef}
            key={`${run.runId}-${run.activeResult}`}
            columns={active.output.columns}
            rows={shownRows}
            sortedColumns={view.sort}
            onSortColumn={(_name, additive, col) =>
              setView((v) => ({ ...v, sort: nextClientSort(v.sort, col, additive) }))
            }
            onFilterByValue={(_name, value, col) => setView((v) => withValueFilter(v, col, value))}
            dialect={dialect}
            insertTable={insertTable}
            rowDetail={{ open: rowDetailOpen, onOpenChange: setRowDetailOpen }}
            emptyMessage={filtering ? 'No loaded rows match the filter' : '0 rows'}
          />
        ) : (
          <MessagesView run={run} dialect={dialect} onShowError={onShowError} />
        )}
        {run.status === 'running' && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-background/60 backdrop-blur-[1px]"
            data-testid="data-project-running"
          >
            <div className="flex items-center gap-3 rounded-[10px] border border-border bg-card px-4 py-2.5 text-[13px] shadow-lg">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span>
                {run.cancelRequested
                  ? 'Cancelling…'
                  : run.queryId
                    ? 'Running…'
                    : 'Waiting for confirmation…'}
              </span>
              <span className="text-muted-foreground">
                <Elapsed since={run.startedAt} />
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={onCancel}
                disabled={!run.queryId || run.cancelRequested}
                data-testid="data-project-results-cancel"
              >
                <Square className="h-3 w-3" />
                Cancel
                <ShortcutHint label="⌘." />
              </Button>
            </div>
          </div>
        )}
      </div>

      <div
        className="flex h-7 shrink-0 items-center gap-2 overflow-hidden border-t border-border bg-card px-2 text-[11px] text-muted-foreground"
        data-testid="data-project-status-line"
      >
        {active ? (
          <>
            <span className="text-foreground" data-testid="data-project-status-rows">
              {filtering && `${formatCount(shownRows.length)} of `}
              {formatCount(active.output.rows.length)}{' '}
              {active.output.rows.length === 1 ? 'row' : 'rows'}
            </span>
            {active.output.truncated && (
              <span
                className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-300"
                data-testid="data-project-truncated"
              >
                Limited to {formatCount(active.output.limit)}
                {active.output.autoLimited &&
                  active.output.limit !== null &&
                  active.output.limit < 100_000 && (
                    <>
                      <span>·</span>
                      <button
                        type="button"
                        className="font-medium hover:underline"
                        onClick={() =>
                          onRerun(
                            rerunTarget(active.statement),
                            Math.min((active.output.limit ?? 1000) * 10, 100_000)
                          )
                        }
                        data-testid="data-project-load-more"
                      >
                        Load {formatCount(Math.min((active.output.limit ?? 1000) * 10, 100_000))}
                      </button>
                      <span>·</span>
                      <button
                        type="button"
                        className="font-medium hover:underline"
                        onClick={() => onRerun(rerunTarget(active.statement), null)}
                        data-testid="data-project-load-all"
                      >
                        Load all
                      </button>
                    </>
                  )}
                {!active.output.autoLimited && (
                  <span>· the row cap was reached; export to get every row</span>
                )}
              </span>
            )}
            <span>{formatDuration(active.statement.durationMs)}</span>
            {active.statement.stats?.rowsRead !== undefined && (
              <span>
                read {formatCount(active.statement.stats.rowsRead, true)} rows
                {active.statement.stats.bytesRead !== undefined
                  ? ` · ${formatBytes(active.statement.stats.bytesRead)}`
                  : ''}
              </span>
            )}
            {active.statement.executedText &&
              active.statement.executedText !== active.statement.text && (
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => setShowExecuted((v) => !v)}
                  data-testid="data-project-executed-toggle"
                >
                  {showExecuted ? 'Hide executed SQL' : 'Executed SQL'}
                </button>
              )}
          </>
        ) : run.status !== 'running' ? (
          <span>
            {run.statements.length} {run.statements.length === 1 ? 'statement' : 'statements'}
            {run.durationMs !== undefined ? ` · ${formatDuration(run.durationMs)}` : ''}
          </span>
        ) : null}
        {run.inTransaction && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-300">
            Transaction open
          </span>
        )}
        {run.database && <span className="ml-auto truncate">{run.database}</span>}
      </div>
      {active && showExecuted && active.statement.executedText && (
        <div className="max-h-32 shrink-0 overflow-auto border-t border-border bg-card px-2 py-1">
          <SqlText text={active.statement.executedText} dialect={dialect} />
        </div>
      )}
    </div>
  )
}
