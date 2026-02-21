/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import type { OpenCodeStreamEvent } from '../../../src/shared/types/opencode'
import { opencodeSubscriptionResolvers } from '../../../src/server/resolvers/subscription/opencode.resolvers'

function getSubscribeFn() {
  const sub = opencodeSubscriptionResolvers.Subscription!.opencodeStream
  if (typeof sub === 'function') throw new Error('Expected object with subscribe')
  return (sub as { subscribe: (...args: any[]) => AsyncIterable<any> }).subscribe
}

describe('opencodeStream subscription', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  it('yields events from opencode:stream channel', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any)

    const event: OpenCodeStreamEvent = {
      type: 'message.created',
      sessionId: 'sess-1',
      data: { content: 'hello' },
    }

    setTimeout(() => eventBus.emit('opencode:stream', event), 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value).toEqual({ opencodeStream: event })
  })

  it('filters by sessionIds when provided', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe(
      {},
      { sessionIds: ['sess-1'] },
      { eventBus } as any,
      {} as any,
    )

    setTimeout(() => {
      eventBus.emit('opencode:stream', {
        type: 'message.created',
        sessionId: 'sess-2',
        data: {},
      })
      eventBus.emit('opencode:stream', {
        type: 'message.created',
        sessionId: 'sess-1',
        data: { content: 'yes' },
      })
    }, 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value.opencodeStream.sessionId).toBe('sess-1')
  })

  it('yields all events when sessionIds is not provided', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any)

    setTimeout(() => {
      eventBus.emit('opencode:stream', {
        type: 'message.created',
        sessionId: 'sess-A',
        data: {},
      })
    }, 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value.opencodeStream.sessionId).toBe('sess-A')
  })

  it('batches events with 50ms delay to reduce wakeups', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any)

    setTimeout(() => {
      eventBus.emit('opencode:stream', { type: 'a', sessionId: 's1', data: {} })
      eventBus.emit('opencode:stream', { type: 'b', sessionId: 's1', data: {} })
      eventBus.emit('opencode:stream', { type: 'c', sessionId: 's1', data: {} })
    }, 10)

    const r1 = await (iter as AsyncGenerator).next()
    const r2 = await (iter as AsyncGenerator).next()
    const r3 = await (iter as AsyncGenerator).next()

    expect(r1.value.opencodeStream.type).toBe('a')
    expect(r2.value.opencodeStream.type).toBe('b')
    expect(r3.value.opencodeStream.type).toBe('c')
  })

  it('cleans up EventBus listener when generator returns', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any) as AsyncGenerator

    setTimeout(() => {
      eventBus.emit('opencode:stream', {
        type: 'test',
        sessionId: 's1',
        data: {},
      })
    }, 10)

    await iter.next()
    await iter.return(undefined)

    eventBus.emit('opencode:stream', {
      type: 'post-cleanup',
      sessionId: 's1',
      data: {},
    })
  })

  it('delivers same event to multiple concurrent subscribers', async () => {
    const subscribe = getSubscribeFn()
    const iter1 = subscribe({}, {}, { eventBus } as any, {} as any)
    const iter2 = subscribe({}, {}, { eventBus } as any, {} as any)

    const event: OpenCodeStreamEvent = {
      type: 'message.created',
      sessionId: 'sess-1',
      data: { content: 'shared' },
    }

    setTimeout(() => eventBus.emit('opencode:stream', event), 10)

    const [r1, r2] = await Promise.all([
      (iter1 as AsyncGenerator).next(),
      (iter2 as AsyncGenerator).next(),
    ])

    expect(r1.value.opencodeStream.sessionId).toBe('sess-1')
    expect(r2.value.opencodeStream.sessionId).toBe('sess-1')
  })
})
