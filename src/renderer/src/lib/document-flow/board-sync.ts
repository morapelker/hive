import { reloadBoard } from '@/lib/board-reload'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { DocumentFlowUpdatedEvent } from '@shared/document-flow-events'

/** A burst of pushes about one project (a run and its items changing together) reloads once. */
export const RUN_BOARD_RELOAD_DEBOUNCE_MS = 250

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * The document-flow service writes to the board on its own, behind the renderer's back: a
 * run's own ticket (made with the run), the parent link of every board ticket an orchestrator
 * adopts or releases, the dependencies edited from a run, the copies a duplicated run gets.
 * Nothing else tells the board, so a `documentFlow:updated` push about a project whose board is
 * loaded reloads that board, once per burst.
 *
 * An entry of the run's activity log (`event`) writes nothing to the board, and a project
 * whose board was never loaded has nothing to refresh: it is read whole when it is opened.
 */
export function scheduleRunBoardReload(
  event: Pick<DocumentFlowUpdatedEvent, 'projectId' | 'reason'>
): void {
  if (event.reason === 'event') return
  const { projectId } = event
  if (!useKanbanStore.getState().tickets.has(projectId)) return
  const pending = timers.get(projectId)
  if (pending) clearTimeout(pending)
  timers.set(
    projectId,
    setTimeout(() => {
      timers.delete(projectId)
      // A failed reload leaves the board as it was; the next push tries again.
      void reloadBoard(projectId).catch(() => undefined)
    }, RUN_BOARD_RELOAD_DEBOUNCE_MS)
  )
}

/** Drops the reloads that have not run yet (the hook that schedules them unmounted). */
export function cancelRunBoardReloads(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}
