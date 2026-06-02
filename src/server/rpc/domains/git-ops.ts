import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  promises as fsPromises,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Effect } from 'effect'
import simpleGit from 'simple-git'
import { z } from 'zod'
import { isDesktopCommandResult, makeDesktopCommandRequest } from '@shared/desktop-command'
import { GIT_STATUS_CHANGED_CHANNEL } from '@shared/git-events'
import { getImageMimeType } from '@shared/types/file-utils'
import type { GitBranchInfo, GitFileStatus, PRReviewComment } from '@shared/types/git'
import { telemetryService } from '../../../main/services/telemetry-service'
import type { EventBus } from '../../events/event-bus'
import type { RpcHandler } from '../router'

export interface GitFileStatusResult {
  readonly success: boolean
  readonly files?: GitFileStatus[]
  readonly error?: string
}

export interface GitOperationResult {
  readonly success: boolean
  readonly error?: string
}

export interface GitBranchWithStatus {
  readonly name: string
  readonly isRemote: boolean
  readonly isCheckedOut: boolean
  readonly worktreePath?: string
}

export interface GitListBranchesWithStatusResult {
  readonly success: boolean
  readonly branches: GitBranchWithStatus[]
  readonly error?: string
}

export interface GitCommitResult {
  readonly success: boolean
  readonly commitHash?: string
  readonly error?: string
}

export interface GitPushResult {
  readonly success: boolean
  readonly pushed?: boolean
  readonly error?: string
}

export interface GitPullResult {
  readonly success: boolean
  readonly updated?: boolean
  readonly error?: string
}

export interface GitMergeResult {
  readonly success: boolean
  readonly error?: string
  readonly conflicts?: string[]
}

export interface GitBranchDiffShortStatResult {
  readonly success: boolean
  readonly filesChanged: number
  readonly insertions: number
  readonly deletions: number
  readonly commitsAhead: number
  readonly error?: string
}

export interface GitDiffResult {
  readonly success: boolean
  readonly diff?: string
  readonly fileName?: string
  readonly error?: string
}

export interface GitBranchFileDiffResult {
  readonly success: boolean
  readonly diff?: string
  readonly error?: string
}

export interface GitRangeDiffResult {
  readonly commitSummary: string
  readonly diffSummary: string
  readonly diffPatch: string
  readonly commitCount: number
}

export interface GitFileContentResult {
  readonly success: boolean
  readonly content: string | null
  readonly error?: string
}

export interface GitRefContentResult {
  readonly success: boolean
  readonly content?: string
  readonly error?: string
}

export interface GitRefContentBase64Result {
  readonly success: boolean
  readonly data?: string
  readonly mimeType?: string
  readonly error?: string
}

export interface GitFileContentBase64Result {
  readonly success: boolean
  readonly data?: string
  readonly mimeType?: string
  readonly error?: string
}

export interface GitRemoteUrlResult {
  readonly success: boolean
  readonly url: string | null
  readonly remote: string | null
  readonly error?: string
}

export interface GitDiffStatFile {
  path: string
  additions: number
  deletions: number
  binary: boolean
}

export interface GitDiffStatResult {
  readonly success: boolean
  readonly files?: GitDiffStatFile[]
  readonly error?: string
}

export interface GitBranchDiffFile {
  readonly relativePath: string
  readonly status: string
  readonly additions: number
  readonly deletions: number
  readonly binary: boolean
}

export interface GitBranchDiffFilesResult {
  readonly success: boolean
  readonly files?: GitBranchDiffFile[]
  readonly error?: string
}

export interface GitBranchMergedResult {
  readonly success: boolean
  readonly isMerged: boolean
}

export interface GitCreatePullRequestResult {
  readonly success: boolean
  readonly url?: string
  readonly number?: number
  readonly error?: string
}

export interface GitGeneratePullRequestContentResult {
  readonly success: boolean
  readonly title?: string
  readonly body?: string
  readonly error?: string
}

export interface GitPullRequestSummary {
  readonly number: number
  readonly title: string
  readonly author: string
  readonly headRefName: string
}

export interface GitListPullRequestsResult {
  readonly success: boolean
  readonly prs: GitPullRequestSummary[]
  readonly error?: string
}

export interface GitPullRequestStateResult {
  readonly success: boolean
  readonly state?: string
  readonly title?: string
  readonly error?: string
}

export interface GitPullRequestReviewCommentsResult {
  readonly success: boolean
  readonly comments?: PRReviewComment[]
  readonly baseBranch?: string
  readonly error?: string
}

interface GQLReviewThread {
  readonly isResolved: boolean
  readonly isOutdated: boolean
  readonly diffSide: 'LEFT' | 'RIGHT'
  readonly comments?: {
    readonly nodes?: ReadonlyArray<{
      readonly databaseId: number
      readonly body?: string
      readonly bodyHTML?: string
      readonly author?: { readonly login?: string; readonly avatarUrl?: string } | null
      readonly path?: string
      readonly line?: number | null
      readonly originalLine?: number | null
      readonly diffHunk?: string
      readonly createdAt?: string
      readonly updatedAt?: string
      readonly subjectType?: 'LINE' | 'FILE'
      readonly pullRequestReview?: { readonly databaseId?: number } | null
    }>
  }
}

export interface GitBranchInfoResult {
  readonly success: boolean
  readonly branch?: GitBranchInfo
  readonly error?: string
}

