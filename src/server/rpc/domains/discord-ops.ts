import { Effect } from 'effect'
import { z } from 'zod'
import type {
  DiscordConfig,
  DiscordProvisionSummary,
  DiscordVerifyResult
} from '@shared/types/discord'
import type { EventBus } from '../../events/event-bus'
import type { RpcHandler } from '../router'

export interface DiscordOpsRpcService {
  readonly getConfig: () => Effect.Effect<DiscordConfig | null, unknown, never>
  readonly setConfig: (
    config: DiscordConfig | null
  ) => Effect.Effect<DiscordSetConfigResult, unknown, never>
  readonly verifyToken: (botToken: string) => Effect.Effect<DiscordVerifyResult, unknown, never>
  readonly provision: (
    selectedProjectIds: string[]
  ) => Effect.Effect<DiscordProvisionSummary, unknown, never>
  readonly disable: () => Effect.Effect<DiscordDisableResult, unknown, never>
}

export interface DiscordSetConfigResult {
  readonly ok: boolean
  readonly error?: string
}

export interface DiscordDisableResult {
  readonly ok: boolean
  readonly error?: string
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const discordConfigSchema = z.object({
  botToken: z.string(),
  guildId: z.string(),
  guildName: z.string(),
  enabled: z.boolean(),
  selectedProjectIds: z.array(z.string())
}) satisfies z.ZodType<DiscordConfig>
const setConfigParamsSchema = z
  .object({
    config: discordConfigSchema.nullable()
  })
  .strict()
const verifyTokenParamsSchema = z
  .object({
    botToken: z.string().min(1)
  })
  .strict()
const provisionParamsSchema = z
  .object({
    selectedProjectIds: z.array(z.string())
  })
  .strict()
const bootedEventBuses = new WeakSet<EventBus>()

const importDiscordService = async (eventBus?: EventBus) => {
  const { discordService } = await import('../../../main/services/discord-service')
  if (eventBus) {
    discordService.setBackendEventPublisher((channel, payload) => {
      void Effect.runPromise(eventBus.publish({ channel, payload }))
    })
  }
  return discordService
}

export const makeLiveDiscordOpsRpcService = (eventBus?: EventBus): DiscordOpsRpcService => {
  if (eventBus && !bootedEventBuses.has(eventBus)) {
    bootedEventBuses.add(eventBus)
    void importDiscordService(eventBus)
      .then((service) => service.startListening())
      .catch(() => undefined)
  }

  return {
    getConfig: () =>
      Effect.tryPromise({
        try: async () => {
          const discordService = await importDiscordService(eventBus)
          return discordService.getConfig()
        },
        catch: (cause) => cause
      }),
    setConfig: (config) =>
      Effect.tryPromise({
        try: async () => {
          const [discordService, { createLogger }, { toError }] = await Promise.all([
            importDiscordService(eventBus),
            import('../../../main/services/logger'),
            import('../../../main/services/error-utils')
          ])
          try {
            discordService.setConfig(config)
            return { ok: true }
          } catch (error) {
            createLogger({ component: 'DiscordOpsRpc' }).error(
              'discordOps.setConfig failed',
              toError(error)
            )
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },
        catch: (cause) => cause
      }),
    verifyToken: (botToken) =>
      Effect.tryPromise({
        try: async () => {
          const discordService = await importDiscordService(eventBus)
          return discordService.verify(botToken)
        },
        catch: (cause) => cause
      }),
    provision: (selectedProjectIds) =>
      Effect.tryPromise({
        try: async () => {
          const discordService = await importDiscordService(eventBus)
          return discordService.provision(selectedProjectIds)
        },
        catch: (cause) => cause
      }),
    disable: () =>
      Effect.tryPromise({
        try: async () => {
          const [discordService, { createLogger }, { toError }] = await Promise.all([
            importDiscordService(eventBus),
            import('../../../main/services/logger'),
            import('../../../main/services/error-utils')
          ])
          try {
            await discordService.disable()
            return { ok: true }
          } catch (error) {
            createLogger({ component: 'DiscordOpsRpc' }).error(
              'discordOps.disable failed',
              toError(error)
            )
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },
        catch: (cause) => cause
      })
  }
}

export const makeDiscordOpsRpcHandlers = (
  service: DiscordOpsRpcService = makeLiveDiscordOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'discordOps.getConfig',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getConfig()
        })
    ],
    [
      'discordOps.setConfig',
      (params) =>
        Effect.gen(function* () {
          const { config } = yield* Effect.try({
            try: () => setConfigParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setConfig(config)
        })
    ],
    [
      'discordOps.verifyToken',
      (params) =>
        Effect.gen(function* () {
          const { botToken } = yield* Effect.try({
            try: () => verifyTokenParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.verifyToken(botToken)
        })
    ],
    [
      'discordOps.provision',
      (params) =>
        Effect.gen(function* () {
          const { selectedProjectIds } = yield* Effect.try({
            try: () => provisionParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.provision(selectedProjectIds)
        })
    ],
    [
      'discordOps.disable',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.disable()
        })
    ]
  ])
