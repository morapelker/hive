import { Effect } from 'effect'
import { z } from 'zod'
import {
  CLI_TOOL_IDS,
  cliToolOutputChannel,
  type CliToolActionResult,
  type CliToolId,
  type CliToolOutputEvent,
  type CliToolsListing
} from '../../../shared/types/cli-tools'
import type { EventBus } from '../../events/event-bus'
import type { RpcHandler } from '../router'

export interface CliToolsOpsRpcService {
  readonly list: (projectPath: string) => Effect.Effect<CliToolsListing, unknown, never>
  readonly install: (
    toolId: CliToolId,
    projectPath: string
  ) => Effect.Effect<CliToolActionResult, unknown, never>
  readonly installSkill: (
    toolId: CliToolId,
    projectPath: string
  ) => Effect.Effect<CliToolActionResult, unknown, never>
}

const toolIdSchema = z.enum(CLI_TOOL_IDS as [CliToolId, ...CliToolId[]])
const listParamsSchema = z.object({ path: z.string().min(1) }).strict()
const toolParamsSchema = z.object({ toolId: toolIdSchema, path: z.string().min(1) }).strict()

export const makeLiveCliToolsOpsRpcService = (eventBus?: EventBus): CliToolsOpsRpcService => {
  const publisher =
    (toolId: CliToolId) =>
    (event: CliToolOutputEvent): void => {
      if (!eventBus) return
      void Effect.runPromise(
        eventBus.publish({ channel: cliToolOutputChannel(toolId), payload: event })
      ).catch(() => undefined)
    }

  return {
    list: (projectPath) =>
      Effect.tryPromise({
        try: async () => {
          const { listCliTools } = await import('../../../main/services/cli-tools/tool-installers')
          return listCliTools(projectPath)
        },
        catch: (cause) => cause
      }),
    install: (toolId, projectPath) =>
      Effect.tryPromise({
        try: async () => {
          const { installCliTool } =
            await import('../../../main/services/cli-tools/tool-installers')
          return installCliTool(toolId, projectPath, publisher(toolId))
        },
        catch: (cause) => cause
      }),
    installSkill: (toolId, projectPath) =>
      Effect.tryPromise({
        try: async () => {
          const { installCliSkill } =
            await import('../../../main/services/cli-tools/tool-installers')
          return installCliSkill(toolId, projectPath, publisher(toolId))
        },
        catch: (cause) => cause
      })
  }
}

export const makeCliToolsOpsRpcHandlers = (
  service: CliToolsOpsRpcService = makeLiveCliToolsOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'cliToolsOps.list',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => listParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.list(path)
        })
    ],
    [
      'cliToolsOps.install',
      (params) =>
        Effect.gen(function* () {
          const { toolId, path } = yield* Effect.try({
            try: () => toolParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.install(toolId, path)
        })
    ],
    [
      'cliToolsOps.installSkill',
      (params) =>
        Effect.gen(function* () {
          const { toolId, path } = yield* Effect.try({
            try: () => toolParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.installSkill(toolId, path)
        })
    ]
  ])
