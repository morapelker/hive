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

import { cleanupBranchWatchers, watchBranch } from './branch-watcher'

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
