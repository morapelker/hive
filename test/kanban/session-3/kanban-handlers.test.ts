import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { DatabaseService } from '../../../src/main/db/database'

// Mock ipcMain to capture registered handlers
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => `/tmp/hive-test-mock-${name}`
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  })
}))

// We need to mock getDatabase to return our test db instance
let testDb: InstanceType<typeof DatabaseService>
vi.mock('../../../src/main/db', () => ({
  getDatabase: () => testDb
}))

import { registerKanbanHandlers } from '../../../src/main/ipc/kanban-handlers'

describe('Session 3: Kanban IPC Handlers', () => {
  let cleanup: () => void
  let projectId: string

  beforeEach(() => {
    handlers.clear()

    const testDir = join(tmpdir(), 'hive-test-' + randomUUID())
    mkdirSync(testDir, { recursive: true })
    const dbPath = join(testDir, 'test.db')

    testDb = new DatabaseService(dbPath)
    testDb.init()

    cleanup = (): void => {
      testDb.close()
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    }

    // Create a test project
    const project = testDb.createProject({ name: 'IPC Test Project', path: '/ipc-test' })
    projectId = project.id

    // Register the handlers so they populate the handlers map
    registerKanbanHandlers()
  })

  afterEach(() => {
    if (cleanup) {
      cleanup()
    }
  })

  test('kanban:ticket:create calls createKanbanTicket and returns result', () => {
    const handler = handlers.get('kanban:ticket:create')
    expect(handler).toBeDefined()

    const result = handler!(null, { project_id: projectId, title: 'New Ticket' })
    expect(result).toBeDefined()
    expect((result as { id: string }).id).toBeTruthy()
    expect((result as { title: string }).title).toBe('New Ticket')
    expect((result as { project_id: string }).project_id).toBe(projectId)
    expect((result as { column: string }).column).toBe('todo')
  })

  test('kanban:ticket:get calls getKanbanTicket with correct id', () => {
    const handler = handlers.get('kanban:ticket:get')
    expect(handler).toBeDefined()

    // Create a ticket first
    const ticket = testDb.createKanbanTicket({ project_id: projectId, title: 'Get Test' })

    const result = handler!(null, ticket.id)
    expect(result).toBeDefined()
    expect((result as { id: string }).id).toBe(ticket.id)
    expect((result as { title: string }).title).toBe('Get Test')

    // Non-existent returns null
    const missing = handler!(null, 'non-existent-id')
    expect(missing).toBeNull()
  })

  test('kanban:ticket:getByProject calls getKanbanTicketsByProject', () => {
    const handler = handlers.get('kanban:ticket:getByProject')
    expect(handler).toBeDefined()

    testDb.createKanbanTicket({ project_id: projectId, title: 'Ticket A' })
    testDb.createKanbanTicket({ project_id: projectId, title: 'Ticket B' })

    const result = handler!(null, projectId) as unknown[]
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(2)
  })

  test('kanban:ticket:update calls updateKanbanTicket with id and data', () => {
    const handler = handlers.get('kanban:ticket:update')
    expect(handler).toBeDefined()

    const ticket = testDb.createKanbanTicket({ project_id: projectId, title: 'Original' })

    const result = handler!(null, ticket.id, { title: 'Updated' })
    expect(result).toBeDefined()
    expect((result as { title: string }).title).toBe('Updated')

    // Non-existent returns null
    const missing = handler!(null, 'non-existent-id', { title: 'Nope' })
    expect(missing).toBeNull()
  })

  test('kanban:ticket:delete calls deleteKanbanTicket', () => {
    const handler = handlers.get('kanban:ticket:delete')
    expect(handler).toBeDefined()

    const ticket = testDb.createKanbanTicket({ project_id: projectId, title: 'Delete Me' })

    const result = handler!(null, ticket.id)
    expect(result).toBe(true)

    // Verify deleted
    expect(testDb.getKanbanTicket(ticket.id)).toBeNull()

    // Deleting again returns false
    const result2 = handler!(null, ticket.id)
    expect(result2).toBe(false)
  })

  test('kanban:ticket:move calls moveKanbanTicket with column and sortOrder', () => {
    const handler = handlers.get('kanban:ticket:move')
    expect(handler).toBeDefined()

    const ticket = testDb.createKanbanTicket({
      project_id: projectId,
      title: 'Move Me',
      column: 'todo',
      sort_order: 0
    })

    const result = handler!(null, ticket.id, 'in_progress', 3.5)
    expect(result).toBeDefined()
    expect((result as { column: string }).column).toBe('in_progress')
    expect((result as { sort_order: number }).sort_order).toBe(3.5)

    // Non-existent returns null
    const missing = handler!(null, 'non-existent-id', 'done', 0)
    expect(missing).toBeNull()
  })

  test('kanban:ticket:reorder calls reorderKanbanTicket with sortOrder', () => {
    const handler = handlers.get('kanban:ticket:reorder')
    expect(handler).toBeDefined()

    const ticket = testDb.createKanbanTicket({
      project_id: projectId,
      title: 'Reorder Me',
      column: 'todo',
      sort_order: 0
    })

    handler!(null, ticket.id, 7.25)

    const fetched = testDb.getKanbanTicket(ticket.id)
    expect(fetched!.sort_order).toBe(7.25)
    expect(fetched!.column).toBe('todo')
  })

  test('kanban:ticket:getBySession calls getKanbanTicketsBySession', () => {
    const handler = handlers.get('kanban:ticket:getBySession')
    expect(handler).toBeDefined()

    const worktree = testDb.createWorktree({
      project_id: projectId,
      name: 'session-wt',
      branch_name: 'session-wt',
      path: '/ipc-test/session-wt'
    })
    const session = testDb.createSession({
      worktree_id: worktree.id,
      project_id: projectId,
      name: 'Test Session'
    })

    testDb.createKanbanTicket({
      project_id: projectId,
      title: 'Session Ticket',
      current_session_id: session.id
    })
    testDb.createKanbanTicket({
      project_id: projectId,
      title: 'Unlinked Ticket'
    })

    const result = handler!(null, session.id) as unknown[]
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    expect((result[0] as { title: string }).title).toBe('Session Ticket')
  })

  test('kanban:simpleMode:toggle calls updateProjectSimpleMode', () => {
    const handler = handlers.get('kanban:simpleMode:toggle')
    expect(handler).toBeDefined()

    // Enable simple mode
    handler!(null, projectId, true)

    // Verify via raw DB query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawDb = (testDb as any)['db']
    const row = rawDb
      .prepare('SELECT kanban_simple_mode FROM projects WHERE id = ?')
      .get(projectId) as { kanban_simple_mode: number }
    expect(row.kanban_simple_mode).toBe(1)

    // Disable
    handler!(null, projectId, false)
    const row2 = rawDb
      .prepare('SELECT kanban_simple_mode FROM projects WHERE id = ?')
      .get(projectId) as { kanban_simple_mode: number }
    expect(row2.kanban_simple_mode).toBe(0)
  })
})
