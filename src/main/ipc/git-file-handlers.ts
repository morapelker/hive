import { ipcMain, BrowserWindow, shell } from 'electron'
import { createGitService, GitFileStatus, GitStatusCode, GitBranchInfo } from '../services/git-service'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'GitFileHandlers' })

// Main window reference for sending events
let mainWindow: BrowserWindow | null = null

export interface GitFileStatusResult {
  success: boolean
  files?: GitFileStatus[]
  error?: string
}

export interface GitOperationResult {
  success: boolean
  error?: string
}

export interface GitBranchInfoResult {
  success: boolean
  branch?: GitBranchInfo
  error?: string
}

export function registerGitFileHandlers(window: BrowserWindow): void {
  mainWindow = window
  log.info('Registering git file handlers')

  // Get file statuses for a worktree
  ipcMain.handle(
    'git:fileStatuses',
    async (
      _event,
      worktreePath: string
    ): Promise<GitFileStatusResult> => {
      log.info('Getting file statuses', { worktreePath })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.getFileStatuses()
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to get file statuses', error instanceof Error ? error : new Error(message), { worktreePath })
        return { success: false, error: message }
      }
    }
  )

  // Stage a file
  ipcMain.handle(
    'git:stageFile',
    async (
      _event,
      worktreePath: string,
      filePath: string
    ): Promise<GitOperationResult> => {
      log.info('Staging file', { worktreePath, filePath })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.stageFile(filePath)

        // Emit status change event
        if (result.success && mainWindow) {
          mainWindow.webContents.send('git:statusChanged', { worktreePath })
        }

        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to stage file', error instanceof Error ? error : new Error(message), { worktreePath, filePath })
        return { success: false, error: message }
      }
    }
  )

  // Unstage a file
  ipcMain.handle(
    'git:unstageFile',
    async (
      _event,
      worktreePath: string,
      filePath: string
    ): Promise<GitOperationResult> => {
      log.info('Unstaging file', { worktreePath, filePath })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.unstageFile(filePath)

        // Emit status change event
        if (result.success && mainWindow) {
          mainWindow.webContents.send('git:statusChanged', { worktreePath })
        }

        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to unstage file', error instanceof Error ? error : new Error(message), { worktreePath, filePath })
        return { success: false, error: message }
      }
    }
  )

  // Discard changes in a file
  ipcMain.handle(
    'git:discardChanges',
    async (
      _event,
      worktreePath: string,
      filePath: string
    ): Promise<GitOperationResult> => {
      log.info('Discarding changes', { worktreePath, filePath })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.discardChanges(filePath)

        // Emit status change event
        if (result.success && mainWindow) {
          mainWindow.webContents.send('git:statusChanged', { worktreePath })
        }

        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to discard changes', error instanceof Error ? error : new Error(message), { worktreePath, filePath })
        return { success: false, error: message }
      }
    }
  )

  // Add to .gitignore
  ipcMain.handle(
    'git:addToGitignore',
    async (
      _event,
      worktreePath: string,
      pattern: string
    ): Promise<GitOperationResult> => {
      log.info('Adding to .gitignore', { worktreePath, pattern })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.addToGitignore(pattern)

        // Emit status change event
        if (result.success && mainWindow) {
          mainWindow.webContents.send('git:statusChanged', { worktreePath })
        }

        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to add to .gitignore', error instanceof Error ? error : new Error(message), { worktreePath, pattern })
        return { success: false, error: message }
      }
    }
  )

  // Open file in default editor
  ipcMain.handle(
    'git:openInEditor',
    async (
      _event,
      filePath: string
    ): Promise<GitOperationResult> => {
      log.info('Opening in editor', { filePath })
      try {
        const result = await shell.openPath(filePath)
        if (result) {
          // shell.openPath returns an error message if it fails, empty string on success
          return { success: false, error: result }
        }
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to open in editor', error instanceof Error ? error : new Error(message), { filePath })
        return { success: false, error: message }
      }
    }
  )

  // Show file in Finder
  ipcMain.handle(
    'git:showInFinder',
    async (
      _event,
      filePath: string
    ): Promise<GitOperationResult> => {
      log.info('Showing in Finder', { filePath })
      try {
        shell.showItemInFolder(filePath)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to show in Finder', error instanceof Error ? error : new Error(message), { filePath })
        return { success: false, error: message }
      }
    }
  )

  // Get branch info (name, tracking, ahead/behind)
  ipcMain.handle(
    'git:branchInfo',
    async (
      _event,
      worktreePath: string
    ): Promise<GitBranchInfoResult> => {
      log.info('Getting branch info', { worktreePath })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.getBranchInfo()
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to get branch info', error instanceof Error ? error : new Error(message), { worktreePath })
        return { success: false, error: message }
      }
    }
  )

  // Stage all modified and untracked files
  ipcMain.handle(
    'git:stageAll',
    async (
      _event,
      worktreePath: string
    ): Promise<GitOperationResult> => {
      log.info('Staging all files', { worktreePath })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.stageAll()

        // Emit status change event
        if (result.success && mainWindow) {
          mainWindow.webContents.send('git:statusChanged', { worktreePath })
        }

        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to stage all files', error instanceof Error ? error : new Error(message), { worktreePath })
        return { success: false, error: message }
      }
    }
  )

  // Unstage all staged files
  ipcMain.handle(
    'git:unstageAll',
    async (
      _event,
      worktreePath: string
    ): Promise<GitOperationResult> => {
      log.info('Unstaging all files', { worktreePath })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.unstageAll()

        // Emit status change event
        if (result.success && mainWindow) {
          mainWindow.webContents.send('git:statusChanged', { worktreePath })
        }

        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to unstage all files', error instanceof Error ? error : new Error(message), { worktreePath })
        return { success: false, error: message }
      }
    }
  )
}

// Export types for use in preload
export type { GitFileStatus, GitStatusCode, GitBranchInfo }
