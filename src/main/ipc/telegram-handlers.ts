import { Data, Effect } from 'effect'
import { z } from 'zod'

import type { TelegramConfig, TelegramMode } from '@shared/types/telegram'
import { telegramForwardingService } from '../services/telegram-forwarding-service'
import { createLogger } from '../services/logger'
import { toError } from '../services/error-utils'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'TelegramHandlers' })

class TelegramHandlerFailed extends Data.TaggedError('TelegramHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const telegramFailed = (operation: string, cause: unknown): TelegramHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new TelegramHandlerFailed({ operation, reason, message: reason })
}

const telegramConfigSchema = z.object({
  botToken: z.string(),
  chatId: z.number(),
  chatName: z.string(),
  contextSize: z.number()
}) satisfies z.ZodType<TelegramConfig>

const startForwardingSchema = z.object({
  sessionId: z.string().min(1),
  worktreeId: z.string().nullable(),
  connectionId: z.string().nullable(),
  mode: z.enum(['questions', 'all'])
})

export function registerTelegramHandlers(): void {
  defineHandler('telegram:getConfig', z.tuple([]), () =>
    Effect.try({
      try: () => telegramForwardingService.getConfig(),
      catch: (error) => telegramFailed('telegram:getConfig', error)
    })
  )

  defineHandler('telegram:setConfig', telegramConfigSchema.nullable(), (config) =>
    Effect.sync(() => {
      try {
        telegramForwardingService.setConfig(config)
        return { ok: true }
      } catch (error) {
        log.error('telegram:setConfig failed', toError(error))
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  )

  defineHandler('telegram:verifyToken', z.string().min(1), (botToken) =>
    Effect.tryPromise({
      try: () => telegramForwardingService.verifyToken(botToken),
      catch: (error) => telegramFailed('telegram:verifyToken', error)
    })
  )

  defineHandler('telegram:discoverChats', telegramConfigSchema.nullish(), (config) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return await telegramForwardingService.discoverChats(config)
        } catch (error) {
          log.error('telegram:discoverChats failed', toError(error))
          return []
        }
      },
      catch: (error) => telegramFailed('telegram:discoverChats', error)
    })
  )

  defineHandler('telegram:sendTestMessage', z.tuple([]), () =>
    Effect.tryPromise({
      try: () => telegramForwardingService.sendTestMessage(),
      catch: (error) => telegramFailed('telegram:sendTestMessage', error)
    })
  )

  defineHandler(
    'telegram:startForwarding',
    startForwardingSchema,
    ({ sessionId, worktreeId, connectionId, mode }) =>
      Effect.tryPromise({
        try: async () => {
          try {
            const status = await telegramForwardingService.startForwarding({
              sessionId,
              worktreeId,
              connectionId,
              mode: mode as TelegramMode
            })
            return { ok: true, status }
          } catch (error) {
            log.error('telegram:startForwarding failed', toError(error))
            return {
              ok: false,
              status: telegramForwardingService.getStatus(),
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (error) => telegramFailed('telegram:startForwarding', error)
      })
  )

  defineHandler('telegram:stopForwarding', z.tuple([]), () =>
    Effect.tryPromise({
      try: async () => {
        const status = await telegramForwardingService.stopForwarding()
        return { status }
      },
      catch: (error) => telegramFailed('telegram:stopForwarding', error)
    })
  )

  defineHandler('telegram:getStatus', z.tuple([]), () =>
    Effect.try({
      try: () => telegramForwardingService.getStatus(),
      catch: (error) => telegramFailed('telegram:getStatus', error)
    })
  )
}
