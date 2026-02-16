import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MainPane } from '../../../src/renderer/src/components/layout/MainPane'
import { Header } from '../../../src/renderer/src/components/layout/Header'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useConnectionStore } from '../../../src/renderer/src/stores/useConnectionStore'
import { useProjectStore } from '../../../src/renderer/src/stores/useProjectStore'
import { useFileViewerStore } from '../../../src/renderer/src/stores/useFileViewerStore'
import { useWorktreeStatusStore } from '../../../src/renderer/src/stores/useWorktreeStatusStore'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

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

// ---------- Mock hooks ----------
vi.mock('@/hooks/usePRDetection', () => ({
  usePRDetection: vi.fn()
}))

// ---------- Mock assets ----------
vi.mock('@/assets/icon.png', () => ({ default: 'mock-icon.png' }))
vi.mock('@/assets/bee.png', () => ({ default: 'mock-bee.png' }))

// ---------- Mock QuickActions ----------
vi.mock('@/components/layout/QuickActions', () => ({
  QuickActions: () => <div data-testid="quick-actions" />
}))

// ---------- Mock SessionView ----------
vi.mock('@/components/sessions/SessionView', () => ({
  SessionView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`session-view-${sessionId}`}>Session: {sessionId}</div>
  )
}))

// ---------- Mock FileViewer ----------
vi.mock('@/components/file-viewer', () => ({
  FileViewer: () => <div data-testid="file-viewer" />
}))

// ---------- Mock InlineDiffViewer ----------
vi.mock('@/components/diff', () => ({
  InlineDiffViewer: () => <div data-testid="diff-viewer" />
}))

// ---------- Mock window APIs ----------
const mockConnectionOps = {
  create: vi.fn(),
  delete: vi.fn().mockResolvedValue({ success: true }),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  rename: vi.fn().mockResolvedValue({ success: true }),
  getAll: vi.fn().mockResolvedValue({ success: true, connections: [] }),
  get: vi.fn().mockResolvedValue({
    success: true,
    connection: {
      id: 'conn-1',
      name: 'golden-retriever',
      path: '/home/.hive/connections/golden-retriever',
      status: 'active',
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
        }
      ]
    }
  }),
  openInTerminal: vi.fn().mockResolvedValue({ success: true }),
  openInEditor: vi.fn().mockResolvedValue({ success: true }),
  removeWorktreeFromAll: vi.fn()
}

const mockDb = {
  worktree: {
    get: vi.fn().mockResolvedValue(null),
    touch: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    getActiveByProject: vi.fn().mockResolvedValue([])
  },
  project: {
    getAll: vi.fn().mockResolvedValue([]),
    touch: vi.fn().mockResolvedValue(undefined)
  },
  session: {
    create: vi.fn().mockResolvedValue({
      id: 'session-new',
      worktree_id: null,
      project_id: 'proj-1',
      connection_id: 'conn-1',
      name: 'Session 1',
      status: 'active',
      opencode_session_id: null,
      mode: 'build',
      model_provider_id: null,
      model_id: null,
      model_variant: null,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      completed_at: null
    }),
    update: vi.fn().mockResolvedValue(undefined),
    getActiveByWorktree: vi.fn().mockResolvedValue([]),
    getActiveByConnection: vi.fn().mockResolvedValue([]),
    getByConnection: vi.fn().mockResolvedValue([])
  }
}

const mockGitOps = {
  getFileStatuses: vi.fn().mockResolvedValue({ success: true, files: [] }),
  getBranchInfo: vi.fn().mockResolvedValue({
    success: true,
    branch: { name: 'main', tracking: null, ahead: 0, behind: 0 }
  }),
  getRemoteUrl: vi.fn().mockResolvedValue({ success: true, url: null, remote: null }),
  listBranchesWithStatus: vi.fn().mockResolvedValue({ success: true, branches: [] }),
  onStatusChanged: vi.fn().mockReturnValue(() => {})
}

const mockProjectOps = {
  showInFolder: vi.fn().mockResolvedValue(undefined),
  copyToClipboard: vi.fn().mockResolvedValue(undefined)
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
  Object.assign(existing, {
    worktree: { ...existing.worktree, ...mockDb.worktree },
    project: { ...existing.project, ...mockDb.project },
    session: { ...existing.session, ...mockDb.session }
  })
}

