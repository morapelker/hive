import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import React from 'react'

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------
const mockGetDiff = vi.fn().mockResolvedValue({
  success: true,
  diff: `diff --git a/src/App.tsx b/src/App.tsx
index 1234567..abcdefg 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1,5 +1,6 @@
 import React from 'react'
+import { useState } from 'react'

 function App() {
-  return <div>Hello</div>
+  return <div>Hello World</div>
 }
@@ -10,3 +11,5 @@
 export default App
+
+// New comment
`,
  fileName: 'App.tsx'
})

const mockGitOps = {
  getFileStatuses: vi.fn().mockResolvedValue({ success: true, files: [] }),
  getBranchInfo: vi.fn().mockResolvedValue({
    success: true,
    branch: { name: 'main', tracking: null, ahead: 0, behind: 0 }
  }),
  stageFile: vi.fn().mockResolvedValue({ success: true }),
  unstageFile: vi.fn().mockResolvedValue({ success: true }),
  stageAll: vi.fn().mockResolvedValue({ success: true }),
  unstageAll: vi.fn().mockResolvedValue({ success: true }),
  discardChanges: vi.fn().mockResolvedValue({ success: true }),
  addToGitignore: vi.fn().mockResolvedValue({ success: true }),
  commit: vi.fn().mockResolvedValue({ success: true }),
  push: vi.fn().mockResolvedValue({ success: true }),
  pull: vi.fn().mockResolvedValue({ success: true }),
  getDiff: mockGetDiff,
  openInEditor: vi.fn().mockResolvedValue({ success: true }),
  showInFinder: vi.fn().mockResolvedValue({ success: true }),
  onStatusChanged: vi.fn().mockReturnValue(() => {})
}

const mockProjectOps = {
  openDirectoryDialog: vi.fn(),
  isGitRepository: vi.fn(),
  validateProject: vi.fn(),
  showInFolder: vi.fn(),
  openPath: vi.fn(),
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  readFromClipboard: vi.fn(),
  detectLanguage: vi.fn(),
  loadLanguageIcons: vi.fn()
}

const mockDb = {
  setting: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getAll: vi.fn() },
  project: {
    create: vi.fn(),
    get: vi.fn(),
    getByPath: vi.fn(),
    getAll: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    delete: vi.fn(),
    touch: vi.fn()
  },
  worktree: {
    create: vi.fn(),
    get: vi.fn(),
    getByProject: vi.fn(),
    getActiveByProject: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    delete: vi.fn(),
    archive: vi.fn(),
    touch: vi.fn()
  },
  session: {
    create: vi.fn(),
    get: vi.fn(),
    getByWorktree: vi.fn(),
    getByProject: vi.fn(),
    getActiveByWorktree: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    delete: vi.fn(),
    search: vi.fn()
  },
  message: {
    create: vi.fn(),
    getBySession: vi.fn().mockResolvedValue([]),
    delete: vi.fn()
  },
  schemaVersion: vi.fn(),
  tableExists: vi.fn(),
  getIndexes: vi.fn()
}

const mockWorktreeOps = {
  create: vi.fn(),
  delete: vi.fn(),
  sync: vi.fn(),
  exists: vi.fn(),
  openInTerminal: vi.fn(),
  openInEditor: vi.fn(),
  getBranches: vi.fn(),
  branchExists: vi.fn(),
  duplicate: vi.fn()
}

const mockFileOps = {
  readFile: vi.fn().mockResolvedValue({ success: false }),
  readPrompt: vi.fn().mockResolvedValue({ success: false })
}

