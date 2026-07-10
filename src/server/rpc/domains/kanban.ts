import { Effect } from 'effect'
import { z } from 'zod'
import { isDesktopCommandResult, makeDesktopCommandRequest } from '../../../shared/desktop-command'
import type {
  KanbanMarkdownConfig,
  KanbanStorageConfig,
  KanbanStorageMode,
  KanbanTicket,
  KanbanTicketBatchCreate,
  KanbanTicketBatchCreateResult,
  KanbanTicketCreate,
  KanbanTicketDuplicateOverrides,
  KanbanTicketUpdate,
  MarkdownCardDiagnostic,
  TicketDependency
} from '../../../main/db'
import type { RpcHandler } from '../router'

interface KanbanBoardImportTicket {
  readonly id: string
  readonly title: string
  readonly description?: string | null
  readonly attachments?: unknown[] | null
  readonly column?: string
}

interface KanbanBoardImportDependency {
  readonly dependentId: string
  readonly blockerId: string
}

interface KanbanBoardImportFileResult {
  readonly tickets: KanbanBoardImportTicket[]
  readonly dependencies: KanbanBoardImportDependency[]
  readonly projectName: string | null
}

interface KanbanBoardExportResult {
  readonly success: boolean
  readonly ticketCount: number
  readonly path?: string
  readonly error?: string
}

interface KanbanBoardImportResult {
  readonly created: number
  readonly updated: number
  readonly dependencyCount: number
  readonly ignoredDependencyCount: number
}

export interface KanbanRpcService {
  readonly createTicket: (
    projectId: string,
    data: KanbanTicketCreate
  ) => Effect.Effect<KanbanTicket, unknown, never>
  readonly createTicketBatch: (
    projectId: string,
    data: KanbanTicketBatchCreate
  ) => Effect.Effect<KanbanTicketBatchCreateResult, unknown, never>
  readonly getTicket: (
    projectId: string,
    id: string
  ) => Effect.Effect<KanbanTicket | null, unknown, never>
  readonly getTicketsByProject: (
    projectId: string,
    includeArchived?: boolean
  ) => Effect.Effect<KanbanTicket[], unknown, never>
  readonly updateTicket: (
    projectId: string,
    id: string,
    data: KanbanTicketUpdate
  ) => Effect.Effect<KanbanTicket | null, unknown, never>
  readonly deleteTicket: (projectId: string, id: string) => Effect.Effect<boolean, unknown, never>
  readonly archiveTicket: (
    projectId: string,
    id: string
  ) => Effect.Effect<KanbanTicket | null, unknown, never>
  readonly archiveAllDoneTickets: (projectId: string) => Effect.Effect<number, unknown, never>
  readonly unarchiveTicket: (
    projectId: string,
    id: string
  ) => Effect.Effect<KanbanTicket | null, unknown, never>
  readonly moveTicket: (
    projectId: string,
    id: string,
    column: KanbanTicket['column'],
    sortOrder: number
  ) => Effect.Effect<KanbanTicket | null, unknown, never>
  // Optional (like the other ticket methods below) so the 50+ existing test
  // mocks that construct a full `kanban:` service literal don't all need updating.
  readonly duplicateTicket?: (
    projectId: string,
    id: string,
    overrides?: KanbanTicketDuplicateOverrides
  ) => Effect.Effect<KanbanTicket, unknown, never>
  readonly moveTicketToProject?: (
    projectId: string,
    id: string,
    targetProjectId: string
  ) => Effect.Effect<KanbanTicket | null, unknown, never>
  readonly reorderTicket?: (
    projectId: string,
    id: string,
    sortOrder: number
  ) => Effect.Effect<void, unknown, never>
  readonly getTicketsBySession?: (
    sessionId: string
  ) => Effect.Effect<KanbanTicket[], unknown, never>
  readonly addTicketTokens?: (
    projectId: string,
    id: string,
    tokens: number
  ) => Effect.Effect<KanbanTicket | null, unknown, never>
  readonly syncPrToTickets?: (
    worktreeId: string,
    prNumber: number,
    prUrl: string
  ) => Effect.Effect<void, unknown, never>
  readonly clearPrFromTickets?: (worktreeId: string) => Effect.Effect<void, unknown, never>
  readonly attachPrToTicket?: (
    ticketId: string,
    projectId: string,
    prNumber: number,
    prUrl: string
  ) => Effect.Effect<void, unknown, never>
  readonly detachPrFromTicket?: (
    ticketId: string,
    projectId: string
  ) => Effect.Effect<void, unknown, never>
  readonly detachWorktreeFromTickets?: (worktreeId: string) => Effect.Effect<number, unknown, never>
  readonly updateProjectSimpleMode?: (
    projectId: string,
    enabled: boolean
  ) => Effect.Effect<void, unknown, never>
  readonly addTicketDependency?: (
    projectId: string,
    dependentId: string,
    blockerId: string
  ) => Effect.Effect<{ success: boolean; error?: string }, unknown, never>
  readonly removeTicketDependency?: (
    projectId: string,
    dependentId: string,
    blockerId: string
  ) => Effect.Effect<boolean, unknown, never>
  readonly getBlockersForTicket?: (
    projectId: string,
    ticketId: string
  ) => Effect.Effect<KanbanTicket[], unknown, never>
  readonly getDependentsOfTicket?: (
    projectId: string,
    ticketId: string
  ) => Effect.Effect<KanbanTicket[], unknown, never>
  readonly getDependenciesForProject?: (
    projectId: string
  ) => Effect.Effect<TicketDependency[], unknown, never>
  readonly removeAllDependenciesForTicket?: (
    projectId: string,
    ticketId: string
  ) => Effect.Effect<number, unknown, never>
  readonly openBoardImportFile?: () => Effect.Effect<
    KanbanBoardImportFileResult | null,
    unknown,
    never
  >
  readonly exportBoard?: (
    projectId: string,
    projectName: string
  ) => Effect.Effect<KanbanBoardExportResult, unknown, never>
  readonly importBoardTickets?: (
    projectId: string,
    tickets: KanbanBoardImportTicket[],
    dependencies?: KanbanBoardImportDependency[]
  ) => Effect.Effect<KanbanBoardImportResult, unknown, never>
  readonly getConfig?: (projectId: string) => Effect.Effect<KanbanStorageConfig, unknown, never>
  readonly updateConfig?: (
    projectId: string,
    config: KanbanMarkdownConfig
  ) => Effect.Effect<KanbanStorageConfig, unknown, never>
  readonly setMode?: (
    projectId: string,
    mode: KanbanStorageMode
  ) => Effect.Effect<{ success: boolean; error?: string }, unknown, never>
  readonly createFolders?: (
    projectId: string,
    config?: KanbanMarkdownConfig
  ) => Effect.Effect<{ success: boolean; error?: string }, unknown, never>
  readonly pickMarkdownFolder?: () => Effect.Effect<string | null, unknown, never>
  readonly getDiagnostics?: (
    projectId: string
  ) => Effect.Effect<MarkdownCardDiagnostic[], unknown, never>
  readonly convertMarkdownFileToCard?: (
    projectId: string,
    filePath: string
  ) => Effect.Effect<KanbanTicket, unknown, never>
  readonly startWatch?: (
    projectId: string
  ) => Effect.Effect<{ success: boolean; error?: string }, unknown, never>
  readonly stopWatch?: (
    projectId: string
  ) => Effect.Effect<{ success: boolean; error?: string }, unknown, never>
}

