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

describeIf('Session 1: Kanban Ticket Note', () => {
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

  test('schema version is at least 24 and note column exists with correct type', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(24)
    expect(db.getSchemaVersion()).toBeGreaterThanOrEqual(24)

    const rawDb = db['db']
    const columns = rawDb.pragma('table_info(kanban_tickets)') as {
      name: string
      type: string
      notnull: number
      pk: number
    }[]
    const noteCol = columns.find((c) => c.name === 'note')

    expect(noteCol, 'note column should exist').toBeTruthy()
    expect(noteCol!.type).toBe('TEXT')
    expect(noteCol!.notnull).toBe(0)
  })

  test('newly created ticket has note === null by default', () => {
    const project = db.createProject({ name: 'Note Default Test', path: '/note-default' })
    const ticket = db.createKanbanTicket({ project_id: project.id, title: 'No note yet' })

    expect(ticket.note).toBeNull()

    // Round-trip via getKanbanTicket as well
    const fetched = db.getKanbanTicket(ticket.id)
    expect(fetched).toBeTruthy()
    expect(fetched.note).toBeNull()
  })

  test('updateKanbanTicket persists a note value', () => {
    const project = db.createProject({ name: 'Note Persist Test', path: '/note-persist' })
    const ticket = db.createKanbanTicket({ project_id: project.id, title: 'Persist note' })

    const updated = db.updateKanbanTicket(ticket.id, { note: 'hello' })
    expect(updated).toBeTruthy()
    expect(updated.note).toBe('hello')

    const fetched = db.getKanbanTicket(ticket.id)
    expect(fetched.note).toBe('hello')
  })

  test('updateKanbanTicket clears note when set to null', () => {
    const project = db.createProject({ name: 'Note Clear Test', path: '/note-clear' })
    const ticket = db.createKanbanTicket({ project_id: project.id, title: 'Clear note' })

    db.updateKanbanTicket(ticket.id, { note: 'will be cleared' })
    const beforeClear = db.getKanbanTicket(ticket.id)
    expect(beforeClear.note).toBe('will be cleared')

    const cleared = db.updateKanbanTicket(ticket.id, { note: null })
    expect(cleared).toBeTruthy()
    expect(cleared.note).toBeNull()

    const fetched = db.getKanbanTicket(ticket.id)
    expect(fetched.note).toBeNull()
  })

  test('updateKanbanTicket without note key does not clobber existing note', () => {
    const project = db.createProject({ name: 'Note Preserve Test', path: '/note-preserve' })
    const ticket = db.createKanbanTicket({ project_id: project.id, title: 'Preserve note' })

    db.updateKanbanTicket(ticket.id, { note: 'keep me' })
    const beforeUpdate = db.getKanbanTicket(ticket.id)
    expect(beforeUpdate.note).toBe('keep me')

    // Update something else without touching note
    const updated = db.updateKanbanTicket(ticket.id, { title: 'new title' })
    expect(updated).toBeTruthy()
    expect(updated.title).toBe('new title')
    expect(updated.note).toBe('keep me')

    const fetched = db.getKanbanTicket(ticket.id)
    expect(fetched.title).toBe('new title')
    expect(fetched.note).toBe('keep me')
  })
})

// Show information when tests are skipped
if (!canRun) {
  describe('Session 1: Kanban Ticket Note (skipped)', () => {
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
