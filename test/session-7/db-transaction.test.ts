import { Effect, Exit, Fiber } from 'effect'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { Db } from '../../src/main/effect/db/service'
import { makeTestDbLayer } from '../utils/db-effect-test-utils'
import { canRunDatabaseTests, createTestDatabase } from '../utils/db-test-utils'
import { expectExitFailure, expectExitSuccess, runEffect } from '../utils/effect-test-utils'

const describeIf = canRunDatabaseTests() ? describe : describe.skip

describeIf('Session 7: Db.transaction', () => {
  let testDb: ReturnType<typeof createTestDatabase>

  beforeEach(() => {
    testDb = createTestDatabase()
  })

  afterEach(() => {
    testDb.cleanup()
  })

  const run = <A, E>(eff: Effect.Effect<A, E, Db>) =>
    runEffect(eff.pipe(Effect.provide(makeTestDbLayer(testDb.db))))

  test('commits on success - rows are visible after commit', async () => {
    const program = Effect.flatMap(Db, (d) =>
      d.transaction(
        Effect.gen(function* () {
          yield* d.exec('INSERT INTO settings (key, value) VALUES (?, ?)', ['a', '1'])
          yield* d.exec('INSERT INTO settings (key, value) VALUES (?, ?)', ['b', '2'])
        })
      )
    )
    expectExitSuccess(await run(program))

    expect(testDb.db.getSetting('a')).toBe('1')
    expect(testDb.db.getSetting('b')).toBe('2')
  })

  test('rolls back on failure - partial inserts are not visible', async () => {
    const program = Effect.flatMap(Db, (d) =>
      d.transaction(
        Effect.gen(function* () {
          yield* d.exec('INSERT INTO settings (key, value) VALUES (?, ?)', ['ok', 'first'])
          yield* Effect.fail('boom' as const)
        })
      )
    )
    const exit = await run(program)
    expect(Exit.isFailure(exit)).toBe(true)

    expect(testDb.db.getSetting('ok')).toBeNull()
  })

  test('rolls back on interruption', async () => {
    const program = Effect.flatMap(Db, (d) =>
      d.transaction(
        Effect.gen(function* () {
          yield* d.exec('INSERT INTO settings (key, value) VALUES (?, ?)', ['interrupt-me', 'x'])
          yield* Effect.never
        })
      )
    ).pipe(Effect.provide(makeTestDbLayer(testDb.db)))

    const fiber = Effect.runFork(program)
    await new Promise((r) => setTimeout(r, 50))
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(testDb.db.getSetting('interrupt-me')).toBeNull()
  })

  test('rolls back when an exec inside the transaction fails (DB error)', async () => {
    testDb.db.setSetting('dup', 'first')
    const program = Effect.flatMap(Db, (d) =>
      d.transaction(
        Effect.gen(function* () {
          yield* d.exec('INSERT INTO settings (key, value) VALUES (?, ?)', ['within-tx', 'y'])
          yield* d.exec('INSERT INTO settings (key, value) VALUES (?, ?)', ['dup', 'second'])
        })
      )
    )
    const exit = await run(program)
    expectExitFailure(exit, 'DbConstraintViolation')
    expect(testDb.db.getSetting('within-tx')).toBeNull()
  })

  test('nested transactions are not supported (BEGIN inside BEGIN fails)', async () => {
    const program = Effect.flatMap(Db, (d) =>
      d.transaction(d.transaction(d.exec('INSERT INTO settings (key, value) VALUES (?, ?)', ['n', '1'])))
    )
    const exit = await run(program)
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
