// The header session counter (Settings › Advanced › "Session profiler", off by default): an
// activity icon with the number of agent CLI processes (claude / codex) the app has alive, tinted
// when some of them look like leftovers — the session completed, its ticket is done, its worktree
// is archived, it fell out of the PTY registry, or it has been idle for a long time. Resting the
// pointer on it opens a panel with the app's CPU and memory, one row per process (ticket, status,
// pid, memory, CPU, idle time, why it looks leftover) and a Stop per row plus "Clear N irrelevant".
//
// Stopping only kills the process: the session row, its tab and its ticket stay as they are, and
// the next time the session is opened it respawns with `--resume`. The renderer's own view of the
// session is released too (useSessionStore.releaseSessionTerminal) so that respawn happens.
//
// Off means off: the exported component reads the setting and returns null, and everything else
// — the poll, the listeners, the RPCs — lives in the inner component that only mounts when it is
// on. Main samples the OS only when asked (one `ps -A` per call, cached a few seconds), so the
// cadence is ours: once on mount, every minute while the window is visible, when the window comes
// back after a minute away, when the panel opens, and right after a stop. Requests never overlap.
//
// The panel is the same non-modal hover popover as the achievements chip next to it (intent
// delays, a close delay that bridges the gap to the panel, Escape / click outside closes it);
// clicking the icon pins it open so it can be read without keeping the pointer on it.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Loader2, RefreshCw, Square } from 'lucide-react'
import { sessionProfilerApi } from '@/api/session-profiler-api'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { toast } from '@/lib/toast'
import { isPausedSessionEntry } from '@/lib/in-progress-sessions'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTimerTickStore } from '@/stores/useTimerTickStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type {
  SessionProfilerAgentKind,
  SessionProfilerIrrelevantReason,
  SessionProfilerKillResult,
  SessionProfilerSession,
  SessionProfilerSnapshot
} from '@shared/types/session-profiler'

const POLL_INTERVAL_MS = 60_000
/** The window coming back to the front re-samples unless the last sample is this recent. */
const VISIBLE_REFRESH_AFTER_MS = 60_000
/** The panel opening re-samples unless the last sample is this recent. */
const OPEN_REFRESH_AFTER_MS = 5_000
const HOVER_OPEN_DELAY_MS = 150
const HOVER_CLOSE_DELAY_MS = 250
/** Bulk clear stops this many at once (an untracked stop can wait up to 3 s for the process). */
const BULK_STOP_CONCURRENCY = 3
/** The icon turns from amber to red at this many leftover sessions. */
const RED_AT_IRRELEVANT = 5

/** Live statuses during which a session must not be stopped from here. */
const BUSY_STATUS_LABELS: Record<string, string> = {
  working: 'working',
  planning: 'planning',
  answering: 'answering',
  permission: 'waiting for permission',
  command_approval: 'waiting for command approval',
  plan_ready: 'plan waiting for approval'
}

const REASON_LABELS: Record<SessionProfilerIrrelevantReason, { label: string; title: string }> = {
  no_session_row: {
    label: 'no session',
    title: 'No session in the database owns this process (deleted, or the database was reset).'
  },
  session_completed: {
    label: 'completed',
    title: 'The session is marked completed, but its process is still running.'
  },
  worktree_archived: {
    label: 'worktree archived',
    title: "The session's worktree was archived."
  },
  ticket_done: { label: 'ticket done', title: 'The ticket is in Done or archived.' },
  untracked: {
    label: 'untracked',
    title: "The process is not in the app's terminal registry: it leaked out of it."
  },
  idle: { label: 'idle', title: 'No terminal input or output for a long time.' }
}

const AGENT_LABELS: Record<SessionProfilerAgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  other: 'Agent'
}

const COLUMN_LABELS: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  merged: 'Merged',
  done: 'Done'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

function formatCpu(percent: number | null): string {
  if (percent === null) return '—'
  if (percent < 10) return `${percent.toFixed(1)}%`
  return `${Math.round(percent)}%`
}

/** "45s", "12m", "3h 12m", "2d 4h". */
function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function rowTitle(row: SessionProfilerSession): string {
  return row.ticket?.title || row.name || 'Unknown session'
}

function rowKey(row: SessionProfilerSession): string {
  return `${row.pid}:${row.startedAt}`
}

