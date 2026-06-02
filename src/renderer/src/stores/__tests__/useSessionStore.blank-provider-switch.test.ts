import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../useSessionStore'
import { useSettingsStore } from '../useSettingsStore'
import { useWorktreeStatusStore } from '../useWorktreeStatusStore'
import { useWorktreeStore } from '../useWorktreeStore'

const initialSessionState = useSessionStore.getState()
const initialSettingsState = useSettingsStore.getState()
const initialStatusState = useWorktreeStatusStore.getState()
const initialWorktreeState = useWorktreeStore.getState()

type TestSession = NonNullable<ReturnType<typeof useSessionStore.getState>['getSessionById']>

function makeSession(overrides: Partial<TestSession> = {}): TestSession {
  return {
    id: 'session-1',
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Session 1',
    status: 'active',
    opencode_session_id: 'old-runtime-1',
    claude_session_id: 'old-claude-1',
    agent_sdk: 'opencode',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'old-model',
    model_variant: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    ...overrides
  }
}

function seedSession(session = makeSession()): void {
  useSessionStore.setState({
    sessionsByWorktree: new Map([[session.worktree_id ?? 'worktree-1', [session]]]),
    sessionsByConnection: new Map(),
    modeBySession: new Map([[session.id, session.mode]]),
    pendingMessages: new Map(),
    pendingPlans: new Map(),
    pendingFollowUpMessages: new Map()
  })
}

function setupWindowDb(session = makeSession()): {
  sessionUpdate: ReturnType<typeof vi.fn>
  worktreeUpdateModel: ReturnType<typeof vi.fn>
  sessionMessageList: ReturnType<typeof vi.fn>
  sessionActivityList: ReturnType<typeof vi.fn>
} {
  const sessionUpdate = vi.fn(async (_sessionId: string, data: Partial<TestSession>) => ({
    ...session,
    ...data,
    updated_at: '2026-01-01T00:00:01.000Z'
  }))
  const worktreeUpdateModel = vi.fn()
  const sessionMessageList = vi.fn(async () => [])
  const sessionActivityList = vi.fn(async () => [])

  Object.defineProperty(window, 'db', {
    writable: true,
    configurable: true,
    value: {
      session: {
        get: vi.fn(async () => session),
        update: sessionUpdate
      },
      sessionMessage: {
        list: sessionMessageList
      },
      sessionActivity: {
        list: sessionActivityList
      },
      worktree: {
        updateModel: worktreeUpdateModel
      }
    }
  })

  return { sessionUpdate, worktreeUpdateModel, sessionMessageList, sessionActivityList }
}

