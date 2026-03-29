import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

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

// ── Import stores AFTER mocking ─────────────────────────────────────
import { useKanbanStore } from '@/stores/useKanbanStore'

// ── Import components under test ────────────────────────────────────
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { TicketCreateModal } from '@/components/kanban/TicketCreateModal'

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
describe('Session 7: Ticket Creation Modal', () => {
  beforeEach(() => {
    act(() => {
      useKanbanStore.setState({
        tickets: new Map(),
        isLoading: false,
        isBoardViewActive: false,
        simpleModeByProject: {}
      })
    })
    vi.clearAllMocks()
  })

  // ── Add-ticket card tests ─────────────────────────────────────────

  test('add-ticket card renders in empty To Do column', () => {
    render(<KanbanColumn column="todo" tickets={[]} projectId="proj-1" />)

    expect(screen.getByTestId('kanban-add-ticket-card')).toBeInTheDocument()
  })

  test('add-ticket card does not render in other empty columns', () => {
    const { unmount: u1 } = render(
      <KanbanColumn column="in_progress" tickets={[]} projectId="proj-1" />
    )
    expect(screen.queryByTestId('kanban-add-ticket-card')).not.toBeInTheDocument()
    u1()

    const { unmount: u2 } = render(
      <KanbanColumn column="review" tickets={[]} projectId="proj-1" />
    )
    expect(screen.queryByTestId('kanban-add-ticket-card')).not.toBeInTheDocument()
    u2()

    render(<KanbanColumn column="done" tickets={[]} projectId="proj-1" />)
    expect(screen.queryByTestId('kanban-add-ticket-card')).not.toBeInTheDocument()
  })

  test('clicking add-ticket card opens the creation modal', () => {
    render(<KanbanColumn column="todo" tickets={[]} projectId="proj-1" />)

    const addCard = screen.getByTestId('kanban-add-ticket-card')
    fireEvent.click(addCard)

    expect(screen.getByTestId('ticket-create-modal')).toBeInTheDocument()
  })

  // ── TicketCreateModal tests ───────────────────────────────────────
  test('Create button is disabled when title is empty', () => {
    render(
      <TicketCreateModal open={true} onOpenChange={vi.fn()} projectId="proj-1" />
    )

    const createBtn = screen.getByTestId('ticket-create-btn')
    expect(createBtn).toBeDisabled()
  })

  test('Create button is enabled when title is provided', () => {
    render(
      <TicketCreateModal open={true} onOpenChange={vi.fn()} projectId="proj-1" />
    )

    const titleInput = screen.getByTestId('ticket-title-input')
    fireEvent.change(titleInput, { target: { value: 'New ticket title' } })

    const createBtn = screen.getByTestId('ticket-create-btn')
    expect(createBtn).not.toBeDisabled()
  })

  test('submitting calls createTicket with correct data', async () => {
    const createdTicket = makeTicket({ id: 'new-1', title: 'My new ticket' })
    mockKanban.ticket.create.mockResolvedValueOnce(createdTicket)

    const onOpenChange = vi.fn()
    render(
      <TicketCreateModal open={true} onOpenChange={onOpenChange} projectId="proj-1" />
    )

    // Fill title
    const titleInput = screen.getByTestId('ticket-title-input')
    fireEvent.change(titleInput, { target: { value: 'My new ticket' } })

    // Fill description
    const descInput = screen.getByTestId('ticket-description-input')
    fireEvent.change(descInput, { target: { value: '## Description\nSome markdown content' } })

    // Submit
    const createBtn = screen.getByTestId('ticket-create-btn')
    await act(async () => {
      fireEvent.click(createBtn)
    })

    await waitFor(() => {
      expect(mockKanban.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: 'proj-1',
          title: 'My new ticket',
          description: '## Description\nSome markdown content',
          column: 'todo'
        })
      )
    })
  })

  test('modal closes after successful creation', async () => {
    const createdTicket = makeTicket({ id: 'new-1', title: 'Success ticket' })
    mockKanban.ticket.create.mockResolvedValueOnce(createdTicket)

    const onOpenChange = vi.fn()
    render(
      <TicketCreateModal open={true} onOpenChange={onOpenChange} projectId="proj-1" />
    )

    // Fill title and submit
    const titleInput = screen.getByTestId('ticket-title-input')
    fireEvent.change(titleInput, { target: { value: 'Success ticket' } })

    const createBtn = screen.getByTestId('ticket-create-btn')
    await act(async () => {
      fireEvent.click(createBtn)
    })

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  test('Cancel button closes modal without creating', () => {
    const onOpenChange = vi.fn()
    render(
      <TicketCreateModal open={true} onOpenChange={onOpenChange} projectId="proj-1" />
    )

    const cancelBtn = screen.getByTestId('ticket-cancel-btn')
    fireEvent.click(cancelBtn)

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mockKanban.ticket.create).not.toHaveBeenCalled()
  })

  test('description field accepts markdown text', () => {
    render(
      <TicketCreateModal open={true} onOpenChange={vi.fn()} projectId="proj-1" />
    )

    const descInput = screen.getByTestId('ticket-description-input')
    fireEvent.change(descInput, { target: { value: '**bold** and *italic*' } })

    expect(descInput).toHaveValue('**bold** and *italic*')
  })

  test('preview toggle shows markdown preview', () => {
    render(
      <TicketCreateModal open={true} onOpenChange={vi.fn()} projectId="proj-1" />
    )

    // Type some markdown
    const descInput = screen.getByTestId('ticket-description-input')
    fireEvent.change(descInput, { target: { value: '**bold text**' } })

    // Click preview toggle
    const previewToggle = screen.getByTestId('ticket-preview-toggle')
    fireEvent.click(previewToggle)

    // Preview area should be visible
    expect(screen.getByTestId('ticket-description-preview')).toBeInTheDocument()
  })

  test('title input is auto-focused when modal opens', () => {
    render(
      <TicketCreateModal open={true} onOpenChange={vi.fn()} projectId="proj-1" />
    )

    const titleInput = screen.getByTestId('ticket-title-input')
    expect(titleInput).toHaveFocus()
  })

  test('attachments can be added via URL input', async () => {
    render(
      <TicketCreateModal open={true} onOpenChange={vi.fn()} projectId="proj-1" />
    )

    // Click the add attachment button
    const addAttachBtn = screen.getByTestId('ticket-add-attachment-btn')
    fireEvent.click(addAttachBtn)

    // Enter a Jira URL
    const attachInput = screen.getByTestId('ticket-attachment-url-input')
    fireEvent.change(attachInput, {
      target: { value: 'https://myteam.atlassian.net/browse/PROJ-123' }
    })

    // Confirm the attachment
    const confirmBtn = screen.getByTestId('ticket-attachment-confirm-btn')
    fireEvent.click(confirmBtn)

    // Attachment chip should appear
    await waitFor(() => {
      expect(screen.getByTestId('ticket-attachment-chip-0')).toBeInTheDocument()
      expect(screen.getByText('PROJ-123')).toBeInTheDocument()
    })
  })

  test('attachments can be removed', async () => {
    render(
      <TicketCreateModal open={true} onOpenChange={vi.fn()} projectId="proj-1" />
    )

    // Add an attachment first
    const addAttachBtn = screen.getByTestId('ticket-add-attachment-btn')
    fireEvent.click(addAttachBtn)

    const attachInput = screen.getByTestId('ticket-attachment-url-input')
    fireEvent.change(attachInput, {
      target: { value: 'https://myteam.atlassian.net/browse/PROJ-456' }
    })

    const confirmBtn = screen.getByTestId('ticket-attachment-confirm-btn')
    fireEvent.click(confirmBtn)

    // Wait for chip to appear
    await waitFor(() => {
      expect(screen.getByTestId('ticket-attachment-chip-0')).toBeInTheDocument()
    })

    // Remove the attachment
    const removeBtn = screen.getByTestId('ticket-attachment-remove-0')
    fireEvent.click(removeBtn)

    expect(screen.queryByTestId('ticket-attachment-chip-0')).not.toBeInTheDocument()
  })

  // ── Tab navigation tests ────────────────────────────────────────────
  test('Tab key allows natural focus movement between title and description', () => {
    render(
      <TicketCreateModal open={true} onOpenChange={vi.fn()} projectId="proj-1" />
    )

    const titleInput = screen.getByTestId('ticket-title-input')
    titleInput.focus()

    // Fire Tab — should NOT be prevented (stopImmediatePropagation blocks
    // SessionView's global handler, but default browser focus movement remains)
    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true
    })
    const preventSpy = vi.spyOn(tabEvent, 'preventDefault')

    titleInput.dispatchEvent(tabEvent)

    // The modal's handler must NOT call preventDefault so focus moves naturally
    expect(preventSpy).not.toHaveBeenCalled()
  })

  test('Tab key inside modal blocks external capture-phase listeners', () => {
    // Simulate SessionView's global Tab handler
    const externalHandler = vi.fn()
    const sessionViewHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        externalHandler()
      }
    }
    // Register AFTER render so the modal's handler runs first via stopImmediatePropagation
    render(
      <TicketCreateModal open={true} onOpenChange={vi.fn()} projectId="proj-1" />
    )
    window.addEventListener('keydown', sessionViewHandler, true)

    try {
      const titleInput = screen.getByTestId('ticket-title-input')
      titleInput.focus()

      fireEvent.keyDown(titleInput, { key: 'Tab' })

      // The external handler must NOT have been called — modal blocks it
      expect(externalHandler).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', sessionViewHandler, true)
    }
  })

  test('Shift+Tab key inside modal also allows natural focus movement', () => {
    render(
      <TicketCreateModal open={true} onOpenChange={vi.fn()} projectId="proj-1" />
    )

    const descInput = screen.getByTestId('ticket-description-input')
    descInput.focus()

    // Shift+Tab should also not be prevented
    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    const preventSpy = vi.spyOn(tabEvent, 'preventDefault')

    descInput.dispatchEvent(tabEvent)

    expect(preventSpy).not.toHaveBeenCalled()
  })
})
