import { Effect } from 'effect'
import { z } from 'zod'
import { isDesktopCommandResult, makeDesktopCommandRequest } from '../../../shared/desktop-command'
import type { RpcHandler } from '../router'

export interface AttachmentDeleteResult {
  readonly success: boolean
  readonly error?: string
}

export interface AttachmentSaveResult {
  readonly success: boolean
  readonly filePath?: string
  readonly error?: string
}

export interface AttachmentOpsRpcService {
  readonly saveImage: (
    dataBase64: string,
    originalName: string
  ) => Effect.Effect<AttachmentSaveResult, unknown, never>
  readonly deleteImage: (filePath: string) => Effect.Effect<AttachmentDeleteResult, unknown, never>
}

const saveImageParamsSchema = z
  .object({
    dataBase64: z.string().min(1),
    originalName: z.string().min(1)
  })
  .strict()
const deleteImageParamsSchema = z.object({ filePath: z.string().min(1) }).strict()

export const makeLiveAttachmentOpsRpcService = (): AttachmentOpsRpcService => ({
  saveImage: (dataBase64, originalName) =>
    Effect.tryPromise({
      try: () => requestSaveAttachmentCommand(dataBase64, originalName),
      catch: (cause) => cause
    }),
  deleteImage: (filePath) =>
    Effect.tryPromise({
      try: () => requestDeleteAttachmentCommand(filePath),
      catch: (cause) => cause
    })
})

export const makeAttachmentOpsRpcHandlers = (
  service: AttachmentOpsRpcService = makeLiveAttachmentOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'attachmentOps.saveImage',
      (params) =>
        Effect.gen(function* () {
          const { dataBase64, originalName } = yield* Effect.try({
            try: () => saveImageParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.saveImage(dataBase64, originalName)
        })
    ],
    [
      'attachmentOps.deleteImage',
      (params) =>
        Effect.gen(function* () {
          const { filePath } = yield* Effect.try({
            try: () => deleteImageParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.deleteImage(filePath)
        })
    ]
  ])

const requestSaveAttachmentCommand = (
  dataBase64: string,
  originalName: string
): Promise<AttachmentSaveResult> => {
  const send = process.send
  if (typeof send !== 'function') {
    return import('../../../main/services/attachment-storage').then(({ saveAttachment }) =>
      saveAttachment(Buffer.from(dataBase64, 'base64'), originalName)
    )
  }

  const command = 'saveAttachment'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<AttachmentSaveResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        const value = message.value
        if (
          typeof value === 'object' &&
          value !== null &&
          'success' in value &&
          typeof value.success === 'boolean'
        ) {
          resolve(value as AttachmentSaveResult)
          return
        }
        reject(new Error(`Desktop command returned invalid response: ${command}`))
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, { dataBase64, originalName }),
      (error) => {
        if (!error) return
        cleanup()
        reject(error)
      }
    )
  })
}

const requestDeleteAttachmentCommand = (filePath: string): Promise<AttachmentDeleteResult> => {
  const send = process.send
  if (typeof send !== 'function') {
    return import('../../../main/services/attachment-storage').then(({ deleteAttachment }) =>
      deleteAttachment(filePath)
    )
  }

  const command = 'deleteAttachment'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<AttachmentDeleteResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        const value = message.value
        if (
          typeof value === 'object' &&
          value !== null &&
          'success' in value &&
          typeof value.success === 'boolean'
        ) {
          resolve(value as AttachmentDeleteResult)
          return
        }
        reject(new Error(`Desktop command returned invalid response: ${command}`))
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { filePath }), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}
