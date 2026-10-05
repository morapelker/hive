import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../useKanbanStore', () => ({
  useKanbanStore: {
    getState: vi.fn(() => ({
      detachWorktreeTickets: vi.fn(),
      closePinnedBoard: vi.fn()
    }))
  }
}))

vi.mock('../useSessionStore', () => ({
  useSessionStore: {
    getState: vi.fn(() => ({
      sessionsByWorktree: new Map()
    }))
  }
}))

vi.mock('../../api/worktree-api', () => ({
  worktreeApi: {
    createFromBranch: vi.fn()
  }
}))

import { resetRendererRpcClientForTests, setRendererRpcClient } from '../../api/rpc-client'
import { worktreeApi } from '../../api/worktree-api'
import { useFileViewerStore } from '../useFileViewerStore'
import { useWorktreeStore } from '../useWorktreeStore'

const createdWorktree = {
  id: 'wt-new',
  project_id: 'project-1',
  name: 'a1-task',
  branch_name: 'a1-task',
  path: '/repo/a1-task',
  status: 'active' as const,
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
  base_branch: 'doc-run',
  created_at: new Date().toISOString(),
  last_accessed_at: new Date().toISOString()
}

describe('useWorktreeStore.createWorktreeFromBranch options', () => {
  const initialFileViewerState = useFileViewerStore.getState()
  let closeAllFiles: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    setRendererRpcClient({ request: vi.fn().mockResolvedValue([]), subscribe: vi.fn() })
    closeAllFiles = vi.fn()
    useFileViewerStore.setState({ closeAllFiles })
    useWorktreeStore.setState({
      worktreesByProject: new Map(),
      loadedProjectIds: new Set(['project-1']),
      worktreeOrderByProject: new Map(),
      isLoading: false,
      error: null,
      selectedWorktreeId: 'wt-current',
      creatingForProjectId: null,
      archivingWorktreeIds: new Set()
    })
    vi.mocked(worktreeApi.createFromBranch).mockResolvedValue({
      success: true,
      worktree: createdWorktree
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    useFileViewerStore.setState(initialFileViewerState, true)
  })

  const create = (
    options?: Parameters<
      ReturnType<typeof useWorktreeStore.getState>['createWorktreeFromBranch']
    >[5]
  ) =>
    useWorktreeStore
      .getState()
      .createWorktreeFromBranch('project-1', '/repo', 'Shop', 'doc-run', 'a1-task', options)

  it('behaves as before without options: selects the worktree and closes the file tabs', async () => {
    const result = await create()

    expect(result).toEqual({ success: true, worktree: createdWorktree })
    expect(worktreeApi.createFromBranch).toHaveBeenCalledWith({
      projectId: 'project-1',
      projectPath: '/repo',
      projectName: 'Shop',
      branchName: 'doc-run',
      nameHint: 'a1-task'
    })
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-new')
    expect(closeAllFiles).toHaveBeenCalledTimes(1)
    expect(useWorktreeStore.getState().getWorktreesForProject('project-1')).toEqual([
      createdWorktree
    ])
  })

  it('passes baseRef and autoPull to the API', async () => {
    await create({ baseRef: 'doc-run', autoPull: false })

    expect(worktreeApi.createFromBranch).toHaveBeenCalledWith({
      projectId: 'project-1',
      projectPath: '/repo',
      projectName: 'Shop',
      branchName: 'doc-run',
      nameHint: 'a1-task',
      baseRef: 'doc-run',
      autoPull: false
    })
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-new')
  })

  it('with select: false keeps the selection and the open files, but still records the worktree', async () => {
    const result = await create({ select: false })

    expect(result.success).toBe(true)
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-current')
    expect(closeAllFiles).not.toHaveBeenCalled()
    expect(useWorktreeStore.getState().getWorktreesForProject('project-1')).toEqual([
      createdWorktree
    ])
    expect(useWorktreeStore.getState().creatingForProjectId).toBeNull()
  })

  it('reports a failed creation without touching the selection', async () => {
    vi.mocked(worktreeApi.createFromBranch).mockResolvedValue({
      success: false,
      error: 'branch exists'
    })

    const result = await create({ select: false, baseRef: 'doc-run' })

    expect(result).toEqual({ success: false, error: 'branch exists' })
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-current')
    expect(closeAllFiles).not.toHaveBeenCalled()
  })
})
