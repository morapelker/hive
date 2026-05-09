import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { Db } from '../../src/main/effect/db/service'
import { makeTestDbLayer } from '../utils/db-effect-test-utils'
import { canRunDatabaseTests, createTestDatabase } from '../utils/db-test-utils'
import { expectExitFailure, expectExitSuccess, runEffect } from '../utils/effect-test-utils'

const describeIf = canRunDatabaseTests() ? describe : describe.skip

describeIf('Session 7: Db service basics', () => {
  let testDb: ReturnType<typeof createTestDatabase>

  beforeEach(() => {
    testDb = createTestDatabase()
  })

  afterEach(() => {
    testDb.cleanup()
  })

  const run = <A, E>(eff: Effect.Effect<A, E, Db>) =>
    runEffect(eff.pipe(Effect.provide(makeTestDbLayer(testDb.db))))

  test('query returns rows from settings table', async () => {
    testDb.db.setSetting('hello', 'world')
    const exit = await run(
      Effect.flatMap(Db, (d) =>
        d.query<{ key: string; value: string }>(
          'SELECT key, value FROM settings WHERE key = ?',
          ['hello']
        )
      )
    )
    const rows = expectExitSuccess(exit)
    expect(rows).toEqual([{ key: 'hello', value: 'world' }])
  })

  test('queryOne returns null when no row matches', async () => {
    const exit = await run(
      Effect.flatMap(Db, (d) => d.queryOne('SELECT * FROM settings WHERE key = ?', ['nope']))
    )
    expect(expectExitSuccess(exit)).toBeNull()
  })

  test('queryOne returns the row when one matches', async () => {
    testDb.db.setSetting('foo', 'bar')
    const exit = await run(
      Effect.flatMap(Db, (d) =>
        d.queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['foo'])
      )
    )
    expect(expectExitSuccess(exit)).toEqual({ value: 'bar' })
  })

  test('exec INSERT returns changes and lastInsertRowid', async () => {
    const exit = await run(
      Effect.flatMap(Db, (d) =>
        d.exec('INSERT INTO settings (key, value) VALUES (?, ?)', ['k', 'v'])
      )
    )
    const result = expectExitSuccess(exit)
    expect(result.changes).toBe(1)
    expect(typeof result.lastInsertRowid === 'number' || typeof result.lastInsertRowid === 'bigint').toBe(true)
  })

  test('exec on bad SQL fails with classified error', async () => {
    const exit = await run(
      Effect.flatMap(Db, (d) =>
        d.exec('INSERT INTO settings (key, value) VALUES (?)', ['only-one-bind'])
      )
    )
    expectExitFailure(exit, 'DbUnknown')
  })

  test('exec violating UNIQUE returns DbConstraintViolation', async () => {
    testDb.db.setSetting('unique-key', 'first')
    const exit = await run(
      Effect.flatMap(Db, (d) =>
        d.exec('INSERT INTO settings (key, value) VALUES (?, ?)', ['unique-key', 'second'])
      )
    )
    expectExitFailure(exit, 'DbConstraintViolation')
  })
})
