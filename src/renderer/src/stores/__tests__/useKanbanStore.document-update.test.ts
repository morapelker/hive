import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../../main/db/types'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import type { DocumentUpdateStatus } from '@shared/types/document-flow'
import {
  isTicketHeldByDocumentUpdate,
  isTicketInDocumentUpdateLane,
  notifyKanbanSessionSync
} from '../store-coordination'
import {
  documentUpdateLaneOf,
  isTicketInDocumentUpdate,
  useDocumentFlowStore
} from '../useDocumentFlowStore'
import { useKanbanStore } from '../useKanbanStore'
import { useWorktreeStatusStore } from '../useWorktreeStatusStore'

// Once a document run merged a ticket, the run sends the ticket's own session one more prompt:
// update the run's document. That prompt is an explicit send and its turn ends like any other,
// but the work is the run's: no session event may move the ticket while the update is on.

const api = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))

const initialKanbanState = useKanbanStore.getState()
const initialFlowState = useDocumentFlowStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

const PROJECT_ID = 'project-1'
const SESSION_ID = 'session-a1'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-a1',
    project_id: PROJECT_ID,
    title: 'Cart totals',
    description: null,
    attachments: [],
    column: 'merged',
    sort_order: 0,
    current_session_id: SESSION_ID,
    worktree_id: 'wt-a1',
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

/** A run that merged the ticket's item, its document update in `status`. */
function seedRun(
  document_update_status: DocumentUpdateStatus | null,
  runStatus: 'running' | 'paused' | 'completed' = 'running'
): void {
  const detail = makeDetail({ id: 'run-1', status: runStatus }, [
    {
      key: 'A1',
      status: 'merged',
      ticket_id: 'ticket-a1',
      session_id: SESSION_ID,
      document_update_status
    }
  ])
  useDocumentFlowStore.setState({ runsById: { 'run-1': detail } })
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

const completed = { type: 'session_completed' } as const
const explicitSend = { type: 'session_working', explicitSend: true } as const

beforeEach(() => {
  moveTicket.mockResolvedValue(undefined)
  updateTicket.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.resetAllMocks()
  useKanbanStore.setState(initialKanbanState, true)
  useDocumentFlowStore.setState(initialFlowState, true)
  useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
})

describe('isTicketInDocumentUpdate', () => {
  it('holds a ticket updating the document of a run that is on', () => {
    seedRun('updating')
    expect(isTicketInDocumentUpdate(useDocumentFlowStore.getState().runsById, 'ticket-a1')).toBe(
      true
    )
    seedRun('updating', 'paused')
    expect(isTicketInDocumentUpdate(useDocumentFlowStore.getState().runsById, 'ticket-a1')).toBe(
      true
    )
  })

  it('lets go once the update is over, the run is over, or for another ticket', () => {
    for (const status of ['queued', 'done', 'failed', 'skipped', null] as const) {
      seedRun(status)
      expect(
        isTicketInDocumentUpdate(useDocumentFlowStore.getState().runsById, 'ticket-a1'),
        String(status)
      ).toBe(false)
    }
    seedRun('updating', 'completed')
    expect(isTicketInDocumentUpdate(useDocumentFlowStore.getState().runsById, 'ticket-a1')).toBe(
      false
    )
    seedRun('updating')
    expect(isTicketInDocumentUpdate(useDocumentFlowStore.getState().runsById, 'ticket-x')).toBe(
      false
    )
  })
})

describe('documentUpdateLaneOf', () => {
  const laneOf = (ticketId = 'ticket-a1'): string | null =>
    documentUpdateLaneOf(useDocumentFlowStore.getState().runsById, ticketId)

  it('tells a ticket still waiting for the update prompt from one whose session is at the edit', () => {
    seedRun('queued')
    expect(laneOf()).toBe('queued')
    seedRun('updating')
    expect(laneOf()).toBe('updating')
    seedRun('queued', 'paused')
    expect(laneOf()).toBe('queued')
  })

  it('is over once the update ended, the run ended, or for another ticket', () => {
    for (const status of ['done', 'failed', 'skipped', null] as const) {
      seedRun(status)
      expect(laneOf(), String(status)).toBeNull()
    }
    seedRun('queued', 'completed')
    expect(laneOf()).toBeNull()
    seedRun('queued')
    expect(laneOf('ticket-x')).toBeNull()
  })

  it('is what the kanban store asks to keep the session open for the run', () => {
    seedRun('queued')
    expect(isTicketInDocumentUpdateLane('ticket-a1')).toBe(true)
    expect(isTicketHeldByDocumentUpdate('ticket-a1')).toBe(false)
    seedRun('updating')
    expect(isTicketInDocumentUpdateLane('ticket-a1')).toBe(true)
    expect(isTicketHeldByDocumentUpdate('ticket-a1')).toBe(true)
    seedRun('done')
    expect(isTicketInDocumentUpdateLane('ticket-a1')).toBe(false)
    expect(isTicketHeldByDocumentUpdate('ticket-a1')).toBe(false)
  })
})

describe('a session updating its run document', () => {
  it('does not reopen its merged ticket when the update prompt is sent', () => {
    seedRun('updating')
    seedTicket({ column: 'merged' })

    notifyKanbanSessionSync(SESSION_ID, explicitSend)

    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('does not move its ticket to Review when the turn ends', () => {
    seedRun('updating')
    seedTicket({ column: 'in_progress' })

    notifyKanbanSessionSync(SESSION_ID, completed)
    notifyKanbanSessionSync(SESSION_ID, { type: 'session_error' })
    notifyKanbanSessionSync(SESSION_ID, { type: 'plan_ready' })

    expect(moveTicket).not.toHaveBeenCalled()
  })

  it("lets the user's own follow-up reopen a ticket still waiting in the queue", () => {
    seedRun('queued')
    seedTicket({ column: 'merged' })

    notifyKanbanSessionSync(SESSION_ID, explicitSend)

    expect(moveTicket).toHaveBeenCalledWith('ticket-a1', PROJECT_ID, 'in_progress', 0)
  })

  it('moves the ticket as usual again once the document update is over', () => {
    seedRun('done')
    seedTicket({ column: 'merged' })

    notifyKanbanSessionSync(SESSION_ID, explicitSend)

    expect(moveTicket).toHaveBeenCalledWith('ticket-a1', PROJECT_ID, 'in_progress', 0)
  })

  it('moves an ordinary ticket as before', () => {
    seedRun('updating')
    seedTicket({ id: 'ticket-other', column: 'in_progress' })

    notifyKanbanSessionSync(SESSION_ID, completed)

    expect(moveTicket).toHaveBeenCalledWith('ticket-other', PROJECT_ID, 'review', 0)
  })

  it('is not advanced to Review by the reconcile after a board load either', () => {
    seedRun('updating')
    seedTicket({ column: 'in_progress' })
    useWorktreeStatusStore.setState({
      sessionStatuses: { [SESSION_ID]: { status: 'completed', timestamp: Date.now() } }
    })

    useKanbanStore.getState().reconcileFinishedSessions(PROJECT_ID)

    expect(moveTicket).not.toHaveBeenCalled()
  })
})