describe('Session 5: Inline Diff Viewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()

    Object.defineProperty(window, 'gitOps', { writable: true, value: mockGitOps })
    Object.defineProperty(window, 'projectOps', { writable: true, value: mockProjectOps })
    Object.defineProperty(window, 'db', { writable: true, value: mockDb })
    Object.defineProperty(window, 'worktreeOps', { writable: true, value: mockWorktreeOps })
    Object.defineProperty(window, 'fileOps', { writable: true, value: mockFileOps })
  })

  // ---------------------------------------------------------------------------
  // InlineDiffViewer component tests
  // ---------------------------------------------------------------------------
  describe('InlineDiffViewer', () => {
    test('renders diff content', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        React.createElement(InlineDiffViewer, {
          worktreePath: '/path/to/worktree',
          filePath: 'src/App.tsx',
          fileName: 'App.tsx',
          staged: false,
          isUntracked: false,
          onClose: vi.fn()
        })
      )

      await waitFor(() => {
        expect(screen.getByTestId('inline-diff-viewer')).toBeTruthy()
        expect(screen.getByTestId('diff-viewer')).toBeTruthy()
      })
    })

    test('toolbar shows nav arrows', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        React.createElement(InlineDiffViewer, {
          worktreePath: '/path/to/worktree',
          filePath: 'src/App.tsx',
          fileName: 'App.tsx',
          staged: false,
          isUntracked: false,
          onClose: vi.fn()
        })
      )

      await waitFor(() => {
        expect(screen.getByTestId('diff-prev-hunk')).toBeTruthy()
        expect(screen.getByTestId('diff-next-hunk')).toBeTruthy()
      })
    })

    test('shows filename in toolbar', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        React.createElement(InlineDiffViewer, {
          worktreePath: '/path/to/worktree',
          filePath: 'src/App.tsx',
          fileName: 'App.tsx',
          staged: false,
          isUntracked: false,
          onClose: vi.fn()
        })
      )

      await waitFor(() => {
        expect(screen.getByTestId('inline-diff-filename').textContent).toBe('App.tsx')
      })
    })

    test('context expansion increases contextLines', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        React.createElement(InlineDiffViewer, {
          worktreePath: '/path/to/worktree',
          filePath: 'src/App.tsx',
          fileName: 'App.tsx',
          staged: false,
          isUntracked: false,
          onClose: vi.fn()
        })
      )

      // Wait for initial load with default contextLines=3
      await waitFor(() => {
        expect(mockGetDiff).toHaveBeenCalledWith(
          '/path/to/worktree',
          'src/App.tsx',
          false,
          false,
          3
        )
      })

      // Click "More context"
      const expandBtn = screen.getByTestId('diff-expand-context')
      fireEvent.click(expandBtn)

      // Should re-fetch with contextLines=13
      await waitFor(() => {
        expect(mockGetDiff).toHaveBeenCalledWith(
          '/path/to/worktree',
          'src/App.tsx',
          false,
          false,
          13
        )
      })
    })

    test('copy button copies diff to clipboard', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        React.createElement(InlineDiffViewer, {
          worktreePath: '/path/to/worktree',
          filePath: 'src/App.tsx',
          fileName: 'App.tsx',
          staged: false,
          isUntracked: false,
          onClose: vi.fn()
        })
      )

      // Wait for diff to load
      await waitFor(() => {
        expect(screen.getByTestId('diff-viewer')).toBeTruthy()
      })

      // Click copy
      const copyBtn = screen.getByTestId('diff-copy-button')
      fireEvent.click(copyBtn)

      await waitFor(() => {
        expect(mockProjectOps.copyToClipboard).toHaveBeenCalled()
      })
    })

    test('close button calls onClose', async () => {
      const onClose = vi.fn()

      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        React.createElement(InlineDiffViewer, {
          worktreePath: '/path/to/worktree',
          filePath: 'src/App.tsx',
          fileName: 'App.tsx',
          staged: false,
          isUntracked: false,
          onClose
        })
      )

      await waitFor(() => {
        expect(screen.getByTestId('diff-close-button')).toBeTruthy()
      })

      fireEvent.click(screen.getByTestId('diff-close-button'))
      expect(onClose).toHaveBeenCalled()
    })

    test('unified/split toggle works', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        React.createElement(InlineDiffViewer, {
          worktreePath: '/path/to/worktree',
          filePath: 'src/App.tsx',
          fileName: 'App.tsx',
          staged: false,
          isUntracked: false,
          onClose: vi.fn()
        })
      )

      await waitFor(() => {
        expect(screen.getByTestId('diff-view-toggle')).toBeTruthy()
      })

      // Click toggle — should switch to split
      fireEvent.click(screen.getByTestId('diff-view-toggle'))

      // The toggle button changes icon; we verify it didn't crash
      expect(screen.getByTestId('diff-view-toggle')).toBeTruthy()
    })

    test('shows loading state', async () => {
      // Make getDiff hang
      mockGetDiff.mockImplementation(() => new Promise(() => {}))

      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        React.createElement(InlineDiffViewer, {
          worktreePath: '/path/to/worktree',
          filePath: 'src/App.tsx',
          fileName: 'App.tsx',
          staged: false,
          isUntracked: false,
          onClose: vi.fn()
        })
      )

      expect(screen.getByTestId('diff-loading')).toBeTruthy()
    })

    test('shows error state', async () => {
      mockGetDiff.mockResolvedValue({
        success: false,
        error: 'Git error'
      })

      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        React.createElement(InlineDiffViewer, {
          worktreePath: '/path/to/worktree',
          filePath: 'src/App.tsx',
          fileName: 'App.tsx',
          staged: false,
          isUntracked: false,
          onClose: vi.fn()
        })
      )

      await waitFor(() => {
        expect(screen.getByTestId('diff-error')).toBeTruthy()
        expect(screen.getByTestId('diff-error').textContent).toBe('Git error')
      })
    })

    test('getDiff called with staged=true for staged files', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        React.createElement(InlineDiffViewer, {
          worktreePath: '/path/to/worktree',
          filePath: 'src/App.tsx',
          fileName: 'App.tsx',
          staged: true,
          isUntracked: false,
          onClose: vi.fn()
        })
      )

      await waitFor(() => {
        expect(mockGetDiff).toHaveBeenCalledWith('/path/to/worktree', 'src/App.tsx', true, false, 3)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // useFileViewerStore activeDiff tests
  // ---------------------------------------------------------------------------
  describe('useFileViewerStore activeDiff', () => {
    test('setActiveDiff sets diff and sets activeFilePath to diff tab key', async () => {
      const { useFileViewerStore } =
        await import('../../../src/renderer/src/stores/useFileViewerStore')

      // Set a file first
      useFileViewerStore.getState().setActiveFile('/some/file.ts')
      expect(useFileViewerStore.getState().activeFilePath).toBe('/some/file.ts')

      // Set active diff — now creates a diff tab entry
      useFileViewerStore.getState().setActiveDiff({
        worktreePath: '/path/to/worktree',
        filePath: 'src/App.tsx',
        fileName: 'App.tsx',
        staged: false,
        isUntracked: false
      })

      const state = useFileViewerStore.getState()
      expect(state.activeDiff).not.toBeNull()
      expect(state.activeDiff?.filePath).toBe('src/App.tsx')
      expect(state.activeFilePath).toBe('diff:src/App.tsx:unstaged')
    })

    test('clearActiveDiff clears diff', async () => {
      const { useFileViewerStore } =
        await import('../../../src/renderer/src/stores/useFileViewerStore')

      useFileViewerStore.getState().setActiveDiff({
        worktreePath: '/path/to/worktree',
        filePath: 'src/App.tsx',
        fileName: 'App.tsx',
        staged: false,
        isUntracked: false
      })

      expect(useFileViewerStore.getState().activeDiff).not.toBeNull()

      useFileViewerStore.getState().clearActiveDiff()
      expect(useFileViewerStore.getState().activeDiff).toBeNull()
    })

    test('setActiveFile clears activeDiff', async () => {
      const { useFileViewerStore } =
        await import('../../../src/renderer/src/stores/useFileViewerStore')

      useFileViewerStore.getState().setActiveDiff({
        worktreePath: '/path/to/worktree',
        filePath: 'src/App.tsx',
        fileName: 'App.tsx',
        staged: false,
        isUntracked: false
      })

      useFileViewerStore.getState().setActiveFile('/some/file.ts')

      const state = useFileViewerStore.getState()
      expect(state.activeDiff).toBeNull()
      expect(state.activeFilePath).toBe('/some/file.ts')
    })

    test('openFile clears activeDiff', async () => {
      const { useFileViewerStore } =
        await import('../../../src/renderer/src/stores/useFileViewerStore')

      useFileViewerStore.getState().setActiveDiff({
        worktreePath: '/path/to/worktree',
        filePath: 'src/App.tsx',
        fileName: 'App.tsx',
        staged: false,
        isUntracked: false
      })

      useFileViewerStore.getState().openFile('/some/file.ts', 'file.ts', 'wt-1')

      const state = useFileViewerStore.getState()
      expect(state.activeDiff).toBeNull()
      expect(state.activeFilePath).toBe('/some/file.ts')
    })
  })

  // ---------------------------------------------------------------------------
  // GitStatusPanel opens inline diff tests
  // ---------------------------------------------------------------------------
  describe('GitStatusPanel opens inline diff', () => {
    test('file click in GitStatusPanel calls setActiveDiff', async () => {
      mockGitOps.getFileStatuses.mockResolvedValue({
        success: true,
        files: [
          { path: '/path/src/App.tsx', relativePath: 'src/App.tsx', status: 'M', staged: false }
        ]
      })

      const { useFileViewerStore } =
        await import('../../../src/renderer/src/stores/useFileViewerStore')

      const { GitStatusPanel } =
        await import('../../../src/renderer/src/components/git/GitStatusPanel')

      render(React.createElement(GitStatusPanel, { worktreePath: '/path/to/worktree' }))

      // Wait for files to load
      await waitFor(() => {
        expect(screen.getByTestId('git-file-item-src/App.tsx')).toBeTruthy()
      })

      // Click the file name to view diff
      const viewDiffBtn = screen.getByTestId('view-diff-src/App.tsx')
      fireEvent.click(viewDiffBtn)

      // Verify setActiveDiff was called (check store state)
      const state = useFileViewerStore.getState()
      expect(state.activeDiff).not.toBeNull()
      expect(state.activeDiff?.filePath).toBe('src/App.tsx')
      expect(state.activeDiff?.worktreePath).toBe('/path/to/worktree')
      expect(state.activeDiff?.staged).toBe(false)
      expect(state.activeDiff?.isUntracked).toBe(false)
    })

    test('staged file sets staged=true in activeDiff', async () => {
      mockGitOps.getFileStatuses.mockResolvedValue({
        success: true,
        files: [
          { path: '/path/src/App.tsx', relativePath: 'src/App.tsx', status: 'M', staged: true }
        ]
      })

      const { useFileViewerStore } =
        await import('../../../src/renderer/src/stores/useFileViewerStore')

      const { GitStatusPanel } =
        await import('../../../src/renderer/src/components/git/GitStatusPanel')

      render(React.createElement(GitStatusPanel, { worktreePath: '/path/to/worktree' }))

      await waitFor(() => {
        expect(screen.getByTestId('git-file-item-src/App.tsx')).toBeTruthy()
      })

      const viewDiffBtn = screen.getByTestId('view-diff-src/App.tsx')
      fireEvent.click(viewDiffBtn)

      const state = useFileViewerStore.getState()
      expect(state.activeDiff?.staged).toBe(true)
    })

    test('untracked file sets isUntracked=true in activeDiff', async () => {
      mockGitOps.getFileStatuses.mockResolvedValue({
        success: true,
        files: [
          { path: '/path/src/New.tsx', relativePath: 'src/New.tsx', status: '?', staged: false }
        ]
      })

      const { useFileViewerStore } =
        await import('../../../src/renderer/src/stores/useFileViewerStore')

      const { GitStatusPanel } =
        await import('../../../src/renderer/src/components/git/GitStatusPanel')

      render(React.createElement(GitStatusPanel, { worktreePath: '/path/to/worktree' }))

      await waitFor(() => {
        expect(screen.getByTestId('git-file-item-src/New.tsx')).toBeTruthy()
      })

      const viewDiffBtn = screen.getByTestId('view-diff-src/New.tsx')
      fireEvent.click(viewDiffBtn)

      const state = useFileViewerStore.getState()
      expect(state.activeDiff?.isUntracked).toBe(true)
    })
  })
})
