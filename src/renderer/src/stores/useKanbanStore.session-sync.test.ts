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
import { useWorktreeStatusStore } from './useWorktreeStatusStore'
import { kanbanApi } from '@/api/kanban-api'
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
