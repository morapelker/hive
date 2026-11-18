import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../../main/db/types'
import { isTicketHeldByPrdFlow, notifyKanbanSessionSync } from '../store-coordination'
import { useKanbanStore } from '../useKanbanStore'
import { usePrdFlowStore, type PrdFlow } from '../usePrdFlowStore'
import { useWorktreeStatusStore } from '../useWorktreeStatusStore'

// "New PRD → orchestrator ticket…" starts one session on a ticket and prompts it twice: for the
// PRD, then for the tasks document. The turn that ends between the two prompts is not the end
// of the ticket's work: while its flow is on, no session event may move the ticket out of In
// Progress. A flow that needs attention holds nothing, and its ticket moves as any other.

const initialKanbanState = useKanbanStore.getState()
const initialPrdFlowState = usePrdFlowStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

const PROJECT_ID = 'project-1'
const TICKET_ID = 'ticket-prd'
const SESSION_ID = 'session-prd'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: TICKET_ID,
    project_id: PROJECT_ID,
    title: 'code mode',
    description: 'A mode for writing code.',
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: SESSION_ID,
    worktree_id: 'wt-main',
    mode: 'build',
    plan_ready: false,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
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
    created_from_session: false,
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
  }
}

function makeFlow(overrides: Partial<PrdFlow> = {}): PrdFlow {
  return {
    ticketId: TICKET_ID,
    projectId: PROJECT_ID,
    name: 'code mode',
    prefix: 'CODE_MODE',
    prompt: 'A mode for writing code.',
    research: true,
    clarify: true,
    launch: { sdk: 'claude-code', model: null, codexFastMode: false },
    checkout: { kind: 'worktree', worktreeId: 'wt-main' },
    cwd: '/code/shop',
    memberDirs: [],
    sessionId: SESSION_ID,
    stage: 'prd',
    status: 'running',
    attention: null,
    detail: null,
    promptedAt: 1_000,
    reprompts: 0,
    resumes: 0,
    waitingSince: null,
    retryAt: null,
    forcePrompt: false,
    prdPath: null,
    tasksPath: null,
    runId: null,
    createdAt: 1_000,
    ...overrides
  }
}

/** The ticket's flow as the PRD flow store holds it. */
function seedFlow(overrides: Partial<PrdFlow> = {}): void {
  usePrdFlowStore.getState().putFlow(makeFlow(overrides))
}

const moveTicket = vi.fn()
const updateTicket = vi.fn()

function seedTicket(overrides: Partial<KanbanTicket> = {}): void {
  useKanbanStore.setState({
    tickets: new Map([[PROJECT_ID, [makeTicket(overrides)]]]),
    moveTicket,
    updateTicket
  })
}

/** The session's turn is over, as the status store has it after a board load. */
function seedCompletedStatus(): void {
  useWorktreeStatusStore.setState({
    sessionStatuses: { [SESSION_ID]: { status: 'completed', timestamp: Date.now() } }
  })
}

const completed = { type: 'session_completed' } as const
const explicitSend = { type: 'session_working', explicitSend: true } as const

beforeEach(() => {
  moveTicket.mockResolvedValue(undefined)
  updateTicket.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.resetAllMocks()
  useKanbanStore.setState(initialKanbanState, true)
  usePrdFlowStore.setState(initialPrdFlowState, true)
  useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
})

