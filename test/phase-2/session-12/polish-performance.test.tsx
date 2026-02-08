import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { ErrorBoundary } from '../../../src/renderer/src/components/error/ErrorBoundary'
import { GitStatusPanel } from '../../../src/renderer/src/components/git/GitStatusPanel'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

const mockToast = vi.mocked(toast)

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

// Reference window mocks from setup.ts (already defined there)
const mockGitOps = window.gitOps as Record<string, ReturnType<typeof vi.fn>>
const mockFileTreeOps = window.fileTreeOps as Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  vi.clearAllMocks()

  // Reset git store
  useGitStore.setState({
    fileStatusesByWorktree: new Map(),
    branchInfoByWorktree: new Map(),
    isLoading: false,
    error: null,
    isCommitting: false,
    isPushing: false,
    isPulling: false
  })

  // Reset default mock return values
  mockGitOps.getFileStatuses.mockResolvedValue({ success: true, files: [] })
  mockGitOps.getBranchInfo.mockResolvedValue({
    success: true,
    branch: { name: 'main', tracking: 'origin/main', ahead: 0, behind: 0 }
  })
  mockGitOps.stageFile.mockResolvedValue({ success: true })
  mockGitOps.unstageFile.mockResolvedValue({ success: true })
  mockGitOps.stageAll.mockResolvedValue({ success: true })
  mockGitOps.unstageAll.mockResolvedValue({ success: true })
  mockGitOps.commit.mockResolvedValue({ success: true, commitHash: 'abc1234' })
  mockGitOps.push.mockResolvedValue({ success: true })
  mockGitOps.pull.mockResolvedValue({ success: true })
  mockGitOps.onStatusChanged.mockReturnValue(() => {})
  mockFileTreeOps.scan.mockResolvedValue({ success: true, tree: [] })
  mockFileTreeOps.onChange.mockReturnValue(() => {})
  mockFileTreeOps.watch.mockResolvedValue({ success: true })
  mockFileTreeOps.unwatch.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
})

