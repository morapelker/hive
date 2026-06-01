import { Effect } from 'effect'
import { z } from 'zod'
import { RPC_ERROR_CODES, RpcRouteError, toRpcError } from '@shared/rpc/errors'
import { RpcRequestSchema, type RpcRequest, type RpcResponse } from '@shared/rpc/protocol'
import type { EventBus } from '../events/event-bus'
import {
  makeAccountOpsRpcHandlers,
  makeLiveAccountOpsRpcService,
  type AccountOpsRpcService
} from './domains/account-ops'
import {
  makeAttachmentOpsRpcHandlers,
  makeLiveAttachmentOpsRpcService,
  type AttachmentOpsRpcService
} from './domains/attachment-ops'
import {
  makeAnalyticsOpsRpcHandlers,
  makeLiveAnalyticsOpsRpcService,
  type AnalyticsOpsRpcService
} from './domains/analytics-ops'
import { makeBashRpcHandlers, type BashRpcService } from './domains/bash'
import {
  makeConnectionOpsRpcHandlers,
  makeLiveConnectionOpsRpcService,
  type ConnectionOpsRpcService
} from './domains/connection-ops'
import {
  makeCodexDebugLoggerOpsRpcHandlers,
  makeLiveCodexDebugLoggerOpsRpcService,
  type CodexDebugLoggerOpsRpcService
} from './domains/codex-debug-logger-ops'
import { makeDbRpcHandlers, makeLiveDbRpcService, type DbRpcService } from './domains/db'
import {
  makeLivePetOpsRpcService,
  makePetOpsRpcHandlers,
  type PetOpsRpcService
} from './domains/pet-ops'
import {
  makeLiveLoggingOpsRpcService,
  makeLoggingOpsRpcHandlers,
  type LoggingOpsRpcService
} from './domains/logging-ops'
import {
  makeLiveOpenCodeOpsRpcService,
  makeOpenCodeOpsRpcHandlers,
  type OpenCodeOpsRpcService
} from './domains/opencode-ops'
import {
  makeLivePerfDiagnosticsOpsRpcService,
  makePerfDiagnosticsOpsRpcHandlers,
  type PerfDiagnosticsOpsRpcService
} from './domains/perf-diagnostics-ops'
import {
  makeFileTreeOpsRpcHandlers,
  makeLiveFileTreeOpsRpcService,
  type FileTreeOpsRpcService
} from './domains/file-tree-ops'
import {
  makeFileOpsRpcHandlers,
  makeLiveFileOpsRpcService,
  type FileOpsRpcService
} from './domains/file-ops'
import {
  makeGitOpsRpcHandlers,
  makeLiveGitOpsRpcService,
  type GitOpsRpcService
} from './domains/git-ops'
import {
  makeLiveProjectOpsRpcService,
  makeProjectOpsRpcHandlers,
  type ProjectOpsRpcService
} from './domains/project-ops'
import {
  makeKanbanRpcHandlers,
  makeLiveKanbanRpcService,
  type KanbanRpcService
} from './domains/kanban'
import {
  makeLiveSettingsOpsRpcService,
  makeSettingsOpsRpcHandlers,
  type SettingsOpsRpcService
} from './domains/settings-ops'
import {
  makeLiveScriptOpsRpcService,
  makeScriptOpsRpcHandlers,
  type ScriptOpsRpcService
} from './domains/script-ops'
import {
  makeLiveSystemOpsRpcService,
  makeSystemOpsRpcHandlers,
  type SystemOpsRpcService
} from './domains/system-ops'
import {
  makeLiveTicketImportRpcService,
  makeTicketImportRpcHandlers,
  type TicketImportRpcService
} from './domains/ticket-import'
import {
  makeLiveTerminalOpsRpcService,
  makeTerminalOpsRpcHandlers,
  type TerminalOpsRpcService
} from './domains/terminal-ops'
import {
  makeLiveTelegramOpsRpcService,
  makeTelegramOpsRpcHandlers,
  type TelegramOpsRpcService
} from './domains/telegram-ops'
import {
  makeLiveUpdaterOpsRpcService,
  makeUpdaterOpsRpcHandlers,
  type UpdaterOpsRpcService
} from './domains/updater-ops'
import {
  makeLiveUsageOpsRpcService,
  makeUsageOpsRpcHandlers,
  type UsageOpsRpcService
} from './domains/usage-ops'
import {
  makeLiveWorktreeOpsRpcService,
  makeWorktreeOpsRpcHandlers,
  type WorktreeOpsRpcService
} from './domains/worktree-ops'

export interface RpcContext {
  readonly eventBus: EventBus
  readonly accountOps?: AccountOpsRpcService
  readonly analyticsOps?: AnalyticsOpsRpcService
  readonly attachmentOps?: AttachmentOpsRpcService
  readonly bash?: BashRpcService
  readonly codexDebugLoggerOps?: CodexDebugLoggerOpsRpcService
  readonly connectionOps?: ConnectionOpsRpcService
  readonly db?: DbRpcService
  readonly fileOps?: FileOpsRpcService
  readonly fileTreeOps?: FileTreeOpsRpcService
  readonly gitOps?: GitOpsRpcService
  readonly kanban?: KanbanRpcService
  readonly loggingOps?: LoggingOpsRpcService
  readonly opencodeOps?: OpenCodeOpsRpcService
  readonly perfDiagnosticsOps?: PerfDiagnosticsOpsRpcService
  readonly petOps?: PetOpsRpcService
  readonly projectOps?: ProjectOpsRpcService
  readonly scriptOps?: ScriptOpsRpcService
  readonly settingsOps?: SettingsOpsRpcService
  readonly systemOps?: SystemOpsRpcService
  readonly terminalOps?: TerminalOpsRpcService
  readonly ticketImport?: TicketImportRpcService
  readonly telegramOps?: TelegramOpsRpcService
  readonly updaterOps?: UpdaterOpsRpcService
  readonly usageOps?: UsageOpsRpcService
  readonly worktreeOps?: WorktreeOpsRpcService
}

