import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { GIT_STATUS_CHANGED_CHANNEL } from '@shared/git-events'
import { makeEventBus } from '../events/event-bus'

const worktreeWatcherMocks = vi.hoisted(() => ({
  watchWorktree: vi.fn(),
  unwatchWorktree: vi.fn()
}))

vi.mock('../../main/services/worktree-watcher', () => ({
  watchWorktree: worktreeWatcherMocks.watchWorktree,
  unwatchWorktree: worktreeWatcherMocks.unwatchWorktree
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name === 'home') return '/tmp/hive-test-mock-home'
      return `/tmp/hive-test-mock-${name}`
    },
    getVersion: (): string => '1.1.10',
    quit: (): void => {}
  }
}))

import { makeLiveGitOpsRpcService } from '../rpc/domains/git-ops'

describe('git ops worktree watcher publisher', () => {
  it('starts the worktree watcher with a publisher bound to the server event bus', async () => {
    const eventBus = makeEventBus()
    const events: Array<{ channel: string; payload: unknown }> = []
    const unsubscribe = await Effect.runPromise(
      eventBus.subscribe(GIT_STATUS_CHANGED_CHANNEL, (event) => {
        events.push(event)
      })
    )
    const service = makeLiveGitOpsRpcService({ eventBus })

    try {
      const result = await Effect.runPromise(service.watchWorktree('/tmp/hive'))
      const options = worktreeWatcherMocks.watchWorktree.mock.calls[0]?.[1]

      expect(result).toEqual({ success: true })
      expect(options?.publishGitEvent).toEqual(expect.any(Function))

      await options.publishGitEvent(GIT_STATUS_CHANGED_CHANNEL, { worktreePath: '/tmp/hive' })

      expect(events).toEqual([
        {
          channel: GIT_STATUS_CHANGED_CHANNEL,
          payload: { worktreePath: '/tmp/hive' }
        }
      ])
    } finally {
      unsubscribe()
    }
  })
})
