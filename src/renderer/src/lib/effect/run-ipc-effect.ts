import { Effect } from 'effect'

import type { Envelope } from '@shared/types/ipc-envelope'
import { IpcError } from './ipc-error'

const messageFromUnknown = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export const runIpcEffect = <A>(invoke: () => Promise<Envelope<A>>): Effect.Effect<A, IpcError> =>
  Effect.tryPromise({
    try: invoke,
    catch: (error) =>
      new IpcError({
        errorCode: 'IpcTransport',
        error: messageFromUnknown(error),
        details: error
      })
  }).pipe(
    Effect.flatMap((envelope) =>
      envelope.success
        ? Effect.succeed(envelope.value)
        : Effect.fail(
            new IpcError({
              errorCode: envelope.errorCode,
              error: envelope.error,
              details: envelope.details
            })
          )
    )
  )
