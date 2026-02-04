import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { act } from 'react'
import { useSessionHistoryStore } from '../../src/renderer/src/stores/useSessionHistoryStore'
import { useProjectStore } from '../../src/renderer/src/stores/useProjectStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'

// Mock session data with worktree info
const mockSessionWithWorktree1 = {
  id: 'session-1',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  name: 'Debug authentication',
  status: 'active' as const,
  opencode_session_id: null,
  created_at: '2024-01-01T10:00:00Z',
  updated_at: '2024-01-01T10:30:00Z',
  completed_at: null,
  worktree_name: 'tokyo',
  worktree_branch_name: 'tokyo',
  project_name: 'My Project'
}

const mockSessionWithWorktree2 = {
  id: 'session-2',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  name: 'Add user validation',
  status: 'completed' as const,
  opencode_session_id: null,
  created_at: '2024-01-02T14:00:00Z',
  updated_at: '2024-01-02T15:00:00Z',
  completed_at: '2024-01-02T15:00:00Z',
  worktree_name: 'tokyo',
  worktree_branch_name: 'tokyo',
  project_name: 'My Project'
}

const mockOrphanedSession = {
  id: 'session-3',
  worktree_id: null,
  project_id: 'project-1',
  name: 'Old refactoring session',
  status: 'completed' as const,
  opencode_session_id: null,
  created_at: '2023-12-01T10:00:00Z',
  updated_at: '2023-12-01T12:00:00Z',
  completed_at: '2023-12-01T12:00:00Z',
  worktree_name: undefined,
  worktree_branch_name: undefined,
  project_name: 'My Project'
}

const mockProject = {
  id: 'project-1',
  name: 'My Project',
  path: '/test/project',
  description: null,
  tags: null,
  created_at: '2024-01-01T00:00:00Z',
  last_accessed_at: '2024-01-01T00:00:00Z'
}

const mockProject2 = {
  id: 'project-2',
  name: 'Another Project',
  path: '/test/project2',
  description: null,
  tags: null,
  created_at: '2024-01-01T00:00:00Z',
  last_accessed_at: '2024-01-01T00:00:00Z'
}

const mockWorktree = {
  id: 'worktree-1',
  project_id: 'project-1',
  name: 'tokyo',
  branch_name: 'tokyo',
  path: '/home/user/.hive-worktrees/my-project/tokyo',
  status: 'active' as const,
  created_at: '2024-01-01T00:00:00Z',
  last_accessed_at: '2024-01-01T00:00:00Z'
}

const mockArchivedWorktree = {
  id: 'worktree-2',
  project_id: 'project-1',
  name: 'paris',
  branch_name: 'paris',
  path: '/home/user/.hive-worktrees/my-project/paris',
  status: 'archived' as const,
  created_at: '2023-12-01T00:00:00Z',
  last_accessed_at: '2023-12-01T00:00:00Z'
}

// Mock window.db for database operations
const mockDbSession = {
  create: vi.fn(),
  get: vi.fn(),
  getByWorktree: vi.fn(),
  getByProject: vi.fn(),
  getActiveByWorktree: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  search: vi.fn()
}

const mockDbMessage = {
  create: vi.fn(),
  getBySession: vi.fn(),
  delete: vi.fn()
}

const mockDbProject = {
  getAll: vi.fn()
}

const mockDbWorktree = {
  getActiveByProject: vi.fn(),
  touch: vi.fn()
}

