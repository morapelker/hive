import { Effect } from 'effect'
import { z } from 'zod'
import { configure as configureCodexDebugLogger } from '../../../main/services/codex-debug-logger'
import type { RpcHandler } from '../router'

export interface CodexDebugLoggerOpsRpcService {
  readonly configure: (
    enabled: boolean,
    resetPerSession: boolean
  ) => Effect.Effect<void, unknown, never>
}

const configureParamsSchema = z
  .object({
    enabled: z.boolean(),
    resetPerSession: z.boolean()
  })
  .strict()

export const makeLiveCodexDebugLoggerOpsRpcService = (): CodexDebugLoggerOpsRpcService => ({
  configure: (enabled, resetPerSession) =>
    Effect.try({
      try: () => {
        configureCodexDebugLogger({ enabled, resetPerSession })
      },
      catch: (cause) => cause
    })
})

export const makeCodexDebugLoggerOpsRpcHandlers = (
  service: CodexDebugLoggerOpsRpcService = makeLiveCodexDebugLoggerOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'codexDebugLoggerOps.configure',
      (params) =>
        Effect.gen(function* () {
          const { enabled, resetPerSession } = yield* Effect.try({
            try: () => configureParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.configure(enabled, resetPerSession)
        })
    ]
  ])
