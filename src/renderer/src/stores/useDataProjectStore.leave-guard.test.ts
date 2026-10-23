// Leaving a data project with staged table edits never drops them without asking: for a git
// project, a worktree, a connection or the Pinned Board / board view, whether the entry point
// asks first (leaveDataProjectThen, the board toggles) or the selection is made elsewhere (the
// data project then stays on screen until the user answered and comes back on "Keep editing").
// With nothing staged everything happens synchronously, exactly as before. A connection edit
// (update) drops the staged edits only once the change was saved.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sampleDataProject } from '@/components/data-projects/data-project.sample'

const api = vi.hoisted(() => ({
  touch: vi.fn(),
  update: vi.fn(),
  status: vi.fn(),
  onStatus: vi.fn()
}))
vi.mock('@/api/data-projects-api', () => ({ dataProjectsApi: api }))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

// The workspace's ask-only question (a Discard answer leaves the staged edits in place).
const askOnly = vi.hoisted(() => ({
  pending: null as { projectId: string; resolve: (discard: boolean) => void } | null
}))
vi.mock('./useDataWorkspaceStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('./useDataWorkspaceStore')>()
  return {
    ...original,
    askDiscardPendingEdits: (projectId: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        askOnly.pending = { projectId, resolve }
      })
  }
})

const { useDataProjectStore, leaveDataProjectThen } = await import('./useDataProjectStore')
const { useProjectStore } = await import('./useProjectStore')
const { useWorktreeStore } = await import('./useWorktreeStore')
const { useConnectionStore } = await import('./useConnectionStore')
const { useKanbanStore } = await import('./useKanbanStore')
const { useDataWorkspaceStore } = await import('./useDataWorkspaceStore')

const initialProjectState = useProjectStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialConnectionState = useConnectionStore.getState()
const initialKanbanState = useKanbanStore.getState()

const DP = 'dp-1'
const workspace = () => useDataWorkspaceStore.getState()
const selected = () => useDataProjectStore.getState().selectedDataProjectId
let unregisterHost: (() => void) | null = null

/** dp-1 open with 3 staged edits in a table tab, its SqlWorkspace mounted (it can ask). */
function stageEdits(): string {
  const tab = workspace().openTable(DP, { name: 'users' })
  workspace().setStagedEditCount(tab, 3)
  unregisterHost = workspace().registerDiscardHost(DP)
  return tab
}

async function answer(discard: boolean): Promise<void> {
  const request = workspace().discardRequest
  if (!request) throw new Error('nothing was asked')
  workspace().answerDiscardEdits(request.id, discard)
  // Let the answer's continuations run.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeAll(async () => {
  // The data store keeps a reference to the lazily imported workspace chunk.
  await new Promise((resolve) => setTimeout(resolve, 0))
})

beforeEach(() => {
  vi.clearAllMocks()
  api.touch.mockResolvedValue(undefined)
  useDataProjectStore.getState().reset()
  useDataProjectStore.setState({ projects: [sampleDataProject()] })
  workspace().reset()
  askOnly.pending = null
})

afterEach(() => {
  unregisterHost?.()
  unregisterHost = null
  useProjectStore.setState(initialProjectState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
  useConnectionStore.setState(initialConnectionState, true)
  useKanbanStore.setState(initialKanbanState, true)
})

describe('nothing staged: unchanged, synchronous', () => {
  it('runs the change in the same tick and clears the data project at once', () => {
    useDataProjectStore.getState().select(DP)
    const proceed = vi.fn()
    leaveDataProjectThen(proceed)
    expect(proceed).toHaveBeenCalledTimes(1)

    useWorktreeStore.getState().selectWorktree('wt-1')
    expect(selected()).toBeNull()
    expect(workspace().discardRequest).toBeNull()

    useDataProjectStore.getState().select(DP)
    useProjectStore.getState().selectProject('p-1')
    expect(selected()).toBeNull()

    useDataProjectStore.getState().select(DP)
    useConnectionStore.getState().selectConnection('c-1')
    expect(selected()).toBeNull()
  })
})

describe('staged edits, entry points that ask first', () => {
  it('leaveDataProjectThen runs the change only after "Discard"', async () => {
    useDataProjectStore.getState().select(DP)
    stageEdits()
    const proceed = vi.fn()

    leaveDataProjectThen(proceed)
    expect(proceed).not.toHaveBeenCalled()
    expect(workspace().discardRequest?.count).toBe(3)
    await answer(false)
    expect(proceed).not.toHaveBeenCalled()
    expect(selected()).toBe(DP)
    expect(workspace().pendingEditCount(DP)).toBe(3)

    leaveDataProjectThen(proceed)
    await answer(true)
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(workspace().pendingEditCount(DP)).toBe(0)
  })

  it('the Pinned Board toggle changes nothing until answered', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: false })
    useDataProjectStore.getState().select(DP)
    expect(useKanbanStore.getState().isPinnedBoardBehindSession).toBe(true)
    stageEdits()

    useKanbanStore.getState().togglePinnedBoard()
    expect(workspace().discardRequest).not.toBeNull()
    await answer(false)
    expect(useKanbanStore.getState().isPinnedBoardBehindSession).toBe(true)
    expect(selected()).toBe(DP)

    useKanbanStore.getState().togglePinnedBoard()
    await answer(true)
    await vi.waitFor(() => expect(useKanbanStore.getState().isPinnedBoardBehindSession).toBe(false))
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
    expect(selected()).toBeNull()
  })

  it('opening the board view asks; closing it does not', async () => {
    useKanbanStore.setState({ isBoardViewActive: false })
    useDataProjectStore.getState().select(DP)
    stageEdits()

    useKanbanStore.getState().toggleBoardView()
    expect(workspace().discardRequest).not.toBeNull()
    await answer(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)
    expect(selected()).toBe(DP)

    useKanbanStore.getState().toggleBoardView()
    await answer(true)
    await vi.waitFor(() => expect(useKanbanStore.getState().isBoardViewActive).toBe(true))
    expect(selected()).toBeNull()
  })
})

