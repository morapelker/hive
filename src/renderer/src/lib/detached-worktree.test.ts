import { beforeEach, describe, expect, it, vi } from 'vitest'

const gitApiMocks = vi.hoisted(() => ({
  getDiffStat: vi.fn(),
  getUnreachableCommits: vi.fn()
}))

vi.mock('@/api/git-api', () => ({ gitApi: gitApiMocks }))

import {
  getDetachedRemovalRisk,
  getWorktreeDisplayName,
  isDetachedWorktree
} from './detached-worktree'

const imported = { name: 'my-app-deploy', branch_name: '', is_default: false }
const onBranch = { name: 'golden-retriever', branch_name: 'feature-x', is_default: false }
const primary = { name: '(no-worktree)', branch_name: 'main', is_default: true }

describe('isDetachedWorktree', () => {
  it('follows the live branch info once it has loaded', () => {
    expect(isDetachedWorktree(imported, 'HEAD')).toBe(true)
    // Mid-rebase: the row still names its branch, git says detached.
    expect(isDetachedWorktree(onBranch, 'HEAD')).toBe(true)
    expect(isDetachedWorktree(onBranch, 'feature-x')).toBe(false)
    // Checked out a branch since the row was written.
    expect(isDetachedWorktree(imported, 'hotfix')).toBe(false)
  })

  it('falls back to the row while branch info is loading', () => {
    expect(isDetachedWorktree(imported, undefined)).toBe(true)
    expect(isDetachedWorktree(onBranch, undefined)).toBe(false)
  })

  it('never flags the project checkout', () => {
    expect(isDetachedWorktree(primary, 'HEAD')).toBe(false)
    expect(isDetachedWorktree({ ...primary, branch_name: '' }, undefined)).toBe(false)
  })
})

describe('getWorktreeDisplayName', () => {
  it('names a detached worktree by its directory instead of "HEAD"', () => {
    expect(getWorktreeDisplayName(imported, 'HEAD')).toBe('my-app-deploy')
    expect(getWorktreeDisplayName(imported, undefined)).toBe('my-app-deploy')
  })

  it('keeps the branch of a worktree that is only detached for now', () => {
    expect(getWorktreeDisplayName(onBranch, 'HEAD')).toBe('feature-x')
  })

  it('shows the live branch otherwise', () => {
    expect(getWorktreeDisplayName(onBranch, 'renamed-in-terminal')).toBe('renamed-in-terminal')
    expect(getWorktreeDisplayName(onBranch, undefined)).toBe('golden-retriever')
    expect(getWorktreeDisplayName(primary, 'HEAD')).toBe('HEAD')
  })
})

describe('getDetachedRemovalRisk', () => {
  const file = { path: 'src/App.tsx', additions: 3, deletions: 1, binary: false }
  const commit = { hash: 'abc1234', subject: 'stray commit' }

  beforeEach(() => {
    gitApiMocks.getDiffStat.mockReset().mockResolvedValue({ success: true, files: [] })
    gitApiMocks.getUnreachableCommits
      .mockReset()
      .mockResolvedValue({ success: true, count: 0, commits: [] })
  })

  it('finds nothing to lose in a clean worktree on reachable commits', async () => {
    await expect(getDetachedRemovalRisk('/wt')).resolves.toBeNull()
    expect(gitApiMocks.getDiffStat).toHaveBeenCalledWith('/wt')
    expect(gitApiMocks.getUnreachableCommits).toHaveBeenCalledWith('/wt')
  })

  it('reports uncommitted files', async () => {
    gitApiMocks.getDiffStat.mockResolvedValue({ success: true, files: [file] })

    await expect(getDetachedRemovalRisk('/wt')).resolves.toEqual({
      files: [file],
      commitCount: 0,
      commits: []
    })
  })

  it('reports commits that are on no branch, with the full count', async () => {
    gitApiMocks.getUnreachableCommits.mockResolvedValue({
      success: true,
      count: 42,
      commits: [commit]
    })

    await expect(getDetachedRemovalRisk('/wt')).resolves.toEqual({
      files: [],
      commitCount: 42,
      commits: [commit]
    })
  })

  it('still reports what one check found when the other fails', async () => {
    gitApiMocks.getDiffStat.mockRejectedValue(new Error('offline'))
    gitApiMocks.getUnreachableCommits.mockResolvedValue({
      success: true,
      count: 1,
      commits: [commit]
    })

    await expect(getDetachedRemovalRisk('/wt')).resolves.toMatchObject({ commitCount: 1 })
  })

  it('lets the removal through when the checkout cannot be inspected', async () => {
    // A directory already gone from disk: both checks fail, and the row must stay removable.
    gitApiMocks.getDiffStat.mockResolvedValue({ success: false, error: 'not a git repository' })
    gitApiMocks.getUnreachableCommits.mockRejectedValue(new Error('not a git repository'))

    await expect(getDetachedRemovalRisk('/gone')).resolves.toBeNull()
  })
})
