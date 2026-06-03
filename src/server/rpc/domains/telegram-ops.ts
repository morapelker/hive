import { Effect } from 'effect'
import { z } from 'zod'
import type {
  TelegramConfig,
  TelegramDiscoveredChat,
  TelegramForwardingStatus,
  TelegramStartForwardingRequest
} from '@shared/types/telegram'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import { TELEGRAM_CLAUDE_CLI_EVENT_CHANNEL } from '@shared/telegram-events'
import type { EventBus } from '../../events/event-bus'
import type { RpcHandler } from '../router'

export interface TelegramOpsRpcService {
  readonly getConfig: () => Effect.Effect<TelegramConfig | null, unknown, never>
  readonly setConfig: (
    config: TelegramConfig | null
  ) => Effect.Effect<TelegramSetConfigResult, unknown, never>
  readonly verifyToken: (
    botToken: string
  ) => Effect.Effect<TelegramVerifyTokenResult, unknown, never>
  readonly discoverChats: (
    config?: TelegramConfig | null
  ) => Effect.Effect<TelegramDiscoveredChat[], unknown, never>
  readonly sendTestMessage: () => Effect.Effect<TelegramSetConfigResult, unknown, never>
  readonly startForwarding: (
    params: TelegramStartForwardingRequest
  ) => Effect.Effect<TelegramStartForwardingResult, unknown, never>
  readonly stopForwarding: () => Effect.Effect<TelegramStopForwardingResult, unknown, never>
  readonly getStatus: () => Effect.Effect<TelegramForwardingStatus, unknown, never>
}

export interface TelegramSetConfigResult {
  readonly ok: boolean
  readonly error?: string
}

export interface TelegramVerifyTokenResult {
  readonly ok: boolean
  readonly botUsername?: string
  readonly error?: string
}

export interface TelegramStartForwardingResult {
  readonly ok: boolean
  readonly status: TelegramForwardingStatus
  readonly error?: string
}

