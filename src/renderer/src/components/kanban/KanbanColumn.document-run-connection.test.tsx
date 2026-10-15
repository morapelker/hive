/**
 * Dropping the ticket of a CONNECTION document run on Done/Merged: the ticket has no worktree
 * (its integration branches live in the run's instance, one worktree per member), so the drop
 * queues the per-member merge-on-done flow of a connection-project ticket.
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
const connectionMerge = vi.hoisted(() => ({
  buildConnectionMergeQueue: vi.fn(),
  resolveTicketConnectionId: vi.fn(),
  // The real helper, over the faked queue: the assertions below see exactly what the column
  // hands the dialog.
  queueConnectionRunMerge: vi.fn(
    async (args: {
      connectionId: string
      ticketId: string
      projectId: string
      targetColumn: 'done' | 'merged'
      sortOrder: number
      archivePromptOnly: boolean
    }): Promise<boolean> => {
      const queue: { worktreeId: string; projectId: string }[] =
        await connectionMerge.buildConnectionMergeQueue(args.connectionId, {
          includeAlreadyMerged: args.archivePromptOnly
        })
      if (queue.length === 0) return false
      const [first, ...rest] = queue
      useKanbanStore.getState().setPendingDoneMove({
        ticketId: args.ticketId,
        projectId: args.projectId,
        sortOrder: args.sortOrder,
        targetColumn: args.targetColumn,
        worktreeId: first.worktreeId,
        worktreeProjectId: first.projectId,
        remainingWorktrees: rest,
        offerArchive: true
      })
      return true
    }
  )
}))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: flowApi }))
vi.mock('@/api/db-api', () => ({ dbApi: dbApiMocks }))
vi.mock('@/api/git-api', () => ({ gitApi: gitApiMocks }))
vi.mock('@/lib/connection-merge', () => connectionMerge)

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

/** The run's own ticket: no worktree and no session, it sits on the integration instance. */
function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-run',
    project_id: 'proj-conn',
    title: 'Checkout redesign',
    description: null,
    attachments: [],
    column: 'review',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
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

const WEB = { worktreeId: 'wt-web-integration', projectId: 'proj-web' }
const API = { worktreeId: 'wt-api-integration', projectId: 'proj-api' }

const moveTicket = vi.fn()
const setPendingDoneMove = vi.fn()

function seedRun(
  status: DocumentRunStatus,
  run: Partial<DocumentRunDetail['run']> = {}
): DocumentRunDetail {
  const detail = makeDetail(
    {
      id: 'run-1',
      project_id: 'proj-conn',
      status,
      base_branch: 'main',
      integration_worktree_id: null,
      integration_worktree_path: null,
      integration_connection_id: 'conn-integration',
      integration_connection_path: '/connections/doc-checkout',
      ...run
    },
    [{ key: 'A1', status: 'merged' }]
  )
  useDocumentFlowStore.setState({ runsById: { 'run-1': detail } })
  return detail
}

