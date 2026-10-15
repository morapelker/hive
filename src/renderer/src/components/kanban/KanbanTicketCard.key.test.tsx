import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/session-followup', () => ({
  continueTicketSession: vi.fn().mockResolvedValue(true)
}))

import { KanbanTicketCard } from './KanbanTicketCard'
import type { KanbanTicket } from '../../../../main/db/types'

const now = '2026-01-01T00:00:00.000Z'

const baseTicket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Fix the thing',
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
  ticket_prefix: 'TD',
  ticket_number: 12,
  parent_ticket_id: null,
  parent_ticket_key: null
}

describe('KanbanTicketCard ticket key', () => {
  afterEach(() => cleanup())

  it('shows the key chip in front of the title', () => {
    render(<KanbanTicketCard ticket={baseTicket} />)

    const key = screen.getByTestId('ticket-key')
    expect(key).toHaveTextContent('TD-12')
    expect(key).toHaveAttribute('title', 'Ticket TD-12')
    // The chip leads the title row
    const title = screen.getByText('Fix the thing')
    expect(key.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows the parent run key for an orchestrator child ticket', () => {
    render(
      <KanbanTicketCard
        ticket={{ ...baseTicket, parent_ticket_id: 'run-ticket', parent_ticket_key: 'TD-7' }}
      />
    )

    expect(screen.getByTestId('ticket-parent-key')).toHaveTextContent('TD-7')
    expect(screen.getByTestId('ticket-key')).toHaveTextContent('TD-12')
  })

  it('renders no key chip for a ticket without a key (markdown card, older row)', () => {
    render(
      <KanbanTicketCard ticket={{ ...baseTicket, ticket_prefix: null, ticket_number: null }} />
    )

    expect(screen.queryByTestId('ticket-key')).toBeNull()
    expect(screen.queryByTestId('ticket-key-badge')).toBeNull()
    expect(screen.getByText('Fix the thing')).toBeInTheDocument()
  })
})
