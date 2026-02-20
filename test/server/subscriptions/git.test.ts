/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import { gitSubscriptionResolvers } from '../../../src/server/resolvers/subscription/git.resolvers'

function getSubscribeFn(field: string) {
  const sub = (gitSubscriptionResolvers.Subscription as any)[field]
  return sub.subscribe as (...args: any[]) => AsyncIterable<any>
}

describe('git subscriptions', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  describe('gitStatusChanged', () => {
    it('yields git status change events', async () => {
      const subscribe = getSubscribeFn('gitStatusChanged')
      const iter = subscribe({}, {}, { eventBus } as any, {} as any)

      setTimeout(() => {
        eventBus.emit('git:statusChanged', { worktreePath: '/tmp/project/main' })
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value).toEqual({
        gitStatusChanged: { worktreePath: '/tmp/project/main' },
      })
    })

    it('filters by worktreePath when provided', async () => {
      const subscribe = getSubscribeFn('gitStatusChanged')
      const iter = subscribe(
        {},
        { worktreePath: '/tmp/project/main' },
        { eventBus } as any,
        {} as any,
      )

      setTimeout(() => {
        eventBus.emit('git:statusChanged', { worktreePath: '/tmp/project/other' })
        eventBus.emit('git:statusChanged', { worktreePath: '/tmp/project/main' })
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value.gitStatusChanged.worktreePath).toBe('/tmp/project/main')
    })

    it('yields all events when worktreePath not provided', async () => {
      const subscribe = getSubscribeFn('gitStatusChanged')
      const iter = subscribe({}, {}, { eventBus } as any, {} as any)

      setTimeout(() => {
        eventBus.emit('git:statusChanged', { worktreePath: '/any/path' })
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value.gitStatusChanged.worktreePath).toBe('/any/path')
    })

    it('cleans up listener on return', async () => {
      const subscribe = getSubscribeFn('gitStatusChanged')
      const iter = subscribe({}, {}, { eventBus } as any, {} as any) as AsyncGenerator

      setTimeout(() => {
        eventBus.emit('git:statusChanged', { worktreePath: '/tmp' })
      }, 10)

      await iter.next()
      await iter.return(undefined)
    })
  })

  describe('gitBranchChanged', () => {
    it('yields branch change events', async () => {
      const subscribe = getSubscribeFn('gitBranchChanged')
      const iter = subscribe({}, {}, { eventBus } as any, {} as any)

      setTimeout(() => {
        eventBus.emit('git:branchChanged', { worktreePath: '/tmp/project/main' })
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value).toEqual({
        gitBranchChanged: { worktreePath: '/tmp/project/main' },
      })
    })

    it('filters by worktreePath when provided', async () => {
      const subscribe = getSubscribeFn('gitBranchChanged')
      const iter = subscribe(
        {},
        { worktreePath: '/tmp/project/feature' },
        { eventBus } as any,
        {} as any,
      )

      setTimeout(() => {
        eventBus.emit('git:branchChanged', { worktreePath: '/tmp/project/other' })
        eventBus.emit('git:branchChanged', { worktreePath: '/tmp/project/feature' })
      }, 10)

      const result = await (iter as AsyncGenerator).next()
      expect(result.value.gitBranchChanged.worktreePath).toBe('/tmp/project/feature')
    })
  })
})
