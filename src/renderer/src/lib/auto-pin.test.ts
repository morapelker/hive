import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingsState = {
  autoPinBaseWorktreeOnBoardPrompt: true
}
vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: () => settingsState }
}))
vi.mock('@/api/hive-enterprise/client', () => ({
  isForceBoardMode: () => false
}))

const pinnedState = {
  pinnedWorktreeIds: new Set<string>(),
  pinnedConnectionIds: new Set<string>(),
  isWorktreePinned: vi.fn((id: string) => pinnedState.pinnedWorktreeIds.has(id)),
  isConnectionPinned: vi.fn((id: string) => pinnedState.pinnedConnectionIds.has(id)),
  pinWorktree: vi.fn(async () => {}),
  pinConnection: vi.fn(async () => {})
}
vi.mock('@/stores/usePinnedStore', () => ({
  usePinnedStore: { getState: () => pinnedState }
}))

const worktreeState = {
  defaultByProject: new Map<string, { id: string } | null>(),
  getDefaultWorktree: vi.fn((projectId: string) => worktreeState.defaultByProject.get(projectId) ?? null),
  loadWorktrees: vi.fn(async () => {})
}
vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: { getState: () => worktreeState }
}))

const projectState = {
  projects: [] as { id: string; kind?: 'git' | 'connection' }[]
}
vi.mock('@/stores/useProjectStore', () => ({
  useProjectStore: { getState: () => projectState }
}))

const connectionState = {
  connections: [] as { id: string; saved_project_id?: string | null; is_base?: number }[],
  loadConnections: vi.fn(async () => {})
}
vi.mock('@/stores/useConnectionStore', () => ({
  useConnectionStore: { getState: () => connectionState }
}))

import { autoPinBaseWorktree } from './auto-pin'

const CONN_PROJECT = 'conn-project-1'
const GIT_PROJECT = 'git-project-1'

describe('autoPinBaseWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsState.autoPinBaseWorktreeOnBoardPrompt = true
    pinnedState.pinnedWorktreeIds = new Set()
    pinnedState.pinnedConnectionIds = new Set()
    worktreeState.defaultByProject = new Map([[GIT_PROJECT, { id: 'wt-default' }]])
    projectState.projects = [
      { id: GIT_PROJECT, kind: 'git' },
      { id: CONN_PROJECT, kind: 'connection' }
    ]
    connectionState.connections = [
      { id: 'inst-1', saved_project_id: CONN_PROJECT, is_base: 0 },
      { id: 'base-1', saved_project_id: CONN_PROJECT, is_base: 1 },
      { id: 'adhoc', saved_project_id: null, is_base: 0 }
    ]
  })

  it('git project: pins the default worktree (unchanged behavior)', async () => {
    await autoPinBaseWorktree(GIT_PROJECT)

    expect(pinnedState.pinWorktree).toHaveBeenCalledWith('wt-default')
    expect(pinnedState.pinConnection).not.toHaveBeenCalled()
  })

  it('connection project: pins the BASE instance, never another instance', async () => {
    await autoPinBaseWorktree(CONN_PROJECT)

    expect(pinnedState.pinConnection).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinConnection).toHaveBeenCalledWith('base-1')
    expect(pinnedState.pinWorktree).not.toHaveBeenCalled()
    // The worktree path is never consulted for connection projects
    expect(worktreeState.loadWorktrees).not.toHaveBeenCalled()
  })

  it('connection project: no-op when the base instance is already pinned', async () => {
    pinnedState.pinnedConnectionIds = new Set(['base-1'])

    await autoPinBaseWorktree(CONN_PROJECT)

    expect(pinnedState.pinConnection).not.toHaveBeenCalled()
  })

  it('connection project: reloads connections when the base is not in the store yet', async () => {
    connectionState.connections = []
    connectionState.loadConnections.mockImplementationOnce(async () => {
      connectionState.connections = [{ id: 'base-1', saved_project_id: CONN_PROJECT, is_base: 1 }]
    })

    await autoPinBaseWorktree(CONN_PROJECT)

    expect(connectionState.loadConnections).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinConnection).toHaveBeenCalledWith('base-1')
  })

  it('connection project: gives up quietly when no base instance exists', async () => {
    connectionState.connections = [{ id: 'inst-1', saved_project_id: CONN_PROJECT, is_base: 0 }]

    await autoPinBaseWorktree(CONN_PROJECT)

    expect(connectionState.loadConnections).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinConnection).not.toHaveBeenCalled()
    expect(pinnedState.pinWorktree).not.toHaveBeenCalled()
  })

  it('respects the setting for connection projects too', async () => {
    settingsState.autoPinBaseWorktreeOnBoardPrompt = false

    await autoPinBaseWorktree(CONN_PROJECT)
    await autoPinBaseWorktree(GIT_PROJECT)

    expect(pinnedState.pinConnection).not.toHaveBeenCalled()
    expect(pinnedState.pinWorktree).not.toHaveBeenCalled()
  })

  it('never throws (pin failure is swallowed)', async () => {
    pinnedState.pinConnection.mockRejectedValueOnce(new Error('boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(autoPinBaseWorktree(CONN_PROJECT)).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
