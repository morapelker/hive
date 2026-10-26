import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../../main/db/types'

const { moveTicket, closeSessionOfFinishedTicket, rpcMove, rpcGetByProject } = vi.hoisted(
  () => ({
    moveTicket: vi.fn().mockResolvedValue(undefined),
    closeSessionOfFinishedTicket: vi.fn().mockResolvedValue(undefined),
    rpcMove: vi.fn().mockResolvedValue(undefined),
    rpcGetByProject: vi.fn().mockResolvedValue([])
  })
)

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      move: rpcMove,
      getByProject: rpcGetByProject
    }
  }
}))

vi.mock('@/stores/useKanbanStore', () => {
  const state = { tickets: new Map<string, KanbanTicket[]>(), moveTicket }
  return {
    useKanbanStore: {
      getState: () => state,
      setState: (partial: Partial<typeof state>) => Object.assign(state, partial)
    },
    closeSessionOfFinishedTicket
  }
})

vi.mock('@/stores/useSettingsStore', () => {
  const state = { showMergedColumn: true }
  return {
    useSettingsStore: {
      getState: () => state,
      setState: (partial: Partial<typeof state>) => Object.assign(state, partial)
    }
  }
})

vi.mock('@/stores/useWorktreeStore', () => {
  const state = { worktreesByProject: new Map<string, Array<{ id: string }>>() }
  return {
    useWorktreeStore: {
      getState: () => state,
      setState: (partial: Partial<typeof state>) => Object.assign(state, partial)
    }
  }
})

import { moveWorktreeTicketsToMerged } from '../pr-merge-ticket-move'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { makeDetail } from '@/components/document-flow/test-fixtures'

const PROJECT_ID = 'proj-1'
const WORKTREE_ID = 'wt-1'

// The mocked worktree store only needs `id` on its worktrees; the cast keeps
// the real module's Worktree[] typing out of the fixture.
const seedWorktreeProject = (): void => {
  useWorktreeStore.setState({
    worktreesByProject: new Map([[PROJECT_ID, [{ id: WORKTREE_ID }]]])
  } as unknown as Parameters<typeof useWorktreeStore.setState>[0])
}

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'A ticket',
    description: null,
    attachments: [],
    column: 'review',
    sort_order: 5,
    current_session_id: null,
    worktree_id: WORKTREE_ID,
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
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ticket_prefix: null,
    ticket_number: null,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  } as KanbanTicket
}

beforeEach(() => {
  vi.clearAllMocks()
  rpcGetByProject.mockResolvedValue([])
  useKanbanStore.setState({ tickets: new Map() })
  useSettingsStore.setState({ showMergedColumn: true })
  useWorktreeStore.setState({ worktreesByProject: new Map() })
})

afterEach(() => {
  useKanbanStore.setState({ tickets: new Map() })
})

