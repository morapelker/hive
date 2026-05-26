// @vitest-environment node
import { Data, Cause } from 'effect'
import { describe, expect, it } from 'vitest'

import { BashAlreadyRunning } from '../../effect/bash/errors'
import { humanMessage } from '../../effect/bash/facade'
import { fromCause } from '../error-utils'

class PlainTaggedError extends Error {
  readonly _tag = 'PlainTaggedError'

  constructor(readonly id: string) {
    super('plain failure')
  }
}

class MixedDetailsError extends Data.TaggedError('MixedDetailsError')<{
  readonly keep: string
  readonly nested: {
    readonly keep: number
    readonly remove: () => void
  }
  readonly fn: () => void
  readonly symbolValue: symbol
  readonly missing?: string
}> {}

describe('fromCause', () => {
  it('renders tagged failures with a caller-provided humanizer and details', () => {
    const envelope = fromCause(Cause.fail(new BashAlreadyRunning({ sessionId: 's' })), {
      humanize: humanMessage
    })

    expect(envelope).toEqual({
      errorCode: 'BashAlreadyRunning',
      error: 'A bash command is already running for session s',
      details: { sessionId: 's' }
    })
  })

  it('renders defects as UnexpectedDefect with Cause.pretty output', () => {
    const cause = Cause.die(new Error('boom'))
    const envelope = fromCause(cause)

    expect(envelope.errorCode).toBe('UnexpectedDefect')
    expect(envelope.error).toBe(Cause.pretty(cause))
    expect(envelope.details).toBeUndefined()
  })

  it('falls back to error.message for tagged failures without a humanizer', () => {
    const envelope = fromCause(Cause.fail(new PlainTaggedError('abc')))

    expect(envelope).toEqual({
      errorCode: 'PlainTaggedError',
      error: 'plain failure',
      details: { id: 'abc' }
    })
  })

  it('strips non-serializable fields from failure details', () => {
    const envelope = fromCause(
      Cause.fail(
        new MixedDetailsError({
          keep: 'yes',
          nested: { keep: 1, remove: () => undefined },
          fn: () => undefined,
          symbolValue: Symbol('drop'),
          missing: undefined
        })
      )
    )

    expect(envelope.details).toEqual({
      keep: 'yes',
      nested: { keep: 1 }
    })
  })
})
