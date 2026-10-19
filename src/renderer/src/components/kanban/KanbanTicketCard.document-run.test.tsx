/**
 * The ticket of a document run is a real board ticket: the usual card, draggable, with a
 * context menu. It shows the run it stands for and opens the run dashboard, and it offers
 * nothing that needs a session of its own.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanTicketCard } from './KanbanTicketCard'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useGitStore } from '@/stores/useGitStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useQuestionStore, type QuestionRequest } from '@/stores/useQuestionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { DOCUMENT_UPDATE_INTERRUPT_DETAIL, WAITING_PREFIX } from '@shared/document-flow/planning'
import type { DocumentRunDetail, DocumentRunMember } from '@shared/types/document-flow'
import type { KanbanTicket } from '../../../../main/db/types'

const api = vi.hoisted(() => ({ get: vi.fn() }))
const projectApi = vi.hoisted(() => ({ openPath: vi.fn() }))
const systemApi = vi.hoisted(() => ({ openInChrome: vi.fn() }))
const runPRs = vi.hoisted(() => ({ createDocumentRunPRs: vi.fn() }))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/api/project-api', () => ({ projectApi }))
vi.mock('@/api/system-api', () => ({ systemApi }))
vi.mock('@/lib/document-flow/run-prs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-flow/run-prs')>()),
  createDocumentRunPRs: runPRs.createDocumentRunPRs
}))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const initialFlowState = useDocumentFlowStore.getState()
const initialGitState = useGitStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialQuestionState = useQuestionStore.getState()
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

function seedRuns(...details: DocumentRunDetail[]): void {
  useDocumentFlowStore.setState({
    runsById: Object.fromEntries(details.map((detail) => [detail.run.id, detail]))
  })
}

const card = (id = 'ticket-run'): HTMLElement => screen.getByTestId(`kanban-ticket-${id}`)

// A finished run whose migrations a session is executing; its ticket is back In Progress.
const migratingRun = (): DocumentRunDetail =>
  makeDetail({ id: 'run-live', status: 'completed', migration_session_id: 'session-mig' }, [
    { key: 'A1', status: 'merged' },
    { key: 'A2', status: 'needs_attention' }
  ])

const MIGRATION_QUESTION: QuestionRequest = {
  id: 'question-1',
  sessionID: 'session-mig',
  questions: [{ question: 'Run 0067 as well?', header: 'Migrations', options: [] }]
}

/** The card of a migrating run whose session waits on the user: orange, like a ticket that asks. */
function expectMigrationsWaiting(): void {
  const body = screen.getByTestId('kanban-docflow-run-run-live')
  expect(body).toHaveAttribute('data-phase', 'migrating')
  expect(body).toHaveAttribute('data-waiting-on-user')
  const bar = screen.getByTestId('kanban-docflow-run-bar-run-live')
  expect(bar).toHaveAttribute('data-moving')
  const progressbar = within(bar).getByRole('progressbar')
  expect(progressbar).toHaveAccessibleName('Waiting for answer')
  expect(progressbar.firstElementChild?.className).toContain('bg-amber-500')
  expect(progressbar.firstElementChild?.className).not.toContain('bg-fuchsia-500')
  const label = screen.getByTestId('kanban-docflow-run-running-run-live')
  expect(label).toHaveTextContent(/^Migrations waiting for you$/)
  expect(label.className).toContain('text-orange-500')
  expect(label.className).not.toContain('text-fuchsia-500')
  expect(card().className).toContain('[--ticket-state-tone:#f97316]')
  expect(card().className).not.toContain('[--ticket-state-tone:#d946ef]')
  // The label says it already; "Needs you" is for a paused run.
  expect(screen.queryByTestId('kanban-docflow-run-needs-you-run-live')).toBeNull()
}

/** The card of a migrating run whose session is at work: the migrations' own color. */
function expectMigrationsRunning(): void {
  const body = screen.getByTestId('kanban-docflow-run-run-live')
  expect(body).toHaveAttribute('data-phase', 'migrating')
  expect(body).not.toHaveAttribute('data-waiting-on-user')
  const progressbar = within(screen.getByTestId('kanban-docflow-run-bar-run-live')).getByRole(
    'progressbar'
  )
  expect(progressbar).toHaveAccessibleName('Running migrations')
  expect(progressbar.firstElementChild?.className).toContain('bg-fuchsia-500')
  const label = screen.getByTestId('kanban-docflow-run-running-run-live')
  expect(label).toHaveTextContent(/^Running migrations$/)
  expect(label.className).toContain('text-fuchsia-500')
  expect(label.className).not.toContain('text-orange-500')
  expect(card().className).toContain('[--ticket-state-tone:#d946ef]')
  expect(card().className).not.toContain('[--ticket-state-tone:#f97316]')
}

beforeEach(() => {
  api.get.mockImplementation(
    async (runId: string) => useDocumentFlowStore.getState().runsById[runId] ?? null
  )
  projectApi.openPath.mockResolvedValue('')
  runPRs.createDocumentRunPRs.mockResolvedValue([])
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.resetAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useGitStore.setState(initialGitState, true)
  useKanbanStore.setState(initialKanbanState, true)
  useQuestionStore.setState(initialQuestionState, true)
  useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
})

