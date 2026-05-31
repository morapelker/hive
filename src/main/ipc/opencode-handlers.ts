import { BrowserWindow } from 'electron'
import { Effect } from 'effect'
import { z } from 'zod'
import { openCodeService } from '../services/opencode-service'
import { createLogger } from '../services/logger'
import { telemetryService } from '../services/telemetry-service'
import type { DatabaseService } from '../db/database'
import type { AgentSdkManager } from '../services/agent-sdk-manager'
import type { PromptOptions } from '../services/agent-sdk-types'
import {
  isTerminalBacked,
  toModelCatalogSdk,
  type AgentSdk,
  AGENT_SDK_VALUES
} from '@shared/types/agent-sdk'
import { ClaudeCodeImplementer } from '../services/claude-code-implementer'
import { CodexImplementer } from '../services/codex-implementer'
import { claudeCliTelegramBridge } from '../services/claude-cli-telegram-bridge'
import { toError } from '../services/error-utils'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'OpenCodeHandlers' })
const opencodeEffect = <A>(operation: () => Promise<A>): Effect.Effect<A> =>
  Effect.promise(operation)
const agentSdkSchema = z.enum(AGENT_SDK_VALUES)
const modelSchema = z
  .object({
    providerID: z.string(),
    modelID: z.string(),
    variant: z.string().optional(),
    agentSdk: agentSdkSchema.optional()
  })
  .passthrough()
const promptOptionsSchema = z
  .object({
    codexFastMode: z.boolean().optional()
  })
  .passthrough()
const promptArgsSchema = z.union([
  z.object({}).passthrough(),
  z.tuple([z.unknown(), z.unknown(), z.unknown()]).rest(z.unknown())
])

type PromptMessage =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'file'; mime: string; url: string; filename?: string }
    >

// Track worktree paths that have already received context injection for their
// current session. We key by worktreePath (not opencodeSessionId) because
// Claude Code sessions start with a `pending::` ID that materializes to a real
// SDK ID after the first prompt — using the session ID would cause re-injection
// when the ID changes.
const injectedWorktrees = new Set<string>()

function resolveSdkId(
  dbService: DatabaseService,
  sessionId: string
): AgentSdk | null {
  return (
    dbService.getAgentSdkForSession(sessionId) ?? dbService.getSession(sessionId)?.agent_sdk ?? null
  )
}

function resolveAgentSessionId(dbService: DatabaseService, sessionId: string): string {
  return dbService.getSession(sessionId)?.opencode_session_id ?? sessionId
}

