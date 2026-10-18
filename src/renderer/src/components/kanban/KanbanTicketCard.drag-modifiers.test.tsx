/**
 * The modifier keys held when a card's drag starts travel with the drag data: cmd+shift on the
 * ticket of a document run dropped on Done/Merged finishes the whole run (KanbanColumn).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/session-followup', () => ({
  continueTicketSession: vi.fn().mockResolvedValue(true)
}))

import { KanbanTicketCard } from './KanbanTicketCard'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getKanbanDragData, setKanbanDragData } from '@/stores/useKanbanStore'
import type { KanbanTicket } from '../../../../main/db/types'

const now = '2026-01-01T00:00:00.000Z'

const ticket: KanbanTicket = {
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
  sync_task_id: null,
  sync_task_title: null,
  sync_task_status: null,
  sync_task_org_id: null,
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
  parent_ticket_key: null
}

// jsdom has no DragEvent: testing-library then fires a plain Event, which carries no
// modifier keys. A MouseEvent stand-in does, and a stub dataTransfer satisfies the card.
class FakeDragEvent extends window.MouseEvent {
  dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '' }
  constructor(type: string, init?: MouseEventInit) {
    super(type, { bubbles: true, cancelable: true, ...init })
  }
}

function dragStart(init: MouseEventInit): void {
  render(
    <TooltipProvider>
      <KanbanTicketCard ticket={ticket} />
    </TooltipProvider>
  )
  fireEvent.dragStart(screen.getByTestId('kanban-ticket-ticket-run'), init)
}

describe('KanbanTicketCard drag modifiers', () => {
  beforeEach(() => {
    vi.stubGlobal('DragEvent', FakeDragEvent)
    setKanbanDragData(null)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    setKanbanDragData(null)
  })

  it('records cmd+shift held when the drag starts', () => {
    dragStart({ metaKey: true, shiftKey: true })

    expect(getKanbanDragData()).toMatchObject({
      ticketId: 'ticket-run',
      sourceColumn: 'review',
      modifiers: { cmd: true, shift: true }
    })
  })

  it('counts ctrl as cmd', () => {
    dragStart({ ctrlKey: true, shiftKey: true })

    expect(getKanbanDragData()?.modifiers).toEqual({ cmd: true, shift: true })
  })

  it('records a plain drag as held with neither', () => {
    dragStart({})

    expect(getKanbanDragData()?.modifiers).toEqual({ cmd: false, shift: false })
  })
})
