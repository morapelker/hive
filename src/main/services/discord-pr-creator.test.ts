import { describe, expect, it, vi } from 'vitest'
import { createPrFromWorktree, type GitServiceLike } from './discord-pr-creator'

const createFakeGit = (overrides: Partial<GitServiceLike> = {}) => {
  const git: GitServiceLike = {
    getDefaultBranch: vi.fn(async () => 'main'),
    getCurrentBranch: vi.fn(async () => 'feature/pr-command'),
    hasUncommittedChanges: vi.fn(async () => false),
    stageAll: vi.fn(async () => ({ success: true })),
    commit: vi.fn(async () => ({ success: true, commitHash: 'abc1234' })),
    getRangeDiff: vi.fn(async () => ({
      commitSummary: 'abc1234 Add PR command',
      diffSummary: ' src/main/services/file.ts | 2 ++',
      diffPatch: 'diff --git a/file.ts b/file.ts',
      commitCount: 1
    })),
    push: vi.fn(async () => ({ success: true })),
    createPullRequest: vi.fn(async () => ({
      success: true,
      url: 'https://github.com/acme/repo/pull/42',
      number: 42
    })),
    ...overrides
  }
  return git
}

describe('createPrFromWorktree', () => {
  it('creates a pull request from a clean branch without committing', async () => {
    const git = createFakeGit()
    const generatePRContent = vi.fn(async () => ({
      title: 'Add Discord PR command',
      body: '## Summary\n- Add /pr\n\n## Testing\n- Unit tests'
    }))

    const result = await createPrFromWorktree(
      {
        worktreePath: '/repo/worktree',
        baseBranch: 'main',
        commitMessage: 'ignored'
      },
      {
        gitFactory: () => git,
        generatePRContent
      }
    )

    expect(result).toEqual({
      status: 'created',
      url: 'https://github.com/acme/repo/pull/42',
      number: 42
    })
    expect(git.stageAll).not.toHaveBeenCalled()
    expect(git.commit).not.toHaveBeenCalled()
    expect(git.push).toHaveBeenCalledWith()
    expect(git.createPullRequest).toHaveBeenCalledWith({
      baseBranch: 'main',
      title: 'Add Discord PR command',
      body: '## Summary\n- Add /pr\n\n## Testing\n- Unit tests'
    })
  })

  it('stages and commits dirty changes with the supplied message', async () => {
    const git = createFakeGit({
      hasUncommittedChanges: vi.fn(async () => true)
    })

    await createPrFromWorktree(
      {
        worktreePath: '/repo/worktree',
        baseBranch: 'develop',
        commitMessage: 'Implement command\n\n- Add tests'
      },
      {
        gitFactory: () => git,
        generatePRContent: vi.fn(async () => ({ title: 'Title', body: 'Body' }))
      }
    )

    expect(git.stageAll).toHaveBeenCalledWith()
    expect(git.commit).toHaveBeenCalledWith('Implement command\n\n- Add tests')
    expect(git.getRangeDiff).toHaveBeenCalledWith('develop')
  })

  it('returns nothing when the clean branch has no commits ahead', async () => {
    const git = createFakeGit({
      getRangeDiff: vi.fn(async () => ({
        commitSummary: '',
        diffSummary: '',
        diffPatch: '',
        commitCount: 0
      }))
    })

    const result = await createPrFromWorktree(
      {
        worktreePath: '/repo/worktree',
        baseBranch: 'main',
        commitMessage: 'No-op'
      },
      {
        gitFactory: () => git,
        generatePRContent: vi.fn()
      }
    )

    expect(result).toEqual({ status: 'nothing' })
    expect(git.push).not.toHaveBeenCalled()
    expect(git.createPullRequest).not.toHaveBeenCalled()
  })

  it('resolves missing base branch from git default then falls back to main', async () => {
    const firstGit = createFakeGit({
      getDefaultBranch: vi.fn(async () => 'trunk')
    })
    await createPrFromWorktree(
      { worktreePath: '/repo/one', baseBranch: null, commitMessage: 'Message' },
      {
        gitFactory: () => firstGit,
        generatePRContent: vi.fn(async () => ({ title: 'T', body: '' }))
      }
    )

    expect(firstGit.getRangeDiff).toHaveBeenCalledWith('trunk')
    expect(firstGit.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: 'trunk' })
    )

    const secondGit = createFakeGit({
      getDefaultBranch: vi.fn(async () => {
        throw new Error('no default')
      })
    })
    await createPrFromWorktree(
      { worktreePath: '/repo/two', baseBranch: '   ', commitMessage: 'Message' },
      {
        gitFactory: () => secondGit,
        generatePRContent: vi.fn(async () => ({ title: 'T', body: '' }))
      }
    )

    expect(secondGit.getRangeDiff).toHaveBeenCalledWith('main')
    expect(secondGit.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: 'main' })
    )
  })

  it('falls back to the head branch title when content generation throws', async () => {
    const git = createFakeGit()

    const result = await createPrFromWorktree(
      {
        worktreePath: '/repo/worktree',
        baseBranch: 'main',
        commitMessage: 'Message'
      },
      {
        gitFactory: () => git,
        generatePRContent: vi.fn(async () => {
          throw new Error('provider failed')
        })
      }
    )

    expect(result.status).toBe('created')
    expect(git.createPullRequest).toHaveBeenCalledWith({
      baseBranch: 'main',
      title: 'feature/pr-command',
      body: ''
    })
  })

  it('reports an existing pull request when gh returns a url without success', async () => {
    const git = createFakeGit({
      createPullRequest: vi.fn(async () => ({
        success: false,
        url: 'https://github.com/acme/repo/pull/99',
        number: 99,
        error: 'pull request already exists'
      }))
    })

    const result = await createPrFromWorktree(
      { worktreePath: '/repo/worktree', baseBranch: 'main', commitMessage: 'Message' },
      { gitFactory: () => git, generatePRContent: vi.fn(async () => ({ title: 'T', body: '' })) }
    )

    expect(result).toEqual({
      status: 'exists',
      url: 'https://github.com/acme/repo/pull/99',
      number: 99
    })
  })

  it('returns an error and does not create a PR when push fails', async () => {
    const git = createFakeGit({
      push: vi.fn(async () => ({ success: false, error: 'remote rejected' }))
    })

    const result = await createPrFromWorktree(
      { worktreePath: '/repo/worktree', baseBranch: 'main', commitMessage: 'Message' },
      { gitFactory: () => git, generatePRContent: vi.fn(async () => ({ title: 'T', body: '' })) }
    )

    expect(result).toEqual({ status: 'error', message: 'Failed to push branch: remote rejected' })
    expect(git.createPullRequest).not.toHaveBeenCalled()
  })

  it('returns early for detached HEAD and current branch equal to base', async () => {
    const detachedGit = createFakeGit({
      getCurrentBranch: vi.fn(async () => 'HEAD')
    })
    await expect(
      createPrFromWorktree(
        { worktreePath: '/repo/detached', baseBranch: 'main', commitMessage: 'Message' },
        { gitFactory: () => detachedGit }
      )
    ).resolves.toEqual({
      status: 'error',
      message: 'Could not determine the current branch (detached HEAD?).'
    })
    expect(detachedGit.hasUncommittedChanges).not.toHaveBeenCalled()

    const baseGit = createFakeGit({
      getCurrentBranch: vi.fn(async () => 'main')
    })
    await expect(
      createPrFromWorktree(
        { worktreePath: '/repo/base', baseBranch: 'main', commitMessage: 'Message' },
        { gitFactory: () => baseGit }
      )
    ).resolves.toEqual({
      status: 'error',
      message: 'Already on the base branch (main).'
    })
    expect(baseGit.hasUncommittedChanges).not.toHaveBeenCalled()
  })

  it('maps common gh errors to friendly messages', async () => {
    const git = createFakeGit({
      createPullRequest: vi.fn(async () => ({
        success: false,
        error: 'gh: To get started with GitHub CLI, please run: gh auth login'
      }))
    })

    const result = await createPrFromWorktree(
      { worktreePath: '/repo/worktree', baseBranch: 'main', commitMessage: 'Message' },
      { gitFactory: () => git, generatePRContent: vi.fn(async () => ({ title: 'T', body: '' })) }
    )

    expect(result).toEqual({
      status: 'error',
      message: 'GitHub CLI is not authenticated. Run `gh auth login` and try again.'
    })
  })

  it('always requests PR content from claude-code', async () => {
    const git = createFakeGit()
    const generatePRContent = vi.fn(async () => ({ title: 'T', body: '' }))

    await createPrFromWorktree(
      { worktreePath: '/repo/worktree', baseBranch: 'main', commitMessage: 'Message' },
      { gitFactory: () => git, generatePRContent }
    )

    expect(generatePRContent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude-code',
        cwd: '/repo/worktree',
        baseBranch: 'main',
        headBranch: 'feature/pr-command'
      })
    )
  })
})
