import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import type { KanbanTicket, KanbanTicketColumn } from '../../../src/main/db/types'

// ── Mock window.kanban before importing the store ──────────────────────
const mockKanban = {
  ticket: {
    create: vi.fn(),
    get: vi.fn(),
    getByProject: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    move: vi.fn(),
    reorder: vi.fn(),
    getBySession: vi.fn()
  },
  simpleMode: {
    toggle: vi.fn()
  }
}

Object.defineProperty(window, 'kanban', {
  writable: true,
  configurable: true,
  value: mockKanban
})

// Import after mocking window.kanban
import { useKanbanStore } from '@/stores/useKanbanStore'

// ── Helpers ────────────────────────────────────────────────────────────
function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: overrides.id ?? 'ticket-1',
    project_id: overrides.project_id ?? 'proj-1',
    title: overrides.title ?? 'Test Ticket',
    description: overrides.description ?? null,
    attachments: overrides.attachments ?? [],
    column: overrides.column ?? 'todo',
    sort_order: overrides.sort_order ?? 0,
    current_session_id: overrides.current_session_id ?? null,
    worktree_id: overrides.worktree_id ?? null,
    mode: overrides.mode ?? null,
    plan_ready: overrides.plan_ready ?? false,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00Z'
  }
}

// ── Setup ──────────────────────────────────────────────────────────────
describe('Session 4: Kanban Store', () => {
  beforeEach(() => {
    // Reset store state
    act(() => {
      useKanbanStore.setState({
        tickets: new Map(),
        isLoading: false,
        isBoardViewActive: false,
        simpleModeByProject: {}
      })
    })

    // Reset all mocks
    vi.clearAllMocks()
  })

  // ── loadTickets ────────────────────────────────────────────────────
  test('loadTickets fetches tickets from IPC and populates map', async () => {
    const tickets = [
      makeTicket({ id: 't1', sort_order: 1 }),
      makeTicket({ id: 't2', sort_order: 2 })
    ]
    mockKanban.ticket.getByProject.mockResolvedValue(tickets)

    await act(async () => {
      await useKanbanStore.getState().loadTickets('proj-1')
    })

    const state = useKanbanStore.getState()
    expect(state.tickets.get('proj-1')).toEqual(tickets)
    expect(mockKanban.ticket.getByProject).toHaveBeenCalledWith('proj-1')
    expect(state.isLoading).toBe(false)
  })

  // ── createTicket ───────────────────────────────────────────────────
  test('createTicket adds ticket to local state and calls IPC', async () => {
    const newTicket = makeTicket({ id: 't-new', title: 'New Ticket' })
    mockKanban.ticket.create.mockResolvedValue(newTicket)

    // Pre-populate with existing tickets
    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [makeTicket({ id: 't-existing' })]]])
      })
    })

    let result: KanbanTicket | undefined
    await act(async () => {
      result = await useKanbanStore.getState().createTicket('proj-1', {
        project_id: 'proj-1',
        title: 'New Ticket'
      })
    })

    expect(result).toEqual(newTicket)
    expect(mockKanban.ticket.create).toHaveBeenCalledWith({
      project_id: 'proj-1',
      title: 'New Ticket'
    })
    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    expect(tickets).toBeDefined()
    expect(tickets!.some((t) => t.id === 't-new')).toBe(true)
  })

  // ── updateTicket ───────────────────────────────────────────────────
  test('updateTicket modifies ticket in local state', async () => {
    const original = makeTicket({ id: 't1', title: 'Original' })
    const updated = { ...original, title: 'Updated' }
    mockKanban.ticket.update.mockResolvedValue(updated)

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [original]]])
      })
    })

    await act(async () => {
      await useKanbanStore.getState().updateTicket('t1', 'proj-1', { title: 'Updated' })
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    expect(tickets![0].title).toBe('Updated')
    expect(mockKanban.ticket.update).toHaveBeenCalledWith('t1', { title: 'Updated' })
  })

  // ── deleteTicket ───────────────────────────────────────────────────
  test('deleteTicket removes ticket from local state', async () => {
    const ticket = makeTicket({ id: 't1' })
    mockKanban.ticket.delete.mockResolvedValue(true)

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      await useKanbanStore.getState().deleteTicket('t1', 'proj-1')
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    expect(tickets).toEqual([])
    expect(mockKanban.ticket.delete).toHaveBeenCalledWith('t1')
  })

  // ── moveTicket ─────────────────────────────────────────────────────
  test('moveTicket updates column and sort_order in local state', async () => {
    const ticket = makeTicket({ id: 't1', column: 'todo', sort_order: 0 })
    const movedTicket = { ...ticket, column: 'in_progress' as KanbanTicketColumn, sort_order: 5 }
    mockKanban.ticket.move.mockResolvedValue(movedTicket)

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      await useKanbanStore.getState().moveTicket('t1', 'proj-1', 'in_progress', 5)
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    const moved = tickets!.find((t) => t.id === 't1')
    expect(moved!.column).toBe('in_progress')
    expect(moved!.sort_order).toBe(5)
    expect(mockKanban.ticket.move).toHaveBeenCalledWith('t1', 'in_progress', 5)
  })

  // ── reorderTicket ──────────────────────────────────────────────────
  test('reorderTicket computes fractional sort_order between neighbors', async () => {
    const ticket = makeTicket({ id: 't1', column: 'todo', sort_order: 0 })
    mockKanban.ticket.reorder.mockResolvedValue(undefined)

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      await useKanbanStore.getState().reorderTicket('t1', 'proj-1', 2.5)
    })

    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    expect(tickets![0].sort_order).toBe(2.5)
    expect(mockKanban.ticket.reorder).toHaveBeenCalledWith('t1', 2.5)
  })

  // ── computeSortOrder: beginning ────────────────────────────────────
  test('computeSortOrder: inserting at beginning uses (first.sortOrder - 1)', () => {
    const tickets = [
      makeTicket({ id: 't1', sort_order: 5 }),
      makeTicket({ id: 't2', sort_order: 10 })
    ]

    const { computeSortOrder } = useKanbanStore.getState()
    const result = computeSortOrder(tickets, 0)
    expect(result).toBe(4)
  })

  // ── computeSortOrder: end ──────────────────────────────────────────
  test('computeSortOrder: inserting at end uses (last.sortOrder + 1)', () => {
    const tickets = [
      makeTicket({ id: 't1', sort_order: 5 }),
      makeTicket({ id: 't2', sort_order: 10 })
    ]

    const { computeSortOrder } = useKanbanStore.getState()
    const result = computeSortOrder(tickets, 2)
    expect(result).toBe(11)
  })

  // ── computeSortOrder: between ──────────────────────────────────────
  test('computeSortOrder: inserting between uses average of neighbors', () => {
    const tickets = [
      makeTicket({ id: 't1', sort_order: 2 }),
      makeTicket({ id: 't2', sort_order: 8 }),
      makeTicket({ id: 't3', sort_order: 14 })
    ]

    const { computeSortOrder } = useKanbanStore.getState()
    const result = computeSortOrder(tickets, 1)
    // Average of tickets[0].sort_order (2) and tickets[1].sort_order (8) = 5
    expect(result).toBe(5)
  })

  // ── computeSortOrder: empty list ───────────────────────────────────
  test('computeSortOrder: empty list returns 0', () => {
    const { computeSortOrder } = useKanbanStore.getState()
    const result = computeSortOrder([], 0)
    expect(result).toBe(0)
  })

  // ── toggleBoardView ────────────────────────────────────────────────
  test('toggleBoardView flips isBoardViewActive', () => {
    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)

    act(() => {
      useKanbanStore.getState().toggleBoardView()
    })
    expect(useKanbanStore.getState().isBoardViewActive).toBe(true)

    act(() => {
      useKanbanStore.getState().toggleBoardView()
    })
    expect(useKanbanStore.getState().isBoardViewActive).toBe(false)
  })

  // ── setSimpleMode ──────────────────────────────────────────────────
  test('setSimpleMode updates simpleModeByProject for given project', async () => {
    mockKanban.simpleMode.toggle.mockResolvedValue(undefined)

    await act(async () => {
      await useKanbanStore.getState().setSimpleMode('proj-1', true)
    })

    expect(useKanbanStore.getState().simpleModeByProject['proj-1']).toBe(true)
    expect(mockKanban.simpleMode.toggle).toHaveBeenCalledWith('proj-1', true)

    await act(async () => {
      await useKanbanStore.getState().setSimpleMode('proj-1', false)
    })

    expect(useKanbanStore.getState().simpleModeByProject['proj-1']).toBe(false)
  })

  // ── getTicketsForProject ───────────────────────────────────────────
  test('getTicketsForProject returns tickets sorted by column then sort_order', () => {
    const tickets = [
      makeTicket({ id: 't3', column: 'in_progress', sort_order: 1 }),
      makeTicket({ id: 't1', column: 'todo', sort_order: 2 }),
      makeTicket({ id: 't4', column: 'in_progress', sort_order: 0 }),
      makeTicket({ id: 't2', column: 'todo', sort_order: 1 })
    ]

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', tickets]])
      })
    })

    const sorted = useKanbanStore.getState().getTicketsForProject('proj-1')

    // Column order: todo < in_progress < review < done
    // Within same column, by sort_order ascending
    expect(sorted.map((t) => t.id)).toEqual(['t2', 't1', 't4', 't3'])
  })

  test('getTicketsForProject returns empty array for unknown project', () => {
    const result = useKanbanStore.getState().getTicketsForProject('nonexistent')
    expect(result).toEqual([])
  })

  // ── getTicketsByColumn ─────────────────────────────────────────────
  test('getTicketsByColumn filters tickets to a specific column', () => {
    const tickets = [
      makeTicket({ id: 't1', column: 'todo', sort_order: 2 }),
      makeTicket({ id: 't2', column: 'in_progress', sort_order: 1 }),
      makeTicket({ id: 't3', column: 'todo', sort_order: 1 })
    ]

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', tickets]])
      })
    })

    const todoTickets = useKanbanStore.getState().getTicketsByColumn('proj-1', 'todo')
    expect(todoTickets).toHaveLength(2)
    // Should be sorted by sort_order
    expect(todoTickets.map((t) => t.id)).toEqual(['t3', 't1'])

    const inProgressTickets = useKanbanStore.getState().getTicketsByColumn('proj-1', 'in_progress')
    expect(inProgressTickets).toHaveLength(1)
    expect(inProgressTickets[0].id).toBe('t2')
  })

  test('getTicketsByColumn returns empty array for unknown project', () => {
    const result = useKanbanStore.getState().getTicketsByColumn('nonexistent', 'todo')
    expect(result).toEqual([])
  })

  // ── Optimistic update revert on IPC failure ────────────────────────
  test('optimistic update reverts on IPC failure for updateTicket', async () => {
    const original = makeTicket({ id: 't1', title: 'Original Title' })
    mockKanban.ticket.update.mockRejectedValue(new Error('IPC failed'))

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [original]]])
      })
    })

    await act(async () => {
      try {
        await useKanbanStore.getState().updateTicket('t1', 'proj-1', { title: 'New Title' })
      } catch {
        // Expected to throw
      }
    })

    // Should revert to original title
    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    expect(tickets![0].title).toBe('Original Title')
  })

  test('optimistic update reverts on IPC failure for deleteTicket', async () => {
    const ticket = makeTicket({ id: 't1' })
    mockKanban.ticket.delete.mockRejectedValue(new Error('IPC failed'))

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      try {
        await useKanbanStore.getState().deleteTicket('t1', 'proj-1')
      } catch {
        // Expected to throw
      }
    })

    // Should revert — ticket should still be there
    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    expect(tickets).toHaveLength(1)
    expect(tickets![0].id).toBe('t1')
  })

  test('optimistic update reverts on IPC failure for moveTicket', async () => {
    const ticket = makeTicket({ id: 't1', column: 'todo', sort_order: 0 })
    mockKanban.ticket.move.mockRejectedValue(new Error('IPC failed'))

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [ticket]]])
      })
    })

    await act(async () => {
      try {
        await useKanbanStore.getState().moveTicket('t1', 'proj-1', 'done', 99)
      } catch {
        // Expected to throw
      }
    })

    // Should revert to original column and sort_order
    const tickets = useKanbanStore.getState().tickets.get('proj-1')
    expect(tickets![0].column).toBe('todo')
    expect(tickets![0].sort_order).toBe(0)
  })
})
