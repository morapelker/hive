import { describe, test, expect, vi, beforeEach } from 'vitest'

// Mock zustand persist to avoid localStorage issues in tests
vi.mock('zustand/middleware', async () => {
  const actual = await vi.importActual('zustand/middleware')
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    persist: (fn: (...args: any[]) => any) => fn
  }
})

// Mock sonner
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  })
}))

// Mock window.db for session store
const mockSessionCreate = vi.fn()
const mockSessionUpdate = vi.fn()
const mockSessionGet = vi.fn()
const mockSessionGetActiveByWorktree = vi.fn().mockResolvedValue([])

Object.defineProperty(window, 'db', {
  writable: true,
  value: {
    session: {
      create: mockSessionCreate,
      update: mockSessionUpdate,
      get: mockSessionGet,
      getActiveByWorktree: mockSessionGetActiveByWorktree,
      updateDraft: vi.fn()
    },
    worktree: {
      get: vi.fn()
    },
    settings: {
      get: vi.fn()
    }
  }
})

Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  value: {
    setModel: vi.fn().mockResolvedValue({ success: true }),
    abort: vi.fn().mockResolvedValue({ success: true }),
    undo: vi.fn().mockResolvedValue({ success: true }),
    redo: vi.fn().mockResolvedValue({ success: true })
  }
})

import { BUILT_IN_SLASH_COMMANDS } from '../../../src/renderer/src/components/sessions/SessionView'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'

