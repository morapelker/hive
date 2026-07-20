import { Effect } from 'effect'
import { z } from 'zod'
import {
  getClaudeAccountEmail,
  getOpenAIAccountEmail
} from '../../../main/services/account-service'
import {
  loginCancel,
  loginStart,
  loginStatus
} from '../../../main/services/login-service'
import {
  listSavedAccounts,
  removeSavedAccount,
  switchAccount
} from '../../../main/services/saved-usage-orchestrator'
import {
  exportAccountShare,
  importAccountShareFromLink,
  type ExportedAccountShare,
  type ImportedAccountShare
} from '../../../main/services/account-share-service'
import type { LoginStatusDTO, SavedAccountDTO, UsageProvider } from '../../../shared/types/usage'
import type { RpcHandler } from '../router'

export interface AccountOpsRpcService {
  readonly getClaudeEmail: () => Effect.Effect<string | null, unknown, never>
  readonly getOpenAIEmail: () => Effect.Effect<string | null, unknown, never>
  readonly listSaved: (provider?: UsageProvider) => Effect.Effect<SavedAccountDTO[], unknown, never>
  readonly removeSaved: (accountId: string) => Effect.Effect<boolean, unknown, never>
  readonly switchAccount: (
    accountId: string
  ) => Effect.Effect<{ success: boolean; error?: string }, unknown, never>
  readonly loginStart: (
    provider: UsageProvider,
    email?: string
  ) => Effect.Effect<{ loginId: string }, unknown, never>
  readonly loginStatus: (loginId: string) => Effect.Effect<LoginStatusDTO, unknown, never>
  readonly loginCancel: (loginId: string) => Effect.Effect<boolean, unknown, never>
  readonly exportShare: (accountId: string) => Effect.Effect<ExportedAccountShare, unknown, never>
  readonly importShare: (url: string) => Effect.Effect<ImportedAccountShare, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const listSavedParamsSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai']).optional()
  })
  .strict()
const removeSavedParamsSchema = z.object({ accountId: z.string() }).strict()
const switchAccountParamsSchema = z.object({ accountId: z.string() }).strict()
const loginStartParamsSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai']),
    email: z.string().optional()
  })
  .strict()
const loginStatusParamsSchema = z.object({ loginId: z.string() }).strict()
const loginCancelParamsSchema = z.object({ loginId: z.string() }).strict()
const exportShareParamsSchema = z.object({ accountId: z.string() }).strict()
const importShareParamsSchema = z.object({ url: z.string() }).strict()

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
    }),
  loginStart: (provider, email) =>
    Effect.tryPromise({
      try: () => loginStart(provider, email),
      catch: (cause) => cause
    }),
  loginStatus: (loginId) =>
    Effect.try({
      try: () => loginStatus(loginId),
      catch: (cause) => cause
    }),
  loginCancel: (loginId) =>
    Effect.tryPromise({
      try: () => loginCancel(loginId),
      catch: (cause) => cause
    }),
  exportShare: (accountId) =>
    Effect.tryPromise({
      try: () => exportAccountShare(accountId),
      catch: (cause) => cause
    }),
  importShare: (url) =>
    Effect.tryPromise({
      try: () => importAccountShareFromLink(url),
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
    ],
    [
      'accountOps.loginStart',
      (params) =>
        Effect.gen(function* () {
          const { provider, email } = yield* Effect.try({
            try: () => loginStartParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.loginStart(provider, email)
        })
    ],
    [
      'accountOps.loginStatus',
      (params) =>
        Effect.gen(function* () {
          const { loginId } = yield* Effect.try({
            try: () => loginStatusParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.loginStatus(loginId)
        })
    ],
    [
      'accountOps.loginCancel',
      (params) =>
        Effect.gen(function* () {
          const { loginId } = yield* Effect.try({
            try: () => loginCancelParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.loginCancel(loginId)
        })
    ],
    [
      'accountOps.exportShare',
      (params) =>
        Effect.gen(function* () {
          const { accountId } = yield* Effect.try({
            try: () => exportShareParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.exportShare(accountId)
        })
    ],
    [
      'accountOps.importShare',
      (params) =>
        Effect.gen(function* () {
          const { url } = yield* Effect.try({
            try: () => importShareParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.importShare(url)
        })
    ]
  ])
