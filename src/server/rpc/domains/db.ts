import { Effect } from 'effect'
import { z } from 'zod'
import type {
  DiffComment,
  DiffCommentCreate,
  DiffCommentUpdate,
  Project,
  ProjectCreate,
  ProjectSpaceAssignment,
  ProjectUpdate,
  Session,
  SessionActivity,
  SessionCreate,
  SessionMessage,
  SessionSearchOptions,
  SessionWithWorktree,
  SessionUpdate,
  Space,
  SpaceCreate,
  SpaceUpdate,
  Worktree,
  WorktreeCreate,
  WorktreeUpdate
} from '../../../main/db'
import type { RpcHandler } from '../router'

export interface DbRpcService {
  readonly getSetting: (key: string) => Effect.Effect<string | null, unknown, never>
  readonly setSetting: (key: string, value: string) => Effect.Effect<boolean, unknown, never>
  readonly deleteSetting: (key: string) => Effect.Effect<boolean, unknown, never>
  readonly getAllSettings: () => Effect.Effect<SettingRow[], unknown, never>
  readonly createProject: (data: ProjectCreate) => Effect.Effect<Project, unknown, never>
  readonly updateProject: (
    id: string,
    data: ProjectUpdate
  ) => Effect.Effect<Project | null, unknown, never>
  readonly deleteProject: (id: string) => Effect.Effect<boolean, unknown, never>
  readonly getProject: (id: string) => Effect.Effect<Project | null, unknown, never>
  readonly getProjectByPath: (path: string) => Effect.Effect<Project | null, unknown, never>
  readonly getAllProjects: () => Effect.Effect<Project[], unknown, never>
  readonly reorderProjects: (orderedIds: string[]) => Effect.Effect<boolean, unknown, never>
  readonly touchProject: (id: string) => Effect.Effect<boolean, unknown, never>
  readonly sortProjectIdsByLastMessage: () => Effect.Effect<string[], unknown, never>
  readonly createWorktree: (data: WorktreeCreate) => Effect.Effect<Worktree, unknown, never>
  readonly getWorktree: (id: string) => Effect.Effect<Worktree | null, unknown, never>
  readonly getWorktreesByProject: (projectId: string) => Effect.Effect<Worktree[], unknown, never>
  readonly getActiveWorktreesByProject: (
    projectId: string
  ) => Effect.Effect<Worktree[], unknown, never>
  readonly getRecentlyActiveWorktrees: (
    cutoffMs: number
  ) => Effect.Effect<Worktree[], unknown, never>
  readonly updateWorktree: (
    id: string,
    data: WorktreeUpdate
  ) => Effect.Effect<Worktree | null, unknown, never>
  readonly deleteWorktree: (id: string) => Effect.Effect<boolean, unknown, never>
  readonly archiveWorktree: (id: string) => Effect.Effect<Worktree | null, unknown, never>
  readonly touchWorktree: (id: string) => Effect.Effect<boolean, unknown, never>
  readonly appendWorktreeSessionTitle: (
    worktreeId: string,
    title: string
  ) => Effect.Effect<{ success: boolean }, unknown, never>
  readonly updateWorktreeModel: (params: {
    readonly worktreeId: string
    readonly modelProviderId: string
    readonly modelId: string
    readonly modelVariant: string | null
  }) => Effect.Effect<{ success: boolean }, unknown, never>
  readonly addWorktreeAttachment: (
    worktreeId: string,
    attachment: WorktreeAttachmentInput
  ) => Effect.Effect<WorktreeMutationResult, unknown, never>
  readonly removeWorktreeAttachment: (
    worktreeId: string,
    attachmentId: string
  ) => Effect.Effect<WorktreeMutationResult, unknown, never>
  readonly attachWorktreePr: (
    worktreeId: string,
    prNumber: number,
    prUrl: string
  ) => Effect.Effect<WorktreeMutationResult, unknown, never>
  readonly detachWorktreePr: (
    worktreeId: string
  ) => Effect.Effect<WorktreeMutationResult, unknown, never>
  readonly setWorktreePinned: (
    worktreeId: string,
    pinned: boolean
  ) => Effect.Effect<{ success: boolean }, unknown, never>
  readonly getPinnedWorktrees: () => Effect.Effect<Worktree[], unknown, never>
  readonly createSession: (data: SessionCreate) => Effect.Effect<Session, unknown, never>
  readonly getSession: (id: string) => Effect.Effect<Session | null, unknown, never>
  readonly getSessionsByWorktree: (worktreeId: string) => Effect.Effect<Session[], unknown, never>
  readonly getSessionsByProject: (projectId: string) => Effect.Effect<Session[], unknown, never>
  readonly getActiveSessionsByWorktree: (
    worktreeId: string
  ) => Effect.Effect<Session[], unknown, never>
  readonly updateSession: (
    id: string,
    data: SessionUpdate
  ) => Effect.Effect<Session | null, unknown, never>
  readonly deleteSession: (id: string) => Effect.Effect<boolean, unknown, never>
  readonly searchSessions: (
    options: SessionSearchOptions
  ) => Effect.Effect<SessionWithWorktree[], unknown, never>
  readonly getSessionDraft: (sessionId: string) => Effect.Effect<string | null, unknown, never>
  readonly updateSessionDraft: (
    sessionId: string,
    draft: string | null
  ) => Effect.Effect<void, unknown, never>
  readonly getSessionsByConnection: (
    connectionId: string
  ) => Effect.Effect<Session[], unknown, never>
  readonly getActiveSessionsByConnection: (
    connectionId: string
  ) => Effect.Effect<Session[], unknown, never>
  readonly setSessionPinnedToBoard: (
    sessionId: string,
    pinned: boolean
  ) => Effect.Effect<Session | null, unknown, never>
  readonly getPinnedSessions: (worktreeId: string) => Effect.Effect<Session[], unknown, never>
  readonly getActiveBoardAssistant: (
    projectId: string
  ) => Effect.Effect<Session | null, unknown, never>
  readonly listSessionMessages: (
    sessionId: string
  ) => Effect.Effect<SessionMessage[], unknown, never>
  readonly listSessionActivities: (
    sessionId: string
  ) => Effect.Effect<SessionActivity[], unknown, never>
  readonly listSpaces: () => Effect.Effect<Space[], unknown, never>
  readonly createSpace: (data: SpaceCreate) => Effect.Effect<Space, unknown, never>
  readonly updateSpace: (
    id: string,
    data: SpaceUpdate
  ) => Effect.Effect<Space | null, unknown, never>
  readonly deleteSpace: (id: string) => Effect.Effect<boolean, unknown, never>
  readonly assignProjectToSpace: (
    projectId: string,
    spaceId: string
  ) => Effect.Effect<boolean, unknown, never>
  readonly removeProjectFromSpace: (
    projectId: string,
    spaceId: string
  ) => Effect.Effect<boolean, unknown, never>
  readonly getProjectIdsForSpace: (spaceId: string) => Effect.Effect<string[], unknown, never>
  readonly getAllProjectSpaceAssignments: () => Effect.Effect<
    ProjectSpaceAssignment[],
    unknown,
    never
  >
  readonly reorderSpaces: (orderedIds: string[]) => Effect.Effect<boolean, unknown, never>
  readonly createDiffComment: (
    data: DiffCommentCreate
  ) => Effect.Effect<DiffComment, unknown, never>
  readonly listDiffComments: (worktreeId: string) => Effect.Effect<DiffComment[], unknown, never>
  readonly updateDiffComment: (
    id: string,
    data: DiffCommentUpdate
  ) => Effect.Effect<DiffComment | null, unknown, never>
  readonly setDiffCommentOutdated: (
    id: string,
    isOutdated: boolean
  ) => Effect.Effect<DiffComment | null, unknown, never>
  readonly deleteDiffComment: (id: string) => Effect.Effect<boolean, unknown, never>
  readonly clearAllDiffComments: (worktreeId: string) => Effect.Effect<number, unknown, never>
  readonly getSchemaVersion: () => Effect.Effect<number, unknown, never>
  readonly tableExists: (tableName: string) => Effect.Effect<boolean, unknown, never>
  readonly getIndexes: () => Effect.Effect<DbIndexRow[], unknown, never>
}

