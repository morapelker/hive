// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Cause, Effect, Exit, Fiber, Layer, Ref, Schedule, Stream } from 'effect'

import { CodexAgent, EventBus } from '../service'
import { CodexAgentLive, EventBusLive } from '../layers'
import { CodexConnectionFailed, CodexPayloadInvalid } from '../errors'
import { CodexEventSchema } from '../schemas'

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

const codexEvent = (method: string, threadId = 'thread-1') => ({
  id: `${method}-1`,
  kind: 'notification',
  method,
  threadId,
  payload: {}
})

describe('CodexAgentLive', () => {
  it('fails malformed manager events with CodexPayloadInvalid', async () => {
    const manager = new EventEmitter()
    const exitPromise = runEffect(
      Effect.flatMap(CodexAgent, (agent) =>
        Stream.runDrain(
          agent.sessionEvents({
            manager,
            hiveSessionId: 'hive-1',
            threadId: 'thread-1'
          })
        )
      ).pipe(Effect.provide(Layer.provide(CodexAgentLive, EventBusLive)))
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    manager.emit('event', { method: 'turn/completed' })
    manager.emit('end')
    const exit = await exitPromise
    const error = expectExitFailure(exit, 'CodexPayloadInvalid') as CodexPayloadInvalid
    expect(error).toBeInstanceOf(CodexPayloadInvalid)
    expect(error.schemaName).toBe('CodexManagerEvent')
  })

  it('publishes mapped events in source order', async () => {
    const manager = new EventEmitter()
    const eventsRef = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
    const layer = Layer.provide(
      CodexAgentLive,
      Layer.succeed(EventBus, {
        publish: (event) => Ref.update(eventsRef, (events) => [...events, event.type])
      })
    )
    const exitPromise = runEffect(
      Effect.flatMap(CodexAgent, (agent) =>
        Stream.runDrain(
          agent.sessionEvents({
            manager,
            hiveSessionId: 'hive-1',
            threadId: 'thread-1'
          })
        )
      ).pipe(Effect.provide(layer))
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    manager.emit('event', {
      ...codexEvent('item/agentMessage/delta'),
      payload: { delta: 'hello' }
    })
    manager.emit('event', {
      ...codexEvent('turn/completed'),
      payload: { turn: { id: 'turn-1', status: 'completed' } }
    })
    manager.emit('end')

    const exit = await exitPromise
    expectExitSuccess(exit)
    expect(await Effect.runPromise(Ref.get(eventsRef))).toEqual([
      'message.part.updated',
      'session.status'
    ])
  })

  it('retries manager startup before listener registration', async () => {
    let attempts = 0
    const manager = new EventEmitter()
    const eventsRef = await Effect.runPromise(Ref.make<ReadonlyArray<string>>([]))
    const layer = Layer.provide(
      CodexAgentLive,
      Layer.succeed(EventBus, {
        publish: (event) => Ref.update(eventsRef, (events) => [...events, event.type])
      })
    )

    const exitPromise = runEffect(
      Effect.flatMap(CodexAgent, (agent) =>
        Stream.runDrain(
          agent.sessionEvents({
            manager,
            hiveSessionId: 'hive-1',
            threadId: 'thread-1',
            retrySchedule: Schedule.recurs(2),
            startup: () => {
              attempts += 1
              if (attempts < 3) throw new Error('not ready')
            }
          })
        )
      ).pipe(Effect.provide(layer))
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    manager.emit('event', {
      ...codexEvent('item/agentMessage/delta'),
      payload: { delta: 'hello' }
    })
    manager.emit('end')

    const exit = await exitPromise
    expectExitSuccess(exit)
    expect(attempts).toBe(3)
    expect(await Effect.runPromise(Ref.get(eventsRef))).toEqual(['message.part.updated'])
  })

  it('surfaces bounded startup failure after retries are exhausted', async () => {
    let attempts = 0
    const exit = await runEffect(
      Effect.flatMap(CodexAgent, (agent) =>
        Stream.runDrain(
          agent.sessionEvents({
            manager: new EventEmitter(),
            hiveSessionId: 'hive-1',
            threadId: 'thread-1',
            retrySchedule: Schedule.recurs(2),
            startup: () => {
              attempts += 1
              throw new Error('down')
            }
          })
        )
      ).pipe(Effect.provide(Layer.provide(CodexAgentLive, EventBusLive)))
    )

    const error = expectExitFailure(exit, 'CodexConnectionFailed')
    expect(error).toBeInstanceOf(CodexConnectionFailed)
    expect(attempts).toBe(3)
  })

  it('detaches manager listeners on interruption', async () => {
    const manager = new EventEmitter()
    const program = Effect.gen(function* () {
      const agent = yield* CodexAgent
      const fiber = yield* Stream.runDrain(
        agent.sessionEvents({
          manager,
          hiveSessionId: 'hive-1',
          threadId: 'thread-1'
        })
      ).pipe(Effect.fork)
      yield* Effect.sleep('10 millis')
      expect(manager.listenerCount('event')).toBe(1)
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.await(fiber)
    }).pipe(Effect.provide(Layer.provide(CodexAgentLive, EventBusLive)))

    const exit = await Effect.runPromise(program)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.isInterruptedOnly(exit.cause)).toBe(true)
    expect(manager.listenerCount('event')).toBe(0)
  })

  it('exports a Zod schema for consumed manager events', () => {
    expect(CodexEventSchema.safeParse(codexEvent('turn/completed')).success).toBe(true)
    expect(CodexEventSchema.safeParse({ method: 'turn/completed' }).success).toBe(false)
  })
})
