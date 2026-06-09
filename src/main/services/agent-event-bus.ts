import { EventEmitter } from 'node:events'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

class AgentEventBus extends EventEmitter {
  publish(event: OpenCodeStreamEvent): void {
    void import('../desktop/backend-manager')
      .then(({ publishDesktopBackendEvent }) =>
        publishDesktopBackendEvent(OPENCODE_STREAM_CHANNEL, event)
      )
      .catch(() => undefined)
    this.emit(OPENCODE_STREAM_CHANNEL, event)
  }

  subscribe(listener: (event: OpenCodeStreamEvent) => void): () => void {
    this.on(OPENCODE_STREAM_CHANNEL, listener)
    return () => this.off(OPENCODE_STREAM_CHANNEL, listener)
  }
}

export const agentEventBus = new AgentEventBus()
