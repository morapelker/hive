// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Cause, Effect, Exit, Fiber, Layer, Ref, Schedule, Stream } from 'effect'

import { ClaudeConnectionFailed, ClaudePayloadInvalid } from '../errors'
import { ClaudeAgent, EventBus } from '../service'
import { ClaudeAgentLive, EventBusLive } from '../layers'
import { SdkMessageSchema } from '../schemas'

const makeIterable = <A>(values: ReadonlyArray<A>): AsyncIterable<A> => ({
  async *[Symbol.asyncIterator]() {
    for (const value of values) {
      yield value
    }
  }
})

const runEffect = <A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect)

const expectExitSuccess = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected Exit.Success, got Exit.Failure: ${Cause.pretty(exit.cause)}`)
}

const expectExitFailure = <A, E>(exit: Exit.Exit<A, E>, expectedTag: string): E => {
  if (Exit.isSuccess(exit)) throw new Error(`expected Exit.Failure tagged "${expectedTag}"`)
  const failure = Cause.failureOption(exit.cause)
  if (failure._tag === 'None') throw new Error(Cause.pretty(exit.cause))
  expect((failure.value as { _tag?: string })._tag).toBe(expectedTag)
  return failure.value
}

const assistant = (sessionId = 'claude-1') => ({
  type: 'assistant',
  session_id: sessionId,
  message: { content: [{ type: 'text', text: 'hello' }] }
})

describe('ClaudeAgentLive', () => {
  it('fails malformed SDK messages with ClaudePayloadInvalid', async () => {
    const exit = await runEffect(
      Effect.flatMap(ClaudeAgent, (agent) =>
        Stream.runDrain(
          agent.sessionEvents({
            hiveSessionId: 'hive-1',
            queryIterator: makeIterable([{ session_id: 'missing-type' }])
          })
        )
      ).pipe(Effect.provide(Layer.provide(ClaudeAgentLive, EventBusLive)))
    )

    const error = expectExitFailure(exit, 'ClaudePayloadInvalid') as ClaudePayloadInvalid
    expect(error).toBeInstanceOf(ClaudePayloadInvalid)
    expect(error.schemaName).toBe('ClaudeSdkMessage')
  })

  it('publishes translated messages in source order', async () => {
    const eventsRef = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
    const layer = Layer.provide(
      ClaudeAgentLive,
      Layer.succeed(EventBus, {
        publish: (event) => Ref.update(eventsRef, (events) => [...events, event.type])
      })
    )

    const exit = await runEffect(
      Effect.flatMap(ClaudeAgent, (agent) =>
        Stream.runDrain(
          agent.sessionEvents({
            hiveSessionId: 'hive-1',
            queryIterator: makeIterable([
              { type: 'system', subtype: 'init', session_id: 'claude-1' },
              assistant('claude-1')
            ])
          })
        )
      ).pipe(Effect.provide(layer))
    )

    expectExitSuccess(exit)
    expect(await Effect.runPromise(Ref.get(eventsRef))).toEqual([
      'session.commands_available',
      'message.updated'
    ])
  })

  it('retries lazy query connection failures', async () => {
    let attempts = 0
    const eventsRef = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
    const layer = Layer.provide(
      ClaudeAgentLive,
      Layer.succeed(EventBus, {
        publish: (event) => Ref.update(eventsRef, (events) => [...events, event.type])
      })
    )

    const exit = await runEffect(
      Effect.flatMap(ClaudeAgent, (agent) =>
        Stream.runDrain(
          agent.sessionEvents({
            hiveSessionId: 'hive-1',
            retrySchedule: Schedule.recurs(2),
            connect: () => {
              attempts += 1
              if (attempts < 3) throw new Error('temporary')
              return makeIterable([assistant()])
            }
          })
        )
      ).pipe(Effect.provide(layer))
    )

    expectExitSuccess(exit)
    expect(attempts).toBe(3)
    expect(await Effect.runPromise(Ref.get(eventsRef))).toEqual(['message.updated'])
  })

  it('surfaces bounded connection failure after retries are exhausted', async () => {
    let attempts = 0
    const exit = await runEffect(
      Effect.flatMap(ClaudeAgent, (agent) =>
        Stream.runDrain(
          agent.sessionEvents({
            hiveSessionId: 'hive-1',
            retrySchedule: Schedule.recurs(2),
            connect: () => {
              attempts += 1
              throw new Error('down')
            }
          })
        )
      ).pipe(Effect.provide(Layer.provide(ClaudeAgentLive, EventBusLive)))
    )

    const error = expectExitFailure(exit, 'ClaudeConnectionFailed')
    expect(error).toBeInstanceOf(ClaudeConnectionFailed)
    expect(attempts).toBe(3)
  })

  it('closes query iterators on interruption', async () => {
    let returned = 0
    let yielded = false
    const queryIterator = {
      async next() {
        if (!yielded) {
          yielded = true
          return { done: false as const, value: assistant() }
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
        return { done: false as const, value: assistant() }
      },
      async return() {
        returned += 1
        return { done: true as const, value: undefined }
      },
      [Symbol.asyncIterator]() {
        return this
      }
    }

    const program = Effect.gen(function* () {
      const agent = yield* ClaudeAgent
      const fiber = yield* Stream.runDrain(
        agent.sessionEvents({
          hiveSessionId: 'hive-1',
          queryIterator
        })
      ).pipe(Effect.fork)
      yield* Effect.sleep('10 millis')
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.await(fiber)
    }).pipe(Effect.provide(Layer.provide(ClaudeAgentLive, EventBusLive)))

    const exit = await Effect.runPromise(program)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.isInterruptedOnly(exit.cause)).toBe(true)
    expect(returned).toBe(1)
  })

  it('exports a Zod schema that accepts consumed message variants', () => {
    expect(SdkMessageSchema.safeParse({ type: 'system', subtype: 'init' }).success).toBe(true)
    expect(SdkMessageSchema.safeParse(assistant()).success).toBe(true)
    expect(SdkMessageSchema.safeParse({ session_id: 'missing-type' }).success).toBe(false)
  })
})
