// Running queries / sessions on the server (pg_stat_activity, PROCESSLIST, system.processes,
// $currentOp). Auto-refreshes every 2 s while visible (toggle), filters by text, hides idle
// sessions by default, marks this app's own sessions, and offers Kill query / Kill connection
// behind a confirmation (killing our own session is called out explicitly). The server runs the
// kill through its safety gate as an 'admin' statement.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Loader2, Pause, Play, RefreshCw, Search, Square, Unplug } from 'lucide-react'
import {
  DATA_ERROR_CODES,
  type DataKillScope,
  type DataProcessInfo
} from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { dataErrorCode, errorMessage } from '@/components/data-projects/data-project-ui'
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
import { formatDuration } from './format-utils'

export interface ProcessesPanelProps {
  projectId: string
  className?: string
}

const REFRESH_MS = 2000

const isIdle = (p: DataProcessInfo): boolean =>
  /^(idle|sleep)/i.test(p.state ?? '') || /^sleep$/i.test(p.command ?? '') || (!p.query && !p.isOwn)

const matches = (p: DataProcessInfo, needle: string): boolean => {
  if (!needle) return true
  const n = needle.toLowerCase()
  return [p.id, p.user, p.host, p.database, p.state, p.command, p.query].some((v) =>
    (v ?? '').toString().toLowerCase().includes(n)
  )
}

