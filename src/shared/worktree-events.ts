import type { Worktree } from './types/worktree'

export const WORKTREE_BRANCH_RENAMED_CHANNEL = 'worktree:branchRenamed'
export const WORKTREE_CREATED_CHANNEL = 'worktree:created'

export interface WorktreeBranchRenamedEvent {
  readonly worktreeId: string
  readonly newBranch: string
  readonly worktreePath: string
}

export interface WorktreeCreatedEvent {
  readonly projectId: string
  readonly worktree: Worktree
}
