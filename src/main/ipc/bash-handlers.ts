import { ipcMain, BrowserWindow } from 'electron'
import { bashService } from '../effect/bash/facade'
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
        return await bashService.run(payload.sessionId, payload.command, payload.cwd)
      } catch (error) {
        log.error(
          'IPC: bash:run failed',
          error instanceof Error ? error : new Error(String(error))
        )
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  ipcMain.handle('bash:abort', async (_event, sessionId: string) => {
    log.info('IPC: bash:abort', { sessionId })
    try {
      return await bashService.abort(sessionId)
    } catch (error) {
      log.error(
        'IPC: bash:abort failed',
        error instanceof Error ? error : new Error(String(error))
      )
      return false
    }
  })

  ipcMain.handle('bash:getRun', async (_event, sessionId: string) => {
    try {
      return await bashService.getRun(sessionId)
    } catch (error) {
      log.error(
        'IPC: bash:getRun failed',
        error instanceof Error ? error : new Error(String(error))
      )
      return null
    }
  })
}