describe('the card of a document run ticket', () => {
  it('shows marker, progress and the sessions at work of a running run, in the ticket chrome', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running', title: 'Checkout redesign' }, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'running' },
        { key: 'A3', status: 'launching' },
        { key: 'A4', status: 'verifying' },
        { key: 'A5', status: 'pending' },
        { key: 'A6', status: 'pending', selected: false }
      ])
    )
    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(card()).toHaveTextContent('Checkout redesign')
    // A ticket like any other: it can be dragged between columns.
    expect(card()).toHaveAttribute('draggable', 'true')
    expect(screen.getByTestId('kanban-docflow-run-marker-run-live')).toHaveTextContent(
      'Document run'
    )
    // Verifying is the orchestrator's own step: not among the sessions at work.
    expect(screen.getByTestId('kanban-docflow-run-running-run-live')).toHaveTextContent(
      /^2 working$/
    )
    expect(screen.getByTestId('kanban-docflow-run-progress-run-live')).toHaveTextContent(
      '1/5 merged'
    )
    // One moving bar, like any ticket at work.
    const bar = screen.getByTestId('kanban-docflow-run-bar-run-live')
    expect(bar).toHaveAttribute('data-moving')
    expect(within(bar).getByRole('progressbar')).toHaveAccessibleName('Agent is working')
    expect(within(card()).queryByTestId('docflow-progress-bar')).toBeNull()

    const body = screen.getByTestId('kanban-docflow-run-run-live')
    expect(body).toHaveAttribute('data-phase', 'running')
    expect(body).not.toHaveAttribute('data-waiting-on-user')
    expect(card().className).toContain('[--ticket-state-tone:#3b82f6]')
    expect(screen.queryByTestId('kanban-docflow-run-needs-you-run-live')).toBeNull()
  })

  it.each([
    ['asks a question', { status: 'needs_input' }],
    ['is flagged', { status: 'needs_attention' }],
    ['stopped to ask mid-fix', { status: 'fixing', status_detail: `${WAITING_PREFIX}which one?` }]
  ] as const)('turns orange when a ticket %s', (_name, waiting) => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [
        { key: 'A1', status: 'running' },
        { key: 'A2', ...waiting }
      ])
    )
    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(screen.getByTestId('kanban-docflow-run-run-live')).toHaveAttribute(
      'data-waiting-on-user'
    )
    expect(card().className).toContain('[--ticket-state-tone:#f97316]')
    expect(card().className).not.toContain('[--ticket-state-tone:#3b82f6]')
    // The count of those waiting takes the place of the count of those at work.
    const label = screen.getByTestId('kanban-docflow-run-running-run-live')
    expect(label).toHaveTextContent(/^1 waiting for answer$/)
    expect(label.className).toContain('text-orange-500')
    expect(
      within(screen.getByTestId('kanban-docflow-run-bar-run-live')).getByRole('progressbar')
    ).toHaveAccessibleName('Waiting for answer')
    expect(screen.queryByTestId('kanban-docflow-run-needs-you-run-live')).toBeNull()
  })

  it('says which ticket edits the document, in pink, while no other session is at work', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [
        { key: 'A1', status: 'merged', document_update_status: 'done' },
        { key: 'A2', status: 'merged', document_update_status: 'updating' }
      ])
    )
    render(<KanbanTicketCard ticket={makeTicket()} />)

    const label = screen.getByTestId('kanban-docflow-run-running-run-live')
    expect(label).toHaveTextContent(/^Editing document · A2$/)
    expect(label.className).toContain('text-pink-500')
    const progressbar = within(screen.getByTestId('kanban-docflow-run-bar-run-live')).getByRole(
      'progressbar'
    )
    expect(progressbar).toHaveAccessibleName('Editing document')
    expect(progressbar.firstElementChild?.className).toContain('bg-pink-500')
    expect(card().className).toContain('[--ticket-state-tone:#ec4899]')
    // The run's own ticket is not queued to edit anything
    expect(screen.queryByTestId('kanban-ticket-doc-edit-queue')).toBeNull()
    expect(screen.queryByTestId('kanban-ticket-editing-document')).toBeNull()
  })

  it('keeps "N working" in blue when the document is edited beside other sessions at work', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [
        { key: 'A1', status: 'running' },
        { key: 'A2', status: 'merged', document_update_status: 'updating' }
      ])
    )
    render(<KanbanTicketCard ticket={makeTicket()} />)

    const label = screen.getByTestId('kanban-docflow-run-running-run-live')
    expect(label).toHaveTextContent(/^2 working$/)
    expect(label.className).not.toContain('text-pink-500')
    expect(card().className).toContain('[--ticket-state-tone:#3b82f6]')
  })

  it('keeps "Needs you" on a paused run, whose label says it is paused', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'paused' }, [{ key: 'A1', status: 'needs_input' }])
    )
    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(screen.getByTestId('kanban-docflow-run-running-run-live')).toHaveTextContent(/^Paused$/)
    expect(screen.getByTestId('kanban-docflow-run-needs-you-run-live')).toHaveTextContent(
      'Needs you'
    )
  })

  it('wears an "At cap" tag once every parallel slot is held, and nothing about the cap before', () => {
    const items = [
      { key: 'A1', status: 'running' },
      { key: 'A2', status: 'checking' },
      { key: 'A3', status: 'pending' }
    ] as const
    const config = (maxParallel: number) => ({ ...makeDetail().run.config, maxParallel })

    seedRuns(makeDetail({ id: 'run-live', status: 'running', config: config(2) }, [...items]))
    const { unmount } = render(<KanbanTicketCard ticket={makeTicket()} />)
    const tag = screen.getByTestId('kanban-docflow-run-at-cap-run-live')
    expect(tag).toHaveTextContent('At cap')
    expect(tag.className).toContain('--elite-gold')
    // The count of those at work stays as it is: the tag is the only mention of the cap
    expect(screen.getByTestId('kanban-docflow-run-running-run-live')).toHaveTextContent(
      /^1 working$/
    )
    unmount()

    seedRuns(makeDetail({ id: 'run-live', status: 'running', config: config(3) }, [...items]))
    render(<KanbanTicketCard ticket={makeTicket()} />)
    expect(screen.queryByTestId('kanban-docflow-run-at-cap-run-live')).toBeNull()
    expect(card()).not.toHaveTextContent('At cap')
  })

  it('wears the dragon frame, gold only while at work In Progress', () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'running' }, [{ key: 'A1', status: 'running' }]))
    const { rerender } = render(<KanbanTicketCard ticket={makeTicket()} />)

    const dragon = (): HTMLElement => within(card()).getByTestId('ticket-elite-dragon')
    expect(dragon()).toHaveAttribute('data-look', 'gold')
    expect(dragon()).toHaveAttribute('data-active')
    expect(card().className).toContain('ticket-elite ')
    expect(card().className).toContain('ticket-elite-gold')
    expect(card().className).not.toContain('ticket-elite-silver')

    rerender(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    // Elsewhere the frame and the dragon turn silver.
    expect(dragon()).toHaveAttribute('data-look', 'silver')
    expect(dragon()).not.toHaveAttribute('data-active')
    expect(card().className).toContain('ticket-elite-silver')
    expect(card().className).not.toContain('ticket-elite-gold')
  })

  it('turns silver while the run is paused, even In Progress', () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'paused' }, [{ key: 'A1', status: 'merged' }]))
    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(within(card()).getByTestId('ticket-elite-dragon')).toHaveAttribute('data-look', 'silver')
    expect(card().className).toContain('ticket-elite-silver')
  })

  it('names the document in its footer, and says Error over the red perimeter of a run with issues', () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'completed' }, [{ key: 'A1', status: 'merged' }]))
    const { rerender } = render(
      <KanbanTicketCard
        ticket={makeTicket({ column: 'review', external_url: '/docs/billing-v2.md' })}
      />
    )

    expect(screen.getByTestId('kanban-docflow-run-footer-run-live')).toHaveTextContent(
      'billing-v2.md'
    )
    expect(within(card()).getByTestId('ticket-elite-dragon')).toHaveAttribute(
      'data-look',
      'silver-complete'
    )

    seedRuns(
      makeDetail({ id: 'run-live', status: 'completed_with_issues' }, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'needs_attention' }
      ])
    )
    rerender(
      <KanbanTicketCard
        ticket={makeTicket({ column: 'review', external_url: '/docs/billing-v2.md' })}
      />
    )

    expect(screen.getByTestId('kanban-docflow-run-footer-run-live')).toHaveTextContent(/^Error$/)
    expect(within(card()).getByTestId('ticket-elite-dragon')).toHaveAttribute('data-look', 'error')
    expect(card().className).toContain('!border-red-500/70')
    expect(card().className).not.toContain('ticket-elite-silver')
    expect(card().className).not.toContain('ticket-elite-gold')
  })

  it('wears the finished silver trim, not the red perimeter, over a run with a skipped ticket', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'completed' }, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'skipped' }
      ])
    )
    render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    expect(screen.getByTestId('kanban-docflow-run-run-live')).toHaveAttribute(
      'data-phase',
      'completed'
    )
    expect(screen.getByTestId('kanban-docflow-run-footer-run-live')).not.toHaveTextContent('Error')
    expect(within(card()).getByTestId('ticket-elite-dragon')).toHaveAttribute(
      'data-look',
      'silver-complete'
    )
    expect(card().className).toContain('ticket-elite-silver')
    expect(card().className).not.toContain('!border-red-500/70')
    expect(card().className).toContain('[--ticket-state-tone:#10b981]')
  })

  it('says a paused run is paused', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'paused' }, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'pending' }
      ])
    )
    render(<KanbanTicketCard ticket={makeTicket()} />)

    expect(screen.getByTestId('kanban-docflow-run-run-live')).toHaveAttribute('data-paused')
    expect(card().className).not.toContain('[--ticket-state-tone:#3b82f6]')
    expect(screen.getByTestId('kanban-docflow-run-running-run-live')).toHaveTextContent(/^Paused$/)
    expect(screen.getByTestId('kanban-docflow-run-progress-run-live')).toHaveTextContent(
      '1/2 merged'
    )
    // A run that is not moving shows how far it got instead.
    const bar = screen.getByTestId('kanban-docflow-run-bar-run-live')
    expect(bar).not.toHaveAttribute('data-moving')
    expect(bar).toHaveAttribute('aria-valuenow', '1')
    expect(bar).toHaveAttribute('aria-valuemax', '2')
  })

  it('follows the run while it works and stays once it has finished', () => {
    const running = makeDetail({ id: 'run-live', status: 'running', base_branch: 'main' }, [
      { key: 'A1', status: 'running' },
      { key: 'A2', status: 'running' }
    ])
    seedRuns(running)
    const { rerender } = render(<KanbanTicketCard ticket={makeTicket()} />)
    expect(screen.getByTestId('kanban-docflow-run-running-run-live')).toHaveTextContent('2 working')

    act(() => {
      useDocumentFlowStore.getState().applyItem({ ...running.items[1], status: 'merged' })
    })
    expect(screen.getByTestId('kanban-docflow-run-running-run-live')).toHaveTextContent('1 working')
    expect(screen.getByTestId('kanban-docflow-run-progress-run-live')).toHaveTextContent(
      '1/2 merged'
    )

    act(() => {
      useDocumentFlowStore.getState().applyItem({ ...running.items[0], status: 'merged' })
      useDocumentFlowStore.getState().applyRun({ ...running.run, status: 'completed' })
    })
    // The app moved the ticket to Review when the run ended.
    rerender(<KanbanTicketCard ticket={makeTicket({ column: 'review', unread: true })} />)

    const body = screen.getByTestId('kanban-docflow-run-run-live')
    expect(body).toHaveAttribute('data-phase', 'completed')
    expect(body).toHaveTextContent('Ready to merge into main')
    expect(body).toHaveTextContent('2/2 merged')
    expect(card().className).toContain('[--ticket-state-tone:#10b981]')
    expect(screen.getByTestId('ticket-unread-dot')).toBeInTheDocument()
  })

  it.each([
    ['completed_with_issues', 'issues', 'Finished · 1 not merged', '[--ticket-state-tone:#ef4444]'],
    ['cancelled', 'cancelled', 'Cancelled', '[--ticket-state-tone:var(--muted-foreground)]']
  ] as const)('shows how a %s run ended', (status, phase, label, tone) => {
    seedRuns(
      makeDetail({ id: 'run-live', status }, [
        { key: 'A1', status: 'merged' },
        { key: 'A2', status: 'needs_attention' }
      ])
    )
    render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    const body = screen.getByTestId('kanban-docflow-run-run-live')
    expect(body).toHaveAttribute('data-phase', phase)
    expect(screen.getByTestId('kanban-docflow-run-running-run-live')).toHaveTextContent(label)
    expect(body).toHaveTextContent('1/2 merged')
    // What a run left flagged is part of its result, not a question any more.
    expect(body).not.toHaveAttribute('data-waiting-on-user')
    expect(card().className).toContain(tone)
  })

  it.each(['completed', 'completed_with_issues'] as const)(
    'moves again, in its own color, while a session executes the migrations of a %s run',
    (status) => {
      seedRuns(
        makeDetail({ id: 'run-live', status, migration_session_id: 'session-mig' }, [
          { key: 'A1', status: 'merged' },
          { key: 'A2', status: 'needs_attention' }
        ])
      )
      // The server put the ticket back In Progress with the session.
      render(<KanbanTicketCard ticket={makeTicket()} />)

      const body = screen.getByTestId('kanban-docflow-run-run-live')
      expect(body).toHaveAttribute('data-phase', 'migrating')
      expect(body).not.toHaveAttribute('data-waiting-on-user')
      const bar = screen.getByTestId('kanban-docflow-run-bar-run-live')
      expect(bar).toHaveAttribute('data-moving')
      const progressbar = within(bar).getByRole('progressbar')
      expect(progressbar).toHaveAccessibleName('Running migrations')
      // A color no other state of a ticket wears.
      expect(progressbar.firstElementChild?.className).toContain('bg-fuchsia-500')
      expect(progressbar.firstElementChild?.className).not.toContain('bg-blue-500')
      const label = screen.getByTestId('kanban-docflow-run-running-run-live')
      expect(label).toHaveTextContent(/^Running migrations$/)
      expect(label.className).toContain('text-fuchsia-500')
      expect(screen.getByTestId('kanban-docflow-run-progress-run-live')).toHaveTextContent(
        '1/2 merged'
      )
      expect(card().className).toContain('[--ticket-state-tone:#d946ef]')
      expect(card().className).not.toContain('[--ticket-state-tone:#3b82f6]')
      expect(card().className).not.toContain('[--ticket-state-tone:#10b981]')
    }
  )

  it('turns orange, still migrating, when the migration session asks a question', () => {
    seedRuns(migratingRun())
    useQuestionStore.getState().addQuestion('session-mig', MIGRATION_QUESTION)
    render(<KanbanTicketCard ticket={makeTicket()} />)

    expectMigrationsWaiting()
    expect(screen.getByTestId('kanban-docflow-run-progress-run-live')).toHaveTextContent(
      '1/2 merged'
    )
  })

  it.each(['answering', 'permission', 'command_approval'] as const)(
    'turns orange, still migrating, when the migration session reports "%s"',
    (status) => {
      seedRuns(migratingRun())
      useWorktreeStatusStore.setState({
        sessionStatuses: { 'session-mig': { status, timestamp: Date.now() } }
      })
      render(<KanbanTicketCard ticket={makeTicket()} />)

      expectMigrationsWaiting()
    }
  )

  it('keeps the color of the migrations while their session works, or another one waits', () => {
    seedRuns(migratingRun())
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        'session-mig': { status: 'working', timestamp: Date.now() },
        'session-other': { status: 'permission', timestamp: Date.now() }
      }
    })
    useQuestionStore
      .getState()
      .addQuestion('session-other', { ...MIGRATION_QUESTION, sessionID: 'session-other' })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    expectMigrationsRunning()
  })

  it('follows the migration session as it asks and is answered', () => {
    seedRuns(migratingRun())
    render(<KanbanTicketCard ticket={makeTicket()} />)
    expectMigrationsRunning()

    act(() => {
      useQuestionStore.getState().addQuestion('session-mig', MIGRATION_QUESTION)
    })
    expectMigrationsWaiting()

    // Answered: the session is at it again.
    act(() => {
      useQuestionStore.getState().removeQuestion('session-mig', MIGRATION_QUESTION.id)
    })
    expectMigrationsRunning()
  })

  it('says how the run ended again once its migration session is over', () => {
    const detail = makeDetail(
      { id: 'run-live', status: 'completed', base_branch: 'main', migration_session_id: 's-mig' },
      [{ key: 'A1', status: 'merged' }]
    )
    seedRuns(detail)
    const { rerender } = render(<KanbanTicketCard ticket={makeTicket()} />)
    expect(screen.getByTestId('kanban-docflow-run-run-live')).toHaveAttribute(
      'data-phase',
      'migrating'
    )

    act(() => {
      useDocumentFlowStore.getState().applyRun({ ...detail.run, migration_session_id: null })
    })
    // The app moved the ticket back to Review when the session ended.
    rerender(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    const body = screen.getByTestId('kanban-docflow-run-run-live')
    expect(body).toHaveAttribute('data-phase', 'completed')
    expect(body).toHaveTextContent('Ready to merge into main')
    expect(screen.getByTestId('kanban-docflow-run-bar-run-live')).not.toHaveAttribute('data-moving')
    expect(card().className).toContain('[--ticket-state-tone:#10b981]')
    expect(card().className).not.toContain('[--ticket-state-tone:#d946ef]')
  })

  it('stops announcing the merge once the ticket is in Merged or Done', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'completed', base_branch: 'main' }, [
        { key: 'A1', status: 'merged' }
      ])
    )
    render(<KanbanTicketCard ticket={makeTicket({ column: 'done' })} />)

    expect(screen.getByTestId('kanban-docflow-run-running-run-live')).toHaveTextContent(
      /^Finished$/
    )
  })

  it('still renders, and opens the dashboard, after its integration worktree was archived', async () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'completed', base_branch: 'main' }, [
        { key: 'A1', status: 'merged' }
      ])
    )
    // Archiving a worktree detaches its tickets.
    render(<KanbanTicketCard ticket={makeTicket({ column: 'done', worktree_id: null })} />)

    expect(screen.getByTestId('kanban-docflow-run-progress-run-live')).toHaveTextContent(
      '1/1 merged'
    )
    await act(async () => {
      fireEvent.click(card())
    })
    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-live')
  })

  it('fetches a run that is not in the list, and says so when its record is gone', async () => {
    const detail = makeDetail({ id: 'run-old', status: 'completed', base_branch: 'main' }, [
      { key: 'A1', status: 'merged' }
    ])
    api.get.mockImplementation(async (runId: string) => (runId === 'run-old' ? detail : null))
    render(
      <>
        <KanbanTicketCard ticket={makeTicket({ id: 'ticket-old', external_id: 'run-old' })} />
        <KanbanTicketCard ticket={makeTicket({ id: 'ticket-gone', external_id: 'run-gone' })} />
      </>
    )

    await waitFor(() =>
      expect(screen.getByTestId('kanban-docflow-run-progress-run-old')).toHaveTextContent(
        '1/1 merged'
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('kanban-docflow-run-missing-run-gone')).toHaveTextContent(
        'Run record missing'
      )
    )
    expect(screen.getByTestId('kanban-docflow-run-run-gone')).toHaveAttribute('data-run-missing')
    expect(screen.queryByTestId('kanban-docflow-run-progress-run-gone')).toBeNull()

    // Nothing to open: the ticket is all that is left.
    fireEvent.click(card('ticket-gone'))
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
    expect(toast.info).toHaveBeenCalledWith(
      'The record of this document run was deleted. Only its ticket is left.'
    )
  })

  it('does not call a run missing because it could not be fetched', async () => {
    api.get.mockRejectedValue(new Error('WebSocket is closed'))
    render(<KanbanTicketCard ticket={makeTicket({ external_id: 'run-unreachable' })} />)
    await act(async () => {})

    expect(screen.getByTestId('kanban-docflow-run-marker-run-unreachable')).toBeInTheDocument()
    expect(screen.queryByTestId('kanban-docflow-run-missing-run-unreachable')).toBeNull()
  })

  it('opens the run dashboard on click, never the ticket modal', async () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'running' }))
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await act(async () => {
      fireEvent.click(card())
    })

    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-live')
    expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
    expect(useKanbanStore.getState().selectedTicketId).toBeNull()
  })

  describe('before the run is launched, in To Do', () => {
    const todoTicket = (): KanbanTicket => makeTicket({ column: 'todo', worktree_id: null })

    it('wears a blue dragon, a moving bar and "Extracting", and cannot be dragged, while extracting', () => {
      seedRuns(makeDetail({ id: 'run-live', status: 'extracting' }, []))
      render(<KanbanTicketCard ticket={todoTicket()} />)

      expect(within(card()).getByTestId('ticket-elite-dragon')).toHaveAttribute('data-look', 'blue')
      expect(card()).toHaveAttribute('draggable', 'false')
      expect(card().className).toContain('ticket-elite-silver')
      expect(card().className).toContain('[--ticket-state-tone:#3b82f6]')
      const body = screen.getByTestId('kanban-docflow-run-run-live')
      expect(body).toHaveAttribute('data-phase', 'extracting')
      expect(screen.getByTestId('kanban-docflow-run-bar-run-live')).toHaveAttribute('data-moving')
      const label = screen.getByTestId('kanban-docflow-run-running-run-live')
      expect(label).toHaveTextContent(/^Extracting tickets…$/)
      expect(label.className).toContain('text-blue-500')
      // Nothing merged to count yet.
      expect(screen.queryByTestId('kanban-docflow-run-progress-run-live')).toBeNull()
    })

    it('turns the dragon green, says it is ready and counts the tickets, draggable again, once extracted', () => {
      seedRuns(
        makeDetail({ id: 'run-live', status: 'preview' }, [
          { key: 'A1' },
          { key: 'A2' },
          { key: 'A3', selected: false }
        ])
      )
      render(<KanbanTicketCard ticket={todoTicket()} />)

      expect(within(card()).getByTestId('ticket-elite-dragon')).toHaveAttribute(
        'data-look',
        'green'
      )
      expect(card()).toHaveAttribute('draggable', 'true')
      expect(card().className).toContain('[--ticket-state-tone:#10b981]')
      expect(screen.getByTestId('kanban-docflow-run-run-live')).toHaveAttribute(
        'data-phase',
        'ready'
      )
      const bar = screen.getByTestId('kanban-docflow-run-bar-run-live')
      expect(bar).not.toHaveAttribute('data-moving')
      expect(bar.firstElementChild?.className).toContain('bg-emerald-500')
      expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%')
      const label = screen.getByTestId('kanban-docflow-run-running-run-live')
      expect(label).toHaveTextContent(/^Ready to launch$/)
      expect(label.className).toContain('text-emerald-500')
      expect(screen.getByTestId('kanban-docflow-run-progress-run-live')).toHaveTextContent(
        '2 tickets'
      )
    })

    it('wears the red perimeter, held in place, when the extraction failed', () => {
      seedRuns(makeDetail({ id: 'run-live', status: 'extract_failed', error: 'No JSON' }, []))
      render(<KanbanTicketCard ticket={todoTicket()} />)

      expect(within(card()).getByTestId('ticket-elite-dragon')).toHaveAttribute(
        'data-look',
        'error'
      )
      expect(card()).toHaveAttribute('draggable', 'false')
      expect(card().className).toContain('ring-red-500/25')
      expect(card().className).toContain('[--ticket-state-tone:#ef4444]')
      expect(screen.getByTestId('kanban-docflow-run-running-run-live')).toHaveTextContent(
        /^Extraction failed$/
      )
      expect(screen.getByTestId('kanban-docflow-run-footer-run-live')).toHaveTextContent('Error')
    })

    it('is held in place until its run is known', () => {
      render(<KanbanTicketCard ticket={todoTicket()} />)

      expect(card()).toHaveAttribute('draggable', 'false')
    })

    it.each(['extracting', 'preview', 'extract_failed'] as const)(
      'opens the Implement document dialog on its run, not the dashboard, on click (%s)',
      async (status) => {
        seedRuns(makeDetail({ id: 'run-live', status }))
        render(<KanbanTicketCard ticket={todoTicket()} />)

        await act(async () => {
          fireEvent.click(card())
        })

        expect(useDocumentFlowStore.getState().wizard).toEqual({
          open: true,
          projectId: 'proj-1',
          runId: 'run-live'
        })
        expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
        expect(useKanbanStore.getState().selectedTicketRef).toBeNull()
      }
    )

    it('opens the dialog from its menu too', async () => {
      seedRuns(makeDetail({ id: 'run-live', status: 'preview' }))
      render(<KanbanTicketCard ticket={todoTicket()} />)

      fireEvent.contextMenu(card())
      const item = await screen.findByTestId('ctx-open-document-run')
      await act(async () => {
        fireEvent.click(item)
      })

      expect(useDocumentFlowStore.getState().wizard).toMatchObject({
        open: true,
        runId: 'run-live'
      })
      expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
    })
  })

  it('leaves clicks to the board while it is in dependency mode', () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'running' }))
    useKanbanStore.setState({
      dependencyMode: { active: true, sourceTicketId: 'ticket-1', sourceProjectId: null }
    })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    fireEvent.click(card())

    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
  })

  it('offers what fits a run in its menu and nothing that needs a session of its own', async () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'completed' }, [{ key: 'A1', status: 'merged' }]))
    render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    fireEvent.contextMenu(card())

    const open = await screen.findByTestId('ctx-open-document-run')
    expect(screen.getByTestId('ctx-open-document')).toBeInTheDocument()
    for (const absent of [
      'ctx-assign-worktree',
      'ctx-change-worktree',
      'ctx-unassign-worktree',
      'ctx-jump-to-session',
      'ctx-toggle-auto-approve',
      'ctx-dependencies-submenu',
      'ctx-duplicate-ticket',
      'ctx-add-to-favorites',
      'ctx-move-to-project',
      // Not an imported ticket either: there is no remote status to update.
      'ctx-update-remote-status'
    ]) {
      expect(screen.queryByTestId(absent), absent).toBeNull()
    }
    expect(screen.getByTestId('ctx-mark-submenu')).toBeInTheDocument()
    expect(screen.getByTestId('ctx-delete-ticket')).toBeInTheDocument()

    fireEvent.click(open)
    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-live')
  })

  it('opens the document from the menu, from the path kept on the ticket, even when the run record is gone', async () => {
    api.get.mockResolvedValue(null)
    render(
      <KanbanTicketCard
        ticket={makeTicket({
          external_id: 'run-gone',
          external_url: '/docs/checkout-redesign.html'
        })}
      />
    )
    await screen.findByTestId('kanban-docflow-run-missing-run-gone')

    fireEvent.contextMenu(card())
    fireEvent.click(await screen.findByTestId('ctx-open-document'))

    await waitFor(() =>
      expect(projectApi.openPath).toHaveBeenCalledWith('/docs/checkout-redesign.html')
    )
    expect(toast.info).not.toHaveBeenCalled()
  })

  it("falls back to the run's own path for a ticket from before the path was kept on it", async () => {
    seedRuns(makeDetail({ id: 'run-live', source_path: '/docs/older-spec.html' }))
    render(<KanbanTicketCard ticket={makeTicket({ external_url: null })} />)

    fireEvent.contextMenu(card())
    fireEvent.click(await screen.findByTestId('ctx-open-document'))

    await waitFor(() => expect(projectApi.openPath).toHaveBeenCalledWith('/docs/older-spec.html'))
  })

  it('says so when the document to open was deleted', async () => {
    projectApi.openPath.mockResolvedValue('Failed to open path')
    seedRuns(makeDetail({ id: 'run-live' }))
    render(<KanbanTicketCard ticket={makeTicket({ external_url: '/docs/gone.html' })} />)

    fireEvent.contextMenu(card())
    fireEvent.click(await screen.findByTestId('ctx-open-document'))

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('The document was deleted from disk.')
    )
  })

  it('offers nothing to open when neither the ticket nor a run knows the document', async () => {
    api.get.mockResolvedValue(null)
    render(
      <KanbanTicketCard ticket={makeTicket({ external_id: 'run-gone', external_url: null })} />
    )
    await screen.findByTestId('kanban-docflow-run-missing-run-gone')

    fireEvent.contextMenu(card())

    await screen.findByTestId('ctx-open-document-run')
    expect(screen.queryByTestId('ctx-open-document')).toBeNull()
  })

  it('refuses to delete the ticket of a run that is still going', async () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'paused' }))
    const deleteTicket = vi.fn()
    useKanbanStore.setState({ deleteTicket })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    fireEvent.contextMenu(card())
    fireEvent.click(await screen.findByTestId('ctx-delete-ticket'))

    expect(toast.warning).toHaveBeenCalledWith(
      'Cancel the document run before deleting its ticket.'
    )
    expect(screen.queryByTestId('ctx-delete-confirm-dialog')).toBeNull()
    expect(deleteTicket).not.toHaveBeenCalled()
  })

  it("refuses to delete the ticket while a session executes the run's migrations", async () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'completed', migration_session_id: 'session-mig' }, [
        { key: 'A1', status: 'merged' }
      ])
    )
    const deleteTicket = vi.fn()
    useKanbanStore.setState({ deleteTicket })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    fireEvent.contextMenu(card())
    fireEvent.click(await screen.findByTestId('ctx-delete-ticket'))

    expect(toast.warning).toHaveBeenCalledWith(
      'Stop the migrations of the document run before deleting its ticket.'
    )
    expect(screen.queryByTestId('ctx-delete-confirm-dialog')).toBeNull()
    expect(deleteTicket).not.toHaveBeenCalled()
  })

  it('deletes the ticket of a finished run after a confirmation that names the run record', async () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'cancelled' }))
    const deleteTicket = vi.fn().mockResolvedValue(undefined)
    useKanbanStore.setState({ deleteTicket })
    render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    fireEvent.contextMenu(card())
    fireEvent.click(await screen.findByTestId('ctx-delete-ticket'))

    const dialog = await screen.findByTestId('ctx-delete-confirm-dialog')
    expect(dialog).toHaveTextContent('Delete document run')
    expect(dialog).toHaveTextContent(
      'Its run record (progress, report and log) is deleted with it. The run’s tickets, branches and worktrees are kept.'
    )
    expect(deleteTicket).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByTestId('ctx-delete-confirm-btn'))
    })

    expect(deleteTicket).toHaveBeenCalledWith('ticket-run', 'proj-1')
    expect(toast.success).toHaveBeenCalledWith('Document run deleted')
  })

  it('passes on why the server refused a delete', async () => {
    // Another window still has the run as finished while it was resumed elsewhere.
    seedRuns(makeDetail({ id: 'run-live', status: 'cancelled' }))
    useKanbanStore.setState({
      deleteTicket: vi
        .fn()
        .mockRejectedValue(new Error('Cancel the run before deleting its ticket.'))
    })
    render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    fireEvent.contextMenu(card())
    fireEvent.click(await screen.findByTestId('ctx-delete-ticket'))
    await act(async () => {
      fireEvent.click(await screen.findByTestId('ctx-delete-confirm-btn'))
    })

    expect(toast.error).toHaveBeenCalledWith('Cancel the run before deleting its ticket.')
  })
})

