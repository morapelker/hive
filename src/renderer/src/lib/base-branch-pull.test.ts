import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitApiMocks = vi.hoisted(() => ({
  syncBranchWithOrigin: vi.fn()
}))
const toastMocks = vi.hoisted(() => ({
  warning: vi.fn(),
  loading: vi.fn(() => 'pull-toast'),
  dismiss: vi.fn()
}))

const settingsState = vi.hoisted(() => ({ autoPullOnTicketMove: true }))

vi.mock('@/api/git-api', () => ({ gitApi: gitApiMocks }))
vi.mock('@/lib/toast', () => ({ toast: toastMocks }))
vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: () => settingsState }
}))

import {
  BASE_BRANCH_PULL_DEADLINE_MS,
  BASE_BRANCH_PULL_INTERVAL_MS,
  forgetBaseBranchPulls,
  pullBaseBranches
} from './base-branch-pull'

const web = { projectId: 'proj-web', worktreePath: '/web/feature', branch: 'main', projectName: 'Web' }
const api = { projectId: 'proj-api', worktreePath: '/api/feature', branch: 'develop', projectName: 'Api' }

beforeEach(() => {
  vi.clearAllMocks()
  settingsState.autoPullOnTicketMove = true
  forgetBaseBranchPulls()
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
  })
})

describe('pullBaseBranches — at most once a minute per project', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('does not pull again for a second ticket of the project within the minute, and shows nothing', async () => {
    await pullBaseBranches([web])
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()

    await vi.advanceTimersByTimeAsync(BASE_BRANCH_PULL_INTERVAL_MS - 1)
    await pullBaseBranches([{ ...web, worktreePath: '/web/other-ticket' }])

    expect(gitApiMocks.syncBranchWithOrigin).not.toHaveBeenCalled()
    expect(toastMocks.loading).not.toHaveBeenCalled()
    expect(toastMocks.dismiss).not.toHaveBeenCalled()
  })

  it('pulls again once the minute is up', async () => {
    await pullBaseBranches([web])
    await vi.advanceTimersByTimeAsync(BASE_BRANCH_PULL_INTERVAL_MS)

    await pullBaseBranches([web])

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(2)
  })

  it('counts from the attempt, so a failed pull is not retried on every move either', async () => {
    gitApiMocks.syncBranchWithOrigin.mockResolvedValue({ success: false, updated: false })
    await pullBaseBranches([web])
    expect(toastMocks.warning).toHaveBeenCalledTimes(1)

    await pullBaseBranches([web])

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(1)
    expect(toastMocks.warning).toHaveBeenCalledTimes(1)
  })

  it('still pulls another project, and another base branch of the same project', async () => {
    await pullBaseBranches([web])
    vi.clearAllMocks()

    await pullBaseBranches([api, { ...web, branch: 'develop' }])

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(2)
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledWith('/api/feature', 'develop')
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledWith('/web/feature', 'develop')
  })

  it('pulls only the members of a connection that are due, and names that many', async () => {
    await pullBaseBranches([web])
    vi.clearAllMocks()

    await pullBaseBranches([web, api])

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(1)
    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledWith('/api/feature', 'develop')
    expect(toastMocks.loading).toHaveBeenCalledWith('Pulling latest develop…')
  })

  it('a batch of many tickets (an orchestrator’s run) pulls the project once', async () => {
    for (const path of ['/web/t1', '/web/t2', '/web/t3']) {
      await pullBaseBranches([{ ...web, worktreePath: path }])
    }

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(1)
    expect(toastMocks.loading).toHaveBeenCalledTimes(1)
  })

  it('joins a pull under way rather than skipping it: the check waits for what it brings', async () => {
    let release: () => void = () => {}
    gitApiMocks.syncBranchWithOrigin.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ success: true, updated: true })
      })
    )
    const first = pullBaseBranches([web])
    let secondDone = false
    const second = pullBaseBranches([web]).then(() => {
      secondDone = true
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(1)
    expect(secondDone).toBe(false)
    release()
    await Promise.all([first, second])
    expect(secondDone).toBe(true)
  })

  it('forgets its pulls on request', async () => {
    await pullBaseBranches([web])
    forgetBaseBranchPulls()

    await pullBaseBranches([web])

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(2)
  })
})

describe('pullBaseBranches — with the setting off', () => {
  beforeEach(() => {
    settingsState.autoPullOnTicketMove = false
  })

  it('pulls nothing and shows nothing', async () => {
    await expect(pullBaseBranches([web, api])).resolves.toBeUndefined()

    expect(gitApiMocks.syncBranchWithOrigin).not.toHaveBeenCalled()
    expect(toastMocks.loading).not.toHaveBeenCalled()
    expect(toastMocks.warning).not.toHaveBeenCalled()
  })

  it('pulls as soon as it is turned back on', async () => {
    await pullBaseBranches([web])
    settingsState.autoPullOnTicketMove = true

    await pullBaseBranches([web])

    expect(gitApiMocks.syncBranchWithOrigin).toHaveBeenCalledTimes(1)
  })
})
