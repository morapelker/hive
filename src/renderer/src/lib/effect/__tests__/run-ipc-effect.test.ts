import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { Envelope } from '@shared/types/ipc-envelope'
import { catchIpcCode, IpcError, runIpcEffect } from '..'

const successEnvelope = <A>(value: A): Envelope<A> => ({ success: true, value })

const failureEnvelope = (
  errorCode: string,
  error: string,
  details?: unknown
): Envelope<never> => ({
  success: false,
  errorCode,
  error,
  details
})

describe('runIpcEffect', () => {
  it('returns the value from a successful envelope', async () => {
    const result = await Effect.runPromise(runIpcEffect(() => Promise.resolve(successEnvelope('ok'))))

    expect(result).toBe('ok')
  })

  it('turns a failed envelope into an IpcError preserving errorCode, error, and details', async () => {
    const details = { path: '/tmp/file.txt' }

    const error = await Effect.runPromise(
      Effect.flip(
        runIpcEffect(() => Promise.resolve(failureEnvelope('FileReadFailed', 'Could not read', details)))
      )
    )

    expect(error).toBeInstanceOf(IpcError)
    expect(error).toMatchObject({
      _tag: 'IpcError',
      errorCode: 'FileReadFailed',
      error: 'Could not read',
      details
    })
  })

  it("turns a rejected invoke promise into an IpcError with errorCode 'IpcTransport'", async () => {
    const cause = new Error('ipc disconnected')

    const error = await Effect.runPromise(Effect.flip(runIpcEffect(() => Promise.reject(cause))))

    expect(error).toBeInstanceOf(IpcError)
    expect(error).toMatchObject({
      _tag: 'IpcError',
      errorCode: 'IpcTransport',
      error: 'ipc disconnected',
      details: cause
    })
  })

  it('invokes the thunk again when retried', async () => {
    let attempts = 0
    const effect = runIpcEffect(() => {
      attempts += 1
      return Promise.resolve(
        attempts === 1
          ? failureEnvelope('Busy', 'Try again')
          : successEnvelope({ attempt: attempts })
      )
    })

    const result = await Effect.runPromise(effect.pipe(Effect.retry({ times: 1 })))

    expect(result).toEqual({ attempt: 2 })
    expect(attempts).toBe(2)
  })

  it('catchIpcCode recovers only matching error codes', async () => {
    const result = await Effect.runPromise(
      runIpcEffect(() => Promise.resolve(failureEnvelope('NotFound', 'Missing'))).pipe(
        catchIpcCode('NotFound', (error) => Effect.succeed(`recovered:${error.error}`))
      )
    )

    expect(result).toBe('recovered:Missing')
  })

  it('catchIpcCode rethrows non-matching error codes', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        runIpcEffect(() => Promise.resolve(failureEnvelope('PermissionDenied', 'No access'))).pipe(
          catchIpcCode('NotFound', () => Effect.succeed('recovered'))
        )
      )
    )

    expect(error).toMatchObject({
      _tag: 'IpcError',
      errorCode: 'PermissionDenied',
      error: 'No access'
    })
  })
})
