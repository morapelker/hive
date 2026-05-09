import { Context, Effect } from 'effect'

import type { DatabaseService } from '../../db/database'
import type { DbError } from './errors'

type Eff<A> = Effect.Effect<A, DbError>

export interface ExecResult {
  readonly changes: number
  readonly lastInsertRowid: number | bigint
}

export class Db extends Context.Tag('DbIsland/Db')<
  Db,
  {
    readonly query: <T = unknown>(
      sql: string,
      params?: ReadonlyArray<unknown>
    ) => Eff<T[]>
    readonly queryOne: <T = unknown>(
      sql: string,
      params?: ReadonlyArray<unknown>
    ) => Eff<T | null>
    readonly exec: (sql: string, params?: ReadonlyArray<unknown>) => Eff<ExecResult>
    readonly transaction: <A, E, R>(
      self: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | DbError, R>
    /** Escape hatch for code that hasn't migrated yet (settings reads, projects, sessions). */
    readonly raw: Effect.Effect<DatabaseService>
  }
>() {}
