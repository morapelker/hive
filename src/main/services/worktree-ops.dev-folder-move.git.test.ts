// The same rule as worktree-ops.dev-folder-move.test.ts, on a real repository: a project folder
// has been renamed with a worktree inside it, and git has not been repaired yet. Shows what a
// sync in that state costs (the worktree's registration, for good) and that it costs nothing
// while the move's note names the project.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { closeDatabase, getDatabase } from '../db'
import { DEV_FOLDER_PENDING_MOVE_KEY, type PendingDevFolderMove } from './dev-folder/types'
import { syncWorktreesOp } from './worktree-ops'

/** null when better-sqlite3 loads under this Node (its binary may be Electron-ABI after `pnpm install`). */
const probeDatabase = (): Error | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.close()
    return null
  } catch (error) {
    return error as Error
  }
}

const describeIf = probeDatabase() ? describe.skip : describe

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' })

describeIf('worktree sync of a moved repository whose git links are not repaired yet', () => {
  let root: string
  let sequence = 0

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-sync-moved-repo-')))
    process.env.HIVE_SERVER_DB_PATH = join(root, 'hive.db')
    closeDatabase()
  })

  afterAll(() => {
    closeDatabase()
    delete process.env.HIVE_SERVER_DB_PATH
    rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    getDatabase().clearPendingDevFolderMove()
  })

  /**
   * A repository with a worktree inside its checkout, renamed as a whole. The rows already
   * point at the new place, as they do once a move has committed; git's own record of the
   * worktree still names the old one.
   */
  const makeMovedRepository = (): {
    projectId: string
    newPath: string
    nestedNew: string
    nestedId: string
  } => {
    const name = `svc-${++sequence}`
    const oldPath = join(root, 'old', name)
    const newPath = join(root, 'dev', name)
    const nestedOld = join(oldPath, '.claude', 'worktrees', 'nested')
    const nestedNew = join(newPath, '.claude', 'worktrees', 'nested')
    mkdirSync(oldPath, { recursive: true })
    mkdirSync(join(root, 'dev'), { recursive: true })
    git(oldPath, 'init', '-q', '-b', 'main')
    writeFileSync(join(oldPath, 'README.md'), `${name}\n`)
    writeFileSync(join(oldPath, '.gitignore'), '.claude/\n')
    git(oldPath, 'add', '.')
    git(oldPath, 'commit', '-q', '-m', 'first')
    git(oldPath, 'worktree', 'add', '-q', '-b', `nested-${sequence}`, nestedOld)
    renameSync(oldPath, newPath)

    const db = getDatabase()
    const project = db.createProject({ name, path: newPath })
    db.createWorktree({
      project_id: project.id,
      name: 'main',
      branch_name: 'main',
      path: newPath,
      is_default: true
    })
    const nested = db.createWorktree({
      project_id: project.id,
      name: 'nested',
      branch_name: `nested-${sequence}`,
      path: nestedNew
    })
    const pending: PendingDevFolderMove = {
      projectId: project.id,
      fromPath: oldPath,
      fromRealPath: oldPath,
      toPath: newPath,
      relocations: [{ from: [oldPath], to: newPath }]
    }
    db.setSetting(DEV_FOLDER_PENDING_MOVE_KEY, JSON.stringify(pending))
    // The state the rule is about: git knows the worktree, at a place that is gone.
    expect(git(newPath, 'worktree', 'list', '--porcelain')).toContain('prunable')
    return { projectId: project.id, newPath, nestedNew, nestedId: nested.id }
  }

  const registeredWorktrees = (repoPath: string): string[] =>
    git(repoPath, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))

  it('leaves the registration in place, so the repair that is owed still works', async () => {
    const { projectId, newPath, nestedNew, nestedId } = makeMovedRepository()

    const result = await syncWorktreesOp(getDatabase(), { projectId, projectPath: newPath })

    expect(result).toEqual({ success: true })
    expect(registeredWorktrees(newPath)).toHaveLength(2)
    expect(getDatabase().getWorktree(nestedId)?.status).toBe('active')

    // What the move does next: repair, then its own sync.
    git(newPath, 'worktree', 'repair', nestedNew)
    expect(registeredWorktrees(newPath)).toEqual([newPath, nestedNew])
    expect(git(newPath, 'worktree', 'list', '--porcelain')).not.toContain('prunable')
    expect(
      await syncWorktreesOp(
        getDatabase(),
        { projectId, projectPath: newPath },
        { forDevFolderMove: true }
      )
    ).toEqual({ success: true })
    expect(registeredWorktrees(newPath)).toEqual([newPath, nestedNew])
    expect(getDatabase().getWorktree(nestedId)?.status).toBe('active')
    expect(git(nestedNew, 'status', '--porcelain')).toBe('')
  })

  // The note also waits while the disk that holds the moved folder is not connected. A sync
  // asked for in that time has no folder to run git in, and nothing to do either.
  it('leaves everything alone while the moved folder is not on disk', async () => {
    const { projectId, newPath, nestedNew, nestedId } = makeMovedRepository()
    const away = `${newPath}-on-a-disk-that-is-away`
    renameSync(newPath, away)

    const result = await syncWorktreesOp(getDatabase(), { projectId, projectPath: newPath })

    expect(result).toEqual({ success: true })
    expect(getDatabase().getWorktree(nestedId)?.status).toBe('active')

    // The disk is back: the registration is still there for the repair that is owed.
    renameSync(away, newPath)
    expect(registeredWorktrees(newPath)).toHaveLength(2)
    git(newPath, 'worktree', 'repair', nestedNew)
    expect(git(nestedNew, 'status', '--porcelain')).toBe('')
  })

  it('would drop the registration for good without the note', async () => {
    const { projectId, newPath, nestedNew } = makeMovedRepository()
    getDatabase().clearPendingDevFolderMove()

    expect(await syncWorktreesOp(getDatabase(), { projectId, projectPath: newPath })).toEqual({
      success: true
    })

    // Pruned: git has forgotten the worktree, and nothing in its folder leads back.
    expect(registeredWorktrees(newPath)).toEqual([newPath])
    expect(() => git(nestedNew, 'status', '--porcelain')).toThrow(/not a git repository/)
  })
})