describe('a ticket whose PRD flow is on', () => {
  it('is what the kanban store asks, for a flow that is on and for no other', () => {
    expect(isTicketHeldByPrdFlow(TICKET_ID)).toBe(false)
    seedFlow()
    expect(isTicketHeldByPrdFlow(TICKET_ID)).toBe(true)
    expect(isTicketHeldByPrdFlow('ticket-other')).toBe(false)
    seedFlow({ status: 'needs_attention', attention: 'missing_file' })
    expect(isTicketHeldByPrdFlow(TICKET_ID)).toBe(false)
    usePrdFlowStore.getState().removeFlow(TICKET_ID)
    expect(isTicketHeldByPrdFlow(TICKET_ID)).toBe(false)
  })

  it.each(['launching', 'prd', 'tasks', 'creating_run'] as const)(
    'stays In Progress when the turn ends at the %s step',
    (stage) => {
      seedFlow({ stage })
      seedTicket({ column: 'in_progress' })

      notifyKanbanSessionSync(SESSION_ID, completed)

      expect(moveTicket).not.toHaveBeenCalled()
    }
  )

  it('does not move to Review when the turn ends on an error, or is read as a finished plan', () => {
    seedFlow()
    seedTicket({ column: 'in_progress' })

    notifyKanbanSessionSync(SESSION_ID, { type: 'session_error' })
    notifyKanbanSessionSync(SESSION_ID, { type: 'plan_ready' })

    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('is not moved by a prompt sent to its session: the flow puts it In Progress itself', () => {
    seedFlow({ stage: 'tasks' })
    for (const column of ['todo', 'review', 'in_progress'] as const) {
      seedTicket({ column })

      notifyKanbanSessionSync(SESSION_ID, explicitSend)
      notifyKanbanSessionSync(SESSION_ID, { type: 'session_working' })
      notifyKanbanSessionSync(SESSION_ID, { type: 'plan_followup' })

      expect(moveTicket, column).not.toHaveBeenCalled()
    }
  })

  it('is not advanced to Review by the reconcile after a board load either', () => {
    seedFlow()
    seedTicket({ column: 'in_progress' })
    seedCompletedStatus()

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)

    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('still wears the hourglass of a turn that only paused', () => {
    seedFlow()
    seedTicket({ column: 'in_progress' })

    notifyKanbanSessionSync(SESSION_ID, { type: 'session_completed', completion: 'waiting' })

    expect(updateTicket).toHaveBeenCalledWith(TICKET_ID, PROJECT_ID, { awaiting_completion: true })
    expect(moveTicket).not.toHaveBeenCalled()
  })
})

describe('a ticket whose PRD flow needs attention', () => {
  it('moves to Review when its turn ends, as any ticket', () => {
    seedFlow({ status: 'needs_attention', attention: 'user_stopped' })
    seedTicket({ column: 'in_progress' })

    notifyKanbanSessionSync(SESSION_ID, completed)

    expect(moveTicket).toHaveBeenCalledWith(TICKET_ID, PROJECT_ID, 'review', 0)
  })

  it('moves to Review on an error, and back to In Progress when the person prompts its session', () => {
    seedFlow({ status: 'needs_attention', attention: 'missing_file' })
    seedTicket({ column: 'in_progress' })

    notifyKanbanSessionSync(SESSION_ID, { type: 'session_error' })

    expect(moveTicket).toHaveBeenCalledExactlyOnceWith(TICKET_ID, PROJECT_ID, 'review', 0)
    moveTicket.mockClear()
    seedTicket({ column: 'review' })

    notifyKanbanSessionSync(SESSION_ID, explicitSend)

    expect(moveTicket).toHaveBeenCalledExactlyOnceWith(TICKET_ID, PROJECT_ID, 'in_progress', 0)
  })

  it('is advanced to Review by the reconcile after a board load', () => {
    seedFlow({ status: 'needs_attention', attention: 'missing_file' })
    seedTicket({ column: 'in_progress' })
    seedCompletedStatus()

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)

    expect(moveTicket).toHaveBeenCalledWith(TICKET_ID, PROJECT_ID, 'review', 0)
  })
})

describe('a ticket with no PRD flow', () => {
  it('moves as before while another ticket is held', () => {
    seedFlow()
    seedTicket({ id: 'ticket-other', column: 'in_progress' })

    notifyKanbanSessionSync(SESSION_ID, completed)

    expect(moveTicket).toHaveBeenCalledWith('ticket-other', PROJECT_ID, 'review', 0)
  })

  it('moves again once its flow is over and forgotten', () => {
    seedFlow({ stage: 'creating_run' })
    seedTicket({ column: 'in_progress' })
    usePrdFlowStore.getState().removeFlow(TICKET_ID)

    notifyKanbanSessionSync(SESSION_ID, completed)

    expect(moveTicket).toHaveBeenCalledWith(TICKET_ID, PROJECT_ID, 'review', 0)
  })

  it('is advanced to Review by the reconcile after a board load', () => {
    seedTicket({ column: 'in_progress' })
    seedCompletedStatus()

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)

    expect(moveTicket).toHaveBeenCalledWith(TICKET_ID, PROJECT_ID, 'review', 0)
  })
})
