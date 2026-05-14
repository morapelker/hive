import { Data, Effect } from 'effect'
import { z } from 'zod'

import { createLogger } from '../services'
import { fetchClaudeUsage } from '../services/usage-service'
import { fetchOpenAIUsage } from '../services/openai-usage-service'
import {
  captureLiveAccountFromFetch,
  fetchForSavedAccount,
  refreshAllForProvider
} from '../services/saved-usage-orchestrator'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'UsageHandlers' })

class UsageHandlerFailed extends Data.TaggedError('UsageHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const usageFailed = (operation: string, cause: unknown): UsageHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new UsageHandlerFailed({ operation, reason, message: reason })
}

export function registerUsageHandlers(): void {
  log.info('Registering usage handlers')

  defineHandler('usage:fetch', z.tuple([]), () =>
    Effect.tryPromise({
      try: async () => {
        const result = await fetchClaudeUsage()
        if (result.success && result.data) {
          try {
            await captureLiveAccountFromFetch('anthropic', result.data)
          } catch (error) {
            log.warn('Failed to capture Claude saved usage account', {
              error: error instanceof Error ? error.message : String(error)
            })
          }
        }
        return result
      },
      catch: (cause) => usageFailed('usage:fetch', cause)
    })
  )

  defineHandler('usage:fetchOpenai', z.tuple([]), () =>
    Effect.tryPromise({
      try: async () => {
        const result = await fetchOpenAIUsage()
        if (result.success && result.data) {
          try {
            await captureLiveAccountFromFetch('openai', result.data)
          } catch (error) {
            log.warn('Failed to capture OpenAI saved usage account', {
              error: error instanceof Error ? error.message : String(error)
            })
          }
        }
        return result
      },
      catch: (cause) => usageFailed('usage:fetchOpenai', cause)
    })
  )

  defineHandler('usage:fetchForAccount', z.string(), (accountId) =>
    Effect.tryPromise({
      try: () => fetchForSavedAccount(accountId),
      catch: (cause) => usageFailed('usage:fetchForAccount', cause)
    })
  )

  defineHandler('usage:refreshAllForProvider', z.enum(['anthropic', 'openai']), (provider) =>
    Effect.tryPromise({
      try: () => refreshAllForProvider(provider),
      catch: (cause) => usageFailed('usage:refreshAllForProvider', cause)
    })
  )
}
