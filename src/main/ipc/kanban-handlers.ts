import { dialog } from 'electron'
import { writeFile, readFile } from 'node:fs/promises'
import { Data, Effect } from 'effect'
import { z } from 'zod'

import { getDatabase } from '../db'
import { createLogger } from '../services/logger'
import type {
  KanbanTicketBatchCreate,
  KanbanTicketCreate,
  KanbanTicketUpdate,
  KanbanTicketColumn
} from '../db'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'KanbanHandlers' })

class KanbanHandlerFailed extends Data.TaggedError('KanbanHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const kanbanFailed = (operation: string, cause: unknown): KanbanHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new KanbanHandlerFailed({ operation, reason, message: reason })
}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))

const tryKanban = <A>(operation: string, fn: () => A): Effect.Effect<A, KanbanHandlerFailed> =>
  Effect.try({
    try: fn,
    catch: (error) => {
      log.error(`${operation} failed`, toError(error))
      return kanbanFailed(operation, error)
    }
  })

const tryKanbanPromise = <A>(
  operation: string,
  fn: () => Promise<A>
): Effect.Effect<A, KanbanHandlerFailed> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) => {
      log.error(`${operation} failed`, toError(error))
      return kanbanFailed(operation, error)
    }
  })

const stringArgSchema = z.string()
const stringPairSchema = z.tuple([z.string(), z.string()])
const stringNumberPairSchema = z.tuple([z.string(), z.number()])
const ticketColumnSchema = z.enum(['todo', 'in_progress', 'review', 'done'])
const typedSchema = <A>(): z.ZodType<A> => z.custom<A>()

const importTicketSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  attachments: z.array(z.unknown()).optional(),
  column: z.string().optional()
})

const importDependencySchema = z.object({
  dependentId: z.string(),
  blockerId: z.string()
})

type ImportTicket = z.infer<typeof importTicketSchema>
type ImportDependency = z.infer<typeof importDependencySchema>

