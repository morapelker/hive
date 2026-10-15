import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'
import { notifyKanbanNewSession } from './store-coordination'
import { useKanbanStore } from './useKanbanStore'

// A shell command's ticket dragged back to To Do keeps the base worktree its command ran in,
// with no session. It waits there for its own next run: an agent session opened in that
// worktree must not adopt it, its text is not a prompt.

const initialKanbanState = useKanbanStore.getState()

const PROJECT_ID = 'proj-1'
const BASE_WORKTREE = 'wt-base'

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
    worktree_id: BASE_WORKTREE,
    mode: null,
    plan_ready: false,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
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

const shellTicket = (overrides: Partial<KanbanTicket> = {}): KanbanTicket =>
  makeTicket({
    id: 'ticket-shell',
    title: 'Build',
    description: 'pnpm build',
    mode: 'build',
    external_provider: 'shell-command',
    external_id: 'build',
    created_from_session: true,
    ...overrides
  })

const updateTicket = vi.fn()

beforeEach(() => {
  updateTicket.mockResolvedValue(undefined)
  useKanbanStore.setState({ updateTicket })
})

afterEach(() => {
  vi.resetAllMocks()
  useKanbanStore.setState(initialKanbanState, true)
})

describe('a new session in the worktree of a shell command ticket', () => {
  it('is not attached to the ticket, which stays in To Do without a session', () => {
    // The board is showing: an adopted ticket would also become the Telegram target.
    useKanbanStore.setState({
      tickets: new Map([[PROJECT_ID, [shellTicket()]]]),
      isBoardViewActive: true
    })

    notifyKanbanNewSession('session-agent', BASE_WORKTREE, PROJECT_ID, 'build')

    expect(updateTicket).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().boardTelegramTarget).toBeNull()
  })

  it.each(['in_progress', 'review', 'done'] as const)(
    'leaves a session-less shell command ticket in %s alone too',
    (column) => {
      useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [shellTicket({ column })]]]) })

      notifyKanbanNewSession('session-agent', BASE_WORKTREE, PROJECT_ID, 'plan')

      expect(updateTicket).not.toHaveBeenCalled()
    }
  )

  it('still goes to a plain ticket pre-assigned to that worktree, past the shell one', () => {
    // In Progress already holds a ticket at 5: the adopted one lands on top of it.
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT_ID,
          [
            shellTicket(),
            makeTicket({ id: 'ticket-waiting' }),
            makeTicket({
              id: 'ticket-running',
              column: 'in_progress',
              sort_order: 5,
              current_session_id: 'session-other'
            })
          ]
        ]
      ]),
      isBoardViewActive: true
    })

    notifyKanbanNewSession('session-1', BASE_WORKTREE, PROJECT_ID, 'plan')

    expect(updateTicket).toHaveBeenCalledTimes(1)
    expect(updateTicket).toHaveBeenCalledWith('ticket-waiting', PROJECT_ID, {
      current_session_id: 'session-1',
      column: 'in_progress',
      sort_order: 4,
      mode: 'plan',
      plan_ready: false
    })
    expect(useKanbanStore.getState().boardTelegramTarget).toEqual({
      ticketId: 'ticket-waiting',
      projectId: PROJECT_ID,
      worktreeId: BASE_WORKTREE,
      sessionId: 'session-1'
    })
  })

  it.each([
    ['an imported ticket', { external_provider: 'jira', external_id: 'X-1' }],
    // Only the provider marks a ticket: a command's id under another provider is just an id.
    [
      'an imported ticket sharing the command id',
      { external_provider: 'jira', external_id: 'build' }
    ]
  ])('still adopts %s', (_name, external) => {
    useKanbanStore.setState({
      tickets: new Map([[PROJECT_ID, [makeTicket({ id: 'ticket-imported', ...external })]]])
    })

    notifyKanbanNewSession('session-1', BASE_WORKTREE, PROJECT_ID, 'build')

    expect(updateTicket).toHaveBeenCalledTimes(1)
    expect(updateTicket).toHaveBeenCalledWith(
      'ticket-imported',
      PROJECT_ID,
      expect.objectContaining({ current_session_id: 'session-1', column: 'in_progress' })
    )
  })
})
