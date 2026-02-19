import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from '@testing-library/react'
import { ConnectDialog } from '../../../src/renderer/src/components/connections/ConnectDialog'
import { useProjectStore } from '../../../src/renderer/src/stores/useProjectStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useConnectionStore } from '../../../src/renderer/src/stores/useConnectionStore'

// ---------- Mock toast ----------
vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn()
  }
}))

// ---------- Mock window APIs ----------
const mockConnectionOps = {
  create: vi.fn(),
  delete: vi.fn(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  rename: vi.fn(),
  getAll: vi.fn().mockResolvedValue([]),
  get: vi.fn(),
  openInTerminal: vi.fn(),
  openInEditor: vi.fn(),
  removeWorktreeFromAll: vi.fn()
}

const mockDb = {
  worktree: {
    touch: vi.fn().mockResolvedValue(undefined),
    getActiveByProject: vi.fn().mockResolvedValue([])
  },
  project: {
    getAll: vi.fn().mockResolvedValue([]),
    touch: vi.fn().mockResolvedValue(undefined)
  }
}

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
  const existing = (window as any).db
  if (!existing.worktree) existing.worktree = mockDb.worktree
  if (!existing.project) existing.project = mockDb.project
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- Test data factories ----------
function makeProject(id: string, name: string) {
  return {
    id,
    name,
    path: `/repos/${name.toLowerCase()}`,
    description: null,
    tags: null,
    language: null,
    custom_icon: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    auto_assign_port: false,
    sort_order: 0,
    created_at: '2025-01-01T00:00:00.000Z',
    last_accessed_at: '2025-01-01T00:00:00.000Z'
  }
}

function makeWorktree(
  id: string,
  projectId: string,
  name: string,
  branchName: string,
  isDefault = false
) {
  return {
    id,
    project_id: projectId,
    name,
    branch_name: branchName,
    path: `/repos/${name}`,
    status: 'active' as const,
    is_default: isDefault,
    branch_renamed: 0,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    created_at: '2025-01-01T00:00:00.000Z',
    last_accessed_at: '2025-01-01T00:00:00.000Z'
  }
}

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    name: 'golden-retriever',
    status: 'active' as const,
    path: '/home/.hive/connections/golden-retriever',
    color: JSON.stringify(['#bfdbfe', '#2563eb', '#1e3a5f', '#ffffff']),
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

// ---------- Helpers ----------
function setupStores(options: {
  projects?: ReturnType<typeof makeProject>[]
  worktreesByProject?: Map<string, ReturnType<typeof makeWorktree>[]>
  connections?: ReturnType<typeof makeConnection>[]
}) {
  const { projects = [], worktreesByProject = new Map(), connections = [] } = options

  useProjectStore.setState({ projects })
  useWorktreeStore.setState({ worktreesByProject })
  useConnectionStore.setState({
    connections,
    isLoading: false,
    error: null,
    selectedConnectionId: null
  })
}

// ---------- Tests ----------
describe('Session 7: Connect Dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProjectStore.setState({
      projects: [],
      isLoading: false,
      error: null,
      selectedProjectId: null,
      expandedProjectIds: new Set(),
      editingProjectId: null,
      settingsProjectId: null
    })
    useWorktreeStore.setState({
      worktreesByProject: new Map(),
      selectedWorktreeId: null
    })
    useConnectionStore.setState({
      connections: [],
      isLoading: false,
      error: null,
      selectedConnectionId: null
    })
  })

  describe('rendering', () => {
    test('renders worktrees grouped by project', () => {
      const projects = [makeProject('proj-1', 'Frontend'), makeProject('proj-2', 'Backend')]
      const worktreesByProject = new Map([
        [
          'proj-1',
          [
            makeWorktree('wt-1', 'proj-1', 'city-one', 'feat/auth'),
            makeWorktree('wt-1-default', 'proj-1', 'main', 'main', true)
          ]
        ],
        [
          'proj-2',
          [
            makeWorktree('wt-2', 'proj-2', 'city-two', 'feat/api'),
            makeWorktree('wt-3', 'proj-2', 'city-three', 'develop')
          ]
        ]
      ])

      setupStores({ projects, worktreesByProject })

      render(<ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={vi.fn()} />)

      // Should show dialog
      expect(screen.getByTestId('connect-dialog')).toBeInTheDocument()

      // Should NOT show Frontend (source project) worktrees
      expect(screen.queryByText('Frontend')).not.toBeInTheDocument()

      // Should show Backend project worktrees
      expect(screen.getByText('Backend')).toBeInTheDocument()
      expect(screen.getByText('city-two')).toBeInTheDocument()
      expect(screen.getByText('city-three')).toBeInTheDocument()
    })

    test('excludes source worktree project from list', () => {
      const projects = [
        makeProject('proj-1', 'Frontend'),
        makeProject('proj-2', 'Backend'),
        makeProject('proj-3', 'API')
      ]
      const worktreesByProject = new Map([
        ['proj-1', [makeWorktree('wt-1', 'proj-1', 'fe-branch', 'feat/ui')]],
        ['proj-2', [makeWorktree('wt-2', 'proj-2', 'be-branch', 'feat/api')]],
        ['proj-3', [makeWorktree('wt-3', 'proj-3', 'api-branch', 'feat/rest')]]
      ])

      setupStores({ projects, worktreesByProject })

      render(<ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={vi.fn()} />)

      // Source project (Frontend) should be excluded
      const worktreeList = screen.getByTestId('worktree-list')
      expect(within(worktreeList).queryByText('Frontend')).not.toBeInTheDocument()

      // Other projects should be visible
      expect(within(worktreeList).getByText('Backend')).toBeInTheDocument()
      expect(within(worktreeList).getByText('API')).toBeInTheDocument()
    })

    test('shows empty state when no other projects exist', () => {
      const projects = [makeProject('proj-1', 'Frontend')]
      const worktreesByProject = new Map([
        ['proj-1', [makeWorktree('wt-1', 'proj-1', 'city-one', 'feat/auth')]]
      ])

      setupStores({ projects, worktreesByProject })

      render(<ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={vi.fn()} />)

      expect(screen.getByText(/No worktrees from other projects/)).toBeInTheDocument()
    })

    test('shows existing connections containing the source worktree', () => {
      const projects = [makeProject('proj-1', 'Frontend'), makeProject('proj-2', 'Backend')]
      const worktreesByProject = new Map([
        ['proj-1', [makeWorktree('wt-1', 'proj-1', 'city-one', 'feat/auth')]],
        ['proj-2', [makeWorktree('wt-2', 'proj-2', 'city-two', 'feat/api')]]
      ])
      const connections = [makeConnection()]

      setupStores({ projects, worktreesByProject, connections })

      render(<ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={vi.fn()} />)

      expect(screen.getByTestId('existing-connections')).toBeInTheDocument()
      expect(screen.getByText('golden-retriever')).toBeInTheDocument()
    })
  })

  describe('Connect button', () => {
    test('is disabled when nothing selected', () => {
      const projects = [makeProject('proj-1', 'Frontend'), makeProject('proj-2', 'Backend')]
      const worktreesByProject = new Map([
        ['proj-1', [makeWorktree('wt-1', 'proj-1', 'city-one', 'feat/auth')]],
        ['proj-2', [makeWorktree('wt-2', 'proj-2', 'city-two', 'feat/api')]]
      ])

      setupStores({ projects, worktreesByProject })

      render(<ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={vi.fn()} />)

      const connectButton = screen.getByTestId('connect-button')
      expect(connectButton).toBeDisabled()
    })

    test('becomes enabled when a worktree is selected', async () => {
      const user = userEvent.setup()
      const projects = [makeProject('proj-1', 'Frontend'), makeProject('proj-2', 'Backend')]
      const worktreesByProject = new Map([
        ['proj-1', [makeWorktree('wt-1', 'proj-1', 'city-one', 'feat/auth')]],
        ['proj-2', [makeWorktree('wt-2', 'proj-2', 'city-two', 'feat/api')]]
      ])

      setupStores({ projects, worktreesByProject })

      render(<ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={vi.fn()} />)

      // Click the checkbox for wt-2
      const checkbox = screen.getByTestId('worktree-checkbox-wt-2')
      await user.click(checkbox)

      const connectButton = screen.getByTestId('connect-button')
      expect(connectButton).not.toBeDisabled()
    })
  })

  describe('submitting', () => {
    test('calls createConnection with source + selected IDs', async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()
      const projects = [makeProject('proj-1', 'Frontend'), makeProject('proj-2', 'Backend')]
      const worktreesByProject = new Map([
        ['proj-1', [makeWorktree('wt-1', 'proj-1', 'city-one', 'feat/auth')]],
        ['proj-2', [makeWorktree('wt-2', 'proj-2', 'city-two', 'feat/api')]]
      ])

      setupStores({ projects, worktreesByProject })

      const newConn = makeConnection()
      mockConnectionOps.create.mockResolvedValueOnce(newConn)

      render(<ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={onOpenChange} />)

      // Select wt-2
      const checkbox = screen.getByTestId('worktree-checkbox-wt-2')
      await user.click(checkbox)

      // Click connect
      const connectButton = screen.getByTestId('connect-button')
      await user.click(connectButton)

      // Wait for async operations
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10))
      })

      // Should have been called with [sourceId, selectedId]
      expect(mockConnectionOps.create).toHaveBeenCalledWith(['wt-1', 'wt-2'])

      // Should close the dialog
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    test('supports selecting multiple worktrees', async () => {
      const user = userEvent.setup()
      const onOpenChange = vi.fn()
      const projects = [
        makeProject('proj-1', 'Frontend'),
        makeProject('proj-2', 'Backend'),
        makeProject('proj-3', 'API')
      ]
      const worktreesByProject = new Map([
        ['proj-1', [makeWorktree('wt-1', 'proj-1', 'fe-branch', 'feat/ui')]],
        ['proj-2', [makeWorktree('wt-2', 'proj-2', 'be-branch', 'feat/api')]],
        ['proj-3', [makeWorktree('wt-3', 'proj-3', 'api-branch', 'feat/rest')]]
      ])

      setupStores({ projects, worktreesByProject })

      const newConn = makeConnection()
      mockConnectionOps.create.mockResolvedValueOnce(newConn)

      render(<ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={onOpenChange} />)

      // Select both wt-2 and wt-3
      await user.click(screen.getByTestId('worktree-checkbox-wt-2'))
      await user.click(screen.getByTestId('worktree-checkbox-wt-3'))

      // Verify count text
      expect(screen.getByText('2 worktrees selected')).toBeInTheDocument()

      // Click connect
      await user.click(screen.getByTestId('connect-button'))

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10))
      })

      // Should include source + both selected
      const callArgs = mockConnectionOps.create.mock.calls[0][0] as string[]
      expect(callArgs).toHaveLength(3)
      expect(callArgs[0]).toBe('wt-1')
      expect(callArgs).toContain('wt-2')
      expect(callArgs).toContain('wt-3')
    })
  })

  describe('filtering', () => {
    test('filters worktrees by name', async () => {
      const user = userEvent.setup()
      const projects = [
        makeProject('proj-1', 'Frontend'),
        makeProject('proj-2', 'Backend'),
        makeProject('proj-3', 'API')
      ]
      const worktreesByProject = new Map([
        ['proj-1', [makeWorktree('wt-1', 'proj-1', 'fe-branch', 'feat/ui')]],
        ['proj-2', [makeWorktree('wt-2', 'proj-2', 'be-branch', 'feat/api')]],
        ['proj-3', [makeWorktree('wt-3', 'proj-3', 'api-branch', 'feat/rest')]]
      ])

      setupStores({ projects, worktreesByProject })

      render(<ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={vi.fn()} />)

      // Type in filter
      const filterInput = screen.getByTestId('connect-dialog-filter')
      await user.type(filterInput, 'api')

      // api-branch should be visible, be-branch should not
      expect(screen.getByText('api-branch')).toBeInTheDocument()
      // be-branch has "feat/api" as branch name, so it should also match
      expect(screen.getByText('be-branch')).toBeInTheDocument()
    })

    test('shows no results message when filter matches nothing', async () => {
      const user = userEvent.setup()
      const projects = [makeProject('proj-1', 'Frontend'), makeProject('proj-2', 'Backend')]
      const worktreesByProject = new Map([
        ['proj-1', [makeWorktree('wt-1', 'proj-1', 'city-one', 'feat/auth')]],
        ['proj-2', [makeWorktree('wt-2', 'proj-2', 'city-two', 'feat/api')]]
      ])

      setupStores({ projects, worktreesByProject })

      render(<ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={vi.fn()} />)

      const filterInput = screen.getByTestId('connect-dialog-filter')
      await user.type(filterInput, 'zzzznonexistent')

      expect(screen.getByText('No worktrees match your filter')).toBeInTheDocument()
    })
  })

  describe('toggle behavior', () => {
    test('toggling a checkbox on and off updates selection count', async () => {
      const user = userEvent.setup()
      const projects = [makeProject('proj-1', 'Frontend'), makeProject('proj-2', 'Backend')]
      const worktreesByProject = new Map([
        ['proj-1', [makeWorktree('wt-1', 'proj-1', 'city-one', 'feat/auth')]],
        ['proj-2', [makeWorktree('wt-2', 'proj-2', 'city-two', 'feat/api')]]
      ])

      setupStores({ projects, worktreesByProject })

      render(<ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={vi.fn()} />)

      expect(screen.getByText('Select worktrees to connect')).toBeInTheDocument()

      // Check wt-2
      const checkbox = screen.getByTestId('worktree-checkbox-wt-2')
      await user.click(checkbox)
      expect(screen.getByText('1 worktree selected')).toBeInTheDocument()

      // Uncheck wt-2
      await user.click(checkbox)
      expect(screen.getByText('Select worktrees to connect')).toBeInTheDocument()
    })
  })

  describe('dialog state management', () => {
    test('resets state when dialog closes', () => {
      const projects = [makeProject('proj-1', 'Frontend'), makeProject('proj-2', 'Backend')]
      const worktreesByProject = new Map([
        ['proj-1', [makeWorktree('wt-1', 'proj-1', 'city-one', 'feat/auth')]],
        ['proj-2', [makeWorktree('wt-2', 'proj-2', 'city-two', 'feat/api')]]
      ])

      setupStores({ projects, worktreesByProject })

      const { rerender } = render(
        <ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={vi.fn()} />
      )

      // Close dialog
      rerender(<ConnectDialog sourceWorktreeId="wt-1" open={false} onOpenChange={vi.fn()} />)

      // Reopen dialog
      rerender(<ConnectDialog sourceWorktreeId="wt-1" open={true} onOpenChange={vi.fn()} />)

      // Should show default state
      expect(screen.getByText('Select worktrees to connect')).toBeInTheDocument()
      expect(screen.getByTestId('connect-button')).toBeDisabled()
    })
  })
})
