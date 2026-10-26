/**
 * Deleting or archiving a ticket ends its work: the attached session is closed (so its
 * agent process dies) with the same shared-session guards as the Done close — never while
 * another live ticket rides the session, while it is working or being revived, or while it
 * holds a document run's document update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'

const {
  closeSession,
  isSessionReactivating,
  toastError,
  isTicketInDocumentUpdateLane,
  sessionGet
} = vi.hoisted(() => ({
  closeSession: vi.fn().mockResolvedValue({ success: true }),
  isSessionReactivating: vi.fn(() => false),
  toastError: vi.fn(),
  isTicketInDocumentUpdateLane: vi.fn((_ticketId: string) => false),
  sessionGet: vi.fn()
}))

vi.mock('@/api/db-api', () => ({ dbApi: { session: { get: sessionGet } } }))

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      delete: vi.fn().mockResolvedValue(true),
      archive: vi.fn().mockResolvedValue(null),
      archiveAllDone: vi.fn().mockResolvedValue(0),
      getBySession: vi.fn().mockResolvedValue([])
    },
    dependency: {
      removeAll: vi.fn().mockResolvedValue(0)
    }
  }
}))

vi.mock('./useSessionStore', () => ({
  useSessionStore: { getState: () => ({ closeSession }) },
  isSessionReactivating
}))

vi.mock('./store-coordination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store-coordination')>()),
  isTicketInDocumentUpdateLane
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() }
}))

import { closeSessionOfFinishedTicket, useKanbanStore } from './useKanbanStore'
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
    created_from_session: true,
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

function seed(ticket: KanbanTicket): void {
  useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [ticket]]]) })
}

// Drain the detached close task (link check, dynamic import, close).
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

type RemoveAction = 'deleteTicket' | 'archiveTicket'
const remove = (action: RemoveAction): Promise<void> =>
  useKanbanStore.getState()[action]('ticket-1', PROJECT_ID)

beforeEach(() => {
  vi.clearAllMocks()
  closeSession.mockResolvedValue({ success: true })
  isSessionReactivating.mockReturnValue(false)
  isTicketInDocumentUpdateLane.mockReturnValue(false)
  vi.mocked(kanbanApi.ticket.getBySession).mockResolvedValue([])
  sessionGet.mockImplementation(async (id: string) => ({ id, status: 'active' }))
  useKanbanStore.setState({ tickets: new Map(), dependencyMap: new Map() })
  useWorktreeStatusStore.setState({ sessionStatuses: {} })
})

afterEach(() => {
  useKanbanStore.setState({ tickets: new Map(), dependencyMap: new Map() })
  useWorktreeStatusStore.setState({ sessionStatuses: {} })
})

describe.each(['deleteTicket', 'archiveTicket'] as const)(
  '%s closes the ticket session',
  (action) => {
    it('closes the attached session like the Done close does', async () => {
      seed(makeTicket())

      await remove(action)
      await flush()

      expect(closeSession).toHaveBeenCalledTimes(1)
      expect(closeSession).toHaveBeenCalledWith(SESSION_ID, {
        abortIfRevived: true,
        stopRemote: true
      })
    })

    it('does nothing for a ticket without a session', async () => {
      seed(makeTicket({ current_session_id: null }))

      await remove(action)
      await flush()

      expect(kanbanApi.ticket.getBySession).not.toHaveBeenCalled()
      expect(closeSession).not.toHaveBeenCalled()
    })

    it('keeps a session another live ticket still rides', async () => {
      seed(makeTicket())
      vi.mocked(kanbanApi.ticket.getBySession).mockResolvedValue([
        makeTicket(),
        makeTicket({ id: 'ticket-2', column: 'review' })
      ])

      await remove(action)
      await flush()

      expect(closeSession).not.toHaveBeenCalled()
    })

    it('closes a session whose other tickets are archived, done or merged', async () => {
      seed(makeTicket())
      vi.mocked(kanbanApi.ticket.getBySession).mockResolvedValue([
        makeTicket({
          id: 'ticket-2',
          column: 'in_progress',
          archived_at: '2026-01-02T00:00:00.000Z'
        }),
        makeTicket({ id: 'ticket-3', column: 'done' }),
        makeTicket({ id: 'ticket-4', column: 'merged' })
      ])

      await remove(action)
      await flush()

      expect(closeSession).toHaveBeenCalledTimes(1)
    })

    it('skips the close when the link set cannot be read', async () => {
      seed(makeTicket())
      vi.mocked(kanbanApi.ticket.getBySession).mockRejectedValue(new Error('db down'))
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      await remove(action)
      await flush()

      expect(closeSession).not.toHaveBeenCalled()
      consoleError.mockRestore()
    })

    it('keeps a session that is working', async () => {
      seed(makeTicket())
      useWorktreeStatusStore.setState({
        sessionStatuses: { [SESSION_ID]: { status: 'working', timestamp: Date.now() } }
      })

      await remove(action)
      await flush()

      expect(closeSession).not.toHaveBeenCalled()
    })

    it('keeps a session that is being revived', async () => {
      seed(makeTicket())
      isSessionReactivating.mockReturnValue(true)

      await remove(action)
      await flush()

      expect(closeSession).not.toHaveBeenCalled()
    })

    it("keeps a session that holds a document run's document update", async () => {
      seed(makeTicket())
      isTicketInDocumentUpdateLane.mockReturnValue(true)

      await remove(action)
      await flush()

      expect(closeSession).not.toHaveBeenCalled()
    })

    it('surfaces a failed close without failing the ticket change', async () => {
      seed(makeTicket())
      closeSession.mockResolvedValue({ success: false, error: 'remote stop failed: offline' })
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(remove(action)).resolves.toBeUndefined()
      await flush()

      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining('its session could not be closed: remote stop failed: offline')
      )
      consoleError.mockRestore()
    })

    it('leaves an already closed session alone (its completed_at stays)', async () => {
      seed(makeTicket({ column: 'done' }))
      sessionGet.mockResolvedValue({ id: SESSION_ID, status: 'completed' })

      await remove(action)
      await flush()

      expect(closeSession).not.toHaveBeenCalled()
    })

    it('still closes when the session row cannot be read', async () => {
      seed(makeTicket())
      sessionGet.mockRejectedValue(new Error('db down'))

      await remove(action)
      await flush()

      expect(closeSession).toHaveBeenCalledTimes(1)
    })

    it('does not report an aborted close (a revival won)', async () => {
      seed(makeTicket())
      closeSession.mockResolvedValue({ success: false, aborted: true })

      await remove(action)
      await flush()

      expect(toastError).not.toHaveBeenCalled()
    })
  }
)

describe("archiveAllDone closes the archived tickets' sessions", () => {
  const archiveAll = (includeMerged?: boolean): Promise<number> =>
    useKanbanStore.getState().archiveAllDone(PROJECT_ID, includeMerged)

  it('closes each distinct session of the archived done and merged tickets once', async () => {
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT_ID,
          [
            makeTicket({ id: 't-done', column: 'done', current_session_id: 'sess-a' }),
            makeTicket({ id: 't-merged', column: 'merged', current_session_id: 'sess-b' }),
            // Shares sess-b with t-merged and is archived in the same batch
            makeTicket({ id: 't-merged-2', column: 'merged', current_session_id: 'sess-b' }),
            makeTicket({ id: 't-no-session', column: 'done', current_session_id: null }),
            makeTicket({ id: 't-live', column: 'in_progress', current_session_id: 'sess-c' }),
            makeTicket({
              id: 't-old',
              column: 'done',
              current_session_id: 'sess-d',
              archived_at: '2026-01-02T00:00:00.000Z'
            })
          ]
        ]
      ])
    })

    await expect(archiveAll(true)).resolves.toBe(4)
    await flush()

    expect(closeSession.mock.calls.map(([id]) => id)).toEqual(['sess-a', 'sess-b'])
  })

  it('leaves merged tickets (and their sessions) alone without includeMerged', async () => {
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT_ID,
          [
            makeTicket({ id: 't-done', column: 'done', current_session_id: 'sess-a' }),
            makeTicket({ id: 't-merged', column: 'merged', current_session_id: 'sess-b' })
          ]
        ]
      ])
    })

    await archiveAll(false)
    await flush()

    expect(closeSession.mock.calls.map(([id]) => id)).toEqual(['sess-a'])
  })

  it('keeps a shared session when any of its archived tickets holds a document update', async () => {
    isTicketInDocumentUpdateLane.mockImplementation((id: string) => id === 't-2')
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT_ID,
          [makeTicket({ id: 't-1', column: 'done' }), makeTicket({ id: 't-2', column: 'done' })]
        ]
      ])
    })

    await archiveAll()
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('closes nothing when the bulk archive failed', async () => {
    seed(makeTicket({ column: 'done' }))
    vi.mocked(kanbanApi.ticket.archiveAllDone).mockRejectedValueOnce(new Error('boom'))

    await expect(archiveAll()).rejects.toThrow('boom')
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
  })
})

// The same close, called directly: by a document run once a merged ticket's document update is
// over (through the runner's closeTicketSession port), and by the PR merge for a ticket of a
// board that was never loaded.
describe('closeSessionOfFinishedTicket', () => {
  it('closes the session of a merged ticket with the same guards as the board moves', async () => {
    await closeSessionOfFinishedTicket(SESSION_ID, 'ticket-1', 'merged')

    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(closeSession).toHaveBeenCalledWith(SESSION_ID, {
      abortIfRevived: true,
      stopRemote: true
    })
    expect(toastError).not.toHaveBeenCalled()
  })

  it("leaves the session to the run while the ticket is still in its document edit lane", async () => {
    isTicketInDocumentUpdateLane.mockImplementation((id: string) => id === 'ticket-1')

    await closeSessionOfFinishedTicket(SESSION_ID, 'ticket-1', 'merged')

    expect(closeSession).not.toHaveBeenCalled()
    expect(kanbanApi.ticket.getBySession).not.toHaveBeenCalled()
  })

  it('leaves an already closed session alone', async () => {
    sessionGet.mockImplementation(async (id: string) => ({ id, status: 'completed' }))

    await closeSessionOfFinishedTicket(SESSION_ID, 'ticket-1', 'done')

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('leaves a working session alone', async () => {
    useWorktreeStatusStore.setState({
      sessionStatuses: { [SESSION_ID]: { status: 'working', timestamp: Date.now() } }
    })

    await closeSessionOfFinishedTicket(SESSION_ID, 'ticket-1', 'merged')

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('closes a session that was merely still working when the caller moved the ticket (movedAtMs), like a drop on the board', async () => {
    const movedAtMs = Date.now()
    useWorktreeStatusStore.setState({
      sessionStatuses: { [SESSION_ID]: { status: 'working', timestamp: movedAtMs - 1000 } }
    })

    await closeSessionOfFinishedTicket(SESSION_ID, 'ticket-1', 'merged', { movedAtMs })

    expect(closeSession).toHaveBeenCalledTimes(1)
  })

  it('leaves a session revived after the caller moved the ticket (a status newer than movedAtMs)', async () => {
    const movedAtMs = Date.now()
    useWorktreeStatusStore.setState({
      sessionStatuses: { [SESSION_ID]: { status: 'working', timestamp: movedAtMs + 1000 } }
    })

    await closeSessionOfFinishedTicket(SESSION_ID, 'ticket-1', 'merged', { movedAtMs })

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('rejects when the link set cannot be read, so the caller skips the close', async () => {
    vi.mocked(kanbanApi.ticket.getBySession).mockRejectedValue(new Error('db down'))

    await expect(closeSessionOfFinishedTicket(SESSION_ID, 'ticket-1', 'merged')).rejects.toThrow(
      'db down'
    )

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('names what became of the ticket when the close fails', async () => {
    closeSession.mockResolvedValue({ success: false, error: 'pty gone' })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await closeSessionOfFinishedTicket(SESSION_ID, 'ticket-1', 'merged')

    expect(toastError).toHaveBeenCalledWith(
      'Ticket merged, but its session could not be closed: pty gone'
    )
    consoleError.mockRestore()
  })
})

describe('a failed ticket change closes nothing', () => {
  it('deleteTicket: the RPC failed and the ticket was restored', async () => {
    seed(makeTicket())
    vi.mocked(kanbanApi.ticket.delete).mockRejectedValueOnce(new Error('boom'))

    await expect(remove('deleteTicket')).rejects.toThrow('boom')
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
  })

  it('archiveTicket: the RPC failed and the ticket was restored', async () => {
    seed(makeTicket())
    vi.mocked(kanbanApi.ticket.archive).mockRejectedValueOnce(new Error('boom'))

    await expect(remove('archiveTicket')).rejects.toThrow('boom')
    await flush()

    expect(closeSession).not.toHaveBeenCalled()
  })
})
