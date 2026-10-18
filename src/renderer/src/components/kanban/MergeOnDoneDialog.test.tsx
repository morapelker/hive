import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MergeOnDoneDialog } from './MergeOnDoneDialog'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useGitStore } from '@/stores/useGitStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import type { KanbanTicket } from '../../../../main/db/types'

const dbApiMocks = vi.hoisted(() => ({
  worktree: {
    get: vi.fn(),
    getActiveByProject: vi.fn()
  },
  project: {
    get: vi.fn()
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: dbApiMocks
}))

const gitApiMocks = vi.hoisted(() => ({
  hasUncommittedChanges: vi.fn(),
  branchDiffShortStat: vi.fn(),
  getDiffStat: vi.fn(),
  getFileStatuses: vi.fn(),
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

vi.mock('@/api/git-api', () => ({
  gitApi: gitApiMocks
}))

// A document-run batch merges ticket branches through the run's own merge path
const flowApiMocks = vi.hoisted(() => ({
  prepareMerge: vi.fn(),
  merge: vi.fn(),
  updateItem: vi.fn()
}))

vi.mock('@/api/document-flow-api', () => ({
  documentFlowApi: flowApiMocks
}))

// diff2html and the image loaders are exercised elsewhere; here the diff view
// only needs to prove it received the patch
vi.mock('@/components/diff/DiffViewer', () => ({
  DiffViewer: ({ diff }: { diff: string }) => <pre data-testid="diff-viewer">{diff}</pre>
}))
vi.mock('@/components/diff/ImageDiffView', () => ({
  ImageDiffView: () => <div data-testid="image-diff-view" />
}))

const now = '2026-01-01T00:00:00.000Z'

const featureWorktree = {
  id: 'worktree-1',
  project_id: 'project-1',
  branch_name: 'feature',
  path: '/repo/feature',
  status: 'active' as const,
  is_default: false,
  base_branch: null
}

const baseWorktree = {
  id: 'worktree-main',
  project_id: 'project-1',
  branch_name: 'main',
  path: '/repo/main',
  status: 'active' as const,
  is_default: true,
  base_branch: null
}

const ticket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'My feature',
  description: null,
  attachments: [],
  column: 'review',
  sort_order: 1,
  current_session_id: null,
  worktree_id: 'worktree-1',
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
  parent_ticket_key: null
}

const moveTicketMock = vi.fn().mockResolvedValue(undefined)
const archiveWorktreeMock = vi.fn().mockResolvedValue({ success: true })

function setupStores(): void {
  useKanbanStore.setState({
    tickets: new Map([['project-1', [ticket]]]),
    pendingDoneMove: {
      ticketId: 'ticket-1',
      projectId: 'project-1',
      sortOrder: 5,
      targetColumn: 'done'
    },
    moveTicket: moveTicketMock
  })
  useWorktreeStore.setState({ archiveWorktree: archiveWorktreeMock })
}

function mockAlreadyMergedBranch(): void {
  dbApiMocks.worktree.get.mockResolvedValue(featureWorktree)
  dbApiMocks.worktree.getActiveByProject.mockResolvedValue([featureWorktree, baseWorktree])
  dbApiMocks.project.get.mockResolvedValue({ path: '/repo/main' })
  gitApiMocks.hasUncommittedChanges.mockResolvedValue(false)
  gitApiMocks.branchDiffShortStat.mockResolvedValue({
    success: true,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    commitsAhead: 0
  })
  gitApiMocks.getBranchDiffFiles.mockResolvedValue({ success: true, files: [] })
  gitApiMocks.getBranchFileDiff.mockResolvedValue({ success: true, diff: '' })
  gitApiMocks.getDiffStat.mockResolvedValue({ success: true, files: [] })
  gitApiMocks.getFileStatuses.mockResolvedValue({ success: true, files: [] })
  gitApiMocks.getDiff.mockResolvedValue({ success: true, diff: '' })
}

describe('MergeOnDoneDialog — already-merged branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    moveTicketMock.mockResolvedValue(undefined)
    archiveWorktreeMock.mockResolvedValue({ success: true })
    mockAlreadyMergedBranch()
    setupStores()
  })

  afterEach(() => {
    cleanup()
    useKanbanStore.setState({ pendingDoneMove: null })
  })

  it('shows the archive/keep step instead of silently moving to done', async () => {
    render(<MergeOnDoneDialog />)

    expect(await screen.findByText(/Branch already merged/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep' })).toBeTruthy()
    expect(moveTicketMock).not.toHaveBeenCalled()
  })

  it('Keep moves the ticket to done without archiving the worktree', async () => {
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Keep' }))

    await waitFor(() =>
      expect(moveTicketMock).toHaveBeenCalledWith('ticket-1', 'project-1', 'done', 5)
    )
    expect(archiveWorktreeMock).not.toHaveBeenCalled()
  })

  it('Archive moves the ticket to done and archives the worktree', async () => {
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))

    await waitFor(() =>
      expect(moveTicketMock).toHaveBeenCalledWith('ticket-1', 'project-1', 'done', 5)
    )
    await waitFor(() =>
      expect(archiveWorktreeMock).toHaveBeenCalledWith(
        'worktree-1',
        '/repo/feature',
        'feature',
        '/repo/main'
      )
    )
  })

  it('completes the move when the feature worktree was archived', async () => {
    dbApiMocks.worktree.get.mockResolvedValue({ ...featureWorktree, status: 'archived' })

    render(<MergeOnDoneDialog />)

    await waitFor(() =>
      expect(moveTicketMock).toHaveBeenCalledWith('ticket-1', 'project-1', 'done', 5)
    )
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
  })

  it('completes the move when the feature worktree row is gone', async () => {
    dbApiMocks.worktree.get.mockResolvedValue(null)

    render(<MergeOnDoneDialog />)

    await waitFor(() =>
      expect(moveTicketMock).toHaveBeenCalledWith('ticket-1', 'project-1', 'done', 5)
    )
  })

  it('still runs the merge flow when the branch has commits ahead', async () => {
    gitApiMocks.branchDiffShortStat.mockResolvedValue({
      success: true,
      filesChanged: 2,
      insertions: 10,
      deletions: 3,
      commitsAhead: 1
    })

    render(<MergeOnDoneDialog />)

    expect(await screen.findByText('Merge branch')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Merge' })).toBeTruthy()
    expect(moveTicketMock).not.toHaveBeenCalled()
  })
})

describe('MergeOnDoneDialog — ticket of a document run', () => {
  const aheadOfBase = (): void => {
    gitApiMocks.branchDiffShortStat.mockResolvedValue({
      success: true,
      filesChanged: 2,
      insertions: 10,
      deletions: 3,
      commitsAhead: 4
    })
  }
  /** The ticket's branch was cut from the integration branch after A1 and A2 landed on it. */
  const seedRun = (): void => {
    useDocumentFlowStore.setState({
      runsById: {
        'run-1': makeDetail({ id: 'run-1', status: 'completed', base_branch: 'main' }, [
          { key: 'A1', status: 'merged', merge_sha: 'm1', ticket_id: 'ticket-a1' },
          { key: 'A2', status: 'merged', merge_sha: 'm2', ticket_id: 'ticket-a2' },
          { key: 'A3', status: 'merged', merge_sha: 'm3', ticket_id: 'ticket-1' }
        ])
      }
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    moveTicketMock.mockResolvedValue(undefined)
    mockAlreadyMergedBranch()
    aheadOfBase()
    setupStores()
  })

  afterEach(() => {
    cleanup()
    useKanbanStore.setState({ pendingDoneMove: null })
    useDocumentFlowStore.setState({ runsById: {} })
  })

  it('warns that merging it brings earlier tickets of the run into the base branch', async () => {
    seedRun()
    // On the ticket's branch, not on main yet: the run's own ticket was not merged.
    gitApiMocks.isBranchMerged.mockImplementation(async (path: string) => ({
      success: true,
      isMerged: path === '/repo/feature'
    }))

    render(<MergeOnDoneDialog />)

    expect(await screen.findByTestId('merge-carried-run-tickets')).toHaveTextContent(
      'This branch was cut from its document run, so the merge also brings A1, A2 into main, ahead of the run’s own ticket.'
    )
    // Allowed all the same.
    expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled()
  })

  it('says nothing once the run was merged: only the follow-up is left to merge', async () => {
    seedRun()
    gitApiMocks.isBranchMerged.mockResolvedValue({ success: true, isMerged: true })

    render(<MergeOnDoneDialog />)

    expect(await screen.findByText('Merge branch')).toBeTruthy()
    expect(screen.queryByTestId('merge-carried-run-tickets')).toBeNull()
  })

  it('says nothing for a ticket of no run, without asking git', async () => {
    render(<MergeOnDoneDialog />)

    expect(await screen.findByText('Merge branch')).toBeTruthy()
    expect(screen.queryByTestId('merge-carried-run-tickets')).toBeNull()
    expect(gitApiMocks.isBranchMerged).not.toHaveBeenCalled()
  })
})

describe('MergeOnDoneDialog — connection member queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    moveTicketMock.mockResolvedValue(undefined)
    archiveWorktreeMock.mockResolvedValue({ success: true })
    mockAlreadyMergedBranch()
    setupStores()
    // Connection tickets have no worktree_id — the queue supplies it
    useKanbanStore.setState({
      tickets: new Map([['project-1', [{ ...ticket, worktree_id: null }]]]),
      pendingDoneMove: {
        ticketId: 'ticket-1',
        projectId: 'project-1',
        sortOrder: 5,
        targetColumn: 'merged',
        worktreeId: 'worktree-1',
        worktreeProjectId: 'project-1',
        remainingWorktrees: [{ worktreeId: 'worktree-next', projectId: 'project-2' }]
      }
    })
  })

  afterEach(() => {
    cleanup()
    useKanbanStore.setState({ pendingDoneMove: null })
  })

  it('advances the queue after a successful merge instead of offering archive', async () => {
    gitApiMocks.branchDiffShortStat.mockResolvedValue({
      success: true,
      filesChanged: 2,
      insertions: 10,
      deletions: 3,
      commitsAhead: 1
    })
    gitApiMocks.getRemoteUrl.mockResolvedValue({ url: null })
    gitApiMocks.merge.mockResolvedValue({ success: true })

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    await waitFor(() =>
      expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('worktree-next')
    )
    expect(gitApiMocks.merge).toHaveBeenCalledWith('/repo/main', 'feature')
    expect(moveTicketMock).not.toHaveBeenCalled()
    expect(archiveWorktreeMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
  })

  it('skips the archive prompt for an already-merged member and moves after the last one', async () => {
    useKanbanStore.setState({
      pendingDoneMove: {
        ticketId: 'ticket-1',
        projectId: 'project-1',
        sortOrder: 5,
        targetColumn: 'merged',
        worktreeId: 'worktree-1',
        worktreeProjectId: 'project-1',
        remainingWorktrees: []
      }
    })

    render(<MergeOnDoneDialog />)

    await waitFor(() =>
      expect(moveTicketMock).toHaveBeenCalledWith('ticket-1', 'project-1', 'merged', 5)
    )
    expect(archiveWorktreeMock).not.toHaveBeenCalled()
    expect(screen.queryByText(/Branch already merged/)).toBeNull()
  })
})

