/**
 * ⌘⇧-dragging the ticket of a document run (an orchestrator) to Done/Merged is the override
 * of its shift-drop: the archive step for the whole run, no branch checked. A native drag
 * cannot be dropped while ⌘ is held (macOS refuses it), so the card cancels the native drag
 * and runs the gesture on mouse events.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../../main/db/types'

const { dropRunTicketArchiveOverride } = vi.hoisted(() => ({
  dropRunTicketArchiveOverride: vi.fn(async () => {})
}))

vi.mock('@/lib/session-followup', () => ({
  continueTicketSession: vi.fn().mockResolvedValue(true)
}))
vi.mock('@/lib/document-flow/run-archive-override', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/document-flow/run-archive-override')>()
  return { ...actual, dropRunTicketArchiveOverride }
})

import { KanbanTicketCard } from './KanbanTicketCard'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getKanbanDragData, setKanbanDragData } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

const now = '2026-01-01T00:00:00.000Z'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-run',
    project_id: 'project-1',
    title: 'Checkout redesign',
    description: null,
    attachments: [],
    column: 'review',
    sort_order: 0,
    current_session_id: null,
    worktree_id: 'wt-integration',
    mode: null,
    plan_ready: false,
    created_at: now,
    updated_at: now,
    column_changed_at: null,
    archived_at: null,
    external_provider: 'document-run',
    external_id: 'run-1',
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

// jsdom has no DragEvent: a MouseEvent stand-in carries the modifier keys, and a stub
// dataTransfer satisfies the card's native drag path
class FakeDragEvent extends window.MouseEvent {
  dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '' }
  constructor(type: string, init?: MouseEventInit) {
    super(type, { bubbles: true, cancelable: true, ...init })
  }
}

const CHORD = { metaKey: true, shiftKey: true }

function renderBoard(ticket: KanbanTicket = makeTicket()): {
  card: HTMLElement
  column: (name: string) => HTMLElement
} {
  render(
    <TooltipProvider>
      <KanbanTicketCard ticket={ticket} />
      <div data-kanban-column="in_progress" />
      <div data-kanban-column="merged" />
      <div data-kanban-column="done" />
    </TooltipProvider>
  )
  return {
    card: screen.getByTestId(`kanban-ticket-${ticket.id}`),
    column: (name) => document.querySelector(`[data-kanban-column="${name}"]`) as HTMLElement
  }
}

/** jsdom has no layout: whatever the pointer is "over" is decided by the test. */
let under: HTMLElement | null = null
const originalElementFromPoint = document.elementFromPoint

const ghostChip = (): HTMLElement | null =>
  document.querySelector('[data-testid="archive-override-drag-chip"]')

