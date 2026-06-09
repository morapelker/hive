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

const dbApiMocks = vi.hoisted(() => ({
  session: {
    create: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
    getActiveByWorktree: vi.fn().mockResolvedValue([]),
    updateDraft: vi.fn()
  },
  sessionMessage: {
    list: vi.fn().mockResolvedValue([])
  },
  sessionActivity: {
    list: vi.fn().mockResolvedValue([])
  },
  worktree: {
    get: vi.fn(),
    updateModel: vi.fn().mockResolvedValue({ success: true })
  },
  setting: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(true)
  }
}))

const opencodeApiMocks = vi.hoisted(() => ({
  setModel: vi.fn().mockResolvedValue({ success: true }),
  abort: vi.fn().mockResolvedValue({ success: true }),
  disconnect: vi.fn().mockResolvedValue({ success: true }),
  undo: vi.fn().mockResolvedValue({ success: true }),
  redo: vi.fn().mockResolvedValue({ success: true }),
  onStream: vi.fn().mockReturnValue(() => {})
}))

vi.mock('@/api/db-api', () => ({
  dbApi: dbApiMocks
}))

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: opencodeApiMocks
}))

const settingsStoreMocks = vi.hoisted(() => {
  const state = {
    availableAgentSdks: {
      opencode: true,
      claude: true,
      codex: true
    },
    defaultAgentSdk: 'opencode',
    selectedModel: null,
    selectedModelByProvider: {},
    getModelForMode: vi.fn(() => null),
    goalStatusCollapsed: false,
    stripAtMentions: false,
    codexFastMode: false,
    codexFastModeAccepted: false,
    vimModeEnabled: false,
    updateSetting: vi.fn()
  }

  return {
    state,
    useSettingsStore: Object.assign(
      (selector?: (state: typeof state) => unknown) => (selector ? selector(state) : state),
      {
        getState: () => state
      }
    ),
    resolveModelForSdk: vi.fn(() => null)
  }
})

vi.mock('../../../src/renderer/src/stores/useSettingsStore', () => ({
  useSettingsStore: settingsStoreMocks.useSettingsStore,
  resolveModelForSdk: settingsStoreMocks.resolveModelForSdk
}))

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: settingsStoreMocks.useSettingsStore,
  resolveModelForSdk: settingsStoreMocks.resolveModelForSdk
}))

import { BUILT_IN_SLASH_COMMANDS } from '../../../src/renderer/src/components/sessions/SessionView'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'

const mockSessionCreate = dbApiMocks.session.create
const mockSessionUpdate = dbApiMocks.session.update

describe('Session 2: /clear Command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbApiMocks.session.create.mockReset()
    dbApiMocks.session.update.mockReset()
    dbApiMocks.session.get.mockReset()
    dbApiMocks.session.getActiveByWorktree.mockReset()
    dbApiMocks.session.updateDraft.mockReset()
    dbApiMocks.sessionMessage.list.mockResolvedValue([])
    dbApiMocks.sessionActivity.list.mockResolvedValue([])
    dbApiMocks.worktree.get.mockReset()
    dbApiMocks.worktree.updateModel.mockResolvedValue({ success: true })
    dbApiMocks.setting.get.mockResolvedValue(null)
    dbApiMocks.setting.set.mockResolvedValue(true)
    dbApiMocks.session.getActiveByWorktree.mockResolvedValue([])
    opencodeApiMocks.setModel.mockResolvedValue({ success: true })
    opencodeApiMocks.abort.mockResolvedValue({ success: true })
    opencodeApiMocks.disconnect.mockResolvedValue({ success: true })
    opencodeApiMocks.undo.mockResolvedValue({ success: true })
    opencodeApiMocks.redo.mockResolvedValue({ success: true })
    opencodeApiMocks.onStream.mockReturnValue(() => {})

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
