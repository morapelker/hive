import { useCallback, useEffect } from 'react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { SidebarHoverTarget } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

interface SidebarHoverHandlers {
  onMouseEnter: () => void
  onMouseLeave: () => void
}

/** Project owning a worktree, from the already-loaded worktree store. */
function findWorktreeProjectId(worktreeId: string): string | null {
  for (const [projectId, worktrees] of useWorktreeStore.getState().worktreesByProject) {
    if (worktrees.some((w) => w.id === worktreeId)) return projectId
  }
  return null
}

/**
 * Mouse enter/leave handlers for a sidebar card (project header, worktree,
 * connection). While the card is hovered, board ticket cards linked to it are
 * highlighted. Worktree hover is worktree-agnostic: it highlights every ticket
 * of the worktree's project, not just the ones on that branch. Clears the
 * target on unmount so a card removed mid-hover does not leave a stale
 * highlight behind.
 */
export function useSidebarHoverHighlight(
  kind: SidebarHoverTarget['kind'],
  id: string
): SidebarHoverHandlers {
  const onMouseEnter = useCallback(() => {
    const kanban = useKanbanStore.getState()
    const target: SidebarHoverTarget =
      kind === 'worktree'
        ? { kind, id, projectId: findWorktreeProjectId(id) }
        : ({ kind, id } as SidebarHoverTarget)
    kanban.setHoveredSidebarTarget(target)
    // Connection tickets are linked through their session, and connection
    // sessions are only loaded once a connection is opened. While a board is
    // showing, fetch them in the background so the highlight can resolve.
    if (kind === 'connection' && (kanban.isBoardViewActive || kanban.isPinnedBoardActive)) {
      const sessions = useSessionStore.getState()
      if (!sessions.sessionsByConnection.has(id)) {
        void sessions.loadConnectionSessionsBackground(id)
      }
    }
  }, [kind, id])

  const onMouseLeave = useCallback(() => {
    const state = useKanbanStore.getState()
    const current = state.hoveredSidebarTarget
    if (current && current.kind === kind && current.id === id) {
      state.setHoveredSidebarTarget(null)
    }
  }, [kind, id])

  useEffect(() => onMouseLeave, [onMouseLeave])

  return { onMouseEnter, onMouseLeave }
}
