import type { Worktree } from './types/worktree'

export const WORKTREE_BRANCH_RENAMED_CHANNEL = 'worktree:branchRenamed'
export const WORKTREE_CREATED_CHANNEL = 'worktree:created'

export interface WorktreeBranchRenamedEvent {
  readonly worktreeId: string
  readonly newBranch: string
  readonly worktreePath: string
  /**
   * The name the branch had before, when the branch itself was renamed (not when the worktree
   * merely switched to another branch). Whoever holds the old name as a choice — a compare
   * branch, a merge source — moves it to `newBranch`.
   */
  readonly oldBranch?: string
  /** The project of the worktree: its worktrees are reloaded, bases of dependents included. */
  readonly projectId?: string
}

export interface WorktreeCreatedEvent {
  readonly projectId: string
  readonly worktree: Worktree
}
