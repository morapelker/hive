import { describe, expect, it, vi } from 'vitest'
import { pushWorktree, type PushGitServiceLike } from './discord-push'

const createFakeGit = (overrides: Partial<PushGitServiceLike> = {}) => {
  const git: PushGitServiceLike = {
    getCurrentBranch: vi.fn(async () => 'feature/push-command'),
    hasUncommittedChanges: vi.fn(async () => false),
    stageAll: vi.fn(async () => ({ success: true })),
    commit: vi.fn(async () => ({ success: true, commitHash: 'abc1234' })),
    push: vi.fn(async () => ({ success: true })),
    ...overrides
  }
  return git
}

describe('pushWorktree', () => {
  it('pushes a clean branch without staging or committing', async () => {
    const git = createFakeGit()

    const result = await pushWorktree(
      {
        worktreePath: '/repo/worktree',
        commitMessage: 'ignored'
      },
      {
        gitFactory: () => git
      }
    )

    expect(result).toEqual({
      status: 'pushed',
      branch: 'feature/push-command',
      committed: false
    })
    expect(git.stageAll).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
    expect(git.push).toHaveBeenCalledWith()
  })

  it('stages and commits dirty changes before pushing', async () => {
    const git = createFakeGit({
      hasUncommittedChanges: vi.fn(async () => true)
    })

    const result = await pushWorktree(
      {
        worktreePath: '/repo/worktree',
        commitMessage: 'Implement command\n\n- Add tests'
      },
      {
        gitFactory: () => git
      }
    )

    expect(result).toEqual({
      status: 'pushed',
      branch: 'feature/push-command',
      committed: true
    })
    expect(git.stageAll).toHaveBeenCalledWith()
    expect(git.commit).toHaveBeenCalledWith('Implement command\n\n- Add tests')
    expect(git.push).toHaveBeenCalledWith()
  })

  it('returns an error for detached HEAD without pushing', async () => {
    const git = createFakeGit({
      getCurrentBranch: vi.fn(async () => 'HEAD')
    })

    const result = await pushWorktree(
      {
        worktreePath: '/repo/detached',
        commitMessage: 'Message'
      },
      {
        gitFactory: () => git
      }
    )

    expect(result).toEqual({
      status: 'error',
      message: 'Could not determine the current branch (detached HEAD?).'
    })
    expect(git.hasUncommittedChanges).not.toHaveBeenCalled()
    expect(git.push).not.toHaveBeenCalled()
  })

  it('returns a friendly push failure error', async () => {
    const git = createFakeGit({
      push: vi.fn(async () => ({ success: false, error: 'remote rejected' }))
    })

    const result = await pushWorktree(
      {
        worktreePath: '/repo/worktree',
        commitMessage: 'Message'
      },
      {
        gitFactory: () => git
      }
    )

    expect(result).toEqual({
      status: 'error',
      message: 'Failed to push branch: remote rejected'
    })
  })

  it.each([
    'fatal: not a git repository (or any of the parent directories): .git',
    'fatal: no such remote: origin'
  ])('maps repository remote errors to a friendly message: %s', async (error) => {
    const git = createFakeGit({
      push: vi.fn(async () => ({ success: false, error }))
    })

    const result = await pushWorktree(
      {
        worktreePath: '/repo/worktree',
        commitMessage: 'Message'
      },
      {
        gitFactory: () => git
      }
    )

    expect(result).toEqual({
      status: 'error',
      message:
        'Failed to push branch: This worktree is not connected to a GitHub repository with a usable remote.'
    })
  })
})
