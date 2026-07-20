import { openCodeService } from './opencode-service'
import { createLogger } from './logger'
import { telemetryService } from './telemetry-service'
import type { DatabaseService } from '../db/database'
import type { AgentSdkManager } from './agent-sdk-manager'
import type { AgentSdkCapabilities, AgentSdkId, PromptOptions } from './agent-sdk-types'
import { ClaudeCodeImplementer } from './claude-code-implementer'
import { CodexImplementer } from './codex-implementer'
import { claudeCliTelegramBridge } from './claude-cli-telegram-bridge'
import { claudeCliDiscordBridge } from './claude-cli-discord-bridge'
import { toError } from './error-utils'
import { isCliAgentSdk, isTerminalBacked } from '@shared/types/agent-sdk'

const log = createLogger({ component: 'OpenCodeSessionCommands' })
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
): 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'grok-cli' | 'terminal' | null {
  return (
    dbService.getAgentSdkForSession(sessionId) ?? dbService.getSession(sessionId)?.agent_sdk ?? null
  )
}

function resolveAgentSessionId(dbService: DatabaseService, sessionId: string): string {
  return dbService.getSession(sessionId)?.opencode_session_id ?? sessionId
}

function toImplementerSdk(sdkId: AgentSdkId): AgentSdkId {
  return sdkId === 'claude-code-cli' ? 'claude-code' : sdkId
}

