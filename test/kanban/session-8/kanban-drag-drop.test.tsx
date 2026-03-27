import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'

// ── Mock window.kanban BEFORE importing stores ──────────────────────
const mockKanban = {
  ticket: {
    create: vi.fn(),
    get: vi.fn(),
    getByProject: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    delete: vi.fn(),
    move: vi.fn().mockResolvedValue(undefined),
    reorder: vi.fn().mockResolvedValue(undefined),
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

// ── Import stores AFTER mocking ─────────────────────────────────────
import {
  useKanbanStore,
  setKanbanDragData,
  getKanbanDragData
} from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

// ── Import components under test ────────────────────────────────────
import { KanbanTicketCard } from '@/components/kanban/KanbanTicketCard'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'

import type { KanbanTicket } from '../../../src/main/db/types'

// ── Helpers ─────────────────────────────────────────────────────────
function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Test ticket',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

/** Create a mock DataTransfer with a readable/writable data store */
function createMockDT(initialData: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initialData }
  return {
    setData: vi.fn((key: string, val: string) => {
      store[key] = val
    }),
    getData: vi.fn((key: string) => store[key] ?? ''),
    effectAllowed: 'uninitialized' as string,
    dropEffect: 'none' as string,
    setDragImage: vi.fn()
  }
}

/**
 * Dispatch a native drag event on the given element with a mock DataTransfer.
 * React's event delegation picks up native events and invokes synthetic handlers.
 */
function dispatchDrag(
  element: Element,
  type: 'dragstart' | 'dragover' | 'dragleave' | 'drop' | 'dragend',
  dt?: ReturnType<typeof createMockDT>
) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  if (dt) {
    Object.defineProperty(event, 'dataTransfer', {
      value: dt,
      configurable: true,
      writable: true
    })
  }
  element.dispatchEvent(event)
  return event
}