describe('an ordinary ticket', () => {
  it('shows nothing of a document run and keeps its menu', async () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'running' }))
    render(
      <KanbanTicketCard
        ticket={makeTicket({ id: 'ticket-1', external_provider: null, external_id: null })}
      />
    )

    expect(screen.queryByTestId('kanban-docflow-run-run-live')).toBeNull()
    expect(api.get).not.toHaveBeenCalled()

    fireEvent.contextMenu(card('ticket-1'))
    expect(await screen.findByTestId('ctx-duplicate-ticket')).toBeInTheDocument()
    expect(screen.getByTestId('ctx-dependencies-submenu')).toBeInTheDocument()
    expect(screen.queryByTestId('ctx-open-document-run')).toBeNull()

    fireEvent.click(card('ticket-1'))
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
    expect(useKanbanStore.getState().selectedTicketRef).toEqual({
      projectId: 'proj-1',
      ticketId: 'ticket-1'
    })
  })
})

// A launched git run: one integration branch, cut from main
const launchedGitRun = (): DocumentRunDetail =>
  makeDetail(
    {
      id: 'run-live',
      status: 'completed',
      base_branch: 'main',
      base_sha: '1111111aaaaaaa',
      integration_branch: 'doc-checkout-redesign',
      integration_worktree_id: 'wt-integration',
      integration_worktree_path: '/worktrees/shop--doc-checkout-redesign'
    },
    [{ key: 'A1', status: 'merged' }]
  )

