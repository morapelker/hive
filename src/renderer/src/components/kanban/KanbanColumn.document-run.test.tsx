/**
 * Where the ticket of a document run may be dropped: it stays In Progress while its run is
 * going, never goes back to To Do, and once the run has ended a drop on Merged or Done takes
 * the same commit / merge / archive dialog as any ticket with a worktree.
 */
import type { PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { TooltipProvider } from '@/components/ui/tooltip'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { setKanbanDragData, useKanbanStore } from '@/stores/useKanbanStore'
import type { DocumentRunDetail, DocumentRunStatus } from '@shared/types/document-flow'
import type { KanbanTicket, KanbanTicketColumn } from '../../../../main/db/types'

const flowApi = vi.hoisted(() => ({ get: vi.fn() }))
const dbApiMocks = vi.hoisted(() => ({
  worktree: { get: vi.fn(), getActiveByProject: vi.fn() }
}))
const gitApiMocks = vi.hoisted(() => ({
  hasUncommittedChanges: vi.fn(),
  branchDiffShortStat: vi.fn()
}))

const runDoneQueue = vi.hoisted(() => ({ queueDocumentRunDone: vi.fn() }))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: flowApi }))
vi.mock('@/api/db-api', () => ({ dbApi: dbApiMocks }))
vi.mock('@/api/git-api', () => ({ gitApi: gitApiMocks }))
vi.mock('@/lib/document-flow/run-done-queue', () => runDoneQueue)

vi.mock('@/components/kanban/KanbanTicketCard', () => ({
  KanbanTicketCard: ({ ticket }: { ticket: KanbanTicket }) => (
    <div data-testid="kanban-ticket-card" data-ticket-id={ticket.id}>
      {ticket.title}
    </div>
  )
}))
vi.mock('@/components/kanban/WorktreePickerModal', () => ({
  WorktreePickerModal: ({ ticket, open }: { ticket: KanbanTicket | null; open: boolean }) =>
    open && ticket ? <div data-testid="worktree-picker" data-ticket-id={ticket.id} /> : null
}))
vi.mock('@/components/kanban/TicketCreateModal', () => ({ TicketCreateModal: () => null }))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

