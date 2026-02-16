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

describeIf('Session 1: Connection Schema & Migration', () => {
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
    if (cleanup) cleanup()
  })

  test('schema version is 2', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2)
    expect(db.getSchemaVersion()).toBe(2)
  })

  describe('Table creation', () => {
    test('connections table is created by migration', () => {
      expect(db.tableExists('connections')).toBe(true)
    })

    test('connection_members table is created by migration', () => {
      expect(db.tableExists('connection_members')).toBe(true)
    })

    test('indexes exist for connection tables', () => {
      const indexes = db.getIndexes()
      const indexNames = indexes.map((i: { name: string }) => i.name)

      expect(indexNames).toContain('idx_connection_members_connection')
      expect(indexNames).toContain('idx_connection_members_worktree')
      expect(indexNames).toContain('idx_sessions_connection')
    })
  })

  describe('Connection CRUD', () => {
    test('createConnection returns a connection with generated id and timestamps', () => {
      const conn = db.createConnection({ name: 'test-conn', path: '/tmp/test-conn' })

      expect(conn.id).toBeTruthy()
      expect(conn.name).toBe('test-conn')
      expect(conn.path).toBe('/tmp/test-conn')
      expect(conn.status).toBe('active')
      expect(conn.created_at).toBeTruthy()
      expect(conn.updated_at).toBeTruthy()
    })

    test('getConnection returns null for non-existent id', () => {
      expect(db.getConnection('non-existent')).toBeNull()
    })

    test('getConnection returns connection with empty members array', () => {
      const conn = db.createConnection({ name: 'empty-conn', path: '/tmp/empty' })
      const fetched = db.getConnection(conn.id)

      expect(fetched).not.toBeNull()
      expect(fetched.name).toBe('empty-conn')
      expect(fetched.members).toEqual([])
    })

    test('updateConnection updates name and path', () => {
      const conn = db.createConnection({ name: 'original', path: '/tmp/original' })
      const updated = db.updateConnection(conn.id, { name: 'renamed', path: '/tmp/renamed' })

      expect(updated).not.toBeNull()
      expect(updated.name).toBe('renamed')
      expect(updated.path).toBe('/tmp/renamed')
    })

    test('updateConnection returns null for non-existent id', () => {
      expect(db.updateConnection('non-existent', { name: 'nope' })).toBeNull()
    })

    test('deleteConnection removes the row', () => {
      const conn = db.createConnection({ name: 'to-delete', path: '/tmp/delete' })
      expect(db.deleteConnection(conn.id)).toBe(true)
      expect(db.getConnection(conn.id)).toBeNull()
    })

    test('deleteConnection returns false for non-existent id', () => {
      expect(db.deleteConnection('non-existent')).toBe(false)
    })

    test('getAllConnections returns only active connections', () => {
      db.createConnection({ name: 'active-1', path: '/tmp/a1' })
      db.createConnection({ name: 'active-2', path: '/tmp/a2' })
      const archived = db.createConnection({ name: 'archived', path: '/tmp/arch' })
      db.updateConnection(archived.id, { status: 'archived' })

      const all = db.getAllConnections()
      expect(all.length).toBe(2)
      expect(all.map((c: { name: string }) => c.name).sort()).toEqual(['active-1', 'active-2'])
    })
  })

  describe('ConnectionMember CRUD', () => {
    let projectId: string
    let worktreeId: string
    let connectionId: string

    beforeEach(() => {
      const project = db.createProject({ name: 'Test Project', path: '/project' })
      projectId = project.id

      const worktree = db.createWorktree({
        project_id: projectId,
        name: 'main-wt',
        branch_name: 'main',
        path: '/worktrees/main'
      })
      worktreeId = worktree.id

      const conn = db.createConnection({ name: 'test-conn', path: '/tmp/conn' })
      connectionId = conn.id
    })

    test('createConnectionMember inserts a member row', () => {
      const member = db.createConnectionMember({
        connection_id: connectionId,
        worktree_id: worktreeId,
        project_id: projectId,
        symlink_name: 'test-project'
      })

      expect(member.id).toBeTruthy()
      expect(member.connection_id).toBe(connectionId)
      expect(member.worktree_id).toBe(worktreeId)
      expect(member.project_id).toBe(projectId)
      expect(member.symlink_name).toBe('test-project')
      expect(member.added_at).toBeTruthy()
    })

    test('createConnectionMember fails with invalid connection_id', () => {
      expect(() => {
        db.createConnectionMember({
          connection_id: 'invalid-conn',
          worktree_id: worktreeId,
          project_id: projectId,
          symlink_name: 'test'
        })
      }).toThrow()
    })

    test('createConnectionMember fails with invalid worktree_id', () => {
      expect(() => {
        db.createConnectionMember({
          connection_id: connectionId,
          worktree_id: 'invalid-wt',
          project_id: projectId,
          symlink_name: 'test'
        })
      }).toThrow()
    })

    test('deleteConnectionMember removes the member row', () => {
      db.createConnectionMember({
        connection_id: connectionId,
        worktree_id: worktreeId,
        project_id: projectId,
        symlink_name: 'test-project'
      })

      expect(db.deleteConnectionMember(connectionId, worktreeId)).toBe(true)

      const members = db.getConnectionMembersByWorktree(worktreeId)
      expect(members.length).toBe(0)
    })

    test('getConnectionMembersByWorktree returns members for a worktree', () => {
      const conn2 = db.createConnection({ name: 'conn-2', path: '/tmp/conn2' })

      db.createConnectionMember({
        connection_id: connectionId,
        worktree_id: worktreeId,
        project_id: projectId,
        symlink_name: 'link-1'
      })
      db.createConnectionMember({
        connection_id: conn2.id,
        worktree_id: worktreeId,
        project_id: projectId,
        symlink_name: 'link-2'
      })

      const members = db.getConnectionMembersByWorktree(worktreeId)
      expect(members.length).toBe(2)
    })
  })

  describe('Cascade deletes', () => {
    let projectId: string
    let worktreeId: string
    let worktreeId2: string

    beforeEach(() => {
      const project = db.createProject({ name: 'Cascade Project', path: '/cascade' })
      projectId = project.id

      const wt1 = db.createWorktree({
        project_id: projectId,
        name: 'wt-1',
        branch_name: 'branch-1',
        path: '/worktrees/1'
      })
      worktreeId = wt1.id

      const wt2 = db.createWorktree({
        project_id: projectId,
        name: 'wt-2',
        branch_name: 'branch-2',
        path: '/worktrees/2'
      })
      worktreeId2 = wt2.id
    })

    test('deleting a connection cascades to its members', () => {
      const conn = db.createConnection({ name: 'cascade-conn', path: '/tmp/cascade' })

      db.createConnectionMember({
        connection_id: conn.id,
        worktree_id: worktreeId,
        project_id: projectId,
        symlink_name: 'link-1'
      })
      db.createConnectionMember({
        connection_id: conn.id,
        worktree_id: worktreeId2,
        project_id: projectId,
        symlink_name: 'link-2'
      })

      db.deleteConnection(conn.id)

      const members1 = db.getConnectionMembersByWorktree(worktreeId)
      const members2 = db.getConnectionMembersByWorktree(worktreeId2)
      expect(members1.length).toBe(0)
      expect(members2.length).toBe(0)
    })

    test('deleting a worktree cascades to its connection_members', () => {
      const conn = db.createConnection({ name: 'wt-cascade', path: '/tmp/wtcascade' })

      db.createConnectionMember({
        connection_id: conn.id,
        worktree_id: worktreeId,
        project_id: projectId,
        symlink_name: 'link-1'
      })
      db.createConnectionMember({
        connection_id: conn.id,
        worktree_id: worktreeId2,
        project_id: projectId,
        symlink_name: 'link-2'
      })

      db.deleteWorktree(worktreeId)

      // Connection should still exist
      const fetched = db.getConnection(conn.id)
      expect(fetched).not.toBeNull()
      // Only member for worktreeId2 should remain
      expect(fetched.members.length).toBe(1)
      expect(fetched.members[0].worktree_id).toBe(worktreeId2)
    })
  })

  describe('sessions.connection_id', () => {
    let projectId: string
    let worktreeId: string

    beforeEach(() => {
      const project = db.createProject({ name: 'Session Project', path: '/sess-proj' })
      projectId = project.id

      const wt = db.createWorktree({
        project_id: projectId,
        name: 'sess-wt',
        branch_name: 'main',
        path: '/worktrees/sess'
      })
      worktreeId = wt.id
    })

    test('session can be created with connection_id = null (existing behavior)', () => {
      const session = db.createSession({
        worktree_id: worktreeId,
        project_id: projectId
      })

      expect(session.connection_id).toBeNull()
    })

    test('session can be created with connection_id set', () => {
      const conn = db.createConnection({ name: 'sess-conn', path: '/tmp/sess-conn' })

      const session = db.createSession({
        worktree_id: null,
        project_id: projectId,
        connection_id: conn.id
      })

      expect(session.connection_id).toBe(conn.id)

      // Verify persisted
      const fetched = db.getSession(session.id)
      expect(fetched.connection_id).toBe(conn.id)
    })

    test('deleting a connection sets session connection_id to null', () => {
      const conn = db.createConnection({ name: 'del-conn', path: '/tmp/del-conn' })

      const session = db.createSession({
        worktree_id: null,
        project_id: projectId,
        connection_id: conn.id
      })

      db.deleteConnection(conn.id)

      const fetched = db.getSession(session.id)
      expect(fetched).not.toBeNull()
      expect(fetched.connection_id).toBeNull()
    })

    test('getActiveSessionsByConnection returns active sessions', () => {
      const conn = db.createConnection({ name: 'active-sess', path: '/tmp/active-sess' })

      db.createSession({
        worktree_id: null,
        project_id: projectId,
        connection_id: conn.id
      })
      const completed = db.createSession({
        worktree_id: null,
        project_id: projectId,
        connection_id: conn.id
      })
      db.updateSession(completed.id, { status: 'completed' })

      const active = db.getActiveSessionsByConnection(conn.id)
      expect(active.length).toBe(1)
    })

    test('getSessionsByConnection returns all sessions', () => {
      const conn = db.createConnection({ name: 'all-sess', path: '/tmp/all-sess' })

      db.createSession({
        worktree_id: null,
        project_id: projectId,
        connection_id: conn.id
      })
      const completed = db.createSession({
        worktree_id: null,
        project_id: projectId,
        connection_id: conn.id
      })
      db.updateSession(completed.id, { status: 'completed' })

      const all = db.getSessionsByConnection(conn.id)
      expect(all.length).toBe(2)
    })
  })

  describe('getAllConnections returns enriched member data', () => {
    test('members include worktree and project details', () => {
      const project1 = db.createProject({ name: 'Frontend', path: '/frontend' })
      const project2 = db.createProject({ name: 'Backend', path: '/backend' })

      const wt1 = db.createWorktree({
        project_id: project1.id,
        name: 'fe-main',
        branch_name: 'main',
        path: '/worktrees/fe-main'
      })
      const wt2 = db.createWorktree({
        project_id: project2.id,
        name: 'be-main',
        branch_name: 'develop',
        path: '/worktrees/be-main'
      })

      const conn = db.createConnection({ name: 'full-stack', path: '/tmp/full-stack' })

      db.createConnectionMember({
        connection_id: conn.id,
        worktree_id: wt1.id,
        project_id: project1.id,
        symlink_name: 'frontend'
      })
      db.createConnectionMember({
        connection_id: conn.id,
        worktree_id: wt2.id,
        project_id: project2.id,
        symlink_name: 'backend'
      })

      const connections = db.getAllConnections()
      expect(connections.length).toBe(1)

      const members = connections[0].members
      expect(members.length).toBe(2)

      const feMember = members.find((m: { symlink_name: string }) => m.symlink_name === 'frontend')
      expect(feMember.worktree_name).toBe('fe-main')
      expect(feMember.worktree_branch).toBe('main')
      expect(feMember.worktree_path).toBe('/worktrees/fe-main')
      expect(feMember.project_name).toBe('Frontend')

      const beMember = members.find((m: { symlink_name: string }) => m.symlink_name === 'backend')
      expect(beMember.worktree_name).toBe('be-main')
      expect(beMember.worktree_branch).toBe('develop')
      expect(beMember.worktree_path).toBe('/worktrees/be-main')
      expect(beMember.project_name).toBe('Backend')
    })
  })
})

if (!canRun) {
  describe('Session 1: Connection Schema (skipped)', () => {
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
