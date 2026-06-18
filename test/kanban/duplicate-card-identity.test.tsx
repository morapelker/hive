import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PropsWithChildren } from 'react'
import { fireEvent, render, waitFor } from '../utils/render'
import { KanbanBoard } from '@/components/kanban/KanbanBoard'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { cardOccurrenceKeys } from '@/components/kanban/kanban-card-identity'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setKanbanDragData, ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import type { KanbanTicket } from '../../src/main/db/types'

const kanbanApiMock = vi.hoisted(() => ({
  ticket: {
    getByProject: vi.fn()
  },
  diagnostics: {
    get: vi.fn()
  },
  dependency: {
    getForProject: vi.fn()
  }
}))

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: kanbanApiMock
}))

vi.mock('@/components/kanban/WorktreePickerModal', () => ({
  WorktreePickerModal: () => null
}))

vi.mock('@/components/kanban/KanbanTicketModal', () => ({
  KanbanTicketModal: () => null
}))

vi.mock('@/components/kanban/BoardChatLauncher', () => ({
  BoardChatLauncher: () => null
}))

vi.mock('@/components/kanban/MergeOnDoneDialog', () => ({
  MergeOnDoneDialog: () => null
}))

vi.mock('@/components/kanban/TicketCreateModal', () => ({
  TicketCreateModal: () => null
}))

vi.mock('@/components/kanban/KanbanTicketCard', () => ({
  KanbanTicketCard: ({
    ticket,
    cardIdentityKey
  }: {
    ticket: KanbanTicket
    cardIdentityKey: string
  }) => (
    <div
      data-testid="kanban-ticket-card"
      data-ticket-id={ticket.id}
      data-project-id={ticket.project_id}
      data-ticket-key={cardIdentityKey}
    >
      {ticket.title}
    </div>
  )
}))

vi.mock('@/components/kanban/AttachPRPopover', () => ({
  AttachPRPopover: () => null
}))

vi.mock('@/components/kanban/UpdateStatusModal', () => ({
  UpdateStatusModal: () => null
}))

vi.mock('@/components/worktrees/PulseAnimation', () => ({
  PulseAnimation: () => null
}))

vi.mock('@/components/sessions/IndeterminateProgressBar', () => ({
  IndeterminateProgressBar: () => null
}))

vi.mock('@/hooks/useMarkdownKanbanWatcher', () => ({
  useMarkdownKanbanWatcher: vi.fn()
}))

vi.mock('@/hooks/useSessionTimer', () => ({
  useSessionTimer: () => null
}))

vi.mock('@/hooks/useSessionTokenDelta', () => ({
  useSessionTokenDelta: () => null
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
}))

vi.mock('motion/react', () => ({
  LayoutGroup: ({ children }: PropsWithChildren) => <>{children}</>,
  motion: {
    div: ({
      children,
      layoutId,
      layout: _layout,
      layoutScroll: _layoutScroll,
      transition: _transition,
      ...props
    }: PropsWithChildren<{
      layoutId?: string
      layout?: boolean
      layoutScroll?: boolean
      transition?: unknown
      [key: string]: unknown
    }>) => (
      <div data-layout-id={layoutId} {...props}>
        {children}
      </div>
    )
  }
}))

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'shared',
    project_id: 'proj-1',
    title: 'Duplicate ticket',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
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
    ...overrides
  }
}

