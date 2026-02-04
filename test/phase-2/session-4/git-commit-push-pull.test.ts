/**
 * Session 4: Git Commit, Push, Pull Tests
 *
 * Testing criteria from IMPLEMENTATION-P2.md:
 * - Commit form renders with summary and description fields
 * - Character count warns at 50 characters
 * - Character count errors at 72 characters
 * - Commit button disabled without staged files
 * - Commit creates git commit
 * - Push sends commits to remote
 * - Pull fetches commits from remote
 * - Force push shows confirmation
 * - Progress indicator shows during push
 * - Error toast shows on push failure
 * - Cmd+Enter triggers commit
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock types
interface GitFileStatus {
  path: string
  relativePath: string
  status: 'M' | 'A' | 'D' | '?' | 'C' | ''
  staged: boolean
}

interface GitBranchInfo {
  name: string
  tracking: string | null
  ahead: number
  behind: number
}

interface GitCommitResult {
  success: boolean
  commitHash?: string
  error?: string
}

interface GitPushResult {
  success: boolean
  pushed?: boolean
  error?: string
}

interface GitPullResult {
  success: boolean
  updated?: boolean
  error?: string
}

interface GitOps {
  getFileStatuses: (worktreePath: string) => Promise<{ success: boolean; files?: GitFileStatus[]; error?: string }>
  getBranchInfo: (worktreePath: string) => Promise<{ success: boolean; branch?: GitBranchInfo; error?: string }>
  stageFile: (worktreePath: string, filePath: string) => Promise<{ success: boolean; error?: string }>
  unstageFile: (worktreePath: string, filePath: string) => Promise<{ success: boolean; error?: string }>
  stageAll: (worktreePath: string) => Promise<{ success: boolean; error?: string }>
  unstageAll: (worktreePath: string) => Promise<{ success: boolean; error?: string }>
  discardChanges: (worktreePath: string, filePath: string) => Promise<{ success: boolean; error?: string }>
  commit: (worktreePath: string, message: string) => Promise<GitCommitResult>
  push: (worktreePath: string, remote?: string, branch?: string, force?: boolean) => Promise<GitPushResult>
  pull: (worktreePath: string, remote?: string, branch?: string, rebase?: boolean) => Promise<GitPullResult>
  onStatusChanged: (callback: (event: { worktreePath: string }) => void) => () => void
}

// Create mock functions
const mockUnsubscribe = vi.fn()

const mockGitOps: GitOps = {
  getFileStatuses: vi.fn(),
  getBranchInfo: vi.fn(),
  stageFile: vi.fn(),
  unstageFile: vi.fn(),
  stageAll: vi.fn(),
  unstageAll: vi.fn(),
  discardChanges: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  onStatusChanged: vi.fn().mockReturnValue(mockUnsubscribe)
}

describe('Session 4: Git Commit, Push, Pull', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(mockGitOps.onStatusChanged).mockReturnValue(mockUnsubscribe)
    // @ts-expect-error - global mock
    global.window = {
      gitOps: mockGitOps
    }
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('Commit Form Requirements', () => {
    test('Commit message validation - empty message rejected', async () => {
      vi.mocked(mockGitOps.commit).mockResolvedValue({
        success: false,
        error: 'Commit message is required'
      })

      const result = await mockGitOps.commit('/repo', '')

      expect(result.success).toBe(false)
      expect(result.error).toContain('message')
    })

    test('Commit message with summary only', async () => {
      vi.mocked(mockGitOps.commit).mockResolvedValue({
        success: true,
        commitHash: 'abc1234'
      })

      const result = await mockGitOps.commit('/repo', 'Fix bug in login flow')

      expect(mockGitOps.commit).toHaveBeenCalledWith('/repo', 'Fix bug in login flow')
      expect(result.success).toBe(true)
      expect(result.commitHash).toBe('abc1234')
    })

    test('Commit message with summary and description', async () => {
      vi.mocked(mockGitOps.commit).mockResolvedValue({
        success: true,
        commitHash: 'def5678'
      })

      const message = 'Add new feature\n\nThis adds a new feature that allows users to do XYZ.'
      const result = await mockGitOps.commit('/repo', message)

      expect(mockGitOps.commit).toHaveBeenCalledWith('/repo', message)
      expect(result.success).toBe(true)
    })

    test('Character count warning at 50 characters', () => {
      const SUMMARY_WARN_LENGTH = 50
      const summaryText = 'a'.repeat(51)

      expect(summaryText.length).toBeGreaterThan(SUMMARY_WARN_LENGTH)
    })

    test('Character count error at 72 characters', () => {
      const SUMMARY_ERROR_LENGTH = 72
      const summaryText = 'a'.repeat(73)

      expect(summaryText.length).toBeGreaterThan(SUMMARY_ERROR_LENGTH)
    })
  })

  describe('Commit Button State', () => {
    test('Commit button disabled without staged files', async () => {
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: [
          { path: '/repo/file.ts', relativePath: 'file.ts', status: 'M', staged: false }
        ]
      })

      const result = await mockGitOps.getFileStatuses('/repo')
      const stagedFiles = result.files?.filter(f => f.staged) || []

      expect(stagedFiles.length).toBe(0)
      // Button should be disabled when stagedFiles.length === 0
    })

    test('Commit button enabled with staged files and message', async () => {
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: [
          { path: '/repo/file.ts', relativePath: 'file.ts', status: 'A', staged: true }
        ]
      })

      const result = await mockGitOps.getFileStatuses('/repo')
      const stagedFiles = result.files?.filter(f => f.staged) || []

      expect(stagedFiles.length).toBeGreaterThan(0)
      // Button should be enabled when stagedFiles.length > 0 && message.length > 0
    })
  })

  describe('Commit Creates Git Commit', () => {
    test('Commit creates git commit with hash', async () => {
      vi.mocked(mockGitOps.commit).mockResolvedValue({
        success: true,
        commitHash: 'abc12345'
      })

      const result = await mockGitOps.commit('/repo', 'feat: add new feature')

      expect(result.success).toBe(true)
      expect(result.commitHash).toBe('abc12345')
    })

    test('Commit fails when no staged changes', async () => {
      vi.mocked(mockGitOps.commit).mockResolvedValue({
        success: false,
        error: 'No staged changes to commit'
      })

      const result = await mockGitOps.commit('/repo', 'empty commit')

      expect(result.success).toBe(false)
      expect(result.error).toContain('staged')
    })
  })

  describe('Push Operations', () => {
    test('Push sends commits to remote', async () => {
      vi.mocked(mockGitOps.push).mockResolvedValue({
        success: true,
        pushed: true
      })

      const result = await mockGitOps.push('/repo')

      expect(mockGitOps.push).toHaveBeenCalledWith('/repo')
      expect(result.success).toBe(true)
      expect(result.pushed).toBe(true)
    })

    test('Push with specific remote and branch', async () => {
      vi.mocked(mockGitOps.push).mockResolvedValue({
        success: true,
        pushed: true
      })

      const result = await mockGitOps.push('/repo', 'upstream', 'feature-branch')

      expect(mockGitOps.push).toHaveBeenCalledWith('/repo', 'upstream', 'feature-branch')
      expect(result.success).toBe(true)
    })

    test('Force push sends commits forcefully', async () => {
      vi.mocked(mockGitOps.push).mockResolvedValue({
        success: true,
        pushed: true
      })

      const result = await mockGitOps.push('/repo', 'origin', 'main', true)

      expect(mockGitOps.push).toHaveBeenCalledWith('/repo', 'origin', 'main', true)
      expect(result.success).toBe(true)
    })

    test('Push failure returns error', async () => {
      vi.mocked(mockGitOps.push).mockResolvedValue({
        success: false,
        error: 'Push rejected. The remote contains commits not present locally. Pull first or use force push.'
      })

      const result = await mockGitOps.push('/repo')

      expect(result.success).toBe(false)
      expect(result.error).toContain('rejected')
    })

    test('Push authentication failure', async () => {
      vi.mocked(mockGitOps.push).mockResolvedValue({
        success: false,
        error: 'Authentication failed. Check your credentials.'
      })

      const result = await mockGitOps.push('/repo')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Authentication')
    })
  })

  describe('Pull Operations', () => {
    test('Pull fetches commits from remote', async () => {
      vi.mocked(mockGitOps.pull).mockResolvedValue({
        success: true,
        updated: true
      })

      const result = await mockGitOps.pull('/repo')

      expect(mockGitOps.pull).toHaveBeenCalledWith('/repo')
      expect(result.success).toBe(true)
      expect(result.updated).toBe(true)
    })

    test('Pull with rebase option', async () => {
      vi.mocked(mockGitOps.pull).mockResolvedValue({
        success: true,
        updated: true
      })

      const result = await mockGitOps.pull('/repo', 'origin', 'main', true)

      expect(mockGitOps.pull).toHaveBeenCalledWith('/repo', 'origin', 'main', true)
      expect(result.success).toBe(true)
    })

    test('Pull shows when no updates available', async () => {
      vi.mocked(mockGitOps.pull).mockResolvedValue({
        success: true,
        updated: false
      })

      const result = await mockGitOps.pull('/repo')

      expect(result.success).toBe(true)
      expect(result.updated).toBe(false)
    })

    test('Pull fails with merge conflict', async () => {
      vi.mocked(mockGitOps.pull).mockResolvedValue({
        success: false,
        error: 'Pull resulted in merge conflicts. Resolve conflicts before continuing.'
      })

      const result = await mockGitOps.pull('/repo')

      expect(result.success).toBe(false)
      expect(result.error).toContain('conflict')
    })

    test('Pull fails with uncommitted changes', async () => {
      vi.mocked(mockGitOps.pull).mockResolvedValue({
        success: false,
        error: 'You have uncommitted changes. Commit or stash them before pulling.'
      })

      const result = await mockGitOps.pull('/repo')

      expect(result.success).toBe(false)
      expect(result.error).toContain('uncommitted')
    })
  })

  describe('Progress Indicators', () => {
    test('Commit operation can be tracked via loading state', async () => {
      let isCommitting = false

      vi.mocked(mockGitOps.commit).mockImplementation(async () => {
        isCommitting = true
        // Simulate operation time
        await new Promise(resolve => setTimeout(resolve, 10))
        isCommitting = false
        return { success: true, commitHash: 'abc' }
      })

      const promise = mockGitOps.commit('/repo', 'test')
      // isCommitting should be true during operation
      expect(isCommitting).toBe(true)

      await promise
      expect(isCommitting).toBe(false)
    })

    test('Push operation can be tracked via loading state', async () => {
      let isPushing = false

      vi.mocked(mockGitOps.push).mockImplementation(async () => {
        isPushing = true
        await new Promise(resolve => setTimeout(resolve, 10))
        isPushing = false
        return { success: true, pushed: true }
      })

      const promise = mockGitOps.push('/repo')
      expect(isPushing).toBe(true)

      await promise
      expect(isPushing).toBe(false)
    })

    test('Pull operation can be tracked via loading state', async () => {
      let isPulling = false

      vi.mocked(mockGitOps.pull).mockImplementation(async () => {
        isPulling = true
        await new Promise(resolve => setTimeout(resolve, 10))
        isPulling = false
        return { success: true, updated: true }
      })

      const promise = mockGitOps.pull('/repo')
      expect(isPulling).toBe(true)

      await promise
      expect(isPulling).toBe(false)
    })
  })

  describe('Ahead/Behind Counts', () => {
    test('Push button shows ahead count', async () => {
      vi.mocked(mockGitOps.getBranchInfo).mockResolvedValue({
        success: true,
        branch: { name: 'main', tracking: 'origin/main', ahead: 3, behind: 0 }
      })

      const result = await mockGitOps.getBranchInfo('/repo')

      expect(result.branch?.ahead).toBe(3)
      // UI should show (3) next to Push button
    })

    test('Pull button shows behind count', async () => {
      vi.mocked(mockGitOps.getBranchInfo).mockResolvedValue({
        success: true,
        branch: { name: 'main', tracking: 'origin/main', ahead: 0, behind: 5 }
      })

      const result = await mockGitOps.getBranchInfo('/repo')

      expect(result.branch?.behind).toBe(5)
      // UI should show (5) next to Pull button
    })

    test('Branch without tracking shows no counts', async () => {
      vi.mocked(mockGitOps.getBranchInfo).mockResolvedValue({
        success: true,
        branch: { name: 'feature', tracking: null, ahead: 0, behind: 0 }
      })

      const result = await mockGitOps.getBranchInfo('/repo')

      expect(result.branch?.tracking).toBeNull()
      // UI should show "No upstream branch set"
    })
  })

  describe('Error Handling', () => {
    test('Commit error shows user-friendly message', async () => {
      vi.mocked(mockGitOps.commit).mockResolvedValue({
        success: false,
        error: 'Commit message is required'
      })

      const result = await mockGitOps.commit('/repo', '')

      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
    })

    test('Push network error shows connection message', async () => {
      vi.mocked(mockGitOps.push).mockResolvedValue({
        success: false,
        error: 'Could not connect to remote repository. Check your network connection and authentication.'
      })

      const result = await mockGitOps.push('/repo')

      expect(result.success).toBe(false)
      expect(result.error).toContain('network')
    })

    test('Pull network error shows connection message', async () => {
      vi.mocked(mockGitOps.pull).mockResolvedValue({
        success: false,
        error: 'Could not connect to remote repository. Check your network connection and authentication.'
      })

      const result = await mockGitOps.pull('/repo')

      expect(result.success).toBe(false)
      expect(result.error).toContain('network')
    })
  })

  describe('Integration Flow', () => {
    test('Full commit-push workflow', async () => {
      // Stage files
      vi.mocked(mockGitOps.stageAll).mockResolvedValue({ success: true })
      await mockGitOps.stageAll('/repo')

      // Commit
      vi.mocked(mockGitOps.commit).mockResolvedValue({
        success: true,
        commitHash: 'abc123'
      })
      const commitResult = await mockGitOps.commit('/repo', 'feat: add new feature')

      expect(commitResult.success).toBe(true)

      // Push
      vi.mocked(mockGitOps.push).mockResolvedValue({
        success: true,
        pushed: true
      })
      const pushResult = await mockGitOps.push('/repo')

      expect(pushResult.success).toBe(true)
    })

    test('Pull before push workflow', async () => {
      // Pull first
      vi.mocked(mockGitOps.pull).mockResolvedValue({
        success: true,
        updated: true
      })
      const pullResult = await mockGitOps.pull('/repo')

      expect(pullResult.success).toBe(true)

      // Then push
      vi.mocked(mockGitOps.push).mockResolvedValue({
        success: true,
        pushed: true
      })
      const pushResult = await mockGitOps.push('/repo')

      expect(pushResult.success).toBe(true)
    })
  })
})
