import { ipcMain } from 'electron'
import { readFileSync, existsSync, statSync } from 'fs'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'FileHandlers' })

const MAX_FILE_SIZE = 1024 * 1024 // 1MB

export function registerFileHandlers(): void {
  log.info('Registering file handlers')

  ipcMain.handle(
    'file:read',
    async (
      _event,
      filePath: string
    ): Promise<{
      success: boolean
      content?: string
      error?: string
    }> => {
      try {
        if (!filePath || typeof filePath !== 'string') {
          return { success: false, error: 'Invalid file path' }
        }

        if (!existsSync(filePath)) {
          return { success: false, error: 'File does not exist' }
        }

        const stat = statSync(filePath)
        if (stat.isDirectory()) {
          return { success: false, error: 'Path is a directory' }
        }

        if (stat.size > MAX_FILE_SIZE) {
          return { success: false, error: 'File too large (max 1MB)' }
        }

        const content = readFileSync(filePath, 'utf-8')
        return { success: true, content }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to read file', error instanceof Error ? error : new Error(message), { filePath })
        return { success: false, error: message }
      }
    }
  )
}