describe('moveWorktreeTicketsToMerged', () => {
  it('moves the linked loaded ticket to the merged column', async () => {
    useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [makeTicket()]]]) })

    await moveWorktreeTicketsToMerged(WORKTREE_ID, 42)

    expect(moveTicket).toHaveBeenCalledWith('ticket-1', PROJECT_ID, 'merged', 5)
    expect(rpcGetByProject).not.toHaveBeenCalled()
  })

  it('does nothing when the merged column is hidden in settings', async () => {
    useSettingsStore.setState({ showMergedColumn: false })
    useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [makeTicket()]]]) })

    await moveWorktreeTicketsToMerged(WORKTREE_ID, 42)

    expect(moveTicket).not.toHaveBeenCalled()
    expect(rpcMove).not.toHaveBeenCalled()
  })

  it('leaves terminal, archived, unrelated, and other-PR tickets in place', async () => {
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT_ID,
          [
            makeTicket({ id: 'done', column: 'done' }),
            makeTicket({ id: 'merged', column: 'merged' }),
            makeTicket({ id: 'archived', archived_at: '2026-01-02T00:00:00.000Z' }),
            makeTicket({ id: 'other-worktree', worktree_id: 'wt-other' }),
            makeTicket({ id: 'other-pr', github_pr_number: 7 }),
            makeTicket({ id: 'same-pr', github_pr_number: 42 })
          ]
        ]
      ])
    })

    await moveWorktreeTicketsToMerged(WORKTREE_ID, 42)

    expect(moveTicket).toHaveBeenCalledTimes(1)
    expect(moveTicket).toHaveBeenCalledWith('same-pr', PROJECT_ID, 'merged', 5)
  })

  it('falls back to a DB fetch + RPC move when the project board was never loaded', async () => {
    seedWorktreeProject()
    rpcGetByProject.mockResolvedValue([makeTicket({ id: 'db-ticket', sort_order: 3 })])

    await moveWorktreeTicketsToMerged(WORKTREE_ID, 42)

    expect(moveTicket).not.toHaveBeenCalled()
    expect(rpcGetByProject).toHaveBeenCalledWith(PROJECT_ID, false)
    expect(rpcMove).toHaveBeenCalledWith(PROJECT_ID, 'db-ticket', 'merged', 3)
  })

  it("closes a DB-path ticket's session once the RPC accepted the move, as a store move does on entering Merged", async () => {
    seedWorktreeProject()
    rpcGetByProject.mockResolvedValue([
      makeTicket({ id: 'db-with-session', current_session_id: 'sess-1' }),
      makeTicket({ id: 'db-no-session', current_session_id: null })
    ])

    await moveWorktreeTicketsToMerged(WORKTREE_ID, 42)

    expect(closeSessionOfFinishedTicket).toHaveBeenCalledTimes(1)
    // Stamped with the move, like a drop on the board: a session merely still working when
    // the PR merged is closed too, only a status newer than the move counts as a revival.
    expect(closeSessionOfFinishedTicket).toHaveBeenCalledWith(
      'sess-1',
      'db-with-session',
      'merged',
      { movedAtMs: expect.any(Number) }
    )
  })

  it('closes nothing for a DB-path move the RPC rejected, and survives a close that rejects', async () => {
    seedWorktreeProject()
    rpcGetByProject.mockResolvedValue([
      makeTicket({ id: 'db-fails', current_session_id: 'sess-fails' }),
      makeTicket({ id: 'db-moves', current_session_id: 'sess-moves' })
    ])
    rpcMove.mockRejectedValueOnce(new Error('boom'))
    closeSessionOfFinishedTicket.mockRejectedValueOnce(new Error('link set unreadable'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(moveWorktreeTicketsToMerged(WORKTREE_ID, 42)).resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(closeSessionOfFinishedTicket).toHaveBeenCalledTimes(1)
    expect(closeSessionOfFinishedTicket).toHaveBeenCalledWith('sess-moves', 'db-moves', 'merged', {
      movedAtMs: expect.any(Number)
    })
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('skips the DB fallback when the worktree project is already loaded', async () => {
    useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [makeTicket()]]]) })
    seedWorktreeProject()

    await moveWorktreeTicketsToMerged(WORKTREE_ID, 42)

    expect(moveTicket).toHaveBeenCalledTimes(1)
    expect(rpcGetByProject).not.toHaveBeenCalled()
  })

  it('leaves the ticket of a document run In Progress while its run is going, and moves it once the run ended', async () => {
    const runTicket = makeTicket({
      id: 'ticket-run',
      column: 'in_progress',
      mode: null,
      external_provider: 'document-run',
      external_id: 'run-1'
    })
    useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [runTicket]]]) })
    useDocumentFlowStore.setState({
      runsById: { 'run-1': makeDetail({ id: 'run-1', status: 'running' }) }
    })

    await moveWorktreeTicketsToMerged(WORKTREE_ID, 42)
    expect(moveTicket).not.toHaveBeenCalled()

    useDocumentFlowStore.setState({
      runsById: { 'run-1': makeDetail({ id: 'run-1', status: 'completed' }) }
    })
    await moveWorktreeTicketsToMerged(WORKTREE_ID, 42)
    expect(moveTicket).toHaveBeenCalledWith('ticket-run', PROJECT_ID, 'merged', 5)

    useDocumentFlowStore.setState({ runsById: {} })
  })

  it('leaves the ticket of an ended document run In Progress while a session executes its migrations, and moves it once that session is gone', async () => {
    const runTicket = makeTicket({
      id: 'ticket-run',
      column: 'in_progress',
      mode: null,
      external_provider: 'document-run',
      external_id: 'run-1'
    })
    useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [runTicket]]]) })
    // The run itself is over: only the migration session holds the ticket back.
    useDocumentFlowStore.setState({
      runsById: {
        'run-1': makeDetail({
          id: 'run-1',
          status: 'completed',
          migration_session_id: 'session-migrate'
        })
      }
    })

    await moveWorktreeTicketsToMerged(WORKTREE_ID, 42)
    expect(moveTicket).not.toHaveBeenCalled()
    expect(rpcMove).not.toHaveBeenCalled()

    useDocumentFlowStore.setState({
      runsById: {
        'run-1': makeDetail({ id: 'run-1', status: 'completed', migration_session_id: null })
      }
    })
    await moveWorktreeTicketsToMerged(WORKTREE_ID, 42)
    expect(moveTicket).toHaveBeenCalledTimes(1)
    expect(moveTicket).toHaveBeenCalledWith('ticket-run', PROJECT_ID, 'merged', 5)

    useDocumentFlowStore.setState({ runsById: {} })
  })

  it('holds back only the migrating run ticket: the other tickets of the worktree still move', async () => {
    const runTicket = makeTicket({
      id: 'ticket-run',
      column: 'in_progress',
      mode: null,
      external_provider: 'document-run',
      external_id: 'run-1'
    })
    useKanbanStore.setState({
      tickets: new Map([[PROJECT_ID, [runTicket, makeTicket({ id: 'ticket-plain' })]]])
    })
    useDocumentFlowStore.setState({
      runsById: {
        'run-1': makeDetail({
          id: 'run-1',
          status: 'completed',
          migration_session_id: 'session-migrate'
        })
      }
    })

    await moveWorktreeTicketsToMerged(WORKTREE_ID, 42)

    expect(moveTicket).toHaveBeenCalledTimes(1)
    expect(moveTicket).toHaveBeenCalledWith('ticket-plain', PROJECT_ID, 'merged', 5)

    useDocumentFlowStore.setState({ runsById: {} })
  })

  it('leaves a migrating run ticket alone on the DB fallback path too', async () => {
    seedWorktreeProject()
    rpcGetByProject.mockResolvedValue([
      makeTicket({
        id: 'db-run-ticket',
        column: 'in_progress',
        mode: null,
        external_provider: 'document-run',
        external_id: 'run-1'
      }),
      makeTicket({ id: 'db-ticket', sort_order: 3 })
    ])
    useDocumentFlowStore.setState({
      runsById: {
        'run-1': makeDetail({
          id: 'run-1',
          status: 'completed',
          migration_session_id: 'session-migrate'
        })
      }
    })

    await moveWorktreeTicketsToMerged(WORKTREE_ID, 42)

    expect(moveTicket).not.toHaveBeenCalled()
    expect(rpcMove).toHaveBeenCalledTimes(1)
    expect(rpcMove).toHaveBeenCalledWith(PROJECT_ID, 'db-ticket', 'merged', 3)

    useDocumentFlowStore.setState({ runsById: {} })
  })

  it('swallows move failures instead of rejecting', async () => {
    moveTicket.mockRejectedValueOnce(new Error('boom'))
    useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [makeTicket()]]]) })

    await expect(moveWorktreeTicketsToMerged(WORKTREE_ID, 42)).resolves.toBeUndefined()
  })
})
