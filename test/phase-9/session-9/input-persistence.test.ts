import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createTestDatabase,
  canRunDatabaseTests,
  getDatabaseLoadError
} from '../../utils/db-test-utils'
import { CURRENT_SCHEMA_VERSION } from '../../../src/main/db/schema'

// Check if we can run database tests
const canRun = canRunDatabaseTests()
const loadError = getDatabaseLoadError()

// Skip the entire suite if we can't load better-sqlite3
const describeIf = canRun ? describe : describe.skip

describeIf('Session 9: Input Persistence', () => {
  let db: ReturnType<typeof createTestDatabase>['db']
  let cleanup: () => void

  beforeEach(() => {
    const testDb = createTestDatabase()
    db = testDb.db
    cleanup = testDb.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  if (!canRun) {
    test.skip(`Skipping database tests: ${loadError?.message}`, () => {})
  }

  describe('Schema migration', () => {
    test('schema version is 6 after init', () => {
      expect(db.getSchemaVersion()).toBe(6)
    })

    test('CURRENT_SCHEMA_VERSION matches', () => {
      expect(CURRENT_SCHEMA_VERSION).toBe(6)
    })

    test('draft_input column exists on sessions table', () => {
      const project = db.createProject({
        name: 'Test Project',
        path: '/tmp/test-project-draft-col'
      })

      const session = db.createSession({
        worktree_id: null,
        project_id: project.id,
        name: 'Test Session'
      })

      // getSessionDraft should work (column exists)
      const draft = db.getSessionDraft(session.id)
      expect(draft).toBeNull()
    })
  })

  describe('getSessionDraft', () => {
    test('returns null for new session', () => {
      const project = db.createProject({
        name: 'Test Project',
        path: '/tmp/test-project-draft-1'
      })
      const session = db.createSession({
        worktree_id: null,
        project_id: project.id
      })

      expect(db.getSessionDraft(session.id)).toBeNull()
    })

    test('returns null for non-existent session', () => {
      expect(db.getSessionDraft('non-existent-id')).toBeNull()
    })

    test('returns saved draft', () => {
      const project = db.createProject({
        name: 'Test Project',
        path: '/tmp/test-project-draft-2'
      })
      const session = db.createSession({
        worktree_id: null,
        project_id: project.id
      })

      db.updateSessionDraft(session.id, 'hello world')
      expect(db.getSessionDraft(session.id)).toBe('hello world')
    })
  })

  describe('updateSessionDraft', () => {
    test('saves draft text', () => {
      const project = db.createProject({
        name: 'Test Project',
        path: '/tmp/test-project-draft-3'
      })
      const session = db.createSession({
        worktree_id: null,
        project_id: project.id
      })

      db.updateSessionDraft(session.id, 'my draft text')
      expect(db.getSessionDraft(session.id)).toBe('my draft text')
    })

    test('clears draft when set to null', () => {
      const project = db.createProject({
        name: 'Test Project',
        path: '/tmp/test-project-draft-4'
      })
      const session = db.createSession({
        worktree_id: null,
        project_id: project.id
      })

      db.updateSessionDraft(session.id, 'some text')
      expect(db.getSessionDraft(session.id)).toBe('some text')

      db.updateSessionDraft(session.id, null)
      expect(db.getSessionDraft(session.id)).toBeNull()
    })

    test('overwrites existing draft', () => {
      const project = db.createProject({
        name: 'Test Project',
        path: '/tmp/test-project-draft-5'
      })
      const session = db.createSession({
        worktree_id: null,
        project_id: project.id
      })

      db.updateSessionDraft(session.id, 'first draft')
      db.updateSessionDraft(session.id, 'second draft')
      expect(db.getSessionDraft(session.id)).toBe('second draft')
    })

    test('handles empty string', () => {
      const project = db.createProject({
        name: 'Test Project',
        path: '/tmp/test-project-draft-6'
      })
      const session = db.createSession({
        worktree_id: null,
        project_id: project.id
      })

      db.updateSessionDraft(session.id, '')
      expect(db.getSessionDraft(session.id)).toBe('')
    })

    test('drafts are independent per session', () => {
      const project = db.createProject({
        name: 'Test Project',
        path: '/tmp/test-project-draft-7'
      })
      const session1 = db.createSession({
        worktree_id: null,
        project_id: project.id,
        name: 'Session 1'
      })
      const session2 = db.createSession({
        worktree_id: null,
        project_id: project.id,
        name: 'Session 2'
      })

      db.updateSessionDraft(session1.id, 'draft for session 1')
      db.updateSessionDraft(session2.id, 'draft for session 2')

      expect(db.getSessionDraft(session1.id)).toBe('draft for session 1')
      expect(db.getSessionDraft(session2.id)).toBe('draft for session 2')
    })
  })

  describe('Draft lifecycle', () => {
    test('draft survives session update', () => {
      const project = db.createProject({
        name: 'Test Project',
        path: '/tmp/test-project-draft-8'
      })
      const session = db.createSession({
        worktree_id: null,
        project_id: project.id
      })

      db.updateSessionDraft(session.id, 'persistent draft')

      // Update session name (should not affect draft)
      db.updateSession(session.id, { name: 'Renamed Session' })

      expect(db.getSessionDraft(session.id)).toBe('persistent draft')
    })

    test('draft is deleted when session is deleted', () => {
      const project = db.createProject({
        name: 'Test Project',
        path: '/tmp/test-project-draft-9'
      })
      const session = db.createSession({
        worktree_id: null,
        project_id: project.id
      })

      db.updateSessionDraft(session.id, 'will be deleted')
      db.deleteSession(session.id)

      // Session no longer exists, so draft returns null
      expect(db.getSessionDraft(session.id)).toBeNull()
    })
  })

  describe('Debounce behavior (unit test for timing)', () => {
    test('debounce timer concept - clearTimeout prevents earlier save', () => {
      vi.useFakeTimers()
      const saveFn = vi.fn()
      let timer: ReturnType<typeof setTimeout> | null = null

      // Simulate typing with debounce
      const simulateType = (value: string): void => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => saveFn(value), 3000)
      }

      simulateType('h')
      simulateType('he')
      simulateType('hel')
      simulateType('hello')

      // Before 3 seconds, nothing saved
      vi.advanceTimersByTime(2999)
      expect(saveFn).not.toHaveBeenCalled()

      // At 3 seconds after last keystroke
      vi.advanceTimersByTime(1)
      expect(saveFn).toHaveBeenCalledTimes(1)
      expect(saveFn).toHaveBeenCalledWith('hello')

      vi.useRealTimers()
    })
  })
})
