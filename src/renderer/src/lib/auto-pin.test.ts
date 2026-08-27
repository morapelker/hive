import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingsState: {
  autoPinOnBoardPrompt: 'off' | 'root-branch' | 'current-branch'
  hiveAuthToken: string | null
  hiveOrganizationId: string | null
  hiveOrganizationForceBoardMode: boolean
} = {
  autoPinOnBoardPrompt: 'root-branch',
  hiveAuthToken: null,
  hiveOrganizationId: null,
  hiveOrganizationForceBoardMode: false
}
vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: () => settingsState }
}))
const forceBoardMode = { value: false }
vi.mock('@/api/hive-enterprise/client', () => ({
  isForceBoardMode: () => forceBoardMode.value
}))

const pinnedState = {
  pinnedWorktreeIds: new Set<string>(),
  pinnedConnectionIds: new Set<string>(),
  isWorktreePinned: vi.fn((id: string) => pinnedState.pinnedWorktreeIds.has(id)),
  isConnectionPinned: vi.fn((id: string) => pinnedState.pinnedConnectionIds.has(id)),
  pinWorktree: vi.fn(async (_id: string) => {}),
  pinConnection: vi.fn(async (_id: string) => {})
}
vi.mock('@/stores/usePinnedStore', () => ({
  usePinnedStore: { getState: () => pinnedState }
}))