const ticketColumnSchema = z.enum(['todo', 'in_progress', 'review', 'done'])
const sessionModeSchema = z.enum(['build', 'plan', 'super-plan'])
const ticketMarkSchema = z.enum(['common', 'rare', 'epic', 'legendary'])

const kanbanTicketCreateSchema = z
  .object({
    id: z.string().optional(),
    project_id: z.string(),
    title: z.string(),
    description: z.string().nullable().optional(),
    attachments: z.array(z.unknown()).optional(),
    column: ticketColumnSchema.optional(),
    sort_order: z.number().optional(),
    current_session_id: z.string().nullable().optional(),
    worktree_id: z.string().nullable().optional(),
    mode: sessionModeSchema.nullable().optional(),
    plan_ready: z.boolean().optional(),
    external_provider: z.string().nullable().optional(),
    external_id: z.string().nullable().optional(),
    external_url: z.string().nullable().optional(),
    github_pr_number: z.number().nullable().optional(),
    github_pr_url: z.string().nullable().optional(),
    mark: ticketMarkSchema.nullable().optional(),
    created_from_session: z.boolean().optional(),
    note: z.string().nullable().optional(),
    model_provider_id: z.string().nullable().optional(),
    model_id: z.string().nullable().optional(),
    model_variant: z.string().nullable().optional(),
    variant_group_id: z.string().nullable().optional()
  })
  .strict() satisfies z.ZodType<KanbanTicketCreate>

const kanbanTicketBatchCreateItemSchema = kanbanTicketCreateSchema
  .extend({
    draft_key: z.string(),
    project_id: z.string(),
    title: z.string(),
    depends_on: z.array(z.string()).optional()
  })
  .omit({ id: true })

const kanbanTicketBatchCreateSchema = z
  .object({
    drafts: z.array(kanbanTicketBatchCreateItemSchema)
  })
  .strict() satisfies z.ZodType<KanbanTicketBatchCreate>
const kanbanTicketBatchCreateParamsSchema = z
  .object({
    projectId: z.string(),
    data: kanbanTicketBatchCreateSchema
  })
  .strict()
const kanbanTicketDuplicateOverridesSchema = z
  .object({
    column: ticketColumnSchema.optional(),
    sort_order: z.number().optional(),
    model_provider_id: z.string().nullable().optional(),
    model_id: z.string().nullable().optional(),
    model_variant: z.string().nullable().optional(),
    variant_group_id: z.string().nullable().optional()
  })
  .strict() satisfies z.ZodType<KanbanTicketDuplicateOverrides>
const kanbanTicketDuplicateParamsSchema = z
  .object({
    projectId: z.string(),
    id: z.string(),
    overrides: kanbanTicketDuplicateOverridesSchema.optional()
  })
  .strict()
const kanbanTicketUpdateSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    attachments: z.array(z.unknown()).optional(),
    column: ticketColumnSchema.optional(),
    sort_order: z.number().optional(),
    current_session_id: z.string().nullable().optional(),
    worktree_id: z.string().nullable().optional(),
    mode: sessionModeSchema.nullable().optional(),
    plan_ready: z.boolean().optional(),
    github_pr_number: z.number().nullable().optional(),
    github_pr_url: z.string().nullable().optional(),
    mark: ticketMarkSchema.nullable().optional(),
    pending_launch_config: z.string().nullable().optional(),
    goal_mode: z.boolean().optional(),
    goal_success_criteria: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    archived_at: z.string().nullable().optional(),
    auto_approve_plan: z.boolean().optional(),
    model_provider_id: z.string().nullable().optional(),
    model_id: z.string().nullable().optional(),
    model_variant: z.string().nullable().optional(),
    variant_group_id: z.string().nullable().optional()
  })
  .strict() satisfies z.ZodType<KanbanTicketUpdate>
const ticketIdProjectParamsSchema = z
  .object({
    projectId: z.string(),
    id: z.string()
  })
  .strict()
const getTicketsByProjectParamsSchema = z
  .object({
    projectId: z.string(),
    includeArchived: z.boolean().optional()
  })
  .strict()
const projectIdParamsSchema = z.object({ projectId: z.string() }).strict()
const markdownFileParamsSchema = z
  .object({
    projectId: z.string(),
    filePath: z.string()
  })
  .strict()
const updateTicketParamsSchema = z
  .object({
    projectId: z.string(),
    id: z.string(),
    data: kanbanTicketUpdateSchema
  })
  .strict()
const moveTicketParamsSchema = z
  .object({
    projectId: z.string(),
    id: z.string(),
    column: ticketColumnSchema,
    sortOrder: z.number()
  })
  .strict()
const moveTicketToProjectParamsSchema = z
  .object({
    projectId: z.string(),
    id: z.string(),
    targetProjectId: z.string()
  })
  .strict()
const reorderTicketParamsSchema = z
  .object({
    projectId: z.string(),
    id: z.string(),
    sortOrder: z.number()
  })
  .strict()
const sessionIdParamsSchema = z.object({ sessionId: z.string() }).strict()
const addTicketTokensParamsSchema = z
  .object({
    projectId: z.string(),
    id: z.string(),
    tokens: z.number()
  })
  .strict()
const syncPrToTicketsParamsSchema = z
  .object({
    worktreeId: z.string(),
    prNumber: z.number(),
    prUrl: z.string()
  })
  .strict()
const worktreeIdParamsSchema = z.object({ worktreeId: z.string() }).strict()
const attachPrToTicketParamsSchema = z
  .object({
    ticketId: z.string(),
    projectId: z.string(),
    prNumber: z.number(),
    prUrl: z.string()
  })
  .strict()
const ticketProjectParamsSchema = z
  .object({
    ticketId: z.string(),
    projectId: z.string()
  })
  .strict()
const simpleModeToggleParamsSchema = z
  .object({
    projectId: z.string(),
    enabled: z.boolean()
  })
  .strict()
const ticketDependencyPairParamsSchema = z
  .object({
    projectId: z.string(),
    dependentId: z.string(),
    blockerId: z.string()
  })
  .strict()
const ticketDependencyLookupParamsSchema = z
  .object({
    projectId: z.string(),
    id: z.string()
  })
  .strict()
const exportBoardParamsSchema = z
  .object({
    projectId: z.string(),
    projectName: z.string()
  })
  .strict()
const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const importTicketSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable().optional(),
    attachments: z.array(z.unknown()).nullable().optional(),
    column: z.string().optional()
  })
  .strict() satisfies z.ZodType<KanbanBoardImportTicket>
const importDependencySchema = z
  .object({
    dependentId: z.string(),
    blockerId: z.string()
  })
  .strict() satisfies z.ZodType<KanbanBoardImportDependency>
const importBoardTicketsParamsSchema = z
  .object({
    projectId: z.string(),
    tickets: z.array(importTicketSchema),
    dependencies: z.array(importDependencySchema).optional()
  })
  .strict()
const kanbanStorageModeSchema = z.enum(['internal', 'markdown'])
const kanbanMarkdownStatusFoldersSchema = z
  .object({
    todo: z.string(),
    in_progress: z.string(),
    review: z.string(),
    done: z.string()
  })
  .strict()
const kanbanMarkdownConfigSchema = z.discriminatedUnion('layout', [
  z
    .object({
      layout: z.literal('single-folder'),
      singleFolder: z.string(),
      statusFolders: kanbanMarkdownStatusFoldersSchema.optional()
    })
    .strict(),
  z
    .object({
      layout: z.literal('status-folders'),
      singleFolder: z.string().optional(),
      statusFolders: kanbanMarkdownStatusFoldersSchema
    })
    .strict()
]) satisfies z.ZodType<KanbanMarkdownConfig>
const updateKanbanConfigParamsSchema = z
  .object({
    projectId: z.string(),
    config: kanbanMarkdownConfigSchema
  })
  .strict()
