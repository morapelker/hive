import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useKeyboardShortcuts } from '../../../src/renderer/src/hooks/useKeyboardShortcuts'
import { useProjectStore } from '../../../src/renderer/src/stores/useProjectStore'
import { useScriptStore } from '../../../src/renderer/src/stores/useScriptStore'
import { useShortcutStore } from '../../../src/renderer/src/stores/useShortcutStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'

function ShortcutHarness(): React.JSX.Element {
  useKeyboardShortcuts()
  return <div>shortcut-harness</div>
}

const mockScriptOps = {
  runSetup: vi.fn().mockResolvedValue({ success: true }),
  runProject: vi.fn().mockResolvedValue({ success: true, pid: 12345 }),
  kill: vi.fn().mockResolvedValue({ success: true }),
  runArchive: vi.fn().mockResolvedValue({ success: true, output: '' }),
  onOutput: vi.fn().mockReturnValue(() => {}),
  offOutput: vi.fn()
}

describe('Cmd/Ctrl+R run shortcut', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    Object.defineProperty(window, 'scriptOps', {
      value: mockScriptOps,
      writable: true,
      configurable: true
    })

    useShortcutStore.setState({ customBindings: {} })
    useProjectStore.setState({
      projects: [
        {
          id: 'project-1',
          name: 'Test Project',
          path: '/tmp/test-project',
          description: null,
          tags: null,
          language: null,
          setup_script: null,
          run_script: 'pnpm run dev',
          archive_script: null,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
    })
    useWorktreeStore.setState({
      selectedWorktreeId: 'worktree-1',
      worktreesByProject: new Map([
        [
          'project-1',
          [
            {
              id: 'worktree-1',
              project_id: 'project-1',
              name: 'tokyo',
              branch_name: 'tokyo',
              path: '/tmp/test-project/worktree-1',
              status: 'active',
              is_default: false,
              created_at: new Date().toISOString(),
              last_accessed_at: new Date().toISOString()
            }
          ]
        ]
      ])
    })
    useScriptStore.setState({ scriptStates: {} })
    useScriptStore.getState().setRunRunning('worktree-1', true)
    useScriptStore.getState().setRunPid('worktree-1', 4321)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('stops an active run and does not auto-restart', async () => {
    render(<ShortcutHarness />)

    fireEvent.keyDown(document.body, { key: 'r', ctrlKey: true })

    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      vi.advanceTimersByTime(250)
    })

    expect(mockScriptOps.kill).toHaveBeenCalledTimes(1)
    expect(mockScriptOps.kill).toHaveBeenCalledWith('worktree-1')
    expect(mockScriptOps.runProject).not.toHaveBeenCalled()
  })
})
