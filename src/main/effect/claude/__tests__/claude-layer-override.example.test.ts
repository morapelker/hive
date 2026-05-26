// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Cause, Effect, Exit, Layer, Stream } from 'effect'

import { ClaudeSessionMissing, type ClaudeError } from '../errors'
import { ClaudeAgent } from '../service'
import type { SubscriptionParams } from '../types'

const params: SubscriptionParams = {
  hiveSessionId: 'hive-1'
}

const countSessionEvents = (input: SubscriptionParams) =>
  Effect.gen(function* () {
    const agent = yield* ClaudeAgent
    return yield* Stream.runCount(agent.sessionEvents(input))
  })

const twoSessionNotifications = Stream.make(void 0, void 0)

const expectFailure = <A>(exit: Exit.Exit<A, ClaudeError>) => {
  if (Exit.isSuccess(exit)) throw new Error('expected Exit.Failure')
  const failure = Cause.failureOption(exit.cause)
  if (failure._tag === 'None') throw new Error(Cause.pretty(exit.cause))
  return failure.value
}

describe('ClaudeAgent layer override example', () => {
  it('runs a unit against a fake ClaudeAgent layer', async () => {
    const fakeAgent = Layer.succeed(ClaudeAgent, {
      sessionEvents: () => twoSessionNotifications
    })

    const result = await Effect.runPromise(
      countSessionEvents(params).pipe(Effect.provide(fakeAgent))
    )

    expect(result).toBe(2)
  })

  it('can surface a typed Claude failure from the fake layer', async () => {
    const fakeAgent = Layer.succeed(ClaudeAgent, {
      sessionEvents: (input) =>
        Stream.fail(new ClaudeSessionMissing({ sessionId: input.hiveSessionId }))
    })

    const exit = await Effect.runPromiseExit(
      countSessionEvents(params).pipe(Effect.provide(fakeAgent))
    )

    const error = expectFailure(exit)
    expect(error).toBeInstanceOf(ClaudeSessionMissing)
    expect(error._tag).toBe('ClaudeSessionMissing')
    if (error._tag === 'ClaudeSessionMissing') {
      expect(error.sessionId).toBe('hive-1')
    }
  })
})
