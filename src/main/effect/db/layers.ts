import { Context, Effect, Layer, Ref } from 'effect'

import { getDatabase } from '../../db'
import type { DatabaseService } from '../../db/database'
import { classifyDbError, type DbError } from './errors'
import { Db, type ExecResult } from './service'

const tryDb = <A>(thunk: () => A): Effect.Effect<A, DbError> =>
  Effect.try({ try: thunk, catch: classifyDbError })

type DbServiceShape = Context.Tag.Service<Db>

export const makeDbService = (svc: DatabaseService): DbServiceShape => {
  const raw = (): import('better-sqlite3').Database => svc.getRawDb()

  const query = <T = unknown>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Effect.Effect<T[], DbError> => tryDb(() => raw().prepare(sql).all(...params) as T[])

  const queryOne = <T = unknown>(
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Effect.Effect<T | null, DbError> =>
    tryDb(() => {
      const row = raw().prepare(sql).get(...params) as T | undefined
      return row ?? null
    })

  const exec = (
    sql: string,
    params: ReadonlyArray<unknown> = []
  ): Effect.Effect<ExecResult, DbError> =>
    tryDb(() => {
      const result = raw().prepare(sql).run(...params)
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
    })

  const transaction = <A, E, R>(
    self: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | DbError, R> =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* tryDb(() => raw().exec('BEGIN'))
        const committed = yield* Ref.make(false)
        yield* Effect.addFinalizer(() =>
          Ref.get(committed).pipe(
            Effect.flatMap((c) =>
              c
                ? Effect.void
                : tryDb(() => raw().exec('ROLLBACK')).pipe(Effect.catchAll(() => Effect.void))
            )
          )
        )
        const result = yield* self
        yield* tryDb(() => raw().exec('COMMIT'))
        yield* Ref.set(committed, true)
        return result
      })
    )

  return {
    query,
    queryOne,
    exec,
    transaction,
    raw: Effect.sync(() => svc)
  }
}

export const DbLive: Layer.Layer<Db> = Layer.effect(
  Db,
  Effect.sync(() => makeDbService(getDatabase()))
)
