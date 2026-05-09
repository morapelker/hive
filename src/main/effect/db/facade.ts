import type {
  CreateFromBranchParams,
  CreateWorktreeParams,
  DeleteWorktreeParams,
  DuplicateWorktreeParams,
  RenameBranchParams,
  SyncWorktreesParams
} from '../../services/worktree-ops'
import {
  createWorktreeFromBranchOp,
  createWorktreeOp,
  deleteWorktreeOp,
  duplicateWorktreeOp,
  renameWorktreeBranchOp,
  syncWorktreesOp
} from '../../services/worktree-ops'

export const worktreeOpsFacade = {
  create: (params: CreateWorktreeParams) => createWorktreeOp(params),
  delete: (params: DeleteWorktreeParams) => deleteWorktreeOp(params),
  sync: (params: SyncWorktreesParams) => syncWorktreesOp(params),
  duplicate: (params: DuplicateWorktreeParams) => duplicateWorktreeOp(params),
  renameBranch: (params: RenameBranchParams) => renameWorktreeBranchOp(params),
  createFromBranch: (params: CreateFromBranchParams) => createWorktreeFromBranchOp(params)
}
