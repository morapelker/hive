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
      loadedProjectIds: new Set(),
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
  describe('bulk hydrate', () => {
    const callsTo = (method: string) => request.mock.calls.filter(([m]) => m === method)

    it('fills every project from one query and marks them loaded', async () => {
      const rows = [
        makeWorktree('a1', 'hydrate-a'),
        { ...makeWorktree('a-default', 'hydrate-a'), is_default: true },
        makeWorktree('a2', 'hydrate-a'),
        makeWorktree('b1', 'hydrate-b')
      ]
      request.mockImplementation((method) =>
        Promise.resolve(method === 'db.worktree.getAllActive' ? rows : [])
      )

      await useWorktreeStore.getState().hydrateAllWorktrees()

      const state = useWorktreeStore.getState()
      expect(callsTo('db.worktree.getAllActive')).toHaveLength(1)
      expectGetActiveByProjectCalls(0)
      expect(state.worktreesByProject.get('hydrate-a')?.map((w) => w.id)).toEqual([
        'a1',
        'a2',
        'a-default'
      ])
      expect(state.worktreesByProject.get('hydrate-b')?.map((w) => w.id)).toEqual(['b1'])
      expect([...state.loadedProjectIds].sort()).toEqual(['hydrate-a', 'hydrate-b'])
    })

    it('never triggers a git sync', async () => {
      request.mockImplementation((method) =>
        Promise.resolve(
          method === 'db.worktree.getAllActive' ? [makeWorktree('s1', 'hydrate-nosync')] : []
        )
      )
      await useWorktreeStore.getState().hydrateAllWorktrees()
      expect(worktreeApi.sync).not.toHaveBeenCalled()
    })

    it('leaves an already-loaded project untouched', async () => {
      const projectId = 'hydrate-already-loaded'
      const fresh = [makeWorktree('fresh-1', projectId), makeWorktree('fresh-2', projectId)]
      request.mockImplementation((method) => {
        if (method === 'db.worktree.getActiveByProject') return Promise.resolve(fresh)
        // Older snapshot that predates fresh-2.
        if (method === 'db.worktree.getAllActive') return Promise.resolve([fresh[0]])
        return Promise.resolve([])
      })

      await useWorktreeStore.getState().loadWorktrees(projectId)
      const before = useWorktreeStore.getState().worktreesByProject.get(projectId)
      await useWorktreeStore.getState().hydrateAllWorktrees()

      expect(useWorktreeStore.getState().worktreesByProject.get(projectId)).toBe(before)
      expect(before).toHaveLength(2)
    })

    it('keeps a worktree added to the store while the query was in flight', async () => {
      const projectId = 'hydrate-inflight-insert'
      let resolveAll: (rows: unknown[]) => void
      const allPromise = new Promise<unknown[]>((resolve) => {
        resolveAll = resolve
      })
      request.mockImplementation((method) =>
        method === 'db.worktree.getAllActive' ? allPromise : Promise.resolve([])
      )

      const hydrate = useWorktreeStore.getState().hydrateAllWorktrees()
      useWorktreeStore.setState({
        worktreesByProject: new Map([[projectId, [makeWorktree('created-mid-flight', projectId)]]])
      })
      resolveAll!([makeWorktree('from-db', projectId)])
      await hydrate

      expect(
        useWorktreeStore
          .getState()
          .worktreesByProject.get(projectId)
          ?.map((w) => w.id)
      ).toEqual(['created-mid-flight', 'from-db'])
    })

    it('coalesces concurrent hydrates', async () => {
      await Promise.all([
        useWorktreeStore.getState().hydrateAllWorktrees(),
        useWorktreeStore.getState().hydrateAllWorktrees()
      ])
      expect(callsTo('db.worktree.getAllActive')).toHaveLength(1)
    })
  })

  describe('loaded tracking', () => {
    it('marks a project loaded only once its full list has been fetched', async () => {
      const projectId = 'loaded-tracking-project'
      expect(useWorktreeStore.getState().loadedProjectIds.has(projectId)).toBe(false)
      await useWorktreeStore.getState().loadWorktrees(projectId)
      expect(useWorktreeStore.getState().loadedProjectIds.has(projectId)).toBe(true)
    })

    it('fetches the full list when a worktree is added to a never-loaded project', async () => {
      const projectId = 'partial-insert-project'
      const created = makeWorktree('created', projectId)
      const existing = makeWorktree('existing', projectId)
      request.mockImplementation((method) =>
        Promise.resolve(method === 'db.worktree.getActiveByProject' ? [created, existing] : [])
      )

      useWorktreeStore.getState().addWorktreeToProject(projectId, created)
      await vi.waitFor(() =>
        expect(useWorktreeStore.getState().loadedProjectIds.has(projectId)).toBe(true)
      )

      expect(
        useWorktreeStore
          .getState()
          .worktreesByProject.get(projectId)
          ?.map((w) => w.id)
          .sort()
      ).toEqual(['created', 'existing'])
      expectGetActiveByProjectCalls(1)
    })

    it('does not refetch when a worktree is added to a loaded project', async () => {
      const projectId = 'loaded-insert-project'
      await useWorktreeStore.getState().loadWorktrees(projectId)
      useWorktreeStore.getState().addWorktreeToProject(projectId, makeWorktree('new', projectId))
      expectGetActiveByProjectCalls(1)
      expect(useWorktreeStore.getState().worktreesByProject.get(projectId)).toHaveLength(1)
    })
  })
})
