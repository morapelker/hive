import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

const kanbanState = {
  isPinnedBoardActive: true,
  togglePinnedBoard: vi.fn(),
  closePinnedBoard: vi.fn()
}

vi.mock('../useKanbanStore', () => ({
  useKanbanStore: {
    getState: vi.fn(() => kanbanState)
  }
}))

const pinnedState = {
  pinnedProjectIds: new Set<string>()
}

vi.mock('../usePinnedStore', () => ({
  usePinnedStore: {
    getState: vi.fn(() => pinnedState)
  }
}))

import { resetRendererRpcClientForTests, setRendererRpcClient } from '../../api/rpc-client'
import { useProjectStore } from '../useProjectStore'

// selectProject resolves the pinned scope through a dynamic import — wait for
// it to settle before asserting.
const flush = (): Promise<void> => vi.dynamicImportSettled()

describe('useProjectStore selectProject × pinned board', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setRendererRpcClient({ request: vi.fn().mockResolvedValue(true), subscribe: vi.fn() })
    kanbanState.isPinnedBoardActive = true
    pinnedState.pinnedProjectIds = new Set<string>()
    useProjectStore.setState({ selectedProjectId: null })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('closes the pinned board when selecting a project outside the pinned scope', async () => {
    useProjectStore.getState().selectProject('project-1')
    await flush()

    expect(useProjectStore.getState().selectedProjectId).toBe('project-1')
    expect(kanbanState.closePinnedBoard).toHaveBeenCalledTimes(1)
  })

  it('keeps the pinned board open when selecting a project already in the pinned scope', async () => {
    pinnedState.pinnedProjectIds = new Set(['project-1'])

    useProjectStore.getState().selectProject('project-1')
    await flush()

    expect(useProjectStore.getState().selectedProjectId).toBe('project-1')
    expect(kanbanState.closePinnedBoard).not.toHaveBeenCalled()
    expect(kanbanState.togglePinnedBoard).not.toHaveBeenCalled()
  })

  it('keeps the pinned board open when preservePinnedBoard is set', async () => {
    useProjectStore.getState().selectProject('project-1', { preservePinnedBoard: true })
    await flush()

    expect(kanbanState.closePinnedBoard).not.toHaveBeenCalled()
    expect(kanbanState.togglePinnedBoard).not.toHaveBeenCalled()
  })

  it('does nothing when the pinned board is not active', async () => {
    kanbanState.isPinnedBoardActive = false

    useProjectStore.getState().selectProject('project-1')
    await flush()

    expect(kanbanState.closePinnedBoard).not.toHaveBeenCalled()
    expect(kanbanState.togglePinnedBoard).not.toHaveBeenCalled()
  })
})