export interface SettingRow {
  readonly key: string
  readonly value: string
}

export interface DbIndexRow {
  readonly name: string
  readonly tbl_name: string
}

export interface WorktreeAttachmentInput {
  readonly type: 'jira' | 'figma'
  readonly url: string
  readonly label: string
}

export interface WorktreeMutationResult {
  readonly success: boolean
  readonly error?: string
}

const settingGetParamsSchema = z.object({ key: z.string().min(1) }).strict()
const settingSetParamsSchema = z.object({ key: z.string().min(1), value: z.string() }).strict()
const settingDeleteParamsSchema = z.object({ key: z.string().min(1) }).strict()
const projectCreateParamsSchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  setup_script: z.string().nullable().optional(),
  run_script: z.string().nullable().optional(),
  archive_script: z.string().nullable().optional(),
  worktree_create_script: z.string().nullable().optional()
}) satisfies z.ZodType<ProjectCreate>
const customProjectCommandSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string()
})
const projectUpdateDataSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  language: z.string().nullable().optional(),
  custom_icon: z.string().nullable().optional(),
  detected_icon: z.string().nullable().optional(),
  setup_script: z.string().nullable().optional(),
  run_script: z.string().nullable().optional(),
  archive_script: z.string().nullable().optional(),
  worktree_create_script: z.string().nullable().optional(),
  custom_commands: z.array(customProjectCommandSchema).nullable().optional(),
  auto_assign_port: z.boolean().optional(),
  last_accessed_at: z.string().optional()
}) satisfies z.ZodType<ProjectUpdate>
const projectUpdateParamsSchema = z.object({
  id: z.string().min(1),
  data: projectUpdateDataSchema
})
const projectGetParamsSchema = z.object({ id: z.string().min(1) }).strict()
const projectGetByPathParamsSchema = z.object({ path: z.string().min(1) }).strict()
const projectReorderParamsSchema = z.object({ orderedIds: z.array(z.string()) }).strict()
const worktreeCreateParamsSchema = z.object({
  project_id: z.string(),
  name: z.string(),
  branch_name: z.string(),
  path: z.string(),
  is_default: z.boolean().optional(),
  base_branch: z.string().nullable().optional()
}) satisfies z.ZodType<WorktreeCreate>
const worktreeByProjectParamsSchema = z.object({ projectId: z.string().min(1) }).strict()
const worktreeRecentlyActiveParamsSchema = z.object({ cutoffMs: z.number() }).strict()
const worktreeUpdateDataSchema = z.object({
  name: z.string().optional(),
  branch_name: z.string().optional(),
  status: z.enum(['active', 'archived']).optional(),
  branch_renamed: z.number().optional(),
  last_message_at: z.number().nullable().optional(),
  last_model_provider_id: z.string().nullable().optional(),
  last_model_id: z.string().nullable().optional(),
  last_model_variant: z.string().nullable().optional(),
  pinned: z.number().optional(),
  github_pr_number: z.number().nullable().optional(),
  github_pr_url: z.string().nullable().optional(),
  teleported_to: z.string().nullable().optional(),
  last_accessed_at: z.string().optional()
}) satisfies z.ZodType<WorktreeUpdate>
const worktreeUpdateParamsSchema = z.object({
  id: z.string().min(1),
  data: worktreeUpdateDataSchema
})
const worktreeAppendSessionTitleParamsSchema = z
  .object({ worktreeId: z.string(), title: z.string() })
  .strict()
