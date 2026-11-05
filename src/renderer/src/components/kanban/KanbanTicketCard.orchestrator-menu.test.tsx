/**
 * Orchestrators made from board tickets, on the card: an ordinary ticket's "Orchestrator"
 * submenu (start one from it, add it to one of the project's, open the run it is part of, take
 * it out while it has not launched), the copy and the "Add tickets…" item of an orchestrator's
 * own ticket, and the right-drag quick launch refused for a ticket its run will launch.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../../main/db/types'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import type { DocumentRunDetail, DocumentRunItem } from '@shared/types/document-flow'

// Radix opens a context menu slowly under jsdom here (see the other card-menu suites)
vi.setConfig({ testTimeout: 120_000 })

const api = vi.hoisted(() => ({
  get: vi.fn(),
  addTickets: vi.fn(),
  removeItem: vi.fn()
}))
const launches = vi.hoisted(() => ({
  quickLaunchTicket: vi.fn(async () => true),
  quickLaunchTicketOnConnection: vi.fn(async () => true)
}))
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/lib/toast', () => ({ toast: toastMock }))
vi.mock('@/components/kanban/WorktreePickerModal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./WorktreePickerModal')>()),
  ...launches
}))

import { KanbanTicketCard } from './KanbanTicketCard'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

const initialFlowState = useDocumentFlowStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialConnectionState = useConnectionStore.getState()

const now = '2026-06-01T00:00:00.000Z'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Checkout button',
    description: 'Make it blue.',
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: now,
    updated_at: now,
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
    ticket_prefix: 'TD',
    ticket_number: 7,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  }
}

/** An orchestrator of proj-1 made from board tickets. */
function ticketRun(
  id: string,
  run: Partial<DocumentRunDetail['run']> = {},
  items: Partial<DocumentRunItem>[] = []
): DocumentRunDetail {
  return makeDetail(
    {
      id,
      project_id: 'proj-1',
      title: `Run ${id}`,
      source_kind: 'tickets',
      source_path: '',
      status: 'running',
      ticket_id: `ticket-${id}`,
      integration_worktree_id: `wt-${id}`,
      ...run
    },
    items
  )
}

function seedRuns(...details: DocumentRunDetail[]): void {
  useDocumentFlowStore.setState({
    runsById: Object.fromEntries(details.map((detail) => [detail.run.id, detail]))
  })
}

/** The project's worktrees as loaded from the database: these checkouts and no others. */
function seedWorktrees(...ids: string[]): void {
  useWorktreeStore.setState({
    worktreesByProject: new Map([['proj-1', ids.map((id) => ({ id }))]]),
    loadedProjectIds: new Set(['proj-1'])
  } as never)
}

const card = (id = 'ticket-1'): HTMLElement => screen.getByTestId(`kanban-ticket-${id}`)

/** Open the card's menu, then its Orchestrator submenu. */
async function openOrchestratorMenu(id = 'ticket-1'): Promise<void> {
  fireEvent.contextMenu(card(id))
  const trigger = await screen.findByTestId('ctx-orchestrator-submenu')
  fireEvent.keyDown(trigger, { key: 'ArrowRight' })
  await screen.findByTestId('ctx-orchestrator-new')
}

const isDisabled = (element: HTMLElement): boolean =>
  element.hasAttribute('data-disabled') || element.getAttribute('aria-disabled') === 'true'

// floating-ui probes every positioned element with matches(':popover-open') and
// matches(':modal'); jsdom recurses on them for seconds per menu. Answer them directly.
const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches

beforeAll(() => {
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})

afterAll(() => {
  Element.prototype.matches = originalMatches
})

