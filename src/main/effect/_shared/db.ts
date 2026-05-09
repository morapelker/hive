import { Context, Effect, Layer } from 'effect'

import { getDatabase } from '../../db'

export class Db extends Context.Tag('EffectShared/Db')<
  Db,
  {
    readonly get: Effect.Effect<ReturnType<typeof getDatabase>>
  }
>() {}

export const DbLive = Layer.succeed(Db, {
  get: Effect.sync(() => getDatabase())
})
