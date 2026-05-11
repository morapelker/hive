import { Data, Effect } from 'effect'
import { z } from 'zod'
import { createLogger } from '../services/logger'
import { readFile, readFileAsBase64, writeFile } from '../services/file-ops'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'FileHandlers' })

class FileReadFailed extends Data.TaggedError('FileReadFailed')<{
  readonly filePath: string
  readonly reason: string
  readonly message: string
}> {}

class FileWriteFailed extends Data.TaggedError('FileWriteFailed')<{
  readonly filePath: string
  readonly reason: string
  readonly message: string
}> {}

const fileReadFailed = (filePath: string, reason: string): FileReadFailed =>
  new FileReadFailed({ filePath, reason, message: reason })

const fileWriteFailed = (filePath: string, reason: string): FileWriteFailed =>
  new FileWriteFailed({ filePath, reason, message: reason })

export function registerFileHandlers(): void {
  log.info('Registering file handlers')

  defineHandler('file:read', z.string().min(1, 'filePath is required'), (filePath) =>
    Effect.sync(() => {
      const result = readFile(filePath)
      if (!result.success) {
        log.error('Failed to read file', new Error(result.error ?? 'Unknown error'), { filePath })
      }
      return result
    })
  )

  // file:readImageAsBase64 - migrated to defineHandler (EFFECT_ADOPTION Session 3)
  defineHandler('file:readImageAsBase64', z.string().min(1, 'filePath is required'), (filePath) =>
    Effect.suspend(() => {
      const result = readFileAsBase64(filePath)
      if (result.success) {
        return Effect.succeed({
          data: result.data!,
          mimeType: result.mimeType
        })
      }
      return Effect.fail(fileReadFailed(filePath, result.error ?? 'Unknown error'))
    })
  )

  // file:write - migrated to defineHandler (EFFECT_ADOPTION Session 3)
  defineHandler(
    'file:write',
    z.tuple([z.string().min(1, 'filePath is required'), z.string()]),
    ([filePath, content]) =>
      Effect.suspend(() => {
        const result = writeFile(filePath, content)
        if (result.success) return Effect.succeed(null)
        return Effect.fail(fileWriteFailed(filePath, result.error ?? 'Unknown error'))
      })
  )
}
