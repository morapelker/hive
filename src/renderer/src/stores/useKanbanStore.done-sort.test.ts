import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'

// Mock the kanban RPC API so moveTicket doesn't hit a real client.
vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      move: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(null),
      reorder: vi.fn().mockResolvedValue(undefined)
    }
  }
}))

// moveTicket dynamically imports useSettingsStore for the follow-up trigger.
vi.mock('./useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ followUpTriggerColumn: 'done' }) }
}))

import { useKanbanStore } from './useKanbanStore'

const PROJECT_ID = 'proj-1'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'A ticket',
    description: null,
    attachments: [],
    column: 'done',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: 'build',
    plan_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
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

beforeEach(() => {
  vi.clearAllMocks()
  useKanbanStore.setState({ tickets: new Map() })
})

afterEach(() => {
  useKanbanStore.setState({ tickets: new Map() })
})

describe('getTicketsByColumn — done column is date-sorted', () => {
  it('sorts done tickets by updated_at descending, ignoring sort_order', () => {
    seed([
      makeTicket({ id: 'old', sort_order: 0, updated_at: '2026-01-01T00:00:00.000Z' }),
      makeTicket({ id: 'newest', sort_order: 99, updated_at: '2026-03-01T00:00:00.000Z' }),
      makeTicket({ id: 'middle', sort_order: 50, updated_at: '2026-02-01T00:00:00.000Z' })
    ])

    const ids = useKanbanStore
      .getState()
      .getTicketsByColumn(PROJECT_ID, 'done')
      .map((t) => t.id)
    expect(ids).toEqual(['newest', 'middle', 'old'])
  })

  it('still sorts other columns by sort_order', () => {
    seed([
      makeTicket({ id: 'b', column: 'todo', sort_order: 1, updated_at: '2026-03-01T00:00:00.000Z' }),
      makeTicket({ id: 'a', column: 'todo', sort_order: 0, updated_at: '2026-01-01T00:00:00.000Z' })
    ])

    const ids = useKanbanStore
      .getState()
      .getTicketsByColumn(PROJECT_ID, 'todo')
      .map((t) => t.id)
    expect(ids).toEqual(['a', 'b'])
  })

  it('excludes archived tickets from the active done list', () => {
    seed([
      makeTicket({ id: 'active', updated_at: '2026-01-01T00:00:00.000Z' }),
      makeTicket({
        id: 'archived',
        updated_at: '2026-03-01T00:00:00.000Z',
        archived_at: '2026-03-02T00:00:00.000Z'
      })
    ])

    const ids = useKanbanStore
      .getState()
      .getTicketsByColumn(PROJECT_ID, 'done')
      .map((t) => t.id)
    expect(ids).toEqual(['active'])
  })
})

describe('moveTicket — done placement', () => {
  it('bumps updated_at optimistically so a ticket moved to done sorts to the top', async () => {
    seed([
      makeTicket({ id: 'existing-done', updated_at: '2026-05-01T00:00:00.000Z' }),
      makeTicket({ id: 'moving', column: 'review', updated_at: '2026-01-01T00:00:00.000Z' })
    ])

    await useKanbanStore.getState().moveTicket('moving', PROJECT_ID, 'done', 5)

    const ids = useKanbanStore
      .getState()
      .getTicketsByColumn(PROJECT_ID, 'done')
      .map((t) => t.id)
    expect(ids).toEqual(['moving', 'existing-done'])
  })
})
