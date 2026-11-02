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
  branchDiffShortStat: vi.fn(),
  syncBranchWithOrigin: vi.fn()
}))

vi.mock('@/api/git-api', () => ({
  gitApi: gitApiMocks
}))

const toastMocks = vi.hoisted(() => ({
  warning: vi.fn(),
  loading: vi.fn(() => 'toast-1'),
  dismiss: vi.fn()
}))

vi.mock('@/lib/toast', () => ({ toast: toastMocks }))

const sessionStoreState = vi.hoisted(() => ({
  sessionsByConnection: new Map<string, { id: string }[]>()
}))

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: { getState: () => sessionStoreState }
}))

const worktreeStoreState = vi.hoisted(() => ({
  archivingWorktreeIds: new Set<string>()
}))

vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: { getState: () => worktreeStoreState }
}))

import {
  assessConnectionMembers,
  buildConnectionMergeQueue,
  resolveTicketConnectionId
} from './connection-merge'

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
  gitApiMocks.syncBranchWithOrigin.mockResolvedValue({ success: true, updated: false })
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
    expect(queue).toEqual([{ worktreeId: 'wt-clean', projectId: 'proj-1', alreadyMerged: true }])
  })

  it('queues members with work to merge first and already-merged ones last', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: {
        id: 'conn-1',
        members: [
          { worktree_id: 'wt-merged-1', project_id: 'proj-1' },
          { worktree_id: 'wt-dirty', project_id: 'proj-2' },
          { worktree_id: 'wt-merged-2', project_id: 'proj-3' },
          { worktree_id: 'wt-ahead', project_id: 'proj-4' }
        ]
      }
    })
    dbApiMocks.worktree.get.mockImplementation(async (id: string) =>
      worktree({ id, project_id: `proj-${id}`, path: `/repo/${id}` })
    )
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([mainWorktree])
    gitApiMocks.hasUncommittedChanges.mockImplementation(
      async (path: string) => path === '/repo/wt-dirty'
    )
    gitApiMocks.branchDiffShortStat.mockImplementation(async (path: string) => ({
      success: true,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      commitsAhead: path === '/repo/wt-ahead' ? 2 : 0
    }))

    const queue = await buildConnectionMergeQueue('conn-1', { includeAlreadyMerged: true })
    expect(queue).toEqual([
      { worktreeId: 'wt-dirty', projectId: 'proj-2' },
      { worktreeId: 'wt-ahead', projectId: 'proj-4' },
      { worktreeId: 'wt-merged-1', projectId: 'proj-1', alreadyMerged: true },
      { worktreeId: 'wt-merged-2', projectId: 'proj-3', alreadyMerged: true }
    ])
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

describe('assessConnectionMembers — pulling first', () => {
  const stat = {
    success: true,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    commitsAhead: 0
  }

  beforeEach(() => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: {
        id: 'conn-1',
        members: [
          { worktree_id: 'wt-web', project_id: 'proj-web', project_name: 'Web' },
          { worktree_id: 'wt-api', project_id: 'proj-api', project_name: 'Api' }
        ]
      }
    })
    dbApiMocks.worktree.get.mockImplementation(async (id: string) =>
      id === 'wt-web'
        ? worktree({ id, project_id: 'proj-web', path: '/web/feature' })
        : worktree({ id, project_id: 'proj-api', path: '/api/feature', base_branch: 'develop' })
    )
    dbApiMocks.worktree.getActiveByProject.mockImplementation(async (projectId: string) =>
      projectId === 'proj-web'
        ? [mainWorktree]
        : [worktree({ id: 'wt-develop', branch_name: 'develop', path: '/api/develop' })]
    )
    gitApiMocks.hasUncommittedChanges.mockResolvedValue(false)
    gitApiMocks.branchDiffShortStat.mockResolvedValue(stat)
  })

  it('pulls every member’s base branch before any check reads it', async () => {
    await assessConnectionMembers('conn-1')

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(2)
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledWith('/web/feature', 'main')
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledWith('/api/feature', 'develop')
    const lastPull = Math.max(...gitApiMocks.syncBranchWithOrigin.mock.invocationCallOrder)
    const firstCheck = Math.min(
      ...gitApiMocks.branchDiffShortStat.mock.invocationCallOrder,
      ...gitApiMocks.hasUncommittedChanges.mock.invocationCallOrder
    )
    expect(lastPull).toBeLessThan(firstCheck)
  })

  it('reads a branch as already merged once the pull brought its commits in', async () => {
    // What the ticket is about: the PR landed on origin, so local main only has it after a pull
    let pulled = false
    gitApiMocks.syncBranchWithOrigin.mockImplementation(async () => {
      pulled = true
      return { success: true, updated: true }
    })
    gitApiMocks.branchDiffShortStat.mockImplementation(async () => ({
      ...stat,
      commitsAhead: pulled ? 0 : 3
    }))

    expect(await buildConnectionMergeQueue('conn-1')).toEqual([])
  })

  it('goes on with the local branches when a pull fails, and says which', async () => {
    gitApiMocks.syncBranchWithOrigin.mockImplementation(async (path: string) => ({
      success: path !== '/api/feature',
      updated: false
    }))
    gitApiMocks.branchDiffShortStat.mockResolvedValue({ ...stat, commitsAhead: 1 })

    const queue = await buildConnectionMergeQueue('conn-1')

    expect(queue.map((target) => target.worktreeId)).toEqual(['wt-web', 'wt-api'])
    expect(toastMocks.warning).toHaveBeenCalledWith(
      'Could not pull latest develop (Api) from origin - checking against the local branch'
    )
  })

  it('leaves the members it will not check alone', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: {
        id: 'conn-1',
        members: [
          { worktree_id: 'wt-archived', project_id: 'proj-1' },
          { worktree_id: 'wt-on-base', project_id: 'proj-1' },
          { worktree_id: 'wt-no-base', project_id: 'proj-2' }
        ]
      }
    })
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      if (id === 'wt-archived') return worktree({ id, status: 'archived' })
      if (id === 'wt-on-base') return worktree({ id, branch_name: 'main' })
      return worktree({ id, base_branch: 'gone' })
    })
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([mainWorktree])

    const assessment = await assessConnectionMembers('conn-1')

    expect(assessment.skipped.map((s) => s.reason).sort()).toEqual([
      'inactive',
      'no-base-worktree',
      'on-base'
    ])
    expect(gitApiMocks.syncBranchWithOrigin).not.toHaveBeenCalled()
    expect(toastMocks.loading).not.toHaveBeenCalled()
  })

  it('leaves out a member whose archive started during the pull', async () => {
    gitApiMocks.syncBranchWithOrigin.mockImplementation(async () => {
      worktreeStoreState.archivingWorktreeIds = new Set(['wt-api'])
      return { success: true, updated: false }
    })
    gitApiMocks.branchDiffShortStat.mockResolvedValue({ ...stat, commitsAhead: 1 })

    const assessment = await assessConnectionMembers('conn-1')

    expect(assessment.targets).toEqual([{ worktreeId: 'wt-web', projectId: 'proj-web' }])
    expect(assessment.skipped).toEqual([
      { worktreeId: 'wt-api', projectId: 'proj-api', reason: 'inactive' }
    ])
    expect(gitApiMocks.branchDiffShortStat).not.toHaveBeenCalledWith('/api/feature', 'develop')
  })

  it('pulls nothing for a deleted connection', async () => {
    connectionApiMocks.get.mockResolvedValue({ success: false, error: 'Connection not found' })

    await assessConnectionMembers('conn-1')

    expect(gitApiMocks.syncBranchWithOrigin).not.toHaveBeenCalled()
  })
})

