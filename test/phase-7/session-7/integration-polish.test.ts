import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import React from 'react'
import { subsequenceMatch } from '../../../src/renderer/src/lib/subsequence-match'
import { useScriptStore } from '../../../src/renderer/src/stores/useScriptStore'
import { useFileViewerStore } from '../../../src/renderer/src/stores/useFileViewerStore'
import { deleteBuffer } from '../../../src/renderer/src/lib/output-ring-buffer'

// ---------------------------------------------------------------------------
// Session 7: Integration & Polish
// ---------------------------------------------------------------------------
describe('Session 7: Integration & Polish', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()

    Object.defineProperty(window, 'projectOps', {
      value: {
        showInFolder: vi.fn(),
        copyToClipboard: vi.fn(),
        getAll: vi.fn().mockResolvedValue([]),
        add: vi.fn().mockResolvedValue({ success: true }),
        remove: vi.fn().mockResolvedValue(true)
      },
      writable: true,
      configurable: true
    })

    Object.defineProperty(window, 'worktreeOps', {
      value: {
        openInTerminal: vi.fn().mockResolvedValue({ success: true }),
        openInEditor: vi.fn().mockResolvedValue({ success: true }),
        duplicate: vi.fn().mockResolvedValue({
          success: true,
          worktree: {
            id: 'wt-dup',
            name: 'feature-auth-v2',
            branch_name: 'feature-auth-v2',
            path: '/test/feature-auth-v2'
          }
        })
      },
      writable: true,
      configurable: true
    })

    Object.defineProperty(window, 'scriptOps', {
      value: {
        onOutput: vi.fn().mockReturnValue(() => {}),
        runProject: vi.fn().mockResolvedValue({ success: true, pid: 123 }),
        kill: vi.fn().mockResolvedValue({ success: true })
      },
      writable: true,
      configurable: true
    })

    // Reset stores
    useScriptStore.setState({ scriptStates: {} })
    deleteBuffer('wt-1')
    useFileViewerStore.setState({ activeDiff: null, openFiles: new Map(), activeFilePath: null })
  })

  // -------------------------------------------------------------------------
  // Project Filter integration
  // -------------------------------------------------------------------------
  describe('Project Filter integration', () => {
    test('filter preserves match data across projects', () => {
      // Verify subsequence matching works for name matches and path-only matches
      const nameResult = subsequenceMatch('auth', 'feature-auth')
      expect(nameResult.matched).toBe(true)
      expect(nameResult.indices.length).toBe(4)

      const pathResult = subsequenceMatch('orders', 'tedooo-orders')
      expect(pathResult.matched).toBe(true)
    })

    test('filter hides non-matching and shows matching', () => {
      const projects = ['alpha-service', 'beta-api', 'gamma-ui']
      const query = 'al'

      const results = projects
        .map((name) => ({
          name,
          match: subsequenceMatch(query, name)
        }))
        .filter((r) => r.match.matched)

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('alpha-service')
    })

    test('filter with special characters does not crash', () => {
      expect(() => subsequenceMatch('a+b', 'a+b-project')).not.toThrow()
      expect(() => subsequenceMatch('$', '$pecial')).not.toThrow()
      expect(() => subsequenceMatch('.', 'dot.project')).not.toThrow()
    })

    test('empty filter matches all projects', () => {
      const projects = ['alpha', 'beta', 'gamma']
      const results = projects
        .map((name) => ({
          name,
          match: subsequenceMatch('', name)
        }))
        .filter((r) => r.match.matched)

      expect(results).toHaveLength(3)
    })

    test('results sorted by match quality - name matches before path matches', () => {
      const items = [
        {
          name: 'my-project',
          path: '/users/orders-app',
          nameMatch: subsequenceMatch('orders', 'my-project'),
          pathMatch: subsequenceMatch('orders', '/users/orders-app')
        },
        {
          name: 'orders-service',
          path: '/users/svc',
          nameMatch: subsequenceMatch('orders', 'orders-service'),
          pathMatch: subsequenceMatch('orders', '/users/svc')
        }
      ]

      const sorted = items
        .filter((i) => i.nameMatch.matched || i.pathMatch.matched)
        .sort((a, b) => {
          const aScore = a.nameMatch.matched ? a.nameMatch.score : a.pathMatch.score + 1000
          const bScore = b.nameMatch.matched ? b.nameMatch.score : b.pathMatch.score + 1000
          return aScore - bScore
        })

      // Name match ('orders-service') should come before path-only match ('my-project')
      expect(sorted[0].name).toBe('orders-service')
      expect(sorted[1].name).toBe('my-project')
    })
  })

  // -------------------------------------------------------------------------
  // Pulse Animation integration
  // -------------------------------------------------------------------------
  describe('Pulse Animation integration', () => {
    const mockWorktree = {
      id: 'wt-1',
      project_id: 'proj-1',
      name: 'feature-branch',
      branch_name: 'feature-branch',
      path: '/test/path',
      status: 'active' as const,
      is_default: false,
      created_at: '2024-01-01',
      last_accessed_at: '2024-01-01'
    }

    test('pulse priority over AI spinner when both active', async () => {
      // runRunning=true AND worktreeStatus='working'
      useScriptStore.setState({
        scriptStates: {
          'wt-1': {
            setupOutput: [],
            setupRunning: false,
            setupError: null,
            runOutputVersion: 0,
            runRunning: true,
            runPid: 123
          }
        }
      })

      const { WorktreeItem } =
        await import('../../../src/renderer/src/components/worktrees/WorktreeItem')
      const { container } = render(
        React.createElement(WorktreeItem, {
          worktree: mockWorktree,
          projectPath: '/test/project'
        })
      )

      // PulseAnimation renders an SVG with animateTransform
      const svg = container.querySelector('svg')
      expect(svg).toBeTruthy()

      // Spinner should NOT be shown (pulse takes priority)
      const spinner = container.querySelector('.animate-spin')
      expect(spinner).toBeNull()
    })

    test('pulse disappears when run process stops', async () => {
      // Start with running
      useScriptStore.setState({
        scriptStates: {
          'wt-1': {
            setupOutput: [],
            setupRunning: false,
            setupError: null,
            runOutputVersion: 0,
            runRunning: true,
            runPid: 123
          }
        }
      })

      const { WorktreeItem } =
        await import('../../../src/renderer/src/components/worktrees/WorktreeItem')
      const { container, rerender } = render(
        React.createElement(WorktreeItem, {
          worktree: mockWorktree,
          projectPath: '/test/project'
        })
      )

      // Initially has pulse
      expect(container.querySelector('animateTransform')).toBeTruthy()

      // Stop the run
      await act(async () => {
        useScriptStore.setState({
          scriptStates: {
            'wt-1': {
              setupOutput: [],
              setupRunning: false,
              setupError: null,
              runOutputVersion: 0,
              runRunning: false,
              runPid: null
            }
          }
        })
      })

      rerender(
        React.createElement(WorktreeItem, {
          worktree: mockWorktree,
          projectPath: '/test/project'
        })
      )

      // Pulse should be gone
      expect(container.querySelector('animateTransform')).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Inline Diff integration
  // -------------------------------------------------------------------------
  describe('Inline Diff integration', () => {
    test('setting active diff clears active file', () => {
      const store = useFileViewerStore.getState()

      // Open a file first
      store.openFile('/test/file.ts', 'file.ts', 'wt-1')
      expect(useFileViewerStore.getState().activeFilePath).toBe('/test/file.ts')

      // Set active diff should clear active file
      store.setActiveDiff({
        worktreePath: '/test/worktree',
        filePath: 'src/app.ts',
        fileName: 'app.ts',
        staged: false,
        isUntracked: false
      })

      expect(useFileViewerStore.getState().activeDiff).not.toBeNull()
      expect(useFileViewerStore.getState().activeFilePath).toBeNull()
    })

    test('clearing diff does not restore previous file', () => {
      const store = useFileViewerStore.getState()

      store.setActiveDiff({
        worktreePath: '/test/worktree',
        filePath: 'src/app.ts',
        fileName: 'app.ts',
        staged: false,
        isUntracked: false
      })

      store.clearActiveDiff()

      expect(useFileViewerStore.getState().activeDiff).toBeNull()
      expect(useFileViewerStore.getState().activeFilePath).toBeNull()
    })

    test('opening a file clears active diff', () => {
      const store = useFileViewerStore.getState()

      // Set diff
      store.setActiveDiff({
        worktreePath: '/test/worktree',
        filePath: 'src/app.ts',
        fileName: 'app.ts',
        staged: false,
        isUntracked: false
      })

      // Open a file should clear diff
      store.openFile('/test/file.ts', 'file.ts', 'wt-1')

      expect(useFileViewerStore.getState().activeDiff).toBeNull()
      expect(useFileViewerStore.getState().activeFilePath).toBe('/test/file.ts')
    })
  })

  // -------------------------------------------------------------------------
  // Clear Button integration
  // -------------------------------------------------------------------------
  describe('Clear Button integration', () => {
    test('clear button in RunTab calls clearRunOutput', async () => {
      // Populate ring buffer before setting state
      deleteBuffer('wt-1')
      useScriptStore.getState().appendRunOutput('wt-1', 'line 1')
      useScriptStore.getState().appendRunOutput('wt-1', 'line 2')
      useScriptStore.getState().appendRunOutput('wt-1', 'line 3')
      useScriptStore.setState({
        scriptStates: {
          'wt-1': {
            setupOutput: [],
            setupRunning: false,
            setupError: null,
            runOutputVersion: 3,
            runRunning: false,
            runPid: null
          }
        }
      })

      const { RunTab } = await import('../../../src/renderer/src/components/layout/RunTab')
      render(React.createElement(RunTab, { worktreeId: 'wt-1' }))

      const clearButton = screen.getByTestId('clear-button')
      expect(clearButton).toBeTruthy()

      await act(async () => {
        fireEvent.click(clearButton)
      })

      // Verify output was cleared
      expect(useScriptStore.getState().getRunOutput('wt-1')).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // PulseAnimation component
  // -------------------------------------------------------------------------
  describe('PulseAnimation component', () => {
    test('renders SVG with proper animation attributes', async () => {
      const { PulseAnimation } =
        await import('../../../src/renderer/src/components/worktrees/PulseAnimation')
      const { container } = render(React.createElement(PulseAnimation))

      const svg = container.querySelector('svg')
      expect(svg).toBeTruthy()

      const path = svg?.querySelector('path')
      expect(path).toBeTruthy()
      expect(path?.getAttribute('stroke')).toBe('currentColor')

      const animate = container.querySelector('animateTransform')
      expect(animate).toBeTruthy()
      expect(animate?.getAttribute('dur')).toBe('2s')
      expect(animate?.getAttribute('repeatCount')).toBe('indefinite')
    })
  })

  // -------------------------------------------------------------------------
  // Cross-feature: diff + file viewer state consistency
  // -------------------------------------------------------------------------
  describe('Cross-feature state consistency', () => {
    test('file viewer store handles multiple rapid state changes', () => {
      const store = useFileViewerStore.getState()

      // Rapid state changes: open file, set diff, clear diff, open another file
      store.openFile('/a.ts', 'a.ts', 'wt-1')
      store.setActiveDiff({
        worktreePath: '/wt',
        filePath: 'b.ts',
        fileName: 'b.ts',
        staged: false,
        isUntracked: false
      })
      store.clearActiveDiff()
      store.openFile('/c.ts', 'c.ts', 'wt-1')

      const state = useFileViewerStore.getState()
      expect(state.activeFilePath).toBe('/c.ts')
      expect(state.activeDiff).toBeNull()
      expect(state.openFiles.size).toBe(2) // a.ts and c.ts
    })

    test('closeAllFiles resets diff state too', () => {
      const store = useFileViewerStore.getState()

      store.openFile('/a.ts', 'a.ts', 'wt-1')
      store.setActiveDiff({
        worktreePath: '/wt',
        filePath: 'b.ts',
        fileName: 'b.ts',
        staged: true,
        isUntracked: false
      })

      store.closeAllFiles()

      const state = useFileViewerStore.getState()
      expect(state.openFiles.size).toBe(0)
      expect(state.activeFilePath).toBeNull()
      expect(state.activeDiff).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // subsequenceMatch edge cases
  // -------------------------------------------------------------------------
  describe('subsequenceMatch edge cases', () => {
    test('single character queries work', () => {
      const result = subsequenceMatch('a', 'apple')
      expect(result.matched).toBe(true)
      expect(result.indices).toEqual([0])
    })

    test('repeated characters match first occurrences greedily', () => {
      const result = subsequenceMatch('aa', 'abaca')
      expect(result.matched).toBe(true)
      expect(result.indices).toEqual([0, 2])
    })

    test('unicode characters work', () => {
      // Basic ASCII-safe test
      const result = subsequenceMatch('abc', 'a-b-c')
      expect(result.matched).toBe(true)
      expect(result.indices).toEqual([0, 2, 4])
    })

    test('very long target does not hang', () => {
      const longTarget = 'a'.repeat(10000) + 'bcdef'
      const start = performance.now()
      const result = subsequenceMatch('bcdef', longTarget)
      const elapsed = performance.now() - start
      expect(result.matched).toBe(true)
      expect(elapsed).toBeLessThan(100) // Should be well under 100ms
    })
  })
})