const worktreeState = {
  defaultByProject: new Map<string, { id: string } | null>(),
  worktreesByProject: new Map<string, { id: string }[]>(),
  getDefaultWorktree: vi.fn(
    (projectId: string) => worktreeState.defaultByProject.get(projectId) ?? null
  ),
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

import { autoPinForBoardPrompt, resolveAutoPinMode } from './auto-pin'

const CONN_PROJECT = 'conn-project-1'
const GIT_PROJECT = 'git-project-1'

beforeEach(() => {
  vi.clearAllMocks()
  settingsState.autoPinOnBoardPrompt = 'root-branch'
  forceBoardMode.value = false
  pinnedState.pinnedWorktreeIds = new Set()
  pinnedState.pinnedConnectionIds = new Set()
  worktreeState.defaultByProject = new Map([[GIT_PROJECT, { id: 'wt-default' }]])
  worktreeState.worktreesByProject = new Map([
    [GIT_PROJECT, [{ id: 'wt-default' }, { id: 'wt-feature' }]],
    ['other-project', [{ id: 'wt-elsewhere' }]]
  ])
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

describe('resolveAutoPinMode', () => {
  it('returns the local setting when no org policy applies', () => {
    settingsState.autoPinOnBoardPrompt = 'current-branch'
    expect(resolveAutoPinMode(settingsState)).toBe('current-branch')
    settingsState.autoPinOnBoardPrompt = 'off'
    expect(resolveAutoPinMode(settingsState)).toBe('off')
  })

  it('forces root-branch under org Force board mode regardless of the local setting', () => {
    forceBoardMode.value = true
    settingsState.autoPinOnBoardPrompt = 'off'
    expect(resolveAutoPinMode(settingsState)).toBe('root-branch')
    settingsState.autoPinOnBoardPrompt = 'current-branch'
    expect(resolveAutoPinMode(settingsState)).toBe('root-branch')
  })
})

describe('autoPinForBoardPrompt — off', () => {
  it('never pins when the setting is off, even with a worktree/connection target', async () => {
    settingsState.autoPinOnBoardPrompt = 'off'

    await autoPinForBoardPrompt({ projectId: GIT_PROJECT, worktreeId: 'wt-feature' })
    await autoPinForBoardPrompt({ projectId: CONN_PROJECT, connectionId: 'inst-1' })

    expect(pinnedState.pinWorktree).not.toHaveBeenCalled()
    expect(pinnedState.pinConnection).not.toHaveBeenCalled()
    expect(worktreeState.loadWorktrees).not.toHaveBeenCalled()
  })

  it('no-ops without a project id', async () => {
    await autoPinForBoardPrompt({ projectId: null, worktreeId: 'wt-feature' })
    await autoPinForBoardPrompt({ projectId: undefined })

    expect(pinnedState.pinWorktree).not.toHaveBeenCalled()
    expect(pinnedState.pinConnection).not.toHaveBeenCalled()
  })
})

describe('autoPinForBoardPrompt — root-branch (legacy "on")', () => {
  it('git project: pins the default worktree', async () => {
    await autoPinForBoardPrompt({ projectId: GIT_PROJECT })

    expect(pinnedState.pinWorktree).toHaveBeenCalledWith('wt-default')
    expect(pinnedState.pinConnection).not.toHaveBeenCalled()
  })

  it('git project: ignores the session worktree and still pins the default', async () => {
    await autoPinForBoardPrompt({ projectId: GIT_PROJECT, worktreeId: 'wt-feature' })

    expect(pinnedState.pinWorktree).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinWorktree).toHaveBeenCalledWith('wt-default')
  })

  it('git project: no-op when the default worktree is already pinned', async () => {
    pinnedState.pinnedWorktreeIds = new Set(['wt-default'])

    await autoPinForBoardPrompt({ projectId: GIT_PROJECT })

    expect(pinnedState.pinWorktree).not.toHaveBeenCalled()
  })

  it('git project: loads worktrees when the default is not in the store yet', async () => {
    worktreeState.defaultByProject = new Map()
    worktreeState.loadWorktrees.mockImplementationOnce(async () => {
      worktreeState.defaultByProject = new Map([[GIT_PROJECT, { id: 'wt-default' }]])
    })

    await autoPinForBoardPrompt({ projectId: GIT_PROJECT })

    expect(worktreeState.loadWorktrees).toHaveBeenCalledWith(GIT_PROJECT)
    expect(pinnedState.pinWorktree).toHaveBeenCalledWith('wt-default')
  })

  it('connection project: pins the BASE instance, never another instance', async () => {
    await autoPinForBoardPrompt({ projectId: CONN_PROJECT, connectionId: 'inst-1' })

    expect(pinnedState.pinConnection).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinConnection).toHaveBeenCalledWith('base-1')
    expect(pinnedState.pinWorktree).not.toHaveBeenCalled()
    // The worktree path is never consulted for connection projects
    expect(worktreeState.loadWorktrees).not.toHaveBeenCalled()
  })

  it('connection project: no-op when the base instance is already pinned', async () => {
    pinnedState.pinnedConnectionIds = new Set(['base-1'])

    await autoPinForBoardPrompt({ projectId: CONN_PROJECT })

    expect(pinnedState.pinConnection).not.toHaveBeenCalled()
  })

  it('connection project: reloads connections when the base is not in the store yet', async () => {
    connectionState.connections = []
    connectionState.loadConnections.mockImplementationOnce(async () => {
      connectionState.connections = [{ id: 'base-1', saved_project_id: CONN_PROJECT, is_base: 1 }]
    })

    await autoPinForBoardPrompt({ projectId: CONN_PROJECT })

    expect(connectionState.loadConnections).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinConnection).toHaveBeenCalledWith('base-1')
  })

  it('connection project: gives up quietly when no base instance exists', async () => {
    connectionState.connections = [{ id: 'inst-1', saved_project_id: CONN_PROJECT, is_base: 0 }]

    await autoPinForBoardPrompt({ projectId: CONN_PROJECT })

    expect(connectionState.loadConnections).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinConnection).not.toHaveBeenCalled()
    expect(pinnedState.pinWorktree).not.toHaveBeenCalled()
  })

  it('org Force board mode pins the root branch even when the local setting is off', async () => {
    forceBoardMode.value = true
    settingsState.autoPinOnBoardPrompt = 'off'

    await autoPinForBoardPrompt({ projectId: GIT_PROJECT, worktreeId: 'wt-feature' })

    expect(pinnedState.pinWorktree).toHaveBeenCalledWith('wt-default')
  })
})

