import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'

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
import type { ClaudeCliCompletion } from '@shared/types/claude-cli-stop-completion'

const SESSION_ID = 'sess-1'
const PROJECT_ID = 'proj-1'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'A ticket',
    description: null,
    attachments: [],
    column: 'in_progress',
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
    awaiting_completion: false,
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

function getTicket(ticketId = 'ticket-1'): KanbanTicket {
  const ticket = useKanbanStore
    .getState()
    .tickets.get(PROJECT_ID)
    ?.find((t) => t.id === ticketId)
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`)
  return ticket
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function completeSession(
  completion?: ClaudeCliCompletion,
  sessionMode: 'build' | 'plan' = 'build'
): void {
  useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
    type: 'session_completed',
    sessionMode,
    ...(completion !== undefined ? { completion } : {})
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

describe('session_completed — a Claude CLI turn that ended without a detected completion', () => {
  it.each<ClaudeCliCompletion>(['waiting', 'none'])(
    'keeps the ticket in progress, flagged awaiting completion, instead of moving it to review (%s)',
    async (completion) => {
      seed(makeTicket())

      completeSession(completion)
      await flush()

      const ticket = getTicket()
      expect(ticket.column).toBe('in_progress')
      expect(ticket.awaiting_completion).toBe(true)
      expect(ticket.unread).toBe(false)
      expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
      expect(kanbanApi.ticket.update).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', {
        awaiting_completion: true
      })
      // No column change → nothing for the push notifier to announce.
    }
  )

  it('does not flag plan_ready on a paused plan ticket', async () => {
    seed(makeTicket({ mode: 'plan' }))

    completeSession('waiting', 'plan')
    await flush()

    expect(getTicket().column).toBe('in_progress')
    expect(getTicket().plan_ready).toBe(false)
    expect(getTicket().awaiting_completion).toBe(true)
    expect(kanbanApi.ticket.update).not.toHaveBeenCalledWith(
      PROJECT_ID,
      'ticket-1',
      expect.objectContaining({ plan_ready: true })
    )
  })

  it('leaves an already-flagged ticket alone on a further pause', async () => {
    seed(makeTicket({ awaiting_completion: true }))

    completeSession('waiting')
    await flush()

    expect(getTicket().column).toBe('in_progress')
    expect(getTicket().awaiting_completion).toBe(true)
    expect(kanbanApi.ticket.update).not.toHaveBeenCalled()
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('never touches a ticket outside in_progress on a pause', async () => {
    seed(makeTicket({ column: 'review', unread: true }))

    completeSession('waiting')
    await flush()

    expect(getTicket().column).toBe('review')
    expect(getTicket().awaiting_completion).toBe(false)
    expect(kanbanApi.ticket.update).not.toHaveBeenCalled()
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('still accumulates the turn tokens while paused', async () => {
    seed(makeTicket())

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'build',
      completion: 'waiting',
      tokenDelta: 42
    })
    await flush()

    expect(kanbanApi.ticket.addTokens).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 42)
  })

  it('flags the ticket through the worktree status store when the claude-cli listener reports a pause', async () => {
    seed(makeTicket())

    useWorktreeStatusStore.getState().setSessionStatus(SESSION_ID, 'completed', {
      hookEventName: 'Stop',
      completion: 'waiting',
      pendingTasks: 1,
      pendingWakeups: 0
    } as Parameters<ReturnType<typeof useWorktreeStatusStore.getState>['setSessionStatus']>[2])
    await flush()

    expect(getTicket().column).toBe('in_progress')
    expect(getTicket().awaiting_completion).toBe(true)
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })
})

describe('session_completed — a detected completion', () => {
  it.each<ClaudeCliCompletion>(['completed', 'unknown'])(
    'moves the ticket to review with only the unread dot (%s)',
    async (completion) => {
      seed(makeTicket())

      completeSession(completion)
      await flush()

      const ticket = getTicket()
      expect(ticket.column).toBe('review')
      expect(ticket.unread).toBe(true)
      expect(ticket.awaiting_completion).toBe(false)
      expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
    }
  )

  it('moves a paused ticket to review and drops the flag when the real completion lands', async () => {
    seed(makeTicket({ awaiting_completion: true }))

    completeSession('completed')
    await flush()

    const ticket = getTicket()
    expect(ticket.column).toBe('review')
    expect(ticket.awaiting_completion).toBe(false)
    expect(ticket.unread).toBe(true)
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
    // This is the moment the push notifier hears about.
  })

  it('never flags tickets of providers that carry no completion signal', async () => {
    seed(makeTicket())

    completeSession(undefined)
    await flush()

    expect(getTicket().column).toBe('review')
    expect(getTicket().awaiting_completion).toBe(false)
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
  })

  it('clears the flag and re-arms unread on a review ticket an earlier version parked while paused', async () => {
    seed(makeTicket({ column: 'review', unread: false, awaiting_completion: true }))

    completeSession('completed')
    await flush()

    expect(getTicket().column).toBe('review')
    expect(getTicket().awaiting_completion).toBe(false)
    expect(getTicket().unread).toBe(true)
    expect(kanbanApi.ticket.update).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', {
      awaiting_completion: false,
      unread: true
    })
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not re-arm unread on a replayed completion for a ticket that was never waiting', async () => {
    seed(makeTicket({ column: 'review', unread: false, awaiting_completion: false }))

    completeSession('completed')
    await flush()

    expect(getTicket().unread).toBe(false)
    expect(kanbanApi.ticket.update).not.toHaveBeenCalled()
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })
})

describe('flag lifecycle', () => {
  it('drops the flag when the paused session resumes work', async () => {
    seed(makeTicket({ awaiting_completion: true }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_working' })
    await flush()

    expect(getTicket().column).toBe('in_progress')
    expect(getTicket().awaiting_completion).toBe(false)
    expect(kanbanApi.ticket.update).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', {
      awaiting_completion: false
    })
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not write anything for a working session on an unflagged in-progress ticket', async () => {
    seed(makeTicket())

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_working' })
    await flush()

    expect(kanbanApi.ticket.update).not.toHaveBeenCalled()
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('drops the flag when the resumed session pulls a parked review ticket back to in_progress', async () => {
    seed(makeTicket({ column: 'review', unread: true, awaiting_completion: true }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_working' })
    await flush()

    expect(getTicket().column).toBe('in_progress')
    expect(getTicket().awaiting_completion).toBe(false)
    expect(getTicket().unread).toBe(false)
  })

  it('any column move drops the flag', async () => {
    seed(makeTicket({ awaiting_completion: true }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)

    expect(getTicket().awaiting_completion).toBe(false)
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'done', 0)
  })

  it('a same-column move keeps the flag', async () => {
    seed(makeTicket({ awaiting_completion: true }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'in_progress', 5)

    expect(getTicket().awaiting_completion).toBe(true)
  })

  it('updateTicket with a column change clears the flag unless set explicitly', async () => {
    seed(makeTicket({ awaiting_completion: true }))

    await useKanbanStore.getState().updateTicket('ticket-1', PROJECT_ID, { column: 'review' })
    expect(getTicket().awaiting_completion).toBe(false)

    await useKanbanStore
      .getState()
      .updateTicket('ticket-1', PROJECT_ID, { column: 'in_progress', awaiting_completion: true })
    expect(getTicket().awaiting_completion).toBe(true)
  })
})

describe('reconcileFinishedSessions — recovers a paused finish on load', () => {
  it('flags an in_progress ticket in place when the stored completed status was a pause', async () => {
    seed(makeTicket())
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        [SESSION_ID]: { status: 'completed', timestamp: 0, completion: 'waiting' }
      }
    })

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(getTicket().column).toBe('in_progress')
    expect(getTicket().awaiting_completion).toBe(true)
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
    expect(kanbanApi.ticket.update).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', {
      awaiting_completion: true
    })
  })

  it('writes nothing when the paused ticket is already flagged', async () => {
    seed(makeTicket({ awaiting_completion: true }))
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        [SESSION_ID]: { status: 'completed', timestamp: 0, completion: 'waiting' }
      }
    })

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
    expect(kanbanApi.ticket.update).not.toHaveBeenCalled()
  })

  it('moves to review without the flag when the stored completion was detected', async () => {
    seed(makeTicket({ awaiting_completion: true }))
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        [SESSION_ID]: { status: 'completed', timestamp: 0, completion: 'completed' }
      }
    })

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(getTicket().column).toBe('review')
    expect(getTicket().awaiting_completion).toBe(false)
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
  })

  it('moves an API-errored stop to review even though it carries no completion', async () => {
    seed(makeTicket())
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        [SESSION_ID]: {
          status: 'completed',
          timestamp: 0,
          completion: 'none',
          apiError: 'rate_limit'
        }
      }
    })

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)
    await flush()

    expect(getTicket().column).toBe('review')
    expect(getTicket().awaiting_completion).toBe(false)
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
  })
})
