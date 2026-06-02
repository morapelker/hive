export const WORKTREE_BRANCH_RENAMED_CHANNEL = 'worktree:branchRenamed'

export interface WorktreeBranchRenamedEvent {
  readonly worktreeId: string
  readonly newBranch: string
}
