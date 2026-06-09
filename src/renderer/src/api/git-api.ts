import { GIT_BRANCH_CHANGED_CHANNEL, GIT_STATUS_CHANGED_CHANNEL } from '@shared/git-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import type {
  GitBranchChangedEvent,
  GitBranchInfo,
  GitFileStatus,
  GitStatusChangedEvent,
  PRReviewComment
} from '@shared/types/git'
import { getRendererRpcClient } from './rpc-client'

type GitFileStatusesResult = {
  success: boolean
  files?: GitFileStatus[]
  error?: string
}

type GitBranchInfoResult = {
  success: boolean
  branch?: GitBranchInfo
  error?: string
}

type GitOperationResult = {
  success: boolean
  error?: string
}

type GitCommitResult = {
  success: boolean
  commitHash?: string
  error?: string
}

type GitGeneratePRContentResult = {
  success: boolean
  title?: string
  body?: string
  error?: string
}

type GitCreatePRResult = {
  success: boolean
  url?: string
  number?: number
  error?: string
}

type GitPRStateResult = {
  success: boolean
  state?: string
  title?: string
  error?: string
}

type GitPullRequestSummary = {
  number: number
  title: string
  author: string
  headRefName: string
}

type GitListPullRequestsResult = {
  success: boolean
  prs: GitPullRequestSummary[]
  error?: string
}

type GitPRReviewCommentsResult = {
  success: boolean
  comments?: PRReviewComment[]
  baseBranch?: string
  error?: string
}

type GitPRContentProvider = 'opencode' | 'claude-code' | 'codex'

type GitBranchDiffShortStatResult = {
  success: boolean
  filesChanged: number
  insertions: number
  deletions: number
  commitsAhead: number
  error?: string
}

type GitDiffResult = {
  success: boolean
  diff?: string
  fileName?: string
  error?: string
}

type GitBranchFileDiffResult = {
  success: boolean
  diff?: string
  error?: string
}

type GitFileContentResult = {
  success: boolean
  content: string | null
  error?: string
}

type GitRefContentResult = {
  success: boolean
  content?: string
  error?: string
}

type GitRefContentBase64Result = {
  success: boolean
  data?: string
  mimeType?: string
  error?: string
}

type GitFileContentBase64Result = {
  success: boolean
  data?: string
  mimeType?: string
  error?: string
}

type GitBranchBaseContentResult = {
  success: boolean
  content?: string
  error?: string
}

type GitBranchBaseContentBase64Result = {
  success: boolean
  data?: string
  mimeType?: string
  error?: string
}

type GitBranchStatus = {
  name: string
  isRemote: boolean
  isCheckedOut: boolean
  worktreePath?: string
}

type GitListBranchesWithStatusResult = {
  success: boolean
  branches: GitBranchStatus[]
  error?: string
}

type GitPushResult = {
  success: boolean
  pushed?: boolean
  error?: string
}

type GitPullResult = {
  success: boolean
  updated?: boolean
  error?: string
}

type GitMergeResult = {
  success: boolean
  error?: string
  conflicts?: string[]
}

type GitBranchMergedResult = {
  success: boolean
  isMerged: boolean
}

type GitRemoteUrlResult = {
  success: boolean
  url: string | null
  remote: string | null
  error?: string
}

type GitDiffStatFile = {
  path: string
  additions: number
  deletions: number
  binary: boolean
}

type GitDiffStatResult = {
  success: boolean
  files?: GitDiffStatFile[]
  error?: string
}

type GitBranchDiffFile = {
  relativePath: string
  status: string
  additions: number
  deletions: number
  binary: boolean
}

type GitBranchDiffFilesResult = {
  success: boolean
  files?: GitBranchDiffFile[]
  error?: string
}

type GitRangeDiffResult = {
  commitSummary: string
  diffSummary: string
  diffPatch: string
  commitCount: number
}

const isGitStatusChangedEvent = (value: unknown): value is GitStatusChangedEvent =>
  typeof value === 'object' &&
  value !== null &&
  'worktreePath' in value &&
  typeof value.worktreePath === 'string'

const isGitBranchChangedEvent = (value: unknown): value is GitBranchChangedEvent =>
  typeof value === 'object' &&
  value !== null &&
  'worktreePath' in value &&
  typeof value.worktreePath === 'string'

