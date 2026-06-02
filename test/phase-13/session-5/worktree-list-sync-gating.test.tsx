import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '../../utils/render'
import { WorktreeList } from '@/components/worktrees/WorktreeList'
import { useWorktreeStore } from '@/stores'

// Regression test for the filter-clear performance fix.
//
// WorktreeList used to call syncWorktrees() (an expensive git op) on EVERY mount.
// Clearing the sidebar filter remounts every project's list at once, so this fired
// a flood of concurrent git syncs + store updates that janked the whole UI for ~10s.
// The store already holds worktree data across unmount/remount, so the list must now
// load + sync only once per project per session — never again on later remounts.

const mockWorktreeOps = {
  sync: vi.fn().mockResolvedValue({ success: true })
}

const mockDb = {
  worktree: {
    getActiveByProject: vi.fn().mockResolvedValue([])
  }
}

beforeEach(() => {
  // @ts-expect-error - Mock window.worktreeOps
  window.worktreeOps = mockWorktreeOps
  // @ts-expect-error - Mock window.db
  window.db = mockDb
  vi.clearAllMocks()
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
    await waitFor(() => expect(mockWorktreeOps.sync).toHaveBeenCalledTimes(1))

    // Simulate the filter being cleared: unmount then remount the same project's list.
    unmount()
    render(<WorktreeList project={project} />)

    // Give any (incorrect) mount-effect sync a chance to fire, then assert it did NOT.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockWorktreeOps.sync).toHaveBeenCalledTimes(1)
  })
})