const worktreeModelParamsSchema = z
  .object({
    worktreeId: z.string(),
    modelProviderId: z.string(),
    modelId: z.string(),
    modelVariant: z.string().nullable()
  })
  .strict()
const worktreeAttachmentParamsSchema = z
  .object({
    worktreeId: z.string(),
    attachment: z.object({
      type: z.enum(['jira', 'figma']),
      url: z.string(),
      label: z.string()
    })
  })
  .strict()
const worktreeAttachmentIdParamsSchema = z
  .object({ worktreeId: z.string(), attachmentId: z.string() })
  .strict()
const worktreePrParamsSchema = z
  .object({ worktreeId: z.string(), prNumber: z.number(), prUrl: z.string() })
  .strict()
const worktreeIdParamsSchema = z.object({ worktreeId: z.string() }).strict()
const worktreePinnedParamsSchema = z
  .object({ worktreeId: z.string(), pinned: z.boolean() })
  .strict()
const agentSdkSchema = z.enum(['opencode', 'claude-code', 'claude-code-cli', 'codex', 'terminal'])
const sessionModeSchema = z.enum(['build', 'plan', 'super-plan'])
const sessionTypeSchema = z.enum(['default', 'board-assistant'])
const sessionCreateParamsSchema = z.object({
  worktree_id: z.string().nullable(),
  project_id: z.string(),
  connection_id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  opencode_session_id: z.string().nullable().optional(),
  claude_session_id: z.string().nullable().optional(),
  agent_sdk: agentSdkSchema.optional(),
  mode: sessionModeSchema.optional(),
  session_type: sessionTypeSchema.optional(),
  model_provider_id: z.string().nullable().optional(),
  model_id: z.string().nullable().optional(),
  model_variant: z.string().nullable().optional(),
  pinned_to_board: z.boolean().optional()
}) satisfies z.ZodType<SessionCreate>
const sessionUpdateDataSchema = z.object({
  name: z.string().nullable().optional(),
  status: z.enum(['active', 'completed', 'error']).optional(),
  opencode_session_id: z.string().nullable().optional(),
  claude_session_id: z.string().nullable().optional(),
  agent_sdk: agentSdkSchema.optional(),
  mode: sessionModeSchema.optional(),
  session_type: sessionTypeSchema.optional(),
  model_provider_id: z.string().nullable().optional(),
  model_id: z.string().nullable().optional(),
  model_variant: z.string().nullable().optional(),
  updated_at: z.string().optional(),
  completed_at: z.string().nullable().optional(),
  pinned_to_board: z.boolean().optional()
}) satisfies z.ZodType<SessionUpdate>
const sessionUpdateParamsSchema = z.object({
  id: z.string().min(1),
  data: sessionUpdateDataSchema
})
const sessionSearchOptionsSchema = z.object({
  keyword: z.string().optional(),
  project_id: z.string().optional(),
  worktree_id: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  includeArchived: z.boolean().optional()
}) satisfies z.ZodType<SessionSearchOptions>
const sessionByWorktreeParamsSchema = z.object({ worktreeId: z.string().min(1) }).strict()
const sessionByProjectParamsSchema = z.object({ projectId: z.string().min(1) }).strict()
const sessionDraftParamsSchema = z.object({ sessionId: z.string().min(1) }).strict()
const sessionByConnectionParamsSchema = z.object({ connectionId: z.string().min(1) }).strict()
const sessionPinnedToBoardParamsSchema = z
  .object({ sessionId: z.string().min(1), pinned: z.boolean() })
  .strict()
const sessionUpdateDraftParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    draft: z.string().nullable()
  })
  .strict()
const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const spaceCreateParamsSchema = z.object({
  name: z.string(),
  icon_type: z.string().optional(),
  icon_value: z.string().optional()
}) satisfies z.ZodType<SpaceCreate>
const spaceUpdateDataSchema = z.object({
  name: z.string().optional(),
  icon_type: z.string().optional(),
  icon_value: z.string().optional(),
  sort_order: z.number().optional()
}) satisfies z.ZodType<SpaceUpdate>
const spaceUpdateParamsSchema = z
  .object({
    id: z.string().min(1),
    data: spaceUpdateDataSchema
  })
  .strict()
const spaceProjectParamsSchema = z
  .object({
    projectId: z.string().min(1),
    spaceId: z.string().min(1)
  })
  .strict()
const diffCommentCreateParamsSchema = z.object({
  worktree_id: z.string(),
  file_path: z.string(),
  line_start: z.number(),
  line_end: z.number().nullable().optional(),
  anchor_text: z.string().nullable().optional(),
  anchor_context_before: z.string().nullable().optional(),
  anchor_context_after: z.string().nullable().optional(),
  body: z.string()
}) satisfies z.ZodType<DiffCommentCreate>
const diffCommentUpdateDataSchema = z.object({
  body: z.string().optional(),
  line_start: z.number().optional(),
  line_end: z.number().nullable().optional(),
  anchor_text: z.string().nullable().optional(),
  anchor_context_before: z.string().nullable().optional(),
  anchor_context_after: z.string().nullable().optional(),
  is_outdated: z.boolean().optional()
}) satisfies z.ZodType<DiffCommentUpdate>
const diffCommentUpdateParamsSchema = z
  .object({
    id: z.string().min(1),
    data: diffCommentUpdateDataSchema
  })
  .strict()
const diffCommentSetOutdatedParamsSchema = z
  .object({
    id: z.string().min(1),
    isOutdated: z.boolean()
  })
  .strict()
const tableExistsParamsSchema = z.object({ tableName: z.string().min(1) }).strict()

