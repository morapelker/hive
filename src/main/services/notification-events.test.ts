import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOTIFICATION_NAVIGATE_CHANNEL,
  type NotificationNavigatePayload
} from '../../shared/notification-events'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import { emitNotificationNavigate } from './notification-events'

describe('notification events', () => {
  beforeEach(() => {
    mocks.publishDesktopBackendEvent.mockClear()
  })

  it('publishes notification navigation payloads through the backend event stream', async () => {
    const payload: NotificationNavigatePayload = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      sessionId: 'session-1'
    }

    emitNotificationNavigate(payload)
    await vi.waitFor(() => {
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(
        NOTIFICATION_NAVIGATE_CHANNEL,
        payload
      )
    })
  })
})
