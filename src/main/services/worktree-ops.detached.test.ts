// Detached-HEAD worktrees: git checkouts on no branch, stored with an empty `branch_name`.
// They reach the app through sync, which imports what `git worktree list` reports. Two rules:
// removing one works without a branch name, and the scratch ones an agent parks in a temp
// directory (`git worktree add --detach /tmp/baseline <sha>`) are not imported at all.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const gitServiceMocks = vi.hoisted(() => ({
  archiveWorktree: vi.fn(async () => ({ success: true })),
  removeWorktree: vi.fn(async () => ({ success: true })),
  listWorktrees: vi.fn(async () => [] as Array<{ path: string; branch: string; isMain: boolean }>),
  pruneWorktrees: vi.fn(async () => undefined)
}))

vi.mock('./git-service', () => ({
  createGitService: vi.fn(() => gitServiceMocks),
  isAutoNamedBranch: vi.fn(() => false)
}))
vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { closeDatabase, getDatabase } from '../db'
import { deleteWorktreeOp, syncWorktreesOp } from './worktree-ops'

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

describeIf('detached-HEAD worktrees', () => {
  let root: string
  let projectPath: string
  let projectId: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hive-detached-worktrees-'))
    process.env.HIVE_SERVER_DB_PATH = join(root, 'hive.db')
    closeDatabase()
    projectPath = join(root, 'repo')
    mkdirSync(projectPath)
    projectId = getDatabase().createProject({ name: 'repo', path: projectPath }).id
  })

  afterAll(() => {
    closeDatabase()
    delete process.env.HIVE_SERVER_DB_PATH
    rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    gitServiceMocks.archiveWorktree.mockClear()
    gitServiceMocks.removeWorktree.mockClear()
  })

  /** A directory that looks like a linked worktree of the project. */
  const makeLinkedWorktree = (name: string): string => {
    const path = join(root, name)
    mkdirSync(path)
    writeFileSync(join(path, '.git'), `gitdir: ${projectPath}/.git/worktrees/${name}\n`)
    return path
  }

  const activePaths = (): string[] =>
    getDatabase()
      .getWorktreesByProject(projectId)
      .filter((worktree) => worktree.status === 'active')
      .map((worktree) => worktree.path)

  // Archive would go on to delete the branch; with none there is only the checkout to remove.
  it.each([false, true])(
    'removes a detached worktree that has no branch name (archive: %s)',
    async (archive) => {
      const wt = getDatabase().createWorktree({
        project_id: projectId,
        name: 'deploy',
        branch_name: '',
        path: join(root, `deploy-${archive}`)
      })

      const result = await deleteWorktreeOp(getDatabase(), {
        worktreeId: wt.id,
        worktreePath: wt.path,
        branchName: '',
        projectPath,
        archive
      })

      expect(result).toEqual({ success: true })
      expect(gitServiceMocks.removeWorktree).toHaveBeenCalledWith(wt.path)
      expect(gitServiceMocks.archiveWorktree).not.toHaveBeenCalled()
      expect(getDatabase().getWorktree(wt.id)?.status).toBe('archived')
    }
  )

  it('still deletes the branch when archiving a worktree that has one', async () => {
    const wt = getDatabase().createWorktree({
      project_id: projectId,
      name: 'feature',
      branch_name: 'feature',
      path: join(root, 'on-a-branch')
    })

    const result = await deleteWorktreeOp(getDatabase(), {
      worktreeId: wt.id,
      worktreePath: wt.path,
      branchName: 'feature',
      projectPath,
      archive: true
    })

    expect(result).toEqual({ success: true })
    expect(gitServiceMocks.archiveWorktree).toHaveBeenCalledWith(wt.path, 'feature')
    expect(gitServiceMocks.removeWorktree).not.toHaveBeenCalled()
  })

  it('sync leaves a detached worktree in a temp directory out of the project', async () => {
    const detached = makeLinkedWorktree('baseline')
    const onBranch = makeLinkedWorktree('feature-x')
    gitServiceMocks.listWorktrees.mockResolvedValueOnce([
      { path: projectPath, branch: 'main', isMain: true },
      { path: detached, branch: '', isMain: false },
      // Same place, on a branch: still imported, so it is the detachment that excludes.
      { path: onBranch, branch: 'feature-x', isMain: false }
    ])

    const result = await syncWorktreesOp(getDatabase(), { projectId, projectPath })

    expect(result).toEqual({ success: true })
    expect(activePaths()).toContain(onBranch)
    expect(activePaths()).not.toContain(detached)
  })
})
