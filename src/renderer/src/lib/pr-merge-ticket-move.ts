import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { kanbanApi } from '@/api/kanban-api'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { documentRunIdOf, isActiveRunStatus } from '@shared/document-flow/run-ticket'
import type { KanbanTicket } from '../../../main/db/types'

function resolveProjectIdForWorktree(worktreeId: string): string | null {
  for (const [projectId, worktrees] of useWorktreeStore.getState().worktreesByProject) {
    if (worktrees.some((w) => w.id === worktreeId)) return projectId
  }
  return null
}

/**
 * After a PR merge succeeds, advance the worktree's linked tickets to the
 * Merged column — only when that column exists on the board (the
 * showMergedColumn setting). Terminal-column tickets stay put: done/merged
 * are already final, and a ticket carrying a different PR number belongs to
 * another PR's lifecycle.
 */
export async function moveWorktreeTicketsToMerged(
  worktreeId: string,
  prNumber?: number
): Promise<void> {
  try {
    if (!useSettingsStore.getState().showMergedColumn) return

    // The ticket of a document run stays In Progress for as long as its run is on, and
    // again while a session executes the run's migrations
    const isRunningDocumentRun = (t: KanbanTicket): boolean => {
      const runId = documentRunIdOf(t)
      const run = runId ? useDocumentFlowStore.getState().runsById[runId]?.run : null
      return !!run && (isActiveRunStatus(run.status) || Boolean(run.migration_session_id))
    }

    const shouldMove = (t: KanbanTicket): boolean =>
      t.worktree_id === worktreeId &&
      !t.archived_at &&
      !isRunningDocumentRun(t) &&
      t.column !== 'merged' &&
      t.column !== 'done' &&
      (prNumber == null || t.github_pr_number == null || t.github_pr_number === prNumber)

    // Tickets already loaded in the store move via moveTicket so any open
    // board updates optimistically and completion effects (dependent
    // auto-launch) fire, matching a manual drag onto Merged.
    const kanban = useKanbanStore.getState()
    const loadedProjectIds = new Set<string>()
    const loadedMoves: Array<Promise<void>> = []
    for (const [projectId, tickets] of kanban.tickets) {
      loadedProjectIds.add(projectId)
      for (const ticket of tickets) {
        if (!shouldMove(ticket)) continue
        loadedMoves.push(
          kanban.moveTicket(ticket.id, projectId, 'merged', ticket.sort_order).catch(() => {})
        )
      }
    }
    await Promise.all(loadedMoves)

    // The worktree's board may never have been opened this session — its
    // tickets then only exist in the DB, so move them through the RPC
    // directly (no store state to keep in sync).
    const projectId = resolveProjectIdForWorktree(worktreeId)
    if (!projectId || loadedProjectIds.has(projectId)) return
    const dbTickets = await kanbanApi.ticket.getByProject<KanbanTicket>(projectId, false)
    await Promise.all(
      dbTickets
        .filter(shouldMove)
        .map((t) => kanbanApi.ticket.move(projectId, t.id, 'merged', t.sort_order).catch(() => {}))
    )
  } catch {
    // Best-effort: a failed board sync must never surface as a merge failure.
  }
}
