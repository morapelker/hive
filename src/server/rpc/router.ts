import { Effect, Scheduler } from 'effect'
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
  makeBackupOpsRpcHandlers,
  makeLiveBackupOpsRpcService,
  type BackupOpsRpcService
} from './domains/backup-ops'
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
import {
  makeDataAssistantRpcHandlers,
  makeLiveDataAssistantRpcService,
  type DataAssistantRpcService
} from './domains/data-assistant'
import {
  makeDataConsoleRpcHandlers,
  makeLiveDataConsoleRpcService,
  type DataConsoleRpcService
} from './domains/data-console'
import {
  makeDataProjectsRpcHandlers,
  makeLiveDataProjectsRpcService,
  type DataProjectsRpcService
} from './domains/data-projects'
import { makeDbRpcHandlers, makeLiveDbRpcService, type DbRpcService } from './domains/db'
import {
  makeDiscordOpsRpcHandlers,
  makeLiveDiscordOpsRpcService,
  type DiscordOpsRpcService
} from './domains/discord-ops'
import {
  makeDocumentFlowRpcHandlers,
  makeLiveDocumentFlowRpcService,
  type DocumentFlowRpcService
} from './domains/document-flow'
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
  makeLiveSessionProfilerOpsRpcService,
  makeSessionProfilerOpsRpcHandlers,
  type SessionProfilerOpsRpcService
} from './domains/session-profiler-ops'
import {
  makeFavoriteTicketsRpcHandlers,
  makeLiveFavoriteTicketsRpcService,
  type FavoriteTicketsRpcService
} from './domains/favorite-tickets'
import {
  makeLiveTicketLabelsRpcService,
  makeTicketLabelsRpcHandlers,
  type TicketLabelsRpcService
} from './domains/ticket-labels'
import {
  makeFileTreeOpsRpcHandlers,
  makeLiveFileTreeOpsRpcService,
  type FileTreeOpsRpcService
} from './domains/file-tree-ops'
import {
  makeCliToolsOpsRpcHandlers,
  makeLiveCliToolsOpsRpcService,
  type CliToolsOpsRpcService
} from './domains/cli-tools-ops'
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
  makeGithubOpsRpcHandlers,
  makeLiveGithubOpsRpcService,
  type GithubOpsRpcService
} from './domains/github-ops'
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
  makeLiveStorageOpsRpcService,
  makeStorageOpsRpcHandlers,
  type StorageOpsRpcService
} from './domains/storage-ops'
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
  makeLiveTeleportOpsRpcService,
  makeTeleportOpsRpcHandlers,
  type TeleportOpsRpcService
} from './domains/teleport-ops'
import {
  makeLiveRemoteLaunchOpsRpcService,
  makeRemoteLaunchOpsRpcHandlers,
  type RemoteLaunchOpsRpcService
} from './domains/remote-launch-ops'
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
  makeLiveTicketAutocompleteRpcService,
  makeTicketAutocompleteRpcHandlers,
  type TicketAutocompleteRpcService
} from './domains/ticket-autocomplete'
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
  readonly backupOps?: BackupOpsRpcService
  readonly bash?: BashRpcService
  readonly codexDebugLoggerOps?: CodexDebugLoggerOpsRpcService
  readonly connectionOps?: ConnectionOpsRpcService
  /** Desktop-only: never in the remote-access policy (see remote-policy.test.ts). */
  readonly dataAssistant?: DataAssistantRpcService
  /** `dataProjects.console.*` — desktop-only like every `dataProjects.*` method. */
  readonly dataConsole?: DataConsoleRpcService
  /** Desktop-only: never in the remote-access policy (see remote-policy.test.ts). */
  readonly dataProjects?: DataProjectsRpcService
  readonly cliToolsOps?: CliToolsOpsRpcService
  readonly db?: DbRpcService
  readonly discordOps?: DiscordOpsRpcService
  readonly documentFlow?: DocumentFlowRpcService
  readonly favoriteTickets?: FavoriteTicketsRpcService
  readonly fileOps?: FileOpsRpcService
  readonly fileTreeOps?: FileTreeOpsRpcService
  readonly gitOps?: GitOpsRpcService
  readonly githubOps?: GithubOpsRpcService
  readonly kanban?: KanbanRpcService
  readonly loggingOps?: LoggingOpsRpcService
  readonly opencodeOps?: OpenCodeOpsRpcService
  readonly perfDiagnosticsOps?: PerfDiagnosticsOpsRpcService
  readonly sessionProfilerOps?: SessionProfilerOpsRpcService
  readonly petOps?: PetOpsRpcService
  readonly projectOps?: ProjectOpsRpcService
  readonly remoteLaunchOps?: RemoteLaunchOpsRpcService
  readonly scriptOps?: ScriptOpsRpcService
  readonly settingsOps?: SettingsOpsRpcService
  readonly storageOps?: StorageOpsRpcService
  readonly systemOps?: SystemOpsRpcService
  readonly terminalOps?: TerminalOpsRpcService
  readonly ticketAutocomplete?: TicketAutocompleteRpcService
  readonly ticketImport?: TicketImportRpcService
  readonly ticketLabels?: TicketLabelsRpcService
  readonly telegramOps?: TelegramOpsRpcService
  readonly teleportOps?: TeleportOpsRpcService
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
    ...makeBackupOpsRpcHandlers(context.backupOps ?? makeLiveBackupOpsRpcService()),
    ...makeBashRpcHandlers(context.bash, context.eventBus),
    ...makeCodexDebugLoggerOpsRpcHandlers(
      context.codexDebugLoggerOps ?? makeLiveCodexDebugLoggerOpsRpcService()
    ),
    ...makeConnectionOpsRpcHandlers(context.connectionOps ?? makeLiveConnectionOpsRpcService()),
    ...makeDataAssistantRpcHandlers(
      context.dataAssistant ?? makeLiveDataAssistantRpcService({ eventBus: context.eventBus })
    ),
    ...makeDataProjectsRpcHandlers(
      context.dataProjects ?? makeLiveDataProjectsRpcService({ eventBus: context.eventBus })
    ),
    ...makeDataConsoleRpcHandlers(
      context.dataConsole ?? makeLiveDataConsoleRpcService({ eventBus: context.eventBus })
    ),
    ...makeDbRpcHandlers(context.db ?? makeLiveDbRpcService()),
    ...makeCliToolsOpsRpcHandlers(
      context.cliToolsOps ?? makeLiveCliToolsOpsRpcService(context.eventBus)
    ),
    ...makeDiscordOpsRpcHandlers(
      context.discordOps ?? makeLiveDiscordOpsRpcService(context.eventBus)
    ),
    ...makeDocumentFlowRpcHandlers(
      context.documentFlow ?? makeLiveDocumentFlowRpcService(context.eventBus)
    ),
    ...makeFavoriteTicketsRpcHandlers(
      context.favoriteTickets ?? makeLiveFavoriteTicketsRpcService()
    ),
    ...makeFileOpsRpcHandlers(context.fileOps ?? makeLiveFileOpsRpcService()),
    ...makeFileTreeOpsRpcHandlers(context.fileTreeOps ?? makeLiveFileTreeOpsRpcService()),
    ...makeGitOpsRpcHandlers(
      context.gitOps ?? makeLiveGitOpsRpcService({ eventBus: context.eventBus })
    ),
    ...makeGithubOpsRpcHandlers(
      context.githubOps ?? makeLiveGithubOpsRpcService({ eventBus: context.eventBus })
    ),
    ...makeKanbanRpcHandlers(context.kanban ?? makeLiveKanbanRpcService()),
    ...makeLoggingOpsRpcHandlers(context.loggingOps ?? makeLiveLoggingOpsRpcService()),
    ...makeOpenCodeOpsRpcHandlers(context.opencodeOps ?? makeLiveOpenCodeOpsRpcService()),
    ...makePerfDiagnosticsOpsRpcHandlers(
      context.perfDiagnosticsOps ?? makeLivePerfDiagnosticsOpsRpcService()
    ),
    ...makeSessionProfilerOpsRpcHandlers(
      context.sessionProfilerOps ?? makeLiveSessionProfilerOpsRpcService()
    ),
    ...makePetOpsRpcHandlers(context.petOps ?? makeLivePetOpsRpcService()),
    ...makeProjectOpsRpcHandlers(context.projectOps ?? makeLiveProjectOpsRpcService()),
    ...makeRemoteLaunchOpsRpcHandlers(
      context.remoteLaunchOps ?? makeLiveRemoteLaunchOpsRpcService(context.eventBus)
    ),
    ...makeScriptOpsRpcHandlers(context.scriptOps ?? makeLiveScriptOpsRpcService(context.eventBus)),
    ...makeSettingsOpsRpcHandlers(context.settingsOps ?? makeLiveSettingsOpsRpcService()),
    ...makeStorageOpsRpcHandlers(context.storageOps ?? makeLiveStorageOpsRpcService()),
    ...makeSystemOpsRpcHandlers(context.systemOps ?? makeLiveSystemOpsRpcService()),
    ...makeTerminalOpsRpcHandlers(
      context.terminalOps ?? makeLiveTerminalOpsRpcService(context.eventBus)
    ),
    ...makeTicketAutocompleteRpcHandlers(
      context.ticketAutocomplete ?? makeLiveTicketAutocompleteRpcService()
    ),
    ...makeTicketImportRpcHandlers(context.ticketImport ?? makeLiveTicketImportRpcService()),
    ...makeTicketLabelsRpcHandlers(context.ticketLabels ?? makeLiveTicketLabelsRpcService()),
    ...makeTelegramOpsRpcHandlers(
      context.telegramOps ?? makeLiveTelegramOpsRpcService(context.eventBus)
    ),
    ...makeTeleportOpsRpcHandlers(context.teleportOps ?? makeLiveTeleportOpsRpcService()),
    ...makeUpdaterOpsRpcHandlers(context.updaterOps ?? makeLiveUpdaterOpsRpcService()),
    ...makeUsageOpsRpcHandlers(context.usageOps ?? makeLiveUsageOpsRpcService()),
    ...makeWorktreeOpsRpcHandlers(context.worktreeOps ?? makeLiveWorktreeOpsRpcService())
  ])

import { runWithRpcRequestContext, type RpcRequestContext } from './request-context'

/**
 * Runs `router.handle` inside the request-scoped AsyncLocalStorage context (see
 * request-context.ts) so a domain can read who asked. A per-call Effect scheduler re-enters the
 * context on every fiber resumption, because the default global scheduler batches tasks from
 * unrelated requests into one timer and would otherwise leak or lose the store between
 * concurrent connections.
 */
export const handleRpcWithRequestContext = (
  router: RpcRouter,
  request: unknown,
  context: RpcRequestContext
): Promise<RpcResponse> =>
  runWithRpcRequestContext(context, () => {
    const scheduler = Scheduler.make((task, _priority) => {
      setImmediate(() => runWithRpcRequestContext(context, task))
    })
    return Effect.runPromise(router.handle(request).pipe(Effect.withScheduler(scheduler)))
  })

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