beforeEach(() => {
  api.get.mockImplementation(
    async (runId: string) => useDocumentFlowStore.getState().runsById[runId] ?? null
  )
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.clearAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useKanbanStore.setState(initialKanbanState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
  useConnectionStore.setState(initialConnectionState, true)
})

describe("an ordinary ticket's Orchestrator submenu", () => {
  it('starts a new orchestrator with the ticket picked', async () => {
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await openOrchestratorMenu()
    fireEvent.click(screen.getByTestId('ctx-orchestrator-new'))

    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'proj-1',
      runId: null,
      source: 'tickets',
      preselectedTicketIds: ['ticket-1']
    })
  })

  it("adds the ticket to one of the project's orchestrators", async () => {
    const running = ticketRun('run-a', { title: 'Checkout' })
    seedRuns(
      running,
      ticketRun('run-other-project', { project_id: 'proj-2' }),
      ticketRun('run-cancelled', { status: 'cancelled' }),
      makeDetail({ id: 'doc-run', project_id: 'proj-1', status: 'running' }, [])
    )
    api.addTickets.mockResolvedValue(
      ticketRun('run-a', { title: 'Checkout' }, [{ key: 'TD-7', ticket_id: 'ticket-1' }])
    )
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await openOrchestratorMenu()
    // Only the project's orchestrators that take tickets are listed
    expect(screen.queryByTestId('ctx-orchestrator-add-run-other-project')).toBeNull()
    expect(screen.queryByTestId('ctx-orchestrator-add-run-cancelled')).toBeNull()
    expect(screen.queryByTestId('ctx-orchestrator-add-doc-run')).toBeNull()
    const add = screen.getByTestId('ctx-orchestrator-add-run-a')
    expect(add).toHaveTextContent('Add to “Checkout”')
    await act(async () => {
      fireEvent.click(add)
    })

    expect(api.addTickets).toHaveBeenCalledWith({ runId: 'run-a', ticketIds: ['ticket-1'] })
    expect(toastMock.success).toHaveBeenCalledWith('Added to “Checkout”')
    expect(useDocumentFlowStore.getState().runsById['run-a'].items).toHaveLength(1)
  })

  it('says a finished orchestrator resumes, and passes on a refusal from the server', async () => {
    seedRuns(ticketRun('run-done', { status: 'completed', title: 'Done run' }))
    api.addTickets.mockRejectedValue(new Error('The run is being cancelled.'))
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await openOrchestratorMenu()
    const add = screen.getByTestId('ctx-orchestrator-add-run-done')
    expect(add).toHaveTextContent('It finished: the run resumes.')
    await act(async () => {
      fireEvent.click(add)
    })

    expect(toastMock.error).toHaveBeenCalledWith('The run is being cancelled.')
  })

  it('does not offer a finished orchestrator whose integration worktree is gone', async () => {
    // Merged and archived with the run's ticket: the server would refuse the add
    seedRuns(
      ticketRun('run-gone', { status: 'completed', created_at: '2026-03-01T00:00:00.000Z' }),
      ticketRun('run-issues', { status: 'completed_with_issues' }),
      ticketRun('run-kept', { status: 'completed' }),
      // Nothing to resume: a running run needs no checkout listed to take the ticket
      ticketRun('run-live')
    )
    seedWorktrees('wt-run-kept')
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await openOrchestratorMenu()

    expect(screen.queryByTestId('ctx-orchestrator-add-run-gone')).toBeNull()
    expect(screen.queryByTestId('ctx-orchestrator-add-run-issues')).toBeNull()
    expect(screen.getByTestId('ctx-orchestrator-add-run-kept')).toHaveTextContent(
      'It finished: the run resumes.'
    )
    expect(screen.getByTestId('ctx-orchestrator-add-run-live')).toBeInTheDocument()
  })

  it('does not let dead runs push a live one out of the menu', async () => {
    const newerThanLive = (index: number): DocumentRunDetail =>
      ticketRun(`run-dead-${index}`, {
        status: 'completed',
        created_at: `2026-03-0${index + 1}T00:00:00.000Z`
      })
    seedRuns(
      ticketRun('run-older-live', { created_at: '2026-01-01T00:00:00.000Z' }),
      ...[0, 1, 2, 3, 4].map(newerThanLive)
    )
    seedWorktrees()
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await openOrchestratorMenu()

    expect(screen.getByTestId('ctx-orchestrator-add-run-older-live')).toBeInTheDocument()
    expect(screen.queryByTestId('ctx-orchestrator-add-run-dead-4')).toBeNull()
  })

  it('does not offer a finished run on a connection project whose instance is gone', async () => {
    const onConnection = (id: string, connectionId: string): DocumentRunDetail =>
      ticketRun(id, {
        status: 'completed',
        integration_worktree_id: null,
        integration_connection_id: connectionId
      })
    seedRuns(onConnection('run-gone', 'conn-gone'), onConnection('run-kept', 'conn-kept'))
    useConnectionStore.setState({
      loaded: true,
      connections: [
        { id: 'conn-kept', status: 'active' },
        { id: 'conn-gone', status: 'archived' }
      ]
    } as never)
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await openOrchestratorMenu()

    expect(screen.queryByTestId('ctx-orchestrator-add-run-gone')).toBeNull()
    expect(screen.getByTestId('ctx-orchestrator-add-run-kept')).toBeInTheDocument()
  })

  it('refuses nothing on a list that has not loaded', async () => {
    seedRuns(
      ticketRun('run-done', { status: 'completed' }),
      ticketRun('run-connection', {
        status: 'completed',
        integration_worktree_id: null,
        integration_connection_id: 'conn-1'
      })
    )
    // A worktree created for a project never loaded makes an entry that is not the whole list
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj-1', [{ id: 'wt-new' }]]]),
      loadedProjectIds: new Set()
    } as never)
    useConnectionStore.setState({ loaded: false, connections: [] })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await openOrchestratorMenu()

    expect(screen.getByTestId('ctx-orchestrator-add-run-done')).toBeInTheDocument()
    expect(screen.getByTestId('ctx-orchestrator-add-run-connection')).toBeInTheDocument()
  })

  it('refuses nothing when the connections failed to load, which reads as an empty list', async () => {
    seedRuns(
      ticketRun('run-connection', {
        status: 'completed',
        integration_worktree_id: null,
        integration_connection_id: 'conn-1'
      })
    )
    useConnectionStore.setState({ loaded: true, connections: [], error: 'no database' })
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await openOrchestratorMenu()

    expect(screen.getByTestId('ctx-orchestrator-add-run-connection')).toBeInTheDocument()
  })

  it('does not offer a finished orchestrator the ticket is still part of', async () => {
    // Skipped there, back in To Do: adding it again would change nothing (the server leaves
    // a ticket already in the run as it is), so "the run resumes" would not be true
    seedRuns(
      ticketRun('run-done', { status: 'completed', title: 'Done run' }, [
        { key: 'TD-7', ticket_id: 'ticket-1', status: 'skipped' }
      ]),
      ticketRun('run-other', { status: 'completed', title: 'Other run' })
    )
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await openOrchestratorMenu()

    expect(screen.queryByTestId('ctx-orchestrator-add-run-done')).toBeNull()
    expect(screen.getByTestId('ctx-orchestrator-add-run-other')).toBeInTheDocument()
    expect(screen.getByTestId('ctx-orchestrator-open')).toHaveTextContent('Open orchestrator')
  })

  it('offers nothing it cannot do for a ticket that already has a session', async () => {
    seedRuns(ticketRun('run-a'))
    render(
      <KanbanTicketCard
        ticket={makeTicket({ column: 'review', current_session_id: 'session-1' })}
      />
    )

    await openOrchestratorMenu()

    const reason =
      'It already has a session. Only tickets that have not been launched can be orchestrated.'
    expect(isDisabled(screen.getByTestId('ctx-orchestrator-new'))).toBe(true)
    expect(screen.getByTestId('ctx-orchestrator-new')).toHaveTextContent(reason)
    expect(isDisabled(screen.getByTestId('ctx-orchestrator-add-run-a'))).toBe(true)
    expect(screen.getByTestId('ctx-orchestrator-add-run-a')).toHaveTextContent(reason)
    expect(screen.queryByTestId('ctx-orchestrator-open')).toBeNull()
    expect(screen.queryByTestId('ctx-orchestrator-remove')).toBeNull()
  })

  it('opens the orchestrator a ticket is part of, and takes it out while it waits', async () => {
    seedRuns(
      ticketRun('run-a', { title: 'Checkout' }, [
        { id: 'item-7', key: 'TD-7', ticket_id: 'ticket-1', status: 'pending' }
      ]),
      ticketRun('run-b', { title: 'Other' })
    )
    api.removeItem.mockResolvedValue(ticketRun('run-a', { title: 'Checkout' }, []))
    render(<KanbanTicketCard ticket={makeTicket()} />)

    await openOrchestratorMenu()
    // One run at a time: the other orchestrator says why it cannot take it, the one that has
    // it is not listed again
    expect(screen.queryByTestId('ctx-orchestrator-add-run-a')).toBeNull()
    expect(screen.getByTestId('ctx-orchestrator-add-run-b')).toHaveTextContent(
      'It is already part of “Checkout”.'
    )
    expect(isDisabled(screen.getByTestId('ctx-orchestrator-new'))).toBe(true)
    expect(screen.getByTestId('ctx-orchestrator-open')).toHaveTextContent('Open orchestrator')
    await act(async () => {
      fireEvent.click(screen.getByTestId('ctx-orchestrator-remove'))
    })

    expect(api.removeItem).toHaveBeenCalledWith({ runId: 'run-a', itemId: 'item-7' })
    expect(toastMock.success).toHaveBeenCalledWith('Removed from “Checkout”')
  })

  it('opens the run from the submenu', async () => {
    seedRuns(ticketRun('run-a', {}, [{ key: 'TD-7', ticket_id: 'ticket-1', status: 'running' }]))
    render(<KanbanTicketCard ticket={makeTicket({ column: 'in_progress' })} />)

    await openOrchestratorMenu()
    // Launched: it stays in the run (Skip is on the dashboard)
    expect(screen.queryByTestId('ctx-orchestrator-remove')).toBeNull()
    fireEvent.click(screen.getByTestId('ctx-orchestrator-open'))

    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-a')
  })

  it("follows a document run's task ticket to its run", async () => {
    seedRuns(
      makeDetail({ id: 'doc-run', project_id: 'proj-1', status: 'completed' }, [
        { key: 'A1', ticket_id: 'ticket-1', status: 'merged' }
      ])
    )
    render(<KanbanTicketCard ticket={makeTicket({ column: 'merged' })} />)

    await openOrchestratorMenu()

    expect(screen.getByTestId('ctx-orchestrator-open')).toHaveTextContent('Open document run')
    expect(screen.queryByTestId('ctx-orchestrator-remove')).toBeNull()
  })

  it.each([
    ['a shell command ticket', { external_provider: 'shell-command', external_id: 'build' }],
    ['an archived ticket', { archived_at: now }]
  ])('is not offered on %s', async (_label, overrides) => {
    render(<KanbanTicketCard ticket={makeTicket(overrides)} />)

    fireEvent.contextMenu(card())
    // Its neighbour in the menu is there: the menu is open
    await screen.findByTestId('ctx-dependencies-submenu')

    expect(screen.queryByTestId('ctx-orchestrator-submenu')).toBeNull()
  })
})

