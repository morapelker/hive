// The Console tab of a data project (TablePlus' Console log): every statement the app sent to
// the server, oldest first, live while the tab is mounted — editor queries, table pages and
// their counts, grid edits with their transaction, exports, schema actions, kills, the
// assistant's reads, the Mongo views' commands — and, behind "Show metadata queries", the
// catalog / introspection / session statements the drivers run around them.
//
// Per entry: time (ms), source badge, database, duration, rows / affected, status; the text is
// highlighted and clamped to three lines (expand to read it all), errors below it. Filter box
// (text, error, database), source menu, Errors only, Follow (stays at the newest entry while
// scrolled to the bottom; "Jump to latest" otherwise). Copy (one entry, one with its details,
// or every visible entry as a commented script), Open in a query tab / Shell tab (never runs:
// the statement lands in a new editor tab; not for summaries, cut texts, or texts whose secrets
// were masked — those carry a "masked" mark), Clear (the server's log for this project). Keys on
// the list: ↑ / ↓ select, Enter opens, ⌘C copies the selected statement, Esc deselects.
//
// The log lives in server memory (masked like history, capped per project); see
// main/services/data-projects/console-log.ts.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Copy,
  CopyPlus,
  ExternalLink,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  Trash2,
  XCircle
} from 'lucide-react'
import type { DataConsoleEntry, DataConsoleSource } from '@shared/data-projects/console-types'
import type { SqlDialect } from '@shared/data-projects/types'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { errorMessage } from '@/components/data-projects/data-project-ui'
import { formatDuration } from '../shared/format-utils'
import { SqlText } from '../shared/SqlText'
import {
  CONSOLE_SOURCE_CLASS,
  CONSOLE_SOURCE_FILTERS,
  CONSOLE_SOURCE_HINT,
  CONSOLE_SOURCE_LABEL,
  consoleEntryBlock,
  consoleLogText,
  consoleOpenBlocker,
  formatConsoleCounts,
  formatConsoleTime,
  isMaskedConsoleEntry,
  matchesConsoleFilter,
  type ConsoleFilter
} from './console-format'
import { followDataConsole, useDataConsoleStore, type ConsoleProjectLog } from './console-store'

export interface ConsolePanelProps {
  projectId: string
  /** Highlighting dialect of SQL entries; null for MongoDB (mongosh text). */
  dialect: SqlDialect | null
  /** Opens a statement in a new query / Shell tab of the workspace (never runs it). */
  onOpen: (text: string, database: string | undefined) => void
  className?: string
}

const EMPTY_LOG: ConsoleProjectLog = { entries: [], epoch: null, status: 'idle', error: null }
/** Characters of a collapsed entry rendered (and highlighted). */
const COLLAPSED_CHARS = 1_200
/** Within this many pixels of the bottom, the list follows new entries. */
const FOLLOW_SLACK_PX = 32

const isLong = (entry: DataConsoleEntry): boolean =>
  entry.text.length > 240 || entry.text.split('\n', 4).length > 3

async function copyText(text: string, what: string): Promise<void> {
  if (await copyTextToClipboard(text)) toast.success(`${what} copied`)
  else toast.error('Could not copy to the clipboard')
}

interface RowProps {
  entry: DataConsoleEntry
  dialect: SqlDialect | null
  selected: boolean
  expanded: boolean
  openLabel: string
  onSelect: (seq: number) => void
  onToggle: (seq: number) => void
  onOpen: (entry: DataConsoleEntry) => void
}

