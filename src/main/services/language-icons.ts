import { existsSync, readFileSync } from 'fs'
import { extname } from 'path'
import { getDatabase } from '../db'
import { createLogger } from './logger'

const log = createLogger({ component: 'LanguageIcons' })

const MIME_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
}

/**
 * Load custom language icons from the language_icons setting as data URLs.
 */
export function loadLanguageIcons(): Record<string, string> {
  const db = getDatabase()
  const raw = db.getSetting('language_icons')
  if (!raw) return {}

  try {
    const iconPaths: Record<string, string> = JSON.parse(raw)
    const result: Record<string, string> = {}

    for (const [language, filePath] of Object.entries(iconPaths)) {
      try {
        if (!existsSync(filePath)) {
          log.warn('Language icon file not found', { language, filePath })
          continue
        }
        const ext = extname(filePath).toLowerCase()
        const mime = MIME_TYPES[ext]
        if (!mime) {
          log.warn('Unsupported icon file type', { language, filePath, ext })
          continue
        }
        const data = readFileSync(filePath)
        result[language] = `data:${mime};base64,${data.toString('base64')}`
      } catch (err) {
        log.warn('Failed to read language icon', {
          language,
          filePath,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    return result
  } catch {
    log.warn('Failed to parse language_icons setting')
    return {}
  }
}