const setKanbanModeParamsSchema = z
  .object({
    projectId: z.string(),
    mode: kanbanStorageModeSchema
  })
  .strict()
const createKanbanFoldersParamsSchema = z
  .object({
    projectId: z.string(),
    config: kanbanMarkdownConfigSchema.optional()
  })
  .strict()

export const parseKanbanBoardImportFile = (raw: string): KanbanBoardImportFileResult => {
  const parsed = JSON.parse(raw) as unknown

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { tickets?: unknown }).tickets) ||
    !(parsed as { tickets: unknown[] }).tickets.every(
      (ticket: unknown) =>
        typeof ticket === 'object' && ticket !== null && 'id' in ticket && 'title' in ticket
    )
  ) {
    throw new Error('Invalid Hive board file: missing tickets array or tickets lack id/title')
  }

  return {
    tickets: (parsed as { tickets: KanbanBoardImportTicket[] }).tickets,
    dependencies: Array.isArray((parsed as { dependencies?: unknown }).dependencies)
      ? (parsed as { dependencies: unknown[] }).dependencies.filter(
          (dependency: unknown): dependency is KanbanBoardImportDependency =>
            typeof dependency === 'object' &&
            dependency !== null &&
            typeof (dependency as { dependentId?: unknown }).dependentId === 'string' &&
            typeof (dependency as { blockerId?: unknown }).blockerId === 'string'
        )
      : [],
    projectName:
      typeof (parsed as { projectName?: unknown }).projectName === 'string'
        ? (parsed as { projectName: string }).projectName
        : null
  }
}

const errorMessage = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'reason' in error) {
    const reason = (error as { reason?: unknown }).reason
    if (typeof reason === 'string') return reason
  }
  return error instanceof Error ? error.message : String(error)
}

