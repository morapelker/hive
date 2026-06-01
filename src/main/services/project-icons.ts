import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs'
import { extname, join } from 'path'
import { createLogger } from './logger'

const log = createLogger({ component: 'ProjectIcons' })

const MIME_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
}

export interface PickProjectIconResult {
  readonly success: boolean
  readonly filename?: string
  readonly error?: string
}

export interface RemoveProjectIconResult {
  readonly success: boolean
  readonly error?: string
}

export function getProjectIconDataUrl(filename: string, iconDir: string): string | null {
  if (!filename) return null
  const fullPath = join(iconDir, filename)
  if (!existsSync(fullPath)) return null

  try {
    const ext = extname(filename).toLowerCase()
    const mime = MIME_TYPES[ext]
    if (!mime) return null

    const data = readFileSync(fullPath)
    return `data:${mime};base64,${data.toString('base64')}`
  } catch (error) {
    log.warn('Failed to read project icon', {
      filename,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

export function getAbsoluteIconDataUrl(absolutePath: string): string | null {
  if (!absolutePath) return null
  if (!existsSync(absolutePath)) return null

  try {
    const ext = extname(absolutePath).toLowerCase()
    const mime = MIME_TYPES[ext]
    if (!mime) return null

    const data = readFileSync(absolutePath)
    return `data:${mime};base64,${data.toString('base64')}`
  } catch (error) {
    log.warn('Failed to read absolute icon path', {
      absolutePath,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

export function saveProjectIcon(
  projectId: string,
  sourcePath: string,
  iconDir: string
): PickProjectIconResult {
  try {
    const ext = extname(sourcePath).toLowerCase()
    const filename = `${projectId}${ext}`

    if (!existsSync(iconDir)) {
      mkdirSync(iconDir, { recursive: true })
    }

    const existing = readdirSync(iconDir).filter((file) => file.startsWith(`${projectId}.`))
    for (const old of existing) {
      try {
        unlinkSync(join(iconDir, old))
      } catch {
        // ignore cleanup errors
      }
    }

    copyFileSync(sourcePath, join(iconDir, filename))
    log.info('Project icon set', { projectId, filename })

    return { success: true, filename }
  } catch (error) {
    log.error(
      'Failed to save project icon',
      error instanceof Error ? error : new Error(String(error)),
      { projectId }
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function removeProjectIcon(projectId: string, iconDir: string): RemoveProjectIconResult {
  try {
    if (!existsSync(iconDir)) {
      mkdirSync(iconDir, { recursive: true })
    }

    const existing = readdirSync(iconDir).filter((file) => file.startsWith(`${projectId}.`))
    for (const old of existing) {
      unlinkSync(join(iconDir, old))
    }

    log.info('Project icon removed', { projectId })
    return { success: true }
  } catch (error) {
    log.error(
      'Failed to remove project icon',
      error instanceof Error ? error : new Error(String(error)),
      { projectId }
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