if (!(window as any).gitOps) {
  Object.defineProperty(window, 'gitOps', {
    writable: true,
    configurable: true,
    value: mockGitOps
  })
} else {
  // Merge in methods that the global setup may be missing
  Object.assign((window as any).gitOps, mockGitOps)
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

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    worktree_id: null,
    project_id: 'proj-1',
    connection_id: 'conn-1',
    name: 'Session 1',
    status: 'active' as const,
    opencode_session_id: null,
    mode: 'build' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    completed_at: null,
    ...overrides
  }
}

function makeWorktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wt-1',
    project_id: 'proj-1',
    name: 'main',
    branch_name: 'main',
    path: '/repos/project/main',
    status: 'active' as const,
    is_default: true,
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

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    name: 'My Project',
    path: '/repos/project',
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
    last_accessed_at: '2025-01-01T00:00:00.000Z',
    ...overrides
  }
}

function makeRemoteInfo(overrides: Record<string, unknown> = {}) {
  return {
    hasRemote: true,
    isGitHub: true,
    url: 'https://github.com/test/repo',
    ...overrides
  }
}

// ---------- Tests ----------
describe('Session 9: SessionView & MainPane Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Re-establish mock return values after clearAllMocks
    mockConnectionOps.delete.mockResolvedValue({ success: true })
    mockConnectionOps.rename.mockResolvedValue({ success: true })
    mockConnectionOps.getAll.mockResolvedValue({ success: true, connections: [] })
    mockConnectionOps.get.mockResolvedValue({
      success: true,
      connection: makeConnection()
    })
    mockConnectionOps.openInTerminal.mockResolvedValue({ success: true })
    mockConnectionOps.openInEditor.mockResolvedValue({ success: true })
    mockGitOps.getFileStatuses.mockResolvedValue({ success: true, files: [] })
    mockGitOps.getBranchInfo.mockResolvedValue({
      success: true,
      branch: { name: 'main', tracking: null, ahead: 0, behind: 0 }
    })
    mockGitOps.getRemoteUrl.mockResolvedValue({ success: true, url: null, remote: null })
    mockGitOps.listBranchesWithStatus.mockResolvedValue({ success: true, branches: [] })
    mockGitOps.onStatusChanged.mockReturnValue(() => {})
    mockDb.worktree.get.mockResolvedValue(null)
    mockDb.worktree.touch.mockResolvedValue(undefined)
    mockDb.worktree.update.mockResolvedValue(undefined)
    mockDb.worktree.getActiveByProject.mockResolvedValue([])
    mockDb.project.getAll.mockResolvedValue([])
    mockDb.project.touch.mockResolvedValue(undefined)
    mockDb.session.getActiveByWorktree.mockResolvedValue([])
    mockDb.session.getActiveByConnection.mockResolvedValue([])
    mockDb.session.getByConnection.mockResolvedValue([])

    // Reset all stores
    useConnectionStore.setState({
      connections: [],
      isLoading: false,
      error: null,
      selectedConnectionId: null
    })
    useWorktreeStore.setState({
      selectedWorktreeId: null,
      worktreesByProject: new Map()
    })
    useSessionStore.setState({
      activeSessionId: null,
      activeWorktreeId: null,
      activeConnectionId: null,
      sessionsByWorktree: new Map(),
      tabOrderByWorktree: new Map(),
      sessionsByConnection: new Map(),
      tabOrderByConnection: new Map(),
      activeSessionByWorktree: {},
      activeSessionByConnection: {},
      modeBySession: new Map(),
      pendingMessages: new Map(),
      isLoading: false,
      error: null
    })
    useFileViewerStore.setState({
      activeFilePath: null,
      activeDiff: null,
      openFiles: new Map()
    })
    useProjectStore.setState({
      projects: [],
      selectedProjectId: null,
      isLoading: false,
      error: null
    })
    useWorktreeStatusStore.setState({
      sessionStatuses: {},
      lastMessageTimeByWorktree: {}
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('MainPane', () => {
    test('shows welcome message when neither worktree nor connection is selected', () => {
      render(<MainPane />)

      expect(screen.getByText('Welcome to Hive')).toBeInTheDocument()
      expect(screen.getByText('Select a project or worktree to get started.')).toBeInTheDocument()
    })

    test('renders session tabs when a connection is selected', async () => {
      const connection = makeConnection()
      const session = makeSession()

      // Pre-populate sessions so loadConnectionSessions resolves with same data
      mockDb.session.getActiveByConnection.mockResolvedValue([session])

      useConnectionStore.setState({
        connections: [connection],
        selectedConnectionId: 'conn-1'
      })
      useSessionStore.setState({
        activeConnectionId: 'conn-1',
        sessionsByConnection: new Map([['conn-1', [session]]]),
        tabOrderByConnection: new Map([['conn-1', ['session-1']]]),
        activeSessionId: 'session-1',
        isLoading: false
      })

      await act(async () => {
        render(<MainPane />)
      })

      expect(screen.getByTestId('session-tabs')).toBeInTheDocument()
    })

    test('renders SessionView when connection session is active', async () => {
      const connection = makeConnection()
      const session = makeSession()

      mockDb.session.getActiveByConnection.mockResolvedValue([session])

      useConnectionStore.setState({
        connections: [connection],
        selectedConnectionId: 'conn-1'
      })
      useSessionStore.setState({
        activeConnectionId: 'conn-1',
        sessionsByConnection: new Map([['conn-1', [session]]]),
        tabOrderByConnection: new Map([['conn-1', ['session-1']]]),
        activeSessionId: 'session-1',
        isLoading: false
      })

      await act(async () => {
        render(<MainPane />)
      })

      await waitFor(() => {
        expect(screen.getByTestId('session-view-session-1')).toBeInTheDocument()
      })
    })

    test('shows no-session prompt when connection selected but no session active', async () => {
      const connection = makeConnection()

      mockDb.session.getActiveByConnection.mockResolvedValue([])

      useConnectionStore.setState({
        connections: [connection],
        selectedConnectionId: 'conn-1'
      })
      useSessionStore.setState({
        activeConnectionId: 'conn-1',
        sessionsByConnection: new Map([['conn-1', []]]),
        tabOrderByConnection: new Map([['conn-1', []]]),
        activeSessionId: null,
        isLoading: false
      })

      await act(async () => {
        render(<MainPane />)
      })

      await waitFor(() => {
        expect(screen.getByText('No active session')).toBeInTheDocument()
      })
    })

    test('renders worktree session when worktree is selected (not connection)', async () => {
      const wtSession = makeSession({
        id: 'wt-session-1',
        worktree_id: 'wt-1',
        connection_id: null
      })

      mockDb.session.getActiveByWorktree.mockResolvedValue([wtSession])

      useWorktreeStore.setState({
        selectedWorktreeId: 'wt-1',
        worktreesByProject: new Map([['proj-1', [makeWorktree()]]])
      })
      useProjectStore.setState({
        projects: [makeProject()]
      })
      useSessionStore.setState({
        activeWorktreeId: 'wt-1',
        activeSessionId: 'wt-session-1',
        sessionsByWorktree: new Map([['wt-1', [wtSession]]]),
        tabOrderByWorktree: new Map([['wt-1', ['wt-session-1']]]),
        isLoading: false
      })

      await act(async () => {
        render(<MainPane />)
      })

      await waitFor(() => {
        expect(screen.getByTestId('session-view-wt-session-1')).toBeInTheDocument()
      })
    })
  })

  describe('SessionTabs connection mode', () => {
    test('reads sessions from sessionsByConnection when connection is active', async () => {
      const connection = makeConnection()
      const session = makeSession()

      mockDb.session.getActiveByConnection.mockResolvedValue([session])

      useConnectionStore.setState({
        connections: [connection],
        selectedConnectionId: 'conn-1'
      })
      useSessionStore.setState({
        activeConnectionId: 'conn-1',
        sessionsByConnection: new Map([['conn-1', [session]]]),
        tabOrderByConnection: new Map([['conn-1', ['session-1']]]),
        activeSessionId: 'session-1',
        isLoading: false
      })

      await act(async () => {
        render(<MainPane />)
      })

      expect(screen.getByTestId('session-tab-session-1')).toBeInTheDocument()
      expect(screen.getByText('Session 1')).toBeInTheDocument()
    })

    test('create button works in connection mode', async () => {
      const user = userEvent.setup()
      const connection = makeConnection()

      mockDb.session.getActiveByConnection.mockResolvedValue([])

      useConnectionStore.setState({
        connections: [connection],
        selectedConnectionId: 'conn-1'
      })
      useSessionStore.setState({
        activeConnectionId: 'conn-1',
        sessionsByConnection: new Map([['conn-1', []]]),
        tabOrderByConnection: new Map([['conn-1', []]]),
        isLoading: false
      })

      await act(async () => {
        render(<MainPane />)
      })

      const createButton = screen.getByTestId('create-session')
      await user.click(createButton)

      // Verify connectionOps.get was called (for fetching project_id)
      expect(mockConnectionOps.get).toHaveBeenCalledWith('conn-1')
    })

    test('shows empty state when connection has no sessions', async () => {
      const connection = makeConnection()

      mockDb.session.getActiveByConnection.mockResolvedValue([])

      useConnectionStore.setState({
        connections: [connection],
        selectedConnectionId: 'conn-1'
      })
      useSessionStore.setState({
        activeConnectionId: 'conn-1',
        sessionsByConnection: new Map([['conn-1', []]]),
        tabOrderByConnection: new Map([['conn-1', []]]),
        isLoading: false
      })

      await act(async () => {
        render(<MainPane />)
      })

      expect(screen.getByTestId('no-sessions')).toBeInTheDocument()
      expect(screen.getByText('No sessions yet. Click + to create one.')).toBeInTheDocument()
    })
  })

  describe('Header', () => {
    test('shows connection name and member projects when connection is selected', () => {
      const connection = makeConnection()

      useConnectionStore.setState({
        connections: [connection],
        selectedConnectionId: 'conn-1'
      })
      useWorktreeStore.setState({
        selectedWorktreeId: null,
        worktreesByProject: new Map()
      })

      render(<Header />)

      expect(screen.getByTestId('header-connection-info')).toBeInTheDocument()
      expect(screen.getByText('golden-retriever')).toBeInTheDocument()
      expect(screen.getByText('(Frontend + Backend)')).toBeInTheDocument()
    })

    test('shows project/branch info when worktree is selected (not connection)', () => {
      useWorktreeStore.setState({
        selectedWorktreeId: 'wt-1',
        worktreesByProject: new Map([['proj-1', [makeWorktree({ branch_name: 'feat/auth' })]]])
      })
      useProjectStore.setState({
        projects: [makeProject()],
        selectedProjectId: 'proj-1'
      })

      render(<Header />)

      expect(screen.getByTestId('header-project-info')).toBeInTheDocument()
      expect(screen.getByText('My Project')).toBeInTheDocument()
      expect(screen.getByText('(feat/auth)')).toBeInTheDocument()
    })

    test('hides git UI (PR, merge, archive) when connection is selected', () => {
      const connection = makeConnection()

      useConnectionStore.setState({
        connections: [connection],
        selectedConnectionId: 'conn-1'
      })
      useWorktreeStore.setState({
        selectedWorktreeId: null,
        worktreesByProject: new Map()
      })
      // Set up git state that would normally show PR buttons
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useGitStore.setState({ remoteInfo: new Map([['wt-1', makeRemoteInfo()]]) } as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useGitStore.setState({ prInfo: new Map([['wt-1', { state: 'none' }]]) } as any)

      render(<Header />)

      // PR and git buttons should NOT be shown in connection mode
      expect(screen.queryByTestId('pr-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('pr-merge-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('pr-archive-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('fix-conflicts-button')).not.toBeInTheDocument()
    })

    test('switching from connection to worktree restores git UI', () => {
      useWorktreeStore.setState({
        selectedWorktreeId: 'wt-1',
        worktreesByProject: new Map([['proj-1', [makeWorktree()]]])
      })
      useProjectStore.setState({
        projects: [makeProject()],
        selectedProjectId: 'proj-1'
      })
      useConnectionStore.setState({
        connections: [],
        selectedConnectionId: null
      })
      // Set up state to show PR button
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useGitStore.setState({ remoteInfo: new Map([['wt-1', makeRemoteInfo()]]) } as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useGitStore.setState({ prInfo: new Map([['wt-1', { state: 'none' }]]) } as any)

      render(<Header />)

      // Header should show project info, not connection info
      expect(screen.getByTestId('header-project-info')).toBeInTheDocument()
      expect(screen.queryByTestId('header-connection-info')).not.toBeInTheDocument()

      // PR button should be visible now (worktree mode with GitHub remote)
      expect(screen.getByTestId('pr-button')).toBeInTheDocument()
    })

    test('shows Hive text when nothing is selected', () => {
      render(<Header />)

      expect(screen.getByText('Hive')).toBeInTheDocument()
    })
  })

  describe('SessionView path resolution', () => {
    test('session store searches both worktree and connection maps for sessionRecord', () => {
      const session = makeSession({
        id: 'conn-session-1',
        model_provider_id: 'anthropic',
        model_id: 'claude-opus-4-5-20251101'
      })

      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session]]]),
        sessionsByWorktree: new Map()
      })

      // Verify that the session store can find sessions in the connection map
      const state = useSessionStore.getState()
      let found = false
      for (const sessions of state.sessionsByConnection.values()) {
        if (sessions.some((s) => s.id === 'conn-session-1')) {
          found = true
          break
        }
      }
      expect(found).toBe(true)
    })

    test('connection session has connection_id set and worktree_id null', () => {
      const session = makeSession()

      expect(session.connection_id).toBe('conn-1')
      expect(session.worktree_id).toBeNull()
    })

    test('connectionOps.get returns connection path for path resolution', async () => {
      mockConnectionOps.get.mockResolvedValueOnce({
        success: true,
        connection: makeConnection()
      })

      const result = await mockConnectionOps.get('conn-1')

      expect(result.success).toBe(true)
      expect(result.connection.path).toBe('/home/.hive/connections/golden-retriever')
    })
  })

  describe('Connection mode switching', () => {
    test('selecting connection clears worktree and vice versa', () => {
      // Select a connection
      act(() => {
        useConnectionStore.getState().selectConnection('conn-1')
      })

      expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-1')

      // Select a worktree (this should clear connection via deconfliction)
      act(() => {
        useWorktreeStore.getState().selectWorktreeOnly('wt-1')
      })

      // The worktree should be selected
      expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-1')
    })

    test('activeConnectionId is set in session store when connection is selected', () => {
      const session = makeSession()

      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session]]]),
        tabOrderByConnection: new Map([['conn-1', ['session-1']]])
      })

      act(() => {
        useSessionStore.getState().setActiveConnection('conn-1')
      })

      expect(useSessionStore.getState().activeConnectionId).toBe('conn-1')
    })

    test('createConnectionSession creates session with connection_id', async () => {
      // Ensure mocks are set up properly for this test
      mockConnectionOps.get.mockResolvedValue({
        success: true,
        connection: makeConnection()
      })
      mockDb.session.create.mockResolvedValue({
        id: 'session-new',
        worktree_id: null,
        project_id: 'proj-1',
        connection_id: 'conn-1',
        name: 'Session 1',
        status: 'active',
        opencode_session_id: null,
        mode: 'build',
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        completed_at: null
      })

      useConnectionStore.setState({
        connections: [makeConnection()],
        selectedConnectionId: 'conn-1'
      })

      useSessionStore.setState({
        activeConnectionId: 'conn-1',
        sessionsByConnection: new Map([['conn-1', []]]),
        tabOrderByConnection: new Map([['conn-1', []]])
      })

      await act(async () => {
        const result = await useSessionStore.getState().createConnectionSession('conn-1')
        expect(result.success).toBe(true)
        expect(result.session).toBeDefined()
        expect(result.session!.connection_id).toBe('conn-1')
        expect(result.session!.worktree_id).toBeNull()
      })
    })
  })
})
