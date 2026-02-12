import { ipcMain, app } from 'electron'
import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
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

  // Read a prompt file from the app's own prompts/ directory
  ipcMain.handle(
    'file:readPrompt',
    async (
      _event,
      promptName: string
    ): Promise<{
      success: boolean
      content?: string
      error?: string
    }> => {
      try {
        if (!promptName || typeof promptName !== 'string') {
          return { success: false, error: 'Invalid prompt name' }
        }

        // In dev: app.getAppPath() is the repo root
        // In production: app.getAppPath() is the asar, prompts are in resources
        const appPath = app.getAppPath()
        let promptPath = join(appPath, 'prompts', promptName)

        if (!existsSync(promptPath)) {
          // Fallback: try resources path (production builds)
          const resourcesPath = join(appPath, '..', 'prompts', promptName)
          if (existsSync(resourcesPath)) {
            promptPath = resourcesPath
          } else {
            return { success: false, error: 'Prompt file not found' }
          }
        }

        const content = readFileSync(promptPath, 'utf-8')
        return { success: true, content }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to read prompt', error instanceof Error ? error : new Error(message), { promptName })
        return { success: false, error: message }
      }
    }
  )
}