const MEMBERS: DocumentRunMember[] = [
  {
    project_id: 'web',
    project_name: 'Web',
    project_path: '/repo/web',
    symlink_name: 'web',
    base_branch: 'main',
    base_sha: 'aaaaaaa1111111',
    integration_branch: 'doc-checkout',
    integration_worktree_id: 'wt-web-int',
    integration_worktree_path: '/worktrees/web--doc-checkout'
  },
  {
    project_id: 'api',
    project_name: 'API',
    project_path: '/repo/api',
    symlink_name: 'api',
    base_branch: 'master',
    base_sha: 'bbbbbbb2222222',
    integration_branch: 'doc-checkout',
    integration_worktree_id: 'wt-api-int',
    integration_worktree_path: '/worktrees/api--doc-checkout'
  }
]

// A launched connection run: an integration branch in each of two member repositories
const launchedConnectionRun = (): DocumentRunDetail =>
  makeDetail(
    {
      id: 'run-live',
      status: 'completed',
      base_branch: 'main + master',
      integration_branch: 'doc-checkout',
      integration_connection_id: 'conn-int',
      integration_connection_path: '/connections/doc-checkout',
      members: MEMBERS
    },
    [{ key: 'A1', status: 'merged' }]
  )

describe('the PRs of a document run ticket', () => {
  const prButton = (): HTMLElement | null =>
    screen.queryByTestId('kanban-docflow-run-pr-button-run-live')

  it('offers nothing before the run is launched: there is no integration branch yet', () => {
    seedRuns(makeDetail({ id: 'run-live', status: 'preview' }))
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: null, column: 'todo' })} />)

    expect(screen.queryByTestId('kanban-docflow-run-prs-run-live')).toBeNull()
  })

  it('has no PR button on the card: it is in the run dashboard the card opens', () => {
    seedRuns(launchedConnectionRun())
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: null, column: 'review' })} />)

    expect(prButton()).toBeNull()
    expect(within(card()).queryByText(/^Create PRs?$/)).toBeNull()
    // Without a PR yet there is no PR row at all.
    expect(screen.queryByTestId('kanban-docflow-run-prs-run-live')).toBeNull()
  })

  it('lists the PRs the integration branches have, named after their repositories, and opens them', () => {
    seedRuns(launchedConnectionRun())
    useGitStore.getState().setAttachedPR('wt-web-int', {
      number: 12,
      url: 'https://github.com/acme/web/pull/12'
    })
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: null, column: 'review' })} />)

    const webLink = screen.getByTestId('kanban-docflow-run-pr-link-run-live-wt-web-int')
    expect(webLink).toHaveTextContent(/^Web #12$/)
    expect(screen.queryByTestId('kanban-docflow-run-pr-link-run-live-wt-api-int')).toBeNull()
    expect(prButton()).toBeNull()

    fireEvent.click(webLink)
    expect(systemApi.openInChrome).toHaveBeenCalledWith('https://github.com/acme/web/pull/12')
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()

    act(() => {
      useGitStore.getState().setAttachedPR('wt-api-int', {
        number: 3,
        url: 'https://github.com/acme/api/pull/3'
      })
    })
    expect(screen.getByTestId('kanban-docflow-run-pr-link-run-live-wt-api-int')).toHaveTextContent(
      /^API #3$/
    )
  })

  it("shows a git run's PR from its ticket, once, in the PR row rather than the pill row", () => {
    seedRuns(launchedGitRun())
    render(
      <KanbanTicketCard
        ticket={makeTicket({
          column: 'review',
          github_pr_number: 7,
          github_pr_url: 'https://github.com/acme/shop/pull/7'
        })}
      />
    )

    const link = screen.getByTestId('kanban-docflow-run-pr-link-run-live-wt-integration')
    expect(link).toHaveTextContent(/^#7$/)
    expect(within(card()).getAllByTitle('Open PR #7 in browser')).toHaveLength(1)
  })

  it('is still in the context menu', async () => {
    seedRuns(launchedConnectionRun())
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: null, column: 'review' })} />)

    fireEvent.contextMenu(card())
    const item = await screen.findByTestId('ctx-create-run-prs')
    expect(item).toHaveTextContent(/^Create PRs$/)
    fireEvent.click(item)

    await waitFor(() => expect(runPRs.createDocumentRunPRs).toHaveBeenCalledTimes(1))
    expect(runPRs.createDocumentRunPRs).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-live', members: MEMBERS })
    )
  })
})