function statusLabel(status: string): string {
  return BUSY_STATUS_LABELS[status] ?? status.replace(/_/g, ' ')
}

/** Leftover sessions first, then the heaviest. */
function sortSessions(sessions: SessionProfilerSession[]): SessionProfilerSession[] {
  return [...sessions].sort((a, b) => {
    const aIrrelevant = a.irrelevantReasons.length > 0 ? 1 : 0
    const bIrrelevant = b.irrelevantReasons.length > 0 ? 1 : 0
    if (aIrrelevant !== bIrrelevant) return bIrrelevant - aIrrelevant
    return b.rssBytes - a.rssBytes
  })
}

function reasonLabel(reason: string): { label: string; title?: string } {
  return (
    (REASON_LABELS as Partial<Record<string, { label: string; title: string }>>)[reason] ?? {
      label: reason.replace(/_/g, ' ')
    }
  )
}

/**
 * Why a session must not be stopped from here at all, or null — what the user is looking at or
 * a turn in progress, read from the renderer's stores at call time: the tab in front, the pinned
 * session on the board, an inline connection tab, a ticket modal or tile showing the session, or
 * a working-ish status.
 *
 * Only the app's own PTY (a tracked row) is what those views and statuses describe. An untracked
 * row with the same session id is an orphan or a leaked earlier process of that session: nothing
 * is attached to it, and main re-verifies it before signalling it.
 */
function protectionReason(row: SessionProfilerSession): string | null {
  const id = row.sessionId
  if (!id || !row.tracked) return null
  // The same three checks as useSessionStore's isSessionOnScreen, each with its own label.
  const sessions = useSessionStore.getState()
  if (sessions.activeSessionId === id) return 'active tab'
  if (sessions.activePinnedSessionId === id) return 'pinned on the board'
  if (sessions.inlineConnectionSessionId === id) return 'open as a connection tab'
  if ((sessions.sessionMountRequests.get(id) ?? 0) > 0) return 'open in a ticket or tile'
  const status = useWorktreeStatusStore.getState().sessionStatuses[id]?.status
  if (status && status in BUSY_STATUS_LABELS) return BUSY_STATUS_LABELS[status]
  return null
}

/**
 * Why a bulk clear skips a session, or null. On top of `protectionReason`: a paused turn (the
 * last Stop left a scheduled wakeup, monitor or subagent that resumes the agent by itself, or an
 * API-error auto-resume is pending — as the renderer's status store or main's `paused` sees it), main's last hook status (a turn the
 * renderer has not heard of yet) and pending background work keep it. A single Stop on such a
 * row is still the user's call.
 */
function bulkSkipReason(row: SessionProfilerSession): string | null {
  const protection = protectionReason(row)
  if (protection) return protection
  if (
    row.paused ||
    (row.tracked &&
      row.sessionId &&
      isPausedSessionEntry(useWorktreeStatusStore.getState().sessionStatuses[row.sessionId]))
  ) {
    return 'waiting to wake up'
  }
  if (row.liveStatus && row.liveStatus in BUSY_STATUS_LABELS) {
    return BUSY_STATUS_LABELS[row.liveStatus]
  }
  if (row.backgroundWork > 0) return 'background work pending'
  return null
}

/** Rows a bulk clear stops: leftover, and nothing keeps them. */
function clearableRows(sessions: SessionProfilerSession[]): SessionProfilerSession[] {
  return sessions.filter((row) => row.irrelevantReasons.length > 0 && !bulkSkipReason(row))
}

/**
 * Stops one session's process. Only when the app's own PTY was torn down is the renderer's view
 * released: an untracked process is not the one any view is attached to.
 */
async function stopSession(row: SessionProfilerSession): Promise<SessionProfilerKillResult> {
  const result = await sessionProfilerApi.kill({
    sessionId: row.sessionId,
    pid: row.pid,
    startedAt: row.startedAt
  })
  if (result.ok && row.sessionId && (result.method === 'pty' || (!result.method && row.tracked))) {
    useSessionStore.getState().releaseSessionTerminal?.(row.sessionId)
  }
  return result
}

interface BulkOutcome {
  row: SessionProfilerSession
  error: string | null
  /** Why the row was left alone after all (the stores moved while the batch ran). */
  skipped?: string
}

