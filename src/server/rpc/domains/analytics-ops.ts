import { Effect } from 'effect'
import { z } from 'zod'
import { telemetryService } from '../../../main/services/telemetry-service'
import type { RpcHandler } from '../router'

export interface AnalyticsOpsRpcService {
  readonly track: (
    event: string,
    properties?: Record<string, unknown>
  ) => Effect.Effect<void, unknown, never>
  readonly setEnabled: (enabled: boolean) => Effect.Effect<void, unknown, never>
  readonly isEnabled: () => Effect.Effect<boolean, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const trackParamsSchema = z
  .object({
    event: z.string(),
    properties: z.record(z.string(), z.unknown()).optional()
  })
  .strict()
const setEnabledParamsSchema = z.object({ enabled: z.boolean() }).strict()

export const makeLiveAnalyticsOpsRpcService = (): AnalyticsOpsRpcService => ({
  track: (event, properties) =>
    Effect.try({
      try: () => {
        telemetryService.track(event, properties)
      },
      catch: (cause) => cause
    }),
  setEnabled: (enabled) =>
    Effect.tryPromise({
      try: () => telemetryService.setEnabled(enabled),
      catch: (cause) => cause
    }),
  isEnabled: () =>
    Effect.try({
      try: () => telemetryService.isEnabled(),
      catch: (cause) => cause
    })
})

export const makeAnalyticsOpsRpcHandlers = (
  service: AnalyticsOpsRpcService = makeLiveAnalyticsOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'analyticsOps.track',
      (params) =>
        Effect.gen(function* () {
          const { event, properties } = yield* Effect.try({
            try: () => trackParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.track(event, properties)
        })
    ],
    [
      'analyticsOps.setEnabled',
      (params) =>
        Effect.gen(function* () {
          const { enabled } = yield* Effect.try({
            try: () => setEnabledParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setEnabled(enabled)
        })
    ],
    [
      'analyticsOps.isEnabled',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.isEnabled()
        })
    ]
  ])
