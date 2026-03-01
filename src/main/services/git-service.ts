import simpleGit, { SimpleGit, BranchSummary } from 'simple-git'
import { app } from 'electron'
import { join, basename, dirname } from 'path'
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { selectUniqueBreedName, ALL_BREED_NAMES, LEGACY_CITY_NAMES, type BreedType } from './breed-names'
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

export interface GitDiffStatFile {
  path: string
  additions: number
  deletions: number
  binary: boolean
}

export interface GitDiffStatResult {
  success: boolean
  files?: GitDiffStatFile[]
  error?: string
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
   * Check if the repository has any commits (i.e., HEAD resolves)
   */
  async hasCommits(): Promise<boolean> {
    try {
      await this.git.raw(['rev-parse', 'HEAD'])
      return true
    } catch {
      return false
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
   * Create a new worktree with a breed-named branch
   */
  async createWorktree(
    projectName: string,
    breedType: BreedType = 'dogs'
  ): Promise<CreateWorktreeResult> {
    try {
      // Get existing branches to avoid collisions
      const existingBranches = await this.getAllBranches()
      const existingWorktrees = await this.listWorktrees()
      const existingWorktreeBranches = existingWorktrees.map((w) => w.branch)

      // Combine all existing names to avoid
      const existingNames = new Set([...existingBranches, ...existingWorktreeBranches])

      // Select a unique breed name
      const breedName = selectUniqueBreedName(existingNames, breedType)

      // Ensure worktrees directory exists
      const projectWorktreesDir = this.ensureWorktreesDir(projectName)
      const worktreePath = join(projectWorktreesDir, breedName)

      // Branch from whatever is checked out at the root of the repository
      const defaultBranch = await this.getCurrentBranch()

      // Create the worktree with a new branch
      await this.git.raw(['worktree', 'add', '-b', breedName, worktreePath, defaultBranch])

      return {
        success: true,
        name: breedName,
        branchName: breedName,
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
   *
   * Uses status.files (per-file porcelain codes) instead of convenience arrays
   * because simple-git's status.modified includes fully-staged files (porcelain `M `)
   * which would incorrectly appear as unstaged changes.
   */
  async getFileStatuses(): Promise<GitStatusResult> {
    try {
      const status = await this.git.status()
      const files: GitFileStatus[] = []
      const conflictedSet = new Set(status.conflicted)

      for (const fileStatus of status.files) {
        const filePath = fileStatus.path
        const fullPath = join(this.repoPath, filePath)
        const idx = fileStatus.index
        const wd = fileStatus.working_dir

        // Conflicted files
        if (conflictedSet.has(filePath)) {
          files.push({
            path: fullPath,
            relativePath: filePath,
            status: 'C',
            staged: false
          })
          continue
        }

        // Untracked files
        if (idx === '?' && wd === '?') {
          files.push({
            path: fullPath,
            relativePath: filePath,
            status: '?',
            staged: false
          })
          continue
        }

        // Staged changes — index column indicates staged modifications
        if (idx === 'M' || idx === 'A' || idx === 'D' || idx === 'R' || idx === 'C') {
          files.push({
            path: fullPath,
            relativePath: filePath,
            status: idx === 'D' ? 'D' : idx === 'M' ? 'M' : 'A',
            staged: true
          })
        }

        // Unstaged working tree changes — only when working_dir indicates real changes
        if (wd === 'M' || wd === 'D') {
          files.push({
            path: fullPath,
            relativePath: filePath,
            status: wd === 'D' ? 'D' : 'M',
            staged: false
          })
        }
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
   * Get file content from a specific git ref (HEAD, index, etc.)
   * @param ref - Git ref: 'HEAD' for HEAD version, '' (empty string) for index/staged version
   * @param filePath - Relative path to the file
   */
  async getRefContent(
    ref: string,
    filePath: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      // 'HEAD:path' for HEAD, ':path' for index (staged)
      const refSpec = ref ? `${ref}:${filePath}` : `:${filePath}`
      const content = await this.git.show([refSpec])
      return { success: true, content }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to get ref content', error instanceof Error ? error : new Error(message), {
        ref,
        filePath,
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Write patch content to a temp file, run git apply, then clean up.
   * simple-git's applyPatch() treats the first arg as a file path,
   * so we must write the patch string to disk first.
   */
  private async applyPatchString(patch: string, options: string[]): Promise<void> {
    const tmpFile = join(tmpdir(), `hive-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`)
    try {
      writeFileSync(tmpFile, patch, 'utf-8')
      await this.git.applyPatch(tmpFile, options)
    } finally {
      try { unlinkSync(tmpFile) } catch { /* ignore cleanup errors */ }
    }
  }

  /**
   * Stage a single hunk by applying a patch to the index
   * @param patch - Unified diff patch string for the hunk
   */
  async stageHunk(patch: string): Promise<GitOperationResult> {
    try {
      await this.applyPatchString(patch, ['--cached', '--unidiff-zero'])
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to stage hunk', error instanceof Error ? error : new Error(message), {
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Unstage a single hunk by reverse-applying a patch from the index
   * @param patch - Unified diff patch string for the hunk
   */
  async unstageHunk(patch: string): Promise<GitOperationResult> {
    try {
      await this.applyPatchString(patch, ['--cached', '--reverse', '--unidiff-zero'])
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to unstage hunk', error instanceof Error ? error : new Error(message), {
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Revert a single hunk in the working tree
   * @param patch - Unified diff patch string for the hunk
   */
  async revertHunk(patch: string): Promise<GitOperationResult> {
    try {
      await this.applyPatchString(patch, ['--reverse', '--unidiff-zero'])
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to revert hunk', error instanceof Error ? error : new Error(message), {
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

    return Object.entries(branchSummary.branches).map(([name, info]) => {
      const isRemote = name.startsWith('remotes/')

      return {
        name: normalizeBranchDisplayName(name),
        isRemote,
        isCheckedOut: checkedOut.has(info.name),
        worktreePath: checkedOut.get(info.name)
      }
    })
  }

  /**
   * Create a worktree from a specific existing branch.
   * If the branch is already checked out in another worktree, duplicate it instead.
   */
  async createWorktreeFromBranch(
    projectName: string,
    branchName: string,
    breedType: BreedType = 'dogs',
    prNumber?: number
  ): Promise<CreateWorktreeResult> {
    try {
      // Check if branch is already checked out (skip for PR checkouts —
      // a fork's head ref may collide with a local branch name)
      if (prNumber == null) {
        const worktreeList = await this.git.raw(['worktree', 'list', '--porcelain'])
        const blocks = worktreeList.split('\n\n').filter(Boolean)

        for (const block of blocks) {
          const lines = block.split('\n')
          const branch = lines
            .find((l) => l.startsWith('branch '))
            ?.replace('branch refs/heads/', '')
          const wtPath = lines
            .find((l) => l.startsWith('worktree '))
            ?.replace('worktree ', '')
          if (branch === branchName && wtPath) {
            // Already checked out — duplicate it
            return this.duplicateWorktree(branchName, wtPath, projectName)
          }
        }
      }

      // Get existing branches to avoid name collisions
      const existingBranches = await this.getAllBranches()
      const existingWorktrees = await this.listWorktrees()
      const existingWorktreeBranches = existingWorktrees.map((w) => w.branch)
      const existingNames = new Set([...existingBranches, ...existingWorktreeBranches])

      // Select a unique breed name
      const breedName = selectUniqueBreedName(existingNames, breedType)

      const projectWorktreesDir = this.ensureWorktreesDir(projectName)
      const worktreePath = join(projectWorktreesDir, breedName)

      if (prNumber != null) {
        // Fetch the PR ref directly — works for both fork and same-repo PRs
        await this.git.raw(['fetch', 'origin', `pull/${prNumber}/head`])
        await this.git.raw(['worktree', 'add', '-b', breedName, worktreePath, 'FETCH_HEAD'])
      } else {
        // Create a new breed-named branch derived from the selected branch
        await this.git.raw(['worktree', 'add', '-b', breedName, worktreePath, branchName])
      }

      return { success: true, path: worktreePath, branchName: breedName, name: breedName }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error(
        'Failed to create worktree from branch',
        error instanceof Error ? error : new Error(message),
        { projectName, branchName, prNumber, repoPath: this.repoPath }
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

  /**
   * Delete a local branch.
   * Uses -D (force) to handle branches that may not be fully merged.
   * @param branchName - The branch to delete
   */
  async deleteBranch(branchName: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.git.branch(['-D', branchName])
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('Failed to delete branch', error instanceof Error ? error : new Error(message), {
        branchName,
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Check if a branch has been fully merged into HEAD.
   * Uses `git rev-list --count HEAD..{branch}` to count commits in the branch
   * that are not reachable from HEAD. If the count is 0, the branch is fully merged.
   *
   * Note: `git merge-base --is-ancestor` cannot be used here because simple-git's
   * raw() does not throw on its non-zero exit code — it returns empty string for both cases.
   *
   * @param branch - Branch name to check
   * @returns isMerged: true if branch has no commits beyond HEAD
   */
  async isBranchMerged(branch: string): Promise<{ success: boolean; isMerged: boolean }> {
    try {
      const result = await this.git.raw(['rev-list', '--count', `HEAD..${branch}`])
      const count = parseInt(result.trim(), 10)
      return { success: true, isMerged: count === 0 }
    } catch {
      return { success: true, isMerged: false }
    }
  }

  /**
   * Get diff stats (additions/deletions per file) for all uncommitted changes.
   * Combines both staged and unstaged changes, plus untracked files.
   */
  async getDiffStat(): Promise<GitDiffStatResult> {
    try {
      const files: GitDiffStatFile[] = []
      const seen = new Set<string>()

      // Staged changes: git diff --cached --numstat
      try {
        const staged = await this.git.raw(['diff', '--cached', '--numstat'])
        for (const line of staged.trim().split('\n')) {
          if (!line) continue
          const [add, del, path] = line.split('\t')
          if (!path) continue
          seen.add(path)
          const binary = add === '-' && del === '-'
          files.push({
            path,
            additions: binary ? 0 : parseInt(add, 10) || 0,
            deletions: binary ? 0 : parseInt(del, 10) || 0,
            binary
          })
        }
      } catch {
        // No staged changes
      }

      // Unstaged changes: git diff --numstat
      try {
        const unstaged = await this.git.raw(['diff', '--numstat'])
        for (const line of unstaged.trim().split('\n')) {
          if (!line) continue
          const [add, del, path] = line.split('\t')
          if (!path) continue
          if (seen.has(path)) {
            // Merge with existing staged entry
            const existing = files.find((f) => f.path === path)
            if (existing) {
              const binary = add === '-' && del === '-'
              if (!binary) {
                existing.additions += parseInt(add, 10) || 0
                existing.deletions += parseInt(del, 10) || 0
              }
            }
          } else {
            seen.add(path)
            const binary = add === '-' && del === '-'
            files.push({
              path,
              additions: binary ? 0 : parseInt(add, 10) || 0,
              deletions: binary ? 0 : parseInt(del, 10) || 0,
              binary
            })
          }
        }
      } catch {
        // No unstaged changes
      }

      // Untracked files: count their lines as additions
      try {
        const status = await this.git.status()
        for (const file of status.not_added) {
          if (seen.has(file)) continue
          seen.add(file)
          try {
            const content = await this.git.raw(['show', `:${file}`]).catch(() => null)
            if (content === null) {
              // File not in index, read from disk
              const { readFile: readF } = await import('fs/promises')
              const fullPath = join(this.repoPath, file)
              const text = await readF(fullPath, 'utf-8').catch(() => null)
              const lineCount = text ? text.split('\n').length : 0
              files.push({ path: file, additions: lineCount, deletions: 0, binary: false })
            }
          } catch {
            files.push({ path: file, additions: 0, deletions: 0, binary: false })
          }
        }
      } catch {
        // No untracked files
      }

      return { success: true, files }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('Failed to get diff stat', error instanceof Error ? error : new Error(message), {
        repoPath: this.repoPath
      })
      return { success: false, error: message }
    }
  }

  /**
   * Get list of files changed between the current worktree and a branch
   * Uses git diff --name-status to get file paths and their change status
   */
  async getBranchDiffFiles(
    branch: string
  ): Promise<{ success: boolean; files?: { relativePath: string; status: string }[]; error?: string }> {
    try {
      const result = await this.git.raw(['diff', '--name-status', '--no-renames', branch])
      const files: { relativePath: string; status: string }[] = []
      for (const line of result.trim().split('\n')) {
        if (!line) continue
        const [status, ...pathParts] = line.split('\t')
        const relativePath = pathParts.join('\t')
        if (status && relativePath) {
          files.push({ relativePath, status })
        }
      }
      return { success: true, files }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(
        'Failed to get branch diff files',
        error instanceof Error ? error : new Error(message),
        { branch, repoPath: this.repoPath }
      )
      return { success: false, error: message }
    }
  }

  /**
   * Get unified diff between the current worktree and a branch for a specific file
   */
  async getBranchFileDiff(
    branch: string,
    filePath: string
  ): Promise<{ success: boolean; diff?: string; error?: string }> {
    try {
      const result = await this.git.raw(['diff', branch, '--', filePath])
      return { success: true, diff: result || '' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(
        'Failed to get branch file diff',
        error instanceof Error ? error : new Error(message),
        { branch, filePath, repoPath: this.repoPath }
      )
      return { success: false, error: message }
    }
  }
}

/**
 * Remove git's remote branch prefix for UI display.
 */
export function normalizeBranchDisplayName(branchName: string): string {
  return branchName.startsWith('remotes/') ? branchName.replace(/^remotes\//, '') : branchName
}

/**
 * Convert a session title into a safe git branch name.
 */
export function canonicalizeBranchName(title: string): string {
  const firstThreeWords = title.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(' ')

  return firstThreeWords
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // spaces and underscores → dashes
    .replace(/[^a-z0-9\-/.]/g, '') // remove invalid chars
    .replace(/-{2,}/g, '-') // collapse consecutive dashes
    .replace(/^-+|-+$/g, '') // strip leading/trailing dashes
    .slice(0, 50) // truncate
    .replace(/-+$/, '') // strip trailing dashes after truncation
}

/**
 * Check if a branch name is an auto-generated name (breed or legacy city name).
 * Matches exact names and suffixed variants like `golden-retriever-2` or `tokyo-v3`.
 */
export function isAutoNamedBranch(branchName: string): boolean {
  const lower = branchName.toLowerCase()
  return (
    ALL_BREED_NAMES.some(
      (b) => b === lower || new RegExp(`^${b}-(?:v)?\\d+$`).test(lower)
    ) ||
    LEGACY_CITY_NAMES.some(
      (c) => c === lower || new RegExp(`^${c}-(?:v)?\\d+$`).test(lower)
    )
  )
}

// ── Auto-rename helper ──────────────────────────────────────────

export interface AutoRenameParams {
  worktreeId: string
  worktreePath: string
  currentBranchName: string
  sessionTitle: string
  /** Minimal DB interface — only needs updateWorktree */
  db: {
    updateWorktree(
      id: string,
      data: { name?: string; branch_name?: string; branch_renamed?: number }
    ): unknown
  }
}

export interface AutoRenameResult {
  renamed: boolean
  newBranch?: string
  error?: string
  skipped?: 'not-auto-named' | 'same-name' | 'all-variants-taken' | 'empty-canonical'
}

/**
 * Attempt to rename a worktree's auto-named branch to a canonicalized session title.
 * Handles collision suffixing (-2, -3, ...) and sets `branch_renamed: 1` on
 * both success and hard failure to prevent re-attempts.
 */
export async function autoRenameWorktreeBranch(
  params: AutoRenameParams
): Promise<AutoRenameResult> {
  const { worktreeId, worktreePath, currentBranchName, sessionTitle, db } = params

  if (!isAutoNamedBranch(currentBranchName)) {
    return { renamed: false, skipped: 'not-auto-named' }
  }

  const baseBranch = canonicalizeBranchName(sessionTitle)
  if (!baseBranch) {
    return { renamed: false, skipped: 'empty-canonical' }
  }
  if (baseBranch === currentBranchName.toLowerCase()) {
    return { renamed: false, skipped: 'same-name' }
  }

  const gitService = createGitService(worktreePath)

  // Find an available branch name, appending -2, -3, etc. if needed
  let targetBranch = baseBranch
  if (await gitService.branchExists(targetBranch)) {
    let suffix = 2
    const maxSuffix = 9999
    while (suffix <= maxSuffix) {
      const candidate = `${baseBranch}-${suffix}`
      if (!(await gitService.branchExists(candidate))) {
        targetBranch = candidate
        break
      }
      suffix += 1
    }
    if (suffix > maxSuffix) {
      db.updateWorktree(worktreeId, { branch_renamed: 1 })
      return { renamed: false, skipped: 'all-variants-taken' }
    }
  }

  const renameResult = await gitService.renameBranch(worktreePath, currentBranchName, targetBranch)
  if (renameResult.success) {
    db.updateWorktree(worktreeId, {
      name: targetBranch,
      branch_name: targetBranch,
      branch_renamed: 1
    })
    return { renamed: true, newBranch: targetBranch }
  } else {
    db.updateWorktree(worktreeId, { branch_renamed: 1 })
    return { renamed: false, error: renameResult.error }
  }
}

/**
 * Parse `git worktree list --porcelain` output to find the worktree path
 * for a given branch name.
 *
 * Porcelain format:
 *   worktree /path/to/worktree
 *   HEAD abc123
 *   branch refs/heads/main
 *   (blank line)
 */
export function parseWorktreeForBranch(porcelainOutput: string, branchName: string): string | null {
  const blocks = porcelainOutput.trim().split('\n\n')
  for (const block of blocks) {
    const lines = block.split('\n')
    let path = ''
    let branch = ''
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length)
    }
    if (branch === branchName && path) return path
  }
  return null
}

/**
 * Cache of GitService instances per repo path.
 * Reusing instances ensures simple-git serializes operations on the same repo,
 * preventing git lock contention from concurrent processes.
 */
const gitServiceCache = new Map<string, GitService>()

/**
 * Get or create a GitService instance for a repository.
 * Instances are cached per repoPath so that simple-git's internal task queue
 * serializes operations on the same repo.
 */
export function createGitService(repoPath: string): GitService {
  const cached = gitServiceCache.get(repoPath)
  if (cached) return cached
  const service = new GitService(repoPath)
  gitServiceCache.set(repoPath, service)
  return service
}

/**
 * Get the project name from a path
 */
export function getProjectNameFromPath(path: string): string {
  return basename(path)
}
