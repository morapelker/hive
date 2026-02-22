import type { Resolvers } from '../../__generated__/resolvers-types'

// ---------------------------------------------------------------------------
// snake_case DB rows -> camelCase GraphQL fields
// (Same mapping utilities as query resolvers — kept co-located for mutations
// that return the mutated entity.)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapProject(row: any) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    description: row.description,
    tags: row.tags,
    language: row.language,
    customIcon: row.custom_icon,
    setupScript: row.setup_script,
    runScript: row.run_script,
    archiveScript: row.archive_script,
    autoAssignPort: Boolean(row.auto_assign_port),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at
  }
}

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSession(row: any) {
  if (!row) return null
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    projectId: row.project_id,
    connectionId: row.connection_id,
    name: row.name,
    status: row.status,
    opencodeSessionId: row.opencode_session_id,
    agentSdk: row.agent_sdk === 'claude-code' ? 'claude_code' : row.agent_sdk,
    mode: row.mode,
    modelProviderId: row.model_provider_id,
    modelId: row.model_id,
    modelVariant: row.model_variant,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSpace(row: any) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    iconType: row.icon_type,
    iconValue: row.icon_value,
    sortOrder: row.sort_order,
    createdAt: row.created_at
  }
}

// ---------------------------------------------------------------------------
// DB Mutation Resolvers
// ---------------------------------------------------------------------------

