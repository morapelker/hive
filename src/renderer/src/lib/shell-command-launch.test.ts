import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectShellCommand, SessionShellCommand } from '@shared/lib/shell-commands'

/** Every observable side effect, in call order (ordering is part of the contract). */
const calls: string[] = []

const settingsState = {
  automaticallyCreateTicket: true,
  hiveOrganizationId: null as string | null,
  hiveOrganizationForceBoardMode: false
}
vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: () => settingsState }
}))

const forceBoardMode = { value: false }
vi.mock('@/api/hive-enterprise/client', () => ({
  isForceBoardMode: () => forceBoardMode.value
}))

const platform = { windows: false }
vi.mock('@/lib/platform', () => ({ isWindows: () => platform.windows }))

const autoPinForBoardPrompt = vi.fn(async (_target: unknown) => {})
vi.mock('@/lib/auto-pin', () => ({
  autoPinForBoardPrompt: (target: unknown) => autoPinForBoardPrompt(target)
}))

const markShellCommandStartFailed = vi.fn((_sessionId: string, _error: string) => {
  calls.push('markShellCommandStartFailed')
})
vi.mock('@/lib/shell-command-status', () => ({
  markShellCommandStartFailed: (sessionId: string, error: string) =>
    markShellCommandStartFailed(sessionId, error)
}))

const runShellCommand = vi.fn()
vi.mock('@/api/terminal-api', () => ({
  terminalApi: {
    runShellCommand: (...args: unknown[]) => {
      calls.push('runShellCommand')
      return runShellCommand(...args)
    }
  }
}))

const sessionGet = vi.fn()
vi.mock('@/api/db-api', () => ({
  dbApi: { session: { get: (id: string) => sessionGet(id) } }
}))

const getBySession = vi.fn()
vi.mock('@/api/kanban-api', () => ({
  kanbanApi: { ticket: { getBySession: (id: string) => getBySession(id) } }
}))

interface TestWorktree {
  id: string
  is_default?: boolean
}
const worktreeState = {
  worktreesByProject: new Map<string, TestWorktree[]>(),
  /** What a loadWorktrees call makes appear in the store. */
  afterLoad: null as Map<string, TestWorktree[]> | null,
  getDefaultWorktree: vi.fn(
    (projectId: string): TestWorktree | null =>
      worktreeState.worktreesByProject.get(projectId)?.find((w) => w.is_default) ?? null
  ),
  loadWorktrees: vi.fn(async (_projectId: string) => {
    if (worktreeState.afterLoad) worktreeState.worktreesByProject = worktreeState.afterLoad
  }),
  selectWorktree: vi.fn((_id: string) => {
    calls.push('selectWorktree')
  })
}
vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: { getState: () => worktreeState }
}))

const projectState = {
  projects: [] as Array<{ id: string; kind?: 'git' | 'connection'; shell_commands?: unknown }>,
  expandedProjectIds: new Set<string>(),
  selectProject: vi.fn((_id: string) => {
    calls.push('selectProject')
  }),
  toggleProjectExpanded: vi.fn((_id: string) => {
    calls.push('toggleProjectExpanded')
  })
}
vi.mock('@/stores/useProjectStore', () => ({
  useProjectStore: { getState: () => projectState }
}))

interface TestTicket {
  id: string
  column: string
  sort_order: number
  current_session_id?: string | null
  archived_at?: string | null
}
const kanbanState = {
  tickets: new Map<string, TestTicket[]>(),
  isBoardViewActive: false,
  closeBoardView: vi.fn(() => {
    calls.push('closeBoardView')
  }),
  closePinnedBoard: vi.fn(),
  loadTickets: vi.fn(async (projectId: string) => {
    calls.push('loadTickets')
    if (!kanbanState.tickets.has(projectId)) kanbanState.tickets.set(projectId, [])
  }),
  getTicketsByColumn: vi.fn((projectId: string, column: string) =>
    (kanbanState.tickets.get(projectId) ?? []).filter((t) => t.column === column)
  ),
  computeSortOrder: vi.fn((_tickets: TestTicket[], _index: number) => 7),
  createTicket: vi.fn(async (projectId: string, data: Record<string, unknown>) => {
    calls.push('createTicket')
    const ticket = { id: `ticket-${nextTicketNumber++}`, ...data } as unknown as TestTicket
    kanbanState.tickets.set(projectId, [...(kanbanState.tickets.get(projectId) ?? []), ticket])
    return ticket
  }),
  updateTicket: vi.fn(
    async (ticketId: string, projectId: string, data: Record<string, unknown>) => {
      calls.push('updateTicket')
      kanbanState.tickets.set(
        projectId,
        (kanbanState.tickets.get(projectId) ?? []).map((t) =>
          t.id === ticketId ? { ...t, ...data } : t
        )
      )
    }
  ),
  toggleBoardView: vi.fn(() => {
    calls.push('toggleBoardView')
  })
}
vi.mock('@/stores/useKanbanStore', () => ({
  useKanbanStore: { getState: () => kanbanState }
}))

