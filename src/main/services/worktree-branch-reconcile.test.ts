// A branch name lives in git; the database keeps copies of it. These tests rename, switch and
// detach branches in real repositories and check what the copies do: a worktree row follows
// its checkout, a rename takes the worktrees based on the old name with it, a switch takes
// nothing, and a base that went stale while nobody looked is found again through git's reflog.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const events = vi.hoisted(() => ({
  branchRenamed: vi.fn(),
  gitBranchChanged: vi.fn(),
  dbChanged: vi.fn()
}))

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('./worktree-events', () => ({ emitWorktreeBranchRenamed: events.branchRenamed }))
vi.mock('./git-events', () => ({ emitGitBranchChanged: events.gitBranchChanged }))
vi.mock('./db-change-events', () => ({ emitDbChanged: events.dbChanged }))

import type { Worktree, WorktreeUpdate } from '../db/types'
import { readHeadBranch } from './git-head'
import {
  healStaleBaseBranches,
  readBranchRenames,
  readWithLiveBranches,
  reconcileWorktreeBranch,
  recordBranchRename,
  refResolves,
  worktreeNameForBranch,
  type BranchReconcileDb
} from './worktree-branch-reconcile'

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

const PROJECT = 'project-1'

/** The worktree rows of one project, behind the methods the reconciliation uses. */
class FakeDb implements BranchReconcileDb {
  readonly rows = new Map<string, Worktree>()
  readonly documentRunRenames: unknown[] = []
  readonly pendingLaunchRenames: unknown[] = []

  add(row: Partial<Worktree> & Pick<Worktree, 'id' | 'path' | 'branch_name'>): Worktree {
    const worktree = {
      project_id: PROJECT,
      name: row.branch_name,
      status: 'active',
      is_default: false,
      branch_renamed: 0,
      base_branch: null,
      ...row
    } as Worktree
    this.rows.set(worktree.id, worktree)
    return worktree
  }

  getWorktree(id: string): Worktree | null {
    return this.rows.get(id) ?? null
  }

  getActiveWorktreesByProject(projectId: string): Worktree[] {
    return [...this.rows.values()].filter(
      (w) => w.project_id === projectId && w.status === 'active'
    )
  }

  updateWorktree(id: string, data: WorktreeUpdate): Worktree | null {
    const row = this.rows.get(id)
    if (!row) return null
    const next = { ...row, ...data } as Worktree
    this.rows.set(id, next)
    return next
  }

  repointWorktreeBaseBranch(projectId: string, oldBranch: string, newBranch: string): string[] {
    const ids: string[] = []
    for (const row of this.getActiveWorktreesByProject(projectId)) {
      if (row.base_branch !== oldBranch) continue
      this.rows.set(row.id, { ...row, base_branch: newBranch })
      ids.push(row.id)
    }
    return ids
  }

  renameBranchInDocumentRuns(rename: unknown): string[] {
    this.documentRunRenames.push(rename)
    return []
  }

  renameBranchInPendingLaunches(projectId: string, oldBranch: string, newBranch: string): number {
    this.pendingLaunchRenames.push({ projectId, oldBranch, newBranch })
    return 0
  }
}

