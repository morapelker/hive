import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/connection-api', () => ({
  connectionApi: {
    create: vi.fn(),
    get: vi.fn(),
    rename: vi.fn()
  }
}))
vi.mock('@/api/worktree-api', () => ({
  worktreeApi: {
    createFromBranch: vi.fn(),
    delete: vi.fn()
  }
}))

import { connectionApi } from '@/api/connection-api'
import { worktreeApi } from '@/api/worktree-api'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { resolveConnectionForLaunch } from './connection-project-launch'
import type { WorktreeNameSet } from './connection-project'

const SAVED_ID = 'saved-project-1'

const makeConnection = (
  id: string,
  worktreeIds: string[],
  savedProjectId: string | null = SAVED_ID
) =>
  ({
    id,
    name: 'a + b',
    custom_name: null,
    status: 'active' as const,
    path: `/tmp/connections/${id}`,
    color: null,
    saved_project_id: savedProjectId,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    members: worktreeIds.map((worktreeId, i) => ({
      id: `m-${id}-${i}`,
      connection_id: id,
      worktree_id: worktreeId,
      project_id: `p${i}`,
      symlink_name: `p${i}`,
      added_at: '2026-01-01',
      worktree_name: 'wt',
      worktree_branch: 'wt',
      worktree_path: `/tmp/wt/${worktreeId}`,
      project_name: `p${i}`
    }))
  }) as never

const memberProjects = [
  { id: 'pa', path: '/tmp/alpha', name: 'alpha' },
  { id: 'pb', path: '/tmp/beta', name: 'beta' }
]

const makeWorktree = (
  id: string,
  projectId: string,
  name: string,
  extra: Record<string, unknown> = {}
) =>
  ({
    id,
    project_id: projectId,
    name,
    branch_name: name,
    path: `/tmp/wt/${projectId}/${name}`,
    status: 'active',
    is_default: false,
    ...extra
  }) as never

