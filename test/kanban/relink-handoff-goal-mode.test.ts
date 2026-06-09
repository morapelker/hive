import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { KanbanTicket } from '../../src/main/db/types'

const apiMocks = vi.hoisted(() => ({
  kanbanApi: {
    ticket: {
      getBySession: vi.fn(),
      update: vi.fn()
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

import { kanbanApi } from '@/api/kanban-api'
import { useKanbanStore } from '@/stores/useKanbanStore'

const mockKanbanTicketApi = vi.mocked(kanbanApi.ticket)

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Handoff ticket',
    description: null,
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: 'session-old',
    worktree_id: 'wt-1',
    mode: 'plan',
    plan_ready: true,
    created_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:00.000Z',
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
  }
}

describe('relinkTicketsForHandoff goal mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useKanbanStore.setState({
      tickets: new Map(),
      boardTelegramTarget: null
    })
    mockKanbanTicketApi.update.mockResolvedValue(null)
  })

  test('writes goal mode true and keeps existing criteria when requested', async () => {
    const ticket = makeTicket({
      goal_mode: false,
      goal_success_criteria: 'Ship without regressions'
    })
    useKanbanStore.setState({
      tickets: new Map([['proj-1', [ticket]]])
    })
    mockKanbanTicketApi.getBySession.mockResolvedValue([ticket])

    await useKanbanStore.getState().relinkTicketsForHandoff('session-old', 'session-new', true)

    expect(mockKanbanTicketApi.update).toHaveBeenCalledWith('ticket-1', {
      current_session_id: 'session-new',
      plan_ready: false,
      mode: 'build',
      goal_mode: true,
      goal_success_criteria: 'Ship without regressions'
    })
    expect(useKanbanStore.getState().tickets.get('proj-1')?.[0]).toMatchObject({
      current_session_id: 'session-new',
      plan_ready: false,
      mode: 'build',
      goal_mode: true,
      goal_success_criteria: 'Ship without regressions'
    })
  })

  test('defaults omitted goal mode to false and clears criteria', async () => {
    const ticket = makeTicket({
      goal_mode: true,
      goal_success_criteria: 'Old criteria'
    })
    useKanbanStore.setState({
      tickets: new Map([['proj-1', [ticket]]])
    })
    mockKanbanTicketApi.getBySession.mockResolvedValue([ticket])

    await useKanbanStore.getState().relinkTicketsForHandoff('session-old', 'session-new')

    expect(mockKanbanTicketApi.update).toHaveBeenCalledWith('ticket-1', {
      current_session_id: 'session-new',
      plan_ready: false,
      mode: 'build',
      goal_mode: false,
      goal_success_criteria: null
    })
    expect(useKanbanStore.getState().tickets.get('proj-1')?.[0]).toMatchObject({
      current_session_id: 'session-new',
      plan_ready: false,
      mode: 'build',
      goal_mode: false,
      goal_success_criteria: null
    })
  })
})