describe('MergeOnDoneDialog — connection-project member queue (offerArchive)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    moveTicketMock.mockResolvedValue(undefined)
    archiveWorktreeMock.mockResolvedValue({ success: true })
    mockAlreadyMergedBranch()
    setupStores()
    useKanbanStore.setState({
      tickets: new Map([['project-1', [{ ...ticket, worktree_id: null }]]]),
      pendingDoneMove: {
        ticketId: 'ticket-1',
        projectId: 'project-1',
        sortOrder: 5,
        targetColumn: 'done',
        worktreeId: 'worktree-1',
        worktreeProjectId: 'project-1',
        remainingWorktrees: [{ worktreeId: 'worktree-next', projectId: 'project-2' }],
        offerArchive: true
      }
    })
  })

  afterEach(() => {
    cleanup()
    useKanbanStore.setState({ pendingDoneMove: null })
  })

  it('offers the archive/keep step for an already-merged member', async () => {
    render(<MergeOnDoneDialog />)

    expect(await screen.findByText(/Branch already merged/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy()
    expect(moveTicketMock).not.toHaveBeenCalled()
  })

  it('offers the archive/keep step after a successful merge', async () => {
    gitApiMocks.branchDiffShortStat.mockResolvedValue({
      success: true,
      filesChanged: 2,
      insertions: 10,
      deletions: 3,
      commitsAhead: 1
    })
    gitApiMocks.getRemoteUrl.mockResolvedValue({ url: null })
    gitApiMocks.merge.mockResolvedValue({ success: true })

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    expect(await screen.findByText(/Merge successful/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy()
    // Queue must not advance until the archive/keep choice is made
    expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('worktree-1')
  })

  it('Archive archives the member worktree and advances the queue', async () => {
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))

    await waitFor(() =>
      expect(archiveWorktreeMock).toHaveBeenCalledWith(
        'worktree-1',
        '/repo/feature',
        'feature',
        '/repo/main'
      )
    )
    const next = useKanbanStore.getState().pendingDoneMove
    expect(next?.worktreeId).toBe('worktree-next')
    // offerArchive must survive queue advancement so later members get the prompt
    expect(next?.offerArchive).toBe(true)
    expect(moveTicketMock).not.toHaveBeenCalled()
  })

  it('Keep advances the queue without archiving, then moves after the last member', async () => {
    useKanbanStore.setState({
      pendingDoneMove: {
        ticketId: 'ticket-1',
        projectId: 'project-1',
        sortOrder: 5,
        targetColumn: 'done',
        worktreeId: 'worktree-1',
        worktreeProjectId: 'project-1',
        remainingWorktrees: [],
        offerArchive: true
      }
    })

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Keep' }))

    await waitFor(() =>
      expect(moveTicketMock).toHaveBeenCalledWith('ticket-1', 'project-1', 'done', 5)
    )
    expect(archiveWorktreeMock).not.toHaveBeenCalled()
  })

  it('does not offer Archive all while a remaining member still has work to merge', async () => {
    render(<MergeOnDoneDialog />)

    expect(await screen.findByRole('button', { name: 'Archive' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Archive all' })).toBeNull()
  })

  it('does not offer Archive all for the last member of the queue', async () => {
    useKanbanStore.setState({
      pendingDoneMove: {
        ticketId: 'ticket-1',
        projectId: 'project-1',
        sortOrder: 5,
        targetColumn: 'done',
        worktreeId: 'worktree-1',
        worktreeProjectId: 'project-1',
        remainingWorktrees: [],
        offerArchive: true
      }
    })

    render(<MergeOnDoneDialog />)

    expect(await screen.findByRole('button', { name: 'Archive' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Archive all' })).toBeNull()
  })
})

describe('MergeOnDoneDialog — Archive all (connection-project queue)', () => {
  const nextWorktree = {
    id: 'worktree-next',
    project_id: 'project-2',
    branch_name: 'feature-next',
    path: '/repo2/feature',
    status: 'active' as const,
    is_default: false,
    base_branch: null
  }
  const nextBase = {
    id: 'worktree-main-2',
    project_id: 'project-2',
    branch_name: 'main',
    path: '/repo2/main',
    status: 'active' as const,
    is_default: true,
    base_branch: null
  }
  const lastWorktree = {
    id: 'worktree-last',
    project_id: 'project-3',
    branch_name: 'feature-last',
    path: '/repo3/feature',
    status: 'active' as const,
    is_default: false,
    base_branch: null
  }
  const lastBase = {
    id: 'worktree-main-3',
    project_id: 'project-3',
    branch_name: 'main',
    path: '/repo3/main',
    status: 'active' as const,
    is_default: true,
    base_branch: null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    moveTicketMock.mockResolvedValue(undefined)
    archiveWorktreeMock.mockResolvedValue({ success: true })
    mockAlreadyMergedBranch()
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      if (id === 'worktree-1') return featureWorktree
      if (id === 'worktree-next') return nextWorktree
      if (id === 'worktree-last') return lastWorktree
      return null
    })
    dbApiMocks.worktree.getActiveByProject.mockImplementation(async (projectId: string) => {
      if (projectId === 'project-2') return [nextWorktree, nextBase]
      if (projectId === 'project-3') return [lastWorktree, lastBase]
      return [featureWorktree, baseWorktree]
    })
    dbApiMocks.project.get.mockImplementation(async (projectId: string) => ({
      path: `/${projectId}`
    }))
    setupStores()
    useKanbanStore.setState({
      tickets: new Map([['project-1', [{ ...ticket, worktree_id: null }]]]),
      pendingDoneMove: {
        ticketId: 'ticket-1',
        projectId: 'project-1',
        sortOrder: 5,
        targetColumn: 'done',
        worktreeId: 'worktree-1',
        worktreeProjectId: 'project-1',
        remainingWorktrees: [
          { worktreeId: 'worktree-next', projectId: 'project-2', alreadyMerged: true },
          { worktreeId: 'worktree-last', projectId: 'project-3', alreadyMerged: true }
        ],
        offerArchive: true
      }
    })
  })

  afterEach(() => {
    cleanup()
    useKanbanStore.setState({ pendingDoneMove: null })
  })

  it('offers Archive all when every remaining member is already merged', async () => {
    render(<MergeOnDoneDialog />)

    expect(await screen.findByRole('button', { name: 'Archive all' })).toBeTruthy()
    expect(screen.getByTestId('archive-all-hint').textContent).toContain('other 2 projects')
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep' })).toBeTruthy()
  })

  it('offers Archive all after merging the last member with work, too', async () => {
    gitApiMocks.branchDiffShortStat.mockResolvedValueOnce({
      success: true,
      filesChanged: 2,
      insertions: 10,
      deletions: 3,
      commitsAhead: 1
    })
    gitApiMocks.getRemoteUrl.mockResolvedValue({ url: null })
    gitApiMocks.merge.mockResolvedValue({ success: true })

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    expect(await screen.findByText(/Merge successful/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archive all' })).toBeTruthy()
  })

  it('archives the current and every remaining member at once, then moves the ticket', async () => {
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive all' }))

    await waitFor(() =>
      expect(moveTicketMock).toHaveBeenCalledWith('ticket-1', 'project-1', 'done', 5)
    )
    await waitFor(() => expect(archiveWorktreeMock).toHaveBeenCalledTimes(3))
    expect(archiveWorktreeMock).toHaveBeenCalledWith(
      'worktree-1',
      '/repo/feature',
      'feature',
      '/project-1'
    )
    expect(archiveWorktreeMock).toHaveBeenCalledWith(
      'worktree-next',
      '/repo2/feature',
      'feature-next',
      '/project-2'
    )
    expect(archiveWorktreeMock).toHaveBeenCalledWith(
      'worktree-last',
      '/repo3/feature',
      'feature-last',
      '/project-3'
    )
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
  })

  it('keeps a member that picked up new work in the queue instead of archiving it', async () => {
    // worktree-next got commits since the queue was built
    gitApiMocks.branchDiffShortStat.mockImplementation(async (path: string) => ({
      success: true,
      filesChanged: path === '/repo2/feature' ? 1 : 0,
      insertions: 0,
      deletions: 0,
      commitsAhead: path === '/repo2/feature' ? 1 : 0
    }))

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive all' }))

    // The queue continues with the member that still needs a merge
    await waitFor(() =>
      expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('worktree-next')
    )
    expect(useKanbanStore.getState().pendingDoneMove?.remainingWorktrees).toEqual([])
    expect(moveTicketMock).not.toHaveBeenCalled()

    await waitFor(() => expect(archiveWorktreeMock).toHaveBeenCalledTimes(2))
    expect(archiveWorktreeMock).not.toHaveBeenCalledWith(
      'worktree-next',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('archives nothing when the dialog is dismissed while the members are being checked', async () => {
    let releaseCheck: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseCheck = resolve
    })
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      if (id === 'worktree-1') return featureWorktree
      await gate
      if (id === 'worktree-next') return nextWorktree
      if (id === 'worktree-last') return lastWorktree
      return null
    })

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive all' }))
    // Escape / close → Keep in Review while the checks are still running
    act(() => useKanbanStore.getState().clearPendingDoneMove())
    releaseCheck()

    await waitFor(() => expect(screen.queryByTestId('merge-on-done-dialog')).toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(archiveWorktreeMock).not.toHaveBeenCalled()
    expect(moveTicketMock).not.toHaveBeenCalled()
  })

  it('keeps a member that picked up work between its check and the archive', async () => {
    // worktree-next is clean at the first check, dirty right before archiving
    let nextChecks = 0
    gitApiMocks.hasUncommittedChanges.mockImplementation(async (path: string) => {
      if (path !== '/repo2/feature') return false
      nextChecks += 1
      return nextChecks > 1
    })

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive all' }))

    await waitFor(() =>
      expect(moveTicketMock).toHaveBeenCalledWith('ticket-1', 'project-1', 'done', 5)
    )
    await waitFor(() => expect(archiveWorktreeMock).toHaveBeenCalledTimes(2))
    expect(archiveWorktreeMock).not.toHaveBeenCalledWith(
      'worktree-next',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('Archive (single) still archives only the current member and advances the queue', async () => {
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))

    await waitFor(() => expect(archiveWorktreeMock).toHaveBeenCalledTimes(1))
    expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('worktree-next')
    expect(moveTicketMock).not.toHaveBeenCalled()
  })
})

describe('MergeOnDoneDialog — changed files', () => {
  const branchFiles = [
    { relativePath: 'src/app.ts', status: 'M', additions: 10, deletions: 3, binary: false },
    { relativePath: 'src/new.ts', status: 'A', additions: 5, deletions: 0, binary: false },
    { relativePath: 'assets/logo.bin', status: 'M', additions: 0, deletions: 0, binary: true },
    {
      relativePath: 'big/generated.json',
      status: 'M',
      additions: 2000,
      deletions: 0,
      binary: false
    }
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    moveTicketMock.mockResolvedValue(undefined)
    archiveWorktreeMock.mockResolvedValue({ success: true })
    mockAlreadyMergedBranch()
    setupStores()
    gitApiMocks.branchDiffShortStat.mockResolvedValue({
      success: true,
      filesChanged: 4,
      insertions: 2015,
      deletions: 3,
      commitsAhead: 1
    })
    gitApiMocks.getBranchDiffFiles.mockResolvedValue({ success: true, files: branchFiles })
    gitApiMocks.getBranchFileDiff.mockImplementation(
      (_path: string, _branch: string, file: string) =>
        Promise.resolve({ success: true, diff: `diff --git a/${file} b/${file}\n+changed` })
    )
  })

  afterEach(() => {
    cleanup()
    useKanbanStore.setState({ pendingDoneMove: null })
  })

  it('lists every file that differs from the base branch in the merge step', async () => {
    render(<MergeOnDoneDialog />)

    expect(await screen.findByText('Merge branch')).toBeTruthy()
    const rows = await screen.findAllByTestId('merge-file-row')
    expect(rows.map((row) => row.getAttribute('data-path'))).toEqual([
      'assets/logo.bin',
      'big/generated.json',
      'src/app.ts',
      'src/new.ts'
    ])
    expect(gitApiMocks.getBranchDiffFiles).toHaveBeenCalledWith('/repo/feature', 'main')
    expect(screen.getByTestId('merge-summary-commits').textContent).toBe('1 commit ahead')
    expect(screen.getByTestId('merge-summary-files').textContent).toBe('4 files changed')
    expect(screen.getByTestId('merge-summary-stats').textContent).toBe('+2015-3')
    expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled()
  })

  it('opens a file diff inside the dialog and returns to the list', async () => {
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: /^src\/app\.ts,/ }))

    const viewer = await screen.findByTestId('diff-viewer')
    expect(viewer.textContent).toContain('diff --git a/src/app.ts b/src/app.ts')
    expect(gitApiMocks.getBranchFileDiff).toHaveBeenCalledWith(
      '/repo/feature',
      'main',
      'src/app.ts'
    )
    expect(screen.getByTestId('merge-diff-position').textContent).toBe('3 / 4')
    // The decision stays one click away from the evidence
    expect(screen.getByRole('button', { name: 'Merge' })).toBeTruthy()
    expect(screen.queryByTestId('merge-file-list')).toBeNull()

    fireEvent.click(screen.getByTestId('merge-diff-back'))

    expect(await screen.findByTestId('merge-file-list')).toBeTruthy()
    expect(screen.queryByTestId('merge-diff-view')).toBeNull()
    expect(useKanbanStore.getState().pendingDoneMove).not.toBeNull()
    expect(moveTicketMock).not.toHaveBeenCalled()
  })

  it('Escape backs out of the diff view and only closes the dialog from the list', async () => {
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: /^src\/app\.ts,/ }))
    await screen.findByTestId('merge-diff-view')

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(await screen.findByTestId('merge-file-list')).toBeTruthy()
    expect(useKanbanStore.getState().pendingDoneMove).not.toBeNull()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    await waitFor(() => expect(useKanbanStore.getState().pendingDoneMove).toBeNull())
    expect(moveTicketMock).not.toHaveBeenCalled()
  })

  it('never fetches a patch for a binary file', async () => {
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: /^assets\/logo\.bin,/ }))

    expect(await screen.findByTestId('merge-diff-binary')).toBeTruthy()
    expect(gitApiMocks.getBranchFileDiff).not.toHaveBeenCalled()
  })

  it('waits for an explicit Load diff on very large files', async () => {
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: /^big\/generated\.json,/ }))

    expect(await screen.findByTestId('merge-diff-load-large')).toBeTruthy()
    expect(gitApiMocks.getBranchFileDiff).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Load diff' }))

    expect(await screen.findByTestId('diff-viewer')).toBeTruthy()
    expect(gitApiMocks.getBranchFileDiff).toHaveBeenCalledWith(
      '/repo/feature',
      'main',
      'big/generated.json'
    )
  })

  it('steps through files with previous/next without leaving the diff view', async () => {
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: /^src\/app\.ts,/ }))
    await screen.findByTestId('diff-viewer')

    fireEvent.click(screen.getByTestId('merge-diff-next'))

    await waitFor(() =>
      expect(gitApiMocks.getBranchFileDiff).toHaveBeenCalledWith(
        '/repo/feature',
        'main',
        'src/new.ts'
      )
    )
    expect(screen.getByTestId('merge-diff-position').textContent).toBe('4 / 4')
    expect(screen.getByTestId('merge-diff-next')).toBeDisabled()

    fireEvent.click(screen.getByTestId('merge-diff-prev'))
    fireEvent.click(screen.getByTestId('merge-diff-prev'))

    expect(await screen.findByTestId('merge-diff-load-large')).toBeTruthy()
    expect(screen.getByTestId('merge-diff-position').textContent).toBe('2 / 4')
  })

  it('shows an inline error and keeps Merge available when the file list fails', async () => {
    gitApiMocks.getBranchDiffFiles.mockResolvedValue({ success: false, error: 'boom' })

    render(<MergeOnDoneDialog />)

    const error = await screen.findByTestId('merge-file-list-error')
    expect(error.textContent).toContain('boom')
    expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled()
    // Header falls back to the shortstat totals
    expect(screen.getByTestId('merge-summary-files').textContent).toBe('4 files changed')
  })

  it('explains an empty list when the branch is ahead but its content matches base', async () => {
    gitApiMocks.getBranchDiffFiles.mockResolvedValue({ success: true, files: [] })

    render(<MergeOnDoneDialog />)

    const empty = await screen.findByTestId('merge-file-list-empty')
    expect(empty.textContent).toContain('No file differences against')
    expect(empty.textContent).toContain('1 commit ahead')
    expect(screen.getByTestId('merge-summary-files').textContent).toBe('0 files changed')
  })

  it('lists uncommitted files in the commit step and diffs them against HEAD', async () => {
    gitApiMocks.hasUncommittedChanges.mockImplementation((path: string) =>
      Promise.resolve(path === '/repo/feature')
    )
    gitApiMocks.getDiffStat.mockResolvedValue({
      success: true,
      files: [
        { path: 'src/app.ts', additions: 2, deletions: 1, binary: false },
        { path: 'notes.md', additions: 4, deletions: 0, binary: false }
      ]
    })
    gitApiMocks.getFileStatuses.mockResolvedValue({
      success: true,
      files: [
        { path: '/repo/feature/notes.md', relativePath: 'notes.md', status: '?', staged: false },
        { path: '/repo/feature/src/app.ts', relativePath: 'src/app.ts', status: 'M', staged: true },
        { path: '/repo/feature/src/app.ts', relativePath: 'src/app.ts', status: 'M', staged: false }
      ]
    })
    gitApiMocks.getDiff.mockResolvedValue({
      success: true,
      diff: 'diff --git a/notes.md b/notes.md\n+new'
    })

    render(<MergeOnDoneDialog />)

    expect(await screen.findByText('Uncommitted changes')).toBeTruthy()
    const rows = await screen.findAllByTestId('merge-file-row')
    expect(rows.map((row) => row.getAttribute('data-path'))).toEqual(['notes.md', 'src/app.ts'])
    expect(screen.getByTestId('merge-summary-files').textContent).toBe('2 uncommitted files')
    expect(screen.getByTestId('merge-summary-stats').textContent).toBe('+6-1')
    expect(gitApiMocks.getBranchDiffFiles).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^notes\.md, Untracked/ }))
    expect((await screen.findByTestId('diff-viewer')).textContent).toContain('+new')
    expect(gitApiMocks.getDiff).toHaveBeenCalledWith('/repo/feature', 'notes.md', false, true)

    fireEvent.click(screen.getByTestId('merge-diff-back'))
    fireEvent.click(await screen.findByRole('button', { name: /^src\/app\.ts, Modified/ }))

    await waitFor(() =>
      expect(gitApiMocks.getBranchFileDiff).toHaveBeenCalledWith(
        '/repo/feature',
        'HEAD',
        'src/app.ts'
      )
    )
    expect(screen.getByRole('button', { name: 'Commit' })).toBeTruthy()
  })

  const manyFiles = Array.from({ length: 10 }, (_, i) => ({
    relativePath: i < 5 ? `src/app${i}.ts` : `docs/page${i}.md`,
    status: 'M',
    additions: i + 1,
    deletions: 0,
    binary: false
  }))

  it('Escape clears the file filter before it closes the dialog', async () => {
    gitApiMocks.getBranchDiffFiles.mockResolvedValue({ success: true, files: manyFiles })

    render(<MergeOnDoneDialog />)

    const filter = await screen.findByTestId('merge-file-filter')
    fireEvent.change(filter, { target: { value: 'docs' } })
    expect(screen.getAllByTestId('merge-file-row')).toHaveLength(5)

    fireEvent.keyDown(filter, { key: 'Escape' })

    await waitFor(() => expect(screen.getAllByTestId('merge-file-row')).toHaveLength(10))
    expect((screen.getByTestId('merge-file-filter') as HTMLInputElement).value).toBe('')
    expect(useKanbanStore.getState().pendingDoneMove).not.toBeNull()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    await waitFor(() => expect(useKanbanStore.getState().pendingDoneMove).toBeNull())
  })

  it('keeps the filter and walks the filtered rows when a diff is open', async () => {
    gitApiMocks.getBranchDiffFiles.mockResolvedValue({ success: true, files: manyFiles })

    render(<MergeOnDoneDialog />)

    fireEvent.change(await screen.findByTestId('merge-file-filter'), {
      target: { value: 'docs' }
    })
    fireEvent.click(screen.getByRole('button', { name: /^docs\/page5\.md,/ }))

    await screen.findByTestId('diff-viewer')
    expect(screen.getByTestId('merge-diff-position').textContent).toBe('1 / 5')

    fireEvent.click(screen.getByTestId('merge-diff-next'))
    await waitFor(() =>
      expect(gitApiMocks.getBranchFileDiff).toHaveBeenCalledWith(
        '/repo/feature',
        'main',
        'docs/page6.md'
      )
    )

    fireEvent.click(screen.getByTestId('merge-diff-back'))

    const filter = await screen.findByTestId('merge-file-filter')
    expect((filter as HTMLInputElement).value).toBe('docs')
    expect(screen.getAllByTestId('merge-file-row')).toHaveLength(5)
  })

  it('refreshes the list and an open diff when the worktree status changes', async () => {
    const listeners: Array<(event: { worktreePath: string }) => void> = []
    gitApiMocks.onStatusChanged.mockImplementation(
      (cb: (event: { worktreePath: string }) => void) => {
        listeners.push(cb)
        return () => {}
      }
    )

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: /^src\/app\.ts,/ }))
    await screen.findByTestId('diff-viewer')
    expect(gitApiMocks.getBranchFileDiff).toHaveBeenCalledTimes(1)
    expect(gitApiMocks.getBranchDiffFiles).toHaveBeenCalledTimes(1)

    gitApiMocks.getBranchFileDiff.mockResolvedValue({ success: true, diff: 'diff --git fresh' })
    await act(async () => {
      listeners.forEach((cb) => cb({ worktreePath: '/repo/feature' }))
    })

    await waitFor(() => expect(gitApiMocks.getBranchDiffFiles).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByTestId('diff-viewer').textContent).toContain('diff --git fresh')
    )
    // Still in the merge step: the tree is clean
    expect(screen.getByRole('button', { name: 'Merge' })).toBeTruthy()
  })

  it('goes back to the commit step when uncommitted changes appear before Merge', async () => {
    gitApiMocks.hasUncommittedChanges
      .mockResolvedValueOnce(false) // base, during init
      .mockResolvedValueOnce(false) // feature, during init
      .mockResolvedValue(true) // anything after: an agent wrote to the tree

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    expect(await screen.findByText('Uncommitted changes')).toBeTruthy()
    expect(gitApiMocks.merge).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().pendingDoneMove).not.toBeNull()
  })

  it('remembers Load diff consent through Back once the patch is cached', async () => {
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: /^big\/generated\.json,/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Load diff' }))
    await screen.findByTestId('diff-viewer')

    fireEvent.click(screen.getByTestId('merge-diff-back'))
    fireEvent.click(await screen.findByRole('button', { name: /^big\/generated\.json,/ }))

    expect(await screen.findByTestId('diff-viewer')).toBeTruthy()
    expect(screen.queryByTestId('merge-diff-load-large')).toBeNull()
    expect(gitApiMocks.getBranchFileDiff).toHaveBeenCalledTimes(1)
  })

  it('keeps the loaded list on screen when a refresh fails', async () => {
    const listeners: Array<(event: { worktreePath: string }) => void> = []
    gitApiMocks.onStatusChanged.mockImplementation(
      (cb: (event: { worktreePath: string }) => void) => {
        listeners.push(cb)
        return () => {}
      }
    )

    render(<MergeOnDoneDialog />)
    await screen.findAllByTestId('merge-file-row')

    gitApiMocks.getBranchDiffFiles.mockResolvedValue({ success: false, error: 'lost git' })
    await act(async () => {
      listeners.forEach((cb) => cb({ worktreePath: '/repo/feature' }))
    })

    const strip = await screen.findByTestId('merge-file-list-refresh-error')
    expect(strip.textContent).toContain('lost git')
    expect(screen.getAllByTestId('merge-file-row')).toHaveLength(4)
  })
})