/**
 * Stops `rows` a few at a time. Each row is checked again right before its kill: a batch with
 * untracked processes can take seconds, and meanwhile the user may bring one of the rows to the
 * front or open its ticket.
 */
async function stopAll(
  rows: SessionProfilerSession[],
  onSettled?: (row: SessionProfilerSession) => void
): Promise<BulkOutcome[]> {
  const outcomes: BulkOutcome[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < rows.length) {
      const row = rows[next++]
      try {
        const skip = bulkSkipReason(row)
        if (skip) {
          outcomes.push({ row, error: null, skipped: skip })
          continue
        }
        const result = await stopSession(row)
        outcomes.push({ row, error: result.ok ? null : (result.error ?? 'Unknown error') })
      } catch (error) {
        outcomes.push({ row, error: errorMessage(error) })
      } finally {
        onSettled?.(row)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(BULK_STOP_CONCURRENCY, rows.length) }, () => worker())
  )
  return outcomes
}

interface ProfilerState {
  snapshot: SessionProfilerSnapshot | null
  /** The last request failed (the previous snapshot, if any, is kept). */
  error: string | null
  loading: boolean
  /** Epoch ms the last request settled, null before the first. */
  fetchedAt: number | null
  /**
   * Samples again unless one settled less than `maxAgeMs` ago. `force` makes a request that is
   * already running sample once more when it is done (its answer may predate a stop).
   */
  refresh: (options?: { maxAgeMs?: number; force?: boolean }) => Promise<void>
}

