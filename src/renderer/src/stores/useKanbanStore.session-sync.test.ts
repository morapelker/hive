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
vi.mock('./useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ followUpTriggerColumn: 'done' }) }
}))

import { useKanbanStore } from './useKanbanStore'
import { markNextWorkingStatusExplicit, useWorktreeStatusStore } from './useWorktreeStatusStore'
import { kanbanApi } from '@/api/kanban-api'
import { userExplicitSendTimes } from '@/lib/message-send-times'
import type { SessionStatusType } from '@shared/types/session-status'

const SESSION_ID = 'sess-1'
const PROJECT_ID = 'proj-1'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'A ticket',
    description: null,
    attachments: [],
    column: 'done',
    sort_order: 0,
    current_session_id: SESSION_ID,
    worktree_id: null,
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
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ...overrides
  }
}

function seed(ticket: KanbanTicket): void {
  useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [ticket]]]) })
}

function columnOf(ticketId: string): KanbanTicketColumn | undefined {
  return useKanbanStore
    .getState()
    .tickets.get(PROJECT_ID)
    ?.find((t) => t.id === ticketId)?.column
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function setSessionStatus(sessionId: string, status: SessionStatusType | null): void {
  useWorktreeStatusStore.setState({
    sessionStatuses: status ? { [sessionId]: { status, timestamp: 0 } } : {}
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useKanbanStore.setState({ tickets: new Map() })
  useWorktreeStatusStore.setState({ sessionStatuses: {} })
})

afterEach(() => {
  useKanbanStore.setState({ tickets: new Map() })
  useWorktreeStatusStore.setState({ sessionStatuses: {} })
})

describe('syncTicketWithSession — done is terminal', () => {
  it('does not move a done build ticket to review on session_completed', async () => {
    seed(makeTicket({ column: 'done', mode: 'build' }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'build'
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not move a done plan ticket to review on session_completed', async () => {
    seed(makeTicket({ column: 'done', mode: 'plan', plan_ready: false }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'plan'
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not move a done plan ticket to review on plan_ready', async () => {
    seed(makeTicket({ column: 'done', mode: 'plan', plan_ready: false }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'plan_ready' })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not move a done ticket to in_progress on plan_followup', async () => {
    seed(makeTicket({ column: 'done', mode: 'plan', plan_ready: true }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'plan_followup' })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })
})

describe('syncTicketWithSession — non-done paths unchanged', () => {
  it('still advances an in_progress build ticket to review on session_completed', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'build' }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'build'
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('review')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
  })

  it('still returns a review ticket to in_progress on session_working', async () => {
    seed(makeTicket({ column: 'review', mode: 'build', plan_ready: false }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_working' })
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'in_progress', 0)
  })
})

describe('syncTicketWithSession — finish moves to review regardless of mode/plan state', () => {
  it('moves an in_progress ticket with mode null to review on session_completed', async () => {
    seed(makeTicket({ column: 'in_progress', mode: null }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: undefined
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('review')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
  })

  it('moves an in_progress plan ticket to review on session_completed even when plan_ready is already true', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'plan', plan_ready: true }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'plan'
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('review')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
  })

  it('moves an in_progress build ticket to review on a misrouted plan_ready event', async () => {
    // A build session's completion can be rerouted to the plan_ready event by a
    // stale lastSendMode; the move must not be gated on mode.
    seed(makeTicket({ column: 'in_progress', mode: 'build', plan_ready: false }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'plan_ready' })
    await flush()

    expect(columnOf('ticket-1')).toBe('review')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
  })
})

describe('reconcileFinishedSessions — recovers dropped finish moves on load', () => {
  it('moves an in_progress ticket to review when its session status is completed', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'build' }))
    setSessionStatus(SESSION_ID, 'completed')

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('review')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
  })

  it('moves an in_progress plan ticket to review when its session status is plan_ready', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'plan', plan_ready: false }))
    setSessionStatus(SESSION_ID, 'plan_ready')

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('review')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
  })

  it('moves an API-errored in_progress plan ticket to review without flagging plan_ready', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'plan', plan_ready: false }))
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        [SESSION_ID]: { status: 'completed', timestamp: 0, apiError: 'server_error' }
      }
    })

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('review')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
    expect(kanbanApi.ticket.update).not.toHaveBeenCalled()
  })

  it('does not move when the session has no status', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'build' }))
    setSessionStatus(SESSION_ID, null)

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not move when the session is still working', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'build' }))
    setSessionStatus(SESSION_ID, 'working')

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })
})

