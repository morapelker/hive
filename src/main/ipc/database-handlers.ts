import { ipcMain } from 'electron'
import { getDatabase } from '../db'
import { createLogger } from '../services/logger'
import type {
  ProjectCreate,
  ProjectUpdate,
  WorktreeCreate,
  WorktreeUpdate,
  SessionCreate,
  SessionUpdate,
  SessionMessageCreate,
  SessionSearchOptions
} from '../db'

const log = createLogger({ component: 'DatabaseHandlers' })

// Helper to wrap handlers with error logging
function withErrorHandler<T>(
  operation: string,
  handler: () => T,
  context?: Record<string, unknown>
): T {
  try {
    return handler()
  } catch (error) {
    log.error(
      `Failed to ${operation}`,
      error instanceof Error ? error : new Error(String(error)),
      context
    )
    throw error
  }
}

export function registerDatabaseHandlers(): void {
  log.info('Registering database handlers')
  // Settings
  ipcMain.handle('db:setting:get', (_event, key: string) => {
    return getDatabase().getSetting(key)
  })

  ipcMain.handle('db:setting:set', (_event, key: string, value: string) => {
    getDatabase().setSetting(key, value)
    return true
  })

  ipcMain.handle('db:setting:delete', (_event, key: string) => {
    getDatabase().deleteSetting(key)
    return true
  })

  ipcMain.handle('db:setting:getAll', () => {
    return getDatabase().getAllSettings()
  })

  // Projects
  ipcMain.handle('db:project:create', (_event, data: ProjectCreate) => {
    const db = getDatabase()
    const project = db.createProject(data)

    // Create default worktree for the new project
    db.createWorktree({
      project_id: project.id,
      name: '(no-worktree)',
      branch_name: '',
      path: project.path,
      is_default: true
    })

    return project
  })

  ipcMain.handle('db:project:get', (_event, id: string) => {
    return getDatabase().getProject(id)
  })

  ipcMain.handle('db:project:getByPath', (_event, path: string) => {
    return getDatabase().getProjectByPath(path)
  })

  ipcMain.handle('db:project:getAll', () => {
    return getDatabase().getAllProjects()
  })

  ipcMain.handle('db:project:update', (_event, id: string, data: ProjectUpdate) => {
    return getDatabase().updateProject(id, data)
  })

  ipcMain.handle('db:project:delete', (_event, id: string) => {
    return getDatabase().deleteProject(id)
  })

  ipcMain.handle('db:project:touch', (_event, id: string) => {
    getDatabase().touchProject(id)
    return true
  })

  // Worktrees
  ipcMain.handle('db:worktree:create', (_event, data: WorktreeCreate) => {
    return getDatabase().createWorktree(data)
  })

  ipcMain.handle('db:worktree:get', (_event, id: string) => {
    return getDatabase().getWorktree(id)
  })

  ipcMain.handle('db:worktree:getByProject', (_event, projectId: string) => {
    return getDatabase().getWorktreesByProject(projectId)
  })

  ipcMain.handle('db:worktree:getActiveByProject', (_event, projectId: string) => {
    return getDatabase().getActiveWorktreesByProject(projectId)
  })

  ipcMain.handle('db:worktree:update', (_event, id: string, data: WorktreeUpdate) => {
    return getDatabase().updateWorktree(id, data)
  })

  ipcMain.handle('db:worktree:delete', (_event, id: string) => {
    return getDatabase().deleteWorktree(id)
  })

  ipcMain.handle('db:worktree:archive', (_event, id: string) => {
    return getDatabase().archiveWorktree(id)
  })

  ipcMain.handle('db:worktree:touch', (_event, id: string) => {
    getDatabase().touchWorktree(id)
    return true
  })

  // Sessions
  ipcMain.handle('db:session:create', (_event, data: SessionCreate) => {
    return getDatabase().createSession(data)
  })

  ipcMain.handle('db:session:get', (_event, id: string) => {
    return getDatabase().getSession(id)
  })

  ipcMain.handle('db:session:getByWorktree', (_event, worktreeId: string) => {
    return getDatabase().getSessionsByWorktree(worktreeId)
  })

  ipcMain.handle('db:session:getByProject', (_event, projectId: string) => {
    return getDatabase().getSessionsByProject(projectId)
  })

  ipcMain.handle('db:session:getActiveByWorktree', (_event, worktreeId: string) => {
    return getDatabase().getActiveSessionsByWorktree(worktreeId)
  })

  ipcMain.handle('db:session:update', (_event, id: string, data: SessionUpdate) => {
    return getDatabase().updateSession(id, data)
  })

  ipcMain.handle('db:session:delete', (_event, id: string) => {
    return getDatabase().deleteSession(id)
  })

  ipcMain.handle('db:session:search', (_event, options: SessionSearchOptions) => {
    return getDatabase().searchSessions(options)
  })

  ipcMain.handle('db:session:getDraft', (_event, sessionId: string) => {
    return getDatabase().getSessionDraft(sessionId)
  })

  ipcMain.handle('db:session:updateDraft', (_event, sessionId: string, draft: string | null) => {
    getDatabase().updateSessionDraft(sessionId, draft)
  })

  // Session Messages
  ipcMain.handle('db:message:create', (_event, data: SessionMessageCreate) => {
    return getDatabase().createSessionMessage(data)
  })

  ipcMain.handle('db:message:getBySession', (_event, sessionId: string) => {
    return getDatabase().getSessionMessages(sessionId)
  })

  ipcMain.handle('db:message:delete', (_event, id: string) => {
    return getDatabase().deleteSessionMessage(id)
  })

  // Utility
  ipcMain.handle('db:schemaVersion', () => {
    return getDatabase().getSchemaVersion()
  })

  ipcMain.handle('db:tableExists', (_event, tableName: string) => {
    return getDatabase().tableExists(tableName)
  })

  ipcMain.handle('db:getIndexes', () => {
    return getDatabase().getIndexes()
  })
}
