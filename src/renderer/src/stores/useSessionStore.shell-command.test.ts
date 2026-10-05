import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'

const mocks = vi.hoisted(() => ({
  sessionCreate: vi.fn(),
  getActiveByWorktree: vi.fn(),
  getPinnedSessions: vi.fn(),
  getActiveBoardAssistant: vi.fn(),
  ticketUpdate: vi.fn(),
  isWindows: vi.fn(() => false),
  notifyKanbanNewSession: vi.fn(),
  attachAllToChat: vi.fn()
}))

vi.mock('@/api/db-api', () => ({
  dbApi: {
    session: {
      create: mocks.sessionCreate,
      getActiveByWorktree: mocks.getActiveByWorktree,
      getPinnedSessions: mocks.getPinnedSessions,
      getActiveBoardAssistant: mocks.getActiveBoardAssistant
    }
  }
}))

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      update: mocks.ticketUpdate,
      move: vi.fn().mockResolvedValue(undefined),
      getBySession: vi.fn().mockResolvedValue([])
    }
  }
}))

vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  isWindows: mocks.isWindows
}))

// Keep the real coordination (the kanban store registers its auto-attach handler
// through it) but observe every new-session notification.
vi.mock('./store-coordination', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store-coordination')>()
  mocks.notifyKanbanNewSession.mockImplementation(actual.notifyKanbanNewSession)
  return { ...actual, notifyKanbanNewSession: mocks.notifyKanbanNewSession }
})

vi.mock('./useDiffCommentStore', () => ({
  useDiffCommentStore: { getState: () => ({ attachAllToChat: mocks.attachAllToChat }) }
}))

import { useSessionStore, type Session } from './useSessionStore'
import { useKanbanStore } from './useKanbanStore'
import { useShellCommandRunStore } from './useShellCommandRunStore'
import { parseSessionShellCommand, type ProjectShellCommand } from '@shared/lib/shell-commands'

const initialSessionState = useSessionStore.getState()
const initialKanbanState = useKanbanStore.getState()

const PROJECT_ID = 'project-1'
const WORKTREE_ID = 'worktree-1'

const command: ProjectShellCommand = {
  id: 'cmd-1',
  name: '  Install app  ',
  commands: 'pnpm install\npnpm build',
  keepRunningOnQuit: true
}

let nextSessionNumber = 1

/** Echo the create payload back as a session row, like the server does. */
function sessionFromCreate(data: Record<string, unknown>): Session {
  return {
    id: `session-${nextSessionNumber++}`,
    connection_id: null,
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    ...data
  } as unknown as Session
}

function orphanTicket(): KanbanTicket {
  return {
    id: 'ticket-orphan',
    project_id: PROJECT_ID,
    title: 'Unrelated pre-assigned ticket',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: WORKTREE_ID,
    mode: null,
    plan_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    archived_at: null
  } as unknown as KanbanTicket
}

beforeEach(() => {
  vi.clearAllMocks()
  nextSessionNumber = 1
  mocks.isWindows.mockReturnValue(false)
  mocks.sessionCreate.mockImplementation(async (data: Record<string, unknown>) =>
    sessionFromCreate(data)
  )
  mocks.getActiveByWorktree.mockResolvedValue([])
  mocks.getPinnedSessions.mockResolvedValue([])
  mocks.getActiveBoardAssistant.mockResolvedValue(null)
  mocks.ticketUpdate.mockResolvedValue(null)
  useShellCommandRunStore.setState({ runsBySession: {}, loaded: false })
})

afterEach(() => {
  useSessionStore.setState(initialSessionState, true)
  useKanbanStore.setState(initialKanbanState, true)
})

