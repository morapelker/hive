import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { KanbanTicket } from '../../src/main/db/types'

const apiMocks = vi.hoisted(() => ({
  kanbanApi: {
    ticket: {
      move: vi.fn(),
      archiveAllDone: vi.fn()
    }
  },
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: apiMocks.kanbanApi
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: apiMocks.settingsApi
}))

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(vi.fn(), {
    getState: () => ({ followUpTriggerColumn: 'done', showMergedColumn: true })
  })
}))

import { kanbanApi } from '@/api/kanban-api'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { isBlockerSatisfied } from '@/lib/blocker-utils'

const mockKanbanTicketApi = vi.mocked(kanbanApi.ticket)

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Merged column ticket',
    description: null,
    attachments: [],
    column: 'review',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: 'build',
    plan_ready: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
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
    ...overrides
  } as KanbanTicket
}

describe('merged column', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useKanbanStore.setState({
      tickets: new Map(),
      pendingDoneMove: null,
      dependencyMap: new Map()
    })
  })

  test('completeDoneMove moves the ticket to the pending target column', async () => {
    mockKanbanTicketApi.move.mockResolvedValue(undefined)
    useKanbanStore.setState({
      tickets: new Map([['proj-1', [makeTicket()]]]),
      pendingDoneMove: {
        ticketId: 'ticket-1',
        projectId: 'proj-1',
        sortOrder: 5,
        targetColumn: 'merged'
      }
    })

    await useKanbanStore.getState().completeDoneMove()

    expect(mockKanbanTicketApi.move).toHaveBeenCalledWith('proj-1', 'ticket-1', 'merged', 5)
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    const moved = useKanbanStore.getState().tickets.get('proj-1')?.find((t) => t.id === 'ticket-1')
    expect(moved?.column).toBe('merged')
  })

  test('completeDoneMove still targets done when the dialog was opened from Done', async () => {
    mockKanbanTicketApi.move.mockResolvedValue(undefined)
    useKanbanStore.setState({
      tickets: new Map([['proj-1', [makeTicket()]]]),
      pendingDoneMove: {
        ticketId: 'ticket-1',
        projectId: 'proj-1',
        sortOrder: 0,
        targetColumn: 'done'
      }
    })

    await useKanbanStore.getState().completeDoneMove()

    expect(mockKanbanTicketApi.move).toHaveBeenCalledWith('proj-1', 'ticket-1', 'done', 0)
  })

  test('getTicketsByColumn date-sorts the merged column newest first', () => {
    const older = makeTicket({
      id: 'older',
      column: 'merged',
      sort_order: 0,
      updated_at: '2026-07-01T00:00:00.000Z'
    })
    const newer = makeTicket({
      id: 'newer',
      column: 'merged',
      sort_order: 99,
      updated_at: '2026-07-02T00:00:00.000Z'
    })
    useKanbanStore.setState({ tickets: new Map([['proj-1', [older, newer]]]) })

    const tickets = useKanbanStore.getState().getTicketsByColumn('proj-1', 'merged')
    expect(tickets.map((t) => t.id)).toEqual(['newer', 'older'])
  })

  test('getTicketsForProject orders merged between review and done', () => {
    const review = makeTicket({ id: 'r', column: 'review' })
    const merged = makeTicket({ id: 'm', column: 'merged' })
    const done = makeTicket({ id: 'd', column: 'done' })
    useKanbanStore.setState({ tickets: new Map([['proj-1', [done, merged, review]]]) })

    const ordered = useKanbanStore.getState().getTicketsForProject('proj-1')
    expect(ordered.map((t) => t.id)).toEqual(['r', 'm', 'd'])
  })

  test('archiveAllDone with includeMerged archives folded merged tickets too', async () => {
    mockKanbanTicketApi.archiveAllDone.mockResolvedValue(2)
    const done = makeTicket({ id: 'd', column: 'done' })
    const merged = makeTicket({ id: 'm', column: 'merged' })
    useKanbanStore.setState({ tickets: new Map([['proj-1', [done, merged]]]) })

    const count = await useKanbanStore.getState().archiveAllDone('proj-1', true)

    expect(count).toBe(2)
    expect(mockKanbanTicketApi.archiveAllDone).toHaveBeenCalledWith('proj-1', true)
    const tickets = useKanbanStore.getState().tickets.get('proj-1') ?? []
    expect(tickets.every((t) => t.archived_at)).toBe(true)
  })

  test('archiveAllDone without includeMerged leaves merged tickets alone', async () => {
    mockKanbanTicketApi.archiveAllDone.mockResolvedValue(1)
    const done = makeTicket({ id: 'd', column: 'done' })
    const merged = makeTicket({ id: 'm', column: 'merged' })
    useKanbanStore.setState({ tickets: new Map([['proj-1', [done, merged]]]) })

    const count = await useKanbanStore.getState().archiveAllDone('proj-1')

    expect(count).toBe(1)
    const tickets = useKanbanStore.getState().tickets.get('proj-1') ?? []
    expect(tickets.find((t) => t.id === 'm')?.archived_at).toBeNull()
    expect(tickets.find((t) => t.id === 'd')?.archived_at).toBeTruthy()
  })

  test('merged blockers satisfy dependents in both trigger modes', () => {
    expect(isBlockerSatisfied('merged', 'build', 'done')).toBe(true)
    expect(isBlockerSatisfied('merged', 'plan', 'review')).toBe(true)
    expect(isBlockerSatisfied('done', 'build', 'done')).toBe(true)
    expect(isBlockerSatisfied('review', 'build', 'done')).toBe(false)
    expect(isBlockerSatisfied('review', 'build', 'review')).toBe(true)
  })
})
