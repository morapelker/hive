// Renaming a branch, end to end: real repositories and the real database. Every way a branch
// gets a new name (the app's rename, the auto-rename from a session title, `git branch -m` in
// a terminal) must leave the database naming branches that exist — the worktree's own, and
// the base of every worktree cut from it, which is what merge-on-done and the review diff
// compare with. Archive must delete the branch the checkout is on, whatever the caller calls it.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { DEFAULT_DOCUMENT_RUN_CONFIG } from '@shared/types/document-flow'
import { closeDatabase, getDatabase } from '../db'
import type { Worktree } from '../db/types'
import { autoRenameWorktreeBranch } from './git-service'
import { readWithLiveBranches } from './worktree-branch-reconcile'
import { deleteWorktreeOp, renameWorktreeBranchOp, syncWorktreesOp } from './worktree-ops'

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

describeIf('renaming a branch keeps every stored branch name in step', () => {
  let root: string
  let sequence = 0
  let repo: string
  let projectId: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-branch-rename-')))
    process.env.HIVE_SERVER_DB_PATH = join(root, 'hive.db')
    closeDatabase()
  })

  afterAll(() => {
    closeDatabase()
    delete process.env.HIVE_SERVER_DB_PATH
    rmSync(root, { recursive: true, force: true })
  })

  /** A project on `main` with one commit, and its default worktree row. */
  beforeEach(() => {
    repo = join(root, `repo-${++sequence}`)
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'README.md'), 'hello\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    const db = getDatabase()
    projectId = db.createProject({ name: `repo-${sequence}`, path: repo }).id
    db.createWorktree({
      project_id: projectId,
      name: 'main',
      branch_name: 'main',
      path: repo,
      is_default: true
    })
  })

  /** A linked worktree on a new branch cut from `from`, recorded the way the app records it. */
  const addWorktree = (branch: string, from = 'main'): Worktree => {
    const path = join(root, `wt-${sequence}-${branch}`)
    git(repo, 'worktree', 'add', '-q', '-b', branch, path, from)
    return getDatabase().createWorktree({
      project_id: projectId,
      name: branch,
      branch_name: branch,
      path,
      base_branch: from
    })
  }

  const row = (id: string): Worktree => {
    const worktree = getDatabase().getWorktree(id)
    if (!worktree) throw new Error(`no worktree ${id}`)
    return worktree
  }

  const branches = (): string[] =>
    git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').trim().split('\n').sort()

  describe('the app renames a branch', () => {
    it('re-points the worktrees that were cut from it', async () => {
      const parent = addWorktree('feature')
      const child = addWorktree('child', 'feature')
      const unrelated = addWorktree('unrelated')

      const result = await renameWorktreeBranchOp(getDatabase(), {
        worktreeId: parent.id,
        worktreePath: parent.path,
        oldBranch: 'feature',
        newBranch: 'feature-login'
      })

      expect(result).toEqual({ success: true })
      expect(branches()).toEqual(['child', 'feature-login', 'main', 'unrelated'])
      expect(row(parent.id)).toMatchObject({ branch_name: 'feature-login', name: 'feature-login' })
      expect(row(child.id).base_branch).toBe('feature-login')
      expect(row(unrelated.id).base_branch).toBe('main')
      // What merge-on-done asks git: the comparison with the base resolves again
      expect(() =>
        git(row(child.id).path, 'diff', '--shortstat', `${row(child.id).base_branch}...HEAD`)
      ).not.toThrow()
    })

    // The window's copy of the name is behind: the branch was renamed in a terminal since.
    // `git branch -m <stale> <new>` would fail; the branch the checkout is on is renamed.
    it('renames the branch the checkout is on when the caller names a stale one', async () => {
      const parent = addWorktree('beagle')
      const child = addWorktree('child', 'beagle')
      git(parent.path, 'branch', '-m', 'beagle', 'draft')

      const result = await renameWorktreeBranchOp(getDatabase(), {
        worktreeId: parent.id,
        worktreePath: parent.path,
        oldBranch: 'beagle',
        newBranch: 'final'
      })

      expect(result).toEqual({ success: true })
      expect(branches()).toEqual(['child', 'final', 'main'])
      expect(row(parent.id).branch_name).toBe('final')
      // Followed through both renames: the one made outside, then this one
      expect(row(child.id).base_branch).toBe('final')
    })

    it('stops tracking the remote branch of the old name, and keeps any other upstream', async () => {
      const remote = join(root, `remote-${sequence}.git`)
      git(root, 'init', '-q', '--bare', remote)
      git(repo, 'remote', 'add', 'origin', remote)
      git(repo, 'push', '-q', 'origin', 'main')
      const pushed = addWorktree('pushed')
      git(pushed.path, 'push', '-q', '--set-upstream', 'origin', 'pushed')
      const tracksMain = addWorktree('tracks-main')
      git(tracksMain.path, 'branch', '--set-upstream-to=origin/main')

      await renameWorktreeBranchOp(getDatabase(), {
        worktreeId: pushed.id,
        worktreePath: pushed.path,
        oldBranch: 'pushed',
        newBranch: 'pushed-2'
      })
      await renameWorktreeBranchOp(getDatabase(), {
        worktreeId: tracksMain.id,
        worktreePath: tracksMain.path,
        oldBranch: 'tracks-main',
        newBranch: 'tracks-main-2'
      })

      const upstream = (branch: string): string => {
        try {
          return git(repo, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`).trim()
        } catch {
          return ''
        }
      }
      expect(upstream('pushed-2')).toBe('')
      expect(upstream('tracks-main-2')).toBe('origin/main')
    })
  })

  describe('a session title renames a placeholder branch', () => {
    it('takes the worktrees cut from the placeholder with it', async () => {
      const parent = addWorktree('beagle')
      const child = addWorktree('child', 'beagle')

      const result = await autoRenameWorktreeBranch({
        worktreeId: parent.id,
        worktreePath: parent.path,
        currentBranchName: 'beagle',
        sessionTitle: 'Fix login redirect',
        db: getDatabase()
      })

      expect(result).toMatchObject({ renamed: true, oldBranch: 'beagle', projectId })
      expect(row(parent.id).branch_name).toBe(result.newBranch)
      expect(row(child.id).base_branch).toBe(result.newBranch)
    })

    // The row still says `beagle`, the checkout was already renamed by hand: there is no
    // placeholder left to rename, and nothing is marked as tried.
    it('reads the branch from the checkout, not from the caller', async () => {
      const parent = addWorktree('beagle')
      git(parent.path, 'branch', '-m', 'beagle', 'my-own-name')

      const result = await autoRenameWorktreeBranch({
        worktreeId: parent.id,
        worktreePath: parent.path,
        currentBranchName: 'beagle',
        sessionTitle: 'Fix login redirect',
        db: getDatabase()
      })

      expect(result).toEqual({ renamed: false, skipped: 'not-auto-named' })
      expect(branches()).toEqual(['main', 'my-own-name'])
    })
  })

  describe('a branch is renamed outside the app', () => {
    // No watcher, no sync: the row is corrected when a window reads it.
    it('is seen by the next read of the worktree', async () => {
      const parent = addWorktree('feature')
      const child = addWorktree('child', 'feature')
      git(parent.path, 'branch', '-m', 'feature', 'feature-2')
      const db = getDatabase()

      const read = await readWithLiveBranches(db, () => db.getWorktree(parent.id))

      expect(read?.branch_name).toBe('feature-2')
      expect(row(child.id).base_branch).toBe('feature-2')
    })

    // Merge-on-done reads the dragged ticket's worktree alone, and compares with its base:
    // the base is another worktree's branch, and that one was renamed.
    it('a read of a worktree cut from the renamed branch already has the new base', async () => {
      const parent = addWorktree('feature')
      const child = addWorktree('child', 'feature')
      git(parent.path, 'branch', '-m', 'feature', 'feature-2')
      const db = getDatabase()

      const read = await readWithLiveBranches(db, () => db.getWorktree(child.id))

      expect(read?.base_branch).toBe('feature-2')
      expect(row(parent.id).branch_name).toBe('feature-2')
    })

    it('is reconciled by a sync, dependents included', async () => {
      const parent = addWorktree('feature')
      const child = addWorktree('child', 'feature')
      git(parent.path, 'branch', '-m', 'feature', 'feature-2')

      const result = await syncWorktreesOp(getDatabase(), { projectId, projectPath: repo })

      expect(result).toEqual({ success: true })
      expect(row(parent.id)).toMatchObject({ branch_name: 'feature-2', name: 'feature-2' })
      expect(row(child.id).base_branch).toBe('feature-2')
    })

    // Rows as an older build left them: the renamed worktree's own row was corrected, the
    // worktrees cut from it were not. Git still remembers the rename.
    it('a sync repairs a base that went stale before bases followed renames', async () => {
      const parent = addWorktree('feature')
      const child = addWorktree('child', 'feature')
      git(parent.path, 'branch', '-m', 'feature', 'feature-2')
      getDatabase().updateWorktree(parent.id, { branch_name: 'feature-2', name: 'feature-2' })
      expect(row(child.id).base_branch).toBe('feature')

      await syncWorktreesOp(getDatabase(), { projectId, projectPath: repo })

      expect(row(child.id).base_branch).toBe('feature-2')
    })

    // The same rows, and no sync: the project is collapsed in the sidebar and the ticket is
    // dragged to Merged. The read that merge-on-done makes repairs the base.
    it('a read repairs a base that went stale before bases followed renames', async () => {
      const parent = addWorktree('feature')
      const child = addWorktree('child', 'feature')
      git(parent.path, 'branch', '-m', 'feature', 'feature-2')
      const db = getDatabase()
      db.updateWorktree(parent.id, { branch_name: 'feature-2', name: 'feature-2' })

      const read = await readWithLiveBranches(db, () => db.getWorktree(child.id))

      expect(read?.base_branch).toBe('feature-2')
    })

    // A rebase detaches HEAD for a while. The display name must survive that.
    it('a sync during a detached HEAD keeps the display name', async () => {
      const worktree = addWorktree('feature')
      git(worktree.path, 'checkout', '-q', '--detach')

      await syncWorktreesOp(getDatabase(), { projectId, projectPath: repo })
      expect(row(worktree.id)).toMatchObject({ branch_name: '', name: 'feature' })

      git(worktree.path, 'checkout', '-q', 'feature')
      await syncWorktreesOp(getDatabase(), { projectId, projectPath: repo })
      expect(row(worktree.id)).toMatchObject({ branch_name: 'feature', name: 'feature' })
    })
  })

  describe('archive', () => {
    // The caller (a window, a connection's member list) still has the old name. Deleting by
    // that name deleted nothing and left the renamed branch behind.
    it('deletes the branch the checkout is on, not the name the caller remembers', async () => {
      const worktree = addWorktree('feature')
      git(worktree.path, 'branch', '-m', 'feature', 'feature-2')

      const result = await deleteWorktreeOp(getDatabase(), {
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        branchName: 'feature',
        projectPath: repo,
        archive: true
      })

      expect(result).toEqual({ success: true })
      expect(branches()).toEqual(['main'])
      expect(row(worktree.id).status).toBe('archived')
    })
  })

  describe('other records that name the branch', () => {
    const rename = (worktreeId: string, oldBranch: string, newBranch: string) =>
      renameWorktreeBranchOp(getDatabase(), {
        worktreeId,
        worktreePath: row(worktreeId).path,
        oldBranch,
        newBranch
      })

    it('document runs: base, integration and ticket branches follow', async () => {
      const db = getDatabase()
      const base = addWorktree('feature')
      const integration = addWorktree('integration', 'feature')
      const ticket = addWorktree('ticket-a', 'integration')
      const run = db.createDocumentRun({
        id: randomUUID(),
        project_id: projectId,
        title: 'Spec',
        source_path: '/docs/spec.html',
        run_dir: join(root, 'runs', 'spec'),
        status: 'running',
        config: DEFAULT_DOCUMENT_RUN_CONFIG
      })
      db.updateDocumentRun(run.id, {
        base_branch: 'feature',
        integration_branch: 'integration',
        integration_worktree_id: integration.id,
        integration_worktree_path: integration.path
      })
      const [item] = db.replaceDocumentRunItems(run.id, [
        {
          key: 'A',
          title: 'Task A',
          summary: '',
          description: '',
          kind: 'change',
          depends_on: [],
          has_migration: false,
          size: null,
          conflict_risk: null,
          doc_status: 'unknown',
          selected: true,
          figures: [],
          open_questions: [],
          verification_suggested: [],
          verification: [],
          verification_reason: ''
        }
      ])
      db.updateDocumentRunItem(item.id, { worktree_id: ticket.id, branch_name: 'ticket-a' })

      await rename(base.id, 'feature', 'feature-2')
      await rename(integration.id, 'integration', 'integration-2')
      await rename(ticket.id, 'ticket-a', 'ticket-a-2')

      expect(db.getDocumentRun(run.id)).toMatchObject({
        base_branch: 'feature-2',
        integration_branch: 'integration-2'
      })
      expect(db.getDocumentRunItem(item.id)?.branch_name).toBe('ticket-a-2')
    })

    it('a connection run: only the member whose worktree was renamed follows', () => {
      const db = getDatabase()
      const integration = addWorktree('run-1')
      const ticket = addWorktree('ticket-a', 'run-1')
      const member = {
        project_name: 'repo',
        project_path: repo,
        symlink_name: 'repo',
        base_sha: 'abc',
        integration_worktree_path: integration.path
      }
      const connectionProject = db.createProject({
        name: `stack-${sequence}`,
        path: join(root, `stack-${sequence}`)
      })
      const run = db.createDocumentRun({
        id: randomUUID(),
        project_id: connectionProject.id,
        title: 'Spec',
        source_path: '/docs/spec.html',
        run_dir: join(root, 'runs', 'connection'),
        status: 'running',
        config: DEFAULT_DOCUMENT_RUN_CONFIG
      })
      db.updateDocumentRun(run.id, {
        integration_branch: 'run-1',
        members: [
          {
            ...member,
            project_id: projectId,
            base_branch: 'main',
            integration_branch: 'run-1',
            integration_worktree_id: integration.id
          },
          {
            ...member,
            project_id: 'other-project',
            base_branch: 'main',
            integration_branch: 'run-1',
            integration_worktree_id: 'other-worktree'
          }
        ]
      })
      const [item] = db.replaceDocumentRunItems(run.id, [
        {
          key: 'A',
          title: 'Task A',
          summary: '',
          description: '',
          kind: 'change',
          depends_on: [],
          has_migration: false,
          size: null,
          conflict_risk: null,
          doc_status: 'unknown',
          selected: true,
          figures: [],
          open_questions: [],
          verification_suggested: [],
          verification: [],
          verification_reason: ''
        }
      ])
      const itemMember = { pre_merge_sha: null, merge_sha: null }
      db.updateDocumentRunItem(item.id, {
        branch_name: 'ticket-a',
        members: [
          { ...itemMember, project_id: projectId, worktree_id: ticket.id, branch_name: 'ticket-a' },
          { ...itemMember, project_id: 'other-project', worktree_id: 'w2', branch_name: 'ticket-a' }
        ]
      })

      expect(
        db.renameBranchInDocumentRuns({
          projectId,
          worktreeId: integration.id,
          oldBranch: 'run-1',
          newBranch: 'run-renamed'
        })
      ).toEqual([run.id])
      db.renameBranchInDocumentRuns({
        projectId,
        worktreeId: ticket.id,
        oldBranch: 'ticket-a',
        newBranch: 'ticket-renamed'
      })

      const stored = db.getDocumentRun(run.id)
      expect(stored?.members?.map((m) => m.integration_branch)).toEqual(['run-renamed', 'run-1'])
      // The run's own name is the first member's when they differ
      expect(stored?.integration_branch).toBe('run-renamed')
      const storedItem = db.getDocumentRunItem(item.id)
      expect(storedItem?.members?.map((m) => m.branch_name)).toEqual(['ticket-renamed', 'ticket-a'])
      expect(storedItem?.branch_name).toBe('ticket-renamed')
    })

    it('a launch queued to cut its worktree from the branch cuts it from the new name', async () => {
      const db = getDatabase()
      const source = addWorktree('feature')
      const queued = (sourceBranch: string): string =>
        JSON.stringify({
          worktree: { type: 'new', sourceBranch },
          prompt: 'Mentions feature in its text',
          mode: 'build',
          model: null,
          sdk: 'claude-code'
        })
      const fromFeature = db.createKanbanTicket({ project_id: projectId, title: 'From feature' })
      const fromMain = db.createKanbanTicket({ project_id: projectId, title: 'From main' })
      db.updateKanbanTicket(fromFeature.id, { pending_launch_config: queued('feature') })
      db.updateKanbanTicket(fromMain.id, { pending_launch_config: queued('main') })

      await rename(source.id, 'feature', 'feature-2')

      expect(db.getKanbanTicket(fromFeature.id)?.pending_launch_config).toBe(queued('feature-2'))
      expect(db.getKanbanTicket(fromMain.id)?.pending_launch_config).toBe(queued('main'))
    })
  })
})
