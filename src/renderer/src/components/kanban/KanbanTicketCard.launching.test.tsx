/**
 * A ticket whose launch is on its way (Create & Send, a right-drag, the picker): until its
 * session exists the card stays where it was, so it says what the launch is doing, dimmed,
 * and cannot be started a second time.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../../main/db/types'

const { quickLaunchTicket, quickLaunchTicketOnConnection } = vi.hoisted(() => ({
  quickLaunchTicket: vi.fn(async () => true),
  quickLaunchTicketOnConnection: vi.fn(async () => true)
}))

vi.mock('@/components/kanban/WorktreePickerModal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./WorktreePickerModal')>()
  return { ...actual, quickLaunchTicket, quickLaunchTicketOnConnection }
})

import { KanbanTicketCard } from './KanbanTicketCard'
import { beginTicketLaunch, settleTicketLaunch } from '@/stores/useTicketLaunchStore'

const now = '2026-01-01T00:00:00.000Z'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Add dark mode toggle',
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
    ticket_prefix: null,
    ticket_number: null,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  }
}

const card = (): HTMLElement => screen.getByTestId('kanban-ticket-ticket-1')
const launchLine = (): HTMLElement | null => screen.queryByTestId('kanban-ticket-launching')

function rightDragIntoInProgress(): void {
  const column = document.querySelector('[data-kanban-column="in_progress"]') as HTMLElement
  const source = card()
  // jsdom has no layout: resolve hit-testing by x coordinate
  const original = document.elementFromPoint
  document.elementFromPoint = (x: number) => (x >= 300 ? column : source)
  try {
    fireEvent.mouseDown(source, { button: 2, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 350, clientY: 50 })
    fireEvent.mouseUp(window, { button: 2, clientX: 350, clientY: 50 })
  } finally {
    document.elementFromPoint = original
  }
}

function renderCard(): void {
  render(
    <>
      <KanbanTicketCard ticket={makeTicket()} />
      <div data-kanban-column="in_progress" />
    </>
  )
}

describe('KanbanTicketCard while its ticket is being launched', () => {
  afterEach(() => {
    cleanup()
    settleTicketLaunch('ticket-1')
    settleTicketLaunch('ticket-2')
    quickLaunchTicket.mockClear()
    quickLaunchTicketOnConnection.mockClear()
  })

  it('shows nothing of the kind on a ticket nobody launches', () => {
    beginTicketLaunch('ticket-2', 'worktree')
    renderCard()

    expect(launchLine()).toBeNull()
    expect(card().getAttribute('draggable')).toBe('true')
    expect(card().hasAttribute('aria-busy')).toBe(false)
  })

  it('says what the launch is doing and follows it until the ticket is placed', () => {
    renderCard()
    let hold!: ReturnType<typeof beginTicketLaunch>
    act(() => {
      hold = beginTicketLaunch('ticket-1', 'worktree')
    })

    expect(launchLine()?.textContent).toBe('Creating worktree…')
    expect(card().getAttribute('aria-busy')).toBe('true')
    expect(card().hasAttribute('data-launching')).toBe(true)

    act(() => hold.setPhase('session'))
    expect(launchLine()?.textContent).toBe('Starting session…')

    act(() => settleTicketLaunch('ticket-1'))
    expect(launchLine()).toBeNull()
    expect(card().hasAttribute('aria-busy')).toBe(false)
    expect(card().hasAttribute('data-launching')).toBe(false)
  })

  it('cannot be dragged, and a right-drag into In Progress starts nothing', () => {
    beginTicketLaunch('ticket-1', 'worktree')
    renderCard()

    expect(card().getAttribute('draggable')).toBe('false')
    rightDragIntoInProgress()
    expect(quickLaunchTicket).not.toHaveBeenCalled()
    expect(quickLaunchTicketOnConnection).not.toHaveBeenCalled()
  })

  it('launches again once a failed launch let go of it', () => {
    const hold = beginTicketLaunch('ticket-1', 'worktree')
    renderCard()
    act(() => hold.release())

    expect(card().getAttribute('draggable')).toBe('true')
    rightDragIntoInProgress()
    expect(quickLaunchTicket).toHaveBeenCalledTimes(1)
  })
})
