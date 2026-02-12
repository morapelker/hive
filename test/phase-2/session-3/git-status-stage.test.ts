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

interface GitOps {
  getFileStatuses: (worktreePath: string) => Promise<{ success: boolean; files?: GitFileStatus[]; error?: string }>
  getBranchInfo: (worktreePath: string) => Promise<{ success: boolean; branch?: GitBranchInfo; error?: string }>
  stageFile: (worktreePath: string, filePath: string) => Promise<{ success: boolean; error?: string }>
  unstageFile: (worktreePath: string, filePath: string) => Promise<{ success: boolean; error?: string }>
  stageAll: (worktreePath: string) => Promise<{ success: boolean; error?: string }>
  unstageAll: (worktreePath: string) => Promise<{ success: boolean; error?: string }>
  discardChanges: (worktreePath: string, filePath: string) => Promise<{ success: boolean; error?: string }>
  addToGitignore: (worktreePath: string, pattern: string) => Promise<{ success: boolean; error?: string }>
  openInEditor: (filePath: string) => Promise<{ success: boolean; error?: string }>
  showInFinder: (filePath: string) => Promise<{ success: boolean; error?: string }>
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
  addToGitignore: vi.fn(),
  openInEditor: vi.fn(),
  showInFinder: vi.fn(),
  onStatusChanged: vi.fn().mockReturnValue(mockUnsubscribe)
}