export const makeLiveDbRpcService = (): DbRpcService => ({
  getSetting: (key) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getSetting(key)
      },
      catch: (cause) => cause
    }),
  setSetting: (key, value) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        getDatabase().setSetting(key, value)
        return true
      },
      catch: (cause) => cause
    }),
  deleteSetting: (key) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        getDatabase().deleteSetting(key)
        return true
      },
      catch: (cause) => cause
    }),
  getAllSettings: () =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getAllSettings()
      },
      catch: (cause) => cause
    }),
  createProject: (data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        const { createProjectWithDefaultWorktree } =
          await import('../../../main/services/project-ops')
        const { telemetryService } = await import('../../../main/services/telemetry-service')
        const db = getDatabase()
        const project = createProjectWithDefaultWorktree(db, data)
        telemetryService.track('project_added', {})

        return project
      },
      catch: (cause) => cause
    }),
  updateProject: (id, data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().updateProject(id, data)
      },
      catch: (cause) => cause
    }),
  deleteProject: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().deleteProject(id)
      },
      catch: (cause) => cause
    }),
  getProject: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getProject(id)
      },
      catch: (cause) => cause
    }),
  getProjectByPath: (path) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getProjectByPath(path)
      },
      catch: (cause) => cause
    }),
  getAllProjects: () =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getAllProjects()
      },
      catch: (cause) => cause
    }),
  reorderProjects: (orderedIds) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        getDatabase().reorderProjects(orderedIds)
        return true
      },
      catch: (cause) => cause
    }),
  touchProject: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        getDatabase().touchProject(id)
        return true
      },
      catch: (cause) => cause
    }),
  sortProjectIdsByLastMessage: () =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getProjectIdsSortedByLastMessage()
      },
      catch: (cause) => cause
    }),
  createWorktree: (data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().createWorktree(data)
      },
      catch: (cause) => cause
    }),
  getWorktree: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getWorktree(id)
      },
      catch: (cause) => cause
    }),
  getWorktreesByProject: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getWorktreesByProject(projectId)
      },
      catch: (cause) => cause
    }),
  getActiveWorktreesByProject: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getActiveWorktreesByProject(projectId)
      },
      catch: (cause) => cause
    }),
  getRecentlyActiveWorktrees: (cutoffMs) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getRecentlyActiveWorktrees(cutoffMs)
      },
      catch: (cause) => cause
    }),
  updateWorktree: (id, data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().updateWorktree(id, data)
      },
      catch: (cause) => cause
    }),
  deleteWorktree: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().deleteWorktree(id)
      },
      catch: (cause) => cause
    }),
  archiveWorktree: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().archiveWorktree(id)
      },
      catch: (cause) => cause
    }),
  touchWorktree: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        getDatabase().touchWorktree(id)
        return true
      },
      catch: (cause) => cause
    }),
  appendWorktreeSessionTitle: (worktreeId, title) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        getDatabase().appendSessionTitle(worktreeId, title)
        return { success: true }
      },
      catch: (cause) => cause
    }),
  updateWorktreeModel: (params) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        getDatabase().updateWorktreeModel(
          params.worktreeId,
          params.modelProviderId,
          params.modelId,
          params.modelVariant ?? null
        )
        return { success: true }
      },
      catch: (cause) => cause
    }),
  addWorktreeAttachment: (worktreeId, attachment) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().addAttachment(worktreeId, attachment)
      },
      catch: (cause) => cause
    }),
  removeWorktreeAttachment: (worktreeId, attachmentId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().removeAttachment(worktreeId, attachmentId)
      },
      catch: (cause) => cause
    }),
  attachWorktreePr: (worktreeId, prNumber, prUrl) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().attachPR(worktreeId, prNumber, prUrl)
      },
      catch: (cause) => cause
    }),
  detachWorktreePr: (worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().detachPR(worktreeId)
      },
      catch: (cause) => cause
    }),
  setWorktreePinned: (worktreeId, pinned) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        getDatabase().updateWorktree(worktreeId, { pinned: pinned ? 1 : 0 })
        return { success: true }
      },
      catch: (cause) => cause
    }),
  getPinnedWorktrees: () =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getPinnedWorktrees()
      },
      catch: (cause) => cause
    }),
  createSession: (data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().createSession(data)
      },
      catch: (cause) => cause
    }),
  getSession: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getSession(id)
      },
      catch: (cause) => cause
    }),
  getSessionsByWorktree: (worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getSessionsByWorktree(worktreeId)
      },
      catch: (cause) => cause
    }),
  getSessionsByProject: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getSessionsByProject(projectId)
      },
      catch: (cause) => cause
    }),
  getActiveSessionsByWorktree: (worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getActiveSessionsByWorktree(worktreeId)
      },
      catch: (cause) => cause
    }),
  updateSession: (id, data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().updateSession(id, data)
      },
      catch: (cause) => cause
    }),
  deleteSession: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().deleteSession(id)
      },
      catch: (cause) => cause
    }),
  searchSessions: (options) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().searchSessions(options)
      },
      catch: (cause) => cause
    }),
  getSessionDraft: (sessionId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getSessionDraft(sessionId)
      },
      catch: (cause) => cause
    }),
  updateSessionDraft: (sessionId, draft) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        getDatabase().updateSessionDraft(sessionId, draft)
      },
      catch: (cause) => cause
    }),
  getSessionsByConnection: (connectionId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getSessionsByConnection(connectionId)
      },
      catch: (cause) => cause
    }),
  getActiveSessionsByConnection: (connectionId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getActiveSessionsByConnection(connectionId)
      },
      catch: (cause) => cause
    }),
  setSessionPinnedToBoard: (sessionId, pinned) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().updateSession(sessionId, { pinned_to_board: pinned })
      },
      catch: (cause) => cause
    }),
  getPinnedSessions: (worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getPinnedSessions(worktreeId)
      },
      catch: (cause) => cause
    }),
  getActiveBoardAssistant: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getActiveBoardAssistantByProject(projectId)
      },
      catch: (cause) => cause
    }),
  listSessionMessages: (sessionId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getSessionMessages(sessionId)
      },
      catch: (cause) => cause
    }),
  listSessionActivities: (sessionId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getSessionActivities(sessionId)
      },
      catch: (cause) => cause
    }),
  listSpaces: () =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().listSpaces()
      },
      catch: (cause) => cause
    }),
  createSpace: (data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().createSpace(data)
      },
      catch: (cause) => cause
    }),
  updateSpace: (id, data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().updateSpace(id, data)
      },
      catch: (cause) => cause
    }),
  deleteSpace: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().deleteSpace(id)
      },
      catch: (cause) => cause
    }),
  assignProjectToSpace: (projectId, spaceId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        getDatabase().assignProjectToSpace(projectId, spaceId)
        return true
      },
      catch: (cause) => cause
    }),
  removeProjectFromSpace: (projectId, spaceId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        getDatabase().removeProjectFromSpace(projectId, spaceId)
        return true
      },
      catch: (cause) => cause
    }),
  getProjectIdsForSpace: (spaceId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getProjectIdsForSpace(spaceId)
      },
      catch: (cause) => cause
    }),
  getAllProjectSpaceAssignments: () =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getAllProjectSpaceAssignments()
      },
      catch: (cause) => cause
    }),
  reorderSpaces: (orderedIds) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        getDatabase().reorderSpaces(orderedIds)
        return true
      },
      catch: (cause) => cause
    }),
  createDiffComment: (data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().createDiffComment(data)
      },
      catch: (cause) => cause
    }),
  listDiffComments: (worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getDiffCommentsByWorktree(worktreeId)
      },
      catch: (cause) => cause
    }),
  updateDiffComment: (id, data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().updateDiffComment(id, data)
      },
      catch: (cause) => cause
    }),
  setDiffCommentOutdated: (id, isOutdated) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().setDiffCommentOutdated(id, isOutdated)
      },
      catch: (cause) => cause
    }),
  deleteDiffComment: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().deleteDiffComment(id)
      },
      catch: (cause) => cause
    }),
  clearAllDiffComments: (worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().clearAllDiffComments(worktreeId)
      },
      catch: (cause) => cause
    }),
  getSchemaVersion: () =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getSchemaVersion()
      },
      catch: (cause) => cause
    }),
  tableExists: (tableName) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().tableExists(tableName)
      },
      catch: (cause) => cause
    }),
  getIndexes: () =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getIndexes()
      },
      catch: (cause) => cause
    })
})

