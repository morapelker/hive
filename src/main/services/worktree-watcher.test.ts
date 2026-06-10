import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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

  it('watches MERGE_HEAD even when it does not exist at watch start', async () => {
    // Two chokidar watchers are created (git metadata + working tree) — capture
    // each instance's paths and handlers separately.
    const instances: Array<{ paths: unknown; handlers: Map<string, (path: string) => void> }> = []
    chokidarMocks.watch.mockImplementation((paths: unknown) => {
      const handlers = new Map<string, (path: string) => void>()
      instances.push({ paths, handlers })
      return {
        on: vi.fn((event: string, handler: (path: string) => void) => {
          handlers.set(event, handler)
        }),
        close: vi.fn().mockResolvedValue(undefined)
      }
    })

    const worktreePath = mkdtempSync(join(tmpdir(), 'hive-watcher-'))
    const gitDir = join(worktreePath, '.git')
    mkdirSync(gitDir)
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')

    try {
      const publishGitEvent = vi.fn()
      await watchWorktree(worktreePath, { publishGitEvent })

      // First watcher instance is the git metadata watcher
      const gitWatcherPaths = instances[0].paths as string[]
      const mergeHeadPath = join(gitDir, 'MERGE_HEAD')
      expect(gitWatcherPaths).toContain(mergeHeadPath)
      expect(gitWatcherPaths).toContain(join(gitDir, 'REBASE_HEAD'))
      expect(gitWatcherPaths).toContain(join(gitDir, 'CHERRY_PICK_HEAD'))

      // A merge starting later surfaces as an 'add' for MERGE_HEAD
      instances[0].handlers.get('add')?.(mergeHeadPath)
      await vi.advanceTimersByTimeAsync(300)

      expect(publishGitEvent).toHaveBeenCalledWith(GIT_STATUS_CHANGED_CHANNEL, {
        worktreePath
      })
    } finally {
      await cleanupWorktreeWatchers()
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })
})