// ── Setup ───────────────────────────────────────────────────────────
describe('Session 8: Drag-and-Drop', () => {
  beforeEach(() => {
    act(() => {
      useKanbanStore.setState({
        tickets: new Map(),
        isLoading: false,
        isBoardViewActive: false,
        simpleModeByProject: {}
      })
      useSessionStore.setState({
        activeSessionId: null,
        isLoading: false,
        sessionsByWorktree: new Map(),
        sessionsByConnection: new Map(),
        closedTerminalSessionIds: new Set(),
        inlineConnectionSessionId: null
      })
      useWorktreeStore.setState({
        selectedWorktreeId: null,
        worktreesByProject: new Map()
      })
    })
    // Clear shared drag state between tests
    setKanbanDragData(null)
    vi.clearAllMocks()
  })

  // ── Card drag source tests ────────────────────────────────────────

  test('ticket card has draggable=true', () => {
    const ticket = makeTicket({ id: 't-1' })
    render(<KanbanTicketCard ticket={ticket} />)

    const card = screen.getByTestId('kanban-ticket-t-1')
    expect(card.getAttribute('draggable')).toBe('true')
  })

  test('onDragStart sets correct transfer data', () => {
    const ticket = makeTicket({ id: 't-1', column: 'todo' })
    render(<KanbanTicketCard ticket={ticket} index={2} />)

    const card = screen.getByTestId('kanban-ticket-t-1')
    const dt = createMockDT()

    act(() => {
      dispatchDrag(card, 'dragstart', dt)
    })

    // Verify module-level drag data is set (primary mechanism)
    const dragData = getKanbanDragData()
    expect(dragData).toEqual({
      ticketId: 't-1',
      sourceColumn: 'todo',
      sourceIndex: 2
    })

    // Verify DataTransfer also receives data (for native drag feedback)
    expect(dt.setData).toHaveBeenCalledWith('text/plain', 't-1')
  })

  test('drag source gets invisible class during drag', () => {
    const ticket = makeTicket({ id: 't-drag' })
    render(<KanbanTicketCard ticket={ticket} />)

    const card = screen.getByTestId('kanban-ticket-t-drag')

    // Before drag — no opacity reduction
    expect(card.className).not.toContain('invisible')

    // Start drag
    act(() => {
      dispatchDrag(card, 'dragstart', createMockDT())
    })
    expect(card.className).toContain('invisible')

    // End drag — also clears shared drag data
    act(() => {
      dispatchDrag(card, 'dragend')
    })
    expect(card.className).not.toContain('invisible')
    expect(getKanbanDragData()).toBeNull()
  })

  // ── Column drop target tests ──────────────────────────────────────

  test('column onDragOver prevents default', () => {
    render(<KanbanColumn column="in_progress" tickets={[]} projectId="proj-1" />)

    const dropArea = screen.getByTestId('kanban-drop-area-in_progress')
    const event = dispatchDrag(dropArea, 'dragover', createMockDT())

    expect(event.defaultPrevented).toBe(true)
  })

  test('dropping ticket in different column calls moveTicket', () => {
    // Render target column (in_progress) — source is todo
    render(<KanbanColumn column="in_progress" tickets={[]} projectId="proj-1" />)

    // Set shared drag data (as KanbanTicketCard.onDragStart would)
    setKanbanDragData({ ticketId: 't-1', sourceColumn: 'todo', sourceIndex: 0 })

    const dropArea = screen.getByTestId('kanban-drop-area-in_progress')

    act(() => {
      // Fire dragover first to set drop index, then drop
      dispatchDrag(dropArea, 'dragover', createMockDT())
      dispatchDrag(dropArea, 'drop', createMockDT())
    })

    expect(mockKanban.ticket.move).toHaveBeenCalledWith(
      't-1',
      'in_progress',
      expect.any(Number)
    )
  })

  test('dropping ticket in same column at different position calls reorderTicket', () => {
    const tickets = [
      makeTicket({ id: 't-1', column: 'todo', sort_order: 0 }),
      makeTicket({ id: 't-2', column: 'todo', sort_order: 1 }),
      makeTicket({ id: 't-3', column: 'todo', sort_order: 2 })
    ]

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', tickets]])
      })
    })

    render(<KanbanColumn column="todo" tickets={tickets} projectId="proj-1" />)

    // Set shared drag data (as KanbanTicketCard.onDragStart would)
    setKanbanDragData({ ticketId: 't-1', sourceColumn: 'todo', sourceIndex: 0 })

    const dropArea = screen.getByTestId('kanban-drop-area-todo')

    act(() => {
      dispatchDrag(dropArea, 'dragover', createMockDT())
      dispatchDrag(dropArea, 'drop', createMockDT())
    })

    expect(mockKanban.ticket.reorder).toHaveBeenCalledWith('t-1', expect.any(Number))
  })

  // ── Sort order computation tests (store integration) ──────────────

  test('sort_order is computed as average of neighbors for mid-drop', () => {
    const tickets = [
      makeTicket({ id: 't-1', sort_order: 0 }),
      makeTicket({ id: 't-2', sort_order: 10 }),
      makeTicket({ id: 't-3', sort_order: 20 })
    ]

    const { computeSortOrder } = useKanbanStore.getState()

    // Drop between t-1 (sort_order=0) and t-2 (sort_order=10) at index 1
    const sortOrder = computeSortOrder(tickets, 1)
    expect(sortOrder).toBe(5) // (0 + 10) / 2
  })

  test('sort_order is (first - 1) for drop at beginning', () => {
    const tickets = [
      makeTicket({ id: 't-1', sort_order: 5 }),
      makeTicket({ id: 't-2', sort_order: 10 })
    ]

    const { computeSortOrder } = useKanbanStore.getState()

    const sortOrder = computeSortOrder(tickets, 0)
    expect(sortOrder).toBe(4) // 5 - 1
  })

  test('sort_order is (last + 1) for drop at end', () => {
    const tickets = [
      makeTicket({ id: 't-1', sort_order: 5 }),
      makeTicket({ id: 't-2', sort_order: 10 })
    ]

    const { computeSortOrder } = useKanbanStore.getState()

    const sortOrder = computeSortOrder(tickets, 2)
    expect(sortOrder).toBe(11) // 10 + 1
  })
})
