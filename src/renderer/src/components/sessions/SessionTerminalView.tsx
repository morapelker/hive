import { useMemo } from 'react'
import { TerminalView } from '@/components/terminal/TerminalView'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'

interface SessionTerminalViewProps {
  sessionId: string
}

/**
 * Renders a full-size terminal for "terminal" agent_sdk sessions.
 * Uses the session ID as the PTY key (not worktree ID) to avoid
 * conflicts with the bottom-panel terminal.
 */
export function SessionTerminalView({ sessionId }: SessionTerminalViewProps): React.JSX.Element {
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

  // Resolve the working directory from the session's worktree
  const cwd = useMemo(() => {
    if (!session) return null

    // Direct worktree session
    if (session.worktree_id) {
      const worktreesByProject = useWorktreeStore.getState().worktreesByProject
      for (const worktrees of worktreesByProject.values()) {
        const wt = worktrees.find((w) => w.id === session.worktree_id)
        if (wt?.path) return wt.path
      }
    }

    // Connection session — use the first member's worktree path
    if (session.connection_id) {
      const connections = useConnectionStore.getState().connections
      const connection = connections.find((c) => c.id === session.connection_id)
      if (connection?.members?.[0]) {
        const worktreesByProject = useWorktreeStore.getState().worktreesByProject
        for (const worktrees of worktreesByProject.values()) {
          const wt = worktrees.find((w) => w.id === connection.members[0].worktree_id)
          if (wt?.path) return wt.path
        }
      }
    }

    return null
  }, [session])

  if (!cwd) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p className="text-sm">Loading terminal...</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="session-terminal-view">
      <TerminalView
        worktreeId={sessionId}
        cwd={cwd}
        isVisible={true}
      />
    </div>
  )
}
