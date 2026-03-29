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
    updatedAt: row.updated_at
  }
}

// ---------------------------------------------------------------------------
// Kanban Mutation Resolvers
// ---------------------------------------------------------------------------

export const kanbanMutationResolvers: Resolvers = {
  Mutation: {
    kanbanCreateTicket: async (_parent, { input }, ctx) => {
      const row = ctx.db.createKanbanTicket({
        project_id: input.projectId,
        current_session_id: input.sessionId ?? null,
        worktree_id: input.worktreeId ?? null,
        title: input.title,
        description: input.description ?? null,
        column: input.column as 'todo' | 'in_progress' | 'review' | 'done',
        sort_order: input.sortOrder ?? 0,
        external_provider: input.externalProvider ?? null,
        external_id: input.externalId ?? null,
        external_url: input.externalUrl ?? null
      })
      return mapKanbanTicket(row)
    },

    kanbanUpdateTicket: async (_parent, { id, input }, ctx) => {
      const data: Record<string, unknown> = {}
      if (input.title !== undefined) data.title = input.title
      if (input.description !== undefined) data.description = input.description
      if (input.column !== undefined) data.column = input.column
      if (input.sortOrder !== undefined) data.sort_order = input.sortOrder
      if (input.sessionId !== undefined) data.current_session_id = input.sessionId
      if (input.worktreeId !== undefined) data.worktree_id = input.worktreeId
      return mapKanbanTicket(ctx.db.updateKanbanTicket(id, data))
    },

    kanbanDeleteTicket: async (_parent, { id }, ctx) => {
      const deleted = ctx.db.deleteKanbanTicket(id)
      return { success: deleted }
    },

    kanbanArchiveTicket: async (_parent, { id }, ctx) => {
      return mapKanbanTicket(ctx.db.archiveKanbanTicket(id))
    },

    kanbanArchiveAllDone: async (_parent, { projectId }, ctx) => {
      ctx.db.archiveAllDoneKanbanTickets(projectId)
      return { success: true }
    },

    kanbanUnarchiveTicket: async (_parent, { id }, ctx) => {
      return mapKanbanTicket(ctx.db.unarchiveKanbanTicket(id))
    },

    kanbanMoveTicket: async (_parent, { id, column, sortOrder }, ctx) => {
      return mapKanbanTicket(
        ctx.db.moveKanbanTicket(
          id,
          column as 'todo' | 'in_progress' | 'review' | 'done',
          sortOrder
        )
      )
    },

    kanbanReorderTicket: async (_parent, { id, sortOrder }, ctx) => {
      ctx.db.reorderKanbanTicket(id, sortOrder)
      return { success: true }
    },

    kanbanToggleSimpleMode: async (_parent, { projectId, enabled }, ctx) => {
      ctx.db.updateProjectSimpleMode(projectId, enabled)
      return { success: true }
    }
  }
}
