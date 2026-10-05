import { dbApi } from '@/api/db-api'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { Session } from '../../../../main/db/types'

// Leaving a run dialog for the place the work happens. Same moves as a click on a sidebar
// worktree row, and as "go to session" on a kanban card or in the ticket modal.

function leaveBoardViews(): void {
  const kanban = useKanbanStore.getState()
  if (kanban.isBoardViewActive) kanban.toggleBoardView()
  if (kanban.isPinnedBoardActive) kanban.togglePinnedBoard()
}

/** Select a worktree in the sidebar, as a click on its row does. */
export function openWorktree(projectId: string, worktreeId: string): void {
  leaveBoardViews()
  useWorktreeStore.getState().selectWorktree(worktreeId)
  useProjectStore.getState().selectProject(projectId)
  useSessionStore.getState().setActiveWorktree(worktreeId)
  useWorktreeStatusStore.getState().clearWorktreeUnread(worktreeId)
}

/**
 * A session that was closed when its ticket was done has no tab any more; bring it back so
 * the jump does not land on an empty pane. The store drops closed sessions from its maps, so
 * the lookup falls back to the database row.
 */
async function reopenIfClosed(sessionId: string, worktreeId: string): Promise<void> {
  try {
    const sessions = useSessionStore.getState()
    const record =
      sessions.getSessionById(sessionId) ?? (await dbApi.session.get<Session>(sessionId))
    if (record?.status === 'completed') await sessions.reopenSession(sessionId, worktreeId)
  } catch {
    // Best effort: at worst the jump lands on a session without a tab.
  }
}

/** Bring a session to the front, switching to its worktree first when it has one. */
export function openSession(projectId: string, worktreeId: string | null, sessionId: string): void {
  leaveBoardViews()
  if (worktreeId) {
    useWorktreeStore.getState().selectWorktree(worktreeId)
    useSessionStore.getState().setActiveWorktree(worktreeId)
  }
  useProjectStore.getState().selectProject(projectId)
  useSessionStore.getState().setActiveSession(sessionId)
  if (worktreeId) void reopenIfClosed(sessionId, worktreeId)
}
