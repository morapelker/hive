import { Effect } from 'effect'
import { z } from 'zod'
import {
  getDatabase,
  type CompactionPreview,
  type CompactionResult,
  type StorageStats
} from '../../../main/db'
import type { RpcHandler } from '../router'

export interface StorageOpsRpcService {
  readonly getStats: () => Effect.Effect<StorageStats, unknown, never>
  readonly previewCompaction: () => Effect.Effect<CompactionPreview, unknown, never>
  readonly compact: () => Effect.Effect<CompactionResult, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])

export const makeLiveStorageOpsRpcService = (): StorageOpsRpcService => ({
  getStats: () =>
    Effect.try({
      try: () => getDatabase().getStorageStats(),
      catch: (cause) => cause
    }),
  previewCompaction: () =>
    Effect.try({
      try: () => getDatabase().previewCompaction(),
      catch: (cause) => cause
    }),
  compact: () =>
    Effect.tryPromise({
      try: () => getDatabase().compactDatabase(),
      catch: (cause) => cause
    })
})

export const makeStorageOpsRpcHandlers = (
  service: StorageOpsRpcService = makeLiveStorageOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'storageOps.getStats',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getStats()
        })
    ],
    [
      'storageOps.previewCompaction',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.previewCompaction()
        })
    ],
    [
      'storageOps.compact',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.compact()
        })
    ]
  ])