export const makeDbRpcHandlers = (
  service: DbRpcService = makeLiveDbRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'db.setting.get',
      (params) =>
        Effect.gen(function* () {
          const { key } = yield* Effect.try({
            try: () => settingGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getSetting(key)
        })
    ],
    [
      'db.setting.set',
      (params) =>
        Effect.gen(function* () {
          const { key, value } = yield* Effect.try({
            try: () => settingSetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setSetting(key, value)
        })
    ],
    [
      'db.setting.delete',
      (params) =>
        Effect.gen(function* () {
          const { key } = yield* Effect.try({
            try: () => settingDeleteParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.deleteSetting(key)
        })
    ],
    [
      'db.setting.getAll',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getAllSettings()
        })
    ],
    [
      'db.project.create',
      (params) =>
        Effect.gen(function* () {
          const data = yield* Effect.try({
            try: () => projectCreateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createProject(data)
        })
    ],
    [
      'db.project.update',
      (params) =>
        Effect.gen(function* () {
          const { id, data } = yield* Effect.try({
            try: () => projectUpdateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.updateProject(id, data)
        })
    ],
    [
      'db.project.delete',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => projectGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.deleteProject(id)
        })
    ],
    [
      'db.project.get',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => projectGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getProject(id)
        })
    ],
    [
      'db.project.getByPath',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => projectGetByPathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getProjectByPath(path)
        })
    ],
    [
      'db.project.getAll',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getAllProjects()
        })
    ],
    [
      'db.project.reorder',
      (params) =>
        Effect.gen(function* () {
          const { orderedIds } = yield* Effect.try({
            try: () => projectReorderParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.reorderProjects(orderedIds)
        })
    ],
    [
      'db.project.touch',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => projectGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.touchProject(id)
        })
    ],
    [
      'db.project.sortByLastMessage',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.sortProjectIdsByLastMessage()
        })
    ],
    [
      'db.worktree.create',
      (params) =>
        Effect.gen(function* () {
          const data = yield* Effect.try({
            try: () => worktreeCreateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createWorktree(data)
        })
    ],
    [
      'db.worktree.get',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => projectGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getWorktree(id)
        })
    ],
    [
      'db.worktree.getByProject',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => worktreeByProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getWorktreesByProject(projectId)
        })
    ],
    [
      'db.worktree.getActiveByProject',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => worktreeByProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getActiveWorktreesByProject(projectId)
        })
    ],
    [
      'db.worktree.getRecentlyActive',
      (params) =>
        Effect.gen(function* () {
          const { cutoffMs } = yield* Effect.try({
            try: () => worktreeRecentlyActiveParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getRecentlyActiveWorktrees(cutoffMs)
        })
    ],
    [
      'db.worktree.update',
      (params) =>
        Effect.gen(function* () {
          const { id, data } = yield* Effect.try({
            try: () => worktreeUpdateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.updateWorktree(id, data)
        })
    ],
    [
      'db.worktree.delete',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => projectGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.deleteWorktree(id)
        })
    ],
    [
      'db.worktree.archive',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => projectGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.archiveWorktree(id)
        })
    ],
    [
      'db.worktree.touch',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => projectGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.touchWorktree(id)
        })
    ],
    [
      'db.worktree.appendSessionTitle',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId, title } = yield* Effect.try({
            try: () => worktreeAppendSessionTitleParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.appendWorktreeSessionTitle(worktreeId, title)
        })
    ],
    [
      'db.worktree.updateModel',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => worktreeModelParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.updateWorktreeModel(parsed)
        })
    ],
    [
      'db.worktree.addAttachment',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId, attachment } = yield* Effect.try({
            try: () => worktreeAttachmentParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.addWorktreeAttachment(worktreeId, attachment)
        })
    ],
    [
      'db.worktree.removeAttachment',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId, attachmentId } = yield* Effect.try({
            try: () => worktreeAttachmentIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.removeWorktreeAttachment(worktreeId, attachmentId)
        })
    ],
    [
      'db.worktree.attachPR',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId, prNumber, prUrl } = yield* Effect.try({
            try: () => worktreePrParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.attachWorktreePr(worktreeId, prNumber, prUrl)
        })
    ],
    [
      'db.worktree.detachPR',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId } = yield* Effect.try({
            try: () => worktreeIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.detachWorktreePr(worktreeId)
        })
    ],
    [
      'db.worktree.setPinned',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId, pinned } = yield* Effect.try({
            try: () => worktreePinnedParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setWorktreePinned(worktreeId, pinned)
        })
    ],
    [
      'db.worktree.getPinned',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getPinnedWorktrees()
        })
    ],
    [
      'db.session.create',
      (params) =>
        Effect.gen(function* () {
          const data = yield* Effect.try({
            try: () => sessionCreateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createSession(data)
        })
    ],
    [
      'db.session.get',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => projectGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getSession(id)
        })
    ],
    [
      'db.session.getByWorktree',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId } = yield* Effect.try({
            try: () => sessionByWorktreeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getSessionsByWorktree(worktreeId)
        })
    ],
    [
      'db.session.getByProject',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => sessionByProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getSessionsByProject(projectId)
        })
    ],
    [
      'db.session.getActiveByWorktree',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId } = yield* Effect.try({
            try: () => sessionByWorktreeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getActiveSessionsByWorktree(worktreeId)
        })
    ],
    [
      'db.session.update',
      (params) =>
        Effect.gen(function* () {
          const { id, data } = yield* Effect.try({
            try: () => sessionUpdateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.updateSession(id, data)
        })
    ],
    [
      'db.session.delete',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => projectGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.deleteSession(id)
        })
    ],
    [
      'db.session.search',
      (params) =>
        Effect.gen(function* () {
          const options = yield* Effect.try({
            try: () => sessionSearchOptionsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.searchSessions(options)
        })
    ],
    [
      'db.session.getDraft',
      (params) =>
        Effect.gen(function* () {
          const { sessionId } = yield* Effect.try({
            try: () => sessionDraftParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getSessionDraft(sessionId)
        })
    ],
    [
      'db.session.updateDraft',
      (params) =>
        Effect.gen(function* () {
          const { sessionId, draft } = yield* Effect.try({
            try: () => sessionUpdateDraftParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.updateSessionDraft(sessionId, draft)
        })
    ],
    [
      'db.session.getByConnection',
      (params) =>
        Effect.gen(function* () {
          const { connectionId } = yield* Effect.try({
            try: () => sessionByConnectionParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getSessionsByConnection(connectionId)
        })
    ],
    [
      'db.session.getActiveByConnection',
      (params) =>
        Effect.gen(function* () {
          const { connectionId } = yield* Effect.try({
            try: () => sessionByConnectionParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getActiveSessionsByConnection(connectionId)
        })
    ],
    [
      'db.session.setPinnedToBoard',
      (params) =>
        Effect.gen(function* () {
          const { sessionId, pinned } = yield* Effect.try({
            try: () => sessionPinnedToBoardParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setSessionPinnedToBoard(sessionId, pinned)
        })
    ],
    [
      'db.session.getPinnedSessions',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId } = yield* Effect.try({
            try: () => sessionByWorktreeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getPinnedSessions(worktreeId)
        })
    ],
    [
      'db.session.getActiveBoardAssistant',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => sessionByProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getActiveBoardAssistant(projectId)
        })
    ],
    [
      'db.sessionMessage.list',
      (params) =>
        Effect.gen(function* () {
          const { sessionId } = yield* Effect.try({
            try: () => sessionDraftParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.listSessionMessages(sessionId)
        })
    ],
    [
      'db.sessionActivity.list',
      (params) =>
        Effect.gen(function* () {
          const { sessionId } = yield* Effect.try({
            try: () => sessionDraftParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.listSessionActivities(sessionId)
        })
    ],
    [
      'db.space.list',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.listSpaces()
        })
    ],
    [
      'db.space.create',
      (params) =>
        Effect.gen(function* () {
          const data = yield* Effect.try({
            try: () => spaceCreateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createSpace(data)
        })
    ],
    [
      'db.space.update',
      (params) =>
        Effect.gen(function* () {
          const { id, data } = yield* Effect.try({
            try: () => spaceUpdateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.updateSpace(id, data)
        })
    ],
    [
      'db.space.delete',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => projectGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.deleteSpace(id)
        })
    ],
    [
      'db.space.assignProject',
      (params) =>
        Effect.gen(function* () {
          const { projectId, spaceId } = yield* Effect.try({
            try: () => spaceProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.assignProjectToSpace(projectId, spaceId)
        })
    ],
    [
      'db.space.removeProject',
      (params) =>
        Effect.gen(function* () {
          const { projectId, spaceId } = yield* Effect.try({
            try: () => spaceProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.removeProjectFromSpace(projectId, spaceId)
        })
    ],
    [
      'db.space.getProjectIds',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => projectGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getProjectIdsForSpace(id)
        })
    ],
    [
      'db.space.getAllAssignments',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getAllProjectSpaceAssignments()
        })
    ],
    [
      'db.space.reorder',
      (params) =>
        Effect.gen(function* () {
          const { orderedIds } = yield* Effect.try({
            try: () => projectReorderParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.reorderSpaces(orderedIds)
        })
    ],
    [
      'db.diffComment.create',
      (params) =>
        Effect.gen(function* () {
          const data = yield* Effect.try({
            try: () => diffCommentCreateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createDiffComment(data)
        })
    ],
    [
      'db.diffComment.list',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId } = yield* Effect.try({
            try: () => worktreeIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.listDiffComments(worktreeId)
        })
    ],
    [
      'db.diffComment.update',
      (params) =>
        Effect.gen(function* () {
          const { id, data } = yield* Effect.try({
            try: () => diffCommentUpdateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.updateDiffComment(id, data)
        })
    ],
    [
      'db.diffComment.setOutdated',
      (params) =>
        Effect.gen(function* () {
          const { id, isOutdated } = yield* Effect.try({
            try: () => diffCommentSetOutdatedParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setDiffCommentOutdated(id, isOutdated)
        })
    ],
    [
      'db.diffComment.delete',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => projectGetParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.deleteDiffComment(id)
        })
    ],
    [
      'db.diffComment.clearAll',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId } = yield* Effect.try({
            try: () => worktreeIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.clearAllDiffComments(worktreeId)
        })
    ],
    [
      'db.schemaVersion',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getSchemaVersion()
        })
    ],
    [
      'db.tableExists',
      (params) =>
        Effect.gen(function* () {
          const { tableName } = yield* Effect.try({
            try: () => tableExistsParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.tableExists(tableName)
        })
    ],
    [
      'db.getIndexes',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getIndexes()
        })
    ]
  ])
