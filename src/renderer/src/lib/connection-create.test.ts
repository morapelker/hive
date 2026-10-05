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
