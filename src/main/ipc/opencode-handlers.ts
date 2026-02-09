import { ipcMain, BrowserWindow } from 'electron'
import { openCodeService } from '../services/opencode-service'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'OpenCodeHandlers' })

export function registerOpenCodeHandlers(mainWindow: BrowserWindow): void {
  // Set the main window for event forwarding
  openCodeService.setMainWindow(mainWindow)

  // Connect to OpenCode for a worktree (lazy starts server if needed)
  ipcMain.handle(
    'opencode:connect',
    async (_event, worktreePath: string, hiveSessionId: string) => {
      log.info('IPC: opencode:connect', { worktreePath, hiveSessionId })
      try {
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
        const result = await openCodeService.reconnect(worktreePath, opencodeSessionId, hiveSessionId)
        return result
      } catch (error) {
        log.error('IPC: opencode:reconnect failed', { error })
        return { success: false }
      }
    }
  )

  // Send a prompt (response streams via onStream)
  // Accepts either { worktreePath, sessionId, parts } object or positional (worktreePath, sessionId, message) for backward compat
  ipcMain.handle(
    'opencode:prompt',
    async (_event, ...args: unknown[]) => {
      let worktreePath: string
      let opencodeSessionId: string
      let messageOrParts: string | Array<{ type: string; text?: string; mime?: string; url?: string; filename?: string }>

      // Support object-style call: { worktreePath, sessionId, parts }
      if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
        const obj = args[0] as Record<string, unknown>
        worktreePath = obj.worktreePath as string
        opencodeSessionId = obj.sessionId as string
        // Backward compat: accept message string or parts array
        messageOrParts = (obj.parts as typeof messageOrParts) || [{ type: 'text', text: obj.message as string }]
      } else {
        // Legacy positional args: (worktreePath, sessionId, message)
        worktreePath = args[0] as string
        opencodeSessionId = args[1] as string
        messageOrParts = args[2] as string
      }

      log.info('IPC: opencode:prompt', { worktreePath, opencodeSessionId, partsCount: Array.isArray(messageOrParts) ? messageOrParts.length : 1 })
      try {
        await openCodeService.prompt(worktreePath, opencodeSessionId, messageOrParts)
        return { success: true }
      } catch (error) {
        log.error('IPC: opencode:prompt failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Disconnect session (may kill server if last session for worktree)
  ipcMain.handle(
    'opencode:disconnect',
    async (_event, worktreePath: string, opencodeSessionId: string) => {
      log.info('IPC: opencode:disconnect', { worktreePath, opencodeSessionId })
      try {
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
  ipcMain.handle('opencode:models', async () => {
    log.info('IPC: opencode:models')
    try {
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
  })

  // Set the selected model
  ipcMain.handle(
    'opencode:setModel',
    async (_event, model: { providerID: string; modelID: string }) => {
      log.info('IPC: opencode:setModel', { model })
      try {
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

  // Generate a descriptive session name using Claude Haiku via OpenCode
  ipcMain.handle(
    'opencode:generateSessionName',
    async (_event, message: string, worktreePath: string) => {
      log.info('Session naming: IPC request received', { messageLength: message?.length, worktreePath })
      try {
        const name = await openCodeService.generateSessionName(message, worktreePath)
        log.info('Session naming: IPC returning result', { name, success: !!name })
        return { success: true, name }
      } catch (error) {
        log.error('Session naming: IPC handler failed', { error })
        return {
          success: false,
          name: '',
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Get model info (name, context limit)
  ipcMain.handle(
    'opencode:modelInfo',
    async (_event, { worktreePath, modelId }: { worktreePath: string; modelId: string }) => {
      log.info('IPC: opencode:modelInfo', { worktreePath, modelId })
      try {
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

  // List available slash commands
  ipcMain.handle(
    'opencode:commands',
    async (_event, { worktreePath }: { worktreePath: string }) => {
      log.info('IPC: opencode:commands', { worktreePath })
      try {
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

  // Get messages from an OpenCode session
  ipcMain.handle(
    'opencode:messages',
    async (_event, worktreePath: string, opencodeSessionId: string) => {
      log.info('IPC: opencode:messages', { worktreePath, opencodeSessionId })
      try {
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

  log.info('OpenCode IPC handlers registered')
}

export async function cleanupOpenCode(): Promise<void> {
  log.info('Cleaning up OpenCode service')
  await openCodeService.cleanup()
}