export type RpcHandler = (
  params: unknown,
  context: RpcContext
) => Effect.Effect<unknown, unknown, never>

export interface RpcRouter {
  readonly handle: (request: unknown) => Effect.Effect<RpcResponse, never, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])

const makeSystemPingHandler = (): RpcHandler => (params) =>
  Effect.try({
    try: () => {
      emptyParamsSchema.parse(params)
      return { ok: true }
    },
    catch: (cause) => cause
  })

const makeDefaultRpcHandlers = (context: RpcContext): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    ['system.ping', makeSystemPingHandler()],
    ...makeAccountOpsRpcHandlers(context.accountOps ?? makeLiveAccountOpsRpcService()),
    ...makeAnalyticsOpsRpcHandlers(context.analyticsOps ?? makeLiveAnalyticsOpsRpcService()),
    ...makeAttachmentOpsRpcHandlers(context.attachmentOps ?? makeLiveAttachmentOpsRpcService()),
    ...makeBashRpcHandlers(context.bash, context.eventBus),
    ...makeCodexDebugLoggerOpsRpcHandlers(
      context.codexDebugLoggerOps ?? makeLiveCodexDebugLoggerOpsRpcService()
    ),
    ...makeConnectionOpsRpcHandlers(context.connectionOps ?? makeLiveConnectionOpsRpcService()),
    ...makeDbRpcHandlers(context.db ?? makeLiveDbRpcService()),
    ...makeFileOpsRpcHandlers(context.fileOps ?? makeLiveFileOpsRpcService()),
    ...makeFileTreeOpsRpcHandlers(context.fileTreeOps ?? makeLiveFileTreeOpsRpcService()),
    ...makeGitOpsRpcHandlers(context.gitOps ?? makeLiveGitOpsRpcService()),
    ...makeKanbanRpcHandlers(context.kanban ?? makeLiveKanbanRpcService()),
    ...makeLoggingOpsRpcHandlers(context.loggingOps ?? makeLiveLoggingOpsRpcService()),
    ...makeOpenCodeOpsRpcHandlers(context.opencodeOps ?? makeLiveOpenCodeOpsRpcService()),
    ...makePerfDiagnosticsOpsRpcHandlers(
      context.perfDiagnosticsOps ?? makeLivePerfDiagnosticsOpsRpcService()
    ),
    ...makePetOpsRpcHandlers(context.petOps ?? makeLivePetOpsRpcService()),
    ...makeProjectOpsRpcHandlers(context.projectOps ?? makeLiveProjectOpsRpcService()),
    ...makeScriptOpsRpcHandlers(context.scriptOps ?? makeLiveScriptOpsRpcService(context.eventBus)),
    ...makeSettingsOpsRpcHandlers(context.settingsOps ?? makeLiveSettingsOpsRpcService()),
    ...makeSystemOpsRpcHandlers(context.systemOps ?? makeLiveSystemOpsRpcService()),
    ...makeTerminalOpsRpcHandlers(
      context.terminalOps ?? makeLiveTerminalOpsRpcService(context.eventBus)
    ),
    ...makeTicketImportRpcHandlers(context.ticketImport ?? makeLiveTicketImportRpcService()),
    ...makeTelegramOpsRpcHandlers(
      context.telegramOps ?? makeLiveTelegramOpsRpcService(context.eventBus)
    ),
    ...makeUpdaterOpsRpcHandlers(context.updaterOps ?? makeLiveUpdaterOpsRpcService()),
    ...makeUsageOpsRpcHandlers(context.usageOps ?? makeLiveUsageOpsRpcService()),
    ...makeWorktreeOpsRpcHandlers(context.worktreeOps ?? makeLiveWorktreeOpsRpcService())
  ])

export const makeRpcRouter = (
  context: RpcContext,
  handlers: ReadonlyMap<string, RpcHandler> = makeDefaultRpcHandlers(context)
): RpcRouter => ({
  handle: (request) =>
    Effect.gen(function* () {
      const parsed = RpcRequestSchema.safeParse(request)
      if (!parsed.success) {
        const id =
          typeof request === 'object' &&
          request !== null &&
          'id' in request &&
          typeof request.id === 'string'
            ? request.id
            : ''

        return {
          id,
          ok: false,
          error: {
            code: RPC_ERROR_CODES.invalidRequest,
            message: 'Invalid RPC request',
            details: z.treeifyError(parsed.error)
          }
        } satisfies RpcResponse
      }

      const rpcRequest: RpcRequest = parsed.data
      const handler = handlers.get(rpcRequest.method)
      if (!handler) {
        return {
          id: rpcRequest.id,
          ok: false,
          error: {
            code: RPC_ERROR_CODES.methodNotFound,
            message: `Unknown RPC method: ${rpcRequest.method}`
          }
        } satisfies RpcResponse
      }

      const result = yield* handler(rpcRequest.params, context).pipe(
        Effect.map((value) => ({ id: rpcRequest.id, ok: true as const, value })),
        Effect.catchAll((cause) =>
          Effect.succeed({
            id: rpcRequest.id,
            ok: false as const,
            error: toRpcError(
              cause instanceof RpcRouteError || cause instanceof Error ? cause : cause
            )
          })
        )
      )
      return result
    })
})
