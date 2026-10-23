// `dataProjects.console.*`: the console log of data projects (TablePlus' Console; contract:
// src/shared/data-projects/console-types.ts, server side: main/services/data-projects/
// console-log.ts, renderer client: src/renderer/src/api/data-console-api.ts).
//
//   dataProjects.console.list   { id, since? }  → the project's entries, oldest first
//   dataProjects.console.clear  { id }          → empties it (renderers get a 'cleared' event)
//   DATA_CONSOLE_CHANNEL ('dataProjects:console') carries new entries live.
//
// Desktop-only, three times over: the methods sit under `dataProjects.` and the channel under
// `dataProjects:`, which the remote-access policy never lists (remote-policy.test.ts fails if a
// `dataProjects.*` method is ever added; device sockets only get allowlisted channels), and the
// handlers refuse a device principal themselves. The log holds statement texts (masked) of
// databases phones must never see.
//
// The log module is imported on first use, like the engine, so server start stays light; the
// event bus publisher is handed to it then (a renderer lists before it follows the channel, and
// entries recorded earlier are in that list).

import { Effect } from 'effect'
import { z } from 'zod'
import type { DataConsoleListResponse } from '../../../shared/data-projects/console-types'
import { DATA_ERROR_CODES } from '../../../shared/data-projects/types'
import { RPC_ERROR_CODES, RpcRouteError } from '../../../shared/rpc/errors'
import type { EventBus } from '../../events/event-bus'
import { getRpcRequestContext } from '../request-context'
import type { RpcHandler } from '../router'

export interface DataConsoleRpcService {
  readonly list: (id: string, since?: number) => Promise<DataConsoleListResponse>
  readonly clear: (id: string) => Promise<{ success: boolean }>
}

const idSchema = z.string().min(1).max(128)

const params = {
  list: z
    .object({
      id: idSchema,
      since: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
    })
    .strict(),
  clear: z.object({ id: idSchema }).strict()
}

type ConsoleLogModule = typeof import('../../../main/services/data-projects/console-log')

export const makeLiveDataConsoleRpcService = (
  deps: { eventBus?: EventBus; load?: () => Promise<ConsoleLogModule> } = {}
): DataConsoleRpcService => {
  let loading: Promise<ConsoleLogModule> | null = null
  const load = (): Promise<ConsoleLogModule> => {
    loading ??= (deps.load ?? (() => import('../../../main/services/data-projects/console-log')))()
      .then((module) => {
        const bus = deps.eventBus
        if (bus) {
          module.setDataConsolePublisher((channel, payload) => {
            try {
              void Effect.runPromise(bus.publish({ channel, payload })).catch(() => undefined)
            } catch {
              // A failing subscriber must never break a statement being logged.
            }
          })
        }
        return module
      })
      .catch((error: unknown) => {
        loading = null
        throw error
      })
    return loading
  }
  return {
    list: async (id, since) => (await load()).getDataConsoleLog().list(id, since),
    clear: async (id) => {
      ;(await load()).getDataConsoleLog().clear(id)
      return { success: true }
    }
  }
}

/** The console is desktop-only: a device principal (phone, peer Mac) is refused. */
const assertDesktopPrincipal = (): void => {
  if (getRpcRequestContext()?.principal?.kind === 'device') {
    throw new RpcRouteError(
      DATA_ERROR_CODES.forbidden,
      'Data projects are not available from a remote device'
    )
  }
}

const describeZodError = (error: z.ZodError): string =>
  `Invalid input: ${error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')}`

const route =
  <T>(schema: z.ZodType<T>, run: (input: T) => Promise<unknown>): RpcHandler =>
  (raw) =>
    Effect.tryPromise({
      try: async () => {
        assertDesktopPrincipal()
        const parsed = schema.safeParse(raw)
        if (!parsed.success) {
          throw new RpcRouteError(DATA_ERROR_CODES.invalidInput, describeZodError(parsed.error))
        }
        return await run(parsed.data)
      },
      catch: (cause) =>
        cause instanceof RpcRouteError
          ? cause
          : new RpcRouteError(
              RPC_ERROR_CODES.internalError,
              cause instanceof Error ? cause.message : 'The console log failed'
            )
    })

export const makeDataConsoleRpcHandlers = (
  service: DataConsoleRpcService = makeLiveDataConsoleRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    ['dataProjects.console.list', route(params.list, ({ id, since }) => service.list(id, since))],
    ['dataProjects.console.clear', route(params.clear, ({ id }) => service.clear(id))]
  ])
