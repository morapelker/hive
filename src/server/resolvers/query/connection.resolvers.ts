import type { Resolvers } from '../../__generated__/resolvers-types'

// ---------------------------------------------------------------------------
// snake_case DB rows -> camelCase GraphQL fields
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
// Connection Query Resolvers
// ---------------------------------------------------------------------------

export const connectionQueryResolvers: Resolvers = {
  Query: {
    connections: async (_parent, _args, ctx) => {
      return ctx.db.getAllConnections().map(mapConnection)
    },
    connection: async (_parent, { connectionId }, ctx) => {
      return mapConnection(ctx.db.getConnection(connectionId))
    }
  }
}
