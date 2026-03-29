import { graphqlQuery } from '../client'
import type { KanbanApi } from '../../types'

// GraphQL returns camelCase; the renderer expects snake_case KanbanTicket objects.
// Map the fields accordingly, including the field name differences:
//   projectId   -> project_id
//   sessionId   -> current_session_id  (note the name change)
//   worktreeId  -> worktree_id
//   sortOrder   -> sort_order
//   archived    -> archived_at  (boolean -> null | ISO date string)
//   createdAt   -> created_at
//   updatedAt   -> updated_at

interface GqlKanbanTicket {
  id: string
  projectId: string
  sessionId: string | null
  worktreeId: string | null
  title: string
  description: string | null
  column: string
  sortOrder: number
  archived: boolean
  createdAt: string
  updatedAt: string
}

function mapTicket(t: GqlKanbanTicket) {
  return {
    id: t.id,
    project_id: t.projectId,
    title: t.title,
    description: t.description,
    attachments: [],
    column: t.column as 'todo' | 'in_progress' | 'review' | 'done',
    sort_order: t.sortOrder,
    current_session_id: t.sessionId,
    worktree_id: t.worktreeId,
    mode: null as 'build' | 'plan' | null,
    plan_ready: false,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    archived_at: t.archived ? t.updatedAt : null
  }
}

function mapTicketOrNull(t: GqlKanbanTicket | null) {
  return t ? mapTicket(t) : null
}

const TICKET_FIELDS = `id projectId sessionId worktreeId title description column sortOrder archived createdAt updatedAt`

export function createKanbanAdapter(): KanbanApi {
  return {
    ticket: {
      async create(data) {
        const input: Record<string, unknown> = {
          projectId: data.project_id,
          title: data.title,
          description: data.description ?? null,
          column: data.column ?? 'todo',
          sortOrder: data.sort_order
        }
        if (data.current_session_id !== undefined) input.sessionId = data.current_session_id
        if (data.worktree_id !== undefined) input.worktreeId = data.worktree_id

        const result = await graphqlQuery<{ kanbanCreateTicket: GqlKanbanTicket }>(
          `mutation ($input: KanbanCreateTicketInput!) {
            kanbanCreateTicket(input: $input) { ${TICKET_FIELDS} }
          }`,
          { input }
        )
        return mapTicket(result.kanbanCreateTicket)
      },

      async get(id) {
        const result = await graphqlQuery<{ kanbanTicket: GqlKanbanTicket | null }>(
          `query ($id: ID!) {
            kanbanTicket(id: $id) { ${TICKET_FIELDS} }
          }`,
          { id }
        )
        return mapTicketOrNull(result.kanbanTicket)
      },

      async getByProject(projectId) {
        const result = await graphqlQuery<{ kanbanTicketsByProject: GqlKanbanTicket[] }>(
          `query ($projectId: ID!) {
            kanbanTicketsByProject(projectId: $projectId) { ${TICKET_FIELDS} }
          }`,
          { projectId }
        )
        return result.kanbanTicketsByProject.map(mapTicket)
      },

      async update(id, data) {
        const input: Record<string, unknown> = {}
        if (data.title !== undefined) input.title = data.title
        if (data.description !== undefined) input.description = data.description
        if (data.column !== undefined) input.column = data.column
        if (data.sort_order !== undefined) input.sortOrder = data.sort_order
        if (data.current_session_id !== undefined) input.sessionId = data.current_session_id
        if (data.worktree_id !== undefined) input.worktreeId = data.worktree_id

        const result = await graphqlQuery<{ kanbanUpdateTicket: GqlKanbanTicket | null }>(
          `mutation ($id: ID!, $input: KanbanUpdateTicketInput!) {
            kanbanUpdateTicket(id: $id, input: $input) { ${TICKET_FIELDS} }
          }`,
          { id, input }
        )
        return mapTicketOrNull(result.kanbanUpdateTicket)
      },

      async delete(id) {
        const result = await graphqlQuery<{ kanbanDeleteTicket: { success: boolean } }>(
          `mutation ($id: ID!) {
            kanbanDeleteTicket(id: $id) { success }
          }`,
          { id }
        )
        return result.kanbanDeleteTicket.success
      },

      async archive(id) {
        const result = await graphqlQuery<{ kanbanArchiveTicket: GqlKanbanTicket | null }>(
          `mutation ($id: ID!) {
            kanbanArchiveTicket(id: $id) { ${TICKET_FIELDS} }
          }`,
          { id }
        )
        return mapTicketOrNull(result.kanbanArchiveTicket)
      },

      async archiveAllDone(projectId) {
        const result = await graphqlQuery<{ kanbanArchiveAllDone: { success: boolean } }>(
          `mutation ($projectId: ID!) {
            kanbanArchiveAllDone(projectId: $projectId) { success }
          }`,
          { projectId }
        )
        // The Window interface expects a number (count of archived tickets).
        // The GraphQL only returns success boolean, so we return 0 on success.
        return result.kanbanArchiveAllDone.success ? 0 : 0
      },

      async unarchive(id) {
        const result = await graphqlQuery<{ kanbanUnarchiveTicket: GqlKanbanTicket | null }>(
          `mutation ($id: ID!) {
            kanbanUnarchiveTicket(id: $id) { ${TICKET_FIELDS} }
          }`,
          { id }
        )
        return mapTicketOrNull(result.kanbanUnarchiveTicket)
      },

      async move(id, column, sortOrder) {
        const result = await graphqlQuery<{ kanbanMoveTicket: GqlKanbanTicket | null }>(
          `mutation ($id: ID!, $column: KanbanTicketColumn!, $sortOrder: Float!) {
            kanbanMoveTicket(id: $id, column: $column, sortOrder: $sortOrder) { ${TICKET_FIELDS} }
          }`,
          { id, column, sortOrder }
        )
        return mapTicketOrNull(result.kanbanMoveTicket)
      },

      async reorder(id, sortOrder) {
        await graphqlQuery<{ kanbanReorderTicket: { success: boolean } }>(
          `mutation ($id: ID!, $sortOrder: Float!) {
            kanbanReorderTicket(id: $id, sortOrder: $sortOrder) { success }
          }`,
          { id, sortOrder }
        )
      },

      async getBySession(sessionId) {
        const result = await graphqlQuery<{ kanbanTicketsBySession: GqlKanbanTicket[] }>(
          `query ($sessionId: ID!) {
            kanbanTicketsBySession(sessionId: $sessionId) { ${TICKET_FIELDS} }
          }`,
          { sessionId }
        )
        return result.kanbanTicketsBySession.map(mapTicket)
      }
    },

    simpleMode: {
      async toggle(projectId, enabled) {
        await graphqlQuery<{ kanbanToggleSimpleMode: { success: boolean } }>(
          `mutation ($projectId: ID!, $enabled: Boolean!) {
            kanbanToggleSimpleMode(projectId: $projectId, enabled: $enabled) { success }
          }`,
          { projectId, enabled }
        )
      }
    }
  }
}
