/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// ── Mock window APIs BEFORE importing stores ────────────────────────
const mockKanban = {
  ticket: {
    create: vi.fn(),
    get: vi.fn(),
    getByProject: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
    reorder: vi.fn(),
    getBySession: vi.fn()
  },
  simpleMode: { toggle: vi.fn() }
}

Object.defineProperty(window, 'kanban', {
  writable: true,
  configurable: true,
  value: mockKanban
})

Object.defineProperty(window, 'fileOps', {
  writable: true,
  configurable: true,
  value: {
    getPathForFile: vi.fn().mockReturnValue('/mock/path/file.txt')
  }
})

// ── Mock toast ──────────────────────────────────────────────────────
vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  },
  default: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  }
}))

// ── Mock radix dropdown to avoid portal issues in test ──────────────
vi.mock('@radix-ui/react-dropdown-menu', () => {
  const React = require('react')
  return {
    Root: ({ children, open, onOpenChange }: any) => {
      const [isOpen, setIsOpen] = React.useState(open ?? false)
      return React.createElement(
        'div',
        { 'data-testid': 'dropdown-root', 'data-state': isOpen ? 'open' : 'closed' },
        React.Children.map(children, (child: any) =>
          child
            ? React.cloneElement(child, {
                _isOpen: isOpen,
                _setIsOpen: (v: boolean) => {
                  setIsOpen(v)
                  onOpenChange?.(v)
                }
              })
            : null
        )
      )
    },
    Trigger: React.forwardRef(({ children, _isOpen, _setIsOpen, asChild: _asChild, ...props }: any, ref: any) =>
      React.createElement(
        'button',
        {
          ...props,
          ref,
          'data-testid': props['data-testid'] ?? 'dropdown-trigger',
          onClick: (e: any) => {
            _setIsOpen?.(!_isOpen)
            props.onClick?.(e)
          }
        },
        children
      )
    ),
    Portal: ({ children }: any) => children,
    Content: React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement('div', { ...props, ref, 'data-testid': 'dropdown-content', role: 'menu' }, children)
    ),
    Item: React.forwardRef(({ children, onSelect, ...props }: any, ref: any) =>
      React.createElement(
        'div',
        {
          ...props,
          ref,
          role: 'menuitem',
          onClick: (e: any) => {
            onSelect?.(e)
            props.onClick?.(e)
          }
        },
        children
      )
    ),
    Group: ({ children }: any) => React.createElement('div', { role: 'group' }, children),
    Label: ({ children }: any) => React.createElement('div', null, children),
    Separator: () => React.createElement('hr'),
    CheckboxItem: ({ children }: any) => React.createElement('div', null, children),
    RadioGroup: ({ children }: any) => React.createElement('div', null, children),
    RadioItem: ({ children }: any) => React.createElement('div', null, children),
    Sub: ({ children }: any) => React.createElement('div', null, children),
    SubTrigger: ({ children }: any) => React.createElement('div', null, children),
    SubContent: ({ children }: any) => React.createElement('div', null, children)
  }
})

// ── Mock radix tooltip to avoid portal issues in test ───────────────
vi.mock('radix-ui', () => {
  const React = require('react')
  return {
    Tooltip: {
      Provider: ({ children }: any) => React.createElement('div', null, children),
      Root: ({ children }: any) => React.createElement('div', null, children),
      Trigger: React.forwardRef(({ children, ...props }: any, ref: any) =>
        React.createElement('div', { ...props, ref }, children)
      ),
      Portal: ({ children }: any) => children,
      Content: ({ children }: any) =>
        React.createElement('div', { 'data-testid': 'tooltip-content' }, children),
      Arrow: () => null
    }
  }
})

// ── Mock Dialog for TicketPickerModal ───────────────────────────────
vi.mock('@/components/ui/dialog', () => {
  const React = require('react')
  return {
    Dialog: ({ children, open }: any) =>
      open ? React.createElement('div', { 'data-testid': 'dialog-root', role: 'dialog' }, children) : null,
    DialogContent: React.forwardRef(({ children, ...props }: any, ref: any) =>
      React.createElement('div', { ...props, ref, 'data-testid': 'dialog-content' }, children)
    ),
    DialogHeader: ({ children }: any) =>
      React.createElement('div', { 'data-testid': 'dialog-header' }, children),
    DialogFooter: ({ children }: any) =>
      React.createElement('div', { 'data-testid': 'dialog-footer' }, children),
    DialogTitle: ({ children }: any) =>
      React.createElement('h2', { 'data-testid': 'dialog-title' }, children),
    DialogDescription: ({ children }: any) =>
      React.createElement('p', { 'data-testid': 'dialog-description' }, children)
  }
})

