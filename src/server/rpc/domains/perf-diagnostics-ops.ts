import { Effect } from 'effect'
import { z } from 'zod'
import { perfDiagnostics, type PerfSnapshot } from '../../../main/services/perf-diagnostics'
import type { RpcHandler } from '../router'

export interface PerfDiagnosticsOpsRpcService {
  readonly enable: (enabled: boolean) => Effect.Effect<void, unknown, never>
  readonly getSnapshot: () => Effect.Effect<PerfSnapshot, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const enableParamsSchema = z.object({ enabled: z.boolean() }).strict()

export const makeLivePerfDiagnosticsOpsRpcService = (): PerfDiagnosticsOpsRpcService => ({
  enable: (enabled) =>
    Effect.try({
      try: () => {
        if (enabled) {
          perfDiagnostics.start()
        } else {
          perfDiagnostics.stop()
        }
      },
      catch: (cause) => cause
    }),
  getSnapshot: () =>
    Effect.try({
      try: () => perfDiagnostics.getSnapshot(),
      catch: (cause) => cause
    })
})

export const makePerfDiagnosticsOpsRpcHandlers = (
  service: PerfDiagnosticsOpsRpcService = makeLivePerfDiagnosticsOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'perfDiagnosticsOps.enable',
      (params) =>
        Effect.gen(function* () {
          const { enabled } = yield* Effect.try({
            try: () => enableParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.enable(enabled)
        })
    ],
    [
      'perfDiagnosticsOps.getSnapshot',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getSnapshot()
        })
    ]
  ])