describe('duplicate markdown card renderer identity', () => {
  const moveTicket = vi.fn()
  const reorderTicket = vi.fn()

  beforeEach(() => {
    moveTicket.mockReset()
    reorderTicket.mockReset()
    kanbanApiMock.ticket.getByProject.mockReset()
    kanbanApiMock.diagnostics.get.mockReset()
    kanbanApiMock.dependency.getForProject.mockReset()
    kanbanApiMock.dependency.getForProject.mockResolvedValue([])
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
      markdownDiagnostics: new Map([
        [
          'proj-1',
          [
            {
              projectId: 'proj-1',
              ticketId: 'shared',
              filePath: '/tmp/project/cards/a.md',
              kind: 'duplicate_id',
              message: 'Duplicate markdown card id "shared"',
              blocking: true
            },
            {
              projectId: 'proj-1',
              ticketId: 'shared',
              filePath: '/tmp/project/cards/b.md',
              kind: 'duplicate_id',
              message: 'Duplicate markdown card id "shared"',
              blocking: true
            }
          ]
        ]
      ]),
      markdownPlaceholders: new Map(),
      dependencyMap: new Map(),
      draggingTicketKey: null,
      moveTicket,
      reorderTicket
    })
    setKanbanDragData(null)
  })

  test('duplicate cards get distinct DOM and layout identities while retaining blocking diagnostics', () => {
    const { container } = render(
      <TooltipProvider>
        <KanbanColumn
          column="todo"
          projectId="proj-1"
          tickets={[
            makeTicket({ title: 'Duplicate A', sort_order: 0 }),
            makeTicket({ title: 'Duplicate B', sort_order: 1 })
          ]}
        />
      </TooltipProvider>
    )

    const cards = [...container.querySelectorAll<HTMLElement>('[data-testid="kanban-ticket-card"]')]
    const ticketKeys = cards.map((card) => card.getAttribute('data-ticket-key'))
    const layoutIds = [...container.querySelectorAll<HTMLElement>('[data-layout-id]')].map((node) =>
      node.getAttribute('data-layout-id')
    )
    const diagnostics = useKanbanStore.getState().getDiagnosticsForTicket('proj-1', 'shared')

    expect(cards).toHaveLength(2)
    expect(new Set(ticketKeys).size).toBe(2)
    expect(new Set(layoutIds).size).toBe(2)
    expect(
      ticketKeys.every((key) => key?.startsWith(`${ticketKey('proj-1', 'shared')}:duplicate:`))
    ).toBe(true)
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics.every((diagnostic) => diagnostic.blocking)).toBe(true)
  })

  test('duplicate cards split across columns use board-wide occurrence identities', () => {
    const diagnostics = useKanbanStore.getState().markdownDiagnostics
    const occurrenceCounts = new Map<string, number>()
    const todoTickets = [makeTicket({ title: 'Duplicate A', column: 'todo', sort_order: 0 })]
    const reviewTickets = [makeTicket({ title: 'Duplicate B', column: 'review', sort_order: 1 })]
    const todoKeys = cardOccurrenceKeys(todoTickets, diagnostics, occurrenceCounts)
    const reviewKeys = cardOccurrenceKeys(reviewTickets, diagnostics, occurrenceCounts)

    const { container } = render(
      <TooltipProvider>
        <div>
          <KanbanColumn
            column="todo"
            projectId="proj-1"
            tickets={todoTickets}
            activeCardIdentityKeys={todoKeys}
          />
          <KanbanColumn
            column="review"
            projectId="proj-1"
            tickets={reviewTickets}
            activeCardIdentityKeys={reviewKeys}
          />
        </div>
      </TooltipProvider>
    )

    const cards = [...container.querySelectorAll<HTMLElement>('[data-testid="kanban-ticket-card"]')]
    const ticketKeys = cards.map((card) => card.getAttribute('data-ticket-key'))
    const layoutIds = [...container.querySelectorAll<HTMLElement>('[data-layout-id]')].map((node) =>
      node.getAttribute('data-layout-id')
    )

    expect(cards).toHaveLength(2)
    expect(new Set(ticketKeys).size).toBe(2)
    expect(new Set(layoutIds).size).toBe(2)
    expect(ticketKeys).toEqual([
      `${ticketKey('proj-1', 'shared')}:duplicate:${encodeURIComponent('/tmp/project/cards/a.md')}`,
      `${ticketKey('proj-1', 'shared')}:duplicate:${encodeURIComponent('/tmp/project/cards/b.md')}`
    ])
  })

  test('standalone column fallback namespaces duplicate identities across columns', () => {
    const todoTickets = [makeTicket({ title: 'Duplicate A', column: 'todo', sort_order: 0 })]
    const reviewTickets = [makeTicket({ title: 'Duplicate B', column: 'review', sort_order: 1 })]

    const { container } = render(
      <TooltipProvider>
        <div>
          <KanbanColumn column="todo" projectId="proj-1" tickets={todoTickets} />
          <KanbanColumn column="review" projectId="proj-1" tickets={reviewTickets} />
        </div>
      </TooltipProvider>
    )

    const cards = [...container.querySelectorAll<HTMLElement>('[data-testid="kanban-ticket-card"]')]
    const ticketKeys = cards.map((card) => card.getAttribute('data-ticket-key'))
    const layoutIds = [...container.querySelectorAll<HTMLElement>('[data-layout-id]')].map((node) =>
      node.getAttribute('data-layout-id')
    )

    expect(cards).toHaveLength(2)
    expect(ticketKeys).toEqual([
      `${ticketKey('proj-1', 'shared')}:duplicate:active:todo:local-0`,
      `${ticketKey('proj-1', 'shared')}:duplicate:active:review:local-0`
    ])
    expect(new Set(ticketKeys).size).toBe(2)
    expect(new Set(layoutIds).size).toBe(2)
  })

  test('KanbanBoard shares duplicate occurrence identities across rendered columns', () => {
    useKanbanStore.setState({
      tickets: new Map([
        [
          'proj-1',
          [
            makeTicket({ title: 'Duplicate A', column: 'todo', sort_order: 0 }),
            makeTicket({ title: 'Duplicate B', column: 'review', sort_order: 1 })
          ]
        ]
      ]),
      loadTickets: vi.fn().mockResolvedValue(undefined)
    })

    const { container } = render(
      <TooltipProvider>
        <KanbanBoard projectId="proj-1" />
      </TooltipProvider>
    )

    const cards = [...container.querySelectorAll<HTMLElement>('[data-testid="kanban-ticket-card"]')]
    const ticketKeys = cards.map((card) => card.getAttribute('data-ticket-key'))
    const layoutIds = [...container.querySelectorAll<HTMLElement>('[data-layout-id]')].map((node) =>
      node.getAttribute('data-layout-id')
    )

    expect(cards).toHaveLength(2)
    expect(ticketKeys).toEqual([
      `${ticketKey('proj-1', 'shared')}:duplicate:${encodeURIComponent('/tmp/project/cards/a.md')}`,
      `${ticketKey('proj-1', 'shared')}:duplicate:${encodeURIComponent('/tmp/project/cards/b.md')}`
    ])
    expect(new Set(ticketKeys).size).toBe(2)
    expect(new Set(layoutIds).size).toBe(2)
  })

  test('KanbanBoard passes invalid markdown placeholders into the todo column', () => {
    useKanbanStore.setState({
      tickets: new Map([['proj-1', []]]),
      markdownPlaceholders: new Map([
        [
          'proj-1',
          [
            {
              projectId: 'proj-1',
              filePath: '/tmp/project/cards/broken.md',
              kind: 'invalid_frontmatter',
              message: 'Invalid markdown frontmatter',
              blocking: true
            }
          ]
        ]
      ]),
      loadTickets: vi.fn().mockResolvedValue(undefined)
    })

    const { getByTestId } = render(
      <TooltipProvider>
        <KanbanBoard projectId="proj-1" />
      </TooltipProvider>
    )

    expect(getByTestId('kanban-invalid-card-placeholder')).toHaveTextContent('broken.md')
    expect(getByTestId('kanban-invalid-card-placeholder')).toHaveTextContent(
      'Invalid markdown frontmatter'
    )
  })

  test('loadTickets creates placeholders for id-bearing invalid markdown diagnostics', async () => {
    kanbanApiMock.ticket.getByProject.mockResolvedValueOnce([])
    kanbanApiMock.diagnostics.get.mockResolvedValueOnce([
      {
        projectId: 'proj-1',
        ticketId: 'bad-card',
        filePath: '/tmp/project/cards/bad-card.md',
        kind: 'invalid_frontmatter',
        message: 'Invalid column; expected todo, in_progress, review, or done',
        blocking: true
      }
    ])
    useKanbanStore.setState({ loadTickets: useKanbanStore.getInitialState().loadTickets })

    await useKanbanStore.getState().loadTickets('proj-1')

    expect(useKanbanStore.getState().markdownPlaceholders.get('proj-1')).toEqual([
      {
        projectId: 'proj-1',
        filePath: '/tmp/project/cards/bad-card.md',
        kind: 'invalid_frontmatter',
        message: 'Invalid column; expected todo, in_progress, review, or done',
        blocking: true
      }
    ])
  })

  test('cross-column drops compute sort order from the dragged project only', async () => {
    const tickets = [
      makeTicket({
        id: 'done-a',
        project_id: 'proj-1',
        title: 'Project 1 Done',
        column: 'done',
        sort_order: 10
      }),
      makeTicket({
        id: 'done-b',
        project_id: 'proj-2',
        title: 'Project 2 Done',
        column: 'done',
        sort_order: 100
      })
    ]
    const { container } = render(
      <TooltipProvider>
        <KanbanColumn column="done" projectId="" tickets={tickets} isPinnedMode />
      </TooltipProvider>
    )
    setKanbanDragData({
      projectId: 'proj-1',
      ticketId: 'shared',
      sourceColumn: 'todo',
      sourceIndex: 0
    })

    fireEvent.drop(container.querySelector('[data-testid="kanban-drop-area-done"]')!)

    await waitFor(() => expect(moveTicket).toHaveBeenCalled())
    expect(moveTicket).toHaveBeenCalledWith('shared', 'proj-1', 'done', 11)
  })

  test('aggregate simple mode moves directly when dropping into In Progress', async () => {
    const tickets = [
      makeTicket({ id: 'shared', project_id: 'proj-1', title: 'Project 1 Shared', sort_order: 10 }),
      makeTicket({ id: 'other', project_id: 'proj-2', title: 'Project 2 Other', sort_order: 100 })
    ]
    useKanbanStore.setState({
      tickets: new Map([
        ['proj-1', [tickets[0]]],
        ['proj-2', [tickets[1]]]
      ]),
      simpleModeByProject: { '': true }
    })
    const { container } = render(
      <TooltipProvider>
        <KanbanColumn column="in_progress" projectId="" tickets={tickets} isPinnedMode />
      </TooltipProvider>
    )
    setKanbanDragData({
      projectId: 'proj-1',
      ticketId: 'shared',
      sourceColumn: 'todo',
      sourceIndex: 0
    })

    fireEvent.drop(container.querySelector('[data-testid="kanban-drop-area-in_progress"]')!)

    await waitFor(() => expect(moveTicket).toHaveBeenCalled())
    expect(moveTicket).toHaveBeenCalledWith('shared', 'proj-1', 'in_progress', 11)
  })

  test('aggregate flow mode opens picker instead of moving directly when dropping into In Progress', async () => {
    const ticket = makeTicket({
      id: 'shared',
      project_id: 'proj-1',
      title: 'Project 1 Shared',
      sort_order: 10
    })
    useKanbanStore.setState({
      tickets: new Map([['proj-1', [ticket]]]),
      simpleModeByProject: { '': false }
    })
    const { container } = render(
      <TooltipProvider>
        <KanbanColumn column="in_progress" projectId="" tickets={[ticket]} isPinnedMode />
      </TooltipProvider>
    )
    setKanbanDragData({
      projectId: 'proj-1',
      ticketId: 'shared',
      sourceColumn: 'todo',
      sourceIndex: 0
    })

    fireEvent.drop(container.querySelector('[data-testid="kanban-drop-area-in_progress"]')!)

    await waitFor(() => expect(moveTicket).not.toHaveBeenCalled())
  })

  test('same-column reorder filters the dragged project key before computing sort order', async () => {
    const tickets = [
      makeTicket({ id: 'shared', project_id: 'proj-1', title: 'Project 1 Shared', sort_order: 0 }),
      makeTicket({ id: 'other', project_id: 'proj-1', title: 'Project 1 Other', sort_order: 10 }),
      makeTicket({
        id: 'shared',
        project_id: 'proj-2',
        title: 'Project 2 Shared',
        sort_order: 100
      }),
      makeTicket({ id: 'later', project_id: 'proj-2', title: 'Project 2 Later', sort_order: 200 })
    ]
    const { container } = render(
      <TooltipProvider>
        <KanbanColumn column="todo" projectId="" tickets={tickets} isPinnedMode />
      </TooltipProvider>
    )
    const dropArea = container.querySelector('[data-testid="kanban-drop-area-todo"]')!
    setKanbanDragData({
      projectId: 'proj-1',
      ticketId: 'shared',
      sourceColumn: 'todo',
      sourceIndex: 0
    })

    fireEvent.drop(dropArea)

    await waitFor(() => expect(reorderTicket).toHaveBeenCalled())
    expect(reorderTicket).toHaveBeenCalledWith('shared', 'proj-1', 11)
  })
})