export const dbMutationResolvers: Resolvers = {
  Mutation: {
    // -- Projects (Session 37) --
    createProject: async (_parent, { input }, ctx) => {
      const row = ctx.db.createProject({
        name: input.name,
        path: input.path,
        description: input.description ?? null,
        tags: input.tags ?? null
      })
      return mapProject(row)
    },
    updateProject: async (_parent, { id, input }, ctx) => {
      const data: Record<string, unknown> = {}
      if (input.name !== undefined) data.name = input.name
      if (input.description !== undefined) data.description = input.description
      if (input.tags !== undefined)
        data.tags = input.tags ? JSON.stringify(input.tags) : null
      if (input.language !== undefined) data.language = input.language
      if (input.customIcon !== undefined) data.custom_icon = input.customIcon
      if (input.setupScript !== undefined) data.setup_script = input.setupScript
      if (input.runScript !== undefined) data.run_script = input.runScript
      if (input.archiveScript !== undefined) data.archive_script = input.archiveScript
      if (input.autoAssignPort !== undefined) data.auto_assign_port = input.autoAssignPort
      if (input.lastAccessedAt !== undefined) data.last_accessed_at = input.lastAccessedAt
      return mapProject(ctx.db.updateProject(id, data))
    },
    deleteProject: async (_parent, { id }, ctx) => {
      return ctx.db.deleteProject(id)
    },
    touchProject: async (_parent, { id }, ctx) => {
      ctx.db.touchProject(id)
      return true
    },
    reorderProjects: async (_parent, { orderedIds }, ctx) => {
      ctx.db.reorderProjects(orderedIds)
      return true
    },

    // -- Worktrees (Session 38) --
    updateWorktree: async (_parent, { id, input }, ctx) => {
      const data: Record<string, unknown> = {}
      if (input.name !== undefined) data.name = input.name
      if (input.status !== undefined) data.status = input.status
      if (input.lastMessageAt !== undefined) data.last_message_at = input.lastMessageAt
      if (input.lastAccessedAt !== undefined) data.last_accessed_at = input.lastAccessedAt
      return mapWorktree(ctx.db.updateWorktree(id, data))
    },
    archiveWorktree: async (_parent, { id }, ctx) => {
      return mapWorktree(ctx.db.archiveWorktree(id))
    },
    touchWorktree: async (_parent, { id }, ctx) => {
      ctx.db.touchWorktree(id)
      return true
    },
    appendWorktreeSessionTitle: async (_parent, { worktreeId, title }, ctx) => {
      ctx.db.appendSessionTitle(worktreeId, title)
      return { success: true }
    },
    updateWorktreeModel: async (_parent, { input }, ctx) => {
      ctx.db.updateWorktreeModel(
        input.worktreeId,
        input.modelProviderId,
        input.modelId,
        input.modelVariant ?? null
      )
      return { success: true }
    },

    // -- Sessions (Session 39) --
    createSession: async (_parent, { input }, ctx) => {
      const row = ctx.db.createSession({
        worktree_id: input.worktreeId ?? null,
        project_id: input.projectId,
        connection_id: input.connectionId ?? null,
        name: input.name ?? null,
        opencode_session_id: input.opencodeSessionId ?? null,
        agent_sdk:
          input.agentSdk === 'claude_code'
            ? 'claude-code'
            : (input.agentSdk ?? 'opencode'),
        model_provider_id: input.modelProviderId ?? null,
        model_id: input.modelId ?? null,
        model_variant: input.modelVariant ?? null
      })
      return mapSession(row)
    },
    updateSession: async (_parent, { id, input }, ctx) => {
      const data: Record<string, unknown> = {}
      if (input.name !== undefined) data.name = input.name
      if (input.status !== undefined) data.status = input.status
      if (input.opencodeSessionId !== undefined)
        data.opencode_session_id = input.opencodeSessionId
      if (input.agentSdk !== undefined)
        data.agent_sdk =
          input.agentSdk === 'claude_code' ? 'claude-code' : input.agentSdk
      if (input.mode !== undefined) data.mode = input.mode
      if (input.modelProviderId !== undefined)
        data.model_provider_id = input.modelProviderId
      if (input.modelId !== undefined) data.model_id = input.modelId
      if (input.modelVariant !== undefined) data.model_variant = input.modelVariant
      if (input.updatedAt !== undefined) data.updated_at = input.updatedAt
      if (input.completedAt !== undefined) data.completed_at = input.completedAt
      return mapSession(ctx.db.updateSession(id, data))
    },
    deleteSession: async (_parent, { id }, ctx) => {
      return ctx.db.deleteSession(id)
    },
    updateSessionDraft: async (_parent, { sessionId, draft }, ctx) => {
      ctx.db.updateSessionDraft(sessionId, draft ?? null)
      return true
    },

    // -- Spaces (Session 40) --
    createSpace: async (_parent, { input }, ctx) => {
      return mapSpace(
        ctx.db.createSpace({
          name: input.name,
          icon_type: input.iconType ?? undefined,
          icon_value: input.iconValue ?? undefined
        })
      )
    },
    updateSpace: async (_parent, { id, input }, ctx) => {
      const data: Record<string, unknown> = {}
      if (input.name !== undefined) data.name = input.name
      if (input.iconType !== undefined) data.icon_type = input.iconType
      if (input.iconValue !== undefined) data.icon_value = input.iconValue
      if (input.sortOrder !== undefined) data.sort_order = input.sortOrder
      return mapSpace(ctx.db.updateSpace(id, data))
    },
    deleteSpace: async (_parent, { id }, ctx) => {
      return ctx.db.deleteSpace(id)
    },
    assignProjectToSpace: async (_parent, { projectId, spaceId }, ctx) => {
      ctx.db.assignProjectToSpace(projectId, spaceId)
      return true
    },
    removeProjectFromSpace: async (_parent, { projectId, spaceId }, ctx) => {
      ctx.db.removeProjectFromSpace(projectId, spaceId)
      return true
    },
    reorderSpaces: async (_parent, { orderedIds }, ctx) => {
      ctx.db.reorderSpaces(orderedIds)
      return true
    },

    // -- Settings (Session 41) --
    setSetting: async (_parent, { key, value }, ctx) => {
      ctx.db.setSetting(key, value)
      return true
    },
    deleteSetting: async (_parent, { key }, ctx) => {
      ctx.db.deleteSetting(key)
      return true
    }
  }
}
