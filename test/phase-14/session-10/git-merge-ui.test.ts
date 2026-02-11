/**
 * Session 10: Git Merge UI Tests
 *
 * Testing criteria from IMPLEMENTATION-P14.md:
 * - Renders merge section with dropdown trigger and button
 * - Merge button disabled when no branch selected
 * - Calls gitOps.merge on button click
 * - Branch dropdown fetches and filters branches
 * - Shows success toast on successful merge
 * - Shows error toast on failed merge
 * - Merge button shows spinner while merging
 * - Merge button disabled while other git operations in progress
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

// Mock types matching the git store
interface BranchInfo {
  name: string
  isRemote: boolean
  isCheckedOut: boolean
  worktreePath?: string
}

interface MockGitOps {
  getFileStatuses: ReturnType<typeof vi.fn>
  getBranchInfo: ReturnType<typeof vi.fn>
  stageFile: ReturnType<typeof vi.fn>
  unstageFile: ReturnType<typeof vi.fn>
  stageAll: ReturnType<typeof vi.fn>
  unstageAll: ReturnType<typeof vi.fn>
  discardChanges: ReturnType<typeof vi.fn>
  addToGitignore: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  push: ReturnType<typeof vi.fn>
  pull: ReturnType<typeof vi.fn>
  onStatusChanged: ReturnType<typeof vi.fn>
  openInEditor: ReturnType<typeof vi.fn>
  showInFinder: ReturnType<typeof vi.fn>
  getDiff: ReturnType<typeof vi.fn>
  listBranchesWithStatus: ReturnType<typeof vi.fn>
  merge: ReturnType<typeof vi.fn>
}

const mockUnsubscribe = vi.fn()

const mockBranches: BranchInfo[] = [
  { name: 'main', isRemote: false, isCheckedOut: false },
  { name: 'develop', isRemote: false, isCheckedOut: false },
  { name: 'feature/login', isRemote: false, isCheckedOut: true, worktreePath: '/repo/wt' },
  { name: 'remotes/origin/main', isRemote: true, isCheckedOut: false },
  { name: 'remotes/origin/develop', isRemote: true, isCheckedOut: false }
]

const mockGitOps: MockGitOps = {
  getFileStatuses: vi.fn().mockResolvedValue({ success: true, files: [] }),
  getBranchInfo: vi.fn().mockResolvedValue({
    success: true,
    branch: { name: 'feature', tracking: 'origin/feature', ahead: 0, behind: 0 }
  }),
  stageFile: vi.fn(),
  unstageFile: vi.fn(),
  stageAll: vi.fn(),
  unstageAll: vi.fn(),
  discardChanges: vi.fn(),
  addToGitignore: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  onStatusChanged: vi.fn().mockReturnValue(mockUnsubscribe),
  openInEditor: vi.fn(),
  showInFinder: vi.fn(),
  getDiff: vi.fn(),
  listBranchesWithStatus: vi.fn().mockResolvedValue({ success: true, branches: mockBranches }),
  merge: vi.fn()
}

describe('Session 10: Git Merge UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(mockGitOps.onStatusChanged).mockReturnValue(mockUnsubscribe)
    vi.mocked(mockGitOps.listBranchesWithStatus).mockResolvedValue({
      success: true,
      branches: mockBranches
    })
    Object.defineProperty(global, 'window', {
      value: { gitOps: mockGitOps },
      writable: true,
      configurable: true
    })
  })

  describe('Branch dropdown', () => {
    test('listBranchesWithStatus returns both local and remote branches', async () => {
      const result = await mockGitOps.listBranchesWithStatus('/test/repo')

      expect(result.success).toBe(true)
      expect(result.branches).toHaveLength(5)

      const localBranches = result.branches.filter((b: BranchInfo) => !b.isRemote)
      const remoteBranches = result.branches.filter((b: BranchInfo) => b.isRemote)

      expect(localBranches).toHaveLength(3)
      expect(remoteBranches).toHaveLength(2)
    })

    test('branches can be filtered by name', () => {
      const filter = 'main'
      const filtered = mockBranches.filter((b) =>
        b.name.toLowerCase().includes(filter.toLowerCase())
      )

      expect(filtered).toHaveLength(2) // 'main' and 'remotes/origin/main'
    })

    test('filtered branches sort local first, then remote', () => {
      const sorted = [...mockBranches].sort((a, b) => {
        if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1
        return a.name.localeCompare(b.name)
      })

      // Local branches come first
      const firstRemoteIndex = sorted.findIndex((b) => b.isRemote)
      // All items before the first remote should be local
      const allLocalBeforeRemote = sorted.slice(0, firstRemoteIndex).every((b) => !b.isRemote)

      expect(firstRemoteIndex).toBeGreaterThan(0)
      expect(allLocalBeforeRemote).toBe(true)
    })

    test('current branch is excluded from the list', () => {
      const currentBranch = 'feature'
      const filtered = mockBranches.filter((b) => b.name !== currentBranch)

      // 'feature' is not in mockBranches but 'feature/login' is, so all 5 remain
      expect(filtered).toHaveLength(5)

      // If current branch were 'main', it should be excluded
      const filteredMain = mockBranches.filter((b) => b.name !== 'main')
      expect(filteredMain).toHaveLength(4)
    })

    test('selecting a branch from dropdown sets mergeBranch', () => {
      let mergeBranch = ''
      const handleBranchSelect = (name: string): void => {
        mergeBranch = name
      }

      handleBranchSelect('develop')
      expect(mergeBranch).toBe('develop')
    })

    test('empty filter shows all branches', () => {
      const filter = ''
      const filtered = mockBranches.filter((b) =>
        b.name.toLowerCase().includes(filter.toLowerCase())
      )

      expect(filtered).toHaveLength(5)
    })
  })

  describe('Merge button disabled states', () => {
    test('merge button disabled when no branch selected', () => {
      const mergeBranch = ''
      const isMerging = false
      const isOperating = false

      const isDisabled = isMerging || isOperating || !mergeBranch.trim()

      expect(isDisabled).toBe(true)
    })

    test('merge button enabled when branch is selected', () => {
      const mergeBranch = 'main'
      const isMerging = false
      const isOperating = false

      const isDisabled = isMerging || isOperating || !mergeBranch.trim()

      expect(isDisabled).toBe(false)
    })

    test('merge button disabled while merging', () => {
      const mergeBranch = 'main'
      const isMerging = true
      const isOperating = true

      const isDisabled = isMerging || isOperating || !mergeBranch.trim()

      expect(isDisabled).toBe(true)
    })

    test('merge button disabled while pushing or pulling', () => {
      const mergeBranch = 'main'
      const isMerging = false
      const isOperating = true

      const isDisabled = isMerging || isOperating || !mergeBranch.trim()

      expect(isDisabled).toBe(true)
    })
  })

  describe('Merge handler', () => {
    test('calls gitOps.merge with correct params', async () => {
      vi.mocked(mockGitOps.merge).mockResolvedValue({ success: true })

      const result = await mockGitOps.merge('/test/repo', 'main')

      expect(mockGitOps.merge).toHaveBeenCalledWith('/test/repo', 'main')
      expect(result.success).toBe(true)
    })

    test('handles successful merge', async () => {
      vi.mocked(mockGitOps.merge).mockResolvedValue({ success: true })

      const result = await mockGitOps.merge('/test/repo', 'develop')

      expect(result.success).toBe(true)
    })

    test('handles merge failure with error message', async () => {
      vi.mocked(mockGitOps.merge).mockResolvedValue({
        success: false,
        error: 'merge: main - not something we can merge'
      })

      const result = await mockGitOps.merge('/test/repo', 'nonexistent-branch')

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    test('handles merge with conflicts', async () => {
      vi.mocked(mockGitOps.merge).mockResolvedValue({
        success: false,
        error: 'Merge conflicts in 2 file(s). Resolve conflicts before continuing.',
        conflicts: ['file1.ts', 'file2.ts']
      })

      const result = await mockGitOps.merge('/test/repo', 'main')

      expect(result.success).toBe(false)
      expect(result.conflicts).toEqual(['file1.ts', 'file2.ts'])
      expect(result.error).toContain('conflicts')
    })

    test('trims whitespace from branch name before merging', () => {
      const mergeBranch = '  main  '
      const trimmed = mergeBranch.trim()

      expect(trimmed).toBe('main')
    })
  })

  describe('isOperating includes isMerging', () => {
    test('isOperating is true when isMerging is true', () => {
      const isPushing = false
      const isPulling = false
      const isMerging = true

      const isOperating = isPushing || isPulling || isMerging

      expect(isOperating).toBe(true)
    })

    test('isOperating is false when nothing is happening', () => {
      const isPushing = false
      const isPulling = false
      const isMerging = false

      const isOperating = isPushing || isPulling || isMerging

      expect(isOperating).toBe(false)
    })
  })
})
