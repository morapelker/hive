import type { BreedType } from '../../services/breed-names'
import type {
  CreateWorktreeResult,
  GitBranchInfo,
  GitBranchInfoResult,
  GitCommitResult,
  GitDiffResult,
  GitDiffStatFile,
  GitDiffStatResult,
  GitFileStatus,
  GitMergeResult,
  GitOperationResult,
  GitPullResult,
  GitPushResult,
  GitStatusCode,
  GitStatusResult,
  WorktreeInfo
} from '../../services/git-service'

export type {
  BreedType,
  CreateWorktreeResult,
  GitBranchInfo,
  GitBranchInfoResult,
  GitCommitResult,
  GitDiffResult,
  GitDiffStatFile,
  GitDiffStatResult,
  GitFileStatus,
  GitMergeResult,
  GitOperationResult,
  GitPullResult,
  GitPushResult,
  GitStatusCode,
  GitStatusResult,
  WorktreeInfo
}

export type CreateWorktreePayload = Omit<CreateWorktreeResult, 'success' | 'error'>

export type GitRemoteUrlResult = {
  success: boolean
  url: string | null
  remote: string | null
  error?: string
}

export type GitBranchDiffShortStatResult = {
  success: boolean
  filesChanged: number
  insertions: number
  deletions: number
  commitsAhead: number
  error?: string
}

export type GitRefContentResult = {
  success: boolean
  content?: string
  error?: string
}

export type GitRefContentBase64Result = {
  success: boolean
  data?: string
  mimeType?: string
  error?: string
}

export type GitBranchDiffFile = {
  relativePath: string
  status: string
  additions: number
  deletions: number
  binary: boolean
}

export type GitBranchDiffFilesResult = {
  success: boolean
  files?: GitBranchDiffFile[]
  error?: string
}

export type GitBranchFileDiffResult = {
  success: boolean
  diff?: string
  error?: string
}

export type GitRangeDiffResult = {
  commitSummary: string
  diffSummary: string
  diffPatch: string
  commitCount: number
}

export type GitBranchWithStatus = {
  name: string
  isRemote: boolean
  isCheckedOut: boolean
  worktreePath?: string
}

export type GitCreatePullRequestOptions = {
  baseBranch: string
  title: string
  body: string
}

export type GitCreatePullRequestResult = {
  success: boolean
  url?: string
  number?: number
  error?: string
}