describe("an orchestrator's own ticket", () => {
  const runTicket = (overrides: Partial<KanbanTicket> = {}): KanbanTicket =>
    makeTicket({
      id: 'ticket-run-a',
      title: 'Checkout',
      column: 'in_progress',
      external_provider: 'document-run',
      external_id: 'run-a',
      external_url: '',
      ticket_number: 1,
      ...overrides
    })

  it('opens the orchestrator, takes more tickets and has no document to open', async () => {
    seedRuns(ticketRun('run-a', { title: 'Checkout' }))
    render(<KanbanTicketCard ticket={runTicket()} />)

    fireEvent.contextMenu(card('ticket-run-a'))

    const open = await screen.findByTestId('ctx-open-document-run')
    expect(open).toHaveTextContent('Open orchestrator')
    expect(screen.queryByTestId('ctx-open-document')).toBeNull()
    expect(screen.queryByTestId('ctx-orchestrator-submenu')).toBeNull()
    fireEvent.click(screen.getByTestId('ctx-run-add-tickets'))

    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-a')
  })

  it('opens the preview to add tickets before launch', async () => {
    seedRuns(ticketRun('run-a', { status: 'preview' }))
    render(<KanbanTicketCard ticket={runTicket({ column: 'todo' })} />)

    fireEvent.contextMenu(card('ticket-run-a'))
    fireEvent.click(await screen.findByTestId('ctx-run-add-tickets'))

    expect(useDocumentFlowStore.getState().wizard).toMatchObject({ open: true, runId: 'run-a' })
  })

  it('offers no "Add tickets…" once the orchestrator was cancelled', async () => {
    seedRuns(ticketRun('run-a', { status: 'cancelled' }))
    render(<KanbanTicketCard ticket={runTicket({ column: 'review' })} />)

    fireEvent.contextMenu(card('ticket-run-a'))
    await screen.findByTestId('ctx-open-document-run')

    expect(screen.queryByTestId('ctx-run-add-tickets')).toBeNull()
  })

  it('offers no "Add tickets…" once a finished orchestrator has no checkout to resume on', async () => {
    seedRuns(ticketRun('run-a', { status: 'completed' }))
    seedWorktrees()
    render(<KanbanTicketCard ticket={runTicket({ column: 'done' })} />)

    fireEvent.contextMenu(card('ticket-run-a'))
    await screen.findByTestId('ctx-open-document-run')

    expect(screen.queryByTestId('ctx-run-add-tickets')).toBeNull()
  })

  it('offers "Add tickets…" on a finished orchestrator whose checkout is still there', async () => {
    seedRuns(ticketRun('run-a', { status: 'completed' }))
    seedWorktrees('wt-run-a')
    render(<KanbanTicketCard ticket={runTicket({ column: 'review' })} />)

    fireEvent.contextMenu(card('ticket-run-a'))

    expect(await screen.findByTestId('ctx-run-add-tickets')).toBeInTheDocument()
  })

  it('offers "Add tickets…" while the worktree list has not loaded', async () => {
    seedRuns(ticketRun('run-a', { status: 'completed' }))
    render(<KanbanTicketCard ticket={runTicket({ column: 'review' })} />)

    fireEvent.contextMenu(card('ticket-run-a'))

    expect(await screen.findByTestId('ctx-run-add-tickets')).toBeInTheDocument()
  })

  it('names the orchestrator when deleting its ticket', async () => {
    seedRuns(ticketRun('run-a', { status: 'paused' }))
    render(<KanbanTicketCard ticket={runTicket()} />)

    fireEvent.contextMenu(card('ticket-run-a'))
    fireEvent.click(await screen.findByTestId('ctx-delete-ticket'))

    expect(toastMock.warning).toHaveBeenCalledWith(
      'Cancel the orchestrator before deleting its ticket.'
    )
  })

  it('names the orchestrator in the delete confirmation', async () => {
    seedRuns(ticketRun('run-a', { status: 'cancelled' }))
    const deleteTicket = vi.fn().mockResolvedValue(undefined)
    useKanbanStore.setState({ deleteTicket })
    render(<KanbanTicketCard ticket={runTicket({ column: 'review' })} />)

    fireEvent.contextMenu(card('ticket-run-a'))
    fireEvent.click(await screen.findByTestId('ctx-delete-ticket'))
    const dialog = await screen.findByTestId('ctx-delete-confirm-dialog')
    expect(dialog).toHaveTextContent('Delete orchestrator')
    await act(async () => {
      fireEvent.click(screen.getByTestId('ctx-delete-confirm-btn'))
    })

    expect(toastMock.success).toHaveBeenCalledWith('Orchestrator deleted')
  })
})