describe('branch names follow git', () => {
  let root: string
  let sequence = 0
  let repo: string
  let db: FakeDb

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-branch-reconcile-')))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** A repository on `main` with one commit. */
  beforeEach(() => {
    events.branchRenamed.mockClear()
    events.gitBranchChanged.mockClear()
    events.dbChanged.mockClear()
    repo = join(root, `repo-${++sequence}`)
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'README.md'), 'hello\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    db = new FakeDb()
  })

  /** A linked worktree of `repo` on a new branch cut from `from`. */
  const addWorktree = (branch: string, from = 'main'): string => {
    const path = join(root, `wt-${sequence}-${branch.replace(/\//g, '-')}`)
    git(repo, 'worktree', 'add', '-q', '-b', branch, path, from)
    return path
  }

  describe('readHeadBranch', () => {
    it('reads the branch of a main checkout and of a linked worktree', () => {
      const path = addWorktree('feature/login')
      expect(readHeadBranch(repo)).toBe('main')
      expect(readHeadBranch(path)).toBe('feature/login')
    })

    it('sees a rename at once', () => {
      const path = addWorktree('corgi')
      git(path, 'branch', '-m', 'corgi', 'fix-login')
      expect(readHeadBranch(path)).toBe('fix-login')
    })

    // null is "cannot say", never "no branch": the caller keeps the name it has.
    it('is null for a detached HEAD and for a path that is not a checkout', () => {
      const path = addWorktree('corgi')
      git(path, 'checkout', '-q', '--detach')
      expect(readHeadBranch(path)).toBeNull()
      expect(readHeadBranch(join(root, 'no-such-directory'))).toBeNull()
      expect(readHeadBranch(root)).toBeNull()
    })
  })

  describe('reconcileWorktreeBranch', () => {
    it('leaves a row alone, without events, while it agrees with the checkout', async () => {
      const path = addWorktree('feature')
      const row = db.add({ id: 'w1', path, branch_name: 'feature' })

      expect(await reconcileWorktreeBranch(db, row)).toBe(row)
      expect(events.branchRenamed).not.toHaveBeenCalled()
      expect(events.dbChanged).not.toHaveBeenCalled()
    })

    // The bug: a branch renamed in a terminal, and the worktrees cut from it still compare
    // with (and want to merge into) the name that is gone.
    it('follows a rename and takes the worktrees based on the old name with it', async () => {
      const basePath = addWorktree('corgi')
      const childPath = addWorktree('child', 'corgi')
      const base = db.add({ id: 'base', path: basePath, branch_name: 'corgi' })
      db.add({ id: 'child', path: childPath, branch_name: 'child', base_branch: 'corgi' })
      db.add({ id: 'other', path: join(root, 'elsewhere'), branch_name: 'x', base_branch: 'main' })

      git(basePath, 'branch', '-m', 'corgi', 'fix-login')
      const reconciled = await reconcileWorktreeBranch(db, base)

      expect(reconciled.branch_name).toBe('fix-login')
      // The display name was the branch's name, so it follows
      expect(reconciled.name).toBe('fix-login')
      expect(db.getWorktree('child')?.base_branch).toBe('fix-login')
      expect(db.getWorktree('other')?.base_branch).toBe('main')
      expect(db.documentRunRenames).toEqual([
        { projectId: PROJECT, worktreeId: 'base', oldBranch: 'corgi', newBranch: 'fix-login' }
      ])
      expect(db.pendingLaunchRenames).toEqual([
        { projectId: PROJECT, oldBranch: 'corgi', newBranch: 'fix-login' }
      ])
      expect(events.branchRenamed).toHaveBeenCalledWith({
        worktreeId: 'base',
        newBranch: 'fix-login',
        worktreePath: basePath,
        projectId: PROJECT,
        oldBranch: 'corgi'
      })
      // Both changed rows are announced under an origin no window filters out
      const announced = events.dbChanged.mock.calls.map(([event]) => [
        event.id,
        event.originClientId
      ])
      expect(announced).toContainEqual(['base', 'branch-reconcile'])
      expect(announced).toContainEqual(['child', 'branch-reconcile'])
    })

    // The old branch still exists: nothing was renamed, and what is based on it stays.
    it('follows a switch to another branch without moving anything based on the old one', async () => {
      const basePath = addWorktree('feature')
      const childPath = addWorktree('child', 'feature')
      const base = db.add({ id: 'base', path: basePath, branch_name: 'feature' })
      db.add({ id: 'child', path: childPath, branch_name: 'child', base_branch: 'feature' })

      git(basePath, 'switch', '-q', '-c', 'experiment')
      const reconciled = await reconcileWorktreeBranch(db, base)

      expect(reconciled.branch_name).toBe('experiment')
      expect(db.getWorktree('child')?.base_branch).toBe('feature')
      expect(db.documentRunRenames).toEqual([])
      expect(events.branchRenamed).toHaveBeenCalledWith({
        worktreeId: 'base',
        newBranch: 'experiment',
        worktreePath: basePath,
        projectId: PROJECT
      })
    })

    it('keeps the last known branch while HEAD is detached', async () => {
      const path = addWorktree('feature')
      const row = db.add({ id: 'w1', path, branch_name: 'feature' })

      git(path, 'checkout', '-q', '--detach')

      expect(await reconcileWorktreeBranch(db, row)).toBe(row)
      expect(db.getWorktree('w1')?.branch_name).toBe('feature')
    })

    it('keeps a display name the user chose', async () => {
      const path = addWorktree('feature')
      const row = db.add({ id: 'w1', path, branch_name: 'feature', name: 'Login rework' })

      git(path, 'branch', '-m', 'feature', 'feature-2')

      expect((await reconcileWorktreeBranch(db, row)).name).toBe('Login rework')
    })

    // A recorded worktree whose directory has a `.git` directory of its own is the main
    // checkout of some other repository: its branch is not this worktree's branch.
    it('does not take the branch of a directory that is not a linked worktree', async () => {
      const stray = join(root, `stray-${sequence}`)
      mkdirSync(stray)
      git(stray, 'init', '-q', '-b', 'someone-elses-branch')
      const row = db.add({ id: 'w1', path: stray, branch_name: 'feature' })

      expect(readHeadBranch(stray)).toBe('someone-elses-branch')
      expect(readHeadBranch(stray, { linkedOnly: true })).toBeNull()
      expect(await reconcileWorktreeBranch(db, row)).toBe(row)
      // The project's own checkout is a main checkout, and is followed
      const main = db.add({ id: 'default', path: repo, branch_name: 'old-main', is_default: true })
      expect((await reconcileWorktreeBranch(db, main)).branch_name).toBe('main')
    })

    it('does not touch an archived worktree', async () => {
      const path = addWorktree('feature')
      const row = db.add({ id: 'w1', path, branch_name: 'old-name', status: 'archived' })

      expect(await reconcileWorktreeBranch(db, row)).toBe(row)
    })
  })

  describe('readWithLiveBranches', () => {
    it('hands out the rows as the database holds them after the reconciliation', async () => {
      const basePath = addWorktree('corgi')
      const childPath = addWorktree('child', 'corgi')
      db.add({ id: 'child', path: childPath, branch_name: 'child', base_branch: 'corgi' })
      db.add({ id: 'base', path: basePath, branch_name: 'corgi' })
      git(basePath, 'branch', '-m', 'corgi', 'fix-login')

      // `child` is read before `base` is reconciled: the second read is what carries its base
      const rows = await readWithLiveBranches(db, () => db.getActiveWorktreesByProject(PROJECT))

      expect(rows.map((w) => [w.id, w.branch_name, w.base_branch])).toEqual([
        ['child', 'child', 'fix-login'],
        ['base', 'fix-login', null]
      ])
    })

    it('reads once when nothing changed, and passes a missing row through', async () => {
      const path = addWorktree('feature')
      db.add({ id: 'w1', path, branch_name: 'feature' })
      const read = vi.fn(() => db.getWorktree('w1'))

      expect((await readWithLiveBranches(db, read))?.branch_name).toBe('feature')
      expect(read).toHaveBeenCalledTimes(1)
      expect(await readWithLiveBranches(db, () => db.getWorktree('nope'))).toBeNull()
    })
  })

  describe('recordBranchRename', () => {
    const rename = { projectId: PROJECT, worktreeId: 'w1', oldBranch: 'a', newBranch: 'b' }

    it('works with a database that only knows worktrees', () => {
      expect(() => recordBranchRename({}, rename)).not.toThrow()
    })

    // One copy that cannot be rewritten must not keep the others on the old name.
    it('carries on past a step that fails', () => {
      db.add({ id: 'child', path: '/x', branch_name: 'child', base_branch: 'a' })
      db.renameBranchInDocumentRuns = () => {
        throw new Error('no such table')
      }

      recordBranchRename(db, rename)

      expect(db.getWorktree('child')?.base_branch).toBe('b')
      expect(db.pendingLaunchRenames).toHaveLength(1)
    })

    it('does nothing for a rename to the same name', () => {
      recordBranchRename(db, { ...rename, newBranch: 'a' })
      expect(db.pendingLaunchRenames).toEqual([])
    })
  })

  describe('renames remembered by git', () => {
    it('reads every rename from the reflogs, the latest one of a name first', async () => {
      const path = addWorktree('feat')
      git(path, 'branch', '-m', 'feat', 'feat-2')
      git(path, 'branch', '-m', 'feat-2', 'feat-3')
      git(repo, 'branch', 'side')
      git(repo, 'branch', '-m', 'side', 'side-2')

      expect(Object.fromEntries(await readBranchRenames(repo))).toEqual({
        feat: 'feat-2',
        'feat-2': 'feat-3',
        side: 'side-2'
      })
    })

    it('is empty for a path that is not a repository', async () => {
      expect((await readBranchRenames(join(root, 'nowhere'))).size).toBe(0)
    })

    it('tells a missing ref from a git that could not answer', async () => {
      expect(await refResolves(repo, 'main')).toBe(true)
      expect(await refResolves(repo, 'no-such-branch')).toBe(false)
      expect(await refResolves(join(root, 'nowhere'), 'main')).toBeNull()
    })
  })

  // A rename nobody watched: made while the app was closed, or before the app kept bases in
  // step. The worktree on the renamed branch is long gone from the picture (here: its row
  // already says the new name), only the dependents still name the old one.
  describe('healStaleBaseBranches', () => {
    it('follows a chain of renames to the branch that exists now', async () => {
      const basePath = addWorktree('corgi')
      const childPath = addWorktree('child', 'corgi')
      git(basePath, 'branch', '-m', 'corgi', 'draft')
      git(basePath, 'branch', '-m', 'draft', 'fix-login')
      db.add({ id: 'base', path: basePath, branch_name: 'fix-login' })
      db.add({ id: 'child', path: childPath, branch_name: 'child', base_branch: 'corgi' })

      await healStaleBaseBranches(db, PROJECT, repo)

      expect(db.getWorktree('child')?.base_branch).toBe('fix-login')
      expect(events.dbChanged).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'child', originClientId: 'branch-reconcile' })
      )
    })

    it('leaves a base that exists, checked out or not, and one that was deleted', async () => {
      const childPath = addWorktree('child')
      git(repo, 'branch', 'release')
      git(repo, 'branch', 'doomed')
      git(repo, 'branch', '-D', 'doomed')
      db.add({ id: 'default', path: repo, branch_name: 'main', is_default: true })
      db.add({ id: 'a', path: childPath, branch_name: 'child', base_branch: 'main' })
      db.add({ id: 'b', path: '/b', branch_name: 'b', base_branch: 'release' })
      db.add({ id: 'c', path: '/c', branch_name: 'c', base_branch: 'doomed' })

      await healStaleBaseBranches(db, PROJECT, repo)

      expect(db.getWorktree('a')?.base_branch).toBe('main')
      expect(db.getWorktree('b')?.base_branch).toBe('release')
      expect(db.getWorktree('c')?.base_branch).toBe('doomed')
    })

    // Renamed away and renamed back: the name exists again, there is nothing to heal.
    it('does not loop on a branch renamed back to an old name', async () => {
      const basePath = addWorktree('one')
      git(basePath, 'branch', '-m', 'one', 'two')
      git(basePath, 'branch', '-m', 'two', 'one')
      git(basePath, 'branch', '-m', 'one', 'two')
      git(basePath, 'checkout', '-q', '--detach')
      git(repo, 'branch', '-D', 'two')
      db.add({ id: 'child', path: '/child', branch_name: 'child', base_branch: 'one' })

      await healStaleBaseBranches(db, PROJECT, repo)

      expect(db.getWorktree('child')?.base_branch).toBe('one')
    })
  })

  describe('worktreeNameForBranch', () => {
    it('follows the branch while the name is the branch or a generated placeholder', () => {
      const path = '/somewhere/project--corgi'
      expect(worktreeNameForBranch({ name: 'a', branch_name: 'a', path }, 'b')).toBe('b')
      expect(worktreeNameForBranch({ name: 'beagle-2', branch_name: 'x', path }, 'b')).toBe('b')
      expect(worktreeNameForBranch({ name: 'Mine', branch_name: 'a', path }, 'b')).toBeUndefined()
      expect(worktreeNameForBranch({ name: 'a', branch_name: 'a', path }, '')).toBe(
        'project--corgi'
      )
    })
  })
})
