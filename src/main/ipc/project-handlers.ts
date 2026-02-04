import { ipcMain, dialog, shell, clipboard, BrowserWindow } from 'electron'
import { existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { createLogger } from '../services/logger'

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
        error: 'The selected folder is not a Git repository. Please select a folder containing a .git directory.'
      }
    }

    return {
      success: true,
      path: path,
      name: basename(path)
    }
  })

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
}
