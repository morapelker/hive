/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import { worktreeSubscriptionResolvers } from '../../../src/server/resolvers/subscription/worktree.resolvers'

function getSubscribeFn() {
  const sub = (worktreeSubscriptionResolvers.Subscription as any).worktreeBranchRenamed
  return sub.subscribe as (...args: any[]) => AsyncIterable<any>
}

describe('worktreeBranchRenamed subscription', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  it('yields branch rename events', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any)

    setTimeout(() => {
      eventBus.emit('worktree:branchRenamed', {
        worktreeId: 'wt-1',
        newBranch: 'feature/new-name',
      })
    }, 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value).toEqual({
      worktreeBranchRenamed: {
        worktreeId: 'wt-1',
        newBranch: 'feature/new-name',
      },
    })
  })

  it('receives events for all worktrees (no filter)', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any)

    setTimeout(() => {
      eventBus.emit('worktree:branchRenamed', { worktreeId: 'wt-1', newBranch: 'a' })
      eventBus.emit('worktree:branchRenamed', { worktreeId: 'wt-2', newBranch: 'b' })
    }, 10)

    const r1 = await (iter as AsyncGenerator).next()
    const r2 = await (iter as AsyncGenerator).next()
    expect(r1.value.worktreeBranchRenamed.worktreeId).toBe('wt-1')
    expect(r2.value.worktreeBranchRenamed.worktreeId).toBe('wt-2')
  })

  it('cleans up listener on return', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any) as AsyncGenerator

    setTimeout(() => {
      eventBus.emit('worktree:branchRenamed', {
        worktreeId: 'wt-1',
        newBranch: 'x',
      })
    }, 10)

    await iter.next()
    await iter.return(undefined)
  })
})
