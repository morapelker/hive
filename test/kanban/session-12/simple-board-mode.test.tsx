import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

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
    toggle: vi.fn().mockResolvedValue(undefined)
  }
}

Object.defineProperty(window, 'kanban', {
  writable: true,
  configurable: true,
  value: mockKanban
})

// ── Mock window.db for backward-drag session completion ─────────────
const mockDb = {
  session: {
    update: vi.fn().mockResolvedValue(undefined)
  }
}

Object.defineProperty(window, 'db', {
  writable: true,
  configurable: true,
  value: mockDb
})

// ── Mock WorktreePickerModal to avoid Radix Dialog rendering in jsdom ──
// S12 does not test WorktreePickerModal internals (tested in S9).
// We mock it to prevent Radix Presence infinite loops in jsdom.
vi.mock('@/components/kanban/WorktreePickerModal', () => ({
  WorktreePickerModal: ({
    open,
    ticket
  }: {
    open: boolean
    ticket: { id: string }
    projectId: string
    onOpenChange: (v: boolean) => void
  }) =>
    open ? (
      <div data-testid={`mock-worktree-picker-${ticket.id}`}>WorktreePicker</div>
    ) : null
}))

// ── Import stores AFTER mocking ─────────────────────────────────────
import {
  useKanbanStore,
  setKanbanDragData
} from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

