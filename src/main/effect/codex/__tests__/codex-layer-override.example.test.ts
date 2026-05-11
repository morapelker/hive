// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Cause, Effect, Exit, Layer, Stream } from 'effect'

import { CodexSessionMissing, type CodexError } from '../errors'
import { CodexAgent } from '../service'
import type { SubscriptionParams } from '../types'

const params: SubscriptionParams = {
  hiveSessionId: 'hive-1',
  threadId: 'thread-1',
  manager: {
    on: () => undefined
  }
}

const countSessionEvents = (input: SubscriptionParams) =>
  Effect.gen(function* () {
    const agent = yield* CodexAgent
    return yield* Stream.runCount(agent.sessionEvents(input))
  })

const twoSessionNotifications = Stream.make(void 0, void 0)

const expectFailure = <A>(exit: Exit.Exit<A, CodexError>) => {
  if (Exit.isSuccess(exit)) throw new Error('expected Exit.Failure')
  const failure = Cause.failureOption(exit.cause)
  if (failure._tag === 'None') throw new Error(Cause.pretty(exit.cause))
  return failure.value
}

describe('CodexAgent layer override example', () => {
  it('runs a unit against a fake CodexAgent layer', async () => {
    const fakeAgent = Layer.succeed(CodexAgent, {
      sessionEvents: () => twoSessionNotifications
    })

    const result = await Effect.runPromise(
      countSessionEvents(params).pipe(Effect.provide(fakeAgent))
    )

    expect(result).toBe(2)
  })

  it('can surface a typed Codex failure from the fake layer', async () => {
    const fakeAgent = Layer.succeed(CodexAgent, {
      sessionEvents: (input) => Stream.fail(new CodexSessionMissing({ threadId: input.threadId }))
    })

    const exit = await Effect.runPromiseExit(
      countSessionEvents(params).pipe(Effect.provide(fakeAgent))
    )

    const error = expectFailure(exit)
    expect(error).toBeInstanceOf(CodexSessionMissing)
    expect(error._tag).toBe('CodexSessionMissing')
    if (error._tag === 'CodexSessionMissing') {
      expect(error.threadId).toBe('thread-1')
    }
  })
})