describe('right-button drag into In Progress', () => {
  function rightDragIntoInProgress(cardElement: HTMLElement): void {
    const column = document.querySelector('[data-kanban-column="in_progress"]') as HTMLElement
    // jsdom has no layout — resolve hit-testing by x coordinate
    const original = document.elementFromPoint
    document.elementFromPoint = (x: number) => (x >= 300 ? column : cardElement)
    try {
      fireEvent.mouseDown(cardElement, { button: 2, clientX: 10, clientY: 10 })
      fireEvent.mouseMove(window, { clientX: 350, clientY: 50 })
      fireEvent.mouseUp(window, { button: 2, clientX: 350, clientY: 50 })
    } finally {
      document.elementFromPoint = original
    }
  }

  it('refuses a ticket its orchestrator will launch', async () => {
    seedRuns(
      ticketRun('run-a', { title: 'Checkout' }, [
        { key: 'TD-7', ticket_id: 'ticket-1', status: 'pending' }
      ])
    )
    render(
      <>
        <KanbanTicketCard ticket={makeTicket()} />
        <div data-kanban-column="in_progress" />
      </>
    )

    rightDragIntoInProgress(card())

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'TD-7 is part of the orchestrator “Checkout”: it launches when the run gets to it. Remove it from the orchestrator to launch it yourself.'
      )
    )
    expect(launches.quickLaunchTicket).not.toHaveBeenCalled()
  })

  it("quick-launches a document run's task ticket as it always did", () => {
    seedRuns(
      makeDetail({ id: 'doc-run', project_id: 'proj-1', status: 'running' }, [
        { key: 'A1', ticket_id: 'ticket-1', status: 'pending' }
      ])
    )
    render(
      <>
        <KanbanTicketCard ticket={makeTicket()} />
        <div data-kanban-column="in_progress" />
      </>
    )

    rightDragIntoInProgress(card())

    expect(launches.quickLaunchTicket).toHaveBeenCalledTimes(1)
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it('still quick-launches a ticket no run has', () => {
    render(
      <>
        <KanbanTicketCard ticket={makeTicket()} />
        <div data-kanban-column="in_progress" />
      </>
    )

    rightDragIntoInProgress(card())

    expect(launches.quickLaunchTicket).toHaveBeenCalledTimes(1)
    expect(toastMock.error).not.toHaveBeenCalled()
  })
})