describe('useSessionStore.changeBlankSessionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSessionStore.setState(initialSessionState, true)
    useSettingsStore.setState(initialSettingsState, true)
    useWorktreeStatusStore.setState(initialStatusState, true)
    useWorktreeStore.setState(initialWorktreeState, true)

    useSettingsStore.setState({
      defaultAgentSdk: 'opencode',
      availableAgentSdks: { opencode: true, claude: true, codex: true },
      selectedModel: null,
      selectedModelByProvider: {
        codex: { providerID: 'codex', modelID: 'gpt-5.5' },
        'claude-code': { providerID: 'anthropic', modelID: 'opus' },
        'claude-code-cli': { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' }
      },
      defaultModels: null
    })
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'project-1',
          [
            {
              id: 'worktree-1',
              project_id: 'project-1',
              name: 'Main',
              branch_name: 'main',
              path: '/repo',
              is_default: true,
              status: 'active',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
              base_branch: null,
              branch_renamed: 0,
              last_message_at: null,
              last_model_provider_id: null,
              last_model_id: null,
              last_model_variant: null,
              pinned: 0,
              github_pr_number: null,
              github_pr_url: null
            }
          ]
        ]
      ])
    })

    Object.defineProperty(window, 'opencodeOps', {
      writable: true,
      configurable: true,
      value: {
        disconnect: vi.fn(async () => ({ success: true })),
        getMessages: vi.fn(async () => ({ success: true, messages: [] })),
        setModel: vi.fn(async () => ({ success: true }))
      }
    })
    Object.defineProperty(window, 'terminalOps', {
      writable: true,
      configurable: true,
      value: {
        destroy: vi.fn(async () => ({ success: true }))
      }
    })
  })

  it('switches a durable-blank session and clears old runtime IDs', async () => {
    const session = makeSession()
    seedSession(session)
    const { sessionUpdate, worktreeUpdateModel } = setupWindowDb(session)
    const setSelectedModelForSdk = vi.spyOn(useSettingsStore.getState(), 'setSelectedModelForSdk')

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result.success).toBe(true)
    expect(window.opencodeOps.disconnect).toHaveBeenCalledWith('/repo', 'old-runtime-1')
    expect(sessionUpdate).toHaveBeenCalledWith('session-1', {
      agent_sdk: 'codex',
      model_provider_id: 'codex',
      model_id: 'gpt-5.5',
      model_variant: null,
      opencode_session_id: null,
      claude_session_id: null
    })
    expect(useSessionStore.getState().getSessionById('session-1')).toMatchObject({
      agent_sdk: 'codex',
      model_provider_id: 'codex',
      model_id: 'gpt-5.5',
      opencode_session_id: null,
      claude_session_id: null
    })
    expect(worktreeUpdateModel).not.toHaveBeenCalled()
    expect(setSelectedModelForSdk).not.toHaveBeenCalled()
    expect(window.opencodeOps.setModel).not.toHaveBeenCalled()
  })

  it('does not use worktree last-used model when switching providers', async () => {
    const session = makeSession()
    seedSession(session)
    useSettingsStore.setState({
      selectedModelByProvider: {},
      selectedModel: null
    })
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'project-1',
          [
            {
              id: 'worktree-1',
              project_id: 'project-1',
              name: 'Main',
              branch_name: 'main',
              path: '/repo',
              is_default: true,
              status: 'active',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
              base_branch: null,
              branch_renamed: 0,
              last_message_at: null,
              last_model_provider_id: 'anthropic',
              last_model_id: 'opus',
              last_model_variant: null,
              pinned: 0,
              github_pr_number: null,
              github_pr_url: null
            }
          ]
        ]
      ])
    })
    const { sessionUpdate } = setupWindowDb(session)

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result.success).toBe(true)
    expect(sessionUpdate).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        agent_sdk: 'codex',
        model_provider_id: 'codex',
        model_id: 'gpt-5.5'
      })
    )
  })

  it('still allows switching a blank OpenCode-style session into Claude CLI', async () => {
    const session = makeSession({
      agent_sdk: 'opencode',
      opencode_session_id: null,
      claude_session_id: null
    })
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)

    const result = await useSessionStore
      .getState()
      .changeBlankSessionProvider('session-1', 'claude-code-cli')

    expect(result.success).toBe(true)
    expect(sessionUpdate).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        agent_sdk: 'claude-code-cli',
        model_provider_id: 'anthropic',
        model_id: 'sonnet',
        model_variant: 'high',
        opencode_session_id: null,
        claude_session_id: null
      })
    )
    expect(window.terminalOps.destroy).not.toHaveBeenCalled()
  })

  it('rejects sessions with durable messages or activities', async () => {
    const session = makeSession()
    seedSession(session)
    const { sessionMessageList, sessionActivityList, sessionUpdate } = setupWindowDb(session)
    sessionMessageList.mockResolvedValueOnce([{ id: 'message-1' }])

    const messageResult = await useSessionStore
      .getState()
      .changeBlankSessionProvider('session-1', 'codex')
    expect(messageResult.success).toBe(false)

    sessionMessageList.mockResolvedValueOnce([])
    sessionActivityList.mockResolvedValueOnce([{ id: 'activity-1' }])
    const activityResult = await useSessionStore
      .getState()
      .changeBlankSessionProvider('session-1', 'codex')
    expect(activityResult.success).toBe(false)
    expect(sessionUpdate).not.toHaveBeenCalled()
  })

  it('rejects sessions with live transcript history', async () => {
    const session = makeSession()
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)
    window.opencodeOps.getMessages.mockResolvedValueOnce({
      success: true,
      messages: [{ id: 'runtime-message-1' }]
    })

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result).toMatchObject({
      success: false,
      error: 'Provider can only be changed before history exists'
    })
    expect(window.opencodeOps.getMessages).toHaveBeenCalledWith('/repo', 'old-runtime-1')
    expect(sessionUpdate).not.toHaveBeenCalled()
  })

  it('rejects when live transcript history cannot be verified', async () => {
    const session = makeSession()
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)
    window.opencodeOps.getMessages.mockResolvedValueOnce({
      success: false,
      error: 'not connected'
    })

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result).toMatchObject({
      success: false,
      error: 'Could not verify whether this session has live transcript history'
    })
    expect(sessionUpdate).not.toHaveBeenCalled()
  })

  it('rejects when durable history cannot be verified', async () => {
    const session = makeSession()
    seedSession(session)
    setupWindowDb(session)
    Object.defineProperty(window, 'db', {
      writable: true,
      configurable: true,
      value: {
        session: {
          get: vi.fn(async () => session),
          update: vi.fn()
        },
        sessionMessage: {},
        sessionActivity: {
          list: vi.fn(async () => [])
        }
      }
    })

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result).toMatchObject({
      success: false,
      error: 'Could not verify whether this session has history'
    })
    expect(window.db.session.update).not.toHaveBeenCalled()
  })

  it('rejects pending prompts and queued follow-ups', async () => {
    const session = makeSession()
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)

    useSessionStore.setState({ pendingMessages: new Map([['session-1', 'start']]) })
    expect(
      await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')
    ).toMatchObject({ success: false })

    useSessionStore.setState({
      pendingMessages: new Map(),
      pendingFollowUpMessages: new Map([['session-1', ['next']]])
    })
    expect(
      await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')
    ).toMatchObject({ success: false })

    expect(sessionUpdate).not.toHaveBeenCalled()
  })

  it('rejects when provider availability has not loaded', async () => {
    const session = makeSession()
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)
    useSettingsStore.setState({ availableAgentSdks: null })

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result).toMatchObject({
      success: false,
      error: 'Provider availability has not loaded yet'
    })
    expect(sessionUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ['sending', { sending: true, streaming: false, queuedLocalFollowUps: 0 }],
    ['streaming', { sending: false, streaming: true, queuedLocalFollowUps: 0 }],
    ['queued local follow-ups', { sending: false, streaming: false, queuedLocalFollowUps: 1 }]
  ])('rejects provider switching while local activity is %s', async (_label, activity) => {
    const session = makeSession()
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)
    useSessionStore.getState().setProviderSwitchActivity('session-1', activity)

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result).toMatchObject({
      success: false,
      error: 'Provider cannot change while the session is active'
    })
    expect(sessionUpdate).not.toHaveBeenCalled()
  })

  it('rejects active session status', async () => {
    const session = makeSession()
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-1': {
          status: 'working',
          timestamp: Date.now()
        }
      }
    })

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result.success).toBe(false)
    expect(sessionUpdate).not.toHaveBeenCalled()
  })

  it('allows ordinary completed status after durable blankness is verified', async () => {
    const session = makeSession()
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-1': {
          status: 'completed',
          timestamp: Date.now()
        }
      }
    })

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result.success).toBe(true)
    expect(sessionUpdate).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        agent_sdk: 'codex'
      })
    )
  })

  it('fails closed for Claude CLI sessions before a session id is captured', async () => {
    const session = makeSession({
      agent_sdk: 'claude-code-cli',
      opencode_session_id: null,
      claude_session_id: null
    })
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-1': {
          status: 'completed',
          reason: 'pty_start',
          timestamp: Date.now()
        }
      }
    })

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result).toMatchObject({
      success: false,
      error: 'Could not verify whether this session has live transcript history'
    })
    expect(sessionUpdate).not.toHaveBeenCalled()
    expect(window.terminalOps.destroy).not.toHaveBeenCalled()
    expect(window.opencodeOps.disconnect).not.toHaveBeenCalled()
  })

  it('fails closed for launched Claude CLI sessions with an unverifiable transcript', async () => {
    const session = makeSession({
      agent_sdk: 'claude-code-cli',
      opencode_session_id: null,
      claude_session_id: 'claude-session-1'
    })
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result).toMatchObject({
      success: false,
      error: 'Could not verify whether this session has live transcript history'
    })
    expect(sessionUpdate).not.toHaveBeenCalled()
    expect(window.terminalOps.destroy).not.toHaveBeenCalled()
  })

  it('continues when old backend disconnect fails', async () => {
    const session = makeSession()
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)
    window.opencodeOps.disconnect.mockRejectedValueOnce(new Error('already gone'))

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result.success).toBe(true)
    expect(sessionUpdate).toHaveBeenCalled()
    expect(useSessionStore.getState().getSessionById('session-1')?.agent_sdk).toBe('codex')
  })

  it('disconnects the pre-update database runtime id when memory is stale', async () => {
    const memorySession = makeSession({
      opencode_session_id: null,
      claude_session_id: null
    })
    const dbSession = makeSession({
      opencode_session_id: 'db-runtime-1',
      claude_session_id: 'db-claude-1'
    })
    seedSession(memorySession)
    setupWindowDb(dbSession)

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result.success).toBe(true)
    expect(window.opencodeOps.getMessages).toHaveBeenCalledWith('/repo', 'db-runtime-1')
    expect(window.opencodeOps.disconnect).toHaveBeenCalledWith('/repo', 'db-runtime-1')
  })

  it('does not mutate local state when the database update fails', async () => {
    const session = makeSession()
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)
    sessionUpdate.mockRejectedValueOnce(new Error('write failed'))

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result.success).toBe(false)
    expect(useSessionStore.getState().getSessionById('session-1')).toMatchObject({
      agent_sdk: 'opencode',
      model_id: 'old-model',
      opencode_session_id: 'old-runtime-1'
    })
    expect(window.opencodeOps.disconnect).not.toHaveBeenCalled()
    expect(window.terminalOps.destroy).not.toHaveBeenCalled()
  })

  it('does not tear down a Claude CLI PTY when the database update fails', async () => {
    const session = makeSession({
      agent_sdk: 'claude-code-cli',
      opencode_session_id: null,
      claude_session_id: null
    })
    seedSession(session)
    const { sessionUpdate } = setupWindowDb(session)
    sessionUpdate.mockRejectedValueOnce(new Error('write failed'))

    const result = await useSessionStore.getState().changeBlankSessionProvider('session-1', 'codex')

    expect(result.success).toBe(false)
    expect(window.terminalOps.destroy).not.toHaveBeenCalled()
    expect(useSessionStore.getState().getSessionById('session-1')?.agent_sdk).toBe(
      'claude-code-cli'
    )
  })
})
