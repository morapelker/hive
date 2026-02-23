import { ipcMain, dialog, shell, clipboard, BrowserWindow, app } from 'electron'
import { existsSync, readdirSync, copyFileSync, unlinkSync, mkdirSync } from 'fs'
import { join, extname } from 'path'
import { createLogger } from '../services/logger'
import {
  isGitRepository,
  validateProject,
  initRepository,
  detectProjectLanguage,
  loadLanguageIcons,
  getIconDataUrl,
  removeIcon
} from '../services/project-ops'

const log = createLogger({ component: 'ProjectHandlers' })

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
    return validateProject(path)
  })

  // Initialize a new git repository in a directory
  ipcMain.handle(
    'git:init',
    async (_event, path: string): Promise<{ success: boolean; error?: string }> => {
      return initRepository(path)
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
    return loadLanguageIcons()
  })

  // --- Custom Project Icon handlers ---

  const iconDir = join(app.getPath('home'), '.hive', 'project-icons')

  /**
   * Ensure the project-icons directory exists
   */
  function ensureIconDir(): void {
    if (!existsSync(iconDir)) {
      mkdirSync(iconDir, { recursive: true })
    }
  }

  // Pick a custom project icon via native file dialog, copy to ~/.hive/project-icons/
  ipcMain.handle(
    'project:pickIcon',
    async (
      _event,
      projectId: string
    ): Promise<{ success: boolean; filename?: string; error?: string }> => {
      try {
        const window = BrowserWindow.getFocusedWindow()
        const result = await dialog.showOpenDialog(window!, {
          properties: ['openFile'],
          title: 'Select Project Icon',
          buttonLabel: 'Select Icon',
          filters: [{ name: 'Images', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp'] }]
        })

        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: 'cancelled' }
        }

        const sourcePath = result.filePaths[0]
        const ext = extname(sourcePath).toLowerCase()
        const filename = `${projectId}${ext}`

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

        copyFileSync(sourcePath, join(iconDir, filename))
        log.info('Project icon set', { projectId, filename })

        return { success: true, filename }
      } catch (error) {
        log.error(
          'Failed to pick project icon',
          error instanceof Error ? error : new Error(String(error)),
          { projectId }
        )
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  // Remove a custom project icon
  ipcMain.handle(
    'project:removeIcon',
    async (_event, projectId: string): Promise<{ success: boolean; error?: string }> => {
      return removeIcon(projectId)
    }
  )

  // Resolve an icon filename to a data URL for the renderer
  ipcMain.handle('project:getIconPath', (_event, filename: string): string | null => {
    return getIconDataUrl(filename)
  })
}
