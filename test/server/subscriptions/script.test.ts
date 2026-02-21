/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import type { ScriptOutputEvent } from '../../../src/shared/types/script'
import { scriptSubscriptionResolvers } from '../../../src/server/resolvers/subscription/script.resolvers'

function getSubscribeFn() {
  const sub = scriptSubscriptionResolvers.Subscription!.scriptOutput
  if (typeof sub === 'function') throw new Error('Expected object with subscribe')
  return (sub as { subscribe: (...args: any[]) => AsyncIterable<any> }).subscribe
}

describe('scriptOutput subscription', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  it('yields script output for the matching channel', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe(
      {},
      { worktreeId: 'wt-1', channel: 'script:output:wt-1:run' },
      { eventBus } as any,
      {} as any,
    )

    const event: ScriptOutputEvent = {
      type: 'output',
      data: 'Server started on port 3000',
    }

    setTimeout(() => {
      eventBus.emit('script:output', 'script:output:wt-1:run', event)
    }, 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value).toEqual({ scriptOutput: event })
  })

  it('filters out events for other channels', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe(
      {},
      { worktreeId: 'wt-1', channel: 'script:output:wt-1:run' },
      { eventBus } as any,
      {} as any,
    )

    setTimeout(() => {
      eventBus.emit('script:output', 'script:output:wt-1:setup', {
        type: 'output',
        data: 'wrong channel',
      })
      eventBus.emit('script:output', 'script:output:wt-1:run', {
        type: 'done',
        exitCode: 0,
      })
    }, 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value.scriptOutput.type).toBe('done')
    expect(result.value.scriptOutput.exitCode).toBe(0)
  })

  it('handles all ScriptOutputEvent types', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe(
      {},
      { worktreeId: 'wt-1', channel: 'ch1' },
      { eventBus } as any,
      {} as any,
    )

    const events: ScriptOutputEvent[] = [
      { type: 'command-start', command: 'npm test' },
      { type: 'output', data: 'PASS' },
      { type: 'error', data: 'Warning: deprecated API' },
      { type: 'done', exitCode: 0 },
    ]

    setTimeout(() => {
      for (const e of events) {
        eventBus.emit('script:output', 'ch1', e)
      }
    }, 10)

    for (const expected of events) {
      const result = await (iter as AsyncGenerator).next()
      expect(result.value.scriptOutput.type).toBe(expected.type)
    }
  })

  it('cleans up listener on return', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe(
      {},
      { worktreeId: 'wt-1', channel: 'ch1' },
      { eventBus } as any,
      {} as any,
    ) as AsyncGenerator

    setTimeout(() => {
      eventBus.emit('script:output', 'ch1', { type: 'output', data: 'x' })
    }, 10)

    await iter.next()
    await iter.return(undefined)
  })
})