const statusState = {
  setSessionStatus: vi.fn((sessionId: string, status: string) => {
    calls.push(`setSessionStatus:${status}`)
    // Snapshot the stamps the status flip can see.
    stampsAtStatus = {
      messageSendTime: messageSendTimes.get(sessionId),
      explicitSendTime: userExplicitSendTimes.get(sessionId),
      mode: lastSendMode.get(sessionId)
    }
  }),
  clearSessionApiError: vi.fn((_sessionId: string) => {
    calls.push('clearSessionApiError')
  })
}
vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: { getState: () => statusState }
}))

const sessionState = {
  sessions: new Map<string, { id: string; project_id: string; worktree_id: string | null }>(),
  createShellCommandSession: vi.fn(
    async (input: { worktreeId: string; projectId: string; command: ProjectShellCommand }) => {
      calls.push('createShellCommandSession')
      const session = {
        id: `session-${nextSessionNumber++}`,
        project_id: input.projectId,
        worktree_id: input.worktreeId
      }
      sessionState.sessions.set(session.id, session)
      return { success: true, session } as {
        success: boolean
        session?: typeof session
        error?: string
      }
    }
  ),
  getSessionById: vi.fn((id: string) => sessionState.sessions.get(id) ?? null),
  reactivateSession: vi.fn(async (_id: string) => {
    calls.push('reactivateSession')
  }),
  closeSession: vi.fn(async (_id: string) => {
    calls.push('closeSession')
    return { success: true }
  }),
  setActiveWorktree: vi.fn((_id: string) => {
    calls.push('setActiveWorktree')
  }),
  setActiveSession: vi.fn((_id: string) => {
    calls.push('setActiveSession')
  })
}
vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: { getState: () => sessionState }
}))

const runStoreState = {
  runsBySession: {} as Record<string, SessionShellCommand>,
  setRun: vi.fn((sessionId: string, run: SessionShellCommand) => {
    runStoreState.runsBySession[sessionId] = run
  })
}
vi.mock('@/stores/useShellCommandRunStore', () => ({
  useShellCommandRunStore: { getState: () => runStoreState }
}))

import { rerunShellCommand, runProjectShellCommand } from './shell-command-launch'
import { lastSendMode, messageSendTimes, userExplicitSendTimes } from '@/lib/message-send-times'
import {
  createSessionShellCommandSnapshot,
  serializeSessionShellCommand
} from '@shared/lib/shell-commands'

const PROJECT = 'project-1'
const BASE = 'wt-base'
const FEATURE = 'wt-feature'

const COMMAND: ProjectShellCommand = {
  id: 'cmd-install',
  name: 'Install app',
  commands: 'pnpm install\npnpm build'
}
const OTHER_COMMAND: ProjectShellCommand = { id: 'cmd-test', name: 'Test', commands: 'pnpm test' }

let nextSessionNumber = 1
let nextTicketNumber = 1
let stampsAtStatus: {
  messageSendTime: number | undefined
  explicitSendTime: number | undefined
  mode: string | undefined
} | null = null

function runSnapshot(overrides: Partial<SessionShellCommand> = {}): SessionShellCommand {
  return { ...createSessionShellCommandSnapshot(COMMAND), ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  nextSessionNumber = 1
  nextTicketNumber = 1
  stampsAtStatus = null
  messageSendTimes.clear()
  userExplicitSendTimes.clear()
  lastSendMode.clear()

  settingsState.automaticallyCreateTicket = true
  forceBoardMode.value = false
  platform.windows = false

  worktreeState.worktreesByProject = new Map([
    [
      PROJECT,
      [
        { id: BASE, is_default: true },
        { id: FEATURE, is_default: false }
      ]
    ],
    ['other-project', [{ id: 'wt-elsewhere', is_default: true }]]
  ])
  worktreeState.afterLoad = null
  projectState.projects = [
    { id: PROJECT, kind: 'git', shell_commands: [COMMAND, OTHER_COMMAND] },
    { id: 'conn-project', kind: 'connection', shell_commands: [COMMAND] }
  ]
  projectState.expandedProjectIds = new Set([PROJECT])
  kanbanState.tickets = new Map([[PROJECT, []]])
  kanbanState.isBoardViewActive = false
  sessionState.sessions = new Map()
  runStoreState.runsBySession = {}

  runShellCommand.mockResolvedValue({ success: true, value: { success: true, cols: 80, rows: 24 } })
  getBySession.mockResolvedValue([])
  sessionGet.mockResolvedValue(null)
})

describe('runProjectShellCommand — guards', () => {
  it('rejects on Windows', async () => {
    platform.windows = true

    await expect(
      runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })
    ).resolves.toEqual({ success: false, error: 'Shell commands are not supported on Windows' })
    expect(sessionState.createShellCommandSession).not.toHaveBeenCalled()
  })

  it('rejects connection projects and unknown projects', async () => {
    const error = 'Shell commands are only available for git projects'

    await expect(
      runProjectShellCommand({ projectId: 'conn-project', commandId: COMMAND.id })
    ).resolves.toEqual({ success: false, error })
    await expect(
      runProjectShellCommand({ projectId: 'missing', commandId: COMMAND.id })
    ).resolves.toEqual({ success: false, error })
    expect(sessionState.createShellCommandSession).not.toHaveBeenCalled()
  })

  it('rejects an unknown command id', async () => {
    await expect(
      runProjectShellCommand({ projectId: PROJECT, commandId: 'cmd-gone' })
    ).resolves.toEqual({ success: false, error: 'Command not found' })
    expect(sessionState.createShellCommandSession).not.toHaveBeenCalled()
  })

  it('rejects when the project has no (valid) shell commands', async () => {
    projectState.projects = [{ id: PROJECT, kind: 'git', shell_commands: null }]

    await expect(
      runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })
    ).resolves.toEqual({ success: false, error: 'Command not found' })
  })

  it('never throws: an unexpected store error becomes a returned error', async () => {
    sessionState.createShellCommandSession.mockRejectedValueOnce(new Error('store exploded'))

    await expect(
      runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })
    ).resolves.toEqual({ success: false, error: 'store exploded' })
  })
})