function useSessionProfilerSnapshot(): ProfilerState {
  const [snapshot, setSnapshot] = useState<SessionProfilerSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)
  const again = useRef(false)
  const settledAt = useRef<number | null>(null)
  const mounted = useRef(false)

  const refresh = useCallback(
    (options: { maxAgeMs?: number; force?: boolean } = {}): Promise<void> => {
      // Off means off: a stop that settles after the chip unmounted must not sample again.
      if (!mounted.current) return Promise.resolve()
      if (inFlight.current) {
        if (options.force) again.current = true
        return inFlight.current
      }
      const last = settledAt.current
      if (options.maxAgeMs !== undefined && last !== null && Date.now() - last < options.maxAgeMs) {
        return Promise.resolve()
      }
      const run = async (): Promise<void> => {
        setLoading(true)
        try {
          do {
            again.current = false
            try {
              const next = await sessionProfilerApi.getSnapshot()
              if (!mounted.current) return
              setSnapshot(next)
              setError(null)
            } catch (err) {
              if (!mounted.current) return
              setError(errorMessage(err))
            }
            settledAt.current = Date.now()
            setFetchedAt(settledAt.current)
          } while (again.current && mounted.current)
        } finally {
          inFlight.current = null
          if (mounted.current) setLoading(false)
        }
      }
      inFlight.current = run()
      return inFlight.current
    },
    []
  )

  useEffect(() => {
    mounted.current = true
    const visible = (): boolean => document.visibilityState === 'visible'
    if (visible()) void refresh()
    const timer = setInterval(() => {
      if (visible()) void refresh()
    }, POLL_INTERVAL_MS)
    const onVisibilityChange = (): void => {
      if (visible()) void refresh({ maxAgeMs: VISIBLE_REFRESH_AFTER_MS })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      mounted.current = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [refresh])

  return { snapshot, error, loading, fetchedAt, refresh }
}

/** "sampled 12 s ago", re-rendered by the app's 1 s tick while the panel is open. */
function SampledAgo({ at }: { at: number }): React.JSX.Element {
  const now = useTimerTickStore((s) => s.tickMs)
  const seconds = Math.max(0, Math.round((Math.max(now, Date.now()) - at) / 1000))
  return (
    <span data-testid="session-profiler-sampled-ago">
      {seconds < 60 ? `sampled ${seconds} s ago` : `sampled ${formatDuration(seconds)} ago`}
    </span>
  )
}

function Totals({ snapshot }: { snapshot: SessionProfilerSnapshot }): React.JSX.Element {
  const { totals } = snapshot
  const machine =
    totals.cpuPercent !== null && totals.cpuCount > 0
      ? ` (${formatCpu(totals.cpuPercent / totals.cpuCount)} of machine)`
      : ''
  const windowTitle =
    snapshot.cpuWindowMs !== null
      ? `Average over the last ${formatDuration(snapshot.cpuWindowMs / 1000)}; 100% is one core.`
      : '100% is one core.'
  return (
    <div className="space-y-0.5 px-1.5 text-xs" data-testid="session-profiler-totals">
      <div className="text-foreground" title={windowTitle}>
        Hive CPU:{' '}
        <span className="font-medium tabular-nums" data-testid="session-profiler-app-cpu">
          {formatCpu(totals.cpuPercent)}
        </span>
        <span className="text-muted-foreground">{machine}</span>
      </div>
      <div
        className="text-muted-foreground"
        title="Memory is the sum of each process's resident size, which overcounts shared pages."
      >
        Agents: <span className="tabular-nums">{formatCpu(totals.agentCpuPercent)}</span> CPU ·{' '}
        <span className="tabular-nums">{formatBytes(totals.agentRssBytes)}</span>
        <span className="text-muted-foreground/70">
          {' '}
          · app total {formatBytes(totals.rssBytes)} · {totals.processCount} processes
        </span>
      </div>
    </div>
  )
}

function SessionRow({
  row,
  protection,
  stopping,
  onStop
}: {
  row: SessionProfilerSession
  protection: string | null
  stopping: boolean
  onStop: (row: SessionProfilerSession) => void
}): React.JSX.Element {
  const irrelevant = row.irrelevantReasons.length > 0
  const ticket = row.ticket
  const column = ticket
    ? ticket.archived
      ? 'Archived'
      : (COLUMN_LABELS[ticket.column] ?? ticket.column)
    : null
  const status = [row.dbStatus, row.liveStatus ? statusLabel(row.liveStatus) : null]
    .filter(Boolean)
    .join(' · ')
  const location = [row.projectName, row.worktreeName].filter(Boolean).join(' / ')
  const stopTitle = protection
    ? `Can't stop: ${protection}`
    : 'Stop the process. The session stays and resumes the next time you open it.'

  return (
    <li
      className={cn(
        'rounded-lg px-1.5 py-1.5 hover:bg-accent/60',
        irrelevant && 'bg-amber-500/[0.06]'
      )}
      data-testid={`session-profiler-row-${row.sessionId ?? row.pid}`}
      data-irrelevant={irrelevant ? 'true' : undefined}
      data-protected={protection ? 'true' : undefined}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className="truncate text-[12.5px] font-medium leading-tight text-foreground"
              title={rowTitle(row)}
            >
              {rowTitle(row)}
            </span>
            {column && (
              <span className="shrink-0 rounded border border-border/70 px-1 text-[10px] leading-[14px] text-muted-foreground">
                {column}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">
            {AGENT_LABELS[row.agent]}
            {status && ` · ${status}`}
            <span title={`Started ${row.startedAt}`}> · pid {row.pid}</span>
            {row.processCount > 1 && ` (+${row.processCount - 1})`}
            {!row.tracked && ' · untracked'}
          </div>
          <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] leading-tight text-muted-foreground tabular-nums">
            <span>{formatBytes(row.rssBytes)}</span>
            <span>· {formatCpu(row.cpuPercent)} CPU</span>
            {row.idleSeconds !== null && <span>· idle {formatDuration(row.idleSeconds)}</span>}
            <span>· up {formatDuration(row.elapsedSeconds)}</span>
            {row.backgroundWork > 0 && <span>· {row.backgroundWork} in background</span>}
          </div>
          {location && (
            <div
              className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground/70"
              title={row.worktreePath ?? row.cwd ?? undefined}
            >
              {location}
            </div>
          )}
          {irrelevant && (
            <div className="mt-1 flex flex-wrap gap-1">
              {row.irrelevantReasons.map((reason) => (
                <span
                  key={reason}
                  className="rounded-full bg-amber-500/15 px-1.5 text-[10px] leading-4 text-amber-700 dark:text-amber-300"
                  title={reasonLabel(reason).title}
                  data-testid="session-profiler-reason"
                >
                  {reasonLabel(reason).label}
                </span>
              ))}
            </div>
          )}
        </div>
        {/* The wrapper carries the title: a disabled button gets no pointer events. */}
        <span className="shrink-0" title={stopTitle}>
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px] has-[>svg]:px-1.5"
            disabled={protection !== null || stopping}
            onClick={() => onStop(row)}
            aria-label={`Stop ${rowTitle(row)}`}
            data-testid="session-profiler-stop"
          >
            {stopping ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Square className="size-2.5 fill-current" />
            )}
            Stop
          </Button>
        </span>
      </div>
    </li>
  )
}

