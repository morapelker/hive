/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import { opencodeSubscriptionResolvers } from '../../../src/server/resolvers/subscription/opencode.resolvers'

function getSubscribeFn() {
  const sub = opencodeSubscriptionResolvers.Subscription!.opencodeStream
  if (typeof sub === 'function') throw new Error('Expected object with subscribe')
  return (sub as { subscribe: (...args: any[]) => AsyncIterable<any> }).subscribe
}

describe('Subscription Stress Tests', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  it('handles 100 rapid events without dropping', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any) as AsyncGenerator

    const COUNT = 100
    const received: any[] = []

    // Emit 100 events rapidly
    setTimeout(() => {
      for (let i = 0; i < COUNT; i++) {
        eventBus.emit('opencode:stream', {
          type: `event-${i}`,
          sessionId: 'sess-1',
          data: { index: i },
        })
      }
    }, 10)

    // Collect all 100
    for (let i = 0; i < COUNT; i++) {
      const result = await iter.next()
      received.push(result.value.opencodeStream)
    }

    expect(received).toHaveLength(COUNT)
    // Verify ordering preserved
    expect(received[0].type).toBe('event-0')
    expect(received[COUNT - 1].type).toBe('event-99')
  })
})