describe('resolveConnectionForLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useConnectionStore.setState({ connections: [] })
    useWorktreeStore.setState({ worktreesByProject: new Map() })
  })

  it('existing-connection target returns the live instance without creating anything', async () => {
    useConnectionStore.setState({ connections: [makeConnection('conn-1', ['w1', 'w2'])] })

    const result = await resolveConnectionForLaunch({
      savedProjectId: SAVED_ID,
      memberProjects,
      target: { type: 'existing-connection', connectionId: 'conn-1' }
    })

    expect(result).toEqual({ connectionId: 'conn-1', connectionPath: '/tmp/connections/conn-1' })
    expect(connectionApi.create).not.toHaveBeenCalled()
  })

  it('name-set target reuses an instance whose worktree set matches exactly', async () => {
    useConnectionStore.setState({
      connections: [
        makeConnection('other', ['w1', 'w2'], null), // ad-hoc — never reused
        makeConnection('inst', ['w1', 'w2'])
      ]
    })
    const nameSet: WorktreeNameSet = {
      name: 'ticket-x',
      worktrees: [
        { projectId: 'pa', worktreeId: 'w1', worktreePath: '/tmp/wt/pa/ticket-x' },
        { projectId: 'pb', worktreeId: 'w2', worktreePath: '/tmp/wt/pb/ticket-x' }
      ]
    }

    const result = await resolveConnectionForLaunch({
      savedProjectId: SAVED_ID,
      memberProjects,
      target: { type: 'name-set', nameSet }
    })

    expect(result.connectionId).toBe('inst')
    expect(connectionApi.create).not.toHaveBeenCalled()
  })

  it('name-set target creates a linked connection when no instance matches', async () => {
    vi.mocked(connectionApi.create).mockResolvedValue({
      success: true,
      connection: makeConnection('fresh', ['w1', 'w2'])
    } as never)

    const nameSet: WorktreeNameSet = {
      name: 'ticket-x',
      worktrees: [
        { projectId: 'pa', worktreeId: 'w1', worktreePath: '/tmp/wt/pa/ticket-x' },
        { projectId: 'pb', worktreeId: 'w2', worktreePath: '/tmp/wt/pb/ticket-x' }
      ]
    }

    const result = await resolveConnectionForLaunch({
      savedProjectId: SAVED_ID,
      memberProjects,
      target: { type: 'name-set', nameSet }
    })

    expect(connectionApi.create).toHaveBeenCalledExactlyOnceWith(['w1', 'w2'], {
      savedProjectId: SAVED_ID
    })
    expect(result.connectionId).toBe('fresh')
    // Inserted into the store without selection
    expect(useConnectionStore.getState().connections.some((c) => c.id === 'fresh')).toBe(true)
    expect(useConnectionStore.getState().selectedConnectionId).not.toBe('fresh')
  })

  it('new target creates a worktree per member off its default branch, then connects them', async () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        ['pa', [makeWorktree('da', 'pa', 'main', { is_default: true, branch_name: 'main' })]],
        ['pb', [makeWorktree('db', 'pb', 'develop', { is_default: true, branch_name: 'develop' })]]
      ])
    })
    const loadWorktrees = vi.fn().mockResolvedValue(undefined)
    useWorktreeStore.setState({ loadWorktrees } as never)

    vi.mocked(worktreeApi.createFromBranch)
      .mockResolvedValueOnce({
        success: true,
        worktree: makeWorktree('na', 'pa', 'ticket-x')
      } as never)
      .mockResolvedValueOnce({
        success: true,
        worktree: makeWorktree('nb', 'pb', 'ticket-x')
      } as never)
    vi.mocked(connectionApi.create).mockResolvedValue({
      success: true,
      connection: makeConnection('inst-new', ['na', 'nb'])
    } as never)

    const result = await resolveConnectionForLaunch({
      savedProjectId: SAVED_ID,
      memberProjects,
      target: { type: 'new' },
      nameHint: 'ticket-x'
    })

    expect(worktreeApi.createFromBranch).toHaveBeenNthCalledWith(1, {
      projectId: 'pa',
      projectPath: '/tmp/alpha',
      projectName: 'alpha',
      branchName: 'main',
      nameHint: 'ticket-x'
    })
    expect(worktreeApi.createFromBranch).toHaveBeenNthCalledWith(2, {
      projectId: 'pb',
      projectPath: '/tmp/beta',
      projectName: 'beta',
      branchName: 'develop',
      nameHint: 'ticket-x'
    })
    expect(connectionApi.create).toHaveBeenCalledExactlyOnceWith(['na', 'nb'], {
      savedProjectId: SAVED_ID
    })
    expect(result.connectionId).toBe('inst-new')
  })

  it('new target rolls back already-created worktrees when a later create fails', async () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        ['pa', [makeWorktree('da', 'pa', 'main', { is_default: true, branch_name: 'main' })]],
        ['pb', [makeWorktree('db', 'pb', 'main', { is_default: true, branch_name: 'main' })]]
      ]),
      loadWorktrees: vi.fn().mockResolvedValue(undefined) as never
    })

    const createdWorktree = makeWorktree('na', 'pa', 'ticket-x') as { id: string; path: string }
    vi.mocked(worktreeApi.createFromBranch)
      .mockResolvedValueOnce({ success: true, worktree: createdWorktree } as never)
      .mockResolvedValueOnce({ success: false, error: 'boom' } as never)
    vi.mocked(worktreeApi.delete).mockResolvedValue({ success: true } as never)

    const result = await resolveConnectionForLaunch({
      savedProjectId: SAVED_ID,
      memberProjects,
      target: { type: 'new' },
      nameHint: 'ticket-x'
    })

    expect(result.connectionId).toBeUndefined()
    expect(result.error).toContain('beta')
    expect(worktreeApi.delete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ worktreeId: 'na', archive: false })
    )
    expect(connectionApi.create).not.toHaveBeenCalled()
  })

  it('new target fails fast with fewer than 2 member projects', async () => {
    const result = await resolveConnectionForLaunch({
      savedProjectId: SAVED_ID,
      memberProjects: [memberProjects[0]],
      target: { type: 'new' }
    })
    expect(result.error).toMatch(/at least 2/)
    expect(worktreeApi.createFromBranch).not.toHaveBeenCalled()
  })
})