const ConsoleRow = memo(function ConsoleRow({
  entry,
  dialect,
  selected,
  expanded,
  openLabel,
  onSelect,
  onToggle,
  onOpen
}: RowProps): React.JSX.Element {
  const blocker = consoleOpenBlocker(entry)
  const long = isLong(entry)
  const metadata = entry.source === 'metadata'
  const counts = formatConsoleCounts(entry)
  const text =
    expanded || entry.text.length <= COLLAPSED_CHARS
      ? entry.text
      : `${entry.text.slice(0, COLLAPSED_CHARS)}…`
  return (
    <div
      role="option"
      aria-selected={selected}
      data-seq={entry.seq}
      data-source={entry.source}
      data-status={entry.status}
      data-testid={`data-project-console-entry-${entry.seq}`}
      onClick={() => onSelect(entry.seq)}
      onDoubleClick={() => !blocker && onOpen(entry)}
      className={cn(
        'group cursor-default border-b border-l-2 border-b-border/60 px-3 py-1.5 [contain-intrinsic-size:auto_56px] [content-visibility:auto] hover:bg-accent/40',
        entry.status === 'error'
          ? 'border-l-red-500'
          : entry.status === 'cancelled'
            ? 'border-l-muted-foreground/40'
            : 'border-l-transparent',
        selected && 'bg-accent/60 hover:bg-accent/60'
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
        {entry.status === 'error' ? (
          <XCircle className="h-3 w-3 shrink-0 text-red-500" />
        ) : entry.status === 'cancelled' ? (
          <CircleSlash className="h-3 w-3 shrink-0" />
        ) : null}
        <span className="shrink-0 font-mono tabular-nums">{formatConsoleTime(entry.at)}</span>
        <span
          className={cn(
            'shrink-0 rounded-[4px] px-1 text-[10px] font-semibold uppercase tracking-[0.04em]',
            CONSOLE_SOURCE_CLASS[entry.source]
          )}
          title={CONSOLE_SOURCE_HINT[entry.source]}
        >
          {CONSOLE_SOURCE_LABEL[entry.source]}
        </span>
        {entry.database && (
          <span className="min-w-0 max-w-[180px] truncate" title={entry.database}>
            {entry.database}
          </span>
        )}
        {entry.durationMs !== null && (
          <span className="shrink-0 tabular-nums">{formatDuration(entry.durationMs)}</span>
        )}
        {counts && <span className="shrink-0 tabular-nums">{counts}</span>}
        {entry.status === 'cancelled' && <span className="shrink-0">cancelled</span>}
        {isMaskedConsoleEntry(entry) && (
          <span
            className="shrink-0 rounded-[4px] bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300"
            title="Secrets in this statement were masked (***): it is not the text that ran"
            data-testid={`data-project-console-masked-${entry.seq}`}
          >
            masked
          </span>
        )}
        <div
          className={cn(
            'ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100',
            selected && 'opacity-100'
          )}
        >
          {long && (
            <button
              type="button"
              className="rounded p-0.5 hover:bg-accent"
              title={expanded ? 'Collapse' : 'Show all of it'}
              aria-label={expanded ? 'Collapse' : 'Expand'}
              onClick={(e) => {
                e.stopPropagation()
                onToggle(entry.seq)
              }}
              data-testid={`data-project-console-expand-${entry.seq}`}
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
          )}
          <button
            type="button"
            className="rounded p-0.5 hover:bg-accent"
            title="Copy"
            aria-label="Copy"
            onClick={(e) => {
              e.stopPropagation()
              void copyText(entry.text, 'Statement')
            }}
            data-testid={`data-project-console-copy-${entry.seq}`}
          >
            <Copy className="h-3 w-3" />
          </button>
          <button
            type="button"
            className="rounded p-0.5 hover:bg-accent disabled:opacity-40"
            title={blocker ?? openLabel}
            aria-label={openLabel}
            disabled={!!blocker}
            onClick={(e) => {
              e.stopPropagation()
              onOpen(entry)
            }}
            data-testid={`data-project-console-open-${entry.seq}`}
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        </div>
      </div>
      <SqlText
        text={text}
        dialect={entry.language === 'sql' && !entry.summary ? dialect : null}
        className={cn(
          'mt-0.5 text-[12px]',
          !expanded && 'line-clamp-3',
          (metadata || entry.summary) && 'text-muted-foreground',
          entry.summary && 'italic'
        )}
      />
      {entry.error && (
        <div
          className={cn(
            'mt-0.5 whitespace-pre-wrap break-words text-[11px] text-red-600 dark:text-red-400',
            !expanded && 'line-clamp-2'
          )}
        >
          {entry.error}
        </div>
      )}
    </div>
  )
})

export function ConsolePanel({
  projectId,
  dialect,
  onOpen,
  className
}: ConsolePanelProps): React.JSX.Element {
  const log = useDataConsoleStore((s) => s.logs[projectId]) ?? EMPTY_LOG
  const showMetadata = useDataConsoleStore((s) => s.showMetadata)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [source, setSource] = useState<DataConsoleSource | 'all'>('all')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const [menuSeq, setMenuSeq] = useState<number | null>(null)
  const [behind, setBehind] = useState(false)
  const [clearing, setClearing] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const openLabel = dialect === null ? 'Open in a Shell tab' : 'Open in a query tab'

  useEffect(() => followDataConsole(projectId), [projectId])

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search), 150)
    return () => window.clearTimeout(t)
  }, [search])

  const filter = useMemo<ConsoleFilter>(
    () => ({ text: debounced, source, metadata: showMetadata, errorsOnly }),
    [debounced, source, showMetadata, errorsOnly]
  )
  const visible = useMemo(
    () => log.entries.filter((e) => matchesConsoleFilter(e, filter)),
    [log.entries, filter]
  )
  const hiddenMetadata = useMemo(
    () => (showMetadata ? 0 : log.entries.filter((e) => e.source === 'metadata').length),
    [log.entries, showMetadata]
  )
  const bySeq = useMemo(() => new Map(log.entries.map((e) => [e.seq, e])), [log.entries])

  // Follow the newest entry while the list sits at its bottom.
  const lastSeq = visible.at(-1)?.seq ?? 0
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (atBottom.current) el.scrollTop = el.scrollHeight
    else if (lastSeq) setBehind(true)
  }, [lastSeq])
  // A hidden tab (the SQL workspace keeps visited tabs mounted) cannot scroll: catch up when it
  // gets a size again, and keep the bottom in view when the pane is resized.
  const hasList = visible.length > 0
  useEffect(() => {
    const el = listRef.current
    if (!el || !hasList || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasList])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX
    if (atBottom.current) setBehind(false)
  }

  const jumpToLatest = (): void => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
    atBottom.current = true
    setBehind(false)
  }

  const open = useCallback(
    (entry: DataConsoleEntry) => {
      if (consoleOpenBlocker(entry)) return
      onOpen(entry.text, entry.database ?? undefined)
    },
    [onOpen]
  )
  const toggle = useCallback((seq: number) => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }, [])
  const select = useCallback((seq: number) => setSelected(seq), [])

  const clear = async (): Promise<void> => {
    setClearing(true)
    try {
      await useDataConsoleStore.getState().clear(projectId)
      setSelected(null)
      setExpanded(new Set())
    } catch (error) {
      toast.error(`Could not clear the console: ${errorMessage(error)}`)
    } finally {
      setClearing(false)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (visible.length === 0) return
    const index = selected === null ? -1 : visible.findIndex((e) => e.seq === selected)
    const move = (to: number): void => {
      const entry = visible[Math.max(0, Math.min(visible.length - 1, to))]
      setSelected(entry.seq)
      listRef.current
        ?.querySelector(`[data-seq="${entry.seq}"]`)
        ?.scrollIntoView?.({ block: 'nearest' })
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(index < 0 ? visible.length - 1 : index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(index < 0 ? visible.length - 1 : index - 1)
    } else if (event.key === 'Enter' && index >= 0) {
      event.preventDefault()
      open(visible[index])
    } else if (event.key === 'Escape' && selected !== null) {
      event.preventDefault()
      setSelected(null)
    } else if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'c' &&
      index >= 0 &&
      !window.getSelection()?.toString()
    ) {
      event.preventDefault()
      void copyText(visible[index].text, 'Statement')
    }
  }

  const menuEntry = menuSeq === null ? undefined : bySeq.get(menuSeq)
  const filtered = !!debounced.trim() || source !== 'all' || errorsOnly

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col', className)}
      data-testid="data-project-console"
    >
      <div className="@container/console flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1">
        <div className="relative min-w-[120px] max-w-72 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter statements…"
            data-testid="data-project-console-filter"
            className="h-7 w-full rounded-md border border-input bg-transparent pl-7 pr-2 text-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as DataConsoleSource | 'all')}
          title="Show the statements of one source"
          data-testid="data-project-console-source"
          className="h-7 rounded-md border border-input bg-background px-1.5 text-[12px]"
        >
          <option value="all">All sources</option>
          {CONSOLE_SOURCE_FILTERS.map((s) => (
            <option key={s} value={s} title={CONSOLE_SOURCE_HINT[s]}>
              {CONSOLE_SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
        <label
          className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground"
          title="Also list the catalog, introspection and session statements the app runs (USE, SET, schema lookups…)"
        >
          <input
            type="checkbox"
            checked={showMetadata}
            onChange={(e) => useDataConsoleStore.getState().setShowMetadata(e.target.checked)}
            data-testid="data-project-console-metadata"
          />
          <span className="@[620px]/console:hidden">Metadata</span>
          <span className="hidden @[620px]/console:inline">Show metadata queries</span>
        </label>
        <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
            data-testid="data-project-console-errors"
          />
          Errors
        </label>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span
            className="hidden text-[11px] tabular-nums text-muted-foreground @[560px]/console:inline"
            data-testid="data-project-console-count"
          >
            {visible.length.toLocaleString('en-US')} of {log.entries.length.toLocaleString('en-US')}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void useDataConsoleStore.getState().load(projectId)}
            title="Reload the log"
            data-testid="data-project-console-refresh"
          >
            {log.status === 'loading' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={visible.length === 0}
            onClick={() =>
              void copyText(
                consoleLogText(visible),
                `${visible.length === 1 ? '1 statement' : `${visible.length.toLocaleString('en-US')} statements`}`
              )
            }
            title="Copy the visible statements (with their time, source and duration)"
            data-testid="data-project-console-copy-all"
          >
            <CopyPlus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={log.entries.length === 0 || clearing}
            onClick={() => void clear()}
            title="Empty this connection’s console log"
            data-testid="data-project-console-clear"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="hidden @[420px]/console:inline">Clear</span>
          </Button>
        </div>
      </div>
      {log.status === 'error' && log.error && (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border bg-red-500/10 px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400"
          data-testid="data-project-console-error"
        >
          <span className="min-w-0 flex-1 truncate">{log.error}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void useDataConsoleStore.getState().load(projectId)}
          >
            Retry
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {log.entries.length === 0 && (log.status === 'loading' || log.status === 'idle') ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : visible.length === 0 ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"
            data-testid="data-project-console-empty"
          >
            <ScrollText className="h-8 w-8 opacity-50" />
            {filtered ? (
              'No matching statements'
            ) : (
              <>
                <span>No statements yet</span>
                <span className="max-w-sm text-[12px]">
                  What the app sends to this server — your queries, table pages, edits, exports — is
                  listed here as it runs.
                  {dialect === null &&
                    ' MongoDB commands are recorded while a Console tab is open (monitoring slows big reads).'}
                </span>
              </>
            )}
            {hiddenMetadata > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => useDataConsoleStore.getState().setShowMetadata(true)}
                data-testid="data-project-console-show-metadata"
              >
                Show {hiddenMetadata.toLocaleString('en-US')} metadata{' '}
                {hiddenMetadata === 1 ? 'query' : 'queries'}
              </Button>
            )}
          </div>
        ) : (
          <ContextMenu onOpenChange={(open) => !open && setMenuSeq(null)}>
            <ContextMenuTrigger asChild>
              <div
                ref={listRef}
                role="listbox"
                aria-label="Console log"
                tabIndex={0}
                onScroll={onScroll}
                onKeyDown={onKeyDown}
                onContextMenu={(e) => {
                  const row = (e.target as HTMLElement).closest('[data-seq]')
                  const seq = row ? Number(row.getAttribute('data-seq')) : null
                  setMenuSeq(seq)
                  if (seq !== null) setSelected(seq)
                }}
                className="h-full overflow-y-auto outline-none"
                data-testid="data-project-console-list"
              >
                {visible.map((entry) => (
                  <ConsoleRow
                    key={entry.seq}
                    entry={entry}
                    dialect={dialect}
                    selected={entry.seq === selected}
                    expanded={expanded.has(entry.seq)}
                    openLabel={openLabel}
                    onSelect={select}
                    onToggle={toggle}
                    onOpen={open}
                  />
                ))}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-60">
              <ContextMenuItem
                disabled={!menuEntry}
                onSelect={() => menuEntry && void copyText(menuEntry.text, 'Statement')}
              >
                <Copy className="mr-2 h-3.5 w-3.5" />
                Copy statement
                <ContextMenuShortcut>⌘C</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!menuEntry}
                onSelect={() =>
                  menuEntry && void copyText(consoleEntryBlock(menuEntry), 'Statement')
                }
              >
                <CopyPlus className="mr-2 h-3.5 w-3.5" />
                Copy with details
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={!menuEntry || !!consoleOpenBlocker(menuEntry)}
                onSelect={() => menuEntry && open(menuEntry)}
              >
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                {openLabel}
                <ContextMenuShortcut>↵</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
        {behind && visible.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            className="absolute bottom-3 right-4 h-6 gap-1 rounded-full px-2.5 text-[11px] shadow-md"
            onClick={jumpToLatest}
            data-testid="data-project-console-jump"
          >
            <ArrowDownToLine className="h-3 w-3" />
            Jump to latest
          </Button>
        )}
      </div>
    </div>
  )
}

export default ConsolePanel
