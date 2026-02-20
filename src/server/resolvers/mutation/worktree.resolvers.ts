import type { Resolvers } from '../../__generated__/resolvers-types'
import {
  createWorktreeOp,
  deleteWorktreeOp,
  syncWorktreesOp,
  duplicateWorktreeOp,
  renameWorktreeBranchOp,
  createWorktreeFromBranchOp
} from '../../../main/services/worktree-ops'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapWorktree(row: any) {
  if (!row) return null
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    branchName: row.branch_name,
    path: row.path,
    status: row.status,
    isDefault: Boolean(row.is_default),
    branchRenamed: row.branch_renamed ?? 0,
    lastMessageAt: row.last_message_at,
    sessionTitles: row.session_titles ?? '[]',
    lastModelProviderId: row.last_model_provider_id,
    lastModelId: row.last_model_id,
    lastModelVariant: row.last_model_variant,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at
  }
}

export const worktreeMutationResolvers: Resolvers = {
  Mutation: {
    createWorktree: async (_parent, { input }, ctx) => {
      const result = await createWorktreeOp(ctx.db, {
        projectId: input.projectId,
        projectPath: input.projectPath,
        projectName: input.projectName
      })
      return {
        success: result.success,
        worktree: result.worktree ? mapWorktree(result.worktree) : null,
        error: result.error
      }
    },
    deleteWorktree: async (_parent, { input }, ctx) => {
      return deleteWorktreeOp(ctx.db, {
        worktreeId: input.worktreeId,
        worktreePath: input.worktreePath,
        branchName: input.branchName,
        projectPath: input.projectPath,
        archive: input.archive
      })
    },
    syncWorktrees: async (_parent, { projectId, projectPath }, ctx) => {
      return syncWorktreesOp(ctx.db, {
        projectId,
        projectPath
      })
    },
    duplicateWorktree: async (_parent, { input }, ctx) => {
      const result = await duplicateWorktreeOp(ctx.db, {
        projectId: input.projectId,
        projectPath: input.projectPath,
        projectName: input.projectName,
        sourceBranch: input.sourceBranch,
        sourceWorktreePath: input.sourceWorktreePath
      })
      return {
        success: result.success,
        worktree: result.worktree ? mapWorktree(result.worktree) : null,
        error: result.error
      }
    },
    renameWorktreeBranch: async (_parent, { input }, ctx) => {
      return renameWorktreeBranchOp(ctx.db, {
        worktreeId: input.worktreeId,
        worktreePath: input.worktreePath,
        oldBranch: input.oldBranch,
        newBranch: input.newBranch
      })
    },
    createWorktreeFromBranch: async (_parent, { input }, ctx) => {
      const result = await createWorktreeFromBranchOp(ctx.db, {
        projectId: input.projectId,
        projectPath: input.projectPath,
        projectName: input.projectName,
        branchName: input.branchName
      })
      return {
        success: result.success,
        worktree: result.worktree ? mapWorktree(result.worktree) : null,
        error: result.error
      }
    }
  }
}
