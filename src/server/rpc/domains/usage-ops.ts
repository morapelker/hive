import { Effect } from 'effect'
import { z } from 'zod'
import type {
  FetchForAccountResult,
  OpenAIUsageResult,
  RefreshAllResultItem,
  UsageProvider,
  UsageResult
} from '@shared/types/usage'
import {
  fetchForAccountOp,
  fetchOpenAIUsageOp,
  fetchUsageOp,
  refreshAllForProviderOp
} from '../../../main/services/usage-ops'
import type { RpcHandler } from '../router'

export interface UsageOpsRpcService {
  readonly fetch: () => Effect.Effect<UsageResult, unknown, never>
  readonly fetchOpenai: () => Effect.Effect<OpenAIUsageResult, unknown, never>
  readonly fetchForAccount: (
    accountId: string
  ) => Effect.Effect<FetchForAccountResult, unknown, never>
  readonly refreshAllForProvider: (
    provider: UsageProvider
  ) => Effect.Effect<RefreshAllResultItem[], unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const fetchForAccountParamsSchema = z.object({ accountId: z.string() }).strict()
const refreshAllForProviderParamsSchema = z
  .object({ provider: z.enum(['anthropic', 'openai']) })
  .strict()

export const makeLiveUsageOpsRpcService = (): UsageOpsRpcService => ({
  fetch: () =>
    Effect.tryPromise({
      try: () => fetchUsageOp(),
      catch: (cause) => cause
    }),
  fetchOpenai: () =>
    Effect.tryPromise({
      try: () => fetchOpenAIUsageOp(),
      catch: (cause) => cause
    }),
  fetchForAccount: (accountId) =>
    Effect.tryPromise({
      try: () => fetchForAccountOp(accountId),
      catch: (cause) => cause
    }),
  refreshAllForProvider: (provider) =>
    Effect.tryPromise({
      try: () => refreshAllForProviderOp(provider),
      catch: (cause) => cause
    })
})

export const makeUsageOpsRpcHandlers = (
  service: UsageOpsRpcService = makeLiveUsageOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'usageOps.fetch',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.fetch()
        })
    ],
    [
      'usageOps.fetchOpenai',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.fetchOpenai()
        })
    ],
    [
      'usageOps.fetchForAccount',
      (params) =>
        Effect.gen(function* () {
          const { accountId } = yield* Effect.try({
            try: () => fetchForAccountParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.fetchForAccount(accountId)
        })
    ],
    [
      'usageOps.refreshAllForProvider',
      (params) =>
        Effect.gen(function* () {
          const { provider } = yield* Effect.try({
            try: () => refreshAllForProviderParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.refreshAllForProvider(provider)
        })
    ]
  ])