describe('runProjectShellCommand — worktree resolution', () => {
  it('project-level launch runs in the base worktree', async () => {
    const result = await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(result).toMatchObject({ success: true, worktreeId: BASE })
    expect(worktreeState.loadWorktrees).not.toHaveBeenCalled()
    expect(sessionState.createShellCommandSession).toHaveBeenCalledWith({
      worktreeId: BASE,
      projectId: PROJECT,
      command: COMMAND
    })
  })

  it('reloads the worktrees once when the base is not in the store yet', async () => {
    worktreeState.afterLoad = worktreeState.worktreesByProject
    worktreeState.worktreesByProject = new Map()

    const result = await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(worktreeState.loadWorktrees).toHaveBeenCalledExactlyOnceWith(PROJECT)
    expect(result).toMatchObject({ success: true, worktreeId: BASE })
  })

  it('fails when the project has no base worktree even after the reload', async () => {
    worktreeState.worktreesByProject = new Map([[PROJECT, [{ id: FEATURE, is_default: false }]]])

    await expect(
      runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })
    ).resolves.toEqual({ success: false, error: 'No base worktree found for this project' })
    expect(worktreeState.loadWorktrees).toHaveBeenCalledTimes(1)
    expect(sessionState.createShellCommandSession).not.toHaveBeenCalled()
  })

  it('worktree-level launch runs in that worktree', async () => {
    const result = await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      worktreeId: FEATURE
    })

    expect(result).toMatchObject({ success: true, worktreeId: FEATURE })
    expect(sessionState.createShellCommandSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: FEATURE })
    )
  })

  it('reloads once for a worktree that was only just created', async () => {
    worktreeState.afterLoad = new Map([
      [
        PROJECT,
        [
          { id: BASE, is_default: true },
          { id: 'wt-new', is_default: false }
        ]
      ]
    ])

    const result = await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      worktreeId: 'wt-new'
    })

    expect(worktreeState.loadWorktrees).toHaveBeenCalledExactlyOnceWith(PROJECT)
    expect(result).toMatchObject({ success: true, worktreeId: 'wt-new' })
  })

  it('a worktree that is not in the project is an error, never a fallback to the base', async () => {
    for (const worktreeId of ['wt-elsewhere', 'wt-archived']) {
      await expect(
        runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, worktreeId })
      ).resolves.toEqual({ success: false, error: 'Worktree not found' })
    }
    expect(sessionState.createShellCommandSession).not.toHaveBeenCalled()
    expect(runShellCommand).not.toHaveBeenCalled()
  })
})

describe('runProjectShellCommand — ticket and auto-pin', () => {
  it('creates no ticket and does not auto-pin when automaticallyCreateTicket is off', async () => {
    settingsState.automaticallyCreateTicket = false

    const result = await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(result).toEqual({
      success: true,
      sessionId: 'session-1',
      ticketId: null,
      worktreeId: BASE
    })
    expect(kanbanState.createTicket).not.toHaveBeenCalled()
    expect(kanbanState.loadTickets).not.toHaveBeenCalled()
    expect(autoPinForBoardPrompt).not.toHaveBeenCalled()
    expect(runShellCommand).toHaveBeenCalledTimes(1)
  })

  it('creates the In Progress ticket with exactly the expected fields', async () => {
    const result = await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      worktreeId: FEATURE
    })

    expect(kanbanState.createTicket).toHaveBeenCalledExactlyOnceWith(PROJECT, {
      project_id: PROJECT,
      title: 'Install app',
      description: 'pnpm install\npnpm build',
      column: 'in_progress',
      sort_order: 7,
      current_session_id: 'session-1',
      worktree_id: FEATURE,
      mode: 'build',
      external_provider: 'shell-command',
      external_id: COMMAND.id,
      created_from_session: true
    })
    expect(kanbanState.getTicketsByColumn).toHaveBeenCalledWith(PROJECT, 'in_progress')
    expect(kanbanState.computeSortOrder).toHaveBeenCalledWith([], 0)
    expect(result).toMatchObject({ success: true, ticketId: 'ticket-1' })
  })

  it('auto-pins with { projectId, worktreeId } when a ticket was created', async () => {
    await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, worktreeId: FEATURE })

    expect(autoPinForBoardPrompt).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT,
      worktreeId: FEATURE
    })
  })

  it('forces a ticket under Force Board Mode even when the setting is off', async () => {
    settingsState.automaticallyCreateTicket = false
    forceBoardMode.value = true

    const result = await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(kanbanState.createTicket).toHaveBeenCalledTimes(1)
    expect(autoPinForBoardPrompt).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT,
      worktreeId: BASE
    })
    expect(result.ticketId).toBe('ticket-1')
  })

  it('loads the project tickets first when they are not loaded', async () => {
    kanbanState.tickets = new Map()

    await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(kanbanState.loadTickets).toHaveBeenCalledExactlyOnceWith(PROJECT)
    expect(calls.indexOf('loadTickets')).toBeLessThan(calls.indexOf('createShellCommandSession'))
    expect(calls.indexOf('loadTickets')).toBeLessThan(calls.indexOf('createTicket'))
  })

  it('continues without a ticket (and without a pin) when creating it throws', async () => {
    kanbanState.createTicket.mockRejectedValueOnce(new Error('schema rejected'))

    const result = await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(result).toEqual({
      success: true,
      sessionId: 'session-1',
      ticketId: null,
      worktreeId: BASE
    })
    expect(autoPinForBoardPrompt).not.toHaveBeenCalled()
    expect(runShellCommand).toHaveBeenCalledTimes(1)
  })

  it('returns the session error and creates nothing else when the session cannot be created', async () => {
    sessionState.createShellCommandSession.mockResolvedValueOnce({
      success: false,
      error: 'db is locked'
    })

    await expect(
      runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })
    ).resolves.toEqual({ success: false, error: 'db is locked' })
    expect(kanbanState.createTicket).not.toHaveBeenCalled()
    expect(runShellCommand).not.toHaveBeenCalled()
    expect(statusState.setSessionStatus).not.toHaveBeenCalled()
  })
})

