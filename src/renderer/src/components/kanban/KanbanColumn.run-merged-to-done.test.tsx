/**
 * Reproduction: shift-dragging the ticket of a document run that ALREADY landed on base (its
 * ticket sits in Merged, its items are merged, the integration worktree and the ticket
 * worktrees are still active) onto Done. Expected: the merge-on-done dialog opens on the
 * archive step with "Archive all (3)", and Archive all moves every ticket of the run to Done.
 *
 * Real KanbanColumn, real run-done-queue, real useKanbanStore (`moveTicket` is a spy in most
 * tests, the real action with the backend RPC mocked in the last one), real session signal;
 * only the IPC apis (db, git, document flow, kanban) and the toasts are mocked.
 */
import type { PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { MergeOnDoneDialog } from '@/components/kanban/MergeOnDoneDialog'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { TooltipProvider } from '@/components/ui/tooltip'
import { toast } from '@/lib/toast'
import { toast as sonnerToast } from 'sonner'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { setKanbanDragData, useKanbanStore } from '@/stores/useKanbanStore'
import type { DocumentRunDetail } from '@shared/types/document-flow'
import type { KanbanTicket } from '../../../../main/db/types'

const flowApi = vi.hoisted(() => ({
  get: vi.fn(),
  prepareMerge: vi.fn(),
  merge: vi.fn(),
  updateItem: vi.fn()
}))
const dbApiMocks = vi.hoisted(() => ({
  worktree: { get: vi.fn(), getActiveByProject: vi.fn() },
  project: { get: vi.fn() }
}))
const gitApiMocks = vi.hoisted(() => ({
  hasUncommittedChanges: vi.fn(),
  branchDiffShortStat: vi.fn(),
  getFileStatuses: vi.fn(),
  getDiffStat: vi.fn(),
  getBranchDiffFiles: vi.fn(),
  getBranchFileDiff: vi.fn(),
  getDiff: vi.fn(),
  onStatusChanged: vi.fn((_cb: (event: { worktreePath: string }) => void) => () => {}),
  stageAll: vi.fn(),
  commit: vi.fn(),
  merge: vi.fn(),
  pull: vi.fn(),
  getRemoteUrl: vi.fn(),
  isBranchMerged: vi.fn()
}))
const kanbanApiMocks = vi.hoisted(() => ({
  ticket: { move: vi.fn(), getBySession: vi.fn(async () => []) }
}))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: flowApi }))
vi.mock('@/api/db-api', () => ({ dbApi: dbApiMocks }))
vi.mock('@/api/git-api', () => ({ gitApi: gitApiMocks }))
vi.mock('@/api/kanban-api', () => ({ kanbanApi: kanbanApiMocks }))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(() => 1), dismiss: vi.fn() }
}))
// MergeOnDoneDialog toasts through sonner directly
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(() => 1), dismiss: vi.fn() }
}))

