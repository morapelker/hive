import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../../main/db/types'
import { notifyKanbanNewSession } from '../store-coordination'
import { useDocumentFlowStore } from '../useDocumentFlowStore'
import { useKanbanStore } from '../useKanbanStore'

// The ticket of a document run is a real ticket on the run's integration worktree, with no
// session. Logic meant for tickets an agent works on must leave it alone.

const api = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))

const initialKanbanState = useKanbanStore.getState()
const initialFlowState = useDocumentFlowStore.getState()

const PROJECT_ID = 'proj-1'
const INTEGRATION_WORKTREE = 'wt-integration'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'A ticket',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: INTEGRATION_WORKTREE,
    mode: null,
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
    ...overrides
  }
}

const runTicket = (overrides: Partial<KanbanTicket> = {}): KanbanTicket =>
  makeTicket({
    id: 'ticket-run',
    title: 'Checkout redesign',
    column: 'in_progress',
    external_provider: 'document-run',
    external_id: 'run-1',
    ...overrides
  })

const updateTicket = vi.fn()
const markTicketRead = vi.fn()

/** The dashboard is opened behind a dynamic import. */
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  api.get.mockResolvedValue(null)
  updateTicket.mockResolvedValue(undefined)
  useKanbanStore.setState({ updateTicket, markTicketRead })
})

afterEach(() => {
  vi.resetAllMocks()
  useKanbanStore.setState(initialKanbanState, true)
  useDocumentFlowStore.setState(initialFlowState, true)
})

describe('a new session on the integration worktree', () => {
  it('is not attached to the run ticket: a fix session belongs to its own ticket', () => {
    useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [runTicket()]]]) })

    notifyKanbanNewSession('session-fix', INTEGRATION_WORKTREE, PROJECT_ID, 'build')

    expect(updateTicket).not.toHaveBeenCalled()
  })

  it('still goes to a ticket that was pre-assigned to that worktree', () => {
    useKanbanStore.setState({
      tickets: new Map([[PROJECT_ID, [runTicket(), makeTicket({ id: 'ticket-waiting' })]]])
    })

    notifyKanbanNewSession('session-1', INTEGRATION_WORKTREE, PROJECT_ID, 'build')

    expect(updateTicket).toHaveBeenCalledTimes(1)
    expect(updateTicket).toHaveBeenCalledWith(
      'ticket-waiting',
      PROJECT_ID,
      expect.objectContaining({ current_session_id: 'session-1', column: 'in_progress' })
    )
  })
})

describe('opening a ticket', () => {
  it('opens the run dashboard for the ticket of a run, from any route, and marks it read', async () => {
    useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [runTicket({ unread: true })]]]) })

    useKanbanStore.getState().setSelectedTicketRef({ projectId: PROJECT_ID, ticketId: 'ticket-run' })
    await flush()

    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-1')
    // The ticket modal, with its session launcher, stays closed.
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
    expect(useKanbanStore.getState().selectedTicketId).toBeNull()
    expect(markTicketRead).toHaveBeenCalledWith('ticket-run', PROJECT_ID)
  })

  it.each(['extracting', 'preview', 'extract_failed'] as const)(
    'opens the Implement document dialog instead for the ticket of a run that is %s',
    async (status) => {
      useKanbanStore.setState({
        tickets: new Map([[PROJECT_ID, [runTicket({ column: 'todo', worktree_id: null })]]])
      })
      useDocumentFlowStore.setState({
        runsById: {
          'run-1': {
            run: { id: 'run-1', project_id: PROJECT_ID, status } as never,
            items: [],
            events: []
          }
        }
      })

      useKanbanStore.getState().setSelectedTicketRef({ projectId: PROJECT_ID, ticketId: 'ticket-run' })
      await flush()

      expect(useDocumentFlowStore.getState().wizard).toEqual({
        open: true,
        projectId: PROJECT_ID,
        runId: 'run-1'
      })
      expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
      expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
      expect(markTicketRead).toHaveBeenCalledWith('ticket-run', PROJECT_ID)
    }
  )

  it('opens the dashboard for a run ticket whose run is not loaded: the dashboard offers the preview', async () => {
    useKanbanStore.setState({
      tickets: new Map([[PROJECT_ID, [runTicket({ column: 'todo', worktree_id: null })]]])
    })

    useKanbanStore.getState().setSelectedTicketRef({ projectId: PROJECT_ID, ticketId: 'ticket-run' })
    await flush()

    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-1')
    expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
  })

  it('opens the ticket modal for every other ticket, and still closes it', async () => {
    useKanbanStore.setState({
      tickets: new Map([[PROJECT_ID, [runTicket(), makeTicket({ external_provider: 'github' })]]])
    })

    useKanbanStore.getState().setSelectedTicketRef({ projectId: PROJECT_ID, ticketId: 'ticket-1' })
    await flush()

    expect(useKanbanStore.getState().selectedTicketRef).toEqual({
      projectId: PROJECT_ID,
      ticketId: 'ticket-1'
    })
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()

    useKanbanStore.getState().setSelectedTicketRef(null)
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
  })
})
