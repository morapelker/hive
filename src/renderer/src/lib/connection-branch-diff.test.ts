import { describe, expect, it } from 'vitest'
import {
  connectionDiffBranchKey,
  describeMemberGitError,
  intersectMemberBranches,
  type BranchWithStatus
} from './connection-branch-diff'

const b = (name: string, opts: Partial<BranchWithStatus> = {}): BranchWithStatus => ({
  name,
  isRemote: name.includes('/'),
  isCheckedOut: false,
  ...opts
})

describe('intersectMemberBranches', () => {
  it('returns only branches present by name in every loaded member', () => {
    const result = intersectMemberBranches([
      { worktreePath: '/a', branches: [b('main'), b('feat/x'), b('origin/main'), b('only-a')] },
      { worktreePath: '/b', branches: [b('feat/x'), b('main'), b('origin/main'), b('only-b')] },
      { worktreePath: '/c', branches: [b('origin/main'), b('main'), b('feat/x')] }
    ])
    expect(result.map((r) => r.name)).toEqual(['main', 'feat/x', 'origin/main'])
  })

  it('keeps the first member ordering and remote flag', () => {
    const result = intersectMemberBranches([
      { worktreePath: '/a', branches: [b('origin/main'), b('main')] },
      { worktreePath: '/b', branches: [b('main'), b('origin/main')] }
    ])
    expect(result).toEqual([
      { name: 'origin/main', isRemote: true, isCheckedOut: false },
      { name: 'main', isRemote: false, isCheckedOut: false }
    ])
  })

  it('marks a branch current only when every member worktree is checked out on it', () => {
    const result = intersectMemberBranches([
      {
        worktreePath: '/a',
        branches: [
          b('main', { isCheckedOut: true, worktreePath: '/a' }),
          b('feat', { isCheckedOut: true, worktreePath: '/a' }),
          // checked out in a sibling worktree of the same repo, not in /a
          b('other', { isCheckedOut: true, worktreePath: '/a-sibling' })
        ]
      },
      {
        worktreePath: '/b',
        branches: [
          b('main', { isCheckedOut: true, worktreePath: '/b' }),
          b('feat', { isCheckedOut: false }),
          b('other', { isCheckedOut: true, worktreePath: '/b' })
        ]
      }
    ])
    expect(result.find((r) => r.name === 'main')?.isCheckedOut).toBe(true)
    expect(result.find((r) => r.name === 'feat')?.isCheckedOut).toBe(false)
    expect(result.find((r) => r.name === 'other')?.isCheckedOut).toBe(false)
  })

  it('does not let a local branch match a remote one of the same base name', () => {
    const result = intersectMemberBranches([
      { worktreePath: '/a', branches: [b('main')] },
      { worktreePath: '/b', branches: [b('origin/main')] }
    ])
    expect(result).toEqual([])
  })

  it('ignores members whose listing failed instead of emptying the result', () => {
    const result = intersectMemberBranches([
      { worktreePath: '/a', branches: [b('main'), b('feat')] },
      { worktreePath: '/b', error: 'not a git repository' },
      { worktreePath: '/c', branches: [b('main')] }
    ])
    expect(result.map((r) => r.name)).toEqual(['main'])
  })

  it('returns nothing when no member loaded', () => {
    expect(intersectMemberBranches([])).toEqual([])
    expect(intersectMemberBranches([{ worktreePath: '/a', error: 'boom' }])).toEqual([])
  })

  it('treats a single member as its own intersection', () => {
    const result = intersectMemberBranches([
      { worktreePath: '/a', branches: [b('main'), b('feat')] }
    ])
    expect(result.map((r) => r.name)).toEqual(['main', 'feat'])
  })

  it('dedupes a name repeated within one member', () => {
    const result = intersectMemberBranches([
      { worktreePath: '/a', branches: [b('main'), b('main')] },
      { worktreePath: '/b', branches: [b('main')] }
    ])
    expect(result).toHaveLength(1)
  })
})

describe('connectionDiffBranchKey', () => {
  it('namespaces the connection id so it cannot collide with a worktree path', () => {
    expect(connectionDiffBranchKey('abc')).toBe('connection:abc')
  })
})

describe('describeMemberGitError', () => {
  it('maps the common raw git failures to readable text', () => {
    expect(
      describeMemberGitError('fatal: not a git repository (or any of the parent directories): .git')
    ).toBe('Not a git repository')
    expect(
      describeMemberGitError(
        "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree."
      )
    ).toBe('Branch not found in this repo')
  })

  it('passes unknown errors through unchanged', () => {
    expect(describeMemberGitError('index.lock exists')).toBe('index.lock exists')
  })
})
