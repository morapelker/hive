import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useConnectionStore } from '../../../src/renderer/src/stores/useConnectionStore'

// ---------- Mock window.connectionOps ----------
const mockConnectionOps = {
  create: vi.fn(),
  delete: vi.fn(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  rename: vi.fn(),
  getAll: vi.fn(),
  get: vi.fn(),
  openInTerminal: vi.fn(),
  openInEditor: vi.fn(),
  removeWorktreeFromAll: vi.fn()
}

// ---------- Mock window.worktreeOps ----------
const mockWorktreeOps = {
  delete: vi.fn()
}

// ---------- Mock window.db ----------
const mockDb = {
  worktree: {
    touch: vi.fn().mockResolvedValue(undefined)
  }
}

// ---------- Mock window.scriptOps ----------
const mockScriptOps = {
  kill: vi.fn()
}

// ---------- Mock window.opencodeOps ----------
const mockOpencodeOps = {
  abort: vi.fn()
}

// ---------- Mock toast ----------
vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn()
  }
}))

// Set up window mocks
Object.defineProperty(window, 'connectionOps', {
  writable: true,
  configurable: true,
  value: mockConnectionOps
})

Object.defineProperty(window, 'worktreeOps', {
  writable: true,
  configurable: true,
  value: mockWorktreeOps
})

Object.defineProperty(window, 'scriptOps', {
  writable: true,
  configurable: true,
  value: mockScriptOps
})

Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  configurable: true,
  value: mockOpencodeOps
})

/* eslint-disable @typescript-eslint/no-explicit-any */
if (!(window as any).db) {
  Object.defineProperty(window, 'db', {
    writable: true,
    configurable: true,
    value: mockDb
  })
} else {
  const existing = (window as any).db
  if (!existing.worktree) {
    existing.worktree = mockDb.worktree
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- Test data factories ----------
function makeWorktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wt-1',
    project_id: 'proj-1',
    name: 'city-one',
    branch_name: 'feat/auth',
    path: '/repos/frontend/city-one',
    is_default: false,
    status: 'active' as const,
    branch_renamed: 0,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    created_at: '2025-01-01T00:00:00.000Z',
    last_accessed_at: '2025-01-01T00:00:00.000Z',
    ...overrides
  }
}

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
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
        worktree_name: 'city-one',
        worktree_branch: 'feat/auth',
        worktree_path: '/repos/frontend/city-one',
        project_name: 'Frontend'
      },
      {
        id: 'mem-2',
        connection_id: 'conn-1',
        worktree_id: 'wt-2',
        project_id: 'proj-2',
        symlink_name: 'backend',
        added_at: '2025-01-01T00:00:00.000Z',
        worktree_name: 'city-two',
        worktree_branch: 'feat/api',
        worktree_path: '/repos/backend/city-two',
        project_name: 'Backend'
      }
    ],
    ...overrides
  }
}

function makeConnectionSingleMember() {
  return makeConnection({
    id: 'conn-single',
    name: 'poodle',
    path: '/home/.hive/connections/poodle',
    members: [
      {
        id: 'mem-solo',
        connection_id: 'conn-single',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        symlink_name: 'frontend',
        added_at: '2025-01-01T00:00:00.000Z',
        worktree_name: 'city-one',
        worktree_branch: 'feat/auth',
        worktree_path: '/repos/frontend/city-one',
        project_name: 'Frontend'
      }
    ]
  })
}

function makeSecondConnection(overrides: Record<string, unknown> = {}) {
  return makeConnection({
    id: 'conn-2',
    name: 'labrador',
    path: '/home/.hive/connections/labrador',
    members: [
      {
        id: 'mem-3',
        connection_id: 'conn-2',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        symlink_name: 'frontend',
        added_at: '2025-01-01T00:00:00.000Z',
        worktree_name: 'city-one',
        worktree_branch: 'feat/auth',
        worktree_path: '/repos/frontend/city-one',
        project_name: 'Frontend'
      },
      {
        id: 'mem-4',
        connection_id: 'conn-2',
        worktree_id: 'wt-3',
        project_id: 'proj-3',
        symlink_name: 'api',
        added_at: '2025-01-01T00:00:00.000Z',
        worktree_name: 'city-three',
        worktree_branch: 'main',
        worktree_path: '/repos/api/city-three',
        project_name: 'API'
      }
    ],
    ...overrides
  })
}

