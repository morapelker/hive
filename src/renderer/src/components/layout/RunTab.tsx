import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import Ansi from 'ansi-to-react'
import { Play, Square, RotateCcw, Loader2, Trash2, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useScriptStore, fireRunScript, killRunScript } from '@/stores/useScriptStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { getOrCreateBuffer, TRUNCATION_MARKER } from '@/lib/output-ring-buffer'

interface RunTabProps {
  worktreeId: string | null
}

const emptyOutput: string[] = []
const VIRTUALIZE_THRESHOLD = 500
const ROW_ESTIMATE_PX = 20

export function RunTab({ worktreeId }: RunTabProps): React.JSX.Element {
  const outputRef = useRef<HTMLDivElement>(null)

  // Subscribe to version counter (triggers re-render on each append)
  const runOutputVersion = useScriptStore((s) =>
    worktreeId ? (s.scriptStates[worktreeId]?.runOutputVersion ?? 0) : 0
  )

  // Produce the ordered array only when version changes
  const runOutput = useMemo(() => {
    if (!worktreeId) return emptyOutput
    return getOrCreateBuffer(worktreeId).toArray()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId, runOutputVersion])

  const shouldVirtualize = runOutput.length >= VIRTUALIZE_THRESHOLD

  const virtualizer = useVirtualizer({
    count: runOutput.length,
    getScrollElement: () => outputRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 30,
    enabled: shouldVirtualize
  })

  const runRunning = useScriptStore((s) =>
    worktreeId ? (s.scriptStates[worktreeId]?.runRunning ?? false) : false
  )

  const [assignedPort, setAssignedPort] = useState<number | null>(null)

  const { clearRunOutput } = useScriptStore.getState()

  // Auto-scroll to bottom on new output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [runOutputVersion])

  const getProject = useCallback(() => {
    if (!worktreeId) return null
    const worktrees = useWorktreeStore.getState().worktreesByProject
    for (const [projectId, wts] of worktrees) {
      if (wts.some((w) => w.id === worktreeId)) {
        return useProjectStore.getState().projects.find((p) => p.id === projectId) ?? null
      }
    }
    return null
  }, [worktreeId])

  const getWorktreePath = useCallback(() => {
    if (!worktreeId) return null
    const worktrees = useWorktreeStore.getState().worktreesByProject
    for (const [, wts] of worktrees) {
      const wt = wts.find((w) => w.id === worktreeId)
      if (wt) return wt.path
    }
    return null
  }, [worktreeId])

  // Fetch assigned port when worktree changes
  useEffect(() => {
    const cwd = getWorktreePath()
    if (!cwd) {
      setAssignedPort(null)
      return
    }
    window.scriptOps.getPort(cwd).then(({ port }) => setAssignedPort(port))
  }, [worktreeId, getWorktreePath])

  const handleRun = useCallback(() => {
    if (!worktreeId || runRunning) return

    const project = getProject()
    if (!project?.run_script) return

    const cwd = getWorktreePath()
    if (!cwd) return

    const commands = project.run_script
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))

    fireRunScript(worktreeId, commands, cwd)
  }, [worktreeId, runRunning, getProject, getWorktreePath])

  const handleStop = useCallback(async () => {
    if (!worktreeId) return
    await killRunScript(worktreeId)
  }, [worktreeId])

  const handleRestart = useCallback(async () => {
    if (!worktreeId) return
    await handleStop()
    // Small delay to allow cleanup
    setTimeout(() => {
      handleRun()
    }, 200)
  }, [worktreeId, handleStop, handleRun])

  if (!worktreeId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Select a worktree to run scripts
      </div>
    )
  }

  const project = getProject()
  const hasRunScript = !!project?.run_script

  return (
    <div className="flex flex-col h-full" data-testid="run-tab">
      {/* Output area */}
      <div
        ref={outputRef}
        className="flex-1 min-h-0 overflow-auto p-2 font-mono text-xs leading-relaxed"
        data-testid="run-tab-output"
      >
        {runOutput.length === 0 && !runRunning && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground text-xs">
            {hasRunScript ? (
              'No run output yet. Press ⌘R or click Run to start.'
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (project) useProjectStore.getState().openProjectSettings(project.id)
                }}
              >
                <Settings className="h-4 w-4 mr-2" />
                Setup run script
              </Button>
            )}
          </div>
        )}
        {shouldVirtualize ? (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative'
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const line = runOutput[virtualRow.index]
              if (line === undefined) return null

              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  {line === TRUNCATION_MARKER || line.startsWith('\x00TRUNC:') ? (
                    <div className="text-muted-foreground text-center text-[10px] py-1 border-b border-border/50">
                      {line.startsWith('\x00TRUNC:') ? line.slice(7) : '[older output truncated]'}
                    </div>
                  ) : line.startsWith('\x00CMD:') ? (
                    <div className="text-muted-foreground font-semibold mt-1">
                      $ {line.slice(5)}
                    </div>
                  ) : line.startsWith('\x00ERR:') ? (
                    <div className="text-destructive">{line.slice(5)}</div>
                  ) : (
                    <div className="whitespace-pre-wrap break-all [&_code]:all-unset">
                      <Ansi>{line}</Ansi>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          runOutput.map((line, i) => {
            if (line === TRUNCATION_MARKER || line.startsWith('\x00TRUNC:')) {
              const msg = line.startsWith('\x00TRUNC:') ? line.slice(7) : '[older output truncated]'
              return (
                <div
                  key={i}
                  className="text-muted-foreground text-center text-[10px] py-1 border-b border-border/50"
                >
                  {msg}
                </div>
              )
            }
            if (line.startsWith('\x00CMD:')) {
              const cmd = line.slice(5)
              return (
                <div key={i} className="text-muted-foreground font-semibold mt-1">
                  $ {cmd}
                </div>
              )
            }
            if (line.startsWith('\x00ERR:')) {
              const msg = line.slice(5)
              return (
                <div key={i} className="text-destructive">
                  {msg}
                </div>
              )
            }
            return (
              <div key={i} className="whitespace-pre-wrap break-all [&_code]:all-unset">
                <Ansi>{line}</Ansi>
              </div>
            )
          })
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-2 py-1 border-t border-border text-xs">
        <div className="flex items-center gap-1.5">
          {runRunning ? (
            <>
              <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
              <span className="text-muted-foreground">Running</span>
            </>
          ) : runOutput.length > 0 ? (
            <>
              <span className="h-2 w-2 rounded-full bg-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Stopped</span>
            </>
          ) : null}
          {assignedPort && (
            <span className="text-muted-foreground ml-2 font-mono">PORT={assignedPort}</span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {runOutput.length > 0 && (
            <button
              onClick={() => clearRunOutput(worktreeId!)}
              className="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent transition-colors"
              data-testid="clear-button"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </button>
          )}
          {hasRunScript && (
            <>
              {runRunning ? (
                <>
                  <button
                    onClick={handleStop}
                    className="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent transition-colors"
                    data-testid="stop-button"
                  >
                    <Square className="h-3 w-3" />
                    Stop
                  </button>
                  <button
                    onClick={handleRestart}
                    className="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent transition-colors"
                    data-testid="restart-button"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Restart
                  </button>
                </>
              ) : (
                <button
                  onClick={handleRun}
                  className="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent transition-colors"
                  data-testid="run-button"
                >
                  {runRunning ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                  Run
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
