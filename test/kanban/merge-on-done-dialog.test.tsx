import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { KanbanTicket, Project, Worktree } from '../../src/main/db/types'
import { MergeOnDoneDialog } from '../../src/renderer/src/components/kanban/MergeOnDoneDialog'
import { dbApi } from '../../src/renderer/src/api/db-api'
import { useGitStore } from '../../src/renderer/src/stores/useGitStore'
import { useKanbanStore } from '../../src/renderer/src/stores/useKanbanStore'
import { useWorktreeStatusStore } from '../../src/renderer/src/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'

const apiMocks = vi.hoisted(() => ({
  dbApi: {
    setting: {
      get: vi.fn(),
      set: vi.fn()
    },
    worktree: {
      get: vi.fn(),
      getActiveByProject: vi.fn()
    },
    project: {
      get: vi.fn()
    }
  },
  gitApi: {
    hasUncommittedChanges: vi.fn(),
    branchDiffShortStat: vi.fn(),
    getDiffStat: vi.fn(),
    getRemoteUrl: vi.fn(),
    pull: vi.fn(),
    merge: vi.fn(),
    mergeAbort: vi.fn(),
    stageAll: vi.fn(),
    commit: vi.fn(),
    getBranchInfo: vi.fn()
  },
  kanbanApi: {
    ticket: {
      move: vi.fn()
    }
  },
  petApi: {
    updateSettings: vi.fn()
  },
  settingsApi: {
    onSettingsUpdated: vi.fn(() => () => {})
  }
}))

vi.mock('../../src/renderer/src/api/db-api', () => ({
  dbApi: apiMocks.dbApi
}))

vi.mock('../../src/renderer/src/api/git-api', () => ({
  gitApi: apiMocks.gitApi
}))

vi.mock('../../src/renderer/src/api/kanban-api', () => ({
  kanbanApi: apiMocks.kanbanApi
}))

vi.mock('../../src/renderer/src/api/pet-api', () => ({
  petApi: apiMocks.petApi
}))

vi.mock('../../src/renderer/src/api/settings-api', () => ({
  settingsApi: apiMocks.settingsApi
}))

const toastError = vi.fn()
const toastSuccess = vi.fn()
const toastWarning = vi.fn()

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: (...args: unknown[]) => toastWarning(...args)
  }
}))

const ticketMove = apiMocks.kanbanApi.ticket.move
const mergeAbort = apiMocks.gitApi.mergeAbort
const merge = apiMocks.gitApi.merge
const originalArchiveWorktree = useWorktreeStore.getState().archiveWorktree

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'project-1',
    title: 'Fix merge issue',
    description: null,
    attachments: [],
    column: 'review',
    sort_order: 10,
    current_session_id: null,
    worktree_id: 'feature-wt',
    mode: 'build',
    plan_ready: false,
    created_at: '2026-04-26T00:00:00.000Z',
    updated_at: '2026-04-26T00:00:00.000Z',
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    note: null,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'feature-wt',
    project_id: 'project-1',
    name: 'feature',
    branch_name: 'feature',
    path: '/repo/feature',
    status: 'active',
    is_default: false,
    branch_renamed: 1,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    attachments: '[]',
    pinned: 0,
    context: null,
    github_pr_number: null,
    github_pr_url: null,
    base_branch: 'main',
    created_at: '2026-04-26T00:00:00.000Z',
    last_accessed_at: '2026-04-26T00:00:00.000Z',
    ...overrides
  }
}

const baseWorktree = makeWorktree({
  id: 'base-wt',
  name: 'main',
  branch_name: 'main',
  path: '/repo/main',
  is_default: true,
  base_branch: null
})

const project: Project = {
  id: 'project-1',
  name: 'Project',
  path: '/repo/main',
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-04-26T00:00:00.000Z',
  last_accessed_at: '2026-04-26T00:00:00.000Z'
}

