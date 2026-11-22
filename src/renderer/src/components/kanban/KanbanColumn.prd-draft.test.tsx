/**
 * Dropping the ticket of a PRD flow that was saved for later on In Progress launches that
 * flow: the drop hands the ticket to launchSavedPrdFlowDraft and never takes the agent launch
 * (worktree picker) or the plain move, in simple mode too. A ticket with no draft, a draft
 * that already became a flow, and any other column keep the regular drop behavior.
 */
import type { PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { TooltipProvider } from '@/components/ui/tooltip'
import { toast } from '@/lib/toast'
import { setKanbanDragData, ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import { usePrdFlowStore, type PrdFlow } from '@/stores/usePrdFlowStore'
import { useUsageStore } from '@/stores/useUsageStore'
import type { KanbanTicket, KanbanTicketColumn } from '../../../../main/db/types'

const draftMocks = vi.hoisted(() => ({ launchSavedPrdFlowDraft: vi.fn() }))
const dbApiMocks = vi.hoisted(() => ({
  worktree: { get: vi.fn(), getActiveByProject: vi.fn() }
}))

// Which tickets are drafts is the real rule; only the launch is observed.
vi.mock('@/lib/prd-flow/draft', async () => ({
  ...(await vi.importActual<typeof import('@/lib/prd-flow/draft')>('@/lib/prd-flow/draft')),
  launchSavedPrdFlowDraft: draftMocks.launchSavedPrdFlowDraft
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
  WorktreePickerModal: ({ ticket, open }: { ticket: KanbanTicket | null; open: boolean }) =>
    open && ticket ? <div data-testid="worktree-picker" data-ticket-id={ticket.id} /> : null
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
const initialPrdFlowState = usePrdFlowStore.getState()
const initialUsageState = useUsageStore.getState()

const PROJECT = 'proj-1'
const TICKET = 'ticket-draft'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: TICKET,
    project_id: PROJECT,
    title: 'code mode',
    description: 'A mode for writing code.',
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    archived_at: null,
    external_provider: null,
    external_id: null,
    labels: [],
    ...overrides
  } as KanbanTicket
}

/** The form's answers, saved for the ticket. */
function seedDraft(ticketId = TICKET): void {
  usePrdFlowStore.getState().putDraft({
    ticketId,
    projectId: PROJECT,
    name: 'code mode',
    prompt: 'A mode for writing code.',
    research: true,
    clarify: true,
    launch: null,
    createdAt: 1_000,
    updatedAt: 1_000
  })
}

const moveTicket = vi.fn()
const fetchUsageForProvider = vi.fn()

/** Drop `ticket` (as it sits in its own column) on `column`. */
async function drop(
  ticket: KanbanTicket,
  column: KanbanTicketColumn,
  otherTickets: KanbanTicket[] = []
): Promise<void> {
  useKanbanStore.setState({ tickets: new Map([[ticket.project_id, [ticket, ...otherTickets]]]) })
  render(
    <TooltipProvider>
      <KanbanColumn column={column} projectId={PROJECT} tickets={[]} />
    </TooltipProvider>
  )
  setKanbanDragData({
    projectId: ticket.project_id,
    ticketId: ticket.id,
    sourceColumn: ticket.column,
    sourceIndex: 0
  })
  await act(async () => {
    fireEvent.drop(screen.getByTestId(`kanban-drop-area-${column}`))
  })
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
  draftMocks.launchSavedPrdFlowDraft.mockResolvedValue(undefined)
  dbApiMocks.worktree.get.mockResolvedValue(null)
  dbApiMocks.worktree.getActiveByProject.mockResolvedValue([])
  useKanbanStore.setState({
    tickets: new Map(),
    markdownDiagnostics: new Map(),
    markdownPlaceholders: new Map(),
    dependencyMap: new Map(),
    draggingTicketKey: null,
    simpleModeByProject: {},
    moveTicket
  })
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
  usePrdFlowStore.setState(initialPrdFlowState, true)
  useUsageStore.setState(initialUsageState, true)
})

describe('dropping the ticket of a saved PRD draft on In Progress', () => {
  it('launches its PRD flow instead of opening the worktree picker', async () => {
    seedDraft()

    await drop(makeTicket(), 'in_progress')

    expect(draftMocks.launchSavedPrdFlowDraft).toHaveBeenCalledExactlyOnceWith(TICKET)
    expect(screen.queryByTestId('worktree-picker')).toBeNull()
    // The launch moves the ticket once its session exists; the drop itself moves nothing
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('launches it in simple mode too, without a plain move', async () => {
    useKanbanStore.setState({ simpleModeByProject: { [PROJECT]: true } })
    seedDraft()

    await drop(makeTicket(), 'in_progress')

    expect(draftMocks.launchSavedPrdFlowDraft).toHaveBeenCalledExactlyOnceWith(TICKET)
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('does not launch a draft that waits on another ticket', async () => {
    seedDraft()
    const ticket = makeTicket()
    const blocker = makeTicket({ id: 'blocker', title: 'Blocker' })
    useKanbanStore.setState({
      dependencyMap: new Map([
        [ticketKey(PROJECT, TICKET), new Set([ticketKey(PROJECT, 'blocker')])]
      ])
    })

    await drop(ticket, 'in_progress', [blocker])

    expect(draftMocks.launchSavedPrdFlowDraft).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(
      'Ticket is blocked — resolve its dependencies first'
    )
    expect(moveTicket).not.toHaveBeenCalled()
  })
})

describe('what keeps the regular drop', () => {
  it('opens the worktree picker for a ticket with no draft', async () => {
    seedDraft('ticket-other')

    await drop(makeTicket(), 'in_progress')

    expect(draftMocks.launchSavedPrdFlowDraft).not.toHaveBeenCalled()
    expect(screen.getByTestId('worktree-picker')).toHaveAttribute('data-ticket-id', TICKET)
  })

  it('does not launch a draft a second time once it is a flow', async () => {
    seedDraft()
    usePrdFlowStore.getState().putFlow({ ticketId: TICKET, projectId: PROJECT } as PrdFlow)

    await drop(makeTicket(), 'in_progress')

    expect(draftMocks.launchSavedPrdFlowDraft).not.toHaveBeenCalled()
  })

  it('moves a draft dropped on another column as any ticket, launching nothing', async () => {
    seedDraft()

    await drop(makeTicket(), 'review')

    expect(draftMocks.launchSavedPrdFlowDraft).not.toHaveBeenCalled()
    expect(moveTicket).toHaveBeenCalledTimes(1)
    expect(moveTicket.mock.calls[0].slice(0, 3)).toEqual([TICKET, PROJECT, 'review'])
  })
})
