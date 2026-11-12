/**
 * Shift-dragging a ticket from Merged to Done is the override: the drop skips the pull and the
 * commit/merge checks and goes straight to the archive/keep step for the ticket's worktrees.
 * Only that gesture: a plain drag, another source column, and the ticket of a document run
 * (where shift finishes the whole run) keep their own paths.
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
const archiveOverride = vi.hoisted(() => ({ queueArchiveOverride: vi.fn() }))
const basePull = vi.hoisted(() => ({ pullBaseBranches: vi.fn() }))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: flowApi }))
vi.mock('@/api/db-api', () => ({ dbApi: dbApiMocks }))
vi.mock('@/api/git-api', () => ({ gitApi: gitApiMocks }))
vi.mock('@/lib/connection-merge', () => connectionMerge)
vi.mock('@/lib/document-flow/run-done-queue', () => runDoneQueue)
vi.mock('@/lib/archive-override', () => archiveOverride)
vi.mock('@/lib/base-branch-pull', () => basePull)

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

/** A ticket sitting in Merged with a feature worktree of its own. */
function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-web',
    title: 'Checkout redesign',
    description: null,
    attachments: [],
    column: 'merged',
    sort_order: 0,
    current_session_id: 'session-1',
    worktree_id: 'wt-feature',
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

const featureWorktree = {
  id: 'wt-feature',
  project_id: 'proj-web',
  branch_name: 'feature',
  path: '/repo/feature',
  status: 'active',
  is_default: false,
  base_branch: null
}
const mainWorktree = {
  id: 'wt-main',
  project_id: 'proj-web',
  branch_name: 'main',
  path: '/repo/main',
  status: 'active',
  is_default: true,
  base_branch: null
}

const moveTicket = vi.fn()
const setPendingDoneMove = vi.fn()

// jsdom has no DragEvent: testing-library then fires a plain Event, which carries no
// modifier keys. A MouseEvent stand-in does.
class FakeDragEvent extends window.MouseEvent {
  dataTransfer = { dropEffect: '' }
  constructor(type: string, init?: MouseEventInit) {
    super(type, { bubbles: true, cancelable: true, ...init })
  }
}

/**
 * Drop `ticket` (as it sits in its own column) on `column` of its own project board, with
 * shift held when the drag started and/or at the drop.
 */
async function drop(
  ticket: KanbanTicket,
  column: KanbanTicketColumn,
  shift: { atStart?: boolean; atDrop?: boolean } = {}
): Promise<void> {
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
    sourceIndex: 0,
    modifiers: { shift: Boolean(shift.atStart) }
  })
  await act(async () => {
    fireEvent.drop(screen.getByTestId(`kanban-drop-area-${column}`), {
      shiftKey: Boolean(shift.atDrop)
    })
  })
}

