/**
 * Dropping a shell command's ticket on In Progress runs its command: the drop hands the
 * ticket to startShellCommandTicket with the sort order of the drop position, and never
 * takes the agent launch (worktree picker) or the plain move. Any other ticket, and any
 * other column, keeps the regular drop behavior.
 */
import type { PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { TooltipProvider } from '@/components/ui/tooltip'
import { toast } from '@/lib/toast'
import { setKanbanDragData, ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import { useShellCommandRunStore } from '@/stores/useShellCommandRunStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { SHELL_COMMAND_TICKET_PROVIDER, type SessionShellCommand } from '@shared/lib/shell-commands'
import type { KanbanTicket, KanbanTicketColumn } from '../../../../main/db/types'

const shellTicketMocks = vi.hoisted(() => ({ startShellCommandTicket: vi.fn() }))
const dbApiMocks = vi.hoisted(() => ({
  worktree: { get: vi.fn(), getActiveByProject: vi.fn() }
}))

// Which tickets are shell-command tickets is the real rule; only the start is observed.
vi.mock('@/lib/shell-command-ticket', async () => ({
  ...(await vi.importActual<typeof import('@/lib/shell-command-ticket')>(
    '@/lib/shell-command-ticket'
  )),
  startShellCommandTicket: shellTicketMocks.startShellCommandTicket
}))
vi.mock('@/api/db-api', () => ({ dbApi: dbApiMocks }))

vi.mock('@/components/kanban/KanbanTicketCard', () => ({
  KanbanTicketCard: ({ ticket }: { ticket: KanbanTicket }) => (
    <div data-testid="kanban-ticket-card" data-ticket-id={ticket.id}>
      {ticket.title}
    </div>
  )
}))
vi.mock('@/components/kanban/WorktreePickerModal', () => ({
  WorktreePickerModal: ({
    ticket,
    open,
    saveConfigOnly
  }: {
    ticket: KanbanTicket | null
    open: boolean
    saveConfigOnly?: boolean
  }) =>
    open && ticket ? (
      <div
        data-testid="worktree-picker"
        data-ticket-id={ticket.id}
        data-save-config-only={saveConfigOnly ? 'true' : 'false'}
      />
    ) : null
}))
vi.mock('@/components/kanban/TicketCreateModal', () => ({ TicketCreateModal: () => null }))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

vi.mock('motion/react', () => ({
  LayoutGroup: ({ children }: PropsWithChildren) => <>{children}</>,
  motion: {
    div: ({
      children,
      layoutId: _layoutId,
      layout: _layout,
      layoutScroll: _layoutScroll,
      transition: _transition,
      ...props
    }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>
  }
}))

const initialKanbanState = useKanbanStore.getState()
const initialRunState = useShellCommandRunStore.getState()
const initialUsageState = useUsageStore.getState()

const now = '2026-06-01T00:00:00.000Z'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-plain',
    project_id: 'proj-1',
    title: 'Fix the login form',
    description: null,
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
    ticket_prefix: null,
    ticket_number: null,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  }
}

/** A duplicated shell ticket: the marker, no session, no worktree. */
function makeShellTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return makeTicket({
    id: 'ticket-shell',
    title: 'Build',
    external_provider: SHELL_COMMAND_TICKET_PROVIDER,
    external_id: 'cmd-1',
    ...overrides
  })
}

const finishedRun: SessionShellCommand = {
  commandId: 'cmd-1',
  name: 'Build',
  script: 'make',
  detached: false,
  state: 'succeeded',
  runId: 'run-1',
  exitCode: 0,
  signal: null,
  reason: null,
  error: null,
  startedAt: now,
  finishedAt: now
}

// What In Progress already holds: a drop at the end lands after sort order 7.
const inProgressTickets = [
  makeTicket({ id: 'running-a', title: 'Running A', column: 'in_progress', sort_order: 3 }),
  makeTicket({ id: 'running-b', title: 'Running B', column: 'in_progress', sort_order: 7 })
]

const moveTicket = vi.fn()
const setPendingDoneMove = vi.fn()
const fetchUsageForProvider = vi.fn()

interface DropOptions {
  /** Tickets already in the target column. */
  columnTickets?: KanbanTicket[]
  /** Other tickets of the board (a blocker, say). */
  otherTickets?: KanbanTicket[]
  /** Hover above the first card before dropping, instead of dropping at the end. */
  aboveFirstCard?: boolean
}