// ── Import stores AFTER mocking ─────────────────────────────────────
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'

// ── Import components under test ────────────────────────────────────
import { AttachmentButton } from '@/components/sessions/AttachmentButton'
import { TicketAttachments } from '@/components/sessions/TicketAttachments'
import type { Attachment } from '@/components/sessions/AttachmentPreview'
import { TicketPickerModal } from '@/components/kanban/TicketPickerModal'
import { buildMessageParts, MAX_ATTACHMENTS } from '@/lib/file-attachment-utils'

import type { KanbanTicket } from '../../../src/main/db/types'

// ── Helpers ─────────────────────────────────────────────────────────
function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Implement auth flow',
    description: 'Add login and signup pages with JWT tokens',
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
beforeEach(() => {
  vi.clearAllMocks()

  // Reset kanban store tickets
  act(() => {
    useKanbanStore.setState({ tickets: new Map() })
  })

  // Reset project store
  act(() => {
    useProjectStore.setState({
      projects: [],
      selectedProjectId: null
    })
  })
})

// ── Tests ───────────────────────────────────────────────────────────
describe('Session 13: Ticket Attachment', () => {
  test('"Board ticket" option renders in attachment button when project selected', () => {
    // Set up a selected project
    act(() => {
      useProjectStore.setState({
        projects: [
          {
            id: 'proj-1',
            name: 'Test Project',
            path: '/test/project',
            description: null,
            tags: null,
            language: null,
            custom_icon: null,
            setup_script: null,
            run_script: null,
            archive_script: null,
            auto_assign_port: false,
            sort_order: 0,
            created_at: '2026-01-01T00:00:00Z',
            last_accessed_at: '2026-01-01T00:00:00Z'
          }
        ],
        selectedProjectId: 'proj-1'
      })
    })

    const onAttach = vi.fn()
    render(
      <AttachmentButton
        onAttach={onAttach}
        projectId="proj-1"
        onPickTicket={() => {}}
      />
    )

    // Click the dropdown trigger
    const trigger = screen.getByTestId('attachment-button')
    fireEvent.click(trigger)

    // Board ticket option should be visible
    expect(screen.getByTestId('attach-board-ticket')).toBeTruthy()
  })

  test('"Board ticket" option hidden when no project selected', () => {
    // No project selected
    act(() => {
      useProjectStore.setState({
        projects: [],
        selectedProjectId: null
      })
    })

    const onAttach = vi.fn()
    render(
      <AttachmentButton
        onAttach={onAttach}
        projectId={null}
        onPickTicket={() => {}}
      />
    )

    // Click the dropdown trigger
    const trigger = screen.getByTestId('attachment-button')
    fireEvent.click(trigger)

    // Board ticket option should NOT be visible
    expect(screen.queryByTestId('attach-board-ticket')).toBeNull()
  })

  test('ticket picker shows all project tickets', async () => {
    const tickets = [
      makeTicket({ id: 'ticket-1', title: 'Auth flow', column: 'todo' }),
      makeTicket({ id: 'ticket-2', title: 'Dashboard UI', column: 'in_progress' }),
      makeTicket({ id: 'ticket-3', title: 'API endpoints', column: 'review' }),
      makeTicket({ id: 'ticket-4', title: 'Deploy pipeline', column: 'done' })
    ]

    // Load tickets into the store
    act(() => {
      const ticketsMap = new Map<string, KanbanTicket[]>()
      ticketsMap.set('proj-1', tickets)
      useKanbanStore.setState({ tickets: ticketsMap })
    })

    render(
      <TicketPickerModal
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
        onSelectTickets={() => {}}
      />
    )

    // All 4 tickets should be displayed
    expect(screen.getByText('Auth flow')).toBeTruthy()
    expect(screen.getByText('Dashboard UI')).toBeTruthy()
    expect(screen.getByText('API endpoints')).toBeTruthy()
    expect(screen.getByText('Deploy pipeline')).toBeTruthy()
  })

  test('search input filters tickets by title case-insensitively', async () => {
    const tickets = [
      makeTicket({ id: 'ticket-1', title: 'Auth flow', column: 'todo' }),
      makeTicket({ id: 'ticket-2', title: 'Dashboard UI', column: 'in_progress' }),
      makeTicket({ id: 'ticket-3', title: 'authentication API', column: 'review' })
    ]

    act(() => {
      const ticketsMap = new Map<string, KanbanTicket[]>()
      ticketsMap.set('proj-1', tickets)
      useKanbanStore.setState({ tickets: ticketsMap })
    })

    render(
      <TicketPickerModal
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
        onSelectTickets={() => {}}
      />
    )

    // Type "auth" (lowercase) in search
    const searchInput = screen.getByTestId('ticket-search-input')
    fireEvent.change(searchInput, { target: { value: 'auth' } })

    // "Auth flow" and "authentication API" should match, "Dashboard UI" should not
    expect(screen.getByText('Auth flow')).toBeTruthy()
    expect(screen.getByText('authentication API')).toBeTruthy()
    expect(screen.queryByText('Dashboard UI')).toBeNull()
  })

  test('column filter chips toggle correctly', async () => {
    const tickets = [
      makeTicket({ id: 'ticket-1', title: 'Todo ticket', column: 'todo' }),
      makeTicket({ id: 'ticket-2', title: 'Progress ticket', column: 'in_progress' }),
      makeTicket({ id: 'ticket-3', title: 'Review ticket', column: 'review' })
    ]

    act(() => {
      const ticketsMap = new Map<string, KanbanTicket[]>()
      ticketsMap.set('proj-1', tickets)
      useKanbanStore.setState({ tickets: ticketsMap })
    })

    render(
      <TicketPickerModal
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
        onSelectTickets={() => {}}
      />
    )

    // Initially all tickets visible (no filters active)
    expect(screen.getByText('Todo ticket')).toBeTruthy()
    expect(screen.getByText('Progress ticket')).toBeTruthy()
    expect(screen.getByText('Review ticket')).toBeTruthy()

    // Click "To Do" filter chip
    const todoChip = screen.getByTestId('column-filter-todo')
    fireEvent.click(todoChip)

    // Only "Todo ticket" should show
    expect(screen.getByText('Todo ticket')).toBeTruthy()
    expect(screen.queryByText('Progress ticket')).toBeNull()
    expect(screen.queryByText('Review ticket')).toBeNull()

    // Click "In Progress" too (multi-select)
    const progressChip = screen.getByTestId('column-filter-in_progress')
    fireEvent.click(progressChip)

    // Both should show
    expect(screen.getByText('Todo ticket')).toBeTruthy()
    expect(screen.getByText('Progress ticket')).toBeTruthy()
    expect(screen.queryByText('Review ticket')).toBeNull()
  })

  test('selecting a ticket adds it to attachment list', async () => {
    const tickets = [
      makeTicket({ id: 'ticket-1', title: 'Auth flow', description: 'Build the auth' })
    ]

    act(() => {
      const ticketsMap = new Map<string, KanbanTicket[]>()
      ticketsMap.set('proj-1', tickets)
      useKanbanStore.setState({ tickets: ticketsMap })
    })

    const onSelectTickets = vi.fn()

    render(
      <TicketPickerModal
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
        onSelectTickets={onSelectTickets}
      />
    )

    // Click the ticket row to select it
    const ticketRow = screen.getByTestId('ticket-row-ticket-1')
    fireEvent.click(ticketRow)

    // Click the "Done" button to confirm selection
    const doneButton = screen.getByTestId('ticket-picker-done')
    fireEvent.click(doneButton)

    // onSelectTickets should be called with the selected ticket(s)
    expect(onSelectTickets).toHaveBeenCalledTimes(1)
    const selectedTickets = onSelectTickets.mock.calls[0][0]
    expect(selectedTickets).toHaveLength(1)
    expect(selectedTickets[0].ticketId).toBe('ticket-1')
    expect(selectedTickets[0].title).toBe('Auth flow')
  })

  test('ticket chip renders with kanban icon and title', () => {
    const ticketAttachment: Attachment = {
      kind: 'ticket',
      id: 'att-1',
      name: 'Auth flow',
      ticketId: 'ticket-1',
      title: 'Auth flow',
      description: 'Build the auth',
      attachments: '[]'
    }

    render(
      <TicketAttachments
        attachments={[ticketAttachment]}
        onRemove={() => {}}
      />
    )

    // Should render the ticket card
    const chip = screen.getByTestId('attachment-item-ticket')
    expect(chip).toBeTruthy()

    // Should show the ticket title
    expect(screen.getByText('Auth flow')).toBeTruthy()

    // Should show the description
    expect(screen.getByText('Build the auth')).toBeTruthy()
  })

  test('multiple tickets can be attached up to 10-attachment limit', () => {
    // Create 10 ticket attachments (at the MAX_ATTACHMENTS limit)
    const attachments: Attachment[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'ticket' as const,
      id: `att-${i}`,
      name: `Ticket ${i}`,
      ticketId: `ticket-${i}`,
      title: `Ticket ${i}`,
      description: `Description ${i}`,
      attachments: '[]'
    }))

    render(
      <TicketAttachments
        attachments={attachments}
        onRemove={() => {}}
      />
    )

    // All 10 should be rendered
    const items = screen.getAllByTestId('attachment-item-ticket')
    expect(items).toHaveLength(10)

    // Verify MAX_ATTACHMENTS is 10
    expect(MAX_ATTACHMENTS).toBe(10)
  })

  test('ticket attachment is serialized as XML block in message parts', () => {
    const attachments: Attachment[] = [
      {
        kind: 'ticket',
        id: 'att-1',
        name: 'Auth flow',
        ticketId: 'ticket-1',
        title: 'Auth flow',
        description: 'Add login and signup pages with JWT tokens',
        attachments: '[]'
      }
    ]

    const parts = buildMessageParts(attachments, 'Please review this')

    // Should have 2 parts: ticket XML block + prompt text
    expect(parts).toHaveLength(2)

    // First part is the ticket XML block
    const xmlPart = parts[0]
    expect(xmlPart.type).toBe('text')
    expect((xmlPart as any).text).toContain('<ticket title="Auth flow">')
    expect((xmlPart as any).text).toContain('Add login and signup pages with JWT tokens')
    expect((xmlPart as any).text).toContain('</ticket>')

    // Second part is the prompt text
    expect(parts[1]).toEqual({ type: 'text', text: 'Please review this' })
  })

  test('ticket XML block includes title and description', () => {
    const attachments: Attachment[] = [
      {
        kind: 'ticket',
        id: 'att-1',
        name: 'Deploy pipeline',
        ticketId: 'ticket-1',
        title: 'Deploy pipeline',
        description: 'Set up CI/CD with GitHub Actions',
        attachments: '[{"name":"config.yml"}]'
      },
      {
        kind: 'ticket',
        id: 'att-2',
        name: 'API endpoints',
        ticketId: 'ticket-2',
        title: 'API endpoints',
        description: 'REST API for user management',
        attachments: '[]'
      }
    ]

    const parts = buildMessageParts(attachments, 'Help with these')

    // Should have 2 parts: tickets XML block + prompt text
    expect(parts).toHaveLength(2)

    const xmlText = (parts[0] as any).text
    // Both tickets should be present as XML blocks
    expect(xmlText).toContain('<ticket title="Deploy pipeline">')
    expect(xmlText).toContain('Set up CI/CD with GitHub Actions')
    expect(xmlText).toContain('</ticket>')
    expect(xmlText).toContain('<ticket title="API endpoints">')
    expect(xmlText).toContain('REST API for user management')
  })

  test('attaching ticket does not modify ticket state in kanban store', async () => {
    const ticket = makeTicket({
      id: 'ticket-1',
      title: 'Auth flow',
      column: 'todo',
      description: 'Build the auth'
    })

    // Load ticket into store
    act(() => {
      const ticketsMap = new Map<string, KanbanTicket[]>()
      ticketsMap.set('proj-1', [ticket])
      useKanbanStore.setState({ tickets: ticketsMap })
    })

    // Snapshot the ticket state before attaching
    const ticketBefore = useKanbanStore.getState().tickets.get('proj-1')![0]
    const columnBefore = ticketBefore.column
    const sessionBefore = ticketBefore.current_session_id
    const modeBefore = ticketBefore.mode

    const onSelectTickets = vi.fn()

    // Render the ticket picker and select a ticket
    render(
      <TicketPickerModal
        projectId="proj-1"
        open={true}
        onOpenChange={() => {}}
        onSelectTickets={onSelectTickets}
      />
    )

    // Select the ticket
    fireEvent.click(screen.getByTestId('ticket-row-ticket-1'))
    fireEvent.click(screen.getByTestId('ticket-picker-done'))

    // Verify the ticket state in the kanban store is UNCHANGED
    const ticketAfter = useKanbanStore.getState().tickets.get('proj-1')![0]
    expect(ticketAfter.column).toBe(columnBefore)
    expect(ticketAfter.current_session_id).toBe(sessionBefore)
    expect(ticketAfter.mode).toBe(modeBefore)

    // Verify no kanban mutation APIs were called
    expect(mockKanban.ticket.update).not.toHaveBeenCalled()
    expect(mockKanban.ticket.move).not.toHaveBeenCalled()
    expect(mockKanban.ticket.delete).not.toHaveBeenCalled()
  })
})
