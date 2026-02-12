import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useScriptStore } from '../../../src/renderer/src/stores/useScriptStore'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStatusStore } from '../../../src/renderer/src/stores/useWorktreeStatusStore'

// Mock window.worktreeOps
const mockDelete = vi.fn()
Object.defineProperty(window, 'worktreeOps', {
  writable: true,
  value: {
    delete: mockDelete,
    create: vi.fn(),
    sync: vi.fn(),
    openInTerminal: vi.fn(),
    openInEditor: vi.fn(),
    duplicate: vi.fn(),
    renameBranch: vi.fn()
  }
})

// Mock window.scriptOps
const mockKill = vi.fn()
Object.defineProperty(window, 'scriptOps', {
  writable: true,
  value: {
    kill: mockKill,
    run: vi.fn(),
    runSetup: vi.fn(),
    getPort: vi.fn().mockResolvedValue({ port: null })
  }
})

// Mock window.opencodeOps
const mockAbort = vi.fn()
Object.defineProperty(window, 'opencodeOps', {
  writable: true,
  value: {
    abort: mockAbort,
    send: vi.fn(),
    disconnect: vi.fn(),
    getMessages: vi.fn(),
    listModels: vi.fn(),
    setModel: vi.fn()
  }
})

// Mock window.db
Object.defineProperty(window, 'db', {
  writable: true,
  value: {
    worktree: {
      getActiveByProject: vi.fn().mockResolvedValue([]),
      touch: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      appendSessionTitle: vi.fn()
    },
    session: {
      getActiveByWorktree: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn()
    }
  }
})

// Helper to create a worktree object
function makeWorktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wt1',
    project_id: 'proj1',
    name: 'feature-branch',
    branch_name: 'feature-branch',
    path: '/path/to/wt1',
    status: 'active' as const,
    is_default: false,
    branch_renamed: 0,
    last_message_at: null,
    session_titles: '[]',
    created_at: new Date().toISOString(),
    last_accessed_at: new Date().toISOString(),
    ...overrides
  }
}

// Helper to create a session object
function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session1',
    worktree_id: 'wt1',
    project_id: 'proj1',
    name: 'Test Session',
    status: 'active' as const,
    opencode_session_id: 'oc-session-1',
    mode: 'build' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    ...overrides
  }
}