describe('staged edits, selections made without asking first', () => {
  it('a git project: the data project stays until answered and comes back on "Keep editing"', async () => {
    useDataProjectStore.getState().select(DP)
    stageEdits()

    useProjectStore.getState().selectProject('p-1')
    expect(selected()).toBe(DP)
    expect(workspace().discardRequest?.projectId).toBe(DP)
    await answer(false)
    expect(selected()).toBe(DP)
    expect(useProjectStore.getState().selectedProjectId).toBeNull()
    expect(workspace().pendingEditCount(DP)).toBe(3)

    useProjectStore.getState().selectProject('p-1')
    await answer(true)
    expect(selected()).toBeNull()
    expect(useProjectStore.getState().selectedProjectId).toBe('p-1')
  })

  it('a worktree row (worktree + its project) asks once', async () => {
    useDataProjectStore.getState().select(DP)
    stageEdits()

    useWorktreeStore.getState().selectWorktree('wt-1')
    const first = workspace().discardRequest
    useProjectStore.getState().selectProject('p-1')
    expect(workspace().discardRequest).toBe(first)
    expect(selected()).toBe(DP)
    await answer(false)
    expect(selected()).toBe(DP)
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
    expect(useProjectStore.getState().selectedProjectId).toBeNull()

    useWorktreeStore.getState().selectWorktree('wt-1')
    useProjectStore.getState().selectProject('p-1')
    await answer(true)
    expect(selected()).toBeNull()
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-1')
    expect(useProjectStore.getState().selectedProjectId).toBe('p-1')
  })

  it('a connection, with pinned mode kept on "Keep editing"', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: false })
    useDataProjectStore.getState().select(DP)
    stageEdits()

    useConnectionStore.getState().selectConnection('c-1')
    expect(selected()).toBe(DP)
    await answer(false)
    expect(selected()).toBe(DP)
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    // Selecting the connection switched pinned mode off; the board is back behind the data project.
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
    expect(useKanbanStore.getState().isPinnedBoardBehindSession).toBe(true)

    useConnectionStore.getState().selectConnection('c-1')
    await answer(true)
    expect(selected()).toBeNull()
    expect(useConnectionStore.getState().selectedConnectionId).toBe('c-1')
  })

  it('the board brought forward directly goes back behind on "Keep editing"', async () => {
    useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: false })
    useDataProjectStore.getState().select(DP)
    stageEdits()

    useKanbanStore.setState({ isPinnedBoardBehindSession: false })
    expect(selected()).toBe(DP)
    await answer(false)
    expect(useKanbanStore.getState().isPinnedBoardBehindSession).toBe(true)
    expect(selected()).toBe(DP)

    useKanbanStore.setState({ isBoardViewActive: true })
    await answer(false)
    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)
    expect(selected()).toBe(DP)

    useKanbanStore.setState({ isBoardViewActive: true })
    await answer(true)
    expect(selected()).toBeNull()
    expect(useKanbanStore.getState().isBoardViewActive).toBe(true)
  })
})

describe('connection edit (update) with staged edits', () => {
  const connectionPatch = { config: { host: 'db2' } }

  it('keeps the staged edits when the save fails after "Discard"', async () => {
    useDataProjectStore.getState().select(DP)
    stageEdits()
    api.update.mockRejectedValue(new Error('vault unavailable'))

    const saving = useDataProjectStore.getState().update(DP, connectionPatch)
    await vi.waitFor(() => expect(askOnly.pending?.projectId).toBe(DP))
    askOnly.pending!.resolve(true)
    await expect(saving).rejects.toThrow('vault unavailable')

    expect(workspace().pendingEditCount(DP)).toBe(3)
    expect(workspace().discardEpoch[DP]).toBeUndefined()
    expect(useDataProjectStore.getState().connectionEpoch[DP]).toBeUndefined()
  })

  it('drops them once the save went through', async () => {
    useDataProjectStore.getState().select(DP)
    stageEdits()
    api.update.mockResolvedValue(sampleDataProject({ config: { host: 'db2' } }))

    const saving = useDataProjectStore.getState().update(DP, connectionPatch)
    await vi.waitFor(() => expect(askOnly.pending).not.toBeNull())
    // Nothing is dropped while the save runs.
    expect(workspace().pendingEditCount(DP)).toBe(3)
    askOnly.pending!.resolve(true)
    await saving

    expect(workspace().pendingEditCount(DP)).toBe(0)
    expect(workspace().discardEpoch[DP]).toBe(1)
    expect(useDataProjectStore.getState().connectionEpoch[DP]).toBe(1)
  })

  it('"Keep editing" changes nothing', async () => {
    useDataProjectStore.getState().select(DP)
    stageEdits()

    const saving = useDataProjectStore.getState().update(DP, connectionPatch)
    await vi.waitFor(() => expect(askOnly.pending).not.toBeNull())
    askOnly.pending!.resolve(false)
    await expect(saving).rejects.toThrow('Kept the pending table edits')
    expect(api.update).not.toHaveBeenCalled()
    expect(workspace().pendingEditCount(DP)).toBe(3)
  })

  it('a change that does not reconnect never asks', async () => {
    useDataProjectStore.getState().select(DP)
    stageEdits()
    api.update.mockResolvedValue(sampleDataProject({ name: 'renamed' }))
    await useDataProjectStore.getState().update(DP, { name: 'renamed' })
    expect(askOnly.pending).toBeNull()
    expect(workspace().pendingEditCount(DP)).toBe(3)
  })
})