describe('runProjectShellCommand — for an existing ticket', () => {
  const TICKET = 'ticket-todo'

  function seedTicket(overrides: Partial<TestTicket> = {}): void {
    kanbanState.tickets.set(PROJECT, [
      { id: 'ticket-running', column: 'in_progress', sort_order: 3, current_session_id: 'other' },
      { id: TICKET, column: 'todo', sort_order: 12, current_session_id: null, ...overrides }
    ])
  }

  beforeEach(() => seedTicket())

  it('links the ticket instead of creating one, even when automaticallyCreateTicket is on', async () => {
    const result = await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      ticketId: TICKET
    })

    expect(result).toEqual({
      success: true,
      sessionId: 'session-1',
      ticketId: TICKET,
      worktreeId: BASE
    })
    expect(kanbanState.createTicket).not.toHaveBeenCalled()
    expect(kanbanState.updateTicket).toHaveBeenCalledTimes(1)
    expect(kanbanState.tickets.get(PROJECT)).toHaveLength(2)
  })

  it('links the ticket when the setting is off, and under Force Board Mode', async () => {
    settingsState.automaticallyCreateTicket = false

    const result = await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      ticketId: TICKET
    })

    expect(result).toMatchObject({ success: true, sessionId: 'session-1', ticketId: TICKET })
    expect(kanbanState.updateTicket).toHaveBeenCalledTimes(1)
    expect(runShellCommand).toHaveBeenCalledExactlyOnceWith('session-1')

    seedTicket()
    forceBoardMode.value = true
    const forced = await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      ticketId: TICKET
    })

    expect(forced).toMatchObject({ success: true, sessionId: 'session-2', ticketId: TICKET })
    expect(kanbanState.createTicket).not.toHaveBeenCalled()
  })

  it('updates the ticket with exactly the link fields, at the top of In Progress by default', async () => {
    await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, ticketId: TICKET })

    expect(kanbanState.updateTicket).toHaveBeenCalledExactlyOnceWith(TICKET, PROJECT, {
      column: 'in_progress',
      sort_order: 7,
      current_session_id: 'session-1',
      worktree_id: BASE,
      mode: 'build',
      plan_ready: false,
      pending_launch_config: null
    })
    expect(kanbanState.getTicketsByColumn).toHaveBeenCalledWith(PROJECT, 'in_progress')
    expect(kanbanState.computeSortOrder).toHaveBeenCalledExactlyOnceWith(
      [expect.objectContaining({ id: 'ticket-running' })],
      0
    )
  })

  it('uses an explicit sortOrder as is, 0 included', async () => {
    await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      ticketId: TICKET,
      sortOrder: 42.5
    })
    seedTicket()
    await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      ticketId: TICKET,
      sortOrder: 0
    })

    expect(kanbanState.updateTicket.mock.calls.map(([, , data]) => data.sort_order)).toEqual([
      42.5, 0
    ])
    expect(kanbanState.computeSortOrder).not.toHaveBeenCalled()
  })

  it('never rewrites the ticket text or its marker', async () => {
    await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, ticketId: TICKET })

    const data = kanbanState.updateTicket.mock.calls[0][2]
    for (const field of ['title', 'description', 'external_provider', 'external_id']) {
      expect(data).not.toHaveProperty(field)
    }
  })

  it('orders the steps: session, ticket link, status, start', async () => {
    await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      ticketId: TICKET,
      focus: false
    })

    expect(calls).toEqual([
      'createShellCommandSession',
      'updateTicket',
      'setSessionStatus:working',
      'runShellCommand'
    ])
  })

  it('runs in the base worktree when worktreeId is omitted', async () => {
    const result = await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      ticketId: TICKET
    })

    expect(result).toMatchObject({ success: true, worktreeId: BASE })
    expect(sessionState.createShellCommandSession).toHaveBeenCalledExactlyOnceWith({
      worktreeId: BASE,
      projectId: PROJECT,
      command: COMMAND
    })
    expect(kanbanState.updateTicket).toHaveBeenCalledExactlyOnceWith(
      TICKET,
      PROJECT,
      expect.objectContaining({ worktree_id: BASE })
    )
  })

  it('links the ticket to an explicit worktree', async () => {
    await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      ticketId: TICKET,
      worktreeId: FEATURE
    })

    expect(kanbanState.updateTicket).toHaveBeenCalledExactlyOnceWith(
      TICKET,
      PROJECT,
      expect.objectContaining({ worktree_id: FEATURE, current_session_id: 'session-1' })
    )
  })

  it('auto-pins alongside the linked ticket, also with the setting off', async () => {
    settingsState.automaticallyCreateTicket = false

    await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, ticketId: TICKET })

    expect(autoPinForBoardPrompt).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT,
      worktreeId: BASE
    })
  })

  it('does not navigate when focus is false', async () => {
    kanbanState.isBoardViewActive = true

    const result = await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      ticketId: TICKET,
      focus: false
    })

    expect(result.success).toBe(true)
    expect(kanbanState.toggleBoardView).not.toHaveBeenCalled()
    expect(worktreeState.selectWorktree).not.toHaveBeenCalled()
    expect(projectState.selectProject).not.toHaveBeenCalled()
    expect(sessionState.setActiveWorktree).not.toHaveBeenCalled()
    expect(sessionState.setActiveSession).not.toHaveBeenCalled()
  })

  it('loads the project tickets before looking the ticket up, with the setting off too', async () => {
    settingsState.automaticallyCreateTicket = false
    const loaded = kanbanState.tickets
    kanbanState.tickets = new Map()
    kanbanState.loadTickets.mockImplementationOnce(async () => {
      calls.push('loadTickets')
      kanbanState.tickets = loaded
    })

    const result = await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      ticketId: TICKET
    })

    expect(result).toMatchObject({ success: true, ticketId: TICKET })
    expect(kanbanState.loadTickets).toHaveBeenCalledExactlyOnceWith(PROJECT)
    expect(calls.indexOf('loadTickets')).toBeLessThan(calls.indexOf('createShellCommandSession'))
  })

  it('a missing ticket is "Ticket not found" and no session is created', async () => {
    kanbanState.tickets.set('other-project', [
      { id: 'ticket-elsewhere', column: 'todo', sort_order: 1 }
    ])

    for (const ticketId of ['ticket-gone', 'ticket-elsewhere']) {
      await expect(
        runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, ticketId })
      ).resolves.toEqual({ success: false, error: 'Ticket not found' })
    }
    expect(calls).toEqual([])
    expect(sessionState.createShellCommandSession).not.toHaveBeenCalled()
    expect(kanbanState.updateTicket).not.toHaveBeenCalled()
    expect(runShellCommand).not.toHaveBeenCalled()
  })

  it('an archived ticket is "Ticket not found" and no session is created', async () => {
    seedTicket({ archived_at: '2026-01-02T00:00:00.000Z' })

    await expect(
      runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, ticketId: TICKET })
    ).resolves.toEqual({ success: false, error: 'Ticket not found' })
    expect(sessionState.createShellCommandSession).not.toHaveBeenCalled()
    expect(kanbanState.updateTicket).not.toHaveBeenCalled()
    expect(runShellCommand).not.toHaveBeenCalled()
  })

  it('a ticket that already has a session is refused and no session is created', async () => {
    seedTicket({ column: 'in_progress', current_session_id: 'session-existing' })

    await expect(
      runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, ticketId: TICKET })
    ).resolves.toEqual({ success: false, error: 'Ticket already has a session' })
    expect(sessionState.createShellCommandSession).not.toHaveBeenCalled()
    expect(kanbanState.updateTicket).not.toHaveBeenCalled()
    expect(runShellCommand).not.toHaveBeenCalled()
    expect(kanbanState.tickets.get(PROJECT)).toContainEqual(
      expect.objectContaining({ id: TICKET, current_session_id: 'session-existing' })
    )
  })

  it('a deleted command leaves the ticket alone: "Command not found", no session', async () => {
    await expect(
      runProjectShellCommand({ projectId: PROJECT, commandId: 'cmd-gone', ticketId: TICKET })
    ).resolves.toEqual({ success: false, error: 'Command not found' })
    expect(calls).toEqual([])
    expect(kanbanState.tickets.get(PROJECT)).toContainEqual(
      expect.objectContaining({ id: TICKET, column: 'todo', current_session_id: null })
    )
  })

  it('closes the new session and runs nothing when the ticket cannot be updated', async () => {
    kanbanState.updateTicket.mockRejectedValueOnce(new Error('schema rejected'))

    const result = await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      ticketId: TICKET
    })

    expect(result).toEqual({ success: false, error: 'Could not update the ticket' })
    expect(sessionState.closeSession).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(runShellCommand).not.toHaveBeenCalled()
    expect(statusState.setSessionStatus).not.toHaveBeenCalled()
    expect(messageSendTimes.has('session-1')).toBe(false)
    expect(autoPinForBoardPrompt).not.toHaveBeenCalled()
    expect(kanbanState.createTicket).not.toHaveBeenCalled()
    expect(sessionState.setActiveSession).not.toHaveBeenCalled()
    expect(calls).toEqual(['createShellCommandSession', 'closeSession'])
  })

  it('creates no session-less orphan: a session that cannot be created leaves the ticket alone', async () => {
    sessionState.createShellCommandSession.mockResolvedValueOnce({
      success: false,
      error: 'db is locked'
    })

    await expect(
      runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, ticketId: TICKET })
    ).resolves.toEqual({ success: false, error: 'db is locked' })
    expect(kanbanState.updateTicket).not.toHaveBeenCalled()
    expect(sessionState.closeSession).not.toHaveBeenCalled()
    expect(runShellCommand).not.toHaveBeenCalled()
  })

  it('a start failure keeps the link and returns the ticket id with the error', async () => {
    runShellCommand.mockResolvedValue({
      success: true,
      value: { success: false, error: 'Worktree is teleported' }
    })

    const result = await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      ticketId: TICKET,
      focus: false
    })

    expect(result).toEqual({
      success: false,
      error: 'Worktree is teleported',
      sessionId: 'session-1',
      ticketId: TICKET,
      worktreeId: BASE
    })
    expect(markShellCommandStartFailed).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      'Worktree is teleported'
    )
    expect(sessionState.closeSession).not.toHaveBeenCalled()
  })

  it('a second launch for the ticket once it is linked is refused', async () => {
    await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, ticketId: TICKET })

    await expect(
      runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, ticketId: TICKET })
    ).resolves.toEqual({ success: false, error: 'Ticket already has a session' })
    expect(sessionState.createShellCommandSession).toHaveBeenCalledTimes(1)
    expect(runShellCommand).toHaveBeenCalledTimes(1)
  })
})

