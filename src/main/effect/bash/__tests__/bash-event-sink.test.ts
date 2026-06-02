// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { BASH_STREAM_CHANNEL } from '../../../../shared/bash-events'

const mocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../../../desktop/backend-manager', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

import { EventSink } from '../service'
import { EventSinkLive } from '../layers'
import type { BashStreamEvent } from '../types'

describe('Bash EventSinkLive', () => {
  it('publishes bash stream events through the backend event bus without renderer IPC', async () => {
    const event: BashStreamEvent = {
      type: 'output',
      sessionId: 'session-1',
      runId: 'run-1',
      data: 'hello'
    }

    await Effect.runPromise(
      Effect.flatMap(EventSink, (sink) => sink.send(event)).pipe(Effect.provide(EventSinkLive))
    )

    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith(BASH_STREAM_CHANNEL, event)
  })
})
