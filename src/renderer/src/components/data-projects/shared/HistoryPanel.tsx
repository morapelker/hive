// Query history of a data project (server-side, masked): search (server substring filter,
// debounced), status filter, duration / rows / database / time per entry, click to open the text
// in the editor (via `onOpen`, never run), copy, and Clear (confirmed). Refetches when
// `refreshKey` or the SQL workspace's history counter for the project changes (each run bumps it).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Ban,
  CheckCircle2,
  CircleSlash,
  Copy,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  XCircle
} from 'lucide-react'
import type { DataHistoryEntry, SqlDialect } from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { errorMessage } from '@/components/data-projects/data-project-ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useDataWorkspaceStore } from '@/stores/useDataWorkspaceStore'
import { formatCount, formatDuration, formatRelativeTime } from './format-utils'
import { SqlText } from './SqlText'

/** A literal masked by maskSqlSecrets / the Mongo masker ('***' or "***"). */
const MASKED_LITERAL = /(['"])\*\*\*\1/

export interface HistoryPanelProps {
  projectId: string
  onOpen: (text: string, database: string | undefined) => void
  /** Highlighting dialect (null = Mongo shell / plain). */
  dialect?: SqlDialect | null
  /** Change it to refetch (the Mongo workspace bumps its own counter). */
  refreshKey?: number
  className?: string
}

type StatusFilter = 'all' | DataHistoryEntry['status']

const STATUS_ICON: Record<DataHistoryEntry['status'], React.JSX.Element> = {
  ok: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />,
  error: <XCircle className="h-3.5 w-3.5 text-red-500" />,
  cancelled: <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" />,
  blocked: <Ban className="h-3.5 w-3.5 text-amber-500" />
}

const HISTORY_LIMIT = 500

export function HistoryPanel({
  projectId,
  onOpen,
  dialect = null,
  refreshKey = 0,
  className
}: HistoryPanelProps): React.JSX.Element {
  const [entries, setEntries] = useState<DataHistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [confirmClear, setConfirmClear] = useState(false)
  const seqRef = useRef(0)
  const version = useDataWorkspaceStore((s) => s.historyVersion[projectId] ?? 0)

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 250)
    return () => window.clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const list = await dataProjectsApi.history(projectId, debounced || undefined, HISTORY_LIMIT)
      if (seq !== seqRef.current) return
      setEntries(list)
      setError(null)
    } catch (err) {
      if (seq === seqRef.current) setError(errorMessage(err, 'Could not load the history'))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [projectId, debounced])

  useEffect(() => {
    void load()
  }, [load, version, refreshKey])

  useEffect(() => () => void seqRef.current++, [])

  const visible = useMemo(
    () => (entries ?? []).filter((e) => status === 'all' || e.status === status),
    [entries, status]
  )

  const clear = async (): Promise<void> => {
    try {
      await dataProjectsApi.clearHistory(projectId)
      setConfirmClear(false)
      setEntries([])
      useDataWorkspaceStore.getState().bumpHistory(projectId)
      toast.success('History cleared')
    } catch (err) {
      toast.error(`Could not clear the history: ${errorMessage(err)}`)
    }
  }

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col', className)}
      data-testid="data-project-history"
    >
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1">
        <div className="relative min-w-[120px] max-w-72 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search history…"
            data-testid="data-project-history-search"
            className="h-7 w-full rounded-md border border-input bg-transparent pl-7 pr-2 text-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          data-testid="data-project-history-status"
          className="h-7 rounded-md border border-input bg-background px-1.5 text-[12px]"
        >
          <option value="all">All</option>
          <option value="ok">Succeeded</option>
          <option value="error">Failed</option>
          <option value="cancelled">Cancelled</option>
          <option value="blocked">Blocked</option>
        </select>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void load()}
            title="Refresh"
            data-testid="data-project-history-refresh"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!entries?.length}
            onClick={() => setConfirmClear(true)}
            data-testid="data-project-history-clear"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      </div>
      {error && (
        <div
          className="shrink-0 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400"
          data-testid="data-project-history-error"
        >
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries === null && !error ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : visible.length === 0 ? (
          <div
            className="p-6 text-center text-sm text-muted-foreground"
            data-testid="data-project-history-empty"
          >
            {debounced || status !== 'all' ? 'No matching queries' : 'No queries run yet'}
          </div>
        ) : (
          <ul>
            {visible.map((entry) => (
              <li
                key={entry.id}
                className="group border-b border-border/60 px-3 py-2 hover:bg-accent/40"
                data-testid={`data-project-history-entry-${entry.id}`}
              >
                <button
                  type="button"
                  className="block w-full text-left"
                  title="Open in the editor"
                  onClick={() => {
                    onOpen(entry.text, entry.database ?? undefined)
                    // History is stored masked: running a masked literal would write '***'.
                    if (MASKED_LITERAL.test(entry.text))
                      toast.warning(
                        'Secrets in this query were masked (***). Put the real values back before running it.'
                      )
                  }}
                  data-testid={`data-project-history-open-${entry.id}`}
                >
                  <SqlText
                    text={entry.text.length > 600 ? `${entry.text.slice(0, 600)}…` : entry.text}
                    dialect={dialect}
                    className="line-clamp-4"
                  />
                </button>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  {STATUS_ICON[entry.status]}
                  <span>{formatRelativeTime(entry.executedAt)}</span>
                  {entry.database && <span>· {entry.database}</span>}
                  {entry.durationMs !== null && <span>· {formatDuration(entry.durationMs)}</span>}
                  {entry.rowCount !== null && (
                    <span>
                      · {formatCount(entry.rowCount)} {entry.rowCount === 1 ? 'row' : 'rows'}
                    </span>
                  )}
                  <button
                    type="button"
                    className="ml-auto rounded p-0.5 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
                    title="Copy"
                    onClick={async () => {
                      if (await copyTextToClipboard(entry.text)) toast.success('Query copied')
                    }}
                    data-testid={`data-project-history-copy-${entry.id}`}
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
                {entry.error && (
                  <div className="mt-0.5 line-clamp-2 text-[11px] text-red-600 dark:text-red-400">
                    {entry.error}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[15px]">Clear query history?</AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]">
              Every history entry of this connection is deleted. Saved queries are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault()
                void clear()
              }}
              data-testid="data-project-history-clear-confirm"
            >
              Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
