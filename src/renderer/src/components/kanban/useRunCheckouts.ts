import { activeConnectionIds } from '@/lib/document-flow/migrations'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

export interface RunCheckouts {
  worktrees: readonly { id: string }[] | undefined
  connectionIds: ReadonlySet<string> | undefined
}

/**
 * The checkouts of `projectId` as far as they are known, as `integrationCheckoutGone` takes them.
 * A list that has not loaded is undefined, which refuses nothing: a worktree made for a project
 * never loaded leaves an entry that is not the whole list, so the entry alone does not count, and
 * a failed load of the connections marks them loaded with an empty list.
 * With no project nothing is read, so a card this does not concern never re-renders for a list.
 */
export function useRunCheckouts(projectId: string | null): RunCheckouts {
  const worktrees = useWorktreeStore((s) =>
    projectId && s.loadedProjectIds.has(projectId) ? s.worktreesByProject.get(projectId) : undefined
  )
  const loaded = useConnectionStore((s) => projectId !== null && s.loaded)
  const connections = useConnectionStore((s) => (projectId && !s.error ? s.connections : null))
  return {
    worktrees,
    connectionIds: connections ? activeConnectionIds({ loaded, connections }) : undefined
  }
}
