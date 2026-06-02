import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorktreeStore } from '../useWorktreeStore'

const envelope = <T>(value: T) => ({ success: true as const, value })

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
    useWorktreeStore.setState({
      worktreesByProject: new Map(),
      worktreeOrderByProject: new Map(),
      isLoading: false,
      error: null,
      selectedWorktreeId: null,
      creatingForProjectId: null,
      archivingWorktreeIds: new Set()
    })

    Object.defineProperty(window, 'db', {
      writable: true,
      configurable: true,
      value: {
        worktree: {
          getActiveByProject: vi.fn().mockResolvedValue(envelope([])),
          touch: vi.fn().mockResolvedValue(envelope(undefined))
        }
      }
    })

    Object.defineProperty(window, 'worktreeOps', {
      writable: true,
      configurable: true,
      value: {
        ...window.worktreeOps,
        sync: vi.fn().mockResolvedValue(envelope({ success: true }))
      }
    })
  })

  it('coalesces concurrent worktree loads for the same project', async () => {
    const projectId = 'load-concurrent-project'
    const worktrees = [makeWorktree('a', projectId)]
    let resolveLoad: (value: { success: true; value: typeof worktrees }) => void
    const loadPromise = new Promise<{ success: true; value: typeof worktrees }>((resolve) => {
      resolveLoad = resolve
    })

    vi.mocked(window.db.worktree.getActiveByProject).mockReturnValue(loadPromise)

    const firstLoad = useWorktreeStore.getState().loadWorktrees(projectId)
    const secondLoad = useWorktreeStore.getState().loadWorktrees(projectId)

    expect(window.db.worktree.getActiveByProject).toHaveBeenCalledTimes(1)

    resolveLoad!(envelope(worktrees))
    await Promise.all([firstLoad, secondLoad])

    expect(useWorktreeStore.getState().getWorktreesForProject(projectId)).toEqual(worktrees)
  })

  it('coalesces concurrent worktree syncs for the same project', async () => {
    const projectId = 'sync-concurrent-project'
    const projectPath = '/repo/project'
    let resolveSync: (value: { success: true; value: { success: true } }) => void
    const syncPromise = new Promise<{ success: true; value: { success: true } }>((resolve) => {
      resolveSync = resolve
    })

    vi.mocked(window.worktreeOps.sync).mockReturnValue(syncPromise)

    const firstSync = useWorktreeStore.getState().syncWorktrees(projectId, projectPath)
    const secondSync = useWorktreeStore.getState().syncWorktrees(projectId, projectPath)

    expect(window.worktreeOps.sync).toHaveBeenCalledTimes(1)

    resolveSync!(envelope({ success: true }))
    await Promise.all([firstSync, secondSync])

    expect(window.db.worktree.getActiveByProject).toHaveBeenCalledTimes(1)
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

    expect(window.db.worktree.getActiveByProject).toHaveBeenCalledTimes(2)
    expect(window.worktreeOps.sync).toHaveBeenCalledTimes(1)
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

    expect(window.db.worktree.getActiveByProject).toHaveBeenCalledTimes(4)
    expect(window.worktreeOps.sync).toHaveBeenCalledTimes(2)
  })

  it('always runs first-ever worktree load and sync calls', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const projectId = 'first-ever-project'
    const projectPath = '/repo/first-ever-project'

    await useWorktreeStore.getState().loadWorktrees(projectId)
    await useWorktreeStore.getState().syncWorktrees(projectId, projectPath)

    expect(window.db.worktree.getActiveByProject).toHaveBeenCalledTimes(2)
    expect(window.worktreeOps.sync).toHaveBeenCalledTimes(1)
  })
})
