import { describe, test, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { CURRENT_SCHEMA_VERSION } from '../../src/main/db/schema'
import {
  createTestDatabase,
  canRunDatabaseTests,
  getDatabaseLoadError
} from '../utils/db-test-utils'

// Check if we can run database tests
const canRun = canRunDatabaseTests()
const loadError = getDatabaseLoadError()

// Skip the entire suite if we can't load better-sqlite3
const describeIf = canRun ? describe : describe.skip

describeIf('Session 3: Database', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any
  let cleanup: () => void

  beforeAll(() => {
    if (!canRun) {
      console.warn(
        'Skipping database tests: better-sqlite3 not available.',
        'This is expected when running tests outside of Electron.',
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

  test('Database file is created at specified location', () => {
    const dbPath = db.getDbPath()
    expect(dbPath).toBeTruthy()
    expect(dbPath).toContain('test.db')
  })

  test('All tables are created', () => {
    expect(db.tableExists('projects')).toBe(true)
    expect(db.tableExists('worktrees')).toBe(true)
    expect(db.tableExists('sessions')).toBe(true)
    expect(db.tableExists('session_messages')).toBe(true)
    expect(db.tableExists('settings')).toBe(true)
  })

  test('Indexes exist for performance', () => {
    const indexes = db.getIndexes()
    const indexNames = indexes.map((i: { name: string }) => i.name)

    expect(indexNames).toContain('idx_worktrees_project')
    expect(indexNames).toContain('idx_sessions_worktree')
    expect(indexNames).toContain('idx_sessions_project')
    expect(indexNames).toContain('idx_messages_session')
    expect(indexNames).toContain('idx_sessions_updated')
    expect(indexNames).toContain('idx_projects_accessed')
  })

  test('Schema version is tracked', () => {
    const version = db.getSchemaVersion()
    expect(version).toBe(CURRENT_SCHEMA_VERSION)
  })

  describe('Settings operations', () => {
    test('Set and get setting', () => {
      db.setSetting('test_key', 'test_value')
      expect(db.getSetting('test_key')).toBe('test_value')
    })

    test('Get non-existent setting returns null', () => {
      expect(db.getSetting('non_existent')).toBeNull()
    })

    test('Delete setting', () => {
      db.setSetting('to_delete', 'value')
      db.deleteSetting('to_delete')
      expect(db.getSetting('to_delete')).toBeNull()
    })

    test('Get all settings', () => {
      db.setSetting('key1', 'value1')
      db.setSetting('key2', 'value2')
      const settings = db.getAllSettings()
      expect(
        settings.some((s: { key: string; value: string }) => s.key === 'key1' && s.value === 'value1')
      ).toBe(true)
      expect(
        settings.some((s: { key: string; value: string }) => s.key === 'key2' && s.value === 'value2')
      ).toBe(true)
    })
  })

  describe('Project CRUD operations', () => {
    test('Create project', () => {
      const project = db.createProject({
        name: 'Test Project',
        path: '/test/path'
      })

      expect(project.id).toBeTruthy()
      expect(project.name).toBe('Test Project')
      expect(project.path).toBe('/test/path')
      expect(project.created_at).toBeTruthy()
      expect(project.last_accessed_at).toBeTruthy()
    })

    test('Create project with optional fields', () => {
      const project = db.createProject({
        name: 'Test Project',
        path: '/test/path',
        description: 'A test project',
        tags: ['tag1', 'tag2']
      })

      expect(project.description).toBe('A test project')
      expect(project.tags).toBe('["tag1","tag2"]')
    })

    test('Get project by ID', () => {
      const created = db.createProject({ name: 'Test', path: '/test' })
      const found = db.getProject(created.id)

      expect(found).not.toBeNull()
      expect(found?.id).toBe(created.id)
    })

    test('Get project by path', () => {
      const created = db.createProject({ name: 'Test', path: '/unique/path' })
      const found = db.getProjectByPath('/unique/path')

      expect(found).not.toBeNull()
      expect(found?.id).toBe(created.id)
    })

    test('Get all projects', () => {
      db.createProject({ name: 'Project 1', path: '/path/1' })
      db.createProject({ name: 'Project 2', path: '/path/2' })

      const projects = db.getAllProjects()
      expect(projects.length).toBe(2)
    })

    test('Update project', () => {
      const project = db.createProject({ name: 'Original', path: '/test' })
      const updated = db.updateProject(project.id, { name: 'Updated' })

      expect(updated?.name).toBe('Updated')
    })

    test('Delete project', () => {
      const project = db.createProject({ name: 'To Delete', path: '/delete' })
      const result = db.deleteProject(project.id)

      expect(result).toBe(true)
      expect(db.getProject(project.id)).toBeNull()
    })

    test('Touch project updates last_accessed_at', async () => {
      const project = db.createProject({ name: 'Touch Test', path: '/touch' })
      const originalAccess = project.last_accessed_at

      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10))

      db.touchProject(project.id)
      const updated = db.getProject(project.id)

      expect(updated?.last_accessed_at).not.toBe(originalAccess)
    })

    test('Duplicate path is rejected', () => {
      db.createProject({ name: 'First', path: '/same/path' })

      expect(() => {
        db.createProject({ name: 'Second', path: '/same/path' })
      }).toThrow()
    })
  })

  describe('Worktree CRUD operations', () => {
    let projectId: string

    beforeEach(() => {
      const project = db.createProject({ name: 'Parent Project', path: '/project' })
      projectId = project.id
    })

    test('Create worktree', () => {
      const worktree = db.createWorktree({
        project_id: projectId,
        name: 'tokyo',
        branch_name: 'tokyo',
        path: '/worktrees/tokyo'
      })

      expect(worktree.id).toBeTruthy()
      expect(worktree.project_id).toBe(projectId)
      expect(worktree.name).toBe('tokyo')
      expect(worktree.status).toBe('active')
    })

    test('Get worktrees by project', () => {
      db.createWorktree({
        project_id: projectId,
        name: 'tokyo',
        branch_name: 'tokyo',
        path: '/worktrees/tokyo'
      })
      db.createWorktree({
        project_id: projectId,
        name: 'paris',
        branch_name: 'paris',
        path: '/worktrees/paris'
      })

      const worktrees = db.getWorktreesByProject(projectId)
      expect(worktrees.length).toBe(2)
    })

    test('Get active worktrees by project', () => {
      const wt1 = db.createWorktree({
        project_id: projectId,
        name: 'active',
        branch_name: 'active',
        path: '/worktrees/active'
      })
      db.createWorktree({
        project_id: projectId,
        name: 'archived',
        branch_name: 'archived',
        path: '/worktrees/archived'
      })

      db.archiveWorktree(wt1.id)

      const active = db.getActiveWorktreesByProject(projectId)
      expect(active.length).toBe(1)
      expect(active[0].name).toBe('archived')
    })

    test('Archive worktree', () => {
      const worktree = db.createWorktree({
        project_id: projectId,
        name: 'to-archive',
        branch_name: 'to-archive',
        path: '/worktrees/to-archive'
      })

      const archived = db.archiveWorktree(worktree.id)
      expect(archived?.status).toBe('archived')
    })
  })

  describe('Session CRUD operations', () => {
    let projectId: string
    let worktreeId: string

    beforeEach(() => {
      const project = db.createProject({ name: 'Session Project', path: '/session-project' })
      projectId = project.id

      const worktree = db.createWorktree({
        project_id: projectId,
        name: 'session-worktree',
        branch_name: 'session-worktree',
        path: '/worktrees/session'
      })
      worktreeId = worktree.id
    })

    test('Create session', () => {
      const session = db.createSession({
        worktree_id: worktreeId,
        project_id: projectId,
        name: 'Test Session'
      })

      expect(session.id).toBeTruthy()
      expect(session.worktree_id).toBe(worktreeId)
      expect(session.project_id).toBe(projectId)
      expect(session.status).toBe('active')
    })

    test('Create session without worktree', () => {
      const session = db.createSession({
        worktree_id: null,
        project_id: projectId
      })

      expect(session.worktree_id).toBeNull()
    })

    test('Get sessions by worktree', () => {
      db.createSession({ worktree_id: worktreeId, project_id: projectId })
      db.createSession({ worktree_id: worktreeId, project_id: projectId })

      const sessions = db.getSessionsByWorktree(worktreeId)
      expect(sessions.length).toBe(2)
    })

    test('Update session', () => {
      const session = db.createSession({
        worktree_id: worktreeId,
        project_id: projectId
      })

      const updated = db.updateSession(session.id, {
        status: 'completed',
        completed_at: new Date().toISOString()
      })

      expect(updated?.status).toBe('completed')
      expect(updated?.completed_at).toBeTruthy()
    })

    test('Search sessions by keyword', () => {
      const session = db.createSession({
        worktree_id: worktreeId,
        project_id: projectId,
        name: 'Search Test Session'
      })

      db.createSessionMessage({
        session_id: session.id,
        role: 'user',
        content: 'Hello world unique content'
      })

      const results = db.searchSessions({ keyword: 'unique content' })
      expect(results.length).toBe(1)
    })

    test('Search sessions by project', () => {
      db.createSession({ worktree_id: worktreeId, project_id: projectId })

      const results = db.searchSessions({ project_id: projectId })
      expect(results.length).toBe(1)
    })
  })

  describe('Session message operations', () => {
    let sessionId: string

    beforeEach(() => {
      const project = db.createProject({ name: 'Msg Project', path: '/msg-project' })
      const session = db.createSession({
        worktree_id: null,
        project_id: project.id
      })
      sessionId = session.id
    })

    test('Create session message', () => {
      const message = db.createSessionMessage({
        session_id: sessionId,
        role: 'user',
        content: 'Hello, assistant!'
      })

      expect(message.id).toBeTruthy()
      expect(message.session_id).toBe(sessionId)
      expect(message.role).toBe('user')
      expect(message.content).toBe('Hello, assistant!')
    })

    test('Get messages by session', () => {
      db.createSessionMessage({ session_id: sessionId, role: 'user', content: 'First' })
      db.createSessionMessage({ session_id: sessionId, role: 'assistant', content: 'Second' })

      const messages = db.getSessionMessages(sessionId)
      expect(messages.length).toBe(2)
      expect(messages[0].content).toBe('First')
      expect(messages[1].content).toBe('Second')
    })

    test('Creating message updates session updated_at', async () => {
      const session = db.getSession(sessionId)
      const originalUpdated = session?.updated_at

      await new Promise((resolve) => setTimeout(resolve, 10))

      db.createSessionMessage({ session_id: sessionId, role: 'user', content: 'New message' })

      const updated = db.getSession(sessionId)
      expect(updated?.updated_at).not.toBe(originalUpdated)
    })
  })

  describe('Foreign key constraints', () => {
    test('Cannot create worktree with invalid project_id', () => {
      expect(() => {
        db.createWorktree({
          project_id: 'non-existent-id',
          name: 'test',
          branch_name: 'test',
          path: '/test'
        })
      }).toThrow()
    })

    test('Cannot create session with invalid project_id', () => {
      expect(() => {
        db.createSession({
          worktree_id: null,
          project_id: 'non-existent-id'
        })
      }).toThrow()
    })

    test('Cannot create message with invalid session_id', () => {
      expect(() => {
        db.createSessionMessage({
          session_id: 'non-existent-id',
          role: 'user',
          content: 'test'
        })
      }).toThrow()
    })
  })

  describe('Cascade delete', () => {
    test('Deleting project cascades to worktrees', () => {
      const project = db.createProject({ name: 'Cascade Test', path: '/cascade' })
      const worktree = db.createWorktree({
        project_id: project.id,
        name: 'child',
        branch_name: 'child',
        path: '/cascade/child'
      })

      db.deleteProject(project.id)

      expect(db.getWorktree(worktree.id)).toBeNull()
    })

    test('Deleting project cascades to sessions', () => {
      const project = db.createProject({ name: 'Cascade Test', path: '/cascade2' })
      const session = db.createSession({
        worktree_id: null,
        project_id: project.id
      })

      db.deleteProject(project.id)

      expect(db.getSession(session.id)).toBeNull()
    })

    test('Deleting worktree sets session worktree_id to null', () => {
      const project = db.createProject({ name: 'Set Null Test', path: '/setnull' })
      const worktree = db.createWorktree({
        project_id: project.id,
        name: 'to-delete',
        branch_name: 'to-delete',
        path: '/setnull/worktree'
      })
      const session = db.createSession({
        worktree_id: worktree.id,
        project_id: project.id
      })

      db.deleteWorktree(worktree.id)

      const updatedSession = db.getSession(session.id)
      expect(updatedSession).not.toBeNull()
      expect(updatedSession?.worktree_id).toBeNull()
    })

    test('Deleting session cascades to messages', () => {
      const project = db.createProject({ name: 'Msg Cascade', path: '/msgcascade' })
      const session = db.createSession({
        worktree_id: null,
        project_id: project.id
      })
      db.createSessionMessage({
        session_id: session.id,
        role: 'user',
        content: 'test'
      })

      db.deleteSession(session.id)

      // Messages should be deleted with session
      const messages = db.getSessionMessages(session.id)
      expect(messages.length).toBe(0)
    })
  })

  describe('Performance', () => {
    test('Database operations complete under 50ms', () => {
      // Create project
      const start1 = performance.now()
      const project = db.createProject({ name: 'Perf Test', path: '/perf' })
      const createTime = performance.now() - start1
      expect(createTime).toBeLessThan(50)

      // Read project
      const start2 = performance.now()
      db.getProject(project.id)
      const readTime = performance.now() - start2
      expect(readTime).toBeLessThan(50)

      // Update project
      const start3 = performance.now()
      db.updateProject(project.id, { name: 'Updated Perf' })
      const updateTime = performance.now() - start3
      expect(updateTime).toBeLessThan(50)

      // Query all projects
      const start4 = performance.now()
      db.getAllProjects()
      const queryTime = performance.now() - start4
      expect(queryTime).toBeLessThan(50)
    })

    test('Bulk operations maintain performance', () => {
      const project = db.createProject({ name: 'Bulk Test', path: '/bulk' })

      // Create 100 worktrees
      const start = performance.now()
      for (let i = 0; i < 100; i++) {
        db.createWorktree({
          project_id: project.id,
          name: `worktree-${i}`,
          branch_name: `branch-${i}`,
          path: `/bulk/worktree-${i}`
        })
      }
      const bulkCreateTime = performance.now() - start

      // Query all worktrees
      const startQuery = performance.now()
      const worktrees = db.getWorktreesByProject(project.id)
      const queryTime = performance.now() - startQuery

      expect(worktrees.length).toBe(100)
      expect(queryTime).toBeLessThan(50)
      // Bulk create can take longer, but should still be reasonable
      expect(bulkCreateTime).toBeLessThan(5000)
    })
  })
})

// Export a test that shows information when tests are skipped
if (!canRun) {
  describe('Session 3: Database (skipped)', () => {
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
