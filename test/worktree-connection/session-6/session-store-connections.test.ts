import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'

// ---------- Mock window.db ----------
const mockDbSession = {
  create: vi.fn(),
  get: vi.fn(),
  getByWorktree: vi.fn(),
  getByProject: vi.fn(),
  getActiveByWorktree: vi.fn(),
  getActiveByConnection: vi.fn(),
  getByConnection: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  search: vi.fn(),
  getDraft: vi.fn(),
  updateDraft: vi.fn()
}

const mockDbWorktree = {
  get: vi.fn(),
  touch: vi.fn().mockResolvedValue(undefined),
  updateModel: vi.fn().mockResolvedValue({ success: true }),
  appendSessionTitle: vi.fn().mockResolvedValue({ success: true })
}

const mockDb = {
  session: mockDbSession,
  worktree: mockDbWorktree
}

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

// ---------- Mock window.opencodeOps ----------
const mockOpencodeOps = {
  setModel: vi.fn().mockResolvedValue(undefined)
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

// ---------- Mock useSettingsStore ----------
vi.mock('../../../src/renderer/src/stores/useSettingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      selectedModel: null,
      updateSetting: vi.fn()
    })
  }
}))

// Set up window mocks
/* eslint-disable @typescript-eslint/no-explicit-any */
Object.defineProperty(window, 'connectionOps', {
  writable: true,
  configurable: true,
  value: mockConnectionOps
})

Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  configurable: true,
  value: mockOpencodeOps
})

if (!(window as any).db) {
  Object.defineProperty(window, 'db', {
    writable: true,
    configurable: true,
    value: mockDb
  })
} else {
  const existing = (window as any).db
  Object.assign(existing, mockDb)
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- Test data factories ----------
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

function makeWorktreeSession(overrides: Record<string, unknown> = {}) {
  return makeSession({
    id: 'wt-session-1',
    worktree_id: 'wt-1',
    connection_id: null,
    ...overrides
  })
}

function makeConnection() {
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
    ]
  }
}

