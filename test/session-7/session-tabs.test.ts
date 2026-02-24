import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { act } from 'react'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'
import { useProjectStore } from '../../src/renderer/src/stores/useProjectStore'
import { useGitStore } from '../../src/renderer/src/stores/useGitStore'

// Mock session data
const mockSession1 = {
  id: 'session-1',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  name: 'Session 1',
  status: 'active' as const,
  opencode_session_id: null,
  created_at: '2024-01-01T10:00:00Z',
  updated_at: '2024-01-01T10:00:00Z',
  completed_at: null
}

const mockSession2 = {
  id: 'session-2',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  name: 'Session 2',
  status: 'active' as const,
  opencode_session_id: null,
  created_at: '2024-01-01T11:00:00Z',
  updated_at: '2024-01-01T11:00:00Z',
  completed_at: null
}

const mockSession3 = {
  id: 'session-3',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  name: 'Session 3',
  status: 'active' as const,
  opencode_session_id: null,
  created_at: '2024-01-01T12:00:00Z',
  updated_at: '2024-01-01T12:00:00Z',
  completed_at: null
}

const mockProject = {
  id: 'project-1',
  name: 'Test Project',
  path: '/test/project',
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
  path: '/home/user/.hive-worktrees/test-project/tokyo',
  status: 'active' as const,
  created_at: '2024-01-01T00:00:00Z',
  last_accessed_at: '2024-01-01T00:00:00Z'
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
  useSessionStore.setState({
    sessionsByWorktree: new Map(),
    tabOrderByWorktree: new Map(),
    isLoading: false,
    error: null,
    activeSessionId: null,
    activeWorktreeId: null
  })

  useWorktreeStore.setState({
    worktreesByProject: new Map([['project-1', [mockWorktree]]]),
    isLoading: false,
    error: null,
    selectedWorktreeId: null,
    creatingForProjectId: null
  })

  useProjectStore.setState({
    projects: [mockProject],
    isLoading: false,
    error: null,
    selectedProjectId: null,
    expandedProjectIds: new Set(),
    editingProjectId: null
  })

  useGitStore.setState({
    prInfo: new Map()
  })

  // Mock window.db
  Object.defineProperty(window, 'db', {
    value: {
      session: mockDbSession,
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

describe('Session 7: Session Tabs', () => {
  describe('Session Store', () => {
    test('Initial state is correct', () => {
      const state = useSessionStore.getState()
      expect(state.sessionsByWorktree.size).toBe(0)
      expect(state.tabOrderByWorktree.size).toBe(0)
      expect(state.activeSessionId).toBeNull()
      expect(state.activeWorktreeId).toBeNull()
      expect(state.isLoading).toBe(false)
    })

    test('loadSessions loads active sessions for a worktree', async () => {
      mockDbSession.getActiveByWorktree.mockResolvedValue([mockSession1, mockSession2])

      await act(async () => {
        await useSessionStore.getState().loadSessions('worktree-1', 'project-1')
      })

      const state = useSessionStore.getState()
      const sessions = state.sessionsByWorktree.get('worktree-1')
      expect(sessions).toHaveLength(2)
      expect(mockDbSession.getActiveByWorktree).toHaveBeenCalledWith('worktree-1')
    })

    test('createSession creates a new session', async () => {
      const newSession = {
        ...mockSession1,
        id: 'new-session',
        name: 'Session 10:30'
      }
      mockDbSession.create.mockResolvedValue(newSession)

      const result = await act(async () => {
        return await useSessionStore.getState().createSession('worktree-1', 'project-1')
      })

      expect(result.success).toBe(true)
      expect(result.session).toBeDefined()
      expect(mockDbSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          worktree_id: 'worktree-1',
          project_id: 'project-1',
          name: expect.stringMatching(/^Session \d+$/),
          agent_sdk: 'opencode'
        })
      )

      const state = useSessionStore.getState()
      expect(state.activeSessionId).toBe('new-session')
    })

    test('closeSession marks session as completed and removes from tabs', async () => {
      // Setup initial state with sessions
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1, mockSession2]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-1', 'session-2']]]),
        activeSessionId: 'session-1',
        activeWorktreeId: 'worktree-1'
      })

      mockDbSession.update.mockResolvedValue({ ...mockSession1, status: 'completed' })

      const result = await act(async () => {
        return await useSessionStore.getState().closeSession('session-1')
      })

      expect(result.success).toBe(true)
      // Should update with completed status, not delete
      expect(mockDbSession.update).toHaveBeenCalledWith('session-1', {
        status: 'completed',
        completed_at: expect.any(String)
      })

      const state = useSessionStore.getState()
      const sessions = state.sessionsByWorktree.get('worktree-1')
      expect(sessions).toHaveLength(1)
      expect(sessions![0].id).toBe('session-2')
      // Should select next session after closing
      expect(state.activeSessionId).toBe('session-2')
    })

    test('closeSession resets PR creating state for that session only', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1, mockSession2]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-1', 'session-2']]]),
        activeSessionId: 'session-1',
        activeWorktreeId: 'worktree-1'
      })

      useGitStore.setState({
        prInfo: new Map([
          [
            'worktree-1',
            {
              state: 'creating',
              sessionId: 'session-1',
              targetBranch: 'origin/main'
            }
          ],
          [
            'worktree-2',
            {
              state: 'creating',
              sessionId: 'session-other',
              targetBranch: 'origin/main'
            }
          ]
        ])
      })

      mockDbSession.update.mockResolvedValue({ ...mockSession1, status: 'completed' })

      await act(async () => {
        await useSessionStore.getState().closeSession('session-1')
      })

      expect(useGitStore.getState().prInfo.get('worktree-1')?.state).toBe('none')
      expect(useGitStore.getState().prInfo.get('worktree-2')?.state).toBe('creating')
    })

    test('closeSession does not reset non-creating PR state', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-1']]]),
        activeSessionId: 'session-1',
        activeWorktreeId: 'worktree-1'
      })

      useGitStore.setState({
        prInfo: new Map([
          [
            'worktree-1',
            {
              state: 'created',
              sessionId: 'session-1',
              targetBranch: 'origin/main',
              prNumber: 42,
              prUrl: 'https://github.com/org/repo/pull/42'
            }
          ]
        ])
      })

      mockDbSession.update.mockResolvedValue({ ...mockSession1, status: 'completed' })

      await act(async () => {
        await useSessionStore.getState().closeSession('session-1')
      })

      expect(useGitStore.getState().prInfo.get('worktree-1')?.state).toBe('created')
    })

    test('closeSession selects previous session when closing last tab', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1, mockSession2]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-1', 'session-2']]]),
        activeSessionId: 'session-2',
        activeWorktreeId: 'worktree-1'
      })

      mockDbSession.update.mockResolvedValue({ ...mockSession2, status: 'completed' })

      await act(async () => {
        await useSessionStore.getState().closeSession('session-2')
      })

      const state = useSessionStore.getState()
      // Should select session-1 (the remaining session)
      expect(state.activeSessionId).toBe('session-1')
    })

    test('closeSession clears activeSessionId when closing last session', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-1']]]),
        activeSessionId: 'session-1',
        activeWorktreeId: 'worktree-1'
      })

      mockDbSession.update.mockResolvedValue({ ...mockSession1, status: 'completed' })

      await act(async () => {
        await useSessionStore.getState().closeSession('session-1')
      })

      const state = useSessionStore.getState()
      expect(state.activeSessionId).toBeNull()
    })

    test('setActiveSession updates active session', () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1, mockSession2]]]),
        activeSessionId: 'session-1'
      })

      act(() => {
        useSessionStore.getState().setActiveSession('session-2')
      })

      expect(useSessionStore.getState().activeSessionId).toBe('session-2')
    })

    test('setActiveWorktree updates active worktree', () => {
      act(() => {
        useSessionStore.getState().setActiveWorktree('worktree-1')
      })

      expect(useSessionStore.getState().activeWorktreeId).toBe('worktree-1')
    })

    test('reorderTabs reorders tab order', () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1, mockSession2, mockSession3]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-1', 'session-2', 'session-3']]])
      })

      act(() => {
        useSessionStore.getState().reorderTabs('worktree-1', 0, 2)
      })

      const tabOrder = useSessionStore.getState().tabOrderByWorktree.get('worktree-1')
      expect(tabOrder).toEqual(['session-2', 'session-3', 'session-1'])
    })

    test('reorderTabs handles invalid indices gracefully', () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1, mockSession2]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-1', 'session-2']]])
      })

      act(() => {
        useSessionStore.getState().reorderTabs('worktree-1', -1, 5)
      })

      // Should remain unchanged
      const tabOrder = useSessionStore.getState().tabOrderByWorktree.get('worktree-1')
      expect(tabOrder).toEqual(['session-1', 'session-2'])
    })

    test('getSessionsForWorktree returns sessions for worktree', () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1, mockSession2]]])
      })

      const sessions = useSessionStore.getState().getSessionsForWorktree('worktree-1')
      expect(sessions).toHaveLength(2)
    })

    test('getSessionsForWorktree returns empty array for unknown worktree', () => {
      const sessions = useSessionStore.getState().getSessionsForWorktree('unknown')
      expect(sessions).toEqual([])
    })

    test('updateSessionName updates session name', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1]]])
      })

      mockDbSession.update.mockResolvedValue({ ...mockSession1, name: 'New Name' })

      const result = await act(async () => {
        return await useSessionStore.getState().updateSessionName('session-1', 'New Name')
      })

      expect(result).toBe(true)
      expect(mockDbSession.update).toHaveBeenCalledWith('session-1', { name: 'New Name' })
    })
  })

  describe('Session Tabs Integration', () => {
    test('Switching worktree shows different sessions', async () => {
      const worktree2Sessions = [{ ...mockSession1, id: 'w2-session-1', worktree_id: 'worktree-2' }]

      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['worktree-1', [mockSession1, mockSession2]],
          ['worktree-2', worktree2Sessions]
        ]),
        tabOrderByWorktree: new Map([
          ['worktree-1', ['session-1', 'session-2']],
          ['worktree-2', ['w2-session-1']]
        ]),
        activeWorktreeId: 'worktree-1',
        activeSessionId: 'session-1'
      })

      // Switch to worktree-2
      act(() => {
        useSessionStore.getState().setActiveWorktree('worktree-2')
      })

      const state = useSessionStore.getState()
      expect(state.activeWorktreeId).toBe('worktree-2')
      expect(state.activeSessionId).toBe('w2-session-1')
    })

    test('Empty state when no sessions for worktree', async () => {
      mockDbSession.getActiveByWorktree.mockResolvedValue([])

      await act(async () => {
        await useSessionStore.getState().loadSessions('worktree-1', 'project-1')
      })

      const sessions = useSessionStore.getState().getSessionsForWorktree('worktree-1')
      expect(sessions).toHaveLength(0)
    })

    test('Sessions are persisted to database via create', async () => {
      mockDbSession.create.mockResolvedValue({
        id: 'new-session',
        worktree_id: 'worktree-1',
        project_id: 'project-1',
        name: 'Session 14:30',
        status: 'active',
        opencode_session_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      })

      await act(async () => {
        await useSessionStore.getState().createSession('worktree-1', 'project-1')
      })

      expect(mockDbSession.create).toHaveBeenCalled()
    })

    test('Tab order is maintained across operations', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1, mockSession2, mockSession3]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-3', 'session-1', 'session-2']]])
      })

      // Get tab order
      const order = useSessionStore.getState().getTabOrderForWorktree('worktree-1')
      expect(order).toEqual(['session-3', 'session-1', 'session-2'])

      // Reorder tabs
      act(() => {
        useSessionStore.getState().reorderTabs('worktree-1', 2, 0)
      })

      const newOrder = useSessionStore.getState().getTabOrderForWorktree('worktree-1')
      expect(newOrder).toEqual(['session-2', 'session-3', 'session-1'])
    })
  })

  describe('Error Handling', () => {
    test('loadSessions handles errors gracefully', async () => {
      mockDbSession.getActiveByWorktree.mockRejectedValue(new Error('Database error'))

      await act(async () => {
        await useSessionStore.getState().loadSessions('worktree-1', 'project-1')
      })

      const state = useSessionStore.getState()
      expect(state.error).toBe('Database error')
      expect(state.isLoading).toBe(false)
    })

    test('createSession handles errors gracefully', async () => {
      mockDbSession.create.mockRejectedValue(new Error('Failed to create'))

      const result = await act(async () => {
        return await useSessionStore.getState().createSession('worktree-1', 'project-1')
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Failed to create')
    })

    test('closeSession handles database errors', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-1']]]),
        activeSessionId: 'session-1'
      })

      mockDbSession.update.mockRejectedValue(new Error('Database error'))

      const result = await act(async () => {
        return await useSessionStore.getState().closeSession('session-1')
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Database error')
    })
  })
})
