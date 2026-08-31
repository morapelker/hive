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

import { useKanbanStore, transitionSortKey } from './useKanbanStore'

const PROJECT_ID = 'proj-1'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'A ticket',
    description: null,
    attachments: [],
    column: 'todo',
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

beforeEach(() => {
  vi.clearAllMocks()
  useKanbanStore.setState({ tickets: new Map(), transitionSortByColumn: {} })
})

afterEach(() => {
  useKanbanStore.setState({ tickets: new Map(), transitionSortByColumn: {} })
})

describe('setTransitionSort', () => {
  it('stores the per-project, per-column toggle', () => {
    useKanbanStore.getState().setTransitionSort(PROJECT_ID, 'todo', true)
    expect(
      useKanbanStore.getState().transitionSortByColumn[transitionSortKey(PROJECT_ID, 'todo')]
    ).toBe(true)

    useKanbanStore.getState().setTransitionSort(PROJECT_ID, 'todo', false)
    expect(
      useKanbanStore.getState().transitionSortByColumn[transitionSortKey(PROJECT_ID, 'todo')]
    ).toBe(false)
  })
})

describe('getTicketsByColumn — transition sort toggle', () => {
  const seedTodo = (): void =>
    seed([
      makeTicket({
        id: 'oldest',
        sort_order: 0,
        column_changed_at: '2026-01-01T00:00:00.000Z'
      }),
      makeTicket({
        id: 'newest',
        sort_order: 99,
        column_changed_at: '2026-03-01T00:00:00.000Z'
      }),
      makeTicket({
        id: 'middle',
        sort_order: 50,
        column_changed_at: '2026-02-01T00:00:00.000Z'
      })
    ])

  it('sorts by sort_order when the toggle is off', () => {
    seedTodo()
    const ids = useKanbanStore
      .getState()
      .getTicketsByColumn(PROJECT_ID, 'todo')
      .map((t) => t.id)
    expect(ids).toEqual(['oldest', 'middle', 'newest'])
  })

  it('sorts by latest transition first when the toggle is on', () => {
    seedTodo()
    useKanbanStore.getState().setTransitionSort(PROJECT_ID, 'todo', true)
    const ids = useKanbanStore
      .getState()
      .getTicketsByColumn(PROJECT_ID, 'todo')
      .map((t) => t.id)
    expect(ids).toEqual(['newest', 'middle', 'oldest'])
  })

  it('falls back to updated_at for tickets without a transition date', () => {
    seed([
      makeTicket({
        id: 'legacy-new',
        sort_order: 0,
        column_changed_at: null,
        updated_at: '2026-04-01T00:00:00.000Z'
      }),
      makeTicket({
        id: 'tracked-old',
        sort_order: 1,
        column_changed_at: '2026-02-01T00:00:00.000Z',
        updated_at: '2026-02-01T00:00:00.000Z'
      })
    ])
    useKanbanStore.getState().setTransitionSort(PROJECT_ID, 'todo', true)
    const ids = useKanbanStore
      .getState()
      .getTicketsByColumn(PROJECT_ID, 'todo')
      .map((t) => t.id)
    expect(ids).toEqual(['legacy-new', 'tracked-old'])
  })

  it('done column sorts by transition date regardless of the toggle', () => {
    seed([
      makeTicket({
        id: 'done-old',
        column: 'done',
        sort_order: 0,
        column_changed_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z'
      }),
      makeTicket({
        id: 'done-new',
        column: 'done',
        sort_order: 1,
        column_changed_at: '2026-05-01T00:00:00.000Z',
        updated_at: '2026-02-01T00:00:00.000Z'
      })
    ])
    const ids = useKanbanStore
      .getState()
      .getTicketsByColumn(PROJECT_ID, 'done')
      .map((t) => t.id)
    expect(ids).toEqual(['done-new', 'done-old'])
  })
})

describe('moveTicket — optimistic transition date', () => {
  it('stamps column_changed_at locally so the ticket lands on top of a sorted column', async () => {
    seed([
      makeTicket({
        id: 'resident',
        column: 'in_progress',
        sort_order: 0,
        column_changed_at: '2026-05-01T00:00:00.000Z'
      }),
      makeTicket({
        id: 'moving',
        column: 'todo',
        sort_order: 0,
        column_changed_at: '2026-01-01T00:00:00.000Z'
      })
    ])
    useKanbanStore.getState().setTransitionSort(PROJECT_ID, 'in_progress', true)

    await useKanbanStore.getState().moveTicket('moving', PROJECT_ID, 'in_progress', 99)

    const ids = useKanbanStore
      .getState()
      .getTicketsByColumn(PROJECT_ID, 'in_progress')
      .map((t) => t.id)
    expect(ids).toEqual(['moving', 'resident'])
  })

  it('does not stamp column_changed_at on a same-column move', async () => {
    seed([
      makeTicket({
        id: 'moving',
        column: 'todo',
        sort_order: 0,
        column_changed_at: '2026-01-01T00:00:00.000Z'
      })
    ])

    await useKanbanStore.getState().moveTicket('moving', PROJECT_ID, 'todo', 5)

    const ticket = useKanbanStore.getState().tickets.get(PROJECT_ID)![0]
    expect(ticket.column_changed_at).toBe('2026-01-01T00:00:00.000Z')
    expect(ticket.sort_order).toBe(5)
  })
})

describe('updateTicket — optimistic transition date', () => {
  it('stamps column_changed_at when the update changes the column', async () => {
    seed([
      makeTicket({
        id: 'moving',
        column: 'todo',
        column_changed_at: '2026-01-01T00:00:00.000Z'
      })
    ])

    await useKanbanStore.getState().updateTicket('moving', PROJECT_ID, { column: 'in_progress' })

    const ticket = useKanbanStore.getState().tickets.get(PROJECT_ID)![0]
    expect(ticket.column).toBe('in_progress')
    expect(ticket.column_changed_at! > '2026-01-01T00:00:00.000Z').toBe(true)
  })

  it('leaves column_changed_at alone for non-column updates', async () => {
    seed([
      makeTicket({
        id: 'ticket-1',
        column: 'todo',
        column_changed_at: '2026-01-01T00:00:00.000Z'
      })
    ])

    await useKanbanStore.getState().updateTicket('ticket-1', PROJECT_ID, { title: 'Renamed' })

    const ticket = useKanbanStore.getState().tickets.get(PROJECT_ID)![0]
    expect(ticket.column_changed_at).toBe('2026-01-01T00:00:00.000Z')
  })
})
