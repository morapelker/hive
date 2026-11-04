/**
 * The tickets of a document run fold into the run's card as a collapsible strip of rows when
 * the "Group document run tickets" setting is on (off by default): a header with the count and
 * where the rows stand, the rows themselves once opened, each opening its ticket.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanTicketCard } from './KanbanTicketCard'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useQuestionStore, type QuestionRequest } from '@/stores/useQuestionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type { KanbanTicket } from '../../../../main/db/types'

const api = vi.hoisted(() => ({ get: vi.fn() }))
const projectApi = vi.hoisted(() => ({ openPath: vi.fn() }))
const systemApi = vi.hoisted(() => ({ openInChrome: vi.fn() }))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/api/project-api', () => ({ projectApi }))
vi.mock('@/api/system-api', () => ({ systemApi }))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const initialFlowState = useDocumentFlowStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialQuestionState = useQuestionStore.getState()
const initialSettingsState = useSettingsStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

const now = '2026-06-01T00:00:00.000Z'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-run',
    project_id: 'proj-1',
    title: 'Checkout redesign',
    description: null,
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: null,
    worktree_id: 'wt-integration',
    mode: null,
    plan_ready: false,
    created_at: now,
    updated_at: now,
    column_changed_at: null,
    archived_at: null,
    external_provider: 'document-run',
    external_id: 'run-live',
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    sync_task_id: null,
    sync_task_title: null,
    sync_task_status: null,
    sync_task_org_id: null,
    sync_task_assignees: null,
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
    ticket_prefix: 'TD',
    ticket_number: 12,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  }
}

const runTicket = makeTicket()

function childTicket(
  id: string,
  number: number,
  overrides: Partial<KanbanTicket> = {}
): KanbanTicket {
  return makeTicket({
    id,
    title: `Task ${number}`,
    external_provider: null,
    external_id: null,
    worktree_id: null,
    ticket_number: number,
    parent_ticket_id: runTicket.id,
    parent_ticket_key: 'TD-12',
    ...overrides
  })
}

const children = [
  childTicket('child-merged', 13, { column: 'merged' }),
  childTicket('child-review', 14, { column: 'review', current_session_id: 'session-14' }),
  childTicket('child-working', 15, { column: 'in_progress', current_session_id: 'session-15' }),
  childTicket('child-queued', 16, { column: 'todo' })
]

function seedBoard(tickets: KanbanTicket[]): void {
  useKanbanStore.setState({ tickets: new Map([[runTicket.project_id, tickets]]) })
}

const strip = (): HTMLElement => screen.getByTestId('kanban-docflow-run-children-ticket-run')
const toggle = (): HTMLElement =>
  screen.getByTestId('kanban-docflow-run-children-toggle-ticket-run')
const queryStrip = (): HTMLElement | null =>
  screen.queryByTestId('kanban-docflow-run-children-ticket-run')

beforeEach(() => {
  api.get.mockImplementation(
    async (runId: string) => useDocumentFlowStore.getState().runsById[runId] ?? null
  )
  useDocumentFlowStore.setState({
    runsById: { 'run-live': makeDetail({ id: 'run-live', status: 'running' }) }
  })
  useSettingsStore.setState({ nestDocumentRunTickets: true })
  seedBoard([runTicket, ...children])
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.resetAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useKanbanStore.setState(initialKanbanState, true)
  useQuestionStore.setState(initialQuestionState, true)
  useSettingsStore.setState(initialSettingsState, true)
  useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
})

describe('the folded tickets of a document run', () => {
  it('is off by default: the run card shows no strip', () => {
    useSettingsStore.setState({ nestDocumentRunTickets: false })
    render(<KanbanTicketCard ticket={runTicket} />)
    expect(queryStrip()).toBeNull()
  })

  it('starts collapsed with the count and where the rows stand, and opens on the header', () => {
    render(<KanbanTicketCard ticket={runTicket} />)

    expect(strip()).not.toHaveAttribute('data-expanded')
    expect(toggle()).toHaveTextContent('4 tickets')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.getByTestId('kanban-docflow-run-children-count-ticket-run-todo')
    ).toHaveTextContent('1')
    expect(
      screen.getByTestId('kanban-docflow-run-children-count-ticket-run-in_progress')
    ).toHaveTextContent('1')
    expect(
      screen.getByTestId('kanban-docflow-run-children-count-ticket-run-review')
    ).toHaveTextContent('1')
    expect(
      screen.getByTestId('kanban-docflow-run-children-count-ticket-run-merged')
    ).toHaveTextContent('1')
    expect(
      screen.queryByTestId('kanban-docflow-run-children-count-ticket-run-done')
    ).toBeNull()
    expect(screen.queryByTestId('kanban-docflow-run-child-child-queued')).toBeNull()

    fireEvent.click(toggle())

    expect(strip()).toHaveAttribute('data-expanded')
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(useDocumentFlowStore.getState().expandedRunTickets).toEqual({ 'ticket-run': true })
    // Queued first, done last; each row carries its own key, not the run's
    const rows = within(strip()).getAllByTestId(/^kanban-docflow-run-child-/)
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'kanban-docflow-run-child-child-queued',
      'kanban-docflow-run-child-child-working',
      'kanban-docflow-run-child-child-review',
      'kanban-docflow-run-child-child-merged'
    ])
    const queued = screen.getByTestId('kanban-docflow-run-child-child-queued')
    expect(queued).toHaveTextContent('TD-16')
    expect(queued).not.toHaveTextContent('TD-12')
    expect(queued).toHaveTextContent('Task 16')
    expect(queued).toHaveTextContent('Queued')
    expect(screen.getByTestId('kanban-docflow-run-child-child-merged')).toHaveTextContent('Merged')
    expect(screen.getByTestId('kanban-docflow-run-child-child-review')).toHaveTextContent('Review')

    fireEvent.click(toggle())
    expect(strip()).not.toHaveAttribute('data-expanded')
    expect(screen.queryByTestId('kanban-docflow-run-child-child-queued')).toBeNull()
  })

  it('says which rows are at work or waiting for you, from their sessions', () => {
    useDocumentFlowStore.getState().toggleRunTicketsExpanded('ticket-run')
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-15': { status: 'working', timestamp: 1 } as never
      }
    })
    const question: QuestionRequest = {
      id: 'q-1',
      sessionID: 'session-14',
      questions: [{ question: 'Keep the old endpoint?', header: 'API', options: [] }]
    }
    useQuestionStore.setState({ pendingBySession: new Map([['session-14', [question]]]) })

    render(<KanbanTicketCard ticket={runTicket} />)

    const working = screen.getByTestId('kanban-docflow-run-child-child-working')
    expect(working).toHaveAttribute('data-session-state', 'working')
    expect(working).toHaveTextContent('Working')
    const asking = screen.getByTestId('kanban-docflow-run-child-child-review')
    expect(asking).toHaveAttribute('data-session-state', 'needs_you')
    expect(asking).toHaveTextContent('Needs you')
    // The header counts the rows waiting for you, so a collapsed strip says it too
    expect(
      screen.getByTestId('kanban-docflow-run-children-needs-you-ticket-run')
    ).toHaveTextContent('1')
  })

  it('opens the row’s ticket on click, not the run', () => {
    useDocumentFlowStore.getState().toggleRunTicketsExpanded('ticket-run')
    const openRun = vi.fn()
    useDocumentFlowStore.setState({ openRun })
    render(<KanbanTicketCard ticket={runTicket} />)

    fireEvent.click(screen.getByTestId('kanban-docflow-run-child-child-queued'))

    expect(useKanbanStore.getState().selectedTicketRef).toEqual({
      projectId: 'proj-1',
      ticketId: 'child-queued'
    })
    expect(openRun).not.toHaveBeenCalled()
  })

  it('shows no strip while a board search is on (the rows are cards again) or without rows', () => {
    useKanbanStore.setState({
      boardSearch: { open: true, query: 'task', searchDescriptions: false }
    })
    const { unmount } = render(<KanbanTicketCard ticket={runTicket} />)
    expect(queryStrip()).toBeNull()
    unmount()

    useKanbanStore.setState({
      boardSearch: { open: false, query: '', searchDescriptions: false }
    })
    seedBoard([runTicket, childTicket('child-archived', 17, { archived_at: now })])
    render(<KanbanTicketCard ticket={runTicket} />)
    expect(queryStrip()).toBeNull()
  })
})
