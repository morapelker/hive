import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket, KanbanTicketColumn } from '../../../main/db/types'

// Mock the kanban RPC API so moveTicket/updateTicket don't hit a real client.
vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      move: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(null),
      reorder: vi.fn().mockResolvedValue(undefined),
      addTokens: vi.fn().mockResolvedValue(null),
      getBySession: vi.fn().mockResolvedValue([])
    }
  }
}))

// moveTicket dynamically imports useSettingsStore for the follow-up trigger.
vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ followUpTriggerColumn: 'done' }) }
}))

import {
  applyShellCommandRunStatus,
  markRunningShellCommandsWorking,
  markShellCommandStartFailed,
  reconcileShellCommandTickets
} from './shell-command-status'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { lastSendMode, messageSendTimes, userExplicitSendTimes } from '@/lib/message-send-times'
import type { ShellCommandStatusPayload } from '@shared/shell-command-events'
import {
  createSessionShellCommandSnapshot,
  serializeSessionShellCommand,
  type SessionShellCommand
} from '@shared/lib/shell-commands'

const SESSION_ID = 'sess-shell-1'
const PROJECT_ID = 'proj-1'
const STARTED_AT = '2026-01-01T00:00:00.000Z'
const INTERRUPTED_TEXT = 'Command interrupted (the app quit while it was running)'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'Install app',
    description: 'pnpm install',
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: SESSION_ID,
    worktree_id: 'wt-1',
    mode: 'build',
    plan_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    column_changed_at: null,
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    note: null,
    created_from_session: true,
    auto_approve_plan: false,
    unread: false,
    awaiting_completion: false,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ticket_prefix: null,
    ticket_number: null,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  } as KanbanTicket
}

function run(overrides: Partial<SessionShellCommand> = {}): SessionShellCommand {
  return {
    ...createSessionShellCommandSnapshot({ id: 'cmd-1', name: 'Install app', commands: 'make' }),
    ...overrides
  }
}

function payload(overrides: Partial<ShellCommandStatusPayload> = {}): ShellCommandStatusPayload {
  return {
    sessionId: SESSION_ID,
    runId: 'run-1',
    state: 'running',
    exitCode: null,
    signal: null,
    detached: false,
    reason: null,
    error: null,
    startedAt: STARTED_AT,
    finishedAt: null,
    ...overrides
  }
}

function seedTickets(...tickets: KanbanTicket[]): void {
  useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, tickets]]) })
}

function columnOf(ticketId = 'ticket-1'): KanbanTicketColumn | undefined {
  return useKanbanStore
    .getState()
    .tickets.get(PROJECT_ID)
    ?.find((t) => t.id === ticketId)?.column
}

const statusEntry = (sessionId = SESSION_ID) =>
  useWorktreeStatusStore.getState().sessionStatuses[sessionId] ?? null
const apiError = (sessionId = SESSION_ID): string | undefined =>
  useWorktreeStatusStore.getState().sessionApiErrors[sessionId]

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Serve `rows` from the run-list RPC; returns the request mock. */
function serveRuns(rows: Record<string, SessionShellCommand>): ReturnType<typeof vi.fn> {
  const request = vi.fn().mockResolvedValue(
    Object.entries(rows).map(([sessionId, value]) => ({
      sessionId,
      projectId: PROJECT_ID,
      worktreeId: 'wt-1',
      shellCommand: serializeSessionShellCommand(value)
    }))
  )
  setRendererRpcClient({ request, subscribe: vi.fn() })
  return request
}

const initialRunStoreState = useShellCommandRunStore.getState()

function resetState(): void {
  useKanbanStore.setState({ tickets: new Map() })
  useWorktreeStatusStore.setState({ sessionStatuses: {}, sessionApiErrors: {} })
  useShellCommandRunStore.setState({ ...initialRunStoreState, runsBySession: {}, loaded: false })
  messageSendTimes.clear()
  userExplicitSendTimes.clear()
  lastSendMode.clear()
}

beforeEach(() => {
  vi.clearAllMocks()
  resetState()
  serveRuns({})
})

afterEach(() => {
  resetState()
  resetRendererRpcClientForTests()
})

