import {
  createGitService,
  type GitCommitResult,
  type GitOperationResult,
  type GitPushResult,
  type GitService
} from './git-service'

export interface PushWorktreeInput {
  worktreePath: string
  commitMessage: string
}

export type PushWorktreeResult =
  | { status: 'pushed'; branch: string; committed: boolean }
  | { status: 'error'; message: string }

export interface PushGitServiceLike {
  getCurrentBranch(): Promise<string>
  hasUncommittedChanges(): Promise<boolean>
  stageAll(): Promise<GitOperationResult>
  commit(message: string): Promise<GitCommitResult>
  push(): Promise<GitPushResult>
}

export interface PushWorktreeDeps {
  gitFactory?: (repoPath: string) => PushGitServiceLike
}

export async function pushWorktree(
  input: PushWorktreeInput,
  deps: PushWorktreeDeps = {}
): Promise<PushWorktreeResult> {
  const git = (deps.gitFactory ?? defaultGitFactory)(input.worktreePath)

  try {
    const head = (await git.getCurrentBranch()).trim()
    if (!head || head === 'HEAD') {
      return {
        status: 'error',
        message: 'Could not determine the current branch (detached HEAD?).'
      }
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

    const pushed = await git.push()
    if (!pushed.success) {
      return { status: 'error', message: `Failed to push branch: ${friendly(pushed.error)}` }
    }

    return { status: 'pushed', branch: head, committed }
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

  return message
}
