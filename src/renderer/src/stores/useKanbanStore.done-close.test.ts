import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket, KanbanTicketColumn } from '../../../main/db/types'

const { closeSession, reactivateSession, isSessionReactivating, toastError } = vi.hoisted(() => ({
  closeSession: vi.fn().mockResolvedValue({ success: true }),
  reactivateSession: vi.fn().mockResolvedValue(undefined),
  isSessionReactivating: vi.fn(() => false),
  toastError: vi.fn()
}))

// Mock the kanban RPC API so moveTicket doesn't hit a real client.
vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      move: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(null),
      reorder: vi.fn().mockResolvedValue(undefined),
      addTokens: vi.fn().mockResolvedValue(null),
      getBySession: vi.fn().mockResolvedValue([])
    }
  }
}))

// moveTicket dynamically imports useSettingsStore for the follow-up trigger.
vi.mock('./useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ followUpTriggerColumn: 'done' }) }
}))

// moveTicket dynamically imports useSessionStore to close the attached
// session when a ticket enters the done column.
vi.mock('./useSessionStore', () => ({
  useSessionStore: { getState: () => ({ closeSession, reactivateSession }) },
  isSessionReactivating
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() }
}))

import { useKanbanStore } from './useKanbanStore'
import { useWorktreeStatusStore } from './useWorktreeStatusStore'
import { kanbanApi } from '@/api/kanban-api'

const SESSION_ID = 'sess-1'
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
    current_session_id: SESSION_ID,
    worktree_id: null,
    mode: 'build',
    plan_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
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
    created_from_session: true,
    auto_approve_plan: false,
    unread: false,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ...overrides
  }
}

function seed(ticket: KanbanTicket): void {
  useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [ticket]]]) })
}

function columnOf(ticketId: string): KanbanTicketColumn | undefined {
  return useKanbanStore
    .getState()
    .tickets.get(PROJECT_ID)
    ?.find((t) => t.id === ticketId)?.column
}

// Drain the detached close task fully — it spans several awaits (DB read,
// remote stop, lifecycle-locked close); a partial drain would leak a pending
// block into the next test where it consumes that test's mocks.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  closeSession.mockResolvedValue({ success: true })
  isSessionReactivating.mockReturnValue(false)
  useKanbanStore.setState({ tickets: new Map(), dependencyMap: new Map() })
  useWorktreeStatusStore.setState({ sessionStatuses: {} })
})

afterEach(() => {
  useKanbanStore.setState({ tickets: new Map(), dependencyMap: new Map() })
  useWorktreeStatusStore.setState({ sessionStatuses: {} })
})