/** Drop `ticket` (as it sits in its own column) on `column`. */
async function drop(
  ticket: KanbanTicket,
  column: KanbanTicketColumn,
  { columnTickets = [], otherTickets = [], aboveFirstCard = false }: DropOptions = {}
): Promise<void> {
  useKanbanStore.setState({
    tickets: new Map([[ticket.project_id, [ticket, ...columnTickets, ...otherTickets]]])
  })
  render(
    <TooltipProvider>
      <KanbanColumn column={column} projectId="proj-1" tickets={columnTickets} />
    </TooltipProvider>
  )
  setKanbanDragData({
    projectId: ticket.project_id,
    ticketId: ticket.id,
    sourceColumn: ticket.column,
    sourceIndex: 0
  })
  const dropArea = screen.getByTestId(`kanban-drop-area-${column}`)
  if (aboveFirstCard) {
    // jsdom has no DragEvent (so no clientY on a fired dragOver) and lays every card out
    // at y = 0: a mouse event above that is a cursor above the first card
    const dragOver = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: -1 })
    Object.defineProperty(dragOver, 'dataTransfer', { value: { dropEffect: 'none' } })
    fireEvent(dropArea, dragOver)
  }
  await act(async () => {
    fireEvent.drop(dropArea)
  })
}

/** `ticket` waits on a blocker that is still in To Do. */
function block(ticket: KanbanTicket): KanbanTicket {
  const blocker = makeTicket({ id: 'blocker', title: 'Blocker' })
  useKanbanStore.setState({
    dependencyMap: new Map([
      [ticketKey(ticket.project_id, ticket.id), new Set([ticketKey('proj-1', 'blocker')])]
    ])
  })
  return blocker
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  shellTicketMocks.startShellCommandTicket.mockResolvedValue(true)
  dbApiMocks.worktree.get.mockResolvedValue(null)
  dbApiMocks.worktree.getActiveByProject.mockResolvedValue([])
  useKanbanStore.setState({
    tickets: new Map(),
    markdownDiagnostics: new Map(),
    markdownPlaceholders: new Map(),
    dependencyMap: new Map(),
    draggingTicketKey: null,
    simpleModeByProject: {},
    moveTicket,
    setPendingDoneMove
  })
  useShellCommandRunStore.setState({ runsBySession: {}, loaded: true })
  // A plain simple-mode drop on In Progress refreshes usage; keep that off the network
  useUsageStore.setState({ fetchUsageForProvider })
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  setKanbanDragData(null)
  useKanbanStore.setState(initialKanbanState, true)
  useShellCommandRunStore.setState(initialRunState, true)
  useUsageStore.setState(initialUsageState, true)
})

