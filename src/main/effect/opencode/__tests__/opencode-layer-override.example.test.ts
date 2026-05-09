// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Cause, Effect, Exit, Layer, Stream } from 'effect'

import { OpenCodeSessionMissing, type OpenCodeError } from '../errors'
import { OpenCodeAgent } from '../service'
import type { SubscriptionParams } from '../types'

const unusedAsyncIterable: AsyncIterable<unknown> = {
  async *[Symbol.asyncIterator]() {}
}

const params: SubscriptionParams = {
  directory: '/repo',
  hiveSessionId: 'hive-1',
  client: {
    event: {
      subscribe: async () => ({ stream: unusedAsyncIterable })
    }
  }
}

const countSessionEvents = (input: SubscriptionParams) =>
  Effect.gen(function* () {
    const agent = yield* OpenCodeAgent
    return yield* Stream.runCount(agent.sessionEvents(input))
  })

const expectFailure = <A>(exit: Exit.Exit<A, OpenCodeError>) => {
  if (Exit.isSuccess(exit)) throw new Error('expected Exit.Failure')
  const failure = Cause.failureOption(exit.cause)
  if (failure._tag === 'None') throw new Error(Cause.pretty(exit.cause))
  return failure.value
}

describe('OpenCodeAgent layer override example', () => {
  it('runs a unit against a fake OpenCodeAgent layer', async () => {
    const fakeAgent = Layer.succeed(OpenCodeAgent, {
      sessionEvents: () => Stream.make(undefined, undefined)
    })

    const result = await Effect.runPromise(
      countSessionEvents(params).pipe(Effect.provide(fakeAgent))
    )

    expect(result).toBe(2)
  })

  it('can surface a typed OpenCode failure from the fake layer', async () => {
    const fakeAgent = Layer.succeed(OpenCodeAgent, {
      sessionEvents: (input) =>
        Stream.fail(new OpenCodeSessionMissing({ sessionId: input.hiveSessionId }))
    })

    const exit = await Effect.runPromiseExit(
      countSessionEvents(params).pipe(Effect.provide(fakeAgent))
    )

    const error = expectFailure(exit)
    expect(error).toBeInstanceOf(OpenCodeSessionMissing)
    expect(error.sessionId).toBe('hive-1')
  })
})
