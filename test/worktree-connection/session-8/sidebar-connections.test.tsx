import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectionList } from '../../../src/renderer/src/components/connections/ConnectionList'
import { ConnectionItem } from '../../../src/renderer/src/components/connections/ConnectionItem'
import { useConnectionStore } from '../../../src/renderer/src/stores/useConnectionStore'
import { useWorktreeStatusStore } from '../../../src/renderer/src/stores/useWorktreeStatusStore'

// ---------- Mock toast ----------
vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn()
  },
  clipboardToast: {
    copied: vi.fn()
  }
}))

// ---------- Mock window APIs ----------
const mockConnectionOps = {
  create: vi.fn(),
  delete: vi.fn().mockResolvedValue({ success: true }),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  rename: vi.fn().mockResolvedValue({ success: true }),
  getAll: vi.fn().mockResolvedValue({ success: true, connections: [] }),
  get: vi.fn(),
  openInTerminal: vi.fn().mockResolvedValue({ success: true }),
  openInEditor: vi.fn().mockResolvedValue({ success: true }),
  removeWorktreeFromAll: vi.fn()
}

const mockProjectOps = {
  showInFolder: vi.fn().mockResolvedValue(undefined),
  copyToClipboard: vi.fn().mockResolvedValue(undefined)
}

const mockDb = {
  worktree: {
    touch: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    getActiveByProject: vi.fn().mockResolvedValue([])
  },
  project: {
    getAll: vi.fn().mockResolvedValue([]),
    touch: vi.fn().mockResolvedValue(undefined)
  },
  session: {
    getActiveByConnection: vi.fn().mockResolvedValue([])
  }
}

Object.defineProperty(window, 'connectionOps', {
  writable: true,
  configurable: true,
  value: mockConnectionOps
})

Object.defineProperty(window, 'projectOps', {
  writable: true,
  configurable: true,
  value: mockProjectOps
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
  if (!existing.worktree) existing.worktree = mockDb.worktree
  if (!existing.project) existing.project = mockDb.project
  if (!existing.session) existing.session = mockDb.session
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
        worktree_branch: 'feat/rest',
        worktree_path: '/repos/api/city-three',
        project_name: 'API'
      }
    ]
  })
}

