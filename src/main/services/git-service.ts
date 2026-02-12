import simpleGit, { SimpleGit, BranchSummary } from 'simple-git'
import { app } from 'electron'
import { join, basename, dirname } from 'path'
import { existsSync, mkdirSync, rmSync, cpSync } from 'fs'
import { selectUniqueCityName } from './city-names'
import { createLogger } from './logger'

const log = createLogger({ component: 'GitService' })

export interface WorktreeInfo {
  path: string
  branch: string
  isMain: boolean
}

export interface CreateWorktreeResult {
  success: boolean
  name?: string
  branchName?: string
  path?: string
  error?: string
}

export interface DeleteWorktreeResult {
  success: boolean
  error?: string
}

// Git file status codes
export type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'C' | ''

export interface GitFileStatus {
  path: string
  relativePath: string
  status: GitStatusCode
  staged: boolean
}

export interface GitStatusResult {
  success: boolean
  files?: GitFileStatus[]
  error?: string
}

export interface GitOperationResult {
  success: boolean
  error?: string
}

export interface GitBranchInfo {
  name: string
  tracking: string | null
  ahead: number
  behind: number
}

export interface GitBranchInfoResult {
  success: boolean
  branch?: GitBranchInfo
  error?: string
}

export interface GitCommitResult {
  success: boolean
  commitHash?: string
  error?: string
}

export interface GitPushResult {
  success: boolean
  pushed?: boolean
  error?: string
}

export interface GitPullResult {
  success: boolean
  updated?: boolean
  error?: string
}

export interface GitDiffResult {
  success: boolean
  diff?: string
  fileName?: string
  error?: string
}

export interface GitMergeResult {
  success: boolean
  error?: string
  conflicts?: string[]
}

/**
 * GitService - Handles all git operations for worktrees
 */
export class GitService {
  private repoPath: string
  private git: SimpleGit

  constructor(repoPath: string) {
    this.repoPath = repoPath
    this.git = simpleGit(repoPath)
  }

  /**
   * Get the base directory for all Hive worktrees
   */
  static getWorktreesBaseDir(): string {
    return join(app.getPath('home'), '.hive-worktrees')
  }

  /**
   * Get the worktree directory for a specific project
   */
  static getProjectWorktreesDir(projectName: string): string {
    return join(GitService.getWorktreesBaseDir(), projectName)
  }

  /**
   * Ensure the worktrees directory exists
   */
  private ensureWorktreesDir(projectName: string): string {
    const projectWorktreesDir = GitService.getProjectWorktreesDir(projectName)
    if (!existsSync(projectWorktreesDir)) {
      mkdirSync(projectWorktreesDir, { recursive: true })
    }
    return projectWorktreesDir
  }

  /**
   * Get all branch names in the repository
   */
  async getAllBranches(): Promise<string[]> {
    try {
      const branches: BranchSummary = await this.git.branch(['-a'])
      return branches.all.map((b) => {
        // Remove remote prefix if present
        if (b.startsWith('remotes/origin/')) {
          return b.replace('remotes/origin/', '')
        }
        return b
      })
    } catch (error) {
      log.error(
        'Failed to get branches',
        error instanceof Error ? error : new Error(String(error)),
        { repoPath: this.repoPath }
      )
      return []
    }
  }

  /**
   * Get the current branch name
   */
  async getCurrentBranch(): Promise<string> {
    try {
      const result = await this.git.branch()
      return result.current
    } catch (error) {
      log.error(
        'Failed to get current branch',
        error instanceof Error ? error : new Error(String(error)),
        { repoPath: this.repoPath }
      )
      return 'main'
    }
  }

  /**
   * Get the default branch (main or master)
   */
  async getDefaultBranch(): Promise<string> {
    try {
      const branches = await this.getAllBranches()
      if (branches.includes('main')) return 'main'
      if (branches.includes('master')) return 'master'
      return branches[0] || 'main'
    } catch {
      return 'main'
    }
  }