export async function connectOpenCodeSession(
  worktreePath: string,
  hiveSessionId: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  log.info('OpenCode session connect', { worktreePath, hiveSessionId })
  // New session on this worktree — allow context injection for the first prompt
  injectedWorktrees.delete(worktreePath)
  try {
    // SDK-aware dispatch: route non-OpenCode sessions to their implementer
    if (sdkManager && dbService) {
      const session = dbService.getSession(hiveSessionId)
      // Terminal sessions have no AI backend — short-circuit
      if (session?.agent_sdk === 'terminal') {
        return { success: true, sessionId: hiveSessionId }
      }
      if (session?.agent_sdk && session.agent_sdk !== 'opencode') {
        const impl = sdkManager.getImplementer(toImplementerSdk(session.agent_sdk))
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
    log.error('OpenCode session connect failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function reconnectOpenCodeSession(
  worktreePath: string,
  opencodeSessionId: string,
  hiveSessionId: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{
  success: boolean
  sessionStatus?: 'idle' | 'busy' | 'retry'
  revertMessageID?: string | null
}> {
  log.info('OpenCode session reconnect', { worktreePath, opencodeSessionId, hiveSessionId })
  try {
    // SDK-aware dispatch: route non-OpenCode sessions to their implementer
    if (sdkManager && dbService) {
      const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
      // Terminal sessions have no AI backend — short-circuit
      if (sdkId === 'terminal') {
        return { success: true, sessionStatus: 'idle' as const }
      }
      if (sdkId && sdkId !== 'opencode') {
        const impl = sdkManager.getImplementer(toImplementerSdk(sdkId))
        const result = await impl.reconnect(worktreePath, opencodeSessionId, hiveSessionId)
        return result
      }
    }
    // Fall through to existing OpenCode path
    const result = await openCodeService.reconnect(worktreePath, opencodeSessionId, hiveSessionId)
    return result
  } catch (error) {
    log.error('OpenCode session reconnect failed', toError(error))
    return { success: false }
  }
}

export async function promptOpenCodeSession(
  worktreePath: string,
  opencodeSessionId: string,
  messageOrParts: PromptMessage,
  model?: { providerID: string; modelID: string; variant?: string },
  options?: PromptOptions,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{ success: boolean; error?: string }> {
  let promptMessage = messageOrParts

  // Inject worktree context on first prompt of each session.
  // We track by worktreePath (not opencodeSessionId) because Claude Code
  // sessions start with a pending:: ID that materializes to a real ID after
  // the first prompt — tracking by session ID would miss the transition.
  if (!injectedWorktrees.has(worktreePath) && dbService) {
    // Skip worktree context injection for Supercharge sessions — the plan
    // content that follows already has full context and the worktree context
    // just pollutes it.
    const firstTextPart = Array.isArray(promptMessage)
      ? promptMessage.find((p) => p.type === 'text')?.text?.trim()
      : typeof promptMessage === 'string'
        ? promptMessage.trim()
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
          if (typeof promptMessage === 'string') {
            promptMessage = contextPrefix + promptMessage
          } else if (Array.isArray(promptMessage)) {
            const textPartIndex = promptMessage.findIndex((p) => p.type === 'text')
            if (textPartIndex >= 0) {
              const textPart = promptMessage[textPartIndex]
              if (textPart.type === 'text' && textPart.text) {
                promptMessage = [...promptMessage]
                promptMessage[textPartIndex] = {
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

  log.info('OpenCode session prompt', {
    worktreePath,
    opencodeSessionId,
    partsCount: Array.isArray(promptMessage) ? promptMessage.length : 1,
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
        route: sdkId && sdkId !== 'opencode' && !isTerminalBacked(sdkId) ? 'sdk' : 'opencode'
      })
      if (isCliAgentSdk(sdkId)) {
        // Terminal-backed CLI agents: prompts go through the PTY (bracketed
        // paste / pending-prompt spawn), never an SDK implementer. Routing
        // one there would corrupt the implementer's session state.
        return {
          success: false,
          error: 'CLI agent sessions receive prompts via the terminal, not the prompt API'
        }
      }
      if (sdkId && sdkId !== 'opencode' && !isTerminalBacked(sdkId)) {
        const impl = sdkManager.getImplementer(toImplementerSdk(sdkId))
        await impl.prompt(worktreePath, opencodeSessionId, promptMessage, model, options)
        telemetryService.track('prompt_sent', { agent_sdk: sdkId })
        return { success: true }
      }
    }
    // Fall through to existing OpenCode path
    await openCodeService.prompt(worktreePath, opencodeSessionId, promptMessage, model)
    telemetryService.track('prompt_sent', { agent_sdk: 'opencode' })
    return { success: true }
  } catch (error) {
    log.error('OpenCode session prompt failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function abortOpenCodeSession(
  worktreePath: string,
  opencodeSessionId: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{ success: boolean; error?: string }> {
  log.info('OpenCode session abort', { worktreePath, opencodeSessionId })
  try {
    // SDK-aware dispatch: route non-OpenCode sessions to their implementer
    if (sdkManager && dbService) {
      const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
      if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal') {
        const impl = sdkManager.getImplementer(toImplementerSdk(sdkId))
        const result = await impl.abort(worktreePath, opencodeSessionId)
        return { success: result }
      }
    }
    // Fall through to existing OpenCode path
    const result = await openCodeService.abort(worktreePath, opencodeSessionId)
    return { success: result }
  } catch (error) {
    log.error('OpenCode session abort failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function steerOpenCodeSession(
  worktreePath: string,
  sessionId: string,
  message: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{
  success: boolean
  error?: string
  insertedMessageId?: string
  nextAssistantMessageId?: string
  turnId?: string
}> {
  log.info('OpenCode session steer', { worktreePath, sessionId })
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
    log.error('OpenCode session steer failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function disconnectOpenCodeSession(
  worktreePath: string,
  opencodeSessionId: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{ success: boolean; error?: string }> {
  log.info('OpenCode session disconnect', { worktreePath, opencodeSessionId })
  injectedWorktrees.delete(worktreePath)
  try {
    // SDK-aware dispatch: route non-OpenCode sessions to their implementer
    if (sdkManager && dbService) {
      const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
      if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal') {
        const impl = sdkManager.getImplementer(toImplementerSdk(sdkId))
        await impl.disconnect(worktreePath, opencodeSessionId)
        return { success: true }
      }
    }
    // Fall through to existing OpenCode path
    await openCodeService.disconnect(worktreePath, opencodeSessionId)
    return { success: true }
  } catch (error) {
    log.error('OpenCode session disconnect failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function getOpenCodeSessionMessages(
  worktreePath: string,
  opencodeSessionId: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{ success: boolean; messages: unknown[]; error?: string }> {
  log.info('OpenCode session messages', { worktreePath, opencodeSessionId })
  try {
    // SDK-aware dispatch: route non-OpenCode sessions to their implementer
    if (sdkManager && dbService) {
      const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
      if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal') {
        const impl = sdkManager.getImplementer(sdkId)
        const messages = await impl.getMessages(worktreePath, opencodeSessionId)
        return { success: true, messages }
      }
    }
    // Fall through to existing OpenCode path
    const messages = await openCodeService.getMessages(worktreePath, opencodeSessionId)
    return { success: true, messages }
  } catch (error) {
    log.error('OpenCode session messages failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      messages: []
    }
  }
}

export async function refreshOpenCodeSessionFromThread(
  worktreePath: string,
  opencodeSessionId: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{ success: boolean; count?: number; error?: string }> {
  log.info('OpenCode session refresh-from-thread', { worktreePath, opencodeSessionId })
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
    log.error('OpenCode session refresh-from-thread failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function listOpenCodeModels(
  opts?: {
    agentSdk?: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'grok-cli' | 'terminal'
  },
  sdkManager?: AgentSdkManager
): Promise<{ success: boolean; providers: unknown; error?: string }> {
  log.info('OpenCode session models', { agentSdk: opts?.agentSdk })
  try {
    if (opts?.agentSdk === 'grok-cli') {
      // Grok has no SDK implementer or fetched catalog; it ships a single
      // model (`grok models`), mirrored here for the picker/badge. Variant
      // keys are grok's --reasoning-effort values; key order is chip order
      // and the first key is the default on first select (high matches
      // grok's own default effort).
      return {
        success: true,
        providers: {
          providers: [
            {
              id: 'xai',
              name: 'xAI',
              models: {
                'grok-4.5': {
                  id: 'grok-4.5',
                  name: 'Grok 4.5',
                  variants: { high: {}, medium: {}, low: {} }
                }
              }
            }
          ]
        }
      }
    }
    const requestedSdk = opts?.agentSdk === 'claude-code-cli' ? 'claude-code' : opts?.agentSdk
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
    log.error('OpenCode session models failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      providers: {}
    }
  }
}

export async function setOpenCodeSelectedModel(
  model: {
    providerID: string
    modelID: string
    variant?: string
    agentSdk?: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'grok-cli' | 'terminal'
  } | null,
  sdkManager?: AgentSdkManager
): Promise<{ success: boolean; error?: string }> {
  log.info('OpenCode session setModel', {
    model: model ? model.modelID : null,
    agentSdk: model?.agentSdk
  })
  try {
    // Handle null (clear global model only — per-SDK models are independent)
    if (model === null) {
      openCodeService.clearSelectedModel()
      return { success: true }
    }

    // Handle non-null model. grok-cli has no implementer — model selection for
    // it lives entirely in renderer settings (the spawner reads the session
    // row). This includes UNSTAMPED grok selections (Settings' global model
    // picker sends no agentSdk): persisting xai/grok-4.5 as OpenCode's model
    // would make later OpenCode prompts run a model it cannot serve. An
    // explicit non-grok stamp is trusted — OpenCode's own catalog may expose
    // xAI models, and those selections must reach openCodeService.
    if (
      model.agentSdk === 'grok-cli' ||
      (!model.agentSdk &&
        (model.providerID === 'xai' || model.modelID.toLowerCase().startsWith('grok')))
    ) {
      return { success: true }
    }
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
    log.error('OpenCode session setModel failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function getOpenCodeModelInfo(
  worktreePath: string,
  modelId: string,
  agentSdk?: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'grok-cli' | 'terminal',
  sdkManager?: AgentSdkManager
): Promise<{
  success: boolean
  model?: { id: string; name: string; limit: { context: number; input?: number; output?: number } }
  error?: string
}> {
  log.info('OpenCode session modelInfo', { worktreePath, modelId, agentSdk })
  try {
    if (agentSdk === 'grok-cli') {
      return { success: false, error: 'Model info not available for grok-cli' }
    }
    const requestedSdk = agentSdk === 'claude-code-cli' ? 'claude-code' : agentSdk
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
    log.error('OpenCode session modelInfo failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function replyOpenCodeQuestion(
  requestId: string,
  answers: string[][],
  worktreePath?: string,
  sdkManager?: AgentSdkManager
): Promise<{ success: boolean; error?: string }> {
  log.info('OpenCode session question:reply', { requestId })
  try {
    if (claudeCliTelegramBridge.hasPendingQuestion(requestId)) {
      claudeCliTelegramBridge.resolveQuestion(requestId, answers)
      return { success: true }
    }

    if (claudeCliDiscordBridge.hasPendingQuestion(requestId)) {
      claudeCliDiscordBridge.resolveQuestion(requestId, answers)
      return { success: true }
    }

    if (sdkManager) {
      const claudeImpl = sdkManager.getImplementer('claude-code') as ClaudeCodeImplementer
      if (claudeImpl.hasPendingQuestion(requestId)) {
        await claudeImpl.questionReply(requestId, answers, worktreePath)
        return { success: true }
      }

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

    await openCodeService.questionReply(requestId, answers, worktreePath)
    return { success: true }
  } catch (error) {
    log.error('OpenCode session question:reply failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function rejectOpenCodeQuestion(
  requestId: string,
  worktreePath?: string,
  sdkManager?: AgentSdkManager
): Promise<{ success: boolean; error?: string }> {
  log.info('OpenCode session question:reject', { requestId })
  try {
    if (claudeCliTelegramBridge.hasPendingQuestion(requestId)) {
      claudeCliTelegramBridge.rejectQuestion(requestId)
      return { success: true }
    }

    if (claudeCliDiscordBridge.hasPendingQuestion(requestId)) {
      claudeCliDiscordBridge.rejectQuestion(requestId)
      return { success: true }
    }

    if (sdkManager) {
      const claudeImpl = sdkManager.getImplementer('claude-code') as ClaudeCodeImplementer
      if (claudeImpl.hasPendingQuestion(requestId)) {
        await claudeImpl.questionReject(requestId, worktreePath)
        return { success: true }
      }

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

    await openCodeService.questionReject(requestId, worktreePath)
    return { success: true }
  } catch (error) {
    log.error('OpenCode session question:reject failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function approveOpenCodePlan(
  worktreePath: string,
  hiveSessionId: string,
  requestId?: string,
  sdkManager?: AgentSdkManager
): Promise<{ success: boolean; error?: string }> {
  log.info('OpenCode session plan:approve', { hiveSessionId, requestId })
  try {
    if (requestId && claudeCliDiscordBridge.hasPendingPlan(requestId)) {
      claudeCliDiscordBridge.resolvePlan(requestId, true)
      return { success: true }
    }
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
    log.error('OpenCode session plan:approve failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function rejectOpenCodePlan(
  worktreePath: string,
  hiveSessionId: string,
  feedback: string,
  requestId?: string,
  sdkManager?: AgentSdkManager
): Promise<{ success: boolean; error?: string }> {
  log.info('OpenCode session plan:reject', {
    hiveSessionId,
    requestId,
    feedbackLength: feedback.length
  })
  try {
    if (requestId && claudeCliDiscordBridge.hasPendingPlan(requestId)) {
      claudeCliDiscordBridge.resolvePlan(requestId, false, feedback)
      return { success: true }
    }
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
    log.error('OpenCode session plan:reject failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function replyOpenCodePermission(
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  worktreePath?: string,
  message?: string,
  sdkManager?: AgentSdkManager
): Promise<{ success: boolean; error?: string }> {
  log.info('OpenCode session permission:reply', { requestId, reply })
  try {
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

    await openCodeService.permissionReply(requestId, reply, worktreePath, message)
    return { success: true }
  } catch (error) {
    log.error('OpenCode session permission:reply failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function listOpenCodePermissions(
  worktreePath?: string,
  sdkManager?: AgentSdkManager
): Promise<{ success: boolean; permissions: unknown[]; error?: string }> {
  log.info('OpenCode session permission:list')
  try {
    let permissions = await openCodeService.permissionList(worktreePath)

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
    log.error('OpenCode session permission:list failed', toError(error))
    return {
      success: false,
      permissions: [],
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function replyOpenCodeCommandApproval(
  requestId: string,
  approved: boolean,
  remember?: 'allow' | 'block',
  pattern?: string,
  _worktreePath?: string,
  patterns?: string[],
  sdkManager?: AgentSdkManager
): Promise<{ success: boolean; error?: string }> {
  log.info('OpenCode session commandApprovalReply', {
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
    log.error('OpenCode session commandApprovalReply failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function getOpenCodeSessionInfo(
  worktreePath: string,
  sessionId: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{
  success: boolean
  revertMessageID?: string | null
  revertDiff?: string | null
  error?: string
}> {
  log.info('OpenCode session sessionInfo', { worktreePath, sessionId })
  try {
    // SDK-aware dispatch: route non-OpenCode sessions to their implementer
    if (sdkManager && dbService) {
      const sdkId = dbService.getAgentSdkForSession(sessionId)
      if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal') {
        const impl = sdkManager.getImplementer(sdkId)
        const result = await impl.getSessionInfo(worktreePath, sessionId)
        return { success: true, ...result }
      }
    }

    // Fall through to existing OpenCode path
    const result = await openCodeService.getSessionInfo(worktreePath, sessionId)
    return { success: true, ...result }
  } catch (error) {
    log.error('OpenCode session sessionInfo failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function undoOpenCodeSession(
  worktreePath: string,
  sessionId: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{
  success: boolean
  revertMessageID?: string
  restoredPrompt?: string
  revertDiff?: string | null
  error?: string
}> {
  log.info('OpenCode session undo', { worktreePath, sessionId })
  try {
    // SDK-aware dispatch: route non-OpenCode sessions to their implementer
    if (sdkManager && dbService) {
      const sdkId = dbService.getAgentSdkForSession(sessionId)
      if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal') {
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
    log.error('OpenCode session undo failed', err)
    return {
      success: false,
      error: err.message
    }
  }
}

export async function redoOpenCodeSession(
  worktreePath: string,
  sessionId: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{ success: boolean; revertMessageID?: string | null; error?: string }> {
  log.info('OpenCode session redo', { worktreePath, sessionId })
  try {
    // SDK-aware dispatch: route non-OpenCode sessions to their implementer
    if (sdkManager && dbService) {
      const sdkId = dbService.getAgentSdkForSession(sessionId)
      if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal') {
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
    log.error('OpenCode session redo failed', err)
    return {
      success: false,
      error: err.message
    }
  }
}

export async function sendOpenCodeCommand(
  worktreePath: string,
  sessionId: string,
  command: string,
  args: string,
  model?: {
    providerID: string
    modelID: string
    variant?: string
  },
  options?: PromptOptions,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{ success: boolean; error?: string }> {
  log.info('OpenCode session command', { worktreePath, sessionId, command, args, model, options })
  try {
    // SDK-aware dispatch: route non-OpenCode sessions to their implementer
    if (sdkManager && dbService) {
      const sdkId = resolveSdkId(dbService, sessionId)
      const resolvedAgentSessionId =
        sdkId && sdkId !== 'opencode' && sdkId !== 'terminal'
          ? resolveAgentSessionId(dbService, sessionId)
          : sessionId
      log.info('[CODEX_STREAM_DEBUG] IPC command route resolved', {
        worktreePath,
        requestedSessionId: sessionId,
        resolvedAgentSessionId,
        sdkId,
        command,
        route: sdkId && sdkId !== 'opencode' && sdkId !== 'terminal' ? 'sdk' : 'opencode'
      })
      if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal') {
        const impl = sdkManager.getImplementer(sdkId)
        await impl.sendCommand(worktreePath, resolvedAgentSessionId, command, args, model, options)
        return { success: true }
      }
    }

    // Fall through to existing OpenCode path
    await openCodeService.sendCommand(worktreePath, sessionId, command, args, model)
    return { success: true }
  } catch (error) {
    log.error('OpenCode session command failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function listOpenCodeCommands(
  worktreePath: string,
  sessionId?: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{
  success: boolean
  commands: Array<{
    name: string
    description?: string
    template: string
    agent?: string
    model?: string
    source?: string
    subtask?: boolean
    hints?: string[]
  }>
  error?: string
}> {
  log.info('OpenCode session commands', { worktreePath, sessionId })
  try {
    // SDK-aware dispatch: route non-OpenCode sessions to their implementer
    if (sdkManager && dbService && sessionId) {
      const sdkId = resolveSdkId(dbService, sessionId)
      if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal') {
        const impl = sdkManager.getImplementer(sdkId)
        const commands = await impl.listCommands(
          worktreePath,
          resolveAgentSessionId(dbService, sessionId)
        )
        return {
          success: true,
          commands: commands as Awaited<ReturnType<typeof openCodeService.listCommands>>
        }
      }
    }

    // For pending:: sessions (not yet materialized in DB), try Claude Code
    // implementer as it may have cached commands from previous sessions.
    if (sdkManager && sessionId?.startsWith('pending::')) {
      const impl = sdkManager.getImplementer('claude-code')
      const commands = await impl.listCommands(worktreePath)
      if (commands.length > 0) {
        return {
          success: true,
          commands: commands as Awaited<ReturnType<typeof openCodeService.listCommands>>
        }
      }
    }

    // Fall through to existing OpenCode path
    const commands = await openCodeService.listCommands(worktreePath)
    return { success: true, commands }
  } catch (error) {
    log.error('OpenCode session commands failed', toError(error))
    return {
      success: false,
      commands: [],
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function renameOpenCodeSession(
  opencodeSessionId: string,
  title: string,
  worktreePath?: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{ success: boolean; error?: string }> {
  log.info('OpenCode session renameSession', { opencodeSessionId, title })
  try {
    // SDK-aware dispatch: route non-OpenCode sessions to their implementer
    if (sdkManager && dbService) {
      const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
      if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal') {
        const impl = sdkManager.getImplementer(sdkId)
        await impl.renameSession(worktreePath ?? '', opencodeSessionId, title)
        return { success: true }
      }
    }
    // Fall through to existing OpenCode path
    await openCodeService.renameSession(opencodeSessionId, title, worktreePath)
    return { success: true }
  } catch (error) {
    log.error('OpenCode session renameSession failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function getOpenCodeCapabilities(
  sessionId?: string,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): Promise<{
  success: boolean
  capabilities?: AgentSdkCapabilities | null
  error?: string
}> {
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
    log.error('OpenCode session capabilities failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function forkOpenCodeSession(
  worktreePath: string,
  opencodeSessionId: string,
  messageId?: string
): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  log.info('OpenCode fork requested', { worktreePath, sessionId: opencodeSessionId, messageId })
  try {
    const result = await openCodeService.forkSession(worktreePath, opencodeSessionId, messageId)
    return { success: true, ...result }
  } catch (error) {
    log.error('OpenCode fork failed', toError(error))
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function cleanupOpenCode(): Promise<void> {
  log.info('Cleaning up OpenCode service')
  injectedWorktrees.clear()
  await openCodeService.cleanup()
}
