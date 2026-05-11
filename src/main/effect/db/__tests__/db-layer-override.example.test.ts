// @vitest-environment node
import { Context, Effect, Either, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { Db } from '../service'
import { DbConstraintViolation } from '../errors'

type DbServiceShape = Context.Tag.Service<Db>

interface User {
  readonly id: string
  readonly name: string
}

// These tiny functions are the "unit under test" for this example. In a real
// island test, they would usually live in an operation module and the test would
// provide a fake Db layer at the edge.
const readUsers = Effect.gen(function* () {
  const db = yield* Db
  return yield* db.query<User>('select id, name from users order by id')
})

const reserveUserName = (name: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db.exec('insert into users (name) values (?)', [name])
  })

// Keep one complete fake factory in the example so future tests can copy it
// directly. The object shape intentionally mirrors src/main/effect/db/service.ts:
// query, queryOne, exec, transaction, and raw.
const makeFakeDb = (overrides: Partial<DbServiceShape> = {}): DbServiceShape => ({
  // Default to empty successful reads. Individual tests override only the
  // method that matters for the behavior under test.
  query: <T = unknown>(_sql: string, _params: ReadonlyArray<unknown> = []) =>
    Effect.succeed([] as T[]),

  // queryOne returns null instead of throwing when no row is found, matching the
  // Db service contract.
  queryOne: <T = unknown>(_sql: string, _params: ReadonlyArray<unknown> = []) =>
    Effect.succeed(null as T | null),

  // exec returns the normalized write result shape from Db.ExecResult.
  exec: (_sql: string, _params: ReadonlyArray<unknown> = []) =>
    Effect.succeed({ changes: 0, lastInsertRowid: 0 }),

  // Unit tests commonly do not need real transaction behavior. Returning the
  // supplied Effect keeps code using db.transaction(...) testable while still
  // preserving the typed DbError channel.
  transaction: <A, E, R>(self: Effect.Effect<A, E, R>) => self,

  // raw is the escape hatch for legacy DatabaseService access. Most island unit
  // tests should fail loudly if the unit under test accidentally reaches for it.
  raw: Effect.die('raw DatabaseService is not provided by this fake Db'),

  ...overrides
})

const runWithFakeDb = <A, E>(program: Effect.Effect<A, E, Db>, fake: DbServiceShape) =>
  Effect.runPromise(program.pipe(Effect.provide(Layer.succeed(Db, fake))))

describe('Db layer override example', () => {
  it('overrides Db with Layer.succeed for a successful query', async () => {
    const users: ReadonlyArray<User> = [
      { id: 'user-1', name: 'Ada' },
      { id: 'user-2', name: 'Grace' }
    ]

    const fake = makeFakeDb({
      query: <T = unknown>(sql: string, params: ReadonlyArray<unknown> = []) => {
        expect(sql).toBe('select id, name from users order by id')
        expect(params).toEqual([])
        return Effect.succeed(users as T[])
      }
    })

    const result = await runWithFakeDb(readUsers, fake)

    expect(result).toEqual(users)
  })

  it('asserts typed Db failures with Either', async () => {
    const constraint = new DbConstraintViolation({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'UNIQUE constraint failed: users.name',
      cause: new Error('duplicate user name')
    })

    const fake = makeFakeDb({
      exec: (sql: string, params: ReadonlyArray<unknown> = []) => {
        expect(sql).toBe('insert into users (name) values (?)')
        expect(params).toEqual(['Ada'])
        return Effect.fail(constraint)
      }
    })

    const result = await runWithFakeDb(Effect.either(reserveUserName('Ada')), fake)

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe('DbConstraintViolation')
      expect(result.left).toBe(constraint)
    }
  })
})
