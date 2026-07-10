import { Context, Effect } from 'effect'

import type { GitError } from './errors'
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

type Eff<A> = Effect.Effect<A, GitError>

export class Git extends Context.Tag('GitIsland/Git')<
  Git,
  {
    readonly repo: {
      readonly getAllBranches: (repoPath: string) => Eff<string[]>
      readonly getCurrentBranch: (repoPath: string) => Eff<string>
      readonly hasCommits: (repoPath: string) => Eff<boolean>
      readonly getDefaultBranch: (repoPath: string) => Eff<string>
      readonly hasUncommittedChanges: (repoPath: string) => Eff<boolean>
      readonly needsPush: (repoPath: string) => Eff<boolean>
      readonly getRemoteUrl: (repoPath: string, remote?: string) => Eff<GitRemoteUrlResult>
    }
    readonly worktree: {
      readonly list: (repoPath: string) => Eff<WorktreeInfo[]>
      readonly create: (
        repoPath: string,
        projectName: string,
        breedType?: BreedType,
        options?: { autoPull?: boolean; worktreeCreateScript?: string | null }
      ) => Eff<CreateWorktreeResult>
      readonly remove: (repoPath: string, worktreePath: string) => Eff<GitOperationResult>
      readonly archive: (
        repoPath: string,
        worktreePath: string,
        branchName: string
      ) => Eff<GitOperationResult>
      readonly prune: (repoPath: string) => Eff<void>
      readonly exists: (repoPath: string, worktreePath: string) => Eff<boolean>
      readonly duplicate: (
        repoPath: string,
        sourceBranch: string,
        sourceWorktreePath: string,
        projectName: string,
        nameHint?: string,
        options?: { worktreeCreateScript?: string | null }
      ) => Eff<CreateWorktreeResult>
      readonly createFromBranch: (
        repoPath: string,
        projectName: string,
        branchName: string,
        breedType?: BreedType,
        prNumber?: number,
        options?: { autoPull?: boolean; nameHint?: string; worktreeCreateScript?: string | null; baseRef?: string }
      ) => Eff<CreateWorktreeResult>
    }
    readonly branch: {
      readonly exists: (repoPath: string, branchName: string) => Eff<boolean>
      readonly rename: (
        repoPath: string,
        worktreePath: string,
        oldBranch: string,
        newBranch: string
      ) => Eff<GitOperationResult>
      readonly delete: (repoPath: string, branchName: string) => Eff<GitOperationResult>
      readonly isMerged: (repoPath: string, branch: string) => Eff<{ success: boolean; isMerged: boolean }>
      readonly info: (repoPath: string) => Eff<GitBranchInfoResult>
      readonly listWithStatus: (repoPath: string) => Eff<GitBranchWithStatus[]>
    }
    readonly file: {
      readonly status: (repoPath: string) => Eff<GitStatusResult>
      readonly stage: (repoPath: string, filePath: string) => Eff<GitOperationResult>
      readonly unstage: (repoPath: string, filePath: string) => Eff<GitOperationResult>
      readonly stageAll: (repoPath: string) => Eff<GitOperationResult>
      readonly unstageAll: (repoPath: string) => Eff<GitOperationResult>
      readonly discard: (repoPath: string, filePath: string) => Eff<GitOperationResult>
      readonly addToGitignore: (repoPath: string, pattern: string) => Eff<GitOperationResult>
      readonly stageHunk: (repoPath: string, patch: string) => Eff<GitOperationResult>
      readonly unstageHunk: (repoPath: string, patch: string) => Eff<GitOperationResult>
      readonly revertHunk: (repoPath: string, patch: string) => Eff<GitOperationResult>
    }
    readonly commit: {
      readonly commit: (repoPath: string, message: string) => Eff<GitCommitResult>
      readonly push: (
        repoPath: string,
        remote?: string,
        branch?: string,
        force?: boolean
      ) => Eff<GitPushResult>
      readonly pull: (
        repoPath: string,
        remote?: string,
        branch?: string,
        rebase?: boolean
      ) => Eff<GitPullResult>
      readonly pullBaseBranch: (
        repoPath: string,
        branchName: string,
        options?: { silent?: boolean; skipPull?: boolean }
      ) => Eff<GitPullResult>
      readonly merge: (repoPath: string, sourceBranch: string) => Eff<GitMergeResult>
      readonly mergeAbort: (repoPath: string) => Eff<GitOperationResult>
    }
    readonly diff: {
      readonly getDiff: (
        repoPath: string,
        filePath: string,
        staged?: boolean,
        contextLines?: number
      ) => Eff<GitDiffResult>
      readonly getUntrackedFileDiff: (repoPath: string, filePath: string) => Eff<GitDiffResult>
      readonly getDiffStat: (repoPath: string) => Eff<GitDiffStatResult>
      readonly branchDiffShortStat: (
        repoPath: string,
        baseBranch: string
      ) => Eff<GitBranchDiffShortStatResult>
      readonly branchDiffFiles: (repoPath: string, branch: string) => Eff<GitBranchDiffFilesResult>
      readonly branchFileDiff: (
        repoPath: string,
        branch: string,
        filePath: string
      ) => Eff<GitBranchFileDiffResult>
      readonly getRangeDiff: (repoPath: string, baseBranch: string) => Eff<GitRangeDiffResult>
    }
    readonly content: {
      readonly getRefContent: (
        repoPath: string,
        ref: string,
        filePath: string
      ) => Eff<GitRefContentResult>
      readonly getRefContentBase64: (
        repoPath: string,
        ref: string,
        filePath: string
      ) => Eff<GitRefContentBase64Result>
      readonly getBranchBaseContent: (
        repoPath: string,
        branch: string,
        filePath: string
      ) => Eff<GitRefContentResult>
      readonly getBranchBaseContentBase64: (
        repoPath: string,
        branch: string,
        filePath: string
      ) => Eff<GitRefContentBase64Result>
    }
    readonly pr: {
      readonly createPullRequest: (
        repoPath: string,
        options: GitCreatePullRequestOptions
      ) => Eff<GitCreatePullRequestResult>
    }
  }
>() {}
