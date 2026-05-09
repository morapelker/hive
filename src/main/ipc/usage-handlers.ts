import { Data, Effect } from 'effect'
import { z } from 'zod'

import { createLogger } from '../services'
import { fetchClaudeUsage } from '../services/usage-service'
import { fetchOpenAIUsage } from '../services/openai-usage-service'
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
      try: () => fetchClaudeUsage(),
      catch: (cause) => usageFailed('usage:fetch', cause)
    })
  )

  defineHandler('usage:fetchOpenai', z.tuple([]), () =>
    Effect.tryPromise({
      try: () => fetchOpenAIUsage(),
      catch: (cause) => usageFailed('usage:fetchOpenai', cause)
    })
  )
}
