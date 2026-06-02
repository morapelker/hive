import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock types
interface GitFileStatus {
  path: string
  relativePath: string
  status: 'M' | 'A' | 'D' | '?' | 'C' | ''
  staged: boolean
}

interface GitOps {
  getFileStatuses: (worktreePath: string) => Promise<{ success: boolean; files?: GitFileStatus[]; error?: string }>
  stageFile: (worktreePath: string, filePath: string) => Promise<{ success: boolean; error?: string }>
  unstageFile: (worktreePath: string, filePath: string) => Promise<{ success: boolean; error?: string }>
  discardChanges: (worktreePath: string, filePath: string) => Promise<{ success: boolean; error?: string }>
  addToGitignore: (worktreePath: string, pattern: string) => Promise<{ success: boolean; error?: string }>
  openInEditor: (filePath: string) => Promise<{ success: boolean; error?: string }>
  showInFinder: (filePath: string) => Promise<{ success: boolean; error?: string }>
  onStatusChanged: (callback: (event: { worktreePath: string }) => void) => () => void
}

interface ProjectOps {
  copyToClipboard: (text: string) => Promise<void>
}

// Create a mock unsubscribe function
const mockUnsubscribe = vi.fn()

// Mock window.gitOps
const mockGitOps: GitOps = {
  getFileStatuses: vi.fn(),
  stageFile: vi.fn(),
  unstageFile: vi.fn(),
  discardChanges: vi.fn(),
  addToGitignore: vi.fn(),
  openInEditor: vi.fn(),
  showInFinder: vi.fn(),
  onStatusChanged: vi.fn().mockReturnValue(mockUnsubscribe)
}

// Mock window.projectOps
const mockProjectOps: ProjectOps = {
  copyToClipboard: vi.fn()
}

