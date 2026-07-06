import { Effect } from 'effect'
import { z } from 'zod'
import {
  getClaudeAccountEmail,
  getOpenAIAccountEmail
} from '../../../main/services/account-service'
import {
  listSavedAccounts,
  removeSavedAccount,
  switchAccount
} from '../../../main/services/saved-usage-orchestrator'
import type { SavedAccountDTO, UsageProvider } from '../../../shared/types/usage'
import type { RpcHandler } from '../router'

export interface AccountOpsRpcService {
  readonly getClaudeEmail: () => Effect.Effect<string | null, unknown, never>
  readonly getOpenAIEmail: () => Effect.Effect<string | null, unknown, never>
  readonly listSaved: (provider?: UsageProvider) => Effect.Effect<SavedAccountDTO[], unknown, never>
  readonly removeSaved: (accountId: string) => Effect.Effect<boolean, unknown, never>
  readonly switchAccount: (
    accountId: string
  ) => Effect.Effect<{ success: boolean; error?: string }, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const listSavedParamsSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai']).optional()
  })
  .strict()
const removeSavedParamsSchema = z.object({ accountId: z.string() }).strict()
const switchAccountParamsSchema = z.object({ accountId: z.string() }).strict()

export const makeLiveAccountOpsRpcService = (): AccountOpsRpcService => ({
  getClaudeEmail: () =>
    Effect.tryPromise({
      try: () => getClaudeAccountEmail(),
      catch: (cause) => cause
    }),
  getOpenAIEmail: () =>
    Effect.tryPromise({
      try: () => getOpenAIAccountEmail(),
      catch: (cause) => cause
    }),
  listSaved: (provider) =>
    Effect.tryPromise({
      try: () => listSavedAccounts(provider),
      catch: (cause) => cause
    }),
  removeSaved: (accountId) =>
    Effect.tryPromise({
      try: () => removeSavedAccount(accountId),
      catch: (cause) => cause
    }),
  switchAccount: (accountId) =>
    Effect.tryPromise({
      try: () => switchAccount(accountId),
      catch: (cause) => cause
    })
})

export const makeAccountOpsRpcHandlers = (
  service: AccountOpsRpcService = makeLiveAccountOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'accountOps.getClaudeEmail',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getClaudeEmail()
        })
    ],
    [
      'accountOps.getOpenAIEmail',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getOpenAIEmail()
        })
    ],
    [
      'accountOps.listSaved',
      (params) =>
        Effect.gen(function* () {
          const { provider } = yield* Effect.try({
            try: () => listSavedParamsSchema.parse(params ?? {}),
            catch: (cause) => cause
          })
          return yield* service.listSaved(provider)
        })
    ],
    [
      'accountOps.removeSaved',
      (params) =>
        Effect.gen(function* () {
          const { accountId } = yield* Effect.try({
            try: () => removeSavedParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.removeSaved(accountId)
        })
    ],
    [
      'accountOps.switchAccount',
      (params) =>
        Effect.gen(function* () {
          const { accountId } = yield* Effect.try({
            try: () => switchAccountParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.switchAccount(accountId)
        })
    ]
  ])
