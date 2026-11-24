/**
 * The board and orchestrators: a ticket its run will launch is not launched by a drop on In
 * Progress (no picker, no "Save & Queue" for a blocked one, no plain move in simple mode), and
 * the To Do header's right-click menu starts an orchestrator from a single project's tickets.
 */
import type { PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { TooltipProvider } from '@/components/ui/tooltip'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { setKanbanDragData, ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import type { DocumentRunItem, DocumentRunStatus } from '@shared/types/document-flow'
import type { KanbanTicket, KanbanTicketColumn } from '../../../../main/db/types'

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: { get: vi.fn() } }))
vi.mock('@/components/kanban/KanbanTicketCard', () => ({ KanbanTicketCard: () => null }))
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

const initialFlowState = useDocumentFlowStore.getState()
const initialKanbanState = useKanbanStore.getState()

const now = '2026-06-01T00:00:00.000Z'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Checkout button',
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
    ticket_prefix: 'TD',
    ticket_number: 7,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  }
}

const REFUSAL =
  'TD-7 is part of the orchestrator “Checkout”: it launches when the run gets to it. Remove it from the orchestrator to launch it yourself.'

/** `ticket-1` as the item TD-7 of an orchestrator of proj-1. */
function seedRun(status: DocumentRunStatus, item: Partial<DocumentRunItem> = {}): void {
  useDocumentFlowStore.setState({
    runsById: {
      'run-1': makeDetail(
        { id: 'run-1', project_id: 'proj-1', title: 'Checkout', source_kind: 'tickets', status },
        [{ key: 'TD-7', ticket_id: 'ticket-1', status: 'pending', ...item }]
      )
    }
  })
}

const moveTicket = vi.fn()

/** Drop `ticket` (from its own column) on `column`; `extra` tickets sit on the board too. */
async function drop(
  ticket: KanbanTicket,
  column: KanbanTicketColumn,
  extra: KanbanTicket[] = []
): Promise<void> {
  useKanbanStore.setState({ tickets: new Map([[ticket.project_id, [ticket, ...extra]]]) })
  render(
    <TooltipProvider>
      <KanbanColumn column={column} projectId="proj-1" tickets={[]} />
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

// jsdom cannot answer floating-ui's top-layer probes (see KanbanColumn.new-ticket-button.test)
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  useKanbanStore.setState({
    tickets: new Map(),
    markdownDiagnostics: new Map(),
    markdownPlaceholders: new Map(),
    dependencyMap: new Map(),
    draggingTicketKey: null,
    simpleModeByProject: {},
    moveTicket
  })
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  setKanbanDragData(null)
  useDocumentFlowStore.setState(initialFlowState, true)
  useKanbanStore.setState(initialKanbanState, true)
})

describe('dropping a ticket its run will launch on In Progress', () => {
  it.each(['preview', 'running', 'paused'] as const)(
    'refuses it while the run is %s, and opens no picker',
    async (status) => {
      seedRun(status)

      await drop(makeTicket(), 'in_progress')

      expect(toast.error).toHaveBeenCalledWith(REFUSAL)
      expect(screen.queryByTestId('worktree-picker')).toBeNull()
      expect(moveTicket).not.toHaveBeenCalled()
    }
  )

  it('does not queue a blocked one either ("Save & Queue" would launch it a second time)', async () => {
    seedRun('running')
    const blocker = makeTicket({ id: 'ticket-0', column: 'in_progress' })
    useKanbanStore.setState({
      dependencyMap: new Map([
        [ticketKey('proj-1', 'ticket-1'), new Set([ticketKey('proj-1', 'ticket-0')])]
      ])
    })

    await drop(makeTicket(), 'in_progress', [blocker])

    expect(toast.error).toHaveBeenCalledWith(REFUSAL)
    expect(screen.queryByTestId('worktree-picker')).toBeNull()
  })

  it('does not move it in simple mode', async () => {
    seedRun('running')
    useKanbanStore.setState({ simpleModeByProject: { 'proj-1': true } })

    await drop(makeTicket(), 'in_progress')

    expect(toast.error).toHaveBeenCalledWith(REFUSAL)
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('opens the picker once the run launched it, or for a ticket of an ended run', async () => {
    seedRun('completed')

    await drop(makeTicket(), 'in_progress')

    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByTestId('worktree-picker')).toHaveAttribute('data-ticket-id', 'ticket-1')
  })

  it('opens the picker for a ticket no run has', async () => {
    await drop(makeTicket(), 'in_progress')

    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByTestId('worktree-picker')).toHaveAttribute('data-save-config-only', 'false')
  })

  it("leaves other drops of a run's ticket alone", async () => {
    seedRun('running')

    await drop(makeTicket({ column: 'in_progress' }), 'todo')

    expect(toast.error).not.toHaveBeenCalled()
    expect(moveTicket).toHaveBeenCalledWith('ticket-1', 'proj-1', 'todo', 0, { interactive: true })
  })
})

describe("dropping an orchestrator's own ticket", () => {
  it('names the orchestrator when the drop is refused', async () => {
    seedRun('running')
    const runTicket = makeTicket({
      id: 'run-ticket',
      column: 'in_progress',
      external_provider: 'document-run',
      external_id: 'run-1'
    })

    await drop(runTicket, 'done')

    expect(toast.warning).toHaveBeenCalledWith(
      'The orchestrator is still going. Wait for it to end, or cancel it, before merging it.'
    )
    expect(moveTicket).not.toHaveBeenCalled()
  })
})

describe('the To Do header menu', () => {
  const header = (): HTMLElement =>
    screen.getByRole('heading', { name: 'To Do' }).parentElement!.parentElement!

  function renderTodo(board: { connectionId?: string; isPinnedMode?: boolean } = {}): void {
    render(
      <TooltipProvider>
        <KanbanColumn column="todo" projectId="proj-1" tickets={[]} {...board} />
      </TooltipProvider>
    )
  }

  it("starts an orchestrator from a single project's board tickets", () => {
    renderTodo()

    fireEvent.contextMenu(header())
    fireEvent.click(screen.getByTestId('ctx-new-orchestrator'))

    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'proj-1',
      runId: null,
      source: 'tickets'
    })
  })

  it.each([
    ['a pinned board', { isPinnedMode: true }],
    ['a connection board', { connectionId: 'conn-1' }]
  ])('is not offered on %s, which mixes projects', (_label, board) => {
    renderTodo(board)

    fireEvent.contextMenu(header())

    expect(screen.getByTestId('ctx-new-ticket')).toBeTruthy()
    expect(screen.queryByTestId('ctx-new-orchestrator')).toBeNull()
  })
})