describe('MergeOnDoneDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(dbApi.setting.get).mockResolvedValue(null)
    vi.mocked(dbApi.setting.set).mockResolvedValue(true)
    vi.mocked(dbApi.worktree.get).mockResolvedValue(makeWorktree())
    vi.mocked(dbApi.worktree.getActiveByProject).mockResolvedValue([makeWorktree(), baseWorktree])
    vi.mocked(dbApi.project.get).mockResolvedValue(project)
    ticketMove.mockResolvedValue(null)
    apiMocks.gitApi.hasUncommittedChanges.mockResolvedValue(false)
    apiMocks.gitApi.branchDiffShortStat.mockResolvedValue({
      success: true,
      filesChanged: 2,
      insertions: 4,
      deletions: 1,
      commitsAhead: 1
    })
    apiMocks.gitApi.getDiffStat.mockResolvedValue({
      success: true,
      files: []
    })
    apiMocks.gitApi.getRemoteUrl.mockResolvedValue({ success: true, url: null, remote: null })
    apiMocks.gitApi.pull.mockResolvedValue({ success: true })
    apiMocks.gitApi.stageAll.mockResolvedValue({ success: true })
    apiMocks.gitApi.commit.mockResolvedValue({ success: true, commitHash: 'commit-1' })
    apiMocks.gitApi.getBranchInfo.mockResolvedValue({ success: true, branch: null })
    apiMocks.petApi.updateSettings.mockResolvedValue({ success: true })
    mergeAbort.mockResolvedValue({ success: true })

    useKanbanStore.setState({
      tickets: new Map([['project-1', [makeTicket()]]]),
      pendingDoneMove: {
        ticketId: 'ticket-1',
        projectId: 'project-1',
        sortOrder: 100,
        targetColumn: 'done' as const
      }
    })
    useGitStore.setState({ conflictsByWorktree: {} })
    useWorktreeStatusStore.setState({ mergeConflictWorktreeByTicket: {} })

    useWorktreeStore.setState({ archiveWorktree: originalArchiveWorktree })
  })
  test('keeps ticket in review when merge returns conflicts', async () => {
    merge.mockResolvedValue({
      success: false,
      error: 'Merge conflicts in 1 file(s). Resolve conflicts before continuing.',
      conflicts: ['src/file.ts']
    })

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: /^merge$/i }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Merge conflicts in 1 file — merge manually')
    })

    expect(mergeAbort).not.toHaveBeenCalled()
    expect(ticketMove).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().tickets.get('project-1')?.[0]?.column).toBe('review')
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    expect(useGitStore.getState().conflictsByWorktree['/repo/main']).toBe(true)
    expect(
      useWorktreeStatusStore.getState().mergeConflictWorktreeByTicket['project-1:ticket-1']
    ).toBe('base-wt')
  })

  test('keeps ticket in review when merge fails without conflicts', async () => {
    merge.mockResolvedValue({
      success: false,
      error: 'merge failed'
    })

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: /^merge$/i }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Merge failed: merge failed')
    })

    expect(mergeAbort).not.toHaveBeenCalled()
    expect(ticketMove).not.toHaveBeenCalled()
    expect(useKanbanStore.getState().tickets.get('project-1')?.[0]?.column).toBe('review')
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
  })

  test('moves ticket to done only after a successful merge reaches the archive step', async () => {
    merge.mockResolvedValue({ success: true })

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: /^merge$/i }))

    const keepButton = await screen.findByRole('button', { name: 'Keep' })
    expect(ticketMove).not.toHaveBeenCalled()

    fireEvent.click(keepButton)

    await waitFor(() => {
      expect(ticketMove).toHaveBeenCalledWith('project-1', 'ticket-1', 'done', 100)
    })
    expect(useKanbanStore.getState().tickets.get('project-1')?.[0]?.column).toBe('done')
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    expect(toastSuccess).toHaveBeenCalledWith('Branch merged successfully')
  })

  test('moves ticket to done and closes immediately while archive continues in the background', async () => {
    merge.mockResolvedValue({ success: true })
    let resolveArchive!: (value: { success: boolean }) => void
    const archiveWorktree = vi.fn(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolveArchive = resolve
        })
    )
    useWorktreeStore.setState({ archiveWorktree })

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: /^merge$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^archive$/i }))

    await waitFor(() => {
      expect(ticketMove).toHaveBeenCalledWith('project-1', 'ticket-1', 'done', 100)
    })

    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()
    expect(screen.queryByText('Archive worktree')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(archiveWorktree).toHaveBeenCalledWith(
        'feature-wt',
        '/repo/feature',
        'feature',
        '/repo/main'
      )
    })
    expect(toastSuccess).not.toHaveBeenCalledWith('Worktree archived')

    resolveArchive({ success: true })

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Worktree archived')
    })
  })

  test('starts a new done-move archive step with the archive button enabled while a previous archive is still running', async () => {
    const secondTicket = makeTicket({
      id: 'ticket-2',
      title: 'Fix second issue',
      worktree_id: 'feature-wt-2'
    })
    const secondWorktree = makeWorktree({
      id: 'feature-wt-2',
      name: 'feature-two',
      branch_name: 'feature-two',
      path: '/repo/feature-two'
    })
    vi.mocked(dbApi.worktree.get).mockImplementation((id: string) =>
      Promise.resolve(id === 'feature-wt-2' ? secondWorktree : makeWorktree())
    )
    vi.mocked(dbApi.worktree.getActiveByProject).mockResolvedValue([
      makeWorktree(),
      secondWorktree,
      baseWorktree
    ])
    merge.mockResolvedValue({ success: true })
    const archiveWorktree = vi.fn(
      () =>
        new Promise<{ success: boolean }>(() => {
          // Keep the first archive pending to reproduce the leaked loading state.
        })
    )
    useWorktreeStore.setState({ archiveWorktree })

    render(<MergeOnDoneDialog />)

    fireEvent.click(await screen.findByRole('button', { name: /^merge$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^archive$/i }))

    await waitFor(() => {
      expect(ticketMove).toHaveBeenCalledWith('project-1', 'ticket-1', 'done', 100)
    })
    expect(useKanbanStore.getState().pendingDoneMove).toBeNull()

    act(() => {
      useKanbanStore.setState({
        tickets: new Map([
          ['project-1', [makeTicket({ column: 'done', sort_order: 100 }), secondTicket]]
        ]),
        pendingDoneMove: {
          ticketId: 'ticket-2',
          projectId: 'project-1',
          sortOrder: 200,
          targetColumn: 'done' as const
        }
      })
    })

    fireEvent.click(await screen.findByRole('button', { name: /^merge$/i }))
    const secondArchiveButton = await screen.findByRole('button', { name: /^archive$/i })

    expect(secondArchiveButton).toBeEnabled()
  })
})
