import type { Resolvers } from '../../__generated__/resolvers-types'
import {
  createConnectionOp,
  deleteConnectionOp,
  renameConnectionOp,
  addConnectionMemberOp,
  removeConnectionMemberOp,
  removeWorktreeFromAllConnectionsOp
} from '../../../main/services/connection-ops'

// ---------------------------------------------------------------------------
// snake_case DB rows -> camelCase GraphQL fields
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapConnection(row: any) {
  if (!row) return null
  return {
    id: row.id,
    name: row.custom_name || row.name,
    status: row.status,
    path: row.path,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    members: (row.members || []).map((m: any) => ({
      id: m.id,
      connectionId: m.connection_id,
      worktreeId: m.worktree_id,
      projectId: m.project_id,
      symlinkName: m.symlink_name,
      addedAt: m.added_at,
      worktreeName: m.worktree_name,
      worktreeBranch: m.worktree_branch,
      worktreePath: m.worktree_path,
      projectName: m.project_name
    }))
  }
}

// ---------------------------------------------------------------------------
// Connection Mutation Resolvers
// ---------------------------------------------------------------------------

export const connectionMutationResolvers: Resolvers = {
  Mutation: {
    createConnection: async (_parent, { worktreeIds }, ctx) => {
      const result = await createConnectionOp(ctx.db, worktreeIds)
      return {
        success: result.success,
        connection: result.connection ? mapConnection(result.connection) : null,
        error: result.error
      }
    },
    deleteConnection: async (_parent, { connectionId }, ctx) => {
      return deleteConnectionOp(ctx.db, connectionId)
    },
    renameConnection: async (_parent, { connectionId, customName }, ctx) => {
      const result = await renameConnectionOp(ctx.db, connectionId, customName ?? null)
      if (!result.success || !result.connection) return null
      return mapConnection(result.connection)
    },
    addConnectionMember: async (_parent, { connectionId, worktreeId }, ctx) => {
      return addConnectionMemberOp(ctx.db, connectionId, worktreeId)
    },
    removeConnectionMember: async (_parent, { connectionId, worktreeId }, ctx) => {
      return removeConnectionMemberOp(ctx.db, connectionId, worktreeId)
    },
    removeWorktreeFromAllConnections: async (_parent, { worktreeId }, ctx) => {
      return removeWorktreeFromAllConnectionsOp(ctx.db, worktreeId)
    }
  }
}
