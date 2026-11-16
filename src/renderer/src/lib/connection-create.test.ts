import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    updateSettings: vi.fn()
  }
}))

const worktreeStoreMocks = vi.hoisted(() => ({
  addWorktreeToProject: vi.fn(),
  removeWorktreeFromProject: vi.fn(),
  createWorktree: vi.fn(),
  fireSetupScript: vi.fn()
}))

vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map(),
      loadWorktrees: vi.fn(),
      addWorktreeToProject: worktreeStoreMocks.addWorktreeToProject,
      removeWorktreeFromProject: worktreeStoreMocks.removeWorktreeFromProject,
      createWorktree: worktreeStoreMocks.createWorktree
    }))
  },
  fireSetupScript: worktreeStoreMocks.fireSetupScript
}))

vi.mock('@/stores/useKanbanStore', () => ({
  useKanbanStore: {
    getState: vi.fn(() => ({
      isPinnedBoardActive: false,
      togglePinnedBoard: vi.fn(),
      closePinnedBoard: vi.fn()
    }))
  }
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

import { useConnectionStore } from '@/stores/useConnectionStore'
import { toast } from '@/lib/toast'
import {
  CONNECTION_MAX_PROJECTS,
  connectableProjects,
  createConnectionFromProjects,
  describePullFailure,
  insertConnectionLocally
} from './connection-create'

const projects = [
  { id: 'project-1', path: '/tmp/project-1', name: 'Project 1' },
  { id: 'project-2', path: '/tmp/project-2', name: 'Project 2' }
]

const worktreeFor = (projectId: string): Record<string, unknown> => ({
  id: `worktree-${projectId}`,
  project_id: projectId,
  name: `wt-${projectId}`,
  branch_name: `branch-${projectId}`,
  path: `/tmp/${projectId}/wt`,
  status: 'active',
  is_default: false,
  branch_renamed: 0,
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
  base_branch: null,
  created_at: '2026-05-28T00:00:00.000Z',
  last_accessed_at: '2026-05-28T00:00:00.000Z'
})

const connectionFor = (
  worktreeIds: string[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id: 'connection-created',
  name: 'Project 1 + Project 2',
  custom_name: null,
  status: 'active',
  path: '/tmp/created-connection',
  color: null,
  pinned: 0,
  saved_project_id: null,
  created_at: '2026-05-28T00:00:00.000Z',
  updated_at: '2026-05-28T00:00:00.000Z',
  members: worktreeIds.map((worktreeId, index) => ({
    id: `member-${index + 1}`,
    connection_id: 'connection-created',
    worktree_id: worktreeId,
    project_id: `project-${index + 1}`,
    symlink_name: `worktree-${index + 1}`,
    added_at: '2026-05-28T00:00:00.000Z',
    worktree_name: `Worktree ${index + 1}`,
    worktree_branch: `branch-${index + 1}`,
    worktree_path: `/tmp/worktree-${index + 1}`,
    project_name: `Project ${index + 1}`
  })),
  ...extra
})

/** The happy path: every worktree create succeeds and the connection has every member. */
const happyPath = async (method: string, params?: unknown): Promise<unknown> => {
  if (method === 'worktreeOps.create') {
    const { projectId } = params as { projectId: string }
    return { success: true, worktree: worktreeFor(projectId) }
  }
  if (method === 'worktreeOps.delete') {
    return { success: true }
  }
  if (method === 'connectionOps.create') {
    const { worktreeIds } = params as { worktreeIds: string[] }
    return { success: true, connection: connectionFor(worktreeIds) }
  }
  if (method === 'connectionOps.delete') {
    return { success: true }
  }
  return null
}

const callsTo = (request: ReturnType<typeof vi.fn>, method: string): unknown[] =>
  request.mock.calls.filter(([m]) => m === method).map(([, params]) => params)

describe('connectableProjects', () => {
  it('keeps order and drops duplicates and connection-kind projects', () => {
    const input = [
      { id: 'project-2', path: '/tmp/project-2', name: 'Project 2', kind: 'git' as const },
      { id: 'connection-project', path: '/tmp/conn', name: 'Conn', kind: 'connection' as const },
      { id: 'project-1', path: '/tmp/project-1', name: 'Project 1', kind: null },
      { id: 'project-2', path: '/tmp/project-2-again', name: 'Project 2 again' },
      { id: 'project-3', path: '/tmp/project-3', name: 'Project 3' }
    ]

    expect(connectableProjects(input)).toEqual([input[0], input[2], input[4]])
  })

  it('returns an empty list for an empty input', () => {
    expect(connectableProjects([])).toEqual([])
  })
})

describe('insertConnectionLocally', () => {
  beforeEach(() => {
    useConnectionStore.setState({ connections: [], selectedConnectionId: 'connection-other' })
  })

  it('appends the connection without selecting it, and never twice', () => {
    insertConnectionLocally({ id: 'connection-new', members: [] })
    insertConnectionLocally({ id: 'connection-new', members: [] })

    expect(useConnectionStore.getState().connections).toEqual([
      expect.objectContaining({ id: 'connection-new' })
    ])
    expect(useConnectionStore.getState().selectedConnectionId).toBe('connection-other')
  })
})

describe('createConnectionFromProjects', () => {
  let request: ReturnType<typeof vi.fn>
  let saveConnectionAsProject: ReturnType<typeof vi.fn>

  beforeEach(() => {
    request = vi.fn(happyPath)
    setRendererRpcClient({ request, subscribe: vi.fn() })
    saveConnectionAsProject = vi.fn(async () => 'saved-project-1')
    useConnectionStore.setState({
      connections: [],
      selectedConnectionId: 'connection-other',
      isLoading: false,
      error: null,
      loaded: false,
      saveConnectionAsProject
    } as never)
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.success).mockClear()
    worktreeStoreMocks.addWorktreeToProject.mockClear()
    worktreeStoreMocks.removeWorktreeFromProject.mockClear()
    worktreeStoreMocks.createWorktree.mockClear()
    worktreeStoreMocks.fireSetupScript.mockClear()
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  describe('input validation', () => {
    it('rejects a single project without any RPC call', async () => {
      const result = await createConnectionFromProjects([projects[0]])

      expect(result).toEqual({
        ok: false,
        error: 'A connection needs at least 2 different projects.'
      })
      expect(request).not.toHaveBeenCalled()
      expect(worktreeStoreMocks.addWorktreeToProject).not.toHaveBeenCalled()
      expect(useConnectionStore.getState().connections).toEqual([])
    })

    it('rejects the same project given twice', async () => {
      const result = await createConnectionFromProjects([
        projects[0],
        { ...projects[0], path: '/tmp/elsewhere' }
      ])

      expect(result).toEqual({ ok: false, error: expect.stringContaining('at least 2') })
      expect(request).not.toHaveBeenCalled()
    })

    it('does not count connection projects towards the minimum', async () => {
      const result = await createConnectionFromProjects([
        projects[0],
        { id: 'connection-project', path: '/tmp/conn', name: 'Conn', kind: 'connection' }
      ])

      expect(result).toEqual({ ok: false, error: expect.stringContaining('at least 2') })
      expect(request).not.toHaveBeenCalled()
    })

    // CONNECTION_MAX_PROJECTS caps the agent and the phone in their own schemas; the desktop
    // dialog (and Duplicate / a connection project's new instance) was never capped.
    it('enforces no maximum of its own', async () => {
      const many = Array.from({ length: CONNECTION_MAX_PROJECTS + 1 }, (_, i) => ({
        id: `project-${i + 1}`,
        path: `/tmp/project-${i + 1}`,
        name: `Project ${i + 1}`
      }))

      const result = await createConnectionFromProjects(many)

      expect(result).toMatchObject({ ok: true, connectionId: 'connection-created' })
      expect(callsTo(request, 'worktreeOps.create')).toHaveLength(CONNECTION_MAX_PROJECTS + 1)
    })
  })

  describe('autoPull', () => {
    const base = [
      { projectId: 'project-1', projectPath: '/tmp/project-1', projectName: 'Project 1' },
      { projectId: 'project-2', projectPath: '/tmp/project-2', projectName: 'Project 2' }
    ]

    /** Every project's checkout is on main and its pull goes through, unless `overrides` says otherwise. */
    const withGit =
      (overrides: (method: string, params: Record<string, unknown>) => unknown = () => undefined) =>
      async (method: string, params?: unknown): Promise<unknown> => {
        const answer = overrides(method, (params ?? {}) as Record<string, unknown>)
        if (answer !== undefined) return answer
        if (method === 'gitOps.getBranchInfo') {
          return { success: true, branch: { name: 'main', tracking: null, ahead: 0, behind: 0 } }
        }
        if (method === 'gitOps.syncBranchWithOrigin') {
          return { success: true, updated: true }
        }
        return happyPath(method, params)
      }

    const methodsCalled = (): string[] => request.mock.calls.map(([method]) => method as string)

    it('sends no autoPull and pulls nothing itself when the option is left out, so the setting decides', async () => {
      await createConnectionFromProjects(projects)

      expect(callsTo(request, 'worktreeOps.create')).toEqual(base)
      for (const params of callsTo(request, 'worktreeOps.create')) {
        expect(params).not.toHaveProperty('autoPull')
      }
      expect(callsTo(request, 'gitOps.syncBranchWithOrigin')).toEqual([])
    })

    it('with autoPull: false, pulls nothing and tells every worktree create not to either', async () => {
      const result = await createConnectionFromProjects(projects, { autoPull: false })

      expect(result).toMatchObject({ ok: true })
      expect(callsTo(request, 'gitOps.getBranchInfo')).toEqual([])
      expect(callsTo(request, 'gitOps.syncBranchWithOrigin')).toEqual([])
      expect(callsTo(request, 'worktreeOps.create')).toEqual(
        base.map((params) => ({ ...params, autoPull: false }))
      )
    })

    it("with autoPull: true, pulls every project's current branch before the first worktree is created", async () => {
      request.mockImplementation(
        withGit((method, params) =>
          method === 'gitOps.getBranchInfo' && params.worktreePath === '/tmp/project-2'
            ? { success: true, branch: { name: 'develop', tracking: null, ahead: 0, behind: 0 } }
            : undefined
        )
      )

      const result = await createConnectionFromProjects(projects, { autoPull: true })

      expect(result).toMatchObject({ ok: true, connectionId: 'connection-created' })
      expect(callsTo(request, 'gitOps.syncBranchWithOrigin')).toEqual([
        { worktreePath: '/tmp/project-1', branch: 'main' },
        { worktreePath: '/tmp/project-2', branch: 'develop' }
      ])
      const methods = methodsCalled()
      expect(methods.lastIndexOf('gitOps.syncBranchWithOrigin')).toBeLessThan(
        methods.indexOf('worktreeOps.create')
      )
      // Already pulled: the create must not pull a second time
      expect(callsTo(request, 'worktreeOps.create')).toEqual(
        base.map((params) => ({ ...params, autoPull: false }))
      )
    })

    it('waits for the slowest pull before creating any worktree', async () => {
      let finishSlowPull: (value: unknown) => void = () => {}
      request.mockImplementation(
        withGit((method, params) =>
          method === 'gitOps.syncBranchWithOrigin' && params.worktreePath === '/tmp/project-1'
            ? new Promise((resolve) => {
                finishSlowPull = resolve
              })
            : undefined
        )
      )

      const creating = createConnectionFromProjects(projects, { autoPull: true })
      await vi.waitFor(() =>
        expect(callsTo(request, 'gitOps.syncBranchWithOrigin')).toHaveLength(2)
      )
      // Project 2 is pulled, project 1 is not yet: nothing may be created
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(callsTo(request, 'worktreeOps.create')).toEqual([])

      finishSlowPull({ success: true, updated: false })

      expect(await creating).toMatchObject({ ok: true })
      expect(callsTo(request, 'worktreeOps.create')).toHaveLength(2)
    })

    it('creates nothing when a pull fails, and says which project and why', async () => {
      request.mockImplementation(
        withGit((method, params) =>
          method === 'gitOps.syncBranchWithOrigin' && params.worktreePath === '/tmp/project-2'
            ? {
                success: false,
                updated: false,
                error:
                  "hint: Diverging branches can't be fast-forwarded\nfatal: Not possible to fast-forward, aborting."
              }
            : undefined
        )
      )

      const result = await createConnectionFromProjects(projects, { autoPull: true })

      expect(result).toEqual({
        ok: false,
        error:
          'Could not pull "Project 2": local main has commits that origin/main does not, so it cannot be fast-forwarded'
      })
      expect(callsTo(request, 'worktreeOps.create')).toEqual([])
      expect(callsTo(request, 'connectionOps.create')).toEqual([])
      expect(worktreeStoreMocks.addWorktreeToProject).not.toHaveBeenCalled()
      expect(useConnectionStore.getState().connections).toEqual([])
    })

    it('names every project whose pull failed, one per line', async () => {
      request.mockImplementation(
        withGit((method, params) => {
          if (method !== 'gitOps.syncBranchWithOrigin') return undefined
          return params.worktreePath === '/tmp/project-1'
            ? {
                success: false,
                updated: false,
                error: "fatal: unable to access 'https://x/': Could not resolve host: x"
              }
            : { success: false, updated: false }
        })
      )

      const result = await createConnectionFromProjects(projects, { autoPull: true })

      expect(result).toEqual({
        ok: false,
        error:
          'Could not pull "Project 1": unable to access \'https://x/\': Could not resolve host: x\n' +
          'Could not pull "Project 2": git pull failed'
      })
      expect(callsTo(request, 'worktreeOps.create')).toEqual([])
    })

    it('fails the pull of a project whose current branch cannot be read or whose pull throws', async () => {
      request.mockImplementation(
        withGit((method, params) => {
          if (method === 'gitOps.getBranchInfo' && params.worktreePath === '/tmp/project-1') {
            return { success: false, error: 'not a git repository' }
          }
          if (method === 'gitOps.syncBranchWithOrigin') throw new Error('RPC connection lost')
          return undefined
        })
      )

      const result = await createConnectionFromProjects(projects, { autoPull: true })

      expect(result).toEqual({
        ok: false,
        error:
          'Could not pull "Project 1": not a git repository\n' +
          'Could not pull "Project 2": RPC connection lost'
      })
      expect(callsTo(request, 'worktreeOps.create')).toEqual([])
    })

    it('has nothing to pull on a detached HEAD and goes on to create the worktrees', async () => {
      request.mockImplementation(
        withGit((method) =>
          method === 'gitOps.getBranchInfo'
            ? { success: true, branch: { name: 'HEAD', tracking: null, ahead: 0, behind: 0 } }
            : undefined
        )
      )

      const result = await createConnectionFromProjects(projects, { autoPull: true })

      expect(result).toMatchObject({ ok: true })
      expect(callsTo(request, 'gitOps.syncBranchWithOrigin')).toEqual([])
      expect(callsTo(request, 'worktreeOps.create')).toHaveLength(2)
    })

    describe('onProgress', () => {
      const progressOf = async (
        opts: Parameters<typeof createConnectionFromProjects>[1]
      ): Promise<string[]> => {
        const seen: string[] = []
        await createConnectionFromProjects(projects, {
          ...opts,
          onProgress: ({ projectId, step, status, error }) =>
            seen.push(`${step} ${projectId} ${status}${error ? `: ${error}` : ''}`)
        })
        return seen
      }

      it('reports every pull, then every worktree', async () => {
        request.mockImplementation(withGit())

        const seen = await progressOf({ autoPull: true })

        expect(seen.slice().sort()).toEqual(
          [
            'pull project-1 running',
            'pull project-1 done',
            'pull project-2 running',
            'pull project-2 done',
            'worktree project-1 running',
            'worktree project-1 done',
            'worktree project-2 running',
            'worktree project-2 done'
          ].sort()
        )
        // No worktree step before the last pull has ended; worktrees one at a time, in order
        expect(seen.slice(0, 4).every((line) => line.startsWith('pull '))).toBe(true)
        expect(seen.slice(4)).toEqual([
          'worktree project-1 running',
          'worktree project-1 done',
          'worktree project-2 running',
          'worktree project-2 done'
        ])
      })

      it('reports only the worktrees when there is no pull', async () => {
        expect(await progressOf({ autoPull: false })).toEqual([
          'worktree project-1 running',
          'worktree project-1 done',
          'worktree project-2 running',
          'worktree project-2 done'
        ])
      })

      it('reports the pull that failed with its reason, and no worktree step after it', async () => {
        request.mockImplementation(
          withGit((method, params) =>
            method === 'gitOps.syncBranchWithOrigin' && params.worktreePath === '/tmp/project-2'
              ? { success: false, updated: false, error: 'fatal: boom' }
              : undefined
          )
        )

        const seen = await progressOf({ autoPull: true })

        expect(seen).toContain('pull project-1 done')
        expect(seen).toContain('pull project-2 failed: boom')
        expect(seen.some((line) => line.startsWith('worktree '))).toBe(false)
      })

      it('reports the worktree that could not be created', async () => {
        request.mockImplementation(async (method: string, params?: unknown) => {
          if (
            method === 'worktreeOps.create' &&
            (params as { projectId: string }).projectId === 'project-2'
          ) {
            return { success: false, error: 'disk full' }
          }
          return happyPath(method, params)
        })

        expect(await progressOf({ autoPull: false })).toEqual([
          'worktree project-1 running',
          'worktree project-1 done',
          'worktree project-2 running',
          'worktree project-2 failed: disk full'
        ])
      })
    })
  })

  describe('describePullFailure', () => {
    it.each([
      [
        "hint: Diverging branches can't be fast-forwarded, you need to either:\nfatal: Not possible to fast-forward, aborting.",
        'local main has commits that origin/main does not, so it cannot be fast-forwarded'
      ],
      [
        'error: Your local changes to the following files would be overwritten by merge:\n\ttracked.txt\nPlease commit your changes or stash them before you merge.\nAborting',
        'uncommitted changes on main conflict with the incoming commits'
      ],
      [
        'error: Pulling is not possible because you have unmerged files.\nhint: Fix them up in the work tree',
        'main has a merge with unresolved conflicts'
      ],
      ['block timeout reached', 'origin stopped responding'],
      [
        "From github.com:acme/web\nfatal: couldn't find remote ref main",
        "couldn't find remote ref main"
      ],
      ['GitNetworkError', 'GitNetworkError'],
      [undefined, 'git pull failed'],
      ['', 'git pull failed']
    ])('%j', (gitError, expected) => {
      expect(describePullFailure('main', gitError)).toBe(expected)
    })
  })

  describe('success', () => {
    it('creates a worktree per project in order, then one connection, without selecting anything', async () => {
      const result = await createConnectionFromProjects(projects)

      expect(result).toEqual({
        ok: true,
        connectionId: 'connection-created',
        connectionName: 'Project 1 + Project 2',
        connectionPath: '/tmp/created-connection',
        savedProjectId: null
      })

      expect(callsTo(request, 'worktreeOps.create')).toEqual([
        { projectId: 'project-1', projectPath: '/tmp/project-1', projectName: 'Project 1' },
        { projectId: 'project-2', projectPath: '/tmp/project-2', projectName: 'Project 2' }
      ])
      // No savedProjectId option -> none is sent.
      expect(callsTo(request, 'connectionOps.create')).toEqual([
        { worktreeIds: ['worktree-project-1', 'worktree-project-2'] }
      ])

      expect(worktreeStoreMocks.addWorktreeToProject).toHaveBeenCalledTimes(2)
      expect(worktreeStoreMocks.addWorktreeToProject).toHaveBeenNthCalledWith(
        1,
        'project-1',
        expect.objectContaining({ id: 'worktree-project-1' })
      )
      expect(worktreeStoreMocks.addWorktreeToProject).toHaveBeenNthCalledWith(
        2,
        'project-2',
        expect.objectContaining({ id: 'worktree-project-2' })
      )
      expect(worktreeStoreMocks.fireSetupScript).toHaveBeenCalledTimes(2)
      expect(worktreeStoreMocks.fireSetupScript).toHaveBeenNthCalledWith(
        1,
        'project-1',
        'worktree-project-1',
        '/tmp/project-1/wt'
      )
      expect(worktreeStoreMocks.fireSetupScript).toHaveBeenNthCalledWith(
        2,
        'project-2',
        'worktree-project-2',
        '/tmp/project-2/wt'
      )
      // Setup scripts only fire once every worktree create has succeeded — every
      // addWorktreeToProject call happens before the first fireSetupScript call.
      const lastAddCallOrder = Math.max(
        ...worktreeStoreMocks.addWorktreeToProject.mock.invocationCallOrder
      )
      const firstFireCallOrder = Math.min(
        ...worktreeStoreMocks.fireSetupScript.mock.invocationCallOrder
      )
      expect(firstFireCallOrder).toBeGreaterThan(lastAddCallOrder)

      // Inserted into the store WITHOUT selecting it, and never via the selecting action.
      expect(useConnectionStore.getState().connections).toEqual([
        expect.objectContaining({ id: 'connection-created', name: 'Project 1 + Project 2' })
      ])
      expect(useConnectionStore.getState().selectedConnectionId).toBe('connection-other')
      expect(worktreeStoreMocks.createWorktree).not.toHaveBeenCalled()
      expect(worktreeStoreMocks.removeWorktreeFromProject).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalledWith('worktreeOps.delete', expect.anything())
      expect(request).not.toHaveBeenCalledWith('connectionOps.rename', expect.anything())
      expect(saveConnectionAsProject).not.toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
    })

    it('passes savedProjectId to connectionOps.create and reports it without saving again', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'connectionOps.create') {
          const { worktreeIds, savedProjectId } = params as {
            worktreeIds: string[]
            savedProjectId?: string
          }
          return {
            success: true,
            connection: connectionFor(worktreeIds, { saved_project_id: savedProjectId ?? null })
          }
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects, {
        savedProjectId: 'saved-project-existing',
        saveAsProject: true
      })

      expect(callsTo(request, 'connectionOps.create')).toEqual([
        {
          worktreeIds: ['worktree-project-1', 'worktree-project-2'],
          savedProjectId: 'saved-project-existing'
        }
      ])
      expect(result).toMatchObject({ ok: true, savedProjectId: 'saved-project-existing' })
      // The connection already belongs to a connection project: nothing to save.
      expect(saveConnectionAsProject).not.toHaveBeenCalled()
    })

    it('ignores duplicate and connection-kind projects when deciding what to create', async () => {
      const result = await createConnectionFromProjects([
        projects[0],
        { id: 'connection-project', path: '/tmp/conn', name: 'Conn', kind: 'connection' },
        { ...projects[0], name: 'Project 1 duplicate' },
        projects[1]
      ])

      expect(result).toMatchObject({ ok: true })
      expect(callsTo(request, 'worktreeOps.create')).toEqual([
        { projectId: 'project-1', projectPath: '/tmp/project-1', projectName: 'Project 1' },
        { projectId: 'project-2', projectPath: '/tmp/project-2', projectName: 'Project 2' }
      ])
    })
  })

  describe('worktree create failures', () => {
    it('rolls back earlier worktrees, skips the connection and never fires setup scripts', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'worktreeOps.create') {
          const { projectId } = params as { projectId: string }
          if (projectId === 'project-2') {
            return { success: false, error: 'disk full' }
          }
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects)

      expect(result).toEqual({
        ok: false,
        error: 'Failed to create worktree in "Project 2": disk full'
      })
      // The first (successful) worktree is deleted, non-archiving, and dropped from the store.
      expect(callsTo(request, 'worktreeOps.delete')).toEqual([
        {
          worktreeId: 'worktree-project-1',
          worktreePath: '/tmp/project-1/wt',
          branchName: 'branch-project-1',
          projectPath: '/tmp/project-1',
          archive: false
        }
      ])
      expect(worktreeStoreMocks.removeWorktreeFromProject).toHaveBeenCalledTimes(1)
      expect(worktreeStoreMocks.removeWorktreeFromProject).toHaveBeenCalledWith(
        'project-1',
        'worktree-project-1'
      )
      expect(request).not.toHaveBeenCalledWith('connectionOps.create', expect.anything())
      expect(worktreeStoreMocks.fireSetupScript).not.toHaveBeenCalled()
      expect(useConnectionStore.getState().connections).toEqual([])
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('keeps a rolled-back worktree in the store when its delete fails', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'worktreeOps.create') {
          const { projectId } = params as { projectId: string }
          if (projectId === 'project-2') {
            return { success: false, error: 'disk full' }
          }
        }
        if (method === 'worktreeOps.delete') {
          return { success: false, error: 'delete failed' }
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects)

      expect(result).toMatchObject({ ok: false })
      expect(callsTo(request, 'worktreeOps.delete')).toHaveLength(1)
      // The delete failed, so the worktree still exists — it must stay visible in the sidebar.
      expect(worktreeStoreMocks.removeWorktreeFromProject).not.toHaveBeenCalled()
      expect(worktreeStoreMocks.fireSetupScript).not.toHaveBeenCalled()
    })

    it('treats a thrown RPC error like a failed create', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'worktreeOps.create') {
          const { projectId } = params as { projectId: string }
          if (projectId === 'project-2') {
            throw new Error('relay offline')
          }
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects)

      expect(result).toEqual({
        ok: false,
        error: 'Failed to create worktree in "Project 2": relay offline'
      })
      expect(callsTo(request, 'worktreeOps.delete')).toEqual([
        expect.objectContaining({ worktreeId: 'worktree-project-1', archive: false })
      ])
      expect(request).not.toHaveBeenCalledWith('connectionOps.create', expect.anything())
      expect(worktreeStoreMocks.fireSetupScript).not.toHaveBeenCalled()
    })

    it('reports a success without a worktree as a failure', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'worktreeOps.create') {
          const { projectId } = params as { projectId: string }
          if (projectId === 'project-1') {
            return { success: true }
          }
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects)

      expect(result).toEqual({
        ok: false,
        error: 'Failed to create worktree in "Project 1": Unknown error'
      })
      // Nothing had been created yet, so nothing to roll back.
      expect(request).not.toHaveBeenCalledWith('worktreeOps.delete', expect.anything())
      expect(callsTo(request, 'worktreeOps.create')).toHaveLength(1)
    })
  })

  describe('connection create failures', () => {
    it('rolls back every worktree when connectionOps.create fails', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'connectionOps.create') {
          return { success: false, error: 'symlink failed' }
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects)

      expect(result).toEqual({ ok: false, error: 'Failed to create connection: symlink failed' })
      expect(callsTo(request, 'worktreeOps.delete')).toEqual([
        expect.objectContaining({ worktreeId: 'worktree-project-1', archive: false }),
        expect.objectContaining({ worktreeId: 'worktree-project-2', archive: false })
      ])
      expect(worktreeStoreMocks.removeWorktreeFromProject).toHaveBeenCalledTimes(2)
      expect(useConnectionStore.getState().connections).toEqual([])
      // Setup scripts had already been fired by then; the connection is simply not inserted.
      expect(worktreeStoreMocks.fireSetupScript).toHaveBeenCalledTimes(2)
    })

    it('treats a thrown connectionOps.create as a failure', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'connectionOps.create') {
          throw new Error('relay offline')
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects)

      expect(result).toEqual({ ok: false, error: 'Failed to create connection: relay offline' })
      expect(callsTo(request, 'worktreeOps.delete')).toHaveLength(2)
      expect(useConnectionStore.getState().connections).toEqual([])
    })

    it('falls back to a generic message when the failure carries no error', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'connectionOps.create') {
          return { success: true }
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects)

      expect(result).toEqual({ ok: false, error: 'Failed to create connection: Unknown error' })
      expect(callsTo(request, 'worktreeOps.delete')).toHaveLength(2)
    })

    it('deletes a connection that is missing members and rolls back the worktrees', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'connectionOps.create') {
          const { worktreeIds } = params as { worktreeIds: string[] }
          // The server silently skipped one worktree.
          return { success: true, connection: connectionFor(worktreeIds.slice(0, 1)) }
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects)

      expect(result).toEqual({
        ok: false,
        error: 'The connection is missing some of its worktrees.'
      })
      expect(callsTo(request, 'connectionOps.delete')).toEqual([
        { connectionId: 'connection-created' }
      ])
      expect(callsTo(request, 'worktreeOps.delete')).toHaveLength(2)
      expect(worktreeStoreMocks.removeWorktreeFromProject).toHaveBeenCalledTimes(2)
      expect(useConnectionStore.getState().connections).toEqual([])
      expect(saveConnectionAsProject).not.toHaveBeenCalled()
    })

    it('still rolls back when deleting the incomplete connection throws', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'connectionOps.create') {
          const { worktreeIds } = params as { worktreeIds: string[] }
          return { success: true, connection: connectionFor(worktreeIds.slice(0, 1)) }
        }
        if (method === 'connectionOps.delete') {
          throw new Error('relay offline')
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects)

      expect(result).toMatchObject({ ok: false })
      expect(callsTo(request, 'worktreeOps.delete')).toHaveLength(2)
      expect(useConnectionStore.getState().connections).toEqual([])
    })
  })

  describe('customName', () => {
    it('renames the connection with the trimmed name and replaces the store row', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'connectionOps.rename') {
          const { customName } = params as { customName: string }
          return {
            success: true,
            connection: connectionFor(['worktree-project-1', 'worktree-project-2'], {
              custom_name: customName
            })
          }
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects, { customName: '  Shipping  ' })

      expect(callsTo(request, 'connectionOps.rename')).toEqual([
        { connectionId: 'connection-created', customName: 'Shipping' }
      ])
      expect(result).toEqual({
        ok: true,
        connectionId: 'connection-created',
        connectionName: 'Shipping',
        connectionPath: '/tmp/created-connection',
        savedProjectId: null
      })
      expect(useConnectionStore.getState().connections).toEqual([
        expect.objectContaining({ id: 'connection-created', custom_name: 'Shipping' })
      ])
      expect(useConnectionStore.getState().selectedConnectionId).toBe('connection-other')
    })

    it('keeps the derived name when the rename reports failure', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'connectionOps.rename') {
          return { success: false, error: 'name taken' }
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects, { customName: 'Shipping' })

      expect(result).toMatchObject({ ok: true, connectionName: 'Project 1 + Project 2' })
      expect(useConnectionStore.getState().connections).toEqual([
        expect.objectContaining({ id: 'connection-created', custom_name: null })
      ])
      expect(request).not.toHaveBeenCalledWith('worktreeOps.delete', expect.anything())
    })

    it('keeps the derived name when the rename throws', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'connectionOps.rename') {
          throw new Error('relay offline')
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects, { customName: 'Shipping' })

      expect(result).toMatchObject({ ok: true, connectionName: 'Project 1 + Project 2' })
      expect(useConnectionStore.getState().connections).toHaveLength(1)
    })

    it.each(['', '   ', null, undefined])('does not rename for a blank name (%j)', async (name) => {
      const result = await createConnectionFromProjects(projects, { customName: name })

      expect(result).toMatchObject({ ok: true, connectionName: 'Project 1 + Project 2' })
      expect(request).not.toHaveBeenCalledWith('connectionOps.rename', expect.anything())
    })
  })

  describe('saveAsProject', () => {
    it('saves the connection as a project and reports the new project id', async () => {
      const result = await createConnectionFromProjects(projects, { saveAsProject: true })

      expect(saveConnectionAsProject).toHaveBeenCalledTimes(1)
      expect(saveConnectionAsProject).toHaveBeenCalledWith('connection-created')
      expect(result).toEqual({
        ok: true,
        connectionId: 'connection-created',
        connectionName: 'Project 1 + Project 2',
        connectionPath: '/tmp/created-connection',
        savedProjectId: 'saved-project-1'
      })
    })

    it('saves after renaming, so the saved project sees the custom name', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'connectionOps.rename') {
          return {
            success: true,
            connection: connectionFor(['worktree-project-1', 'worktree-project-2'], {
              custom_name: 'Shipping'
            })
          }
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects, {
        customName: 'Shipping',
        saveAsProject: true
      })

      expect(result).toMatchObject({
        ok: true,
        connectionName: 'Shipping',
        savedProjectId: 'saved-project-1'
      })
      const renameOrder =
        request.mock.invocationCallOrder[
          request.mock.calls.findIndex(([m]) => m === 'connectionOps.rename')
        ]
      expect(saveConnectionAsProject.mock.invocationCallOrder[0]).toBeGreaterThan(renameOrder)
    })

    // A failure here would make the caller retry and create the worktrees and the connection a
    // second time, so the created connection is returned with a warning instead.
    it('reports a failed save as a warning on the created connection', async () => {
      saveConnectionAsProject.mockResolvedValue(null)

      const result = await createConnectionFromProjects(projects, { saveAsProject: true })

      expect(result).toEqual({
        ok: true,
        connectionId: 'connection-created',
        connectionName: 'Project 1 + Project 2',
        connectionPath: '/tmp/created-connection',
        savedProjectId: null,
        warning: 'The connection was created, but saving it as a project failed.'
      })
      // The connection itself stays: no rollback of worktrees or the connection.
      expect(request).not.toHaveBeenCalledWith('worktreeOps.delete', expect.anything())
      expect(request).not.toHaveBeenCalledWith('connectionOps.delete', expect.anything())
      expect(useConnectionStore.getState().connections).toEqual([
        expect.objectContaining({ id: 'connection-created' })
      ])
    })

    it('does not save when the created connection already has a saved_project_id', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'connectionOps.create') {
          const { worktreeIds } = params as { worktreeIds: string[] }
          return {
            success: true,
            connection: connectionFor(worktreeIds, { saved_project_id: 'saved-project-existing' })
          }
        }
        return happyPath(method, params)
      })

      const result = await createConnectionFromProjects(projects, { saveAsProject: true })

      expect(saveConnectionAsProject).not.toHaveBeenCalled()
      expect(result).toMatchObject({ ok: true, savedProjectId: 'saved-project-existing' })
    })

    it('does not save when saveAsProject is not requested', async () => {
      const result = await createConnectionFromProjects(projects, { saveAsProject: false })

      expect(saveConnectionAsProject).not.toHaveBeenCalled()
      expect(result).toMatchObject({ ok: true, savedProjectId: null })
    })
  })
})
