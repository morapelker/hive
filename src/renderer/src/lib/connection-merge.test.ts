import { beforeEach, describe, expect, it, vi } from 'vitest'

const connectionApiMocks = vi.hoisted(() => ({
  get: vi.fn()
}))

vi.mock('@/api/connection-api', () => ({
  connectionApi: connectionApiMocks
}))

const dbApiMocks = vi.hoisted(() => ({
  session: {
    get: vi.fn()
  },
  worktree: {
    get: vi.fn(),
    getActiveByProject: vi.fn()
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: dbApiMocks
}))

const gitApiMocks = vi.hoisted(() => ({
  hasUncommittedChanges: vi.fn(),
  branchDiffShortStat: vi.fn()
}))

vi.mock('@/api/git-api', () => ({
  gitApi: gitApiMocks
}))

const sessionStoreState = vi.hoisted(() => ({
  sessionsByConnection: new Map<string, { id: string }[]>()
}))

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: { getState: () => sessionStoreState }
}))

import { buildConnectionMergeQueue, resolveTicketConnectionId } from './connection-merge'

function worktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wt-feature',
    project_id: 'proj-1',
    branch_name: 'feature',
    path: '/repo/feature',
    status: 'active',
    is_default: false,
    base_branch: null,
    ...overrides
  }
}

const mainWorktree = worktree({
  id: 'wt-main',
  branch_name: 'main',
  path: '/repo/main',
  is_default: true
})

beforeEach(() => {
  vi.clearAllMocks()
  sessionStoreState.sessionsByConnection = new Map()
})

describe('resolveTicketConnectionId', () => {
  it('returns null without a session id', async () => {
    expect(await resolveTicketConnectionId(null)).toBeNull()
    expect(dbApiMocks.session.get).not.toHaveBeenCalled()
  })

  it('finds the connection in the session store without hitting the DB', async () => {
    sessionStoreState.sessionsByConnection = new Map([['conn-1', [{ id: 'sess-1' }]]])
    expect(await resolveTicketConnectionId('sess-1')).toBe('conn-1')
    expect(dbApiMocks.session.get).not.toHaveBeenCalled()
  })

  it('falls back to the DB when the store map is cold', async () => {
    dbApiMocks.session.get.mockResolvedValue({ id: 'sess-1', connection_id: 'conn-2' })
    expect(await resolveTicketConnectionId('sess-1')).toBe('conn-2')
  })

  it('returns null for non-connection sessions', async () => {
    dbApiMocks.session.get.mockResolvedValue({ id: 'sess-1', connection_id: null })
    expect(await resolveTicketConnectionId('sess-1')).toBeNull()
  })
})

