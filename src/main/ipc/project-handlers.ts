import { ipcMain, dialog, shell, clipboard, BrowserWindow } from 'electron'
import { existsSync, statSync, readFileSync } from 'fs'
import { execSync } from 'child_process'
import { join, basename, extname } from 'path'
import { createLogger } from '../services/logger'
import { detectProjectLanguage } from '../services/language-detector'
import { getDatabase } from '../db'

const log = createLogger({ component: 'ProjectHandlers' })

/**
 * Check if a directory is a git repository by looking for .git folder
 */
function isGitRepository(path: string): boolean {
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
function isValidDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

export interface AddProjectResult {
  success: boolean
  path?: string
  name?: string
  error?: string
}

export function registerProjectHandlers(): void {
  log.info('Registering project handlers')

  // Open folder picker dialog
  ipcMain.handle('dialog:openDirectory', async (): Promise<string | null> => {
    log.debug('Opening directory picker dialog')
    const window = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(window!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Project Folder',
      buttonLabel: 'Add Project'
    })

    if (result.canceled || result.filePaths.length === 0) {
      log.debug('Directory picker canceled')
      return null
    }

    log.info('Directory selected', { path: result.filePaths[0] })
    return result.filePaths[0]
  })

  // Validate if a path is a git repository
  ipcMain.handle('git:isRepository', (_event, path: string): boolean => {
    return isGitRepository(path)
  })

  // Validate and get project info for adding
  ipcMain.handle('project:validate', (_event, path: string): AddProjectResult => {
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
  })

  // Initialize a new git repository in a directory
  ipcMain.handle(
    'git:init',
    async (_event, path: string): Promise<{ success: boolean; error?: string }> => {
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
  )

  // Open path in Finder/Explorer
  ipcMain.handle('shell:showItemInFolder', (_event, path: string): void => {
    shell.showItemInFolder(path)
  })

  // Open path in default file manager
  ipcMain.handle('shell:openPath', async (_event, path: string): Promise<string> => {
    return shell.openPath(path)
  })

  // Copy text to clipboard
  ipcMain.handle('clipboard:writeText', (_event, text: string): void => {
    clipboard.writeText(text)
  })

  // Read text from clipboard
  ipcMain.handle('clipboard:readText', (): string => {
    return clipboard.readText()
  })

  // Detect project language from characteristic files
  ipcMain.handle(
    'project:detectLanguage',
    async (_event, projectPath: string): Promise<string | null> => {
      log.debug('Detecting project language', { projectPath })
      return detectProjectLanguage(projectPath)
    }
  )

  // Load custom language icons as data URLs
  ipcMain.handle('project:loadLanguageIcons', (): Record<string, string> => {
    const db = getDatabase()
    const raw = db.getSetting('language_icons')
    if (!raw) return {}

    try {
      const iconPaths: Record<string, string> = JSON.parse(raw)
      const result: Record<string, string> = {}

      const mimeTypes: Record<string, string> = {
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
      }

      for (const [language, filePath] of Object.entries(iconPaths)) {
        try {
          if (!existsSync(filePath)) {
            log.warn('Language icon file not found', { language, filePath })
            continue
          }
          const ext = extname(filePath).toLowerCase()
          const mime = mimeTypes[ext]
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
  })

  // Seed default custom language icons if not already set
  const db = getDatabase()
  if (!db.getSetting('language_icons')) {
    db.setSetting(
      'language_icons',
      JSON.stringify({
        python: '/Users/mor/Desktop/python.svg',
        rust: '/Users/mor/Desktop/rustacean-orig-noshadow.svg',
        go: '/Users/mor/Desktop/golang.png',
        typescript: '/Users/mor/Desktop/typescript.svg'
      })
    )
  }
}
