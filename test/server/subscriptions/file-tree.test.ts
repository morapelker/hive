import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus } from '../../../src/server/event-bus'
import type { FileTreeChangeEvent } from '../../../src/shared/types/file-tree'
import { fileTreeSubscriptionResolvers } from '../../../src/server/resolvers/subscription/file-tree.resolvers'

function getSubscribeFn() {
  const sub = fileTreeSubscriptionResolvers.Subscription!.fileTreeChange
  if (typeof sub === 'function') throw new Error('Expected object with subscribe')
  return (sub as { subscribe: (...args: any[]) => AsyncIterable<any> }).subscribe
}

describe('fileTreeChange subscription', () => {
  let eventBus: EventBus

  beforeEach(() => {
    eventBus = new EventBus()
  })

  it('yields file tree change events', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any)

    const event: FileTreeChangeEvent = {
      worktreePath: '/tmp/project/main',
      eventType: 'change',
      changedPath: '/tmp/project/main/src/index.ts',
      relativePath: 'src/index.ts',
    }

    setTimeout(() => eventBus.emit('file-tree:change', event), 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value).toEqual({ fileTreeChange: event })
  })

  it('filters by worktreePath when provided', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe(
      {},
      { worktreePath: '/tmp/project/main' },
      { eventBus } as any,
      {} as any,
    )

    setTimeout(() => {
      eventBus.emit('file-tree:change', {
        worktreePath: '/tmp/project/other',
        eventType: 'add',
        changedPath: '/tmp/project/other/foo.ts',
        relativePath: 'foo.ts',
      })
      eventBus.emit('file-tree:change', {
        worktreePath: '/tmp/project/main',
        eventType: 'unlink',
        changedPath: '/tmp/project/main/bar.ts',
        relativePath: 'bar.ts',
      })
    }, 10)

    const result = await (iter as AsyncGenerator).next()
    expect(result.value.fileTreeChange.worktreePath).toBe('/tmp/project/main')
    expect(result.value.fileTreeChange.eventType).toBe('unlink')
  })

  it('cleans up listener on return', async () => {
    const subscribe = getSubscribeFn()
    const iter = subscribe({}, {}, { eventBus } as any, {} as any) as AsyncGenerator

    setTimeout(() => {
      eventBus.emit('file-tree:change', {
        worktreePath: '/tmp',
        eventType: 'change',
        changedPath: '/tmp/a.ts',
        relativePath: 'a.ts',
      })
    }, 10)

    await iter.next()
    await iter.return(undefined)
  })
})
