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

// ── Import stores AFTER mocking ─────────────────────────────────────
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

// ── Import components under test ────────────────────────────────────
import { KanbanBoard } from '@/components/kanban/KanbanBoard'
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

// ── Setup ───────────────────────────────────────────────────────────
describe('Session 6: Board Components', () => {
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
    vi.clearAllMocks()
  })

  // ── KanbanBoard tests ───────────────────────────────────────────
  test('KanbanBoard renders 4 columns', () => {
    render(<KanbanBoard projectId="proj-1" />)

    expect(screen.getByTestId('kanban-column-todo')).toBeInTheDocument()
    expect(screen.getByTestId('kanban-column-in_progress')).toBeInTheDocument()
    expect(screen.getByTestId('kanban-column-review')).toBeInTheDocument()
    expect(screen.getByTestId('kanban-column-done')).toBeInTheDocument()
  })

  test('KanbanBoard calls loadTickets on mount', async () => {
    await act(async () => {
      render(<KanbanBoard projectId="proj-1" />)
    })

    expect(mockKanban.ticket.getByProject).toHaveBeenCalledWith('proj-1')
  })

  // ── KanbanColumn tests ──────────────────────────────────────────
  test('KanbanColumn renders column header with title and count', () => {
    const tickets = [
      makeTicket({ id: 't-1', column: 'todo' }),
      makeTicket({ id: 't-2', column: 'todo' })
    ]

    render(<KanbanColumn column="todo" tickets={tickets} projectId="proj-1" />)

    expect(screen.getByText('To Do')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  test('KanbanColumn renders ticket cards for its tickets', () => {
    const tickets = [
      makeTicket({ id: 't-1', title: 'First ticket', column: 'in_progress' }),
      makeTicket({ id: 't-2', title: 'Second ticket', column: 'in_progress' })
    ]

    render(<KanbanColumn column="in_progress" tickets={tickets} projectId="proj-1" />)

    expect(screen.getByTestId('kanban-ticket-t-1')).toBeInTheDocument()
    expect(screen.getByTestId('kanban-ticket-t-2')).toBeInTheDocument()
    expect(screen.getByText('First ticket')).toBeInTheDocument()
    expect(screen.getByText('Second ticket')).toBeInTheDocument()
  })

  test('KanbanColumn Done column toggles collapse state', () => {
    const tickets = [
      makeTicket({ id: 't-done-1', title: 'Done ticket', column: 'done' })
    ]

    render(<KanbanColumn column="done" tickets={tickets} projectId="proj-1" />)

    // Done column starts expanded — ticket should be visible
    expect(screen.getByTestId('kanban-ticket-t-done-1')).toBeInTheDocument()

    // Click the collapse toggle
    const toggleBtn = screen.getByTestId('kanban-column-done-toggle')
    fireEvent.click(toggleBtn)

    // After collapse, the ticket should not be visible
    expect(screen.queryByTestId('kanban-ticket-t-done-1')).not.toBeInTheDocument()

    // Click again to expand
    fireEvent.click(toggleBtn)
    expect(screen.getByTestId('kanban-ticket-t-done-1')).toBeInTheDocument()
  })

  // ── KanbanTicketCard tests ──────────────────────────────────────
  test('KanbanTicketCard renders title', () => {
    render(<KanbanTicketCard ticket={makeTicket({ title: 'My important task' })} />)

    expect(screen.getByText('My important task')).toBeInTheDocument()
  })

  test('KanbanTicketCard renders attachment badge when attachments exist', () => {
    const ticket = makeTicket({
      attachments: [{ name: 'file.png' }, { name: 'doc.pdf' }]
    })

    render(<KanbanTicketCard ticket={ticket} />)

    expect(screen.getByTestId('kanban-ticket-attachments')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  test('KanbanTicketCard does not render attachment badge when no attachments', () => {
    render(<KanbanTicketCard ticket={makeTicket({ attachments: [] })} />)

    expect(screen.queryByTestId('kanban-ticket-attachments')).not.toBeInTheDocument()
  })

  test('KanbanTicketCard renders worktree name when worktree_id is set', () => {
    // Set up worktree store with a matching worktree
    act(() => {
      useWorktreeStore.setState({
        worktreesByProject: new Map([
          [
            'proj-1',
            [
              {
                id: 'wt-1',
                project_id: 'proj-1',
                name: 'feature-branch',
                branch_name: 'feature-branch',
                path: '/tmp/test/feature',
                status: 'active' as const,
                is_default: false,
                branch_renamed: 0,
                last_message_at: null,
                session_titles: '[]',
                last_model_provider_id: null,
                last_model_id: null,
                last_model_variant: null,
                attachments: '[]',
                pinned: 0,
                context: null,
                github_pr_number: null,
                github_pr_url: null,
                created_at: '2026-01-01T00:00:00Z',
                last_accessed_at: '2026-01-01T00:00:00Z'
              }
            ]
          ]
        ])
      })
    })

    const ticket = makeTicket({ worktree_id: 'wt-1' })
    render(<KanbanTicketCard ticket={ticket} />)

    expect(screen.getByText('feature-branch')).toBeInTheDocument()
  })

  test('KanbanTicketCard applies pulsing blue border for active build ticket', () => {
    // Set up session store with an active session
    act(() => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          [
            'wt-1',
            [
              {
                id: 'session-1',
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
    })

    const ticket = makeTicket({
      current_session_id: 'session-1',
      worktree_id: 'wt-1',
      mode: 'build'
    })
    const { container } = render(<KanbanTicketCard ticket={ticket} />)

    const card = container.querySelector('[data-testid="kanban-ticket-ticket-1"]') as HTMLElement
    // Verify solid blue border + progress bar for active build ticket
    expect(card?.className).toMatch(/blue/)
    expect(card?.querySelector('[data-testid="kanban-ticket-progress"]')).toBeTruthy()
  })

  test('KanbanTicketCard applies pulsing violet border for active plan ticket', () => {
    // Set up session store with an active plan session
    act(() => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          [
            'wt-1',
            [
              {
                id: 'session-2',
                worktree_id: 'wt-1',
                project_id: 'proj-1',
                connection_id: null,
                name: 'Plan session',
                status: 'active' as const,
                opencode_session_id: null,
                agent_sdk: 'opencode' as const,
                mode: 'plan' as const,
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
    })

    const ticket = makeTicket({
      current_session_id: 'session-2',
      worktree_id: 'wt-1',
      mode: 'plan'
    })
    const { container } = render(<KanbanTicketCard ticket={ticket} />)

    const card = container.querySelector('[data-testid="kanban-ticket-ticket-1"]') as HTMLElement
    // Verify solid violet border + progress bar for active plan ticket
    expect(card?.className).toMatch(/violet/)
    expect(card?.querySelector('[data-testid="kanban-ticket-progress"]')).toBeTruthy()
  })

  test('KanbanTicketCard applies static violet border + Plan ready badge when plan_ready', () => {
    const ticket = makeTicket({ plan_ready: true })
    render(<KanbanTicketCard ticket={ticket} />)

    expect(screen.getByText('Plan ready')).toBeInTheDocument()

    const card = screen.getByTestId('kanban-ticket-ticket-1')
    expect(card.className).toMatch(/violet/)
    // Static border should NOT have pulsing animation
    expect(card.style.animation).toBe('')
  })

  test('KanbanTicketCard shows error badge when linked session has error status', () => {
    // Set up session store with an errored session
    act(() => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          [
            'wt-1',
            [
              {
                id: 'session-err',
                worktree_id: 'wt-1',
                project_id: 'proj-1',
                connection_id: null,
                name: 'Errored session',
                status: 'error' as const,
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
    })

    const ticket = makeTicket({
      current_session_id: 'session-err',
      worktree_id: 'wt-1'
    })
    render(<KanbanTicketCard ticket={ticket} />)

    expect(screen.getByText('Error')).toBeInTheDocument()
  })
})
