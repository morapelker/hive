import { useState } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

/**
 * A number that goes up each time the folder of the session's worktree becomes another
 * folder: the project was moved (to the dev folder) while the session is on screen.
 *
 * A session view that talks to an agent holds that folder in many places at once: its
 * state, the closures of its start-up, and the agent's own registration, which is filed
 * under `<folder>::<agent session id>`. Starting the view over is the one way to replace all
 * of them together, so the view takes this number as its `key`.
 *
 * It only counts a change from one known folder to a different one. The first time the
 * worktree's row shows up in the store (the view mounted before its project loaded) is not a
 * move and must not restart a view that is already running, and neither is the row going
 * away for a moment. The selector returns the path itself, so a change to any other worktree
 * does not even render the caller.
 */
export function useWorktreePathEpoch(sessionId: string): number {
  const worktreeId = useSessionStore(
    (state) => state.getSessionById(sessionId)?.worktree_id ?? null
  )
  const storePath = useWorktreeStore((state) => {
    if (!worktreeId) return null
    for (const worktrees of state.worktreesByProject.values()) {
      const worktree = worktrees.find((candidate) => candidate.id === worktreeId)
      if (worktree) return worktree.path
    }
    return null
  })

  const [seen, setSeen] = useState<{ path: string | null; epoch: number }>({
    path: storePath,
    epoch: 0
  })
  if (!storePath || storePath === seen.path) return seen.epoch

  // Adjusting state while rendering: React runs this render again with the new state before
  // it touches the children, so they never see the folder and the number out of step.
  const epoch = seen.path ? seen.epoch + 1 : seen.epoch
  setSeen({ path: storePath, epoch })
  return epoch
}
