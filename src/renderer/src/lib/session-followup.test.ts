import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, Worktree } from '../../../main/db/types'

const mocks = vi.hoisted(() => ({
  terminalApi: {
    sendClaudeCliPrompt: vi.fn(),
    createClaudeCli: vi.fn()
  },
  opencodeApi: {
    reconnect: vi.fn(),
    prompt: vi.fn()
  },
  dbApi: {
    session: { get: vi.fn(), update: vi.fn() },
    worktree: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) }
  },
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  autoPinForBoardPrompt: vi.fn(),
  startHivePromptTelemetry: vi.fn()
}))

vi.mock('@/api/terminal-api', () => ({ terminalApi: mocks.terminalApi }))
vi.mock('@/api/opencode-api', () => ({ opencodeApi: mocks.opencodeApi }))
vi.mock('@/api/db-api', () => ({ dbApi: mocks.dbApi }))
vi.mock('@/lib/toast', () => ({ toast: mocks.toast }))
vi.mock('@/lib/auto-pin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auto-pin')>()),
  autoPinForBoardPrompt: mocks.autoPinForBoardPrompt
}))
vi.mock('@/lib/hive-enterprise-telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hive-enterprise-telemetry')>()),
  startHivePromptTelemetry: mocks.startHivePromptTelemetry
}))

import { CONTINUE_PROMPT, continueTicketSession, sendFollowupToSession } from './session-followup'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useKanbanStore } from '@/stores/useKanbanStore'

const now = '2026-01-01T00:00:00.000Z'

const worktree: Worktree = {
  id: 'worktree-1',
  project_id: 'project-1',
  name: 'Feature',
  branch_name: 'feature',
  path: '/repo/feature',
  status: 'active',
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  attachments: '[]',
  pinned: 0,
  context: null,
  github_pr_number: null,
  github_pr_url: null,
  base_branch: null,
  created_at: now,
  last_accessed_at: now
}

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Errored session',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'opus',
    model_variant: 'high',
    remote_launch: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

const ticket = {
  id: 'ticket-1',
  project_id: 'project-1',
  current_session_id: 'session-1',
  mode: 'build' as const
}

const setSessionMode = vi.fn().mockResolvedValue(undefined)
const reactivateSession = vi.fn().mockResolvedValue(undefined)
const updateTicket = vi.fn().mockResolvedValue(undefined)

function seedSession(session: Session): void {
  useSessionStore.setState({
    sessionsByWorktree: new Map([[session.worktree_id ?? '', [session]]]),
    sessionsByConnection: new Map(),
    setSessionMode,
    reactivateSession
  } as Partial<ReturnType<typeof useSessionStore.getState>>)
}

