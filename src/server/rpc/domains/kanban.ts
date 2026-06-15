import { Effect } from 'effect'
import { z } from 'zod'
import { isDesktopCommandResult, makeDesktopCommandRequest } from '../../../shared/desktop-command'
import type {
  KanbanTicket,
  KanbanTicketBatchCreate,
  KanbanTicketBatchCreateResult,
  KanbanTicketCreate,
  KanbanTicketUpdate,
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
  readonly createTicket: (data: KanbanTicketCreate) => Effect.Effect<KanbanTicket, unknown, never>
  readonly createTicketBatch: (
    data: KanbanTicketBatchCreate
  ) => Effect.Effect<KanbanTicketBatchCreateResult, unknown, never>
  readonly getTicket: (id: string) => Effect.Effect<KanbanTicket | null, unknown, never>
  readonly getTicketsByProject: (
    projectId: string,
    includeArchived?: boolean
  ) => Effect.Effect<KanbanTicket[], unknown, never>
  readonly updateTicket: (
    id: string,
    data: KanbanTicketUpdate
  ) => Effect.Effect<KanbanTicket | null, unknown, never>
  readonly deleteTicket: (id: string) => Effect.Effect<boolean, unknown, never>
  readonly archiveTicket: (id: string) => Effect.Effect<KanbanTicket | null, unknown, never>
  readonly archiveAllDoneTickets: (projectId: string) => Effect.Effect<number, unknown, never>
  readonly unarchiveTicket: (id: string) => Effect.Effect<KanbanTicket | null, unknown, never>
  readonly moveTicket: (
    id: string,
    column: KanbanTicket['column'],
    sortOrder: number
  ) => Effect.Effect<KanbanTicket | null, unknown, never>
  readonly moveTicketToProject?: (
    id: string,
    targetProjectId: string
  ) => Effect.Effect<KanbanTicket | null, unknown, never>
  readonly reorderTicket?: (id: string, sortOrder: number) => Effect.Effect<void, unknown, never>
  readonly getTicketsBySession?: (
    sessionId: string
  ) => Effect.Effect<KanbanTicket[], unknown, never>
  readonly addTicketTokens?: (
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
    dependentId: string,
    blockerId: string
  ) => Effect.Effect<{ success: boolean; error?: string }, unknown, never>
  readonly removeTicketDependency?: (
    dependentId: string,
    blockerId: string
  ) => Effect.Effect<boolean, unknown, never>
  readonly getBlockersForTicket?: (
    ticketId: string
  ) => Effect.Effect<KanbanTicket[], unknown, never>
  readonly getDependentsOfTicket?: (
    ticketId: string
  ) => Effect.Effect<KanbanTicket[], unknown, never>
  readonly getDependenciesForProject?: (
    projectId: string
  ) => Effect.Effect<TicketDependency[], unknown, never>
  readonly removeAllDependenciesForTicket?: (
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
    mark: ticketMarkSchema.nullable().optional()
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
    note: z.string().nullable().optional()
  })
  .strict() satisfies z.ZodType<KanbanTicketUpdate>
const stringArgParamsSchema = z.object({ id: z.string() }).strict()
const getTicketsByProjectParamsSchema = z
  .object({
    projectId: z.string(),
    includeArchived: z.boolean().optional()
  })
  .strict()
const projectIdParamsSchema = z.object({ projectId: z.string() }).strict()
const updateTicketParamsSchema = z
  .object({
    id: z.string(),
    data: kanbanTicketUpdateSchema
  })
  .strict()
const moveTicketParamsSchema = z
  .object({
    id: z.string(),
    column: ticketColumnSchema,
    sortOrder: z.number()
  })
  .strict()
const moveTicketToProjectParamsSchema = z
  .object({
    id: z.string(),
    targetProjectId: z.string()
  })
  .strict()
const reorderTicketParamsSchema = z
  .object({
    id: z.string(),
    sortOrder: z.number()
  })
  .strict()
