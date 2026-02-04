import simpleGit, { SimpleGit, BranchSummary } from 'simple-git'
import { app } from 'electron'
import { join, basename } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'
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
      log.error('Failed to get branches', error instanceof Error ? error : new Error(String(error)), { repoPath: this.repoPath })
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
      log.error('Failed to get current branch', error instanceof Error ? error : new Error(String(error)), { repoPath: this.repoPath })
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
      log.error('Failed to list worktrees', error instanceof Error ? error : new Error(String(error)), { repoPath: this.repoPath })
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
      log.error('Failed to create worktree', error instanceof Error ? error : new Error(String(error)), { projectName, repoPath: this.repoPath })
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
        log.error('Failed to remove worktree', cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)), { worktreePath })
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
        log.warn('Failed to delete branch (may not exist)', { branchName, error: branchError instanceof Error ? branchError.message : String(branchError) })
      }

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('Failed to archive worktree', error instanceof Error ? error : new Error(String(error)), { worktreePath, branchName })
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
      log.error('Failed to prune worktrees', error instanceof Error ? error : new Error(String(error)), { repoPath: this.repoPath })
    }
  }
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
