import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_STATUS_CHANGED_CHANNEL } from '../../shared/git-events'

const chokidarMocks = vi.hoisted(() => ({
  handlers: new Map<string, (path: string) => void>(),
  watch: vi.fn()
}))

const gitEventMocks = vi.hoisted(() => ({
  emitGitStatusChanged: vi.fn()
}))

vi.mock('chokidar', () => ({
  watch: chokidarMocks.watch
}))

vi.mock('./git-events', () => ({
  emitGitStatusChanged: gitEventMocks.emitGitStatusChanged
}))

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { cleanupWorktreeWatchers, watchWorktree } from './worktree-watcher'

describe('worktree watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    chokidarMocks.handlers.clear()
    chokidarMocks.watch.mockImplementation(() => ({
      on: vi.fn((event: string, handler: (path: string) => void) => {
        chokidarMocks.handlers.set(event, handler)
      }),
      close: vi.fn().mockResolvedValue(undefined)
    }))
  })

  afterEach(async () => {
    await cleanupWorktreeWatchers()
    vi.useRealTimers()
    chokidarMocks.watch.mockReset()
    gitEventMocks.emitGitStatusChanged.mockReset()
  })

  it('publishes debounced worktree changes through an injected server publisher', async () => {
    const publishGitEvent = vi.fn()

    await watchWorktree('/tmp/hive', { publishGitEvent })
    chokidarMocks.handlers.get('change')?.('/tmp/hive/src/App.tsx')
    await vi.advanceTimersByTimeAsync(500)

    expect(publishGitEvent).toHaveBeenCalledWith(GIT_STATUS_CHANGED_CHANNEL, {
      worktreePath: '/tmp/hive'
    })
    expect(gitEventMocks.emitGitStatusChanged).not.toHaveBeenCalled()
  })
})
