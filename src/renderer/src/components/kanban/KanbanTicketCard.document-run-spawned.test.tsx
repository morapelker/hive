/**
 * The sessions started from a run's dashboard once the run ended (its migrations, its manual
 * steps, a new session on its branch) each have a ticket of their own, a child of the run's
 * ticket. While such a session runs, the run's card names that ticket under the run's state;
 * the row opens the ticket. The run's own items are counted in the label, not listed.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    column: 'review',
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
    external_id: 'run-done',
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
    ticket_prefix: 'TD',
    ticket_number: 12,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  }
}

const runTicket = makeTicket()

function childTicket(id: string, overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return makeTicket({
    id,
    column: 'in_progress',
    external_provider: null,
    external_id: null,
    parent_ticket_id: runTicket.id,
    parent_ticket_key: 'TD-12',
    ...overrides
  })
}

// One of the run's own items, and the three kinds of session its dashboard starts
const task = childTicket('task-1', { title: 'Task one', current_session_id: 's-task' })
const migrations = childTicket('t-migrations', {
  title: 'Migrations — Checkout redesign',
  current_session_id: 's-migrations',
  created_at: '2026-06-02T00:00:00.000Z'
})
const manualSteps = childTicket('t-manual', {
  title: 'Manual steps — Checkout redesign',
  current_session_id: 's-manual',
  created_at: '2026-06-03T00:00:00.000Z'
})
const session = childTicket('t-session', {
  title: 'Fix the footer',
  current_session_id: 's-session',
  created_at: '2026-06-04T00:00:00.000Z'
})

function seedBoard(tickets: KanbanTicket[]): void {
  useKanbanStore.setState({ tickets: new Map([[runTicket.project_id, tickets]]) })
}

function setStatuses(statuses: Record<string, string>): void {
  useWorktreeStatusStore.setState({
    sessionStatuses: Object.fromEntries(
      Object.entries(statuses).map(([id, status]) => [id, { status, timestamp: 1 }])
    ) as never
  })
}

const rows = (): string[] =>
  screen
    .queryAllByTestId(/^kanban-docflow-run-spawned-session-/)
    .map((row) => row.getAttribute('data-testid')!.replace('kanban-docflow-run-spawned-session-', ''))

beforeEach(() => {
  api.get.mockImplementation(
    async (runId: string) => useDocumentFlowStore.getState().runsById[runId] ?? null
  )
  useDocumentFlowStore.setState({
    runsById: {
      'run-done': makeDetail({ id: 'run-done', status: 'completed', ticket_id: 'ticket-run' }, [
        { key: 'A1', status: 'merged', ticket_id: 'task-1', session_id: 's-task' }
      ])
    }
  })
  seedBoard([runTicket, task, migrations, manualSteps, session])
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

describe('the sessions started from a run’s dashboard, on the run’s card', () => {
  it('names the ticket of every such session that is running, oldest first', () => {
    setStatuses({ 's-migrations': 'working', 's-manual': 'working', 's-session': 'planning' })
    render(<KanbanTicketCard ticket={runTicket} />)

    expect(rows()).toEqual(['t-migrations', 't-manual', 't-session'])
    const row = screen.getByTestId('kanban-docflow-run-spawned-session-t-manual')
    expect(row).toHaveTextContent('Manual steps — Checkout redesign')
    expect(row).toHaveAttribute('data-session-state', 'working')
    expect(screen.getByTestId('kanban-docflow-run-spawned-session-t-session')).toHaveTextContent(
      'Fix the footer'
    )
  })

  it('names none whose session is not running', () => {
    // Over, never reported, and a ticket that was created but has no session
    setStatuses({ 's-migrations': 'completed', 's-manual': 'unread' })
    seedBoard([runTicket, migrations, manualSteps, { ...session, current_session_id: null }])
    render(<KanbanTicketCard ticket={runTicket} />)

    expect(rows()).toEqual([])
  })

  it('drops the row once the session is over', () => {
    setStatuses({ 's-manual': 'working' })
    render(<KanbanTicketCard ticket={runTicket} />)
    expect(rows()).toEqual(['t-manual'])

    act(() => setStatuses({ 's-manual': 'completed' }))

    expect(rows()).toEqual([])
  })

  it('does not list the run’s own items: the label counts those', () => {
    setStatuses({ 's-task': 'working' })
    render(<KanbanTicketCard ticket={runTicket} />)

    expect(rows()).toEqual([])
  })

  it('says when a session waits for the user: a question, or a permission', () => {
    const question: QuestionRequest = {
      id: 'q-1',
      sessionID: 's-migrations',
      questions: [{ question: 'Run 0043 against production?', header: 'Migrations', options: [] }]
    }
    useQuestionStore.setState({ pendingBySession: new Map([['s-migrations', [question]]]) })
    setStatuses({ 's-manual': 'permission' })
    render(<KanbanTicketCard ticket={runTicket} />)

    expect(rows()).toEqual(['t-migrations', 't-manual'])
    expect(screen.getByTestId('kanban-docflow-run-spawned-session-t-migrations')).toHaveAttribute(
      'data-session-state',
      'needs_you'
    )
    expect(screen.getByTestId('kanban-docflow-run-spawned-session-t-manual')).toHaveAttribute(
      'data-session-state',
      'needs_you'
    )
  })

  it('keeps naming a session parked on its own background work', () => {
    setStatuses({ 's-manual': 'completed' })
    seedBoard([runTicket, { ...manualSteps, awaiting_completion: true }])
    render(<KanbanTicketCard ticket={runTicket} />)

    expect(rows()).toEqual(['t-manual'])
    expect(screen.getByTestId('kanban-docflow-run-spawned-session-t-manual')).toHaveAttribute(
      'data-session-state',
      'waiting'
    )
  })

  it('opens the session’s ticket on click, not the run', () => {
    setStatuses({ 's-manual': 'working' })
    const openRun = vi.fn()
    useDocumentFlowStore.setState({ openRun })
    render(<KanbanTicketCard ticket={runTicket} />)

    fireEvent.click(screen.getByTestId('kanban-docflow-run-spawned-session-t-manual'))

    expect(useKanbanStore.getState().selectedTicketRef).toEqual({
      projectId: 'proj-1',
      ticketId: 't-manual'
    })
    expect(openRun).not.toHaveBeenCalled()
  })

  it('names the sessions next to the migrations label while the migrations are executed', () => {
    useDocumentFlowStore.setState({
      runsById: {
        'run-done': makeDetail(
          {
            id: 'run-done',
            status: 'completed',
            ticket_id: 'ticket-run',
            migration_session_id: 's-migrations'
          },
          [{ key: 'A1', status: 'merged', ticket_id: 'task-1', session_id: 's-task' }]
        )
      }
    })
    setStatuses({ 's-migrations': 'working' })
    render(<KanbanTicketCard ticket={{ ...runTicket, column: 'in_progress' }} />)

    expect(screen.getByTestId('kanban-docflow-run-running-run-done')).toHaveTextContent(
      'Running migrations'
    )
    expect(rows()).toEqual(['t-migrations'])
  })

  it('lists them with the run’s tickets folded into the card too', () => {
    useSettingsStore.setState({ nestDocumentRunTickets: true })
    setStatuses({ 's-manual': 'working' })
    render(<KanbanTicketCard ticket={runTicket} />)

    expect(rows()).toEqual(['t-manual'])
    expect(screen.getByTestId('kanban-docflow-run-children-ticket-run')).toBeInTheDocument()
  })

  it('names nothing on the card of an archived run', () => {
    setStatuses({ 's-manual': 'working' })
    render(<KanbanTicketCard ticket={{ ...runTicket, archived_at: now }} />)

    expect(rows()).toEqual([])
  })
})
