import { ipcMain, BrowserWindow } from 'electron'
import { bashService } from '../services/bash-service'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'BashHandlers' })

export function registerBashHandlers(mainWindow: BrowserWindow): void {
  bashService.setMainWindow(mainWindow)

  ipcMain.handle(
    'bash:run',
    async (_event, payload: { sessionId: string; command: string; cwd: string }) => {
      log.info('IPC: bash:run', {
        sessionId: payload.sessionId,
        command: payload.command,
        cwd: payload.cwd
      })
      try {
        const result = await bashService.run(payload.sessionId, payload.command, payload.cwd)
        return { success: true, ...result }
      } catch (error) {
        log.error('IPC: bash:run failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  ipcMain.handle('bash:abort', async (_event, sessionId: string) => {
    log.info('IPC: bash:abort', { sessionId })
    return bashService.abort(sessionId)
  })

  ipcMain.handle('bash:getRun', async (_event, sessionId: string) => {
    return bashService.getRun(sessionId)
  })
}
