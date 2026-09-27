import {
  listOpenAIResetCreditsOp,
  consumeOpenAIResetCreditOp
} from '../../../main/services/openai-reset-service'
import { Effect } from 'effect'
import { z } from 'zod'
import type {
  ClaudeTokenTally,
  FetchForAccountResult,
  OpenAIUsageResult,
  OpenAIResetCredits,
  OpenAIResetResult,
  RefreshAllResultItem,
  UsageProvider,
  UsageResult
} from '@shared/types/usage'
import {
  fetchForAccountOp,
  fetchOpenAIUsageOp,
  fetchUsageOp,
  getClaudeTokenTallyOp,
  refreshAllForProviderOp
} from '../../../main/services/usage-ops'
import type { RpcHandler } from '../router'

export interface UsageOpsRpcService {
  readonly listOpenaiResets: (
    accountId: string
  ) => Effect.Effect<OpenAIResetCredits, unknown, never>
  readonly consumeOpenaiReset: (
    accountId: string,
    redeemRequestId: string,
    creditId?: string
  ) => Effect.Effect<OpenAIResetResult, unknown, never>
  readonly fetch: () => Effect.Effect<UsageResult, unknown, never>
  readonly fetchOpenai: () => Effect.Effect<OpenAIUsageResult, unknown, never>
  readonly fetchForAccount: (
    accountId: string,
    userInitiated?: boolean
  ) => Effect.Effect<FetchForAccountResult, unknown, never>
  readonly refreshAllForProvider: (
    provider: UsageProvider,
    excludeAccountIds?: string[],
    maxAgeMs?: number
  ) => Effect.Effect<RefreshAllResultItem[], unknown, never>
  readonly getClaudeTokenTally: () => Effect.Effect<ClaudeTokenTally, unknown, never>
}

const resetAccountSchema = z.object({ accountId: z.string().min(1) }).strict()
const consumeResetSchema = z
  .object({
    accountId: z.string().min(1),
    redeemRequestId: z.string().uuid(),
    creditId: z.string().min(1).optional()
  })
  .strict()

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const fetchForAccountParamsSchema = z
  .object({ accountId: z.string(), userInitiated: z.boolean().optional() })
  .strict()
const refreshAllForProviderParamsSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai']),
    excludeAccountIds: z.array(z.string()).optional(),
    maxAgeMs: z.number().int().positive().optional()
  })
  .strict()

export const makeLiveUsageOpsRpcService = (): UsageOpsRpcService => ({
  listOpenaiResets: (accountId) => Effect.tryPromise(() => listOpenAIResetCreditsOp(accountId)),
  consumeOpenaiReset: (accountId, redeemRequestId, creditId) =>
    Effect.tryPromise(() => consumeOpenAIResetCreditOp(accountId, redeemRequestId, creditId)),
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
  fetchForAccount: (accountId, userInitiated) =>
    Effect.tryPromise({
      try: () => fetchForAccountOp(accountId, userInitiated),
      catch: (cause) => cause
    }),
  refreshAllForProvider: (provider, excludeAccountIds, maxAgeMs) =>
    Effect.tryPromise({
      try: () => refreshAllForProviderOp(provider, excludeAccountIds, maxAgeMs),
      catch: (cause) => cause
    }),
  getClaudeTokenTally: () =>
    Effect.tryPromise({
      try: () => getClaudeTokenTallyOp(),
      catch: (cause) => cause
    })
})

export const makeUsageOpsRpcHandlers = (
  service: UsageOpsRpcService = makeLiveUsageOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'usageOps.listOpenaiResets',
      (params) =>
        Effect.gen(function* () {
          const { accountId } = yield* Effect.try(() => resetAccountSchema.parse(params))
          return yield* service.listOpenaiResets(accountId)
        })
    ],
    [
      'usageOps.consumeOpenaiReset',
      (params) =>
        Effect.gen(function* () {
          const { accountId, redeemRequestId, creditId } = yield* Effect.try(() =>
            consumeResetSchema.parse(params)
          )
          return yield* service.consumeOpenaiReset(accountId, redeemRequestId, creditId)
        })
    ],
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
          const { accountId, userInitiated } = yield* Effect.try({
            try: () => fetchForAccountParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.fetchForAccount(accountId, userInitiated)
        })
    ],
    [
      'usageOps.refreshAllForProvider',
      (params) =>
        Effect.gen(function* () {
          const { provider, excludeAccountIds, maxAgeMs } = yield* Effect.try({
            try: () => refreshAllForProviderParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.refreshAllForProvider(provider, excludeAccountIds, maxAgeMs)
        })
    ],
    [
      'usageOps.getClaudeTokenTally',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getClaudeTokenTally()
        })
    ]
  ])
