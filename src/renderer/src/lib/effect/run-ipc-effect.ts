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

const isSuccessEnvelope = <A>(value: Envelope<A> | A): value is Extract<Envelope<A>, { success: true }> =>
  Boolean(value && typeof value === 'object' && 'success' in value && value.success === true && 'value' in value)

const isFailureEnvelope = <A>(value: Envelope<A> | A): value is Extract<Envelope<A>, { success: false }> =>
  Boolean(
    value &&
      typeof value === 'object' &&
      'success' in value &&
      value.success === false &&
      'errorCode' in value &&
      'error' in value
  )

export const runIpcEffect = <A>(invoke: () => Promise<Envelope<A> | A>): Effect.Effect<A, IpcError> =>
  Effect.tryPromise({
    try: invoke,
    catch: (error) =>
      new IpcError({
        errorCode: 'IpcTransport',
        error: messageFromUnknown(error),
        details: error
      })
  }).pipe(
    Effect.flatMap((envelope) => {
      if (isSuccessEnvelope(envelope)) return Effect.succeed(envelope.value)
      if (isFailureEnvelope(envelope)) {
        return Effect.fail(
          new IpcError({
            errorCode: envelope.errorCode,
            error: envelope.error,
            details: envelope.details
          })
        )
      }
      return Effect.succeed(envelope as A)
    })
  )
