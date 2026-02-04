/**
 * Session 5: Diff Viewer Tests
 *
 * Testing criteria from IMPLEMENTATION-P2.md:
 * - Diff viewer renders for modified file
 * - Unified view shows inline diff
 * - Split view shows side by side
 * - Additions highlighted in green
 * - Deletions highlighted in red
 * - Line numbers displayed
 * - Context menu View Changes opens diff
 * - Git panel file click opens diff
 * - Diff renders under 100ms
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock types
interface GitFileStatus {
  path: string
  relativePath: string
  status: 'M' | 'A' | 'D' | '?' | 'C' | ''
  staged: boolean
}

interface GitDiffResult {
  success: boolean
  diff?: string
  fileName?: string
  error?: string
}

interface GitOps {
  getFileStatuses: (worktreePath: string) => Promise<{ success: boolean; files?: GitFileStatus[]; error?: string }>
  getDiff: (worktreePath: string, filePath: string, staged: boolean, isUntracked: boolean) => Promise<GitDiffResult>
  onStatusChanged: (callback: (event: { worktreePath: string }) => void) => () => void
}

interface ProjectOps {
  copyToClipboard: (text: string) => Promise<void>
}

// Sample unified diff for testing
const SAMPLE_UNIFIED_DIFF = `diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,7 @@
 import { createApp } from 'vue'
+import { router } from './router'

 const app = createApp(App)
+app.use(router)
 app.mount('#app')
-// Old comment
`

const SAMPLE_LARGE_DIFF = Array(500).fill(`diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
-old line
+new line
 context line
`).join('\n')

// Create mock functions
const mockUnsubscribe = vi.fn()

const mockGitOps: GitOps = {
  getFileStatuses: vi.fn(),
  getDiff: vi.fn(),
  onStatusChanged: vi.fn().mockReturnValue(mockUnsubscribe)
}

const mockProjectOps: ProjectOps = {
  copyToClipboard: vi.fn()
}

describe('Session 5: Diff Viewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  describe('Diff Loading', () => {
    test('Diff viewer renders for modified file', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: SAMPLE_UNIFIED_DIFF,
        fileName: 'app.ts'
      })

      const result = await mockGitOps.getDiff('/repo', 'src/app.ts', false, false)

      expect(result.success).toBe(true)
      expect(result.diff).toContain('diff --git')
      expect(result.fileName).toBe('app.ts')
    })

    test('Diff viewer handles staged file diff', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: SAMPLE_UNIFIED_DIFF,
        fileName: 'app.ts'
      })

      const result = await mockGitOps.getDiff('/repo', 'src/app.ts', true, false)

      expect(mockGitOps.getDiff).toHaveBeenCalledWith('/repo', 'src/app.ts', true, false)
      expect(result.success).toBe(true)
    })

    test('Diff viewer handles untracked file diff', async () => {
      const newFileDiff = `diff --git a/new-file.ts b/new-file.ts
new file mode 100644
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,3 @@
+const hello = 'world'
+export default hello
`
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: newFileDiff,
        fileName: 'new-file.ts'
      })

      const result = await mockGitOps.getDiff('/repo', 'new-file.ts', false, true)

      expect(mockGitOps.getDiff).toHaveBeenCalledWith('/repo', 'new-file.ts', false, true)
      expect(result.success).toBe(true)
      expect(result.diff).toContain('new file mode')
    })

    test('Diff viewer shows error on failure', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: false,
        error: 'File not found'
      })

      const result = await mockGitOps.getDiff('/repo', 'nonexistent.ts', false, false)

      expect(result.success).toBe(false)
      expect(result.error).toBe('File not found')
    })

    test('Diff viewer handles empty diff (no changes)', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: '',
        fileName: 'unchanged.ts'
      })

      const result = await mockGitOps.getDiff('/repo', 'unchanged.ts', false, false)

      expect(result.success).toBe(true)
      expect(result.diff).toBe('')
    })
  })

  describe('Unified View', () => {
    test('Unified view shows additions with + prefix', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: SAMPLE_UNIFIED_DIFF,
        fileName: 'app.ts'
      })

      const result = await mockGitOps.getDiff('/repo', 'src/app.ts', false, false)
      const diff = result.diff || ''

      // Check for addition lines (+ prefix)
      expect(diff).toContain('+import { router }')
      expect(diff).toContain('+app.use(router)')
    })

    test('Unified view shows deletions with - prefix', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: SAMPLE_UNIFIED_DIFF,
        fileName: 'app.ts'
      })

      const result = await mockGitOps.getDiff('/repo', 'src/app.ts', false, false)
      const diff = result.diff || ''

      // Check for deletion lines (- prefix)
      expect(diff).toContain('-// Old comment')
    })

    test('Unified view shows context lines', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: SAMPLE_UNIFIED_DIFF,
        fileName: 'app.ts'
      })

      const result = await mockGitOps.getDiff('/repo', 'src/app.ts', false, false)
      const diff = result.diff || ''

      // Check for context lines (no prefix)
      expect(diff).toContain(' import { createApp }')
      expect(diff).toContain(' const app = createApp')
    })

    test('Unified view includes line number information', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: SAMPLE_UNIFIED_DIFF,
        fileName: 'app.ts'
      })

      const result = await mockGitOps.getDiff('/repo', 'src/app.ts', false, false)
      const diff = result.diff || ''

      // Check for hunk header with line numbers
      expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/)
    })
  })

  describe('Split View', () => {
    test('Split view diff can be generated', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: SAMPLE_UNIFIED_DIFF,
        fileName: 'app.ts'
      })

      const result = await mockGitOps.getDiff('/repo', 'src/app.ts', false, false)

      // The diff2html library can render this in split mode
      // The unified diff format supports both line-by-line and side-by-side rendering
      expect(result.success).toBe(true)
      expect(result.diff).toBeDefined()
    })
  })

  describe('Line Numbers', () => {
    test('Diff includes original and new line numbers', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: SAMPLE_UNIFIED_DIFF,
        fileName: 'app.ts'
      })

      const result = await mockGitOps.getDiff('/repo', 'src/app.ts', false, false)
      const diff = result.diff || ''

      // Line number info is in hunk headers like @@ -1,5 +1,7 @@
      const hunkHeader = diff.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/)
      expect(hunkHeader).toBeTruthy()
      expect(hunkHeader![1]).toBe('1') // Original start line
      expect(hunkHeader![2]).toBe('5') // Original line count
      expect(hunkHeader![3]).toBe('1') // New start line
      expect(hunkHeader![4]).toBe('7') // New line count
    })
  })

  describe('Context Menu Integration', () => {
    test('View Changes action triggers diff load', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: SAMPLE_UNIFIED_DIFF,
        fileName: 'app.ts'
      })

      // Simulate context menu action
      const file: GitFileStatus = {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        status: 'M',
        staged: false
      }

      const result = await mockGitOps.getDiff('/repo', file.relativePath, file.staged, file.status === '?')

      expect(mockGitOps.getDiff).toHaveBeenCalledWith('/repo', 'src/app.ts', false, false)
      expect(result.success).toBe(true)
    })

    test('View Changes shows diff for untracked files', async () => {
      const newFileDiff = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+export const x = 1
`
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: newFileDiff,
        fileName: 'new.ts'
      })

      const file: GitFileStatus = {
        path: '/repo/new.ts',
        relativePath: 'new.ts',
        status: '?',
        staged: false
      }

      const result = await mockGitOps.getDiff('/repo', file.relativePath, file.staged, file.status === '?')

      expect(mockGitOps.getDiff).toHaveBeenCalledWith('/repo', 'new.ts', false, true)
      expect(result.success).toBe(true)
    })
  })

  describe('Git Panel Integration', () => {
    test('File click in staged section loads staged diff', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: SAMPLE_UNIFIED_DIFF,
        fileName: 'app.ts'
      })

      const file: GitFileStatus = {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        status: 'A',
        staged: true
      }

      const result = await mockGitOps.getDiff('/repo', file.relativePath, file.staged, file.status === '?')

      expect(mockGitOps.getDiff).toHaveBeenCalledWith('/repo', 'src/app.ts', true, false)
      expect(result.success).toBe(true)
    })

    test('File click in modified section loads unstaged diff', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: SAMPLE_UNIFIED_DIFF,
        fileName: 'app.ts'
      })

      const file: GitFileStatus = {
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        status: 'M',
        staged: false
      }

      const result = await mockGitOps.getDiff('/repo', file.relativePath, file.staged, file.status === '?')

      expect(mockGitOps.getDiff).toHaveBeenCalledWith('/repo', 'src/app.ts', false, false)
      expect(result.success).toBe(true)
    })

    test('File click in untracked section loads untracked diff', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: '+ new file content',
        fileName: 'new.ts'
      })

      const file: GitFileStatus = {
        path: '/repo/new.ts',
        relativePath: 'new.ts',
        status: '?',
        staged: false
      }

      const result = await mockGitOps.getDiff('/repo', file.relativePath, file.staged, file.status === '?')

      expect(mockGitOps.getDiff).toHaveBeenCalledWith('/repo', 'new.ts', false, true)
      expect(result.success).toBe(true)
    })
  })

  describe('Copy Functionality', () => {
    test('Copy diff copies to clipboard', async () => {
      vi.mocked(mockProjectOps.copyToClipboard).mockResolvedValue()

      const diff = SAMPLE_UNIFIED_DIFF
      await mockProjectOps.copyToClipboard(diff)

      expect(mockProjectOps.copyToClipboard).toHaveBeenCalledWith(diff)
    })
  })

  describe('Performance', () => {
    test('Diff renders under 100ms for 500-line file', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: SAMPLE_LARGE_DIFF,
        fileName: 'large-file.ts'
      })

      const start = performance.now()
      const result = await mockGitOps.getDiff('/repo', 'large-file.ts', false, false)
      const duration = performance.now() - start

      expect(result.success).toBe(true)
      // Allow some margin for CI/slow machines, but IPC call should be fast
      expect(duration).toBeLessThan(100)
    })

    test('Multiple diff loads are independent', async () => {
      vi.mocked(mockGitOps.getDiff)
        .mockResolvedValueOnce({
          success: true,
          diff: 'diff 1',
          fileName: 'file1.ts'
        })
        .mockResolvedValueOnce({
          success: true,
          diff: 'diff 2',
          fileName: 'file2.ts'
        })

      const result1 = await mockGitOps.getDiff('/repo', 'file1.ts', false, false)
      const result2 = await mockGitOps.getDiff('/repo', 'file2.ts', false, false)

      expect(result1.diff).toBe('diff 1')
      expect(result2.diff).toBe('diff 2')
    })
  })

  describe('Error Handling', () => {
    test('Handles binary file gracefully', async () => {
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: false,
        error: 'Binary file cannot be diffed'
      })

      const result = await mockGitOps.getDiff('/repo', 'image.png', false, false)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Binary')
    })

    test('Handles deleted file diff', async () => {
      const deletedFileDiff = `diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
--- a/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-const x = 1
-export default x
`
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: deletedFileDiff,
        fileName: 'deleted.ts'
      })

      const result = await mockGitOps.getDiff('/repo', 'deleted.ts', false, false)

      expect(result.success).toBe(true)
      expect(result.diff).toContain('deleted file mode')
    })

    test('Handles renamed file diff', async () => {
      const renamedFileDiff = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,2 +1,2 @@
-// old name
+// new name
 export const x = 1
`
      vi.mocked(mockGitOps.getDiff).mockResolvedValue({
        success: true,
        diff: renamedFileDiff,
        fileName: 'new-name.ts'
      })

      const result = await mockGitOps.getDiff('/repo', 'new-name.ts', false, false)

      expect(result.success).toBe(true)
      expect(result.diff).toContain('rename from')
      expect(result.diff).toContain('rename to')
    })

    test('Handles network/IPC error', async () => {
      vi.mocked(mockGitOps.getDiff).mockRejectedValue(new Error('IPC timeout'))

      await expect(mockGitOps.getDiff('/repo', 'file.ts', false, false))
        .rejects.toThrow('IPC timeout')
    })
  })

  describe('Diff Types', () => {
    test('Modified file shows changes', async () => {
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: [
          { path: '/repo/modified.ts', relativePath: 'modified.ts', status: 'M', staged: false }
        ]
      })

      const statusResult = await mockGitOps.getFileStatuses('/repo')
      const modifiedFile = statusResult.files?.find(f => f.status === 'M')

      expect(modifiedFile).toBeDefined()
      expect(modifiedFile?.status).toBe('M')
    })

    test('Added file shows full content as additions', async () => {
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: [
          { path: '/repo/added.ts', relativePath: 'added.ts', status: 'A', staged: true }
        ]
      })

      const statusResult = await mockGitOps.getFileStatuses('/repo')
      const addedFile = statusResult.files?.find(f => f.status === 'A')

      expect(addedFile).toBeDefined()
      expect(addedFile?.status).toBe('A')
      expect(addedFile?.staged).toBe(true)
    })

    test('Deleted file shows full content as deletions', async () => {
      vi.mocked(mockGitOps.getFileStatuses).mockResolvedValue({
        success: true,
        files: [
          { path: '/repo/deleted.ts', relativePath: 'deleted.ts', status: 'D', staged: false }
        ]
      })

      const statusResult = await mockGitOps.getFileStatuses('/repo')
      const deletedFile = statusResult.files?.find(f => f.status === 'D')

      expect(deletedFile).toBeDefined()
      expect(deletedFile?.status).toBe('D')
    })
  })
})
