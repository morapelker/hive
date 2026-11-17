import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
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

import {
  cleanupWorktreeWatchers,
  getWorktreeWatcherCount,
  rebindWorktreeGitWatch,
  unwatchWorktree,
  watchWorktree
} from './worktree-watcher'

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

describe('rebindWorktreeGitWatch', () => {
  interface WatcherInstance {
    paths: unknown
    handlers: Map<string, (path: string) => void>
    close: ReturnType<typeof vi.fn>
  }

  // watchWorktree creates the git metadata watcher first, then the working tree watcher.
  let instances: WatcherInstance[]
  let root: string
  let oldCheckout: string
  let newCheckout: string
  let linkedWorktree: string

  const gitDirIn = (checkout: string): string => join(checkout, '.git', 'worktrees', 'feature')

  const gitPathsIn = (checkout: string): string[] => [
    join(gitDirIn(checkout), 'index'),
    join(gitDirIn(checkout), 'HEAD'),
    join(checkout, '.git', 'refs'),
    join(gitDirIn(checkout), 'MERGE_HEAD'),
    join(gitDirIn(checkout), 'REBASE_HEAD'),
    join(gitDirIn(checkout), 'CHERRY_PICK_HEAD')
  ]

  /** What moving the main checkout and `git worktree repair` leave behind for a linked worktree. */
  const moveCheckout = (): void => {
    mkdirSync(join(root, 'new'))
    renameSync(oldCheckout, newCheckout)
    writeFileSync(join(linkedWorktree, '.git'), `gitdir: ${gitDirIn(newCheckout)}\n`)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    instances = []
    chokidarMocks.watch.mockImplementation((paths: unknown) => {
      const instance: WatcherInstance = {
        paths,
        handlers: new Map(),
        close: vi.fn().mockResolvedValue(undefined)
      }
      instances.push(instance)
      return {
        on: vi.fn((event: string, handler: (path: string) => void) => {
          instance.handlers.set(event, handler)
        }),
        close: instance.close
      }
    })

    root = mkdtempSync(join(tmpdir(), 'hive-watcher-rebind-'))
    oldCheckout = join(root, 'old', 'proj')
    newCheckout = join(root, 'new', 'proj')
    mkdirSync(gitDirIn(oldCheckout), { recursive: true })
    mkdirSync(join(oldCheckout, '.git', 'refs'))
    writeFileSync(join(gitDirIn(oldCheckout), 'HEAD'), 'ref: refs/heads/feature\n')
    writeFileSync(join(gitDirIn(oldCheckout), 'index'), 'index')
    // The linked worktree is outside the checkout: it stays where it is when the checkout moves.
    linkedWorktree = join(root, 'worktrees', 'feature')
    mkdirSync(linkedWorktree, { recursive: true })
    writeFileSync(join(linkedWorktree, '.git'), `gitdir: ${gitDirIn(oldCheckout)}\n`)
  })

  afterEach(async () => {
    await cleanupWorktreeWatchers()
    vi.useRealTimers()
    chokidarMocks.watch.mockReset()
    gitEventMocks.emitGitStatusChanged.mockReset()
    rmSync(root, { recursive: true, force: true })
  })

  it('replaces only the git watcher, with one on the git dir the worktree points at now', async () => {
    const publishGitEvent = vi.fn()
    await watchWorktree(linkedWorktree, { publishGitEvent })
    expect(instances).toHaveLength(2)
    expect(instances[0].paths).toEqual(gitPathsIn(oldCheckout))

    moveCheckout()
    await expect(rebindWorktreeGitWatch(linkedWorktree)).resolves.toBe(true)

    expect(instances).toHaveLength(3)
    expect(instances[2].paths).toEqual(gitPathsIn(newCheckout))
    expect(instances[0].close).toHaveBeenCalledTimes(1)
    expect(instances[1].close).not.toHaveBeenCalled()
    expect(instances[2].close).not.toHaveBeenCalled()
    expect(getWorktreeWatcherCount()).toBe(1)

    // One refresh after the rebind, so the UI reads git from the new place.
    expect(publishGitEvent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(publishGitEvent).toHaveBeenCalledTimes(1)
    expect(publishGitEvent).toHaveBeenCalledWith(GIT_STATUS_CHANGED_CHANNEL, {
      worktreePath: linkedWorktree
    })

    // The new watcher reports to the same entry, through the same publisher.
    instances[2].handlers.get('change')?.(join(gitDirIn(newCheckout), 'HEAD'))
    await vi.advanceTimersByTimeAsync(300)
    expect(publishGitEvent).toHaveBeenCalledTimes(2)
    expect(gitEventMocks.emitGitStatusChanged).not.toHaveBeenCalled()
  })

  it('folds the refresh the move itself asked for into the one it schedules', async () => {
    const publishGitEvent = vi.fn()
    await watchWorktree(linkedWorktree, { publishGitEvent })

    moveCheckout()
    // chokidar reports the old git dir's files as removed: a refresh is pending.
    instances[0].handlers.get('unlink')?.(join(gitDirIn(oldCheckout), 'HEAD'))
    await vi.advanceTimersByTimeAsync(200)
    await rebindWorktreeGitWatch(linkedWorktree)

    await vi.advanceTimersByTimeAsync(299)
    expect(publishGitEvent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(publishGitEvent).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(publishGitEvent).toHaveBeenCalledTimes(1)
  })

  it('keeps the watch for every consumer that asked for it', async () => {
    await watchWorktree(linkedWorktree)
    await watchWorktree(linkedWorktree)
    moveCheckout()
    await rebindWorktreeGitWatch(linkedWorktree)

    // Two consumers: the first unwatch leaves both watchers running.
    await unwatchWorktree(linkedWorktree)
    expect(getWorktreeWatcherCount()).toBe(1)
    expect(instances[1].close).not.toHaveBeenCalled()
    expect(instances[2].close).not.toHaveBeenCalled()

    // The second ends the watch: it closes the git watcher the rebind put in place.
    await unwatchWorktree(linkedWorktree)
    expect(getWorktreeWatcherCount()).toBe(0)
    expect(instances[1].close).toHaveBeenCalledTimes(1)
    expect(instances[2].close).toHaveBeenCalledTimes(1)
    expect(instances[0].close).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a worktree that is not watched', async () => {
    moveCheckout()

    await expect(rebindWorktreeGitWatch(linkedWorktree)).resolves.toBe(false)

    expect(instances).toHaveLength(0)
    expect(getWorktreeWatcherCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(gitEventMocks.emitGitStatusChanged).not.toHaveBeenCalled()
  })

  it('refreshes nothing when the worktree is unwatched while the old watcher closes', async () => {
    const publishGitEvent = vi.fn()
    await watchWorktree(linkedWorktree, { publishGitEvent })
    let finishClosing: () => void = () => undefined
    instances[0].close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClosing = resolve
        })
    )

    moveCheckout()
    const rebinding = rebindWorktreeGitWatch(linkedWorktree)
    // The last consumer leaves before the old git watcher has finished closing.
    await unwatchWorktree(linkedWorktree)
    finishClosing()

    await expect(rebinding).resolves.toBe(false)
    expect(getWorktreeWatcherCount()).toBe(0)
    // Nothing is left open: the unwatch closed the watcher the rebind had just created.
    expect(instances).toHaveLength(3)
    expect(instances[1].close).toHaveBeenCalled()
    expect(instances[2].close).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(publishGitEvent).not.toHaveBeenCalled()
  })

  it('drops the git watcher when the worktree has no git dir any more', async () => {
    const publishGitEvent = vi.fn()
    await watchWorktree(linkedWorktree, { publishGitEvent })
    rmSync(join(linkedWorktree, '.git'))

    await expect(rebindWorktreeGitWatch(linkedWorktree)).resolves.toBe(true)

    expect(instances).toHaveLength(2)
    expect(instances[0].close).toHaveBeenCalledTimes(1)
    expect(instances[1].close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(publishGitEvent).toHaveBeenCalledTimes(1)

    await unwatchWorktree(linkedWorktree)
    expect(instances[0].close).toHaveBeenCalledTimes(1)
    expect(instances[1].close).toHaveBeenCalledTimes(1)
  })
})