describe('syncTicketWithSession — implement consumes auto-approve', () => {
  it('clears auto_approve_plan alongside plan_ready and mode on implement', async () => {
    seed(
      makeTicket({ column: 'in_progress', mode: 'plan', plan_ready: true, auto_approve_plan: true })
    )

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'implement' })
    await flush()

    expect(kanbanApi.ticket.update).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', {
      plan_ready: false,
      mode: 'build',
      auto_approve_plan: false
    })
  })

  it('clears a lingering auto_approve_plan on implement even for a build ticket', async () => {
    seed(
      makeTicket({
        column: 'in_progress',
        mode: 'build',
        plan_ready: false,
        auto_approve_plan: true
      })
    )

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'implement' })
    await flush()

    expect(kanbanApi.ticket.update).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', {
      plan_ready: false,
      mode: 'build',
      auto_approve_plan: false
    })
  })
})

describe('syncTicketWithSession — explicit follow-up reopens done/merged tickets', () => {
  it('moves a done ticket to in_progress on session_working with explicitSend', async () => {
    seed(makeTicket({ column: 'done' }))

    useKanbanStore
      .getState()
      .syncTicketWithSession(SESSION_ID, { type: 'session_working', explicitSend: true })
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'in_progress', 0)
  })

  it('moves a merged ticket to in_progress on session_working with explicitSend', async () => {
    seed(makeTicket({ column: 'merged' }))

    useKanbanStore
      .getState()
      .syncTicketWithSession(SESSION_ID, { type: 'session_working', explicitSend: true })
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('does not move a done ticket on session_working without explicitSend', async () => {
    seed(makeTicket({ column: 'done' }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_working' })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not reopen an archived done ticket on an explicit send', async () => {
    seed(makeTicket({ column: 'done', archived_at: '2026-01-02T00:00:00.000Z' }))

    useKanbanStore
      .getState()
      .syncTicketWithSession(SESSION_ID, { type: 'session_working', explicitSend: true })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not move a merged ticket on session_working with explicitSend false', async () => {
    seed(makeTicket({ column: 'merged' }))

    useKanbanStore
      .getState()
      .syncTicketWithSession(SESSION_ID, { type: 'session_working', explicitSend: false })
    await flush()

    expect(columnOf('ticket-1')).toBe('merged')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })
})

describe('sessionApiErrors — error mark lifecycle', () => {
  afterEach(() => {
    useWorktreeStatusStore.setState({ sessionApiErrors: {} })
  })

  it('keeps the error through completed/unread statuses, clears on a hook-evidenced relaunch', () => {
    const store = useWorktreeStatusStore.getState()
    store.setSessionApiError(SESSION_ID, 'server_error')
    store.setSessionStatus(SESSION_ID, 'completed', { apiError: 'server_error' })
    expect(useWorktreeStatusStore.getState().sessionApiErrors[SESSION_ID]).toBe('server_error')

    store.setSessionStatus(SESSION_ID, 'unread')
    expect(useWorktreeStatusStore.getState().sessionApiErrors[SESSION_ID]).toBe('server_error')

    store.setSessionStatus(SESSION_ID, 'working', { hookEventName: 'UserPromptSubmit' })
    expect(useWorktreeStatusStore.getState().sessionApiErrors[SESSION_ID]).toBeUndefined()
  })

  it('clears on a planning relaunch detected as a plan followup', () => {
    const store = useWorktreeStatusStore.getState()
    store.setSessionApiError(SESSION_ID, 'rate_limit')
    store.setSessionStatus(SESSION_ID, 'planning', { reason: 'claude_cli_plan_followup' })
    expect(useWorktreeStatusStore.getState().sessionApiErrors[SESSION_ID]).toBeUndefined()
  })

  it('survives an optimistic pre-send working write (no hook evidence yet)', () => {
    const store = useWorktreeStatusStore.getState()
    store.setSessionApiError(SESSION_ID, 'overloaded')
    store.setSessionStatus(SESSION_ID, 'working')
    expect(useWorktreeStatusStore.getState().sessionApiErrors[SESSION_ID]).toBe('overloaded')
  })

  it('survives a failed-relaunch rollback (clearSessionStatus)', () => {
    const store = useWorktreeStatusStore.getState()
    store.setSessionApiError(SESSION_ID, 'authentication_failed')
    // Modal relaunch: optimistic working write, then the send fails and rolls back.
    store.setSessionStatus(SESSION_ID, 'working')
    store.clearSessionStatus(SESSION_ID)
    expect(useWorktreeStatusStore.getState().sessionApiErrors[SESSION_ID]).toBe(
      'authentication_failed'
    )
  })

  it('survives clearWorktreeUnread even though the completed status entry is nulled', async () => {
    const { useSessionStore } = await import('./useSessionStore')
    const sessionsByWorktree = new Map([
      ['wt-1', [{ id: SESSION_ID }]]
    ]) as unknown as ReturnType<typeof useSessionStore.getState>['sessionsByWorktree']
    useSessionStore.setState({ sessionsByWorktree })
    try {
      const store = useWorktreeStatusStore.getState()
      store.setSessionApiError(SESSION_ID, 'server_error')
      store.setSessionStatus(SESSION_ID, 'completed', { apiError: 'server_error' })

      store.clearWorktreeUnread('wt-1')

      expect(useWorktreeStatusStore.getState().sessionStatuses[SESSION_ID]).toBeNull()
      expect(useWorktreeStatusStore.getState().sessionApiErrors[SESSION_ID]).toBe('server_error')
    } finally {
      useSessionStore.setState({ sessionsByWorktree: new Map() })
    }
  })
})

describe('setSessionStatus — API-errored completions dispatch session_error', () => {
  it('moves an in_progress plan ticket to review without flagging plan_ready', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'plan', plan_ready: false }))

    useWorktreeStatusStore.getState().setSessionStatus(SESSION_ID, 'completed', {
      hookEventName: 'StopFailure',
      apiError: 'server_error'
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('review')
    const ticket = useKanbanStore
      .getState()
      .tickets.get(PROJECT_ID)
      ?.find((t) => t.id === 'ticket-1')
    expect(ticket?.plan_ready).toBe(false)
    expect(kanbanApi.ticket.update).not.toHaveBeenCalled()
  })

  it('leaves a done ticket untouched on an API-errored completion', async () => {
    seed(makeTicket({ column: 'done', mode: 'build' }))

    useWorktreeStatusStore.getState().setSessionStatus(SESSION_ID, 'completed', {
      hookEventName: 'StopFailure',
      apiError: 'rate_limit'
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })
})

describe('setSessionStatus → session_working explicitSend derivation', () => {
  beforeEach(() => {
    userExplicitSendTimes.clear()
  })

  afterEach(() => {
    userExplicitSendTimes.clear()
  })

  it('reopens a done ticket when working follows a recent explicit send', async () => {
    seed(makeTicket({ column: 'done' }))
    userExplicitSendTimes.set(SESSION_ID, Date.now())

    useWorktreeStatusStore.getState().setSessionStatus(SESSION_ID, 'working')
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('reopens a merged ticket on a UserPromptSubmit hook (terminal-typed prompt)', async () => {
    seed(makeTicket({ column: 'merged' }))

    useWorktreeStatusStore
      .getState()
      .setSessionStatus(SESSION_ID, 'working', { hookEventName: 'UserPromptSubmit' })
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('ignores a UserPromptSubmit stamped as a background task-notification', async () => {
    seed(makeTicket({ column: 'done' }))

    useWorktreeStatusStore.getState().setSessionStatus(SESSION_ID, 'working', {
      hookEventName: 'UserPromptSubmit',
      taskNotification: true
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('ignores a bare working re-emit when the last explicit send is stale', async () => {
    seed(makeTicket({ column: 'merged' }))
    userExplicitSendTimes.set(SESSION_ID, Date.now() - 60_000)

    useWorktreeStatusStore.getState().setSessionStatus(SESSION_ID, 'working')
    await flush()

    expect(columnOf('ticket-1')).toBe('merged')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('still moves a review ticket on a working re-emit without an explicit send', async () => {
    seed(makeTicket({ column: 'review' }))

    useWorktreeStatusStore.getState().setSessionStatus(SESSION_ID, 'working')
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('consumes the send stamp: a working re-emit cannot reopen a re-done ticket', async () => {
    const sessionId = 'sess-one-shot'
    seed(makeTicket({ column: 'done', current_session_id: sessionId }))
    userExplicitSendTimes.set(sessionId, Date.now())

    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
    await flush()
    expect(columnOf('ticket-1')).toBe('in_progress')

    // User drags the ticket back to done while the session is still busy…
    seed(makeTicket({ column: 'done', current_session_id: sessionId }))
    // …then a streaming re-emit arrives inside the 15s freshness window.
    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
  })

  it('reopens a done ticket on transcript-detected CLI plan feedback', async () => {
    const sessionId = 'sess-plan-watcher'
    seed(makeTicket({ column: 'done', current_session_id: sessionId, mode: 'plan' }))

    useWorktreeStatusStore
      .getState()
      .setSessionStatus(sessionId, 'planning', { reason: 'claude_cli_plan_followup' })
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('one-shot marker reopens a done ticket for a queued follow-up drain', async () => {
    const sessionId = 'sess-queued-drain'
    seed(makeTicket({ column: 'done', current_session_id: sessionId }))

    // Drain path: no userExplicitSendTimes stamp, only the one-shot marker.
    markNextWorkingStatusExplicit(sessionId)
    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
    await flush()
    expect(columnOf('ticket-1')).toBe('in_progress')

    // The marker is consumed — a replay cannot reopen a re-done ticket.
    seed(makeTicket({ column: 'done', current_session_id: sessionId }))
    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
    await flush()
    expect(columnOf('ticket-1')).toBe('done')
  })

  it('a task-notification does not consume the one-shot marker', async () => {
    const sessionId = 'sess-marker-notif'
    seed(makeTicket({ column: 'merged', current_session_id: sessionId }))

    markNextWorkingStatusExplicit(sessionId)
    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working', {
      hookEventName: 'UserPromptSubmit',
      taskNotification: true
    })
    await flush()
    expect(columnOf('ticket-1')).toBe('merged')

    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
    await flush()
    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('a task-notification neither reopens nor consumes a pending send stamp', async () => {
    const sessionId = 'sess-task-notif'
    seed(makeTicket({ column: 'done', current_session_id: sessionId }))
    userExplicitSendTimes.set(sessionId, Date.now())

    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working', {
      hookEventName: 'UserPromptSubmit',
      taskNotification: true
    })
    await flush()
    expect(columnOf('ticket-1')).toBe('done')

    // The genuine transition for the send still gets the marker afterwards.
    useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
    await flush()
    expect(columnOf('ticket-1')).toBe('in_progress')
  })
})

describe('syncTicketWithSession — implement reopens done/merged tickets', () => {
  it('moves a done plan-ready ticket to in_progress on implement', async () => {
    seed(makeTicket({ column: 'done', mode: 'plan', plan_ready: true }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'implement' })
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'in_progress', 0)
  })

  it('moves a merged plan-ready ticket to in_progress on implement', async () => {
    seed(makeTicket({ column: 'merged', mode: 'plan', plan_ready: true }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'implement' })
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('does not move a review ticket on implement (session_working handles it)', async () => {
    seed(makeTicket({ column: 'review', mode: 'plan', plan_ready: true }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'implement' })
    await flush()

    expect(columnOf('ticket-1')).toBe('review')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not reopen a done ticket on implement when auto_approve_plan is armed', async () => {
    seed(makeTicket({ column: 'done', mode: 'plan', plan_ready: true, auto_approve_plan: true }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'implement' })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })
})

describe('reconcileFinishedSessions — recovers explicit reopens missed while unloaded', () => {
  it('reopens a done ticket whose explicit send fired before tickets loaded', async () => {
    const sessionId = 'sess-unloaded-reopen'
    // Board not loaded: the explicit session_working matches nothing.
    useKanbanStore
      .getState()
      .syncTicketWithSession(sessionId, { type: 'session_working', explicitSend: true })
    await flush()

    // Tickets load afterwards; the session is still running.
    seed(makeTicket({ column: 'done', current_session_id: sessionId }))
    setSessionStatus(sessionId, 'working')
    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')

    // The recovery is one-shot: re-done ticket stays put on the next reconcile.
    seed(makeTicket({ column: 'done', current_session_id: sessionId }))
    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()
    expect(columnOf('ticket-1')).toBe('done')
  })

  it('recovers a terminal-approved implement for a project loaded later', async () => {
    const sessionId = 'sess-implement-unloaded'
    // Manual ExitPlanMode approval in the CLI terminal, board not loaded.
    useKanbanStore.getState().syncTicketWithSession(sessionId, { type: 'implement' })
    await flush()

    seed(makeTicket({ column: 'done', mode: 'plan', current_session_id: sessionId }))
    setSessionStatus(sessionId, 'working')
    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('implement recovery keeps an armed auto_approve_plan ticket terminal', async () => {
    const sessionId = 'sess-implement-armed'
    useKanbanStore.getState().syncTicketWithSession(sessionId, { type: 'implement' })
    await flush()

    seed(
      makeTicket({
        column: 'merged',
        mode: 'plan',
        auto_approve_plan: true,
        unread: false,
        current_session_id: sessionId
      })
    )
    setSessionStatus(sessionId, 'working')
    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('merged')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('a failed implement rollback clears pending recoveries', async () => {
    const sessionId = 'sess-implement-rolled-back'
    useKanbanStore.getState().syncTicketWithSession(sessionId, { type: 'implement' })
    await flush()

    // The dispatch failed: the failure path clears the session status, which
    // notifies status_cleared and drops the pending recoveries.
    useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

    seed(makeTicket({ column: 'done', mode: 'plan', current_session_id: sessionId }))
    setSessionStatus(sessionId, 'working')
    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('a finished run clears a pending implement recovery too', async () => {
    const sessionId = 'sess-implement-ended'
    useKanbanStore.getState().syncTicketWithSession(sessionId, { type: 'implement' })
    useKanbanStore.getState().syncTicketWithSession(sessionId, { type: 'session_completed' })
    await flush()

    seed(makeTicket({ column: 'done', mode: 'plan', current_session_id: sessionId }))
    setSessionStatus(sessionId, 'working')
    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('reopens when the recovered run is blocked awaiting user input', async () => {
    const sessionId = 'sess-blocked-recovery'
    useKanbanStore
      .getState()
      .syncTicketWithSession(sessionId, { type: 'session_working', explicitSend: true })
    await flush()

    seed(makeTicket({ column: 'done', current_session_id: sessionId }))
    setSessionStatus(sessionId, 'permission')
    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('does not reopen an archived ticket during reconcile recovery', async () => {
    const sessionId = 'sess-archived-reconcile'
    useKanbanStore
      .getState()
      .syncTicketWithSession(sessionId, { type: 'session_working', explicitSend: true })
    await flush()

    seed(
      makeTicket({
        column: 'merged',
        current_session_id: sessionId,
        archived_at: '2026-01-02T00:00:00.000Z'
      })
    )
    setSessionStatus(sessionId, 'working')
    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('merged')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not reopen when the session already finished by load time', async () => {
    const sessionId = 'sess-unloaded-finished'
    useKanbanStore
      .getState()
      .syncTicketWithSession(sessionId, { type: 'session_working', explicitSend: true })
    await flush()

    seed(makeTicket({ column: 'merged', current_session_id: sessionId }))
    setSessionStatus(sessionId, 'completed')
    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('merged')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('a finished run clears the pending reopen before a later auto-resume', async () => {
    const sessionId = 'sess-run-ended'
    // Explicit send with the board unloaded, then the run finishes before
    // any reconcile happened.
    useKanbanStore
      .getState()
      .syncTicketWithSession(sessionId, { type: 'session_working', explicitSend: true })
    useKanbanStore.getState().syncTicketWithSession(sessionId, { type: 'session_completed' })
    await flush()

    // A later unrelated run (background auto-resume) is working at load time —
    // the stale marker must not reopen the terminal ticket.
    seed(makeTicket({ column: 'done', current_session_id: sessionId }))
    setSessionStatus(sessionId, 'working')
    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('recovers the reopen for a second linked project loaded after the send', async () => {
    const sessionId = 'sess-multi-project'
    const otherProject = 'proj-2'
    // Project 1 is loaded and handles the send live; project 2 is not loaded.
    seed(makeTicket({ column: 'done', current_session_id: sessionId }))
    useKanbanStore
      .getState()
      .syncTicketWithSession(sessionId, { type: 'session_working', explicitSend: true })
    await flush()
    expect(columnOf('ticket-1')).toBe('in_progress')

    // Project 2's tickets load later while the session still runs.
    useKanbanStore.setState((state) => {
      const next = new Map(state.tickets)
      next.set(otherProject, [
        makeTicket({ id: 'ticket-2', project_id: otherProject, column: 'merged', current_session_id: sessionId })
      ])
      return { tickets: next }
    })
    setSessionStatus(sessionId, 'working')
    useKanbanStore.getState().reconcileFinishedSessions(otherProject)
    await flush()

    const ticket2 = useKanbanStore
      .getState()
      .tickets.get(otherProject)
      ?.find((t) => t.id === 'ticket-2')
    expect(ticket2?.column).toBe('in_progress')
  })

  it('clears the pending reopen once a loaded ticket handles the explicit send', async () => {
    const sessionId = 'sess-live-handled'
    useKanbanStore
      .getState()
      .syncTicketWithSession(sessionId, { type: 'session_working', explicitSend: true })
    await flush()

    // A later explicit send arrives with the ticket loaded — handled live.
    seed(makeTicket({ column: 'done', current_session_id: sessionId }))
    useKanbanStore
      .getState()
      .syncTicketWithSession(sessionId, { type: 'session_working', explicitSend: true })
    await flush()
    expect(columnOf('ticket-1')).toBe('in_progress')

    // The stale pending entry must not resurrect a re-done ticket on load.
    seed(makeTicket({ column: 'done', current_session_id: sessionId }))
    setSessionStatus(sessionId, 'working')
    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()
    expect(columnOf('ticket-1')).toBe('done')
  })
})
