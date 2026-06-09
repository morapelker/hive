import { afterEach, describe, test, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '../../utils/render'

vi.mock('@/api/worktree-api', () => ({
  worktreeApi: {
    sync: vi.fn()
  }
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => () => {})
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    hide: vi.fn(() => Promise.resolve(undefined)),
    show: vi.fn(() => Promise.resolve(undefined)),
    updateSettings: vi.fn(() => Promise.resolve({ success: true }))
  }
}))

import { WorktreeList } from '@/components/worktrees/WorktreeList'
import { useWorktreeStore } from '@/stores'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { worktreeApi } from '@/api/worktree-api'

// Regression test for the filter-clear performance fix.
//
// WorktreeList used to call syncWorktrees() (an expensive git op) on EVERY mount.
// Clearing the sidebar filter remounts every project's list at once, so this fired
// a flood of concurrent git syncs + store updates that janked the whole UI for ~10s.
// The store already holds worktree data across unmount/remount, so the list must now
// load + sync only once per project per session — never again on later remounts.

let request: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  request = vi.fn().mockImplementation((method) => {
    if (method === 'db.worktree.getActiveByProject') return Promise.resolve([])
    return Promise.resolve(null)
  })
  setRendererRpcClient({ request, subscribe: vi.fn() })
  vi.mocked(worktreeApi.sync).mockResolvedValue({ success: true })
})

describe('Session 5: WorktreeList git-sync gating', () => {
  test('syncs once per project per session, not on every remount', async () => {
    // Unique id so the module-level "initialized" guard isn't pre-tripped by another test.
    const project = { id: 'proj-sync-gating-unique', name: 'Gating', path: '/tmp/gating' }

    useWorktreeStore.setState({
      worktreesByProject: new Map([[project.id, []]]),
      worktreeOrderByProject: new Map()
    })

    // First mount: should load + git-sync exactly once.
    const { unmount } = render(<WorktreeList project={project} />)
    await waitFor(() => expect(worktreeApi.sync).toHaveBeenCalledTimes(1))
    expect(request).toHaveBeenCalledWith('db.worktree.getActiveByProject', {
      projectId: project.id
    })
    expect(worktreeApi.sync).toHaveBeenCalledWith({
      projectId: project.id,
      projectPath: project.path
    })

    // Simulate the filter being cleared: unmount then remount the same project's list.
    unmount()
    render(<WorktreeList project={project} />)

    // Give any (incorrect) mount-effect sync a chance to fire, then assert it did NOT.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(worktreeApi.sync).toHaveBeenCalledTimes(1)
  })
})

afterEach(() => {
  resetRendererRpcClientForTests()
})