vi.mock('motion/react', () => ({
  LayoutGroup: ({ children }: PropsWithChildren) => <>{children}</>,
  motion: {
    div: ({
      children,
      layoutId: _layoutId,
      layout: _layout,
      layoutScroll: _layoutScroll,
      transition: _transition,
      ...props
    }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>
  }
}))

const initialFlowState = useDocumentFlowStore.getState()
const initialKanbanState = useKanbanStore.getState()

const now = '2026-06-01T00:00:00.000Z'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-run',
    project_id: 'proj-1',
    title: 'Checkout redesign',
    description: null,
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: null,
    worktree_id: 'wt-integration',
    mode: null,
    plan_ready: false,
    created_at: now,
    updated_at: now,
    column_changed_at: null,
    archived_at: null,
    external_provider: 'document-run',
    external_id: 'run-1',
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

const integrationWorktree = {
  id: 'wt-integration',
  project_id: 'proj-1',
  branch_name: 'doc-checkout',
  path: '/worktrees/doc-checkout',
  status: 'active',
  is_default: false,
  base_branch: 'main'
}
const mainWorktree = {
  id: 'wt-main',
  project_id: 'proj-1',
  branch_name: 'main',
  path: '/repo',
  status: 'active',
  is_default: true,
  base_branch: null
}

const moveTicket = vi.fn()
const setPendingDoneMove = vi.fn()

function seedRun(
  status: DocumentRunStatus,
  run: Partial<DocumentRunDetail['run']> = {}
): DocumentRunDetail {
  const detail = makeDetail(
    { id: 'run-1', project_id: 'proj-1', status, base_branch: 'main', ...run },
    [{ key: 'A1', status: 'merged' }]
  )
  useDocumentFlowStore.setState({ runsById: { 'run-1': detail } })
  return detail
}

/**
 * Drop `ticket` (as it sits in its own column) on `column`. jsdom has no DragEvent, so the
 * modifier keys of a drag can only travel through the drag data here, never the drop event.
 */
async function drop(
  ticket: KanbanTicket,
  column: KanbanTicketColumn,
  modifiers?: { shift: boolean }
): Promise<void> {
  useKanbanStore.setState({ tickets: new Map([[ticket.project_id, [ticket]]]) })
  render(
    <TooltipProvider>
      <KanbanColumn column={column} projectId="proj-1" tickets={[]} />
    </TooltipProvider>
  )
  setKanbanDragData({
    projectId: ticket.project_id,
    ticketId: ticket.id,
    sourceColumn: ticket.column,
    sourceIndex: 0,
    ...(modifiers ? { modifiers } : {})
  })
  await act(async () => {
    fireEvent.drop(screen.getByTestId(`kanban-drop-area-${column}`))
  })
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  flowApi.get.mockImplementation(
    async (runId: string) => useDocumentFlowStore.getState().runsById[runId] ?? null
  )
  dbApiMocks.worktree.get.mockResolvedValue(integrationWorktree)
  dbApiMocks.worktree.getActiveByProject.mockResolvedValue([integrationWorktree, mainWorktree])
  gitApiMocks.hasUncommittedChanges.mockResolvedValue(false)
  gitApiMocks.branchDiffShortStat.mockResolvedValue({
    success: true,
    filesChanged: 4,
    insertions: 40,
    deletions: 2,
    commitsAhead: 6
  })
  useKanbanStore.setState({
    tickets: new Map(),
    markdownDiagnostics: new Map(),
    markdownPlaceholders: new Map(),
    dependencyMap: new Map(),
    draggingTicketKey: null,
    simpleModeByProject: {},
    moveTicket,
    setPendingDoneMove
  })
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  setKanbanDragData(null)
  useDocumentFlowStore.setState(initialFlowState, true)
  useKanbanStore.setState(initialKanbanState, true)
})

