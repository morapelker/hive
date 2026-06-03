import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OPENCODE_STREAM_CHANNEL } from '../../shared/opencode-events'
import type { OpenCodeStreamEvent } from '../../shared/types/opencode'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import { agentEventBus } from './agent-event-bus'

describe('agent event bus', () => {
  beforeEach(() => {
    mocks.publishDesktopBackendEvent.mockClear()
  })

  it('publishes opencode stream events through the backend event channel without renderer IPC', async () => {
    const event: OpenCodeStreamEvent = {
      type: 'message.delta',
      sessionId: 'session-1',
      data: { text: 'hello' }
    }

    agentEventBus.publish(event)

    await vi.waitFor(() => {
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(OPENCODE_STREAM_CHANNEL, event)
    })
  })

  it('still publishes opencode stream events when no renderer window is available', async () => {
    const event: OpenCodeStreamEvent = {
      type: 'session.updated',
      sessionId: 'session-1',
      data: {}
    }

    agentEventBus.publish(event)

    await vi.waitFor(() => {
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(OPENCODE_STREAM_CHANNEL, event)
    })
  })
})