// ── Import components under test ────────────────────────────────────
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { KanbanTicketCard } from '@/components/kanban/KanbanTicketCard'

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
describe('Session 12: Simple Board Mode', () => {
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

  // ── Toggle switch rendering ──────────────────────────────────────

  test('toggle switch renders on In Progress column header', () => {
    render(
      <KanbanColumn column="in_progress" tickets={[]} projectId="proj-1" />
    )

    expect(screen.getByTestId('simple-mode-toggle')).toBeInTheDocument()
  })

  test('toggle switch does not render on other columns', () => {
    const { unmount: unmount1 } = render(
      <KanbanColumn column="todo" tickets={[]} projectId="proj-1" />
    )
    expect(screen.queryByTestId('simple-mode-toggle')).not.toBeInTheDocument()
    unmount1()

    const { unmount: unmount2 } = render(
      <KanbanColumn column="review" tickets={[]} projectId="proj-1" />
    )
    expect(screen.queryByTestId('simple-mode-toggle')).not.toBeInTheDocument()
    unmount2()

    render(
      <KanbanColumn column="done" tickets={[]} projectId="proj-1" />
    )
    expect(screen.queryByTestId('simple-mode-toggle')).not.toBeInTheDocument()
  })

  test('toggle calls setSimpleMode with correct project and value', async () => {
    // Default state: simple mode OFF → switch is ON (flow/automation active).
    // Clicking the switch turns it OFF → sets simple mode ON (true).
    render(
      <KanbanColumn column="in_progress" tickets={[]} projectId="proj-1" />
    )

    const toggle = screen.getByTestId('simple-mode-toggle')

    // Click to disable flow mode → enables simple mode
    await act(async () => {
      fireEvent.click(toggle)
    })

    expect(mockKanban.simpleMode.toggle).toHaveBeenCalledWith('proj-1', true)
  })

  // ── Drop behavior tests ──────────────────────────────────────────

  test('simple mode on: drop to In Progress skips worktree picker', () => {
    // Enable simple mode for project
    act(() => {
      useKanbanStore.setState({
        simpleModeByProject: { 'proj-1': true },
        tickets: new Map([
          [
            'proj-1',
            [makeTicket({ id: 't-drag', column: 'todo', sort_order: 0 })]
          ]
        ])
      })
    })

    render(
      <KanbanColumn column="in_progress" tickets={[]} projectId="proj-1" />
    )

    // Set drag data as if a todo ticket is being dragged
    setKanbanDragData({ ticketId: 't-drag', sourceColumn: 'todo', sourceIndex: 0 })

    const dropArea = screen.getByTestId('kanban-drop-area-in_progress')

    act(() => {
      dispatchDrag(dropArea, 'dragover', createMockDT())
      dispatchDrag(dropArea, 'drop', createMockDT())
    })

    // Should move directly without showing worktree picker
    expect(mockKanban.ticket.move).toHaveBeenCalledWith(
      't-drag',
      'in_progress',
      expect.any(Number)
    )
  })

  test('simple mode off: drop to In Progress triggers worktree picker', () => {
    // Simple mode off (default)
    act(() => {
      useKanbanStore.setState({
        simpleModeByProject: { 'proj-1': false },
        tickets: new Map([
          [
            'proj-1',
            [makeTicket({ id: 't-drag', column: 'todo', sort_order: 0 })]
          ]
        ])
      })
    })

    render(
      <KanbanColumn column="in_progress" tickets={[]} projectId="proj-1" />
    )

    // Set drag data
    setKanbanDragData({ ticketId: 't-drag', sourceColumn: 'todo', sourceIndex: 0 })

    const dropArea = screen.getByTestId('kanban-drop-area-in_progress')

    act(() => {
      dispatchDrag(dropArea, 'dragover', createMockDT())
      dispatchDrag(dropArea, 'drop', createMockDT())
    })

    // Should NOT move directly — worktree picker should be triggered instead
    expect(mockKanban.ticket.move).not.toHaveBeenCalled()
    // Verify mock worktree picker rendered (modal opened)
    expect(screen.getByTestId('mock-worktree-picker-t-drag')).toBeInTheDocument()
  })

  // ── Visual distinction tests ─────────────────────────────────────

  test('simple ticket card has no animated border', () => {
    // Simple ticket: in_progress, no session
    const ticket = makeTicket({
      id: 't-simple',
      column: 'in_progress',
      current_session_id: null,
      worktree_id: null,
      mode: null
    })

    const { container } = render(<KanbanTicketCard ticket={ticket} />)

    const card = container.querySelector(
      '[data-testid="kanban-ticket-t-simple"]'
    ) as HTMLElement
    // No animation on simple tickets
    expect(card?.style.animation).toBe('')
    // Default border, not blue or violet pulse
    expect(card?.className).not.toMatch(/blue/)
    expect(card?.className).toMatch(/border-border/)
  })

  test('simple ticket card has no worktree badge', () => {
    // Simple ticket: no worktree assigned
    const ticket = makeTicket({
      id: 't-simple',
      column: 'in_progress',
      current_session_id: null,
      worktree_id: null
    })

    render(<KanbanTicketCard ticket={ticket} />)

    // No worktree badge should be visible
    const card = screen.getByTestId('kanban-ticket-t-simple')
    // Simple tickets have no worktree badge or "Plan ready" badge
    expect(card.textContent).toBe('Test ticket')
  })

  test('flow ticket retains animated border when simple mode is toggled on', () => {
    // Set up session store with an active build session
    act(() => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          [
            'wt-1',
            [
              {
                id: 'session-flow',
                worktree_id: 'wt-1',
                project_id: 'proj-1',
                connection_id: null,
                name: 'Build session',
                status: 'active' as const,
                opencode_session_id: null,
                agent_sdk: 'opencode' as const,
                mode: 'build' as const,
                model_provider_id: null,
                model_id: null,
                model_variant: null,
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
                completed_at: null
              }
            ]
          ]
        ])
      })

      // Enable simple mode — should NOT affect existing flow ticket visual state
      useKanbanStore.setState({
        simpleModeByProject: { 'proj-1': true }
      })
    })

    // Flow ticket with active session
    const ticket = makeTicket({
      id: 't-flow',
      column: 'in_progress',
      current_session_id: 'session-flow',
      worktree_id: 'wt-1',
      mode: 'build'
    })

    const { container } = render(<KanbanTicketCard ticket={ticket} />)

    const card = container.querySelector(
      '[data-testid="kanban-ticket-t-flow"]'
    ) as HTMLElement

    // Flow ticket should retain solid blue border (progress bar requires worktree status 'working')
    expect(card?.className).toMatch(/blue/)
  })

  // ── Assign to worktree conversion ────────────────────────────────

  test('assign to worktree on simple ticket opens worktree picker', () => {
    // Simple ticket in in_progress (no session)
    const ticket = makeTicket({
      id: 't-simple-assign',
      column: 'in_progress',
      current_session_id: null,
      worktree_id: null
    })

    render(<KanbanTicketCard ticket={ticket} />)

    // Open context menu — right-click the card
    const card = screen.getByTestId('kanban-ticket-t-simple-assign')
    fireEvent.contextMenu(card)

    // "Assign to worktree" option should be visible for simple tickets
    expect(screen.getByTestId('ctx-assign-worktree')).toBeInTheDocument()
  })

  test('after assigning worktree, simple ticket becomes flow ticket with session', async () => {
    // This test verifies the contract: when WorktreePickerModal completes
    // for a simple ticket, it should call updateTicket to set session fields.
    // We test the store behavior directly since the modal integration was tested in S9.

    const simpleTicket = makeTicket({
      id: 't-convert',
      column: 'in_progress',
      current_session_id: null,
      worktree_id: null,
      mode: null,
      plan_ready: false
    })

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([['proj-1', [simpleTicket]]])
      })
    })

    // Simulate what WorktreePickerModal does: update the ticket with session fields
    mockKanban.ticket.update.mockResolvedValue(undefined)

    await act(async () => {
      await useKanbanStore.getState().updateTicket('t-convert', 'proj-1', {
        current_session_id: 'new-session-1',
        worktree_id: 'wt-1',
        mode: 'build'
      })
    })

    // Verify the ticket is now a flow ticket
    const updated = useKanbanStore
      .getState()
      .tickets.get('proj-1')
      ?.find((t) => t.id === 't-convert')

    expect(updated?.current_session_id).toBe('new-session-1')
    expect(updated?.worktree_id).toBe('wt-1')
    expect(updated?.mode).toBe('build')
  })
})