export const gitApi = {
  addToGitignore: async (worktreePath: string, pattern: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.addToGitignore', {
      worktreePath,
      pattern
    }),
  commit: async (worktreePath: string, message: string): Promise<GitCommitResult> =>
    getRendererRpcClient().request<GitCommitResult>('gitOps.commit', {
      worktreePath,
      message
    }),
  createPR: async (
    worktreePath: string,
    baseBranch: string,
    title: string,
    body: string
  ): Promise<GitCreatePRResult> =>
    getRendererRpcClient().request<GitCreatePRResult>('gitOps.createPR', {
      worktreePath,
      baseBranch,
      title,
      body
    }),
  branchDiffShortStat: async (
    worktreePath: string,
    baseBranch: string
  ): Promise<GitBranchDiffShortStatResult> =>
    getRendererRpcClient().request<GitBranchDiffShortStatResult>('gitOps.branchDiffShortStat', {
      worktreePath,
      baseBranch
    }),
  discardChanges: async (worktreePath: string, filePath: string): Promise<null> =>
    getRendererRpcClient().request<null>('gitOps.discardChanges', {
      worktreePath,
      filePath
    }),
  getBranchInfo: async (worktreePath: string): Promise<GitBranchInfoResult> =>
    getRendererRpcClient().request<GitBranchInfoResult>('gitOps.getBranchInfo', {
      worktreePath
    }),
  getFileStatuses: async (worktreePath: string): Promise<GitFileStatusesResult> =>
    getRendererRpcClient().request<GitFileStatusesResult>('gitOps.getFileStatuses', {
      worktreePath
    }),
  getFileContent: async (worktreePath: string, filePath: string): Promise<GitFileContentResult> =>
    getRendererRpcClient().request<GitFileContentResult>('gitOps.getFileContent', {
      worktreePath,
      filePath
    }),
  getRefContent: async (
    worktreePath: string,
    ref: string,
    filePath: string
  ): Promise<GitRefContentResult> =>
    getRendererRpcClient().request<GitRefContentResult>('gitOps.getRefContent', {
      worktreePath,
      ref,
      filePath
    }),
  getRefContentBase64: async (
    worktreePath: string,
    ref: string,
    filePath: string
  ): Promise<GitRefContentBase64Result> =>
    getRendererRpcClient().request<GitRefContentBase64Result>('gitOps.getRefContentBase64', {
      worktreePath,
      ref,
      filePath
    }),
  getFileContentBase64: async (
    worktreePath: string,
    filePath: string
  ): Promise<GitFileContentBase64Result> =>
    getRendererRpcClient().request<GitFileContentBase64Result>('gitOps.getFileContentBase64', {
      worktreePath,
      filePath
    }),
  getBranchBaseContent: async (
    worktreePath: string,
    branch: string,
    filePath: string
  ): Promise<GitBranchBaseContentResult> =>
    getRendererRpcClient().request<GitBranchBaseContentResult>('gitOps.getBranchBaseContent', {
      worktreePath,
      branch,
      filePath
    }),
  getBranchBaseContentBase64: async (
    worktreePath: string,
    branch: string,
    filePath: string
  ): Promise<GitBranchBaseContentBase64Result> =>
    getRendererRpcClient().request<GitBranchBaseContentBase64Result>(
      'gitOps.getBranchBaseContentBase64',
      {
        worktreePath,
        branch,
        filePath
      }
    ),
  generatePRContent: async (
    worktreePath: string,
    baseBranch: string,
    provider: GitPRContentProvider
  ): Promise<GitGeneratePRContentResult> =>
    getRendererRpcClient().request<GitGeneratePRContentResult>('gitOps.generatePRContent', {
      worktreePath,
      baseBranch,
      provider
    }),
  getDiff: async (
    worktreePath: string,
    filePath: string,
    staged: boolean,
    isUntracked: boolean,
    contextLines?: number
  ): Promise<GitDiffResult> =>
    getRendererRpcClient().request<GitDiffResult>('gitOps.getDiff', {
      worktreePath,
      filePath,
      staged,
      isUntracked,
      contextLines
    }),
  getBranchFileDiff: async (
    worktreePath: string,
    branch: string,
    filePath: string
  ): Promise<GitBranchFileDiffResult> =>
    getRendererRpcClient().request<GitBranchFileDiffResult>('gitOps.getBranchFileDiff', {
      worktreePath,
      branch,
      filePath
    }),
  getDiffStat: async (worktreePath: string): Promise<GitDiffStatResult> =>
    getRendererRpcClient().request<GitDiffStatResult>('gitOps.getDiffStat', {
      worktreePath
    }),
  getBranchDiffFiles: async (
    worktreePath: string,
    branch: string
  ): Promise<GitBranchDiffFilesResult> =>
    getRendererRpcClient().request<GitBranchDiffFilesResult>('gitOps.getBranchDiffFiles', {
      worktreePath,
      branch
    }),
  getRemoteUrl: async (worktreePath: string, remote?: string): Promise<GitRemoteUrlResult> =>
    getRendererRpcClient().request<GitRemoteUrlResult>('gitOps.getRemoteUrl', {
      worktreePath,
      remote
    }),
  getRangeDiff: async (worktreePath: string, baseBranch: string): Promise<GitRangeDiffResult> =>
    getRendererRpcClient().request<GitRangeDiffResult>('gitOps.getRangeDiff', {
      worktreePath,
      baseBranch
    }),
  getPRState: async (projectPath: string, prNumber: number): Promise<GitPRStateResult> =>
    getRendererRpcClient().request<GitPRStateResult>('gitOps.getPRState', {
      projectPath,
      prNumber
    }),
  getPRReviewComments: async (
    projectPath: string,
    prNumber: number
  ): Promise<GitPRReviewCommentsResult> =>
    getRendererRpcClient().request<GitPRReviewCommentsResult>('gitOps.getPRReviewComments', {
      projectPath,
      prNumber
    }),
  listPRs: async (projectPath: string): Promise<GitListPullRequestsResult> =>
    getRendererRpcClient().request<GitListPullRequestsResult>('gitOps.listPRs', {
      projectPath
    }),
  hasUncommittedChanges: async (worktreePath: string): Promise<boolean> =>
    getRendererRpcClient().request<boolean>('gitOps.hasUncommittedChanges', {
      worktreePath
    }),
  isBranchMerged: async (worktreePath: string, branch: string): Promise<GitBranchMergedResult> =>
    getRendererRpcClient().request<GitBranchMergedResult>('gitOps.isBranchMerged', {
      worktreePath,
      branch
    }),
  deleteBranch: async (worktreePath: string, branchName: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.deleteBranch', {
      worktreePath,
      branchName
    }),
  merge: async (worktreePath: string, sourceBranch: string): Promise<GitMergeResult> =>
    getRendererRpcClient().request<GitMergeResult>('gitOps.merge', {
      worktreePath,
      sourceBranch
    }),
  mergeAbort: async (worktreePath: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.mergeAbort', {
      worktreePath
    }),
  needsPush: async (worktreePath: string): Promise<boolean> =>
    getRendererRpcClient().request<boolean>('gitOps.needsPush', {
      worktreePath
    }),
  prMerge: async (worktreePath: string, prNumber: number): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.prMerge', {
      worktreePath,
      prNumber
    }),
  listBranchesWithStatus: async (projectPath: string): Promise<GitListBranchesWithStatusResult> =>
    getRendererRpcClient().request<GitListBranchesWithStatusResult>(
      'gitOps.listBranchesWithStatus',
      {
        projectPath
      }
    ),
  onStatusChanged: (callback: (event: GitStatusChangedEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(GIT_STATUS_CHANGED_CHANNEL, (event: ServerEvent) => {
      if (isGitStatusChangedEvent(event.payload)) {
        callback(event.payload)
      }
    }),
  onBranchChanged: (callback: (event: GitBranchChangedEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(GIT_BRANCH_CHANGED_CHANNEL, (event: ServerEvent) => {
      if (isGitBranchChangedEvent(event.payload)) {
        callback(event.payload)
      }
    }),
  watchWorktree: async (worktreePath: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.watchWorktree', {
      worktreePath
    }),
  watchBranch: async (worktreePath: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.watchBranch', {
      worktreePath
    }),
  unwatchWorktree: async (worktreePath: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.unwatchWorktree', {
      worktreePath
    }),
  unwatchBranch: async (worktreePath: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.unwatchBranch', {
      worktreePath
    }),
  openInEditor: async (filePath: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.openInEditor', {
      filePath
    }),
  showInFinder: async (filePath: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.showInFinder', {
      filePath
    }),
  push: async (
    worktreePath: string,
    remote?: string,
    branch?: string,
    force?: boolean
  ): Promise<GitPushResult> =>
    getRendererRpcClient().request<GitPushResult>('gitOps.push', {
      worktreePath,
      remote,
      branch,
      force
    }),
  pull: async (
    worktreePath: string,
    remote?: string,
    branch?: string,
    rebase?: boolean
  ): Promise<GitPullResult> =>
    getRendererRpcClient().request<GitPullResult>('gitOps.pull', {
      worktreePath,
      remote,
      branch,
      rebase
    }),
  stageFile: async (worktreePath: string, filePath: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.stageFile', {
      worktreePath,
      filePath
    }),
  stageAll: async (worktreePath: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.stageAll', {
      worktreePath
    }),
  stageHunk: async (worktreePath: string, patch: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.stageHunk', {
      worktreePath,
      patch
    }),
  unstageFile: async (worktreePath: string, filePath: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.unstageFile', {
      worktreePath,
      filePath
    }),
  unstageHunk: async (worktreePath: string, patch: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.unstageHunk', {
      worktreePath,
      patch
    }),
  revertHunk: async (worktreePath: string, patch: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.revertHunk', {
      worktreePath,
      patch
    }),
  unstageAll: async (worktreePath: string): Promise<GitOperationResult> =>
    getRendererRpcClient().request<GitOperationResult>('gitOps.unstageAll', {
      worktreePath
    })
}