describe('createShellCommandSession', () => {
  it('creates a terminal session of type shell-command with a pending snapshot', async () => {
    const result = await useSessionStore
      .getState()
      .createShellCommandSession({ worktreeId: WORKTREE_ID, projectId: PROJECT_ID, command })

    expect(result.success).toBe(true)
    expect(mocks.sessionCreate).toHaveBeenCalledTimes(1)
    const payload = mocks.sessionCreate.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toEqual({
      worktree_id: WORKTREE_ID,
      project_id: PROJECT_ID,
      name: 'Install app',
      agent_sdk: 'terminal',
      session_type: 'shell-command',
      mode: 'build',
      shell_command: expect.any(String)
    })
    expect(parseSessionShellCommand(payload.shell_command)).toEqual({
      commandId: 'cmd-1',
      name: 'Install app',
      script: 'pnpm install\npnpm build',
      detached: true,
      state: 'pending',
      runId: null,
      exitCode: null,
      signal: null,
      reason: null,
      error: null,
      startedAt: null,
      finishedAt: null
    })
  })

  it('snapshots detached = false when keepRunningOnQuit is not set', async () => {
    await useSessionStore.getState().createShellCommandSession({
      worktreeId: WORKTREE_ID,
      projectId: PROJECT_ID,
      command: { id: 'cmd-2', name: 'Test', commands: 'pnpm test' }
    })

    const payload = mocks.sessionCreate.mock.calls[0][0] as Record<string, unknown>
    expect(parseSessionShellCommand(payload.shell_command)?.detached).toBe(false)
  })

  it('adds the session to the worktree list and the tab order without taking focus', async () => {
    const existing = sessionFromCreate({
      worktree_id: WORKTREE_ID,
      project_id: PROJECT_ID,
      name: 'Session 1',
      agent_sdk: 'claude-code-cli',
      session_type: 'default',
      mode: 'build'
    })
    useSessionStore.setState({
      sessionsByWorktree: new Map([[WORKTREE_ID, [existing]]]),
      tabOrderByWorktree: new Map([[WORKTREE_ID, [existing.id]]]),
      activeWorktreeId: WORKTREE_ID,
      activeSessionId: existing.id,
      activeSessionByWorktree: { [WORKTREE_ID]: existing.id }
    })

    const result = await useSessionStore
      .getState()
      .createShellCommandSession({ worktreeId: WORKTREE_ID, projectId: PROJECT_ID, command })

    const created = result.session!
    const state = useSessionStore.getState()
    expect(state.sessionsByWorktree.get(WORKTREE_ID)?.map((s) => s.id)).toEqual([
      created.id,
      existing.id
    ])
    expect(state.tabOrderByWorktree.get(WORKTREE_ID)).toEqual([existing.id, created.id])
    expect(state.modeBySession.get(created.id)).toBe('build')
    expect(state.activeSessionId).toBe(existing.id)
    expect(state.activeSessionByWorktree[WORKTREE_ID]).toBe(existing.id)
  })

  it('does not notify the kanban store, so an orphan ticket of the worktree stays unattached', async () => {
    useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [orphanTicket()]]]) })

    await useSessionStore
      .getState()
      .createShellCommandSession({ worktreeId: WORKTREE_ID, projectId: PROJECT_ID, command })

    expect(mocks.notifyKanbanNewSession).not.toHaveBeenCalled()
    expect(mocks.attachAllToChat).not.toHaveBeenCalled()
    expect(mocks.ticketUpdate).not.toHaveBeenCalled()
    const ticket = useKanbanStore.getState().tickets.get(PROJECT_ID)?.[0]
    expect(ticket?.current_session_id).toBeNull()
    expect(ticket?.column).toBe('todo')
  })

  it('seeds the run store with the snapshot the server returned', async () => {
    const result = await useSessionStore
      .getState()
      .createShellCommandSession({ worktreeId: WORKTREE_ID, projectId: PROJECT_ID, command })

    const run = useShellCommandRunStore.getState().runsBySession[result.session!.id]
    expect(run).toMatchObject({ commandId: 'cmd-1', name: 'Install app', state: 'pending' })
    expect(run.detached).toBe(true)
  })

  it('falls back to the local snapshot when the returned row carries no shell_command', async () => {
    mocks.sessionCreate.mockImplementation(async (data: Record<string, unknown>) =>
      sessionFromCreate({ ...data, shell_command: null })
    )

    const result = await useSessionStore
      .getState()
      .createShellCommandSession({ worktreeId: WORKTREE_ID, projectId: PROJECT_ID, command })

    expect(useShellCommandRunStore.getState().runsBySession[result.session!.id]).toMatchObject({
      commandId: 'cmd-1',
      script: 'pnpm install\npnpm build',
      state: 'pending'
    })
  })

  it('two launches of the same command create two independent sessions', async () => {
    const input = { worktreeId: WORKTREE_ID, projectId: PROJECT_ID, command }
    const first = await useSessionStore.getState().createShellCommandSession(input)
    const second = await useSessionStore.getState().createShellCommandSession(input)

    expect(first.session!.id).not.toBe(second.session!.id)
    expect(useSessionStore.getState().sessionsByWorktree.get(WORKTREE_ID)).toHaveLength(2)
    expect(Object.keys(useShellCommandRunStore.getState().runsBySession)).toHaveLength(2)
  })

  it('the session stays visible after loadSessions', async () => {
    const result = await useSessionStore
      .getState()
      .createShellCommandSession({ worktreeId: WORKTREE_ID, projectId: PROJECT_ID, command })
    const created = result.session!
    mocks.getActiveByWorktree.mockResolvedValue([created])

    await useSessionStore.getState().loadSessions(WORKTREE_ID, PROJECT_ID)

    const state = useSessionStore.getState()
    expect(state.sessionsByWorktree.get(WORKTREE_ID)?.map((s) => s.id)).toEqual([created.id])
    expect(state.tabOrderByWorktree.get(WORKTREE_ID)).toEqual([created.id])
    expect(state.getSessionById(created.id)?.session_type).toBe('shell-command')
  })

  it('is rejected on Windows without creating anything', async () => {
    mocks.isWindows.mockReturnValue(true)

    const result = await useSessionStore
      .getState()
      .createShellCommandSession({ worktreeId: WORKTREE_ID, projectId: PROJECT_ID, command })

    expect(result).toEqual({
      success: false,
      error: 'Shell commands are not supported on Windows'
    })
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })

  it('returns the error when the create RPC fails', async () => {
    mocks.sessionCreate.mockRejectedValue(new Error('db is locked'))

    const result = await useSessionStore
      .getState()
      .createShellCommandSession({ worktreeId: WORKTREE_ID, projectId: PROJECT_ID, command })

    expect(result).toEqual({ success: false, error: 'db is locked' })
    expect(useSessionStore.getState().sessionsByWorktree.get(WORKTREE_ID)).toBeUndefined()
    expect(useShellCommandRunStore.getState().runsBySession).toEqual({})
  })
})