describe('runProjectShellCommand — status and start', () => {
  it('stamps the send times and mode before flipping the status to working', async () => {
    await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(statusState.setSessionStatus).toHaveBeenCalledExactlyOnceWith('session-1', 'working')
    expect(stampsAtStatus?.messageSendTime).toEqual(expect.any(Number))
    expect(stampsAtStatus?.explicitSendTime).toEqual(expect.any(Number))
    expect(stampsAtStatus?.mode).toBe('build')
  })

  it('orders the steps: session, ticket, status, start', async () => {
    await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, focus: false })

    expect(calls).toEqual([
      'createShellCommandSession',
      'createTicket',
      'setSessionStatus:working',
      'runShellCommand'
    ])
  })

  it('calls runShellCommand with the session id only (no command text)', async () => {
    await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(runShellCommand).toHaveBeenCalledExactlyOnceWith('session-1')
  })

  it('a failed run result marks the start failure and returns the error with the ids', async () => {
    runShellCommand.mockResolvedValue({
      success: true,
      value: { success: false, error: 'Worktree is teleported' }
    })

    const result = await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(markShellCommandStartFailed).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      'Worktree is teleported'
    )
    expect(result).toEqual({
      success: false,
      error: 'Worktree is teleported',
      sessionId: 'session-1',
      ticketId: 'ticket-1',
      worktreeId: BASE
    })
  })

  it('a non-success envelope marks the start failure', async () => {
    runShellCommand.mockResolvedValue({
      success: false,
      errorCode: 'RpcError',
      error: 'Desktop command transport is not available'
    })

    const result = await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(markShellCommandStartFailed).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      'Desktop command transport is not available'
    )
    expect(result).toMatchObject({
      success: false,
      error: 'Desktop command transport is not available',
      sessionId: 'session-1'
    })
  })

  it('a thrown RPC error marks the start failure and is returned, not thrown', async () => {
    runShellCommand.mockRejectedValue(new Error('socket closed'))

    const result = await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(markShellCommandStartFailed).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      'socket closed'
    )
    expect(result).toEqual({
      success: false,
      error: 'socket closed',
      sessionId: 'session-1',
      ticketId: 'ticket-1',
      worktreeId: BASE
    })
  })

  it('still navigates to the session after a start failure', async () => {
    runShellCommand.mockRejectedValue(new Error('socket closed'))

    await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(sessionState.setActiveSession).toHaveBeenCalledExactlyOnceWith('session-1')
  })
})