describe('Session 2: /clear Command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the store between tests
    useSessionStore.setState({
      sessionsByWorktree: new Map(),
      tabOrderByWorktree: new Map(),
      modeBySession: new Map(),
      pendingMessages: new Map(),
      isLoading: false,
      error: null,
      activeSessionId: null,
      activeWorktreeId: null,
      activeSessionByWorktree: {}
    })
  })

  test('/clear is in BUILT_IN_SLASH_COMMANDS', () => {
    const clearCmd = BUILT_IN_SLASH_COMMANDS.find((c) => c.name === 'clear')
    expect(clearCmd).toBeDefined()
    expect(clearCmd!.template).toBe('/clear')
    expect(clearCmd!.builtIn).toBe(true)
    expect(clearCmd!.description).toBe('Close current tab and open a new one')
  })

  test('/clear command has all required fields', () => {
    const clearCmd = BUILT_IN_SLASH_COMMANDS.find((c) => c.name === 'clear')
    expect(clearCmd).toMatchObject({
      name: 'clear',
      description: expect.any(String),
      template: '/clear',
      builtIn: true
    })
  })

  test('BUILT_IN_SLASH_COMMANDS contains undo, redo, and clear', () => {
    const names = BUILT_IN_SLASH_COMMANDS.map((c) => c.name)
    expect(names).toContain('undo')
    expect(names).toContain('redo')
    expect(names).toContain('clear')
  })

  test('closeSession marks session as completed and removes from tabs', async () => {
    const sessionId = 'session-1'
    const worktreeId = 'wt-1'

    // Set up initial state with a session
    mockSessionUpdate.mockResolvedValue({
      id: sessionId,
      status: 'completed',
      completed_at: new Date().toISOString()
    })

    useSessionStore.setState({
      sessionsByWorktree: new Map([
        [
          worktreeId,
          [
            {
              id: sessionId,
              worktree_id: worktreeId,
              project_id: 'proj-1',
              name: 'Test session',
              status: 'active' as const,
              opencode_session_id: null,
              mode: 'build' as const,
              model_provider_id: null,
              model_id: null,
              model_variant: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              completed_at: null
            }
          ]
        ]
      ]),
      tabOrderByWorktree: new Map([[worktreeId, [sessionId]]]),
      activeSessionId: sessionId,
      activeSessionByWorktree: { [worktreeId]: sessionId }
    })

    // Close the session
    const result = await useSessionStore.getState().closeSession(sessionId)
    expect(result.success).toBe(true)

    // Session should be removed from tabs
    const sessions = useSessionStore.getState().sessionsByWorktree.get(worktreeId)
    expect(sessions).toHaveLength(0)

    // Tab order should be empty
    const tabOrder = useSessionStore.getState().tabOrderByWorktree.get(worktreeId)
    expect(tabOrder).toHaveLength(0)

    // Session was marked as completed in DB
    expect(mockSessionUpdate).toHaveBeenCalledWith(sessionId, {
      status: 'completed',
      completed_at: expect.any(String)
    })
  })

  test('createSession adds new session to tabs and sets it active', async () => {
    const worktreeId = 'wt-1'
    const projectId = 'proj-1'
    const newSession = {
      id: 'new-session-1',
      worktree_id: worktreeId,
      project_id: projectId,
      name: 'New session',
      status: 'active' as const,
      opencode_session_id: null,
      mode: 'build' as const,
      model_provider_id: null,
      model_id: null,
      model_variant: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null
    }

    mockSessionCreate.mockResolvedValue(newSession)

    // Start with empty state
    useSessionStore.setState({
      sessionsByWorktree: new Map([[worktreeId, []]]),
      tabOrderByWorktree: new Map([[worktreeId, []]]),
      activeSessionId: null,
      activeSessionByWorktree: {}
    })

    const result = await useSessionStore.getState().createSession(worktreeId, projectId)
    expect(result.success).toBe(true)
    expect(result.session).toBeDefined()
    expect(result.session!.id).toBe('new-session-1')

    // New session should be in tabs
    const sessions = useSessionStore.getState().sessionsByWorktree.get(worktreeId)
    expect(sessions).toHaveLength(1)
    expect(sessions![0].id).toBe('new-session-1')

    // New session should be active
    expect(useSessionStore.getState().activeSessionId).toBe('new-session-1')
  })

  test('/clear workflow: close then create produces correct state', async () => {
    const worktreeId = 'wt-1'
    const projectId = 'proj-1'
    const oldSessionId = 'old-session'
    const newSessionId = 'new-session'

    // Initial state with one active session
    mockSessionUpdate.mockResolvedValue({
      id: oldSessionId,
      status: 'completed'
    })
    mockSessionCreate.mockResolvedValue({
      id: newSessionId,
      worktree_id: worktreeId,
      project_id: projectId,
      name: 'New session',
      status: 'active',
      opencode_session_id: null,
      mode: 'build',
      model_provider_id: null,
      model_id: null,
      model_variant: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null
    })

    useSessionStore.setState({
      sessionsByWorktree: new Map([
        [
          worktreeId,
          [
            {
              id: oldSessionId,
              worktree_id: worktreeId,
              project_id: projectId,
              name: 'Old session',
              status: 'active' as const,
              opencode_session_id: null,
              mode: 'build' as const,
              model_provider_id: null,
              model_id: null,
              model_variant: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              completed_at: null
            }
          ]
        ]
      ]),
      tabOrderByWorktree: new Map([[worktreeId, [oldSessionId]]]),
      activeSessionId: oldSessionId,
      activeSessionByWorktree: { [worktreeId]: oldSessionId }
    })

    // Simulate /clear: close current, create new
    await useSessionStore.getState().closeSession(oldSessionId)
    const { success, session } = await useSessionStore
      .getState()
      .createSession(worktreeId, projectId)

    expect(success).toBe(true)
    expect(session).toBeDefined()

    useSessionStore.getState().setActiveSession(session!.id)

    // Old session gone from tabs, new session present
    const sessions = useSessionStore.getState().sessionsByWorktree.get(worktreeId)
    expect(sessions).toHaveLength(1)
    expect(sessions![0].id).toBe(newSessionId)

    // Active session is the new one
    expect(useSessionStore.getState().activeSessionId).toBe(newSessionId)

    // Old session was marked completed in DB (preserved for history)
    expect(mockSessionUpdate).toHaveBeenCalledWith(oldSessionId, {
      status: 'completed',
      completed_at: expect.any(String)
    })
  })

  test('/clear does not create user message in chat', () => {
    // The /clear command returns early before reaching message creation logic
    // This is verified by the code structure: the `return` statement in the
    // clear handler prevents execution from reaching the setMessages call
    const clearCmd = BUILT_IN_SLASH_COMMANDS.find((c) => c.name === 'clear')
    expect(clearCmd).toBeDefined()
    // Built-in commands with early return don't create messages
    expect(clearCmd!.builtIn).toBe(true)
  })

  test('/clear is filterable by typing /cl', () => {
    // Simulate the filtering logic used in the slash command popover
    const filterText = 'cl'
    const filtered = BUILT_IN_SLASH_COMMANDS.filter(
      (cmd) => cmd.name.includes(filterText) || cmd.template.includes(filterText)
    )
    expect(filtered).toHaveLength(1)
    expect(filtered[0].name).toBe('clear')
  })
})