vi.mock('@/components/kanban/KanbanTicketCard', () => ({
  KanbanTicketCard: ({ ticket }: { ticket: KanbanTicket }) => (
    <div data-testid="kanban-ticket-card" data-ticket-id={ticket.id}>
      {ticket.title}
    </div>
  )
}))
vi.mock('@/components/kanban/WorktreePickerModal', () => ({
  WorktreePickerModal: () => null
}))
vi.mock('@/components/kanban/TicketCreateModal', () => ({ TicketCreateModal: () => null }))
vi.mock('@/components/diff/DiffViewer', () => ({
  DiffViewer: ({ diff }: { diff: string }) => <pre data-testid="diff-viewer">{diff}</pre>
}))
vi.mock('@/components/diff/ImageDiffView', () => ({
  ImageDiffView: () => <div data-testid="image-diff-view" />
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
const initialSettingsState = useSettingsStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

const now = '2026-06-01T00:00:00.000Z'
const PROJECT = 'proj-1'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-run',
    project_id: PROJECT,
    title: 'Checkout redesign',
    description: null,
    attachments: [],
    column: 'merged',
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

type Wt = {
  id: string
  project_id: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  is_default: boolean
  base_branch: string | null
}

const worktrees: Record<string, Wt> = {
  'wt-main': {
    id: 'wt-main',
    project_id: PROJECT,
    branch_name: 'main',
    path: '/repo',
    status: 'active',
    is_default: true,
    base_branch: null
  },
  'wt-integration': {
    id: 'wt-integration',
    project_id: PROJECT,
    branch_name: 'doc-checkout',
    path: '/worktrees/doc-checkout',
    status: 'active',
    is_default: false,
    base_branch: 'main'
  },
  'wt-a': {
    id: 'wt-a',
    project_id: PROJECT,
    branch_name: 'a1-alpha',
    path: '/worktrees/a1-alpha',
    status: 'active',
    is_default: false,
    base_branch: 'doc-checkout'
  },
  'wt-b': {
    id: 'wt-b',
    project_id: PROJECT,
    branch_name: 'a2-beta',
    path: '/worktrees/a2-beta',
    status: 'active',
    is_default: false,
    base_branch: 'doc-checkout'
  }
}

const runTicket = makeTicket()
const alphaTicket = makeTicket({
  id: 't-a',
  title: 'Alpha',
  column: 'merged',
  worktree_id: 'wt-a',
  external_provider: null,
  external_id: null,
  parent_ticket_id: 'ticket-run'
})
const betaTicket = makeTicket({
  id: 't-b',
  title: 'Beta',
  column: 'merged',
  worktree_id: 'wt-b',
  external_provider: null,
  external_id: null,
  parent_ticket_id: 'ticket-run'
})

/** A finished run that merged both tickets into the integration branch. */
function seedRun(): DocumentRunDetail {
  const detail = makeDetail(
    {
      id: 'run-1',
      project_id: PROJECT,
      title: 'Checkout redesign',
      status: 'completed',
      base_branch: 'main',
      base_sha: 'base-sha',
      integration_branch: 'doc-checkout',
      integration_worktree_id: 'wt-integration',
      integration_worktree_path: '/worktrees/doc-checkout',
      ticket_id: 'ticket-run',
      started_at: now,
      finished_at: now
    },
    [
      {
        key: 'A1',
        title: 'Alpha',
        status: 'merged',
        ticket_id: 't-a',
        worktree_id: 'wt-a',
        branch_name: 'a1-alpha',
        session_id: 's-a',
        pre_merge_sha: 'pre-a',
        merge_sha: 'sha-a',
        finished_at: now
      },
      {
        key: 'A2',
        title: 'Beta',
        status: 'merged',
        ticket_id: 't-b',
        worktree_id: 'wt-b',
        branch_name: 'a2-beta',
        session_id: 's-b',
        pre_merge_sha: 'pre-b',
        merge_sha: 'sha-b',
        finished_at: now
      }
    ]
  )
  useDocumentFlowStore.setState({ runsById: { 'run-1': detail } })
  return detail
}

const moveTicket = vi.fn()
const archiveWorktree = vi.fn()
let setPendingDoneMove: ReturnType<typeof vi.fn>

function mountBoard(): void {
  render(
    <TooltipProvider>
      <KanbanColumn column="done" projectId={PROJECT} tickets={[]} />
      <MergeOnDoneDialog />
    </TooltipProvider>
  )
}

async function shiftDropRunTicketOnDone(): Promise<void> {
  setKanbanDragData({
    projectId: PROJECT,
    ticketId: runTicket.id,
    sourceColumn: runTicket.column,
    sourceIndex: 0,
    modifiers: { shift: true }
  })
  await act(async () => {
    fireEvent.drop(screen.getByTestId('kanban-drop-area-done'))
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
  seedRun()
  flowApi.get.mockImplementation(
    async (runId: string) => useDocumentFlowStore.getState().runsById[runId] ?? null
  )
  flowApi.updateItem.mockResolvedValue(undefined)
  dbApiMocks.worktree.get.mockImplementation(async (id: string) => worktrees[id] ?? null)
  dbApiMocks.worktree.getActiveByProject.mockResolvedValue(
    Object.values(worktrees).filter((w) => w.status === 'active')
  )
  dbApiMocks.project.get.mockResolvedValue({ path: '/repo', name: 'Shop' })
  // The run merged into base already: nothing is dirty, nothing is ahead of anything
  gitApiMocks.hasUncommittedChanges.mockResolvedValue(false)
  gitApiMocks.branchDiffShortStat.mockResolvedValue({
    success: true,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    commitsAhead: 0
  })
  gitApiMocks.getFileStatuses.mockResolvedValue({ success: true, files: [] })
  gitApiMocks.getBranchDiffFiles.mockResolvedValue({ success: true, files: [] })
  gitApiMocks.getBranchFileDiff.mockResolvedValue({ success: true, diff: '' })
  gitApiMocks.getDiffStat.mockResolvedValue({ success: true, files: [] })
  gitApiMocks.getDiff.mockResolvedValue({ success: true, diff: '' })
  gitApiMocks.getRemoteUrl.mockResolvedValue({ url: null })
  gitApiMocks.isBranchMerged.mockResolvedValue({ success: true, isMerged: true })

  moveTicket.mockReset().mockResolvedValue(undefined)
  archiveWorktree.mockReset().mockResolvedValue({ success: true })
  setPendingDoneMove = vi.fn(initialKanbanState.setPendingDoneMove)

  // The user sees the Merged column (otherwise Merged → Done is a folded-card no-op)
  useSettingsStore.setState({ showMergedColumn: true })
  useWorktreeStore.setState({ archiveWorktree, loadWorktrees: vi.fn() })
  useKanbanStore.setState({
    tickets: new Map([[PROJECT, [runTicket, alphaTicket, betaTicket]]]),
    markdownDiagnostics: new Map(),
    markdownPlaceholders: new Map(),
    dependencyMap: new Map(),
    draggingTicketKey: null,
    simpleModeByProject: {},
    pendingDoneMove: null,
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
  useSettingsStore.setState(initialSettingsState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
  useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
})

describe('shift-dropping the ticket of a run that already landed on base from Merged onto Done', () => {
  it('queues the batch: the integration entry first, then both archive entries', async () => {
    mountBoard()

    await shiftDropRunTicketOnDone()

    await waitFor(() => expect(setPendingDoneMove).toHaveBeenCalledTimes(1))
    const pending = setPendingDoneMove.mock.calls[0][0]
    expect(pending).toMatchObject({
      ticketId: 'ticket-run',
      projectId: PROJECT,
      targetColumn: 'done',
      worktreeId: 'wt-integration',
      offerArchive: true,
      entry: { kind: 'run-integration', worktreeId: 'wt-integration' },
      run: { runId: 'run-1', kept: [], alsoMoveTicketIds: [] }
    })
    expect(pending.remainingWorktrees).toEqual([
      expect.objectContaining({ kind: 'run-child-archive', worktreeId: 'wt-a', ticketId: 't-a', alreadyMerged: true }),
      expect.objectContaining({ kind: 'run-child-archive', worktreeId: 'wt-b', ticketId: 't-b', alreadyMerged: true })
    ])
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    // The drop handler itself moved nothing: the dialog owns the move
    expect(moveTicket).not.toHaveBeenCalled()
  })

  it('opens the dialog on the archive step with "Archive all (3)"', async () => {
    mountBoard()

    await shiftDropRunTicketOnDone()

    await waitFor(() => expect(useKanbanStore.getState().pendingDoneMove).not.toBeNull())
    expect(await screen.findByTestId('merge-on-done-dialog')).toBeTruthy()
    const archiveAll = await screen.findByRole('button', { name: 'Archive all (3)' })
    expect(archiveAll).toBeTruthy()
    expect(screen.getByText(/Branch already merged/)).toBeTruthy()
    expect(screen.getByTestId('archive-all-hint').textContent).toContain(
      'other 2 branches of this document run'
    )
    expect(screen.queryByTestId('archive-kept-branches')).toBeNull()
    expect(sonnerToast.warning).not.toHaveBeenCalled()
    expect(sonnerToast.error).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('Archive all moves both child tickets and then the run’s ticket to Done, and archives all three worktrees', async () => {
    mountBoard()

    await shiftDropRunTicketOnDone()

    fireEvent.click(await screen.findByRole('button', { name: 'Archive all (3)' }))

    await waitFor(() =>
      expect(moveTicket).toHaveBeenCalledWith('ticket-run', PROJECT, 'done', expect.any(Number))
    )
    const moved = moveTicket.mock.calls.map((call) => call[0])
    expect(moved).toEqual(['t-a', 't-b', 'ticket-run'])
    expect(moveTicket).toHaveBeenCalledWith('t-a', PROJECT, 'done', expect.any(Number), {
      skipCompletionEffects: true
    })
    await waitFor(() => expect(archiveWorktree).toHaveBeenCalledTimes(3))
    expect(archiveWorktree).toHaveBeenCalledWith(
      'wt-integration',
      '/worktrees/doc-checkout',
      'doc-checkout',
      '/repo'
    )
    expect(archiveWorktree).toHaveBeenCalledWith('wt-a', '/worktrees/a1-alpha', 'a1-alpha', '/repo')
    expect(archiveWorktree).toHaveBeenCalledWith('wt-b', '/worktrees/a2-beta', 'a2-beta', '/repo')
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    expect(sonnerToast.warning).not.toHaveBeenCalled()
    expect(sonnerToast.error).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('Archive (single) moves the run’s ticket as well', async () => {
    mountBoard()

    await shiftDropRunTicketOnDone()

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))

    // The integration entry completes; the two archive entries take their own turns
    await waitFor(() => expect(archiveWorktree).toHaveBeenCalledWith(
      'wt-integration',
      '/worktrees/doc-checkout',
      'doc-checkout',
      '/repo'
    ))
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(archiveWorktree).toHaveBeenCalledTimes(2))
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))
    await waitFor(() =>
      expect(moveTicket).toHaveBeenCalledWith('ticket-run', PROJECT, 'done', expect.any(Number))
    )
    expect(moveTicket.mock.calls.map((call) => call[0])).toEqual(['t-a', 't-b', 'ticket-run'])
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
  })
})

// ── Realistic variants of the same board ──────────────────────────────────────────────────
// Each one asks the same question: does "shift-drop → (dialog) → Archive all / Archive →
// run ticket in Done" still hold?

async function clickArchiveAllOrArchive(): Promise<void> {
  const archiveAll = screen.queryByRole('button', { name: /^Archive all/ })
  fireEvent.click(archiveAll ?? (await screen.findByRole('button', { name: 'Archive' })))
}

describe('variants of a run that already landed on base', () => {
  it('child worktrees re-pointed at the base branch (reconcileRunTickets did its repoint)', async () => {
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      const wt = worktrees[id]
      if (!wt) return null
      return id === 'wt-a' || id === 'wt-b' ? { ...wt, base_branch: 'main' } : wt
    })
    mountBoard()

    await shiftDropRunTicketOnDone()

    fireEvent.click(await screen.findByRole('button', { name: 'Archive all (3)' }))
    await waitFor(() =>
      expect(moveTicket).toHaveBeenCalledWith('ticket-run', PROJECT, 'done', expect.any(Number))
    )
    expect(moveTicket.mock.calls.map((c) => c[0])).toEqual(['t-a', 't-b', 'ticket-run'])
  })

  it('integration worktree archived by the earlier plain drop; children re-pointed at main', async () => {
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      const wt = worktrees[id]
      if (!wt) return null
      if (id === 'wt-integration') return { ...wt, status: 'archived' }
      return id === 'wt-a' || id === 'wt-b' ? { ...wt, base_branch: 'main' } : wt
    })
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([worktrees['wt-main'], { ...worktrees['wt-a'], base_branch: 'main' }, { ...worktrees['wt-b'], base_branch: 'main' }])
    mountBoard()

    await shiftDropRunTicketOnDone()

    await waitFor(() => expect(setPendingDoneMove).toHaveBeenCalledTimes(1))
    expect(setPendingDoneMove.mock.calls[0][0]).toMatchObject({
      worktreeId: 'wt-a',
      entry: { kind: 'run-child-archive', worktreeId: 'wt-a' },
      remainingWorktrees: [expect.objectContaining({ kind: 'run-child-archive', worktreeId: 'wt-b' })]
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Archive all (2)' }))
    await waitFor(() =>
      expect(moveTicket).toHaveBeenCalledWith('ticket-run', PROJECT, 'done', expect.any(Number))
    )
    expect(moveTicket.mock.calls.map((c) => c[0])).toEqual(['t-a', 't-b', 'ticket-run'])
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('integration worktree archived (branch deleted) while the children still name it as base', async () => {
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      const wt = worktrees[id]
      if (!wt) return null
      return id === 'wt-integration' ? { ...wt, status: 'archived' } : wt
    })
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([worktrees['wt-main'], worktrees['wt-a'], worktrees['wt-b']])
    // `git diff doc-checkout...HEAD` with doc-checkout gone
    gitApiMocks.branchDiffShortStat.mockImplementation(async (_path: string, base: string) =>
      base === 'doc-checkout'
        ? { success: false, error: `unknown revision or path not in the working tree: ${base}` }
        : { success: true, filesChanged: 0, insertions: 0, deletions: 0, commitsAhead: 0 }
    )
    mountBoard()

    await shiftDropRunTicketOnDone()

    await act(async () => {})
    // The run merged both branches, so an unverifiable one is kept (named), not a reason to
    // refuse the drop: nothing is left to archive, every ticket of the run moves to Done
    expect(setPendingDoneMove).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/^Kept: A1 · Alpha \(could not be verified: .*doc-checkout — not archived\), A2 · Beta/))
    await waitFor(() => expect(moveTicket.mock.calls.map((c) => c[0])).toEqual(['t-a', 't-b', 'ticket-run']))
  })

  it('child sessions still read as working (stale status entries)', async () => {
    useWorktreeStatusStore.setState({
      sessionStatuses: {
        's-a': { status: 'working', timestamp: Date.now() },
        's-b': { status: 'working', timestamp: Date.now() }
      } as never
    })
    mountBoard()

    await shiftDropRunTicketOnDone()

    await waitFor(() => expect(setPendingDoneMove).toHaveBeenCalledTimes(1))
    expect(setPendingDoneMove.mock.calls[0][0]).toMatchObject({
      entry: { kind: 'run-integration' },
      remainingWorktrees: [],
      run: { kept: [expect.objectContaining({ label: 'A1 · Alpha' }), expect.objectContaining({ label: 'A2 · Beta' })] }
    })
    expect(await screen.findByRole('button', { name: 'Archive' })).toBeTruthy()
    expect(screen.getByTestId('archive-kept-branches').textContent).toContain('still working')
    await clickArchiveAllOrArchive()
    await waitFor(() =>
      expect(moveTicket).toHaveBeenCalledWith('ticket-run', PROJECT, 'done', expect.any(Number))
    )
    // Children stay where they are (their sessions are "working")
    expect(moveTicket.mock.calls.map((c) => c[0])).toEqual(['ticket-run'])
  })

  it('a child worktree has untracked leftovers (dirty): the run merged it, so it is kept, never re-merged', async () => {
    gitApiMocks.hasUncommittedChanges.mockImplementation(async (path: string) => path === '/worktrees/a1-alpha')
    mountBoard()

    await shiftDropRunTicketOnDone()

    await waitFor(() => expect(setPendingDoneMove).toHaveBeenCalledTimes(1))
    expect(setPendingDoneMove.mock.calls[0][0]).toMatchObject({
      entry: { kind: 'run-integration' },
      remainingWorktrees: [expect.objectContaining({ kind: 'run-child-archive', worktreeId: 'wt-b' })],
      run: {
        kept: [
          {
            label: 'A1 · Alpha',
            reason: 'has uncommitted changes since the run merged it — not archived'
          }
        ],
        alsoMoveTicketIds: ['t-a']
      }
    })
    // Straight to the archive step, with the kept branch named
    expect(await screen.findByRole('button', { name: /Archive all \(2\)/ })).toBeTruthy()
    expect(screen.getByTestId('archive-kept-branches').textContent).toContain('A1 · Alpha')
    expect(screen.queryByText('Uncommitted changes')).toBeNull()
  })

  it('the default worktree has another branch checked out (no worktree on main)', async () => {
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([
      { ...worktrees['wt-main'], branch_name: 'some-other-branch' },
      worktrees['wt-integration'],
      worktrees['wt-a'],
      worktrees['wt-b']
    ])
    mountBoard()

    await shiftDropRunTicketOnDone()

    await waitFor(() => expect(setPendingDoneMove).toHaveBeenCalledTimes(1))
    // Integration entry: no base worktree → skipped with a toast → archive entries (base
    // doc-checkout = the integration worktree) → Archive all (2)
    await waitFor(() => expect(sonnerToast.warning).toHaveBeenCalledWith('Skipping merge — no worktree for main'))
    fireEvent.click(await screen.findByRole('button', { name: 'Archive all (2)' }))
    await waitFor(() =>
      expect(moveTicket).toHaveBeenCalledWith('ticket-run', PROJECT, 'done', expect.any(Number))
    )
    expect(moveTicket.mock.calls.map((c) => c[0])).toEqual(['t-a', 't-b', 'ticket-run'])
  })

  it('everything archived already (integration and children): plain move', async () => {
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      const wt = worktrees[id]
      if (!wt) return null
      return id === 'wt-main' ? wt : { ...wt, status: 'archived' }
    })
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([worktrees['wt-main']])
    mountBoard()

    await shiftDropRunTicketOnDone()

    await waitFor(() =>
      expect(moveTicket).toHaveBeenCalledWith('ticket-run', PROJECT, 'done', expect.any(Number))
    )
    expect(setPendingDoneMove).not.toHaveBeenCalled()
    // children moved along (worktree-less now, their work landed)
    expect(moveTicket.mock.calls.map((c) => c[0])).toEqual(['t-a', 't-b', 'ticket-run'])
  })

  it('the child tickets were archived from the board already', async () => {
    useKanbanStore.setState({
      tickets: new Map([
        [PROJECT, [runTicket, { ...alphaTicket, archived_at: now }, { ...betaTicket, archived_at: now }]]
      ])
    })
    mountBoard()

    await shiftDropRunTicketOnDone()

    fireEvent.click(await screen.findByRole('button', { name: 'Archive all (3)' }))
    await waitFor(() =>
      expect(moveTicket).toHaveBeenCalledWith('ticket-run', PROJECT, 'done', expect.any(Number))
    )
    expect(moveTicket.mock.calls.map((c) => c[0])).toEqual(['ticket-run'])
  })
})