describe('continueTicketSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.terminalApi.sendClaudeCliPrompt.mockResolvedValue({
      success: true,
      value: { delivered: true }
    })
    mocks.terminalApi.createClaudeCli.mockResolvedValue({
      success: true,
      value: { success: true }
    })
    mocks.opencodeApi.reconnect.mockResolvedValue({ success: true, value: { success: true } })
    mocks.opencodeApi.prompt.mockResolvedValue({ success: true, value: { success: true } })
    mocks.dbApi.session.get.mockResolvedValue(null)
    mocks.dbApi.worktree.get.mockResolvedValue(null)

    useWorktreeStore.setState({
      worktreesByProject: new Map([['project-1', [worktree]]])
    } as Partial<ReturnType<typeof useWorktreeStore.getState>>)
    useWorktreeStatusStore.setState({ sessionStatuses: {}, sessionApiErrors: {} })
    useKanbanStore.setState({ updateTicket } as Partial<ReturnType<typeof useKanbanStore.getState>>)
  })

  afterEach(() => {
    useSessionStore.setState({
      sessionsByWorktree: new Map(),
      sessionsByConnection: new Map()
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
  })

  it('writes "continue" into the PTY of a CLI session', async () => {
    seedSession(makeSession({ agent_sdk: 'claude-code-cli' }))

    await expect(continueTicketSession({ ...ticket, mode: 'super-build' })).resolves.toBe(true)

    expect(mocks.terminalApi.sendClaudeCliPrompt).toHaveBeenCalledWith('session-1', CONTINUE_PROMPT)
    expect(mocks.opencodeApi.prompt).not.toHaveBeenCalled()
    // Super modes are one-shot: the ticket continues in its base mode.
    expect(updateTicket).toHaveBeenCalledWith('ticket-1', 'project-1', {
      mode: 'build',
      plan_ready: false
    })
    expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']?.status).toBe('working')
    expect(mocks.toast.success).toHaveBeenCalledWith('Continue sent')
  })

  it('prompts an SDK session through the agent SDK API', async () => {
    seedSession(makeSession({ agent_sdk: 'claude-code', opencode_session_id: 'opc-1' }))

    await expect(continueTicketSession(ticket)).resolves.toBe(true)

    expect(mocks.opencodeApi.reconnect).toHaveBeenCalledWith('/repo/feature', 'opc-1', 'session-1')
    expect(mocks.opencodeApi.prompt).toHaveBeenCalledWith(
      '/repo/feature',
      'opc-1',
      [{ type: 'text', text: CONTINUE_PROMPT }],
      { providerID: 'anthropic', modelID: 'opus', variant: 'high' }
    )
    expect(mocks.terminalApi.sendClaudeCliPrompt).not.toHaveBeenCalled()
    expect(updateTicket).toHaveBeenCalledWith('ticket-1', 'project-1', {
      mode: 'build',
      plan_ready: false
    })
  })

  it('reports a failed send and rolls back the working status', async () => {
    seedSession(makeSession({ agent_sdk: 'codex', opencode_session_id: 'opc-1' }))
    mocks.opencodeApi.prompt.mockResolvedValue({
      success: true,
      value: { success: false, error: 'boom' }
    })

    await expect(continueTicketSession(ticket)).resolves.toBe(false)

    expect(updateTicket).not.toHaveBeenCalled()
    expect(mocks.toast.error).toHaveBeenCalledWith('Failed to send continue')
    expect(useWorktreeStatusStore.getState().sessionStatuses['session-1']).toBeNull()
  })

  it('refuses when the ticket has no linked session', async () => {
    await expect(continueTicketSession({ ...ticket, current_session_id: null })).resolves.toBe(
      false
    )

    expect(mocks.terminalApi.sendClaudeCliPrompt).not.toHaveBeenCalled()
    expect(mocks.opencodeApi.prompt).not.toHaveBeenCalled()
    expect(mocks.toast.error).toHaveBeenCalled()
  })
})

describe('sendFollowupToSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.opencodeApi.reconnect.mockResolvedValue({ success: true, value: { success: true } })
    mocks.opencodeApi.prompt.mockResolvedValue({ success: true, value: { success: true } })
    mocks.dbApi.worktree.get.mockResolvedValue(null)
    useWorktreeStore.setState({
      worktreesByProject: new Map([['project-1', [worktree]]])
    } as Partial<ReturnType<typeof useWorktreeStore.getState>>)
    useWorktreeStatusStore.setState({ sessionStatuses: {}, sessionApiErrors: {} })
    seedSession(makeSession({ agent_sdk: 'claude-code', opencode_session_id: 'opc-1' }))
  })

  afterEach(() => {
    useSessionStore.setState({
      sessionsByWorktree: new Map(),
      sessionsByConnection: new Map()
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
  })

  it('applies the mode default model unless asked to keep the session model', async () => {
    await sendFollowupToSession({
      sessionId: 'session-1',
      prompt: 'continue',
      followUpMode: 'build',
      ticketId: 'ticket-1'
    })
    expect(setSessionMode).toHaveBeenLastCalledWith('session-1', 'build', undefined)

    await sendFollowupToSession({
      sessionId: 'session-1',
      prompt: 'continue',
      followUpMode: 'build',
      ticketId: 'ticket-1',
      preserveSessionModel: true
    })
    expect(setSessionMode).toHaveBeenLastCalledWith('session-1', 'build', {
      applyModeDefault: false
    })
    expect(mocks.opencodeApi.prompt).toHaveBeenLastCalledWith(
      '/repo/feature',
      'opc-1',
      [{ type: 'text', text: 'continue' }],
      { providerID: 'anthropic', modelID: 'opus', variant: 'high' }
    )
  })
})