describe('runProjectShellCommand — navigation', () => {
  it('navigates in the load-bearing order, setActiveWorktree before setActiveSession', async () => {
    kanbanState.isBoardViewActive = true
    projectState.expandedProjectIds = new Set()

    await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id, worktreeId: FEATURE })

    expect(calls.slice(calls.indexOf('runShellCommand') + 1)).toEqual([
      'closeBoardView',
      'selectWorktree',
      'selectProject',
      'toggleProjectExpanded',
      'setActiveWorktree',
      'setActiveSession'
    ])
    expect(worktreeState.selectWorktree).toHaveBeenCalledExactlyOnceWith(FEATURE)
    expect(projectState.selectProject).toHaveBeenCalledExactlyOnceWith(PROJECT)
    expect(sessionState.setActiveWorktree).toHaveBeenCalledExactlyOnceWith(FEATURE)
    expect(sessionState.setActiveSession).toHaveBeenCalledExactlyOnceWith('session-1')
  })

  it('leaves the board view and an expanded project alone', async () => {
    await runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })

    expect(kanbanState.toggleBoardView).not.toHaveBeenCalled()
    expect(projectState.toggleProjectExpanded).not.toHaveBeenCalled()
  })

  it('does not navigate when focus is false', async () => {
    kanbanState.isBoardViewActive = true

    const result = await runProjectShellCommand({
      projectId: PROJECT,
      commandId: COMMAND.id,
      focus: false
    })

    expect(result.success).toBe(true)
    expect(kanbanState.toggleBoardView).not.toHaveBeenCalled()
    expect(worktreeState.selectWorktree).not.toHaveBeenCalled()
    expect(projectState.selectProject).not.toHaveBeenCalled()
    expect(sessionState.setActiveWorktree).not.toHaveBeenCalled()
    expect(sessionState.setActiveSession).not.toHaveBeenCalled()
  })
})