describe('KanbanTicketCard ⌘⇧-drag of a run ticket (archive override)', () => {
  beforeEach(() => {
    vi.stubGlobal('DragEvent', FakeDragEvent)
    setKanbanDragData(null)
    dropRunTicketArchiveOverride.mockClear()
    useSettingsStore.setState({ showMergedColumn: true })
    under = null
    document.elementFromPoint = () => under
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    setKanbanDragData(null)
    document.elementFromPoint = originalElementFromPoint
  })

  it('drops on Done: the override runs for the ticket, and the gesture cleans up after itself', () => {
    const ticket = makeTicket()
    const { card, column } = renderBoard(ticket)

    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10, ...CHORD })
    under = column('done')
    fireEvent.mouseMove(window, { clientX: 350, clientY: 50, ...CHORD })

    // Mid-drag: the ghost says what a release does, and only Done/Merged read as targets
    expect(ghostChip()?.textContent).toContain('Archive all')
    expect(column('done').getAttribute('data-archive-drag')).toBe('over')
    expect(column('merged').getAttribute('data-archive-drag')).toBe('target')
    expect(column('in_progress').hasAttribute('data-archive-drag')).toBe(false)

    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50, ...CHORD })

    expect(dropRunTicketArchiveOverride).toHaveBeenCalledTimes(1)
    expect(dropRunTicketArchiveOverride).toHaveBeenCalledWith(ticket, 'done')
    expect(ghostChip()).toBeNull()
    expect(column('done').hasAttribute('data-archive-drag')).toBe(false)
    expect(column('merged').hasAttribute('data-archive-drag')).toBe(false)
  })

  it('cancels the native drag the chord would start: it could never be dropped with ⌘ held', () => {
    const { card, column } = renderBoard()

    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10, ...CHORD })
    const notCancelled = fireEvent.dragStart(card, { clientX: 14, clientY: 10, ...CHORD })

    expect(notCancelled).toBe(false)
    expect(getKanbanDragData()).toBeNull()
    // The drag is the gesture's from here on, before its own threshold was reached
    expect(ghostChip()).not.toBeNull()

    under = column('merged')
    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50, ...CHORD })
    expect(dropRunTicketArchiveOverride).toHaveBeenCalledWith(expect.anything(), 'merged')
  })

  it('takes over a drag whose chord went down after the mouse button did', () => {
    const { card, column } = renderBoard()

    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10 })
    const notCancelled = fireEvent.dragStart(card, { clientX: 14, clientY: 10, ...CHORD })

    expect(notCancelled).toBe(false)
    expect(getKanbanDragData()).toBeNull()

    under = column('done')
    // The keys may be let go before the release: the gesture was chosen when the drag started
    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50 })
    expect(dropRunTicketArchiveOverride).toHaveBeenCalledWith(expect.anything(), 'done')
  })

  it('does nothing when released anywhere but Done or Merged', () => {
    const { card, column } = renderBoard()

    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10, ...CHORD })
    under = column('in_progress')
    fireEvent.mouseMove(window, { clientX: 350, clientY: 50, ...CHORD })
    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50, ...CHORD })

    expect(dropRunTicketArchiveOverride).not.toHaveBeenCalled()
    expect(ghostChip()).toBeNull()
  })

  it('never offers the column the ticket is in', () => {
    const { card, column } = renderBoard(makeTicket({ column: 'done' }))

    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10, ...CHORD })
    under = column('done')
    fireEvent.mouseMove(window, { clientX: 350, clientY: 50, ...CHORD })

    expect(column('done').hasAttribute('data-archive-drag')).toBe(false)
    expect(column('merged').getAttribute('data-archive-drag')).toBe('target')

    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50, ...CHORD })
    expect(dropRunTicketArchiveOverride).not.toHaveBeenCalled()
  })

  it('leaves the native drag alone on a board with no column to release on', () => {
    // Already in Done, and the board shows no Merged column
    useSettingsStore.setState({ showMergedColumn: false })
    const ticket = makeTicket({ column: 'done' })
    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={ticket} />
        <div data-kanban-column="review" />
        <div data-kanban-column="done" />
      </TooltipProvider>
    )
    const card = screen.getByTestId('kanban-ticket-ticket-run')

    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10, ...CHORD })
    const notCancelled = fireEvent.dragStart(card, { clientX: 14, clientY: 10, ...CHORD })

    expect(notCancelled).toBe(true)
    expect(getKanbanDragData()).toMatchObject({ ticketId: 'ticket-run' })
    expect(ghostChip()).toBeNull()
  })

  it('Escape gives the drag up: the release that follows is nothing', () => {
    const { card, column } = renderBoard()

    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10, ...CHORD })
    under = column('done')
    fireEvent.mouseMove(window, { clientX: 350, clientY: 50, ...CHORD })
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(ghostChip()).toBeNull()
    expect(column('done').hasAttribute('data-archive-drag')).toBe(false)

    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50, ...CHORD })
    expect(dropRunTicketArchiveOverride).not.toHaveBeenCalled()
  })

  it('swallows the click that follows a drag, so the card under the pointer is not opened', () => {
    const { card } = renderBoard()
    const clicked = vi.fn()
    window.addEventListener('click', clicked)

    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10, ...CHORD })
    under = card
    fireEvent.mouseMove(window, { clientX: 40, clientY: 10, ...CHORD })
    fireEvent.mouseUp(window, { button: 0, clientX: 40, clientY: 10, ...CHORD })
    fireEvent.click(card, CHORD)

    expect(clicked).not.toHaveBeenCalled()
    window.removeEventListener('click', clicked)
  })

  it('leaves a ⌘⇧-click that never moved alone', () => {
    const { card } = renderBoard()

    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10, ...CHORD })
    fireEvent.mouseUp(window, { button: 0, clientX: 11, clientY: 10, ...CHORD })

    expect(ghostChip()).toBeNull()
    expect(dropRunTicketArchiveOverride).not.toHaveBeenCalled()
  })

  it('is a run ticket’s gesture only: any other card keeps its native drag', () => {
    const { card, column } = renderBoard(
      makeTicket({ id: 'ticket-plain', external_provider: null, external_id: null })
    )

    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10, ...CHORD })
    const notCancelled = fireEvent.dragStart(card, { clientX: 14, clientY: 10, ...CHORD })

    expect(notCancelled).toBe(true)
    expect(getKanbanDragData()).toMatchObject({ ticketId: 'ticket-plain', modifiers: { shift: true } })

    under = column('done')
    fireEvent.mouseMove(window, { clientX: 350, clientY: 50, ...CHORD })
    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50, ...CHORD })
    expect(ghostChip()).toBeNull()
    expect(dropRunTicketArchiveOverride).not.toHaveBeenCalled()
  })

  it('needs both keys: shift alone stays the native shift-drag of the run ticket', () => {
    const { card } = renderBoard()

    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10, shiftKey: true })
    const notCancelled = fireEvent.dragStart(card, { clientX: 14, clientY: 10, shiftKey: true })

    expect(notCancelled).toBe(true)
    expect(getKanbanDragData()).toMatchObject({ ticketId: 'ticket-run', modifiers: { shift: true } })
    expect(ghostChip()).toBeNull()
  })

  it('is off for an archived ticket', () => {
    const ticket = makeTicket()
    render(
      <TooltipProvider>
        <KanbanTicketCard ticket={ticket} isArchived />
        <div data-kanban-column="done" />
      </TooltipProvider>
    )
    const card = screen.getByTestId('kanban-ticket-ticket-run')

    fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10, ...CHORD })
    under = document.querySelector('[data-kanban-column="done"]') as HTMLElement
    fireEvent.mouseMove(window, { clientX: 350, clientY: 50, ...CHORD })
    fireEvent.mouseUp(window, { button: 0, clientX: 350, clientY: 50, ...CHORD })

    expect(dropRunTicketArchiveOverride).not.toHaveBeenCalled()
  })
})
