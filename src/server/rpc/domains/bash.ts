import { Effect, Exit, Layer, ManagedRuntime } from 'effect'
import { z } from 'zod'
import { bashService } from '../../../main/effect/bash/facade'
import { LowLevelSpawnLive } from '../../../main/effect/spawn/layers'
import { LoggerLive } from '../../../main/effect/_shared/logger'
import { Bash, EventSink } from '../../../main/effect/bash/service'
import { BashLive, SpawnerLive } from '../../../main/effect/bash/layers'
import type { BashRunSnapshot } from '../../../main/effect/bash/types'
import type { EventBus } from '../../events/event-bus'
import { BASH_STREAM_CHANNEL } from '../../../shared/bash-events'
import type { RpcHandler } from '../router'

export interface BashRunResult {
  readonly runId: string
}

export interface BashRpcService {
  readonly run: (
    sessionId: string,
    command: string,
    cwd: string
  ) => Effect.Effect<BashRunResult, unknown, never>
  readonly abort: (sessionId: string) => Effect.Effect<boolean, unknown, never>
  readonly getRun: (sessionId: string) => Effect.Effect<BashRunSnapshot | null, unknown, never>
}

const runParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1)
  })
  .strict()
const abortParamsSchema = z
  .object({
    sessionId: z.string().min(1)
  })
  .strict()
const getRunParamsSchema = z
  .object({
    sessionId: z.string().min(1)
  })
  .strict()

const runtimeByEventBus = new WeakMap<EventBus, ManagedRuntime.ManagedRuntime<Bash, never>>()

const makeEventBusBashRuntime = (
  eventBus: EventBus
): ManagedRuntime.ManagedRuntime<Bash, never> => {
  const eventSinkLive = Layer.succeed(EventSink, {
    send: (payload) => eventBus.publish({ channel: BASH_STREAM_CHANNEL, payload })
  })
  const appLive = Layer.provide(BashLive, Layer.mergeAll(eventSinkLive, SpawnerLive))
  return ManagedRuntime.make(Layer.merge(Layer.provide(appLive, LowLevelSpawnLive), LoggerLive))
}

const getEventBusRuntime = (eventBus: EventBus): ManagedRuntime.ManagedRuntime<Bash, never> => {
  const existing = runtimeByEventBus.get(eventBus)
  if (existing) return existing
  const runtime = makeEventBusBashRuntime(eventBus)
  runtimeByEventBus.set(eventBus, runtime)
  return runtime
}

const runWithEventBus = async (
  eventBus: EventBus,
  sessionId: string,
  command: string,
  cwd: string
): Promise<BashRunResult> => {
  const exit = await getEventBusRuntime(eventBus).runPromiseExit(
    Effect.flatMap(Bash, (bash) => bash.run(sessionId, command, cwd))
  )
  return Exit.match(exit, {
    onSuccess: (value) => value,
    onFailure: (cause) => {
      throw new Error(String(cause))
    }
  })
}

const abortWithEventBus = (eventBus: EventBus, sessionId: string): Promise<boolean> =>
  getEventBusRuntime(eventBus).runPromise(Effect.flatMap(Bash, (bash) => bash.abort(sessionId)))

const getRunWithEventBus = (
  eventBus: EventBus,
  sessionId: string
): Promise<BashRunSnapshot | null> =>
  getEventBusRuntime(eventBus).runPromise(Effect.flatMap(Bash, (bash) => bash.getRun(sessionId)))

export const makeLiveBashRpcService = (eventBus?: EventBus): BashRpcService => ({
  run: (sessionId, command, cwd) =>
    Effect.tryPromise({
      try: async () => {
        if (eventBus) {
          return runWithEventBus(eventBus, sessionId, command, cwd)
        }
        const envelope = await bashService.run(sessionId, command, cwd)
        if (envelope.success) {
          return { runId: envelope.runId }
        }
        throw new Error(envelope.error)
      },
      catch: (cause) => cause
    }),
  abort: (sessionId) =>
    Effect.tryPromise({
      try: () => (eventBus ? abortWithEventBus(eventBus, sessionId) : bashService.abort(sessionId)),
      catch: (cause) => cause
    }),
  getRun: (sessionId) =>
    Effect.tryPromise({
      try: () =>
        eventBus ? getRunWithEventBus(eventBus, sessionId) : bashService.getRun(sessionId),
      catch: (cause) => cause
    })
})

export const makeBashRpcHandlers = (
  service?: BashRpcService,
  eventBus?: EventBus
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'bash.run',
      (params, context) =>
        Effect.gen(function* () {
          const liveService = service ?? makeLiveBashRpcService(eventBus ?? context.eventBus)
          const { sessionId, command, cwd } = yield* Effect.try({
            try: () => runParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* liveService.run(sessionId, command, cwd)
        })
    ],
    [
      'bash.abort',
      (params, context) =>
        Effect.gen(function* () {
          const liveService = service ?? makeLiveBashRpcService(eventBus ?? context.eventBus)
          const { sessionId } = yield* Effect.try({
            try: () => abortParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* liveService.abort(sessionId)
        })
    ],
    [
      'bash.getRun',
      (params, context) =>
        Effect.gen(function* () {
          const liveService = service ?? makeLiveBashRpcService(eventBus ?? context.eventBus)
          const { sessionId } = yield* Effect.try({
            try: () => getRunParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* liveService.getRun(sessionId)
        })
    ]
  ])