describe('applyShellCommandRunStatus — status mapping', () => {
  beforeEach(() => {
    useShellCommandRunStore.getState().setRun(SESSION_ID, run())
  })

  it('merges the payload into the run store', () => {
    applyShellCommandRunStatus(
      payload({ state: 'failed', exitCode: 3, finishedAt: '2026-01-01T00:00:09.000Z' })
    )

    expect(useShellCommandRunStore.getState().runsBySession[SESSION_ID]).toMatchObject({
      commandId: 'cmd-1',
      script: 'make',
      state: 'failed',
      runId: 'run-1',
      exitCode: 3,
      startedAt: STARTED_AT,
      finishedAt: '2026-01-01T00:00:09.000Z'
    })
  })

  it('running sets working once and is idempotent', () => {
    applyShellCommandRunStatus(payload())
    const first = statusEntry()
    expect(first?.status).toBe('working')
    expect(lastSendMode.get(SESSION_ID)).toBe('build')

    applyShellCommandRunStatus(payload())
    // Same entry object: setSessionStatus was not called a second time.
    expect(statusEntry()).toBe(first)
  })

  it('running stamps the timer maps from startedAt only when they have no entry', () => {
    applyShellCommandRunStatus(payload())
    expect(messageSendTimes.get(SESSION_ID)).toBe(Date.parse(STARTED_AT))
    expect(userExplicitSendTimes.get(SESSION_ID)).toBe(Date.parse(STARTED_AT))

    messageSendTimes.set(SESSION_ID, 42)
    userExplicitSendTimes.set(SESSION_ID, 43)
    useWorktreeStatusStore.setState({ sessionStatuses: {} })
    applyShellCommandRunStatus(payload({ startedAt: '2026-02-02T00:00:00.000Z' }))
    expect(messageSendTimes.get(SESSION_ID)).toBe(42)
    expect(userExplicitSendTimes.get(SESSION_ID)).toBe(43)
  })

  it('running with an unparsable startedAt leaves the timer maps alone', () => {
    applyShellCommandRunStatus(payload({ startedAt: 'not a date' }))
    applyShellCommandRunStatus(payload({ startedAt: null }))

    expect(statusEntry()?.status).toBe('working')
    expect(messageSendTimes.has(SESSION_ID)).toBe(false)
    expect(userExplicitSendTimes.has(SESSION_ID)).toBe(false)
  })

  it('a restored running run is not an explicit send: a done ticket stays done', async () => {
    seedTickets(makeTicket({ column: 'done' }))

    // startedAt "now": were the stamp written before the status flip, the fresh
    // explicit-send time would reopen the ticket.
    applyShellCommandRunStatus(payload({ startedAt: new Date().toISOString() }))
    await flush()

    expect(statusEntry()?.status).toBe('working')
    expect(columnOf()).toBe('done')
  })

  it("running clears the previous run's error mark (a rerun started elsewhere)", () => {
    useWorktreeStatusStore.getState().setSessionApiError(SESSION_ID, 'Command failed (exit 2)')

    applyShellCommandRunStatus(payload())

    expect(statusEntry()?.status).toBe('working')
    expect(apiError()).toBeUndefined()
  })

  it('succeeded completes without an apiError and clears a previous error', () => {
    useWorktreeStatusStore.getState().setSessionApiError(SESSION_ID, 'Command failed (exit 1)')

    applyShellCommandRunStatus(payload({ state: 'succeeded', exitCode: 0 }))

    expect(statusEntry()?.status).toBe('completed')
    expect(statusEntry()?.apiError).toBeUndefined()
    expect(apiError()).toBeUndefined()
    expect(lastSendMode.get(SESSION_ID)).toBe('build')
  })

  it('failed with exit 3 sets the error mark, then completes with the same apiError', () => {
    const order: string[] = []
    const unsubscribe = useWorktreeStatusStore.subscribe((state, previous) => {
      if (state.sessionApiErrors !== previous.sessionApiErrors) order.push('apiError')
      if (state.sessionStatuses !== previous.sessionStatuses) order.push('status')
    })

    applyShellCommandRunStatus(payload({ state: 'failed', exitCode: 3 }))
    unsubscribe()

    expect(order).toEqual(['apiError', 'status'])
    expect(apiError()).toBe('Command failed (exit 3)')
    expect(statusEntry()).toMatchObject({
      status: 'completed',
      apiError: 'Command failed (exit 3)'
    })
  })

  it('interrupted sets the interruption text as the error mark', () => {
    applyShellCommandRunStatus(payload({ state: 'interrupted' }))

    expect(apiError()).toBe(INTERRUPTED_TEXT)
    expect(statusEntry()).toMatchObject({ status: 'completed', apiError: INTERRUPTED_TEXT })
  })

  it('uses the output-limit and start-failed texts', () => {
    applyShellCommandRunStatus(payload({ state: 'failed', reason: 'output-limit', exitCode: 1 }))
    expect(apiError()).toBe('Command stopped: output limit reached')

    applyShellCommandRunStatus(
      payload({
        state: 'failed',
        reason: 'start-failed',
        error: 'worktree is missing',
        runId: null
      })
    )
    expect(apiError()).toBe('Command could not start: worktree is missing')

    applyShellCommandRunStatus(payload({ state: 'failed', reason: 'start-failed', error: null }))
    expect(apiError()).toBe('Command could not start')
  })

  it('cancelled completes as a user interrupt only when the status is working', () => {
    applyShellCommandRunStatus(payload())
    applyShellCommandRunStatus(payload({ state: 'cancelled' }))

    expect(statusEntry()).toMatchObject({ status: 'completed', reason: 'user_interrupt' })
    expect(statusEntry()?.apiError).toBeUndefined()
    expect(apiError()).toBeUndefined()
  })

  it('cancelled does nothing when the status was already cleared', () => {
    applyShellCommandRunStatus(payload())
    useWorktreeStatusStore.getState().clearSessionStatus(SESSION_ID)

    applyShellCommandRunStatus(payload({ state: 'cancelled' }))

    expect(statusEntry()).toBeNull()
    // The run store still records the outcome for the status strip.
    expect(useShellCommandRunStore.getState().runsBySession[SESSION_ID].state).toBe('cancelled')
  })

  it('pending changes no status', () => {
    applyShellCommandRunStatus(payload({ state: 'pending', runId: null, startedAt: null }))

    expect(statusEntry()).toBeNull()
    expect(apiError()).toBeUndefined()
  })
})

