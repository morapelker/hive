import { dbApi } from '@/api/db-api'
import { leaveBoardViews } from '@/lib/board-navigation'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { Session } from '../../../../main/db/types'

// Leaving a run dialog for the place the work happens. Same moves as a click on a sidebar
// worktree (or instance) row, and as "go to session" on a kanban card or in the ticket modal.

/** Select a worktree in the sidebar, as a click on its row does. */
export function openWorktree(projectId: string, worktreeId: string): void {
  leaveBoardViews()
  useWorktreeStore.getState().selectWorktree(worktreeId)
  useProjectStore.getState().selectProject(projectId)
  useSessionStore.getState().setActiveWorktree(worktreeId)
  useWorktreeStatusStore.getState().clearWorktreeUnread(worktreeId)
}

/**
 * Select a connection instance in the sidebar, as a click on its row does. Selecting the
 * connection clears the worktree selection itself; the session store is told separately, as
 * the kanban card's "go to session" does.
 */
export function openConnection(projectId: string, connectionId: string): void {
  leaveBoardViews()
  useConnectionStore.getState().selectConnection(connectionId)
  useProjectStore.getState().selectProject(projectId)
  useSessionStore.getState().setActiveConnection(connectionId)
}

/**
 * A session that was closed when its ticket was done has no tab any more; bring it back so
 * the jump does not land on an empty pane. The store drops closed sessions from its maps, so
 * the lookup falls back to the database row. A connection session is reopened on its instance.
 */
async function reopenIfClosed(
  sessionId: string,
  target: { worktreeId: string } | { connectionId: string }
): Promise<void> {
  try {
    const sessions = useSessionStore.getState()
    const record =
      sessions.getSessionById(sessionId) ?? (await dbApi.session.get<Session>(sessionId))
    if (record?.status !== 'completed') return
    if ('connectionId' in target) {
      await sessions.reopenConnectionSession(sessionId, target.connectionId)
    } else {
      await sessions.reopenSession(sessionId, target.worktreeId)
    }
  } catch {
    // Best effort: at worst the jump lands on a session without a tab.
  }
}

/**
 * Bring a session to the front, switching to its worktree first when it has one, or to its
 * connection instance for a session of a connection run (`connectionId` outranks `worktreeId`).
 */
export function openSession(
  projectId: string,
  worktreeId: string | null,
  sessionId: string,
  connectionId?: string | null
): void {
  leaveBoardViews()
  if (connectionId) {
    useConnectionStore.getState().selectConnection(connectionId)
    useSessionStore.getState().setActiveConnection(connectionId)
  } else if (worktreeId) {
    useWorktreeStore.getState().selectWorktree(worktreeId)
    useSessionStore.getState().setActiveWorktree(worktreeId)
  }
  useProjectStore.getState().selectProject(projectId)
  useSessionStore.getState().setActiveSession(sessionId)
  if (connectionId) void reopenIfClosed(sessionId, { connectionId })
  else if (worktreeId) void reopenIfClosed(sessionId, { worktreeId })
}
