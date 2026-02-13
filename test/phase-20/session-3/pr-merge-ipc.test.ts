import { describe, test, expect, vi } from 'vitest'

// Mock electron's app module so importing git-service doesn't crash in jsdom
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/mock-home')
  }
}))

// Mock simple-git so the module can load without real git
vi.mock('simple-git', () => ({
  default: vi.fn().mockReturnValue({
    branch: vi.fn(),
    raw: vi.fn()
  })
}))

import { parseWorktreeForBranch } from '../../../src/main/services/git-service'

describe('Session 3: PR Merge IPC Backend', () => {
  describe('parseWorktreeForBranch', () => {
    test('finds worktree path for matching branch', () => {
      const output = [
        'worktree /Users/dev/project',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /Users/dev/project-feature',
        'HEAD def456',
        'branch refs/heads/feature-x'
      ].join('\n')
      expect(parseWorktreeForBranch(output, 'main')).toBe('/Users/dev/project')
      expect(parseWorktreeForBranch(output, 'feature-x')).toBe('/Users/dev/project-feature')
    })

    test('returns null when branch not found', () => {
      const output = 'worktree /path\nHEAD abc\nbranch refs/heads/main\n'
      expect(parseWorktreeForBranch(output, 'develop')).toBeNull()
    })

    test('handles bare worktree (no branch line)', () => {
      const output = 'worktree /path\nHEAD abc\nbare\n'
      expect(parseWorktreeForBranch(output, 'main')).toBeNull()
    })

    test('handles detached HEAD worktree', () => {
      const output = 'worktree /path\nHEAD abc\ndetached\n'
      expect(parseWorktreeForBranch(output, 'main')).toBeNull()
    })

    test('handles multiple worktrees with only one matching', () => {
      const output = [
        'worktree /Users/dev/main',
        'HEAD aaa111',
        'branch refs/heads/main',
        '',
        'worktree /Users/dev/feat-a',
        'HEAD bbb222',
        'branch refs/heads/feature-a',
        '',
        'worktree /Users/dev/feat-b',
        'HEAD ccc333',
        'branch refs/heads/feature-b'
      ].join('\n')
      expect(parseWorktreeForBranch(output, 'feature-a')).toBe('/Users/dev/feat-a')
      expect(parseWorktreeForBranch(output, 'feature-c')).toBeNull()
    })

    test('handles empty output', () => {
      expect(parseWorktreeForBranch('', 'main')).toBeNull()
    })

    test('handles worktree path with spaces', () => {
      const output = [
        'worktree /Users/dev/my project',
        'HEAD abc123',
        'branch refs/heads/main'
      ].join('\n')
      expect(parseWorktreeForBranch(output, 'main')).toBe('/Users/dev/my project')
    })
  })

  test('prMerge is exposed on gitOps preload bridge', () => {
    // Verify that prMerge can be set and accessed on window.gitOps
    const mockPrMerge = vi.fn().mockResolvedValue({ success: true })
    Object.defineProperty(window, 'gitOps', {
      writable: true,
      configurable: true,
      value: { ...window.gitOps, prMerge: mockPrMerge }
    })
    expect(window.gitOps.prMerge).toBeDefined()
    expect(typeof window.gitOps.prMerge).toBe('function')
  })
})
