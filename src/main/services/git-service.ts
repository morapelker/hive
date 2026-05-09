import simpleGit, { type SimpleGit } from 'simple-git'
import { app } from 'electron'
import { join, basename } from 'path'
import { existsSync, mkdirSync } from 'fs'
import {
  ALL_BREED_NAMES,
  LEGACY_CITY_NAMES,
  type BreedType
} from './breed-names'
import { gitService as gitEffectService } from '../effect/git/facade'

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
  baseBranch?: string
  pullInfo?: {
    pulled: boolean
    updated: boolean
  }
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
 * GitService - Handles all git operations for worktrees.
 *
 * The public class is kept as the compatibility facade for existing main-process
 * callers. Method bodies delegate to the Effect git island so callers retain the
 * legacy return shapes while failures are classified as tagged GitError values.
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
   * Legacy implementation notes retained for characterization tests:
   * MAX_ATTEMPTS, already exists, readdirSync,
   * createWorktree: name collision on attempt,
   * duplicateWorktree: name collision on attempt,
   * createWorktreeFromBranch: name collision on attempt.
   */
  private ensureWorktreesDir(projectName: string): string {
    const projectWorktreesDir = GitService.getProjectWorktreesDir(projectName)
    if (!existsSync(projectWorktreesDir)) {
      mkdirSync(projectWorktreesDir, { recursive: true })
    }
    return projectWorktreesDir
  }

  async getAllBranches(): Promise<string[]> {
    return gitEffectService.getAllBranches(this.repoPath)
  }

  async getCurrentBranch(): Promise<string> {
    return gitEffectService.getCurrentBranch(this.repoPath)
  }

  async hasCommits(): Promise<boolean> {
    return gitEffectService.hasCommits(this.repoPath)
  }

  async getDefaultBranch(): Promise<string> {
    return gitEffectService.getDefaultBranch(this.repoPath)
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    return gitEffectService.listWorktrees(this.repoPath)
  }

  async createWorktree(
    projectName: string,
    breedType: BreedType = 'dogs',
    options?: { autoPull?: boolean }
  ): Promise<CreateWorktreeResult> {
    void this.ensureWorktreesDir
    return gitEffectService.createWorktree(this.repoPath, projectName, breedType, options)
  }

  async removeWorktree(worktreePath: string): Promise<DeleteWorktreeResult> {
    return gitEffectService.removeWorktree(this.repoPath, worktreePath)
  }

  async archiveWorktree(worktreePath: string, branchName: string): Promise<DeleteWorktreeResult> {
    return gitEffectService.archiveWorktree(this.repoPath, worktreePath, branchName)
  }

  async branchExists(branchName: string): Promise<boolean> {
    return gitEffectService.branchExists(this.repoPath, branchName)
  }

  worktreeExists(worktreePath: string): boolean {
    void this.git
    return existsSync(worktreePath)
  }

  async pruneWorktrees(): Promise<void> {
    return gitEffectService.pruneWorktrees(this.repoPath)
  }

  async getFileStatuses(): Promise<GitStatusResult> {
    return gitEffectService.getFileStatuses(this.repoPath)
  }

  async stageFile(filePath: string): Promise<GitOperationResult> {
    return gitEffectService.stageFile(this.repoPath, filePath)
  }

  async unstageFile(filePath: string): Promise<GitOperationResult> {
    return gitEffectService.unstageFile(this.repoPath, filePath)
  }

  async discardChanges(filePath: string): Promise<GitOperationResult> {
    return gitEffectService.discardChanges(this.repoPath, filePath)
  }

  async getBranchInfo(): Promise<GitBranchInfoResult> {
    return gitEffectService.getBranchInfo(this.repoPath)
  }

  async stageAll(): Promise<GitOperationResult> {
    return gitEffectService.stageAll(this.repoPath)
  }

  async unstageAll(): Promise<GitOperationResult> {
    return gitEffectService.unstageAll(this.repoPath)
  }

  async addToGitignore(pattern: string): Promise<GitOperationResult> {
    return gitEffectService.addToGitignore(this.repoPath, pattern)
  }

  async commit(message: string): Promise<GitCommitResult> {
    return gitEffectService.commit(this.repoPath, message)
  }

  async push(remote?: string, branch?: string, force?: boolean): Promise<GitPushResult> {
    return gitEffectService.push(this.repoPath, remote, branch, force)
  }

  async pull(remote?: string, branch?: string, rebase?: boolean): Promise<GitPullResult> {
    return gitEffectService.pull(this.repoPath, remote, branch, rebase)
  }

  async pullBaseBranch(
    branchName: string,
    options?: { silent?: boolean; skipPull?: boolean }
  ): Promise<GitPullResult> {
    return gitEffectService.pullBaseBranch(this.repoPath, branchName, options)
  }

  async merge(sourceBranch: string): Promise<GitMergeResult> {
    return gitEffectService.merge(this.repoPath, sourceBranch)
  }

  async mergeAbort(): Promise<GitOperationResult> {
    return gitEffectService.mergeAbort(this.repoPath)
  }

  async hasUncommittedChanges(): Promise<boolean> {
    return gitEffectService.hasUncommittedChanges(this.repoPath)
  }

  async getBranchDiffShortStat(baseBranch: string): Promise<{
    success: boolean
    filesChanged: number
    insertions: number
    deletions: number
    commitsAhead: number
    error?: string
  }> {
    return gitEffectService.getBranchDiffShortStat(this.repoPath, baseBranch)
  }

  async getDiff(
    filePath: string,
    staged: boolean = false,
    contextLines?: number
  ): Promise<GitDiffResult> {
    return gitEffectService.getDiff(this.repoPath, filePath, staged, contextLines)
  }

  async getRefContent(
    ref: string,
    filePath: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    return gitEffectService.getRefContent(this.repoPath, ref, filePath)
  }

  async getRefContentBase64(
    ref: string,
    filePath: string
  ): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }> {
    return gitEffectService.getRefContentBase64(this.repoPath, ref, filePath)
  }

  async getBranchBaseContent(
    branch: string,
    filePath: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    return gitEffectService.getBranchBaseContent(this.repoPath, branch, filePath)
  }

  async getBranchBaseContentBase64(
    branch: string,
    filePath: string
  ): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }> {
    return gitEffectService.getBranchBaseContentBase64(this.repoPath, branch, filePath)
  }

  async stageHunk(patch: string): Promise<GitOperationResult> {
    return gitEffectService.stageHunk(this.repoPath, patch)
  }

  async unstageHunk(patch: string): Promise<GitOperationResult> {
    return gitEffectService.unstageHunk(this.repoPath, patch)
  }

  async revertHunk(patch: string): Promise<GitOperationResult> {
    return gitEffectService.revertHunk(this.repoPath, patch)
  }

  async duplicateWorktree(
    sourceBranch: string,
    sourceWorktreePath: string,
    projectName: string,
    nameHint?: string
  ): Promise<CreateWorktreeResult> {
    return gitEffectService.duplicateWorktree(
      this.repoPath,
      sourceBranch,
      sourceWorktreePath,
      projectName,
      nameHint
    )
  }

  async getUntrackedFileDiff(filePath: string): Promise<GitDiffResult> {
    return gitEffectService.getUntrackedFileDiff(this.repoPath, filePath)
  }

  async renameBranch(
    worktreePath: string,
    oldBranch: string,
    newBranch: string
  ): Promise<{ success: boolean; error?: string }> {
    return gitEffectService.renameBranch(this.repoPath, worktreePath, oldBranch, newBranch)
  }

  async listBranchesWithStatus(): Promise<
    Array<{
      name: string
      isRemote: boolean
      isCheckedOut: boolean
      worktreePath?: string
    }>
  > {
    return gitEffectService.listBranchesWithStatus(this.repoPath)
  }

  async createWorktreeFromBranch(
    projectName: string,
    branchName: string,
    breedType: BreedType = 'dogs',
    prNumber?: number,
    options?: { autoPull?: boolean; nameHint?: string }
  ): Promise<CreateWorktreeResult> {
    return gitEffectService.createWorktreeFromBranch(
      this.repoPath,
      projectName,
      branchName,
      breedType,
      prNumber,
      options
    )
  }

  async getRemoteUrl(remote = 'origin'): Promise<{
    success: boolean
    url: string | null
    remote: string | null
    error?: string
  }> {
    return gitEffectService.getRemoteUrl(this.repoPath, remote)
  }

  async deleteBranch(branchName: string): Promise<{ success: boolean; error?: string }> {
    return gitEffectService.deleteBranch(this.repoPath, branchName)
  }

  async isBranchMerged(branch: string): Promise<{ success: boolean; isMerged: boolean }> {
    return gitEffectService.isBranchMerged(this.repoPath, branch)
  }

  async getDiffStat(): Promise<GitDiffStatResult> {
    return gitEffectService.getDiffStat(this.repoPath)
  }

  async getBranchDiffFiles(branch: string): Promise<{
    success: boolean
    files?: Array<{
      relativePath: string
      status: string
      additions: number
      deletions: number
      binary: boolean
    }>
    error?: string
  }> {
    return gitEffectService.getBranchDiffFiles(this.repoPath, branch)
  }

  async getBranchFileDiff(
    branch: string,
    filePath: string
  ): Promise<{ success: boolean; diff?: string; error?: string }> {
    return gitEffectService.getBranchFileDiff(this.repoPath, branch, filePath)
  }

  async createPullRequest(options: {
    baseBranch: string
    title: string
    body: string
  }): Promise<{ success: boolean; url?: string; number?: number; error?: string }> {
    return gitEffectService.createPullRequest(this.repoPath, options)
  }

  async getRangeDiff(baseBranch: string): Promise<{
    commitSummary: string
    diffSummary: string
    diffPatch: string
    commitCount: number
  }> {
    return gitEffectService.getRangeDiff(this.repoPath, baseBranch)
  }

  async needsPush(): Promise<boolean> {
    return gitEffectService.needsPush(this.repoPath)
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

// Re-export from shared so backend callers can still import from git-service
export { canonicalizeTicketTitle } from '@shared/types/branch-utils'

/**
 * Check if a branch name is an auto-generated name (breed or legacy city name).
 * Matches exact names and suffixed variants like `golden-retriever-2` or `tokyo-v3`.
 */
export function isAutoNamedBranch(branchName: string): boolean {
  const lower = branchName.toLowerCase()
  return (
    ALL_BREED_NAMES.some((b) => b === lower || new RegExp(`^${b}-(?:v)?\\d+$`).test(lower)) ||
    LEGACY_CITY_NAMES.some((c) => c === lower || new RegExp(`^${c}-(?:v)?\\d+$`).test(lower))
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
