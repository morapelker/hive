import { ipcMain } from 'electron'
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

  ipcMain.handle('kanban:ticket:getByProject', (_event, projectId: string) => {
    return getDatabase().getKanbanTicketsByProject(projectId)
  })

  ipcMain.handle('kanban:ticket:update', (_event, id: string, data: KanbanTicketUpdate) => {
    return getDatabase().updateKanbanTicket(id, data)
  })

  ipcMain.handle('kanban:ticket:delete', (_event, id: string) => {
    return getDatabase().deleteKanbanTicket(id)
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
}