describe('moveTicket — close attached session on the done column', () => {
  it('closes the attached session when a ticket moves to done', async () => {
    seed(makeTicket())

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()

    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(closeSession).toHaveBeenCalledWith(SESSION_ID, { abortIfRevived: true, stopRemote: true })
  })

  it('does not close the session when a ticket moves to merged', async () => {
    seed(makeTicket())

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'merged', 0)
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('does not close the session for non-terminal columns', async () => {
    seed(makeTicket({ column: 'todo' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('does not close anything for tickets without a session', async () => {
    seed(makeTicket({ current_session_id: null }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('skips the close when completion effects are suppressed (handoff rollback)', async () => {
    seed(makeTicket())

    await useKanbanStore
      .getState()
      .moveTicket('ticket-1', PROJECT_ID, 'done', 0, { skipCompletionEffects: true })
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('does not re-close on a move within the done column', async () => {
    seed(makeTicket({ column: 'done' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 3)
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('does not close the session when the move RPC fails (optimistic revert)', async () => {
    seed(makeTicket())
    vi.mocked(kanbanApi.ticket.move).mockRejectedValueOnce(new Error('boom'))

    await expect(
      useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    ).rejects.toThrow('boom')
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('does not close a session still shared with another live ticket', async () => {
    seed(makeTicket())
    vi.mocked(kanbanApi.ticket.getBySession).mockResolvedValueOnce([
      makeTicket(),
      makeTicket({ id: 'ticket-2', column: 'in_progress' })
    ])

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('closes the session when the other linked tickets are all terminal or archived', async () => {
    seed(makeTicket())
    vi.mocked(kanbanApi.ticket.getBySession).mockResolvedValueOnce([
      makeTicket(),
      makeTicket({ id: 'ticket-2', column: 'merged' }),
      makeTicket({ id: 'ticket-3', column: 'todo', archived_at: '2026-01-02T00:00:00.000Z' })
    ])

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()

    expect(closeSession).toHaveBeenCalledWith(SESSION_ID, { abortIfRevived: true, stopRemote: true })
  })

  it('skips the close (but not the move) when the link check fails', async () => {
    seed(makeTicket())
    vi.mocked(kanbanApi.ticket.getBySession).mockRejectedValueOnce(new Error('rpc down'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    ).resolves.toBeUndefined()
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('done')
    consoleError.mockRestore()
  })

  it('does not close when the ticket left done again during the async window', async () => {
    seed(makeTicket())
    vi.mocked(kanbanApi.ticket.getBySession).mockImplementationOnce(async () => {
      // User drags the ticket back to in_progress while the link check is in
      // flight — the optimistic store already reflects the newer intent.
      useKanbanStore.setState({
        tickets: new Map([[PROJECT_ID, [makeTicket({ column: 'in_progress' })]]])
      })
      return [makeTicket()]
    })

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('does not close when the session was revived during the move', async () => {
    seed(makeTicket())
    vi.mocked(kanbanApi.ticket.getBySession).mockImplementationOnce(async () => {
      // A background revival (follow-up / plan approval) stamps a fresh
      // working status while the close flow is in flight.
      useWorktreeStatusStore.setState({
        sessionStatuses: { [SESSION_ID]: { status: 'working', timestamp: Date.now() + 1000 } }
      })
      return [makeTicket()]
    })

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('does not close while a reactivation is in flight for the session', async () => {
    seed(makeTicket())
    isSessionReactivating.mockReturnValue(true)

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()

    expect(isSessionReactivating).toHaveBeenCalledWith(SESSION_ID)
    expect(closeSession).not.toHaveBeenCalled()
  })

  it('still closes when the session status predates the move (was simply working)', async () => {
    seed(makeTicket())
    useWorktreeStatusStore.setState({
      sessionStatuses: { [SESSION_ID]: { status: 'working', timestamp: Date.now() - 60_000 } }
    })

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()

    expect(closeSession).toHaveBeenCalledWith(SESSION_ID, { abortIfRevived: true, stopRemote: true })
  })






  it('reactivates the session when the ticket was dragged back out of done mid-close', async () => {
    seed(makeTicket())
    closeSession.mockImplementationOnce(async () => {
      // Backward drag lands while closeSession's own awaits are in flight
      useKanbanStore.setState({
        tickets: new Map([[PROJECT_ID, [makeTicket({ column: 'in_progress' })]]])
      })
      return { success: true }
    })

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()

    expect(reactivateSession).toHaveBeenCalledWith(SESSION_ID)
  })

  it('does not undo a backward-drag flow that unlinked the session on purpose', async () => {
    seed(makeTicket())
    closeSession.mockImplementationOnce(async () => {
      // Drag-to-todo completes AND unlinks the session itself
      useKanbanStore.setState({
        tickets: new Map([
          [PROJECT_ID, [makeTicket({ column: 'todo', current_session_id: null })]]
        ])
      })
      return { success: true }
    })

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()

    expect(reactivateSession).not.toHaveBeenCalled()
  })

  it('leaves settled done tickets alone after a successful close', async () => {
    seed(makeTicket())

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()

    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(reactivateSession).not.toHaveBeenCalled()
  })

  it('surfaces a non-aborted close failure via toast', async () => {
    seed(makeTicket())
    closeSession.mockResolvedValue({ success: false, error: 'db locked' })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()
    await flush()

    expect(toastError).toHaveBeenCalledWith(
      'Ticket is done, but its session could not be closed: db locked'
    )
    consoleError.mockRestore()
  })

  it('stays quiet when the close was aborted by a concurrent revival', async () => {
    seed(makeTicket())
    closeSession.mockResolvedValue({ success: false, aborted: true, error: 'revived' })

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    await flush()
    await flush()

    expect(toastError).not.toHaveBeenCalled()
  })

  it('does not fail the move when the session close rejects', async () => {
    seed(makeTicket())
    closeSession.mockRejectedValueOnce(new Error('pty gone'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'done', 0)
    ).resolves.toBeUndefined()
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    consoleError.mockRestore()
  })
})