/** Drop `ticket` (as it sits in its own column) on `column`. */
async function drop(ticket: KanbanTicket, column: KanbanTicketColumn): Promise<void> {
  useKanbanStore.setState({ tickets: new Map([[ticket.project_id, [ticket]]]) })
  render(
    <TooltipProvider>
      <KanbanColumn column={column} projectId="proj-conn" tickets={[]} />
    </TooltipProvider>
  )
  setKanbanDragData({
    projectId: ticket.project_id,
    ticketId: ticket.id,
    sourceColumn: ticket.column,
    sourceIndex: 0
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
  connectionMerge.buildConnectionMergeQueue.mockResolvedValue([WEB, API])
  connectionMerge.resolveTicketConnectionId.mockResolvedValue(null)
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

describe('dropping the ticket of an ended connection run', () => {
  it.each(['completed', 'completed_with_issues', 'cancelled'] as const)(
    'queues the per-member merge flow of the integration instance for a %s run on Done',
    async (status) => {
      seedRun(status)

      await drop(makeTicket(), 'done')

      await waitFor(() =>
        expect(setPendingDoneMove).toHaveBeenCalledWith({
          ticketId: 'ticket-run',
          projectId: 'proj-conn',
          sortOrder: 0,
          targetColumn: 'done',
          worktreeId: WEB.worktreeId,
          worktreeProjectId: WEB.projectId,
          remainingWorktrees: [API],
          offerArchive: true
        })
      )
      // Review → Done also queues already-merged members so each still gets archive/keep.
      expect(connectionMerge.buildConnectionMergeQueue).toHaveBeenCalledWith('conn-integration', {
        includeAlreadyMerged: true
      })
      expect(moveTicket).not.toHaveBeenCalled()
      expect(toast.warning).not.toHaveBeenCalled()
      // The single-worktree path never ran: there is no worktree to look at.
      expect(dbApiMocks.worktree.get).not.toHaveBeenCalled()
      expect(connectionMerge.resolveTicketConnectionId).not.toHaveBeenCalled()
    }
  )

  it('queues it for Merged without the archive-only pass over merged members', async () => {
    seedRun('completed')

    await drop(makeTicket(), 'merged')

    await waitFor(() =>
      expect(setPendingDoneMove).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 'ticket-run', targetColumn: 'merged' })
      )
    )
    expect(connectionMerge.buildConnectionMergeQueue).toHaveBeenCalledWith('conn-integration', {
      includeAlreadyMerged: false
    })
  })

  it('moves the ticket when no member has anything left to merge', async () => {
    seedRun('completed')
    connectionMerge.buildConnectionMergeQueue.mockResolvedValue([])

    await drop(makeTicket(), 'done')

    await waitFor(() =>
      expect(moveTicket).toHaveBeenCalledWith('ticket-run', 'proj-conn', 'done', 0)
    )
    expect(setPendingDoneMove).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('says so, and leaves the ticket, when a member cannot be checked', async () => {
    seedRun('completed')
    connectionMerge.buildConnectionMergeQueue.mockRejectedValue(
      new Error('doc-checkout: could not verify merge status')
    )

    await drop(makeTicket(), 'done')

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Could not verify merge status: doc-checkout: could not verify merge status'
      )
    )
    expect(moveTicket).not.toHaveBeenCalled()
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })

  it('reads the instance off a run fetched from the server', async () => {
    const detail = makeDetail(
      {
        id: 'run-1',
        project_id: 'proj-conn',
        status: 'completed',
        integration_worktree_id: null,
        integration_connection_id: 'conn-integration'
      },
      [{ key: 'A1', status: 'merged' }]
    )
    flowApi.get.mockResolvedValue(detail)

    await drop(makeTicket(), 'done')

    expect(flowApi.get).toHaveBeenCalledWith('run-1')
    await waitFor(() =>
      expect(setPendingDoneMove).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: WEB.worktreeId, offerArchive: true })
      )
    )
  })
})

describe('dropping the ticket of a connection run that is still going', () => {
  it('refuses it before looking at the instance', async () => {
    seedRun('running')

    await drop(makeTicket({ column: 'in_progress' }), 'done')

    expect(toast.warning).toHaveBeenCalledWith(
      'The document run is still going. Wait for it to end, or cancel it, before merging it.'
    )
    expect(connectionMerge.buildConnectionMergeQueue).not.toHaveBeenCalled()
    expect(moveTicket).not.toHaveBeenCalled()
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })
})

describe('the ticket of a git run that lost its worktree', () => {
  it('still moves without touching the connection path', async () => {
    seedRun('completed', { integration_connection_id: null, integration_connection_path: null })

    await drop(makeTicket(), 'done')

    await waitFor(() =>
      expect(moveTicket).toHaveBeenCalledWith('ticket-run', 'proj-conn', 'done', 0)
    )
    expect(connectionMerge.buildConnectionMergeQueue).not.toHaveBeenCalled()
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })
})