describe('markRunningShellCommandsWorking', () => {
  it('seeds working only for runs the index says are running', () => {
    useShellCommandRunStore
      .getState()
      .setRun(SESSION_ID, run({ state: 'running', runId: 'run-1', startedAt: STARTED_AT }))
    useShellCommandRunStore.getState().setRun('done-session', run({ state: 'succeeded' }))

    markRunningShellCommandsWorking()

    expect(statusEntry()?.status).toBe('working')
    expect(messageSendTimes.get(SESSION_ID)).toBe(Date.parse(STARTED_AT))
    expect(useWorktreeStatusStore.getState().sessionStatuses['done-session']).toBeUndefined()
  })
})

describe('applyShellCommandRunStatus — unknown session', () => {
  it('loads the run index and still maps the status', async () => {
    const request = serveRuns({ [SESSION_ID]: run({ state: 'running', runId: 'run-1' }) })

    applyShellCommandRunStatus(payload())
    expect(statusEntry()?.status).toBe('working')
    await vi.waitFor(() =>
      expect(useShellCommandRunStore.getState().runsBySession[SESSION_ID]).toBeDefined()
    )

    expect(request).toHaveBeenCalledExactlyOnceWith('db.session.getShellCommandRuns', {})
  })

  it('does not reload for a known session', () => {
    const request = serveRuns({})
    useShellCommandRunStore.getState().setRun(SESSION_ID, run())

    applyShellCommandRunStatus(payload())

    expect(request).not.toHaveBeenCalled()
  })
})

describe('applyShellCommandRunStatus — linked ticket', () => {
  beforeEach(() => {
    useShellCommandRunStore.getState().setRun(SESSION_ID, run())
  })

  it('succeeded moves an in_progress ticket to review without an error mark', async () => {
    seedTickets(makeTicket())

    applyShellCommandRunStatus(payload({ state: 'succeeded', exitCode: 0 }))
    await flush()

    expect(columnOf()).toBe('review')
    expect(apiError()).toBeUndefined()
  })

  it('failed moves an in_progress ticket to review with the error mark', async () => {
    seedTickets(makeTicket())

    applyShellCommandRunStatus(payload({ state: 'failed', exitCode: 3 }))
    await flush()

    expect(columnOf()).toBe('review')
    expect(apiError()).toBe('Command failed (exit 3)')
  })

  it('cancelled moves an in_progress ticket to review without an error mark', async () => {
    seedTickets(makeTicket())
    applyShellCommandRunStatus(payload())
    await flush()
    expect(columnOf()).toBe('in_progress')

    applyShellCommandRunStatus(payload({ state: 'cancelled' }))
    await flush()

    expect(columnOf()).toBe('review')
    expect(apiError()).toBeUndefined()
  })

  it('running moves a review ticket back to in_progress', async () => {
    seedTickets(makeTicket({ column: 'review' }))

    applyShellCommandRunStatus(payload())
    await flush()

    expect(columnOf()).toBe('in_progress')
  })
})

