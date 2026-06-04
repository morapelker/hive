import {
  createGitService,
  type GitCommitResult,
  type GitOperationResult,
  type GitPushResult,
  type GitService
} from './git-service'
import { generatePRContent as defaultGeneratePRContent } from './pr-content-generator'
import { createLogger } from './logger'

const log = createLogger({ component: 'DiscordPR' })

export interface CreatePrFromWorktreeInput {
  worktreePath: string
  baseBranch: string | null
  commitMessage: string
}

export type CreatePrResult =
  | { status: 'created'; url: string; number?: number }
  | { status: 'exists'; url: string; number?: number }
  | { status: 'nothing' }
  | { status: 'error'; message: string }

export interface GitServiceLike {
  getDefaultBranch(): Promise<string>
  getCurrentBranch(): Promise<string>
  hasUncommittedChanges(): Promise<boolean>
  stageAll(): Promise<GitOperationResult>
  commit(message: string): Promise<GitCommitResult>
  getRangeDiff(baseBranch: string): Promise<{
    commitSummary: string
    diffSummary: string
    diffPatch: string
    commitCount: number
  }>
  push(): Promise<GitPushResult>
  createPullRequest(options: {
    baseBranch: string
    title: string
    body: string
  }): Promise<{ success: boolean; url?: string; number?: number; error?: string }>
}

export interface CreatePrDeps {
  gitFactory?: (repoPath: string) => GitServiceLike
  generatePRContent?: typeof defaultGeneratePRContent
}

export async function createPrFromWorktree(
  input: CreatePrFromWorktreeInput,
  deps: CreatePrDeps = {}
): Promise<CreatePrResult> {
  const git = (deps.gitFactory ?? defaultGitFactory)(input.worktreePath)

  try {
    let base = input.baseBranch?.trim() || null
    if (!base) {
      base = await git.getDefaultBranch().catch(() => null)
    }
    base = base || 'main'

    const head = (await git.getCurrentBranch()).trim()
    if (!head || head === 'HEAD') {
      return {
        status: 'error',
        message: 'Could not determine the current branch (detached HEAD?).'
      }
    }
    if (head === base) {
      return { status: 'error', message: `Already on the base branch (${base}).` }
    }

    let committed = false
    if (await git.hasUncommittedChanges()) {
      const staged = await git.stageAll()
      if (!staged.success) {
        return { status: 'error', message: `Failed to stage changes: ${friendly(staged.error)}` }
      }

      const commit = await git.commit(input.commitMessage)
      if (!commit.success) {
        return { status: 'error', message: `Failed to commit changes: ${friendly(commit.error)}` }
      }
      committed = true
    }

    const range = await git.getRangeDiff(base)
    if (range.commitCount === 0 && !committed) {
      return { status: 'nothing' }
    }

    let title = ''
    let body = ''
    try {
      const content = await (deps.generatePRContent ?? defaultGeneratePRContent)({
        baseBranch: base,
        headBranch: head,
        commitSummary: range.commitSummary,
        diffSummary: range.diffSummary,
        diffPatch: range.diffPatch,
        provider: 'claude-code',
        cwd: input.worktreePath
      })
      title = content.title
      body = content.body
    } catch (error) {
      log.warn('PR content generation failed; using fallback', {
        error: error instanceof Error ? error.message : String(error),
        worktreePath: input.worktreePath,
        baseBranch: base,
        headBranch: head
      })
    }
    if (!title) title = head
    if (!body) body = ''

    const pushed = await git.push()
    if (!pushed.success) {
      return { status: 'error', message: `Failed to push branch: ${friendly(pushed.error)}` }
    }

    const pr = await git.createPullRequest({ baseBranch: base, title, body })
    if (pr.success && pr.url) {
      return { status: 'created', url: pr.url, number: pr.number }
    }
    if (pr.url) {
      return { status: 'exists', url: pr.url, number: pr.number }
    }

    return { status: 'error', message: friendly(pr.error) }
  } catch (error) {
    return { status: 'error', message: friendly(error) }
  }
}

const defaultGitFactory = (repoPath: string): GitService => createGitService(repoPath)

function friendly(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error ?? '')).trim()
  if (!message) return 'Unknown error'

  if (
    /not a git repository|no such remote|repository not found|could not read from remote repository/i.test(
      message
    )
  ) {
    return 'This worktree is not connected to a GitHub repository with a usable remote.'
  }

  if (/github cli is not installed|gh: command not found|spawn gh enoent/i.test(message)) {
    return 'GitHub CLI is not installed or not in PATH.'
  }

  if (/gh auth login|authentication required|not logged in|not authenticated/i.test(message)) {
    return 'GitHub CLI is not authenticated. Run `gh auth login` and try again.'
  }

  return message
}
