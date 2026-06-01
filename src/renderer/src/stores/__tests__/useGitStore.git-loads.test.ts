import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '../../api/rpc-client'

const branchInfo = { name: 'main', tracking: null, ahead: 0, behind: 0 }

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
