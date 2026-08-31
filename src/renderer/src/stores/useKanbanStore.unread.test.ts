import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'

// Mock the kanban RPC API so moveTicket/updateTicket don't hit a real client.
vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      move: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(null)
    }
  }
}))

// moveTicket dynamically imports useSettingsStore for the follow-up trigger.
vi.mock('./useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ followUpTriggerColumn: 'done' }) }
}))

import { kanbanApi } from '@/api/kanban-api'
import { useKanbanStore } from './useKanbanStore'

const PROJECT_ID = 'proj-1'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'A ticket',
    description: null,
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: 'build',
    plan_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    column_changed_at: '2026-01-01T00:00:00.000Z',
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

function seed(tickets: KanbanTicket[]): void {
  useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, tickets]]) })
}

function getTicket(id: string): KanbanTicket {
  const ticket = useKanbanStore
    .getState()
    .tickets.get(PROJECT_ID)!
    .find((t) => t.id === id)
  if (!ticket) throw new Error(`Ticket ${id} not found`)
  return ticket
}

beforeEach(() => {
  vi.clearAllMocks()
  useKanbanStore.setState({ tickets: new Map(), selectedTicketId: null, selectedTicketRef: null })
})

afterEach(() => {
  useKanbanStore.setState({ tickets: new Map(), selectedTicketId: null, selectedTicketRef: null })
})

describe('unread on column transitions (optimistic)', () => {
  it('moveTicket into review marks the ticket unread', async () => {
    seed([makeTicket()])

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)

    expect(getTicket('ticket-1').unread).toBe(true)
  })

  it('moveTicket out of review clears unread', async () => {
    seed([makeTicket({ column: 'review', unread: true })])

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)

    expect(getTicket('ticket-1').unread).toBe(false)
  })

  it('a same-column move keeps the unread state', async () => {
    seed([makeTicket({ column: 'review', unread: true })])

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 5)

    expect(getTicket('ticket-1').unread).toBe(true)
  })

  it('updateTicket with a column change into review marks unread', async () => {
    seed([makeTicket()])

    await useKanbanStore.getState().updateTicket('ticket-1', PROJECT_ID, { column: 'review' })

    expect(getTicket('ticket-1').unread).toBe(true)
  })

  it('updateTicket with a column change away from review clears unread', async () => {
    seed([makeTicket({ column: 'review', unread: true })])

    await useKanbanStore.getState().updateTicket('ticket-1', PROJECT_ID, { column: 'in_progress' })

    expect(getTicket('ticket-1').unread).toBe(false)
  })

  it('a non-column update leaves unread alone', async () => {
    seed([makeTicket({ column: 'review', unread: true })])

    await useKanbanStore.getState().updateTicket('ticket-1', PROJECT_ID, { title: 'Renamed' })

    expect(getTicket('ticket-1').unread).toBe(true)
  })
})

describe('markTicketRead', () => {
  it('clears unread locally and persists it', async () => {
    seed([makeTicket({ column: 'review', unread: true })])

    useKanbanStore.getState().markTicketRead('ticket-1', PROJECT_ID)

    expect(getTicket('ticket-1').unread).toBe(false)
    await vi.waitFor(() => {
      expect(kanbanApi.ticket.update).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', {
        unread: false
      })
    })
  })

  it('no-ops for tickets that are not unread', () => {
    seed([makeTicket({ column: 'review', unread: false })])

    useKanbanStore.getState().markTicketRead('ticket-1', PROJECT_ID)

    expect(kanbanApi.ticket.update).not.toHaveBeenCalled()
  })
})

describe('setSelectedTicketRef', () => {
  it('opening a ticket marks it read', async () => {
    seed([makeTicket({ column: 'review', unread: true })])

    useKanbanStore
      .getState()
      .setSelectedTicketRef({ projectId: PROJECT_ID, ticketId: 'ticket-1' })

    expect(getTicket('ticket-1').unread).toBe(false)
    await vi.waitFor(() => {
      expect(kanbanApi.ticket.update).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', {
        unread: false
      })
    })
  })

  it('clearing the selection does not touch tickets', () => {
    seed([makeTicket({ column: 'review', unread: true })])

    useKanbanStore.getState().setSelectedTicketRef(null)

    expect(getTicket('ticket-1').unread).toBe(true)
    expect(kanbanApi.ticket.update).not.toHaveBeenCalled()
  })
})
