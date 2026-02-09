import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { act } from 'react'
import React from 'react'
import { useScriptStore } from '../../../src/renderer/src/stores/useScriptStore'

// ---------------------------------------------------------------------------
// PulseAnimation tests
// ---------------------------------------------------------------------------
describe('Session 1: Quick Wins', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
  })

  describe('PulseAnimation', () => {
    test('PulseAnimation renders SVG with path', async () => {
      const { PulseAnimation } = await import(
        '../../../src/renderer/src/components/worktrees/PulseAnimation'
      )
      const { container } = render(React.createElement(PulseAnimation))
      const svg = container.querySelector('svg')
      expect(svg).toBeTruthy()
      const path = svg?.querySelector('path')
      expect(path).toBeTruthy()
      expect(path?.getAttribute('stroke')).toBe('currentColor')
    })

    test('PulseAnimation accepts className prop', async () => {
      const { PulseAnimation } = await import(
        '../../../src/renderer/src/components/worktrees/PulseAnimation'
      )
      const { container } = render(
        React.createElement(PulseAnimation, { className: 'h-3.5 w-3.5 text-green-500' })
      )
      const svg = container.querySelector('svg')
      expect(svg?.className.baseVal).toContain('overflow-hidden')
    })

    test('PulseAnimation has animateTransform for traveling effect', async () => {
      const { PulseAnimation } = await import(
        '../../../src/renderer/src/components/worktrees/PulseAnimation'
      )
      const { container } = render(React.createElement(PulseAnimation))
      const animateTransform = container.querySelector('animateTransform')
      expect(animateTransform).toBeTruthy()
      expect(animateTransform?.getAttribute('type')).toBe('translate')
      expect(animateTransform?.getAttribute('repeatCount')).toBe('indefinite')
    })
  })

  // ---------------------------------------------------------------------------
  // Clear Button tests
  // ---------------------------------------------------------------------------
  describe('Clear Button', () => {
    // Mock window APIs needed by RunTab
    beforeEach(() => {
      Object.defineProperty(window, 'scriptOps', {
        value: {
          onOutput: vi.fn().mockReturnValue(() => {}),
          runProject: vi.fn().mockResolvedValue({ success: true, pid: 123 }),
          kill: vi.fn().mockResolvedValue({ success: true })
        },
        writable: true,
        configurable: true
      })

      Object.defineProperty(window, 'projectOps', {
        value: {
          showInFolder: vi.fn(),
          copyToClipboard: vi.fn()
        },
        writable: true,
        configurable: true
      })

      // Reset script store
      useScriptStore.setState({ scriptStates: {} })
    })

    test('Clear button visible when output exists', async () => {
      // Set some run output in the store
      useScriptStore.setState({
        scriptStates: {
          'wt-1': {
            setupOutput: [],
            setupRunning: false,
            setupError: null,
            runOutput: ['line 1', 'line 2'],
            runRunning: false,
            runPid: null
          }
        }
      })

      const { RunTab } = await import(
        '../../../src/renderer/src/components/layout/RunTab'
      )
      render(React.createElement(RunTab, { worktreeId: 'wt-1' }))

      const clearButton = screen.getByTestId('clear-button')
      expect(clearButton).toBeTruthy()
      expect(clearButton.textContent).toContain('Clear')
    })

    test('Clear button hidden when no output', async () => {
      useScriptStore.setState({
        scriptStates: {
          'wt-1': {
            setupOutput: [],
            setupRunning: false,
            setupError: null,
            runOutput: [],
            runRunning: false,
            runPid: null
          }
        }
      })

      const { RunTab } = await import(
        '../../../src/renderer/src/components/layout/RunTab'
      )
      render(React.createElement(RunTab, { worktreeId: 'wt-1' }))

      expect(screen.queryByTestId('clear-button')).toBeNull()
    })

    test('Clear button clears output on click', async () => {
      useScriptStore.setState({
        scriptStates: {
          'wt-1': {
            setupOutput: [],
            setupRunning: false,
            setupError: null,
            runOutput: ['line 1'],
            runRunning: false,
            runPid: null
          }
        }
      })

      const { RunTab } = await import(
        '../../../src/renderer/src/components/layout/RunTab'
      )
      render(React.createElement(RunTab, { worktreeId: 'wt-1' }))

      const clearButton = screen.getByTestId('clear-button')
      await act(async () => {
        fireEvent.click(clearButton)
      })

      // After clearing, the store should have empty run output
      const state = useScriptStore.getState()
      expect(state.scriptStates['wt-1']?.runOutput).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // WorktreeItem pulse integration tests
  // ---------------------------------------------------------------------------
  describe('Pulse Animation in WorktreeItem', () => {
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

    beforeEach(() => {
      // Mock window APIs needed by WorktreeItem
      Object.defineProperty(window, 'worktreeOps', {
        value: {
          openInTerminal: vi.fn().mockResolvedValue({ success: true }),
          openInEditor: vi.fn().mockResolvedValue({ success: true })
        },
        writable: true,
        configurable: true
      })

      Object.defineProperty(window, 'projectOps', {
        value: {
          showInFolder: vi.fn(),
          copyToClipboard: vi.fn()
        },
        writable: true,
        configurable: true
      })

      useScriptStore.setState({ scriptStates: {} })
    })

    test('Pulse shown when run process alive', async () => {
      useScriptStore.setState({
        scriptStates: {
          'wt-1': {
            setupOutput: [],
            setupRunning: false,
            setupError: null,
            runOutput: [],
            runRunning: true,
            runPid: 123
          }
        }
      })

      const { WorktreeItem } = await import(
        '../../../src/renderer/src/components/worktrees/WorktreeItem'
      )
      const { container } = render(
        React.createElement(WorktreeItem, {
          worktree: mockWorktree,
          projectPath: '/test/project'
        })
      )

      // PulseAnimation renders an SVG
      const svg = container.querySelector('svg')
      expect(svg).toBeTruthy()

      // Should NOT have the Loader2 spinner
      const spinner = container.querySelector('.animate-spin')
      expect(spinner).toBeNull()
    })

    test('Normal branch icon when idle', async () => {
      useScriptStore.setState({
        scriptStates: {
          'wt-1': {
            setupOutput: [],
            setupRunning: false,
            setupError: null,
            runOutput: [],
            runRunning: false,
            runPid: null
          }
        }
      })

      const { WorktreeItem } = await import(
        '../../../src/renderer/src/components/worktrees/WorktreeItem'
      )
      const { container } = render(
        React.createElement(WorktreeItem, {
          worktree: mockWorktree,
          projectPath: '/test/project'
        })
      )

      // Should not have SVG from PulseAnimation (only lucide icons which use SVG too)
      // Check that the ecg-travel animation is not present
      const ecgPath = container.querySelector('.animate-ecg-travel')
      expect(ecgPath).toBeNull()

      // Should not have spinner
      const spinner = container.querySelector('.animate-spin')
      expect(spinner).toBeNull()
    })
  })
})