export interface TelegramStopForwardingResult {
  readonly status: TelegramForwardingStatus
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const telegramConfigSchema = z.object({
  botToken: z.string(),
  chatId: z.number(),
  chatName: z.string(),
  contextSize: z.number()
}) satisfies z.ZodType<TelegramConfig>
const setConfigParamsSchema = z
  .object({
    config: telegramConfigSchema.nullable()
  })
  .strict()
const verifyTokenParamsSchema = z
  .object({
    botToken: z.string().min(1)
  })
  .strict()
const discoverChatsParamsSchema = z
  .union([
    z
      .object({
        config: telegramConfigSchema.nullish()
      })
      .strict(),
    z.undefined(),
    z.null()
  ])
  .transform((params) =>
    params && typeof params === 'object' && 'config' in params ? params.config : undefined
  )
const startForwardingRequestSchema = z.object({
  sessionId: z.string().min(1),
  worktreeId: z.string().nullable(),
  connectionId: z.string().nullable(),
  mode: z.enum(['questions', 'all'])
}) satisfies z.ZodType<TelegramStartForwardingRequest>
const startForwardingParamsSchema = z
  .object({
    params: startForwardingRequestSchema
  })
  .strict()
const subscribedEventBuses = new WeakSet<EventBus>()

const importTelegramForwardingService = async (eventBus?: EventBus) => {
  const [{ telegramForwardingService }, { getDatabase }] = await Promise.all([
    import('../../../main/services/telegram-forwarding-service'),
    import('../../../main/db')
  ])
  telegramForwardingService.initialize({ db: getDatabase() })
  if (eventBus) {
    telegramForwardingService.setBackendEventPublisher((channel, payload) => {
      void Effect.runPromise(eventBus.publish({ channel, payload }))
    })
    if (!subscribedEventBuses.has(eventBus)) {
      subscribedEventBuses.add(eventBus)
      Effect.runSync(
        eventBus.subscribe(OPENCODE_STREAM_CHANNEL, ({ payload }) => {
          telegramForwardingService.handleBackendAgentEvent(payload)
        })
      )
      Effect.runSync(
        eventBus.subscribe(TELEGRAM_CLAUDE_CLI_EVENT_CHANNEL, ({ payload }) => {
          telegramForwardingService.handleBackendAgentEvent(payload)
        })
      )
    }
  }
  return telegramForwardingService
}

export const makeLiveTelegramOpsRpcService = (eventBus?: EventBus): TelegramOpsRpcService => ({
  getConfig: () =>
    Effect.tryPromise({
      try: async () => {
        const telegramForwardingService = await importTelegramForwardingService(eventBus)
        return telegramForwardingService.getConfig()
      },
      catch: (cause) => cause
    }),
  setConfig: (config) =>
    Effect.tryPromise({
      try: async () => {
        const [telegramForwardingService, { createLogger }, { toError }] = await Promise.all([
          importTelegramForwardingService(eventBus),
          import('../../../main/services/logger'),
          import('../../../main/services/error-utils')
        ])
        try {
          telegramForwardingService.setConfig(config)
          return { ok: true }
        } catch (error) {
          createLogger({ component: 'TelegramOpsRpc' }).error(
            'telegramOps.setConfig failed',
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
        const telegramForwardingService = await importTelegramForwardingService(eventBus)
        return telegramForwardingService.verifyToken(botToken)
      },
      catch: (cause) => cause
    }),
  discoverChats: (config) =>
    Effect.tryPromise({
      try: async () => {
        const [telegramForwardingService, { createLogger }, { toError }] = await Promise.all([
          importTelegramForwardingService(eventBus),
          import('../../../main/services/logger'),
          import('../../../main/services/error-utils')
        ])
        try {
          return await telegramForwardingService.discoverChats(config)
        } catch (error) {
          createLogger({ component: 'TelegramOpsRpc' }).error(
            'telegramOps.discoverChats failed',
            toError(error)
          )
          return []
        }
      },
      catch: (cause) => cause
    }),
  sendTestMessage: () =>
    Effect.tryPromise({
      try: async () => {
        const telegramForwardingService = await importTelegramForwardingService(eventBus)
        return telegramForwardingService.sendTestMessage()
      },
      catch: (cause) => cause
    }),
  startForwarding: (params) =>
    Effect.tryPromise({
      try: async () => {
        const [telegramForwardingService, { createLogger }, { toError }] = await Promise.all([
          importTelegramForwardingService(eventBus),
          import('../../../main/services/logger'),
          import('../../../main/services/error-utils')
        ])
        try {
          const status = await telegramForwardingService.startForwarding(params)
          return { ok: true, status }
        } catch (error) {
          createLogger({ component: 'TelegramOpsRpc' }).error(
            'telegramOps.startForwarding failed',
            toError(error)
          )
          return {
            ok: false,
            status: telegramForwardingService.getStatus(),
            error: error instanceof Error ? error.message : String(error)
          }
        }
      },
      catch: (cause) => cause
    }),
  stopForwarding: () =>
    Effect.tryPromise({
      try: async () => {
        const telegramForwardingService = await importTelegramForwardingService(eventBus)
        const status = await telegramForwardingService.stopForwarding()
        return { status }
      },
      catch: (cause) => cause
    }),
  getStatus: () =>
    Effect.tryPromise({
      try: async () => {
        const telegramForwardingService = await importTelegramForwardingService(eventBus)
        return telegramForwardingService.getStatus()
      },
      catch: (cause) => cause
    })
})

export const makeTelegramOpsRpcHandlers = (
  service: TelegramOpsRpcService = makeLiveTelegramOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'telegramOps.getConfig',
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
      'telegramOps.setConfig',
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
      'telegramOps.verifyToken',
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
      'telegramOps.discoverChats',
      (params) =>
        Effect.gen(function* () {
          const config = yield* Effect.try({
            try: () => discoverChatsParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.discoverChats(config)
        })
    ],
    [
      'telegramOps.sendTestMessage',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.sendTestMessage()
        })
    ],
    [
      'telegramOps.startForwarding',
      (params) =>
        Effect.gen(function* () {
          const { params: startParams } = yield* Effect.try({
            try: () => startForwardingParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.startForwarding(startParams)
        })
    ],
    [
      'telegramOps.stopForwarding',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.stopForwarding()
        })
    ],
    [
      'telegramOps.getStatus',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getStatus()
        })
    ]
  ])
