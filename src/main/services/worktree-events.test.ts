import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_BRANCH_RENAMED_CHANNEL } from '../../shared/worktree-events'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import { emitWorktreeBranchRenamed } from './worktree-events'

describe('worktree events', () => {
  beforeEach(() => {
    mocks.publishDesktopBackendEvent.mockClear()
  })

  it('publishes worktree branch renamed events without IPC mirroring', () => {
    const payload = { worktreeId: 'worktree-1', newBranch: 'feature-renamed' }

    emitWorktreeBranchRenamed(payload)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      WORKTREE_BRANCH_RENAMED_CHANNEL,
      payload
    )
  })

  it('publishes worktree branch renamed events without a window dependency', () => {
    const payload = { worktreeId: 'worktree-1', newBranch: 'feature-renamed' }

    emitWorktreeBranchRenamed(payload)

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
      WORKTREE_BRANCH_RENAMED_CHANNEL,
      payload
    )
  })
})
