import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

import { scriptApi } from '@/api/script-api'
import { Button } from '@/components/ui/button'
import { useScriptStore } from '@/stores/useScriptStore'

interface RunSuggestionBannerProps {
  worktreeId: string
}

function humanReason(reason: string | undefined): string {
  switch (reason) {
    case 'ESRCH':
      return 'No such process (already exited)'
    case 'EPERM':
      return 'Not permitted to kill this process'
    default:
      return reason ?? 'Action failed'
  }
}

export function RunSuggestionBanner({
  worktreeId
}: RunSuggestionBannerProps): React.JSX.Element | null {
  const suggestion = useScriptStore((s) => s.scriptStates[worktreeId]?.activeSuggestion ?? null)
  const runRunning = useScriptStore((s) => s.scriptStates[worktreeId]?.runRunning ?? false)
  const dismissSuggestion = useScriptStore((s) => s.dismissSuggestion)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setPending(false)
    setError(null)
  }, [suggestion?.signature])

  if (!suggestion) return null

  const handleAction = async (): Promise<void> => {
    if (suggestion.action.kind !== 'killPid') {
      setError('Unsupported action')
      return
    }

    setPending(true)
    setError(null)
    try {
      const result = await scriptApi.killPid(suggestion.action.pid)
      if (result.killed) {
        dismissSuggestion(worktreeId)
      } else {
        setError(humanReason(result.reason))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/8 px-2 py-1.5 text-xs"
      data-run-running={runRunning ? 'true' : 'false'}
      data-testid="run-suggestion-banner"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-foreground">
          {suggestion.description ?? 'Suggested action available.'}
        </div>
        {error && <div className="truncate text-destructive">{error}</div>}
      </div>
      <Button
        variant="destructive"
        size="sm"
        className="h-7 font-mono text-xs"
        onClick={handleAction}
        disabled={pending || error !== null}
      >
        {pending ? 'Running...' : suggestion.label}
      </Button>
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded hover:bg-destructive/10"
        aria-label="Dismiss suggestion"
        onClick={() => dismissSuggestion(worktreeId)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