describe('buildConnectionMergeQueue', () => {
  it('returns only member worktrees with work to merge', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: {
        id: 'conn-1',
        members: [
          { worktree_id: 'wt-dirty', project_id: 'proj-1' },
          { worktree_id: 'wt-clean', project_id: 'proj-2' },
          { worktree_id: 'wt-on-base', project_id: 'proj-3' }
        ]
      }
    })
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      if (id === 'wt-dirty') return worktree({ id: 'wt-dirty', project_id: 'proj-1' })
      if (id === 'wt-clean')
        return worktree({ id: 'wt-clean', project_id: 'proj-2', path: '/repo/clean' })
      if (id === 'wt-on-base')
        return worktree({ id: 'wt-on-base', project_id: 'proj-3', branch_name: 'main' })
      return null
    })
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([mainWorktree])
    gitApiMocks.hasUncommittedChanges.mockImplementation(
      async (path: string) => path === '/repo/feature'
    )
    gitApiMocks.branchDiffShortStat.mockResolvedValue({
      success: true,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      commitsAhead: 0
    })

    const queue = await buildConnectionMergeQueue('conn-1')
    expect(queue).toEqual([{ worktreeId: 'wt-dirty', projectId: 'proj-1' }])
  })

  it('includes clean-but-ahead worktrees and skips archived ones', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: {
        id: 'conn-1',
        members: [
          { worktree_id: 'wt-ahead', project_id: 'proj-1' },
          { worktree_id: 'wt-archived', project_id: 'proj-2' }
        ]
      }
    })
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      if (id === 'wt-ahead') return worktree({ id: 'wt-ahead' })
      if (id === 'wt-archived') return worktree({ id: 'wt-archived', status: 'archived' })
      return null
    })
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([mainWorktree])
    gitApiMocks.hasUncommittedChanges.mockResolvedValue(false)
    gitApiMocks.branchDiffShortStat.mockResolvedValue({
      success: true,
      filesChanged: 2,
      insertions: 10,
      deletions: 1,
      commitsAhead: 3
    })

    const queue = await buildConnectionMergeQueue('conn-1')
    expect(queue).toEqual([{ worktreeId: 'wt-ahead', projectId: 'proj-1' }])
  })

  it('includeAlreadyMerged queues clean members too, but still skips on-base ones', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: {
        id: 'conn-1',
        members: [
          { worktree_id: 'wt-clean', project_id: 'proj-1' },
          { worktree_id: 'wt-on-base', project_id: 'proj-2' }
        ]
      }
    })
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      if (id === 'wt-clean') return worktree({ id: 'wt-clean' })
      if (id === 'wt-on-base') return worktree({ id: 'wt-on-base', branch_name: 'main' })
      return null
    })
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([mainWorktree])
    gitApiMocks.hasUncommittedChanges.mockResolvedValue(false)
    gitApiMocks.branchDiffShortStat.mockResolvedValue({
      success: true,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      commitsAhead: 0
    })

    const queue = await buildConnectionMergeQueue('conn-1', { includeAlreadyMerged: true })
    expect(queue).toEqual([{ worktreeId: 'wt-clean', projectId: 'proj-1' }])
  })

  it('skips members whose base worktree is missing', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: {
        id: 'conn-1',
        members: [{ worktree_id: 'wt-no-base', project_id: 'proj-1' }]
      }
    })
    dbApiMocks.worktree.get.mockResolvedValue(worktree({ id: 'wt-no-base' }))
    // No default/base worktree in the project
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([])

    expect(await buildConnectionMergeQueue('conn-1')).toEqual([])
  })

  it('rejects when a member assessment throws, so the drop can abort', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: {
        id: 'conn-1',
        members: [{ worktree_id: 'wt-error', project_id: 'proj-1' }]
      }
    })
    dbApiMocks.worktree.get.mockRejectedValue(new Error('db down'))

    await expect(buildConnectionMergeQueue('conn-1')).rejects.toThrow('db down')
  })

  it('rejects when branch stats cannot be verified', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: {
        id: 'conn-1',
        members: [{ worktree_id: 'wt-feature', project_id: 'proj-1' }]
      }
    })
    dbApiMocks.worktree.get.mockResolvedValue(worktree())
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([mainWorktree])
    gitApiMocks.hasUncommittedChanges.mockResolvedValue(false)
    gitApiMocks.branchDiffShortStat.mockResolvedValue({ success: false, error: 'git exploded' })

    await expect(buildConnectionMergeQueue('conn-1')).rejects.toThrow('git exploded')
  })

  it('rejects when the connection lookup fails, so the drop can abort', async () => {
    connectionApiMocks.get.mockResolvedValue({ success: false, error: 'nope' })
    await expect(buildConnectionMergeQueue('conn-1')).rejects.toThrow('nope')
  })

  it('returns an empty queue for a deleted connection so the move proceeds', async () => {
    connectionApiMocks.get.mockResolvedValue({ success: false, error: 'Connection not found' })
    expect(await buildConnectionMergeQueue('conn-1')).toEqual([])
  })

  it('returns an empty queue for an archived connection so the move proceeds', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: {
        id: 'conn-1',
        status: 'archived',
        members: [{ worktree_id: 'wt-feature', project_id: 'proj-1' }]
      }
    })
    expect(await buildConnectionMergeQueue('conn-1')).toEqual([])
    expect(dbApiMocks.worktree.get).not.toHaveBeenCalled()
  })
})