export const makeLiveKanbanRpcService = (): KanbanRpcService => ({
  createTicket: (projectId, data) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).create(projectId, data)
      },
      catch: (cause) => cause
    }),
  duplicateTicket: (projectId, id, overrides) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).duplicate(projectId, id, overrides)
      },
      catch: (cause) => cause
    }),
  createTicketBatch: (projectId, data) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).createBatch(projectId, data)
      },
      catch: (cause) => cause
    }),
  getTicket: (projectId, id) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).get(projectId, id)
      },
      catch: (cause) => cause
    }),
  getTicketsByProject: (projectId, includeArchived) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).list(projectId, includeArchived ?? false)
      },
      catch: (cause) => cause
    }),
  updateTicket: (projectId, id, data) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).update(projectId, id, data)
      },
      catch: (cause) => cause
    }),
  deleteTicket: (projectId, id) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).delete(projectId, id)
      },
      catch: (cause) => cause
    }),
  archiveTicket: (projectId, id) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).archive(projectId, id)
      },
      catch: (cause) => cause
    }),
  archiveAllDoneTickets: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).archiveAllDone(projectId)
      },
      catch: (cause) => cause
    }),
  unarchiveTicket: (projectId, id) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).unarchive(projectId, id)
      },
      catch: (cause) => cause
    }),
  moveTicket: (projectId, id, column, sortOrder) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).move(projectId, id, column, sortOrder)
      },
      catch: (cause) => cause
    }),
  moveTicketToProject: (projectId, id, targetProjectId) =>
    Effect.tryPromise({
      try: async () => {
        const { moveKanbanTicketToProject } = await import(
          '../../../main/services/kanban-backend'
        )
        return moveKanbanTicketToProject(projectId, id, targetProjectId)
      },
      catch: (cause) => cause
    }),
  reorderTicket: (projectId, id, sortOrder) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).reorder(projectId, id, sortOrder)
      },
      catch: (cause) => cause
    }),
  getTicketsBySession: (sessionId) =>
    Effect.tryPromise({
      try: async () => {
        const { getAllKanbanTicketsBySession } = await import(
          '../../../main/services/kanban-backend'
        )
        return getAllKanbanTicketsBySession(sessionId)
      },
      catch: (cause) => cause
    }),
  addTicketTokens: (projectId, id, tokens) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).addTokens(projectId, id, tokens)
      },
      catch: (cause) => cause
    }),
  syncPrToTickets: (worktreeId, prNumber, prUrl) =>
    Effect.tryPromise({
      try: async () => {
        const { syncPRToAllKanbanBackends } = await import('../../../main/services/kanban-backend')
        return syncPRToAllKanbanBackends(worktreeId, prNumber, prUrl)
      },
      catch: (cause) => cause
    }),
  clearPrFromTickets: (worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const { clearPRFromAllKanbanBackends } = await import('../../../main/services/kanban-backend')
        return clearPRFromAllKanbanBackends(worktreeId)
      },
      catch: (cause) => cause
    }),
  attachPrToTicket: (ticketId, projectId, prNumber, prUrl) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).attachPR(projectId, ticketId, prNumber, prUrl)
      },
      catch: (cause) => cause
    }),
  detachPrFromTicket: (ticketId, projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).detachPR(projectId, ticketId)
      },
      catch: (cause) => cause
    }),
  detachWorktreeFromTickets: (worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const { detachWorktreeFromAllKanbanBackends } = await import(
          '../../../main/services/kanban-backend'
        )
        return detachWorktreeFromAllKanbanBackends(worktreeId)
      },
      catch: (cause) => cause
    }),
  updateProjectSimpleMode: (projectId, enabled) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().updateProjectSimpleMode(projectId, enabled)
      },
      catch: (cause) => cause
    }),
  addTicketDependency: (projectId, dependentId, blockerId) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).addDependency(projectId, dependentId, blockerId)
      },
      catch: (cause) => cause
    }),
  removeTicketDependency: (projectId, dependentId, blockerId) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).removeDependency(
          projectId,
          dependentId,
          blockerId
        )
      },
      catch: (cause) => cause
    }),
  getBlockersForTicket: (projectId, ticketId) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).getBlockers(projectId, ticketId)
      },
      catch: (cause) => cause
    }),
  getDependentsOfTicket: (projectId, ticketId) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).getDependents(projectId, ticketId)
      },
      catch: (cause) => cause
    }),
  getDependenciesForProject: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).getDependenciesForProject(projectId)
      },
      catch: (cause) => cause
    }),
  removeAllDependenciesForTicket: (projectId, ticketId) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).removeAllDependencies(projectId, ticketId)
      },
      catch: (cause) => cause
    }),
  openBoardImportFile: () =>
    Effect.gen(function* () {
      const filePath = yield* Effect.tryPromise({
        try: () => requestKanbanOpenBoardImportFileDialog(),
        catch: (cause) => cause
      })

      if (!filePath) {
        return null
      }

      const raw = yield* Effect.tryPromise({
        try: async () => {
          const { readFile } = await import('node:fs/promises')
          return readFile(filePath, 'utf-8')
        },
        catch: (cause) => cause
      })

      return yield* Effect.try({
        try: () => parseKanbanBoardImportFile(raw),
        catch: (cause) => cause
      })
    }).pipe(Effect.catchAll(() => Effect.succeed(null))),
  exportBoard: (projectId, projectName) =>
    Effect.gen(function* () {
      const { exportData, ticketCount } = yield* Effect.tryPromise({
        try: async () => {
          const { getKanbanBackendForProject } = await import(
            '../../../main/services/kanban-backend'
          )
          const { tickets, dependencies } =
            await getKanbanBackendForProject(projectId).exportBoard(projectId)

          return {
            ticketCount: tickets.length,
            exportData: {
              projectName,
              exportedAt: new Date().toISOString(),
              tickets: tickets.map((ticket) => ({
                id: ticket.id,
                title: ticket.title,
                description: ticket.description,
                attachments: ticket.attachments,
                column: ticket.column
              })),
              dependencies: dependencies.map((dependency) => ({
                dependentId: dependency.dependent_id,
                blockerId: dependency.blocker_id
              }))
            }
          }
        },
        catch: (cause) => cause
      })

      const filePath = yield* Effect.tryPromise({
        try: () => requestKanbanSaveBoardExportDialog(projectName),
        catch: (cause) => cause
      })

      if (!filePath) {
        return { success: false, ticketCount: 0 }
      }

      yield* Effect.tryPromise({
        try: async () => {
          const { writeFile } = await import('node:fs/promises')
          return writeFile(filePath, JSON.stringify(exportData, null, 2), 'utf-8')
        },
        catch: (cause) => cause
      })

      return { success: true, ticketCount, path: filePath }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed({ success: false, ticketCount: 0, error: errorMessage(error) })
      )
    ),
  importBoardTickets: (projectId, tickets, dependencies) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanBackendForProject } = await import('../../../main/services/kanban-backend')
        return getKanbanBackendForProject(projectId).importTickets(projectId, tickets, dependencies)
      },
      catch: (cause) => cause
    }),
  getConfig: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanStorageConfig } = await import('../../../main/services/kanban-backend')
        return getKanbanStorageConfig(projectId)
      },
      catch: (cause) => cause
    }),
  updateConfig: (projectId, config) =>
    Effect.tryPromise({
      try: async () => {
        const { updateKanbanMarkdownConfig } = await import('../../../main/services/kanban-backend')
        return updateKanbanMarkdownConfig(projectId, config)
      },
      catch: (cause) => cause
    }),
  setMode: (projectId, mode) =>
    Effect.tryPromise({
      try: async () => {
        const { setKanbanStorageMode } = await import('../../../main/services/kanban-backend')
        return setKanbanStorageMode(projectId, mode)
      },
      catch: (cause) => cause
    }),
  createFolders: (projectId, config) =>
    Effect.tryPromise({
      try: async () => {
        const { createConfiguredMarkdownFolders } = await import(
          '../../../main/services/kanban-backend'
        )
        await createConfiguredMarkdownFolders(projectId, config)
        return { success: true }
      },
      catch: (cause) => cause
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.succeed({
          success: false,
          error: cause instanceof Error ? cause.message : String(cause)
        })
      )
    ),
  pickMarkdownFolder: () =>
    Effect.tryPromise({
      try: () => requestKanbanPickMarkdownFolderDialog(),
      catch: (cause) => cause
    }),
  getDiagnostics: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getKanbanStorageConfig, getMarkdownKanbanBackend } = await import(
          '../../../main/services/kanban-backend'
        )
        if (getKanbanStorageConfig(projectId).mode !== 'markdown') return []
        return getMarkdownKanbanBackend().getDiagnostics(projectId)
      },
      catch: (cause) => cause
    }),
  convertMarkdownFileToCard: (projectId, filePath) =>
    Effect.tryPromise({
      try: async () => {
        const { getMarkdownKanbanBackend } = await import('../../../main/services/kanban-backend')
        return getMarkdownKanbanBackend().convertMarkdownFileToCard(projectId, filePath)
      },
      catch: (cause) => cause
    }),
  startWatch: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { startMarkdownKanbanProjectWatch } = await import(
          '../../../main/services/markdown-kanban-watcher'
        )
        return startMarkdownKanbanProjectWatch(projectId)
      },
      catch: (cause) => cause
    }),
  stopWatch: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { stopMarkdownKanbanProjectWatch } = await import(
          '../../../main/services/markdown-kanban-watcher'
        )
        return stopMarkdownKanbanProjectWatch(projectId)
      },
      catch: (cause) => cause
    })
})

