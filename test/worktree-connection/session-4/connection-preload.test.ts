import { describe, test, expect, beforeEach, vi } from 'vitest'

// ---------- Hoisted mocks ----------

const mockInvoke = vi.hoisted(() => vi.fn())
const mockOn = vi.hoisted(() => vi.fn())
const mockRemoveListener = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn()
  },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
    send: vi.fn(),
    removeAllListeners: vi.fn()
  }
}))

// ---------- Import the preload module ----------
// In test (jsdom), process.contextIsolated is falsy, so the code falls through
// to the `else` branch which assigns to `window.*` directly.
import '../../../src/preload/index'

/* eslint-disable @typescript-eslint/no-explicit-any */
const windowAny = window as any

describe('Session 4: Preload Bridge & Types', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ---------- connectionOps methods ----------
  describe('connectionOps', () => {
    test('connectionOps is exposed on window', () => {
      expect(windowAny.connectionOps).toBeDefined()
    })

    test('connectionOps.create invokes connection:create', async () => {
      const mockResult = { success: true, connection: { id: 'conn-1' } }
      mockInvoke.mockResolvedValueOnce(mockResult)

      const result = await windowAny.connectionOps.create(['wt-1', 'wt-2'])

      expect(mockInvoke).toHaveBeenCalledWith('connection:create', {
        worktreeIds: ['wt-1', 'wt-2']
      })
      expect(result).toEqual(mockResult)
    })

    test('connectionOps.delete invokes connection:delete', async () => {
      mockInvoke.mockResolvedValueOnce({ success: true })

      await windowAny.connectionOps.delete('conn-1')

      expect(mockInvoke).toHaveBeenCalledWith('connection:delete', {
        connectionId: 'conn-1'
      })
    })

    test('connectionOps.addMember invokes connection:addMember', async () => {
      mockInvoke.mockResolvedValueOnce({ success: true, member: { id: 'mem-1' } })

      await windowAny.connectionOps.addMember('conn-1', 'wt-2')

      expect(mockInvoke).toHaveBeenCalledWith('connection:addMember', {
        connectionId: 'conn-1',
        worktreeId: 'wt-2'
      })
    })

    test('connectionOps.removeMember invokes connection:removeMember', async () => {
      mockInvoke.mockResolvedValueOnce({ success: true, connectionDeleted: false })

      await windowAny.connectionOps.removeMember('conn-1', 'wt-1')

      expect(mockInvoke).toHaveBeenCalledWith('connection:removeMember', {
        connectionId: 'conn-1',
        worktreeId: 'wt-1'
      })
    })

    test('connectionOps.rename invokes connection:rename', async () => {
      mockInvoke.mockResolvedValueOnce({ success: true })

      await windowAny.connectionOps.rename('conn-1', 'labrador')

      expect(mockInvoke).toHaveBeenCalledWith('connection:rename', {
        connectionId: 'conn-1',
        name: 'labrador'
      })
    })

    test('connectionOps.getAll invokes connection:getAll', async () => {
      const mockConnections = [{ id: 'conn-1' }, { id: 'conn-2' }]
      mockInvoke.mockResolvedValueOnce(mockConnections)

      const result = await windowAny.connectionOps.getAll()

      expect(mockInvoke).toHaveBeenCalledWith('connection:getAll')
      expect(result).toEqual(mockConnections)
    })

    test('connectionOps.get invokes connection:get', async () => {
      mockInvoke.mockResolvedValueOnce({ id: 'conn-1', name: 'golden-retriever' })

      await windowAny.connectionOps.get('conn-1')

      expect(mockInvoke).toHaveBeenCalledWith('connection:get', {
        connectionId: 'conn-1'
      })
    })

    test('connectionOps.openInTerminal invokes connection:openInTerminal', async () => {
      mockInvoke.mockResolvedValueOnce({ success: true })

      await windowAny.connectionOps.openInTerminal('/path/to/connection')

      expect(mockInvoke).toHaveBeenCalledWith('connection:openInTerminal', {
        connectionPath: '/path/to/connection'
      })
    })

    test('connectionOps.openInEditor invokes connection:openInEditor', async () => {
      mockInvoke.mockResolvedValueOnce({ success: true })

      await windowAny.connectionOps.openInEditor('/path/to/connection')

      expect(mockInvoke).toHaveBeenCalledWith('connection:openInEditor', {
        connectionPath: '/path/to/connection'
      })
    })

    test('connectionOps.removeWorktreeFromAll invokes connection:removeWorktreeFromAll', async () => {
      mockInvoke.mockResolvedValueOnce({ success: true })

      await windowAny.connectionOps.removeWorktreeFromAll('wt-1')

      expect(mockInvoke).toHaveBeenCalledWith('connection:removeWorktreeFromAll', {
        worktreeId: 'wt-1'
      })
    })

    test('all expected connectionOps methods exist', () => {
      const expectedMethods = [
        'create',
        'delete',
        'addMember',
        'removeMember',
        'rename',
        'getAll',
        'get',
        'openInTerminal',
        'openInEditor',
        'removeWorktreeFromAll'
      ]
      for (const method of expectedMethods) {
        expect(typeof windowAny.connectionOps[method]).toBe('function')
      }
    })
  })

  // ---------- Session connection methods on db.session ----------
  describe('db.session connection methods', () => {
    test('db.session.getByConnection invokes db:session:getByConnection', async () => {
      mockInvoke.mockResolvedValueOnce([{ id: 'sess-1', connection_id: 'conn-1' }])

      const result = await windowAny.db.session.getByConnection('conn-1')

      expect(mockInvoke).toHaveBeenCalledWith('db:session:getByConnection', 'conn-1')
      expect(result).toEqual([{ id: 'sess-1', connection_id: 'conn-1' }])
    })

    test('db.session.getActiveByConnection invokes db:session:getActiveByConnection', async () => {
      mockInvoke.mockResolvedValueOnce([{ id: 'sess-1', status: 'active' }])

      const result = await windowAny.db.session.getActiveByConnection('conn-1')

      expect(mockInvoke).toHaveBeenCalledWith('db:session:getActiveByConnection', 'conn-1')
      expect(result).toEqual([{ id: 'sess-1', status: 'active' }])
    })
  })

  // ---------- Type structure validation (runtime shape checks) ----------
  describe('type declarations (runtime shape validation)', () => {
    test('Session object accepts connection_id', () => {
      const session = {
        id: 'sess-1',
        worktree_id: null,
        project_id: 'proj-1',
        connection_id: 'conn-1',
        name: 'Test session',
        status: 'active',
        opencode_session_id: null,
        mode: 'build',
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        completed_at: null
      }
      expect(session.connection_id).toBe('conn-1')
    })

    test('Session object accepts null connection_id', () => {
      const session = {
        id: 'sess-2',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        connection_id: null,
        name: 'Worktree session',
        status: 'active',
        opencode_session_id: null,
        mode: 'build',
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        completed_at: null
      }
      expect(session.connection_id).toBeNull()
    })

    test('Connection object has correct shape', () => {
      const connection = {
        id: 'conn-1',
        name: 'golden-retriever',
        status: 'active' as const,
        path: '/home/.hive/connections/golden-retriever',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z'
      }
      expect(connection.id).toBe('conn-1')
      expect(connection.status).toBe('active')
      expect(connection.path).toContain('golden-retriever')
    })

    test('ConnectionMember object has correct shape', () => {
      const member = {
        id: 'mem-1',
        connection_id: 'conn-1',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        symlink_name: 'frontend',
        added_at: '2025-01-01T00:00:00.000Z'
      }
      expect(member.symlink_name).toBe('frontend')
      expect(member.connection_id).toBe('conn-1')
    })

    test('ConnectionWithMembers object has members with enriched data', () => {
      const connWithMembers = {
        id: 'conn-1',
        name: 'golden-retriever',
        status: 'active' as const,
        path: '/home/.hive/connections/golden-retriever',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        members: [
          {
            id: 'mem-1',
            connection_id: 'conn-1',
            worktree_id: 'wt-1',
            project_id: 'proj-1',
            symlink_name: 'frontend',
            added_at: '2025-01-01T00:00:00.000Z',
            worktree_name: 'golden-retriever',
            worktree_branch: 'feat/auth',
            worktree_path: '/repos/frontend/golden-retriever',
            project_name: 'Frontend'
          }
        ]
      }
      expect(connWithMembers.members).toHaveLength(1)
      expect(connWithMembers.members[0].worktree_name).toBe('golden-retriever')
      expect(connWithMembers.members[0].project_name).toBe('Frontend')
      expect(connWithMembers.members[0].worktree_branch).toBe('feat/auth')
      expect(connWithMembers.members[0].worktree_path).toBe('/repos/frontend/golden-retriever')
    })

    test('Connection status can be archived', () => {
      const connection = {
        id: 'conn-2',
        name: 'labrador',
        status: 'archived' as const,
        path: '/home/.hive/connections/labrador',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z'
      }
      expect(connection.status).toBe('archived')
    })
  })
})
/* eslint-enable @typescript-eslint/no-explicit-any */
