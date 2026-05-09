import { Data, Effect } from 'effect'
import { z } from 'zod'

import { createLogger } from '../services'
import { getClaudeAccountEmail, getOpenAIAccountEmail } from '../services/account-service'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'AccountHandlers' })

class AccountHandlerFailed extends Data.TaggedError('AccountHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const accountFailed = (operation: string, cause: unknown): AccountHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new AccountHandlerFailed({ operation, reason, message: reason })
}

export function registerAccountHandlers(): void {
  log.info('Registering account handlers')

  defineHandler('account:getClaudeEmail', z.tuple([]), () =>
    Effect.tryPromise({
      try: () => getClaudeAccountEmail(),
      catch: (cause) => accountFailed('account:getClaudeEmail', cause)
    })
  )

  defineHandler('account:getOpenAIEmail', z.tuple([]), () =>
    Effect.tryPromise({
      try: () => getOpenAIAccountEmail(),
      catch: (cause) => accountFailed('account:getOpenAIEmail', cause)
    })
  )
}