export interface GitOpsRpcService {
  readonly getFileStatuses: (
    worktreePath: string
  ) => Effect.Effect<GitFileStatusResult, unknown, never>
  readonly stageFile: (
    worktreePath: string,
    filePath: string
  ) => Effect.Effect<GitOperationResult, unknown, never>
  readonly unstageFile: (
    worktreePath: string,
    filePath: string
  ) => Effect.Effect<GitOperationResult, unknown, never>
  readonly discardChanges: (
    worktreePath: string,
    filePath: string
  ) => Effect.Effect<null, unknown, never>
  readonly addToGitignore: (
    worktreePath: string,
    pattern: string
  ) => Effect.Effect<GitOperationResult, unknown, never>
  readonly openInEditor: (filePath: string) => Effect.Effect<GitOperationResult, unknown, never>
  readonly showInFinder: (filePath: string) => Effect.Effect<GitOperationResult, unknown, never>
  readonly watchWorktree: (
    worktreePath: string
  ) => Effect.Effect<GitOperationResult, unknown, never>
  readonly unwatchWorktree: (
    worktreePath: string
  ) => Effect.Effect<GitOperationResult, unknown, never>
  readonly watchBranch: (worktreePath: string) => Effect.Effect<GitOperationResult, unknown, never>
  readonly unwatchBranch: (
    worktreePath: string
  ) => Effect.Effect<GitOperationResult, unknown, never>
  readonly getBranchInfo: (
    worktreePath: string
  ) => Effect.Effect<GitBranchInfoResult, unknown, never>
  readonly stageAll: (worktreePath: string) => Effect.Effect<GitOperationResult, unknown, never>
  readonly unstageAll: (worktreePath: string) => Effect.Effect<GitOperationResult, unknown, never>
  readonly stageHunk: (
    worktreePath: string,
    patch: string
  ) => Effect.Effect<GitOperationResult, unknown, never>
  readonly unstageHunk: (
    worktreePath: string,
    patch: string
  ) => Effect.Effect<GitOperationResult, unknown, never>
  readonly revertHunk: (
    worktreePath: string,
    patch: string
  ) => Effect.Effect<GitOperationResult, unknown, never>
  readonly commit: (
    worktreePath: string,
    message: string
  ) => Effect.Effect<GitCommitResult, unknown, never>
  readonly push: (
    worktreePath: string,
    remote?: string,
    branch?: string,
    force?: boolean
  ) => Effect.Effect<GitPushResult, unknown, never>
  readonly pull: (
    worktreePath: string,
    remote?: string,
    branch?: string,
    rebase?: boolean
  ) => Effect.Effect<GitPullResult, unknown, never>
  readonly merge: (
    worktreePath: string,
    sourceBranch: string
  ) => Effect.Effect<GitMergeResult, unknown, never>
  readonly mergeAbort: (worktreePath: string) => Effect.Effect<GitOperationResult, unknown, never>
  readonly hasUncommittedChanges: (worktreePath: string) => Effect.Effect<boolean, unknown, never>
  readonly branchDiffShortStat: (
    worktreePath: string,
    baseBranch: string
  ) => Effect.Effect<GitBranchDiffShortStatResult, unknown, never>
  readonly getDiff: (
    worktreePath: string,
    filePath: string,
    staged: boolean,
    isUntracked: boolean,
    contextLines?: number
  ) => Effect.Effect<GitDiffResult, unknown, never>
  readonly listBranchesWithStatus: (
    projectPath: string
  ) => Effect.Effect<GitListBranchesWithStatusResult, unknown, never>
  readonly getFileContent: (
    worktreePath: string,
    filePath: string
  ) => Effect.Effect<GitFileContentResult, unknown, never>
  readonly getFileContentBase64: (
    worktreePath: string,
    filePath: string
  ) => Effect.Effect<GitFileContentBase64Result, unknown, never>
  readonly getRefContent: (
    worktreePath: string,
    ref: string,
    filePath: string
  ) => Effect.Effect<GitRefContentResult, unknown, never>
  readonly getBranchBaseContent: (
    worktreePath: string,
    branch: string,
    filePath: string
  ) => Effect.Effect<GitRefContentResult, unknown, never>
  readonly getRefContentBase64: (
    worktreePath: string,
    ref: string,
    filePath: string
  ) => Effect.Effect<GitRefContentBase64Result, unknown, never>
  readonly getBranchBaseContentBase64: (
    worktreePath: string,
    branch: string,
    filePath: string
  ) => Effect.Effect<GitRefContentBase64Result, unknown, never>
  readonly getRemoteUrl: (
    worktreePath: string,
    remote?: string
  ) => Effect.Effect<GitRemoteUrlResult, unknown, never>
  readonly getDiffStat: (worktreePath: string) => Effect.Effect<GitDiffStatResult, unknown, never>
  readonly getBranchDiffFiles: (
    worktreePath: string,
    branch: string
  ) => Effect.Effect<GitBranchDiffFilesResult, unknown, never>
  readonly getBranchFileDiff: (
    worktreePath: string,
    branch: string,
    filePath: string
  ) => Effect.Effect<GitBranchFileDiffResult, unknown, never>
  readonly getRangeDiff: (
    worktreePath: string,
    baseBranch: string
  ) => Effect.Effect<GitRangeDiffResult, unknown, never>
  readonly needsPush: (worktreePath: string) => Effect.Effect<boolean, unknown, never>
  readonly createPR: (
    worktreePath: string,
    baseBranch: string,
    title: string,
    body: string
  ) => Effect.Effect<GitCreatePullRequestResult, unknown, never>
  readonly generatePRContent: (
    worktreePath: string,
    baseBranch: string,
    provider: string
  ) => Effect.Effect<GitGeneratePullRequestContentResult, unknown, never>
  readonly prMerge: (
    worktreePath: string,
    prNumber: number
  ) => Effect.Effect<GitOperationResult, unknown, never>
  readonly isBranchMerged: (
    worktreePath: string,
    branch: string
  ) => Effect.Effect<GitBranchMergedResult, unknown, never>
  readonly deleteBranch: (
    worktreePath: string,
    branchName: string
  ) => Effect.Effect<GitOperationResult, unknown, never>
  readonly listPRs: (
    projectPath: string
  ) => Effect.Effect<GitListPullRequestsResult, unknown, never>
  readonly getPRState: (
    projectPath: string,
    prNumber: number
  ) => Effect.Effect<GitPullRequestStateResult, unknown, never>
  readonly getPRReviewComments: (
    projectPath: string,
    prNumber: number
  ) => Effect.Effect<GitPullRequestReviewCommentsResult, unknown, never>
}

const worktreePathParamsSchema = z.object({ worktreePath: z.string().min(1) }).strict()
const filePathParamsSchema = z.object({ filePath: z.string().min(1) }).strict()
const fileOperationParamsSchema = z
  .object({ worktreePath: z.string().min(1), filePath: z.string().min(1) })
  .strict()
const refContentParamsSchema = z
  .object({ worktreePath: z.string().min(1), ref: z.string(), filePath: z.string().min(1) })
  .strict()
const branchContentParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    branch: z.string().min(1),
    filePath: z.string().min(1)
  })
  .strict()
const gitignoreParamsSchema = z
  .object({ worktreePath: z.string().min(1), pattern: z.string().min(1) })
  .strict()
const commitParamsSchema = z
  .object({ worktreePath: z.string().min(1), message: z.string() })
  .strict()
const hunkPatchParamsSchema = z
  .object({ worktreePath: z.string().min(1), patch: z.string().min(1) })
  .strict()
const pushParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    remote: z.string().optional(),
    branch: z.string().optional(),
    force: z.boolean().optional()
  })
  .strict()
const pullParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    remote: z.string().optional(),
    branch: z.string().optional(),
    rebase: z.boolean().optional()
  })
  .strict()
const mergeParamsSchema = z
  .object({ worktreePath: z.string().min(1), sourceBranch: z.string().min(1) })
  .strict()
const branchDiffShortStatParamsSchema = z
  .object({ worktreePath: z.string().min(1), baseBranch: z.string().min(1) })
  .strict()
const diffParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    filePath: z.string().min(1),
    staged: z.boolean(),
    isUntracked: z.boolean(),
    contextLines: z.number().optional()
  })
  .strict()
const remoteUrlParamsSchema = z
  .object({ worktreePath: z.string().min(1), remote: z.string().optional() })
  .strict()
const prMergeParamsSchema = z
  .object({ worktreePath: z.string().min(1), prNumber: z.number() })
  .strict()
const createPullRequestParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    baseBranch: z.string().min(1),
    title: z.string(),
    body: z.string()
  })
  .strict()
const generatePullRequestContentParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    baseBranch: z.string().min(1),
    provider: z.string().min(1)
  })
  .strict()
const branchNameParamsSchema = z
  .object({ worktreePath: z.string().min(1), branch: z.string().min(1) })
  .strict()
const deleteBranchParamsSchema = z
  .object({ worktreePath: z.string().min(1), branchName: z.string().min(1) })
  .strict()
