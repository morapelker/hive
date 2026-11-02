import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitApiMocks = vi.hoisted(() => ({
  syncBranchWithOrigin: vi.fn()
}))
const toastMocks = vi.hoisted(() => ({
  warning: vi.fn(),
  loading: vi.fn(() => 'pull-toast'),
  dismiss: vi.fn()
}))

vi.mock('@/api/git-api', () => ({ gitApi: gitApiMocks }))
vi.mock('@/lib/toast', () => ({ toast: toastMocks }))

import { BASE_BRANCH_PULL_DEADLINE_MS, pullBaseBranches } from './base-branch-pull'

const web = { projectId: 'proj-web', worktreePath: '/web/feature', branch: 'main', projectName: 'Web' }
const api = { projectId: 'proj-api', worktreePath: '/api/feature', branch: 'develop', projectName: 'Api' }

beforeEach(() => {
  vi.clearAllMocks()
  gitApiMocks.syncBranchWithOrigin.mockResolvedValue({ success: true, updated: false })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pullBaseBranches', () => {
  it('pulls nothing and shows nothing without a target', async () => {
    await pullBaseBranches([])

    expect(gitApiMocks.syncBranchWithOrigin).not.toHaveBeenCalled()
    expect(toastMocks.loading).not.toHaveBeenCalled()
  })

  it('names the branch while pulling one and dismisses the toast afterwards', async () => {
    await pullBaseBranches([web])

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledWith('/web/feature', 'main')
    expect(toastMocks.loading).toHaveBeenCalledWith('Pulling latest main…')
    expect(toastMocks.dismiss).toHaveBeenCalledWith('pull-toast')
    expect(toastMocks.warning).not.toHaveBeenCalled()
  })

  it('pulls every project of a connection at once, under one toast', async () => {
    const releases: (() => void)[] = []
    gitApiMocks.syncBranchWithOrigin.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ success: true, updated: true }))
        })
    )

    const done = pullBaseBranches([web, api])

    // Neither waits for the other
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(2)
    expect(toastMocks.loading).toHaveBeenCalledTimes(1)
    expect(toastMocks.loading).toHaveBeenCalledWith('Pulling latest in 2 projects…')
    releases.forEach((release) => release())
    await done
    expect(toastMocks.dismiss).toHaveBeenCalledTimes(1)
  })

  it('pulls a branch once when two members share the project', async () => {
    await pullBaseBranches([web, { ...web, worktreePath: '/web/other' }])

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(1)
    expect(toastMocks.loading).toHaveBeenCalledWith('Pulling latest main…')
  })

  it('pulls each base when a project has members on different ones', async () => {
    await pullBaseBranches([web, { ...web, branch: 'develop' }])

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledWith('/web/feature', 'main')
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledWith('/web/feature', 'develop')
  })

  it('warns about the branches it could not pull and resolves: the move goes on', async () => {
    gitApiMocks.syncBranchWithOrigin.mockImplementation(async (_path: string, branch: string) => ({
      success: branch !== 'develop',
      updated: false
    }))

    await expect(pullBaseBranches([web, api])).resolves.toBeUndefined()

    expect(toastMocks.warning).toHaveBeenCalledTimes(1)
    expect(toastMocks.warning).toHaveBeenCalledWith(
      'Could not pull latest develop (Api) from origin - checking against the local branch'
    )
    expect(toastMocks.dismiss).toHaveBeenCalledWith('pull-toast')
  })

  it('treats a failing RPC like a failed pull', async () => {
    gitApiMocks.syncBranchWithOrigin.mockRejectedValue(new Error('offline'))

    await expect(
      pullBaseBranches([{ projectId: 'p', worktreePath: '/p', branch: 'main' }])
    ).resolves.toBeUndefined()

    expect(toastMocks.warning).toHaveBeenCalledWith(
      'Could not pull latest main from origin - checking against the local branch'
    )
  })

  it('stops waiting for an origin that never answers', async () => {
    vi.useFakeTimers()
    gitApiMocks.syncBranchWithOrigin.mockReturnValue(new Promise(() => {}))
    const stalled = { ...web, projectId: 'proj-stalled' }

    const done = pullBaseBranches([stalled])
    await vi.advanceTimersByTimeAsync(BASE_BRANCH_PULL_DEADLINE_MS - 1)
    expect(toastMocks.dismiss).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await done

    expect(toastMocks.warning).toHaveBeenCalledWith(
      'Could not pull latest main (Web) from origin - checking against the local branch'
    )
    expect(toastMocks.dismiss).toHaveBeenCalledWith('pull-toast')
  })

  it('joins a sync still running past its deadline instead of starting another git', async () => {
    vi.useFakeTimers()
    let release: () => void = () => {}
    gitApiMocks.syncBranchWithOrigin.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ success: true, updated: true })
      })
    )
    const slow = { ...web, projectId: 'proj-slow' }

    const first = pullBaseBranches([slow])
    await vi.advanceTimersByTimeAsync(BASE_BRANCH_PULL_DEADLINE_MS)
    await first

    // git is still at it: the next drop waits on that one, with a deadline of its own
    const second = pullBaseBranches([slow])
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(1)
    toastMocks.warning.mockClear()
    release()
    await second
    expect(toastMocks.warning).not.toHaveBeenCalled()
  })

  it('joins a pull already under way instead of racing it for git’s locks', async () => {
    let release: () => void = () => {}
    gitApiMocks.syncBranchWithOrigin.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ success: true, updated: true })
      })
    )

    const first = pullBaseBranches([web])
    const second = pullBaseBranches([web])
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(1)

    release()
    await Promise.all([first, second])

    // Finished pulls are not remembered: the next move pulls again
    gitApiMocks.syncBranchWithOrigin.mockResolvedValue({ success: true, updated: false })
    await pullBaseBranches([web])
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(2)
  })
})