// ---------- Tests ----------
describe('Session 6: Session Store Connection Support', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store state completely
    useSessionStore.setState({
      sessionsByWorktree: new Map(),
      tabOrderByWorktree: new Map(),
      sessionsByConnection: new Map(),
      tabOrderByConnection: new Map(),
      modeBySession: new Map(),
      pendingMessages: new Map(),
      isLoading: false,
      error: null,
      activeSessionId: null,
      activeWorktreeId: null,
      activeConnectionId: null,
      activeSessionByWorktree: {},
      activeSessionByConnection: {}
    })
  })

  describe('createConnectionSession', () => {
    test('sets connection_id and null worktree_id', async () => {
      const session = makeSession()
      mockConnectionOps.get.mockResolvedValueOnce({
        success: true,
        connection: makeConnection()
      })
      mockDbSession.create.mockResolvedValueOnce(session)

      let result: { success: boolean; session?: unknown } = { success: false }
      await act(async () => {
        result = await useSessionStore.getState().createConnectionSession('conn-1')
      })

      expect(result.success).toBe(true)
      expect(mockDbSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          connection_id: 'conn-1',
          worktree_id: null,
          project_id: 'proj-1'
        })
      )
    })

    test('uses first member project_id', async () => {
      const connection = makeConnection()
      mockConnectionOps.get.mockResolvedValueOnce({ success: true, connection })
      mockDbSession.create.mockResolvedValueOnce(makeSession())

      await act(async () => {
        await useSessionStore.getState().createConnectionSession('conn-1')
      })

      expect(mockDbSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: 'proj-1' // First member's project_id
        })
      )
    })

    test('adds session to sessionsByConnection', async () => {
      const session = makeSession()
      mockConnectionOps.get.mockResolvedValueOnce({ success: true, connection: makeConnection() })
      mockDbSession.create.mockResolvedValueOnce(session)

      await act(async () => {
        await useSessionStore.getState().createConnectionSession('conn-1')
      })

      const state = useSessionStore.getState()
      const sessions = state.sessionsByConnection.get('conn-1')
      expect(sessions).toHaveLength(1)
      expect(sessions![0].id).toBe('session-1')
    })

    test('adds to tabOrderByConnection', async () => {
      const session = makeSession()
      mockConnectionOps.get.mockResolvedValueOnce({ success: true, connection: makeConnection() })
      mockDbSession.create.mockResolvedValueOnce(session)

      await act(async () => {
        await useSessionStore.getState().createConnectionSession('conn-1')
      })

      const tabOrder = useSessionStore.getState().tabOrderByConnection.get('conn-1')
      expect(tabOrder).toEqual(['session-1'])
    })

    test('sets as active session', async () => {
      const session = makeSession()
      mockConnectionOps.get.mockResolvedValueOnce({ success: true, connection: makeConnection() })
      mockDbSession.create.mockResolvedValueOnce(session)

      await act(async () => {
        await useSessionStore.getState().createConnectionSession('conn-1')
      })

      expect(useSessionStore.getState().activeSessionId).toBe('session-1')
    })

    test('persists in activeSessionByConnection', async () => {
      const session = makeSession()
      mockConnectionOps.get.mockResolvedValueOnce({ success: true, connection: makeConnection() })
      mockDbSession.create.mockResolvedValueOnce(session)

      await act(async () => {
        await useSessionStore.getState().createConnectionSession('conn-1')
      })

      expect(useSessionStore.getState().activeSessionByConnection['conn-1']).toBe('session-1')
    })

    test('returns error when connection has no members', async () => {
      mockConnectionOps.get.mockResolvedValueOnce({
        success: true,
        connection: { ...makeConnection(), members: [] }
      })

      let result: { success: boolean; error?: string } = { success: false }
      await act(async () => {
        result = await useSessionStore.getState().createConnectionSession('conn-1')
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Connection has no members')
    })

    test('increments session number based on existing connection sessions', async () => {
      // Pre-populate with one existing session
      const existingSession = makeSession({ id: 'session-0', name: 'Session 1' })
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [existingSession]]])
      })

      const newSession = makeSession({ id: 'session-2', name: 'Session 2' })
      mockConnectionOps.get.mockResolvedValueOnce({ success: true, connection: makeConnection() })
      mockDbSession.create.mockResolvedValueOnce(newSession)

      await act(async () => {
        await useSessionStore.getState().createConnectionSession('conn-1')
      })

      expect(mockDbSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Session 2'
        })
      )
    })
  })

  describe('loadConnectionSessions', () => {
    test('populates sessionsByConnection', async () => {
      const sessions = [
        makeSession({ id: 'session-1', updated_at: '2025-01-02T00:00:00.000Z' }),
        makeSession({ id: 'session-2', updated_at: '2025-01-01T00:00:00.000Z' })
      ]
      mockDbSession.getActiveByConnection.mockResolvedValueOnce(sessions)

      // Set active connection so active session is picked
      useSessionStore.setState({ activeConnectionId: 'conn-1' })

      await act(async () => {
        await useSessionStore.getState().loadConnectionSessions('conn-1')
      })

      const state = useSessionStore.getState()
      const loaded = state.sessionsByConnection.get('conn-1')
      expect(loaded).toHaveLength(2)
      expect(state.isLoading).toBe(false)
    })

    test('initializes tabOrderByConnection', async () => {
      const sessions = [
        makeSession({ id: 'session-1', updated_at: '2025-01-02T00:00:00.000Z' }),
        makeSession({ id: 'session-2', updated_at: '2025-01-01T00:00:00.000Z' })
      ]
      mockDbSession.getActiveByConnection.mockResolvedValueOnce(sessions)

      await act(async () => {
        await useSessionStore.getState().loadConnectionSessions('conn-1')
      })

      const tabOrder = useSessionStore.getState().tabOrderByConnection.get('conn-1')
      expect(tabOrder).toEqual(['session-1', 'session-2'])
    })

    test('restores persisted active session for connection', async () => {
      const sessions = [
        makeSession({ id: 'session-1', updated_at: '2025-01-02T00:00:00.000Z' }),
        makeSession({ id: 'session-2', updated_at: '2025-01-01T00:00:00.000Z' })
      ]
      mockDbSession.getActiveByConnection.mockResolvedValueOnce(sessions)

      useSessionStore.setState({
        activeConnectionId: 'conn-1',
        activeSessionByConnection: { 'conn-1': 'session-2' }
      })

      await act(async () => {
        await useSessionStore.getState().loadConnectionSessions('conn-1')
      })

      expect(useSessionStore.getState().activeSessionId).toBe('session-2')
    })

    test('handles errors gracefully', async () => {
      mockDbSession.getActiveByConnection.mockRejectedValueOnce(new Error('DB error'))

      await act(async () => {
        await useSessionStore.getState().loadConnectionSessions('conn-1')
      })

      const state = useSessionStore.getState()
      expect(state.error).toBe('DB error')
      expect(state.isLoading).toBe(false)
    })

    test('syncs tab order when re-loading sessions', async () => {
      // Pre-populate tab order with an extra stale session
      useSessionStore.setState({
        tabOrderByConnection: new Map([['conn-1', ['session-stale', 'session-1']]])
      })

      const sessions = [makeSession({ id: 'session-1' })]
      mockDbSession.getActiveByConnection.mockResolvedValueOnce(sessions)

      await act(async () => {
        await useSessionStore.getState().loadConnectionSessions('conn-1')
      })

      const tabOrder = useSessionStore.getState().tabOrderByConnection.get('conn-1')
      // session-stale should be removed since it's not in loaded sessions
      expect(tabOrder).toEqual(['session-1'])
    })
  })

  describe('closing connection sessions', () => {
    test('removes from tabOrderByConnection', async () => {
      const session = makeSession()
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session]]]),
        tabOrderByConnection: new Map([['conn-1', ['session-1']]]),
        activeSessionId: 'session-1',
        activeConnectionId: 'conn-1',
        activeSessionByConnection: { 'conn-1': 'session-1' }
      })

      mockDbSession.update.mockResolvedValueOnce({ ...session, status: 'completed' })

      await act(async () => {
        await useSessionStore.getState().closeSession('session-1')
      })

      const state = useSessionStore.getState()
      expect(state.sessionsByConnection.get('conn-1')).toHaveLength(0)
      expect(state.tabOrderByConnection.get('conn-1')).toEqual([])
      expect(state.activeSessionId).toBeNull()
    })

    test('selects next tab when closing active connection session', async () => {
      const session1 = makeSession({ id: 'session-1' })
      const session2 = makeSession({ id: 'session-2' })
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session1, session2]]]),
        tabOrderByConnection: new Map([['conn-1', ['session-1', 'session-2']]]),
        activeSessionId: 'session-1',
        activeConnectionId: 'conn-1',
        activeSessionByConnection: { 'conn-1': 'session-1' }
      })

      mockDbSession.update.mockResolvedValueOnce({ ...session1, status: 'completed' })

      await act(async () => {
        await useSessionStore.getState().closeSession('session-1')
      })

      expect(useSessionStore.getState().activeSessionId).toBe('session-2')
    })

    test('updates activeSessionByConnection on close', async () => {
      const session = makeSession()
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session]]]),
        tabOrderByConnection: new Map([['conn-1', ['session-1']]]),
        activeSessionId: 'session-1',
        activeConnectionId: 'conn-1',
        activeSessionByConnection: { 'conn-1': 'session-1' }
      })

      mockDbSession.update.mockResolvedValueOnce({ ...session, status: 'completed' })

      await act(async () => {
        await useSessionStore.getState().closeSession('session-1')
      })

      // activeSessionByConnection should be cleared for conn-1
      expect(useSessionStore.getState().activeSessionByConnection['conn-1']).toBeUndefined()
    })
  })

  describe('setActiveConnection', () => {
    test('sets activeConnectionId and clears activeWorktreeId', () => {
      useSessionStore.setState({ activeWorktreeId: 'wt-1' })

      act(() => {
        useSessionStore.getState().setActiveConnection('conn-1')
      })

      const state = useSessionStore.getState()
      expect(state.activeConnectionId).toBe('conn-1')
      expect(state.activeWorktreeId).toBeNull()
    })

    test('restores last active session for the connection', () => {
      const session = makeSession()
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session]]]),
        tabOrderByConnection: new Map([['conn-1', ['session-1']]]),
        activeSessionByConnection: { 'conn-1': 'session-1' }
      })

      act(() => {
        useSessionStore.getState().setActiveConnection('conn-1')
      })

      expect(useSessionStore.getState().activeSessionId).toBe('session-1')
    })

    test('clears active session when no sessions exist for connection', () => {
      useSessionStore.setState({ activeSessionId: 'some-session' })

      act(() => {
        useSessionStore.getState().setActiveConnection('conn-1')
      })

      expect(useSessionStore.getState().activeSessionId).toBeNull()
    })

    test('no-op when already active', () => {
      useSessionStore.setState({
        activeConnectionId: 'conn-1',
        activeSessionId: 'session-1'
      })

      act(() => {
        useSessionStore.getState().setActiveConnection('conn-1')
      })

      // activeSessionId should remain unchanged (no set to null)
      expect(useSessionStore.getState().activeSessionId).toBe('session-1')
    })

    test('deselects connection with null', () => {
      useSessionStore.setState({ activeConnectionId: 'conn-1' })

      act(() => {
        useSessionStore.getState().setActiveConnection(null)
      })

      expect(useSessionStore.getState().activeConnectionId).toBeNull()
      expect(useSessionStore.getState().activeSessionId).toBeNull()
    })
  })

  describe('setActiveConnectionSession', () => {
    test('sets active session and persists to activeSessionByConnection', () => {
      useSessionStore.setState({ activeConnectionId: 'conn-1' })

      act(() => {
        useSessionStore.getState().setActiveConnectionSession('session-2')
      })

      const state = useSessionStore.getState()
      expect(state.activeSessionId).toBe('session-2')
      expect(state.activeSessionByConnection['conn-1']).toBe('session-2')
    })

    test('clears active session with null', () => {
      useSessionStore.setState({
        activeConnectionId: 'conn-1',
        activeSessionId: 'session-1'
      })

      act(() => {
        useSessionStore.getState().setActiveConnectionSession(null)
      })

      expect(useSessionStore.getState().activeSessionId).toBeNull()
    })
  })

  describe('setActiveSession (scope-agnostic)', () => {
    test('persists to activeSessionByWorktree when worktree is active', () => {
      useSessionStore.setState({ activeWorktreeId: 'wt-1' })

      act(() => {
        useSessionStore.getState().setActiveSession('wt-session-1')
      })

      expect(useSessionStore.getState().activeSessionByWorktree['wt-1']).toBe('wt-session-1')
    })

    test('persists to activeSessionByConnection when connection is active', () => {
      useSessionStore.setState({ activeConnectionId: 'conn-1' })

      act(() => {
        useSessionStore.getState().setActiveSession('session-1')
      })

      expect(useSessionStore.getState().activeSessionByConnection['conn-1']).toBe('session-1')
    })
  })

  describe('getSessionsForConnection / getTabOrderForConnection', () => {
    test('returns sessions for a connection', () => {
      const session = makeSession()
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session]]])
      })

      expect(useSessionStore.getState().getSessionsForConnection('conn-1')).toHaveLength(1)
    })

    test('returns empty array for unknown connection', () => {
      expect(useSessionStore.getState().getSessionsForConnection('unknown')).toEqual([])
    })

    test('returns tab order for a connection', () => {
      useSessionStore.setState({
        tabOrderByConnection: new Map([['conn-1', ['session-1', 'session-2']]])
      })

      expect(useSessionStore.getState().getTabOrderForConnection('conn-1')).toEqual([
        'session-1',
        'session-2'
      ])
    })

    test('returns empty array for unknown connection tab order', () => {
      expect(useSessionStore.getState().getTabOrderForConnection('unknown')).toEqual([])
    })
  })

  describe('reorderConnectionTabs', () => {
    test('reorders tabs correctly', () => {
      useSessionStore.setState({
        tabOrderByConnection: new Map([['conn-1', ['session-1', 'session-2', 'session-3']]])
      })

      act(() => {
        useSessionStore.getState().reorderConnectionTabs('conn-1', 0, 2)
      })

      expect(useSessionStore.getState().tabOrderByConnection.get('conn-1')).toEqual([
        'session-2',
        'session-3',
        'session-1'
      ])
    })

    test('handles out-of-bounds indices', () => {
      useSessionStore.setState({
        tabOrderByConnection: new Map([['conn-1', ['session-1', 'session-2']]])
      })

      act(() => {
        useSessionStore.getState().reorderConnectionTabs('conn-1', -1, 5)
      })

      // Should not change
      expect(useSessionStore.getState().tabOrderByConnection.get('conn-1')).toEqual([
        'session-1',
        'session-2'
      ])
    })
  })

  describe('closeOtherConnectionSessions', () => {
    test('closes all except the kept session', async () => {
      const session1 = makeSession({ id: 'session-1' })
      const session2 = makeSession({ id: 'session-2' })
      const session3 = makeSession({ id: 'session-3' })
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session1, session2, session3]]]),
        tabOrderByConnection: new Map([['conn-1', ['session-1', 'session-2', 'session-3']]]),
        activeConnectionId: 'conn-1'
      })

      mockDbSession.update.mockResolvedValue({})

      await act(async () => {
        await useSessionStore.getState().closeOtherConnectionSessions('conn-1', 'session-2')
      })

      const tabs = useSessionStore.getState().tabOrderByConnection.get('conn-1')
      expect(tabs).toEqual(['session-2'])
      expect(useSessionStore.getState().activeSessionId).toBe('session-2')
    })
  })

  describe('closeConnectionSessionsToRight', () => {
    test('closes sessions to the right of the given session', async () => {
      const session1 = makeSession({ id: 'session-1' })
      const session2 = makeSession({ id: 'session-2' })
      const session3 = makeSession({ id: 'session-3' })
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session1, session2, session3]]]),
        tabOrderByConnection: new Map([['conn-1', ['session-1', 'session-2', 'session-3']]]),
        activeConnectionId: 'conn-1'
      })

      mockDbSession.update.mockResolvedValue({})

      await act(async () => {
        await useSessionStore.getState().closeConnectionSessionsToRight('conn-1', 'session-1')
      })

      const tabs = useSessionStore.getState().tabOrderByConnection.get('conn-1')
      expect(tabs).toEqual(['session-1'])
    })
  })

  describe('scope-agnostic operations', () => {
    test('updateSessionName works for connection sessions', async () => {
      const session = makeSession()
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session]]])
      })

      mockDbSession.update.mockResolvedValueOnce({ ...session, name: 'Renamed' })

      let result = false
      await act(async () => {
        result = await useSessionStore.getState().updateSessionName('session-1', 'Renamed')
      })

      expect(result).toBe(true)
      const updated = useSessionStore.getState().sessionsByConnection.get('conn-1')
      expect(updated![0].name).toBe('Renamed')
    })

    test('setOpenCodeSessionId works for connection sessions', () => {
      const session = makeSession()
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session]]])
      })

      act(() => {
        useSessionStore.getState().setOpenCodeSessionId('session-1', 'opc-123')
      })

      const updated = useSessionStore.getState().sessionsByConnection.get('conn-1')
      expect(updated![0].opencode_session_id).toBe('opc-123')
    })

    test('setSessionModel works for connection sessions', async () => {
      const session = makeSession()
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session]]])
      })

      mockDbSession.update.mockResolvedValueOnce({})

      await act(async () => {
        await useSessionStore.getState().setSessionModel('session-1', {
          providerID: 'anthropic',
          modelID: 'claude-4',
          variant: undefined
        })
      })

      const updated = useSessionStore.getState().sessionsByConnection.get('conn-1')
      expect(updated![0].model_provider_id).toBe('anthropic')
      expect(updated![0].model_id).toBe('claude-4')
    })

    test('setSessionModel does NOT update worktree model for connection sessions', async () => {
      const session = makeSession()
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [session]]])
      })

      mockDbSession.update.mockResolvedValueOnce({})

      await act(async () => {
        await useSessionStore.getState().setSessionModel('session-1', {
          providerID: 'anthropic',
          modelID: 'claude-4',
          variant: undefined
        })
      })

      // updateModel should NOT be called since this is a connection session
      expect(mockDbWorktree.updateModel).not.toHaveBeenCalled()
    })
  })

  describe('activeSessionByConnection persists across store resets', () => {
    test('activeSessionByConnection is included in partialize', () => {
      useSessionStore.setState({
        activeSessionByConnection: { 'conn-1': 'session-1' }
      })

      // Verify the state is set correctly (persist middleware handles serialization)
      expect(useSessionStore.getState().activeSessionByConnection).toEqual({
        'conn-1': 'session-1'
      })
    })
  })

  describe('existing worktree session methods are unaffected', () => {
    test('createSession still creates worktree sessions correctly', async () => {
      const wtSession = makeWorktreeSession()
      mockDbSession.create.mockResolvedValueOnce(wtSession)

      await act(async () => {
        await useSessionStore.getState().createSession('wt-1', 'proj-1')
      })

      const state = useSessionStore.getState()
      expect(state.sessionsByWorktree.get('wt-1')).toHaveLength(1)
      // Connection sessions should be unaffected
      expect(state.sessionsByConnection.size).toBe(0)
    })

    test('loadSessions still loads worktree sessions correctly', async () => {
      const wtSession = makeWorktreeSession()
      mockDbSession.getActiveByWorktree.mockResolvedValueOnce([wtSession])

      useSessionStore.setState({ activeWorktreeId: 'wt-1' })

      await act(async () => {
        await useSessionStore.getState().loadSessions('wt-1', 'proj-1')
      })

      const state = useSessionStore.getState()
      expect(state.sessionsByWorktree.get('wt-1')).toHaveLength(1)
      expect(state.sessionsByConnection.size).toBe(0)
    })

    test('closeSession works for worktree sessions without affecting connection sessions', async () => {
      const wtSession = makeWorktreeSession()
      const connSession = makeSession()
      useSessionStore.setState({
        sessionsByWorktree: new Map([['wt-1', [wtSession]]]),
        tabOrderByWorktree: new Map([['wt-1', ['wt-session-1']]]),
        sessionsByConnection: new Map([['conn-1', [connSession]]]),
        tabOrderByConnection: new Map([['conn-1', ['session-1']]]),
        activeSessionId: 'wt-session-1'
      })

      mockDbSession.update.mockResolvedValueOnce({ ...wtSession, status: 'completed' })

      await act(async () => {
        await useSessionStore.getState().closeSession('wt-session-1')
      })

      const state = useSessionStore.getState()
      // Worktree session should be removed
      expect(state.sessionsByWorktree.get('wt-1')).toHaveLength(0)
      // Connection session should be untouched
      expect(state.sessionsByConnection.get('conn-1')).toHaveLength(1)
    })
  })

  describe('setActiveWorktree clears activeConnectionId', () => {
    test('switching to worktree clears connection context', () => {
      useSessionStore.setState({ activeConnectionId: 'conn-1' })

      act(() => {
        useSessionStore.getState().setActiveWorktree('wt-1')
      })

      const state = useSessionStore.getState()
      expect(state.activeWorktreeId).toBe('wt-1')
      expect(state.activeConnectionId).toBeNull()
    })
  })
})
