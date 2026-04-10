import type { Resolvers } from '../../__generated__/resolvers-types'

// ---------------------------------------------------------------------------
// snake_case DB rows -> camelCase GraphQL fields
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapKanbanTicket(row: any) {
  if (!row) return null
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.current_session_id ?? null,
    worktreeId: row.worktree_id ?? null,
    title: row.title,
    description: row.description ?? null,
    column: row.column,
    sortOrder: row.sort_order,
    archived: !!row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    externalProvider: row.external_provider ?? null,
    externalId: row.external_id ?? null,
    externalUrl: row.external_url ?? null,
    totalTokens: row.total_tokens ?? 0,
    mark: row.mark ?? null
  }
}

// ---------------------------------------------------------------------------
// Kanban Query Resolvers
// ---------------------------------------------------------------------------

export const kanbanQueryResolvers: Resolvers = {
  Query: {
    kanbanTicket: async (_parent, { id }, ctx) => {
      return mapKanbanTicket(ctx.db.getKanbanTicket(id))
    },
    kanbanTicketsByProject: async (_parent, { projectId, includeArchived }, ctx) => {
      return ctx.db
        .getKanbanTicketsByProject(projectId, includeArchived ?? false)
        .map(mapKanbanTicket)
    },
    kanbanTicketsBySession: async (_parent, { sessionId }, ctx) => {
      return ctx.db.getKanbanTicketsBySession(sessionId).map(mapKanbanTicket)
    }
  }
}
