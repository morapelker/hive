import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Play, Square, RotateCcw, Trash2, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useScriptStore, fireRunScript, killRunScript } from '@/stores/useScriptStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { getOrCreateBuffer } from '@/lib/output-ring-buffer'
import { RunOutputLine } from './RunOutputLine'
import type { SearchHighlight } from './RunOutputLine'
import { RunOutputSearch } from './RunOutputSearch'
import type { RunSearchMatch } from './RunOutputSearch'

interface RunTabProps {
  worktreeId: string | null
}

const ROW_ESTIMATE_PX = 20

export function RunTab({ worktreeId }: RunTabProps): React.JSX.Element {
  const outputRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Subscribe to version counter (triggers re-render on each append)
  const runOutputVersion = useScriptStore((s) =>
    worktreeId ? (s.scriptStates[worktreeId]?.runOutputVersion ?? 0) : 0
  )

  // Derive buffer and lineCount from renderCount (index-based access).
  // lineCount is re-derived on each render triggered by runOutputVersion changes.
  const buffer = worktreeId ? getOrCreateBuffer(worktreeId) : null
  const lineCount = buffer ? buffer.renderCount : 0

  const virtualizer = useVirtualizer({
    count: lineCount,
    getScrollElement: () => outputRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 30
  })

  const runRunning = useScriptStore((s) =>
    worktreeId ? (s.scriptStates[worktreeId]?.runRunning ?? false) : false
  )

  const [assignedPort, setAssignedPort] = useState<number | null>(null)

  const { clearRunOutput } = useScriptStore.getState()

  // --- Smart auto-scroll ---
  const isAtBottomRef = useRef(true)

  // Scroll listener to track if user is near bottom
  useEffect(() => {
    const el = outputRef.current
    if (!el) return
    const handleScroll = (): void => {
      isAtBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 50
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  // --- Search state ---
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchMatches, setSearchMatches] = useState<RunSearchMatch[]>([])
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)

  // Auto-scroll on new output (only when at bottom and search not open).
  // runOutputVersion in deps triggers this effect when new output arrives.
  useEffect(() => {
    if (!isAtBottomRef.current || searchOpen) return
    if (lineCount > 0) {
      virtualizer.scrollToIndex(lineCount - 1, { align: 'end' })
    }
  }, [runOutputVersion, searchOpen, lineCount, virtualizer])

  // Cmd+F handler — capture phase, scoped to container
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        if (
          !containerRef.current?.contains(document.activeElement) &&
          !containerRef.current?.contains(e.target as Node)
        ) return
        e.preventDefault()
        e.stopPropagation()
        setSearchOpen(true)
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  // Build highlight map for O(1) lookup per visible row.
  // Limitation: only one highlight per line is stored. When a line has multiple
  // matches, the current match takes priority; otherwise the first match wins.
  const highlightMap = useMemo(() => {
    const map = new Map<number, SearchHighlight>()
    if (searchMatches.length === 0) return map
    for (let i = 0; i < searchMatches.length; i++) {
      const match = searchMatches[i]
      if (!map.has(match.lineIndex) || i === currentMatchIndex) {
        map.set(match.lineIndex, {
          matchStart: match.matchStart,
          matchEnd: match.matchEnd,
          isCurrent: i === currentMatchIndex
        })
      }
    }
    return map
  }, [searchMatches, currentMatchIndex])

  // Handle search matches change — scroll to current match
  const handleSearchMatchesChange = useCallback(
    (matches: RunSearchMatch[], index: number) => {
      setSearchMatches(matches)
      setCurrentMatchIndex(index)
      if (matches.length > 0 && matches[index]) {
        virtualizer.scrollToIndex(matches[index].lineIndex, { align: 'center' })
      }
    },
    [virtualizer]
  )

  // Close search handler
  const handleSearchClose = useCallback(() => {
    setSearchOpen(false)
    setSearchMatches([])
    setCurrentMatchIndex(0)
    // Re-enable auto-scroll: scroll to bottom
    const count = buffer?.renderCount ?? 0
    if (count > 0) {
      virtualizer.scrollToIndex(count - 1, { align: 'end' })
    }
    isAtBottomRef.current = true
  }, [buffer, virtualizer])

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
    <div ref={containerRef} className="flex flex-col h-full" data-testid="run-tab">
      {/* Search bar */}
      {searchOpen && buffer && (
        <RunOutputSearch
          buffer={buffer}
          outputVersion={runOutputVersion}
          onMatchesChange={handleSearchMatchesChange}
          onClose={handleSearchClose}
        />
      )}

      {/* Output area */}
      <div
        ref={outputRef}
        className="flex-1 min-h-0 overflow-auto p-2 font-mono text-xs leading-relaxed"
        data-testid="run-tab-output"
      >
        {lineCount === 0 && !runRunning && (
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
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative'
          }}
        >
          {buffer && virtualizer.getVirtualItems().map((virtualRow) => {
            const line = buffer.get(virtualRow.index)
            if (line === null) return null
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
                <RunOutputLine
                  line={line}
                  highlight={highlightMap.get(virtualRow.index)}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-2 py-1 border-t border-border text-xs">
        <div className="flex items-center gap-1.5">
          {runRunning ? (
            <>
              <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
              <span className="text-muted-foreground">Running</span>
            </>
          ) : lineCount > 0 ? (
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
          {lineCount > 0 && (
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
                  <Play className="h-3 w-3" />
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
