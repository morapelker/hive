import { Effect } from 'effect'
import { mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { Db } from '../../src/main/effect/db/service'
import { makeTestDbLayer } from '../utils/db-effect-test-utils'
import { canRunDatabaseTests, createTestDatabase } from '../utils/db-test-utils'
import { expectExitSuccess, runEffect } from '../utils/effect-test-utils'

const gitServiceMocks = vi.hoisted(() => ({
  createWorktree: vi.fn(async () => ({
    success: true,
    name: 'fake-wt',
    path: '/tmp/fake-wt',
    branchName: 'feat/fake',
    baseBranch: 'main',
    pullInfo: { pulled: false, updated: false }
  })),
  archiveWorktree: vi.fn(async () => ({ success: true })),
  removeWorktree: vi.fn(async () => ({ success: true })),
  listWorktrees: vi.fn(async () => [] as Array<{ path: string; branch: string; isMain: boolean }>),
  pruneWorktrees: vi.fn(async () => undefined),
  duplicateWorktree: vi.fn(async () => ({
    success: true,
    name: 'dup',
    path: '/tmp/dup',
    branchName: 'feat/dup',
    baseBranch: 'main'
  })),
  renameBranch: vi.fn(async () => ({ success: true })),
  createWorktreeFromBranch: vi.fn(async () => ({
    success: true,
    name: 'fb',
    path: '/tmp/fb',
    branchName: 'feat/fb',
    baseBranch: 'main',
    pullInfo: { pulled: false, updated: false }
  }))
}))

vi.mock('../../src/main/services/git-service', () => ({
  createGitService: vi.fn(() => gitServiceMocks),
  isAutoNamedBranch: vi.fn(() => false)
}))

import {
  createWorktreeOpEffect,
  deleteWorktreeOpEffect,
  syncWorktreesOpEffect
} from '../../src/main/services/worktree-ops'

const describeIf = canRunDatabaseTests() ? describe : describe.skip

describeIf('Session 7: worktree-ops Effect orchestrators', () => {
  let testDb: ReturnType<typeof createTestDatabase>
  let projectId: string

  beforeEach(() => {
    testDb = createTestDatabase()
    const p = testDb.db.createProject({ name: 'p', path: '/tmp/p' })
    projectId = p.id
    vi.clearAllMocks()
  })

  afterEach(() => {
    testDb.cleanup()
  })

  const run = <A, E>(eff: Effect.Effect<A, E, Db>) =>
    runEffect(eff.pipe(Effect.provide(makeTestDbLayer(testDb.db))))

  test('createWorktreeOpEffect inserts a row and returns success', async () => {
    const result = expectExitSuccess(
      await run(createWorktreeOpEffect({ projectId, projectPath: '/tmp/p', projectName: 'p' }))
    )
    expect(result.success).toBe(true)
    expect(result.worktree?.path).toBe('/tmp/fake-wt')
    expect(testDb.db.getWorktreesByProject(projectId)).toHaveLength(1)
  })

  test('deleteWorktreeOpEffect archives the worktree row', async () => {
    const wt = testDb.db.createWorktree({
      project_id: projectId,
      name: 'old',
      branch_name: 'b',
      path: '/tmp/old'
    })

    const result = expectExitSuccess(
      await run(
        deleteWorktreeOpEffect({
          worktreeId: wt.id,
          worktreePath: wt.path,
          branchName: wt.branch_name,
          projectPath: '/tmp/p',
          archive: true
        })
      )
    )

    expect(result.success).toBe(true)
    const after = testDb.db.getWorktree(wt.id)
    expect(after?.status).toBe('archived')
  })

  test('syncWorktreesOpEffect does not import the main checkout as an app worktree', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-main-sync-'))
    const configuredProjectPath = join(baseDir, 'configured-project-path')
    const gitMainPath = join(baseDir, 'git-main-checkout')
    mkdirSync(configuredProjectPath)
    mkdirSync(gitMainPath)
    gitServiceMocks.listWorktrees.mockResolvedValueOnce([
      { path: gitMainPath, branch: 'main', isMain: true }
    ])

    const result = expectExitSuccess(
      await run(
        syncWorktreesOpEffect({
          projectId,
          projectPath: configuredProjectPath
        })
      )
    )

    expect(result.success).toBe(true)
    expect(testDb.db.getWorktreesByProject(projectId)).toHaveLength(0)
  })
})
