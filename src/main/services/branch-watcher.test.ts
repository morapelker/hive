import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitEventMocks = vi.hoisted(() => ({
  emitGitBranchChanged: vi.fn()
}))

vi.mock('./git-events', () => ({
  emitGitBranchChanged: gitEventMocks.emitGitBranchChanged
}))

vi.mock('./logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import {
  cleanupBranchWatchers,
  getBranchWatcherCount,
  rebindBranchWatch,
  unwatchBranch,
  watchBranch
} from './branch-watcher'

// Git updates HEAD the same way on every symref change: write HEAD.lock, then
// rename it over HEAD (atomic replace). This swaps the inode, which is exactly
// what made a direct file watch go permanently stale on macOS.
const rewriteHeadLikeGit = (gitDir: string, content: string): void => {
  const lockPath = join(gitDir, 'HEAD.lock')
  writeFileSync(lockPath, content)
  renameSync(lockPath, join(gitDir, 'HEAD'))
}

describe('branch watcher', () => {
  let worktreePath: string
  let gitDir: string

  beforeEach(() => {
    gitEventMocks.emitGitBranchChanged.mockClear()
    worktreePath = mkdtempSync(join(tmpdir(), 'hive-branch-watcher-'))
    gitDir = join(worktreePath, '.git')
    mkdirSync(gitDir)
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
  })

  afterEach(async () => {
    await cleanupBranchWatchers()
    rmSync(worktreePath, { recursive: true, force: true })
  })

  it('emits branch changed for repeated atomic HEAD rewrites', { timeout: 15000 }, async () => {
    await watchBranch(worktreePath)
    // Give chokidar's initial scan a moment to settle before mutating
    await new Promise((resolve) => setTimeout(resolve, 300))

    rewriteHeadLikeGit(gitDir, 'ref: refs/heads/renamed-once\n')
    await vi.waitFor(
      () =>
        expect(gitEventMocks.emitGitBranchChanged).toHaveBeenCalledWith({
          worktreePath
        }),
      { timeout: 5000, interval: 50 }
    )

    // The second rewrite is the regression: a stale file watch on the replaced
    // inode never fires again, while the directory watch keeps working.
    gitEventMocks.emitGitBranchChanged.mockClear()
    rewriteHeadLikeGit(gitDir, 'ref: refs/heads/renamed-twice\n')
    await vi.waitFor(
      () =>
        expect(gitEventMocks.emitGitBranchChanged).toHaveBeenCalledWith({
          worktreePath
        }),
      { timeout: 5000, interval: 50 }
    )
  })

  it('ignores changes to other gitdir files', { timeout: 15000 }, async () => {
    await watchBranch(worktreePath)
    await new Promise((resolve) => setTimeout(resolve, 300))

    writeFileSync(join(gitDir, 'index'), 'not-head')
    writeFileSync(join(gitDir, 'COMMIT_EDITMSG'), 'message')
    // Wait past the debounce window — nothing should have been emitted
    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(gitEventMocks.emitGitBranchChanged).not.toHaveBeenCalled()
  })

  it('resolves linked-worktree gitdir pointers', { timeout: 15000 }, async () => {
    // Linked worktrees have a .git FILE pointing at the real gitdir
    const linkedRoot = mkdtempSync(join(tmpdir(), 'hive-linked-wt-'))
    const realGitDir = join(linkedRoot, 'repo.git', 'worktrees', 'feature')
    mkdirSync(realGitDir, { recursive: true })
    writeFileSync(join(realGitDir, 'HEAD'), 'ref: refs/heads/feature\n')
    const linkedWorktree = join(linkedRoot, 'feature')
    mkdirSync(linkedWorktree)
    writeFileSync(join(linkedWorktree, '.git'), `gitdir: ${realGitDir}\n`)

    try {
      await watchBranch(linkedWorktree)
      await new Promise((resolve) => setTimeout(resolve, 300))

      rewriteHeadLikeGit(realGitDir, 'ref: refs/heads/feature-renamed\n')
      await vi.waitFor(
        () =>
          expect(gitEventMocks.emitGitBranchChanged).toHaveBeenCalledWith({
            worktreePath: linkedWorktree
          }),
        { timeout: 5000, interval: 50 }
      )
    } finally {
      await cleanupBranchWatchers()
      rmSync(linkedRoot, { recursive: true, force: true })
    }
  })
})