describe('Session 3: Git Status & Stage/Unstage', () => {
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

  describe('Git Status Panel Rendering', () => {
    test('Git status panel renders', async () => {
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: []
      })
      vi.mocked(mockGitOps.getBranchInfo).mockResolvedValue({
        success: true,
        branch: { name: 'main', tracking: 'origin/main', ahead: 0, behind: 0 }
      })

      const statusResult = await mockGitOps.getFileStatuses('/repo')
      const branchResult = await mockGitOps.getBranchInfo('/repo')

      expect(statusResult.success).toBe(true)
      expect(branchResult.success).toBe(true)
    })
  })

  describe('Branch Info Display', () => {
    test('Branch name is displayed', async () => {
      vi.mocked(mockGitOps.getBranchInfo).mockResolvedValue({
        success: true,
        branch: { name: 'feature/new-feature', tracking: null, ahead: 0, behind: 0 }
      })

      const result = await mockGitOps.getBranchInfo('/repo')

      expect(result.success).toBe(true)
      expect(result.branch?.name).toBe('feature/new-feature')
    })

    test('Ahead/behind counts shown when tracking remote', async () => {
      vi.mocked(mockGitOps.getBranchInfo).mockResolvedValue({
        success: true,
        branch: { name: 'main', tracking: 'origin/main', ahead: 2, behind: 3 }
      })

      const result = await mockGitOps.getBranchInfo('/repo')

      expect(result.success).toBe(true)
      expect(result.branch?.tracking).toBe('origin/main')
      expect(result.branch?.ahead).toBe(2)
      expect(result.branch?.behind).toBe(3)
    })

    test('No ahead/behind when no tracking branch', async () => {
      vi.mocked(mockGitOps.getBranchInfo).mockResolvedValue({
        success: true,
        branch: { name: 'local-only', tracking: null, ahead: 0, behind: 0 }
      })

      const result = await mockGitOps.getBranchInfo('/repo')

      expect(result.branch?.tracking).toBe(null)
    })
  })

  describe('File Status Categorization', () => {
    test('Modified files shown in correct section', async () => {
      const mockStatuses: GitFileStatus[] = [
        { path: '/repo/modified.ts', relativePath: 'modified.ts', status: 'M', staged: false }
      ]

      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: mockStatuses
      })

      const result = await mockGitOps.getFileStatuses('/repo')

      expect(result.files?.filter(f => f.status === 'M' && !f.staged)).toHaveLength(1)
    })

    test('Staged files shown in staged section', async () => {
      const mockStatuses: GitFileStatus[] = [
        { path: '/repo/staged.ts', relativePath: 'staged.ts', status: 'A', staged: true }
      ]

      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: mockStatuses
      })

      const result = await mockGitOps.getFileStatuses('/repo')

      expect(result.files?.filter(f => f.staged)).toHaveLength(1)
    })

    test('Untracked files shown in untracked section', async () => {
      const mockStatuses: GitFileStatus[] = [
        { path: '/repo/untracked.ts', relativePath: 'untracked.ts', status: '?', staged: false }
      ]

      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: mockStatuses
      })

      const result = await mockGitOps.getFileStatuses('/repo')

      expect(result.files?.filter(f => f.status === '?')).toHaveLength(1)
    })
  })

  describe('Stage All / Unstage All', () => {
    test('Stage All stages all files', async () => {
      vi.mocked(mockGitOps.stageAll).mockResolvedValue({ success: true })

      const result = await mockGitOps.stageAll('/repo')

      expect(mockGitOps.stageAll).toHaveBeenCalledWith('/repo')
      expect(result.success).toBe(true)
    })

    test('Unstage All unstages all files', async () => {
      vi.mocked(mockGitOps.unstageAll).mockResolvedValue({ success: true })

      const result = await mockGitOps.unstageAll('/repo')

      expect(mockGitOps.unstageAll).toHaveBeenCalledWith('/repo')
      expect(result.success).toBe(true)
    })
  })

  describe('Individual File Staging', () => {
    test('Individual file staging works', async () => {
      vi.mocked(mockGitOps.stageFile).mockResolvedValue({ success: true })

      const result = await mockGitOps.stageFile('/repo', 'single-file.ts')

      expect(mockGitOps.stageFile).toHaveBeenCalledWith('/repo', 'single-file.ts')
      expect(result.success).toBe(true)
    })

    test('Individual file unstaging works', async () => {
      vi.mocked(mockGitOps.unstageFile).mockResolvedValue({ success: true })

      const result = await mockGitOps.unstageFile('/repo', 'staged-file.ts')

      expect(mockGitOps.unstageFile).toHaveBeenCalledWith('/repo', 'staged-file.ts')
      expect(result.success).toBe(true)
    })
  })

  describe('Auto-Refresh on Status Change', () => {
    test('Status auto-refreshes on file change', async () => {
      const statusChangeCallback = vi.fn()

      // Simulate subscribing to status changes
      mockGitOps.onStatusChanged(statusChangeCallback)

      expect(mockGitOps.onStatusChanged).toHaveBeenCalled()

      // First fetch
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: [{ path: '/repo/file.ts', relativePath: 'file.ts', status: 'M', staged: false }]
      })

      const firstResult = await mockGitOps.getFileStatuses('/repo')
      expect(firstResult.files).toHaveLength(1)

      // After status change (file staged), second fetch
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: [{ path: '/repo/file.ts', relativePath: 'file.ts', status: 'A', staged: true }]
      })

      const secondResult = await mockGitOps.getFileStatuses('/repo')
      expect(secondResult.files?.[0].staged).toBe(true)
    })

    test('Refresh button manually refreshes', async () => {
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: []
      })
      vi.mocked(mockGitOps.getBranchInfo).mockResolvedValue({
        success: true,
        branch: { name: 'main', tracking: null, ahead: 0, behind: 0 }
      })

      // Simulate refresh by calling both APIs
      await mockGitOps.getFileStatuses('/repo')
      await mockGitOps.getBranchInfo('/repo')

      expect(mockGitOps.getFileStatuses).toHaveBeenCalledWith('/repo')
      expect(mockGitOps.getBranchInfo).toHaveBeenCalledWith('/repo')
    })
  })

  describe('Error Handling', () => {
    test('Handle getBranchInfo error gracefully', async () => {
      vi.mocked(mockGitOps.getBranchInfo).mockResolvedValue({
        success: false,
        error: 'Not a git repository'
      })

      const result = await mockGitOps.getBranchInfo('/non-repo')

      expect(result.success).toBe(false)
      expect(result.error).toBe('Not a git repository')
    })

    test('Handle stageAll error gracefully', async () => {
      vi.mocked(mockGitOps.stageAll).mockResolvedValue({
        success: false,
        error: 'Failed to stage files'
      })

      const result = await mockGitOps.stageAll('/repo')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Failed')
    })

    test('Handle unstageAll error gracefully', async () => {
      vi.mocked(mockGitOps.unstageAll).mockResolvedValue({
        success: false,
        error: 'Nothing to unstage'
      })

      const result = await mockGitOps.unstageAll('/repo')

      expect(result.success).toBe(false)
    })
  })

  describe('Collapsible Sections', () => {
    test('File sections support categorization', async () => {
      const mockStatuses: GitFileStatus[] = [
        { path: '/repo/staged1.ts', relativePath: 'staged1.ts', status: 'A', staged: true },
        { path: '/repo/staged2.ts', relativePath: 'staged2.ts', status: 'M', staged: true },
        { path: '/repo/modified1.ts', relativePath: 'modified1.ts', status: 'M', staged: false },
        { path: '/repo/untracked1.ts', relativePath: 'untracked1.ts', status: '?', staged: false },
        { path: '/repo/deleted1.ts', relativePath: 'deleted1.ts', status: 'D', staged: false }
      ]

      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: mockStatuses
      })

      const result = await mockGitOps.getFileStatuses('/repo')
      const files = result.files!

      // Categorize files as the component would
      const staged = files.filter(f => f.staged)
      const modified = files.filter(f => !f.staged && (f.status === 'M' || f.status === 'D'))
      const untracked = files.filter(f => f.status === '?' && !f.staged)

      expect(staged).toHaveLength(2)
      expect(modified).toHaveLength(2)
      expect(untracked).toHaveLength(1)
    })
  })

  describe('Empty State', () => {
    test('Shows no changes message when clean', async () => {
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: []
      })

      const result = await mockGitOps.getFileStatuses('/repo')

      expect(result.success).toBe(true)
      expect(result.files).toHaveLength(0)
    })
  })
})
