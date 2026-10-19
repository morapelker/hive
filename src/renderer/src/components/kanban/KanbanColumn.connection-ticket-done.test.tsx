/**
 * Dropping a plain CONNECTION ticket (a ticket on a regular project whose session runs in a
 * connection) on Done/Merged: it has no worktree of its own, so the drop queues the per-member
 * merge-on-done flow with the archive/keep step for every member — the same treatment a
 * connection-project ticket gets, "Archive all" for the clean tail of the queue included.
 */
import type { PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { TooltipProvider } from '@/components/ui/tooltip'
import { toast } from '@/lib/toast'
import { setKanbanDragData, useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
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
const connectionMerge = vi.hoisted(() => ({
  buildConnectionMergeQueue: vi.fn(),
  resolveTicketConnectionId: vi.fn(),
  queueConnectionRunMerge: vi.fn()
}))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: flowApi }))
vi.mock('@/api/db-api', () => ({ dbApi: dbApiMocks }))
vi.mock('@/api/git-api', () => ({ gitApi: gitApiMocks }))
vi.mock('@/lib/connection-merge', () => connectionMerge)
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

const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialSettingsState = useSettingsStore.getState()

const now = '2026-06-01T00:00:00.000Z'

/** A connection ticket on a plain project: a session but no worktree of its own. */
function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-web',
    title: 'Checkout redesign',
    description: null,
    attachments: [],
    column: 'review',
    sort_order: 0,
    current_session_id: 'session-conn',
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: now,
    updated_at: now,
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

const WEB = { worktreeId: 'wt-web', projectId: 'proj-web' }
const API = { worktreeId: 'wt-api', projectId: 'proj-api', alreadyMerged: true }

const moveTicket = vi.fn()
const setPendingDoneMove = vi.fn()

/** Drop `ticket` (as it sits in its own column) on `column` of its own project board. */
async function drop(ticket: KanbanTicket, column: KanbanTicketColumn): Promise<void> {
  useKanbanStore.setState({ tickets: new Map([[ticket.project_id, [ticket]]]) })
  render(
    <TooltipProvider>
      <KanbanColumn column={column} projectId={ticket.project_id} tickets={[]} />
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
  connectionMerge.resolveTicketConnectionId.mockResolvedValue('conn-1')
  connectionMerge.buildConnectionMergeQueue.mockResolvedValue([WEB, API])
  // A plain project, not a connection project: the ticket still gets the archive step
  useProjectStore.setState({
    projects: [
      { id: 'proj-web', name: 'web', path: '/repo/web', kind: 'git' } as never,
      { id: 'proj-api', name: 'api', path: '/repo/api', kind: 'git' } as never
    ]
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
  useProjectStore.setState(initialProjectState, true)
  useSettingsStore.setState(initialSettingsState, true)
  useKanbanStore.setState(initialKanbanState, true)
})

describe('dropping a connection ticket of a plain project on Done', () => {
  it('queues every member with the archive/keep step, already-merged members included (Review → Done)', async () => {
    await drop(makeTicket({ column: 'review' }), 'done')

    await waitFor(() =>
      expect(setPendingDoneMove).toHaveBeenCalledWith({
        ticketId: 'ticket-1',
        projectId: 'proj-web',
        sortOrder: 0,
        targetColumn: 'done',
        worktreeId: WEB.worktreeId,
        worktreeProjectId: WEB.projectId,
        remainingWorktrees: [API],
        offerArchive: true
      })
    )
    expect(connectionMerge.resolveTicketConnectionId).toHaveBeenCalledWith('session-conn')
    // Clean members are queued too, so the dialog can offer "Archive all" for them
    expect(connectionMerge.buildConnectionMergeQueue).toHaveBeenCalledWith('conn-1', {
      includeAlreadyMerged: true
    })
    expect(moveTicket).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
    // No worktree of its own: the single-worktree path never ran
    expect(dbApiMocks.worktree.get).not.toHaveBeenCalled()
  })

  it('queues the archive/keep step for already-merged members on Merged → Done too', async () => {
    // A Merged → Done drop only counts when the Merged column is a real column
    useSettingsStore.setState({ showMergedColumn: true })

    await drop(makeTicket({ column: 'merged' }), 'done')

    await waitFor(() =>
      expect(setPendingDoneMove).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: WEB.worktreeId, offerArchive: true })
      )
    )
    expect(connectionMerge.buildConnectionMergeQueue).toHaveBeenCalledWith('conn-1', {
      includeAlreadyMerged: true
    })
  })

  it('offers the archive step but leaves clean members alone on In Progress → Done', async () => {
    connectionMerge.buildConnectionMergeQueue.mockResolvedValue([WEB])

    await drop(makeTicket({ column: 'in_progress' }), 'done')

    await waitFor(() =>
      expect(setPendingDoneMove).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: WEB.worktreeId,
          remainingWorktrees: [],
          offerArchive: true
        })
      )
    )
    expect(connectionMerge.buildConnectionMergeQueue).toHaveBeenCalledWith('conn-1', {
      includeAlreadyMerged: false
    })
  })

  it('moves the ticket when no member has anything left to merge', async () => {
    connectionMerge.buildConnectionMergeQueue.mockResolvedValue([])

    await drop(makeTicket({ column: 'in_progress' }), 'done')

    await waitFor(() => expect(moveTicket).toHaveBeenCalledWith('ticket-1', 'proj-web', 'done', 0))
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })

  it('says so, and leaves the ticket, when a member cannot be checked', async () => {
    connectionMerge.buildConnectionMergeQueue.mockRejectedValue(
      new Error('feature/web: could not verify merge status')
    )

    await drop(makeTicket({ column: 'review' }), 'done')

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Could not verify merge status: feature/web: could not verify merge status'
      )
    )
    expect(moveTicket).not.toHaveBeenCalled()
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })
})

describe('dropping a connection ticket of a plain project on Merged', () => {
  it('queues the members with work, with the archive step, without the archive-only pass', async () => {
    connectionMerge.buildConnectionMergeQueue.mockResolvedValue([WEB])

    await drop(makeTicket({ column: 'review' }), 'merged')

    await waitFor(() =>
      expect(setPendingDoneMove).toHaveBeenCalledWith(
        expect.objectContaining({ targetColumn: 'merged', offerArchive: true })
      )
    )
    expect(connectionMerge.buildConnectionMergeQueue).toHaveBeenCalledWith('conn-1', {
      includeAlreadyMerged: false
    })
  })
})