describe('dropping the ticket of a run that is still going', () => {
  it.each([
    ['running', 'done'],
    ['running', 'merged'],
    ['paused', 'done'],
    ['paused', 'merged']
  ] as const)('refuses a %s run on %s and says why', async (status, column) => {
    seedRun(status)

    await drop(makeTicket(), column)

    expect(toast.warning).toHaveBeenCalledWith(
      'The document run is still going. Wait for it to end, or cancel it, before merging it.'
    )
    expect(moveTicket).not.toHaveBeenCalled()
    expect(setPendingDoneMove).not.toHaveBeenCalled()
    // Refused before anything looked at git.
    expect(dbApiMocks.worktree.get).not.toHaveBeenCalled()
  })

  it('keeps it out of Review: the app moves it there when the run ends', async () => {
    seedRun('running')

    await drop(makeTicket(), 'review')

    expect(toast.warning).toHaveBeenCalledWith(
      'The document run is still going; its ticket moves to Review when the run ends.'
    )
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('puts a ticket that strayed back In Progress without offering to launch a session', async () => {
    seedRun('running')

    await drop(makeTicket({ column: 'review' }), 'in_progress')

    expect(moveTicket).toHaveBeenCalledWith('ticket-run', 'proj-1', 'in_progress', 0)
    expect(screen.queryByTestId('worktree-picker')).toBeNull()
    expect(toast.warning).not.toHaveBeenCalled()
  })
})

describe('dropping the ticket of a run that is not launched', () => {
  it('opens the run’s preview to launch it when dropped on In Progress, without moving it', async () => {
    seedRun('preview')

    await drop(makeTicket({ column: 'todo', worktree_id: null }), 'in_progress')

    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'proj-1',
      runId: 'run-1'
    })
    expect(moveTicket).not.toHaveBeenCalled()
    expect(screen.queryByTestId('worktree-picker')).toBeNull()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it.each(['review', 'done', 'merged'] as const)(
    'refuses a previewed run on %s: In Progress is the way to launch it',
    async (column) => {
      seedRun('preview')

      await drop(makeTicket({ column: 'todo', worktree_id: null }), column)

      expect(toast.warning).toHaveBeenCalledWith(
        'This document run has not been launched yet. Drop its ticket on In Progress, or open it, to launch it.'
      )
      expect(moveTicket).not.toHaveBeenCalled()
      expect(setPendingDoneMove).not.toHaveBeenCalled()
      expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
    }
  )

  it('refuses a run whose tickets are still being extracted anywhere', async () => {
    seedRun('extracting')

    await drop(makeTicket({ column: 'todo', worktree_id: null }), 'in_progress')

    expect(toast.warning).toHaveBeenCalledWith(
      'The tickets of this document run are still being extracted. Wait for them before moving it.'
    )
    expect(moveTicket).not.toHaveBeenCalled()
    expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
  })

  it('refuses a run whose extraction failed, pointing at the retry', async () => {
    seedRun('extract_failed')

    await drop(makeTicket({ column: 'todo', worktree_id: null }), 'in_progress')

    expect(toast.warning).toHaveBeenCalledWith(
      'The tickets of this document run could not be extracted. Open its ticket to try again.'
    )
    expect(moveTicket).not.toHaveBeenCalled()
  })
})

describe('dropping the ticket of a run that has ended', () => {
  it.each(['completed', 'completed_with_issues', 'cancelled'] as const)(
    'opens the merge dialog for a %s run dropped on Done',
    async (status) => {
      seedRun(status)

      await drop(makeTicket({ column: 'review' }), 'done')

      await waitFor(() =>
        expect(setPendingDoneMove).toHaveBeenCalledWith({
          ticketId: 'ticket-run',
          projectId: 'proj-1',
          sortOrder: 0,
          targetColumn: 'done'
        })
      )
      // The integration branch against the run's base branch, like any worktree ticket.
      expect(gitApiMocks.branchDiffShortStat).toHaveBeenCalledWith(
        '/worktrees/doc-checkout',
        'main'
      )
      expect(moveTicket).not.toHaveBeenCalled()
      expect(toast.warning).not.toHaveBeenCalled()
    }
  )

  it('opens it for Merged as well', async () => {
    seedRun('completed')

    await drop(makeTicket({ column: 'review' }), 'merged')

    await waitFor(() =>
      expect(setPendingDoneMove).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 'ticket-run', targetColumn: 'merged' })
      )
    )
  })

  it('says so, and leaves the ticket, when no worktree has the base branch checked out', async () => {
    seedRun('completed')
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([
      integrationWorktree,
      { ...mainWorktree, branch_name: 'some-other-branch' }
    ])

    await drop(makeTicket({ column: 'review' }), 'done')

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Cannot merge doc-checkout: no worktree has main checked out. Check it out (in the project or a worktree) and move the ticket again.'
      )
    )
    expect(moveTicket).not.toHaveBeenCalled()
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })

  it('moves the ticket when no worktree has the base branch but nothing is left to merge', async () => {
    seedRun('cancelled')
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([
      integrationWorktree,
      { ...mainWorktree, branch_name: 'some-other-branch' }
    ])
    gitApiMocks.branchDiffShortStat.mockResolvedValue({
      success: true,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      commitsAhead: 0
    })

    await drop(makeTicket({ column: 'review' }), 'done')

    await waitFor(() => expect(moveTicket).toHaveBeenCalledWith('ticket-run', 'proj-1', 'done', 0))
    expect(toast.warning).not.toHaveBeenCalled()
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })

  it('refuses the move without a base worktree while the integration worktree is dirty', async () => {
    seedRun('completed')
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([
      integrationWorktree,
      { ...mainWorktree, branch_name: 'some-other-branch' }
    ])
    gitApiMocks.hasUncommittedChanges.mockResolvedValue(true)
    gitApiMocks.branchDiffShortStat.mockResolvedValue({
      success: true,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      commitsAhead: 0
    })

    await drop(makeTicket({ column: 'review' }), 'done')

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringMatching(/^Cannot merge doc-checkout/)
      )
    )
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('says so when the merge status cannot be read without a base worktree', async () => {
    seedRun('completed')
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([
      integrationWorktree,
      { ...mainWorktree, branch_name: 'some-other-branch' }
    ])
    gitApiMocks.branchDiffShortStat.mockResolvedValue({ success: false, error: 'unknown revision' })

    await drop(makeTicket({ column: 'review' }), 'done')

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Could not verify merge status: unknown revision')
    )
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('moves a ticket whose integration worktree was archived: there is nothing left to merge', async () => {
    seedRun('completed')

    await drop(makeTicket({ column: 'review', worktree_id: null }), 'done')

    await waitFor(() => expect(moveTicket).toHaveBeenCalledWith('ticket-run', 'proj-1', 'done', 0))
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })

  it('does not let it back into In Progress, and never opens the worktree picker for it', async () => {
    seedRun('completed')

    await drop(makeTicket({ column: 'review' }), 'in_progress')

    expect(toast.warning).toHaveBeenCalledWith(
      'This document run is over; its ticket cannot go back to In Progress.'
    )
    expect(moveTicket).not.toHaveBeenCalled()
    expect(screen.queryByTestId('worktree-picker')).toBeNull()
  })
})

