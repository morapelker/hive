// Keeps what the app remembers about branches in line with git.
//
// A branch name lives in git. The app keeps copies of it: `worktrees.branch_name` (the branch
// a checkout is on), `worktrees.base_branch` (the branch a worktree's work is compared with
// and merged into), the branches a document run works with, the source branch of a queued
// launch, the instructions file of a connection. A rename in git (`git branch -m` in a
// terminal, by an agent, or by the app itself) reaches none of them on its own, and each stale
// copy later asks git for a branch that is gone: the comparison fails, the merge is skipped,
// the archive leaves the renamed branch behind.
//
// Every path that renames a branch, or finds one renamed, goes through here:
//  - `recordBranchRename`: a branch was renamed — every copy of the old name follows;
//  - `reconcileWorktreeBranch`: a worktree row follows its checkout's HEAD (a file read; git
//    runs only when the two differ), and records a rename when that is what happened;
//  - `healStaleBaseBranches`: a base branch that no longer exists is followed through the
//    renames git recorded in its reflogs, for renames nobody was there to see.
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { basename, join } from 'path'

import type { ConnectionWithMembers, Worktree, WorktreeUpdate } from '../db/types'
import { isAutoNamedBranch } from './breed-names'
import { generateConnectionInstructions } from './connection-service'
import { emitDbChanged } from './db-change-events'
import { emitGitBranchChanged } from './git-events'
import { readHeadBranch } from './git-head'
import { createLogger } from './logger'
import { emitWorktreeBranchRenamed } from './worktree-events'

const log = createLogger({ component: 'WorktreeBranchReconcile' })

const GIT_TIMEOUT_MS = 10_000

/**
 * The part of the database a rename is written to (`DatabaseService` satisfies it). Every
 * method is optional: the title handlers are tested with a database that only updates
 * worktrees, and a copy that cannot be reached there is simply not rewritten.
 */
export interface BranchRenameDb {
  repointWorktreeBaseBranch?(projectId: string, oldBranch: string, newBranch: string): string[]
  renameBranchInDocumentRuns?(rename: {
    projectId: string
    worktreeId: string
    oldBranch: string
    newBranch: string
  }): string[]
  renameBranchInPendingLaunches?(projectId: string, oldBranch: string, newBranch: string): number
  getConnectionMembersByWorktree?(worktreeId: string): { connection_id: string }[]
  getConnection?(id: string): ConnectionWithMembers | null
}

/** What the reconciliation of a worktree row needs on top of that. */
export interface BranchReconcileDb extends BranchRenameDb {
  getWorktree(id: string): Worktree | null
  getActiveWorktreesByProject(projectId: string): Worktree[]
  updateWorktree(id: string, data: WorktreeUpdate): Worktree | null
}

// Not the origin of any window: a row changed here must reload in every window, the one whose
// request happened to trigger the change included (a `db:changed` event is otherwise dropped
// by the client that caused it).
const RECONCILE_ORIGIN = 'branch-reconcile'

const announceWorktreeChange = (id: string, projectId: string): void => {
  emitDbChanged({
    entity: 'worktree',
    op: 'update',
    id,
    projectId,
    originClientId: RECONCILE_ORIGIN
  })
}

type GitResult = { ok: true; stdout: string } | { ok: false; exitCode: number | null }

/** Runs git; `exitCode` is null when git did not run to an exit (not found, timeout, bad cwd). */
const runGit = (cwd: string, args: readonly string[]): Promise<GitResult> =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) return resolve({ ok: true, stdout })
        resolve({ ok: false, exitCode: typeof error.code === 'number' ? error.code : null })
      }
    )
  })

/**
 * Whether `ref` names a commit in the repository of `cwd` (a local branch, `origin/x`, a
 * tag). null when git could not be asked: "gone" must never be concluded from a failure.
 */
export async function refResolves(cwd: string, ref: string): Promise<boolean | null> {
  // A leading dash would be read as an option; no ref starts with one
  if (!ref || ref.startsWith('-')) return false
  const result = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (result.ok) return true
  // `--verify --quiet` exits 1 for a name that resolves to nothing
  return result.exitCode === 1 ? false : null
}

const localBranchExists = (cwd: string, branch: string): Promise<boolean | null> =>
  refResolves(cwd, `refs/heads/${branch}`)

