import { useEffect, useRef, useCallback, useMemo } from 'react'
import Ansi from 'ansi-to-react'
import { RotateCcw, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { useScriptStore } from '@/stores/useScriptStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

interface SetupTabProps {
  worktreeId: string | null
}

export function SetupTab({ worktreeId }: SetupTabProps): React.JSX.Element {
  const outputRef = useRef<HTMLDivElement>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  const scriptState = useScriptStore((s) =>
    worktreeId ? s.scriptStates[worktreeId] : null
  )

  const emptyOutput: string[] = useMemo(() => [], [])
  const setupOutput = scriptState?.setupOutput ?? emptyOutput
  const setupRunning = scriptState?.setupRunning ?? false
  const setupError = scriptState?.setupError ?? null

  const {
    appendSetupOutput,
    setSetupRunning,
    setSetupError,
    clearSetupOutput
  } = useScriptStore.getState()

  // Auto-scroll to bottom on new output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [setupOutput])

  // Subscribe to IPC events for this worktree
  useEffect(() => {
    if (!worktreeId) return

    const channel = `script:setup:${worktreeId}`

    // Clean up previous subscription
    if (unsubRef.current) {
      unsubRef.current()
      unsubRef.current = null
    }

    const unsub = window.scriptOps.onOutput(channel, (event) => {
      switch (event.type) {
        case 'command-start':
          appendSetupOutput(worktreeId, `\x00CMD:${event.command}`)
          break
        case 'output':
          if (event.data) {
            appendSetupOutput(worktreeId, event.data)
          }
          break
        case 'error':
          appendSetupOutput(
            worktreeId,
            `\x00ERR:Command failed with exit code ${event.exitCode}: ${event.command}`
          )
          setSetupError(worktreeId, `Command failed: ${event.command}`)
          setSetupRunning(worktreeId, false)
          break
        case 'done':
          setSetupRunning(worktreeId, false)
          break
      }
    })

    unsubRef.current = unsub

    return () => {
      unsub()
      unsubRef.current = null
    }
  }, [worktreeId, appendSetupOutput, setSetupRunning, setSetupError])

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

  const handleRerunSetup = useCallback(async () => {
    if (!worktreeId || setupRunning) return

    const project = getProject()
    if (!project?.setup_script) return

    const cwd = getWorktreePath()
    if (!cwd) return

    clearSetupOutput(worktreeId)
    setSetupError(worktreeId, null)
    setSetupRunning(worktreeId, true)

    const commands = project.setup_script
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))

    await window.scriptOps.runSetup(commands, cwd, worktreeId)
  }, [
    worktreeId,
    setupRunning,
    getProject,
    getWorktreePath,
    clearSetupOutput,
    setSetupError,
    setSetupRunning
  ])

  if (!worktreeId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Select a worktree to view setup output
      </div>
    )
  }

  const project = getProject()
  const hasSetupScript = !!project?.setup_script

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
          <div className="text-muted-foreground text-center py-4">
            {hasSetupScript
              ? 'No setup output yet. Click "Rerun Setup" to execute.'
              : 'No setup script configured. Add one in Project Settings.'}
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
