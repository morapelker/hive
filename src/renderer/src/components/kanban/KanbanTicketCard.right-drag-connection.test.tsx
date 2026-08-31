import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

const now = '2026-01-01T00:00:00.000Z'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Connection ticket',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: 'build',
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
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ...overrides
  }
}

function rightDragInto(card: HTMLElement, column: HTMLElement): void {
  // jsdom has no layout — resolve hit-testing by x coordinate
  const original = document.elementFromPoint
  document.elementFromPoint = (x: number) => (x >= 300 ? column : card)
  try {
    fireEvent.mouseDown(card, { button: 2, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 350, clientY: 50 })
    fireEvent.mouseUp(window, { button: 2, clientX: 350, clientY: 50 })
  } finally {
    document.elementFromPoint = original
  }
}

describe('KanbanTicketCard right-button drag on a connection board', () => {
  afterEach(() => {
    cleanup()
    quickLaunchTicket.mockClear()
    quickLaunchTicketOnConnection.mockClear()
  })

  it('quick-launches on the connection when dropped into In Progress', () => {
    const ticket = makeTicket()
    render(
      <>
        <KanbanTicketCard ticket={ticket} connectionId="conn-1" />
        <div data-kanban-column="in_progress" />
      </>
    )
    const card = screen.getByTestId('kanban-ticket-ticket-1')
    const column = document.querySelector('[data-kanban-column="in_progress"]') as HTMLElement

    rightDragInto(card, column)

    expect(quickLaunchTicketOnConnection).toHaveBeenCalledTimes(1)
    expect(quickLaunchTicketOnConnection).toHaveBeenCalledWith(ticket, 'conn-1')
    expect(quickLaunchTicket).not.toHaveBeenCalled()
  })

  it('still uses the worktree quick launch on a regular board', () => {
    const ticket = makeTicket()
    render(
      <>
        <KanbanTicketCard ticket={ticket} />
        <div data-kanban-column="in_progress" />
      </>
    )
    const card = screen.getByTestId('kanban-ticket-ticket-1')
    const column = document.querySelector('[data-kanban-column="in_progress"]') as HTMLElement

    rightDragInto(card, column)

    expect(quickLaunchTicket).toHaveBeenCalledTimes(1)
    expect(quickLaunchTicketOnConnection).not.toHaveBeenCalled()
  })
})