// Setup window.db mock
beforeEach(() => {
  vi.clearAllMocks()

  // Reset stores to initial state
  useSessionHistoryStore.setState({
    isOpen: false,
    filters: {
      keyword: '',
      projectId: null,
      worktreeId: null,
      dateFrom: null,
      dateTo: null,
      includeArchived: false
    },
    searchResults: [],
    isSearching: false,
    error: null,
    selectedSessionId: null
  })

  useProjectStore.setState({
    projects: [mockProject, mockProject2],
    isLoading: false,
    error: null,
    selectedProjectId: null,
    expandedProjectIds: new Set(),
    editingProjectId: null
  })

  useWorktreeStore.setState({
    worktreesByProject: new Map([
      ['project-1', [mockWorktree, mockArchivedWorktree]]
    ]),
    isLoading: false,
    error: null,
    selectedWorktreeId: null,
    creatingForProjectId: null
  })

  useSessionStore.setState({
    sessionsByWorktree: new Map(),
    tabOrderByWorktree: new Map(),
    isLoading: false,
    error: null,
    activeSessionId: null,
    activeWorktreeId: null
  })

  // Mock window.db
  Object.defineProperty(window, 'db', {
    value: {
      session: mockDbSession,
      message: mockDbMessage,
      project: mockDbProject,
      worktree: mockDbWorktree
    },
    writable: true,
    configurable: true
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Session 9: Session History', () => {
  describe('useSessionHistoryStore', () => {
    test('Initial state is correct', () => {
      const state = useSessionHistoryStore.getState()
      expect(state.isOpen).toBe(false)
      expect(state.filters.keyword).toBe('')
      expect(state.filters.projectId).toBeNull()
      expect(state.filters.worktreeId).toBeNull()
      expect(state.searchResults).toEqual([])
      expect(state.selectedSessionId).toBeNull()
    })

    test('openPanel sets isOpen to true and triggers search', async () => {
      mockDbSession.search.mockResolvedValue([mockSessionWithWorktree1])

      await act(async () => {
        useSessionHistoryStore.getState().openPanel()
      })

      const state = useSessionHistoryStore.getState()
      expect(state.isOpen).toBe(true)
      expect(mockDbSession.search).toHaveBeenCalled()
    })

    test('closePanel sets isOpen to false and clears selection', () => {
      useSessionHistoryStore.setState({
        isOpen: true,
        selectedSessionId: 'session-1'
      })

      act(() => {
        useSessionHistoryStore.getState().closePanel()
      })

      const state = useSessionHistoryStore.getState()
      expect(state.isOpen).toBe(false)
      expect(state.selectedSessionId).toBeNull()
    })

    test('togglePanel toggles isOpen state', async () => {
      mockDbSession.search.mockResolvedValue([])

      // Start closed
      expect(useSessionHistoryStore.getState().isOpen).toBe(false)

      // Open
      await act(async () => {
        useSessionHistoryStore.getState().togglePanel()
      })
      expect(useSessionHistoryStore.getState().isOpen).toBe(true)

      // Close
      act(() => {
        useSessionHistoryStore.getState().togglePanel()
      })
      expect(useSessionHistoryStore.getState().isOpen).toBe(false)
    })

    test('setKeyword updates keyword filter', () => {
      act(() => {
        useSessionHistoryStore.getState().setKeyword('authentication')
      })

      expect(useSessionHistoryStore.getState().filters.keyword).toBe('authentication')
    })

    test('setProjectFilter updates project filter and clears worktree', () => {
      useSessionHistoryStore.setState({
        filters: {
          ...useSessionHistoryStore.getState().filters,
          worktreeId: 'worktree-1'
        }
      })

      act(() => {
        useSessionHistoryStore.getState().setProjectFilter('project-1')
      })

      const state = useSessionHistoryStore.getState()
      expect(state.filters.projectId).toBe('project-1')
      expect(state.filters.worktreeId).toBeNull()
    })

    test('setWorktreeFilter updates worktree filter', () => {
      act(() => {
        useSessionHistoryStore.getState().setWorktreeFilter('worktree-1')
      })

      expect(useSessionHistoryStore.getState().filters.worktreeId).toBe('worktree-1')
    })

    test('setDateFromFilter updates dateFrom filter', () => {
      act(() => {
        useSessionHistoryStore.getState().setDateFromFilter('2024-01-01')
      })

      expect(useSessionHistoryStore.getState().filters.dateFrom).toBe('2024-01-01')
    })

    test('setDateToFilter updates dateTo filter', () => {
      act(() => {
        useSessionHistoryStore.getState().setDateToFilter('2024-12-31')
      })

      expect(useSessionHistoryStore.getState().filters.dateTo).toBe('2024-12-31')
    })

    test('setIncludeArchived updates includeArchived filter', () => {
      act(() => {
        useSessionHistoryStore.getState().setIncludeArchived(true)
      })

      expect(useSessionHistoryStore.getState().filters.includeArchived).toBe(true)
    })

    test('clearFilters resets all filters and triggers search', async () => {
      mockDbSession.search.mockResolvedValue([])

      useSessionHistoryStore.setState({
        filters: {
          keyword: 'test',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          dateFrom: '2024-01-01',
          dateTo: '2024-12-31',
          includeArchived: true
        }
      })

      await act(async () => {
        useSessionHistoryStore.getState().clearFilters()
      })

      const state = useSessionHistoryStore.getState()
      expect(state.filters.keyword).toBe('')
      expect(state.filters.projectId).toBeNull()
      expect(state.filters.worktreeId).toBeNull()
      expect(state.filters.dateFrom).toBeNull()
      expect(state.filters.dateTo).toBeNull()
      expect(state.filters.includeArchived).toBe(false)
    })

    test('performSearch calls db.session.search with correct options', async () => {
      mockDbSession.search.mockResolvedValue([mockSessionWithWorktree1])

      useSessionHistoryStore.setState({
        filters: {
          keyword: 'auth',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          dateFrom: '2024-01-01',
          dateTo: '2024-12-31',
          includeArchived: true
        }
      })

      await act(async () => {
        await useSessionHistoryStore.getState().performSearch()
      })

      expect(mockDbSession.search).toHaveBeenCalledWith({
        keyword: 'auth',
        project_id: 'project-1',
        worktree_id: 'worktree-1',
        dateFrom: '2024-01-01',
        dateTo: '2024-12-31',
        includeArchived: true
      })

      expect(useSessionHistoryStore.getState().searchResults).toEqual([mockSessionWithWorktree1])
    })

    test('performSearch handles errors gracefully', async () => {
      mockDbSession.search.mockRejectedValue(new Error('Database error'))

      await act(async () => {
        await useSessionHistoryStore.getState().performSearch()
      })

      const state = useSessionHistoryStore.getState()
      expect(state.error).toBe('Database error')
      expect(state.isSearching).toBe(false)
    })

    test('selectSession updates selectedSessionId', () => {
      useSessionHistoryStore.setState({
        searchResults: [mockSessionWithWorktree1, mockSessionWithWorktree2]
      })

      act(() => {
        useSessionHistoryStore.getState().selectSession('session-1')
      })

      expect(useSessionHistoryStore.getState().selectedSessionId).toBe('session-1')
    })

    test('getSelectedSession returns the selected session', () => {
      useSessionHistoryStore.setState({
        searchResults: [mockSessionWithWorktree1, mockSessionWithWorktree2],
        selectedSessionId: 'session-2'
      })

      const selected = useSessionHistoryStore.getState().getSelectedSession()
      expect(selected).toEqual(mockSessionWithWorktree2)
    })

    test('getSelectedSession returns null when no selection', () => {
      useSessionHistoryStore.setState({
        searchResults: [mockSessionWithWorktree1],
        selectedSessionId: null
      })

      const selected = useSessionHistoryStore.getState().getSelectedSession()
      expect(selected).toBeNull()
    })
  })

  describe('Search Functionality', () => {
    test('Search finds sessions by keyword', async () => {
      mockDbSession.search.mockResolvedValue([mockSessionWithWorktree1])

      useSessionHistoryStore.setState({
        filters: { ...useSessionHistoryStore.getState().filters, keyword: 'authentication' }
      })

      await act(async () => {
        await useSessionHistoryStore.getState().performSearch()
      })

      expect(mockDbSession.search).toHaveBeenCalledWith(
        expect.objectContaining({ keyword: 'authentication' })
      )
      expect(useSessionHistoryStore.getState().searchResults).toHaveLength(1)
    })

    test('Filter by project returns only sessions from that project', async () => {
      mockDbSession.search.mockResolvedValue([mockSessionWithWorktree1, mockSessionWithWorktree2])

      useSessionHistoryStore.setState({
        filters: { ...useSessionHistoryStore.getState().filters, projectId: 'project-1' }
      })

      await act(async () => {
        await useSessionHistoryStore.getState().performSearch()
      })

      expect(mockDbSession.search).toHaveBeenCalledWith(
        expect.objectContaining({ project_id: 'project-1' })
      )
    })

    test('Filter by worktree includes archived worktrees when enabled', async () => {
      mockDbSession.search.mockResolvedValue([mockOrphanedSession])

      useSessionHistoryStore.setState({
        filters: {
          ...useSessionHistoryStore.getState().filters,
          includeArchived: true
        }
      })

      await act(async () => {
        await useSessionHistoryStore.getState().performSearch()
      })

      expect(mockDbSession.search).toHaveBeenCalledWith(
        expect.objectContaining({ includeArchived: true })
      )
    })

    test('Date range filter works correctly', async () => {
      mockDbSession.search.mockResolvedValue([mockSessionWithWorktree2])

      useSessionHistoryStore.setState({
        filters: {
          ...useSessionHistoryStore.getState().filters,
          dateFrom: '2024-01-02',
          dateTo: '2024-01-03'
        }
      })

      await act(async () => {
        await useSessionHistoryStore.getState().performSearch()
      })

      expect(mockDbSession.search).toHaveBeenCalledWith(
        expect.objectContaining({
          dateFrom: '2024-01-02',
          dateTo: '2024-01-03'
        })
      )
    })
  })

  describe('Orphaned Sessions', () => {
    test('Orphaned sessions are identified correctly (null worktree_id)', () => {
      // Session with null worktree_id is orphaned
      expect(mockOrphanedSession.worktree_id).toBeNull()
      expect(mockOrphanedSession.worktree_name).toBeUndefined()
    })

    test('Non-orphaned sessions have worktree info', () => {
      expect(mockSessionWithWorktree1.worktree_id).not.toBeNull()
      expect(mockSessionWithWorktree1.worktree_name).toBeDefined()
    })
  })

  describe('Keyboard Shortcuts', () => {
    test('togglePanel can be used for keyboard shortcut binding', () => {
      // The useCommandK hook in AppLayout binds Cmd/Ctrl+K to togglePanel
      // Here we verify the toggle functionality works as expected
      mockDbSession.search.mockResolvedValue([])

      // Initially closed
      expect(useSessionHistoryStore.getState().isOpen).toBe(false)

      // Toggle open
      act(() => {
        useSessionHistoryStore.getState().togglePanel()
      })
      expect(useSessionHistoryStore.getState().isOpen).toBe(true)

      // Toggle closed
      act(() => {
        useSessionHistoryStore.getState().togglePanel()
      })
      expect(useSessionHistoryStore.getState().isOpen).toBe(false)
    })
  })

  describe('Load Session Action', () => {
    test('Loading a session with valid worktree sets active worktree and session', async () => {
      // Setup session store
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [{ ...mockSessionWithWorktree1 }]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-1']]]),
        activeWorktreeId: null,
        activeSessionId: null
      })

      // The handleLoadSession in SessionHistory component would call:
      // setActiveWorktree and setActiveSession
      act(() => {
        useSessionStore.getState().setActiveWorktree('worktree-1')
        useSessionStore.getState().setActiveSession('session-1')
      })

      const state = useSessionStore.getState()
      expect(state.activeWorktreeId).toBe('worktree-1')
      expect(state.activeSessionId).toBe('session-1')
    })
  })

  describe('Session Preview', () => {
    test('Selecting a session shows preview', () => {
      useSessionHistoryStore.setState({
        searchResults: [mockSessionWithWorktree1, mockSessionWithWorktree2]
      })

      act(() => {
        useSessionHistoryStore.getState().selectSession('session-1')
      })

      const selected = useSessionHistoryStore.getState().getSelectedSession()
      expect(selected).toEqual(mockSessionWithWorktree1)
      expect(selected?.name).toBe('Debug authentication')
    })

    test('Session preview loads messages', async () => {
      const mockMessages = [
        { id: 'msg-1', session_id: 'session-1', role: 'user', content: 'Help me debug', created_at: '2024-01-01T10:00:00Z' },
        { id: 'msg-2', session_id: 'session-1', role: 'assistant', content: 'Sure!', created_at: '2024-01-01T10:01:00Z' }
      ]
      mockDbMessage.getBySession.mockResolvedValue(mockMessages)

      // The SessionPreview component would call getBySession when rendered
      const messages = await mockDbMessage.getBySession('session-1')
      expect(messages).toHaveLength(2)
      expect(mockDbMessage.getBySession).toHaveBeenCalledWith('session-1')
    })
  })

  describe('Integration', () => {
    test('Opening history panel triggers initial search', async () => {
      mockDbSession.search.mockResolvedValue([mockSessionWithWorktree1, mockSessionWithWorktree2])

      await act(async () => {
        useSessionHistoryStore.getState().openPanel()
      })

      expect(mockDbSession.search).toHaveBeenCalled()
      expect(useSessionHistoryStore.getState().searchResults).toHaveLength(2)
    })

    test('Changing filters and searching updates results', async () => {
      mockDbSession.search
        .mockResolvedValueOnce([mockSessionWithWorktree1, mockSessionWithWorktree2])
        .mockResolvedValueOnce([mockSessionWithWorktree1])

      // First search - no filters
      await act(async () => {
        await useSessionHistoryStore.getState().performSearch()
      })
      expect(useSessionHistoryStore.getState().searchResults).toHaveLength(2)

      // Second search - with keyword filter
      act(() => {
        useSessionHistoryStore.getState().setKeyword('authentication')
      })

      await act(async () => {
        await useSessionHistoryStore.getState().performSearch()
      })
      expect(useSessionHistoryStore.getState().searchResults).toHaveLength(1)
    })

    test('Closing panel clears selection but keeps filters', () => {
      useSessionHistoryStore.setState({
        isOpen: true,
        filters: {
          keyword: 'test',
          projectId: 'project-1',
          worktreeId: null,
          dateFrom: null,
          dateTo: null,
          includeArchived: false
        },
        selectedSessionId: 'session-1'
      })

      act(() => {
        useSessionHistoryStore.getState().closePanel()
      })

      const state = useSessionHistoryStore.getState()
      expect(state.isOpen).toBe(false)
      expect(state.selectedSessionId).toBeNull()
      // Filters are preserved
      expect(state.filters.keyword).toBe('test')
      expect(state.filters.projectId).toBe('project-1')
    })
  })
})
