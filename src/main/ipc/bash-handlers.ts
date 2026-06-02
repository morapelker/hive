import type { BrowserWindow } from 'electron'
import { Data, Effect } from 'effect'
import { z } from 'zod'

import { bashService } from '../effect/bash/facade'
import { createLogger } from '../services/logger'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'BashHandlers' })

class BashHandlerFailed extends Data.TaggedError('BashHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const toReason = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const bashHandlerFailed = (operation: string, reason: string): BashHandlerFailed =>
  new BashHandlerFailed({ operation, reason, message: reason })

export function registerBashHandlers(mainWindow: BrowserWindow): void {
  bashService.setMainWindow(mainWindow)

  defineHandler(
    'bash:run',
    z.object({
      sessionId: z.string().min(1),
      command: z.string().min(1),
      cwd: z.string().min(1)
    }),
    (payload) => {
      log.info('IPC: bash:run', {
        sessionId: payload.sessionId,
        command: payload.command,
        cwd: payload.cwd
      })

      return Effect.tryPromise({
        try: () => bashService.run(payload.sessionId, payload.command, payload.cwd),
        catch: (cause) => {
          log.error('IPC: bash:run failed', cause instanceof Error ? cause : new Error(String(cause)))
          return bashHandlerFailed('bash:run', toReason(cause))
        }
      }).pipe(
        Effect.flatMap((envelope) =>
          envelope.success
            ? Effect.succeed({ runId: envelope.runId })
            : Effect.fail(bashHandlerFailed('bash:run', envelope.error))
        )
      )
    }
  )

  defineHandler('bash:abort', z.string().min(1), (sessionId) => {
    log.info('IPC: bash:abort', { sessionId })
    return Effect.tryPromise({
      try: () => bashService.abort(sessionId),
      catch: (cause) => {
        log.error('IPC: bash:abort failed', cause instanceof Error ? cause : new Error(String(cause)))
        return bashHandlerFailed('bash:abort', toReason(cause))
      }
    })
  })

  defineHandler('bash:getRun', z.string().min(1), (sessionId) => {
    return Effect.tryPromise({
      try: () => bashService.getRun(sessionId),
      catch: (cause) => {
        log.error('IPC: bash:getRun failed', cause instanceof Error ? cause : new Error(String(cause)))
        return bashHandlerFailed('bash:getRun', toReason(cause))
      }
    })
  })
}