describe('"Assign to worktree" out of To Do (the picker that launches)', () => {
  it('refuses a ticket its orchestrator will launch, moved out of To Do by hand', async () => {
    seedRuns(
      ticketRun('run-a', { title: 'Checkout' }, [
        { key: 'TD-7', ticket_id: 'ticket-1', status: 'pending' }
      ])
    )
    render(<KanbanTicketCard ticket={makeTicket({ column: 'review' })} />)

    fireEvent.contextMenu(card())
    fireEvent.click(await screen.findByTestId('ctx-assign-worktree'))

    expect(toastMock.error).toHaveBeenCalledWith(
      'TD-7 is part of the orchestrator “Checkout”: it launches when the run gets to it. Remove it from the orchestrator to launch it yourself.'
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('pre-assigning a worktree in To Do (the picker that may link a session)', () => {
  const refusal =
    'TD-7 is part of the orchestrator “Checkout”: it launches when the run gets to it. Remove it from the orchestrator to launch it yourself.'
  const inOrchestrator = (): void =>
    seedRuns(
      ticketRun('run-a', { title: 'Checkout' }, [
        { key: 'TD-7', ticket_id: 'ticket-1', status: 'pending' }
      ])
    )

  it('refuses "Assign worktree" for a ticket its orchestrator will launch', async () => {
    inOrchestrator()
    render(<KanbanTicketCard ticket={makeTicket()} />)

    fireEvent.contextMenu(card())
    fireEvent.click(await screen.findByTestId('ctx-assign-worktree'))

    expect(toastMock.error).toHaveBeenCalledWith(refusal)
    expect(screen.queryByTestId('worktree-picker-modal')).toBeNull()
  })

  it('refuses "Change worktree" for a ticket its orchestrator will launch', async () => {
    inOrchestrator()
    render(<KanbanTicketCard ticket={makeTicket({ worktree_id: 'wt-1' })} />)

    fireEvent.contextMenu(card())
    fireEvent.click(await screen.findByTestId('ctx-change-worktree'))

    expect(toastMock.error).toHaveBeenCalledWith(refusal)
    expect(screen.queryByTestId('worktree-picker-modal')).toBeNull()
  })

  it.each([
    ['no run has', () => seedRuns()],
    [
      'a document run will launch',
      () =>
        seedRuns(
          makeDetail({ id: 'doc-run', project_id: 'proj-1', status: 'running' }, [
            { key: 'A1', ticket_id: 'ticket-1', status: 'pending' }
          ])
        )
    ]
  ])('opens the picker for a ticket %s', async (_label, seed) => {
    seed()
    render(<KanbanTicketCard ticket={makeTicket()} />)

    fireEvent.contextMenu(card())
    fireEvent.click(await screen.findByTestId('ctx-assign-worktree'))

    expect(await screen.findByTestId('worktree-picker-modal')).toBeInTheDocument()
    expect(toastMock.error).not.toHaveBeenCalled()
  })
})