const projectPathParamsSchema = z.object({ projectPath: z.string().min(1) }).strict()
const projectPullRequestParamsSchema = z
  .object({ projectPath: z.string().min(1), prNumber: z.number() })
  .strict()
const maxImageFileSize = 20 * 1024 * 1024

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
}

type CommandRunner = (
  file: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly maxBuffer?: number }
) => Promise<CommandResult>

const execFileAsync = promisify(execFile) as unknown as CommandRunner

const prReviewThreadsQuery =
  `query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){baseRefName reviewThreads(first:100){nodes{isResolved isOutdated diffSide comments(first:50){nodes{databaseId body bodyHTML author{login avatarUrl}path line originalLine diffHunk createdAt updatedAt subjectType pullRequestReview{databaseId}}}}}}}}` as const

const parseShortStat = (
  shortstat: string
): Pick<GitBranchDiffShortStatResult, 'filesChanged' | 'insertions' | 'deletions'> => {
  const filesMatch = shortstat.match(/(\d+) files? changed/)
  const insMatch = shortstat.match(/(\d+) insertions?/)
  const delMatch = shortstat.match(/(\d+) deletions?/)
  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0
  }
}

const parseNumstat = (line: string): GitDiffStatFile | null => {
  const [add, del, ...pathParts] = line.split('\t')
  const filePath = pathParts.join('\t')
  if (!filePath) return null
  const binary = add === '-' || del === '-'
  return {
    path: filePath,
    additions: binary ? 0 : parseInt(add, 10) || 0,
    deletions: binary ? 0 : parseInt(del, 10) || 0,
    binary
  }
}

const parseWorktreeForBranch = (porcelainOutput: string, branchName: string): string | null => {
  const blocks = porcelainOutput.trim().split('\n\n')
  for (const block of blocks) {
    const lines = block.split('\n')
    let worktreePath = ''
    let branch = ''
    for (const line of lines) {
      if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length)
      if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length)
    }
    if (branch === branchName && worktreePath) return worktreePath
  }
  return null
}

const invalidBranch = (branch: string): boolean => !branch || branch.startsWith('-')

