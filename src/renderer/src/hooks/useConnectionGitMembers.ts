import { useEffect, useMemo } from 'react'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { connectionMemberProjectIds, resolveConnectionGitMembers } from '@/lib/connection-git-view'

/**
 * The members the git side (Changes / branch diff / push-pull) works on for the
 * selected connection, honoring the connection store's git view: the
 * connection's own member worktrees, or — in the 'base' view — each member
 * project's default worktree. Loads member projects' worktrees on demand so
 * the base view can resolve them.
 *
 * Returns undefined when no connection is selected.
 */
export function useConnectionGitMembers():
  ReturnType<typeof resolveConnectionGitMembers> | undefined {
  const selectedConnection = useConnectionStore((s) =>
    s.selectedConnectionId ? s.connections.find((c) => c.id === s.selectedConnectionId) : undefined
  )
  const gitView = useConnectionStore((s) => s.connectionGitView)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)

  // Base view needs every member project's worktrees; projects that have never
  // been selected may not have them loaded yet.
  useEffect(() => {
    if (gitView !== 'base' || !selectedConnection) return
    for (const projectId of connectionMemberProjectIds(selectedConnection)) {
      if (!worktreesByProject.has(projectId)) {
        void useWorktreeStore.getState().loadWorktrees(projectId)
      }
    }
  }, [gitView, selectedConnection, worktreesByProject])

  return useMemo(
    () =>
      selectedConnection
        ? resolveConnectionGitMembers(selectedConnection, gitView, worktreesByProject)
        : undefined,
    [selectedConnection, gitView, worktreesByProject]
  )
}