function PanelBody({
  snapshot,
  error,
  loading,
  fetchedAt,
  stopping,
  onRefresh,
  onStop,
  onClear
}: {
  snapshot: SessionProfilerSnapshot | null
  error: string | null
  loading: boolean
  fetchedAt: number | null
  stopping: ReadonlySet<string>
  onRefresh: () => void
  onStop: (row: SessionProfilerSession) => void
  onClear: () => void
}): React.JSX.Element {
  // Re-read on store changes while the panel is open, so a row's Stop follows the tab in front.
  useSessionStore((s) => s.activeSessionId)
  useSessionStore((s) => s.activePinnedSessionId)
  useSessionStore((s) => s.inlineConnectionSessionId)
  useSessionStore((s) => s.sessionMountRequests)
  useWorktreeStatusStore((s) => s.sessionStatuses)

  const sessions = snapshot ? sortSessions(snapshot.sessions) : []
  const irrelevantCount = sessions.filter((row) => row.irrelevantReasons.length > 0).length
  const clearable = clearableRows(sessions).length
  const sampleError = error ?? snapshot?.error ?? null

  return (
    <>
      <div className="mx-1.5 mb-1.5 mt-0.5 flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
          Agent sessions · {sessions.length}
        </h4>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {fetchedAt !== null && <SampledAgo at={snapshot?.sampledAt ?? fetchedAt} />}
          <button
            type="button"
            className="rounded-sm p-0.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Sample again"
            title="Sample again"
            data-testid="session-profiler-refresh"
          >
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </button>
        </div>
      </div>
      {snapshot && <Totals snapshot={snapshot} />}
      {sampleError && (
        <p className="mx-1.5 mt-1.5 text-xs text-red-500" data-testid="session-profiler-error">
          Could not sample the processes: {sampleError}
        </p>
      )}
      <div className="mt-2 border-t border-border/70 pt-1.5">
        {sessions.length === 0 ? (
          <p
            className="px-1.5 py-1 text-xs text-muted-foreground"
            data-testid="session-profiler-empty"
          >
            {snapshot ? 'No agent sessions are running.' : 'Sampling…'}
          </p>
        ) : (
          <ul
            className="max-h-[360px] space-y-0.5 overflow-y-auto"
            data-testid="session-profiler-rows"
          >
            {sessions.map((row) => (
              <SessionRow
                key={rowKey(row)}
                row={row}
                protection={protectionReason(row)}
                // Main reports processes it is still tearing down after an earlier stop.
                stopping={stopping.has(rowKey(row)) || row.stopping}
                onStop={onStop}
              />
            ))}
          </ul>
        )}
      </div>
      {irrelevantCount > 0 && (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/70 px-1.5 pt-2 text-xs">
          <span className="text-muted-foreground">
            {irrelevantCount} look{irrelevantCount === 1 ? 's' : ''} leftover
            {clearable < irrelevantCount && ` · ${irrelevantCount - clearable} kept`}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px] text-amber-700 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-300"
            disabled={clearable === 0 || stopping.size > 0}
            onClick={onClear}
            data-testid="session-profiler-clear"
          >
            Clear {clearable} irrelevant
          </Button>
        </div>
      )}
    </>
  )
}

