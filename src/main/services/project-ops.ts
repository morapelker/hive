import { app } from 'electron'
import {
  existsSync,
  statSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync
} from 'fs'
import { join, basename, extname } from 'path'
import { createLogger } from './logger'
import { getDatabase } from '../db'
import type { DatabaseService } from '../db/database'
import type { Project, ProjectCreate } from '../db/types'
import {
  getAbsoluteIconDataUrl as getAbsoluteProjectIconDataUrl,
  getProjectIconDataUrl,
  removeProjectIcon
} from './project-icons'

export {
  detectProjectLanguage,
  detectProjectFavicon,
  findXcworkspace,
  isAndroidProject
} from './language-detector'
export { detectSetupSuggestions } from './setup-script-suggester'
export { loadLanguageIcons } from './language-icons'
export { cloneRepository, deriveProjectNameFromGitUrl, initRepository } from './git-repository'

const log = createLogger({ component: 'ProjectOps' })

const MIME_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
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
export function validateProject(path: string): {
  success: boolean
  path?: string
  name?: string
  error?: string
} {
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

export function createProjectWithDefaultWorktree(
  db: Pick<DatabaseService, 'createProject' | 'createWorktree'>,
  data: ProjectCreate
): Project {
  const project = db.createProject(data)
  db.createWorktree({
    project_id: project.id,
    name: '(no-worktree)',
    branch_name: '',
    path: project.path,
    is_default: true
  })
  return project
}

/**
 * Resolve an icon filename to a data URL
 */
export function getIconDataUrl(filename: string): string | null {
  return getProjectIconDataUrl(filename, iconDir)
}

/**
 * Resolve any absolute file path to a base64 data URL.
 * Used for auto-detected favicons stored as absolute paths.
 */
export function getAbsoluteIconDataUrl(absolutePath: string): string | null {
  return getAbsoluteProjectIconDataUrl(absolutePath)
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
 * Remove a custom project icon from disk.
 */
export function removeIcon(projectId: string): { success: boolean; error?: string } {
  return removeProjectIcon(projectId, iconDir)
}