describe('dropping a session-less shell-command ticket on In Progress', () => {
  it('runs its command at the drop position instead of opening the worktree picker', async () => {
    const ticket = makeShellTicket()

    await drop(ticket, 'in_progress', { columnTickets: inProgressTickets })

    expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledTimes(1)
    // Dropped at the end of the column: one past the last ticket's sort order
    expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledWith(ticket, { sortOrder: 8 })
    expect(screen.queryByTestId('worktree-picker')).toBeNull()
    // The run links the ticket and moves it; the drop itself moves nothing
    expect(moveTicket).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('passes the sort order of a drop above the first card', async () => {
    const ticket = makeShellTicket()

    await drop(ticket, 'in_progress', { columnTickets: inProgressTickets, aboveFirstCard: true })

    expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledWith(ticket, { sortOrder: 2 })
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('passes sort order 0 into an empty column', async () => {
    const ticket = makeShellTicket()

    await drop(ticket, 'in_progress')

    expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledWith(ticket, { sortOrder: 0 })
  })

  it('runs it in simple mode too, without a plain move', async () => {
    useKanbanStore.setState({ simpleModeByProject: { 'proj-1': true } })
    const ticket = makeShellTicket()

    await drop(ticket, 'in_progress', { columnTickets: inProgressTickets })

    expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledTimes(1)
    expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledWith(ticket, { sortOrder: 8 })
    expect(moveTicket).not.toHaveBeenCalled()
    expect(screen.queryByTestId('worktree-picker')).toBeNull()
    // Not an agent launch: no usage refresh either
    expect(fetchUsageForProvider).not.toHaveBeenCalled()
  })

  it('refuses a blocked ticket with a warning and starts nothing', async () => {
    const ticket = makeShellTicket()
    const blocker = block(ticket)

    await drop(ticket, 'in_progress', { otherTickets: [blocker] })

    expect(toast.warning).toHaveBeenCalledWith('Ticket is blocked — resolve its dependencies first')
    expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
    expect(moveTicket).not.toHaveBeenCalled()
    // Not the save-config picker a blocked agent ticket gets, either
    expect(screen.queryByTestId('worktree-picker')).toBeNull()
  })

  it('runs a ticket whose blocker is already done', async () => {
    const ticket = makeShellTicket()
    const blocker = { ...block(ticket), column: 'done' as const }

    await drop(ticket, 'in_progress', { otherTickets: [blocker] })

    expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledWith(ticket, { sortOrder: 0 })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('does not check blockers in simple mode, like any simple-mode drop', async () => {
    useKanbanStore.setState({ simpleModeByProject: { 'proj-1': true } })
    const ticket = makeShellTicket()
    const blocker = block(ticket)

    await drop(ticket, 'in_progress', { otherTickets: [blocker] })

    expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledWith(ticket, { sortOrder: 0 })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('treats a marker without a command id as a plain ticket', async () => {
    const ticket = makeShellTicket({ external_id: null })

    await drop(ticket, 'in_progress')

    expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
    expect(screen.getByTestId('worktree-picker')).toHaveAttribute('data-ticket-id', 'ticket-shell')
  })
})

describe('dropping a finished run back on In Progress', () => {
  // A ticket from before the marker existed: only its session says it is a shell command
  it('runs the command of a session-linked ticket known to the run store', async () => {
    useShellCommandRunStore.setState({ runsBySession: { 'session-1': finishedRun } })
    const ticket = makeTicket({
      id: 'ticket-ran',
      title: 'Build',
      column: 'review',
      current_session_id: 'session-1',
      worktree_id: 'wt-main',
      mode: 'build'
    })

    await drop(ticket, 'in_progress', { columnTickets: inProgressTickets })

    expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledTimes(1)
    expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledWith(ticket, { sortOrder: 8 })
    expect(screen.queryByTestId('worktree-picker')).toBeNull()
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('runs the command of a marked ticket that still has its session', async () => {
    const ticket = makeShellTicket({
      column: 'review',
      current_session_id: 'session-1',
      worktree_id: 'wt-main',
      mode: 'build'
    })

    await drop(ticket, 'in_progress')

    expect(shellTicketMocks.startShellCommandTicket).toHaveBeenCalledWith(ticket, { sortOrder: 0 })
    expect(screen.queryByTestId('worktree-picker')).toBeNull()
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('does not take an agent ticket for a shell command because of other runs', async () => {
    useShellCommandRunStore.setState({ runsBySession: { 'another-session': finishedRun } })
    const ticket = makeTicket({
      column: 'review',
      current_session_id: 'session-1',
      worktree_id: 'wt-main',
      mode: 'build'
    })

    await drop(ticket, 'in_progress')

    expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
    expect(screen.getByTestId('worktree-picker')).toHaveAttribute('data-ticket-id', 'ticket-plain')
  })
})

describe('dropping a plain ticket on In Progress', () => {
  it('still opens the worktree picker', async () => {
    await drop(makeTicket(), 'in_progress', { columnTickets: inProgressTickets })

    const picker = screen.getByTestId('worktree-picker')
    expect(picker).toHaveAttribute('data-ticket-id', 'ticket-plain')
    expect(picker).toHaveAttribute('data-save-config-only', 'false')
    expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
    // The picker moves the ticket once a worktree is chosen
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('still opens the save-config picker when it is blocked', async () => {
    const ticket = makeTicket()
    const blocker = block(ticket)

    await drop(ticket, 'in_progress', { otherTickets: [blocker] })

    expect(screen.getByTestId('worktree-picker')).toHaveAttribute('data-save-config-only', 'true')
    expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('still moves it directly in simple mode', async () => {
    useKanbanStore.setState({ simpleModeByProject: { 'proj-1': true } })

    await drop(makeTicket(), 'in_progress', { columnTickets: inProgressTickets })

    expect(moveTicket).toHaveBeenCalledTimes(1)
    expect(moveTicket).toHaveBeenCalledWith('ticket-plain', 'proj-1', 'in_progress', 8)
    expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
    expect(screen.queryByTestId('worktree-picker')).toBeNull()
  })
})

describe('dropping a shell-command ticket on another column', () => {
  it.each(['review', 'merged', 'done'] as const)(
    'moves a session-less one to %s without running anything',
    async (column) => {
      await drop(makeShellTicket(), column)

      expect(moveTicket).toHaveBeenCalledTimes(1)
      expect(moveTicket).toHaveBeenCalledWith('ticket-shell', 'proj-1', column, 0)
      expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
      expect(screen.queryByTestId('worktree-picker')).toBeNull()
    }
  )

  it('moves one back to To Do from Review without running anything', async () => {
    await drop(makeShellTicket({ column: 'review' }), 'todo')

    expect(moveTicket).toHaveBeenCalledWith('ticket-shell', 'proj-1', 'todo', 0)
    expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
  })

  it('does not run one that is only reordered inside To Do', async () => {
    const reorderTicket = vi.fn()
    useKanbanStore.setState({ reorderTicket })
    const ticket = makeShellTicket()

    await drop(ticket, 'todo', { columnTickets: [ticket] })

    expect(reorderTicket).toHaveBeenCalledWith('ticket-shell', 'proj-1', 0)
    expect(shellTicketMocks.startShellCommandTicket).not.toHaveBeenCalled()
    expect(moveTicket).not.toHaveBeenCalled()
  })
})
