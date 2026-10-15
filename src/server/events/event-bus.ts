import { Effect } from 'effect'
import type { ServerEvent } from '@shared/rpc/protocol'
import { perfLog } from '../../main/services/perf-logging/perf-logger'

export type ServerEventListener = (event: ServerEvent) => void
export type Unsubscribe = () => void

export interface EventBus {
  readonly publish: (event: ServerEvent) => Effect.Effect<void>
  readonly subscribe: (channel: string, listener: ServerEventListener) => Effect.Effect<Unsubscribe>
  readonly subscribeAll: (listener: ServerEventListener) => Effect.Effect<Unsubscribe>
  /** Number of listeners currently subscribed to `channel` (excludes `subscribeAll`). */
  readonly subscriberCount: (channel: string) => number
  /** Totals for performance logging: channels with listeners, listeners, `subscribeAll` ones. */
  readonly stats: () => { channels: number; listeners: number; all: number }
}

export const makeEventBus = (): EventBus => {
  const listeners = new Map<string, Set<ServerEventListener>>()
  const allListeners = new Set<ServerEventListener>()

  return {
    publish: (event) =>
      Effect.sync(() => {
        const channelListeners = listeners.get(event.channel)
        if (perfLog.isEnabled()) {
          perfLog.recordEvent(
            event.channel,
            payloadBytes(event.payload),
            (channelListeners?.size ?? 0) + allListeners.size
          )
        }
        for (const listener of channelListeners ?? []) {
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
      }),
    subscriberCount: (channel) => listeners.get(channel)?.size ?? 0,
    stats: () => {
      let total = 0
      for (const set of listeners.values()) total += set.size
      return { channels: listeners.size, listeners: total, all: allListeners.size }
    }
  }
}

/** Serialized size of a payload, only computed while performance logging is on. */
const payloadBytes = (payload: unknown): number => {
  try {
    return JSON.stringify(payload)?.length ?? 0
  } catch {
    return -1
  }
}