const sessionIdParamsSchema = z.object({ sessionId: z.string() }).strict()
const addTicketTokensParamsSchema = z
  .object({
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
    dependentId: z.string(),
    blockerId: z.string()
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
  createTicket: (data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().createKanbanTicket(data)
      },
      catch: (cause) => cause
    }),
  createTicketBatch: (data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().createKanbanTicketBatch(data)
      },
      catch: (cause) => cause
    }),
  getTicket: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getKanbanTicket(id)
      },
      catch: (cause) => cause
    }),
  getTicketsByProject: (projectId, includeArchived) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getKanbanTicketsByProject(projectId, includeArchived ?? false)
      },
      catch: (cause) => cause
    }),
  updateTicket: (id, data) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().updateKanbanTicket(id, data)
      },
      catch: (cause) => cause
    }),
  deleteTicket: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().deleteKanbanTicket(id)
      },
      catch: (cause) => cause
    }),
  archiveTicket: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().archiveKanbanTicket(id)
      },
      catch: (cause) => cause
    }),
  archiveAllDoneTickets: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().archiveAllDoneKanbanTickets(projectId)
      },
      catch: (cause) => cause
    }),
  unarchiveTicket: (id) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().unarchiveKanbanTicket(id)
      },
      catch: (cause) => cause
    }),
  moveTicket: (id, column, sortOrder) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().moveKanbanTicket(id, column, sortOrder)
      },
      catch: (cause) => cause
    }),
  moveTicketToProject: (id, targetProjectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().moveKanbanTicketToProject(id, targetProjectId)
      },
      catch: (cause) => cause
    }),
  reorderTicket: (id, sortOrder) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().reorderKanbanTicket(id, sortOrder)
      },
      catch: (cause) => cause
    }),
  getTicketsBySession: (sessionId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getKanbanTicketsBySession(sessionId)
      },
      catch: (cause) => cause
    }),
  addTicketTokens: (id, tokens) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        const db = getDatabase()
        db.addTicketTokens(id, tokens)
        return db.getKanbanTicket(id)
      },
      catch: (cause) => cause
    }),
  syncPrToTickets: (worktreeId, prNumber, prUrl) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().syncPRToTickets(worktreeId, prNumber, prUrl)
      },
      catch: (cause) => cause
    }),
  clearPrFromTickets: (worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().clearPRFromTickets(worktreeId)
      },
      catch: (cause) => cause
    }),
  attachPrToTicket: (ticketId, projectId, prNumber, prUrl) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().attachPRToTicket(ticketId, projectId, prNumber, prUrl)
      },
      catch: (cause) => cause
    }),
  detachPrFromTicket: (ticketId, projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().detachPRFromTicket(ticketId, projectId)
      },
      catch: (cause) => cause
    }),
  detachWorktreeFromTickets: (worktreeId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().detachWorktreeFromTickets(worktreeId)
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
  addTicketDependency: (dependentId, blockerId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().addTicketDependency(dependentId, blockerId)
      },
      catch: (cause) => cause
    }),
  removeTicketDependency: (dependentId, blockerId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().removeTicketDependency(dependentId, blockerId)
      },
      catch: (cause) => cause
    }),
  getBlockersForTicket: (ticketId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getBlockersForTicket(ticketId)
      },
      catch: (cause) => cause
    }),
  getDependentsOfTicket: (ticketId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getDependentsOfTicket(ticketId)
      },
      catch: (cause) => cause
    }),
  getDependenciesForProject: (projectId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().getDependenciesForProject(projectId)
      },
      catch: (cause) => cause
    }),
  removeAllDependenciesForTicket: (ticketId) =>
    Effect.tryPromise({
      try: async () => {
        const { getDatabase } = await import('../../../main/db')
        return getDatabase().removeAllDependenciesForTicket(ticketId)
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
          const { getDatabase } = await import('../../../main/db')
          const db = getDatabase()
          const tickets = db.getKanbanTicketsByProject(projectId, false)
          const dependencies = db.getDependenciesForProject(projectId)

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
        const { getDatabase } = await import('../../../main/db')
        const db = getDatabase()
        let created = 0
        let updated = 0
        let dependencyCount = 0
        let ignoredDependencyCount = 0
        const selectedIds = new Set(tickets.map((ticket) => ticket.id))

        for (const ticket of tickets) {
          const existing = db.getKanbanTicket(ticket.id)

          if (existing && existing.project_id === projectId) {
            db.updateKanbanTicket(ticket.id, {
              title: ticket.title,
              description: ticket.description ?? null,
              attachments: ticket.attachments ?? [],
              column: (ticket.column as KanbanTicket['column']) ?? 'todo'
            })
            updated++
          } else if (existing) {
            db.createKanbanTicket({
              project_id: projectId,
              title: ticket.title,
              description: ticket.description ?? null,
              attachments: ticket.attachments ?? [],
              column: (ticket.column as KanbanTicket['column']) ?? 'todo'
            })
            created++
          } else {
            db.createKanbanTicket({
              id: ticket.id,
              project_id: projectId,
              title: ticket.title,
              description: ticket.description ?? null,
              attachments: ticket.attachments ?? [],
              column: (ticket.column as KanbanTicket['column']) ?? 'todo'
            })
            created++
          }
        }

        for (const ticketId of selectedIds) {
          const blockers = db.getBlockersForTicket(ticketId)
          for (const blocker of blockers) {
            if (selectedIds.has(blocker.id)) {
              db.removeTicketDependency(ticketId, blocker.id)
            }
          }
        }

        for (const dependency of dependencies ?? []) {
          const dependentId = dependency.dependentId.trim()
          const blockerId = dependency.blockerId.trim()
          if (
            !dependentId ||
            !blockerId ||
            !selectedIds.has(dependentId) ||
            !selectedIds.has(blockerId)
          ) {
            ignoredDependencyCount++
            continue
          }

          const result = db.addTicketDependency(dependentId, blockerId)
          if (result.success) {
            dependencyCount++
          } else {
            ignoredDependencyCount++
          }
        }

        return { created, updated, dependencyCount, ignoredDependencyCount }
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
      clearTimeout(timeout)
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
    const timeout = setTimeout(() => {
      finish(null, new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

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
      clearTimeout(timeout)
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
    const timeout = setTimeout(() => {
      finish(null, new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

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
          return yield* service.createTicket(data)
        })
    ],
    [
      'kanban.ticket.createBatch',
      (params) =>
        Effect.gen(function* () {
          const data = yield* Effect.try({
            try: () => kanbanTicketBatchCreateSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createTicketBatch(data)
        })
    ],
    [
      'kanban.ticket.get',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => stringArgParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getTicket(id)
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
          const { id, data } = yield* Effect.try({
            try: () => updateTicketParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.updateTicket(id, data)
        })
    ],
    [
      'kanban.ticket.delete',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => stringArgParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.deleteTicket(id)
        })
    ],
    [
      'kanban.ticket.archive',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => stringArgParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.archiveTicket(id)
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
          const { id } = yield* Effect.try({
            try: () => stringArgParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.unarchiveTicket(id)
        })
    ],
    [
      'kanban.ticket.move',
      (params) =>
        Effect.gen(function* () {
          const { id, column, sortOrder } = yield* Effect.try({
            try: () => moveTicketParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.moveTicket(id, column, sortOrder)
        })
    ],
    [
      'kanban.ticket.moveToProject',
      (params) =>
        Effect.gen(function* () {
          const { id, targetProjectId } = yield* Effect.try({
            try: () => moveTicketToProjectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.moveTicketToProject) {
            return yield* Effect.die(
              new Error('kanban.ticket.moveToProject service is not implemented')
            )
          }
          return yield* service.moveTicketToProject(id, targetProjectId)
        })
    ],
    [
      'kanban.ticket.reorder',
      (params) =>
        Effect.gen(function* () {
          const { id, sortOrder } = yield* Effect.try({
            try: () => reorderTicketParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.reorderTicket) {
            return yield* Effect.die(new Error('kanban.ticket.reorder service is not implemented'))
          }
          return yield* service.reorderTicket(id, sortOrder)
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
          const { id, tokens } = yield* Effect.try({
            try: () => addTicketTokensParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.addTicketTokens) {
            return yield* Effect.die(
              new Error('kanban.ticket.addTokens service is not implemented')
            )
          }
          return yield* service.addTicketTokens(id, tokens)
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
          const { dependentId, blockerId } = yield* Effect.try({
            try: () => ticketDependencyPairParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.addTicketDependency) {
            return yield* Effect.die(new Error('kanban.dependency.add service is not implemented'))
          }
          return yield* service.addTicketDependency(dependentId, blockerId)
        })
    ],
    [
      'kanban.dependency.remove',
      (params) =>
        Effect.gen(function* () {
          const { dependentId, blockerId } = yield* Effect.try({
            try: () => ticketDependencyPairParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.removeTicketDependency) {
            return yield* Effect.die(
              new Error('kanban.dependency.remove service is not implemented')
            )
          }
          return yield* service.removeTicketDependency(dependentId, blockerId)
        })
    ],
    [
      'kanban.dependency.getBlockers',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => stringArgParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.getBlockersForTicket) {
            return yield* Effect.die(
              new Error('kanban.dependency.getBlockers service is not implemented')
            )
          }
          return yield* service.getBlockersForTicket(id)
        })
    ],
    [
      'kanban.dependency.getDependents',
      (params) =>
        Effect.gen(function* () {
          const { id } = yield* Effect.try({
            try: () => stringArgParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.getDependentsOfTicket) {
            return yield* Effect.die(
              new Error('kanban.dependency.getDependents service is not implemented')
            )
          }
          return yield* service.getDependentsOfTicket(id)
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
          const { id } = yield* Effect.try({
            try: () => stringArgParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.removeAllDependenciesForTicket) {
            return yield* Effect.die(
              new Error('kanban.dependency.removeAll service is not implemented')
            )
          }
          return yield* service.removeAllDependenciesForTicket(id)
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