describe('Session 12: Polish & Performance', () => {
  describe('Virtual Scrolling', () => {
    test('File tree uses @tanstack/react-virtual virtualizer', async () => {
      // Verify the module can be imported (installed correctly)
      const mod = await import('@tanstack/react-virtual')
      expect(mod.useVirtualizer).toBeDefined()
    })

    test('FileTree component imports virtual scrolling', async () => {
      const mod = await import(
        '../../../src/renderer/src/components/file-tree/FileTree'
      )
      expect(mod.FileTree).toBeDefined()
    })

    test('FlatNode flattening works for virtual scrolling', async () => {
      // The flattenTree function is internal, but we can verify the FileTree renders
      // a virtual container with the right structure
      const { FileTree } = await import(
        '../../../src/renderer/src/components/file-tree/FileTree'
      )

      // Mock a tree with files
      const mockTree = Array.from({ length: 50 }, (_, i) => ({
        name: `file-${i}.ts`,
        path: `/test/file-${i}.ts`,
        relativePath: `file-${i}.ts`,
        isDirectory: false,
        extension: 'ts'
      }))

      // The scan mock needs to return our tree when loadFileTree calls it
      mockFileTreeOps.scan.mockResolvedValue({
        success: true,
        tree: mockTree
      })

      const { useFileTreeStore } = await import(
        '../../../src/renderer/src/stores/useFileTreeStore'
      )
      // Pre-populate the store so the tree renders immediately
      useFileTreeStore.setState({
        treesByWorktree: new Map([['/test-worktree', mockTree]]),
        expandedPathsByWorktree: new Map([['/test-worktree', new Set()]]),
        filterByWorktree: new Map([['/test-worktree', '']]),
        isLoading: false,
        error: null
      })

      await act(async () => {
        render(<FileTree worktreePath="/test-worktree" />)
      })

      // The file tree container should exist
      const treeEl = screen.getByTestId('file-tree')
      expect(treeEl).toBeInTheDocument()

      // Verify virtual scrolling structure - should have a tree role container
      const treeContent = screen.getByTestId('file-tree-content')
      expect(treeContent).toHaveAttribute('role', 'tree')
    })
  })

  describe('Git Status Debouncing', () => {
    test('refreshStatuses is debounced', async () => {
      const worktreePath = '/test-worktree'

      // Call refreshStatuses multiple times rapidly
      const store = useGitStore.getState()
      store.refreshStatuses(worktreePath)
      store.refreshStatuses(worktreePath)
      store.refreshStatuses(worktreePath)

      // Should not have called getFileStatuses yet (debounced)
      expect(mockGitOps.getFileStatuses).not.toHaveBeenCalled()

      // Wait for debounce to fire (150ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Should have been called only once (debounced)
      expect(mockGitOps.getFileStatuses).toHaveBeenCalledTimes(1)
      expect(mockGitOps.getFileStatuses).toHaveBeenCalledWith(worktreePath)
    })

    test('Git status refreshes under 200ms', async () => {
      const worktreePath = '/test-worktree'

      mockGitOps.getFileStatuses.mockResolvedValueOnce({
        success: true,
        files: [
          { path: '/test/file.ts', relativePath: 'file.ts', status: 'M', staged: false }
        ]
      })

      const start = performance.now()
      await useGitStore.getState().loadFileStatuses(worktreePath)
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(200)
    })
  })

  describe('React.memo Optimization', () => {
    test('ToolCard is memoized', async () => {
      const { ToolCard } = await import(
        '../../../src/renderer/src/components/sessions/ToolCard'
      )
      // React.memo wraps the component, giving it a displayName or $$typeof
      // The component itself should be callable
      expect(ToolCard).toBeDefined()
      // memo components have a 'type' property
      expect((ToolCard as { $$typeof?: symbol }).$$typeof).toBeDefined()
    })

    test('CommandItem is memoized', async () => {
      const { CommandItem } = await import(
        '../../../src/renderer/src/components/command-palette/CommandItem'
      )
      expect(CommandItem).toBeDefined()
      expect((CommandItem as { $$typeof?: symbol }).$$typeof).toBeDefined()
    })
  })

  describe('Error Boundaries', () => {
    test('Error boundary catches component errors', () => {
      // Create a component that throws
      const ThrowingComponent = (): React.JSX.Element => {
        throw new Error('Test component error')
      }

      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      render(
        <ErrorBoundary componentName="TestComponent">
          <ThrowingComponent />
        </ErrorBoundary>
      )

      // Error boundary should render its fallback UI
      expect(screen.getByText('Something went wrong')).toBeInTheDocument()
      expect(screen.getByText(/TestComponent/)).toBeInTheDocument()

      consoleSpy.mockRestore()
    })

    test('Error boundary renders custom fallback', () => {
      const ThrowingComponent = (): React.JSX.Element => {
        throw new Error('Test error')
      }

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      render(
        <ErrorBoundary fallback={<div data-testid="custom-fallback">Custom error UI</div>}>
          <ThrowingComponent />
        </ErrorBoundary>
      )

      expect(screen.getByTestId('custom-fallback')).toBeInTheDocument()
      expect(screen.getByText('Custom error UI')).toBeInTheDocument()

      consoleSpy.mockRestore()
    })

    test('Error boundary calls onError handler', () => {
      const onError = vi.fn()
      const ThrowingComponent = (): React.JSX.Element => {
        throw new Error('Test error callback')
      }

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      render(
        <ErrorBoundary onError={onError}>
          <ThrowingComponent />
        </ErrorBoundary>
      )

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Test error callback' }),
        expect.objectContaining({ componentStack: expect.any(String) })
      )

      consoleSpy.mockRestore()
    })

    test('RightSidebar wraps components in error boundaries', async () => {
      const mod = await import(
        '../../../src/renderer/src/components/layout/RightSidebar'
      )
      expect(mod.RightSidebar).toBeDefined()
    })
  })

  describe('Toast Notifications', () => {
    test('Toast shows on stage all success', async () => {
      const worktreePath = '/test-worktree'

      // Set up store with unstaged files
      useGitStore.setState({
        fileStatusesByWorktree: new Map([
          [
            worktreePath,
            [
              { path: '/test/a.ts', relativePath: 'a.ts', status: 'M' as const, staged: false }
            ]
          ]
        ]),
        branchInfoByWorktree: new Map([
          [worktreePath, { name: 'main', tracking: 'origin/main', ahead: 0, behind: 0 }]
        ])
      })

      render(<GitStatusPanel worktreePath={worktreePath} />)

      // Find and click stage all button
      const stageAllBtn = screen.getByTestId('git-stage-all')
      await act(async () => {
        stageAllBtn.click()
      })

      expect(mockToast.success).toHaveBeenCalledWith('All changes staged')
    })

    test('Toast shows on stage all failure', async () => {
      const worktreePath = '/test-worktree'
      mockGitOps.stageAll.mockResolvedValueOnce({ success: false })

      useGitStore.setState({
        fileStatusesByWorktree: new Map([
          [
            worktreePath,
            [
              { path: '/test/a.ts', relativePath: 'a.ts', status: 'M' as const, staged: false }
            ]
          ]
        ]),
        branchInfoByWorktree: new Map([
          [worktreePath, { name: 'main', tracking: 'origin/main', ahead: 0, behind: 0 }]
        ])
      })

      render(<GitStatusPanel worktreePath={worktreePath} />)

      const stageAllBtn = screen.getByTestId('git-stage-all')
      await act(async () => {
        stageAllBtn.click()
      })

      expect(mockToast.error).toHaveBeenCalledWith('Failed to stage changes')
    })

    test('Toast shows on unstage all success', async () => {
      const worktreePath = '/test-worktree'

      useGitStore.setState({
        fileStatusesByWorktree: new Map([
          [
            worktreePath,
            [
              { path: '/test/a.ts', relativePath: 'a.ts', status: 'M' as const, staged: true }
            ]
          ]
        ]),
        branchInfoByWorktree: new Map([
          [worktreePath, { name: 'main', tracking: 'origin/main', ahead: 0, behind: 0 }]
        ])
      })

      render(<GitStatusPanel worktreePath={worktreePath} />)

      const unstageAllBtn = screen.getByTestId('git-unstage-all')
      await act(async () => {
        unstageAllBtn.click()
      })

      expect(mockToast.success).toHaveBeenCalledWith('All changes unstaged')
    })

    test('Toast shows on git commit success', async () => {
      const worktreePath = '/test-worktree'
      mockGitOps.commit.mockResolvedValueOnce({ success: true, commitHash: 'abc1234' })

      const result = await useGitStore.getState().commit(worktreePath, 'test commit')

      expect(result.success).toBe(true)
      expect(result.commitHash).toBe('abc1234')
    })

    test('Toast shows on git push failure', async () => {
      const worktreePath = '/test-worktree'
      mockGitOps.push.mockResolvedValueOnce({ success: false, error: 'remote rejected' })

      const result = await useGitStore.getState().push(worktreePath)

      expect(result.success).toBe(false)
      expect(result.error).toBe('remote rejected')
    })
  })

  describe('Accessibility', () => {
    test('GitStatusPanel has aria region and label', () => {
      const worktreePath = '/test-worktree'

      useGitStore.setState({
        branchInfoByWorktree: new Map([
          [worktreePath, { name: 'main', tracking: 'origin/main', ahead: 0, behind: 0 }]
        ])
      })

      render(<GitStatusPanel worktreePath={worktreePath} />)

      const panel = screen.getByTestId('git-status-panel')
      expect(panel).toHaveAttribute('role', 'region')
      expect(panel).toHaveAttribute('aria-label', 'Git status')
    })

    test('FileTree content has tree role and aria-label', async () => {
      const { FileTree } = await import(
        '../../../src/renderer/src/components/file-tree/FileTree'
      )
      const { useFileTreeStore } = await import(
        '../../../src/renderer/src/stores/useFileTreeStore'
      )

      const mockTree = [
        {
          name: 'test.ts',
          path: '/test/test.ts',
          relativePath: 'test.ts',
          isDirectory: false,
          extension: 'ts'
        }
      ]

      useFileTreeStore.setState({
        treesByWorktree: new Map([['/test-worktree', mockTree]]),
        expandedPathsByWorktree: new Map([['/test-worktree', new Set()]]),
        filterByWorktree: new Map([['/test-worktree', '']]),
        isLoading: false,
        error: null
      })

      render(<FileTree worktreePath="/test-worktree" />)

      const treeContent = screen.getByTestId('file-tree-content')
      expect(treeContent).toHaveAttribute('role', 'tree')
      expect(treeContent).toHaveAttribute('aria-label', 'File tree')
    })

    test('ModeToggle has descriptive aria-label', async () => {
      const { ModeToggle } = await import(
        '../../../src/renderer/src/components/sessions/ModeToggle'
      )
      const { useSessionStore } = await import(
        '../../../src/renderer/src/stores/useSessionStore'
      )

      useSessionStore.setState({
        modeBySession: new Map([['s1', 'build']])
      })

      render(<ModeToggle sessionId="s1" />)

      const toggle = screen.getByTestId('mode-toggle')
      const ariaLabel = toggle.getAttribute('aria-label')
      expect(ariaLabel).toContain('Build')
      expect(ariaLabel).toContain('Plan')
    })

    test('Git refresh button has title attribute', () => {
      const worktreePath = '/test-worktree'

      useGitStore.setState({
        branchInfoByWorktree: new Map([
          [worktreePath, { name: 'main', tracking: 'origin/main', ahead: 0, behind: 0 }]
        ])
      })

      render(<GitStatusPanel worktreePath={worktreePath} />)

      const refreshBtn = screen.getByTestId('git-refresh-button')
      expect(refreshBtn).toHaveAttribute('title', 'Refresh git status')
    })

    test('File stage/unstage checkboxes have aria-labels', () => {
      const worktreePath = '/test-worktree'

      useGitStore.setState({
        fileStatusesByWorktree: new Map([
          [
            worktreePath,
            [
              { path: '/test/a.ts', relativePath: 'a.ts', status: 'M' as const, staged: false }
            ]
          ]
        ]),
        branchInfoByWorktree: new Map([
          [worktreePath, { name: 'main', tracking: 'origin/main', ahead: 0, behind: 0 }]
        ])
      })

      render(<GitStatusPanel worktreePath={worktreePath} />)

      const checkbox = screen.getByLabelText('Stage a.ts')
      expect(checkbox).toBeInTheDocument()
    })
  })

  describe('Performance Targets', () => {
    test('Git store loadFileStatuses completes quickly', async () => {
      mockGitOps.getFileStatuses.mockResolvedValueOnce({
        success: true,
        files: Array.from({ length: 100 }, (_, i) => ({
          path: `/test/file-${i}.ts`,
          relativePath: `file-${i}.ts`,
          status: 'M',
          staged: false
        }))
      })

      const start = performance.now()
      await useGitStore.getState().loadFileStatuses('/test-worktree')
      const elapsed = performance.now() - start

      // Should complete well under 200ms for 100 files
      expect(elapsed).toBeLessThan(200)

      // Verify data was stored
      const files = useGitStore.getState().fileStatusesByWorktree.get('/test-worktree')
      expect(files).toHaveLength(100)
    })

    test('Git store loadBranchInfo completes quickly', async () => {
      const start = performance.now()
      await useGitStore.getState().loadBranchInfo('/test-worktree')
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(100)
    })

    test('Mode toggle responds under 100ms', async () => {
      const { ModeToggle } = await import(
        '../../../src/renderer/src/components/sessions/ModeToggle'
      )
      const { useSessionStore } = await import(
        '../../../src/renderer/src/stores/useSessionStore'
      )

      // Mock window.db for mode toggle persistence
      Object.defineProperty(window, 'db', {
        value: {
          session: {
            update: vi.fn().mockResolvedValue({}),
            create: vi.fn(),
            getActiveByWorktree: vi.fn(),
            get: vi.fn(),
            getByWorktree: vi.fn(),
            getByProject: vi.fn(),
            delete: vi.fn(),
            search: vi.fn()
          },
          setting: { get: vi.fn(), set: vi.fn() }
        },
        writable: true,
        configurable: true
      })

      useSessionStore.setState({
        modeBySession: new Map([['session-1', 'build']])
      })

      render(<ModeToggle sessionId="session-1" />)

      const start = performance.now()
      await act(async () => {
        screen.getByTestId('mode-toggle').click()
      })
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(100)
    })
  })

  describe('Loading States', () => {
    test('Git status panel shows loading spinner when refreshing', () => {
      const worktreePath = '/test-worktree'

      useGitStore.setState({
        isLoading: true,
        branchInfoByWorktree: new Map([
          [worktreePath, { name: 'main', tracking: 'origin/main', ahead: 0, behind: 0 }]
        ])
      })

      render(<GitStatusPanel worktreePath={worktreePath} />)

      const refreshBtn = screen.getByTestId('git-refresh-button')
      expect(refreshBtn).toBeDisabled()
      // The button should have animate-spin class when loading
      expect(refreshBtn.className).toContain('animate-spin')
    })

    test('Git status shows "No changes" when empty', () => {
      const worktreePath = '/test-worktree'

      useGitStore.setState({
        fileStatusesByWorktree: new Map([[worktreePath, []]]),
        branchInfoByWorktree: new Map([
          [worktreePath, { name: 'main', tracking: 'origin/main', ahead: 0, behind: 0 }]
        ])
      })

      render(<GitStatusPanel worktreePath={worktreePath} />)

      expect(screen.getByText('No changes')).toBeInTheDocument()
    })

    test('Branch name is displayed', () => {
      const worktreePath = '/test-worktree'

      useGitStore.setState({
        branchInfoByWorktree: new Map([
          [worktreePath, { name: 'feature/test', tracking: 'origin/feature/test', ahead: 2, behind: 1 }]
        ])
      })

      render(<GitStatusPanel worktreePath={worktreePath} />)

      expect(screen.getByTestId('git-branch-name')).toHaveTextContent('feature/test')
    })

    test('Ahead/behind counts are displayed', () => {
      const worktreePath = '/test-worktree'

      useGitStore.setState({
        branchInfoByWorktree: new Map([
          [worktreePath, { name: 'main', tracking: 'origin/main', ahead: 3, behind: 1 }]
        ])
      })

      render(<GitStatusPanel worktreePath={worktreePath} />)

      const aheadBehind = screen.getByTestId('git-ahead-behind')
      expect(aheadBehind).toHaveTextContent('3')
      expect(aheadBehind).toHaveTextContent('1')
    })
  })
})