describe('dropping the ticket of a run whose migrations are being executed', () => {
  const MIGRATING = { migration_session_id: 'session-mig' }

  it.each(['review', 'merged', 'done'] as const)(
    'refuses a move to %s and says why',
    async (column) => {
      seedRun('completed', MIGRATING)

      await drop(makeTicket(), column)

      expect(toast.warning).toHaveBeenCalledWith(
        'The migrations of this document run are being executed. Wait for them to finish, or stop them, before moving its ticket.'
      )
      expect(moveTicket).not.toHaveBeenCalled()
      expect(setPendingDoneMove).not.toHaveBeenCalled()
      // Refused before anything looked at git.
      expect(dbApiMocks.worktree.get).not.toHaveBeenCalled()
      expect(gitApiMocks.branchDiffShortStat).not.toHaveBeenCalled()
    }
  )

  it('puts a ticket that strayed back In Progress without offering to launch a session', async () => {
    seedRun('completed_with_issues', MIGRATING)

    await drop(makeTicket({ column: 'review' }), 'in_progress')

    expect(moveTicket).toHaveBeenCalledWith('ticket-run', 'proj-1', 'in_progress', 0)
    expect(screen.queryByTestId('worktree-picker')).toBeNull()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('reads the session off a run fetched from the server', async () => {
    const detail = makeDetail(
      { id: 'run-1', project_id: 'proj-1', status: 'completed', ...MIGRATING },
      [{ key: 'A1', status: 'merged' }]
    )
    flowApi.get.mockResolvedValue(detail)

    await drop(makeTicket(), 'done')

    expect(flowApi.get).toHaveBeenCalledWith('run-1')
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringMatching(/^The migrations of this document run are being executed\./)
    )
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('merges the ticket as usual once the run let go of its session', async () => {
    seedRun('completed', { migration_session_id: null })

    await drop(makeTicket({ column: 'review' }), 'done')

    await waitFor(() =>
      expect(setPendingDoneMove).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 'ticket-run', targetColumn: 'done' })
      )
    )
    expect(toast.warning).not.toHaveBeenCalled()
  })
})

describe('dropping a run ticket on To Do', () => {
  it.each(['running', 'completed'] as const)('refuses it for a %s run', async (status) => {
    seedRun(status)

    await drop(makeTicket({ column: status === 'running' ? 'in_progress' : 'review' }), 'todo')

    expect(toast.warning).toHaveBeenCalledWith(
      'The ticket of a document run cannot go back to To Do.'
    )
    expect(moveTicket).not.toHaveBeenCalled()
  })
})

