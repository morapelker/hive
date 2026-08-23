import { describe, expect, it } from 'vitest'

import { normalizeBranchDisplayName, parseWorktreeForBranch } from '../git-output'

describe('normalizeBranchDisplayName', () => {
  it('strips the remotes prefix', () => {
    expect(normalizeBranchDisplayName('remotes/origin/main')).toBe('origin/main')
  })

  it('leaves a local branch alone', () => {
    expect(normalizeBranchDisplayName('main')).toBe('main')
  })

  it('only strips a leading prefix', () => {
    expect(normalizeBranchDisplayName('feature/remotes/thing')).toBe('feature/remotes/thing')
  })
})

describe('parseWorktreeForBranch', () => {
  const output = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo-feature',
    'HEAD def456',
    'branch refs/heads/feature-x'
  ].join('\n')

  it('finds the worktree checked out on a branch', () => {
    expect(parseWorktreeForBranch(output, 'feature-x')).toBe('/repo-feature')
    expect(parseWorktreeForBranch(output, 'main')).toBe('/repo')
  })

  it('returns null when the branch is not checked out anywhere', () => {
    expect(parseWorktreeForBranch(output, 'missing')).toBeNull()
  })

  it('returns null for empty output', () => {
    expect(parseWorktreeForBranch('', 'main')).toBeNull()
  })

  it('ignores a detached worktree, which has no branch line', () => {
    const detached = ['worktree /repo-detached', 'HEAD abc123', 'detached'].join('\n')
    expect(parseWorktreeForBranch(detached, 'main')).toBeNull()
  })
})
