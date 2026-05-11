// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Cause, Effect, Exit, Fiber, Layer, Ref, Schedule, Stream } from 'effect'

import { OpenCodePayloadInvalid, OpenCodeConnectionFailed } from '../errors'
import { SdkEventSchema } from '../schemas'
import { OpenCodeAgent, EventBus } from '../service'
import { EventBusLive, OpenCodeAgentLive } from '../layers'

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

const validEvent = (type = 'session.idle') => ({
  type,
  properties: { sessionID: 'oc-1' }
})

describe('OpenCodeAgentLive', () => {
  it('fails malformed SDK events with OpenCodePayloadInvalid', async () => {
    const exit = await runEffect(
      Effect.flatMap(OpenCodeAgent, (agent) =>
        Stream.runDrain(
          agent.sessionEvents({
            directory: '/repo',
            hiveSessionId: 'hive-1',
            client: {
              event: {
                subscribe: async () => ({ stream: makeIterable([{ properties: {} }]) })
              }
            }
          })
        )
      ).pipe(Effect.provide(Layer.provide(OpenCodeAgentLive, EventBusLive)))
    )

    const error = expectExitFailure(exit, 'OpenCodePayloadInvalid') as OpenCodePayloadInvalid
    expect(error).toBeInstanceOf(OpenCodePayloadInvalid)
    expect(error.schemaName).toBe('OpenCodeSdkEvent')
    expect(error.issues.length).toBeGreaterThan(0)
  })

  it('publishes decoded events in source order', async () => {
    const eventsRef = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
    const layer = Layer.provide(
      OpenCodeAgentLive,
      Layer.succeed(EventBus, {
        publish: (event) => Ref.update(eventsRef, (events) => [...events, event.type])
      })
    )

    const exit = await runEffect(
      Effect.flatMap(OpenCodeAgent, (agent) =>
        Stream.runDrain(
          agent.sessionEvents({
            directory: '/repo',
            hiveSessionId: 'hive-1',
            client: {
              event: {
                subscribe: async () => ({
                  stream: makeIterable([validEvent('session.busy'), validEvent('session.idle')])
                })
              }
            }
          })
        )
      ).pipe(Effect.provide(layer))
    )

    expectExitSuccess(exit)
    expect(await Effect.runPromise(Ref.get(eventsRef))).toEqual(['session.busy', 'session.idle'])
  })

  it('retries connection failures and then streams events', async () => {
    let attempts = 0
    const eventsRef = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
    const layer = Layer.provide(
      OpenCodeAgentLive,
      Layer.succeed(EventBus, {
        publish: (event) => Ref.update(eventsRef, (events) => [...events, event.type])
      })
    )

    const exit = await runEffect(
      Effect.flatMap(OpenCodeAgent, (agent) =>
        Stream.runDrain(
          agent.sessionEvents({
            directory: '/repo',
            hiveSessionId: 'hive-1',
            retrySchedule: Schedule.recurs(2),
            client: {
              event: {
                subscribe: async () => {
                  attempts += 1
                  if (attempts < 3) throw new Error('temporary')
                  return { stream: makeIterable([validEvent()]) }
                }
              }
            }
          })
        )
      ).pipe(Effect.provide(layer))
    )

    expectExitSuccess(exit)
    expect(attempts).toBe(3)
    expect(await Effect.runPromise(Ref.get(eventsRef))).toEqual(['session.idle'])
  })

  it('surfaces bounded connection failure after retries are exhausted', async () => {
    let attempts = 0
    const exit = await runEffect(
      Effect.flatMap(OpenCodeAgent, (agent) =>
        Stream.runDrain(
          agent.sessionEvents({
            directory: '/repo',
            hiveSessionId: 'hive-1',
            retrySchedule: Schedule.recurs(2),
            client: {
              event: {
                subscribe: async () => {
                  attempts += 1
                  throw new Error('down')
                }
              }
            }
          })
        )
      ).pipe(Effect.provide(Layer.provide(OpenCodeAgentLive, EventBusLive)))
    )

    const error = expectExitFailure(exit, 'OpenCodeConnectionFailed')
    expect(error).toBeInstanceOf(OpenCodeConnectionFailed)
    expect(attempts).toBe(3)
  })

  it('runs unsubscribe when the draining fiber is interrupted', async () => {
    let unsubscribed = 0
    const neverEnding = async function* (): AsyncGenerator<unknown> {
      while (true) {
        yield validEvent()
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    }

    const program = Effect.gen(function* () {
      const agent = yield* OpenCodeAgent
      const fiber = yield* Stream.runDrain(
        agent.sessionEvents({
          directory: '/repo',
          hiveSessionId: 'hive-1',
          client: {
            event: {
              subscribe: async () => ({
                stream: neverEnding(),
                unsubscribe: () => {
                  unsubscribed += 1
                }
              })
            }
          }
        })
      ).pipe(Effect.fork)

      yield* Effect.sleep('10 millis')
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.await(fiber)
    }).pipe(Effect.provide(Layer.provide(OpenCodeAgentLive, EventBusLive)))

    const exit = await Effect.runPromise(program)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.isInterruptedOnly(exit.cause)).toBe(true)
    }
    expect(unsubscribed).toBe(1)
  })

  it('exports a Zod schema that accepts consumed event variants', () => {
    expect(SdkEventSchema.safeParse(validEvent('message.completed')).success).toBe(true)
    expect(SdkEventSchema.safeParse({ properties: {} }).success).toBe(false)
  })
})
