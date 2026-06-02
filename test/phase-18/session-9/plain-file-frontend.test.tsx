import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import {
  useFileViewerStore,
  type ActiveDiff
} from '../../../src/renderer/src/stores/useFileViewerStore'

describe('Session 9: Plain File Rendering Frontend', () => {
  // ── Store: isNewFile field in interfaces ──────────────────────────────────
  describe('useFileViewerStore isNewFile support', () => {
    beforeEach(() => {
      useFileViewerStore.setState({
        openFiles: new Map(),
        activeFilePath: null,
        activeDiff: null
      })
    })

    test('setActiveDiff stores isNewFile: true for untracked files', () => {
      const diff: ActiveDiff = {
        worktreePath: '/path/to/worktree',
        filePath: 'src/new-file.ts',
        fileName: 'new-file.ts',
        staged: false,
        isUntracked: true,
        isNewFile: true
      }

      useFileViewerStore.getState().setActiveDiff(diff)

      const stored = useFileViewerStore.getState().activeDiff
      expect(stored).toBeDefined()
      expect(stored?.isNewFile).toBe(true)
      expect(stored?.isUntracked).toBe(true)
    })

    test('setActiveDiff stores isNewFile: true for staged added files', () => {
      const diff: ActiveDiff = {
        worktreePath: '/path/to/worktree',
        filePath: 'src/added-file.ts',
        fileName: 'added-file.ts',
        staged: true,
        isUntracked: false,
        isNewFile: true
      }

      useFileViewerStore.getState().setActiveDiff(diff)

      const stored = useFileViewerStore.getState().activeDiff
      expect(stored?.isNewFile).toBe(true)
      expect(stored?.staged).toBe(true)
    })

    test('setActiveDiff stores isNewFile: false for modified files', () => {
      const diff: ActiveDiff = {
        worktreePath: '/path/to/worktree',
        filePath: 'src/modified.ts',
        fileName: 'modified.ts',
        staged: false,
        isUntracked: false,
        isNewFile: false
      }

      useFileViewerStore.getState().setActiveDiff(diff)

      const stored = useFileViewerStore.getState().activeDiff
      expect(stored?.isNewFile).toBe(false)
    })

    test('setActiveDiff without isNewFile defaults to undefined', () => {
      const diff: ActiveDiff = {
        worktreePath: '/path/to/worktree',
        filePath: 'src/file.ts',
        fileName: 'file.ts',
        staged: false,
        isUntracked: false
      }

      useFileViewerStore.getState().setActiveDiff(diff)

      const stored = useFileViewerStore.getState().activeDiff
      expect(stored?.isNewFile).toBeUndefined()
    })

    test('isNewFile is persisted in DiffTab via openFiles', () => {
      const diff: ActiveDiff = {
        worktreePath: '/path/to/worktree',
        filePath: 'src/new.ts',
        fileName: 'new.ts',
        staged: false,
        isUntracked: true,
        isNewFile: true
      }

      useFileViewerStore.getState().setActiveDiff(diff)

      const tabKey = 'diff:src/new.ts:unstaged'
      const tab = useFileViewerStore.getState().openFiles.get(tabKey)
      expect(tab).toBeDefined()
      expect(tab?.type).toBe('diff')
      if (tab?.type === 'diff') {
        expect(tab.isNewFile).toBe(true)
      }
    })

    test('activateDiffTab restores isNewFile from DiffTab', () => {
      // First set a diff tab with isNewFile
      const diff: ActiveDiff = {
        worktreePath: '/path/to/worktree',
        filePath: 'src/new.ts',
        fileName: 'new.ts',
        staged: false,
        isUntracked: true,
        isNewFile: true
      }
      useFileViewerStore.getState().setActiveDiff(diff)

      // Now clear active diff
      useFileViewerStore.getState().clearActiveDiff()
      expect(useFileViewerStore.getState().activeDiff).toBeNull()

      // Reactivate the tab
      const tabKey = 'diff:src/new.ts:unstaged'
      useFileViewerStore.getState().activateDiffTab(tabKey)

      const restored = useFileViewerStore.getState().activeDiff
      expect(restored).toBeDefined()
      expect(restored?.isNewFile).toBe(true)
      expect(restored?.filePath).toBe('src/new.ts')
    })
  })

  // ── Call site behavior (unit-level contracts) ─────────────────────────────
  describe('handleViewDiff isNewFile logic', () => {
    function computeIsNewFile(status: string): boolean {
      return status === '?' || status === 'A'
    }

    test('untracked files (status "?") set isNewFile to true', () => {
      expect(computeIsNewFile('?')).toBe(true)
    })

    test('added files (status "A") set isNewFile to true', () => {
      expect(computeIsNewFile('A')).toBe(true)
    })

    test('modified files (status "M") set isNewFile to false', () => {
      expect(computeIsNewFile('M')).toBe(false)
    })

    test('deleted files (status "D") set isNewFile to false', () => {
      expect(computeIsNewFile('D')).toBe(false)
    })

    test('conflicted files (status "C") set isNewFile to false', () => {
      expect(computeIsNewFile('C')).toBe(false)
    })
  })

  // ── InlineDiffViewer behavior ─────────────────────────────────────────────
  describe('InlineDiffViewer isNewFile behavior', () => {
    let mockGetFileContent: ReturnType<typeof vi.fn>
    let mockGetDiff: ReturnType<typeof vi.fn>

    beforeEach(() => {
      mockGetFileContent = vi.fn().mockResolvedValue({
        success: true,
        content: 'const x = 1\nexport default x'
      })
      mockGetDiff = vi.fn().mockResolvedValue({
        success: true,
        diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new'
      })

      Object.defineProperty(window, 'gitOps', {
        writable: true,
        configurable: true,
        value: {
          ...window.gitOps,
          getFileContent: mockGetFileContent,
          getDiff: mockGetDiff
        }
      })

      Object.defineProperty(window, 'projectOps', {
        writable: true,
        configurable: true,
        value: {
          copyToClipboard: vi.fn().mockResolvedValue(undefined)
        }
      })
    })

    test('fetches raw content via getFileContent when isNewFile is true', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        <InlineDiffViewer
          worktreePath="/worktree"
          filePath="src/new-file.ts"
          fileName="new-file.ts"
          staged={false}
          isUntracked={true}
          isNewFile={true}
          onClose={vi.fn()}
        />
      )

      await waitFor(() => {
        expect(mockGetFileContent).toHaveBeenCalledWith('/worktree', 'src/new-file.ts')
      })
      expect(mockGetDiff).not.toHaveBeenCalled()
    })

    test('fetches diff via getDiff when isNewFile is false', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        <InlineDiffViewer
          worktreePath="/worktree"
          filePath="src/modified.ts"
          fileName="modified.ts"
          staged={false}
          isUntracked={false}
          isNewFile={false}
          onClose={vi.fn()}
        />
      )

      await waitFor(() => {
        expect(mockGetDiff).toHaveBeenCalled()
      })
      expect(mockGetFileContent).not.toHaveBeenCalled()
    })

    test('fetches diff when isNewFile is undefined (backward compat)', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      render(
        <InlineDiffViewer
          worktreePath="/worktree"
          filePath="src/file.ts"
          fileName="file.ts"
          staged={false}
          isUntracked={false}
          onClose={vi.fn()}
        />
      )

      await waitFor(() => {
        expect(mockGetDiff).toHaveBeenCalled()
      })
      expect(mockGetFileContent).not.toHaveBeenCalled()
    })

    test('renders plain file content with syntax highlighting for new files', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      const { container } = render(
        <InlineDiffViewer
          worktreePath="/worktree"
          filePath="src/new-file.ts"
          fileName="new-file.ts"
          staged={false}
          isUntracked={true}
          isNewFile={true}
          onClose={vi.fn()}
        />
      )

      await waitFor(() => {
        const plainContent = container.querySelector('[data-testid="plain-file-content"]')
        expect(plainContent).toBeInTheDocument()
      })
    })

    test('shows "New file" status label when isNewFile is true', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      const { getByText } = render(
        <InlineDiffViewer
          worktreePath="/worktree"
          filePath="src/new-file.ts"
          fileName="new-file.ts"
          staged={false}
          isUntracked={true}
          isNewFile={true}
          onClose={vi.fn()}
        />
      )

      expect(getByText('New file')).toBeInTheDocument()
    })

    test('shows "New file" for staged added files (isNewFile=true, staged=true)', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      const { getByText } = render(
        <InlineDiffViewer
          worktreePath="/worktree"
          filePath="src/added.ts"
          fileName="added.ts"
          staged={true}
          isUntracked={false}
          isNewFile={true}
          onClose={vi.fn()}
        />
      )

      expect(getByText('New file')).toBeInTheDocument()
    })

    test('shows "Staged" for staged modified files', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      const { getByText } = render(
        <InlineDiffViewer
          worktreePath="/worktree"
          filePath="src/modified.ts"
          fileName="modified.ts"
          staged={true}
          isUntracked={false}
          isNewFile={false}
          onClose={vi.fn()}
        />
      )

      expect(getByText('Staged')).toBeInTheDocument()
    })

    test('shows "Unstaged" for unstaged modified files', async () => {
      const { InlineDiffViewer } =
        await import('../../../src/renderer/src/components/diff/InlineDiffViewer')

      const { getByText } = render(
        <InlineDiffViewer
          worktreePath="/worktree"
          filePath="src/modified.ts"
          fileName="modified.ts"
          staged={false}
          isUntracked={false}
          isNewFile={false}
          onClose={vi.fn()}
        />
      )

      expect(getByText('Unstaged')).toBeInTheDocument()
    })
  })
})
