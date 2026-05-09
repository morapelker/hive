import { ipcMain } from 'electron'
import { Data, Effect } from 'effect'
import { z } from 'zod'
import { createLogger } from '../services/logger'
import { readFile, readFileAsBase64, writeFile } from '../services/file-ops'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'FileHandlers' })

class FileReadFailed extends Data.TaggedError('FileReadFailed')<{
  readonly filePath: string
  readonly reason: string
}> {}

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
        log.error('Failed to read file', new Error(result.error ?? 'Unknown error'), { filePath })
      }
      return result
    }
  )

  // file:readImageAsBase64 - migrated to defineHandler (EFFECT_ADOPTION Session 3)
  defineHandler(
    'file:readImageAsBase64',
    z.string().min(1, 'filePath is required'),
    (filePath) =>
      Effect.suspend(() => {
        const result = readFileAsBase64(filePath)
        if (result.success) {
          return Effect.succeed({
            data: result.data!,
            mimeType: result.mimeType
          })
        }
        return Effect.fail(
          new FileReadFailed({
            filePath,
            reason: result.error ?? 'Unknown error'
          })
        )
      })
  )

  ipcMain.handle(
    'file:write',
    async (
      _event,
      filePath: string,
      content: string
    ): Promise<{
      success: boolean
      error?: string
    }> => {
      const result = writeFile(filePath, content)
      if (!result.success) {
        log.error('Failed to write file', new Error(result.error ?? 'Unknown error'), { filePath })
      }
      return result
    }
  )

}
