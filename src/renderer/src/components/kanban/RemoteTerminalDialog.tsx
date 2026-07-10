import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { AlertTriangle, Loader2, RefreshCw, Unplug } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { HiveClient } from '@/api/hive-client'
import { remoteTargetFromUrl } from '@/api/remote-launch-api'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { ServerEvent } from '@shared/rpc/protocol'
import type {
  RemoteLaunchAttachParams,
  RemoteLaunchAttachResult,
  RemoteLaunchClientInfo
} from '@shared/types/remote-launch'

export interface RemoteTerminalDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  remoteLaunch: RemoteLaunchClientInfo
}

type ConnectionState = 'connecting' | 'connected' | 'detached' | 'error'
type ErrorKind = 'unreachable' | 'exited' | 'settings'

/** Minimal Catppuccin-Mocha-ish palette matching the local terminal's default theme. */
const REMOTE_TERMINAL_THEME: ITheme = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#585b7066'
}

/** The server throws "Remote session has exited" when `tmux has-session` fails (see attachTerminalRemoteLaunch). */
const isSessionExitedError = (message: string): boolean => /session has exited/i.test(message)

export function RemoteTerminalDialog({
  open,
  onOpenChange,
  remoteLaunch
}: RemoteTerminalDialogProps): React.JSX.Element {
  const [state, setState] = useState<ConnectionState>('connecting')
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null)
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined)

  // A plain ref would race Radix's Portal: it renders `null` on the commit
  // where it first mounts (its `mounted` state starts false, flipped true by
  // its own useLayoutEffect — see @radix-ui/react-portal), and Presence tears
  // the Portal down on every close, so this replays on every reopen. State
  // (set via a callback ref) lets the connect effect below re-run once the
  // container actually lands in the DOM instead of reading a stale ref.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)
  const containerRefCallback = useCallback((node: HTMLDivElement | null) => {
    setContainerEl(node)
  }, [])
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clientRef = useRef<HiveClient | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const unsubDataRef = useRef<(() => void) | null>(null)
  const unsubExitRef = useRef<(() => void) | null>(null)
  const inputDisposableRef = useRef<{ dispose: () => void } | null>(null)

  // Each connect() call captures the current epoch; any continuation that
  // fires after a newer connect() (or the unmount/close cleanup) has bumped
  // it bails out instead of mutating state or leaking a client/terminal.
  const epochRef = useRef(0)

  // Always-current ref so connect() (a stable useCallback) reads the latest
  // prop without needing it in its dependency array — the effect that drives
  // connect() only wants to fire on `open` transitions, not on every
  // remoteLaunch identity change from the parent.
  const remoteLaunchRef = useRef(remoteLaunch)
  remoteLaunchRef.current = remoteLaunch

  /** Detach the remote PTY + WS subscriptions, but keep the mounted xterm instance (used before retry/reconnect). */
  const teardownConnection = useCallback(() => {
    unsubDataRef.current?.()
    unsubDataRef.current = null
    unsubExitRef.current?.()
    unsubExitRef.current = null
    inputDisposableRef.current?.dispose()
    inputDisposableRef.current = null

    const client = clientRef.current
    const terminalId = terminalIdRef.current
    clientRef.current = null
    terminalIdRef.current = null

    if (client && terminalId) {
      // Detach only — the remote tmux session survives this.
      client.request('terminalOps.destroy', { terminalId }).catch(() => {})
    }
    client?.close()
  }, [])

  /** Dispose the xterm instance itself — only on dialog close/unmount, not on retry/reconnect. */
  const disposeTerminal = useCallback(() => {
    if (resizeDebounceRef.current) {
      clearTimeout(resizeDebounceRef.current)
      resizeDebounceRef.current = null
    }
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    termRef.current?.dispose()
    termRef.current = null
    fitAddonRef.current = null
  }, [])

  const requestResize = useCallback(() => {
    const client = clientRef.current
    const terminalId = terminalIdRef.current
    const fitAddon = fitAddonRef.current
    if (!client || !terminalId || !fitAddon) return
    try {
      fitAddon.fit()
    } catch {
      return
    }
    const dims = fitAddon.proposeDimensions()
    if (!dims || !dims.cols || !dims.rows) return
    client.request('terminalOps.resize', { terminalId, cols: dims.cols, rows: dims.rows }).catch(() => {})
  }, [])

  const ensureTerminalMounted = useCallback((): void => {
    if (termRef.current) return
    const container = containerEl
    if (!container) return

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: 13,
      theme: REMOTE_TERMINAL_THEME
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)

    termRef.current = term
    fitAddonRef.current = fitAddon

    const resizeObserver = new ResizeObserver(() => {
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current)
      resizeDebounceRef.current = setTimeout(() => {
        resizeDebounceRef.current = null
        requestResize()
      }, 100)
    })
    resizeObserver.observe(container)
    resizeObserverRef.current = resizeObserver
  }, [containerEl, requestResize])

  const connect = useCallback(async () => {
    const myEpoch = ++epochRef.current
    setState('connecting')
    setErrorKind(null)
    setErrorDetail(undefined)

    // Drop any previous connection (retry/reconnect case); keep the xterm instance.
    teardownConnection()

    const teleport = useSettingsStore.getState().teleport
    if (!teleport || !teleport.bootstrapToken) {
      if (myEpoch !== epochRef.current) return
      setErrorKind('settings')
      setState('error')
      return
    }

    ensureTerminalMounted()
    const term = termRef.current
    term?.clear()

    let dims: { cols: number; rows: number } | undefined
    try {
      fitAddonRef.current?.fit()
      const proposed = fitAddonRef.current?.proposeDimensions()
      if (proposed && proposed.cols && proposed.rows) dims = proposed
    } catch {
      // Container might not be visible/sized yet — attach without an explicit size.
    }

    const target = remoteTargetFromUrl(remoteLaunchRef.current.url, teleport.bootstrapToken)
    const client = new HiveClient(target)

    const attachParams: RemoteLaunchAttachParams = {
      remoteSessionId: remoteLaunchRef.current.remoteSessionId,
      ...(dims ? { cols: dims.cols, rows: dims.rows } : {})
    }

    let result: RemoteLaunchAttachResult
    try {
      result = await client.request<RemoteLaunchAttachResult>(
        'remoteLaunchOps.attachTerminal',
        attachParams
      )
    } catch (err) {
      client.close()
      if (myEpoch !== epochRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      const kind = isSessionExitedError(message) ? 'exited' : 'unreachable'
      // The "exited" title is already the raw server message
      // ("Remote session has exited") — showing it again as errorDetail
      // would just repeat the same sentence underneath itself.
      setErrorDetail(kind === 'exited' ? undefined : message)
      setErrorKind(kind)
      setState('error')
      return
    }

    if (myEpoch !== epochRef.current) {
      // Superseded while attaching (dialog closed/reopened, or another
      // connect() started) — detach quietly instead of leaking the PTY/WS.
      client.request('terminalOps.destroy', { terminalId: result.terminalId }).catch(() => {})
      client.close()
      return
    }

    clientRef.current = client
    terminalIdRef.current = result.terminalId

    unsubDataRef.current = client.subscribe(
      `terminal:data:${result.terminalId}`,
      (event: ServerEvent) => {
        if (typeof event.payload === 'string') term?.write(event.payload)
      }
    )
    unsubExitRef.current = client.subscribe(`terminal:exit:${result.terminalId}`, () => {
      if (myEpoch !== epochRef.current) return
      setState('detached')
    })
    inputDisposableRef.current =
      term?.onData((data) => {
        client.request('terminalOps.write', { terminalId: result.terminalId, data }).catch(() => {})
      }) ?? null

    setState('connected')
    requestAnimationFrame(() => {
      requestResize()
      term?.focus()
    })
  }, [teardownConnection, ensureTerminalMounted, requestResize])

  useEffect(() => {
    // Radix's Portal (which DialogContent renders through) returns `null` on
    // the commit where it first mounts — its `mounted` state starts false
    // and only flips true via its own useLayoutEffect. Presence also tears
    // the Portal down on every close, so this replays on every reopen, not
    // just the first mount. Gating on `containerEl` (set via a callback ref)
    // instead of firing straight off `open` means this effect no-ops on the
    // commit(s) where the container doesn't exist yet, and actually connects
    // once it lands in the DOM — so connect() still runs exactly once per
    // open.
    if (!open || !containerEl) return

    connect()

    return () => {
      // Invalidate any in-flight connect() continuation before tearing down.
      epochRef.current += 1
      teardownConnection()
      disposeTerminal()
    }
    // Only re-run on open/close transitions (and once the container mounts)
    // — connect() reads the latest remoteLaunch via remoteLaunchRef so it
    // doesn't need to be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, containerEl])

  const handleFocusTerminal = useCallback(() => {
    termRef.current?.focus()
  }, [])

  const errorTitle =
    errorKind === 'settings'
      ? 'Teleport settings not configured'
      : errorKind === 'exited'
        ? 'Remote session has exited'
        : 'Remote Hive unreachable'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="remote-terminal-dialog"
        className="max-w-[90vw] max-h-[90vh] w-full h-[85vh] flex flex-col gap-0 p-0"
      >
        <DialogHeader className="px-4 py-3 border-b shrink-0">
          <DialogTitle className="text-sm">
            Remote session — {remoteLaunch.tmuxSession}
          </DialogTitle>
        </DialogHeader>

        <div className="relative flex-1 min-h-0">
          <div
            ref={containerRefCallback}
            onClick={handleFocusTerminal}
            className="absolute inset-0 p-2"
            data-testid="remote-terminal-container"
          />

          {state !== 'connected' && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/95">
              {state === 'connecting' && (
                <div
                  className="flex flex-col items-center gap-2 text-sm text-muted-foreground"
                  data-testid="remote-terminal-connecting"
                >
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Connecting…
                </div>
              )}

              {state === 'error' && (
                <div
                  className="flex flex-col items-center gap-3 max-w-sm text-center px-4"
                  data-testid="remote-terminal-error"
                  data-error-kind={errorKind ?? undefined}
                >
                  <AlertTriangle className="h-6 w-6 text-destructive" />
                  <p className="text-sm font-medium text-foreground">{errorTitle}</p>
                  {errorDetail && (
                    <p className="text-xs text-muted-foreground break-words">{errorDetail}</p>
                  )}
                  <div className="flex items-center gap-2">
                    {errorKind === 'unreachable' && (
                      <Button size="sm" onClick={() => connect()} data-testid="remote-terminal-retry">
                        <RefreshCw className="h-3 w-3 mr-1" />
                        Retry
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onOpenChange(false)}
                      data-testid="remote-terminal-close"
                    >
                      Close
                    </Button>
                  </div>
                </div>
              )}

              {state === 'detached' && (
                <div
                  className="flex flex-col items-center gap-3 max-w-sm text-center px-4"
                  data-testid="remote-terminal-detached"
                >
                  <Unplug className="h-6 w-6 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">Detached</p>
                  <p className="text-xs text-muted-foreground">
                    The terminal connection ended. The remote tmux session may still be running.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => connect()}
                      data-testid="remote-terminal-reconnect"
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />
                      Reconnect
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onOpenChange(false)}
                      data-testid="remote-terminal-close"
                    >
                      Close
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
