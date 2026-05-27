import { Cause, Effect, Exit, Option } from 'effect'

import { fromCause } from '../../services/error-utils'
import { withLogComponent } from '../_shared/logger'
import {
  GitDirty,
  GitMergeConflict,
  GitNetworkError,
  GitNotARepository,
  GitPermissionDenied,
  GitUnknown,
  type GitError
} from './errors'
import { getRuntime } from './runtime'
import { Git } from './service'
import type {
  BreedType,
  CreateWorktreeResult,
  GitBranchDiffFilesResult,
  GitBranchDiffShortStatResult,
  GitBranchFileDiffResult,
  GitBranchInfoResult,
  GitBranchWithStatus,
  GitCommitResult,
  GitCreatePullRequestOptions,
  GitCreatePullRequestResult,
  GitDiffResult,
  GitDiffStatResult,
  GitMergeResult,
  GitOperationResult,
  GitPullResult,
  GitPushResult,
  GitRangeDiffResult,
  GitRefContentBase64Result,
  GitRefContentResult,
  GitRemoteUrlResult,
  GitStatusResult,
  WorktreeInfo
} from './types'

const tagged = <A, E>(effect: Effect.Effect<A, E, Git>) =>
  effect.pipe(withLogComponent('GitEffectIsland'))

const failureValue = (cause: Cause.Cause<GitError>): GitError | undefined => {
  const failure = Cause.failureOption(cause)
  return Option.isSome(failure) ? failure.value : undefined
}

export const humanMessage = (error: GitError): string => {
  const stderr = error.stderrExcerpt ?? ''
  if (/rejected/i.test(stderr)) {
    return 'Push rejected. The remote contains commits not present locally. Pull first or use force push.'
  }
  if (error instanceof GitMergeConflict) {
    if (error.command.startsWith('git pull')) {
      return 'Pull resulted in merge conflicts. Resolve conflicts before continuing.'
    }
    if (error.conflicts.length > 0) {
      return `Merge conflicts in ${error.conflicts.length} file(s). Resolve conflicts before continuing.`
    }
  }
  if (error instanceof GitDirty) {
    if (error.command.startsWith('git pull')) {
      return 'You have uncommitted changes. Commit or stash them before pulling.'
    }
    return 'Local changes would be overwritten. Commit or stash them before continuing.'
  }
  if (error instanceof GitPermissionDenied) {
    return 'Authentication failed. Check your credentials.'
  }
  if (error instanceof GitNetworkError) {
    return 'Could not connect to remote repository. Check your network connection and authentication.'
  }
  if (error instanceof GitNotARepository) {
    return 'Not a git repository'
  }
  if (error instanceof GitUnknown && /GitHub CLI is not installed|spawn gh ENOENT|gh: command not found/i.test(stderr)) {
    return 'GitHub CLI is not installed or not in PATH'
  }
  return stderr || (error instanceof Error ? error.message : String(error))
}

const failureEnvelope = (cause: Cause.Cause<GitError>) => {
  const error = failureValue(cause)
  const env = fromCause(cause, { humanize: humanMessage })
  if (error instanceof GitMergeConflict) {
    return { success: false as const, ...env, conflicts: [...error.conflicts] }
  }
  return { success: false as const, ...env }
}

const runResult = async <A extends object>(program: Effect.Effect<A, GitError, Git>): Promise<A> => {
  const exit = await getRuntime().runPromiseExit(tagged(program))
  return Exit.match(exit, {
    onSuccess: (value) => value,
    onFailure: (cause) => failureEnvelope(cause) as A
  })
}

const runValue = async <A>(
  program: Effect.Effect<A, GitError, Git>,
  fallback: A
): Promise<A> => {
  const exit = await getRuntime().runPromiseExit(tagged(program))
  return Exit.match(exit, {
    onSuccess: (value) => value,
    onFailure: () => fallback
  })
}

class GitFacade {
  getAllBranches(repoPath: string): Promise<string[]> {
    return runValue(Effect.flatMap(Git, (git) => git.repo.getAllBranches(repoPath)), [])
  }

  getCurrentBranch(repoPath: string): Promise<string> {
    return runValue(Effect.flatMap(Git, (git) => git.repo.getCurrentBranch(repoPath)), 'main')
  }

  hasCommits(repoPath: string): Promise<boolean> {
    return runValue(Effect.flatMap(Git, (git) => git.repo.hasCommits(repoPath)), false)
  }

  getDefaultBranch(repoPath: string): Promise<string> {
    return runValue(Effect.flatMap(Git, (git) => git.repo.getDefaultBranch(repoPath)), 'main')
  }

  listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    return runValue(Effect.flatMap(Git, (git) => git.worktree.list(repoPath)), [])
  }

  createWorktree(
    repoPath: string,
    projectName: string,
    breedType?: BreedType,
    options?: { autoPull?: boolean; worktreeCreateScript?: string | null }
  ): Promise<CreateWorktreeResult> {
    return runResult(Effect.flatMap(Git, (git) => git.worktree.create(repoPath, projectName, breedType, options)))
  }

  removeWorktree(repoPath: string, worktreePath: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.worktree.remove(repoPath, worktreePath)))
  }

  archiveWorktree(
    repoPath: string,
    worktreePath: string,
    branchName: string
  ): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.worktree.archive(repoPath, worktreePath, branchName)))
  }

  branchExists(repoPath: string, branchName: string): Promise<boolean> {
    return runValue(Effect.flatMap(Git, (git) => git.branch.exists(repoPath, branchName)), false)
  }

  worktreeExists(repoPath: string, worktreePath: string): Promise<boolean> {
    return runValue(Effect.flatMap(Git, (git) => git.worktree.exists(repoPath, worktreePath)), false)
  }

  pruneWorktrees(repoPath: string): Promise<void> {
    return runValue(Effect.flatMap(Git, (git) => git.worktree.prune(repoPath)), undefined)
  }

  getFileStatuses(repoPath: string): Promise<GitStatusResult> {
    return runResult(Effect.flatMap(Git, (git) => git.file.status(repoPath)))
  }

  stageFile(repoPath: string, filePath: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.file.stage(repoPath, filePath)))
  }

  unstageFile(repoPath: string, filePath: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.file.unstage(repoPath, filePath)))
  }

  discardChanges(repoPath: string, filePath: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.file.discard(repoPath, filePath)))
  }

  getBranchInfo(repoPath: string): Promise<GitBranchInfoResult> {
    return runResult(Effect.flatMap(Git, (git) => git.branch.info(repoPath)))
  }

  stageAll(repoPath: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.file.stageAll(repoPath)))
  }

  unstageAll(repoPath: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.file.unstageAll(repoPath)))
  }

  addToGitignore(repoPath: string, pattern: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.file.addToGitignore(repoPath, pattern)))
  }

  commit(repoPath: string, message: string): Promise<GitCommitResult> {
    return runResult(Effect.flatMap(Git, (git) => git.commit.commit(repoPath, message)))
  }

  push(repoPath: string, remote?: string, branch?: string, force?: boolean): Promise<GitPushResult> {
    return runResult(Effect.flatMap(Git, (git) => git.commit.push(repoPath, remote, branch, force)))
  }

  pull(repoPath: string, remote?: string, branch?: string, rebase?: boolean): Promise<GitPullResult> {
    return runResult(Effect.flatMap(Git, (git) => git.commit.pull(repoPath, remote, branch, rebase)))
  }

  pullBaseBranch(
    repoPath: string,
    branchName: string,
    options?: { silent?: boolean; skipPull?: boolean }
  ): Promise<GitPullResult> {
    return runResult(Effect.flatMap(Git, (git) => git.commit.pullBaseBranch(repoPath, branchName, options)))
  }

  merge(repoPath: string, sourceBranch: string): Promise<GitMergeResult> {
    return runResult(Effect.flatMap(Git, (git) => git.commit.merge(repoPath, sourceBranch)))
  }

  mergeAbort(repoPath: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.commit.mergeAbort(repoPath)))
  }

  hasUncommittedChanges(repoPath: string): Promise<boolean> {
    return runValue(Effect.flatMap(Git, (git) => git.repo.hasUncommittedChanges(repoPath)), false)
  }

  getBranchDiffShortStat(repoPath: string, baseBranch: string): Promise<GitBranchDiffShortStatResult> {
    return runResult(Effect.flatMap(Git, (git) => git.diff.branchDiffShortStat(repoPath, baseBranch)))
  }

  getDiff(repoPath: string, filePath: string, staged?: boolean, contextLines?: number): Promise<GitDiffResult> {
    return runResult(Effect.flatMap(Git, (git) => git.diff.getDiff(repoPath, filePath, staged, contextLines)))
  }

  getRefContent(repoPath: string, ref: string, filePath: string): Promise<GitRefContentResult> {
    return runResult(Effect.flatMap(Git, (git) => git.content.getRefContent(repoPath, ref, filePath)))
  }

  getRefContentBase64(repoPath: string, ref: string, filePath: string): Promise<GitRefContentBase64Result> {
    return runResult(Effect.flatMap(Git, (git) => git.content.getRefContentBase64(repoPath, ref, filePath)))
  }

  getBranchBaseContent(repoPath: string, branch: string, filePath: string): Promise<GitRefContentResult> {
    return runResult(Effect.flatMap(Git, (git) => git.content.getBranchBaseContent(repoPath, branch, filePath)))
  }

  getBranchBaseContentBase64(repoPath: string, branch: string, filePath: string): Promise<GitRefContentBase64Result> {
    return runResult(Effect.flatMap(Git, (git) => git.content.getBranchBaseContentBase64(repoPath, branch, filePath)))
  }

  stageHunk(repoPath: string, patch: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.file.stageHunk(repoPath, patch)))
  }

  unstageHunk(repoPath: string, patch: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.file.unstageHunk(repoPath, patch)))
  }

  revertHunk(repoPath: string, patch: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.file.revertHunk(repoPath, patch)))
  }

  duplicateWorktree(
    repoPath: string,
    sourceBranch: string,
    sourceWorktreePath: string,
    projectName: string,
    nameHint?: string,
    options?: { worktreeCreateScript?: string | null }
  ): Promise<CreateWorktreeResult> {
    return runResult(Effect.flatMap(Git, (git) => git.worktree.duplicate(repoPath, sourceBranch, sourceWorktreePath, projectName, nameHint, options)))
  }

  getUntrackedFileDiff(repoPath: string, filePath: string): Promise<GitDiffResult> {
    return runResult(Effect.flatMap(Git, (git) => git.diff.getUntrackedFileDiff(repoPath, filePath)))
  }

  renameBranch(repoPath: string, worktreePath: string, oldBranch: string, newBranch: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.branch.rename(repoPath, worktreePath, oldBranch, newBranch)))
  }

  listBranchesWithStatus(repoPath: string): Promise<GitBranchWithStatus[]> {
    return runValue(Effect.flatMap(Git, (git) => git.branch.listWithStatus(repoPath)), [])
  }

  createWorktreeFromBranch(
    repoPath: string,
    projectName: string,
    branchName: string,
    breedType?: BreedType,
    prNumber?: number,
    options?: { autoPull?: boolean; nameHint?: string; worktreeCreateScript?: string | null }
  ): Promise<CreateWorktreeResult> {
    return runResult(Effect.flatMap(Git, (git) => git.worktree.createFromBranch(repoPath, projectName, branchName, breedType, prNumber, options)))
  }

  getRemoteUrl(repoPath: string, remote?: string): Promise<GitRemoteUrlResult> {
    return runResult(Effect.flatMap(Git, (git) => git.repo.getRemoteUrl(repoPath, remote)))
  }

  deleteBranch(repoPath: string, branchName: string): Promise<GitOperationResult> {
    return runResult(Effect.flatMap(Git, (git) => git.branch.delete(repoPath, branchName)))
  }

  isBranchMerged(repoPath: string, branch: string): Promise<{ success: boolean; isMerged: boolean }> {
    return runResult(Effect.flatMap(Git, (git) => git.branch.isMerged(repoPath, branch)))
  }

  getDiffStat(repoPath: string): Promise<GitDiffStatResult> {
    return runResult(Effect.flatMap(Git, (git) => git.diff.getDiffStat(repoPath)))
  }

  getBranchDiffFiles(repoPath: string, branch: string): Promise<GitBranchDiffFilesResult> {
    return runResult(Effect.flatMap(Git, (git) => git.diff.branchDiffFiles(repoPath, branch)))
  }

  getBranchFileDiff(repoPath: string, branch: string, filePath: string): Promise<GitBranchFileDiffResult> {
    return runResult(Effect.flatMap(Git, (git) => git.diff.branchFileDiff(repoPath, branch, filePath)))
  }

  createPullRequest(repoPath: string, options: GitCreatePullRequestOptions): Promise<GitCreatePullRequestResult> {
    return runResult(Effect.flatMap(Git, (git) => git.pr.createPullRequest(repoPath, options)))
  }

  getRangeDiff(repoPath: string, baseBranch: string): Promise<GitRangeDiffResult> {
    return runValue(
      Effect.flatMap(Git, (git) => git.diff.getRangeDiff(repoPath, baseBranch)),
      { commitSummary: '', diffSummary: '', diffPatch: '', commitCount: 0 }
    )
  }

  needsPush(repoPath: string): Promise<boolean> {
    return runValue(Effect.flatMap(Git, (git) => git.repo.needsPush(repoPath)), true)
  }
}

export const gitService = new GitFacade()