describe('Session 1: Archive Task Stop', () => {
  beforeEach(() => {
    // Reset all stores
    useWorktreeStore.setState({
      worktreesByProject: new Map(),
      worktreeOrderByProject: new Map(),
      isLoading: false,
      error: null,
      selectedWorktreeId: null,
      creatingForProjectId: null,
      archivingWorktreeIds: new Set()
    })
    useScriptStore.setState({ scriptStates: {} })
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
    useWorktreeStatusStore.setState({
      sessionStatuses: {},
      lastMessageTimeByWorktree: {}
    })

    // Reset all mocks
    mockDelete.mockReset()
    mockKill.mockReset()
    mockAbort.mockReset()
  })

  test('archiveWorktree kills running script before archive', async () => {
    // Set up a worktree in the store
    const worktree = makeWorktree()
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj1', [worktree]]])
    })

    // Set up script state with running process
    useScriptStore.setState({
      scriptStates: {
        wt1: {
          setupOutput: [],
          setupRunning: false,
          setupError: null,
          runOutputVersion: 0,
          runRunning: true,
          runPid: 12345
        }
      }
    })

    mockKill.mockResolvedValue({ success: true })
    mockDelete.mockResolvedValue({ success: true })

    await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    // Verify kill was called with the worktree ID
    expect(mockKill).toHaveBeenCalledWith('wt1')
    // Verify delete was called after kill
    expect(mockDelete).toHaveBeenCalled()
    // Verify runRunning was set to false
    expect(useScriptStore.getState().scriptStates.wt1.runRunning).toBe(false)
  })

  test('archiveWorktree proceeds if kill fails', async () => {
    const worktree = makeWorktree()
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj1', [worktree]]])
    })

    // Script is running but kill will fail
    useScriptStore.setState({
      scriptStates: {
        wt1: {
          setupOutput: [],
          setupRunning: false,
          setupError: null,
          runOutputVersion: 0,
          runRunning: true,
          runPid: 12345
        }
      }
    })

    mockKill.mockRejectedValue(new Error('Process already exited'))
    mockDelete.mockResolvedValue({ success: true })

    const result = await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    // Kill was attempted
    expect(mockKill).toHaveBeenCalledWith('wt1')
    // Archive still proceeded
    expect(mockDelete).toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  test('archiveWorktree skips kill when no process running', async () => {
    const worktree = makeWorktree()
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj1', [worktree]]])
    })

    // No script state or runRunning is false
    useScriptStore.setState({ scriptStates: {} })
    mockDelete.mockResolvedValue({ success: true })

    await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    // Kill should NOT have been called
    expect(mockKill).not.toHaveBeenCalled()
    // Delete should still proceed
    expect(mockDelete).toHaveBeenCalled()
  })

  test('archiveWorktree skips kill when runRunning is false', async () => {
    const worktree = makeWorktree()
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj1', [worktree]]])
    })

    useScriptStore.setState({
      scriptStates: {
        wt1: {
          setupOutput: [],
          setupRunning: false,
          setupError: null,
          runOutputVersion: 0,
          runRunning: false,
          runPid: null
        }
      }
    })

    mockDelete.mockResolvedValue({ success: true })

    await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    expect(mockKill).not.toHaveBeenCalled()
    expect(mockDelete).toHaveBeenCalled()
  })

  test('archiveWorktree aborts active streaming sessions', async () => {
    const worktree = makeWorktree()
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj1', [worktree]]])
    })

    // Set up two sessions: one working, one idle
    const workingSession = makeSession({
      id: 'session-working',
      opencode_session_id: 'oc-working'
    })
    const idleSession = makeSession({
      id: 'session-idle',
      opencode_session_id: 'oc-idle'
    })

    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt1', [workingSession, idleSession]]])
    })

    // Mark working session as 'working', idle session has no status
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-working': { status: 'working', timestamp: Date.now() },
        'session-idle': null
      }
    })

    mockAbort.mockResolvedValue({ success: true })
    mockDelete.mockResolvedValue({ success: true })

    await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    // Abort should be called only for the working session
    expect(mockAbort).toHaveBeenCalledTimes(1)
    expect(mockAbort).toHaveBeenCalledWith('/path/to/wt1', 'oc-working')
    // Delete should still proceed
    expect(mockDelete).toHaveBeenCalled()
  })

  test('archiveWorktree aborts planning sessions too', async () => {
    const worktree = makeWorktree()
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj1', [worktree]]])
    })

    const planningSession = makeSession({
      id: 'session-planning',
      opencode_session_id: 'oc-planning'
    })

    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt1', [planningSession]]])
    })

    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-planning': { status: 'planning', timestamp: Date.now() }
      }
    })

    mockAbort.mockResolvedValue({ success: true })
    mockDelete.mockResolvedValue({ success: true })

    await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    expect(mockAbort).toHaveBeenCalledTimes(1)
    expect(mockAbort).toHaveBeenCalledWith('/path/to/wt1', 'oc-planning')
  })

  test('archiveWorktree proceeds if abort fails', async () => {
    const worktree = makeWorktree()
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj1', [worktree]]])
    })

    const session = makeSession({
      id: 'session-working',
      opencode_session_id: 'oc-working'
    })

    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt1', [session]]])
    })

    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-working': { status: 'working', timestamp: Date.now() }
      }
    })

    mockAbort.mockRejectedValue(new Error('Session already idle'))
    mockDelete.mockResolvedValue({ success: true })

    const result = await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    // Abort was attempted
    expect(mockAbort).toHaveBeenCalled()
    // Archive still proceeded
    expect(mockDelete).toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  test('archiveWorktree skips abort for sessions without opencode_session_id', async () => {
    const worktree = makeWorktree()
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj1', [worktree]]])
    })

    const session = makeSession({
      id: 'session-no-oc',
      opencode_session_id: null
    })

    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt1', [session]]])
    })

    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-no-oc': { status: 'working', timestamp: Date.now() }
      }
    })

    mockDelete.mockResolvedValue({ success: true })

    await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    // Abort should not be called (no opencode session id)
    expect(mockAbort).not.toHaveBeenCalled()
    // Delete should still proceed
    expect(mockDelete).toHaveBeenCalled()
  })

  test('archiveWorktree kills script AND aborts sessions', async () => {
    const worktree = makeWorktree()
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj1', [worktree]]])
    })

    // Script running
    useScriptStore.setState({
      scriptStates: {
        wt1: {
          setupOutput: [],
          setupRunning: false,
          setupError: null,
          runOutputVersion: 0,
          runRunning: true,
          runPid: 99999
        }
      }
    })

    // Active session
    const session = makeSession({
      id: 'session-active',
      opencode_session_id: 'oc-active'
    })

    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt1', [session]]])
    })

    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-active': { status: 'working', timestamp: Date.now() }
      }
    })

    mockKill.mockResolvedValue({ success: true })
    mockAbort.mockResolvedValue({ success: true })
    mockDelete.mockResolvedValue({ success: true })

    const result = await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    // Both kill and abort should have been called
    expect(mockKill).toHaveBeenCalledWith('wt1')
    expect(mockAbort).toHaveBeenCalledWith('/path/to/wt1', 'oc-active')
    expect(mockDelete).toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  test('existing archive behavior unchanged - DB update and state removal', async () => {
    const worktree = makeWorktree()
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj1', [worktree]]]),
      selectedWorktreeId: 'wt1'
    })

    mockDelete.mockResolvedValue({ success: true })

    const result = await useWorktreeStore
      .getState()
      .archiveWorktree('wt1', '/path/to/wt1', 'feature-branch', '/project')

    expect(result.success).toBe(true)
    // Worktree should be removed from the store
    const remaining = useWorktreeStore.getState().worktreesByProject.get('proj1')
    expect(remaining).toEqual([])
    // Selected worktree should be cleared
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
  })
})
