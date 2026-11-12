import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reloadBoard = vi.hoisted(() => vi.fn(async (_projectId: string) => {}))
vi.mock('@/lib/board-reload', () => ({ reloadBoard }))

import { useKanbanStore } from '@/stores/useKanbanStore'
import {
  RUN_BOARD_RELOAD_DEBOUNCE_MS,
  cancelRunBoardReloads,
  scheduleRunBoardReload
} from './board-sync'

const initialKanbanState = useKanbanStore.getState()

/** The boards the renderer has loaded. */
const loadBoards = (...projectIds: string[]): void => {
  useKanbanStore.setState({ tickets: new Map(projectIds.map((id) => [id, []])) })
}

describe('scheduleRunBoardReload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    reloadBoard.mockClear()
    loadBoards('proj-1')
  })

  afterEach(() => {
    cancelRunBoardReloads()
    vi.useRealTimers()
    useKanbanStore.setState(initialKanbanState, true)
  })

  it('reloads the board of the project a run changed in', () => {
    scheduleRunBoardReload({ projectId: 'proj-1', reason: 'run' })

    expect(reloadBoard).not.toHaveBeenCalled()
    vi.advanceTimersByTime(RUN_BOARD_RELOAD_DEBOUNCE_MS)
    expect(reloadBoard).toHaveBeenCalledExactlyOnceWith('proj-1')
  })

  it('reloads once for a burst of pushes about one project', () => {
    scheduleRunBoardReload({ projectId: 'proj-1', reason: 'run' })
    vi.advanceTimersByTime(RUN_BOARD_RELOAD_DEBOUNCE_MS - 1)
    scheduleRunBoardReload({ projectId: 'proj-1', reason: 'item' })
    vi.advanceTimersByTime(RUN_BOARD_RELOAD_DEBOUNCE_MS - 1)
    expect(reloadBoard).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(reloadBoard).toHaveBeenCalledTimes(1)
  })

  it('reloads each project on its own', () => {
    loadBoards('proj-1', 'proj-2')
    scheduleRunBoardReload({ projectId: 'proj-1', reason: 'run' })
    scheduleRunBoardReload({ projectId: 'proj-2', reason: 'deleted' })
    vi.advanceTimersByTime(RUN_BOARD_RELOAD_DEBOUNCE_MS)

    expect(reloadBoard.mock.calls.map(([projectId]) => projectId).sort()).toEqual([
      'proj-1',
      'proj-2'
    ])
  })

  it('leaves the board alone for an entry of the activity log', () => {
    scheduleRunBoardReload({ projectId: 'proj-1', reason: 'event' })
    vi.advanceTimersByTime(RUN_BOARD_RELOAD_DEBOUNCE_MS)

    expect(reloadBoard).not.toHaveBeenCalled()
  })

  it('does not load a board that was never opened', () => {
    scheduleRunBoardReload({ projectId: 'proj-other', reason: 'run' })
    vi.advanceTimersByTime(RUN_BOARD_RELOAD_DEBOUNCE_MS)

    expect(reloadBoard).not.toHaveBeenCalled()
  })

  it('drops what has not run yet when cancelled', () => {
    scheduleRunBoardReload({ projectId: 'proj-1', reason: 'run' })
    cancelRunBoardReloads()
    vi.advanceTimersByTime(RUN_BOARD_RELOAD_DEBOUNCE_MS)

    expect(reloadBoard).not.toHaveBeenCalled()
  })

  it('survives a reload that fails', async () => {
    reloadBoard.mockRejectedValueOnce(new Error('offline'))
    scheduleRunBoardReload({ projectId: 'proj-1', reason: 'run' })
    await vi.advanceTimersByTimeAsync(RUN_BOARD_RELOAD_DEBOUNCE_MS)

    scheduleRunBoardReload({ projectId: 'proj-1', reason: 'run' })
    await vi.advanceTimersByTimeAsync(RUN_BOARD_RELOAD_DEBOUNCE_MS)
    expect(reloadBoard).toHaveBeenCalledTimes(2)
  })
})
