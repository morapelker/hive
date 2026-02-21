/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import { terminalSubscriptionResolvers } from '../../../src/server/resolvers/subscription/terminal.resolvers'

function getSubscribeFn(field: string) {
  const sub = (terminalSubscriptionResolvers.Subscription as any)[field]
  return sub.subscribe as (...args: any[]) => AsyncIterable<any>
}

describe('terminal subscriptions', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  describe('terminalData', () => {
    it('yields terminal output for the subscribed worktreeId', async () => {
      const subscribe = getSubscribeFn('terminalData')
      const iter = subscribe(
        {},
        { worktreeId: 'wt-1' },
        { eventBus } as any,
        {} as any,
      )

      setTimeout(() => eventBus.emit('terminal:data', 'wt-1', 'Hello\n'), 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value).toEqual({
        terminalData: { worktreeId: 'wt-1', data: 'Hello\n' },
      })
    })

    it('filters out events for other worktreeIds', async () => {
      const subscribe = getSubscribeFn('terminalData')
      const iter = subscribe(
        {},
        { worktreeId: 'wt-1' },
        { eventBus } as any,
        {} as any,
      )

      setTimeout(() => {
        eventBus.emit('terminal:data', 'wt-2', 'Wrong terminal')
        eventBus.emit('terminal:data', 'wt-1', 'Right terminal')
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value.terminalData.data).toBe('Right terminal')
    })

    it('cleans up listener on return', async () => {
      const subscribe = getSubscribeFn('terminalData')
      const iter = subscribe(
        {},
        { worktreeId: 'wt-1' },
        { eventBus } as any,
        {} as any,
      ) as AsyncGenerator

      setTimeout(() => eventBus.emit('terminal:data', 'wt-1', 'test'), 10)
      await iter.next()
      await iter.return(undefined)
    })
  })

  describe('terminalExit', () => {
    it('yields exit event for the subscribed worktreeId', async () => {
      const subscribe = getSubscribeFn('terminalExit')
      const iter = subscribe(
        {},
        { worktreeId: 'wt-1' },
        { eventBus } as any,
        {} as any,
      )

      setTimeout(() => eventBus.emit('terminal:exit', 'wt-1', 0), 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value).toEqual({
        terminalExit: { worktreeId: 'wt-1', code: 0 },
      })
    })

    it('filters out exit events for other worktreeIds', async () => {
      const subscribe = getSubscribeFn('terminalExit')
      const iter = subscribe(
        {},
        { worktreeId: 'wt-1' },
        { eventBus } as any,
        {} as any,
      )

      setTimeout(() => {
        eventBus.emit('terminal:exit', 'wt-2', 1)
        eventBus.emit('terminal:exit', 'wt-1', 0)
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value.terminalExit.code).toBe(0)
      expect(result.value.terminalExit.worktreeId).toBe('wt-1')
    })

    it('cleans up listener on return', async () => {
      const subscribe = getSubscribeFn('terminalExit')
      const iter = subscribe(
        {},
        { worktreeId: 'wt-1' },
        { eventBus } as any,
        {} as any,
      ) as AsyncGenerator

      setTimeout(() => {
        eventBus.emit('terminal:exit', 'wt-1', 0)
      }, 10)

      await iter.next()
      await iter.return(undefined)

      eventBus.emit('terminal:exit', 'wt-1', 1)
    })
  })
})