export function ProcessesPanel({ projectId, className }: ProcessesPanelProps): React.JSX.Element {
  const [processes, setProcesses] = useState<DataProcessInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [hideIdle, setHideIdle] = useState(true)
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [kill, setKill] = useState<{ process: DataProcessInfo; scope: DataKillScope } | null>(null)
  const [killing, setKilling] = useState(false)
  const seqRef = useRef(0)
  const inFlightRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const list = await dataProjectsApi.processes(projectId)
      if (seq !== seqRef.current) return
      setProcesses(list)
      setError(null)
    } catch (err) {
      if (seq !== seqRef.current) return
      if (dataErrorCode(err) === DATA_ERROR_CODES.unsupported) {
        setUnsupported(true)
        setAutoRefresh(false)
      } else setError(errorMessage(err, 'Could not load the process list'))
    } finally {
      inFlightRef.current = false
      if (seq === seqRef.current) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    setProcesses(null)
    setUnsupported(false)
    void load()
    // Invalidate answers of this project's requests after a project switch / unmount.
    const counter = seqRef
    const inFlight = inFlightRef
    return () => {
      counter.current++
      inFlight.current = false
    }
  }, [load])

  useEffect(() => {
    if (!autoRefresh || unsupported) return
    const timer = window.setInterval(() => {
      // Only poll while the panel is on screen: a hidden workspace tab is display:none, which
      // leaves the panel without an offsetParent.
      if (document.visibilityState !== 'visible') return
      if (rootRef.current && rootRef.current.offsetParent === null) return
      void load()
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [autoRefresh, unsupported, load])

  const visible = useMemo(() => {
    const list = (processes ?? []).filter(
      (p) => (!hideIdle || !isIdle(p)) && matches(p, filter.trim())
    )
    return list.sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1))
  }, [processes, hideIdle, filter])
  const selected = visible.find((p) => p.id === selectedId) ?? null

  const confirmKill = async (): Promise<void> => {
    if (!kill) return
    setKilling(true)
    try {
      const res = await dataProjectsApi.kill(projectId, kill.process.id, kill.scope)
      if (res.success)
        toast.success(
          kill.scope === 'query'
            ? `Query ${kill.process.id} cancelled`
            : `Connection ${kill.process.id} killed`
        )
      else toast.warning(`The server did not confirm killing ${kill.process.id}`)
      setKill(null)
      void load()
    } catch (err) {
      toast.error(`Kill failed: ${errorMessage(err)}`)
    } finally {
      setKilling(false)
    }
  }

  const extraKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const p of processes ?? []) for (const k of Object.keys(p.extra ?? {})) keys.add(k)
    return [...keys].slice(0, 3)
  }, [processes])

  if (unsupported) {
    return (
      <div
        className={cn(
          'flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground',
          className
        )}
        data-testid="data-project-processes-unsupported"
      >
        This database has no process list.
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={cn('flex min-h-0 flex-1 flex-col', className)}
      data-testid="data-project-processes"
    >
      <div className="@container/proc flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1">
        <div className="relative min-w-[120px] max-w-64 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by user, database, query…"
            data-testid="data-project-processes-filter"
            className="h-7 w-full rounded-md border border-input bg-transparent pl-7 pr-2 text-[12px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
        <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
          <input
            type="checkbox"
            checked={hideIdle}
            onChange={(e) => setHideIdle(e.target.checked)}
            data-testid="data-project-processes-hide-idle"
          />
          Hide idle
        </label>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span className="hidden text-[11px] text-muted-foreground @[480px]/proc:inline">
            {processes ? `${visible.length} of ${processes.length}` : ''}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAutoRefresh((v) => !v)}
            data-testid="data-project-processes-auto"
            title={autoRefresh ? 'Pause auto-refresh' : 'Auto-refresh every 2 s'}
          >
            {autoRefresh ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {autoRefresh ? 'Auto 2s' : 'Paused'}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void load()}
            title="Refresh"
            data-testid="data-project-processes-refresh"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>
      {error && (
        <div
          className="shrink-0 border-b border-border bg-red-500/10 px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400"
          data-testid="data-project-processes-error"
        >
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {processes === null && !error ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : visible.length === 0 ? (
          <div
            className="p-6 text-center text-sm text-muted-foreground"
            data-testid="data-project-processes-empty"
          >
            {processes && processes.length > 0 ? 'No matching sessions' : 'No other active queries'}
          </div>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="text-left text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
                {[
                  'ID',
                  'User',
                  'Host',
                  'Database',
                  'State',
                  'Command',
                  'Time',
                  'Query',
                  ...extraKeys,
                  ''
                ].map((h, i) => (
                  <th key={`${h}-${i}`} className="border-b border-border px-2 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setSelectedId(p.id === selectedId ? null : p.id)}
                  data-testid={`data-project-process-${p.id}`}
                  className={cn(
                    'group cursor-default border-b border-border/60 align-top hover:bg-accent/40',
                    p.id === selectedId && 'bg-accent/60'
                  )}
                >
                  <td className="whitespace-nowrap px-2 py-1 font-mono">
                    {p.id}
                    {p.isOwn && (
                      <span
                        className="ml-1.5 rounded-[4px] bg-sky-500/15 px-1 font-sans text-[10px] font-semibold text-sky-600 dark:text-sky-400"
                        data-testid={`data-project-process-own-${p.id}`}
                      >
                        THIS APP
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">{p.user ?? ''}</td>
                  <td className="max-w-[140px] truncate px-2 py-1" title={p.host ?? ''}>
                    {p.host ?? ''}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">{p.database ?? ''}</td>
                  <td className="whitespace-nowrap px-2 py-1">{p.state ?? ''}</td>
                  <td className="whitespace-nowrap px-2 py-1">{p.command ?? ''}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">
                    {formatDuration(p.durationMs)}
                  </td>
                  <td className="max-w-[420px] truncate px-2 py-1 font-mono" title={p.query ?? ''}>
                    {p.query ?? ''}
                  </td>
                  {extraKeys.map((k) => (
                    <td key={k} className="whitespace-nowrap px-2 py-1 tabular-nums">
                      {p.extra?.[k] ?? ''}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-1 py-0.5 text-right">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Kill query"
                      onClick={(e) => {
                        e.stopPropagation()
                        setKill({ process: p, scope: 'query' })
                      }}
                      data-testid={`data-project-process-kill-query-${p.id}`}
                    >
                      <Square className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Kill connection"
                      onClick={(e) => {
                        e.stopPropagation()
                        setKill({ process: p, scope: 'connection' })
                      }}
                      data-testid={`data-project-process-kill-connection-${p.id}`}
                    >
                      <Unplug className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {selected && (
        <div
          className="max-h-[40%] shrink-0 overflow-auto border-t border-border bg-card/60 p-2"
          data-testid="data-project-process-detail"
        >
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-semibold uppercase tracking-[0.05em]">Session {selected.id}</span>
            {Object.entries(selected.extra ?? {}).map(([k, v]) => (
              <span key={k}>
                {k}: <span className="text-foreground">{String(v ?? '')}</span>
              </span>
            ))}
            {selected.query && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6"
                onClick={async () => {
                  if (await copyTextToClipboard(selected.query ?? '')) toast.success('Query copied')
                }}
                data-testid="data-project-process-copy-query"
              >
                <Copy className="h-3 w-3" />
                Copy query
              </Button>
            )}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">
            {selected.query || '(no query)'}
          </pre>
        </div>
      )}
      <AlertDialog open={kill !== null} onOpenChange={(open) => !open && !killing && setKill(null)}>
        <AlertDialogContent data-testid="data-project-kill-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[15px]">
              {kill?.scope === 'query'
                ? `Cancel query of session ${kill?.process.id}?`
                : `Kill connection ${kill?.process.id}?`}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]">
              {kill?.process.isOwn
                ? 'This is one of this app’s own sessions: its running query will fail.'
                : kill?.scope === 'connection'
                  ? 'The client is disconnected and its open transaction is rolled back.'
                  : 'The running statement is interrupted; the session stays connected.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {kill?.process.query && (
            <pre className="max-h-32 overflow-auto rounded-md bg-muted px-2 py-1 font-mono text-[12px]">
              {kill.process.query}
            </pre>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="data-project-kill-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={killing}
              onClick={(e) => {
                e.preventDefault()
                void confirmKill()
              }}
              data-testid="data-project-kill-confirm"
            >
              {killing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {kill?.scope === 'query' ? 'Kill query' : 'Kill connection'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