describe('the card of a task ticket of a document run', () => {
  // A plain board ticket (no document-run external ref) that one of the run's items points at.
  const taskTicket = (overrides: Partial<KanbanTicket> = {}): KanbanTicket =>
    makeTicket({
      id: 'ticket-a2',
      title: 'Cart totals',
      column: 'review',
      worktree_id: 'wt-a2',
      external_provider: null,
      external_id: null,
      ...overrides
    })

  it('says "In merge queue" in Review while the run merges another ticket first', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [
        { key: 'A1', status: 'merging', ticket_id: 'ticket-a1' },
        { key: 'A2', status: 'ready', ticket_id: 'ticket-a2' }
      ])
    )
    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={taskTicket()} />
      </TooltipProvider>
    )

    expect(screen.getByTestId('kanban-ticket-merge-queue')).toHaveTextContent('In merge queue')
  })

  it('says "Waiting in document edit queue" once merged, with its place and who is editing', async () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running', source_path: '/docs/checkout.html' }, [
        {
          key: 'A1',
          status: 'merged',
          ticket_id: 'ticket-a1',
          document_update_status: 'updating'
        },
        { key: 'A2', status: 'merged', ticket_id: 'ticket-a2', document_update_status: 'queued' }
      ])
    )
    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={taskTicket({ column: 'merged' })} />
      </TooltipProvider>
    )

    const pill = screen.getByTestId('kanban-ticket-doc-edit-queue')
    expect(pill).toHaveTextContent(/^Waiting in document edit queue$/)
    expect(pill.className).toContain('text-pink-500')
    expect(pill.querySelector('svg')).not.toBeNull()
    expect(screen.queryByTestId('kanban-ticket-editing-document')).toBeNull()

    // The tooltip's popper measures itself, which jsdom cannot
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    try {
      fireEvent.focus(pill)
      expect(await screen.findByRole('tooltip')).toHaveTextContent(
        'Merged. The orchestrator updates checkout.html one ticket at a time — #1 in queue; A1 is editing it now.'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows the pink "Editing document" bar while its session edits the document, in any column', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [
        {
          key: 'A2',
          status: 'merged',
          ticket_id: 'ticket-a2',
          session_id: 'session-a2',
          document_update_status: 'updating'
        }
      ])
    )
    for (const column of ['merged', 'in_progress'] as const) {
      const { unmount } = render(
        <TooltipProvider>
          <KanbanTicketCard
            ticket={taskTicket({ column, current_session_id: 'session-a2', mode: 'build' })}
          />
        </TooltipProvider>
      )

      const slot = screen.getByTestId('kanban-ticket-editing-document')
      expect(slot, column).toHaveTextContent('Editing document')
      const progressbar = within(slot).getByRole('progressbar')
      expect(progressbar).toHaveAccessibleName('Editing document')
      expect(progressbar.firstElementChild?.className).toContain('bg-pink-500')
      expect(screen.queryByTestId('kanban-ticket-doc-edit-queue')).toBeNull()
      expect(screen.queryByTestId('kanban-ticket-progress')).toBeNull()
      unmount()
    }
  })

  it('opens the ticket like a busy card when its "Editing document" bar is clicked', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [
        { key: 'A2', status: 'merged', ticket_id: 'ticket-a2', document_update_status: 'updating' }
      ])
    )
    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={taskTicket({ column: 'merged' })} />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByTestId('kanban-ticket-editing-document'))
    expect(useKanbanStore.getState().selectedTicketRef).toEqual({
      projectId: 'proj-1',
      ticketId: 'ticket-a2'
    })
  })

  it('says it waits for the user, without a moving bar, once the editing session stopped for them', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [
        {
          key: 'A2',
          status: 'merged',
          ticket_id: 'ticket-a2',
          session_id: 'session-a2',
          document_update_status: 'updating',
          document_update_detail: DOCUMENT_UPDATE_INTERRUPT_DETAIL
        }
      ])
    )
    render(
      <TooltipProvider>
        <KanbanTicketCard
          ticket={taskTicket({ column: 'merged', current_session_id: 'session-a2', mode: 'build' })}
        />
      </TooltipProvider>
    )

    const slot = screen.getByTestId('kanban-ticket-editing-document')
    expect(within(slot).getByTestId('kanban-ticket-document-edit-waiting')).toHaveTextContent(
      'Waiting for you'
    )
    expect(within(slot).queryByRole('progressbar')).toBeNull()
    expect(slot).not.toHaveTextContent('Editing document')
  })

  it('falls back to the orange Question when the editing session asks', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [
        {
          key: 'A2',
          status: 'merged',
          ticket_id: 'ticket-a2',
          session_id: 'session-a2',
          document_update_status: 'updating',
          document_update_detail: DOCUMENT_UPDATE_INTERRUPT_DETAIL
        }
      ])
    )
    useWorktreeStatusStore.setState({
      sessionStatuses: { 'session-a2': { status: 'answering', timestamp: Date.now() } }
    })
    render(
      <TooltipProvider>
        <KanbanTicketCard
          ticket={taskTicket({ column: 'merged', current_session_id: 'session-a2', mode: 'build' })}
        />
      </TooltipProvider>
    )

    expect(screen.queryByTestId('kanban-ticket-editing-document')).toBeNull()
    const busy = screen.getByTestId('kanban-ticket-progress')
    expect(busy).toHaveTextContent('Question')
    const progressbar = within(busy).getByRole('progressbar')
    expect(progressbar).toHaveAccessibleName('Waiting for answer')
    expect(progressbar.firstElementChild?.className).not.toContain('bg-pink-500')
  })

  it('says nothing about the document once its update is done, or the run is over', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [
        { key: 'A2', status: 'merged', ticket_id: 'ticket-a2', document_update_status: 'done' }
      ])
    )
    const { unmount } = render(
      <TooltipProvider>
        <KanbanTicketCard ticket={taskTicket({ column: 'merged' })} />
      </TooltipProvider>
    )
    expect(screen.queryByTestId('kanban-ticket-doc-edit-queue')).toBeNull()
    expect(screen.queryByTestId('kanban-ticket-editing-document')).toBeNull()
    unmount()

    seedRuns(
      makeDetail({ id: 'run-live', status: 'cancelled' }, [
        { key: 'A2', status: 'merged', ticket_id: 'ticket-a2', document_update_status: 'queued' }
      ])
    )
    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={taskTicket({ column: 'merged' })} />
      </TooltipProvider>
    )
    expect(screen.queryByTestId('kanban-ticket-doc-edit-queue')).toBeNull()
  })

  it('says nothing about the queue when its merge is up next, or outside Review', () => {
    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [
        { key: 'A1', status: 'running', ticket_id: 'ticket-a1' },
        { key: 'A2', status: 'ready', ticket_id: 'ticket-a2' }
      ])
    )
    const { unmount } = render(
      <TooltipProvider>
        <KanbanTicketCard ticket={taskTicket()} />
      </TooltipProvider>
    )
    expect(screen.queryByTestId('kanban-ticket-merge-queue')).toBeNull()
    unmount()

    seedRuns(
      makeDetail({ id: 'run-live', status: 'running' }, [
        { key: 'A1', status: 'merging', ticket_id: 'ticket-a1' },
        { key: 'A2', status: 'ready', ticket_id: 'ticket-a2' }
      ])
    )
    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={taskTicket({ column: 'in_progress' })} />
      </TooltipProvider>
    )
    expect(screen.queryByTestId('kanban-ticket-merge-queue')).toBeNull()
  })
})