const requestKanbanOpenBoardImportFileDialog = (): Promise<string | null> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve(null)
  }

  const id = `kanban-open-board-import-file-dialog-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'kanbanOpenBoardImportFileDialog'

  return new Promise<string | null>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      process.off('message', onMessage)
    }
    const finish = (value?: string | null, error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve(value ?? null)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(null, new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      if (!isKanbanOpenBoardImportFileDialogResult(message.value)) {
        finish(null, new Error(`Desktop command returned invalid response: ${command}`))
        return
      }
      finish(message.value.filePath)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      finish(null, error)
    })
  })
}

const isKanbanOpenBoardImportFileDialogResult = (
  value: unknown
): value is { readonly filePath: string | null } => {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return result.filePath === null || typeof result.filePath === 'string'
}

const requestKanbanSaveBoardExportDialog = (projectName: string): Promise<string | null> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve(null)
  }

  const id = `kanban-save-board-export-dialog-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'kanbanSaveBoardExportDialog'

  return new Promise<string | null>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      process.off('message', onMessage)
    }
    const finish = (value?: string | null, error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve(value ?? null)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(null, new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      if (!isKanbanSaveBoardExportDialogResult(message.value)) {
        finish(null, new Error(`Desktop command returned invalid response: ${command}`))
        return
      }
      finish(message.value.filePath)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { projectName }), (error) => {
      if (!error) return
      finish(null, error)
    })
  })
}

const isKanbanSaveBoardExportDialogResult = (
  value: unknown
): value is { readonly filePath: string | null } => {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return result.filePath === null || typeof result.filePath === 'string'
}

