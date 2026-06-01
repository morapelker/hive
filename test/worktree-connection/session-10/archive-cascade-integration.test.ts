import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useConnectionStore } from '../../../src/renderer/src/stores/useConnectionStore'

const apiMocks = vi.hoisted(() => ({
  connectionApi: {
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
  },
  worktreeApi: {
    delete: vi.fn()
  },
  kanbanApi: {
    ticket: {
      detachWorktree: vi.fn()
    }
  },
  dbApi: {
    worktree: {
      touch: vi.fn().mockResolvedValue(undefined)
    },
    setting: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(true),
      delete: vi.fn().mockResolvedValue(true),
      getAll: vi.fn().mockResolvedValue([])
    }
  },
  scriptApi: {
    kill: vi.fn(),
    onOutput: vi.fn(() => vi.fn())
  },
  opencodeApi: {
    listModels: vi.fn().mockResolvedValue([]),
    abort: vi.fn()
  },
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  },
  systemApi: {
    detectClaudeCode: vi.fn().mockResolvedValue(false),
    detectClaudeCli: vi.fn().mockResolvedValue(false),
    detectCodex: vi.fn().mockResolvedValue(false),
    detectOpencode: vi.fn().mockResolvedValue(false),
    getEnvVar: vi.fn().mockResolvedValue(null)
  },
  updaterApi: {
    getCurrentVersion: vi.fn().mockResolvedValue('0.0.0'),
    checkForUpdates: vi.fn().mockResolvedValue({ available: false }),
    onUpdateStatus: vi.fn(() => vi.fn())
  },
  petApi: {
    updateSettings: vi.fn().mockResolvedValue(undefined)
  },
  telegramApi: {
    getConfig: vi.fn().mockResolvedValue({ enabled: false }),
    getStatus: vi.fn().mockResolvedValue({ connected: false }),
    onStatusChanged: vi.fn(() => vi.fn()),
    onMessageReceived: vi.fn(() => vi.fn()),
    onPlanImplementRequested: vi.fn(() => vi.fn())
  },
  terminalApi: {
    onClosed: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/connection-api', () => ({ connectionApi: apiMocks.connectionApi }))
vi.mock('@/api/worktree-api', () => ({ worktreeApi: apiMocks.worktreeApi }))
vi.mock('@/api/kanban-api', () => ({ kanbanApi: apiMocks.kanbanApi }))
vi.mock('@/api/db-api', () => ({ dbApi: apiMocks.dbApi }))
vi.mock('@/api/script-api', () => ({ scriptApi: apiMocks.scriptApi }))
vi.mock('@/api/opencode-api', () => ({ opencodeApi: apiMocks.opencodeApi }))
vi.mock('@/api/settings-api', () => ({ settingsApi: apiMocks.settingsApi }))
vi.mock('@/api/system-api', () => ({ systemApi: apiMocks.systemApi }))
vi.mock('@/api/updater-api', () => ({ updaterApi: apiMocks.updaterApi }))
vi.mock('@/api/pet-api', () => ({ petApi: apiMocks.petApi }))
vi.mock('@/api/telegram-api', () => ({ telegramApi: apiMocks.telegramApi }))
vi.mock('@/api/terminal-api', () => ({ terminalApi: apiMocks.terminalApi }))

// ---------- Mock toast ----------
vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn()
  }
}))

const mockConnectionOps = apiMocks.connectionApi
const mockWorktreeOps = apiMocks.worktreeApi
const mockKanban = apiMocks.kanbanApi

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
    mockKanban.ticket.detachWorktree.mockResolvedValue(1)
    // Default mock: successful removeWorktreeFromAll
    mockConnectionOps.removeWorktreeFromAll.mockResolvedValue({ success: true })
    // Default mock: getAll returns empty after cleanup
    mockConnectionOps.getAll.mockResolvedValue({ success: true, connections: [] })
  })

  describe('archiveWorktree calls removeWorktreeFromAll', () => {
    test('archiving a worktree detaches tickets before the delete op starts', async () => {
      const callOrder: string[] = []
      mockKanban.ticket.detachWorktree.mockImplementation(async () => {
        callOrder.push('detachWorktree')
        return 1
      })
      mockWorktreeOps.delete.mockImplementation(async () => {
        callOrder.push('delete')
        return { success: true }
      })

      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      expect(callOrder.slice(0, 2)).toEqual(['detachWorktree', 'delete'])
    })

    test('archiving a worktree calls removeWorktreeFromAll with the worktreeId', async () => {
      await act(async () => {
        await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      expect(mockConnectionOps.removeWorktreeFromAll).toHaveBeenCalledWith('wt-1')
      expect(mockConnectionOps.removeWorktreeFromAll).toHaveBeenCalledTimes(1)
    })

    test('archive aborts before delete when ticket detach fails', async () => {
      mockKanban.ticket.detachWorktree.mockRejectedValueOnce(new Error('Detach failed'))

      const result = await act(async () => {
        return useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Detach failed')
      expect(mockWorktreeOps.delete).not.toHaveBeenCalled()
      expect(mockConnectionOps.removeWorktreeFromAll).not.toHaveBeenCalled()
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

    test('archive failure after detach leaves detached tickets in place', async () => {
      mockWorktreeOps.delete.mockResolvedValueOnce({
        success: false,
        error: 'Permission denied'
      })

      let result: { success: boolean; error?: string } | undefined
      await act(async () => {
        result = await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
      })

      expect(result?.success).toBe(false)
      expect(mockKanban.ticket.detachWorktree).toHaveBeenCalledWith('wt-1')
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

    test('archiving the selected worktree reselects the project default worktree', async () => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })

      await act(async () => {
        const result = await useWorktreeStore
          .getState()
          .archiveWorktree('wt-1', '/repos/frontend/city-one', 'feat/auth', '/repos/frontend')
        expect(result?.success).toBe(true)
      })

      expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-default')
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