const normalizeBranchDisplayName = (branchName: string): string =>
  branchName.startsWith('remotes/') ? branchName.replace(/^remotes\//, '') : branchName

const canonicalizePathForComparison = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const preserveRequestedProjectPath = (reportedPath: string, projectPath: string): string =>
  canonicalizePathForComparison(reportedPath) === canonicalizePathForComparison(projectPath)
    ? projectPath
    : reportedPath

export interface GitOpsRpcServiceDependencies {
  readonly runCommand?: CommandRunner
  readonly track?: (event: string, properties?: Record<string, unknown>) => void
  readonly eventBus?: EventBus
  readonly generatePRContent?: (options: {
    readonly baseBranch: string
    readonly headBranch: string
    readonly commitSummary: string
    readonly diffSummary: string
    readonly diffPatch: string
    readonly provider: string
    readonly cwd: string
  }) => Promise<{ readonly title: string; readonly body: string }>
}

export const makeLiveGitOpsRpcService = (
  dependencies: GitOpsRpcServiceDependencies = {}
): GitOpsRpcService => {
  const runCommand = dependencies.runCommand ?? execFileAsync
  const track = dependencies.track ?? telemetryService.track.bind(telemetryService)
  const eventBus = dependencies.eventBus
  const applyHunkPatch = async (
    worktreePath: string,
    patch: string,
    options: string[]
  ): Promise<GitOperationResult> => {
    const tmpFile = join(
      tmpdir(),
      `hive-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`
    )
    try {
      writeFileSync(tmpFile, patch, 'utf8')
      await simpleGit(worktreePath).applyPatch(tmpFile, options)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    } finally {
      try {
        unlinkSync(tmpFile)
      } catch {
        // Ignore cleanup errors for transient patch files.
      }
    }
  }

  return {
    getFileStatuses: (worktreePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitFileStatusResult> => {
          try {
            if (!existsSync(join(worktreePath, '.git'))) {
              return { success: true, files: [] }
            }

            const status = await simpleGit(worktreePath).status()
            const files: GitFileStatus[] = []
            const conflictedSet = new Set(status.conflicted)

            for (const fileStatus of status.files) {
              const filePath = fileStatus.path
              const fullPath = join(worktreePath, filePath)
              const idx = fileStatus.index
              const wd = fileStatus.working_dir

              if (conflictedSet.has(filePath)) {
                files.push({ path: fullPath, relativePath: filePath, status: 'C', staged: false })
                continue
              }

              if (idx === '?' && wd === '?') {
                files.push({ path: fullPath, relativePath: filePath, status: '?', staged: false })
                continue
              }

              if (idx === 'M' || idx === 'A' || idx === 'D' || idx === 'R' || idx === 'C') {
                files.push({
                  path: fullPath,
                  relativePath: filePath,
                  status: idx === 'D' ? 'D' : idx === 'M' ? 'M' : 'A',
                  staged: true
                })
              }

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
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    stageFile: (worktreePath, filePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitOperationResult> => {
          try {
            await simpleGit(worktreePath).add(filePath)
            return { success: true }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    unstageFile: (worktreePath, filePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitOperationResult> => {
          try {
            await simpleGit(worktreePath).reset(['HEAD', '--', filePath])
            return { success: true }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    discardChanges: (worktreePath, filePath) =>
      Effect.tryPromise({
        try: async (): Promise<null> => {
          const git = simpleGit(worktreePath)
          const status = await git.status()
          if (status.not_added.includes(filePath)) {
            const fullPath = join(worktreePath, filePath)
            if (existsSync(fullPath)) unlinkSync(fullPath)
          } else {
            await git.checkout(['--', filePath])
          }
          return null
        },
        catch: (cause) => cause
      }),
    addToGitignore: (worktreePath, pattern) =>
      Effect.tryPromise({
        try: async (): Promise<GitOperationResult> => {
          try {
            const gitignorePath = join(worktreePath, '.gitignore')
            let content = ''
            if (existsSync(gitignorePath)) content = readFileSync(gitignorePath, 'utf8')
            const lines = content.split('\n').map((line) => line.trim())
            if (lines.includes(pattern)) return { success: true }

            const newLine = content.endsWith('\n') || content === '' ? pattern : `\n${pattern}`
            if (content === '') writeFileSync(gitignorePath, `${pattern}\n`)
            else appendFileSync(gitignorePath, `${newLine}\n`)
            return { success: true }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    openInEditor: (filePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitOperationResult> => {
          const { openPathWithPreferredEditor } =
            await import('../../../main/services/settings-openers')
          return openPathWithPreferredEditor(filePath)
        },
        catch: (cause) => cause
      }),
    showInFinder: (filePath) =>
      Effect.tryPromise({
        try: () => requestGitShowInFinderCommand(filePath),
        catch: (cause) => cause
      }),
    watchWorktree: (worktreePath) =>
      Effect.tryPromise({
        try: () => requestGitWorktreeMutationCommand('watchGitWorktree', worktreePath, eventBus),
        catch: (cause) => cause
      }),
    unwatchWorktree: (worktreePath) =>
      Effect.tryPromise({
        try: () => requestGitWorktreeMutationCommand('unwatchGitWorktree', worktreePath),
        catch: (cause) => cause
      }),
    watchBranch: (worktreePath) =>
      Effect.tryPromise({
        try: () => requestGitWorktreeMutationCommand('watchGitBranch', worktreePath),
        catch: (cause) => cause
      }),
    unwatchBranch: (worktreePath) =>
      Effect.tryPromise({
        try: () => requestGitWorktreeMutationCommand('unwatchGitBranch', worktreePath),
        catch: (cause) => cause
      }),
    getBranchInfo: (worktreePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitBranchInfoResult> => {
          try {
            const status = await simpleGit(worktreePath).status()
            return {
              success: true,
              branch: {
                name: status.current || 'HEAD',
                tracking: status.tracking || null,
                ahead: status.tracking ? status.ahead : 0,
                behind: status.tracking ? status.behind : 0
              }
            }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    stageAll: (worktreePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitOperationResult> => {
          try {
            await simpleGit(worktreePath).add(['-A'])
            return { success: true }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    unstageAll: (worktreePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitOperationResult> => {
          try {
            await simpleGit(worktreePath).reset(['HEAD'])
            return { success: true }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    stageHunk: (worktreePath, patch) =>
      Effect.tryPromise({
        try: () => applyHunkPatch(worktreePath, patch, ['--cached', '--unidiff-zero']),
        catch: (cause) => cause
      }),
    unstageHunk: (worktreePath, patch) =>
      Effect.tryPromise({
        try: () => applyHunkPatch(worktreePath, patch, ['--cached', '--reverse', '--unidiff-zero']),
        catch: (cause) => cause
      }),
    revertHunk: (worktreePath, patch) =>
      Effect.tryPromise({
        try: () => applyHunkPatch(worktreePath, patch, ['--reverse', '--unidiff-zero']),
        catch: (cause) => cause
      }),
    commit: (worktreePath, message) =>
      Effect.tryPromise({
        try: async (): Promise<GitCommitResult> => {
          try {
            if (!message || message.trim() === '') {
              return { success: false, error: 'Commit message is required' }
            }

            const git = simpleGit(worktreePath)
            const status = await git.status()
            const hasStagedChanges = status.staged.length > 0 || status.created.length > 0
            if (!hasStagedChanges) return { success: false, error: 'No staged changes to commit' }

            const result = await git.commit(message)
            track('git_commit_made')
            return { success: true, commitHash: result.commit }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    push: (worktreePath, remote, branch, force) =>
      Effect.tryPromise({
        try: async (): Promise<GitPushResult> => {
          try {
            const git = simpleGit(worktreePath)
            const remoteName = remote || 'origin'
            const branchName = branch || (await git.branch()).current
            const options: string[] = []
            if (force) options.push('--force')

            const status = await git.status()
            if (!status.tracking) options.push('--set-upstream')

            await git.push(remoteName, branchName, options)
            track('git_push_made')
            return { success: true, pushed: true }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    pull: (worktreePath, remote, branch, rebase) =>
      Effect.tryPromise({
        try: async (): Promise<GitPullResult> => {
          try {
            const git = simpleGit(worktreePath)
            const remoteName = remote || 'origin'
            const branchName = branch || (await git.branch()).current
            const options: Record<string, null | string | number> = {}
            if (rebase) options['--rebase'] = null

            const result = await git.pull(remoteName, branchName, options)
            return {
              success: true,
              updated: (result.files?.length || 0) > 0 || result.summary.changes > 0
            }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    merge: (worktreePath, sourceBranch) =>
      Effect.tryPromise({
        try: async (): Promise<GitMergeResult> => {
          try {
            await simpleGit(worktreePath).merge([sourceBranch])
            return { success: true }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => cause
      }),
    mergeAbort: (worktreePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitOperationResult> => {
          try {
            await simpleGit(worktreePath).raw(['merge', '--abort'])
            return { success: true }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => cause
      }),
    hasUncommittedChanges: (worktreePath) =>
      Effect.tryPromise({
        try: async (): Promise<boolean> => {
          try {
            const output = await simpleGit(worktreePath).raw(['status', '--porcelain'])
            return output.trim().length > 0
          } catch {
            return false
          }
        },
        catch: (cause) => cause
      }),
    branchDiffShortStat: (worktreePath, baseBranch) =>
      Effect.tryPromise({
        try: async (): Promise<GitBranchDiffShortStatResult> => {
          try {
            const git = simpleGit(worktreePath)
            const stat = parseShortStat(
              await git.raw(['diff', '--shortstat', `${baseBranch}...HEAD`])
            )
            const revList = await git.raw(['rev-list', '--count', `${baseBranch}..HEAD`])
            return {
              success: true,
              ...stat,
              commitsAhead: parseInt(revList.trim(), 10) || 0
            }
          } catch (error) {
            return {
              success: false,
              filesChanged: 0,
              insertions: 0,
              deletions: 0,
              commitsAhead: 0,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => cause
      }),
    getDiff: (worktreePath, filePath, staged, isUntracked, contextLines) =>
      Effect.tryPromise({
        try: async (): Promise<GitDiffResult> => {
          try {
            if (isUntracked) {
              const content = readFileSync(join(worktreePath, filePath), 'utf8')
              const lines = content.split('\n')
              return {
                success: true,
                diff: [
                  `diff --git a/${filePath} b/${filePath}`,
                  'new file mode 100644',
                  '--- /dev/null',
                  `+++ b/${filePath}`,
                  `@@ -0,0 +1,${lines.length} @@`,
                  ...lines.map((line) => `+${line}`)
                ].join('\n'),
                fileName: basename(filePath) || filePath
              }
            }

            const args = ['diff']
            if (contextLines !== undefined) args.push(`-U${contextLines}`)
            if (staged) args.push('--cached')
            args.push('--', filePath)
            const diff = await simpleGit(worktreePath).raw(args)
            return {
              success: true,
              diff: diff || '',
              fileName: basename(filePath) || filePath
            }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => cause
      }),
    listBranchesWithStatus: (projectPath) =>
      Effect.tryPromise({
        try: async (): Promise<GitListBranchesWithStatusResult> => {
          try {
            const git = simpleGit(projectPath)
            const [branchSummary, worktreeList] = await Promise.all([
              git.branch(['-a']),
              git.raw(['worktree', 'list', '--porcelain'])
            ])
            const checkedOut = new Map<string, string>()
            for (const block of worktreeList.split('\n\n').filter(Boolean)) {
              const lines = block.split('\n')
              const worktreePath = lines
                .find((line) => line.startsWith('worktree '))
                ?.replace('worktree ', '')
              const branch = lines
                .find((line) => line.startsWith('branch '))
                ?.replace('branch refs/heads/', '')
              if (worktreePath && branch) {
                checkedOut.set(branch, preserveRequestedProjectPath(worktreePath, projectPath))
              }
            }

            return {
              success: true,
              branches: Object.entries(branchSummary.branches).map(([name, info]) => ({
                name: normalizeBranchDisplayName(name),
                isRemote: name.startsWith('remotes/'),
                isCheckedOut: checkedOut.has(info.name),
                worktreePath: checkedOut.get(info.name)
              }))
            }
          } catch (error) {
            return {
              success: false,
              branches: [],
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    getFileContent: (worktreePath, filePath) =>
      Effect.try({
        try: (): GitFileContentResult => {
          try {
            const content = readFileSync(join(worktreePath, filePath), 'utf8')
            return { success: true, content }
          } catch (error) {
            return {
              success: false,
              content: null,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => cause
      }),
    getFileContentBase64: (worktreePath, filePath) =>
      Effect.try({
        try: (): GitFileContentBase64Result => {
          try {
            const fullPath = join(worktreePath, filePath)
            if (!fullPath || typeof fullPath !== 'string') {
              return { success: false, error: 'Invalid file path' }
            }
            if (!existsSync(fullPath)) {
              return { success: false, error: 'File does not exist' }
            }
            const stat = statSync(fullPath)
            if (stat.isDirectory()) {
              return { success: false, error: 'Path is a directory' }
            }
            if (stat.size > maxImageFileSize) {
              return { success: false, error: 'File too large (max 20MB)' }
            }

            const data = readFileSync(fullPath).toString('base64')
            const mimeType = getImageMimeType(fullPath) ?? undefined
            return { success: true, data, mimeType }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    getRefContent: (worktreePath, ref, filePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitRefContentResult> => {
          try {
            const refSpec = ref ? `${ref}:${filePath}` : `:${filePath}`
            const content = await simpleGit(worktreePath).show([refSpec])
            return { success: true, content }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => cause
      }),
    getBranchBaseContent: (worktreePath, branch, filePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitRefContentResult> => {
          if (invalidBranch(branch)) return { success: false, error: 'Invalid branch name' }

          try {
            const git = simpleGit(worktreePath)
            const mergeBase = await git
              .raw(['merge-base', branch, 'HEAD'])
              .then((result) => result.trim() || null)
              .catch(() => null)
            const ref = mergeBase ?? branch
            const content = await git.show([`${ref}:${filePath}`])
            return { success: true, content }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => cause
      }),
    getRefContentBase64: (worktreePath, ref, filePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitRefContentBase64Result> => {
          try {
            const refSpec = ref ? `${ref}:${filePath}` : `:${filePath}`
            const stdout = await new Promise<Buffer>((resolve, reject) => {
              execFile(
                'git',
                ['show', refSpec],
                { cwd: worktreePath, encoding: 'buffer', maxBuffer: maxImageFileSize },
                (error, output) => {
                  if (error) {
                    reject(error)
                    return
                  }
                  resolve(Buffer.from(output))
                }
              )
            })
            return {
              success: true,
              data: stdout.toString('base64'),
              mimeType: getImageMimeType(filePath) ?? undefined
            }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => cause
      }),
    getBranchBaseContentBase64: (worktreePath, branch, filePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitRefContentBase64Result> => {
          if (invalidBranch(branch)) return { success: false, error: 'Invalid branch name' }

          try {
            const git = simpleGit(worktreePath)
            const mergeBase = await git
              .raw(['merge-base', branch, 'HEAD'])
              .then((result) => result.trim() || null)
              .catch(() => null)
            const ref = mergeBase ?? branch
            const stdout = await new Promise<Buffer>((resolve, reject) => {
              execFile(
                'git',
                ['show', `${ref}:${filePath}`],
                { cwd: worktreePath, encoding: 'buffer', maxBuffer: maxImageFileSize },
                (error, output) => {
                  if (error) {
                    reject(error)
                    return
                  }
                  resolve(Buffer.from(output))
                }
              )
            })
            return {
              success: true,
              data: stdout.toString('base64'),
              mimeType: getImageMimeType(filePath) ?? undefined
            }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => cause
      }),
    getRemoteUrl: (worktreePath, remote = 'origin') =>
      Effect.tryPromise({
        try: async (): Promise<GitRemoteUrlResult> => {
          try {
            const remotes = await simpleGit(worktreePath).getRemotes(true)
            const target = remotes.find((candidate) => candidate.name === remote)
            return {
              success: true,
              url: target?.refs?.fetch || target?.refs?.push || null,
              remote: target?.name || null
            }
          } catch (error) {
            return {
              success: false,
              url: null,
              remote: null,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    getDiffStat: (worktreePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitDiffStatResult> => {
          try {
            const git = simpleGit(worktreePath)
            const files: GitDiffStatFile[] = []
            const seen = new Set<string>()
            const addFile = (file: GitDiffStatFile): void => {
              if (seen.has(file.path)) {
                const existing = files.find((candidate) => candidate.path === file.path)
                if (existing && !file.binary) {
                  existing.additions += file.additions
                  existing.deletions += file.deletions
                }
                return
              }
              seen.add(file.path)
              files.push(file)
            }

            for (const line of (await git.raw(['diff', '--cached', '--numstat']))
              .trim()
              .split('\n')) {
              if (!line) continue
              const parsed = parseNumstat(line)
              if (parsed) addFile(parsed)
            }
            for (const line of (await git.raw(['diff', '--numstat'])).trim().split('\n')) {
              if (!line) continue
              const parsed = parseNumstat(line)
              if (parsed) addFile(parsed)
            }
            const status = await git.status()
            for (const filePath of status.not_added) {
              if (seen.has(filePath)) continue
              seen.add(filePath)
              const text = await fsPromises
                .readFile(join(worktreePath, filePath), 'utf8')
                .catch(() => null)
              files.push({
                path: filePath,
                additions: text ? text.split('\n').length : 0,
                deletions: 0,
                binary: false
              })
            }
            return { success: true, files }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    getBranchDiffFiles: (worktreePath, branch) =>
      Effect.tryPromise({
        try: async (): Promise<GitBranchDiffFilesResult> => {
          if (invalidBranch(branch)) return { success: false, error: 'Invalid branch name' }

          try {
            const git = simpleGit(worktreePath)
            const mergeBase = await git
              .raw(['merge-base', branch, 'HEAD'])
              .then((result) => result.trim() || null)
              .catch(() => null)
            const diffRef = mergeBase ?? branch
            const [nameStatusResult, numstatResult] = await Promise.all([
              git.raw(['diff', '--name-status', '--no-renames', diffRef]),
              git.raw(['diff', '--numstat', '--no-renames', diffRef])
            ])
            const files = new Map<string, GitBranchDiffFile>()

            for (const line of nameStatusResult.trim().split('\n')) {
              if (!line) continue
              const [status, ...pathParts] = line.split('\t')
              const relativePath = pathParts.join('\t')
              if (status && relativePath) {
                files.set(relativePath, {
                  relativePath,
                  status,
                  additions: 0,
                  deletions: 0,
                  binary: false
                })
              }
            }

            for (const line of numstatResult.trim().split('\n')) {
              if (!line) continue
              const [add, del, ...pathParts] = line.split('\t')
              const relativePath = pathParts.join('\t')
              if (!relativePath) continue
              const binary = add === '-' || del === '-'
              files.set(relativePath, {
                relativePath,
                status: files.get(relativePath)?.status ?? '',
                additions: binary ? 0 : parseInt(add, 10) || 0,
                deletions: binary ? 0 : parseInt(del, 10) || 0,
                binary
              })
            }

            return {
              success: true,
              files: Array.from(files.values()).sort((a, b) => {
                const aMissingStatus = a.status === ''
                const bMissingStatus = b.status === ''
                if (aMissingStatus === bMissingStatus) return 0
                return aMissingStatus ? 1 : -1
              })
            }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    getBranchFileDiff: (worktreePath, branch, filePath) =>
      Effect.tryPromise({
        try: async (): Promise<GitBranchFileDiffResult> => {
          if (invalidBranch(branch)) return { success: false, error: 'Invalid branch name' }

          try {
            const git = simpleGit(worktreePath)
            const mergeBase = await git
              .raw(['merge-base', branch, 'HEAD'])
              .then((result) => result.trim() || null)
              .catch(() => null)
            const diffRef = mergeBase ?? branch
            const diff = await git.raw(['diff', diffRef, '--', filePath])
            return { success: true, diff: diff || '' }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => cause
      }),
    getRangeDiff: (worktreePath, baseBranch) =>
      Effect.tryPromise({
        try: async (): Promise<GitRangeDiffResult> => {
          if (invalidBranch(baseBranch)) {
            return { commitSummary: '', diffSummary: '', diffPatch: '', commitCount: 0 }
          }

          const maxSummary = 20 * 1024
          const maxPatch = 60 * 1024
          const runGit = async <A>(
            args: ReadonlyArray<string>,
            fallback: A,
            map: (stdout: string) => A,
            maxBuffer?: number
          ): Promise<A> => {
            try {
              const { stdout } = await runCommand('git', args, { cwd: worktreePath, maxBuffer })
              return map(stdout)
            } catch {
              return fallback
            }
          }

          const [commitLog, diffStat, diffPatch, commitCount] = await Promise.all([
            runGit(['log', '--oneline', `${baseBranch}..HEAD`], '', (stdout) => stdout),
            runGit(['diff', '--stat', `${baseBranch}...HEAD`], '', (stdout) => stdout),
            runGit(
              ['diff', '--patch', '--minimal', `${baseBranch}...HEAD`],
              '',
              (stdout) => stdout,
              maxPatch * 2
            ),
            runGit(
              ['rev-list', '--count', `${baseBranch}..HEAD`],
              0,
              (stdout) => parseInt(stdout.trim(), 10) || 0
            )
          ])

          return {
            commitSummary: commitLog.slice(0, maxSummary),
            diffSummary: diffStat.slice(0, maxSummary),
            diffPatch: diffPatch.slice(0, maxPatch),
            commitCount
          }
        },
        catch: () => ({ commitSummary: '', diffSummary: '', diffPatch: '', commitCount: 0 })
      }),
    needsPush: (worktreePath) =>
      Effect.tryPromise({
        try: async (): Promise<boolean> => {
          try {
            const { stdout } = await runCommand('git', ['rev-list', '--count', '@{u}..HEAD'], {
              cwd: worktreePath
            })
            return parseInt(stdout.trim(), 10) > 0
          } catch {
            return true
          }
        },
        catch: () => false
      }),
    createPR: (worktreePath, baseBranch, title, body) =>
      Effect.tryPromise({
        try: async (): Promise<GitCreatePullRequestResult> => {
          if (invalidBranch(baseBranch)) {
            return { success: false, error: 'Invalid branch name' }
          }

          const normalizedBaseBranch = baseBranch.replace(/^[^/]+\//, '')
          const tempDir = mkdtempSync(join(tmpdir(), 'hive-gh-pr-'))
          const tempFile = join(tempDir, 'body.md')

          try {
            writeFileSync(tempFile, body, 'utf-8')
            const { stdout } = await runCommand(
              'gh',
              [
                'pr',
                'create',
                '--base',
                normalizedBaseBranch,
                '--title',
                title,
                '--body-file',
                tempFile
              ],
              { cwd: worktreePath }
            )
            const url = stdout.trim()
            const match = url.match(/\/pull\/(\d+)/)
            return { success: true, url, number: match ? parseInt(match[1], 10) : undefined }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (/already exists/i.test(message)) {
              const urlMatch = message.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)
              const url = urlMatch?.[0]
              const numberMatch = url?.match(/\/pull\/(\d+)/)
              return {
                success: false,
                error: message,
                url,
                number: numberMatch ? parseInt(numberMatch[1], 10) : undefined
              }
            }

            return { success: false, error: message }
          } finally {
            try {
              rmSync(tempDir, { recursive: true, force: true })
            } catch {
              // Temporary cleanup failure should not mask the pull request result.
            }
          }
        },
        catch: (cause) => ({
          success: false,
          error: cause instanceof Error ? cause.message : String(cause)
        })
      }),
    generatePRContent: (worktreePath, baseBranch, provider) =>
      Effect.tryPromise({
        try: async (): Promise<GitGeneratePullRequestContentResult> => {
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

            const maxSummary = 20 * 1024
            const maxPatch = 60 * 1024
            const runGit = async <A>(
              args: ReadonlyArray<string>,
              fallback: A,
              map: (stdout: string) => A,
              maxBuffer?: number
            ): Promise<A> => {
              try {
                const { stdout } = await runCommand('git', args, { cwd: worktreePath, maxBuffer })
                return map(stdout)
              } catch {
                return fallback
              }
            }

            const [commitSummary, diffSummary, diffPatch] = await Promise.all([
              runGit(['log', '--oneline', `${baseBranch}..HEAD`], '', (stdout) =>
                stdout.slice(0, maxSummary)
              ),
              runGit(['diff', '--stat', `${baseBranch}...HEAD`], '', (stdout) =>
                stdout.slice(0, maxSummary)
              ),
              runGit(
                ['diff', '--patch', '--minimal', `${baseBranch}...HEAD`],
                '',
                (stdout) => stdout.slice(0, maxPatch),
                maxPatch * 2
              )
            ])

            let headBranch = 'HEAD'
            try {
              const status = await simpleGit(worktreePath).status()
              headBranch = status.current || 'HEAD'
            } catch {
              headBranch = 'HEAD'
            }

            const generator =
              dependencies.generatePRContent ??
              (async (options) => {
                const module = await import('../../../main/services/pr-content-generator')
                return module.generatePRContent({
                  ...options,
                  provider: options.provider as never
                })
              })
            const result = await generator({
              baseBranch,
              headBranch,
              commitSummary,
              diffSummary,
              diffPatch,
              provider,
              cwd: worktreePath
            })

            return { success: true, title: result.title, body: result.body }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => ({
          success: false,
          error: cause instanceof Error ? cause.message : String(cause)
        })
      }),
    prMerge: (worktreePath, prNumber) =>
      Effect.tryPromise({
        try: async (): Promise<GitOperationResult> => {
          try {
            await runCommand('gh', ['pr', 'merge', String(prNumber), '--merge'], {
              cwd: worktreePath
            })

            const prInfoResult = await runCommand(
              'gh',
              ['pr', 'view', String(prNumber), '--json', 'baseRefName', '-q', '.baseRefName'],
              { cwd: worktreePath }
            )
            const targetBranch = prInfoResult.stdout.trim()

            const worktreeListResult = await runCommand(
              'git',
              ['worktree', 'list', '--porcelain'],
              {
                cwd: worktreePath
              }
            )
            const targetWorktreePath = parseWorktreeForBranch(
              worktreeListResult.stdout,
              targetBranch
            )

            if (targetWorktreePath) {
              const currentBranch = await runCommand('git', ['branch', '--show-current'], {
                cwd: worktreePath
              })
              await runCommand('git', ['merge', currentBranch.stdout.trim()], {
                cwd: targetWorktreePath
              })
            }

            return { success: true }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => cause
      }),
    isBranchMerged: (worktreePath, branch) =>
      Effect.tryPromise({
        try: async (): Promise<GitBranchMergedResult> => {
          try {
            const result = await simpleGit(worktreePath).raw([
              'rev-list',
              '--count',
              `HEAD..${branch}`
            ])
            return {
              success: true,
              isMerged: (parseInt(result.trim(), 10) || 0) === 0
            }
          } catch {
            return { success: true, isMerged: false }
          }
        },
        catch: (cause) => cause
      }),
    deleteBranch: (worktreePath, branchName) =>
      Effect.tryPromise({
        try: async (): Promise<GitOperationResult> => {
          try {
            await simpleGit(worktreePath).branch(['-D', branchName])
            return { success: true }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        },
        catch: (cause) => cause
      }),
    listPRs: (projectPath) =>
      Effect.tryPromise({
        try: async (): Promise<GitListPullRequestsResult> => {
          try {
            await runCommand('git', ['fetch', 'origin'], { cwd: projectPath })
            const { stdout } = await runCommand(
              'gh',
              [
                'pr',
                'list',
                '--json',
                'number,title,author,headRefName',
                '--state',
                'open',
                '--limit',
                '100'
              ],
              { cwd: projectPath }
            )
            const raw = JSON.parse(stdout) as Array<{
              number: number
              title: string
              author: { login: string }
              headRefName: string
            }>
            return {
              success: true,
              prs: raw.map((pr) => ({
                number: pr.number,
                title: pr.title,
                author: pr.author.login,
                headRefName: pr.headRefName
              }))
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (
              message.includes('gh: command not found') ||
              message.includes('not found') ||
              message.includes('ENOENT')
            ) {
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
        },
        catch: (cause) => cause
      }),
    getPRState: (projectPath, prNumber) =>
      Effect.tryPromise({
        try: async (): Promise<GitPullRequestStateResult> => {
          try {
            const { stdout } = await runCommand(
              'gh',
              ['pr', 'view', String(prNumber), '--json', 'state,title'],
              { cwd: projectPath }
            )
            const data = JSON.parse(stdout) as { state: string; title: string }
            return { success: true, state: data.state, title: data.title }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        },
        catch: (cause) => cause
      }),
    getPRReviewComments: (projectPath, prNumber) =>
      Effect.tryPromise({
        try: async (): Promise<GitPullRequestReviewCommentsResult> => {
          try {
            const { stdout: repoInfo } = await runCommand(
              'gh',
              ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
              { cwd: projectPath }
            )
            const [owner, repo] = repoInfo.trim().split('/')

            const { stdout } = await runCommand(
              'gh',
              [
                'api',
                'graphql',
                '-f',
                `query=${prReviewThreadsQuery}`,
                '-F',
                `owner=${owner}`,
                '-F',
                `repo=${repo}`,
                '-F',
                `pr=${prNumber}`
              ],
              { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
            )

            const response = JSON.parse(stdout) as {
              readonly errors?: ReadonlyArray<{ readonly message?: string }>
              readonly data?: {
                readonly repository?: {
                  readonly pullRequest?: {
                    readonly baseRefName?: string
                    readonly reviewThreads?: { readonly nodes?: GQLReviewThread[] }
                  }
                }
              }
            }
            if (response.errors?.length) {
              return { success: false, error: response.errors[0].message }
            }

            const pullRequest = response.data?.repository?.pullRequest
            const baseBranch = pullRequest?.baseRefName ?? undefined
            const threads = pullRequest?.reviewThreads?.nodes ?? []
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
            if (
              message.includes('gh: command not found') ||
              message.includes('not found') ||
              message.includes('ENOENT')
            ) {
              return { success: false, error: 'GitHub CLI (gh) is not installed' }
            }
            if (message.includes('Could not resolve to a Repository')) {
              return {
                success: false,
                error: 'Not a GitHub repository or not authenticated with gh'
              }
            }
            if (message.includes('404')) return { success: false, error: 'PR not found' }
            return { success: false, error: message }
          }
        },
        catch: (cause) => cause
      })
  }
}

export const makeGitOpsRpcHandlers = (
  service: GitOpsRpcService = makeLiveGitOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'gitOps.getFileStatuses',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getFileStatuses(worktreePath)
        })
    ],
    [
      'gitOps.stageFile',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, filePath } = yield* Effect.try({
            try: () => fileOperationParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.stageFile(worktreePath, filePath)
        })
    ],
    [
      'gitOps.unstageFile',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, filePath } = yield* Effect.try({
            try: () => fileOperationParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.unstageFile(worktreePath, filePath)
        })
    ],
    [
      'gitOps.discardChanges',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, filePath } = yield* Effect.try({
            try: () => fileOperationParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.discardChanges(worktreePath, filePath)
        })
    ],
    [
      'gitOps.addToGitignore',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, pattern } = yield* Effect.try({
            try: () => gitignoreParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.addToGitignore(worktreePath, pattern)
        })
    ],
    [
      'gitOps.openInEditor',
      (params) =>
        Effect.gen(function* () {
          const { filePath } = yield* Effect.try({
            try: () => filePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.openInEditor(filePath)
        })
    ],
    [
      'gitOps.showInFinder',
      (params) =>
        Effect.gen(function* () {
          const { filePath } = yield* Effect.try({
            try: () => filePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.showInFinder(filePath)
        })
    ],
    [
      'gitOps.watchWorktree',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.watchWorktree(worktreePath)
        })
    ],
    [
      'gitOps.unwatchWorktree',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.unwatchWorktree(worktreePath)
        })
    ],
    [
      'gitOps.watchBranch',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.watchBranch(worktreePath)
        })
    ],
    [
      'gitOps.unwatchBranch',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.unwatchBranch(worktreePath)
        })
    ],
    [
      'gitOps.getBranchInfo',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getBranchInfo(worktreePath)
        })
    ],
    [
      'gitOps.stageAll',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.stageAll(worktreePath)
        })
    ],
    [
      'gitOps.unstageAll',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.unstageAll(worktreePath)
        })
    ],
    [
      'gitOps.stageHunk',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, patch } = yield* Effect.try({
            try: () => hunkPatchParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.stageHunk(worktreePath, patch)
        })
    ],
    [
      'gitOps.unstageHunk',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, patch } = yield* Effect.try({
            try: () => hunkPatchParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.unstageHunk(worktreePath, patch)
        })
    ],
    [
      'gitOps.revertHunk',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, patch } = yield* Effect.try({
            try: () => hunkPatchParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.revertHunk(worktreePath, patch)
        })
    ],
    [
      'gitOps.commit',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, message } = yield* Effect.try({
            try: () => commitParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.commit(worktreePath, message)
        })
    ],
    [
      'gitOps.push',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, remote, branch, force } = yield* Effect.try({
            try: () => pushParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.push(worktreePath, remote, branch, force)
        })
    ],
    [
      'gitOps.pull',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, remote, branch, rebase } = yield* Effect.try({
            try: () => pullParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.pull(worktreePath, remote, branch, rebase)
        })
    ],
    [
      'gitOps.merge',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, sourceBranch } = yield* Effect.try({
            try: () => mergeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.merge(worktreePath, sourceBranch)
        })
    ],
    [
      'gitOps.mergeAbort',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.mergeAbort(worktreePath)
        })
    ],
    [
      'gitOps.hasUncommittedChanges',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.hasUncommittedChanges(worktreePath)
        })
    ],
    [
      'gitOps.branchDiffShortStat',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, baseBranch } = yield* Effect.try({
            try: () => branchDiffShortStatParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.branchDiffShortStat(worktreePath, baseBranch)
        })
    ],
    [
      'gitOps.getDiff',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, filePath, staged, isUntracked, contextLines } = yield* Effect.try({
            try: () => diffParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getDiff(worktreePath, filePath, staged, isUntracked, contextLines)
        })
    ],
    [
      'gitOps.listBranchesWithStatus',
      (params) =>
        Effect.gen(function* () {
          const { projectPath } = yield* Effect.try({
            try: () => projectPathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.listBranchesWithStatus(projectPath)
        })
    ],
    [
      'gitOps.getFileContent',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, filePath } = yield* Effect.try({
            try: () => fileOperationParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getFileContent(worktreePath, filePath)
        })
    ],
    [
      'gitOps.getFileContentBase64',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, filePath } = yield* Effect.try({
            try: () => fileOperationParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getFileContentBase64(worktreePath, filePath)
        })
    ],
    [
      'gitOps.getRefContent',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, ref, filePath } = yield* Effect.try({
            try: () => refContentParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getRefContent(worktreePath, ref, filePath)
        })
    ],
    [
      'gitOps.getBranchBaseContent',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, branch, filePath } = yield* Effect.try({
            try: () => branchContentParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getBranchBaseContent(worktreePath, branch, filePath)
        })
    ],
    [
      'gitOps.getRefContentBase64',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, ref, filePath } = yield* Effect.try({
            try: () => refContentParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getRefContentBase64(worktreePath, ref, filePath)
        })
    ],
    [
      'gitOps.getBranchBaseContentBase64',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, branch, filePath } = yield* Effect.try({
            try: () => branchContentParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getBranchBaseContentBase64(worktreePath, branch, filePath)
        })
    ],
    [
      'gitOps.getRemoteUrl',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, remote } = yield* Effect.try({
            try: () => remoteUrlParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getRemoteUrl(worktreePath, remote)
        })
    ],
    [
      'gitOps.getDiffStat',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getDiffStat(worktreePath)
        })
    ],
    [
      'gitOps.getBranchDiffFiles',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, branch } = yield* Effect.try({
            try: () => branchNameParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getBranchDiffFiles(worktreePath, branch)
        })
    ],
    [
      'gitOps.getBranchFileDiff',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, branch, filePath } = yield* Effect.try({
            try: () => branchContentParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getBranchFileDiff(worktreePath, branch, filePath)
        })
    ],
    [
      'gitOps.getRangeDiff',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, baseBranch } = yield* Effect.try({
            try: () => branchDiffShortStatParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getRangeDiff(worktreePath, baseBranch)
        })
    ],
    [
      'gitOps.needsPush',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath } = yield* Effect.try({
            try: () => worktreePathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.needsPush(worktreePath)
        })
    ],
    [
      'gitOps.createPR',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, baseBranch, title, body } = yield* Effect.try({
            try: () => createPullRequestParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createPR(worktreePath, baseBranch, title, body)
        })
    ],
    [
      'gitOps.generatePRContent',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, baseBranch, provider } = yield* Effect.try({
            try: () => generatePullRequestContentParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.generatePRContent(worktreePath, baseBranch, provider)
        })
    ],
    [
      'gitOps.prMerge',
      (params, context) =>
        Effect.gen(function* () {
          const { worktreePath, prNumber } = yield* Effect.try({
            try: () => prMergeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          const result = yield* service.prMerge(worktreePath, prNumber)
          if (result.success) {
            yield* context.eventBus.publish({
              channel: GIT_STATUS_CHANGED_CHANNEL,
              payload: { worktreePath }
            })
          }
          return result
        })
    ],
    [
      'gitOps.isBranchMerged',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, branch } = yield* Effect.try({
            try: () => branchNameParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.isBranchMerged(worktreePath, branch)
        })
    ],
    [
      'gitOps.deleteBranch',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, branchName } = yield* Effect.try({
            try: () => deleteBranchParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.deleteBranch(worktreePath, branchName)
        })
    ],
    [
      'gitOps.listPRs',
      (params) =>
        Effect.gen(function* () {
          const { projectPath } = yield* Effect.try({
            try: () => projectPathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.listPRs(projectPath)
        })
    ],
    [
      'gitOps.getPRState',
      (params) =>
        Effect.gen(function* () {
          const { projectPath, prNumber } = yield* Effect.try({
            try: () => projectPullRequestParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getPRState(projectPath, prNumber)
        })
    ],
    [
      'gitOps.getPRReviewComments',
      (params) =>
        Effect.gen(function* () {
          const { projectPath, prNumber } = yield* Effect.try({
            try: () => projectPullRequestParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getPRReviewComments(projectPath, prNumber)
        })
    ]
  ])

const requestGitWorktreeMutationCommand = (
  command: 'watchGitWorktree' | 'unwatchGitWorktree' | 'watchGitBranch' | 'unwatchGitBranch',
  worktreePath: string,
  eventBus?: EventBus
): Promise<GitOperationResult> => {
  if (command === 'watchGitBranch' || command === 'unwatchGitBranch') {
    return import('../../../main/services/branch-watcher').then(
      async ({ unwatchBranch, watchBranch }) => {
        try {
          if (command === 'watchGitBranch') await watchBranch(worktreePath)
          else await unwatchBranch(worktreePath)
          return { success: true }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      }
    )
  }

  return import('../../../main/services/worktree-watcher').then(
    async ({ unwatchWorktree, watchWorktree }) => {
      try {
        if (command === 'watchGitWorktree') {
          await watchWorktree(worktreePath, {
            publishGitEvent: eventBus
              ? (channel, payload) => Effect.runPromise(eventBus.publish({ channel, payload }))
              : undefined
          })
        } else await unwatchWorktree(worktreePath)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
}

const requestGitShowInFinderCommand = (filePath: string): Promise<GitOperationResult> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve({ success: true })
  }

  const id = `git-show-in-finder-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'gitShowInFinder'

  return new Promise<GitOperationResult>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value?: GitOperationResult, error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve(value ?? { success: true })
    }
    const timeout = setTimeout(() => {
      finish(undefined, new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(undefined, new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      if (!isGitOperationResult(message.value)) {
        finish(undefined, new Error(`Desktop command returned invalid response: ${command}`))
        return
      }
      finish(message.value)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { filePath }), (error) => {
      if (!error) return
      finish(undefined, error)
    })
  })
}

const isGitOperationResult = (value: unknown): value is GitOperationResult =>
  typeof value === 'object' &&
  value !== null &&
  'success' in value &&
  typeof value.success === 'boolean' &&
  (!('error' in value) || typeof value.error === 'string')