describe('runProjectShellCommand — concurrency', () => {
  it('two launches of the same command create two sessions and two tickets', async () => {
    const [first, second] = await Promise.all([
      runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id }),
      runProjectShellCommand({ projectId: PROJECT, commandId: COMMAND.id })
    ])

    expect(first.success && second.success).toBe(true)
    expect(new Set([first.sessionId, second.sessionId]).size).toBe(2)
    expect(new Set([first.ticketId, second.ticketId]).size).toBe(2)
    expect(sessionState.createShellCommandSession).toHaveBeenCalledTimes(2)
    expect(kanbanState.createTicket).toHaveBeenCalledTimes(2)
    expect(runShellCommand).toHaveBeenCalledTimes(2)
    expect(kanbanState.tickets.get(PROJECT)).toHaveLength(2)
  })
})

describe('rerunShellCommand', () => {
  const SESSION = 'session-existing'

  beforeEach(() => {
    sessionState.sessions.set(SESSION, { id: SESSION, project_id: PROJECT, worktree_id: FEATURE })
    runStoreState.runsBySession[SESSION] = runSnapshot({ state: 'failed', exitCode: 3 })
    getBySession.mockResolvedValue([{ id: 'ticket-linked', archived_at: null }])
  })

  it('rejects on Windows', async () => {
    platform.windows = true

    await expect(rerunShellCommand(SESSION)).resolves.toEqual({
      success: false,
      error: 'Shell commands are not supported on Windows'
    })
    expect(runShellCommand).not.toHaveBeenCalled()
  })

  it('rejects while the command is running, changing nothing', async () => {
    runStoreState.runsBySession[SESSION] = runSnapshot({ state: 'running', runId: 'run-1' })

    await expect(rerunShellCommand(SESSION)).resolves.toEqual({
      success: false,
      error: 'Command is already running'
    })
    expect(calls).toEqual([])
    expect(runShellCommand).not.toHaveBeenCalled()
  })

  it('rejects a session that is not a shell command', async () => {
    delete runStoreState.runsBySession[SESSION]
    sessionGet.mockResolvedValue({ id: SESSION, shell_command: null })

    await expect(rerunShellCommand(SESSION)).resolves.toEqual({
      success: false,
      error: 'Session is not a shell command'
    })
    expect(sessionGet).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(runShellCommand).not.toHaveBeenCalled()
  })

  it('falls back to the database snapshot when the run is not indexed', async () => {
    delete runStoreState.runsBySession[SESSION]
    const stored = runSnapshot({ state: 'succeeded', exitCode: 0 })
    sessionGet.mockResolvedValue({
      id: SESSION,
      shell_command: serializeSessionShellCommand(stored)
    })

    await expect(rerunShellCommand(SESSION)).resolves.toEqual({ success: true })
    expect(runStoreState.setRun).toHaveBeenCalledExactlyOnceWith(SESSION, stored)
    expect(runShellCommand).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it('reactivates, clears the error mark, re-stamps, sets working, then starts the run', async () => {
    await expect(rerunShellCommand(SESSION)).resolves.toEqual({ success: true })

    expect(calls).toEqual([
      'reactivateSession',
      'clearSessionApiError',
      'setSessionStatus:working',
      'runShellCommand'
    ])
    expect(sessionState.reactivateSession).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(statusState.clearSessionApiError).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(statusState.setSessionStatus).toHaveBeenCalledExactlyOnceWith(SESSION, 'working')
    expect(stampsAtStatus?.messageSendTime).toEqual(expect.any(Number))
    expect(stampsAtStatus?.explicitSendTime).toEqual(expect.any(Number))
    expect(stampsAtStatus?.mode).toBe('build')
    expect(runShellCommand).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it('reuses the session and its linked ticket: no new session, ticket or navigation', async () => {
    await rerunShellCommand(SESSION)

    expect(sessionState.createShellCommandSession).not.toHaveBeenCalled()
    expect(getBySession).toHaveBeenCalledExactlyOnceWith(SESSION)
    expect(kanbanState.createTicket).not.toHaveBeenCalled()
    expect(autoPinForBoardPrompt).not.toHaveBeenCalled()
    expect(sessionState.setActiveSession).not.toHaveBeenCalled()
    expect(worktreeState.selectWorktree).not.toHaveBeenCalled()
  })

  it('creates a ticket (and pins) when none is linked and the settings want one', async () => {
    getBySession.mockResolvedValue([{ id: 'ticket-old', archived_at: '2026-01-02T00:00:00.000Z' }])

    await rerunShellCommand(SESSION)

    expect(kanbanState.createTicket).toHaveBeenCalledExactlyOnceWith(PROJECT, {
      project_id: PROJECT,
      title: 'Install app',
      description: 'pnpm install\npnpm build',
      column: 'in_progress',
      sort_order: 7,
      current_session_id: SESSION,
      worktree_id: FEATURE,
      mode: 'build',
      external_provider: 'shell-command',
      external_id: COMMAND.id,
      created_from_session: true
    })
    expect(autoPinForBoardPrompt).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT,
      worktreeId: FEATURE
    })
  })

  it("stamps a rerun-created ticket with the run's own command id, not the project's", async () => {
    getBySession.mockResolvedValue([])
    // The run outlives the project definition it was launched from.
    runStoreState.runsBySession[SESSION] = runSnapshot({
      commandId: 'cmd-removed-from-project',
      state: 'succeeded',
      exitCode: 0
    })

    await expect(rerunShellCommand(SESSION)).resolves.toEqual({ success: true })

    expect(kanbanState.createTicket).toHaveBeenCalledExactlyOnceWith(
      PROJECT,
      expect.objectContaining({
        external_provider: 'shell-command',
        external_id: 'cmd-removed-from-project',
        current_session_id: SESSION
      })
    )
  })

  it('creates no ticket when the settings do not want one', async () => {
    settingsState.automaticallyCreateTicket = false
    getBySession.mockResolvedValue([])

    await rerunShellCommand(SESSION)

    expect(getBySession).not.toHaveBeenCalled()
    expect(kanbanState.createTicket).not.toHaveBeenCalled()
  })

  it('a closed session revived by reactivateSession still gets its ticket', async () => {
    getBySession.mockResolvedValue([])
    const revived = sessionState.sessions.get(SESSION)!
    sessionState.sessions.delete(SESSION)
    sessionState.reactivateSession.mockImplementationOnce(async () => {
      calls.push('reactivateSession')
      sessionState.sessions.set(SESSION, revived)
    })

    await expect(rerunShellCommand(SESSION)).resolves.toEqual({ success: true })

    expect(kanbanState.createTicket).toHaveBeenCalledExactlyOnceWith(
      PROJECT,
      expect.objectContaining({ current_session_id: SESSION, worktree_id: FEATURE })
    )
  })

  it('reads the session from the database when it is not in the store', async () => {
    getBySession.mockResolvedValue([])
    sessionState.sessions.delete(SESSION)
    sessionGet.mockResolvedValue({ id: SESSION, project_id: PROJECT, worktree_id: BASE })

    await expect(rerunShellCommand(SESSION)).resolves.toEqual({ success: true })

    expect(kanbanState.createTicket).toHaveBeenCalledExactlyOnceWith(
      PROJECT,
      expect.objectContaining({ current_session_id: SESSION, worktree_id: BASE })
    )
  })

  it('a failed ticket lookup creates no ticket and still starts the run', async () => {
    getBySession.mockRejectedValue(new Error('rpc down'))

    await expect(rerunShellCommand(SESSION)).resolves.toEqual({ success: true })

    expect(kanbanState.createTicket).not.toHaveBeenCalled()
    expect(runShellCommand).toHaveBeenCalledExactlyOnceWith(SESSION)
  })

  it('alreadyRunning returns the error without marking a start failure', async () => {
    runShellCommand.mockResolvedValue({
      success: true,
      value: { success: false, alreadyRunning: true, error: 'Command is already running' }
    })

    await expect(rerunShellCommand(SESSION)).resolves.toEqual({
      success: false,
      error: 'Command is already running'
    })
    expect(markShellCommandStartFailed).not.toHaveBeenCalled()
  })

  it('other start failures are marked and returned', async () => {
    runShellCommand.mockResolvedValue({
      success: true,
      value: { success: false, error: 'Worktree not found' }
    })

    await expect(rerunShellCommand(SESSION)).resolves.toEqual({
      success: false,
      error: 'Worktree not found'
    })
    expect(markShellCommandStartFailed).toHaveBeenCalledExactlyOnceWith(
      SESSION,
      'Worktree not found'
    )
  })

  it('a thrown RPC error is marked and returned, not thrown', async () => {
    runShellCommand.mockRejectedValue(new Error('socket closed'))

    await expect(rerunShellCommand(SESSION)).resolves.toEqual({
      success: false,
      error: 'socket closed'
    })
    expect(markShellCommandStartFailed).toHaveBeenCalledExactlyOnceWith(SESSION, 'socket closed')
  })

  it('never throws when reactivating the session fails', async () => {
    sessionState.reactivateSession.mockRejectedValueOnce(new Error('session row is gone'))

    await expect(rerunShellCommand(SESSION)).resolves.toEqual({
      success: false,
      error: 'session row is gone'
    })
    expect(runShellCommand).not.toHaveBeenCalled()
  })
})
