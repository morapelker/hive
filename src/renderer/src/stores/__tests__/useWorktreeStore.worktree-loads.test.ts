import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../useKanbanStore', () => ({
  useKanbanStore: {
    getState: vi.fn(() => ({
      detachWorktreeTickets: vi.fn()
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
    sync: vi.fn().mockResolvedValue({ success: true })
  }
}))

import { resetRendererRpcClientForTests, setRendererRpcClient } from '../../api/rpc-client'
import { worktreeApi } from '../../api/worktree-api'
import { useWorktreeStore } from '../useWorktreeStore'

let request: ReturnType<typeof vi.fn>

const makeWorktree = (id: string, projectId: string) => ({
  id,
  project_id: projectId,
  name: `worktree-${id}`,
  branch_name: `branch-${id}`,
  path: `/repo/${id}`,
  status: 'active' as const,
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  attachments: '[]',
  created_at: new Date().toISOString(),
  last_accessed_at: new Date().toISOString(),
  github_pr_number: null,
  github_pr_url: null
})

describe('useWorktreeStore worktree loading', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    request = vi.fn().mockResolvedValue([])
    setRendererRpcClient({ request, subscribe: vi.fn() })
    useWorktreeStore.setState({
      worktreesByProject: new Map(),
      worktreeOrderByProject: new Map(),
      isLoading: false,
      error: null,
      selectedWorktreeId: null,
      creatingForProjectId: null,
      archivingWorktreeIds: new Set()
    })

    vi.mocked(worktreeApi.sync).mockResolvedValue({ success: true })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  const expectGetActiveByProjectCalls = (count: number) => {
    expect(
      request.mock.calls.filter(([method]) => method === 'db.worktree.getActiveByProject')
    ).toHaveLength(count)
  }

  it('coalesces concurrent worktree loads for the same project', async () => {
    const projectId = 'load-concurrent-project'
    const worktrees = [makeWorktree('a', projectId)]
    let resolveLoad: (value: typeof worktrees) => void
    const loadPromise = new Promise<typeof worktrees>((resolve) => {
      resolveLoad = resolve
    })

    request.mockImplementation((method) => {
      if (method === 'db.worktree.getActiveByProject') return loadPromise
      return Promise.resolve([])
    })

    const firstLoad = useWorktreeStore.getState().loadWorktrees(projectId)
    const secondLoad = useWorktreeStore.getState().loadWorktrees(projectId)

    expect(request).toHaveBeenCalledWith('db.worktree.getActiveByProject', { projectId })
    expectGetActiveByProjectCalls(1)

    resolveLoad!(worktrees)
    await Promise.all([firstLoad, secondLoad])

    expect(useWorktreeStore.getState().getWorktreesForProject(projectId)).toEqual(worktrees)
  })

  it('coalesces concurrent worktree syncs for the same project', async () => {
    const projectId = 'sync-concurrent-project'
    const projectPath = '/repo/project'
    let resolveSync: (value: { success: true }) => void
    const syncPromise = new Promise<{ success: true }>((resolve) => {
      resolveSync = resolve
    })

    vi.mocked(worktreeApi.sync).mockReturnValue(syncPromise)

    const firstSync = useWorktreeStore.getState().syncWorktrees(projectId, projectPath)
    const secondSync = useWorktreeStore.getState().syncWorktrees(projectId, projectPath)

    expect(worktreeApi.sync).toHaveBeenCalledTimes(1)

    resolveSync!({ success: true })
    await Promise.all([firstSync, secondSync])

    expect(request).toHaveBeenCalledWith('db.worktree.getActiveByProject', { projectId })
    expectGetActiveByProjectCalls(1)
  })

  it('skips worktree load and sync refetches inside their TTLs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const projectId = 'ttl-project'
    const projectPath = '/repo/ttl-project'

    await useWorktreeStore.getState().loadWorktrees(projectId)
    await useWorktreeStore.getState().loadWorktrees(projectId)

    await useWorktreeStore.getState().syncWorktrees(projectId, projectPath)
    await useWorktreeStore.getState().syncWorktrees(projectId, projectPath)

    expectGetActiveByProjectCalls(2)
    expect(worktreeApi.sync).toHaveBeenCalledTimes(1)
  })

  it('allows force worktree load and sync calls to bypass their TTLs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const projectId = 'force-project'
    const projectPath = '/repo/force-project'

    await useWorktreeStore.getState().loadWorktrees(projectId)
    await useWorktreeStore.getState().loadWorktrees(projectId, { force: true })

    await useWorktreeStore.getState().syncWorktrees(projectId, projectPath)
    await useWorktreeStore.getState().syncWorktrees(projectId, projectPath, { force: true })

    expectGetActiveByProjectCalls(4)
    expect(worktreeApi.sync).toHaveBeenCalledTimes(2)
  })

  it('appends a session title locally and persists through dbApi', () => {
    const projectId = 'append-title-project'
    const worktree = makeWorktree('append-title-worktree', projectId)
    useWorktreeStore.setState({
      worktreesByProject: new Map([[projectId, [worktree]]])
    })

    useWorktreeStore.getState().appendSessionTitle(worktree.id, 'Implement RPC migration')

    expect(request).toHaveBeenCalledWith('db.worktree.appendSessionTitle', {
      worktreeId: worktree.id,
      title: 'Implement RPC migration'
    })
    expect(useWorktreeStore.getState().getWorktreesForProject(projectId)[0].session_titles).toBe(
      JSON.stringify(['Implement RPC migration'])
    )
  })

  it('prepends a live-created worktree idempotently', () => {
    const projectId = 'live-project'
    const existing = makeWorktree('existing', projectId)
    const created = makeWorktree('created', projectId)
    useWorktreeStore.setState({
      worktreesByProject: new Map([[projectId, [existing]]])
    })

    useWorktreeStore.getState().addWorktreeToProject(projectId, created)
    useWorktreeStore.getState().addWorktreeToProject(projectId, created)

    expect(useWorktreeStore.getState().getWorktreesForProject(projectId)).toEqual([
      created,
      existing
    ])
  })

  it('always runs first-ever worktree load and sync calls', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const projectId = 'first-ever-project'
    const projectPath = '/repo/first-ever-project'

    await useWorktreeStore.getState().loadWorktrees(projectId)
    await useWorktreeStore.getState().syncWorktrees(projectId, projectPath)

    expectGetActiveByProjectCalls(2)
    expect(worktreeApi.sync).toHaveBeenCalledTimes(1)
  })
})