function SessionProfilerChip(): React.JSX.Element | null {
  const { snapshot, error, loading, fetchedAt, refresh } = useSessionProfilerSnapshot()
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  // The rows outlive the dialog's open state so its title keeps the count while it fades out.
  const [confirmRows, setConfirmRows] = useState<SessionProfilerSession[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set())
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  /** Enter / Space went down on the chip: the click that follows is a keyboard activation. */
  const keyboardActivation = useRef(false)
  /** The panel was opened from the keyboard: focus goes into it, and back to the chip after. */
  const openedByKeyboard = useRef(false)
  /** Focus is still to move into the panel (it mounts a render after `open`, in a portal). */
  const focusPending = useRef(false)
  const [focusRequest, setFocusRequest] = useState(0)

  const clearTimers = useCallback((): void => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    openTimer.current = null
    closeTimer.current = null
  }, [])
  useEffect(() => clearTimers, [clearTimers])

  useEffect(() => {
    if (open) void refresh({ maxAgeMs: OPEN_REFRESH_AFTER_MS })
  }, [open, refresh])

  // A keyboard open moves focus into the panel: it is portalled to the end of the page, so Tab
  // from the chip would never reach it (and focus leaving for the next header control closes it).
  // A panel that was already open (Tab hover-opened it) takes focus here; one that is mounting
  // takes it in onOpenAutoFocus.
  const focusPanel = useCallback((): void => {
    const content = contentRef.current
    if (!focusPending.current || !content) return
    focusPending.current = false
    const first = content.querySelector<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )
    ;(first ?? content).focus()
  }, [])
  useEffect(() => {
    if (open && focusRequest > 0) focusPanel()
  }, [open, focusRequest, focusPanel])

  const markStopping = (rows: SessionProfilerSession[], on: boolean): void => {
    setStopping((current) => {
      const next = new Set(current)
      for (const row of rows) {
        if (on) next.add(rowKey(row))
        else next.delete(rowKey(row))
      }
      return next
    })
  }

  const handleStop = (row: SessionProfilerSession): void => {
    // The stores may have moved since the row rendered (the tab came to the front).
    const protection = protectionReason(row)
    if (protection) {
      toast.info(`Not stopped: ${protection}`)
      return
    }
    markStopping([row], true)
    stopSession(row)
      .then((result) => {
        if (result.ok) {
          toast.success(`Stopped ${rowTitle(row)}`, {
            description: 'It resumes the next time you open it.'
          })
        } else {
          toast.error('Could not stop the session', { description: result.error })
        }
      })
      .catch((err: unknown) => {
        toast.error('Could not stop the session', { description: errorMessage(err) })
      })
      .finally(() => {
        markStopping([row], false)
        void refresh({ force: true })
      })
  }

  const handleConfirmClear = (): void => {
    // Protection is read again now: the dialog may have been open for a while.
    const rows = clearableRows(confirmRows)
    setConfirmOpen(false)
    if (rows.length === 0) return
    markStopping(rows, true)
    stopAll(rows, (row) => markStopping([row], false))
      .then((outcomes) => {
        const skipped = outcomes.filter((outcome) => outcome.skipped)
        const failed = outcomes.filter((outcome) => outcome.error !== null)
        const stopped = outcomes.length - failed.length - skipped.length
        const skippedText =
          skipped.length > 0
            ? `, kept ${skipped.length} (${[...new Set(skipped.map((o) => o.skipped))].join(', ')})`
            : ''
        if (failed.length === 0) {
          toast.success(`Stopped ${stopped} session${stopped === 1 ? '' : 's'}${skippedText}`, {
            description: 'They resume the next time you open them.'
          })
        } else {
          toast.error(
            `Stopped ${stopped} of ${outcomes.length - skipped.length} sessions${skippedText}`,
            {
              description: failed
                .slice(0, 3)
                .map((outcome) => `${rowTitle(outcome.row)}: ${outcome.error}`)
                .join('\n')
            }
          )
        }
      })
      .finally(() => {
        markStopping(rows, false)
        void refresh({ force: true })
      })
  }

  // Before the first answer there is nothing to show, and an unsupported platform never shows.
  if (!snapshot && !error) return null
  if (snapshot && !snapshot.supported) return null

  const sessions = snapshot?.sessions ?? []
  const count = sessions.length
  const irrelevantCount = sessions.filter((row) => row.irrelevantReasons.length > 0).length
  const failed = !snapshot || (Boolean(error ?? snapshot.error) && count === 0)
  const tint = failed
    ? 'text-red-500 hover:text-red-500'
    : irrelevantCount >= RED_AT_IRRELEVANT
      ? 'text-red-500 hover:text-red-500'
      : irrelevantCount > 0
        ? 'text-amber-500 hover:text-amber-500'
        : 'text-muted-foreground hover:text-foreground'
  const label = failed
    ? 'Agent sessions: could not sample'
    : `${count} agent session${count === 1 ? '' : 's'} running` +
      (irrelevantCount > 0
        ? `, ${irrelevantCount} look${irrelevantCount === 1 ? 's' : ''} leftover`
        : '')

  const scheduleOpen = (): void => {
    clearTimers()
    openTimer.current = setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS)
  }
  const scheduleClose = (): void => {
    clearTimers()
    if (pinned) return
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }
  const cancelClose = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const handleOpenChange = (next: boolean): void => {
    clearTimers()
    setOpen(next)
    if (!next) {
      setPinned(false)
      focusPending.current = false
    }
  }
  const togglePinned = (): void => {
    clearTimers()
    const next = !pinned
    setPinned(next)
    setOpen(next)
    if (!next) focusPending.current = false
  }
  /** Opens and pins the panel from the keyboard, with focus on its first control. */
  const openFromKeyboard = (): void => {
    clearTimers()
    openedByKeyboard.current = true
    focusPending.current = true
    setPinned(true)
    setOpen(true)
    setFocusRequest((n) => n + 1)
  }

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange} modal={false}>
        <PopoverAnchor asChild>
          <Button
            ref={chipRef}
            variant="ghost"
            className={cn(
              'h-6 gap-1 rounded-md px-1.5 text-[11px] font-medium tabular-nums hover:bg-accent has-[>svg]:px-1.5',
              tint,
              open && 'bg-accent'
            )}
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            title={label}
            data-testid="session-profiler-chip"
            data-count={count}
            data-irrelevant={irrelevantCount}
            onPointerEnter={(event) => {
              if (event.pointerType === 'touch') return
              scheduleOpen()
            }}
            onPointerLeave={scheduleClose}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') keyboardActivation.current = true
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                openFromKeyboard()
              }
            }}
            onKeyUp={(event) => {
              if (event.key === 'Tab') setOpen(true)
            }}
            onBlur={() => {
              keyboardActivation.current = false
              scheduleClose()
            }}
            onClick={() => {
              const viaKeyboard = keyboardActivation.current
              keyboardActivation.current = false
              if (viaKeyboard && !pinned) openFromKeyboard()
              else togglePinned()
            }}
          >
            <Activity className="size-3.5" />
            <span data-testid="session-profiler-count">{failed ? '!' : count}</span>
          </Button>
        </PopoverAnchor>
        <PopoverContent
          ref={contentRef}
          align="end"
          sideOffset={6}
          className="w-[440px] p-2.5"
          aria-label="Agent sessions"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            focusPanel()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            // Escape after a keyboard open hands focus back to the chip, unless it already went
            // somewhere else (a click outside, Tab past the panel).
            if (!openedByKeyboard.current) return
            openedByKeyboard.current = false
            const active = document.activeElement
            if (!active || active === document.body || contentRef.current?.contains(active)) {
              chipRef.current?.focus()
            }
          }}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          onFocusCapture={cancelClose}
          onBlurCapture={scheduleClose}
          onInteractOutside={(event) => {
            // The chip's own click pins / unpins the panel; dismissing first would undo it.
            if (chipRef.current?.contains(event.target as Node)) event.preventDefault()
          }}
          data-testid="session-profiler-menu"
        >
          <PanelBody
            snapshot={snapshot}
            error={error}
            loading={loading}
            fetchedAt={fetchedAt}
            stopping={stopping}
            onRefresh={() => void refresh({ force: true })}
            onStop={handleStop}
            onClear={() => {
              clearTimers()
              setOpen(false)
              setPinned(false)
              setConfirmRows(clearableRows(sessions))
              setConfirmOpen(true)
            }}
          />
        </PopoverContent>
      </Popover>
      {/* Outside the popover: the dialog outlives the panel, which closes when it opens. */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent size="sm" data-testid="session-profiler-clear-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop {confirmRows.length} leftover session
              {confirmRows.length === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Their processes are stopped to free CPU and memory. The sessions, tabs and tickets
              stay as they are, and each resumes the next time you open it. Sessions on screen,
              working or waiting to wake up are left alone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="session-profiler-clear-cancel">
              Cancel
            </AlertDialogCancel>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleConfirmClear}
              data-testid="session-profiler-clear-confirm"
            >
              Stop sessions
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * Settings › Advanced › "Session profiler". Off renders nothing and runs nothing: no hook below
 * this line exists until the setting is on.
 */
export function HeaderSessionProfiler(): React.JSX.Element | null {
  const enabled = useSettingsStore((s) => s.sessionProfilerEnabled)
  if (!enabled) return null
  return <SessionProfilerChip />
}
