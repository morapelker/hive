import { Effect, Layer, Schedule, Stream } from 'effect'

import { agentEventBus } from '../../services/agent-event-bus'
import { mapCodexEventToStreamEvents } from '../../services/codex-event-mapper'
import { decodeWithZod } from '../_shared/zod-adapter'
import { CodexConnectionFailed, CodexPayloadInvalid, CodexStreamInterrupted } from './errors'
import { CodexEventSchema, type CodexSdkEvent } from './schemas'
import { CodexAgent, EventBus } from './service'
import type { SubscriptionParams } from './types'

const retrySchedule = Schedule.exponential('100 millis').pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(6))
)

const mapPayloadError = (error: unknown): CodexPayloadInvalid => {
  const decoded = error as { issues?: readonly never[]; schemaName?: string }
  return new CodexPayloadInvalid({
    schemaName: decoded.schemaName ?? 'CodexManagerEvent',
    issues: decoded.issues ?? []
  })
}

const startup = (params: SubscriptionParams) =>
  Effect.tryPromise({
    try: async () => {
      await params.startup?.()
    },
    catch: (cause) => new CodexConnectionFailed({ cause })
  })

const managerStream = (params: SubscriptionParams) =>
  Stream.asyncPush<unknown, CodexStreamInterrupted>(
    (emit) =>
      Effect.gen(function* () {
        const onEvent = (event: unknown): void => {
          emit.single(event)
        }
        const onError = (cause: unknown): void => {
          emit.fail(new CodexStreamInterrupted({ cause }))
        }
        const onEnd = (): void => {
          emit.end()
        }

        params.manager.on('event', onEvent)
        params.manager.on('error', onError)
        params.manager.on('end', onEnd)

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            const remove = params.manager.removeListener ?? params.manager.off
            remove?.call(params.manager, 'event', onEvent)
            remove?.call(params.manager, 'error', onError)
            remove?.call(params.manager, 'end', onEnd)
          })
        )
      }),
    { bufferSize: 'unbounded' }
  )

const handleEvent = (
  params: SubscriptionParams,
  bus: EventBus['Type'],
  event: CodexSdkEvent
) => {
  if (event.threadId !== params.threadId) return Effect.void
  if (params.onEvent) {
    return Effect.tryPromise({
      try: () => Promise.resolve(params.onEvent?.(event)),
      catch: (cause) => new CodexStreamInterrupted({ cause })
    })
  }

  return Effect.forEach(
    mapCodexEventToStreamEvents(event as never, params.hiveSessionId),
    (streamEvent) => bus.publish(streamEvent),
    { discard: true }
  )
}

export const CodexAgentLive = Layer.effect(
  CodexAgent,
  Effect.gen(function* () {
    const bus = yield* EventBus

    const sessionEvents = (params: SubscriptionParams) =>
      Stream.unwrapScoped(
        startup(params).pipe(
          Effect.retry(params.retrySchedule ?? retrySchedule),
          Effect.as(managerStream(params))
        )
      ).pipe(
        Stream.mapEffect((raw) =>
          decodeWithZod(CodexEventSchema, raw, 'CodexManagerEvent').pipe(
            Effect.mapError(mapPayloadError)
          )
        ),
        Stream.mapEffect((event) => handleEvent(params, bus, event))
      )

    return { sessionEvents }
  })
)

export const EventBusLive = Layer.succeed(EventBus, {
  publish: (event) => Effect.sync(() => agentEventBus.publish(event))
})

export const AppLive = Layer.provide(CodexAgentLive, EventBusLive)