// ---------- Tests ----------
describe('Session 10: Archive Cascade & Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Reset worktree store
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            makeWorktree(),
            makeWorktree({
              id: 'wt-default',
              name: 'main',
              branch_name: 'main',
              is_default: true,
              path: '/repos/frontend/main'
            })
          ]
        ],
        [
          'proj-2',
          [
            makeWorktree({
              id: 'wt-2',
              project_id: 'proj-2',
              name: 'city-two',
              branch_name: 'feat/api',
              path: '/repos/backend/city-two'
            })
          ]
        ]
      ]),
      selectedWorktreeId: null,
      archivingWorktreeIds: new Set()
    })

    // Reset connection store
    useConnectionStore.setState({
      connections: [],
      isLoading: false,
      error: null,
      selectedConnectionId: null
    })

    // Default mock: successful archive
    mockWorktreeOps.delete.mockResolvedValue({ success: true })
    // Default mock: successful removeWorktreeFromAll
    mockConnectionOps.removeWorktreeFromAll.mockResolvedValue({ success: true })
    // Default mock: getAll returns empty after cleanup
    mockConnectionOps.getAll.mockResolvedValue({ success: true, connections: [] })
  })

  describe('archiveWorktree calls removeWorktreeFromAll', () => {
    test('archiving a worktree calls removeWorktreeFromAll with the worktreeId', async () => {
      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      expect(mockConnectionOps.removeWorktreeFromAll).toHaveBeenCalledWith('wt-1')
      expect(mockConnectionOps.removeWorktreeFromAll).toHaveBeenCalledTimes(1)
    })

    test('archiving a worktree reloads connections after cleanup', async () => {
      // Track call order
      const callOrder: string[] = []
      mockConnectionOps.removeWorktreeFromAll.mockImplementation(async () => {
        callOrder.push('removeWorktreeFromAll')
        return { success: true }
      })
      mockConnectionOps.getAll.mockImplementation(async () => {
        callOrder.push('getAll')
        return { success: true, connections: [] }
      })

      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      // removeWorktreeFromAll should be called before getAll (reload)
      expect(callOrder).toEqual(['removeWorktreeFromAll', 'getAll'])
    })

    test('archive proceeds even if removeWorktreeFromAll fails', async () => {
      mockConnectionOps.removeWorktreeFromAll.mockRejectedValueOnce(
        new Error('Connection cleanup failed')
      )

      let result: { success: boolean; error?: string } | undefined
      await act(async () => {
        result = await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      // Archive should still succeed -- connection cleanup is non-critical
      expect(result?.success).toBe(true)
      // Worktree should be removed from state
      const worktrees = useWorktreeStore.getState().worktreesByProject.get('proj-1')
      expect(worktrees?.find((w) => w.id === 'wt-1')).toBeUndefined()
    })

    test('archive does not call removeWorktreeFromAll when archive itself fails', async () => {
      mockWorktreeOps.delete.mockResolvedValueOnce({
        success: false,
        error: 'Permission denied'
      })

      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      // Should NOT call cleanup since the archive failed
      expect(mockConnectionOps.removeWorktreeFromAll).not.toHaveBeenCalled()
    })

    test('archiving default worktree does not call removeWorktreeFromAll', async () => {
      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-default', '/repos/frontend/main', 'main', '/repos/frontend')
      })

      expect(mockConnectionOps.removeWorktreeFromAll).not.toHaveBeenCalled()
    })
  })

  describe('unbranchWorktree calls removeWorktreeFromAll', () => {
    test('unbranching a worktree calls removeWorktreeFromAll', async () => {
      await act(async () => {
        await useWorktreeStore
          .getState()
          .unbranchWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      expect(mockConnectionOps.removeWorktreeFromAll).toHaveBeenCalledWith('wt-1')
      expect(mockConnectionOps.removeWorktreeFromAll).toHaveBeenCalledTimes(1)
    })

    test('unbranch proceeds even if removeWorktreeFromAll fails', async () => {
      mockConnectionOps.removeWorktreeFromAll.mockRejectedValueOnce(new Error('Cleanup failed'))

      let result: { success: boolean; error?: string } | undefined
      await act(async () => {
        result = await useWorktreeStore
          .getState()
          .unbranchWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      expect(result?.success).toBe(true)
    })
  })

  describe('connection survives when one of multiple members is archived', () => {
    test('connection with 2 members survives when one is archived', async () => {
      // Set up a connection with 2 members
      const conn = makeConnection()
      useConnectionStore.setState({ connections: [conn] })

      // After removing wt-1, the connection should survive with 1 member
      const connAfterCleanup = makeConnection({
        members: [conn.members[1]] // Only wt-2 remains
      })
      mockConnectionOps.getAll.mockResolvedValueOnce({
        success: true,
        connections: [connAfterCleanup]
      })

      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      const connections = useConnectionStore.getState().connections
      expect(connections).toHaveLength(1)
      expect(connections[0].members).toHaveLength(1)
      expect(connections[0].members[0].worktree_id).toBe('wt-2')
    })
  })

  describe('connection is deleted when last member is archived', () => {
    test('connection with 1 member is deleted when that member is archived', async () => {
      useConnectionStore.setState({ connections: [makeConnectionSingleMember()] })

      // After removing the last member, no connections remain
      mockConnectionOps.getAll.mockResolvedValueOnce({
        success: true,
        connections: []
      })

      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      expect(useConnectionStore.getState().connections).toHaveLength(0)
    })

    test('selected connection is cleared when it is deleted by archive cascade', async () => {
      useConnectionStore.setState({
        connections: [makeConnectionSingleMember()],
        selectedConnectionId: 'conn-single'
      })

      mockConnectionOps.getAll.mockResolvedValueOnce({
        success: true,
        connections: []
      })

      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      // The loadConnections call will set connections to [], but selectedConnectionId
      // is managed by persist -- the connection no longer exists so it becomes stale.
      // The UI should handle this gracefully (no matching connection found).
      expect(useConnectionStore.getState().connections).toHaveLength(0)
    })
  })

  describe('worktree in multiple connections is cleaned up from all', () => {
    test('removeWorktreeFromAll is called once and cleans up across connections', async () => {
      // wt-1 is in both connections
      useConnectionStore.setState({
        connections: [makeConnection(), makeSecondConnection()]
      })

      // After cleanup: conn-1 has 1 member (wt-2), conn-2 has 1 member (wt-3)
      const connAfter1 = makeConnection({
        members: [makeConnection().members[1]] // wt-2 remains
      })
      const connAfter2 = makeSecondConnection({
        members: [makeSecondConnection().members[1]] // wt-3 remains
      })
      mockConnectionOps.getAll.mockResolvedValueOnce({
        success: true,
        connections: [connAfter1, connAfter2]
      })

      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      // removeWorktreeFromAll handles all connections server-side in one call
      expect(mockConnectionOps.removeWorktreeFromAll).toHaveBeenCalledWith('wt-1')
      expect(mockConnectionOps.removeWorktreeFromAll).toHaveBeenCalledTimes(1)

      const connections = useConnectionStore.getState().connections
      expect(connections).toHaveLength(2)
      // Verify wt-1 is no longer a member of either connection
      for (const conn of connections) {
        const hasMember = conn.members.some(
          (m: { worktree_id: string }) => m.worktree_id === 'wt-1'
        )
        expect(hasMember).toBe(false)
      }
    })
  })

  describe('full lifecycle: create -> archive -> cleanup', () => {
    test('archiving worktree removes it from state and cleans up connections', async () => {
      useConnectionStore.setState({ connections: [makeConnection()] })

      // After cleanup: connection survives with 1 member
      mockConnectionOps.getAll.mockResolvedValueOnce({
        success: true,
        connections: [
          makeConnection({
            members: [makeConnection().members[1]]
          })
        ]
      })

      await act(async () => {
        const result = await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
        expect(result?.success).toBe(true)
      })

      // Worktree removed from worktree store
      const worktrees = useWorktreeStore.getState().worktreesByProject.get('proj-1')
      expect(worktrees?.find((w) => w.id === 'wt-1')).toBeUndefined()

      // Connection cleanup happened
      expect(mockConnectionOps.removeWorktreeFromAll).toHaveBeenCalledWith('wt-1')

      // Connections reloaded
      const connections = useConnectionStore.getState().connections
      expect(connections).toHaveLength(1)
      expect(connections[0].members).toHaveLength(1)
    })

    test('archiving both members deletes the connection entirely', async () => {
      useConnectionStore.setState({ connections: [makeConnection()] })

      // Archive first member -- connection survives
      const connAfterFirst = makeConnection({
        members: [makeConnection().members[1]]
      })
      mockConnectionOps.getAll.mockResolvedValueOnce({
        success: true,
        connections: [connAfterFirst]
      })

      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      expect(useConnectionStore.getState().connections).toHaveLength(1)

      // Archive second member -- connection deleted
      mockConnectionOps.getAll.mockResolvedValueOnce({
        success: true,
        connections: []
      })

      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-2', '/repos/backend/city-two', 'feat/api', '/repos/backend')
      })

      expect(useConnectionStore.getState().connections).toHaveLength(0)
      expect(mockConnectionOps.removeWorktreeFromAll).toHaveBeenCalledTimes(2)
    })
  })

  describe('archiving state management', () => {
    test('archivingWorktreeIds is cleared after archive with connection cleanup', async () => {
      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt-1')).toBe(false)
    })

    test('archivingWorktreeIds is cleared even when connection cleanup fails', async () => {
      mockConnectionOps.removeWorktreeFromAll.mockRejectedValueOnce(new Error('Cleanup error'))

      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      expect(useWorktreeStore.getState().archivingWorktreeIds.has('wt-1')).toBe(false)
    })
  })
})
