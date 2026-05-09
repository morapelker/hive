import { Data, Effect } from 'effect'
import { z } from 'zod'

import { createLogger } from '../services/logger'
import { saveAttachment, deleteAttachment } from '../services/attachment-storage'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'AttachmentHandlers' })

class AttachmentHandlerFailed extends Data.TaggedError('AttachmentHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const toMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const attachmentFailed = (operation: string, cause: unknown): AttachmentHandlerFailed => {
  const message = toMessage(cause)
  return new AttachmentHandlerFailed({ operation, reason: message, message })
}

const attachmentBufferSchema = z.union([
  z.instanceof(Buffer),
  z.instanceof(Uint8Array).transform((value) => Buffer.from(value))
])

export function registerAttachmentHandlers(): void {
  log.info('Registering attachment handlers')

  defineHandler(
    'attachment:save',
    z.tuple([attachmentBufferSchema, z.string().min(1, 'originalName is required')]),
    ([buffer, originalName]) =>
      Effect.tryPromise({
        try: () => saveAttachment(buffer, originalName),
        catch: (cause) => attachmentFailed('attachment:save', cause)
      })
  )

  defineHandler('attachment:delete', z.string().min(1, 'filePath is required'), (filePath) =>
    Effect.tryPromise({
      try: () => deleteAttachment(filePath),
      catch: (cause) => attachmentFailed('attachment:delete', cause)
    })
  )
}