/**
 * The display name a worktree gets when its branch changes: it follows the branch while it
 * still is the branch's name (or one of the generated placeholder names), and is left alone
 * once the user gave it a name of their own. undefined = keep the name.
 */
export function worktreeNameForBranch(
  worktree: Pick<Worktree, 'name' | 'branch_name' | 'path'>,
  newBranch: string
): string | undefined {
  const follows =
    worktree.name === worktree.branch_name || isAutoNamedBranch(worktree.name.toLowerCase())
  return follows ? newBranch || basename(worktree.path) : undefined
}

export interface BranchRename {
  /** Project (repository) the branch belongs to. */
  readonly projectId: string
  /** The worktree that has the branch checked out. */
  readonly worktreeId: string
  readonly oldBranch: string
  readonly newBranch: string
}

/** The connections a worktree is a member of describe each member's branch to the agents. */
function rewriteConnectionInstructions(db: BranchRenameDb, worktreeId: string): void {
  const memberships = db.getConnectionMembersByWorktree?.(worktreeId) ?? []
  for (const { connection_id: connectionId } of memberships) {
    const connection = db.getConnection?.(connectionId)
    // Only a file that is there is rewritten: an instance without one was never given one
    if (!connection || !existsSync(join(connection.path, 'AGENTS.md'))) continue
    generateConnectionInstructions(
      connection.path,
      connection.members.map((member) => ({
        symlinkName: member.symlink_name,
        projectName: member.project_name,
        branchName: member.worktree_branch,
        worktreePath: member.worktree_path
      }))
    )
  }
}

/**
 * A branch was renamed, and `worktrees.branch_name` of its worktree already says so: every
 * other copy of the old name follows it to the new one.
 *
 *  - worktrees cut from the branch compare with and merge into the new name (`base_branch`);
 *  - document runs that use the branch as base, integration or ticket branch keep working;
 *  - launches queued to cut a worktree from it cut it from the new name;
 *  - the instructions file of every connection the worktree is in names the new branch.
 *
 * For a rename the caller knows happened. An observed change of HEAD goes through
 * `reconcileWorktreeBranch`, which first makes sure the old branch is really gone: a worktree
 * that merely switched branches renamed nothing. A copy that cannot be rewritten is logged
 * and never fails the rename it follows.
 */