// ── Same board, the store's REAL moveTicket (backend RPC mocked) ──────────────────────────────
describe('with the store’s real moveTicket', () => {
  it('Archive all lands every ticket of the run in Done through the backend move RPC', async () => {
    const realMoveTicket = vi.fn(initialKanbanState.moveTicket)
    useKanbanStore.setState({ moveTicket: realMoveTicket })
    kanbanApiMocks.ticket.move.mockImplementation(async (projectId: string, id: string, column: string) => {
      const ticket = useKanbanStore.getState().tickets.get(projectId)?.find((t) => t.id === id)
      return ticket ? { ...ticket, column } : null
    })
    mountBoard()

    await shiftDropRunTicketOnDone()

    fireEvent.click(await screen.findByRole('button', { name: 'Archive all (3)' }))

    await waitFor(() =>
      expect(kanbanApiMocks.ticket.move).toHaveBeenCalledWith(PROJECT, 'ticket-run', 'done', expect.any(Number))
    )
    expect(kanbanApiMocks.ticket.move.mock.calls.map((c) => c[1])).toEqual(['t-a', 't-b', 'ticket-run'])
    const columns = Object.fromEntries(
      (useKanbanStore.getState().tickets.get(PROJECT) ?? []).map((t) => [t.id, t.column])
    )
    expect(columns).toEqual({ 'ticket-run': 'done', 't-a': 'done', 't-b': 'done' })
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
  })
})
