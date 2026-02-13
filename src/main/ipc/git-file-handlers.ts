import { ipcMain, BrowserWindow, shell } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  createGitService,
  GitFileStatus,
  GitStatusCode,
  GitBranchInfo,
  GitCommitResult,
  GitPushResult,
  GitPullResult,
  GitDiffResult,
  GitMergeResult,
  GitDiffStatFile,
  GitDiffStatResult
} from '../services/git-service'
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
    async (_event, worktreePath: string): Promise<GitFileStatusResult> => {
      log.info('Getting file statuses', { worktreePath })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.getFileStatuses()
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to get file statuses',
          error instanceof Error ? error : new Error(message),
          { worktreePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // Stage a file
  ipcMain.handle(
    'git:stageFile',
    async (_event, worktreePath: string, filePath: string): Promise<GitOperationResult> => {
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
        log.error('Failed to stage file', error instanceof Error ? error : new Error(message), {
          worktreePath,
          filePath
        })
        return { success: false, error: message }
      }
    }
  )

  // Unstage a file
  ipcMain.handle(
    'git:unstageFile',
    async (_event, worktreePath: string, filePath: string): Promise<GitOperationResult> => {
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
        log.error('Failed to unstage file', error instanceof Error ? error : new Error(message), {
          worktreePath,
          filePath
        })
        return { success: false, error: message }
      }
    }
  )

  // Discard changes in a file
  ipcMain.handle(
    'git:discardChanges',
    async (_event, worktreePath: string, filePath: string): Promise<GitOperationResult> => {
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
        log.error(
          'Failed to discard changes',
          error instanceof Error ? error : new Error(message),
          { worktreePath, filePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // Add to .gitignore
  ipcMain.handle(
    'git:addToGitignore',
    async (_event, worktreePath: string, pattern: string): Promise<GitOperationResult> => {
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
        log.error(
          'Failed to add to .gitignore',
          error instanceof Error ? error : new Error(message),
          { worktreePath, pattern }
        )
        return { success: false, error: message }
      }
    }
  )

  // Open file in default editor
  ipcMain.handle(
    'git:openInEditor',
    async (_event, filePath: string): Promise<GitOperationResult> => {
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
        log.error('Failed to open in editor', error instanceof Error ? error : new Error(message), {
          filePath
        })
        return { success: false, error: message }
      }
    }
  )

  // Show file in Finder
  ipcMain.handle(
    'git:showInFinder',
    async (_event, filePath: string): Promise<GitOperationResult> => {
      log.info('Showing in Finder', { filePath })
      try {
        shell.showItemInFolder(filePath)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to show in Finder', error instanceof Error ? error : new Error(message), {
          filePath
        })
        return { success: false, error: message }
      }
    }
  )

  // Get branch info (name, tracking, ahead/behind)
  ipcMain.handle(
    'git:branchInfo',
    async (_event, worktreePath: string): Promise<GitBranchInfoResult> => {
      log.info('Getting branch info', { worktreePath })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.getBranchInfo()
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to get branch info',
          error instanceof Error ? error : new Error(message),
          { worktreePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // Stage all modified and untracked files
  ipcMain.handle(
    'git:stageAll',
    async (_event, worktreePath: string): Promise<GitOperationResult> => {
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
        log.error(
          'Failed to stage all files',
          error instanceof Error ? error : new Error(message),
          { worktreePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // Unstage all staged files
  ipcMain.handle(
    'git:unstageAll',
    async (_event, worktreePath: string): Promise<GitOperationResult> => {
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
        log.error(
          'Failed to unstage all files',
          error instanceof Error ? error : new Error(message),
          { worktreePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // Commit staged changes
  ipcMain.handle(
    'git:commit',
    async (_event, worktreePath: string, message: string): Promise<GitCommitResult> => {
      log.info('Committing changes', { worktreePath })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.commit(message)

        // Emit status change event
        if (result.success && mainWindow) {
          mainWindow.webContents.send('git:statusChanged', { worktreePath })
        }

        return result
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to commit', error instanceof Error ? error : new Error(errMessage), {
          worktreePath
        })
        return { success: false, error: errMessage }
      }
    }
  )

  // Push to remote
  ipcMain.handle(
    'git:push',
    async (
      _event,
      worktreePath: string,
      remote?: string,
      branch?: string,
      force?: boolean
    ): Promise<GitPushResult> => {
      log.info('Pushing to remote', { worktreePath, remote, branch, force })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.push(remote, branch, force)

        // Emit status change event to update ahead/behind counts
        if (result.success && mainWindow) {
          mainWindow.webContents.send('git:statusChanged', { worktreePath })
        }

        return result
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to push', error instanceof Error ? error : new Error(errMessage), {
          worktreePath
        })
        return { success: false, error: errMessage }
      }
    }
  )

  // Pull from remote
  ipcMain.handle(
    'git:pull',
    async (
      _event,
      worktreePath: string,
      remote?: string,
      branch?: string,
      rebase?: boolean
    ): Promise<GitPullResult> => {
      log.info('Pulling from remote', { worktreePath, remote, branch, rebase })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.pull(remote, branch, rebase)

        // Emit status change event
        if (result.success && mainWindow) {
          mainWindow.webContents.send('git:statusChanged', { worktreePath })
        }

        return result
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to pull', error instanceof Error ? error : new Error(errMessage), {
          worktreePath
        })
        return { success: false, error: errMessage }
      }
    }
  )

  // Merge a branch into the current branch
  ipcMain.handle(
    'git:merge',
    async (_event, worktreePath: string, sourceBranch: string): Promise<GitMergeResult> => {
      log.info('Merging branch', { worktreePath, sourceBranch })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.merge(sourceBranch)

        // Emit status change event after merge
        if (result.success && mainWindow) {
          mainWindow.webContents.send('git:statusChanged', { worktreePath })
        }

        return result
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : String(error)
        log.error('Failed to merge', error instanceof Error ? error : new Error(errMessage), {
          worktreePath,
          sourceBranch
        })
        return { success: false, error: errMessage }
      }
    }
  )

  // Get remote URL for a worktree
  ipcMain.handle(
    'git:getRemoteUrl',
    async (
      _event,
      { worktreePath, remote = 'origin' }: { worktreePath: string; remote?: string }
    ) => {
      log.info('Getting remote URL', { worktreePath, remote })
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getRemoteUrl(remote)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to get remote URL', error instanceof Error ? error : new Error(message), {
          worktreePath,
          remote
        })
        return { success: false, url: null, remote: null, error: message }
      }
    }
  )

  // Get diff for a file
  ipcMain.handle(
    'git:diff',
    async (
      _event,
      worktreePath: string,
      filePath: string,
      staged: boolean,
      isUntracked: boolean,
      contextLines?: number
    ): Promise<GitDiffResult> => {
      log.info('Getting diff', { worktreePath, filePath, staged, isUntracked, contextLines })
      try {
        const gitService = createGitService(worktreePath)

        // For untracked files, use special method
        if (isUntracked) {
          return await gitService.getUntrackedFileDiff(filePath)
        }

        return await gitService.getDiff(filePath, staged, contextLines)
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to get diff', error instanceof Error ? error : new Error(errMessage), {
          worktreePath,
          filePath
        })
        return { success: false, error: errMessage }
      }
    }
  )

  // Get raw file content from disk
  ipcMain.handle(
    'git:getFileContent',
    async (
      _event,
      { worktreePath, filePath }: { worktreePath: string; filePath: string }
    ): Promise<{ success: boolean; content: string | null; error?: string }> => {
      log.info('Getting file content', { worktreePath, filePath })
      try {
        const fullPath = join(worktreePath, filePath)
        const content = await readFile(fullPath, 'utf-8')
        return { success: true, content }
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : String(error)
        log.error(
          'Failed to get file content',
          error instanceof Error ? error : new Error(errMessage),
          { worktreePath, filePath }
        )
        return { success: false, content: null, error: errMessage }
      }
    }
  )

  // Get diff stat (additions/deletions per file) for all uncommitted changes
  ipcMain.handle(
    'git:diffStat',
    async (_event, worktreePath: string): Promise<GitDiffStatResult> => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getDiffStat()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to get diff stat', error instanceof Error ? error : new Error(message), {
          worktreePath
        })
        return { success: false, error: message }
      }
    }
  )
}

// Export types for use in preload
export type {
  GitFileStatus,
  GitStatusCode,
  GitBranchInfo,
  GitCommitResult,
  GitPushResult,
  GitPullResult,
  GitDiffResult,
  GitMergeResult,
  GitDiffStatFile,
  GitDiffStatResult
}