const requestKanbanPickMarkdownFolderDialog = (): Promise<string | null> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve(null)
  }

  const id = `kanban-pick-markdown-folder-dialog-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'projectOpenDirectoryDialog'

  return new Promise<string | null>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      process.off('message', onMessage)
    }
    const finish = (value?: string | null, error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve(value ?? null)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(null, new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      if (message.value !== null && typeof message.value !== 'string') {
        finish(null, new Error(`Desktop command returned invalid response: ${command}`))
        return
      }
      finish(message.value)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      finish(null, error)
    })
  })
}

export const makeKanbanRpcHandlers = (
  service: KanbanRpcService = makeLiveKanbanRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'kanban.ticket.create',
      (params) =>
        Effect.gen(function* () {
          const data = yield* Effect.try({
            try: () => kanbanTicketCreateSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createTicket(data.project_id, data)
        })
    ],
    [
      'kanban.ticket.duplicate',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id, overrides } = yield* Effect.try({
            try: () => kanbanTicketDuplicateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.duplicateTicket) {
            return yield* Effect.die(new Error('kanban.ticket.duplicate service is not implemented'))
          }
          return yield* service.duplicateTicket(projectId, id, overrides)
        })
    ],
    [
      'kanban.ticket.createBatch',
      (params) =>
        Effect.gen(function* () {
          const { projectId, data } = yield* Effect.try({
            try: () => kanbanTicketBatchCreateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createTicketBatch(projectId, data)
        })
    ],
    [
      'kanban.ticket.get',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id } = yield* Effect.try({
            try: () => ticketIdProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getTicket(projectId, id)
        })
    ],
    [
      'kanban.ticket.getByProject',
      (params) =>
        Effect.gen(function* () {
          const { projectId, includeArchived } = yield* Effect.try({
            try: () => getTicketsByProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getTicketsByProject(projectId, includeArchived)
        })
    ],
    [
      'kanban.ticket.update',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id, data } = yield* Effect.try({
            try: () => updateTicketParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.updateTicket(projectId, id, data)
        })
    ],
    [
      'kanban.ticket.delete',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id } = yield* Effect.try({
            try: () => ticketIdProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.deleteTicket(projectId, id)
        })
    ],
    [
      'kanban.ticket.archive',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id } = yield* Effect.try({
            try: () => ticketIdProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.archiveTicket(projectId, id)
        })
    ],
    [
      'kanban.ticket.archiveAllDone',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => projectIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.archiveAllDoneTickets(projectId)
        })
    ],
    [
      'kanban.ticket.unarchive',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id } = yield* Effect.try({
            try: () => ticketIdProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.unarchiveTicket(projectId, id)
        })
    ],
    [
      'kanban.ticket.move',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id, column, sortOrder } = yield* Effect.try({
            try: () => moveTicketParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.moveTicket(projectId, id, column, sortOrder)
        })
    ],
    [
      'kanban.ticket.moveToProject',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id, targetProjectId } = yield* Effect.try({
            try: () => moveTicketToProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.moveTicketToProject) {
            return yield* Effect.die(
              new Error('kanban.ticket.moveToProject service is not implemented')
            )
          }
          return yield* service.moveTicketToProject(projectId, id, targetProjectId)
        })
    ],
    [
      'kanban.ticket.reorder',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id, sortOrder } = yield* Effect.try({
            try: () => reorderTicketParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.reorderTicket) {
            return yield* Effect.die(new Error('kanban.ticket.reorder service is not implemented'))
          }
          return yield* service.reorderTicket(projectId, id, sortOrder)
        })
    ],
    [
      'kanban.ticket.getBySession',
      (params) =>
        Effect.gen(function* () {
          const { sessionId } = yield* Effect.try({
            try: () => sessionIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.getTicketsBySession) {
            return yield* Effect.die(
              new Error('kanban.ticket.getBySession service is not implemented')
            )
          }
          return yield* service.getTicketsBySession(sessionId)
        })
    ],
    [
      'kanban.ticket.addTokens',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id, tokens } = yield* Effect.try({
            try: () => addTicketTokensParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.addTicketTokens) {
            return yield* Effect.die(
              new Error('kanban.ticket.addTokens service is not implemented')
            )
          }
          return yield* service.addTicketTokens(projectId, id, tokens)
        })
    ],
    [
      'kanban.ticket.syncPR',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId, prNumber, prUrl } = yield* Effect.try({
            try: () => syncPrToTicketsParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.syncPrToTickets) {
            return yield* Effect.die(new Error('kanban.ticket.syncPR service is not implemented'))
          }
          return yield* service.syncPrToTickets(worktreeId, prNumber, prUrl)
        })
    ],
    [
      'kanban.ticket.clearPR',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId } = yield* Effect.try({
            try: () => worktreeIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.clearPrFromTickets) {
            return yield* Effect.die(new Error('kanban.ticket.clearPR service is not implemented'))
          }
          return yield* service.clearPrFromTickets(worktreeId)
        })
    ],
    [
      'kanban.ticket.attachPR',
      (params) =>
        Effect.gen(function* () {
          const { ticketId, projectId, prNumber, prUrl } = yield* Effect.try({
            try: () => attachPrToTicketParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.attachPrToTicket) {
            return yield* Effect.die(new Error('kanban.ticket.attachPR service is not implemented'))
          }
          return yield* service.attachPrToTicket(ticketId, projectId, prNumber, prUrl)
        })
    ],
    [
      'kanban.ticket.detachPR',
      (params) =>
        Effect.gen(function* () {
          const { ticketId, projectId } = yield* Effect.try({
            try: () => ticketProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.detachPrFromTicket) {
            return yield* Effect.die(new Error('kanban.ticket.detachPR service is not implemented'))
          }
          return yield* service.detachPrFromTicket(ticketId, projectId)
        })
    ],
    [
      'kanban.ticket.detachWorktree',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId } = yield* Effect.try({
            try: () => worktreeIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.detachWorktreeFromTickets) {
            return yield* Effect.die(
              new Error('kanban.ticket.detachWorktree service is not implemented')
            )
          }
          return yield* service.detachWorktreeFromTickets(worktreeId)
        })
    ],
    [
      'kanban.simpleMode.toggle',
      (params) =>
        Effect.gen(function* () {
          const { projectId, enabled } = yield* Effect.try({
            try: () => simpleModeToggleParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.updateProjectSimpleMode) {
            return yield* Effect.die(
              new Error('kanban.simpleMode.toggle service is not implemented')
            )
          }
          return yield* service.updateProjectSimpleMode(projectId, enabled)
        })
    ],
    [
      'kanban.dependency.add',
      (params) =>
        Effect.gen(function* () {
          const { projectId, dependentId, blockerId } = yield* Effect.try({
            try: () => ticketDependencyPairParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.addTicketDependency) {
            return yield* Effect.die(new Error('kanban.dependency.add service is not implemented'))
          }
          return yield* service.addTicketDependency(projectId, dependentId, blockerId)
        })
    ],
    [
      'kanban.dependency.remove',
      (params) =>
        Effect.gen(function* () {
          const { projectId, dependentId, blockerId } = yield* Effect.try({
            try: () => ticketDependencyPairParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.removeTicketDependency) {
            return yield* Effect.die(
              new Error('kanban.dependency.remove service is not implemented')
            )
          }
          return yield* service.removeTicketDependency(projectId, dependentId, blockerId)
        })
    ],
    [
      'kanban.dependency.getBlockers',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id } = yield* Effect.try({
            try: () => ticketDependencyLookupParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.getBlockersForTicket) {
            return yield* Effect.die(
              new Error('kanban.dependency.getBlockers service is not implemented')
            )
          }
          return yield* service.getBlockersForTicket(projectId, id)
        })
    ],
    [
      'kanban.dependency.getDependents',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id } = yield* Effect.try({
            try: () => ticketDependencyLookupParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.getDependentsOfTicket) {
            return yield* Effect.die(
              new Error('kanban.dependency.getDependents service is not implemented')
            )
          }
          return yield* service.getDependentsOfTicket(projectId, id)
        })
    ],
    [
      'kanban.dependency.getForProject',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => projectIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.getDependenciesForProject) {
            return yield* Effect.die(
              new Error('kanban.dependency.getForProject service is not implemented')
            )
          }
          return yield* service.getDependenciesForProject(projectId)
        })
    ],
    [
      'kanban.dependency.removeAll',
      (params) =>
        Effect.gen(function* () {
          const { projectId, id } = yield* Effect.try({
            try: () => ticketDependencyLookupParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.removeAllDependenciesForTicket) {
            return yield* Effect.die(
              new Error('kanban.dependency.removeAll service is not implemented')
            )
          }
          return yield* service.removeAllDependenciesForTicket(projectId, id)
        })
    ],
    [
      'kanban.config.get',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => projectIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.getConfig) {
            return yield* Effect.die(new Error('kanban.config.get service is not implemented'))
          }
          return yield* service.getConfig(projectId)
        })
    ],
    [
      'kanban.config.update',
      (params) =>
        Effect.gen(function* () {
          const { projectId, config } = yield* Effect.try({
            try: () => updateKanbanConfigParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.updateConfig) {
            return yield* Effect.die(new Error('kanban.config.update service is not implemented'))
          }
          return yield* service.updateConfig(projectId, config)
        })
    ],
    [
      'kanban.config.setMode',
      (params) =>
        Effect.gen(function* () {
          const { projectId, mode } = yield* Effect.try({
            try: () => setKanbanModeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.setMode) {
            return yield* Effect.die(new Error('kanban.config.setMode service is not implemented'))
          }
          return yield* service.setMode(projectId, mode)
        })
    ],
    [
      'kanban.config.createFolders',
      (params) =>
        Effect.gen(function* () {
          const { projectId, config } = yield* Effect.try({
            try: () => createKanbanFoldersParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.createFolders) {
            return yield* Effect.die(
              new Error('kanban.config.createFolders service is not implemented')
            )
          }
          return yield* service.createFolders(projectId, config)
        })
    ],
    [
      'kanban.config.pickMarkdownFolder',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.pickMarkdownFolder) {
            return yield* Effect.die(
              new Error('kanban.config.pickMarkdownFolder service is not implemented')
            )
          }
          return yield* service.pickMarkdownFolder()
        })
    ],
    [
      'kanban.diagnostics.get',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => projectIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.getDiagnostics) {
            return yield* Effect.die(
              new Error('kanban.diagnostics.get service is not implemented')
            )
          }
          return yield* service.getDiagnostics(projectId)
        })
    ],
    [
      'kanban.markdown.convertFileToCard',
      (params) =>
        Effect.gen(function* () {
          const { projectId, filePath } = yield* Effect.try({
            try: () => markdownFileParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.convertMarkdownFileToCard) {
            return yield* Effect.die(
              new Error('kanban.markdown.convertFileToCard service is not implemented')
            )
          }
          return yield* service.convertMarkdownFileToCard(projectId, filePath)
        })
    ],
    [
      'kanban.watch.start',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => projectIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.startWatch) {
            return yield* Effect.die(new Error('kanban.watch.start service is not implemented'))
          }
          return yield* service.startWatch(projectId)
        })
    ],
    [
      'kanban.watch.stop',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => projectIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.stopWatch) {
            return yield* Effect.die(new Error('kanban.watch.stop service is not implemented'))
          }
          return yield* service.stopWatch(projectId)
        })
    ],
    [
      'kanban.board.export',
      (params) =>
        Effect.gen(function* () {
          const { projectId, projectName } = yield* Effect.try({
            try: () => exportBoardParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.exportBoard) {
            return yield* Effect.die(new Error('kanban.board.export service is not implemented'))
          }
          return yield* service.exportBoard(projectId, projectName)
        })
    ],
    [
      'kanban.board.openImportFile',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.openBoardImportFile) {
            return yield* Effect.die(
              new Error('kanban.board.openImportFile service is not implemented')
            )
          }
          return yield* service.openBoardImportFile()
        })
    ],
    [
      'kanban.board.importTickets',
      (params) =>
        Effect.gen(function* () {
          const { projectId, tickets, dependencies } = yield* Effect.try({
            try: () => importBoardTicketsParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.importBoardTickets) {
            return yield* Effect.die(
              new Error('kanban.board.importTickets service is not implemented')
            )
          }
          return yield* service.importBoardTickets(projectId, tickets, dependencies)
        })
    ]
  ])