describe('markShellCommandStartFailed', () => {
  it('records the failure on the run and marks the session errored', async () => {
    useShellCommandRunStore.getState().setRun(SESSION_ID, run())
    seedTickets(makeTicket())

    markShellCommandStartFailed(SESSION_ID, 'Desktop command transport is not available')
    await flush()

    const stored = useShellCommandRunStore.getState().runsBySession[SESSION_ID]
    expect(stored).toMatchObject({
      state: 'failed',
      reason: 'start-failed',
      error: 'Desktop command transport is not available'
    })
    expect(stored.finishedAt).toEqual(expect.any(String))
    const text = 'Command could not start: Desktop command transport is not available'
    expect(apiError()).toBe(text)
    expect(statusEntry()).toMatchObject({ status: 'completed', apiError: text })
    expect(columnOf()).toBe('review')
  })

  it('produces the same mark as the status event main publishes', () => {
    useShellCommandRunStore.getState().setRun(SESSION_ID, run())

    markShellCommandStartFailed(SESSION_ID, 'boom')
    const local = apiError()
    applyShellCommandRunStatus(
      payload({ state: 'failed', reason: 'start-failed', error: 'boom', runId: null })
    )

    expect(apiError()).toBe(local)
  })

  it('still marks the session when the run is not indexed', () => {
    markShellCommandStartFailed(SESSION_ID, 'boom')

    expect(apiError()).toBe('Command could not start: boom')
    expect(useShellCommandRunStore.getState().runsBySession[SESSION_ID]).toBeUndefined()
  })
})

