import { useEffect, useRef, useCallback, useMemo } from 'react'
import Ansi from 'ansi-to-react'
import { RotateCcw, Loader2, CheckCircle2, XCircle, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useScriptStore } from '@/stores/useScriptStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore, fireSetupScript } from '@/stores/useWorktreeStore'

interface SetupTabProps {
  worktreeId: string | null
}

export function SetupTab({ worktreeId }: SetupTabProps): React.JSX.Element {
  const outputRef = useRef<HTMLDivElement>(null)

  const scriptState = useScriptStore((s) => (worktreeId ? s.scriptStates[worktreeId] : null))

  const emptyOutput: string[] = useMemo(() => [], [])
  const setupOutput = scriptState?.setupOutput ?? emptyOutput
  const setupRunning = scriptState?.setupRunning ?? false
  const setupError = scriptState?.setupError ?? null

  // Auto-scroll to bottom on new output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [setupOutput])

  const getProjectAndWorktree = useCallback(() => {
    if (!worktreeId) return null
    const worktrees = useWorktreeStore.getState().worktreesByProject
    for (const [projectId, wts] of worktrees) {
      const wt = wts.find((w) => w.id === worktreeId)
      if (wt) {
        const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
        return project ? { project, worktree: wt } : null
      }
    }
    return null
  }, [worktreeId])

  const handleRerunSetup = useCallback(() => {
    if (!worktreeId || setupRunning) return

    const info = getProjectAndWorktree()
    if (!info?.project?.setup_script) return

    useScriptStore.getState().clearSetupOutput(worktreeId)
    fireSetupScript(info.project.id, worktreeId, info.worktree.path)
  }, [worktreeId, setupRunning, getProjectAndWorktree])

  if (!worktreeId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Select a worktree to view setup output
      </div>
    )
  }

  const info = getProjectAndWorktree()
  const hasSetupScript = !!info?.project?.setup_script

  // Determine status
  const isComplete = !setupRunning && setupOutput.length > 0 && !setupError
  const isFailed = !setupRunning && !!setupError

  return (
    <div className="flex flex-col h-full" data-testid="setup-tab">
      {/* Output area */}
      <div
        ref={outputRef}
        className="flex-1 min-h-0 overflow-auto p-2 font-mono text-xs leading-relaxed"
        data-testid="setup-tab-output"
      >
        {setupOutput.length === 0 && !setupRunning && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground text-xs">
            {hasSetupScript ? (
              'No setup output yet. Click "Rerun Setup" to execute.'
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (info?.project) useProjectStore.getState().openProjectSettings(info.project.id)
                }}
              >
                <Settings className="h-4 w-4 mr-2" />
                Configure setup script
              </Button>
            )}
          </div>
        )}
        {setupOutput.map((line, i) => {
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
        })}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-2 py-1 border-t border-border text-xs">
        <div className="flex items-center gap-1.5">
          {setupRunning && (
            <>
              <Loader2 className="h-3 w-3 animate-spin text-primary" />
              <span className="text-muted-foreground">Running...</span>
            </>
          )}
          {isComplete && (
            <>
              <CheckCircle2 className="h-3 w-3 text-green-500" />
              <span className="text-muted-foreground">Setup complete</span>
            </>
          )}
          {isFailed && (
            <>
              <XCircle className="h-3 w-3 text-destructive" />
              <span className="text-destructive">Setup failed</span>
            </>
          )}
        </div>

        {hasSetupScript && (
          <button
            onClick={handleRerunSetup}
            disabled={setupRunning}
            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            data-testid="rerun-setup-button"
          >
            <RotateCcw className="h-3 w-3" />
            Rerun Setup
          </button>
        )}
      </div>
    </div>
  )
}
