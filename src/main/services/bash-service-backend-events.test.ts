import { describe, expect, it, vi } from 'vitest'
import { BASH_STREAM_CHANNEL } from '../../shared/bash-events'
import type { BashStreamEvent } from './bash-service'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn().mockResolvedValue(true)
}))

vi.mock('../desktop/backend-manager', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { BashService } from './bash-service'

describe('BashService backend event mirroring', () => {
  it('publishes bash stream events through the backend event bus', async () => {
    const service = new BashService()
    const event: BashStreamEvent = {
      type: 'output',
      sessionId: 'session-1',
      runId: 'run-1',
      data: 'hello'
    }

    ;(service as unknown as { sendEvent: (event: BashStreamEvent) => void }).sendEvent(event)

    await vi.waitFor(() => {
      expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(BASH_STREAM_CHANNEL, event)
    })
  })
})