describe('reconcileShellCommandTickets', () => {
  it('running: marks the session working and stamps the timer maps', async () => {
    serveRuns({ [SESSION_ID]: run({ state: 'running', runId: 'run-1', startedAt: STARTED_AT }) })
    seedTickets(makeTicket({ column: 'review' }))

    await reconcileShellCommandTickets(PROJECT_ID)
    await flush()

    expect(statusEntry()?.status).toBe('working')
    expect(lastSendMode.get(SESSION_ID)).toBe('build')
    expect(messageSendTimes.get(SESSION_ID)).toBe(Date.parse(STARTED_AT))
    expect(columnOf()).toBe('in_progress')
  })

  it('running: leaves an already-working session alone', async () => {
    serveRuns({ [SESSION_ID]: run({ state: 'running', runId: 'run-1' }) })
    seedTickets(makeTicket())
    useWorktreeStatusStore.getState().setSessionStatus(SESSION_ID, 'working')
    const before = statusEntry()

    await reconcileShellCommandTickets(PROJECT_ID)

    expect(statusEntry()).toBe(before)
  })

  it('succeeded: an in_progress ticket moves to review without an error mark', async () => {
    serveRuns({ [SESSION_ID]: run({ state: 'succeeded', exitCode: 0 }) })
    seedTickets(makeTicket())

    await reconcileShellCommandTickets(PROJECT_ID)
    await flush()

    expect(columnOf()).toBe('review')
    expect(statusEntry()?.status).toBe('completed')
    expect(apiError()).toBeUndefined()
  })

  it('succeeded: a ticket outside in_progress is untouched', async () => {
    serveRuns({ [SESSION_ID]: run({ state: 'succeeded', exitCode: 0 }) })
    seedTickets(makeTicket({ column: 'done' }))

    await reconcileShellCommandTickets(PROJECT_ID)
    await flush()

    expect(columnOf()).toBe('done')
    expect(statusEntry()).toBeNull()
  })

  it('failed: an in_progress ticket moves to review with the error mark', async () => {
    serveRuns({ [SESSION_ID]: run({ state: 'failed', exitCode: 2 }) })
    seedTickets(makeTicket())

    await reconcileShellCommandTickets(PROJECT_ID)
    await flush()

    expect(columnOf()).toBe('review')
    expect(apiError()).toBe('Command failed (exit 2)')
    expect(statusEntry()).toMatchObject({
      status: 'completed',
      apiError: 'Command failed (exit 2)'
    })
  })

  it('interrupted: an in_progress ticket moves to review with the interruption mark', async () => {
    serveRuns({ [SESSION_ID]: run({ state: 'interrupted' }) })
    seedTickets(makeTicket())

    await reconcileShellCommandTickets(PROJECT_ID)
    await flush()

    expect(columnOf()).toBe('review')
    expect(apiError()).toBe(INTERRUPTED_TEXT)
  })

  it('failed: a ticket already in review only gets its error mark back', async () => {
    serveRuns({ [SESSION_ID]: run({ state: 'failed', exitCode: 2 }) })
    seedTickets(makeTicket({ column: 'review' }))

    await reconcileShellCommandTickets(PROJECT_ID)
    await flush()

    expect(apiError()).toBe('Command failed (exit 2)')
    expect(statusEntry()).toBeNull()
    expect(columnOf()).toBe('review')
  })

  it('failed: a done ticket gets neither a mark nor a status', async () => {
    serveRuns({ [SESSION_ID]: run({ state: 'failed', exitCode: 2 }) })
    seedTickets(makeTicket({ column: 'done' }))

    await reconcileShellCommandTickets(PROJECT_ID)
    await flush()

    expect(apiError()).toBeUndefined()
    expect(statusEntry()).toBeNull()
    expect(columnOf()).toBe('done')
  })

  it('cancelled: an in_progress ticket moves to review without an error mark', async () => {
    serveRuns({ [SESSION_ID]: run({ state: 'cancelled' }) })
    seedTickets(makeTicket())

    await reconcileShellCommandTickets(PROJECT_ID)
    await flush()

    expect(columnOf()).toBe('review')
    expect(statusEntry()).toMatchObject({ status: 'completed', reason: 'user_interrupt' })
    expect(apiError()).toBeUndefined()
  })

  it('leaves pending runs, unknown sessions, unlinked and archived tickets untouched', async () => {
    serveRuns({
      'sess-pending': run({ state: 'pending' }),
      'sess-archived': run({ state: 'failed', exitCode: 1 })
    })
    seedTickets(
      makeTicket({ id: 'ticket-pending', current_session_id: 'sess-pending' }),
      makeTicket({ id: 'ticket-agent', current_session_id: 'sess-claude' }),
      makeTicket({ id: 'ticket-unlinked', current_session_id: null }),
      makeTicket({
        id: 'ticket-archived',
        current_session_id: 'sess-archived',
        archived_at: '2026-01-02T00:00:00.000Z'
      })
    )

    await reconcileShellCommandTickets(PROJECT_ID)
    await flush()

    expect(useWorktreeStatusStore.getState().sessionStatuses).toEqual({})
    expect(useWorktreeStatusStore.getState().sessionApiErrors).toEqual({})
    for (const id of ['ticket-pending', 'ticket-agent', 'ticket-unlinked', 'ticket-archived']) {
      expect(columnOf(id)).toBe('in_progress')
    }
  })

  it('does nothing for a project without loaded tickets', async () => {
    serveRuns({ [SESSION_ID]: run({ state: 'failed', exitCode: 2 }) })

    await expect(reconcileShellCommandTickets('other-project')).resolves.toBeUndefined()
    expect(useWorktreeStatusStore.getState().sessionStatuses).toEqual({})
  })

  it('never rejects when loadAll fails', async () => {
    useShellCommandRunStore.setState({ loadAll: () => Promise.reject(new Error('rpc down')) })
    seedTickets(makeTicket())

    await expect(reconcileShellCommandTickets(PROJECT_ID)).resolves.toBeUndefined()
    expect(columnOf()).toBe('in_progress')
  })

  it('runs at the end of reconcileFinishedSessions (every board load)', async () => {
    serveRuns({ [SESSION_ID]: run({ state: 'failed', exitCode: 7 }) })
    seedTickets(makeTicket())

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)

    await vi.waitFor(() => expect(columnOf()).toBe('review'))
    expect(apiError()).toBe('Command failed (exit 7)')
  })
})
