import { ipcMain } from 'electron'
import { createLogger } from '../services/logger'
import { readFile, readPromptFile } from '../services/file-ops'

const log = createLogger({ component: 'FileHandlers' })

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
      const result = readFile(filePath)
      if (!result.success) {
        log.error(
          'Failed to read file',
          new Error(result.error ?? 'Unknown error'),
          { filePath }
        )
      }
      return result
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
      const result = readPromptFile(promptName)
      if (!result.success) {
        log.error(
          'Failed to read prompt',
          new Error(result.error ?? 'Unknown error'),
          { promptName }
        )
      }
      return result
    }
  )
}
