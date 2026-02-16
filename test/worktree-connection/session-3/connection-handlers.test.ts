import { describe, test, expect, beforeEach, vi } from 'vitest'

// ---------- hoisted mocks ----------
// We capture the handler callbacks that `ipcMain.handle` registers,
// then invoke them directly in the tests. This lets us verify
// the orchestration logic without actually running Electron.

const handlers = vi.hoisted(() => {
  const map = new Map<string, (...args: unknown[]) => unknown>()
  return map
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    })
  },
  shell: {
    openPath: vi.fn()
  }
}))

vi.mock('child_process', () => ({
  default: { spawn: mockSpawn },
  spawn: mockSpawn
}))

const mockExistsSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => true))
const mockSpawn = vi.hoisted(() => vi.fn())
const mockPlatform = vi.hoisted(() => vi.fn(() => 'darwin'))

vi.mock('fs', () => ({
  default: { existsSync: mockExistsSync },
  existsSync: mockExistsSync
}))

vi.mock('os', () => ({
  default: { platform: mockPlatform },
  platform: mockPlatform
}))

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>()
  return { ...actual }
})

// Mock the connection service
const mockConnectionService = vi.hoisted(() => ({
  createConnectionDir: vi.fn(() => '/mock/.hive/connections/golden-retriever'),
  createSymlink: vi.fn(),
  removeSymlink: vi.fn(),
  deleteConnectionDir: vi.fn(),
  generateAgentsMd: vi.fn(),
  deriveSymlinkName: vi.fn((name: string) => name.toLowerCase().replace(/[^a-z0-9-]/g, '-')),
  renameConnectionDir: vi.fn(),
  getConnectionsBaseDir: vi.fn(() => '/mock/.hive/connections')
}))

vi.mock('../../../src/main/services/connection-service', () => mockConnectionService)

// Mock breed names
vi.mock('../../../src/main/services/breed-names', () => ({
  selectUniqueBreedName: vi.fn(() => 'golden-retriever')
}))