describe('rebindBranchWatch', () => {
  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const expectBranchChanged = (worktreePath: string): Promise<void> =>
    vi.waitFor(
      () => expect(gitEventMocks.emitGitBranchChanged).toHaveBeenCalledWith({ worktreePath }),
      { timeout: 5000, interval: 50 }
    )

  let root: string
  let oldCheckout: string
  let newCheckout: string
  let oldGitDir: string
  let newGitDir: string
  let linkedWorktree: string

  /** What moving the main checkout and `git worktree repair` leave behind for a linked worktree. */
  const moveCheckout = (): void => {
    mkdirSync(join(root, 'new'))
    renameSync(oldCheckout, newCheckout)
    writeFileSync(join(linkedWorktree, '.git'), `gitdir: ${newGitDir}\n`)
  }

  beforeEach(() => {
    gitEventMocks.emitGitBranchChanged.mockClear()
    root = mkdtempSync(join(tmpdir(), 'hive-branch-rebind-'))
    oldCheckout = join(root, 'old', 'proj')
    newCheckout = join(root, 'new', 'proj')
    oldGitDir = join(oldCheckout, '.git', 'worktrees', 'feature')
    newGitDir = join(newCheckout, '.git', 'worktrees', 'feature')
    mkdirSync(oldGitDir, { recursive: true })
    writeFileSync(join(oldGitDir, 'HEAD'), 'ref: refs/heads/feature\n')
    // The linked worktree is outside the checkout: it stays where it is when the checkout moves.
    linkedWorktree = join(root, 'worktrees', 'feature')
    mkdirSync(linkedWorktree, { recursive: true })
    writeFileSync(join(linkedWorktree, '.git'), `gitdir: ${oldGitDir}\n`)
  })

  afterEach(async () => {
    await cleanupBranchWatchers()
    rmSync(root, { recursive: true, force: true })
  })

  it('watches HEAD in the git dir the worktree points at now', { timeout: 20000 }, async () => {
    await watchBranch(linkedWorktree)
    await settle(300)

    moveCheckout()
    // Let chokidar report the old directory as gone, and the debounce of that pass.
    await settle(800)
    gitEventMocks.emitGitBranchChanged.mockClear()

    if (process.platform === 'darwin') {
      // Why a rebind is needed: the watch is still on the directory that is gone. (Seen on
      // macOS; other platforms are not asserted because their watchers follow a moved
      // directory differently.)
      rewriteHeadLikeGit(newGitDir, 'ref: refs/heads/unseen\n')
      await settle(800)
      expect(gitEventMocks.emitGitBranchChanged).not.toHaveBeenCalled()
    }

    expect(rebindBranchWatch(linkedWorktree)).toBe(true)
    // One refresh, at once, so the sidebar reads the branch from the new place.
    expect(gitEventMocks.emitGitBranchChanged).toHaveBeenCalledTimes(1)
    expect(gitEventMocks.emitGitBranchChanged).toHaveBeenCalledWith({
      worktreePath: linkedWorktree
    })
    expect(getBranchWatcherCount()).toBe(1)

    await settle(300)
    gitEventMocks.emitGitBranchChanged.mockClear()
    rewriteHeadLikeGit(newGitDir, 'ref: refs/heads/renamed\n')
    await expectBranchChanged(linkedWorktree)
  })

  it(
    'emits one refresh for the move when it runs right after the checkout moved',
    { timeout: 20000 },
    async () => {
      await watchBranch(linkedWorktree)
      await settle(300)

      moveCheckout()
      expect(rebindBranchWatch(linkedWorktree)).toBe(true)

      // What chokidar still reports about the old directory is not this worktree's HEAD any
      // more, so nothing follows the refresh the rebind emitted.
      await settle(800)
      expect(gitEventMocks.emitGitBranchChanged).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps the watch for every consumer that asked for it', { timeout: 20000 }, async () => {
    await watchBranch(linkedWorktree)
    await watchBranch(linkedWorktree)
    await settle(300)

    moveCheckout()
    expect(rebindBranchWatch(linkedWorktree)).toBe(true)
    await settle(300)

    // Two consumers: the first unwatch leaves the watch running, the second ends it.
    await unwatchBranch(linkedWorktree)
    expect(getBranchWatcherCount()).toBe(1)
    gitEventMocks.emitGitBranchChanged.mockClear()
    rewriteHeadLikeGit(newGitDir, 'ref: refs/heads/still-watched\n')
    await expectBranchChanged(linkedWorktree)

    await unwatchBranch(linkedWorktree)
    expect(getBranchWatcherCount()).toBe(0)
  })

  it('does nothing for a worktree that is not watched', () => {
    moveCheckout()

    expect(rebindBranchWatch(linkedWorktree)).toBe(false)
    expect(rebindBranchWatch(join(root, 'never-watched'))).toBe(false)
    expect(getBranchWatcherCount()).toBe(0)
    expect(gitEventMocks.emitGitBranchChanged).not.toHaveBeenCalled()
  })

  it('does nothing while the git dir is where it was', { timeout: 20000 }, async () => {
    await watchBranch(linkedWorktree)
    await settle(300)

    expect(rebindBranchWatch(linkedWorktree)).toBe(false)
    expect(gitEventMocks.emitGitBranchChanged).not.toHaveBeenCalled()

    // The watch it had still works.
    rewriteHeadLikeGit(oldGitDir, 'ref: refs/heads/renamed\n')
    await expectBranchChanged(linkedWorktree)
  })

  it(
    'does nothing while the pointer is not repaired, then follows it once it is',
    { timeout: 20000 },
    async () => {
      await watchBranch(linkedWorktree)
      await settle(300)

      // The checkout moved but the worktree still points at the old place: no HEAD there.
      mkdirSync(join(root, 'new'))
      renameSync(oldCheckout, newCheckout)
      await settle(800)
      gitEventMocks.emitGitBranchChanged.mockClear()
      expect(rebindBranchWatch(linkedWorktree)).toBe(false)
      expect(gitEventMocks.emitGitBranchChanged).not.toHaveBeenCalled()
      expect(getBranchWatcherCount()).toBe(1)

      writeFileSync(join(linkedWorktree, '.git'), `gitdir: ${newGitDir}\n`)
      expect(rebindBranchWatch(linkedWorktree)).toBe(true)
      await settle(300)
      gitEventMocks.emitGitBranchChanged.mockClear()
      rewriteHeadLikeGit(newGitDir, 'ref: refs/heads/renamed\n')
      await expectBranchChanged(linkedWorktree)
    }
  )
})