// ---------- Tests ----------
describe('Session 8: Sidebar Connections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useConnectionStore.setState({
      connections: [],
      isLoading: false,
      error: null,
      selectedConnectionId: null
    })
    useWorktreeStatusStore.setState({
      sessionStatuses: {},
      lastMessageTimeByWorktree: {}
    })
  })

  describe('ConnectionList', () => {
    test('renders when connections exist', () => {
      useConnectionStore.setState({
        connections: [makeConnection(), makeConnection2()]
      })

      render(<ConnectionList />)

      expect(screen.getByTestId('connection-list')).toBeInTheDocument()
      expect(screen.getByTestId('connections-section-header')).toBeInTheDocument()
      expect(screen.getByText('Connections')).toBeInTheDocument()
      // Should show count
      expect(screen.getByText('2')).toBeInTheDocument()
    })

    test('is hidden when no connections', () => {
      useConnectionStore.setState({ connections: [] })

      const { container } = render(<ConnectionList />)

      // Should render nothing
      expect(container.innerHTML).toBe('')
    })

    test('renders correct number of ConnectionItem components', () => {
      useConnectionStore.setState({
        connections: [makeConnection(), makeConnection2()]
      })

      render(<ConnectionList />)

      expect(screen.getByTestId('connection-item-conn-1')).toBeInTheDocument()
      expect(screen.getByTestId('connection-item-conn-2')).toBeInTheDocument()
    })

    test('collapses and expands on header click', async () => {
      const user = userEvent.setup()
      const connections = [makeConnection()]
      mockConnectionOps.getAll.mockResolvedValue({
        success: true,
        connections
      })
      useConnectionStore.setState({ connections })

      render(<ConnectionList />)

      // Initially expanded
      expect(screen.getByTestId('connections-list-items')).toBeInTheDocument()

      // Click header to collapse
      await user.click(screen.getByTestId('connections-section-header'))
      expect(screen.queryByTestId('connections-list-items')).not.toBeInTheDocument()

      // Click again to expand
      await user.click(screen.getByTestId('connections-section-header'))
      expect(screen.getByTestId('connections-list-items')).toBeInTheDocument()
    })

    test('loads connections on mount', () => {
      mockConnectionOps.getAll.mockResolvedValue({
        success: true,
        connections: [makeConnection()]
      })

      render(<ConnectionList />)

      expect(mockConnectionOps.getAll).toHaveBeenCalled()
    })
  })

  describe('ConnectionItem', () => {
    test('shows breed name and project subtitle', () => {
      const connection = makeConnection()

      render(<ConnectionItem connection={connection} />)

      expect(screen.getByText('golden-retriever')).toBeInTheDocument()
      expect(screen.getByText('Frontend + Backend')).toBeInTheDocument()
    })

    test('shows single project name for single-member connection', () => {
      const connection = makeConnection2()

      render(<ConnectionItem connection={connection} />)

      expect(screen.getByText('labrador')).toBeInTheDocument()
      expect(screen.getByText('API')).toBeInTheDocument()
    })

    test('clicking selects the connection', async () => {
      const user = userEvent.setup()
      const connection = makeConnection()

      render(<ConnectionItem connection={connection} />)

      await user.click(screen.getByTestId('connection-item-conn-1'))

      expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')
    })

    test('selected connection has highlighted background', () => {
      useConnectionStore.setState({ selectedConnectionId: 'conn-1' })
      const connection = makeConnection()

      render(<ConnectionItem connection={connection} />)

      const item = screen.getByTestId('connection-item-conn-1')
      expect(item.className).toContain('bg-accent')
    })

    test('non-selected connection does not have highlighted background', () => {
      useConnectionStore.setState({ selectedConnectionId: 'conn-2' })
      const connection = makeConnection()

      render(<ConnectionItem connection={connection} />)

      const item = screen.getByTestId('connection-item-conn-1')
      expect(item.className).not.toContain('bg-accent text-accent-foreground')
    })

    test('shows Ready status by default', () => {
      const connection = makeConnection()

      render(<ConnectionItem connection={connection} />)

      expect(screen.getByTestId('connection-status-text')).toHaveTextContent('Ready')
    })

    test('deduplicates project names in subtitle', () => {
      const connection = makeConnection({
        members: [
          {
            id: 'mem-1',
            connection_id: 'conn-1',
            worktree_id: 'wt-1',
            project_id: 'proj-1',
            symlink_name: 'fe-main',
            added_at: '2025-01-01T00:00:00.000Z',
            worktree_name: 'main',
            worktree_branch: 'main',
            worktree_path: '/repos/frontend/main',
            project_name: 'Frontend'
          },
          {
            id: 'mem-2',
            connection_id: 'conn-1',
            worktree_id: 'wt-2',
            project_id: 'proj-1',
            symlink_name: 'fe-dev',
            added_at: '2025-01-01T00:00:00.000Z',
            worktree_name: 'dev',
            worktree_branch: 'develop',
            worktree_path: '/repos/frontend/dev',
            project_name: 'Frontend'
          }
        ]
      })

      render(<ConnectionItem connection={connection} />)

      // Should only show "Frontend" once, not "Frontend + Frontend"
      const subtitle = screen.getByText('Frontend')
      expect(subtitle).toBeInTheDocument()
      expect(screen.queryByText('Frontend + Frontend')).not.toBeInTheDocument()
    })
  })

  describe('ConnectionItem context menu actions', () => {
    test('delete removes connection', async () => {
      const user = userEvent.setup()
      const connection = makeConnection()
      mockConnectionOps.delete.mockResolvedValueOnce({ success: true })

      render(<ConnectionItem connection={connection} />)

      // Right-click to open context menu
      const item = screen.getByTestId('connection-item-conn-1')
      await user.pointer({ keys: '[MouseRight]', target: item })

      // Click Delete in context menu
      const deleteItem = screen.getByText('Delete')
      await user.click(deleteItem)

      expect(mockConnectionOps.delete).toHaveBeenCalledWith('conn-1')
    })

    test('copy path copies connection path', async () => {
      const user = userEvent.setup()
      const connection = makeConnection()

      render(<ConnectionItem connection={connection} />)

      // Right-click to open context menu
      const item = screen.getByTestId('connection-item-conn-1')
      await user.pointer({ keys: '[MouseRight]', target: item })

      // Click Copy Path
      const copyPathItem = screen.getByText('Copy Path')
      await user.click(copyPathItem)

      expect(mockProjectOps.copyToClipboard).toHaveBeenCalledWith(
        '/home/.hive/connections/golden-retriever'
      )
    })
  })

  describe('getConnectionStatus integration', () => {
    test('returns null when no sessions exist for connection', () => {
      const status = useWorktreeStatusStore.getState().getConnectionStatus('conn-1')
      expect(status).toBeNull()
    })
  })
})
