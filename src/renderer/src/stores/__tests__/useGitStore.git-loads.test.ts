import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useGitStore } from '../useGitStore'

const branchInfo = { name: 'main', tracking: null, ahead: 0, behind: 0 }

describe('useGitStore git metadata loading', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    useGitStore.setState({
      fileStatusesByWorktree: new Map(),
      branchInfoByWorktree: new Map(),
      conflictsByWorktree: {},
      isLoading: false,
      error: null
    })

    Object.defineProperty(window, 'gitOps', {
      writable: true,
      configurable: true,
      value: {
        ...window.gitOps,
        getBranchInfo: vi.fn().mockResolvedValue({
          success: true,
          value: { success: true, branch: branchInfo }
        }),
        getFileStatuses: vi.fn().mockResolvedValue({
          success: true,
          value: { success: true, files: [] }
        })
      }
    })
  })

  it('coalesces concurrent branch info loads for the same worktree', async () => {
    const worktreePath = '/repo/concurrent'
    let resolveBranchInfo: (value: {
      success: true
      value: { success: true; branch: typeof branchInfo }
    }) => void
    const branchInfoPromise = new Promise<{
      success: true
      value: { success: true; branch: typeof branchInfo }
    }>((resolve) => {
      resolveBranchInfo = resolve
    })

    vi.mocked(window.gitOps.getBranchInfo).mockReturnValue(branchInfoPromise)

    const firstLoad = useGitStore.getState().loadBranchInfo(worktreePath)
    const secondLoad = useGitStore.getState().loadBranchInfo(worktreePath)

    expect(window.gitOps.getBranchInfo).toHaveBeenCalledTimes(1)

    resolveBranchInfo!({ success: true, value: { success: true, branch: branchInfo } })
    await Promise.all([firstLoad, secondLoad])

    expect(useGitStore.getState().getBranchInfo(worktreePath)).toEqual(branchInfo)
  })

  it('skips a branch info refetch inside the load TTL', async () => {
    vi.useFakeTimers()
    const worktreePath = '/repo/ttl'
    vi.setSystemTime(1_000)

    await useGitStore.getState().loadBranchInfo(worktreePath)
    await useGitStore.getState().loadBranchInfo(worktreePath)

    expect(window.gitOps.getBranchInfo).toHaveBeenCalledTimes(1)
  })

  it('allows force branch info loads to bypass the load TTL', async () => {
    vi.useFakeTimers()
    const worktreePath = '/repo/force'
    vi.setSystemTime(1_000)

    await useGitStore.getState().loadBranchInfo(worktreePath)
    await useGitStore.getState().loadBranchInfo(worktreePath, { force: true })

    expect(window.gitOps.getBranchInfo).toHaveBeenCalledTimes(2)
  })
})