export function registerOpenCodeHandlers(
  mainWindow: BrowserWindow,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): void {
  // Set the main window for event forwarding
  openCodeService.setMainWindow(mainWindow)

  // Connect to OpenCode for a worktree (lazy starts server if needed)
  defineHandler(
    'opencode:connect',
    z.tuple([z.string().min(1), z.string().min(1)]),
    ([worktreePath, hiveSessionId]) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:connect', { worktreePath, hiveSessionId })
        // New session on this worktree — allow context injection for the first prompt
        injectedWorktrees.delete(worktreePath)
        try {
          // SDK-aware dispatch: route non-OpenCode sessions to their implementer
          if (sdkManager && dbService) {
            const session = dbService.getSession(hiveSessionId)
            // Terminal and Claude CLI sessions have no Agent-SDK backend reachable
            // here (Claude CLI is PTY-backed and has no registered implementer) —
            // short-circuit instead of falling through to getImplementer (throws)
            // or the OpenCode connect path (would start an unwanted server).
            if (isTerminalBacked(session?.agent_sdk)) {
              return { success: true, sessionId: hiveSessionId }
            }
            if (session?.agent_sdk && session.agent_sdk !== 'opencode') {
              const impl = sdkManager.getImplementer(session.agent_sdk)
              const result = await impl.connect(worktreePath, hiveSessionId)
              telemetryService.track('session_started', { agent_sdk: session.agent_sdk })
              return { success: true, ...result }
            }
          }
          // Fall through to existing OpenCode path
          const result = await openCodeService.connect(worktreePath, hiveSessionId)
          telemetryService.track('session_started', { agent_sdk: 'opencode' })
          return { success: true, ...result }
        } catch (error) {
          log.error('IPC: opencode:connect failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Reconnect to existing OpenCode session
  defineHandler(
    'opencode:reconnect',
    z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]),
    ([worktreePath, opencodeSessionId, hiveSessionId]) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:reconnect', { worktreePath, opencodeSessionId, hiveSessionId })
        try {
          // SDK-aware dispatch: route non-OpenCode sessions to their implementer
          if (sdkManager && dbService) {
            const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
            // Terminal and Claude CLI sessions have no Agent-SDK backend — short-circuit
            if (isTerminalBacked(sdkId)) {
              return { success: true, sessionStatus: 'idle' as const }
            }
            if (sdkId && sdkId !== 'opencode') {
              const impl = sdkManager.getImplementer(sdkId)
              const result = await impl.reconnect(worktreePath, opencodeSessionId, hiveSessionId)
              return result
            }
          }
          // Fall through to existing OpenCode path
          const result = await openCodeService.reconnect(
            worktreePath,
            opencodeSessionId,
            hiveSessionId
          )
          return result
        } catch (error) {
          log.error('IPC: opencode:reconnect failed', toError(error))
          return { success: false }
        }
      })
  )

  // Send a prompt (response streams via onStream)
  // Accepts either { worktreePath, sessionId, parts } object or positional (worktreePath, sessionId, message) for backward compat
  defineHandler('opencode:prompt', promptArgsSchema, (input) =>
    opencodeEffect(async () => {
      const args = Array.isArray(input) ? input : [input]
      let worktreePath: string
      let opencodeSessionId: string
      let messageOrParts: PromptMessage
      let model: { providerID: string; modelID: string; variant?: string } | undefined
      let options: PromptOptions | undefined

      // Support object-style call: { worktreePath, sessionId, parts }
      if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
        const obj = args[0] as Record<string, unknown>
        worktreePath = obj.worktreePath as string
        opencodeSessionId = obj.sessionId as string
        // Backward compat: accept message string or parts array
        messageOrParts = (obj.parts as PromptMessage | undefined) || [
          { type: 'text', text: obj.message as string }
        ]
        const rawModel = obj.model as Record<string, unknown> | undefined
        if (
          rawModel &&
          typeof rawModel.providerID === 'string' &&
          typeof rawModel.modelID === 'string'
        ) {
          model = {
            providerID: rawModel.providerID,
            modelID: rawModel.modelID,
            variant: typeof rawModel.variant === 'string' ? rawModel.variant : undefined
          }
        }
        const rawOptions = obj.options as Record<string, unknown> | undefined
        if (rawOptions && typeof rawOptions.codexFastMode === 'boolean') {
          options = { codexFastMode: rawOptions.codexFastMode }
        }
      } else {
        // Legacy positional args: (worktreePath, sessionId, message)
        worktreePath = args[0] as string
        opencodeSessionId = args[1] as string
      messageOrParts = args[2] as PromptMessage
        const rawModel = args[3] as Record<string, unknown> | undefined
        if (
          rawModel &&
          typeof rawModel.providerID === 'string' &&
          typeof rawModel.modelID === 'string'
        ) {
          model = {
            providerID: rawModel.providerID,
            modelID: rawModel.modelID,
            variant: typeof rawModel.variant === 'string' ? rawModel.variant : undefined
          }
        }
        const rawOptions = args[4] as Record<string, unknown> | undefined
        if (rawOptions && typeof rawOptions.codexFastMode === 'boolean') {
          options = { codexFastMode: rawOptions.codexFastMode }
        }
      }

      // Inject worktree context on first prompt of each session.
      // We track by worktreePath (not opencodeSessionId) because Claude Code
      // sessions start with a pending:: ID that materializes to a real ID after
      // the first prompt — tracking by session ID would miss the transition.
      if (!injectedWorktrees.has(worktreePath) && dbService) {
        // Skip worktree context injection for Supercharge sessions — the plan
        // content that follows already has full context and the worktree context
        // just pollutes it.
        const firstTextPart = Array.isArray(messageOrParts)
          ? messageOrParts.find((p) => p.type === 'text')?.text?.trim()
          : typeof messageOrParts === 'string'
            ? messageOrParts.trim()
            : undefined
        if (firstTextPart?.startsWith('/using-superpowers')) {
          injectedWorktrees.add(worktreePath)
        } else {
          try {
            const worktree = dbService.getWorktreeByPath(worktreePath)
            if (worktree?.context) {
              log.info('Injecting worktree context into first prompt', {
                worktreePath,
                opencodeSessionId,
                contextLength: worktree.context.length
              })
              const contextPrefix = `[Worktree Context]\n${worktree.context}\n\n[User Message]\n`
              if (typeof messageOrParts === 'string') {
                messageOrParts = contextPrefix + messageOrParts
              } else if (Array.isArray(messageOrParts)) {
                // Find the first text part and prepend context
                const textPartIndex = messageOrParts.findIndex((p) => p.type === 'text')
                if (textPartIndex >= 0) {
                  const textPart = messageOrParts[textPartIndex]
                  if (textPart.type === 'text' && textPart.text) {
                    messageOrParts = [...messageOrParts]
                    messageOrParts[textPartIndex] = {
                      ...textPart,
                      text: contextPrefix + textPart.text
                    }
                  }
                }
              }
            }
            // Mark as injected after successful lookup (even if no context to inject)
            injectedWorktrees.add(worktreePath)
          } catch (err) {
            // Don't add to injectedWorktrees — allow retry on next prompt
            log.warn('Failed to inject worktree context', {
              worktreePath,
              error: err instanceof Error ? err.message : String(err)
            })
          }
        }
      }

      log.info('IPC: opencode:prompt', {
        worktreePath,
        opencodeSessionId,
        partsCount: Array.isArray(messageOrParts) ? messageOrParts.length : 1,
        model,
        options
      })
      try {
        // SDK-aware dispatch: route non-OpenCode sessions to their implementer
        if (sdkManager && dbService) {
          const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
          log.info('[CODEX_STREAM_DEBUG] IPC prompt route resolved', {
            worktreePath,
            requestedSessionId: opencodeSessionId,
            sdkId,
            route: sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli' ? 'sdk' : 'opencode'
          })
          if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli') {
            const impl = sdkManager.getImplementer(sdkId)
            await impl.prompt(worktreePath, opencodeSessionId, messageOrParts, model, options)
            telemetryService.track('prompt_sent', { agent_sdk: sdkId })
            return { success: true }
          }
        }
        // Fall through to existing OpenCode path
        await openCodeService.prompt(worktreePath, opencodeSessionId, messageOrParts, model)
        telemetryService.track('prompt_sent', { agent_sdk: 'opencode' })
        return { success: true }
      } catch (error) {
        log.error('IPC: opencode:prompt failed', toError(error))
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    })
  )

  // Disconnect session (may kill server if last session for worktree)
  defineHandler(
    'opencode:disconnect',
    z.tuple([z.string().min(1), z.string().min(1)]),
    ([worktreePath, opencodeSessionId]) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:disconnect', { worktreePath, opencodeSessionId })
        injectedWorktrees.delete(worktreePath)
        try {
          // SDK-aware dispatch: route non-OpenCode sessions to their implementer
          if (sdkManager && dbService) {
            const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
            if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli') {
              const impl = sdkManager.getImplementer(sdkId)
              await impl.disconnect(worktreePath, opencodeSessionId)
              return { success: true }
            }
          }
          // Fall through to existing OpenCode path
          await openCodeService.disconnect(worktreePath, opencodeSessionId)
          return { success: true }
        } catch (error) {
          log.error('IPC: opencode:disconnect failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Get available models from all configured providers
  defineHandler(
    'opencode:models',
    z.object({ agentSdk: agentSdkSchema.optional() }).optional(),
    (opts) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:models', { agentSdk: opts?.agentSdk })
        try {
          const requestedSdk = toModelCatalogSdk(opts?.agentSdk)
          if (requestedSdk && requestedSdk !== 'opencode' && requestedSdk !== 'terminal' && sdkManager) {
            const impl = sdkManager.getImplementer(requestedSdk)
            if (impl) {
              const providers = await impl.getAvailableModels()
              return { success: true, providers }
            }
          }
          // Default: OpenCode
          const providers = await openCodeService.getAvailableModels()
          return { success: true, providers }
        } catch (error) {
          log.error('IPC: opencode:models failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            providers: {}
          }
        }
      })
  )

  // Set the selected model
  defineHandler('opencode:setModel', modelSchema.nullable(), (model) =>
    opencodeEffect(async () => {
      log.info('IPC: opencode:setModel', {
        model: model ? model.modelID : null,
        agentSdk: model?.agentSdk
      })
      try {
        // Handle null (clear global model only — per-SDK models are independent)
        if (model === null) {
          openCodeService.clearSelectedModel()
          return { success: true }
        }

        // Handle non-null model
        if (model.agentSdk && model.agentSdk !== 'opencode' && sdkManager) {
          const impl = sdkManager.getImplementer(model.agentSdk)
          if (impl) {
            impl.setSelectedModel(model)
            return { success: true }
          }
        }
        // Default: OpenCode
        openCodeService.setSelectedModel(model)
        return { success: true }
      } catch (error) {
        log.error('IPC: opencode:setModel failed', toError(error))
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    })
  )

  // Get model info (name, context limit)
  defineHandler(
    'opencode:modelInfo',
    z.object({
      worktreePath: z.string().min(1),
      modelId: z.string().min(1),
      agentSdk: agentSdkSchema.optional()
    }),
    ({ worktreePath, modelId, agentSdk }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:modelInfo', { worktreePath, modelId, agentSdk })
        try {
          const requestedSdk = toModelCatalogSdk(agentSdk)
          if (requestedSdk && requestedSdk !== 'opencode' && requestedSdk !== 'terminal' && sdkManager) {
            const impl = sdkManager.getImplementer(requestedSdk)
            if (impl) {
              const model = await impl.getModelInfo(worktreePath, modelId)
              if (!model) {
                return { success: false, error: 'Model not found' }
              }
              return { success: true, model }
            }
          }
          // Default: OpenCode
          const model = await openCodeService.getModelInfo(worktreePath, modelId)
          if (!model) {
            return { success: false, error: 'Model not found' }
          }
          return { success: true, model }
        } catch (error) {
          log.error('IPC: opencode:modelInfo failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Get session info (revert state)
  defineHandler(
    'opencode:sessionInfo',
    z.object({ worktreePath: z.string().min(1), sessionId: z.string().min(1) }),
    ({ worktreePath, sessionId }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:sessionInfo', { worktreePath, sessionId })
        try {
          // SDK-aware dispatch: route non-OpenCode sessions to their implementer
          if (sdkManager && dbService) {
            const sdkId = dbService.getAgentSdkForSession(sessionId)
            if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli') {
              const impl = sdkManager.getImplementer(sdkId)
              const result = await impl.getSessionInfo(worktreePath, sessionId)
              return { success: true, ...result }
            }
          }
          // Fall through to existing OpenCode path
          const result = await openCodeService.getSessionInfo(worktreePath, sessionId)
          return { success: true, ...result }
        } catch (error) {
          log.error('IPC: opencode:sessionInfo failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // List available slash commands
  defineHandler(
    'opencode:commands',
    z.object({ worktreePath: z.string().min(1), sessionId: z.string().optional() }),
    ({ worktreePath, sessionId }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:commands', { worktreePath, sessionId })
        try {
          // SDK-aware dispatch: route non-OpenCode sessions to their implementer
          if (sdkManager && dbService && sessionId) {
            const sdkId = resolveSdkId(dbService, sessionId)
            if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli') {
              const impl = sdkManager.getImplementer(sdkId)
              const resolvedAgentSessionId = resolveAgentSessionId(dbService, sessionId)
              const commands = await impl.listCommands(worktreePath, resolvedAgentSessionId)
              return { success: true, commands }
            }
          }

          // For pending:: sessions (not yet materialized in DB), try Claude Code
          // implementer as it may have cached commands from previous sessions.
          if (sdkManager && sessionId?.startsWith('pending::')) {
            const impl = sdkManager.getImplementer('claude-code')
            const commands = await impl.listCommands(worktreePath)
            if (commands.length > 0) {
              return { success: true, commands }
            }
          }

          // Fall through to existing OpenCode path
          const commands = await openCodeService.listCommands(worktreePath)
          return { success: true, commands }
        } catch (error) {
          log.error('IPC: opencode:commands failed', toError(error))
          return {
            success: false,
            commands: [],
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Send a slash command to a session via the SDK command endpoint
  defineHandler(
    'opencode:command',
    z.object({
      worktreePath: z.string().min(1),
      sessionId: z.string().min(1),
      command: z.string().min(1),
      args: z.string(),
      model: modelSchema.optional(),
      options: promptOptionsSchema.optional()
    }),
    ({ worktreePath, sessionId, command, args, model, options }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:command', { worktreePath, sessionId, command, args, model, options })
        try {
          // SDK-aware dispatch: route non-OpenCode sessions to their implementer
          if (sdkManager && dbService) {
            const sdkId = resolveSdkId(dbService, sessionId)
            const resolvedAgentSessionId =
              sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli'
                ? resolveAgentSessionId(dbService, sessionId)
                : sessionId
            log.info('[CODEX_STREAM_DEBUG] IPC command route resolved', {
              worktreePath,
              requestedSessionId: sessionId,
              resolvedAgentSessionId,
              sdkId,
              command,
              route: sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli' ? 'sdk' : 'opencode'
            })
            if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli') {
              const impl = sdkManager.getImplementer(sdkId)
              await impl.sendCommand(worktreePath, resolvedAgentSessionId, command, args, model, options)
              return { success: true }
            }
          }
          // Fall through to existing OpenCode path
          await openCodeService.sendCommand(worktreePath, sessionId, command, args, model)
          return { success: true }
        } catch (error) {
          log.error('IPC: opencode:command failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Undo last message state via OpenCode revert API
  defineHandler(
    'opencode:undo',
    z.object({ worktreePath: z.string().min(1), sessionId: z.string().min(1) }),
    ({ worktreePath, sessionId }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:undo', { worktreePath, sessionId })
        try {
          // SDK-aware dispatch: route non-OpenCode sessions to their implementer
          if (sdkManager && dbService) {
            const sdkId = dbService.getAgentSdkForSession(sessionId)
            if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli') {
              const impl = sdkManager.getImplementer(sdkId)
              const result = await impl.undo(worktreePath, sessionId, '')
              return { success: true, ...(result as Record<string, unknown>) }
            }
          }
          // Fall through to existing OpenCode path
          const result = await openCodeService.undo(worktreePath, sessionId)
          return { success: true, ...result }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          log.error('IPC: opencode:undo failed', err)
          return {
            success: false,
            error: err.message
          }
        }
      })
  )

  // Redo last undone message state via OpenCode unrevert/revert API
  defineHandler(
    'opencode:redo',
    z.object({ worktreePath: z.string().min(1), sessionId: z.string().min(1) }),
    ({ worktreePath, sessionId }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:redo', { worktreePath, sessionId })
        try {
          // SDK-aware dispatch: route non-OpenCode sessions to their implementer
          if (sdkManager && dbService) {
            const sdkId = dbService.getAgentSdkForSession(sessionId)
            if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli') {
              const impl = sdkManager.getImplementer(sdkId)
              const result = await impl.redo(worktreePath, sessionId, '')
              return { success: true, ...(result as Record<string, unknown>) }
            }
          }
          // Fall through to existing OpenCode path
          const result = await openCodeService.redo(worktreePath, sessionId)
          return { success: true, ...result }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          log.error('IPC: opencode:redo failed', err)
          return {
            success: false,
            error: err.message
          }
        }
      })
  )

  // Get SDK capabilities for a session
  defineHandler(
    'opencode:capabilities',
    z.object({ sessionId: z.string().optional() }),
    ({ sessionId }) =>
      opencodeEffect(async () => {
        try {
          if (sdkManager && dbService && sessionId) {
            const sdkId = dbService.getAgentSdkForSession(sessionId)
            if (sdkId) {
              return { success: true, capabilities: sdkManager.getCapabilities(sdkId) }
            }
          }
          // Default to opencode capabilities
          const defaultCaps = sdkManager?.getCapabilities('opencode') ?? null
          return { success: true, capabilities: defaultCaps }
        } catch (error) {
          log.error('IPC: opencode:capabilities failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Steer — inject input into a running Codex turn
  defineHandler(
    'opencode:steer',
    z.object({
      worktreePath: z.string().min(1),
      sessionId: z.string().min(1),
      message: z.string()
    }),
    ({ worktreePath, sessionId, message }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:steer', { worktreePath, sessionId })
        try {
          // Only Codex supports steering
          if (sdkManager && dbService) {
            const sdkId = dbService.getAgentSdkForSession(sessionId)
            if (sdkId === 'codex') {
              const impl = sdkManager.getImplementer('codex') as CodexImplementer
              const result = await impl.steer(worktreePath, sessionId, message)
              return {
                success: result.steered,
                error: result.error,
                insertedMessageId: result.insertedMessageId,
                nextAssistantMessageId: result.nextAssistantMessageId,
                turnId: result.turnId
              }
            }
          }
          return { success: false, error: 'sdk_not_supported' }
        } catch (error) {
          log.error('IPC: opencode:steer failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Reply to a pending question from the AI
  defineHandler(
    'opencode:question:reply',
    z.object({
      requestId: z.string().min(1),
      answers: z.array(z.array(z.string())),
      worktreePath: z.string().optional()
    }),
    ({ requestId, answers, worktreePath }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:question:reply', { requestId })
        try {
          // Claude CLI (terminal-backed) question held open by the Telegram bridge.
          if (claudeCliTelegramBridge.hasPendingQuestion(requestId)) {
            claudeCliTelegramBridge.resolveQuestion(requestId, answers)
            return { success: true }
          }
          // Route to Claude Code implementer if this is a Claude Code question
          if (sdkManager) {
            const claudeImpl = sdkManager.getImplementer('claude-code') as ClaudeCodeImplementer
            if (claudeImpl.hasPendingQuestion(requestId)) {
              await claudeImpl.questionReply(requestId, answers, worktreePath)
              return { success: true }
            }

            // Route to Codex implementer if this is a Codex question
            try {
              const codexImpl = sdkManager.getImplementer('codex') as CodexImplementer
              if (codexImpl.hasPendingQuestion(requestId)) {
                await codexImpl.questionReply(requestId, answers, worktreePath)
                return { success: true }
              }
            } catch {
              // Codex implementer not registered, continue
            }
          }
          // Fall through to OpenCode
          await openCodeService.questionReply(requestId, answers, worktreePath)
          return { success: true }
        } catch (error) {
          log.error('IPC: opencode:question:reply failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Reject/dismiss a pending question from the AI
  defineHandler(
    'opencode:question:reject',
    z.object({ requestId: z.string().min(1), worktreePath: z.string().optional() }),
    ({ requestId, worktreePath }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:question:reject', { requestId })
        try {
          // Claude CLI (terminal-backed) question held open by the Telegram bridge.
          if (claudeCliTelegramBridge.hasPendingQuestion(requestId)) {
            claudeCliTelegramBridge.rejectQuestion(requestId)
            return { success: true }
          }
          // Route to Claude Code implementer if this is a Claude Code question
          if (sdkManager) {
            const claudeImpl = sdkManager.getImplementer('claude-code') as ClaudeCodeImplementer
            if (claudeImpl.hasPendingQuestion(requestId)) {
              await claudeImpl.questionReject(requestId, worktreePath)
              return { success: true }
            }

            // Route to Codex implementer if this is a Codex question
            try {
              const codexImpl = sdkManager.getImplementer('codex') as CodexImplementer
              if (codexImpl.hasPendingQuestion(requestId)) {
                await codexImpl.questionReject(requestId, worktreePath)
                return { success: true }
              }
            } catch {
              // Codex implementer not registered, continue
            }
          }
          // Fall through to OpenCode
          await openCodeService.questionReject(requestId, worktreePath)
          return { success: true }
        } catch (error) {
          log.error('IPC: opencode:question:reject failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Approve a pending plan (ExitPlanMode) — unblocks the SDK to implement
  defineHandler(
    'opencode:plan:approve',
    z.object({
      worktreePath: z.string().min(1),
      hiveSessionId: z.string().min(1),
      requestId: z.string().optional()
    }),
    ({ worktreePath, hiveSessionId, requestId }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:plan:approve', { hiveSessionId, requestId })
        try {
          // TODO(codex): Generalize when Codex implements this HITL flow
          if (sdkManager) {
            const claudeImpl = sdkManager.getImplementer('claude-code') as ClaudeCodeImplementer
            if (
              (requestId && claudeImpl.hasPendingPlan(requestId)) ||
              claudeImpl.hasPendingPlanForSession(hiveSessionId)
            ) {
              await claudeImpl.planApprove(worktreePath, hiveSessionId, requestId)
              return { success: true }
            }
          }
          return { success: false, error: 'No pending plan found' }
        } catch (error) {
          log.error('IPC: opencode:plan:approve failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Reject a pending plan with user feedback — Claude will revise
  defineHandler(
    'opencode:plan:reject',
    z.object({
      worktreePath: z.string().min(1),
      hiveSessionId: z.string().min(1),
      feedback: z.string(),
      requestId: z.string().optional()
    }),
    ({ worktreePath, hiveSessionId, feedback, requestId }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:plan:reject', {
          hiveSessionId,
          requestId,
          feedbackLength: feedback.length
        })
        try {
          // TODO(codex): Generalize when Codex implements this HITL flow
          if (sdkManager) {
            const claudeImpl = sdkManager.getImplementer('claude-code') as ClaudeCodeImplementer
            if (
              (requestId && claudeImpl.hasPendingPlan(requestId)) ||
              claudeImpl.hasPendingPlanForSession(hiveSessionId)
            ) {
              await claudeImpl.planReject(worktreePath, hiveSessionId, feedback, requestId)
              return { success: true }
            }
          }
          return { success: false, error: 'No pending plan found' }
        } catch (error) {
          log.error('IPC: opencode:plan:reject failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Reply to a pending permission request
  defineHandler(
    'opencode:permission:reply',
    z.object({
      requestId: z.string().min(1),
      reply: z.enum(['once', 'always', 'reject']),
      worktreePath: z.string().optional(),
      message: z.string().optional()
    }),
    ({ requestId, reply, worktreePath, message }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:permission:reply', { requestId, reply })
        try {
          // Route to Codex implementer if this is a Codex approval
          if (sdkManager) {
            try {
              const codexImpl = sdkManager.getImplementer('codex') as CodexImplementer
              if (codexImpl.hasPendingApproval(requestId)) {
                await codexImpl.permissionReply(requestId, reply, worktreePath)
                return { success: true }
              }
            } catch {
              // Codex implementer not registered, continue
            }
          }
          // Fall through to OpenCode
          await openCodeService.permissionReply(requestId, reply, worktreePath, message)
          return { success: true }
        } catch (error) {
          log.error('IPC: opencode:permission:reply failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // List all pending permission requests
  defineHandler(
    'opencode:permission:list',
    z.object({ worktreePath: z.string().optional() }),
    ({ worktreePath }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:permission:list')
        try {
          // Aggregate permissions from all implementers
          let permissions = await openCodeService.permissionList(worktreePath)

          // Also include Codex pending approvals
          if (sdkManager) {
            try {
              const codexImpl = sdkManager.getImplementer('codex') as CodexImplementer
              const codexPermissions = await codexImpl.permissionList(worktreePath)
              permissions = [...permissions, ...codexPermissions]
            } catch {
              // Codex implementer not registered, continue
            }
          }

          return { success: true, permissions }
        } catch (error) {
          log.error('IPC: opencode:permission:list failed', toError(error))
          return {
            success: false,
            permissions: [],
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Reply to a pending command approval request (for command filter system)
  defineHandler(
    'opencode:commandApprovalReply',
    z.object({
      requestId: z.string().min(1),
      approved: z.boolean(),
      remember: z.enum(['allow', 'block']).optional(),
      pattern: z.string().optional(),
      worktreePath: z.string().optional(),
      patterns: z.array(z.string()).optional()
    }),
    ({ requestId, approved, remember, pattern, patterns }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:commandApprovalReply', {
          requestId,
          approved,
          remember,
          pattern,
          patterns
        })
        try {
          // TODO(codex): Generalize when Codex implements this HITL flow
          // Route to Claude Code implementer (command approval is Claude Code specific)
          if (sdkManager) {
            const impl = sdkManager.getImplementer('claude-code')
            if (impl instanceof ClaudeCodeImplementer) {
              impl.handleApprovalReply(requestId, approved, remember, pattern, patterns)
              return { success: true }
            }
          }
          throw new Error('Claude Code implementer not available')
        } catch (error) {
          log.error('IPC: opencode:commandApprovalReply failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Rename a session's title via the OpenCode PATCH API
  defineHandler(
    'opencode:renameSession',
    z.object({
      opencodeSessionId: z.string().min(1),
      title: z.string(),
      worktreePath: z.string().optional()
    }),
    ({ opencodeSessionId, title, worktreePath }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:renameSession', { opencodeSessionId, title })
        try {
          // SDK-aware dispatch: route non-OpenCode sessions to their implementer
          if (sdkManager && dbService) {
            const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
            if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli') {
              const impl = sdkManager.getImplementer(sdkId)
              await impl.renameSession(worktreePath ?? '', opencodeSessionId, title)
              return { success: true }
            }
          }
          // Fall through to existing OpenCode path
          await openCodeService.renameSession(opencodeSessionId, title, worktreePath)
          return { success: true }
        } catch (error) {
          log.error('IPC: opencode:renameSession failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Fork an existing OpenCode session at an optional message boundary
  defineHandler(
    'opencode:fork',
    z.object({
      worktreePath: z.string().min(1),
      sessionId: z.string().min(1),
      messageId: z.string().optional()
    }),
    ({ worktreePath, sessionId, messageId }) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:fork', { worktreePath, sessionId, messageId })
        try {
          const result = await openCodeService.forkSession(worktreePath, sessionId, messageId)
          return { success: true, ...result }
        } catch (error) {
          log.error('IPC: opencode:fork failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Get messages from an OpenCode session
  defineHandler(
    'opencode:messages',
    z.tuple([z.string().min(1), z.string().min(1)]),
    ([worktreePath, opencodeSessionId]) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:messages', { worktreePath, opencodeSessionId })
        try {
          // SDK-aware dispatch: route non-OpenCode sessions to their implementer
          if (sdkManager && dbService) {
            const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
            if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli') {
              const impl = sdkManager.getImplementer(sdkId)
              const messages = await impl.getMessages(worktreePath, opencodeSessionId)
              return { success: true, messages }
            }
          }
          // Fall through to existing OpenCode path
          const messages = await openCodeService.getMessages(worktreePath, opencodeSessionId)
          return { success: true, messages }
        } catch (error) {
          log.error('IPC: opencode:messages failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            messages: []
          }
        }
      })
  )

  defineHandler(
    'opencode:refresh-from-thread',
    z.tuple([z.string().min(1), z.string().min(1)]),
    ([worktreePath, opencodeSessionId]) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:refresh-from-thread', { worktreePath, opencodeSessionId })
        try {
          if (!sdkManager || !dbService) {
            return { success: false, error: 'SDK manager is not available' }
          }

          const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
          if (sdkId !== 'codex') {
            return {
              success: false,
              error: 'Refresh from file is only supported for Codex sessions'
            }
          }

          const impl = sdkManager.getImplementer('codex') as CodexImplementer
          return await impl.refreshMessagesFromThread(worktreePath, opencodeSessionId)
        } catch (error) {
          log.error('IPC: opencode:refresh-from-thread failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Abort a streaming session
  defineHandler(
    'opencode:abort',
    z.tuple([z.string().min(1), z.string().min(1)]),
    ([worktreePath, opencodeSessionId]) =>
      opencodeEffect(async () => {
        log.info('IPC: opencode:abort', { worktreePath, opencodeSessionId })
        try {
          // SDK-aware dispatch: route non-OpenCode sessions to their implementer
          if (sdkManager && dbService) {
            const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
            if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' && sdkId !== 'claude-code-cli') {
              const impl = sdkManager.getImplementer(sdkId)
              const result = await impl.abort(worktreePath, opencodeSessionId)
              return { success: result }
            }
          }
          // Fall through to existing OpenCode path
          const result = await openCodeService.abort(worktreePath, opencodeSessionId)
          return { success: result }
        } catch (error) {
          log.error('IPC: opencode:abort failed', toError(error))
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  log.info('OpenCode IPC handlers registered')
}

export async function cleanupOpenCode(): Promise<void> {
  log.info('Cleaning up OpenCode service')
  injectedWorktrees.clear()
  await openCodeService.cleanup()
}
