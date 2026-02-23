import type { Resolvers } from '../../__generated__/resolvers-types'

// ---------------------------------------------------------------------------
// snake_case DB rows -> camelCase GraphQL fields
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
function mapSessionWithWorktree(row: any) {
  if (!row) return null
  return {
    ...mapSession(row),
    worktreeName: row.worktree_name,
    worktreeBranchName: row.worktree_branch_name,
    projectName: row.project_name
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
// DB Query Resolvers
// ---------------------------------------------------------------------------

export const dbQueryResolvers: Resolvers = {
  Query: {
    // -- Projects (Session 32) --
    projects: async (_parent, _args, ctx) => {
      return ctx.db.getAllProjects().map(mapProject)
    },
    project: async (_parent, { id }, ctx) => {
      return mapProject(ctx.db.getProject(id))
    },
    projectByPath: async (_parent, { path }, ctx) => {
      return mapProject(ctx.db.getProjectByPath(path))
    },

    // -- Worktrees (Session 33) --
    worktree: async (_parent, { id }, ctx) => {
      return mapWorktree(ctx.db.getWorktree(id))
    },
    worktreesByProject: async (_parent, { projectId }, ctx) => {
      return ctx.db.getWorktreesByProject(projectId).map(mapWorktree)
    },
    activeWorktreesByProject: async (_parent, { projectId }, ctx) => {
      return ctx.db.getActiveWorktreesByProject(projectId).map(mapWorktree)
    },

    // -- Sessions (Session 34) --
    session: async (_parent, { id }, ctx) => {
      return mapSession(ctx.db.getSession(id))
    },
    sessionsByWorktree: async (_parent, { worktreeId }, ctx) => {
      return ctx.db.getSessionsByWorktree(worktreeId).map(mapSession)
    },
    activeSessionsByWorktree: async (_parent, { worktreeId }, ctx) => {
      return ctx.db.getActiveSessionsByWorktree(worktreeId).map(mapSession)
    },
    sessionsByProject: async (_parent, { projectId }, ctx) => {
      return ctx.db.getSessionsByProject(projectId).map(mapSession)
    },
    searchSessions: async (_parent, { input }, ctx) => {
      const opts = {
        keyword: input.keyword ?? undefined,
        project_id: input.projectId ?? undefined,
        worktree_id: input.worktreeId ?? undefined,
        dateFrom: input.dateFrom ?? undefined,
        dateTo: input.dateTo ?? undefined,
        includeArchived: input.includeArchived ?? undefined
      }
      return ctx.db.searchSessions(opts).map(mapSessionWithWorktree)
    },
    sessionDraft: async (_parent, { sessionId }, ctx) => {
      return ctx.db.getSessionDraft(sessionId)
    },

    // -- Sessions by Connection (Session 35) --
    sessionsByConnection: async (_parent, { connectionId }, ctx) => {
      return ctx.db.getSessionsByConnection(connectionId).map(mapSession)
    },
    activeSessionsByConnection: async (_parent, { connectionId }, ctx) => {
      return ctx.db.getActiveSessionsByConnection(connectionId).map(mapSession)
    },

    // -- Spaces (Session 36) --
    spaces: async (_parent, _args, ctx) => {
      return ctx.db.listSpaces().map(mapSpace)
    },
    spaceProjectIds: async (_parent, { spaceId }, ctx) => {
      return ctx.db.getProjectIdsForSpace(spaceId)
    },
    allSpaceAssignments: async (_parent, _args, ctx) => {
      return ctx.db.getAllProjectSpaceAssignments().map((a) => ({
        projectId: a.project_id,
        spaceId: a.space_id
      }))
    },

    // -- Settings (Session 36) --
    setting: async (_parent, { key }, ctx) => {
      return ctx.db.getSetting(key)
    },
    allSettings: async (_parent, _args, ctx) => {
      return ctx.db.getAllSettings()
    },

    // -- Schema Version (Session 36) --
    dbSchemaVersion: async (_parent, _args, ctx) => {
      return ctx.db.getSchemaVersion()
    }
  }
}