export function registerKanbanHandlers(): void {
  log.info('Registering kanban handlers')

  defineHandler('kanban:ticket:create', typedSchema<KanbanTicketCreate>(), (data) =>
    tryKanban('kanban:ticket:create', () => getDatabase().createKanbanTicket(data))
  )

  defineHandler('kanban:ticket:createBatch', typedSchema<KanbanTicketBatchCreate>(), (data) =>
    tryKanban('kanban:ticket:createBatch', () => getDatabase().createKanbanTicketBatch(data))
  )

  defineHandler('kanban:ticket:get', stringArgSchema, (id) =>
    tryKanban('kanban:ticket:get', () => getDatabase().getKanbanTicket(id))
  )

  defineHandler(
    'kanban:ticket:getByProject',
    z.tuple([z.string(), z.boolean().optional()]),
    ([projectId, includeArchived]) =>
      tryKanban('kanban:ticket:getByProject', () =>
        getDatabase().getKanbanTicketsByProject(projectId, includeArchived ?? false)
      )
  )

  defineHandler(
    'kanban:ticket:update',
    z.tuple([z.string(), typedSchema<KanbanTicketUpdate>()]),
    ([id, data]) =>
      tryKanban('kanban:ticket:update', () => getDatabase().updateKanbanTicket(id, data))
  )

  defineHandler('kanban:ticket:delete', stringArgSchema, (id) =>
    tryKanban('kanban:ticket:delete', () => getDatabase().deleteKanbanTicket(id))
  )

  defineHandler('kanban:ticket:archive', stringArgSchema, (id) =>
    tryKanban('kanban:ticket:archive', () => getDatabase().archiveKanbanTicket(id))
  )

  defineHandler('kanban:ticket:archiveAllDone', stringArgSchema, (projectId) =>
    tryKanban('kanban:ticket:archiveAllDone', () =>
      getDatabase().archiveAllDoneKanbanTickets(projectId)
    )
  )

  defineHandler('kanban:ticket:unarchive', stringArgSchema, (id) =>
    tryKanban('kanban:ticket:unarchive', () => getDatabase().unarchiveKanbanTicket(id))
  )

  defineHandler(
    'kanban:ticket:move',
    z.tuple([z.string(), ticketColumnSchema, z.number()]),
    ([id, column, sortOrder]) =>
      tryKanban('kanban:ticket:move', () => getDatabase().moveKanbanTicket(id, column, sortOrder))
  )

  defineHandler('kanban:ticket:reorder', stringNumberPairSchema, ([id, sortOrder]) =>
    tryKanban('kanban:ticket:reorder', () => getDatabase().reorderKanbanTicket(id, sortOrder))
  )

  defineHandler('kanban:ticket:getBySession', stringArgSchema, (sessionId) =>
    tryKanban('kanban:ticket:getBySession', () =>
      getDatabase().getKanbanTicketsBySession(sessionId)
    )
  )

  defineHandler('kanban:ticket:addTokens', stringNumberPairSchema, ([id, tokens]) =>
    tryKanban('kanban:ticket:addTokens', () => {
      const db = getDatabase()
      db.addTicketTokens(id, tokens)
      return db.getKanbanTicket(id)
    })
  )

  defineHandler(
    'kanban:ticket:syncPR',
    z.tuple([z.string(), z.number(), z.string()]),
    ([worktreeId, prNumber, prUrl]) =>
      tryKanban('kanban:ticket:syncPR', () =>
        getDatabase().syncPRToTickets(worktreeId, prNumber, prUrl)
      )
  )

  defineHandler('kanban:ticket:clearPR', stringArgSchema, (worktreeId) =>
    tryKanban('kanban:ticket:clearPR', () => getDatabase().clearPRFromTickets(worktreeId))
  )

  defineHandler(
    'kanban:ticket:attachPR',
    z.tuple([z.string(), z.string(), z.number(), z.string()]),
    ([ticketId, projectId, prNumber, prUrl]) =>
      tryKanban('kanban:ticket:attachPR', () =>
        getDatabase().attachPRToTicket(ticketId, projectId, prNumber, prUrl)
      )
  )

  defineHandler('kanban:ticket:detachPR', stringPairSchema, ([ticketId, projectId]) =>
    tryKanban('kanban:ticket:detachPR', () => getDatabase().detachPRFromTicket(ticketId, projectId))
  )

  defineHandler('kanban:ticket:detachWorktree', stringArgSchema, (worktreeId) =>
    tryKanban('kanban:ticket:detachWorktree', () =>
      getDatabase().detachWorktreeFromTickets(worktreeId)
    )
  )

  defineHandler(
    'kanban:simpleMode:toggle',
    z.tuple([z.string(), z.boolean()]),
    ([projectId, enabled]) =>
      tryKanban('kanban:simpleMode:toggle', () =>
        getDatabase().updateProjectSimpleMode(projectId, enabled)
      )
  )

  // Dependency handlers
  defineHandler('kanban:dependency:add', stringPairSchema, ([dependentId, blockerId]) =>
    tryKanban('kanban:dependency:add', () =>
      getDatabase().addTicketDependency(dependentId, blockerId)
    )
  )

  defineHandler('kanban:dependency:remove', stringPairSchema, ([dependentId, blockerId]) =>
    tryKanban('kanban:dependency:remove', () =>
      getDatabase().removeTicketDependency(dependentId, blockerId)
    )
  )

  defineHandler('kanban:dependency:getBlockers', stringArgSchema, (ticketId) =>
    tryKanban('kanban:dependency:getBlockers', () => getDatabase().getBlockersForTicket(ticketId))
  )

  defineHandler('kanban:dependency:getDependents', stringArgSchema, (ticketId) =>
    tryKanban('kanban:dependency:getDependents', () =>
      getDatabase().getDependentsOfTicket(ticketId)
    )
  )

  defineHandler('kanban:dependency:getForProject', stringArgSchema, (projectId) =>
    tryKanban('kanban:dependency:getForProject', () =>
      getDatabase().getDependenciesForProject(projectId)
    )
  )

  defineHandler('kanban:dependency:removeAll', stringArgSchema, (ticketId) =>
    tryKanban('kanban:dependency:removeAll', () =>
      getDatabase().removeAllDependenciesForTicket(ticketId)
    )
  )

  defineHandler(
    'kanban:board:export',
    z.tuple([z.string(), z.string()]),
    ([projectId, projectName]) =>
      Effect.gen(function* () {
        const { exportData, ticketCount } = yield* tryKanban('kanban:board:export:read', () => {
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
        })

        const { canceled, filePath } = yield* tryKanbanPromise('kanban:board:export:dialog', () =>
          dialog.showSaveDialog({
            defaultPath: `board-${projectName}.hive.json`,
            filters: [{ name: 'Hive Board', extensions: ['hive.json'] }]
          })
        )

        if (canceled || !filePath) {
          return { success: false, ticketCount: 0 }
        }

        yield* tryKanbanPromise('kanban:board:export:write', () =>
          writeFile(filePath, JSON.stringify(exportData, null, 2), 'utf-8')
        )

        return { success: true, ticketCount, path: filePath }
      })
  )

  defineHandler('kanban:board:openImportFile', z.tuple([]), () =>
    Effect.gen(function* () {
      const { canceled, filePaths } = yield* tryKanbanPromise(
        'kanban:board:openImportFile:dialog',
        () =>
          dialog.showOpenDialog({
            filters: [{ name: 'Hive Board', extensions: ['json'] }],
            properties: ['openFile']
          })
      )

      if (canceled || filePaths.length === 0) {
        return null
      }

      const raw = yield* tryKanbanPromise('kanban:board:openImportFile:read', () =>
        readFile(filePaths[0], 'utf-8')
      )

      return yield* tryKanban('kanban:board:openImportFile:parse', () => {
        const parsed = JSON.parse(raw)

        if (
          !parsed ||
          !Array.isArray(parsed.tickets) ||
          !parsed.tickets.every(
            (ticket: unknown) =>
              typeof ticket === 'object' && ticket !== null && 'id' in ticket && 'title' in ticket
          )
        ) {
          throw new Error('Invalid Hive board file: missing tickets array or tickets lack id/title')
        }

        return {
          tickets: parsed.tickets as ImportTicket[],
          dependencies: Array.isArray(parsed.dependencies)
            ? parsed.dependencies.filter(
                (dependency: unknown): dependency is ImportDependency =>
                  typeof dependency === 'object' &&
                  dependency !== null &&
                  typeof (dependency as { dependentId?: unknown }).dependentId === 'string' &&
                  typeof (dependency as { blockerId?: unknown }).blockerId === 'string'
              )
            : [],
          projectName: parsed.projectName ?? null
        }
      })
    })
  )

  defineHandler(
    'kanban:board:importTickets',
    z.tuple([z.string(), z.array(importTicketSchema), z.array(importDependencySchema).optional()]),
    ([projectId, tickets, dependencies]) =>
      tryKanban('kanban:board:importTickets', () => {
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
              column: (ticket.column as KanbanTicketColumn) ?? 'todo'
            })
            updated++
          } else if (existing) {
            db.createKanbanTicket({
              project_id: projectId,
              title: ticket.title,
              description: ticket.description ?? null,
              attachments: ticket.attachments ?? [],
              column: (ticket.column as KanbanTicketColumn) ?? 'todo'
            })
            created++
          } else {
            db.createKanbanTicket({
              id: ticket.id,
              project_id: projectId,
              title: ticket.title,
              description: ticket.description ?? null,
              attachments: ticket.attachments ?? [],
              column: (ticket.column as KanbanTicketColumn) ?? 'todo'
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
      })
  )
}
