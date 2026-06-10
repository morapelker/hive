import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_BRANCH_RENAMED_CHANNEL } from '../../shared/worktree-events'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import { emitWorktreeBranchRenamed, setWorktreeEventPublisher } from './worktree-events'

describe('worktree events', () => {
  beforeEach(() => {
    mocks.publishDesktopBackendEvent.mockClear()
    setWorktreeEventPublisher(null)
  })

  it('publishes worktree branch renamed events through the backend event bus', async () => {
    const payload = {
      worktreeId: 'worktree-1',
      newBranch: 'feature-renamed',
      worktreePath: '/tmp/hive/worktree-1'
    }

    emitWorktreeBranchRenamed(payload)

    await vi.waitFor(() =>
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        WORKTREE_BRANCH_RENAMED_CHANNEL,
        payload
      )
    )
  })

  it('publishes worktree branch renamed events through an injected server publisher', () => {
    const payload = {
      worktreeId: 'worktree-1',
      newBranch: 'feature-renamed',
      worktreePath: '/tmp/hive/worktree-1'
    }
    const publisher = vi.fn()
    setWorktreeEventPublisher(publisher)

    emitWorktreeBranchRenamed(payload)

    expect(publisher).toHaveBeenCalledWith(WORKTREE_BRANCH_RENAMED_CHANNEL, payload)
    expect(mocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
  })

  it('publishes worktree branch renamed events without a window dependency', async () => {
    const payload = {
      worktreeId: 'worktree-1',
      newBranch: 'feature-renamed',
      worktreePath: '/tmp/hive/worktree-1'
    }

    emitWorktreeBranchRenamed(payload)

    await vi.waitFor(() =>
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        WORKTREE_BRANCH_RENAMED_CHANNEL,
        payload
      )
    )
  })
})
