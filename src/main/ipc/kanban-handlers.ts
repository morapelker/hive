import { ipcMain, dialog } from 'electron'
import { writeFile, readFile } from 'node:fs/promises'
import { getDatabase } from '../db'
import { createLogger } from '../services/logger'
import type { KanbanTicketCreate, KanbanTicketUpdate, KanbanTicketColumn } from '../db'

const log = createLogger({ component: 'KanbanHandlers' })

export function registerKanbanHandlers(): void {
  log.info('Registering kanban handlers')

  ipcMain.handle('kanban:ticket:create', (_event, data: KanbanTicketCreate) => {
    return getDatabase().createKanbanTicket(data)
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

  ipcMain.handle('kanban:simpleMode:toggle', (_event, projectId: string, enabled: boolean) => {
    return getDatabase().updateProjectSimpleMode(projectId, enabled)
  })

  ipcMain.handle(
    'kanban:board:export',
    async (_event, projectId: string, projectName: string) => {
      try {
        const db = getDatabase()
        const tickets = db.getKanbanTicketsByProject(projectId, false)

        const exportData = {
          projectName,
          exportedAt: new Date().toISOString(),
          tickets: tickets.map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            attachments: t.attachments,
            column: t.column
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
      }>
    ) => {
      const db = getDatabase()
      let created = 0
      let updated = 0

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

      return { created, updated }
    }
  )

}
