import { useMemo } from 'react'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { summarizeAgentState, type ProjectAgentState } from '@/lib/recent-projects'

/**
 * Whether an agent is working, or waiting on the user, anywhere in a project: in one of a git
 * project's worktrees, or in one of a connection project's instances. Null when neither.
 *
 * Reactivity follows useSiblingAggregate: the per-worktree status is read through
 * `.getState()`, and every store slice it depends on is subscribed to here so the memo re-runs.
 */
export function useProjectAgentState(
  projectId: string,
  kind: 'git' | 'connection'
): ProjectAgentState {
  const worktrees = useWorktreeStore((s) => s.worktreesByProject.get(projectId))
  const archivingWorktreeIds = useWorktreeStore((s) => s.archivingWorktreeIds)
  const connections = useConnectionStore((s) => s.connections)
  const sessionStatuses = useWorktreeStatusStore((s) => s.sessionStatuses)
  const sessionsByWorktree = useSessionStore((s) => s.sessionsByWorktree)
  const sessionsByConnection = useSessionStore((s) => s.sessionsByConnection)

  return useMemo<ProjectAgentState>(() => {
    const status = useWorktreeStatusStore.getState()
    if (kind === 'connection') {
      return summarizeAgentState(
        connections
          .filter((c) => c.saved_project_id === projectId)
          .map((c) => status.getConnectionStatus(c.id))
      )
    }
    return summarizeAgentState(
      (worktrees ?? [])
        .filter((w) => !archivingWorktreeIds.has(w.id))
        .map((w) => status.getWorktreeStatus(w.id))
    )
    // `sessionStatuses`, `sessionsByWorktree` and `sessionsByConnection` feed
    // getWorktreeStatus() / getConnectionStatus() through `.getState()`: listed so that a
    // change in any of them recomputes the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    projectId,
    kind,
    worktrees,
    archivingWorktreeIds,
    connections,
    sessionStatuses,
    sessionsByWorktree,
    sessionsByConnection
  ])
}
