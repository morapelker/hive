import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, Play, Square } from 'lucide-react'
import { terminalApi } from '@/api/terminal-api'
import { TerminalView, type TerminalViewHandle } from '@/components/terminal/TerminalView'
import { Button } from '@/components/ui/button'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { formatElapsedTimer } from '@/lib/format-utils'
import { rerunShellCommand } from '@/lib/shell-command-launch'
import { toast } from '@/lib/toast'
import { useSessionStore } from '@/stores/useSessionStore'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import { useTimerTickStore } from '@/stores/useTimerTickStore'
import {
  describeShellCommandFailure,
  isShellCommandRunActive,
  parseSessionShellCommand,
  shellCommandOutcomeLabel,
  type SessionShellCommand
} from '@shared/lib/shell-commands'
import '@xterm/xterm/css/xterm.css'
import '@/styles/xterm.css'

interface ShellCommandSessionViewProps {
  sessionId: string
  isVisible?: boolean
}

// A run that is still 'pending' after this long never reached main (the launch was
// interrupted between creating the session and starting the run): offer to start it.
const PENDING_RUN_OFFER_MS = 3000

function parseTimestamp(value: string | null): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function StatusIcon({ run }: { run: SessionShellCommand | null }): React.JSX.Element {
  switch (run?.state) {
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-yellow-500" />
    case 'succeeded':
      return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
    case 'failed':
      return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
    case 'cancelled':
      return <Square className="h-3.5 w-3.5 shrink-0 text-amber-500" />
    case 'interrupted':
      return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
    default:
      return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
  }
}

/**
 * The view of a shell-command session: a status strip above a terminal that shows the
 * run's output. Mounting it only ATTACHES to the run (main publishes the transcript on
 * terminal:data); it never starts one. Runs are started by the launcher and by Run again.
 */
export function ShellCommandSessionView({
  sessionId,
  isVisible = true
}: ShellCommandSessionViewProps): React.JSX.Element {
  const terminalRef = useRef<TerminalViewHandle>(null)
  const [stopping, setStopping] = useState(false)
  const [starting, setStarting] = useState(false)
  const [pendingTooLong, setPendingTooLong] = useState(false)

  const storeRun = useShellCommandRunStore((s) => s.runsBySession[sessionId])
  // Fallback while the run index has no entry yet (it loads asynchronously)
  const sessionShellCommand = useSessionStore(
    (s) => s.getSessionById(sessionId)?.shell_command ?? null
  )
  const fallbackRun = useMemo(
    () => parseSessionShellCommand(sessionShellCommand),
    [sessionShellCommand]
  )
  const run = storeRun ?? fallbackRun
  const runState = run?.state ?? null
  const isRunning = runState === 'running'

  // Subscribe to the 1s tick only while running so a finished transcript never re-renders
  const tickMs = useTimerTickStore((s) => (isRunning ? s.tickMs : 0))

  const attachTerminal = useCallback(async () => {
    const envelope = await terminalApi.attachShellCommand(sessionId)
    if (envelope.success && envelope.value.success && envelope.value.state) {
      const store = useShellCommandRunStore.getState()
      const known = store.runsBySession[sessionId]
      const next = envelope.value
      if (!known) {
        void store.loadAll()
      } else if (
        known.runId !== next.runId ||
        (isShellCommandRunActive(known.state) && known.state !== next.state)
      ) {
        // The answer may move an active run forward or follow a new run; it never
        // regresses a finished state.
        store.mergeRun(sessionId, {
          state: next.state,
          exitCode: next.exitCode ?? null,
          runId: next.runId ?? null
        })
      }
    }
    return envelope
  }, [sessionId])

  // Prompts need the keyboard while the command runs. Afterwards the terminal is a
  // transcript: main drops keystrokes.
  useEffect(() => {
    if (!isVisible || !isRunning) return
    const timer = window.setTimeout(() => {
      terminalRef.current?.focus()
    }, 75)
    return () => window.clearTimeout(timer)
  }, [isVisible, isRunning, sessionId])

  useEffect(() => {
    setPendingTooLong(false)
    if (runState !== 'pending') return
    const timer = window.setTimeout(() => setPendingTooLong(true), PENDING_RUN_OFFER_MS)
    return () => window.clearTimeout(timer)
  }, [runState, sessionId])

  // Stop never writes Ctrl-C: a program that swallows SIGINT would let the next step
  // run. The state change arrives through the status event.
  const handleStop = useCallback(async () => {
    setStopping(true)
    try {
      unwrapEnvelope(await terminalApi.destroy(sessionId))
    } catch {
      toast.error('Failed to stop the command')
    } finally {
      setStopping(false)
    }
  }, [sessionId])

  const handleRunAgain = useCallback(async () => {
    setStarting(true)
    try {
      const result = await rerunShellCommand(sessionId)
      if (!result.success) toast.error(result.error ?? 'Failed to run command')
    } finally {
      setStarting(false)
    }
  }, [sessionId])

  const label = run ? shellCommandOutcomeLabel(run) : 'Loading…'
  const failure = run ? describeShellCommandFailure(run) : null

  const startedAtMs = parseTimestamp(run?.startedAt ?? null)
  const finishedAtMs = parseTimestamp(run?.finishedAt ?? null)
  let timing: string | null = null
  if (isRunning) {
    if (startedAtMs !== null) timing = formatElapsedTimer(tickMs - startedAtMs)
  } else if (run && runState !== 'pending' && startedAtMs !== null && finishedAtMs !== null) {
    timing = formatElapsedTimer(finishedAtMs - startedAtMs)
  }

  const canRunAgain = !!run && !isShellCommandRunActive(run.state)
  const canStartPending = runState === 'pending' && pendingTooLong

  return (
    <div
      className="flex-1 flex flex-col min-h-0 bg-background"
      data-testid="shell-command-session-view"
      data-session-id={sessionId}
    >
      <div
        className="shrink-0 h-9 px-3 flex items-center gap-2 border-b border-border/60 text-xs"
        data-testid="shell-command-status-strip"
        data-state={runState ?? 'unknown'}
      >
        <StatusIcon run={run} />
        <span
          className="font-medium"
          data-testid="shell-command-status-label"
          title={failure ?? undefined}
        >
          {label}
        </span>
        {timing && (
          <span
            className="tabular-nums text-muted-foreground"
            data-testid="shell-command-status-timing"
          >
            {timing}
          </span>
        )}
        {run?.detached && (
          <span
            className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            data-testid="shell-command-detached-badge"
          >
            Keeps running if the app quits
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {isRunning && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              data-testid="shell-command-stop"
              disabled={stopping}
              onClick={() => void handleStop()}
            >
              <Square className="h-3 w-3" />
              Stop
            </Button>
          )}
          {(canRunAgain || canStartPending) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              data-testid="shell-command-run-again"
              disabled={starting}
              onClick={() => void handleRunAgain()}
            >
              <Play className="h-3 w-3" />
              {canRunAgain ? 'Run again' : 'Run'}
            </Button>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <TerminalView
          ref={terminalRef}
          terminalId={sessionId}
          cwd="/"
          isVisible={isVisible}
          showToolbar={false}
          backendTypeOverride="xterm"
          createTerminal={attachTerminal}
        />
      </div>
    </div>
  )
}