/** The checks a plain Done drop runs, and the override must not. */
function expectNoMergeChecks(): void {
  expect(basePull.pullBaseBranches).not.toHaveBeenCalled()
  expect(gitApiMocks.hasUncommittedChanges).not.toHaveBeenCalled()
  expect(gitApiMocks.branchDiffShortStat).not.toHaveBeenCalled()
  expect(dbApiMocks.worktree.get).not.toHaveBeenCalled()
  expect(connectionMerge.buildConnectionMergeQueue).not.toHaveBeenCalled()
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
  vi.stubGlobal('DragEvent', FakeDragEvent)
  archiveOverride.queueArchiveOverride.mockResolvedValue(true)
  // The branch still has work: a plain drop would open the commit step for it
  dbApiMocks.worktree.get.mockResolvedValue(featureWorktree)
  dbApiMocks.worktree.getActiveByProject.mockResolvedValue([featureWorktree, mainWorktree])
  gitApiMocks.hasUncommittedChanges.mockResolvedValue(true)
  gitApiMocks.branchDiffShortStat.mockResolvedValue({
    success: true,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    commitsAhead: 2
  })
  basePull.pullBaseBranches.mockResolvedValue(undefined)
  useProjectStore.setState({
    projects: [{ id: 'proj-web', name: 'web', path: '/repo/web', kind: 'git' } as never]
  })
  // A Merged → Done drop only counts when the Merged column is a real column
  useSettingsStore.setState({ showMergedColumn: true })
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

describe('shift-dragging a ticket from Merged to Done', () => {
  it('skips the merge checks and queues the archive step', async () => {
    const ticket = makeTicket()

    await drop(ticket, 'done', { atStart: true })

    await waitFor(() =>
      expect(archiveOverride.queueArchiveOverride).toHaveBeenCalledWith({ ticket, sortOrder: 0 })
    )
    expectNoMergeChecks()
    // The dialog owns the move from here
    expect(moveTicket).not.toHaveBeenCalled()
    expect(setPendingDoneMove).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('counts shift held at the drop too', async () => {
    await drop(makeTicket(), 'done', { atDrop: true })

    await waitFor(() => expect(archiveOverride.queueArchiveOverride).toHaveBeenCalledTimes(1))
    expectNoMergeChecks()
  })

  it('covers a connection ticket, which has no worktree of its own', async () => {
    const ticket = makeTicket({ worktree_id: null, current_session_id: 'session-conn' })

    await drop(ticket, 'done', { atStart: true })

    await waitFor(() =>
      expect(archiveOverride.queueArchiveOverride).toHaveBeenCalledWith({ ticket, sortOrder: 0 })
    )
    expectNoMergeChecks()
    expect(connectionMerge.resolveTicketConnectionId).not.toHaveBeenCalled()
  })

  it('moves the ticket, still unchecked, when it has nothing left to archive', async () => {
    archiveOverride.queueArchiveOverride.mockResolvedValue(false)

    await drop(makeTicket(), 'done', { atStart: true })

    await waitFor(() => expect(moveTicket).toHaveBeenCalledWith('ticket-1', 'proj-web', 'done', 0))
    expectNoMergeChecks()
  })

  it('says so, and leaves the ticket, when its worktrees cannot be looked up', async () => {
    archiveOverride.queueArchiveOverride.mockRejectedValue(new Error('db is locked'))

    await drop(makeTicket(), 'done', { atStart: true })

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Could not look up the ticket's worktrees: db is locked"
      )
    )
    expect(moveTicket).not.toHaveBeenCalled()
  })
})

describe('drops the override leaves alone', () => {
  it('a plain drag from Merged to Done still runs the merge checks', async () => {
    await drop(makeTicket(), 'done')

    await waitFor(() =>
      expect(setPendingDoneMove).toHaveBeenCalledWith({
        ticketId: 'ticket-1',
        projectId: 'proj-web',
        sortOrder: 0,
        targetColumn: 'done'
      })
    )
    expect(archiveOverride.queueArchiveOverride).not.toHaveBeenCalled()
    expect(basePull.pullBaseBranches).toHaveBeenCalled()
    expect(gitApiMocks.branchDiffShortStat).toHaveBeenCalledWith('/repo/feature', 'main')
  })

  it.each<[KanbanTicketColumn, KanbanTicketColumn]>([
    ['review', 'done'],
    ['in_progress', 'done'],
    ['review', 'merged']
  ])('a shift-drag from %s to %s still runs the merge checks', async (from, to) => {
    await drop(makeTicket({ column: from }), to, { atStart: true })

    await waitFor(() =>
      expect(setPendingDoneMove).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 'ticket-1', targetColumn: to })
      )
    )
    expect(archiveOverride.queueArchiveOverride).not.toHaveBeenCalled()
    expect(gitApiMocks.hasUncommittedChanges).toHaveBeenCalledWith('/repo/feature')
  })

  it('the ticket of a document run: shift finishes the whole run instead', async () => {
    flowApi.get.mockResolvedValue({
      run: {
        status: 'completed',
        migration_session_id: null,
        integration_connection_id: null,
        source_kind: 'document'
      }
    })
    runDoneQueue.queueDocumentRunDone.mockResolvedValue('queued')

    await drop(makeTicket({ external_provider: 'document-run', external_id: 'run-1' }), 'done', {
      atStart: true
    })

    await waitFor(() =>
      expect(runDoneQueue.queueDocumentRunDone).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1', ticketId: 'ticket-1', targetColumn: 'done' })
      )
    )
    expect(archiveOverride.queueArchiveOverride).not.toHaveBeenCalled()
  })

  it('a folded Merged card dropped on Done while the Merged column is hidden', async () => {
    useSettingsStore.setState({ showMergedColumn: false })

    await drop(makeTicket(), 'done', { atStart: true })

    expect(archiveOverride.queueArchiveOverride).not.toHaveBeenCalled()
    expect(moveTicket).not.toHaveBeenCalled()
    expect(setPendingDoneMove).not.toHaveBeenCalled()
  })
})
