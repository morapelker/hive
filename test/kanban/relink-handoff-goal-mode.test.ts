import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { KanbanTicket } from '../../src/main/db/types'
import { useKanbanStore } from '@/stores/useKanbanStore'

const getBySession = vi.fn()
const updateTicket = vi.fn()

Object.defineProperty(window, 'kanban', {
  writable: true,
  configurable: true,
  value: {
    ticket: {
      getBySession,
      update: updateTicket
    }
  }
})

function makeEnvelope<T>(value: T): { success: true; value: T } {
  return { success: true, value }
}

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
    updateTicket.mockResolvedValue(makeEnvelope(undefined))
  })

  test('writes goal mode true and keeps existing criteria when requested', async () => {
    const ticket = makeTicket({
      goal_mode: false,
      goal_success_criteria: 'Ship without regressions'
    })
    useKanbanStore.setState({
      tickets: new Map([['proj-1', [ticket]]])
    })
    getBySession.mockResolvedValue(makeEnvelope([ticket]))

    await useKanbanStore.getState().relinkTicketsForHandoff('session-old', 'session-new', true)

    expect(updateTicket).toHaveBeenCalledWith('ticket-1', {
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
    getBySession.mockResolvedValue(makeEnvelope([ticket]))

    await useKanbanStore.getState().relinkTicketsForHandoff('session-old', 'session-new')

    expect(updateTicket).toHaveBeenCalledWith('ticket-1', {
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
