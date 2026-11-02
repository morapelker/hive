import {
  getKanbanInFlightMutationCount,
  getKanbanMutationGeneration,
  useKanbanStore,
  whenKanbanMutationsSettled
} from '@/stores/useKanbanStore'

/** How many times a board reload retries when a mutation overlapped its fetch. */
const MAX_BOARD_RELOADS = 3

const swallow = (): void => {}

/**
 * Reloads a board, never letting a `getByProject` response that overlapped an optimistic
 * mutation stand as the final state. The in-flight counter guards the start of the fetch; the
 * generation counter detects a mutation that began during the round-trip (its optimistic state
 * was clobbered by the pre-write response), in which case the board is fetched again once the
 * mutation settles.
 */
export async function reloadBoard(
  projectId: string,
  onLoadStart: () => void = swallow
): Promise<void> {
  for (let attempt = 0; attempt < MAX_BOARD_RELOADS; attempt++) {
    // Never race an optimistic mutation of the same board.
    await whenKanbanMutationsSettled(projectId)
    const generation = getKanbanMutationGeneration(projectId)
    const inFlight = getKanbanInFlightMutationCount(projectId)
    onLoadStart()
    await useKanbanStore.getState().loadTicketsForProjectInAggregate(projectId)
    const clean = inFlight === 0 && getKanbanMutationGeneration(projectId) === generation
    if (clean) return
  }
}
