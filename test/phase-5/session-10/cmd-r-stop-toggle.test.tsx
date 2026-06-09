import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: {
    setting: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined)
    }
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    updateSettings: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/api/system-api', () => ({
  systemApi: {
    onNewSessionShortcut: vi.fn(() => vi.fn()),
    onFileSearchShortcut: vi.fn(() => vi.fn()),
    onCloseSessionShortcut: vi.fn(() => vi.fn()),
    onMenuAction: vi.fn(() => vi.fn()),
    updateMenuState: vi.fn().mockResolvedValue(undefined)
  }
}))

import { useKeyboardShortcuts } from '../../../src/renderer/src/hooks/useKeyboardShortcuts'
import { useProjectStore } from '../../../src/renderer/src/stores/useProjectStore'
import { useScriptStore } from '../../../src/renderer/src/stores/useScriptStore'
import { useShortcutStore } from '../../../src/renderer/src/stores/useShortcutStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import {
  resetRendererRpcClientForTests,
  setRendererRpcClient
} from '../../../src/renderer/src/api/rpc-client'

function ShortcutHarness(): React.JSX.Element {
  useKeyboardShortcuts()
  return <div>shortcut-harness</div>
}

let request: ReturnType<typeof vi.fn>

describe('Cmd/Ctrl+R run shortcut', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    request = vi.fn(async (method: string) => {
      if (method === 'scriptOps.kill') return { success: true }
      if (method === 'scriptOps.runProject') return { success: true, pid: 12345 }
      if (method === 'scriptOps.getPort') return { port: null }
      return null
    })
    setRendererRpcClient({
      request,
      subscribe: vi.fn().mockReturnValue(() => {})
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
    resetRendererRpcClientForTests()
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

    expect(request).toHaveBeenCalledWith('scriptOps.kill', { worktreeId: 'worktree-1' })
    expect(request).not.toHaveBeenCalledWith('scriptOps.runProject', expect.anything())
  })
})
