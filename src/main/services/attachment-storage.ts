import { app } from 'electron'
import { join, resolve } from 'path'
import { mkdir, writeFile, unlink, access } from 'fs/promises'
import { randomUUID } from 'crypto'
import { createLogger } from './logger'

const log = createLogger({ component: 'AttachmentStorage' })

const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

async function getAttachmentsDir(): Promise<string> {
  const dir = join(app.getPath('home'), '.hive', 'attachments')
  await mkdir(dir, { recursive: true })
  return dir
}

export async function saveAttachment(
  buffer: Buffer,
  originalName: string
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  try {
    if (buffer.length > MAX_IMAGE_SIZE) {
      return { success: false, error: `Image too large (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)` }
    }

    const ext = originalName.split('.').pop()?.toLowerCase() ?? 'png'
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return { success: false, error: `Unsupported image format: .${ext}` }
    }

    const dir = await getAttachmentsDir()
    const fileName = `${randomUUID()}.${ext}`
    const filePath = join(dir, fileName)

    await writeFile(filePath, buffer)
    log.info('Saved attachment', { filePath, size: buffer.length })

    return { success: true, filePath }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    log.error('Failed to save attachment', new Error(msg))
    return { success: false, error: msg }
  }
}

export async function deleteAttachment(filePath: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Safety: only delete files inside the attachments directory
    const dir = resolve(await getAttachmentsDir())
    const resolved = resolve(filePath)
    if (!resolved.startsWith(dir)) {
      return { success: false, error: 'Path is not inside attachments directory' }
    }
    try {
      await access(resolved)
      await unlink(resolved)
      log.info('Deleted attachment', { filePath: resolved })
    } catch {
      // File does not exist — nothing to delete
    }
    return { success: true }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    log.error('Failed to delete attachment', new Error(msg))
    return { success: false, error: msg }
  }
}
