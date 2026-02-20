import { app } from 'electron'
import {
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync
} from 'fs'
import { execSync } from 'child_process'
import { join, basename, extname } from 'path'
import { createLogger } from './logger'
import { getDatabase } from '../db'

export { detectProjectLanguage } from './language-detector'

const log = createLogger({ component: 'ProjectOps' })

const MIME_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

const iconDir = join(app.getPath('home'), '.hive', 'project-icons')

/**
 * Ensure the project-icons directory exists
 */
function ensureIconDir(): void {
  if (!existsSync(iconDir)) {
    mkdirSync(iconDir, { recursive: true })
  }
}

/**
 * Check if a directory is a git repository by looking for .git folder
 */
export function isGitRepository(path: string): boolean {
  try {
    const gitPath = join(path, '.git')
    return existsSync(gitPath) && statSync(gitPath).isDirectory()
  } catch {
    return false
  }
}

/**
 * Check if a path is a valid directory
 */
export function isValidDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Validate a project path: checks it is a valid directory and a git repository.
 * Returns project info on success.
 */
export function validateProject(
  path: string
): { success: boolean; path?: string; name?: string; error?: string } {
  if (!isValidDirectory(path)) {
    return {
      success: false,
      error: 'The selected path is not a valid directory.'
    }
  }

  if (!isGitRepository(path)) {
    return {
      success: false,
      error:
        'The selected folder is not a Git repository. Please select a folder containing a .git directory.'
    }
  }

  return {
    success: true,
    path: path,
    name: basename(path)
  }
}

/**
 * Initialize a new git repository with main as the default branch
 */
export function initRepository(path: string): { success: boolean; error?: string } {
  try {
    log.info('Initializing git repository', { path })
    execSync('git init --initial-branch=main', { cwd: path, encoding: 'utf-8' })
    log.info('Git repository initialized successfully', { path })
    return { success: true }
  } catch (error) {
    log.error(
      'Failed to initialize git repository',
      error instanceof Error ? error : new Error(String(error)),
      { path }
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Load custom language icons from the language_icons setting as data URLs
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

/**
 * Resolve an icon filename to a data URL
 */
export function getIconDataUrl(filename: string): string | null {
  if (!filename) return null
  const fullPath = join(iconDir, filename)
  if (!existsSync(fullPath)) return null

  try {
    const ext = extname(filename).toLowerCase()
    const mime = MIME_TYPES[ext]
    if (!mime) return null

    const data = readFileSync(fullPath)
    return `data:${mime};base64,${data.toString('base64')}`
  } catch (err) {
    log.warn('Failed to read project icon', {
      filename,
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

/**
 * Upload a project icon from base64 data (for mobile/GraphQL API).
 * Saves the file to ~/.hive/project-icons/ and updates the DB custom_icon field.
 */
export function uploadIcon(
  projectId: string,
  base64Data: string,
  filename: string
): { success: boolean; error?: string } {
  try {
    const ext = extname(filename).toLowerCase()
    const mime = MIME_TYPES[ext]
    if (!mime) {
      return { success: false, error: `Unsupported file type: ${ext}` }
    }

    const destFilename = `${projectId}${ext}`
    ensureIconDir()

    // Remove any previous icon for this project (different extension)
    const existing = readdirSync(iconDir).filter((f) => f.startsWith(`${projectId}.`))
    for (const old of existing) {
      try {
        unlinkSync(join(iconDir, old))
      } catch {
        // ignore cleanup errors
      }
    }

    const buffer = Buffer.from(base64Data, 'base64')
    writeFileSync(join(iconDir, destFilename), buffer)

    // Update the project record in the database
    const db = getDatabase()
    db.updateProject(projectId, { custom_icon: destFilename })

    log.info('Project icon uploaded', { projectId, filename: destFilename })
    return { success: true }
  } catch (error) {
    log.error(
      'Failed to upload project icon',
      error instanceof Error ? error : new Error(String(error)),
      { projectId }
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Remove a custom project icon from disk and clear the DB field
 */
export function removeIcon(projectId: string): { success: boolean; error?: string } {
  try {
    ensureIconDir()
    const existing = readdirSync(iconDir).filter((f) => f.startsWith(`${projectId}.`))
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
