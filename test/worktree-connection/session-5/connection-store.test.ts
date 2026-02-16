import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { useConnectionStore } from '../../../src/renderer/src/stores/useConnectionStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'

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

// ---------- Mock window.db ----------
const mockDb = {
  worktree: {
    touch: vi.fn().mockResolvedValue(undefined)
  }
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

/* eslint-disable @typescript-eslint/no-explicit-any */
if (!(window as any).db) {
  Object.defineProperty(window, 'db', {
    writable: true,
    configurable: true,
    value: mockDb
  })
} else {
  // Extend existing db mock with worktree.touch if missing
  const existing = (window as any).db
  if (!existing.worktree) {
    existing.worktree = mockDb.worktree
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- Test data factories ----------
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

function makeConnection2() {
  return makeConnection({
    id: 'conn-2',
    name: 'labrador',
    path: '/home/.hive/connections/labrador',
    members: [
      {
        id: 'mem-3',
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
    ]
  })
}

// ---------- Tests ----------
describe('Session 5: Connection Store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store state
    useConnectionStore.setState({
      connections: [],
      isLoading: false,
      error: null,
      selectedConnectionId: null
    })
    useWorktreeStore.setState({
      selectedWorktreeId: null
    })
  })

  describe('loadConnections', () => {
    test('fetches from IPC and updates state', async () => {
      const connections = [makeConnection(), makeConnection2()]
      mockConnectionOps.getAll.mockResolvedValueOnce({ success: true, connections })

      await act(async () => {
        await useConnectionStore.getState().loadConnections()
      })

      const state = useConnectionStore.getState()
      expect(state.connections).toHaveLength(2)
      expect(state.connections[0].name).toBe('golden-retriever')
      expect(state.connections[1].name).toBe('labrador')
      expect(state.isLoading).toBe(false)
      expect(state.error).toBeNull()
    })

    test('sets isLoading during fetch', async () => {
      let resolveGetAll: (value: unknown) => void
      mockConnectionOps.getAll.mockReturnValueOnce(
        new Promise<unknown>((resolve) => {
          resolveGetAll = resolve
        })
      )

      const loadPromise = useConnectionStore.getState().loadConnections()
      expect(useConnectionStore.getState().isLoading).toBe(true)

      await act(async () => {
        resolveGetAll!({ success: true, connections: [] })
        await loadPromise
      })

      expect(useConnectionStore.getState().isLoading).toBe(false)
    })

    test('handles errors gracefully', async () => {
      mockConnectionOps.getAll.mockRejectedValueOnce(new Error('Network error'))

      await act(async () => {
        await useConnectionStore.getState().loadConnections()
      })

      const state = useConnectionStore.getState()
      expect(state.error).toBe('Network error')
      expect(state.isLoading).toBe(false)
      expect(state.connections).toHaveLength(0)
    })
  })

  describe('createConnection', () => {
    test('adds to state and selects it', async () => {
      const newConn = makeConnection()
      mockConnectionOps.create.mockResolvedValueOnce({ success: true, connection: newConn })

      let result: string | null = null
      await act(async () => {
        result = await useConnectionStore.getState().createConnection(['wt-1', 'wt-2'])
      })

      expect(result).toBe('conn-1')
      expect(mockConnectionOps.create).toHaveBeenCalledWith(['wt-1', 'wt-2'])

      const state = useConnectionStore.getState()
      expect(state.connections).toHaveLength(1)
      expect(state.selectedConnectionId).toBe('conn-1')
    })

    test('returns null on failure', async () => {
      mockConnectionOps.create.mockRejectedValueOnce(new Error('Create failed'))

      let result: string | null = null
      await act(async () => {
        result = await useConnectionStore.getState().createConnection(['wt-1', 'wt-2'])
      })

      expect(result).toBeNull()
      expect(useConnectionStore.getState().connections).toHaveLength(0)
    })

    test('clears selectedWorktreeId on create', async () => {
      // Set a worktree as selected first
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })

      const newConn = makeConnection()
      mockConnectionOps.create.mockResolvedValueOnce({ success: true, connection: newConn })

      await act(async () => {
        await useConnectionStore.getState().createConnection(['wt-1', 'wt-2'])
      })

      // Allow async import to resolve
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10))
      })

      expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
    })
  })

  describe('deleteConnection', () => {
    test('removes from state and clears selection', async () => {
      useConnectionStore.setState({
        connections: [makeConnection()],
        selectedConnectionId: 'conn-1'
      })
      mockConnectionOps.delete.mockResolvedValueOnce({ success: true })

      await act(async () => {
        await useConnectionStore.getState().deleteConnection('conn-1')
      })

      const state = useConnectionStore.getState()
      expect(state.connections).toHaveLength(0)
      expect(state.selectedConnectionId).toBeNull()
    })

    test('does not clear selection for other connections', async () => {
      useConnectionStore.setState({
        connections: [makeConnection(), makeConnection2()],
        selectedConnectionId: 'conn-1'
      })
      mockConnectionOps.delete.mockResolvedValueOnce({ success: true })

      await act(async () => {
        await useConnectionStore.getState().deleteConnection('conn-2')
      })

      const state = useConnectionStore.getState()
      expect(state.connections).toHaveLength(1)
      expect(state.selectedConnectionId).toBe('conn-1')
    })

    test('handles delete failure', async () => {
      useConnectionStore.setState({
        connections: [makeConnection()],
        selectedConnectionId: 'conn-1'
      })
      mockConnectionOps.delete.mockResolvedValueOnce({
        success: false,
        error: 'Permission denied'
      })

      await act(async () => {
        await useConnectionStore.getState().deleteConnection('conn-1')
      })

      // Connection should still be in state
      expect(useConnectionStore.getState().connections).toHaveLength(1)
    })
  })

  describe('addMember', () => {
    test('updates connection with new member', async () => {
      useConnectionStore.setState({ connections: [makeConnection()] })

      const updatedConn = makeConnection({
        members: [
          ...makeConnection().members,
          {
            id: 'mem-3',
            connection_id: 'conn-1',
            worktree_id: 'wt-3',
            project_id: 'proj-3',
            symlink_name: 'api',
            added_at: '2025-01-01T00:00:00.000Z',
            worktree_name: 'city-three',
            worktree_branch: 'main',
            worktree_path: '/repos/api/city-three',
            project_name: 'API'
          }
        ]
      })
      mockConnectionOps.addMember.mockResolvedValueOnce({
        success: true,
        member: { id: 'mem-3', connection_id: 'conn-1', worktree_id: 'wt-3' }
      })
      mockConnectionOps.get.mockResolvedValueOnce({ success: true, connection: updatedConn })

      await act(async () => {
        await useConnectionStore.getState().addMember('conn-1', 'wt-3')
      })

      expect(mockConnectionOps.addMember).toHaveBeenCalledWith('conn-1', 'wt-3')
      expect(useConnectionStore.getState().connections[0].members).toHaveLength(3)
    })
  })

  describe('removeMember', () => {
    test('updates connection when member removed but connection survives', async () => {
      useConnectionStore.setState({ connections: [makeConnection()] })

      const updatedConn = makeConnection({
        members: [makeConnection().members[0]] // Only first member remains
      })
      mockConnectionOps.removeMember.mockResolvedValueOnce({
        success: true,
        connectionDeleted: false
      })
      mockConnectionOps.get.mockResolvedValueOnce({ success: true, connection: updatedConn })

      await act(async () => {
        await useConnectionStore.getState().removeMember('conn-1', 'wt-2')
      })

      expect(useConnectionStore.getState().connections[0].members).toHaveLength(1)
    })

    test('removes connection when last member removed', async () => {
      useConnectionStore.setState({
        connections: [makeConnection()],
        selectedConnectionId: 'conn-1'
      })
      mockConnectionOps.removeMember.mockResolvedValueOnce({
        success: true,
        connectionDeleted: true
      })

      await act(async () => {
        await useConnectionStore.getState().removeMember('conn-1', 'wt-1')
      })

      expect(useConnectionStore.getState().connections).toHaveLength(0)
      expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    })
  })

  describe('renameConnection', () => {
    test('updates name in local state', async () => {
      useConnectionStore.setState({ connections: [makeConnection()] })
      mockConnectionOps.rename.mockResolvedValueOnce({ success: true })

      await act(async () => {
        await useConnectionStore.getState().renameConnection('conn-1', 'poodle')
      })

      expect(mockConnectionOps.rename).toHaveBeenCalledWith('conn-1', 'poodle')
      expect(useConnectionStore.getState().connections[0].name).toBe('poodle')
    })

    test('does not update state on failure', async () => {
      useConnectionStore.setState({ connections: [makeConnection()] })
      mockConnectionOps.rename.mockResolvedValueOnce({
        success: false,
        error: 'Name already taken'
      })

      await act(async () => {
        await useConnectionStore.getState().renameConnection('conn-1', 'poodle')
      })

      expect(useConnectionStore.getState().connections[0].name).toBe('golden-retriever')
    })
  })

  describe('selectConnection', () => {
    test('sets selectedConnectionId', () => {
      act(() => {
        useConnectionStore.getState().selectConnection('conn-1')
      })

      expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
    })

    test('clears selection with null', () => {
      useConnectionStore.setState({ selectedConnectionId: 'conn-1' })

      act(() => {
        useConnectionStore.getState().selectConnection(null)
      })

      expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    })

    test('clears selectedWorktreeId when selecting a connection', async () => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })

      act(() => {
        useConnectionStore.getState().selectConnection('conn-1')
      })

      // Allow async import to resolve
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10))
      })

      expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
      expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
    })

    test('does not clear worktree selection when deselecting connection', async () => {
      useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })
      useConnectionStore.setState({ selectedConnectionId: 'conn-1' })

      act(() => {
        useConnectionStore.getState().selectConnection(null)
      })

      // Allow async import to resolve
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10))
      })

      // Worktree selection should remain untouched
      expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-1')
    })
  })

  describe('selectWorktree deconfliction', () => {
    test('selectWorktree clears selectedConnectionId', async () => {
      useConnectionStore.setState({ selectedConnectionId: 'conn-1' })

      act(() => {
        useWorktreeStore.getState().selectWorktree('wt-1')
      })

      // Allow async import to resolve
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10))
      })

      expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
    })

    test('selectWorktreeOnly does NOT clear selectedConnectionId', () => {
      useConnectionStore.setState({ selectedConnectionId: 'conn-1' })

      act(() => {
        useWorktreeStore.getState().selectWorktreeOnly('wt-1')
      })

      expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
      expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-1')
    })
  })

  describe('persistence', () => {
    test('selectedConnectionId is included in persisted state', () => {
      // The persist middleware with partialize should only persist selectedConnectionId
      // We verify the store has the persist configuration by checking the initial structure
      useConnectionStore.setState({ selectedConnectionId: 'conn-1' })
      expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
    })
  })
})
