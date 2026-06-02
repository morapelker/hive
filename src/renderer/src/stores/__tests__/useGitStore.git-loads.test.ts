import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '../../api/rpc-client'

const branchInfo = { name: 'main', tracking: null, ahead: 0, behind: 0 }
const stagedFile = {
  path: '/repo/stage/src/App.tsx',
  relativePath: 'src/App.tsx',
  status: 'M' as const,
  staged: true
}

let request: ReturnType<typeof vi.fn>
let useGitStore: typeof import('../useGitStore').useGitStore

describe('useGitStore git metadata loading', () => {
  beforeEach(async () => {
    vi.useRealTimers()
    vi.clearAllMocks()
    request = vi.fn().mockResolvedValue([])
    setRendererRpcClient({ request, subscribe: vi.fn() })

    ;({ useGitStore } = await import('../useGitStore'))
    useGitStore.setState({
      fileStatusesByWorktree: new Map(),
      branchInfoByWorktree: new Map(),
      conflictsByWorktree: {},
      remoteInfo: new Map(),
      prTargetBranch: new Map(),
      reviewTargetBranch: new Map(),
      attachedPR: new Map(),
      creatingPRByWorktreeId: new Map(),
      defaultMergeBranch: new Map(),
      selectedMergeBranch: new Map(),
      selectedDiffBranch: new Map(),
      createPRModalOpen: false,
      createPRWorktreeId: null,
      createPRWorktreePath: null,
      isLoading: false,
      error: null,
      isCommitting: false,
      isPushing: false,
      isPulling: false
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('coalesces concurrent branch info loads for the same worktree', async () => {
    const worktreePath = '/repo/concurrent'
    let resolveBranchInfo: (value: { success: true; branch: typeof branchInfo }) => void
    const branchInfoPromise = new Promise<{ success: true; branch: typeof branchInfo }>(
      (resolve) => {
        resolveBranchInfo = resolve
      }
    )
    request.mockImplementation((method) => {
      if (method === 'gitOps.getBranchInfo') return branchInfoPromise
      return Promise.resolve([])
    })

    const firstLoad = useGitStore.getState().loadBranchInfo(worktreePath)
    const secondLoad = useGitStore.getState().loadBranchInfo(worktreePath)

    expect(request.mock.calls.filter(([method]) => method === 'gitOps.getBranchInfo')).toHaveLength(
      1
    )

    resolveBranchInfo!({ success: true, branch: branchInfo })
    await Promise.all([firstLoad, secondLoad])

    expect(useGitStore.getState().getBranchInfo(worktreePath)).toEqual(branchInfo)
  })

  it('skips a branch info refetch inside the load TTL', async () => {
    vi.useFakeTimers()
    const worktreePath = '/repo/ttl'
    vi.setSystemTime(1_000)
    request.mockImplementation((method) => {
      if (method === 'gitOps.getBranchInfo')
        return Promise.resolve({ success: true, branch: branchInfo })
      return Promise.resolve([])
    })

    await useGitStore.getState().loadBranchInfo(worktreePath)
    await useGitStore.getState().loadBranchInfo(worktreePath)

    expect(request.mock.calls.filter(([method]) => method === 'gitOps.getBranchInfo')).toHaveLength(
      1
    )
  })

  it('allows force branch info loads to bypass the load TTL', async () => {
    vi.useFakeTimers()
    const worktreePath = '/repo/force'
    vi.setSystemTime(1_000)
    request.mockImplementation((method) => {
      if (method === 'gitOps.getBranchInfo')
        return Promise.resolve({ success: true, branch: branchInfo })
      return Promise.resolve([])
    })

    await useGitStore.getState().loadBranchInfo(worktreePath)
    await useGitStore.getState().loadBranchInfo(worktreePath, { force: true })

    expect(request.mock.calls.filter(([method]) => method === 'gitOps.getBranchInfo')).toHaveLength(
      2
    )
  })

  it('runs a fresh file status request when a forced load arrives during an in-flight load', async () => {
    const worktreePath = '/repo/inflight-force'
    const freshFile = {
      path: `${worktreePath}/src/new.ts`,
      relativePath: 'src/new.ts',
      status: '?' as const,
      staged: false
    }
    let resolveFirstLoad: (value: { success: true; files: [] }) => void
    const firstLoadResult = new Promise<{ success: true; files: [] }>((resolve) => {
      resolveFirstLoad = resolve
    })

    request.mockImplementation((method) => {
      if (method === 'gitOps.getFileStatuses') {
        const calls = request.mock.calls.filter(([calledMethod]) => calledMethod === method).length
        if (calls === 1) return firstLoadResult
        return Promise.resolve({ success: true, files: [freshFile] })
      }
      return Promise.resolve([])
    })

    const firstLoad = useGitStore.getState().loadFileStatuses(worktreePath)
    const forcedLoad = useGitStore.getState().loadFileStatuses(worktreePath, { force: true })

    expect(
      request.mock.calls.filter(([method]) => method === 'gitOps.getFileStatuses')
    ).toHaveLength(1)

    resolveFirstLoad!({ success: true, files: [] })
    await Promise.all([firstLoad, forcedLoad])

    expect(
      request.mock.calls.filter(([method]) => method === 'gitOps.getFileStatuses')
    ).toHaveLength(2)
    expect(useGitStore.getState().getFileStatuses(worktreePath)).toEqual([freshFile])
  })

  it('refreshes file statuses after staging a file succeeds', async () => {
    const worktreePath = '/repo/stage'

    request.mockImplementation((method) => {
      if (method === 'gitOps.stageFile') return Promise.resolve({ success: true })
      if (method === 'gitOps.getFileStatuses') {
        return Promise.resolve({ success: true, files: [stagedFile] })
      }
      return Promise.resolve([])
    })

    await expect(useGitStore.getState().stageFile(worktreePath, 'src/App.tsx')).resolves.toBe(true)

    expect(request).toHaveBeenCalledWith('gitOps.stageFile', {
      worktreePath,
      filePath: 'src/App.tsx'
    })
    expect(request).toHaveBeenCalledWith('gitOps.getFileStatuses', { worktreePath })
    expect(useGitStore.getState().getFileStatuses(worktreePath)).toEqual([stagedFile])
  })

  it('attaches a PR optimistically and persists through dbApi', async () => {
    request.mockImplementation((method) => {
      if (method === 'db.worktree.attachPR') return Promise.resolve({ success: true })
      return Promise.resolve([])
    })

    await useGitStore.getState().attachPR('worktree-1', 42, 'https://github.com/acme/hive/pull/42')

    expect(request).toHaveBeenCalledWith('db.worktree.attachPR', {
      worktreeId: 'worktree-1',
      prNumber: 42,
      prUrl: 'https://github.com/acme/hive/pull/42'
    })
    expect(useGitStore.getState().attachedPR.get('worktree-1')).toEqual({
      number: 42,
      url: 'https://github.com/acme/hive/pull/42'
    })
    expect(request).toHaveBeenCalledWith('kanban.ticket.syncPR', {
      worktreeId: 'worktree-1',
      prNumber: 42,
      prUrl: 'https://github.com/acme/hive/pull/42'
    })
  })

  it('detaches a PR optimistically and persists through dbApi', async () => {
    useGitStore.setState({
      attachedPR: new Map([
        ['worktree-1', { number: 42, url: 'https://github.com/acme/hive/pull/42' }]
      ])
    })
    request.mockImplementation((method) => {
      if (method === 'db.worktree.detachPR') return Promise.resolve({ success: true })
      return Promise.resolve([])
    })

    await useGitStore.getState().detachPR('worktree-1')

    expect(request).toHaveBeenCalledWith('db.worktree.detachPR', {
      worktreeId: 'worktree-1'
    })
    expect(useGitStore.getState().attachedPR.has('worktree-1')).toBe(false)
    expect(request).toHaveBeenCalledWith('kanban.ticket.clearPR', {
      worktreeId: 'worktree-1'
    })
  })
})
