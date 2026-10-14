import { useKanbanStore } from '@/stores/useKanbanStore'

/**
 * Leave every board surface so the main pane shows a session.
 *
 * Every "go to session" action in the app (ticket card, ticket modal, plan rows,
 * conflict-fix, shell commands, notifications, document-flow runs) goes through
 * here. Both closes are idempotent: `togglePinnedBoard` / `toggleBoardView` are
 * async (dynamic import) and tiled-aware, so a toggle queued here races the
 * synchronous close that `selectWorktree` / `selectConnection` already perform
 * and flips the pinned board back ON — which is exactly the "I can only see the
 * session after I toggle the pinboard off" bug.
 */
export function leaveBoardViews(): void {
  const kanban = useKanbanStore.getState()
  kanban.closeBoardView()
  kanban.closePinnedBoard()
}
