import { Data, Effect } from 'effect'
import { z } from 'zod'

import { getDatabase } from '../db'
import { defineHandler } from './_shared/define-handler'

class StorageHandlerFailed extends Data.TaggedError('StorageHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const storageFailed = (operation: string, cause: unknown): StorageHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new StorageHandlerFailed({ operation, reason, message: reason })
}

const tryDb = <A>(operation: string, fn: () => A): Effect.Effect<A, StorageHandlerFailed> =>
  Effect.try({
    try: fn,
    catch: (error) => storageFailed(operation, error)
  })

export function registerStorageHandlers(): void {
  defineHandler('storage:getStats', z.tuple([]), () =>
    tryDb('storage:getStats', () => getDatabase().getStorageStats())
  )

  defineHandler('storage:previewCompaction', z.tuple([]), () =>
    tryDb('storage:previewCompaction', () => getDatabase().previewCompaction())
  )

  defineHandler('storage:compact', z.tuple([]), () =>
    tryDb('storage:compact', () => getDatabase().compactDatabase())
  )
}