describe('autoPinForBoardPrompt — current-branch', () => {
  beforeEach(() => {
    settingsState.autoPinOnBoardPrompt = 'current-branch'
  })

  it("git project: pins the session's worktree instead of the default", async () => {
    await autoPinForBoardPrompt({ projectId: GIT_PROJECT, worktreeId: 'wt-feature' })

    expect(pinnedState.pinWorktree).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinWorktree).toHaveBeenCalledWith('wt-feature')
    expect(worktreeState.loadWorktrees).not.toHaveBeenCalled()
  })

  it("git project: no-op when the session's worktree is already pinned", async () => {
    pinnedState.pinnedWorktreeIds = new Set(['wt-feature'])

    await autoPinForBoardPrompt({ projectId: GIT_PROJECT, worktreeId: 'wt-feature' })

    expect(pinnedState.pinWorktree).not.toHaveBeenCalled()
  })

  it('git project: each session pins its own worktree (multi-model launches)', async () => {
    worktreeState.worktreesByProject.set(GIT_PROJECT, [
      { id: 'wt-default' },
      { id: 'wt-model-a' },
      { id: 'wt-model-b' }
    ])

    await autoPinForBoardPrompt({ projectId: GIT_PROJECT, worktreeId: 'wt-model-a' })
    await autoPinForBoardPrompt({ projectId: GIT_PROJECT, worktreeId: 'wt-model-b' })

    expect(pinnedState.pinWorktree.mock.calls.map((c) => c[0])).toEqual([
      'wt-model-a',
      'wt-model-b'
    ])
  })

  it('git project: falls back to the default worktree when no worktree is known', async () => {
    await autoPinForBoardPrompt({ projectId: GIT_PROJECT })

    expect(pinnedState.pinWorktree).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinWorktree).toHaveBeenCalledWith('wt-default')
  })

  it('git project: a null worktree id (connection session) falls back to the default', async () => {
    await autoPinForBoardPrompt({ projectId: GIT_PROJECT, worktreeId: null })

    expect(pinnedState.pinWorktree).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinWorktree).toHaveBeenCalledWith('wt-default')
  })

  it('git project: reloads worktrees for a just-created worktree, then pins it', async () => {
    worktreeState.worktreesByProject.set(GIT_PROJECT, [{ id: 'wt-default' }])
    worktreeState.loadWorktrees.mockImplementationOnce(async () => {
      worktreeState.worktreesByProject.set(GIT_PROJECT, [{ id: 'wt-default' }, { id: 'wt-new' }])
    })

    await autoPinForBoardPrompt({ projectId: GIT_PROJECT, worktreeId: 'wt-new' })

    expect(worktreeState.loadWorktrees).toHaveBeenCalledWith(GIT_PROJECT)
    expect(pinnedState.pinWorktree).toHaveBeenCalledWith('wt-new')
  })

  it("git project: falls back to the default when the worktree isn't in this project", async () => {
    await autoPinForBoardPrompt({ projectId: GIT_PROJECT, worktreeId: 'wt-elsewhere' })

    expect(worktreeState.loadWorktrees).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinWorktree).toHaveBeenCalledWith('wt-default')
  })

  it("connection project: pins the session's instance instead of the base", async () => {
    await autoPinForBoardPrompt({ projectId: CONN_PROJECT, connectionId: 'inst-1' })

    expect(pinnedState.pinConnection).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinConnection).toHaveBeenCalledWith('inst-1')
    expect(connectionState.loadConnections).not.toHaveBeenCalled()
  })

  it('connection project: falls back to the base when no instance is known', async () => {
    await autoPinForBoardPrompt({ projectId: CONN_PROJECT })

    expect(pinnedState.pinConnection).toHaveBeenCalledWith('base-1')
  })

  it("connection project: falls back to the base for a connection that isn't an instance of the project", async () => {
    await autoPinForBoardPrompt({ projectId: CONN_PROJECT, connectionId: 'adhoc' })

    expect(connectionState.loadConnections).toHaveBeenCalledTimes(1)
    expect(pinnedState.pinConnection).toHaveBeenCalledWith('base-1')
  })

  it('git project: a connection-backed session (no worktree) falls back to the default worktree', async () => {
    await autoPinForBoardPrompt({ projectId: GIT_PROJECT, worktreeId: null, connectionId: 'adhoc' })

    expect(pinnedState.pinWorktree).toHaveBeenCalledWith('wt-default')
    expect(pinnedState.pinConnection).not.toHaveBeenCalled()
  })
})

describe('autoPinForBoardPrompt — resilience', () => {
  it('never throws (pin failure is swallowed)', async () => {
    pinnedState.pinConnection.mockRejectedValueOnce(new Error('boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(autoPinForBoardPrompt({ projectId: CONN_PROJECT })).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