  /**
   * List all worktrees for this repository
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    try {
      const result = await this.git.raw(['worktree', 'list', '--porcelain'])
      const worktrees: WorktreeInfo[] = []

      const lines = result.split('\n')
      let currentWorktree: Partial<WorktreeInfo> = {}

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          currentWorktree.path = line.replace('worktree ', '')
        } else if (line.startsWith('branch ')) {
          // Format: branch refs/heads/branch-name
          const branchRef = line.replace('branch ', '')
          currentWorktree.branch = branchRef.replace('refs/heads/', '')
        } else if (line === '') {
          if (currentWorktree.path && currentWorktree.branch) {
            worktrees.push({
              path: currentWorktree.path,
              branch: currentWorktree.branch,
              isMain: currentWorktree.path === this.repoPath
            })
          }
          currentWorktree = {}
        }
      }

      return worktrees
    } catch (error) {
      log.error(
        'Failed to list worktrees',
        error instanceof Error ? error : new Error(String(error)),
        { repoPath: this.repoPath }
      )
      return []
    }
  }

  /**
   * Create a new worktree with a city-named branch
   */
  async createWorktree(projectName: string): Promise<CreateWorktreeResult> {
    try {
      // Get existing branches to avoid collisions
      const existingBranches = await this.getAllBranches()
      const existingWorktrees = await this.listWorktrees()
      const existingWorktreeBranches = existingWorktrees.map((w) => w.branch)

      // Combine all existing names to avoid
      const existingNames = new Set([...existingBranches, ...existingWorktreeBranches])

      // Select a unique city name
      const cityName = selectUniqueCityName(existingNames)

      // Ensure worktrees directory exists
      const projectWorktreesDir = this.ensureWorktreesDir(projectName)
      const worktreePath = join(projectWorktreesDir, cityName)

      // Get the default branch to branch from
      const defaultBranch = await this.getDefaultBranch()

      // Create the worktree with a new branch
      await this.git.raw(['worktree', 'add', '-b', cityName, worktreePath, defaultBranch])

      return {
        success: true,
        name: cityName,
        branchName: cityName,
        path: worktreePath
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error(
        'Failed to create worktree',
        error instanceof Error ? error : new Error(String(error)),
        { projectName, repoPath: this.repoPath }
      )
      return {
        success: false,
        error: message
      }
    }
  }

  /**
   * Remove a worktree (keeps the branch)
   * This is the "Unbranch" action
   */
  async removeWorktree(worktreePath: string): Promise<DeleteWorktreeResult> {
    try {
      // First try to remove via git
      await this.git.raw(['worktree', 'remove', worktreePath, '--force'])

      return { success: true }
    } catch {
      // If git worktree remove fails, try manual cleanup
      try {
        if (existsSync(worktreePath)) {
          rmSync(worktreePath, { recursive: true, force: true })
        }
        // Prune stale worktree entries
        await this.git.raw(['worktree', 'prune'])
        return { success: true }
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : 'Unknown error'
        log.error(
          'Failed to remove worktree',
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
          { worktreePath }
        )
        return {
          success: false,
          error: message
        }
      }
    }
  }

  /**
   * Archive a worktree (remove worktree AND delete branch)
   * This is the "Archive" action
   */
  async archiveWorktree(worktreePath: string, branchName: string): Promise<DeleteWorktreeResult> {
    try {
      // First remove the worktree
      const removeResult = await this.removeWorktree(worktreePath)
      if (!removeResult.success) {
        return removeResult
      }

      // Then delete the branch
      try {
        await this.git.branch(['-D', branchName])
      } catch (branchError) {
        // Branch might already be deleted or not exist
        log.warn('Failed to delete branch (may not exist)', {
          branchName,
          error: branchError instanceof Error ? branchError.message : String(branchError)
        })
      }

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error(
        'Failed to archive worktree',
        error instanceof Error ? error : new Error(String(error)),
        { worktreePath, branchName }
      )
      return {
        success: false,
        error: message
      }
    }
  }

  /**
   * Check if a branch exists
   */
  async branchExists(branchName: string): Promise<boolean> {
    try {
      const branches = await this.getAllBranches()
      return branches.includes(branchName)
    } catch {
      return false
    }
  }

  /**
   * Check if a worktree path exists on disk
   */
  worktreeExists(worktreePath: string): boolean {
    return existsSync(worktreePath)
  }

  /**
   * Prune stale worktree entries
   */
  async pruneWorktrees(): Promise<void> {
    try {
      await this.git.raw(['worktree', 'prune'])
    } catch (error) {
      log.error(
        'Failed to prune worktrees',
        error instanceof Error ? error : new Error(String(error)),
        { repoPath: this.repoPath }
      )
    }
  }

  /**
   * Get git status for all files in the repository
   * Returns file statuses with M (modified), A (staged/added), D (deleted), ? (untracked), C (conflicted)
   */
  async getFileStatuses(): Promise<GitStatusResult> {
    try {
      const status = await this.git.status()
      const files: GitFileStatus[] = []

      // Process modified files (not staged)
      for (const file of status.modified) {
        files.push({
          path: join(this.repoPath, file),
          relativePath: file,
          status: 'M',
          staged: false
        })
      }

      // Process staged files
      for (const file of status.staged) {
        // Check if it's already in files (modified but staged some changes)
        const existing = files.find((f) => f.relativePath === file)
        if (existing) {
          // File has both staged and unstaged changes — keep BOTH entries
          // existing stays as { staged: false } (unstaged changes)
          // Add new entry for the staged portion
          files.push({
            path: join(this.repoPath, file),
            relativePath: file,
            status: 'M',
            staged: true
          })
        } else {
          files.push({
            path: join(this.repoPath, file),
            relativePath: file,
            status: 'A',
            staged: true
          })
        }
      }

      // Process created/added files (not yet tracked, staged)
      for (const file of status.created) {
        const existing = files.find((f) => f.relativePath === file)
        if (!existing) {
          files.push({
            path: join(this.repoPath, file),
            relativePath: file,
            status: 'A',
            staged: true
          })
        }
      }

      // Process deleted files
      for (const file of status.deleted) {
        files.push({
          path: join(this.repoPath, file),
          relativePath: file,
          status: 'D',
          staged: false
        })
      }

      // Process untracked files
      for (const file of status.not_added) {
        files.push({
          path: join(this.repoPath, file),
          relativePath: file,
          status: '?',
          staged: false
        })
      }

      // Process conflicted files
      for (const file of status.conflicted) {
        files.push({
          path: join(this.repoPath, file),
          relativePath: file,
          status: 'C',
          staged: false
        })
      }

      return { success: true, files }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error(
        'Failed to get file statuses',
        error instanceof Error ? error : new Error(message),
        { repoPath: this.repoPath }
      )
      return { success: false, error: message }
    }
  }

  /**
   * Stage a file for commit
   */
  async stageFile(filePath: string): Promise<GitOperationResult> {
    try {
      await this.git.add(filePath)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to stage file', error instanceof Error ? error : new Error(message), {
        filePath,
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Unstage a file
   */
  async unstageFile(filePath: string): Promise<GitOperationResult> {
    try {
      await this.git.reset(['HEAD', '--', filePath])
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to unstage file', error instanceof Error ? error : new Error(message), {
        filePath,
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Discard changes in a file (restore to HEAD)
   */
  async discardChanges(filePath: string): Promise<GitOperationResult> {
    try {
      // First check if file is untracked
      const status = await this.git.status()
      const isUntracked = status.not_added.includes(filePath)

      if (isUntracked) {
        // For untracked files, we need to use fs to remove
        const fullPath = join(this.repoPath, filePath)
        const { existsSync, unlinkSync } = await import('fs')
        if (existsSync(fullPath)) {
          unlinkSync(fullPath)
        }
      } else {
        // For tracked files, restore from HEAD
        await this.git.checkout(['--', filePath])
      }
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to discard changes', error instanceof Error ? error : new Error(message), {
        filePath,
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Get branch info including ahead/behind counts
   */
  async getBranchInfo(): Promise<GitBranchInfoResult> {
    try {
      const status = await this.git.status()
      const branchName = status.current || 'HEAD'

      // Get tracking branch info
      let tracking: string | null = null
      let ahead = 0
      let behind = 0

      if (status.tracking) {
        tracking = status.tracking
        ahead = status.ahead
        behind = status.behind
      }

      return {
        success: true,
        branch: {
          name: branchName,
          tracking,
          ahead,
          behind
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to get branch info', error instanceof Error ? error : new Error(message), {
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Stage all modified and untracked files
   */
  async stageAll(): Promise<GitOperationResult> {
    try {
      await this.git.add(['-A'])
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to stage all files', error instanceof Error ? error : new Error(message), {
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Unstage all staged files
   */
  async unstageAll(): Promise<GitOperationResult> {
    try {
      await this.git.reset(['HEAD'])
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error(
        'Failed to unstage all files',
        error instanceof Error ? error : new Error(message),
        { repoPath: this.repoPath }
      )
      return { success: false, error: message }
    }
  }

  /**
   * Add a file path to .gitignore
   */
  async addToGitignore(pattern: string): Promise<GitOperationResult> {
    try {
      const gitignorePath = join(this.repoPath, '.gitignore')
      const { existsSync, readFileSync, appendFileSync, writeFileSync } = await import('fs')

      let content = ''
      if (existsSync(gitignorePath)) {
        content = readFileSync(gitignorePath, 'utf-8')
      }

      // Check if pattern already exists
      const lines = content.split('\n').map((l) => l.trim())
      if (lines.includes(pattern)) {
        return { success: true } // Already ignored
      }

      // Add pattern to .gitignore
      const newLine = content.endsWith('\n') || content === '' ? pattern : '\n' + pattern
      if (content === '') {
        writeFileSync(gitignorePath, pattern + '\n')
      } else {
        appendFileSync(gitignorePath, newLine + '\n')
      }

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error(
        'Failed to add to .gitignore',
        error instanceof Error ? error : new Error(message),
        { pattern, repoPath: this.repoPath }
      )
      return { success: false, error: message }
    }
  }

  /**
   * Commit staged changes with a message
   * @param message - Commit message (summary or summary + description separated by newline)
   */
  async commit(message: string): Promise<GitCommitResult> {
    try {
      if (!message || message.trim() === '') {
        return { success: false, error: 'Commit message is required' }
      }

      // Check if there are staged files
      const status = await this.git.status()
      const hasStagedChanges = status.staged.length > 0 || status.created.length > 0

      if (!hasStagedChanges) {
        return { success: false, error: 'No staged changes to commit' }
      }

      const result = await this.git.commit(message)
      log.info('Committed changes', {
        commit: result.commit,
        summary: result.summary,
        repoPath: this.repoPath
      })

      return {
        success: true,
        commitHash: result.commit
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to commit', error instanceof Error ? error : new Error(message), {
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Push commits to remote
   * @param remote - Remote name (default: origin)
   * @param branch - Branch name (default: current branch)
   * @param force - Force push (default: false)
   */
  async push(remote?: string, branch?: string, force?: boolean): Promise<GitPushResult> {
    try {
      const remoteName = remote || 'origin'
      const branchName = branch || (await this.getCurrentBranch())

      const options: string[] = []
      if (force) {
        options.push('--force')
      }

      // Set upstream if not tracking
      const status = await this.git.status()
      if (!status.tracking) {
        options.push('--set-upstream')
      }

      await this.git.push(remoteName, branchName, options)
      log.info('Pushed to remote', {
        remote: remoteName,
        branch: branchName,
        force,
        repoPath: this.repoPath
      })

      return { success: true, pushed: true }
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to push', error instanceof Error ? error : new Error(errMessage), {
        repoPath: this.repoPath
      })

      // Provide helpful error messages
      let userMessage = errMessage
      if (errMessage.includes('rejected')) {
        userMessage =
          'Push rejected. The remote contains commits not present locally. Pull first or use force push.'
      } else if (errMessage.includes('Could not read from remote repository')) {
        userMessage =
          'Could not connect to remote repository. Check your network connection and authentication.'
      } else if (
        errMessage.includes('Authentication failed') ||
        errMessage.includes('Permission denied')
      ) {
        userMessage = 'Authentication failed. Check your credentials.'
      }

      return { success: false, error: userMessage }
    }
  }

  /**
   * Pull commits from remote
   * @param remote - Remote name (default: origin)
   * @param branch - Branch name (default: current branch)
   * @param rebase - Use rebase instead of merge (default: false)
   */
  async pull(remote?: string, branch?: string, rebase?: boolean): Promise<GitPullResult> {
    try {
      const remoteName = remote || 'origin'
      const branchName = branch || (await this.getCurrentBranch())

      const options: Record<string, null | string | number> = {}
      if (rebase) {
        options['--rebase'] = null
      }

      const result = await this.git.pull(remoteName, branchName, options)
      log.info('Pulled from remote', {
        remote: remoteName,
        branch: branchName,
        rebase,
        files: result.files?.length || 0,
        repoPath: this.repoPath
      })

      return {
        success: true,
        updated: (result.files?.length || 0) > 0 || result.summary.changes > 0
      }
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to pull', error instanceof Error ? error : new Error(errMessage), {
        repoPath: this.repoPath
      })

      // Provide helpful error messages
      let userMessage = errMessage
      if (errMessage.includes('conflict')) {
        userMessage = 'Pull resulted in merge conflicts. Resolve conflicts before continuing.'
      } else if (errMessage.includes('Could not read from remote repository')) {
        userMessage =
          'Could not connect to remote repository. Check your network connection and authentication.'
      } else if (errMessage.includes('uncommitted changes')) {
        userMessage = 'You have uncommitted changes. Commit or stash them before pulling.'
      }

      return { success: false, error: userMessage }
    }
  }

  /**
   * Merge a branch into the current branch
   * @param sourceBranch - Branch to merge from
   */
  async merge(sourceBranch: string): Promise<{
    success: boolean
    error?: string
    conflicts?: string[]
  }> {
    try {
      log.info('Merging branch', { sourceBranch, repoPath: this.repoPath })
      await this.git.merge([sourceBranch])
      return { success: true }
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'git' in error &&
        (error as { git?: { conflicts?: string[] } }).git?.conflicts?.length
      ) {
        const conflicts = (error as { git: { conflicts: string[] } }).git.conflicts
        log.warn('Merge resulted in conflicts', { sourceBranch, conflicts })
        return {
          success: false,
          error: `Merge conflicts in ${conflicts.length} file(s). Resolve conflicts before continuing.`,
          conflicts
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      log.error('Merge failed', error instanceof Error ? error : new Error(message), {
        sourceBranch,
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Get diff for a specific file
   * @param filePath - Relative path to the file
   * @param staged - Whether to get staged diff (default: false for unstaged)
   */
  async getDiff(
    filePath: string,
    staged: boolean = false,
    contextLines?: number
  ): Promise<GitDiffResult> {
    try {
      const args = ['diff']

      // Add context lines arg if specified
      if (contextLines !== undefined) {
        args.push(`-U${contextLines}`)
      }

      // For staged changes, add --cached flag
      if (staged) {
        args.push('--cached')
      }

      // Add the file path
      args.push('--', filePath)

      const result = await this.git.raw(args)
      const fileName = filePath.split('/').pop() || filePath

      return {
        success: true,
        diff: result || '',
        fileName
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to get diff', error instanceof Error ? error : new Error(message), {
        filePath,
        staged,
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Duplicate a worktree by creating a new branch from the source branch
   * and copying uncommitted state (staged, unstaged, untracked files)
   */
  async duplicateWorktree(
    sourceBranch: string,
    sourceWorktreePath: string,
    projectName: string
  ): Promise<CreateWorktreeResult> {
    try {
      // 1. Extract base name (strip -vN suffix)
      const baseName = sourceBranch.replace(/-v\d+$/, '')

      // 2. Find next version number
      const allBranches = await this.getAllBranches()
      const versionPattern = new RegExp(
        `^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-v(\\d+)$`
      )
      let maxVersion = 1 // means first dup will be v2
      for (const branch of allBranches) {
        const match = branch.match(versionPattern)
        if (match) {
          maxVersion = Math.max(maxVersion, parseInt(match[1], 10))
        }
      }
      const newBranchName = `${baseName}-v${maxVersion + 1}`

      // 3. Create worktree directory
      const projectWorktreesDir = this.ensureWorktreesDir(projectName)
      const worktreePath = join(projectWorktreesDir, newBranchName)

      // 4. Create worktree from source branch
      await this.git.raw(['worktree', 'add', '-b', newBranchName, worktreePath, sourceBranch])

      // 5. Capture uncommitted state via stash create (non-destructive)
      const sourceGit = simpleGit(sourceWorktreePath)
      const stashRef = (await sourceGit.raw(['stash', 'create'])).trim()

      if (stashRef) {
        // 6. Apply stash in new worktree
        const newGit = simpleGit(worktreePath)
        try {
          await newGit.raw(['stash', 'apply', stashRef])
        } catch {
          // stash apply may fail if changes conflict — log but continue
          log.warn('Failed to apply stash in duplicated worktree', { newBranchName, stashRef })
        }
      }

      // 7. Copy untracked files
      const untrackedRaw = await sourceGit.raw(['ls-files', '--others', '--exclude-standard'])
      const untrackedFiles = untrackedRaw.trim().split('\n').filter(Boolean)
      for (const file of untrackedFiles) {
        const srcPath = join(sourceWorktreePath, file)
        const destPath = join(worktreePath, file)
        mkdirSync(dirname(destPath), { recursive: true })
        cpSync(srcPath, destPath)
      }

      return { success: true, name: newBranchName, branchName: newBranchName, path: worktreePath }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error(
        'Failed to duplicate worktree',
        error instanceof Error ? error : new Error(message),
        {
          sourceBranch,
          sourceWorktreePath,
          projectName,
          repoPath: this.repoPath
        }
      )
      return { success: false, error: message }
    }
  }

  /**
   * Get diff for a new untracked file (shows entire file as additions)
   * @param filePath - Relative path to the file
   */
  async getUntrackedFileDiff(filePath: string): Promise<GitDiffResult> {
    try {
      const { readFileSync } = await import('fs')
      const fullPath = join(this.repoPath, filePath)
      const content = readFileSync(fullPath, 'utf-8')
      const lines = content.split('\n')
      const fileName = filePath.split('/').pop() || filePath

      // Create a unified diff format for new file
      const diffLines = [
        `diff --git a/${filePath} b/${filePath}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`)
      ]

      return {
        success: true,
        diff: diffLines.join('\n'),
        fileName
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error(
        'Failed to get untracked file diff',
        error instanceof Error ? error : new Error(message),
        { filePath, repoPath: this.repoPath }
      )
      return { success: false, error: message }
    }
  }

  /**
   * Rename a branch in a worktree directory.
   */
  async renameBranch(
    worktreePath: string,
    oldBranch: string,
    newBranch: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const git = simpleGit(worktreePath)
      await git.branch(['-m', oldBranch, newBranch])
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }

  /**
   * List all branches with their checkout status across worktrees
   */
  async listBranchesWithStatus(): Promise<
    Array<{
      name: string
      isRemote: boolean
      isCheckedOut: boolean
      worktreePath?: string
    }>
  > {
    const [branchSummary, worktreeList] = await Promise.all([
      this.git.branch(['-a']),
      this.git.raw(['worktree', 'list', '--porcelain'])
    ])

    const checkedOut = new Map<string, string>()
    const blocks = worktreeList.split('\n\n').filter(Boolean)
    for (const block of blocks) {
      const lines = block.split('\n')
      const wtPath = lines.find((l) => l.startsWith('worktree '))?.replace('worktree ', '')
      const branch = lines.find((l) => l.startsWith('branch '))?.replace('branch refs/heads/', '')
      if (wtPath && branch) checkedOut.set(branch, wtPath)
    }

    return Object.entries(branchSummary.branches).map(([name, info]) => ({
      name: info.name,
      isRemote: name.startsWith('remotes/'),
      isCheckedOut: checkedOut.has(info.name),
      worktreePath: checkedOut.get(info.name)
    }))
  }

  /**
   * Create a worktree from a specific existing branch.
   * If the branch is already checked out in another worktree, duplicate it instead.
   */
  async createWorktreeFromBranch(
    projectName: string,
    branchName: string
  ): Promise<CreateWorktreeResult> {
    try {
      // Check if branch is already checked out
      const worktreeList = await this.git.raw(['worktree', 'list', '--porcelain'])
      const blocks = worktreeList.split('\n\n').filter(Boolean)

      for (const block of blocks) {
        const lines = block.split('\n')
        const branch = lines.find((l) => l.startsWith('branch '))?.replace('branch refs/heads/', '')
        const wtPath = lines.find((l) => l.startsWith('worktree '))?.replace('worktree ', '')
        if (branch === branchName && wtPath) {
          // Already checked out — duplicate it
          return this.duplicateWorktree(branchName, wtPath, projectName)
        }
      }

      // Not checked out — create worktree using existing branch
      const dirName = branchName
        .replace(/[/\\]/g, '-')
        .replace(/[^a-zA-Z0-9-]/g, '')
        .toLowerCase()

      const projectWorktreesDir = this.ensureWorktreesDir(projectName)
      const worktreePath = join(projectWorktreesDir, dirName)

      await this.git.raw(['worktree', 'add', worktreePath, branchName])

      return { success: true, path: worktreePath, branchName, name: dirName }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error(
        'Failed to create worktree from branch',
        error instanceof Error ? error : new Error(message),
        { projectName, branchName, repoPath: this.repoPath }
      )
      return { success: false, error: message }
    }
  }

  /**
   * Get the remote URL for a given remote name (defaults to 'origin')
   */
  async getRemoteUrl(remote = 'origin'): Promise<{
    success: boolean
    url: string | null
    remote: string | null
    error?: string
  }> {
    try {
      const remotes = await this.git.getRemotes(true)
      const target = remotes.find((r) => r.name === remote)
      return {
        success: true,
        url: target?.refs?.fetch || target?.refs?.push || null,
        remote: target?.name || null
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, url: null, remote: null, error: message }
    }
  }
}

/**
 * Convert a session title into a safe git branch name.
 */
export function canonicalizeBranchName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // spaces and underscores → dashes
    .replace(/[^a-z0-9\-/.]/g, '') // remove invalid chars
    .replace(/-{2,}/g, '-') // collapse consecutive dashes
    .replace(/^-+|-+$/g, '') // strip leading/trailing dashes
    .slice(0, 50) // truncate
    .replace(/-+$/, '') // strip trailing dashes after truncation
}

/**
 * Create a GitService instance for a repository
 */
export function createGitService(repoPath: string): GitService {
  return new GitService(repoPath)
}

/**
 * Get the project name from a path
 */
export function getProjectNameFromPath(path: string): string {
  return basename(path)
}
