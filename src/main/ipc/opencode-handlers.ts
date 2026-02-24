import { ipcMain, BrowserWindow } from 'electron'
import { openCodeService } from '../services/opencode-service'
import { createLogger } from '../services/logger'
import type { DatabaseService } from '../db/database'
import type { AgentSdkManager } from '../services/agent-sdk-manager'
import { ClaudeCodeImplementer } from '../services/claude-code-implementer'

const log = createLogger({ component: 'OpenCodeHandlers' })

export function registerOpenCodeHandlers(
  mainWindow: BrowserWindow,
  sdkManager?: AgentSdkManager,
  dbService?: DatabaseService
): void {
  // Set the main window for event forwarding
  openCodeService.setMainWindow(mainWindow)

  // Connect to OpenCode for a worktree (lazy starts server if needed)
  ipcMain.handle(
    'opencode:connect',
    async (_event, worktreePath: string, hiveSessionId: string) => {
      log.info('IPC: opencode:connect', { worktreePath, hiveSessionId })
      try {
        // SDK-aware dispatch: route Claude sessions to ClaudeCodeImplementer
        if (sdkManager && dbService) {
          const session = dbService.getSession(hiveSessionId)
          // Terminal sessions have no AI backend — short-circuit
          if (session?.agent_sdk === 'terminal') {
            return { success: true, sessionId: hiveSessionId }
          }
          if (session?.agent_sdk === 'claude-code') {
            const impl = sdkManager.getImplementer('claude-code')
            const result = await impl.connect(worktreePath, hiveSessionId)
            return { success: true, ...result }
          }
        }
        // Fall through to existing OpenCode path
        const result = await openCodeService.connect(worktreePath, hiveSessionId)
        return { success: true, ...result }
      } catch (error) {
        log.error('IPC: opencode:connect failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Reconnect to existing OpenCode session
  ipcMain.handle(
    'opencode:reconnect',
    async (_event, worktreePath: string, opencodeSessionId: string, hiveSessionId: string) => {
      log.info('IPC: opencode:reconnect', { worktreePath, opencodeSessionId, hiveSessionId })
      try {
        // SDK-aware dispatch: route Claude sessions to ClaudeCodeImplementer
        if (sdkManager && dbService) {
          const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
          // Terminal sessions have no AI backend — short-circuit
          if (sdkId === 'terminal') {
            return { success: true, sessionStatus: 'idle' as const }
          }
          if (sdkId === 'claude-code') {
            const impl = sdkManager.getImplementer('claude-code')
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
        log.error('IPC: opencode:reconnect failed', { error })
        return { success: false }
      }
    }
  )

  // Send a prompt (response streams via onStream)
  // Accepts either { worktreePath, sessionId, parts } object or positional (worktreePath, sessionId, message) for backward compat
  ipcMain.handle('opencode:prompt', async (_event, ...args: unknown[]) => {
    let worktreePath: string
    let opencodeSessionId: string
    let messageOrParts:
      | string
      | Array<{ type: string; text?: string; mime?: string; url?: string; filename?: string }>
    let model: { providerID: string; modelID: string; variant?: string } | undefined

    // Support object-style call: { worktreePath, sessionId, parts }
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      const obj = args[0] as Record<string, unknown>
      worktreePath = obj.worktreePath as string
      opencodeSessionId = obj.sessionId as string
      // Backward compat: accept message string or parts array
      messageOrParts = (obj.parts as typeof messageOrParts) || [
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
    } else {
      // Legacy positional args: (worktreePath, sessionId, message)
      worktreePath = args[0] as string
      opencodeSessionId = args[1] as string
      messageOrParts = args[2] as string
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
    }

    log.info('IPC: opencode:prompt', {
      worktreePath,
      opencodeSessionId,
      partsCount: Array.isArray(messageOrParts) ? messageOrParts.length : 1,
      model
    })
    try {
      // SDK-aware dispatch: route Claude sessions to ClaudeCodeImplementer
      if (sdkManager && dbService) {
        const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
        if (sdkId === 'claude-code') {
          const impl = sdkManager.getImplementer('claude-code')
          await impl.prompt(worktreePath, opencodeSessionId, messageOrParts, model)
          return { success: true }
        }
      }
      // Fall through to existing OpenCode path
      await openCodeService.prompt(worktreePath, opencodeSessionId, messageOrParts, model)
      return { success: true }
    } catch (error) {
      log.error('IPC: opencode:prompt failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // Disconnect session (may kill server if last session for worktree)
  ipcMain.handle(
    'opencode:disconnect',
    async (_event, worktreePath: string, opencodeSessionId: string) => {
      log.info('IPC: opencode:disconnect', { worktreePath, opencodeSessionId })
      try {
        // SDK-aware dispatch: route Claude sessions to ClaudeCodeImplementer
        if (sdkManager && dbService) {
          const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
          if (sdkId === 'claude-code') {
            const impl = sdkManager.getImplementer('claude-code')
            await impl.disconnect(worktreePath, opencodeSessionId)
            return { success: true }
          }
        }
        // Fall through to existing OpenCode path
        await openCodeService.disconnect(worktreePath, opencodeSessionId)
        return { success: true }
      } catch (error) {
        log.error('IPC: opencode:disconnect failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Get available models from all configured providers
  ipcMain.handle(
    'opencode:models',
    async (_event, opts?: { agentSdk?: 'opencode' | 'claude-code' }) => {
      log.info('IPC: opencode:models', { agentSdk: opts?.agentSdk })
      try {
        if (opts?.agentSdk === 'claude-code' && sdkManager) {
          const impl = sdkManager.getImplementer('claude-code')
          if (impl) {
            const providers = await impl.getAvailableModels()
            return { success: true, providers }
          }
        }
        // Default: OpenCode
        const providers = await openCodeService.getAvailableModels()
        return { success: true, providers }
      } catch (error) {
        log.error('IPC: opencode:models failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          providers: {}
        }
      }
    }
  )

  // Set the selected model
  ipcMain.handle(
    'opencode:setModel',
    async (
      _event,
      model: {
        providerID: string
        modelID: string
        variant?: string
        agentSdk?: 'opencode' | 'claude-code'
      }
    ) => {
      log.info('IPC: opencode:setModel', { model: model.modelID, agentSdk: model.agentSdk })
      try {
        if (model.agentSdk === 'claude-code' && sdkManager) {
          const impl = sdkManager.getImplementer('claude-code')
          if (impl) {
            impl.setSelectedModel(model)
            return { success: true }
          }
        }
        // Default: OpenCode
        openCodeService.setSelectedModel(model)
        return { success: true }
      } catch (error) {
        log.error('IPC: opencode:setModel failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Get model info (name, context limit)
  ipcMain.handle(
    'opencode:modelInfo',
    async (
      _event,
      {
        worktreePath,
        modelId,
        agentSdk
      }: { worktreePath: string; modelId: string; agentSdk?: 'opencode' | 'claude-code' }
    ) => {
      log.info('IPC: opencode:modelInfo', { worktreePath, modelId, agentSdk })
      try {
        if (agentSdk === 'claude-code' && sdkManager) {
          const impl = sdkManager.getImplementer('claude-code')
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
        log.error('IPC: opencode:modelInfo failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Get session info (revert state)
  ipcMain.handle(
    'opencode:sessionInfo',
    async (_event, { worktreePath, sessionId }: { worktreePath: string; sessionId: string }) => {
      log.info('IPC: opencode:sessionInfo', { worktreePath, sessionId })
      try {
        // SDK-aware dispatch: route Claude sessions to ClaudeCodeImplementer
        if (sdkManager && dbService) {
          const sdkId = dbService.getAgentSdkForSession(sessionId)
          if (sdkId === 'claude-code') {
            const impl = sdkManager.getImplementer('claude-code')
            const result = await impl.getSessionInfo(worktreePath, sessionId)
            return { success: true, ...result }
          }
        }
        // Fall through to existing OpenCode path
        const result = await openCodeService.getSessionInfo(worktreePath, sessionId)
        return { success: true, ...result }
      } catch (error) {
        log.error('IPC: opencode:sessionInfo failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // List available slash commands
  ipcMain.handle(
    'opencode:commands',
    async (
      _event,
      { worktreePath, sessionId }: { worktreePath: string; sessionId?: string }
    ) => {
      log.info('IPC: opencode:commands', { worktreePath, sessionId })
      try {
        // SDK-aware dispatch: route Claude sessions to ClaudeCodeImplementer
        if (sdkManager && dbService && sessionId) {
          const sdkId = dbService.getAgentSdkForSession(sessionId)
          if (sdkId === 'claude-code') {
            const impl = sdkManager.getImplementer('claude-code')
            const commands = await impl.listCommands(worktreePath)
            return { success: true, commands }
          }
        }
        // Fall through to existing OpenCode path
        const commands = await openCodeService.listCommands(worktreePath)
        return { success: true, commands }
      } catch (error) {
        log.error('IPC: opencode:commands failed', { error })
        return {
          success: false,
          commands: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Send a slash command to a session via the SDK command endpoint
  ipcMain.handle(
    'opencode:command',
    async (
      _event,
      {
        worktreePath,
        sessionId,
        command,
        args,
        model
      }: {
        worktreePath: string
        sessionId: string
        command: string
        args: string
        model?: { providerID: string; modelID: string; variant?: string }
      }
    ) => {
      log.info('IPC: opencode:command', { worktreePath, sessionId, command, args, model })
      try {
        // SDK-aware dispatch: route Claude sessions to ClaudeCodeImplementer
        if (sdkManager && dbService) {
          const sdkId = dbService.getAgentSdkForSession(sessionId)
          if (sdkId === 'claude-code') {
            const impl = sdkManager.getImplementer('claude-code')
            // Note: model param intentionally not passed — Claude Code uses
            // its own model selection mechanism via setSelectedModel()
            await impl.sendCommand(worktreePath, sessionId, command, args)
            return { success: true }
          }
        }
        // Fall through to existing OpenCode path
        await openCodeService.sendCommand(worktreePath, sessionId, command, args, model)
        return { success: true }
      } catch (error) {
        log.error('IPC: opencode:command failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Undo last message state via OpenCode revert API
  ipcMain.handle(
    'opencode:undo',
    async (_event, { worktreePath, sessionId }: { worktreePath: string; sessionId: string }) => {
      log.info('IPC: opencode:undo', { worktreePath, sessionId })
      try {
        // SDK-aware dispatch: route Claude sessions to ClaudeCodeImplementer
        if (sdkManager && dbService) {
          const sdkId = dbService.getAgentSdkForSession(sessionId)
          if (sdkId === 'claude-code') {
            const impl = sdkManager.getImplementer('claude-code')
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
    }
  )

  // Redo last undone message state via OpenCode unrevert/revert API
  ipcMain.handle(
    'opencode:redo',
    async (_event, { worktreePath, sessionId }: { worktreePath: string; sessionId: string }) => {
      log.info('IPC: opencode:redo', { worktreePath, sessionId })
      try {
        // SDK-aware dispatch: route Claude sessions to ClaudeCodeImplementer
        if (sdkManager && dbService) {
          const sdkId = dbService.getAgentSdkForSession(sessionId)
          if (sdkId === 'claude-code') {
            const impl = sdkManager.getImplementer('claude-code')
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
    }
  )

  // Get SDK capabilities for a session
  ipcMain.handle('opencode:capabilities', async (_event, { sessionId }: { sessionId?: string }) => {
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
      log.error('IPC: opencode:capabilities failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // Reply to a pending question from the AI
  ipcMain.handle(
    'opencode:question:reply',
    async (
      _event,
      {
        requestId,
        answers,
        worktreePath
      }: { requestId: string; answers: string[][]; worktreePath?: string }
    ) => {
      log.info('IPC: opencode:question:reply', { requestId })
      try {
        // Route to Claude Code implementer if this is a Claude Code question
        if (sdkManager) {
          const claudeImpl = sdkManager.getImplementer('claude-code') as ClaudeCodeImplementer
          if (claudeImpl.hasPendingQuestion(requestId)) {
            await claudeImpl.questionReply(requestId, answers, worktreePath)
            return { success: true }
          }
        }
        // Fall through to OpenCode
        await openCodeService.questionReply(requestId, answers, worktreePath)
        return { success: true }
      } catch (error) {
        log.error('IPC: opencode:question:reply failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Reject/dismiss a pending question from the AI
  ipcMain.handle(
    'opencode:question:reject',
    async (_event, { requestId, worktreePath }: { requestId: string; worktreePath?: string }) => {
      log.info('IPC: opencode:question:reject', { requestId })
      try {
        // Route to Claude Code implementer if this is a Claude Code question
        if (sdkManager) {
          const claudeImpl = sdkManager.getImplementer('claude-code') as ClaudeCodeImplementer
          if (claudeImpl.hasPendingQuestion(requestId)) {
            await claudeImpl.questionReject(requestId, worktreePath)
            return { success: true }
          }
        }
        // Fall through to OpenCode
        await openCodeService.questionReject(requestId, worktreePath)
        return { success: true }
      } catch (error) {
        log.error('IPC: opencode:question:reject failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Approve a pending plan (ExitPlanMode) — unblocks the SDK to implement
  ipcMain.handle(
    'opencode:plan:approve',
    async (
      _event,
      {
        worktreePath,
        hiveSessionId,
        requestId
      }: { worktreePath: string; hiveSessionId: string; requestId?: string }
    ) => {
      log.info('IPC: opencode:plan:approve', { hiveSessionId, requestId })
      try {
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
        log.error('IPC: opencode:plan:approve failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Reject a pending plan with user feedback — Claude will revise
  ipcMain.handle(
    'opencode:plan:reject',
    async (
      _event,
      {
        worktreePath,
        hiveSessionId,
        feedback,
        requestId
      }: { worktreePath: string; hiveSessionId: string; feedback: string; requestId?: string }
    ) => {
      log.info('IPC: opencode:plan:reject', {
        hiveSessionId,
        requestId,
        feedbackLength: feedback.length
      })
      try {
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
        log.error('IPC: opencode:plan:reject failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Reply to a pending permission request
  ipcMain.handle(
    'opencode:permission:reply',
    async (
      _event,
      {
        requestId,
        reply,
        worktreePath,
        message
      }: {
        requestId: string
        reply: 'once' | 'always' | 'reject'
        worktreePath?: string
        message?: string
      }
    ) => {
      log.info('IPC: opencode:permission:reply', { requestId, reply })
      try {
        await openCodeService.permissionReply(requestId, reply, worktreePath, message)
        return { success: true }
      } catch (error) {
        log.error('IPC: opencode:permission:reply failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // List all pending permission requests
  ipcMain.handle(
    'opencode:permission:list',
    async (_event, { worktreePath }: { worktreePath?: string }) => {
      log.info('IPC: opencode:permission:list')
      try {
        const permissions = await openCodeService.permissionList(worktreePath)
        return { success: true, permissions }
      } catch (error) {
        log.error('IPC: opencode:permission:list failed', { error })
        return {
          success: false,
          permissions: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Rename a session's title via the OpenCode PATCH API
  ipcMain.handle(
    'opencode:renameSession',
    async (
      _event,
      {
        opencodeSessionId,
        title,
        worktreePath
      }: { opencodeSessionId: string; title: string; worktreePath?: string }
    ) => {
      log.info('IPC: opencode:renameSession', { opencodeSessionId, title })
      try {
        await openCodeService.renameSession(opencodeSessionId, title, worktreePath)
        return { success: true }
      } catch (error) {
        log.error('IPC: opencode:renameSession failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Fork an existing OpenCode session at an optional message boundary
  ipcMain.handle(
    'opencode:fork',
    async (
      _event,
      {
        worktreePath,
        sessionId,
        messageId
      }: { worktreePath: string; sessionId: string; messageId?: string }
    ) => {
      log.info('IPC: opencode:fork', { worktreePath, sessionId, messageId })
      try {
        const result = await openCodeService.forkSession(worktreePath, sessionId, messageId)
        return { success: true, ...result }
      } catch (error) {
        log.error('IPC: opencode:fork failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Get messages from an OpenCode session
  ipcMain.handle(
    'opencode:messages',
    async (_event, worktreePath: string, opencodeSessionId: string) => {
      log.info('IPC: opencode:messages', { worktreePath, opencodeSessionId })
      try {
        // SDK-aware dispatch: route Claude sessions to ClaudeCodeImplementer
        if (sdkManager && dbService) {
          const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
          if (sdkId === 'claude-code') {
            const impl = sdkManager.getImplementer('claude-code')
            const messages = await impl.getMessages(worktreePath, opencodeSessionId)
            return { success: true, messages }
          }
        }
        // Fall through to existing OpenCode path
        const messages = await openCodeService.getMessages(worktreePath, opencodeSessionId)
        return { success: true, messages }
      } catch (error) {
        log.error('IPC: opencode:messages failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          messages: []
        }
      }
    }
  )

  // Abort a streaming session
  ipcMain.handle(
    'opencode:abort',
    async (_event, worktreePath: string, opencodeSessionId: string) => {
      log.info('IPC: opencode:abort', { worktreePath, opencodeSessionId })
      try {
        // SDK-aware dispatch: route Claude sessions to ClaudeCodeImplementer
        if (sdkManager && dbService) {
          const sdkId = dbService.getAgentSdkForSession(opencodeSessionId)
          if (sdkId === 'claude-code') {
            const impl = sdkManager.getImplementer('claude-code')
            const result = await impl.abort(worktreePath, opencodeSessionId)
            return { success: result }
          }
        }
        // Fall through to existing OpenCode path
        const result = await openCodeService.abort(worktreePath, opencodeSessionId)
        return { success: result }
      } catch (error) {
        log.error('IPC: opencode:abort failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  log.info('OpenCode IPC handlers registered')
}

export async function cleanupOpenCode(): Promise<void> {
  log.info('Cleaning up OpenCode service')
  await openCodeService.cleanup()
}
