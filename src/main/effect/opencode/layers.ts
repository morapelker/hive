import { Effect, Layer, Schedule, Stream } from 'effect'

import { agentEventBus } from '../../services/agent-event-bus'
import { decodeWithZod } from '../_shared/zod-adapter'
import {
  OpenCodeConnectionFailed,
  OpenCodePayloadInvalid,
  OpenCodeStreamInterrupted
} from './errors'
import { EventBus, OpenCodeAgent } from './service'
import { SdkEventSchema, type OpenCodeSdkEvent } from './schemas'
import type { OpenCodeSubscriptionResult, SubscriptionParams } from './types'

const retrySchedule = Schedule.exponential('100 millis').pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(6))
)

const normalizeEvent = (
  event: OpenCodeSdkEvent,
  fallbackDirectory: string
): { event: Extract<OpenCodeSdkEvent, { type: string }>; directory: string } => {
  if ('payload' in event) {
    return {
      event: event.payload as Extract<OpenCodeSdkEvent, { type: string }>,
      directory: event.directory as string
    }
  }
  return { event: event as Extract<OpenCodeSdkEvent, { type: string }>, directory: fallbackDirectory }
}

const toStreamEvent = (
  event: OpenCodeSdkEvent,
  directory: string,
  hiveSessionId: string
) => {
  const normalized = normalizeEvent(event, directory)
  return {
    type: normalized.event.type,
    sessionId: hiveSessionId,
    data: normalized.event.properties ?? normalized.event
  }
}

const mapPayloadError = (error: unknown): OpenCodePayloadInvalid => {
  const decoded = error as { issues?: readonly never[]; schemaName?: string }
  return new OpenCodePayloadInvalid({
    schemaName: decoded.schemaName ?? 'OpenCodeSdkEvent',
    issues: decoded.issues ?? []
  })
}

const connect = (params: SubscriptionParams) =>
  Effect.tryPromise({
    try: () =>
      params.client.event.subscribe({
        query: { directory: params.directory }
      }),
    catch: (cause) => new OpenCodeConnectionFailed({ directory: params.directory, cause })
  })

const handleEvent = (
  params: SubscriptionParams,
  bus: EventBus['Type'],
  event: OpenCodeSdkEvent
) => {
  const normalized = normalizeEvent(event, params.directory)
  if (params.onEvent) {
    return Effect.tryPromise({
      try: () => Promise.resolve(params.onEvent?.(event, normalized.directory)),
      catch: (cause) =>
        new OpenCodeStreamInterrupted({ directory: normalized.directory, cause })
    })
  }
  return bus.publish(toStreamEvent(event, params.directory, params.hiveSessionId))
}

export const OpenCodeAgentLive = Layer.effect(
  OpenCodeAgent,
  Effect.gen(function* () {
    const bus = yield* EventBus

    const sessionEvents = (params: SubscriptionParams) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const result: OpenCodeSubscriptionResult = yield* connect(params).pipe(
            Effect.retry(params.retrySchedule ?? retrySchedule)
          )
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              result.unsubscribe?.()
            })
          )
          return Stream.fromAsyncIterable(
            result.stream,
            (cause) => new OpenCodeStreamInterrupted({ directory: params.directory, cause })
          )
        })
      ).pipe(
        Stream.mapEffect((raw) =>
          decodeWithZod(SdkEventSchema, raw, 'OpenCodeSdkEvent').pipe(
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

export const AppLive = Layer.provide(OpenCodeAgentLive, EventBusLive)