// Mock the logger
vi.mock('../../../src/main/services', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

// ---------- Database mock ----------
/* eslint-disable @typescript-eslint/no-explicit-any */
const mockDb = vi.hoisted(() => ({
  getAllConnections: vi.fn((..._args: any[]): any[] => []),
  getConnection: vi.fn((..._args: any[]): any => null),
  createConnection: vi.fn((..._args: any[]): any => null),
  deleteConnection: vi.fn((..._args: any[]): boolean => true),
  updateConnection: vi.fn((..._args: any[]): any => null),
  createConnectionMember: vi.fn((..._args: any[]): any => null),
  deleteConnectionMember: vi.fn((..._args: any[]): boolean => true),
  getConnectionMembersByWorktree: vi.fn((..._args: any[]): any[] => []),
  getWorktree: vi.fn((..._args: any[]): any => null),
  getProject: vi.fn((..._args: any[]): any => null),
  getSetting: vi.fn((..._args: any[]): any => null)
}))
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock('../../../src/main/db', () => ({
  getDatabase: vi.fn(() => mockDb)
}))

// ---------- Import under test (triggers handler registration) ----------
import { registerConnectionHandlers } from '../../../src/main/ipc/connection-handlers'

// Helper to call a registered handler
function callHandler<T>(channel: string, ...args: unknown[]): T {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for channel: ${channel}`)
  // ipcMain.handle passes (_event, ...params) -- we pass null as event
  return handler(null, ...args) as T
}

// ---------- Test fixtures ----------
function makeWorktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wt-1',
    project_id: 'proj-1',
    name: 'golden-retriever',
    branch_name: 'golden-retriever',
    path: '/repos/frontend/golden-retriever',
    status: 'active',
    ...overrides
  }
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    name: 'Frontend',
    path: '/repos/frontend',
    ...overrides
  }
}

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    name: 'golden-retriever',
    path: '/mock/.hive/connections/golden-retriever',
    status: 'active',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    members: [],
    ...overrides
  }
}

function makeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-1',
    connection_id: 'conn-1',
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    symlink_name: 'frontend',
    added_at: '2025-01-01T00:00:00.000Z',
    worktree_name: 'golden-retriever',
    worktree_branch: 'golden-retriever',
    worktree_path: '/repos/frontend/golden-retriever',
    project_name: 'Frontend',
    ...overrides
  }
}

describe('Session 3: Connection IPC Handlers', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerConnectionHandlers()
  })

  test('all expected handlers are registered', () => {
    const expectedChannels = [
      'connection:create',
      'connection:delete',
      'connection:addMember',
      'connection:removeMember',
      'connection:rename',
      'connection:getAll',
      'connection:get',
      'connection:openInTerminal',
      'connection:openInEditor',
      'connection:removeWorktreeFromAll'
    ]
    for (const ch of expectedChannels) {
      expect(handlers.has(ch), `Handler missing: ${ch}`).toBe(true)
    }
  })

  describe('connection:create', () => {
    test('creates dir, symlinks, AGENTS.md, and DB rows', async () => {
      const wt1 = makeWorktree({ id: 'wt-1', project_id: 'proj-1' })
      const wt2 = makeWorktree({
        id: 'wt-2',
        project_id: 'proj-2',
        path: '/repos/backend/labrador'
      })
      const proj1 = makeProject({ id: 'proj-1', name: 'Frontend' })
      const proj2 = makeProject({ id: 'proj-2', name: 'Backend', path: '/repos/backend' })

      mockDb.getWorktree.mockImplementation((id: string) => {
        if (id === 'wt-1') return wt1
        if (id === 'wt-2') return wt2
        return null
      })
      mockDb.getProject.mockImplementation((id: string) => {
        if (id === 'proj-1') return proj1
        if (id === 'proj-2') return proj2
        return null
      })
      mockDb.createConnection.mockReturnValue({
        id: 'conn-new',
        name: 'golden-retriever',
        path: '/mock/.hive/connections/golden-retriever',
        status: 'active',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z'
      })
      mockDb.createConnectionMember.mockReturnValue({ id: 'mem-auto' })

      const enriched = makeConnection({
        id: 'conn-new',
        members: [
          makeMember({ connection_id: 'conn-new', symlink_name: 'frontend' }),
          makeMember({
            connection_id: 'conn-new',
            worktree_id: 'wt-2',
            symlink_name: 'backend',
            project_name: 'Backend'
          })
        ]
      })
      mockDb.getConnection.mockReturnValue(enriched)

      const result = await callHandler<{
        success: boolean
        connection?: unknown
      }>('connection:create', { worktreeIds: ['wt-1', 'wt-2'] })

      expect(result.success).toBe(true)
      expect(result.connection).toBeTruthy()

      // Dir created
      expect(mockConnectionService.createConnectionDir).toHaveBeenCalledWith('golden-retriever')

      // Symlinks created for each worktree
      expect(mockConnectionService.createSymlink).toHaveBeenCalledTimes(2)

      // AGENTS.md generated
      expect(mockConnectionService.generateAgentsMd).toHaveBeenCalledTimes(1)

      // DB rows
      expect(mockDb.createConnection).toHaveBeenCalledWith({
        name: 'golden-retriever',
        path: '/mock/.hive/connections/golden-retriever'
      })
      expect(mockDb.createConnectionMember).toHaveBeenCalledTimes(2)
    })

    test('skips worktrees that are not found', async () => {
      mockDb.getWorktree.mockReturnValue(null)
      mockDb.createConnection.mockReturnValue({
        id: 'conn-new',
        name: 'golden-retriever',
        path: '/mock/.hive/connections/golden-retriever',
        status: 'active',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z'
      })
      mockDb.getConnection.mockReturnValue(makeConnection({ id: 'conn-new' }))

      const result = await callHandler<{
        success: boolean
      }>('connection:create', { worktreeIds: ['nonexistent'] })

      expect(result.success).toBe(true)
      expect(mockConnectionService.createSymlink).not.toHaveBeenCalled()
      expect(mockDb.createConnectionMember).not.toHaveBeenCalled()
    })

    test('returns error on exception', async () => {
      mockDb.getAllConnections.mockImplementation(() => {
        throw new Error('DB exploded')
      })

      const result = await callHandler<{
        success: boolean
        error?: string
      }>('connection:create', { worktreeIds: ['wt-1'] })

      expect(result.success).toBe(false)
      expect(result.error).toBe('DB exploded')
    })
  })

  describe('connection:delete', () => {
    test('removes directory and DB row', async () => {
      const conn = makeConnection()
      mockDb.getConnection.mockReturnValue(conn)

      const result = await callHandler<{
        success: boolean
      }>('connection:delete', { connectionId: 'conn-1' })

      expect(result.success).toBe(true)
      expect(mockConnectionService.deleteConnectionDir).toHaveBeenCalledWith(conn.path)
      expect(mockDb.deleteConnection).toHaveBeenCalledWith('conn-1')
    })

    test('returns error when connection not found', async () => {
      mockDb.getConnection.mockReturnValue(null)

      const result = await callHandler<{
        success: boolean
        error?: string
      }>('connection:delete', { connectionId: 'missing' })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Connection not found')
    })
  })

  describe('connection:addMember', () => {
    test('creates symlink, inserts member, and regenerates AGENTS.md', async () => {
      const conn = makeConnection({
        members: [makeMember({ symlink_name: 'frontend' })]
      })
      const wt = makeWorktree({ id: 'wt-2', project_id: 'proj-2' })
      const proj = makeProject({ id: 'proj-2', name: 'Backend' })

      // First call for initial lookup, second call after member added (for AGENTS.md regen)
      mockDb.getConnection.mockReturnValueOnce(conn).mockReturnValueOnce({
        ...conn,
        members: [
          ...conn.members,
          makeMember({
            worktree_id: 'wt-2',
            symlink_name: 'backend',
            project_name: 'Backend'
          })
        ]
      })
      mockDb.getWorktree.mockReturnValue(wt)
      mockDb.getProject.mockReturnValue(proj)
      mockDb.createConnectionMember.mockReturnValue({
        id: 'mem-new',
        connection_id: 'conn-1',
        worktree_id: 'wt-2',
        project_id: 'proj-2',
        symlink_name: 'backend',
        added_at: '2025-01-01T00:00:00.000Z'
      })
      mockConnectionService.deriveSymlinkName.mockReturnValue('backend')

      const result = await callHandler<{
        success: boolean
        member?: unknown
      }>('connection:addMember', { connectionId: 'conn-1', worktreeId: 'wt-2' })

      expect(result.success).toBe(true)
      expect(result.member).toBeTruthy()

      expect(mockConnectionService.createSymlink).toHaveBeenCalledWith(
        wt.path,
        '/mock/.hive/connections/golden-retriever/backend'
      )
      expect(mockDb.createConnectionMember).toHaveBeenCalledWith({
        connection_id: 'conn-1',
        worktree_id: 'wt-2',
        project_id: 'proj-2',
        symlink_name: 'backend'
      })
      expect(mockConnectionService.generateAgentsMd).toHaveBeenCalled()
    })

    test('returns error when worktree not found', async () => {
      mockDb.getConnection.mockReturnValue(makeConnection())
      mockDb.getWorktree.mockReturnValue(null)

      const result = await callHandler<{
        success: boolean
        error?: string
      }>('connection:addMember', { connectionId: 'conn-1', worktreeId: 'missing' })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Worktree not found')
    })
  })

  describe('connection:removeMember', () => {
    test('removes symlink, deletes member, regenerates AGENTS.md', async () => {
      const member1 = makeMember({ worktree_id: 'wt-1', symlink_name: 'frontend' })
      const member2 = makeMember({
        id: 'mem-2',
        worktree_id: 'wt-2',
        symlink_name: 'backend'
      })
      const conn = makeConnection({ members: [member1, member2] })

      // First call: initial lookup; second call: after removal (still has 1 member)
      mockDb.getConnection
        .mockReturnValueOnce(conn)
        .mockReturnValueOnce(makeConnection({ members: [member2] }))

      const result = await callHandler<{
        success: boolean
        connectionDeleted?: boolean
      }>('connection:removeMember', { connectionId: 'conn-1', worktreeId: 'wt-1' })

      expect(result.success).toBe(true)
      expect(result.connectionDeleted).toBe(false)
      expect(mockConnectionService.removeSymlink).toHaveBeenCalledWith(
        '/mock/.hive/connections/golden-retriever/frontend'
      )
      expect(mockDb.deleteConnectionMember).toHaveBeenCalledWith('conn-1', 'wt-1')
      expect(mockConnectionService.generateAgentsMd).toHaveBeenCalled()
    })

    test('deletes connection when last member removed', async () => {
      const member = makeMember({ worktree_id: 'wt-1', symlink_name: 'frontend' })
      const conn = makeConnection({ members: [member] })

      // First call: connection with 1 member; second call: connection with 0 members (or null)
      mockDb.getConnection
        .mockReturnValueOnce(conn)
        .mockReturnValueOnce(makeConnection({ members: [] }))

      const result = await callHandler<{
        success: boolean
        connectionDeleted?: boolean
      }>('connection:removeMember', { connectionId: 'conn-1', worktreeId: 'wt-1' })

      expect(result.success).toBe(true)
      expect(result.connectionDeleted).toBe(true)
      expect(mockConnectionService.deleteConnectionDir).toHaveBeenCalledWith(conn.path)
      expect(mockDb.deleteConnection).toHaveBeenCalledWith('conn-1')
    })

    test('returns error when member not found in connection', async () => {
      mockDb.getConnection.mockReturnValue(makeConnection({ members: [] }))

      const result = await callHandler<{
        success: boolean
        error?: string
      }>('connection:removeMember', { connectionId: 'conn-1', worktreeId: 'missing' })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Member not found in connection')
    })
  })

  describe('connection:rename', () => {
    test('renames folder on disk and updates DB', async () => {
      mockDb.getConnection.mockReturnValue(makeConnection())

      const result = await callHandler<{
        success: boolean
      }>('connection:rename', { connectionId: 'conn-1', name: 'labrador' })

      expect(result.success).toBe(true)
      expect(mockConnectionService.renameConnectionDir).toHaveBeenCalledWith(
        '/mock/.hive/connections/golden-retriever',
        '/mock/.hive/connections/labrador'
      )
      expect(mockDb.updateConnection).toHaveBeenCalledWith('conn-1', {
        name: 'labrador',
        path: '/mock/.hive/connections/labrador'
      })
    })

    test('returns error when connection not found', async () => {
      mockDb.getConnection.mockReturnValue(null)

      const result = await callHandler<{
        success: boolean
        error?: string
      }>('connection:rename', { connectionId: 'missing', name: 'labrador' })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Connection not found')
    })
  })

  describe('connection:getAll', () => {
    test('returns all active connections with enriched members', async () => {
      const connections = [
        makeConnection({ id: 'conn-1', members: [makeMember()] }),
        makeConnection({ id: 'conn-2', name: 'labrador', members: [] })
      ]
      mockDb.getAllConnections.mockReturnValue(connections)

      const result = await callHandler<{
        success: boolean
        connections?: unknown[]
      }>('connection:getAll')

      expect(result.success).toBe(true)
      expect(result.connections).toHaveLength(2)
    })
  })

  describe('connection:get', () => {
    test('returns a single connection with enriched members', async () => {
      const conn = makeConnection({ members: [makeMember()] })
      mockDb.getConnection.mockReturnValue(conn)

      const result = await callHandler<{
        success: boolean
        connection?: unknown
      }>('connection:get', { connectionId: 'conn-1' })

      expect(result.success).toBe(true)
      expect(result.connection).toEqual(conn)
    })

    test('returns error when not found', async () => {
      mockDb.getConnection.mockReturnValue(null)

      const result = await callHandler<{
        success: boolean
        error?: string
      }>('connection:get', { connectionId: 'missing' })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Connection not found')
    })
  })

  describe('connection:openInTerminal', () => {
    test('spawns terminal when directory exists', async () => {
      mockExistsSync.mockReturnValue(true)

      const result = await callHandler<{
        success: boolean
      }>('connection:openInTerminal', { connectionPath: '/some/path' })

      expect(result.success).toBe(true)
      expect(mockSpawn).toHaveBeenCalledWith('open', ['-a', 'Terminal', '/some/path'], {
        detached: true
      })
    })

    test('returns error when directory does not exist', async () => {
      mockExistsSync.mockReturnValue(false)

      const result = await callHandler<{
        success: boolean
        error?: string
      }>('connection:openInTerminal', { connectionPath: '/missing/path' })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Connection directory does not exist')
    })
  })

  describe('connection:openInEditor', () => {
    test('spawns VS Code when directory exists', async () => {
      mockExistsSync.mockReturnValue(true)

      const result = await callHandler<{
        success: boolean
      }>('connection:openInEditor', { connectionPath: '/some/path' })

      expect(result.success).toBe(true)
      expect(mockSpawn).toHaveBeenCalled()
    })

    test('returns error when directory does not exist', async () => {
      mockExistsSync.mockReturnValue(false)

      const result = await callHandler<{
        success: boolean
        error?: string
      }>('connection:openInEditor', { connectionPath: '/missing/path' })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Connection directory does not exist')
    })
  })

  describe('connection:removeWorktreeFromAll', () => {
    test('removes worktree from all connections it belongs to', async () => {
      const membership1 = { connection_id: 'conn-1', worktree_id: 'wt-1' }
      const membership2 = { connection_id: 'conn-2', worktree_id: 'wt-1' }

      mockDb.getConnectionMembersByWorktree.mockReturnValue([membership1, membership2])

      // conn-1 has 2 members (will survive), conn-2 has 1 member (will be deleted)
      const member1A = makeMember({
        connection_id: 'conn-1',
        worktree_id: 'wt-1',
        symlink_name: 'frontend'
      })
      const member1B = makeMember({
        connection_id: 'conn-1',
        worktree_id: 'wt-2',
        symlink_name: 'backend'
      })
      const member2A = makeMember({
        connection_id: 'conn-2',
        worktree_id: 'wt-1',
        symlink_name: 'frontend'
      })

      const conn1 = makeConnection({
        id: 'conn-1',
        members: [member1A, member1B]
      })
      const conn2 = makeConnection({
        id: 'conn-2',
        name: 'labrador',
        path: '/mock/.hive/connections/labrador',
        members: [member2A]
      })

      // getConnection is called multiple times:
      // 1st call: conn-1 (before removal)
      // 2nd call: conn-1 after removal (still has 1 member)
      // 3rd call: conn-2 (before removal)
      // 4th call: conn-2 after removal (0 members)
      mockDb.getConnection
        .mockReturnValueOnce(conn1) // lookup conn-1
        .mockReturnValueOnce(makeConnection({ id: 'conn-1', members: [member1B] })) // after removal
        .mockReturnValueOnce(conn2) // lookup conn-2
        .mockReturnValueOnce(makeConnection({ id: 'conn-2', members: [] })) // after removal

      const result = await callHandler<{
        success: boolean
      }>('connection:removeWorktreeFromAll', { worktreeId: 'wt-1' })

      expect(result.success).toBe(true)

      // Symlinks removed from both connections
      expect(mockConnectionService.removeSymlink).toHaveBeenCalledTimes(2)

      // Member rows deleted from both connections
      expect(mockDb.deleteConnectionMember).toHaveBeenCalledWith('conn-1', 'wt-1')
      expect(mockDb.deleteConnectionMember).toHaveBeenCalledWith('conn-2', 'wt-1')

      // conn-1 survived (still has members) -- AGENTS.md regenerated
      expect(mockConnectionService.generateAgentsMd).toHaveBeenCalledTimes(1)

      // conn-2 was deleted (last member removed)
      expect(mockConnectionService.deleteConnectionDir).toHaveBeenCalledWith(conn2.path)
      expect(mockDb.deleteConnection).toHaveBeenCalledWith('conn-2')
    })

    test('does nothing when worktree has no connections', async () => {
      mockDb.getConnectionMembersByWorktree.mockReturnValue([])

      const result = await callHandler<{
        success: boolean
      }>('connection:removeWorktreeFromAll', { worktreeId: 'wt-orphan' })

      expect(result.success).toBe(true)
      expect(mockConnectionService.removeSymlink).not.toHaveBeenCalled()
      expect(mockDb.deleteConnectionMember).not.toHaveBeenCalled()
    })

    test('returns error on exception', async () => {
      mockDb.getConnectionMembersByWorktree.mockImplementation(() => {
        throw new Error('Query failed')
      })

      const result = await callHandler<{
        success: boolean
        error?: string
      }>('connection:removeWorktreeFromAll', { worktreeId: 'wt-1' })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Query failed')
    })
  })
})
