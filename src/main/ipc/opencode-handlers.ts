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
  ipcMain.handle(
    'opencode:prompt',
    async (_event, worktreePath: string, opencodeSessionId: string, message: string) => {
      log.info('IPC: opencode:prompt', { worktreePath, opencodeSessionId, messageLength: message.length })
      try {
        await openCodeService.prompt(worktreePath, opencodeSessionId, message)
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
