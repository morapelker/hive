// A worktree sync while a dev folder move of the project is unfinished. Until the move has
// repaired git's worktree links, git lists the project's worktrees at their old paths: a sync
// would archive their rows and prune their registrations, and the repair that is still owed
// would find nothing left to repair. So every sync but the move's own leaves things alone.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const gitServiceMocks = vi.hoisted(() => ({
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
import type { DatabaseService } from '../db/database'
import { makeDbService } from '../effect/db/layers'
import { Db } from '../effect/db/service'
import { DEV_FOLDER_PENDING_MOVE_KEY, type PendingDevFolderMove } from './dev-folder/types'
import { syncWorktreesOp, syncWorktreesOpEffect, type SyncWorktreesParams } from './worktree-ops'

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

describeIf('worktree sync while a dev folder move is unfinished', () => {
  let root: string
  let sequence = 0

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hive-sync-pending-move-'))
    process.env.HIVE_SERVER_DB_PATH = join(root, 'hive.db')
    closeDatabase()
  })

  afterAll(() => {
    closeDatabase()
    delete process.env.HIVE_SERVER_DB_PATH
    rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    gitServiceMocks.listWorktrees.mockReset()
    gitServiceMocks.listWorktrees.mockResolvedValue([])
    gitServiceMocks.pruneWorktrees.mockClear()
    getDatabase().clearPendingDevFolderMove()
  })

  interface Fixture {
    params: SyncWorktreesParams
    /** A row whose folder is not on disk and that git does not list: a sync archives it. */
    staleId: string
    /** A linked worktree on disk that git lists and the database does not know: a sync imports it. */
    unknownPath: string
  }

  /**
   * A project as it is right after its folders were moved and before git was repaired: the
   * rows point at the new paths, git still lists the worktrees where they used to be.
   */
  const makeMovedProject = (): Fixture => {
    const name = `repo-${++sequence}`
    const projectPath = join(root, 'dev', name)
    mkdirSync(projectPath, { recursive: true })
    const db = getDatabase()
    const project = db.createProject({ name, path: projectPath })
    db.createWorktree({
      project_id: project.id,
      name: 'main',
      branch_name: 'main',
      path: projectPath,
      is_default: true
    })
    const stale = db.createWorktree({
      project_id: project.id,
      name: 'feature',
      branch_name: 'feature',
      path: join(root, 'gone', `${name}-feature`)
    })
    const unknownPath = join(root, 'old', `${name}-outside`)
    mkdirSync(unknownPath, { recursive: true })
    writeFileSync(join(unknownPath, '.git'), `gitdir: ${projectPath}/.git/worktrees/outside\n`)
    gitServiceMocks.listWorktrees.mockResolvedValue([
      { path: projectPath, branch: 'main', isMain: true },
      { path: unknownPath, branch: 'outside', isMain: false }
    ])
    return { params: { projectId: project.id, projectPath }, staleId: stale.id, unknownPath }
  }

  const notePendingMoveOf = (projectId: string): void => {
    const pending: PendingDevFolderMove = {
      projectId,
      fromPath: '/before/repo',
      fromRealPath: '/before/repo',
      toPath: '/after/repo',
      relocations: [{ from: ['/before/repo'], to: '/after/repo' }]
    }
    getDatabase().setSetting(DEV_FOLDER_PENDING_MOVE_KEY, JSON.stringify(pending))
    expect(getDatabase().readPendingDevFolderMove()?.projectId).toBe(projectId)
  }

  const pathsOf = (projectId: string): string[] =>
    getDatabase()
      .getWorktreesByProject(projectId)
      .map((worktree) => worktree.path)

  it('changes nothing for the project the move is about', async () => {
    const { params, staleId, unknownPath } = makeMovedProject()
    notePendingMoveOf(params.projectId)

    const result = await syncWorktreesOp(getDatabase(), params)

    expect(result).toEqual({ success: true })
    expect(getDatabase().getWorktree(staleId)?.status).toBe('active')
    expect(pathsOf(params.projectId)).not.toContain(unknownPath)
    expect(gitServiceMocks.pruneWorktrees).not.toHaveBeenCalled()
  })

  it('changes nothing through the effect a request runs', async () => {
    const { params, staleId } = makeMovedProject()
    notePendingMoveOf(params.projectId)

    const result = await Effect.runPromise(
      syncWorktreesOpEffect(params).pipe(
        Effect.provide(Layer.succeed(Db, makeDbService(getDatabase())))
      )
    )

    expect(result).toEqual({ success: true })
    expect(getDatabase().getWorktree(staleId)?.status).toBe('active')
    expect(gitServiceMocks.pruneWorktrees).not.toHaveBeenCalled()
  })

  it('does not take the word of the request for being the move', async () => {
    const { params, staleId } = makeMovedProject()
    notePendingMoveOf(params.projectId)
    const claiming = { ...params, forDevFolderMove: true } as SyncWorktreesParams

    expect(await syncWorktreesOp(getDatabase(), claiming)).toEqual({ success: true })

    expect(getDatabase().getWorktree(staleId)?.status).toBe('active')
    expect(gitServiceMocks.pruneWorktrees).not.toHaveBeenCalled()
  })

  it('runs in full for the move itself', async () => {
    const { params, staleId, unknownPath } = makeMovedProject()
    notePendingMoveOf(params.projectId)

    const result = await syncWorktreesOp(getDatabase(), params, { forDevFolderMove: true })

    expect(result).toEqual({ success: true })
    expect(getDatabase().getWorktree(staleId)?.status).toBe('archived')
    expect(pathsOf(params.projectId)).toContain(unknownPath)
    expect(gitServiceMocks.pruneWorktrees).toHaveBeenCalledTimes(1)
  })

  it('runs in full for a project the move is not about', async () => {
    const moved = makeMovedProject()
    const other = makeMovedProject()
    notePendingMoveOf(moved.params.projectId)

    expect(await syncWorktreesOp(getDatabase(), other.params)).toEqual({ success: true })

    expect(getDatabase().getWorktree(other.staleId)?.status).toBe('archived')
    expect(pathsOf(other.params.projectId)).toContain(other.unknownPath)
    expect(gitServiceMocks.pruneWorktrees).toHaveBeenCalledTimes(1)
  })

  it('runs in full again once the move has cleared its note', async () => {
    const { params, staleId } = makeMovedProject()
    notePendingMoveOf(params.projectId)
    await syncWorktreesOp(getDatabase(), params)
    expect(getDatabase().getWorktree(staleId)?.status).toBe('active')

    getDatabase().clearPendingDevFolderMove()
    expect(await syncWorktreesOp(getDatabase(), params)).toEqual({ success: true })

    expect(getDatabase().getWorktree(staleId)?.status).toBe('archived')
    expect(gitServiceMocks.pruneWorktrees).toHaveBeenCalledTimes(1)
  })

  it('runs as before on a database that knows nothing of dev folder moves', async () => {
    const { params, staleId } = makeMovedProject()
    notePendingMoveOf(params.projectId)
    // A stand-in for the database, as callers outside the app's own process hand in.
    const real = getDatabase()
    const older = new Proxy(real, {
      get: (target, key) =>
        key === 'readPendingDevFolderMove'
          ? undefined
          : (Reflect.get(target, key, target) as unknown)
    }) as DatabaseService

    const result = await Effect.runPromise(
      syncWorktreesOpEffect(params).pipe(Effect.provide(Layer.succeed(Db, makeDbService(older))))
    )

    expect(result).toEqual({ success: true })
    expect(real.getWorktree(staleId)?.status).toBe('archived')
  })
})
