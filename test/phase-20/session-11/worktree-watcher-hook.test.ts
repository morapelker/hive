import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useWorktreeWatcher } from '../../../src/renderer/src/hooks/useWorktreeWatcher'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'

interface MockWorktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active'
  is_default: boolean
  branch_renamed: number
  last_message_at: number | null
  session_titles: string
  last_model_provider_id: string | null
  last_model_id: string | null
  last_model_variant: string | null
  created_at: string
  last_accessed_at: string
}

function createWorktree(id: string, path: string): MockWorktree {
  return {
    id,
    project_id: 'project-1',
    name: id,
    branch_name: id,
    path,
    status: 'active',
    is_default: false,
    branch_renamed: 0,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    created_at: '2025-01-01T00:00:00.000Z',
    last_accessed_at: '2025-01-01T00:00:00.000Z'
  }
}

const watchWorktreeMock = vi.fn().mockResolvedValue(undefined)
const unwatchWorktreeMock = vi.fn().mockResolvedValue(undefined)
const loadFileStatusesMock = vi.fn().mockResolvedValue(undefined)
const loadBranchInfoMock = vi.fn().mockResolvedValue(undefined)

describe('worktree watcher hook', () => {
  let originalLoadFileStatuses: (worktreePath: string) => Promise<void>
  let originalLoadBranchInfo: (worktreePath: string) => Promise<void>

  beforeEach(() => {
    vi.clearAllMocks()

    originalLoadFileStatuses = useGitStore.getState().loadFileStatuses
    originalLoadBranchInfo = useGitStore.getState().loadBranchInfo

    const existingGitOps = (window as unknown as { gitOps?: Record<string, unknown> }).gitOps ?? {}

    Object.defineProperty(window, 'gitOps', {
      configurable: true,
      writable: true,
      value: {
        ...existingGitOps,
        watchWorktree: watchWorktreeMock,
        unwatchWorktree: unwatchWorktreeMock
      }
    })

    useGitStore.setState({
      loadFileStatuses: loadFileStatusesMock,
      loadBranchInfo: loadBranchInfoMock
    })

    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-a',
      worktreesByProject: new Map([
        [
          'project-1',
          [createWorktree('wt-a', '/tmp/worktree-a'), createWorktree('wt-b', '/tmp/worktree-b')]
        ]
      ])
    })
  })

  afterEach(() => {
    cleanup()

    useGitStore.setState({
      loadFileStatuses: originalLoadFileStatuses,
      loadBranchInfo: originalLoadBranchInfo
    })

    useWorktreeStore.setState({
      selectedWorktreeId: null,
      worktreesByProject: new Map()
    })
  })

  test('unwatches only previous path when switching and current path on unmount', async () => {
    const { unmount } = renderHook(() => useWorktreeWatcher())

    await waitFor(() => {
      expect(watchWorktreeMock).toHaveBeenCalledWith('/tmp/worktree-a')
    })

    expect(loadFileStatusesMock).toHaveBeenCalledWith('/tmp/worktree-a')
    expect(loadBranchInfoMock).toHaveBeenCalledWith('/tmp/worktree-a')

    act(() => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-b' })
    })

    await waitFor(() => {
      expect(watchWorktreeMock).toHaveBeenCalledWith('/tmp/worktree-b')
    })

    expect(unwatchWorktreeMock).toHaveBeenCalledTimes(1)
    expect(unwatchWorktreeMock).toHaveBeenNthCalledWith(1, '/tmp/worktree-a')

    unmount()

    expect(unwatchWorktreeMock).toHaveBeenCalledTimes(2)
    expect(unwatchWorktreeMock).toHaveBeenNthCalledWith(2, '/tmp/worktree-b')
  })
})