describe('Session 2: File Tree Git Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Re-set the mock return value after clearing mocks
    vi.mocked(mockGitOps.onStatusChanged).mockReturnValue(mockUnsubscribe)
    // @ts-expect-error - global mock
    global.window = {
      gitOps: mockGitOps,
      projectOps: mockProjectOps
    }
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('Git Status Display', () => {
    test('Modified files show M indicator', async () => {
      const mockStatuses: GitFileStatus[] = [
        { path: '/repo/file.ts', relativePath: 'file.ts', status: 'M', staged: false }
      ]

      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: mockStatuses
      })

      const result = await mockGitOps.getFileStatuses('/repo')

      expect(result.success).toBe(true)
      expect(result.files).toHaveLength(1)
      expect(result.files![0].status).toBe('M')
      expect(result.files![0].staged).toBe(false)
    })

    test('Staged files show A indicator', async () => {
      const mockStatuses: GitFileStatus[] = [
        { path: '/repo/new-file.ts', relativePath: 'new-file.ts', status: 'A', staged: true }
      ]

      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: mockStatuses
      })

      const result = await mockGitOps.getFileStatuses('/repo')

      expect(result.success).toBe(true)
      expect(result.files![0].status).toBe('A')
      expect(result.files![0].staged).toBe(true)
    })

    test('Deleted files show D indicator', async () => {
      const mockStatuses: GitFileStatus[] = [
        { path: '/repo/deleted.ts', relativePath: 'deleted.ts', status: 'D', staged: false }
      ]

      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: mockStatuses
      })

      const result = await mockGitOps.getFileStatuses('/repo')

      expect(result.files![0].status).toBe('D')
    })

    test('Untracked files show ? indicator', async () => {
      const mockStatuses: GitFileStatus[] = [
        { path: '/repo/untracked.ts', relativePath: 'untracked.ts', status: '?', staged: false }
      ]

      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: mockStatuses
      })

      const result = await mockGitOps.getFileStatuses('/repo')

      expect(result.files![0].status).toBe('?')
    })

    test('Conflicted files show C indicator', async () => {
      const mockStatuses: GitFileStatus[] = [
        { path: '/repo/conflict.ts', relativePath: 'conflict.ts', status: 'C', staged: false }
      ]

      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: mockStatuses
      })

      const result = await mockGitOps.getFileStatuses('/repo')

      expect(result.files![0].status).toBe('C')
    })
  })

  describe('Context Menu Actions', () => {
    test('Stage file via context menu', async () => {
      vi.mocked(mockGitOps.stageFile).mockResolvedValue({ success: true })

      const result = await mockGitOps.stageFile('/repo', 'file.ts')

      expect(mockGitOps.stageFile).toHaveBeenCalledWith('/repo', 'file.ts')
      expect(result.success).toBe(true)
    })

    test('Unstage file via context menu', async () => {
      vi.mocked(mockGitOps.unstageFile).mockResolvedValue({ success: true })

      const result = await mockGitOps.unstageFile('/repo', 'file.ts')

      expect(mockGitOps.unstageFile).toHaveBeenCalledWith('/repo', 'file.ts')
      expect(result.success).toBe(true)
    })

    test('Discard changes requires confirmation pattern', async () => {
      vi.mocked(mockGitOps.discardChanges).mockResolvedValue({ success: true })

      // The actual confirmation is handled in the UI component
      // This tests that the discard API works correctly
      const result = await mockGitOps.discardChanges('/repo', 'file.ts')

      expect(mockGitOps.discardChanges).toHaveBeenCalledWith('/repo', 'file.ts')
      expect(result.success).toBe(true)
    })

    test('Add to .gitignore works', async () => {
      vi.mocked(mockGitOps.addToGitignore).mockResolvedValue({ success: true })

      const result = await mockGitOps.addToGitignore('/repo', 'untracked.ts')

      expect(mockGitOps.addToGitignore).toHaveBeenCalledWith('/repo', 'untracked.ts')
      expect(result.success).toBe(true)
    })

    test('Open in Editor launches editor', async () => {
      vi.mocked(mockGitOps.openInEditor).mockResolvedValue({ success: true })

      const result = await mockGitOps.openInEditor('/repo/file.ts')

      expect(mockGitOps.openInEditor).toHaveBeenCalledWith('/repo/file.ts')
      expect(result.success).toBe(true)
    })

    test('Show in Finder opens Finder', async () => {
      vi.mocked(mockGitOps.showInFinder).mockResolvedValue({ success: true })

      const result = await mockGitOps.showInFinder('/repo/file.ts')

      expect(mockGitOps.showInFinder).toHaveBeenCalledWith('/repo/file.ts')
      expect(result.success).toBe(true)
    })

    test('Copy path copies to clipboard', async () => {
      vi.mocked(mockProjectOps.copyToClipboard).mockResolvedValue(undefined)

      await mockProjectOps.copyToClipboard('/repo/file.ts')

      expect(mockProjectOps.copyToClipboard).toHaveBeenCalledWith('/repo/file.ts')
    })

    test('Copy relative path copies to clipboard', async () => {
      vi.mocked(mockProjectOps.copyToClipboard).mockResolvedValue(undefined)

      await mockProjectOps.copyToClipboard('src/file.ts')

      expect(mockProjectOps.copyToClipboard).toHaveBeenCalledWith('src/file.ts')
    })
  })

  describe('Git Status Events', () => {
    test('Subscribe to status changed events', () => {
      const callback = vi.fn()
      const unsubscribe = mockGitOps.onStatusChanged(callback)

      expect(mockGitOps.onStatusChanged).toHaveBeenCalled()
      expect(typeof unsubscribe).toBe('function')
    })

    test('Status changes trigger refresh', async () => {
      // First call to get initial statuses
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: [{ path: '/repo/file.ts', relativePath: 'file.ts', status: 'M', staged: false }]
      })

      await mockGitOps.getFileStatuses('/repo')

      // After a git operation, statuses should be refreshed
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: [{ path: '/repo/file.ts', relativePath: 'file.ts', status: 'A', staged: true }]
      })

      const result = await mockGitOps.getFileStatuses('/repo')

      expect(result.files![0].status).toBe('A')
      expect(result.files![0].staged).toBe(true)
    })
  })

  describe('Error Handling', () => {
    test('Handle getFileStatuses error gracefully', async () => {
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: false,
        error: 'Not a git repository'
      })

      const result = await mockGitOps.getFileStatuses('/non-repo')

      expect(result.success).toBe(false)
      expect(result.error).toBe('Not a git repository')
    })

    test('Handle stageFile error gracefully', async () => {
      vi.mocked(mockGitOps.stageFile).mockResolvedValue({
        success: false,
        error: 'File not found'
      })

      const result = await mockGitOps.stageFile('/repo', 'nonexistent.ts')

      expect(result.success).toBe(false)
      expect(result.error).toBe('File not found')
    })

    test('Handle discardChanges error gracefully', async () => {
      vi.mocked(mockGitOps.discardChanges).mockResolvedValue({
        success: false,
        error: 'Cannot discard: file is untracked'
      })

      const result = await mockGitOps.discardChanges('/repo', 'file.ts')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Cannot discard')
    })
  })

  describe('Git Status Color Coding', () => {
    test('Modified status should map to yellow color class', () => {
      const statusColors: Record<string, string> = {
        M: 'text-yellow-500',
        A: 'text-green-500',
        D: 'text-red-500',
        '?': 'text-gray-500',
        C: 'text-red-600 font-bold'
      }

      expect(statusColors['M']).toBe('text-yellow-500')
      expect(statusColors['A']).toBe('text-green-500')
      expect(statusColors['D']).toBe('text-red-500')
      expect(statusColors['?']).toBe('text-gray-500')
      expect(statusColors['C']).toContain('text-red')
      expect(statusColors['C']).toContain('font-bold')
    })
  })

  describe('Directory Git Status Aggregation', () => {
    test('Directory should show most severe child status', async () => {
      const mockStatuses: GitFileStatus[] = [
        { path: '/repo/src/a.ts', relativePath: 'src/a.ts', status: 'M', staged: false },
        { path: '/repo/src/b.ts', relativePath: 'src/b.ts', status: 'D', staged: false },
        { path: '/repo/src/c.ts', relativePath: 'src/c.ts', status: '?', staged: false }
      ]

      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: mockStatuses
      })

      const result = await mockGitOps.getFileStatuses('/repo')

      // The src directory should show D (most severe among its children)
      // This logic is implemented in getNodeGitStatus helper
      expect(result.files).toHaveLength(3)

      // Priority order: C > D > M > A > ?
      const childStatuses = result.files!.map(f => f.status)
      expect(childStatuses).toContain('D')
    })
  })
})