describe('assessConnectionMembers', () => {
  const members = [
    { worktree_id: 'wt-feature', project_id: 'proj-1' },
    { worktree_id: 'wt-no-base', project_id: 'proj-2' },
    { worktree_id: 'wt-archived', project_id: 'proj-1' },
    { worktree_id: 'wt-main', project_id: 'proj-1' }
  ]

  it('names every member it leaves out, and why', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: { id: 'conn-1', members }
    })
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      if (id === 'wt-feature') return worktree({ base_branch: 'main' })
      if (id === 'wt-no-base') return worktree({ id: 'wt-no-base', project_id: 'proj-2', path: '/p2/f', base_branch: 'main' })
      if (id === 'wt-archived') return worktree({ id: 'wt-archived', status: 'archived' })
      if (id === 'wt-main') return mainWorktree
      return null
    })
    dbApiMocks.worktree.getActiveByProject.mockImplementation(async (projectId: string) =>
      projectId === 'proj-1' ? [mainWorktree, worktree({ base_branch: 'main' })] : []
    )
    gitApiMocks.hasUncommittedChanges.mockResolvedValue(false)
    gitApiMocks.branchDiffShortStat.mockResolvedValue({ success: true, filesChanged: 0, insertions: 0, deletions: 0, commitsAhead: 0 })

    const assessment = await assessConnectionMembers('conn-1', { includeAlreadyMerged: true })

    expect(assessment.found).toBe(true)
    expect(assessment.targets).toEqual([{ worktreeId: 'wt-feature', projectId: 'proj-1', alreadyMerged: true }])
    expect([...assessment.skipped].sort((a, b) => a.worktreeId.localeCompare(b.worktreeId))).toEqual([
      { worktreeId: 'wt-archived', projectId: 'proj-1', reason: 'inactive' },
      { worktreeId: 'wt-main', projectId: 'proj-1', reason: 'on-base' },
      { worktreeId: 'wt-no-base', projectId: 'proj-2', reason: 'no-base-worktree' }
    ])
    // The queue is the targets alone
    expect(await buildConnectionMergeQueue('conn-1', { includeAlreadyMerged: true })).toEqual(assessment.targets)
  })

  it('marks a member mid-archive as inactive', async () => {
    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: { id: 'conn-1', members: [{ worktree_id: 'wt-feature', project_id: 'proj-1' }] }
    })
    worktreeStoreState.archivingWorktreeIds = new Set(['wt-feature'])

    const assessment = await assessConnectionMembers('conn-1')

    expect(assessment.skipped).toEqual([{ worktreeId: 'wt-feature', projectId: 'proj-1', reason: 'inactive' }])
    expect(dbApiMocks.worktree.get).not.toHaveBeenCalled()
  })

  it('reports a deleted or archived connection as not found', async () => {
    connectionApiMocks.get.mockResolvedValue({ success: false, error: 'Connection not found' })
    expect(await assessConnectionMembers('conn-1')).toEqual({ targets: [], skipped: [], found: false })

    connectionApiMocks.get.mockResolvedValue({
      success: true,
      connection: { id: 'conn-1', status: 'archived', members: [{ worktree_id: 'wt-feature', project_id: 'proj-1' }] }
    })
    expect(await assessConnectionMembers('conn-1')).toEqual({ targets: [], skipped: [], found: false })
  })
})