describe('MergeOnDoneDialog — document-run batch (shift-drop of the run ticket)', () => {
  const integrationWorktree = {
    id: 'worktree-int',
    project_id: 'project-1',
    branch_name: 'doc-run',
    path: '/repo/doc-run',
    status: 'active' as const,
    is_default: false,
    base_branch: 'main'
  }
  const betaWorktree = {
    id: 'worktree-b',
    project_id: 'project-1',
    branch_name: 'feature-b',
    path: '/repo/feature-b',
    status: 'active' as const,
    is_default: false,
    base_branch: null
  }
  const runTicket: KanbanTicket = {
    ...ticket,
    id: 'ticket-run',
    title: 'The run',
    worktree_id: 'worktree-int',
    external_provider: 'document-run',
    external_id: 'run-1'
  }
  const alphaTicket: KanbanTicket = {
    ...ticket,
    id: 'ticket-a',
    title: 'Alpha',
    column: 'review',
    parent_ticket_id: 'ticket-run'
  }
  const betaTicket: KanbanTicket = {
    ...ticket,
    id: 'ticket-b',
    title: 'Beta',
    column: 'merged',
    worktree_id: 'worktree-b',
    parent_ticket_id: 'ticket-run'
  }

  const childMerge = {
    worktreeId: 'worktree-1',
    projectId: 'project-1',
    kind: 'run-child' as const,
    ticketId: 'ticket-a',
    label: 'A1 · Alpha',
    runId: 'run-1',
    itemId: 'item-a',
    integrationBranch: 'doc-run',
    integrationWorktreeId: 'worktree-int'
  }
  const integration = {
    worktreeId: 'worktree-int',
    projectId: 'project-1',
    kind: 'run-integration' as const,
    label: 'The run'
  }
  const archiveAlpha = {
    worktreeId: 'worktree-1',
    projectId: 'project-1',
    kind: 'run-child-archive' as const,
    alreadyMerged: true,
    ticketId: 'ticket-a',
    label: 'A1 · Alpha'
  }
  const archiveBeta = {
    worktreeId: 'worktree-b',
    projectId: 'project-1',
    kind: 'run-child-archive' as const,
    alreadyMerged: true,
    ticketId: 'ticket-b',
    label: 'A2 · Beta'
  }
  const run = {
    runId: 'run-1',
    title: 'The run',
    kept: [] as { label: string; reason: string }[],
    alsoMoveTicketIds: [] as string[]
  }
  const updateItemMock = vi.fn().mockResolvedValue(undefined)

  /** Commits each worktree path is ahead of a branch; everything else is 0. */
  let ahead: Record<string, Record<string, number>> = {}

  function seedPending(
    current: typeof childMerge | typeof integration | typeof archiveAlpha,
    remaining: Array<typeof integration | typeof archiveAlpha | typeof archiveBeta>,
    extra: Partial<{ run: typeof run & { kept: { label: string; reason: string }[] } }> = {}
  ): void {
    useKanbanStore.setState({
      tickets: new Map([['project-1', [runTicket, alphaTicket, betaTicket]]]),
      pendingDoneMove: {
        ticketId: 'ticket-run',
        projectId: 'project-1',
        sortOrder: 5,
        targetColumn: 'done',
        worktreeId: current.worktreeId,
        worktreeProjectId: 'project-1',
        remainingWorktrees: remaining,
        offerArchive: true,
        entry: current,
        run,
        ...extra
      },
      moveTicket: moveTicketMock
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ahead = {}
    moveTicketMock.mockResolvedValue(undefined)
    archiveWorktreeMock.mockResolvedValue({ success: true })
    updateItemMock.mockResolvedValue(undefined)
    mockAlreadyMergedBranch()
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => {
      if (id === 'worktree-1') return featureWorktree
      if (id === 'worktree-int') return integrationWorktree
      if (id === 'worktree-b') return betaWorktree
      if (id === 'worktree-main') return baseWorktree
      return null
    })
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([
      featureWorktree,
      baseWorktree,
      integrationWorktree,
      betaWorktree
    ])
    dbApiMocks.project.get.mockResolvedValue({ path: '/project-1', name: 'Project' })
    gitApiMocks.hasUncommittedChanges.mockResolvedValue(false)
    gitApiMocks.branchDiffShortStat.mockImplementation(async (path: string, base: string) => {
      const commitsAhead = ahead[path]?.[base] ?? 0
      return {
        success: true,
        filesChanged: commitsAhead,
        insertions: commitsAhead,
        deletions: 0,
        commitsAhead
      }
    })
    gitApiMocks.getFileStatuses.mockResolvedValue({ success: true, files: [] })
    gitApiMocks.getRemoteUrl.mockResolvedValue({ url: null })
    gitApiMocks.isBranchMerged.mockResolvedValue({ success: true, isMerged: false })
    useWorktreeStore.setState({ archiveWorktree: archiveWorktreeMock, loadWorktrees: vi.fn() })
    useDocumentFlowStore.setState({ updateItem: updateItemMock })
  })

  afterEach(() => {
    cleanup()
    useKanbanStore.setState({ pendingDoneMove: null })
  })

  it('merges a ticket branch into the integration branch through the run, never with a plain git merge', async () => {
    ahead = { '/repo/feature': { 'doc-run': 1 } }
    flowApiMocks.prepareMerge.mockResolvedValue({
      state: 'clean',
      conflictedFiles: [],
      committed: false,
      commitsAhead: 1
    })
    flowApiMocks.merge.mockResolvedValue({ success: true, mergeSha: 'abc' })
    seedPending(childMerge, [integration, archiveAlpha])

    render(<MergeOnDoneDialog />)

    expect((await screen.findByTestId('run-entry-label')).textContent).toContain('A1 · Alpha')
    expect(screen.getByText(/into/).textContent).toContain('doc-run')
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    await waitFor(() => expect(flowApiMocks.merge).toHaveBeenCalledWith('run-1', 'item-a'))
    expect(flowApiMocks.prepareMerge).toHaveBeenCalledWith('run-1', 'item-a')
    expect(gitApiMocks.merge).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(updateItemMock).toHaveBeenCalledWith(
        'run-1',
        'item-a',
        expect.objectContaining({ status: 'merged' })
      )
    )
    // The ticket reads as merged, as it would had the run merged it; Done waits for its
    // archive entry at the tail
    expect(moveTicketMock).toHaveBeenCalledWith(
      'ticket-a',
      'project-1',
      'merged',
      expect.any(Number),
      { skipCompletionEffects: true }
    )
    await waitFor(() =>
      expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('worktree-int')
    )
  })

  it('offers to skip a ticket branch instead of moving anyway', async () => {
    ahead = { '/repo/feature': { 'doc-run': 1 } }
    seedPending(childMerge, [integration, archiveAlpha])

    render(<MergeOnDoneDialog />)

    const skip = await screen.findByTestId('skip-run-branch')
    expect(screen.queryByRole('button', { name: /anyway/ })).toBeNull()
    fireEvent.click(skip)

    await waitFor(() =>
      expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('worktree-int')
    )
    // Its archive turn goes with it: a branch that was not merged is never deleted
    expect(useKanbanStore.getState().pendingDoneMove?.remainingWorktrees).toEqual([])
    expect(useKanbanStore.getState().pendingDoneMove?.keptWorktrees).toEqual([
      { label: 'A1 · Alpha', reason: 'skipped', worktreeId: 'worktree-1' }
    ])
    expect(moveTicketMock).not.toHaveBeenCalled()
  })

  it('keeps a ticket branch that conflicts with the integration branch and goes on', async () => {
    ahead = { '/repo/feature': { 'doc-run': 1 } }
    flowApiMocks.prepareMerge.mockResolvedValue({
      state: 'conflict',
      conflictedFiles: ['src/a.ts'],
      committed: false,
      commitsAhead: 1
    })
    seedPending(childMerge, [integration, archiveAlpha])

    render(<MergeOnDoneDialog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    await waitFor(() =>
      expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('worktree-int')
    )
    expect(flowApiMocks.merge).not.toHaveBeenCalled()
    expect(gitApiMocks.merge).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().pendingDoneMove?.remainingWorktrees).toEqual([])
    expect(useKanbanStore.getState().pendingDoneMove?.conflictedWorktrees).toEqual([
      { worktreeId: 'worktree-1', projectId: 'project-1' }
    ])
  })

  it('refuses to commit a ticket branch with conflict markers', async () => {
    gitApiMocks.hasUncommittedChanges.mockImplementation(
      async (path: string) => path === '/repo/feature'
    )
    gitApiMocks.getFileStatuses.mockResolvedValue({
      success: true,
      files: [{ path: 'a.ts', relativePath: 'a.ts', status: 'C', staged: false }]
    })
    seedPending(childMerge, [integration, archiveAlpha])

    render(<MergeOnDoneDialog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Commit' }))

    await waitFor(() => expect(gitApiMocks.getFileStatuses).toHaveBeenCalledWith('/repo/feature'))
    expect(gitApiMocks.stageAll).not.toHaveBeenCalled()
    expect(gitApiMocks.commit).not.toHaveBeenCalled()
  })

  it('stops the whole batch when the integration branch conflicts with base: nothing is archived', async () => {
    ahead = { '/repo/doc-run': { main: 3 } }
    gitApiMocks.merge.mockResolvedValue({ success: false, conflicts: ['src/x.ts'] })
    useGitStore.setState({ setHasConflicts: vi.fn(), refreshStatuses: vi.fn() })
    seedPending(integration, [archiveAlpha, archiveBeta])

    render(<MergeOnDoneDialog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    await waitFor(() => expect(useKanbanStore.getState().pendingDoneMove).toBeNull())
    expect(archiveWorktreeMock).not.toHaveBeenCalled()
    expect(moveTicketMock).not.toHaveBeenCalled()
  })

  it('counts every branch in Archive all and moves their tickets, the run’s last', async () => {
    seedPending(integration, [archiveAlpha, archiveBeta])

    render(<MergeOnDoneDialog />)

    const archiveAll = await screen.findByRole('button', { name: 'Archive all (3)' })
    expect(screen.getByTestId('archive-all-hint').textContent).toContain(
      'other 2 branches of this document run'
    )
    fireEvent.click(archiveAll)

    await waitFor(() =>
      expect(moveTicketMock).toHaveBeenCalledWith('ticket-run', 'project-1', 'done', 5)
    )
    const moved = moveTicketMock.mock.calls.map((call) => call[0])
    expect(moved).toEqual(['ticket-a', 'ticket-b', 'ticket-run'])
    expect(moveTicketMock).toHaveBeenCalledWith(
      'ticket-a',
      'project-1',
      'done',
      expect.any(Number),
      { skipCompletionEffects: true }
    )
    await waitFor(() => expect(archiveWorktreeMock).toHaveBeenCalledTimes(3))
    expect(archiveWorktreeMock).toHaveBeenCalledWith(
      'worktree-int',
      '/repo/doc-run',
      'doc-run',
      '/project-1'
    )
    expect(archiveWorktreeMock).toHaveBeenCalledWith('worktree-1', '/repo/feature', 'feature', '/project-1')
    expect(archiveWorktreeMock).toHaveBeenCalledWith(
      'worktree-b',
      '/repo/feature-b',
      'feature-b',
      '/project-1'
    )
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
  })

  it('leaves a ticket branch that picked up work alone instead of merging it into base', async () => {
    ahead = { '/repo/feature': { main: 2 } }
    seedPending(archiveAlpha, [])

    render(<MergeOnDoneDialog />)

    await waitFor(() => expect(useKanbanStore.getState().pendingDoneMove).toBeNull())
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull()
    expect(gitApiMocks.merge).not.toHaveBeenCalled()
    expect(archiveWorktreeMock).not.toHaveBeenCalled()
    // The branch and its own ticket stay as they are; the run's ticket still moves
    await waitFor(() =>
      expect(moveTicketMock).toHaveBeenCalledExactlyOnceWith('ticket-run', 'project-1', 'done', 5)
    )
  })

  it('names the branches that were left out at the archive step', async () => {
    seedPending(integration, [archiveAlpha], {
      run: { ...run, kept: [{ label: 'A3 · Gamma', reason: 'never started' }] }
    })

    render(<MergeOnDoneDialog />)

    expect((await screen.findByTestId('archive-kept-branches')).textContent).toContain(
      'A3 · Gamma (never started)'
    )
    expect(screen.getByRole('button', { name: 'Archive all (2)' })).toBeTruthy()
  })
})

describe('MergeOnDoneDialog — document-run batch on a connection project (instances)', () => {
  type Wt = {
    id: string
    project_id: string
    branch_name: string
    path: string
    status: 'active' | 'archived'
    is_default: boolean
    base_branch: string | null
  }
  const wt = (
    id: string,
    project_id: string,
    branch_name: string,
    path: string,
    extra: Partial<Wt> = {}
  ): Wt => ({ id, project_id, branch_name, path, status: 'active', is_default: false, base_branch: 'main', ...extra })
  const worktrees: Record<string, Wt> = {
    'wt-main-web': wt('wt-main-web', 'proj-web', 'main', '/web', { is_default: true, base_branch: null }),
    'wt-main-api': wt('wt-main-api', 'proj-api', 'main', '/api', { is_default: true, base_branch: null }),
    'wt-int-web': wt('wt-int-web', 'proj-web', 'doc-run', '/web/int'),
    'wt-int-api': wt('wt-int-api', 'proj-api', 'doc-run', '/api/int'),
    'wt-a-web': wt('wt-a-web', 'proj-web', 'a1-alpha', '/web/a1'),
    'wt-a-api': wt('wt-a-api', 'proj-api', 'a1-alpha', '/api/a1')
  }
  const members = [
    { worktreeId: 'wt-a-web', projectId: 'proj-web', projectName: 'Web', branchName: 'a1-alpha', worktreePath: '/web/a1', integrationBranch: 'doc-run', integrationWorktreeId: 'wt-int-web' },
    { worktreeId: 'wt-a-api', projectId: 'proj-api', projectName: 'Api', branchName: 'a1-alpha', worktreePath: '/api/a1', integrationBranch: 'doc-run', integrationWorktreeId: 'wt-int-api' }
  ]
  const runTicket: KanbanTicket = { ...ticket, id: 'ticket-run', project_id: 'proj-conn', title: 'The run', worktree_id: null, external_provider: 'document-run', external_id: 'run-1' }
  const alphaTicket: KanbanTicket = { ...ticket, id: 'ticket-a', project_id: 'proj-conn', title: 'Alpha', column: 'review', parent_ticket_id: 'ticket-run' }

  const childInstance = {
    worktreeId: 'wt-a-web', projectId: 'proj-web', kind: 'run-child' as const, ticketId: 'ticket-a', label: 'A1 · Alpha',
    runId: 'run-1', itemId: 'item-a', integrationBranch: 'doc-run', integrationWorktreeId: 'wt-int-web', connectionId: 'conn-a', members
  }
  const archiveInstance = {
    worktreeId: 'wt-a-web', projectId: 'proj-web', kind: 'run-child-archive' as const, alreadyMerged: true, ticketId: 'ticket-a', label: 'A1 · Alpha', itemId: 'item-a', connectionId: 'conn-a', members
  }
  const integrationWeb = { worktreeId: 'wt-int-web', projectId: 'proj-web', kind: 'run-integration' as const, alreadyMerged: true, label: 'The run · Web', connectionId: 'conn-int' }
  const integrationApi = { worktreeId: 'wt-int-api', projectId: 'proj-api', kind: 'run-integration' as const, alreadyMerged: true, label: 'The run · Api', connectionId: 'conn-int' }
  const run = { runId: 'run-1', title: 'The run', kept: [] as { label: string; reason: string }[], alsoMoveTicketIds: [] as string[] }

  let ahead: Record<string, Record<string, number>> = {}
  let dirtyPaths: string[] = []
  const skipDoneMoveEntryMock = vi.fn().mockResolvedValue(undefined)
  const realSkipDoneMoveEntry = useKanbanStore.getState().skipDoneMoveEntry
  const closeSessionMock = vi.fn().mockResolvedValue({ success: true })
  const instanceB = {
    worktreeId: 'wt-b-web', projectId: 'proj-web', kind: 'run-child-archive' as const, alreadyMerged: true, ticketId: 'ticket-b', label: 'A2 · Beta', itemId: 'item-b', connectionId: 'conn-b',
    members: [
      { worktreeId: 'wt-b-web', projectId: 'proj-web', projectName: 'Web', branchName: 'a2-beta', worktreePath: '/web/a2', integrationBranch: 'doc-run', integrationWorktreeId: 'wt-int-web' },
      { worktreeId: 'wt-b-api', projectId: 'proj-api', projectName: 'Api', branchName: 'a2-beta', worktreePath: '/api/a2', integrationBranch: 'doc-run', integrationWorktreeId: 'wt-int-api' }
    ]
  }
  const betaTicketB: KanbanTicket = { ...ticket, id: 'ticket-b', project_id: 'proj-conn', title: 'Beta', column: 'merged', parent_ticket_id: 'ticket-run' }

  function seed(current: { worktreeId: string; projectId: string }, remaining: object[] = []): void {
    useKanbanStore.setState({
      tickets: new Map([['proj-conn', [runTicket, alphaTicket, betaTicketB]]]),
      pendingDoneMove: {
        ticketId: 'ticket-run', projectId: 'proj-conn', sortOrder: 5, targetColumn: 'done',
        worktreeId: current.worktreeId, worktreeProjectId: current.projectId,
        remainingWorktrees: remaining as never, offerArchive: true, entry: current as never, run
      },
      moveTicket: moveTicketMock
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ahead = {}
    dirtyPaths = []
    for (const w of Object.values(worktrees)) w.status = 'active'
    worktrees['wt-b-web'] = wt('wt-b-web', 'proj-web', 'a2-beta', '/web/a2')
    worktrees['wt-b-api'] = wt('wt-b-api', 'proj-api', 'a2-beta', '/api/a2')
    moveTicketMock.mockResolvedValue(undefined)
    archiveWorktreeMock.mockResolvedValue({ success: true })
    closeSessionMock.mockResolvedValue({ success: true })
    useSessionStore.setState({ sessionsByConnection: new Map(), closeSession: closeSessionMock })
    useGitStore.setState({ setHasConflicts: vi.fn(), refreshStatuses: vi.fn() })
    dbApiMocks.worktree.get.mockImplementation(async (id: string) => worktrees[id] ?? null)
    dbApiMocks.worktree.getActiveByProject.mockImplementation(async (projectId: string) =>
      Object.values(worktrees).filter((w) => w.project_id === projectId)
    )
    dbApiMocks.project.get.mockImplementation(async (id: string) => ({ path: `/${id}`, name: id }))
    gitApiMocks.hasUncommittedChanges.mockImplementation(async (path: string) => dirtyPaths.includes(path))
    gitApiMocks.branchDiffShortStat.mockImplementation(async (path: string, base: string) => {
      const commitsAhead = ahead[path]?.[base] ?? 0
      return { success: true, filesChanged: commitsAhead, insertions: commitsAhead, deletions: 0, commitsAhead }
    })
    gitApiMocks.getFileStatuses.mockResolvedValue({ success: true, files: [] })
    gitApiMocks.getBranchDiffFiles.mockResolvedValue({ success: true, files: [] })
    gitApiMocks.getDiffStat.mockResolvedValue({ success: true, files: [] })
    gitApiMocks.stageAll.mockResolvedValue({ success: true })
    gitApiMocks.commit.mockResolvedValue({ success: true })
    gitApiMocks.getRemoteUrl.mockResolvedValue({ url: null })
    useWorktreeStore.setState({ archiveWorktree: archiveWorktreeMock, loadWorktrees: vi.fn() })
    useDocumentFlowStore.setState({ updateItem: vi.fn().mockResolvedValue(undefined) })
  })

  afterEach(() => {
    cleanup()
    useKanbanStore.setState({ pendingDoneMove: null, skipDoneMoveEntry: realSkipDoneMoveEntry })
  })

  it('is not short-circuited by a clean first member: the merge step shows every member as a chip', async () => {
    ahead = { '/api/a1': { 'doc-run': 2 } }
    seed(childInstance)

    render(<MergeOnDoneDialog />)

    expect(await screen.findByRole('button', { name: 'Merge' })).toBeTruthy()
    const chips = screen.getByTestId('run-child-members')
    expect(chips.textContent).toContain('Web · 0 commits')
    expect(chips.textContent).toContain('Api · 2 commits')
    // The member with work is in focus; a chip switches the view
    expect(screen.getByTestId('run-child-member-proj-api').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('run-child-member-proj-web'))
    expect(screen.getByTestId('run-child-member-proj-web').getAttribute('aria-pressed')).toBe('true')
    expect(moveTicketMock).not.toHaveBeenCalled()
  })

  it('a clean instance completes without a dialog step', async () => {
    seed(childInstance, [integrationWeb])

    render(<MergeOnDoneDialog />)

    await waitFor(() => expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('wt-int-web'))
    expect(gitApiMocks.commit).not.toHaveBeenCalled()
  })

  it('commits every dirty member with one message, then merges the whole instance through the run', async () => {
    dirtyPaths = ['/web/a1', '/api/a1']
    seed(childInstance)
    render(<MergeOnDoneDialog />)
    expect(await screen.findByText('Uncommitted changes')).toBeTruthy()

    // After the commits both members are ahead of their integration branch
    gitApiMocks.commit.mockImplementation(async (path: string) => {
      dirtyPaths = dirtyPaths.filter((p) => p !== path)
      ahead = { '/web/a1': { 'doc-run': 1 }, '/api/a1': { 'doc-run': 1 } }
      return { success: true }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))

    expect(await screen.findByRole('button', { name: 'Merge' })).toBeTruthy()
    expect(gitApiMocks.commit).toHaveBeenCalledWith('/web/a1', 'Alpha')
    expect(gitApiMocks.commit).toHaveBeenCalledWith('/api/a1', 'Alpha')

    flowApiMocks.prepareMerge.mockResolvedValue({ state: 'clean', conflictedFiles: [], committed: false, commitsAhead: 2 })
    flowApiMocks.merge.mockResolvedValue({ success: true, mergeSha: 'm' })
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))

    await waitFor(() => expect(flowApiMocks.merge).toHaveBeenCalledWith('run-1', 'item-a'))
    expect(gitApiMocks.merge).not.toHaveBeenCalled()
    await waitFor(() => expect(useKanbanStore.getState().pendingDoneMove).toBeNull())
    // The child ticket read as merged; the run's ticket moved once the queue ended
    expect(moveTicketMock).toHaveBeenCalledWith('ticket-a', 'proj-conn', 'merged', expect.any(Number), { skipCompletionEffects: true })
    expect(moveTicketMock).toHaveBeenCalledWith('ticket-run', 'proj-conn', 'done', 5)
  })

  it('keeps the whole instance when any member is not on its base at the archive step', async () => {
    ahead = { '/api/a1': { main: 1 } }
    useKanbanStore.setState({ skipDoneMoveEntry: skipDoneMoveEntryMock })
    seed(archiveInstance, [integrationWeb])

    render(<MergeOnDoneDialog />)

    await waitFor(() =>
      expect(skipDoneMoveEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: 'wt-a-web', kind: 'run-child-archive' }),
        'has new changes in Api since the run'
      )
    )
    expect(archiveWorktreeMock).not.toHaveBeenCalled()
  })

  it('Archive on an instance archives its worktrees one after the other', async () => {
    seed(archiveInstance)
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))

    await waitFor(() => expect(archiveWorktreeMock).toHaveBeenCalledTimes(2))
    expect(archiveWorktreeMock.mock.calls.map((c) => c[0])).toEqual(['wt-a-web', 'wt-a-api'])
    expect(archiveWorktreeMock).toHaveBeenCalledWith('wt-a-api', '/api/a1', 'a1-alpha', '/proj-api')
    expect(moveTicketMock).toHaveBeenCalledWith('ticket-a', 'proj-conn', 'done', expect.any(Number), { skipCompletionEffects: true })
    expect(moveTicketMock).toHaveBeenCalledWith('ticket-run', 'proj-conn', 'done', 5)
  })

  it('Archive all counts instances, archives every worktree of each, and moves all tickets', async () => {
    seed(integrationWeb, [integrationApi, archiveInstance])
    render(<MergeOnDoneDialog />)

    // The integration instance (two member entries) and one ticket instance: 2 instances, 4 worktrees
    const button = await screen.findByRole('button', { name: 'Archive all (2)' })
    expect(screen.getByTestId('archive-all-hint').textContent).toContain('4 worktrees across 2 repositories')
    fireEvent.click(button)

    await waitFor(() => expect(archiveWorktreeMock).toHaveBeenCalledTimes(4))
    expect(new Set(archiveWorktreeMock.mock.calls.map((c) => c[0]))).toEqual(
      new Set(['wt-int-web', 'wt-int-api', 'wt-a-web', 'wt-a-api'])
    )
    // The ticket's instance goes in order; the run ticket moves last
    const instanceCalls = archiveWorktreeMock.mock.calls.map((c) => c[0]).filter((id) => id.startsWith('wt-a-'))
    expect(instanceCalls).toEqual(['wt-a-web', 'wt-a-api'])
    expect(moveTicketMock.mock.calls.map((c) => c[0])).toEqual(['ticket-a', 'ticket-run'])
  })

  it('Archive all keeps a whole instance when one of its members picked up work', async () => {
    ahead = { '/api/a1': { main: 3 } }
    seed(integrationWeb, [integrationApi, archiveInstance])
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive all (2)' }))

    await waitFor(() => expect(archiveWorktreeMock).toHaveBeenCalledTimes(2))
    expect(archiveWorktreeMock.mock.calls.map((c) => c[0]).sort()).toEqual(['wt-int-api', 'wt-int-web'])
    // The instance kept its own turn; its init found Api ahead of base, so the whole instance is
    // kept, its ticket stays, and the run's ticket moves at the end
    await waitFor(() => expect(useKanbanStore.getState().pendingDoneMove).toBeNull())
    expect(archiveWorktreeMock.mock.calls.map((c) => c[0])).not.toContain('wt-a-web')
    expect(moveTicketMock.mock.calls.map((c) => c[0])).toEqual(['ticket-run'])
  })

  it('Archive all on a ticket instance archives every member in its own repository', async () => {
    seed(archiveInstance, [instanceB])
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive all (2)' }))

    await waitFor(() => expect(archiveWorktreeMock).toHaveBeenCalledTimes(4))
    expect(archiveWorktreeMock).toHaveBeenCalledWith('wt-a-web', '/web/a1', 'a1-alpha', '/proj-web')
    expect(archiveWorktreeMock).toHaveBeenCalledWith('wt-a-api', '/api/a1', 'a1-alpha', '/proj-api')
    expect(archiveWorktreeMock).toHaveBeenCalledWith('wt-b-api', '/api/a2', 'a2-beta', '/proj-api')
    expect(moveTicketMock.mock.calls.map((c) => c[0])).toEqual(['ticket-a', 'ticket-b', 'ticket-run'])
  })

  it('Archive all leaves an instance alone when one of its worktrees is gone, and skips one that is gone entirely', async () => {
    worktrees['wt-b-api'].status = 'archived'
    seed(integrationWeb, [integrationApi, archiveInstance, instanceB])
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive all (3)' }))

    // The integration members and the whole A1 instance go; nothing of A2 does
    await waitFor(() => expect(archiveWorktreeMock).toHaveBeenCalledTimes(4))
    expect(archiveWorktreeMock.mock.calls.map((c) => c[0])).not.toContain('wt-b-web')
    // A2 keeps its own turn, where its init finds the worktree gone and skips it whole
    await waitFor(() => expect(useKanbanStore.getState().pendingDoneMove).toBeNull())
    expect(moveTicketMock.mock.calls.map((c) => c[0])).toEqual(['ticket-a', 'ticket-run'])
  })

  it('releases the instance’s sessions before its worktrees are archived', async () => {
    useSessionStore.setState({
      sessionsByConnection: new Map([['conn-a', [{ id: 's-a' } as never]]]),
      closeSession: closeSessionMock
    })
    seed(archiveInstance)
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))

    await waitFor(() => expect(archiveWorktreeMock).toHaveBeenCalledTimes(2))
    expect(closeSessionMock).toHaveBeenCalledWith('s-a')
    expect(closeSessionMock.mock.invocationCallOrder[0]).toBeLessThan(archiveWorktreeMock.mock.invocationCallOrder[0])
  })

  it('archiving one member of the integration instance leaves the instance’s sessions alone', async () => {
    useSessionStore.setState({
      sessionsByConnection: new Map([['conn-int', [{ id: 's-int' } as never]]]),
      closeSession: closeSessionMock
    })
    seed(integrationWeb, [integrationApi])
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))

    await waitFor(() => expect(archiveWorktreeMock).toHaveBeenCalledWith('wt-int-web', '/web/int', 'doc-run', '/proj-web'))
    expect(closeSessionMock).not.toHaveBeenCalled()
  })

  it('a member conflict in the run’s merge keeps the instance and drops its archive twin', async () => {
    ahead = { '/api/a1': { 'doc-run': 1 } }
    flowApiMocks.prepareMerge.mockResolvedValue({
      state: 'conflict',
      conflictedFiles: ['api/src/x.ts'],
      committed: false,
      commitsAhead: 1,
      members: [
        { project_id: 'proj-web', project_name: 'Web', symlink_name: 'web', integrationBranch: 'doc-run', integrationHead: 'h', state: 'no_changes', conflictedFiles: [], commitsAhead: 0 },
        { project_id: 'proj-api', project_name: 'Api', symlink_name: 'api', integrationBranch: 'doc-run', integrationHead: 'h', state: 'conflict', conflictedFiles: ['src/x.ts'], commitsAhead: 1 }
      ]
    })
    seed(childInstance, [integrationWeb, archiveInstance])
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    await waitFor(() => expect(useKanbanStore.getState().pendingDoneMove?.worktreeId).toBe('wt-int-web'))
    expect(flowApiMocks.merge).not.toHaveBeenCalled()
    // The archive twin of the conflicted instance is gone from the queue
    expect(useKanbanStore.getState().pendingDoneMove?.remainingWorktrees).toEqual([])
    expect(useKanbanStore.getState().pendingDoneMove?.conflictedWorktrees).toEqual([{ worktreeId: 'wt-a-web', projectId: 'proj-web' }])
  })

  it('a conflict merging a member integration branch into its base stops the batch with nothing archived', async () => {
    ahead = { '/api/int': { main: 3 } }
    gitApiMocks.merge.mockResolvedValue({ success: false, conflicts: ['src/x.ts'] })
    const integrationApiWithWork = { ...integrationApi, alreadyMerged: undefined }
    seed(integrationApiWithWork, [integrationWeb, archiveInstance])
    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    await waitFor(() => expect(useKanbanStore.getState().pendingDoneMove).toBeNull())
    expect(archiveWorktreeMock).not.toHaveBeenCalled()
    expect(moveTicketMock).not.toHaveBeenCalled()
  })

  it('commits uncommitted changes on the member integration branches first, only where there are any', async () => {
    dirtyPaths = ['/api/int']
    ahead = { '/web/a1': { 'doc-run': 1 } }
    seed(childInstance)
    render(<MergeOnDoneDialog />)

    expect(await screen.findByText('Uncommitted changes on base')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Commit message for base branch'), { target: { value: 'wip' } })
    gitApiMocks.commit.mockImplementation(async () => {
      dirtyPaths = []
      return { success: true }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))

    await waitFor(() => expect(gitApiMocks.commit).toHaveBeenCalledWith('/api/int', 'wip'))
    expect(gitApiMocks.commit).not.toHaveBeenCalledWith('/web/int', expect.anything())
    expect(await screen.findByRole('button', { name: 'Merge' })).toBeTruthy()
  })

  it('a retried commit skips the members already committed by the failed attempt', async () => {
    dirtyPaths = ['/web/a1', '/api/a1']
    seed(childInstance)
    render(<MergeOnDoneDialog />)
    expect(await screen.findByText('Uncommitted changes')).toBeTruthy()

    // Web commits, Api fails; the second attempt must not commit Web again
    gitApiMocks.commit.mockImplementation(async (path: string) => {
      if (path === '/api/a1') return { success: false, error: 'hook failed' }
      dirtyPaths = dirtyPaths.filter((p) => p !== path)
      return { success: true }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    await waitFor(() => expect(gitApiMocks.commit).toHaveBeenCalledWith('/api/a1', 'Alpha'))
    expect(await screen.findByText('Uncommitted changes')).toBeTruthy()

    gitApiMocks.commit.mockImplementation(async (path: string) => {
      dirtyPaths = dirtyPaths.filter((p) => p !== path)
      ahead = { '/web/a1': { 'doc-run': 1 }, '/api/a1': { 'doc-run': 1 } }
      return { success: true }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))

    expect(await screen.findByRole('button', { name: 'Merge' })).toBeTruthy()
    expect(gitApiMocks.commit.mock.calls.filter((c) => c[0] === '/web/a1')).toHaveLength(1)
  })
})
