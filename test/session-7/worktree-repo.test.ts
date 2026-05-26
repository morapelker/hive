import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { Db } from '../../src/main/effect/db/service'
import { worktreeRepo } from '../../src/main/effect/db/repos/worktrees'
import { makeTestDbLayer } from '../utils/db-effect-test-utils'
import { canRunDatabaseTests, createTestDatabase } from '../utils/db-test-utils'
import { expectExitFailure, expectExitSuccess, runEffect } from '../utils/effect-test-utils'

const describeIf = canRunDatabaseTests() ? describe : describe.skip

describeIf('Session 7: worktreeRepo', () => {
  let testDb: ReturnType<typeof createTestDatabase>
  let projectId: string

  beforeEach(() => {
    testDb = createTestDatabase()
    const project = testDb.db.createProject({
      name: 'p',
      path: '/tmp/p'
    })
    projectId = project.id
  })

  afterEach(() => {
    testDb.cleanup()
  })

  const run = <A, E>(eff: Effect.Effect<A, E, Db>) =>
    runEffect(eff.pipe(Effect.provide(makeTestDbLayer(testDb.db))))

  test('create + get round-trip', async () => {
    const created = expectExitSuccess(
      await run(worktreeRepo.create({
        project_id: projectId,
        name: 'wt-1',
        branch_name: 'feat/wt-1',
        path: '/tmp/wt-1'
      }))
    )
    expect(created.id).toBeTruthy()
    expect(created.status).toBe('active')

    const fetched = expectExitSuccess(await run(worktreeRepo.get(created.id)))
    expect(fetched).toEqual(created)
  })

  test('getByPath returns active worktrees only', async () => {
    const created = expectExitSuccess(
      await run(worktreeRepo.create({
        project_id: projectId,
        name: 'wt-2',
        branch_name: 'b',
        path: '/tmp/wt-2'
      }))
    )
    const found = expectExitSuccess(await run(worktreeRepo.getByPath('/tmp/wt-2')))
    expect(found?.id).toBe(created.id)

    expectExitSuccess(await run(worktreeRepo.archive(created.id)))
    const stillFound = expectExitSuccess(await run(worktreeRepo.getByPath('/tmp/wt-2')))
    expect(stillFound).toBeNull()
  })

  test('update returns the updated row', async () => {
    const created = expectExitSuccess(
      await run(worktreeRepo.create({
        project_id: projectId,
        name: 'wt-3',
        branch_name: 'b',
        path: '/tmp/wt-3'
      }))
    )
    const updated = expectExitSuccess(
      await run(worktreeRepo.update(created.id, { name: 'renamed', branch_renamed: 1 }))
    )
    expect(updated?.name).toBe('renamed')
    expect(updated?.branch_renamed).toBe(1)
  })

  test('archive sets status to archived', async () => {
    const created = expectExitSuccess(
      await run(worktreeRepo.create({
        project_id: projectId,
        name: 'wt-4',
        branch_name: 'b',
        path: '/tmp/wt-4'
      }))
    )
    const archived = expectExitSuccess(await run(worktreeRepo.archive(created.id)))
    expect(archived?.status).toBe('archived')
  })

  test('delete returns true when row existed', async () => {
    const created = expectExitSuccess(
      await run(worktreeRepo.create({
        project_id: projectId,
        name: 'wt-5',
        branch_name: 'b',
        path: '/tmp/wt-5'
      }))
    )
    const deleted = expectExitSuccess(await run(worktreeRepo.delete(created.id)))
    expect(deleted).toBe(true)
    const after = expectExitSuccess(await run(worktreeRepo.get(created.id)))
    expect(after).toBeNull()
  })

  test('create with bogus project_id fails with DbForeignKeyViolation', async () => {
    const exit = await run(worktreeRepo.create({
      project_id: 'no-such-project',
      name: 'wt-6',
      branch_name: 'b',
      path: '/tmp/wt-6'
    }))
    expectExitFailure(exit, 'DbForeignKeyViolation')
  })

  test('updateContext writes context column', async () => {
    const created = expectExitSuccess(
      await run(worktreeRepo.create({
        project_id: projectId,
        name: 'wt-7',
        branch_name: 'b',
        path: '/tmp/wt-7'
      }))
    )
    expectExitSuccess(await run(worktreeRepo.updateContext(created.id, 'hello')))
    const after = expectExitSuccess(await run(worktreeRepo.get(created.id)))
    expect(after?.context).toBe('hello')
  })
})
