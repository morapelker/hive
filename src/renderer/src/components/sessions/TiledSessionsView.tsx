import { useCallback, useEffect, useRef, useState } from 'react'
import { LayoutGrid, MonitorOff, CircleSlash } from 'lucide-react'
import { cn } from '@/lib/utils'
import { computeGridLayout } from '@/lib/tiled-sessions'
import { useSessionStore, type TiledSessionTile, type TiledSessionsTab } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useClaudeCliSessionPortal } from '@/contexts/ClaudeCliSessionPortalContext'
import { SessionView } from '@/components/sessions'

/**
 * Portal target for a claude-cli session tile. Mirrors the ticket modal's
 * ClaudeCliPortalSlot contract exactly: request a mount (keeps the single
 * always-mounted terminal view alive in MainPane), register this element as
 * the portal target (the live terminal DOM moves here — no remount, no
 * respawn), and on unmount unregister + release + conditionally destroy
 * (no-op for active sessions).
 */
function TiledClaudeCliSlot({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { registerTarget } = useClaudeCliSessionPortal()
  const requestSessionMount = useSessionStore((s) => s.requestSessionMount)
  const releaseSessionMount = useSessionStore((s) => s.releaseSessionMount)
  const targetRef = useRef<HTMLDivElement | null>(null)

  const setTargetRef = useCallback(
    (el: HTMLDivElement | null) => {
      targetRef.current = el
      registerTarget(sessionId, el)
    },
    [registerTarget, sessionId]
  )

  useEffect(() => {
    requestSessionMount(sessionId)
    if (targetRef.current) {
      registerTarget(sessionId, targetRef.current)
    }

    return () => {
      registerTarget(sessionId, null)
      releaseSessionMount(sessionId)
      // No-op for active sessions; kills the PTY only for completed,
      // un-engaged sessions (same guard set as the ticket modal slot).
      void useSessionStore.getState().destroyCompletedSessionTerminal(sessionId)
    }
  }, [registerTarget, releaseSessionMount, requestSessionMount, sessionId])

  return (
    <div
      ref={setTargetRef}
      className="flex-1 flex flex-col min-h-0"
      data-testid={`tiled-claude-cli-slot-${sessionId}`}
      data-tiled-sessions-slot="true"
    />
  )
}

function TilePlaceholder({
  icon: Icon,
  message
}: {
  icon: typeof MonitorOff
  message: string
}): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <div className="flex flex-col items-center gap-2 px-4 text-center">
        <Icon className="h-5 w-5 opacity-50" />
        <p className="text-xs">{message}</p>
      </div>
    </div>
  )
}

function TileStatusDot({ sessionId }: { sessionId: string | null }): React.JSX.Element {
  const status = useWorktreeStatusStore((s) =>
    sessionId ? (s.sessionStatuses[sessionId]?.status ?? null) : null
  )

  const isBusy = status === 'working' || status === 'planning' || status === 'answering'
  const needsAttention =
    status === 'permission' || status === 'command_approval' || status === 'plan_ready'

  return (
    <span
      data-testid="tile-status-dot"
      data-status={status ?? 'none'}
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        isBusy
          ? 'bg-emerald-500 animate-pulse'
          : needsAttention
            ? 'bg-amber-500'
            : 'bg-muted-foreground/40'
      )}
    />
  )
}

function SessionTile({ tile }: { tile: TiledSessionTile }): React.JSX.Element {
  const isClaudeCli = tile.agentSdk === 'claude-code-cli'
  const isPlainTerminal = tile.agentSdk === 'terminal'

  // Live check on top of the snapshot: if the session is closed while the tab
  // is open (its view in MainPane unmounts and the reparented DOM disappears),
  // swap to a placeholder instead of leaving a dead, empty tile.
  const liveSessionStatus = useSessionStore((s) =>
    tile.sessionId ? (s.getSessionById(tile.sessionId)?.status ?? null) : null
  )
  const sessionEnded = tile.isRunning && liveSessionStatus !== 'active'

  let content: React.JSX.Element
  if (!tile.sessionId) {
    content = <TilePlaceholder icon={CircleSlash} message="No session attached to this ticket" />
  } else if (sessionEnded) {
    content = <TilePlaceholder icon={MonitorOff} message="Session ended" />
  } else if (!tile.isRunning) {
    content = (
      <TilePlaceholder
        icon={MonitorOff}
        message="Session not running — open its tab to start it"
      />
    )
  } else if (isClaudeCli) {
    content = <TiledClaudeCliSlot sessionId={tile.sessionId} />
  } else if (isPlainTerminal) {
    content = (
      <TilePlaceholder icon={MonitorOff} message="Terminal session — open its tab to view it" />
    )
  } else {
    content = <SessionView sessionId={tile.sessionId} isVisible />
  }

  return (
    <div
      data-testid={`session-tile-${tile.sessionId ?? tile.ticketIds[0]}`}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background"
    >
      {/* Tile title bar — always shows the ticket title; project name on multi-project boards */}
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-card px-2">
        <TileStatusDot sessionId={tile.sessionId} />
        <span
          className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground"
          title={tile.title}
          data-testid="tile-title"
        >
          {tile.title}
        </span>
        {tile.projectName && (
          <span
            className="max-w-[40%] shrink-0 truncate rounded-full bg-secondary px-1.5 py-px text-[10px] font-medium text-muted-foreground"
            title={tile.projectName}
            data-testid="tile-project-badge"
          >
            {tile.projectName}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{content}</div>
    </div>
  )
}

/**
 * Tiled view of the In Progress column's sessions — a snapshot grid opened
 * from the board's In Progress header. Fully interactive tiles: claude-cli
 * sessions reparent their live terminal DOM here via the session portal;
 * chat sessions mount their regular SessionView.
 */
export function TiledSessionsView({ tab }: { tab: TiledSessionsTab }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [dims, setDims] = useState<{ width: number; height: number }>({ width: 0, height: 0 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setDims((prev) =>
        prev.width === Math.round(width) && prev.height === Math.round(height)
          ? prev
          : { width: Math.round(width), height: Math.round(height) }
      )
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const tiles = tab.tiles
  const { cols, rows } = computeGridLayout(tiles.length, dims.width, dims.height)

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 min-w-0 p-1.5"
      data-testid="tiled-sessions-view"
    >
      {tiles.length === 0 ? (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <div className="text-center">
            <LayoutGrid className="mx-auto mb-3 h-8 w-8 opacity-50" />
            <p className="text-sm">No in-progress sessions to tile</p>
          </div>
        </div>
      ) : (
        <div
          className="grid h-full w-full gap-1.5"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`
          }}
          data-testid="tiled-sessions-grid"
          data-tiled-sessions-grid="true"
          data-grid-cols={cols}
          data-grid-rows={rows}
        >
          {tiles.map((tile) => (
            <SessionTile key={tile.sessionId ?? tile.ticketIds[0]} tile={tile} />
          ))}
        </div>
      )}
    </div>
  )
}
