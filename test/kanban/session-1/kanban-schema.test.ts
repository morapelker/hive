import { describe, test, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { CURRENT_SCHEMA_VERSION } from '../../../src/main/db/schema'
import {
  createTestDatabase,
  canRunDatabaseTests,
  getDatabaseLoadError
} from '../../utils/db-test-utils'

const canRun = canRunDatabaseTests()
const loadError = getDatabaseLoadError()

const describeIf = canRun ? describe : describe.skip

describeIf('Session 1: Kanban Schema', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any
  let cleanup: () => void

  beforeAll(() => {
    if (!canRun) {
      console.warn(
        'Skipping database tests: better-sqlite3 not available.',
        'Error:',
        loadError?.message
      )
    }
  })

  beforeEach(() => {
    const testSetup = createTestDatabase()
    db = testSetup.db
    cleanup = testSetup.cleanup
  })

  afterEach(() => {
    if (cleanup) {
      cleanup()
    }
  })

  test('kanban_tickets table is created by migration v11', () => {
    expect(db.tableExists('kanban_tickets')).toBe(true)
  })

  test('kanban_tickets has all required columns with correct types', () => {
    const rawDb = db['db']
    const columns = rawDb.pragma('table_info(kanban_tickets)') as {
      name: string
      type: string
      notnull: number
      pk: number
    }[]
    const colMap = new Map(columns.map((c) => [c.name, c]))

    // Verify all columns exist
    const expectedColumns = [
      'id',
      'project_id',
      'title',
      'description',
      'attachments',
      'column',
      'sort_order',
      'current_session_id',
      'worktree_id',
      'mode',
      'plan_ready',
      'created_at',
      'updated_at'
    ]
    for (const col of expectedColumns) {
      expect(colMap.has(col), `column "${col}" should exist`).toBe(true)
    }

    // Verify types
    expect(colMap.get('id')!.type).toBe('TEXT')
    expect(colMap.get('id')!.pk).toBe(1)
    expect(colMap.get('project_id')!.type).toBe('TEXT')
    expect(colMap.get('project_id')!.notnull).toBe(1)
    expect(colMap.get('title')!.type).toBe('TEXT')
    expect(colMap.get('title')!.notnull).toBe(1)
    expect(colMap.get('description')!.type).toBe('TEXT')
    expect(colMap.get('description')!.notnull).toBe(0)
    expect(colMap.get('attachments')!.type).toBe('TEXT')
    expect(colMap.get('attachments')!.notnull).toBe(1)
    expect(colMap.get('column')!.type).toBe('TEXT')
    expect(colMap.get('column')!.notnull).toBe(1)
    expect(colMap.get('sort_order')!.type).toBe('REAL')
    expect(colMap.get('sort_order')!.notnull).toBe(1)
    expect(colMap.get('current_session_id')!.type).toBe('TEXT')
    expect(colMap.get('current_session_id')!.notnull).toBe(0)
    expect(colMap.get('worktree_id')!.type).toBe('TEXT')
    expect(colMap.get('worktree_id')!.notnull).toBe(0)
    expect(colMap.get('mode')!.type).toBe('TEXT')
    expect(colMap.get('mode')!.notnull).toBe(0)
    expect(colMap.get('plan_ready')!.type).toBe('INTEGER')
    expect(colMap.get('plan_ready')!.notnull).toBe(1)
    expect(colMap.get('created_at')!.type).toBe('TEXT')
    expect(colMap.get('created_at')!.notnull).toBe(1)
    expect(colMap.get('updated_at')!.type).toBe('TEXT')
    expect(colMap.get('updated_at')!.notnull).toBe(1)
  })

  test('kanban_tickets.column defaults to "todo"', () => {
    const rawDb = db['db']
    const project = db.createProject({ name: 'Default Col Test', path: '/default-col' })
    const now = new Date().toISOString()

    rawDb
      .prepare(
        `INSERT INTO kanban_tickets (id, project_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('test-default-col', project.id, 'Test Ticket', now, now)

    const row = rawDb.prepare('SELECT "column" FROM kanban_tickets WHERE id = ?').get('test-default-col') as {
      column: string
    }
    expect(row.column).toBe('todo')
  })

  test('kanban_tickets.sort_order defaults to 0', () => {
    const rawDb = db['db']
    const project = db.createProject({ name: 'Default Sort Test', path: '/default-sort' })
    const now = new Date().toISOString()

    rawDb
      .prepare(
        `INSERT INTO kanban_tickets (id, project_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('test-default-sort', project.id, 'Test Ticket', now, now)

    const row = rawDb.prepare('SELECT sort_order FROM kanban_tickets WHERE id = ?').get('test-default-sort') as {
      sort_order: number
    }
    expect(row.sort_order).toBe(0)
  })

  test('kanban_tickets.plan_ready defaults to 0', () => {
    const rawDb = db['db']
    const project = db.createProject({ name: 'Default Plan Test', path: '/default-plan' })
    const now = new Date().toISOString()

    rawDb
      .prepare(
        `INSERT INTO kanban_tickets (id, project_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('test-default-plan', project.id, 'Test Ticket', now, now)

    const row = rawDb.prepare('SELECT plan_ready FROM kanban_tickets WHERE id = ?').get('test-default-plan') as {
      plan_ready: number
    }
    expect(row.plan_ready).toBe(0)
  })

  test('kanban_tickets.attachments defaults to "[]"', () => {
    const rawDb = db['db']
    const project = db.createProject({
      name: 'Default Attachments Test',
      path: '/default-attachments'
    })
    const now = new Date().toISOString()

    rawDb
      .prepare(
        `INSERT INTO kanban_tickets (id, project_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('test-default-attach', project.id, 'Test Ticket', now, now)

    const row = rawDb.prepare('SELECT attachments FROM kanban_tickets WHERE id = ?').get('test-default-attach') as {
      attachments: string
    }
    expect(row.attachments).toBe('[]')
  })

  test('projects table has kanban_simple_mode column defaulting to 0', () => {
    const project = db.createProject({
      name: 'Simple Mode Test',
      path: '/simple-mode'
    })

    const rawDb = db['db']
    const row = rawDb.prepare('SELECT kanban_simple_mode FROM projects WHERE id = ?').get(project.id) as {
      kanban_simple_mode: number
    }
    expect(row.kanban_simple_mode).toBe(0)
  })

  test('deleting a project cascades to its kanban_tickets', () => {
    const rawDb = db['db']
    const project = db.createProject({ name: 'Cascade Project', path: '/cascade-kanban' })
    const now = new Date().toISOString()

    rawDb
      .prepare(
        `INSERT INTO kanban_tickets (id, project_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('ticket-cascade', project.id, 'Cascading Ticket', now, now)

    // Verify ticket exists
    const before = rawDb.prepare('SELECT id FROM kanban_tickets WHERE id = ?').get('ticket-cascade')
    expect(before).toBeTruthy()

    // Delete the project
    db.deleteProject(project.id)

    // Ticket should be gone
    const after = rawDb.prepare('SELECT id FROM kanban_tickets WHERE id = ?').get('ticket-cascade')
    expect(after).toBeUndefined()
  })

  test('deleting a session sets current_session_id to NULL on tickets', () => {
    const rawDb = db['db']
    const project = db.createProject({ name: 'Session FK Test', path: '/session-fk' })
    const worktree = db.createWorktree({
      project_id: project.id,
      name: 'fk-wt',
      branch_name: 'fk-wt',
      path: '/session-fk/wt'
    })
    const session = db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      name: 'FK Session'
    })

    const now = new Date().toISOString()
    rawDb
      .prepare(
        `INSERT INTO kanban_tickets (id, project_id, title, current_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('ticket-session-fk', project.id, 'Session FK Ticket', session.id, now, now)

    // Verify session_id is set
    const before = rawDb.prepare('SELECT current_session_id FROM kanban_tickets WHERE id = ?').get('ticket-session-fk') as {
      current_session_id: string | null
    }
    expect(before.current_session_id).toBe(session.id)

    // Delete the session
    db.deleteSession(session.id)

    // Ticket should still exist but current_session_id should be NULL
    const after = rawDb.prepare('SELECT current_session_id FROM kanban_tickets WHERE id = ?').get('ticket-session-fk') as {
      current_session_id: string | null
    }
    expect(after).toBeTruthy()
    expect(after.current_session_id).toBeNull()
  })

  test('deleting a worktree sets worktree_id to NULL on tickets', () => {
    const rawDb = db['db']
    const project = db.createProject({ name: 'Worktree FK Test', path: '/worktree-fk' })
    const worktree = db.createWorktree({
      project_id: project.id,
      name: 'fk-wt2',
      branch_name: 'fk-wt2',
      path: '/worktree-fk/wt'
    })

    const now = new Date().toISOString()
    rawDb
      .prepare(
        `INSERT INTO kanban_tickets (id, project_id, title, worktree_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('ticket-wt-fk', project.id, 'Worktree FK Ticket', worktree.id, now, now)

    // Verify worktree_id is set
    const before = rawDb.prepare('SELECT worktree_id FROM kanban_tickets WHERE id = ?').get('ticket-wt-fk') as {
      worktree_id: string | null
    }
    expect(before.worktree_id).toBe(worktree.id)

    // Delete the worktree
    db.deleteWorktree(worktree.id)

    // Ticket should still exist but worktree_id should be NULL
    const after = rawDb.prepare('SELECT worktree_id FROM kanban_tickets WHERE id = ?').get('ticket-wt-fk') as {
      worktree_id: string | null
    }
    expect(after).toBeTruthy()
    expect(after.worktree_id).toBeNull()
  })

  test('indexes exist on project_id, current_session_id, worktree_id', () => {
    const indexes = db.getIndexes()
    const indexNames = indexes.map((i: { name: string }) => i.name)

    expect(indexNames).toContain('idx_kanban_tickets_project')
    expect(indexNames).toContain('idx_kanban_tickets_session')
    expect(indexNames).toContain('idx_kanban_tickets_worktree')
  })

  test('schema version is 11', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(11)
    expect(db.getSchemaVersion()).toBe(11)
  })
})

// Show information when tests are skipped
if (!canRun) {
  describe('Session 1: Kanban Schema (skipped)', () => {
    test('better-sqlite3 not available for Node.js testing', () => {
      console.log(
        'Database tests skipped: better-sqlite3 was compiled for Electron.',
        'To run these tests, either:',
        '1. Run tests in Electron environment',
        '2. Rebuild better-sqlite3 for Node.js: npm rebuild better-sqlite3'
      )
      expect(true).toBe(true)
    })
  })
}