describe('a run that is not in the store', () => {
  it('is fetched before deciding', async () => {
    const detail = makeDetail({ id: 'run-1', project_id: 'proj-1', status: 'running' })
    flowApi.get.mockResolvedValue(detail)

    await drop(makeTicket(), 'done')

    expect(flowApi.get).toHaveBeenCalledWith('run-1')
    expect(toast.warning).toHaveBeenCalledWith(
      'The document run is still going. Wait for it to end, or cancel it, before merging it.'
    )
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('moves nothing when the run cannot be checked', async () => {
    flowApi.get.mockRejectedValue(new Error('WebSocket is closed'))

    await drop(makeTicket({ column: 'review' }), 'done')

    expect(toast.warning).toHaveBeenCalledWith(
      'Could not check the document run: WebSocket is closed'
    )
    expect(moveTicket).not.toHaveBeenCalled()
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })

  it('lets the ticket of a deleted run be merged and moved like any other', async () => {
    flowApi.get.mockResolvedValue(null)

    await drop(makeTicket({ column: 'review' }), 'done')

    await waitFor(() => expect(setPendingDoneMove).toHaveBeenCalled())
    expect(toast.warning).not.toHaveBeenCalled()
  })
})

describe('shift-dropping the ticket of a run that has ended', () => {
  const batch = { shift: true }

  beforeEach(() => {
    seedRun('completed')
    runDoneQueue.queueDocumentRunDone.mockReset().mockResolvedValue('queued')
  })

  it('hands the whole run to the batch queue instead of the single-branch dialog', async () => {
    await drop(makeTicket({ column: 'review' }), 'done', batch)

    expect(runDoneQueue.queueDocumentRunDone).toHaveBeenCalledExactlyOnceWith({
      runId: 'run-1',
      ticketId: 'ticket-run',
      projectId: 'proj-1',
      targetColumn: 'done',
      sortOrder: expect.any(Number)
    })
    expect(setPendingDoneMove).not.toHaveBeenCalled()
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('does so for Merged as well', async () => {
    await drop(makeTicket({ column: 'review' }), 'merged', batch)

    expect(runDoneQueue.queueDocumentRunDone).toHaveBeenCalledWith(
      expect.objectContaining({ targetColumn: 'merged' })
    )
  })

  it('takes the usual single-branch path without shift', async () => {
    for (const modifiers of [undefined, { shift: false }]) {
      await drop(makeTicket({ column: 'review' }), 'done', modifiers)
      cleanup()
    }

    expect(runDoneQueue.queueDocumentRunDone).not.toHaveBeenCalled()
    await waitFor(() => expect(setPendingDoneMove).toHaveBeenCalledTimes(2))
  })

  it('still refuses the drop while the run is going', async () => {
    seedRun('running')

    await drop(makeTicket(), 'done', batch)

    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('still going'))
    expect(runDoneQueue.queueDocumentRunDone).not.toHaveBeenCalled()
  })

  it('moves the ticket like a plain drop when the run has nothing to batch', async () => {
    runDoneQueue.queueDocumentRunDone.mockResolvedValue('nothing')

    await drop(makeTicket({ column: 'review' }), 'done', batch)

    await waitFor(() => expect(setPendingDoneMove).toHaveBeenCalled())
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('refuses the drop when a branch of the run cannot be verified', async () => {
    runDoneQueue.queueDocumentRunDone.mockRejectedValue(new Error('a2-beta: git is down'))

    await drop(makeTicket({ column: 'review' }), 'done', batch)

    expect(toast.warning).toHaveBeenCalledWith('Could not verify merge status: a2-beta: git is down')
    expect(setPendingDoneMove).not.toHaveBeenCalled()
    expect(moveTicket).not.toHaveBeenCalled()
  })
})

describe('an ordinary ticket', () => {
  it('still moves silently when its base branch has no worktree', async () => {
    seedRun('running')
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([integrationWorktree])

    await drop(
      makeTicket({ id: 'ticket-1', column: 'review', external_provider: null, external_id: null }),
      'done'
    )

    await waitFor(() => expect(moveTicket).toHaveBeenCalledWith('ticket-1', 'proj-1', 'done', 0))
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
