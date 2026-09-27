import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  getFileStatuses: vi.fn(),
  getBranchDiffFiles: vi.fn(),
  getBranchFileDiff: vi.fn(),
  getDiff: vi.fn(),
  onStatusChanged: vi.fn((_cb: (event: { worktreePath: string }) => void) => () => {}),
  stageAll: vi.fn(),
  commit: vi.fn(),
  merge: vi.fn(),
  pull: vi.fn(),
  getRemoteUrl: vi.fn()
}))

vi.mock('@/api/git-api', () => ({
  gitApi: gitApiMocks
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
