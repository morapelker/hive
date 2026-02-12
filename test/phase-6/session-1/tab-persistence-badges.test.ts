import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { act } from 'react'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStatusStore } from '../../../src/renderer/src/stores/useWorktreeStatusStore'

// Mock session data
const mockSession1 = {
  id: 'session-1',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  name: 'Session 1',
  status: 'active' as const,
  opencode_session_id: null,
  mode: 'build' as const,
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
  mode: 'build' as const,
  created_at: '2024-01-01T11:00:00Z',
  updated_at: '2024-01-01T11:00:00Z',
  completed_at: null
}

const mockSession3 = {
  id: 'session-3',
  worktree_id: 'worktree-2',
  project_id: 'project-1',
  name: 'Session 3',
  status: 'active' as const,
  opencode_session_id: null,
  mode: 'build' as const,
  created_at: '2024-01-01T12:00:00Z',
  updated_at: '2024-01-01T12:00:00Z',
  completed_at: null
}

// Mock window.db
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

beforeEach(() => {
  vi.clearAllMocks()

  // Reset stores to initial state
  useSessionStore.setState({
    sessionsByWorktree: new Map(),
    tabOrderByWorktree: new Map(),
    modeBySession: new Map(),
    isLoading: false,
    error: null,
    activeSessionId: null,
    activeWorktreeId: null,
    activeSessionByWorktree: {}
  })

  useWorktreeStatusStore.setState({
    sessionStatuses: {}
  })

  // Mock window.db
  Object.defineProperty(window, 'db', {
    value: { session: mockDbSession },
    writable: true,
    configurable: true
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Session 1: Tab Persistence & Badges', () => {
  describe('Tab Persistence - activeSessionByWorktree', () => {
    test('activeSessionByWorktree is initialized as empty object', () => {
      const state = useSessionStore.getState()
      expect(state.activeSessionByWorktree).toEqual({})
    })

    test('setActiveSession records mapping to activeSessionByWorktree', () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1, mockSession2]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-1', 'session-2']]]),
        activeWorktreeId: 'worktree-1'
      })

      act(() => {
        useSessionStore.getState().setActiveSession('session-2')
      })

      const state = useSessionStore.getState()
      expect(state.activeSessionId).toBe('session-2')
      expect(state.activeSessionByWorktree['worktree-1']).toBe('session-2')
    })

    test('Switching worktrees restores last active session', () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['worktree-1', [mockSession1, mockSession2]],
          ['worktree-2', [mockSession3]]
        ]),
        tabOrderByWorktree: new Map([
          ['worktree-1', ['session-1', 'session-2']],
          ['worktree-2', ['session-3']]
        ]),
        activeWorktreeId: 'worktree-1',
        activeSessionId: 'session-2',
        activeSessionByWorktree: {
          'worktree-1': 'session-2',
          'worktree-2': 'session-3'
        }
      })

      // Switch to worktree-2
      act(() => {
        useSessionStore.getState().setActiveWorktree('worktree-2')
      })

      expect(useSessionStore.getState().activeSessionId).toBe('session-3')

      // Switch back to worktree-1
      act(() => {
        useSessionStore.getState().setActiveWorktree('worktree-1')
      })

      expect(useSessionStore.getState().activeSessionId).toBe('session-2')
    })

    test('Stale session ID handled gracefully - falls back to first tab', () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['worktree-1', [mockSession1, mockSession2]]
        ]),
        tabOrderByWorktree: new Map([
          ['worktree-1', ['session-1', 'session-2']]
        ]),
        activeWorktreeId: 'worktree-2',
        activeSessionByWorktree: {
          'worktree-1': 'deleted-session'
        }
      })

      // Switch to worktree-1 where the persisted session no longer exists
      act(() => {
        useSessionStore.getState().setActiveWorktree('worktree-1')
      })

      // Should fall back to first tab, not the deleted session
      expect(useSessionStore.getState().activeSessionId).toBe('session-1')
    })

    test('loadSessions restores persisted active session', async () => {
      useSessionStore.setState({
        activeWorktreeId: 'worktree-1',
        activeSessionByWorktree: {
          'worktree-1': 'session-2'
        }
      })

      mockDbSession.getActiveByWorktree.mockResolvedValue([mockSession1, mockSession2])

      await act(async () => {
        await useSessionStore.getState().loadSessions('worktree-1', 'project-1')
      })

      // Should restore the persisted session-2 instead of defaulting to first
      expect(useSessionStore.getState().activeSessionId).toBe('session-2')
    })

    test('loadSessions falls back to first tab when persisted session not found', async () => {
      useSessionStore.setState({
        activeWorktreeId: 'worktree-1',
        activeSessionByWorktree: {
          'worktree-1': 'deleted-session'
        }
      })

      mockDbSession.getActiveByWorktree.mockResolvedValue([mockSession1, mockSession2])

      await act(async () => {
        await useSessionStore.getState().loadSessions('worktree-1', 'project-1')
      })

      // Should fall back since 'deleted-session' doesn't exist
      const state = useSessionStore.getState()
      const tabOrder = state.tabOrderByWorktree.get('worktree-1')!
      expect(state.activeSessionId).toBe(tabOrder[0])
    })

    test('createSession updates activeSessionByWorktree', async () => {
      const newSession = {
        ...mockSession1,
        id: 'new-session',
        name: 'New Session'
      }
      mockDbSession.create.mockResolvedValue(newSession)

      useSessionStore.setState({
        activeWorktreeId: 'worktree-1',
        activeSessionByWorktree: {}
      })

      await act(async () => {
        await useSessionStore.getState().createSession('worktree-1', 'project-1')
      })

      expect(useSessionStore.getState().activeSessionByWorktree['worktree-1']).toBe('new-session')
    })

    test('closeSession updates activeSessionByWorktree to new active', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1, mockSession2]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-1', 'session-2']]]),
        activeSessionId: 'session-1',
        activeWorktreeId: 'worktree-1',
        activeSessionByWorktree: { 'worktree-1': 'session-1' }
      })

      mockDbSession.update.mockResolvedValue({ ...mockSession1, status: 'completed' })

      await act(async () => {
        await useSessionStore.getState().closeSession('session-1')
      })

      // Should update to session-2 (next remaining session)
      expect(useSessionStore.getState().activeSessionByWorktree['worktree-1']).toBe('session-2')
    })

    test('closeSession removes worktree from map when no sessions remain', async () => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([['worktree-1', [mockSession1]]]),
        tabOrderByWorktree: new Map([['worktree-1', ['session-1']]]),
        activeSessionId: 'session-1',
        activeWorktreeId: 'worktree-1',
        activeSessionByWorktree: { 'worktree-1': 'session-1' }
      })

      mockDbSession.update.mockResolvedValue({ ...mockSession1, status: 'completed' })

      await act(async () => {
        await useSessionStore.getState().closeSession('session-1')
      })

      expect(useSessionStore.getState().activeSessionByWorktree['worktree-1']).toBeUndefined()
    })
  })

  describe('Session Tab Badges', () => {
    test('setSessionStatus sets working status', () => {
      act(() => {
        useWorktreeStatusStore.getState().setSessionStatus('session-1', 'working')
      })

      const state = useWorktreeStatusStore.getState()
      expect(state.sessionStatuses['session-1']?.status).toBe('working')
    })

    test('setSessionStatus sets unread status', () => {
      act(() => {
        useWorktreeStatusStore.getState().setSessionStatus('session-1', 'unread')
      })

      const state = useWorktreeStatusStore.getState()
      expect(state.sessionStatuses['session-1']?.status).toBe('unread')
    })

    test('clearSessionStatus clears status', () => {
      act(() => {
        useWorktreeStatusStore.getState().setSessionStatus('session-1', 'working')
      })

      act(() => {
        useWorktreeStatusStore.getState().clearSessionStatus('session-1')
      })

      const state = useWorktreeStatusStore.getState()
      expect(state.sessionStatuses['session-1']).toBeNull()
    })

    test('Multiple tabs show independent statuses', () => {
      act(() => {
        useWorktreeStatusStore.getState().setSessionStatus('session-1', 'working')
        useWorktreeStatusStore.getState().setSessionStatus('session-2', 'unread')
      })

      const state = useWorktreeStatusStore.getState()
      expect(state.sessionStatuses['session-1']?.status).toBe('working')
      expect(state.sessionStatuses['session-2']?.status).toBe('unread')
    })

    test('Tab badge updates reactively', () => {
      // Start with null status
      expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']).toBeUndefined()

      // Set to working
      act(() => {
        useWorktreeStatusStore.getState().setSessionStatus('session-1', 'working')
      })
      expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']?.status).toBe('working')

      // Change to unread
      act(() => {
        useWorktreeStatusStore.getState().setSessionStatus('session-1', 'unread')
      })
      expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']?.status).toBe('unread')

      // Clear
      act(() => {
        useWorktreeStatusStore.getState().setSessionStatus('session-1', null)
      })
      expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']).toBeNull()
    })
  })
})
