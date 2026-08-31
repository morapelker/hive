import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MergeOnDoneDialog } from './MergeOnDoneDialog'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
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
  stageAll: vi.fn(),
  commit: vi.fn(),
  merge: vi.fn(),
  pull: vi.fn(),
  getRemoteUrl: vi.fn()
}))

vi.mock('@/api/git-api', () => ({
  gitApi: gitApiMocks
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
  model_provider_id: null,
  model_id: null,
  model_variant: null,
  variant_group_id: null
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
})
