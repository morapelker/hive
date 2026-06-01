import { Effect } from 'effect'
import type { ServerEvent } from '@shared/rpc/protocol'

export type ServerEventListener = (event: ServerEvent) => void
export type Unsubscribe = () => void

export interface EventBus {
  readonly publish: (event: ServerEvent) => Effect.Effect<void>
  readonly subscribe: (channel: string, listener: ServerEventListener) => Effect.Effect<Unsubscribe>
  readonly subscribeAll: (listener: ServerEventListener) => Effect.Effect<Unsubscribe>
}

export const makeEventBus = (): EventBus => {
  const listeners = new Map<string, Set<ServerEventListener>>()
  const allListeners = new Set<ServerEventListener>()

  return {
    publish: (event) =>
      Effect.sync(() => {
        for (const listener of listeners.get(event.channel) ?? []) {
          listener(event)
        }
        for (const listener of allListeners) {
          listener(event)
        }
      }),
    subscribe: (channel, listener) =>
      Effect.sync(() => {
        let channelListeners = listeners.get(channel)
        if (!channelListeners) {
          channelListeners = new Set()
          listeners.set(channel, channelListeners)
        }
        channelListeners.add(listener)

        return () => {
          channelListeners.delete(listener)
          if (channelListeners.size === 0) listeners.delete(channel)
        }
      }),
    subscribeAll: (listener) =>
      Effect.sync(() => {
        allListeners.add(listener)
        return () => {
          allListeners.delete(listener)
        }
      })
  }
}
