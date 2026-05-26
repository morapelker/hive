import { Effect, Layer, Schedule, Stream } from 'effect'

import { agentEventBus } from '../../services/agent-event-bus'
import { decodeWithZod } from '../_shared/zod-adapter'
import { ClaudeConnectionFailed, ClaudePayloadInvalid, ClaudeStreamInterrupted } from './errors'
import { SdkMessageSchema, type ClaudeSdkMessage } from './schemas'
import { ClaudeAgent, EventBus } from './service'
import type { CloseableAsyncIterable, SubscriptionParams } from './types'

const retrySchedule = Schedule.exponential('100 millis').pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(6))
)

const mapPayloadError = (error: unknown): ClaudePayloadInvalid => {
  const decoded = error as { issues?: readonly never[]; schemaName?: string }
  return new ClaudePayloadInvalid({
    schemaName: decoded.schemaName ?? 'ClaudeSdkMessage',
    issues: decoded.issues ?? []
  })
}

const connect = (params: SubscriptionParams) =>
  Effect.tryPromise({
    try: async () => {
      if (params.connect) return await params.connect()
      if (params.queryIterator) return params.queryIterator
      throw new Error('Claude query iterator missing')
    },
    catch: (cause) => new ClaudeConnectionFailed({ cause })
  })

const closeIterator = (iterator: CloseableAsyncIterable) =>
  Effect.promise(async () => {
    await iterator.return?.()
    iterator.close?.()
  }).pipe(Effect.catchAll(() => Effect.void))

const guardRelease = (iterator: CloseableAsyncIterable): CloseableAsyncIterable => {
  let released = false
  const source = iterator[Symbol.asyncIterator]()

  const release = async (): Promise<IteratorResult<unknown, void>> => {
    if (released) return { done: true, value: undefined }
    released = true
    await iterator.return?.()
    iterator.close?.()
    return { done: true, value: undefined }
  }

  return {
    next: (...args: ReadonlyArray<unknown>) =>
      (source as AsyncIterator<unknown>).next(...(args as [])) as Promise<
        IteratorResult<unknown, void>
      >,
    [Symbol.asyncIterator]() {
      return this as AsyncIterator<unknown> & CloseableAsyncIterable
    },
    return: release,
    close: () => {
      void release()
    }
  }
}

const publishDefault = (
  bus: EventBus['Type'],
  hiveSessionId: string,
  message: ClaudeSdkMessage
) => {
  if (message.type === 'system' && message.subtype === 'init') {
    return bus.publish({ type: 'session.commands_available', sessionId: hiveSessionId, data: {} })
  }
  if (message.type === 'stream_event') {
    const rawEvent = message.event as Record<string, unknown> | undefined
    const delta = rawEvent?.delta as Record<string, unknown> | undefined
    if (rawEvent?.type === 'content_block_delta' && delta?.type === 'text_delta') {
      const text = typeof delta.text === 'string' ? delta.text : ''
      return bus.publish({
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data: { part: { type: 'text', text }, delta: text }
      })
    }
  }
  if (message.type === 'assistant' || message.type === 'result') {
    return bus.publish({
      type: 'message.updated',
      sessionId: hiveSessionId,
      data: { role: 'assistant' }
    })
  }
  return Effect.void
}

const handleMessage = (
  params: SubscriptionParams,
  bus: EventBus['Type'],
  message: ClaudeSdkMessage
) => {
  if (params.onMessage) {
    return Effect.tryPromise({
      try: () => Promise.resolve(params.onMessage?.(message)),
      catch: (cause) => new ClaudeStreamInterrupted({ cause })
    })
  }
  return publishDefault(bus, params.hiveSessionId, message)
}

export const ClaudeAgentLive = Layer.effect(
  ClaudeAgent,
  Effect.gen(function* () {
    const bus = yield* EventBus

    const sessionEvents = (params: SubscriptionParams) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const iterator = guardRelease(
            yield* connect(params).pipe(
              Effect.retry(params.retrySchedule ?? retrySchedule)
            )
          )
          yield* Effect.addFinalizer(() => closeIterator(iterator))
          return Stream.fromAsyncIterable(
            iterator,
            (cause) => new ClaudeStreamInterrupted({ cause })
          )
        })
      ).pipe(
        Stream.mapEffect((raw) =>
          decodeWithZod(SdkMessageSchema, raw, 'ClaudeSdkMessage').pipe(
            Effect.mapError(mapPayloadError)
          )
        ),
        Stream.mapEffect((message) => handleMessage(params, bus, message))
      )

    return { sessionEvents }
  })
)

export const EventBusLive = Layer.succeed(EventBus, {
  publish: (event) => Effect.sync(() => agentEventBus.publish(event))
})

export const AppLive = Layer.provide(ClaudeAgentLive, EventBusLive)
