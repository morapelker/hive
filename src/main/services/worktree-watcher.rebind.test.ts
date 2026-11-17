/**
 * Both git watchers against a real repository and the real chokidar (the unit tests next to
 * this file mock it): the main checkout moves, `git worktree repair` rewrites the pointer of a
 * linked worktree that stayed where it was, and the rebinds make the watchers report that
 * worktree again.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_STATUS_CHANGED_CHANNEL } from '../../shared/git-events'

const gitEventMocks = vi.hoisted(() => ({
  emitGitBranchChanged: vi.fn(),
  emitGitStatusChanged: vi.fn()
}))

vi.mock('./git-events', () => ({
  emitGitBranchChanged: gitEventMocks.emitGitBranchChanged,
  emitGitStatusChanged: gitEventMocks.emitGitStatusChanged
}))

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { cleanupBranchWatchers, rebindBranchWatch, watchBranch } from './branch-watcher'
import { cleanupWorktreeWatchers, rebindWorktreeGitWatch, watchWorktree } from './worktree-watcher'

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** git with nothing of the developer's own configuration (signing, hooks, templates). */
const git = (cwd: string, args: string[]): void => {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Hive Test',
      GIT_AUTHOR_EMAIL: 'hive@example.test',
      GIT_COMMITTER_NAME: 'Hive Test',
      GIT_COMMITTER_EMAIL: 'hive@example.test'
    }
  })
}

describe('git watchers of a linked worktree whose main checkout moved', () => {
  let root: string
  let oldCheckout: string
  let newCheckout: string
  let linkedWorktree: string

  beforeEach(() => {
    gitEventMocks.emitGitBranchChanged.mockClear()
    gitEventMocks.emitGitStatusChanged.mockClear()
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-watchers-rebind-')))
    oldCheckout = join(root, 'old', 'proj')
    newCheckout = join(root, 'new', 'proj')
    linkedWorktree = join(root, 'worktrees', 'feature')
    mkdirSync(oldCheckout, { recursive: true })
    mkdirSync(join(root, 'worktrees'))
    mkdirSync(join(root, 'new'))
    git(oldCheckout, ['init'])
    writeFileSync(join(oldCheckout, 'tracked.txt'), 'tracked\n')
    git(oldCheckout, ['add', 'tracked.txt'])
    git(oldCheckout, ['commit', '-m', 'initial'])
    git(oldCheckout, ['worktree', 'add', '-b', 'feature', linkedWorktree])
  })

  afterEach(async () => {
    await cleanupWorktreeWatchers()
    await cleanupBranchWatchers()
    rmSync(root, { recursive: true, force: true })
  })

  it('report the worktree again once they are rebound', { timeout: 30000 }, async () => {
    const publishGitEvent = vi.fn()
    const expectStatusChanged = (): Promise<void> =>
      vi.waitFor(
        () =>
          expect(publishGitEvent).toHaveBeenCalledWith(GIT_STATUS_CHANGED_CHANNEL, {
            worktreePath: linkedWorktree
          }),
        { timeout: 5000, interval: 50 }
      )
    const expectBranchChanged = (): Promise<void> =>
      vi.waitFor(
        () =>
          expect(gitEventMocks.emitGitBranchChanged).toHaveBeenCalledWith({
            worktreePath: linkedWorktree
          }),
        { timeout: 5000, interval: 50 }
      )

    await watchWorktree(linkedWorktree, { publishGitEvent })
    await watchBranch(linkedWorktree)
    await settle(500)

    // The checkout moves; the linked worktree stays and is repaired from the new place.
    renameSync(oldCheckout, newCheckout)
    git(newCheckout, ['worktree', 'repair', linkedWorktree])
    // Let the watchers report what the move itself did (the old git dir is gone).
    await settle(1200)
    publishGitEvent.mockClear()
    gitEventMocks.emitGitBranchChanged.mockClear()

    if (process.platform === 'darwin') {
      // Why the rebinds are needed: a commit and a branch switch in the worktree change only
      // git metadata, which now lives under the new checkout, and nothing is reported. (Seen on
      // macOS; other platforms are not asserted because their watchers follow a moved
      // directory differently.)
      git(linkedWorktree, ['commit', '--allow-empty', '-m', 'unseen'])
      git(linkedWorktree, ['checkout', '-b', 'unseen'])
      await settle(1200)
      expect(publishGitEvent).not.toHaveBeenCalled()
      expect(gitEventMocks.emitGitBranchChanged).not.toHaveBeenCalled()
    }

    await expect(rebindWorktreeGitWatch(linkedWorktree)).resolves.toBe(true)
    expect(rebindBranchWatch(linkedWorktree)).toBe(true)
    // Each rebind asks for one refresh.
    expect(gitEventMocks.emitGitBranchChanged).toHaveBeenCalledTimes(1)
    await expectStatusChanged()
    expect(publishGitEvent).toHaveBeenCalledTimes(1)

    await settle(500)
    publishGitEvent.mockClear()
    gitEventMocks.emitGitBranchChanged.mockClear()

    // Neither command touches a file of the working tree: only the git watchers can see them.
    git(linkedWorktree, ['commit', '--allow-empty', '-m', 'after the move'])
    await expectStatusChanged()
    git(linkedWorktree, ['checkout', '-b', 'renamed'])
    await expectBranchChanged()
    expect(gitEventMocks.emitGitStatusChanged).not.toHaveBeenCalled()
  })
})
