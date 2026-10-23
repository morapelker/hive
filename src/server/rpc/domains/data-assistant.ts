// `dataAssistant.*`: the database assistant of data projects. `start` validates the request,
// registers the run and returns `{ requestId }` at once; the run is detached and streams its
// progress (status, text, tool calls, the proposed query or a prose answer, done/error) as
// events on DATA_ASSISTANT_CHANNEL. `cancel` stops it. The proposed query is only ever placed
// into the editor by the renderer — nothing here executes it.
//
// Desktop-only: schemas (and sample rows when allowed) must not reach paired phones or peer
// Macs. The remote-access policy has no entry for this domain, and the handlers refuse device
// principals themselves as a second line.

import { Effect } from 'effect'
import { z } from 'zod'
import { RpcRouteError } from '../../../shared/rpc/errors'
import {
  DATA_ASSISTANT_CHANNEL,
  DATA_ERROR_CODES,
  type DataAssistantEventPayload,
  type DataAssistantStartRequest
} from '../../../shared/data-projects/types'
import type { DataAssistantService } from '../../../main/services/data-projects/assistant/service'
import type { EventBus } from '../../events/event-bus'
import { getRpcRequestContext } from '../request-context'
import type { RpcHandler } from '../router'

type Rpc<A> = Effect.Effect<A, unknown, never>

export interface DataAssistantRpcService {
  /** `clientId`: the asking renderer, so its runs stop when its socket closes. */
  readonly start: (
    request: DataAssistantStartRequest,
    clientId?: string | null
  ) => Rpc<{ requestId: string }>
  readonly cancel: (requestId: string) => Rpc<{ cancelled: boolean }>
  /** Socket-close hook (server.ts): stops that renderer's runs. No-op until the service loads. */
  readonly releaseClient?: (clientId: string) => void
  /** Server shutdown: stops every run (kills spawned CLIs). No-op until the service loads. */
  readonly shutdown?: () => void
}

const generationSchema = z
  .object({
    provider: z.enum(['claude-code', 'codex', 'opencode']),
    model: z.string().max(300).optional(),
    effort: z.string().max(40).optional()
  })
  .strict()

const startParamsSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    dataProjectId: z.string().min(1).max(128),
    question: z
      .string()
      .max(20_000)
      .refine((value) => value.trim().length > 0, {
        message: 'The question is empty'
      }),
    database: z.string().max(512).optional(),
    schema: z.string().max(512).optional(),
    editorText: z.string().max(500_000).optional(),
    history: z
      .array(
        z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(100_000) }).strict()
      )
      .max(200),
    generation: generationSchema
  })
  .strict() satisfies z.ZodType<DataAssistantStartRequest>

const cancelParamsSchema = z.object({ requestId: z.string().min(1).max(128) }).strict()

/** Data projects are desktop-only: a device principal (phone, peer Mac) is refused. */
export const requireDesktopPrincipal = (): Effect.Effect<void, RpcRouteError> =>
  Effect.suspend(() =>
    getRpcRequestContext()?.principal?.kind === 'device'
      ? Effect.fail(
          new RpcRouteError(
            DATA_ERROR_CODES.forbidden,
            'Data projects are available on the desktop app only.'
          )
        )
      : Effect.void
  )

export const makeLiveDataAssistantRpcService = (deps: {
  eventBus: EventBus
}): DataAssistantRpcService => {
  const publish = (payload: DataAssistantEventPayload): void => {
    void Effect.runPromise(
      deps.eventBus.publish({ channel: DATA_ASSISTANT_CHANNEL, payload })
    ).catch(() => undefined)
  }

  // Loaded on first use; the lifecycle hooks never load it just to find nothing running.
  let loaded: DataAssistantService | null = null
  const call = <A>(invoke: (service: DataAssistantService) => A | Promise<A>): Rpc<A> =>
    Effect.tryPromise({
      try: async () => {
        const { getDataAssistantService } =
          await import('../../../main/services/data-projects/assistant/service')
        loaded = getDataAssistantService(publish)
        return invoke(loaded)
      },
      catch: (cause) => cause
    })

  return {
    start: (request, clientId) => call((service) => service.start(request, clientId ?? null)),
    cancel: (requestId) => call((service) => service.cancel(requestId)),
    releaseClient: (clientId) => loaded?.releaseClient(clientId),
    shutdown: () => loaded?.shutdown()
  }
}

/** Guard the principal, validate the params against `schema`, then hand them to the service. */
const handle =
  <P, A>(schema: z.ZodType<P>, run: (params: P) => Rpc<A>): RpcHandler =>
  (params) =>
    Effect.gen(function* () {
      yield* requireDesktopPrincipal()
      const parsed = yield* Effect.try({
        try: () => schema.parse(params),
        catch: (cause) => cause
      })
      return yield* run(parsed)
    })

export const makeDataAssistantRpcHandlers = (
  service: DataAssistantRpcService
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'dataAssistant.start',
      handle(startParamsSchema, (params) =>
        service.start(params, getRpcRequestContext()?.clientId ?? null)
      )
    ],
    [
      'dataAssistant.cancel',
      handle(cancelParamsSchema, ({ requestId }) => service.cancel(requestId))
    ]
  ])
