import { useEffect, useState } from 'react'
import { TerminalView } from '@/components/terminal/TerminalView'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'

const findWorktreePath = (
  worktreesByProject: ReadonlyMap<string, readonly { id: string; path: string }[]>,
  worktreeId: string | null
): string | null => {
  if (!worktreeId) return null
  for (const worktrees of worktreesByProject.values()) {
    const worktree = worktrees.find((candidate) => candidate.id === worktreeId)
    if (worktree?.path) return worktree.path
  }
  return null
}

interface SessionTerminalViewProps {
  sessionId: string
  /** Whether this terminal is currently visible (not hidden by CSS). Controls fit/focus and Ghostty frame sync. */
  isVisible?: boolean
}

/**
 * Renders a full-size terminal for "terminal" agent_sdk sessions.
 * Uses the session ID as the PTY key (not worktree ID) to avoid
 * conflicts with the bottom-panel terminal.
 */
export function SessionTerminalView({
  sessionId,
  isVisible = true
}: SessionTerminalViewProps): React.JSX.Element {
  // Look up the session to find its worktree_id or connection_id
  const session = useSessionStore((state) => {
    for (const sessions of state.sessionsByWorktree.values()) {
      const found = sessions.find((s) => s.id === sessionId)
      if (found) return found
    }
    for (const sessions of state.sessionsByConnection.values()) {
      const found = sessions.find((s) => s.id === sessionId)
      if (found) return found
    }
    return null
  })

  const sessionWorktreeId = session?.worktree_id ?? null
  const sessionConnectionId = session?.connection_id ?? null

  // A connection session starts in the folder of the connection's first member.
  const connectionWorktreeId = useConnectionStore((state) => {
    if (!sessionConnectionId) return null
    const connection = state.connections.find((candidate) => candidate.id === sessionConnectionId)
    return connection?.members?.[0]?.worktree_id ?? null
  })

  // The working directory is the folder of that worktree as the store holds it now. It is
  // selected from the store, not read once: the rows can load after this view mounted, and a
  // worktree's folder changes when its project is moved to the dev folder. A terminal that is
  // started again after that must start where the project is, not in the folder it left.
  const resolvedCwd = useWorktreeStore(
    (state) =>
      findWorktreePath(state.worktreesByProject, sessionWorktreeId) ??
      findWorktreePath(state.worktreesByProject, connectionWorktreeId)
  )

  const [lastKnownCwd, setLastKnownCwd] = useState<string | null>(null)

  useEffect(() => {
    if (!resolvedCwd) return
    setLastKnownCwd((current) => (current === resolvedCwd ? current : resolvedCwd))
  }, [resolvedCwd])

  const cwd = resolvedCwd || lastKnownCwd

  if (!cwd) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p className="text-sm">Loading terminal...</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="session-terminal-view">
      <TerminalView terminalId={sessionId} cwd={cwd} isVisible={isVisible} />
    </div>
  )
}
