import { ipcMain } from 'electron'
import { createLogger } from '../services/logger'
import { saveAttachment, deleteAttachment } from '../services/attachment-storage'

const log = createLogger({ component: 'AttachmentHandlers' })

export function registerAttachmentHandlers(): void {
  log.info('Registering attachment handlers')

  ipcMain.handle(
    'attachment:save',
    async (
      _event,
      buffer: Buffer,
      originalName: string
    ): Promise<{ success: boolean; filePath?: string; error?: string }> => {
      return saveAttachment(buffer, originalName)
    }
  )

  ipcMain.handle(
    'attachment:delete',
    async (
      _event,
      filePath: string
    ): Promise<{ success: boolean; error?: string }> => {
      return deleteAttachment(filePath)
    }
  )
}