export function recordBranchRename(db: BranchRenameDb, rename: BranchRename): void {
  const { projectId, worktreeId, oldBranch, newBranch } = rename
  if (!oldBranch || !newBranch || oldBranch === newBranch) return

  const step = (what: string, run: () => void): void => {
    try {
      run()
    } catch (error) {
      log.warn(`Branch rename: could not update ${what}`, {
        ...rename,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  step('the worktrees based on the branch', () => {
    const repointed = db.repointWorktreeBaseBranch?.(projectId, oldBranch, newBranch) ?? []
    if (repointed.length === 0) return
    log.info('Re-pointed worktrees based on a renamed branch', { ...rename, repointed })
    for (const id of repointed) announceWorktreeChange(id, projectId)
  })
  step('document runs', () => {
    const runs = db.renameBranchInDocumentRuns?.(rename) ?? []
    if (runs.length > 0) log.info('Renamed a branch in document runs', { ...rename, runs })
  })
  step('queued launches', () => {
    db.renameBranchInPendingLaunches?.(projectId, oldBranch, newBranch)
  })
  step('connection instructions', () => rewriteConnectionInstructions(db, worktreeId))
}

export interface ReconcileOptions {
  /**
   * The branch the checkout is on, when the caller already asked git (`git worktree list`).
   * Left out, the checkout's HEAD file is read.
   */
  readonly liveBranch?: string | null
}

/**
 * Makes a worktree row say what its checkout's HEAD says, and returns the row as it now is.
 *
 * Nothing is touched — and no git process runs — while the two agree, or while git cannot say
 * (detached HEAD in a rebase, a checkout that is not on this machine): the last known branch
 * stays. When they differ the row takes the live branch, and if the old branch no longer
 * exists the change was a rename, which is recorded (`recordBranchRename`). A plain `git
 * switch` leaves the old branch in place, and everything that names it stays as it is.
 */
export async function reconcileWorktreeBranch(
  db: BranchReconcileDb,
  worktree: Worktree,
  options: ReconcileOptions = {}
): Promise<Worktree> {
  if (worktree.status !== 'active') return worktree
  const liveBranch =
    options.liveBranch === undefined
      ? readHeadBranch(worktree.path, { linkedOnly: !worktree.is_default })
      : options.liveBranch
  if (!liveBranch || liveBranch === worktree.branch_name) return worktree

  const oldBranch = worktree.branch_name
  // Only a definite "no such branch" makes it a rename; a git that could not answer does not
  const renamed = oldBranch !== '' && (await localBranchExists(worktree.path, oldBranch)) === false

  // The row may have been brought up to date while git was asked
  const current = db.getWorktree(worktree.id)
  if (!current || current.status !== 'active') return current ?? worktree
  if (current.branch_name === liveBranch) return current

  log.info('Worktree is on another branch than recorded, updating the database', {
    worktreeId: worktree.id,
    oldBranch,
    newBranch: liveBranch,
    renamed
  })
  const name = worktreeNameForBranch(current, liveBranch)
  const updated = db.updateWorktree(worktree.id, {
    branch_name: liveBranch,
    ...(name !== undefined ? { name } : {})
  })
  if (renamed) {
    recordBranchRename(db, {
      projectId: worktree.project_id,
      worktreeId: worktree.id,
      oldBranch,
      newBranch: liveBranch
    })
  }

  announceWorktreeChange(worktree.id, worktree.project_id)
  emitWorktreeBranchRenamed({
    worktreeId: worktree.id,
    newBranch: liveBranch,
    worktreePath: worktree.path,
    projectId: worktree.project_id,
    ...(renamed ? { oldBranch } : {})
  })
  emitGitBranchChanged({ worktreePath: worktree.path })
  return updated ?? db.getWorktree(worktree.id) ?? worktree
}

/**
 * Reads worktree rows for someone who is about to use their branches (a window asking the
 * database), after making the rows follow their checkouts. This is what lets a rename be seen
 * even when nothing was watching the checkout: the row is corrected the moment it is asked
 * for.
 *
 * Not only the rows asked for: a row's `base_branch` is the name of a branch another worktree
 * of its project has checked out, so every active worktree of the projects involved is
 * brought up to date — one HEAD file read each, git only for a row that is behind. `read` runs
 * again when anything changed, so what is handed out is what the database now holds.
 *
 * Never throws for a row that cannot be reconciled: it is handed out as read.
 */
export async function readWithLiveBranches<R extends Worktree | readonly Worktree[] | null>(
  db: BranchReconcileDb,
  read: () => R
): Promise<R> {
  const first = read()
  const rows: readonly Worktree[] =
    first === null ? [] : Array.isArray(first) ? first : [first as Worktree]

  const toReconcile = new Map<string, Worktree>()
  for (const row of rows) toReconcile.set(row.id, row)
  for (const projectId of new Set(rows.map((row) => row.project_id))) {
    try {
      for (const sibling of db.getActiveWorktreesByProject(projectId)) {
        if (!toReconcile.has(sibling.id)) toReconcile.set(sibling.id, sibling)
      }
    } catch (error) {
      log.warn('Could not list the worktrees of a project to reconcile their branches', {
        projectId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  let changed = false
  for (const row of toReconcile.values()) {
    try {
      if ((await reconcileWorktreeBranch(db, row)) !== row) changed = true
    } catch (error) {
      log.warn('Could not reconcile the branch of a worktree', {
        worktreeId: row.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // A base that no worktree has checked out even now may be a name from before a rename that
  // nobody recorded (made while the app was closed, or by a build that did not follow bases).
  for (const [projectId, repoPath] of projectsWithUnseenBase(db, rows)) {
    try {
      if (await healStaleBaseBranches(db, projectId, repoPath)) changed = true
    } catch (error) {
      log.warn('Could not check the base branches of a project', {
        projectId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return changed ? read() : first
}

// Asking git about a base that no worktree has checked out is repeated at most this often per
// project on the read path: such a base is usually a branch that simply exists.
const BASE_CHECK_INTERVAL_MS = 30_000
const lastBaseCheck = new Map<string, number>()

/**
 * The projects of `rows` in which some row asked for has a base that no active worktree has
 * checked out, with a checkout of each to ask git in — throttled per project.
 */
function projectsWithUnseenBase(
  db: BranchReconcileDb,
  rows: readonly Worktree[]
): Map<string, string> {
  const projects = new Map<string, string>()
  const now = Date.now()
  for (const projectId of new Set(rows.map((row) => row.project_id))) {
    try {
      const active = db.getActiveWorktreesByProject(projectId)
      const checkedOut = new Set(active.map((w) => w.branch_name).filter(Boolean))
      const asked = new Set(rows.map((row) => row.id))
      const unseen = active.some(
        (w) => asked.has(w.id) && w.base_branch && !checkedOut.has(w.base_branch)
      )
      if (!unseen) continue
      if (now - (lastBaseCheck.get(projectId) ?? -Infinity) < BASE_CHECK_INTERVAL_MS) continue
      const checkout = active.find((w) => w.is_default) ?? active[0]
      if (!checkout) continue
      lastBaseCheck.set(projectId, now)
      projects.set(projectId, checkout.path)
    } catch {
      // The rows are handed out as read
    }
  }
  return projects
}

const RENAME_REFLOG_PREFIX = 'Branch: renamed refs/heads/'

/**
 * Every branch rename the repository still remembers, old name → new name. Git writes
 * "Branch: renamed refs/heads/<old> to refs/heads/<new>" into the reflog of the renamed branch
 * (and of HEAD where it is checked out); `git log -g` lists entries newest first, so the first
 * one seen for an old name is where that name went last.
 */
export async function readBranchRenames(repoPath: string): Promise<Map<string, string>> {
  const renames = new Map<string, string>()
  const result = await runGit(repoPath, [
    'log',
    '-g',
    '--all',
    '--format=%gs',
    `--grep-reflog=^${RENAME_REFLOG_PREFIX}`
  ])
  if (!result.ok) return renames
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith(RENAME_REFLOG_PREFIX)) continue
    // Branch names hold no spaces, so the separator cannot be part of one
    const [oldBranch, newRef, ...rest] = line.slice(RENAME_REFLOG_PREFIX.length).split(' to ')
    if (rest.length > 0 || !oldBranch || !newRef?.startsWith('refs/heads/')) continue
    if (!renames.has(oldBranch)) renames.set(oldBranch, newRef.slice('refs/heads/'.length))
  }
  return renames
}

/**
 * Re-points the worktrees whose `base_branch` is a branch that no longer exists but that git
 * remembers renaming. This is what repairs a rename nobody watched: one made while the app
 * was closed, or before the app kept bases in step with renames at all.
 *
 * A base that some active worktree has checked out is known to exist without asking git, so a
 * project in good shape costs no git process. A base that is gone and was never renamed (the
 * branch was deleted) is left as it is. Resolves to whether any worktree was re-pointed.
 */
export async function healStaleBaseBranches(
  db: BranchReconcileDb,
  projectId: string,
  repoPath: string
): Promise<boolean> {
  const worktrees = db.getActiveWorktreesByProject(projectId)
  const checkedOut = new Set(worktrees.map((w) => w.branch_name).filter(Boolean))
  const suspects = new Set<string>()
  for (const worktree of worktrees) {
    if (worktree.base_branch && !checkedOut.has(worktree.base_branch)) {
      suspects.add(worktree.base_branch)
    }
  }
  if (suspects.size === 0) return false

  let healed = false
  let renames: Map<string, string> | null = null
  for (const base of suspects) {
    if ((await refResolves(repoPath, base)) !== false) continue
    renames ??= await readBranchRenames(repoPath)

    // Follow old → new until a name that exists; a name seen twice is a rename cycle
    const seen = new Set<string>([base])
    let target = renames.get(base)
    while (target !== undefined && !seen.has(target)) {
      if ((await localBranchExists(repoPath, target)) === true) break
      seen.add(target)
      target = renames.get(target)
    }
    if (target === undefined || seen.has(target)) {
      log.warn('Base branch no longer exists and no rename of it was found', { projectId, base })
      continue
    }
    const repointed = db.repointWorktreeBaseBranch?.(projectId, base, target) ?? []
    log.info('Re-pointed worktrees whose base branch was renamed', {
      projectId,
      oldBranch: base,
      newBranch: target,
      repointed
    })
    for (const id of repointed) announceWorktreeChange(id, projectId)
    if (repointed.length > 0) healed = true
  }
  return healed
}
