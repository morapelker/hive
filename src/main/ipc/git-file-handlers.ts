import { ipcMain, BrowserWindow, shell } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { readFileAsBase64 } from '../services/file-ops'
import { telemetryService } from '../services/telemetry-service'
import { openPathWithPreferredEditor } from './settings-handlers'
import type { PRReviewComment } from '@shared/types/git'
import {
  createGitService,
  parseWorktreeForBranch,
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
import {
  initWorktreeWatcher,
  watchWorktree,
  unwatchWorktree,
  cleanupWorktreeWatchers
} from '../services/worktree-watcher'
import {
  initBranchWatcher,
  watchBranch,
  unwatchBranch,
  cleanupBranchWatchers
} from '../services/branch-watcher'

const execAsync = promisify(exec)

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

// GraphQL query to fetch review threads (inline file comments only)
const PR_REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){baseRefName reviewThreads(first:100){nodes{isResolved isOutdated diffSide comments(first:50){nodes{databaseId body bodyHTML author{login avatarUrl}path line originalLine diffHunk createdAt updatedAt subjectType pullRequestReview{databaseId}}}}}}}}` as const

interface GQLReviewThread {
  isResolved: boolean
  isOutdated: boolean
  diffSide: 'LEFT' | 'RIGHT'
  comments: {
    nodes: Array<{
      databaseId: number
      body: string
      bodyHTML: string
      author: { login: string; avatarUrl: string } | null
      path: string
      line: number | null
      originalLine: number | null
      diffHunk: string
      createdAt: string
      updatedAt: string
      subjectType: 'LINE' | 'FILE'
      pullRequestReview: { databaseId: number } | null
    }>
  }
}

export function registerGitFileHandlers(window: BrowserWindow): void {
  mainWindow = window
  log.info('Registering git file handlers')

  // Initialize watcher services with the main window reference
  initWorktreeWatcher(window)
  initBranchWatcher(window)

  // Start watching a worktree for git changes (filesystem + .git metadata)
  ipcMain.handle(
    'git:watchWorktree',
    async (_event, worktreePath: string): Promise<GitOperationResult> => {
      log.info('Starting worktree watcher', { worktreePath })
      try {
        await watchWorktree(worktreePath)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to start worktree watcher',
          error instanceof Error ? error : new Error(message),
          { worktreePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // Stop watching a worktree
  ipcMain.handle(
    'git:unwatchWorktree',
    async (_event, worktreePath: string): Promise<GitOperationResult> => {
      log.info('Stopping worktree watcher', { worktreePath })
      try {
        await unwatchWorktree(worktreePath)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to stop worktree watcher',
          error instanceof Error ? error : new Error(message),
          { worktreePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // Start watching a worktree's .git/HEAD for branch changes (lightweight, sidebar use)
  ipcMain.handle(
    'git:watchBranch',
    async (_event, worktreePath: string): Promise<GitOperationResult> => {
      try {
        await watchBranch(worktreePath)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to start branch watcher',
          error instanceof Error ? error : new Error(message),
          { worktreePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // Stop watching a worktree's branch
  ipcMain.handle(
    'git:unwatchBranch',
    async (_event, worktreePath: string): Promise<GitOperationResult> => {
      try {
        await unwatchBranch(worktreePath)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to stop branch watcher',
          error instanceof Error ? error : new Error(message),
          { worktreePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // Get file statuses for a worktree
  ipcMain.handle(
    'git:fileStatuses',
    async (_event, worktreePath: string): Promise<GitFileStatusResult> => {
      log.info('Getting file statuses', { worktreePath })
      try {
        // Defense-in-depth: skip git ops for non-git directories (e.g. connection paths)
        if (!existsSync(join(worktreePath, '.git'))) {
          return { success: true, files: [] }
        }
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

  // Open file in user's preferred editor (from Settings)
  ipcMain.handle(
    'git:openInEditor',
    async (_event, filePath: string): Promise<GitOperationResult> => {
      log.info('Opening in editor', { filePath })
      return openPathWithPreferredEditor(filePath)
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

        if (result.success) {
          telemetryService.track('git_commit_made')
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

        if (result.success) {
          telemetryService.track('git_push_made')
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

  // Abort an in-progress merge
  ipcMain.handle(
    'git:mergeAbort',
    async (_event, worktreePath: string): Promise<GitOperationResult> => {
      log.info('Aborting merge', { worktreePath })
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.mergeAbort()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('Failed to abort merge', error instanceof Error ? error : new Error(message), {
          worktreePath
        })
        return { success: false, error: message }
      }
    }
  )

  // Check if a worktree has uncommitted changes (lightweight boolean check)
  ipcMain.handle(
    'git:hasUncommittedChanges',
    async (_event, worktreePath: string): Promise<boolean> => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.hasUncommittedChanges()
      } catch {
        return false
      }
    }
  )

  // Get branch divergence stats (files changed, insertions, deletions, commits ahead)
  ipcMain.handle(
    'git:branchDiffShortStat',
    async (_event, worktreePath: string, baseBranch: string): Promise<{
      success: boolean
      filesChanged: number
      insertions: number
      deletions: number
      commitsAhead: number
      error?: string
    }> => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getBranchDiffShortStat(baseBranch)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('Failed to get branch diff stat', error instanceof Error ? error : new Error(message), {
          worktreePath,
          baseBranch
        })
        return { success: false, filesChanged: 0, insertions: 0, deletions: 0, commitsAhead: 0, error: message }
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

  // Get raw file content from disk as base64 (for binary/image files)
  ipcMain.handle(
    'git:getFileContentBase64',
    async (
      _event,
      { worktreePath, filePath }: { worktreePath: string; filePath: string }
    ): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }> => {
      log.info('Getting file content as base64', { worktreePath, filePath })
      try {
        const fullPath = join(worktreePath, filePath)
        return readFileAsBase64(fullPath)
      } catch (error) {
        const errMessage = error instanceof Error ? error.message : String(error)
        log.error(
          'Failed to get file content as base64',
          error instanceof Error ? error : new Error(errMessage),
          { worktreePath, filePath }
        )
        return { success: false, error: errMessage }
      }
    }
  )

  // Get file content from a specific git ref as base64 (for binary/image files)
  ipcMain.handle(
    'git:getRefContentBase64',
    async (
      _event,
      worktreePath: string,
      ref: string,
      filePath: string
    ): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }> => {
      log.info('Getting ref content as base64', { worktreePath, ref, filePath })
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getRefContentBase64(ref, filePath)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to get ref content as base64',
          error instanceof Error ? error : new Error(message),
          { worktreePath, ref, filePath }
        )
        return { success: false, error: message }
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

  // Merge a PR on GitHub via gh CLI, then sync the local target branch
  ipcMain.handle(
    'git:prMerge',
    async (
      _event,
      worktreePath: string,
      prNumber: number
    ): Promise<{ success: boolean; error?: string }> => {
      log.info('Merging PR via gh CLI', { worktreePath, prNumber })
      try {
        // Step 1: Merge the PR on GitHub
        await execAsync(`gh pr merge ${prNumber} --merge`, { cwd: worktreePath })

        // Step 2: Get the target branch name
        const prInfoResult = await execAsync(
          `gh pr view ${prNumber} --json baseRefName -q '.baseRefName'`,
          { cwd: worktreePath }
        )
        const targetBranch = prInfoResult.stdout.trim()

        // Step 3: Find local worktree on target branch and sync
        const worktreeListResult = await execAsync('git worktree list --porcelain', {
          cwd: worktreePath
        })
        const targetWorktreePath = parseWorktreeForBranch(worktreeListResult.stdout, targetBranch)

        if (targetWorktreePath) {
          const currentBranch = await execAsync('git branch --show-current', {
            cwd: worktreePath
          })
          await execAsync(`git merge ${currentBranch.stdout.trim()}`, {
            cwd: targetWorktreePath
          })
          log.info('Synced local target branch after PR merge', {
            targetBranch,
            targetWorktreePath
          })
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('git:statusChanged', { worktreePath })
        }

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('Failed to merge PR', error instanceof Error ? error : new Error(message), {
          worktreePath,
          prNumber
        })
        return { success: false, error: message }
      }
    }
  )

  // Check if a branch has been fully merged into the current HEAD
  ipcMain.handle(
    'git:isBranchMerged',
    async (
      _event,
      worktreePath: string,
      branch: string
    ): Promise<{ success: boolean; isMerged: boolean }> => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.isBranchMerged(branch)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to check branch merged status',
          error instanceof Error ? error : new Error(message),
          { worktreePath, branch }
        )
        return { success: false, isMerged: false }
      }
    }
  )

  // Delete a local branch
  ipcMain.handle(
    'git:deleteBranch',
    async (
      _event,
      worktreePath: string,
      branchName: string
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.deleteBranch(branchName)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to delete branch', error instanceof Error ? error : new Error(message), {
          worktreePath,
          branchName
        })
        return { success: false, error: message }
      }
    }
  )

  // Get file content from a specific git ref (HEAD, index)
  ipcMain.handle(
    'git:getRefContent',
    async (
      _event,
      worktreePath: string,
      ref: string,
      filePath: string
    ): Promise<{ success: boolean; content?: string; error?: string }> => {
      log.info('Getting ref content', { worktreePath, ref, filePath })
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getRefContent(ref, filePath)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to get ref content',
          error instanceof Error ? error : new Error(message),
          { worktreePath, ref, filePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // Stage a single hunk by applying a patch to the index
  ipcMain.handle(
    'git:stageHunk',
    async (_event, worktreePath: string, patch: string): Promise<GitOperationResult> => {
      log.info('Staging hunk', { worktreePath })
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.stageHunk(patch)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to stage hunk', error instanceof Error ? error : new Error(message), {
          worktreePath
        })
        return { success: false, error: message }
      }
    }
  )

  // Unstage a single hunk by reverse-applying a patch from the index
  ipcMain.handle(
    'git:unstageHunk',
    async (_event, worktreePath: string, patch: string): Promise<GitOperationResult> => {
      log.info('Unstaging hunk', { worktreePath })
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.unstageHunk(patch)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to unstage hunk', error instanceof Error ? error : new Error(message), {
          worktreePath
        })
        return { success: false, error: message }
      }
    }
  )

  // Revert a single hunk in the working tree
  ipcMain.handle(
    'git:revertHunk',
    async (_event, worktreePath: string, patch: string): Promise<GitOperationResult> => {
      log.info('Reverting hunk', { worktreePath })
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.revertHunk(patch)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Failed to revert hunk', error instanceof Error ? error : new Error(message), {
          worktreePath
        })
        return { success: false, error: message }
      }
    }
  )

  // Get list of files changed between current worktree and a branch
  ipcMain.handle(
    'git:branchDiffFiles',
    async (
      _event,
      worktreePath: string,
      branch: string
    ): Promise<{
      success: boolean
      files?: Array<{
        relativePath: string
        status: string
        additions: number
        deletions: number
        binary: boolean
      }>
      error?: string
    }> => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getBranchDiffFiles(branch)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to get branch diff files',
          error instanceof Error ? error : new Error(message),
          { worktreePath, branch }
        )
        return { success: false, error: message }
      }
    }
  )

  // Get file content at the merge-base between a branch and HEAD
  ipcMain.handle(
    'git:branchBaseContent',
    async (
      _event,
      worktreePath: string,
      branch: string,
      filePath: string
    ): Promise<{ success: boolean; content?: string; error?: string }> => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getBranchBaseContent(branch, filePath)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to get branch base content',
          error instanceof Error ? error : new Error(message),
          { worktreePath, branch, filePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // Get file content as base64 at the merge-base between a branch and HEAD (for binary files)
  ipcMain.handle(
    'git:branchBaseContentBase64',
    async (
      _event,
      worktreePath: string,
      branch: string,
      filePath: string
    ): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }> => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getBranchBaseContentBase64(branch, filePath)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to get branch base content base64',
          error instanceof Error ? error : new Error(message),
          { worktreePath, branch, filePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // Get unified diff between current worktree and a branch for a specific file
  ipcMain.handle(
    'git:branchFileDiff',
    async (
      _event,
      worktreePath: string,
      branch: string,
      filePath: string
    ): Promise<{ success: boolean; diff?: string; error?: string }> => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getBranchFileDiff(branch, filePath)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Failed to get branch file diff',
          error instanceof Error ? error : new Error(message),
          { worktreePath, branch, filePath }
        )
        return { success: false, error: message }
      }
    }
  )

  // List open pull requests via gh CLI
  ipcMain.handle(
    'git:listPRs',
    async (
      _event,
      { projectPath }: { projectPath: string }
    ): Promise<{
      success: boolean
      prs: Array<{
        number: number
        title: string
        author: string
        headRefName: string
      }>
      error?: string
    }> => {
      log.info('Listing PRs via gh CLI', { projectPath })
      try {
        // Fetch latest remote refs so PR branches are available for worktree creation
        await execAsync('git fetch origin', { cwd: projectPath })

        const { stdout } = await execAsync(
          'gh pr list --json number,title,author,headRefName --state open --limit 100',
          { cwd: projectPath }
        )
        const raw = JSON.parse(stdout) as Array<{
          number: number
          title: string
          author: { login: string }
          headRefName: string
        }>
        const prs = raw.map((pr) => ({
          number: pr.number,
          title: pr.title,
          author: pr.author.login,
          headRefName: pr.headRefName
        }))
        return { success: true, prs }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('Failed to list PRs', error instanceof Error ? error : new Error(message), {
          projectPath
        })

        if (message.includes('gh: command not found') || message.includes('not found')) {
          return { success: false, prs: [], error: 'GitHub CLI (gh) is not installed' }
        }
        if (message.includes('not a git repository')) {
          return { success: false, prs: [], error: 'Not a git repository' }
        }
        if (message.includes('Could not resolve to a Repository')) {
          return {
            success: false,
            prs: [],
            error: 'Not a GitHub repository or not authenticated with gh'
          }
        }
        return { success: false, prs: [], error: message }
      }
    }
  )

  // Get the state of a specific PR via gh CLI
  ipcMain.handle(
    'git:getPRState',
    async (
      _event,
      { projectPath, prNumber }: { projectPath: string; prNumber: number }
    ): Promise<{ success: boolean; state?: string; title?: string; error?: string }> => {
      log.info('Getting PR state via gh CLI', { projectPath, prNumber })
      try {
        const { stdout } = await execAsync(
          `gh pr view ${prNumber} --json state,title`,
          { cwd: projectPath }
        )
        const data = JSON.parse(stdout) as { state: string; title: string }
        return { success: true, state: data.state, title: data.title }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('Failed to get PR state', error instanceof Error ? error : new Error(message), {
          projectPath,
          prNumber
        })
        return { success: false, error: message }
      }
    }
  )

  // Fetch inline review comments for a PR (file-level review threads only)
  ipcMain.handle(
    'git:getPRReviewComments',
    async (
      _event,
      { projectPath, prNumber }: { projectPath: string; prNumber: number }
    ): Promise<{ success: boolean; comments?: PRReviewComment[]; error?: string }> => {
      log.info('Fetching PR review comments via GraphQL', { projectPath, prNumber })
      try {
        const { stdout: repoInfo } = await execAsync(
          "gh repo view --json nameWithOwner -q '.nameWithOwner'",
          { cwd: projectPath }
        )
        const [owner, repo] = repoInfo.trim().split('/')

        const { stdout } = await execAsync(
          `gh api graphql -f query='${PR_REVIEW_THREADS_QUERY}' -F owner='${owner}' -F repo='${repo}' -F pr=${prNumber}`,
          { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
        )

        const response = JSON.parse(stdout)
        if (response.errors?.length) {
          return { success: false, error: response.errors[0].message }
        }

        const pullRequest = response.data?.repository?.pullRequest
        const baseBranch: string | undefined = pullRequest?.baseRefName ?? undefined
        const threads: GQLReviewThread[] =
          pullRequest?.reviewThreads?.nodes ?? []
        const comments: PRReviewComment[] = []

        for (const thread of threads) {
          const nodes = thread.comments?.nodes
          if (!nodes?.length) continue
          const rootId = nodes[0].databaseId

          for (let i = 0; i < nodes.length; i++) {
            const c = nodes[i]
            comments.push({
              id: c.databaseId,
              body: c.body ?? '',
              bodyHTML: c.bodyHTML ?? '',
              path: c.path ?? '',
              line: c.line ?? null,
              originalLine: c.originalLine ?? null,
              side: thread.diffSide ?? 'RIGHT',
              diffHunk: c.diffHunk ?? '',
              user: {
                login: c.author?.login ?? 'ghost',
                avatarUrl: c.author?.avatarUrl ?? ''
              },
              createdAt: c.createdAt ?? '',
              updatedAt: c.updatedAt ?? '',
              inReplyToId: i === 0 ? null : rootId,
              pullRequestReviewId: c.pullRequestReview?.databaseId ?? null,
              subjectType: c.subjectType === 'FILE' ? 'file' : 'line'
            })
          }
        }

        return { success: true, comments, baseBranch }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error(
          'Failed to fetch PR review comments',
          error instanceof Error ? error : new Error(message),
          { projectPath, prNumber }
        )
        if (message.includes('gh: command not found') || message.includes('not found'))
          return { success: false, error: 'GitHub CLI (gh) is not installed' }
        if (message.includes('Could not resolve to a Repository'))
          return {
            success: false,
            error: 'Not a GitHub repository or not authenticated with gh'
          }
        if (message.includes('404'))
          return { success: false, error: 'PR not found' }
        return { success: false, error: message }
      }
    }
  )

  // Get range diff between base branch and HEAD
  ipcMain.handle(
    'git:getRangeDiff',
    async (
      _event,
      worktreePath: string,
      baseBranch: string
    ): Promise<{
      commitSummary: string
      diffSummary: string
      diffPatch: string
      commitCount: number
    }> => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getRangeDiff(baseBranch)
      } catch (error) {
        log.warn('getRangeDiff IPC failed', {
          error: error instanceof Error ? error.message : String(error)
        })
        return { commitSummary: '', diffSummary: '', diffPatch: '', commitCount: 0 }
      }
    }
  )

  // Check if current branch needs push
  ipcMain.handle(
    'git:needsPush',
    async (_event, worktreePath: string): Promise<boolean> => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.needsPush()
      } catch {
        return false
      }
    }
  )

  // Create a pull request via gh CLI
  ipcMain.handle(
    'git:createPR',
    async (
      _event,
      worktreePath: string,
      baseBranch: string,
      title: string,
      body: string
    ): Promise<{ success: boolean; url?: string; number?: number; error?: string }> => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.createPullRequest({ baseBranch, title, body })
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  // Generate PR content via AI
  ipcMain.handle(
    'git:generatePRContent',
    async (
      _event,
      worktreePath: string,
      baseBranch: string,
      provider: string
    ): Promise<{ success: boolean; title?: string; body?: string; error?: string }> => {
      try {
        const validProviders = ['claude-code', 'codex', 'opencode']
        if (!validProviders.includes(provider)) {
          return {
            success: false,
            error:
              provider === 'terminal'
                ? "Provider 'terminal' does not support PR content generation"
                : `Invalid provider: ${provider}`
          }
        }

        const gitService = createGitService(worktreePath)
        const rangeDiff = await gitService.getRangeDiff(baseBranch)
        const branchInfo = await gitService.getBranchInfo()

        const { generatePRContent } = await import('../services/pr-content-generator')
        const result = await generatePRContent({
          baseBranch,
          headBranch: branchInfo.branch?.name ?? 'HEAD',
          commitSummary: rangeDiff.commitSummary,
          diffSummary: rangeDiff.diffSummary,
          diffPatch: rangeDiff.diffPatch,
          provider: provider as import('../services/agent-sdk-types').AgentSdkId
        })

        return { success: true, title: result.title, body: result.body }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
}

// Re-export cleanup functions for app quit handler
export { cleanupWorktreeWatchers, cleanupBranchWatchers }

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
