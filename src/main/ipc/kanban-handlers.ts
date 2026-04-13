import { ipcMain, dialog } from 'electron'
import { writeFile, readFile } from 'node:fs/promises'
import { getDatabase } from '../db'
import { createLogger } from '../services/logger'
import type {
  KanbanTicketBatchCreate,
  KanbanTicketCreate,
  KanbanTicketUpdate,
  KanbanTicketColumn
} from '../db'

const log = createLogger({ component: 'KanbanHandlers' })

export function registerKanbanHandlers(): void {
  log.info('Registering kanban handlers')

  ipcMain.handle('kanban:ticket:create', (_event, data: KanbanTicketCreate) => {
    return getDatabase().createKanbanTicket(data)
  })

  ipcMain.handle('kanban:ticket:createBatch', (_event, data: KanbanTicketBatchCreate) => {
    return getDatabase().createKanbanTicketBatch(data)
  })

  ipcMain.handle('kanban:ticket:get', (_event, id: string) => {
    return getDatabase().getKanbanTicket(id)
  })

  ipcMain.handle('kanban:ticket:getByProject', (_event, projectId: string, includeArchived?: boolean) => {
    return getDatabase().getKanbanTicketsByProject(projectId, includeArchived ?? false)
  })

  ipcMain.handle('kanban:ticket:update', (_event, id: string, data: KanbanTicketUpdate) => {
    return getDatabase().updateKanbanTicket(id, data)
  })

  ipcMain.handle('kanban:ticket:delete', (_event, id: string) => {
    return getDatabase().deleteKanbanTicket(id)
  })

  ipcMain.handle('kanban:ticket:archive', (_event, id: string) => {
    return getDatabase().archiveKanbanTicket(id)
  })

  ipcMain.handle('kanban:ticket:archiveAllDone', (_event, projectId: string) => {
    return getDatabase().archiveAllDoneKanbanTickets(projectId)
  })

  ipcMain.handle('kanban:ticket:unarchive', (_event, id: string) => {
    return getDatabase().unarchiveKanbanTicket(id)
  })

  ipcMain.handle(
    'kanban:ticket:move',
    (_event, id: string, column: KanbanTicketColumn, sortOrder: number) => {
      return getDatabase().moveKanbanTicket(id, column, sortOrder)
    }
  )

  ipcMain.handle('kanban:ticket:reorder', (_event, id: string, sortOrder: number) => {
    return getDatabase().reorderKanbanTicket(id, sortOrder)
  })

  ipcMain.handle('kanban:ticket:getBySession', (_event, sessionId: string) => {
    return getDatabase().getKanbanTicketsBySession(sessionId)
  })

  ipcMain.handle('kanban:ticket:addTokens', (_event, id: string, tokens: number) => {
    getDatabase().addTicketTokens(id, tokens)
    return getDatabase().getKanbanTicket(id)
  })

  ipcMain.handle('kanban:ticket:syncPR', (_event, worktreeId: string, prNumber: number, prUrl: string) => {
    return getDatabase().syncPRToTickets(worktreeId, prNumber, prUrl)
  })

  ipcMain.handle('kanban:ticket:clearPR', (_event, worktreeId: string) => {
    return getDatabase().clearPRFromTickets(worktreeId)
  })

  ipcMain.handle('kanban:ticket:attachPR', (_event, ticketId: string, projectId: string, prNumber: number, prUrl: string) => {
    return getDatabase().attachPRToTicket(ticketId, projectId, prNumber, prUrl)
  })

  ipcMain.handle('kanban:ticket:detachPR', (_event, ticketId: string, projectId: string) => {
    return getDatabase().detachPRFromTicket(ticketId, projectId)
  })

  ipcMain.handle('kanban:ticket:detachWorktree', (_event, worktreeId: string) => {
    return getDatabase().detachWorktreeFromTickets(worktreeId)
  })

  ipcMain.handle('kanban:simpleMode:toggle', (_event, projectId: string, enabled: boolean) => {
    return getDatabase().updateProjectSimpleMode(projectId, enabled)
  })

  // Dependency handlers
  ipcMain.handle('kanban:dependency:add', (_event, dependentId: string, blockerId: string) => {
    return getDatabase().addTicketDependency(dependentId, blockerId)
  })

  ipcMain.handle('kanban:dependency:remove', (_event, dependentId: string, blockerId: string) => {
    return getDatabase().removeTicketDependency(dependentId, blockerId)
  })

  ipcMain.handle('kanban:dependency:getBlockers', (_event, ticketId: string) => {
    return getDatabase().getBlockersForTicket(ticketId)
  })

  ipcMain.handle('kanban:dependency:getDependents', (_event, ticketId: string) => {
    return getDatabase().getDependentsOfTicket(ticketId)
  })

  ipcMain.handle('kanban:dependency:getForProject', (_event, projectId: string) => {
    return getDatabase().getDependenciesForProject(projectId)
  })

  ipcMain.handle('kanban:dependency:removeAll', (_event, ticketId: string) => {
    return getDatabase().removeAllDependenciesForTicket(ticketId)
  })

  ipcMain.handle(
    'kanban:board:export',
    async (_event, projectId: string, projectName: string) => {
      try {
        const db = getDatabase()
        const tickets = db.getKanbanTicketsByProject(projectId, false)
        const dependencies = db.getDependenciesForProject(projectId)

        const exportData = {
          projectName,
          exportedAt: new Date().toISOString(),
          tickets: tickets.map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            attachments: t.attachments,
            column: t.column
          })),
          dependencies: dependencies.map((dependency) => ({
            dependentId: dependency.dependent_id,
            blockerId: dependency.blocker_id
          }))
        }

        const { canceled, filePath } = await dialog.showSaveDialog({
          defaultPath: `board-${projectName}.hive.json`,
          filters: [{ name: 'Hive Board', extensions: ['hive.json'] }]
        })

        if (canceled || !filePath) {
          return { success: false, ticketCount: 0 }
        }

        await writeFile(filePath, JSON.stringify(exportData, null, 2), 'utf-8')
        return { success: true, ticketCount: tickets.length, path: filePath }
      } catch (error) {
        log.error('Failed to export board', error)
        return { success: false, ticketCount: 0 }
      }
    }
  )

  ipcMain.handle('kanban:board:openImportFile', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        filters: [{ name: 'Hive Board', extensions: ['json'] }],
        properties: ['openFile']
      })

      if (canceled || filePaths.length === 0) {
        return null
      }

      const raw = await readFile(filePaths[0], 'utf-8')
      const parsed = JSON.parse(raw)

      if (
        !parsed ||
        !Array.isArray(parsed.tickets) ||
        !parsed.tickets.every(
          (t: unknown) =>
            typeof t === 'object' &&
            t !== null &&
            'id' in t &&
            'title' in t
        )
      ) {
        throw new Error('Invalid Hive board file: missing tickets array or tickets lack id/title')
      }

      return {
        tickets: parsed.tickets as Array<{
          id: string
          title: string
          description?: string | null
          attachments?: unknown[]
          column?: string
        }>,
        dependencies: Array.isArray(parsed.dependencies)
          ? parsed.dependencies.filter(
              (dependency: unknown): dependency is { dependentId: string; blockerId: string } =>
                typeof dependency === 'object' &&
                dependency !== null &&
                typeof (dependency as { dependentId?: unknown }).dependentId === 'string' &&
                typeof (dependency as { blockerId?: unknown }).blockerId === 'string'
            )
          : [],
        projectName: parsed.projectName ?? null
      }
    } catch (error) {
      log.error('Failed to open import file', error)
      return null
    }
  })

  ipcMain.handle(
    'kanban:board:importTickets',
    async (
      _event,
      projectId: string,
      tickets: Array<{
        id: string
        title: string
        description?: string | null
        attachments?: unknown[]
        column?: string
      }>,
      dependencies?: Array<{
        dependentId: string
        blockerId: string
      }>
    ) => {
      const db = getDatabase()
      let created = 0
      let updated = 0
      let dependencyCount = 0
      let ignoredDependencyCount = 0
      const selectedIds = new Set(tickets.map((ticket) => ticket.id))

      for (const ticket of tickets) {
        const existing = db.getKanbanTicket(ticket.id)

        if (existing && existing.project_id === projectId) {
          // Same project — update in place
          db.updateKanbanTicket(ticket.id, {
            title: ticket.title,
            description: ticket.description ?? null,
            attachments: ticket.attachments ?? [],
            column: (ticket.column as KanbanTicketColumn) ?? 'todo'
          })
          updated++
        } else if (existing) {
          // Different project — create with new ID
          db.createKanbanTicket({
            project_id: projectId,
            title: ticket.title,
            description: ticket.description ?? null,
            attachments: ticket.attachments ?? [],
            column: (ticket.column as KanbanTicketColumn) ?? 'todo'
          })
          created++
        } else {
          // Doesn't exist — create with preserved ID
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
        if (!dependentId || !blockerId || !selectedIds.has(dependentId) || !selectedIds.has(blockerId)) {
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
    }
  )

}
