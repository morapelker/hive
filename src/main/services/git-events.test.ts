import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_BRANCH_CHANGED_CHANNEL, GIT_STATUS_CHANGED_CHANNEL } from '../../shared/git-events'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import { emitGitBranchChanged, emitGitStatusChanged, setGitEventPublisher } from './git-events'

describe('git events', () => {
  beforeEach(() => {
    mocks.publishDesktopBackendEvent.mockClear()
    setGitEventPublisher(null)
  })

  it('publishes the git status changed event through the backend event bus', async () => {
    const payload = { worktreePath: '/tmp/hive' }

    emitGitStatusChanged(payload)

    await vi.waitFor(() =>
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        GIT_STATUS_CHANGED_CHANNEL,
        payload
      )
    )
  })

  it('publishes the git status changed event through an injected server publisher', () => {
    const payload = { worktreePath: '/tmp/hive' }
    const publisher = vi.fn()
    setGitEventPublisher(publisher)

    emitGitStatusChanged(payload)

    expect(publisher).toHaveBeenCalledWith(GIT_STATUS_CHANGED_CHANNEL, payload)
    expect(mocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
  })

  it('publishes the git status changed event without a renderer window reference', async () => {
    const payload = { worktreePath: '/tmp/hive' }

    emitGitStatusChanged(payload)

    await vi.waitFor(() =>
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        GIT_STATUS_CHANGED_CHANNEL,
        payload
      )
    )
  })

  it('publishes the git branch changed event through the backend event bus', async () => {
    const payload = { worktreePath: '/tmp/hive' }

    emitGitBranchChanged(payload)

    await vi.waitFor(() =>
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        GIT_BRANCH_CHANGED_CHANNEL,
        payload
      )
    )
  })

  it('publishes the git branch changed event through an injected server publisher', () => {
    const payload = { worktreePath: '/tmp/hive' }
    const publisher = vi.fn()
    setGitEventPublisher(publisher)

    emitGitBranchChanged(payload)

    expect(publisher).toHaveBeenCalledWith(GIT_BRANCH_CHANGED_CHANNEL, payload)
    expect(mocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
  })

  it('publishes the git branch changed event without a renderer window reference', async () => {
    const payload = { worktreePath: '/tmp/hive' }

    emitGitBranchChanged(payload)

    await vi.waitFor(() =>
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        GIT_BRANCH_CHANGED_CHANNEL,
        payload
      )
    )
  })
})
