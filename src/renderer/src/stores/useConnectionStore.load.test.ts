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

vi.mock('./useWorktreeStore', () => ({
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

vi.mock('./useKanbanStore', () => ({
  useKanbanStore: {
    getState: vi.fn(() => ({
      isPinnedBoardActive: false,
      togglePinnedBoard: vi.fn()
    }))
  }
}))

import { useConnectionStore } from './useConnectionStore'
import { usePinnedStore } from './usePinnedStore'
import { toast } from '@/lib/toast'

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

describe('useConnectionStore connection loading', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    request = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'connectionOps.getAll') {
        return {
          success: true,
          connections: [
            {
              id: 'connection-1',
              name: 'Hive',
              custom_name: null,
              status: 'active',
              path: '/tmp/hive-connection',
              color: null,
              pinned: 0,
              created_at: '2026-05-28T00:00:00.000Z',
              updated_at: '2026-05-28T00:00:00.000Z',
              members: []
            }
          ]
        }
      }
      if (method === 'connectionOps.create') {
        return {
          success: true,
          connection: {
            id: 'connection-created',
            name: 'Created Connection',
            custom_name: null,
            status: 'active',
            path: '/tmp/created-connection',
            color: null,
            pinned: 0,
            created_at: '2026-05-28T00:00:00.000Z',
            updated_at: '2026-05-28T00:00:00.000Z',
            members: Array.isArray((params as { worktreeIds?: unknown }).worktreeIds)
              ? (params as { worktreeIds: string[] }).worktreeIds.map((worktreeId, index) => ({
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
                }))
              : []
          }
        }
      }
      if (method === 'connectionOps.delete') {
        return { success: true }
      }
      if (method === 'connectionOps.addMember') {
        return {
          success: true,
          member: {
            id: 'member-2',
            connection_id: 'connection-1',
            worktree_id: 'worktree-2',
            project_id: 'project-2',
            symlink_name: 'worktree-2',
            added_at: '2026-05-28T00:00:00.000Z',
            worktree_name: 'Worktree 2',
            worktree_branch: 'branch-2',
            worktree_path: '/tmp/worktree-2',
            project_name: 'Project 2'
          }
        }
      }
      if (method === 'connectionOps.removeMember') {
        return { success: true, connectionDeleted: false }
      }
      if (method === 'connectionOps.get') {
        return {
          success: true,
          connection: {
            id: 'connection-1',
            name: 'Hive Updated',
            custom_name: null,
            status: 'active',
            path: '/tmp/hive-connection',
            color: null,
            pinned: 0,
            created_at: '2026-05-28T00:00:00.000Z',
            updated_at: '2026-05-28T00:00:00.000Z',
            members: [
              {
                id: 'member-1',
                connection_id: 'connection-1',
                worktree_id: 'worktree-1',
                project_id: 'project-1',
                symlink_name: 'worktree-1',
                added_at: '2026-05-28T00:00:00.000Z',
                worktree_name: 'Worktree 1',
                worktree_branch: 'branch-1',
                worktree_path: '/tmp/worktree-1',
                project_name: 'Project 1'
              },
              {
                id: 'member-2',
                connection_id: 'connection-1',
                worktree_id: 'worktree-2',
                project_id: 'project-2',
                symlink_name: 'worktree-2',
                added_at: '2026-05-28T00:00:00.000Z',
                worktree_name: 'Worktree 2',
                worktree_branch: 'branch-2',
                worktree_path: '/tmp/worktree-2',
                project_name: 'Project 2'
              }
            ]
          }
        }
      }
      if (method === 'connectionOps.rename') {
        return {
          success: true,
          connection: {
            id: 'connection-1',
            name: 'Hive',
            custom_name: 'Renamed Hive',
            status: 'active',
            path: '/tmp/hive-connection',
            color: null,
            pinned: 0,
            created_at: '2026-05-28T00:00:00.000Z',
            updated_at: '2026-05-28T00:00:00.000Z',
            members: []
          }
        }
      }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
    useConnectionStore.setState({
      connections: [],
      isLoading: false,
      error: null,
      loaded: false
    })
    usePinnedStore.setState({
      pinnedWorktreeIds: new Set<string>(),
      pinnedConnectionIds: new Set<string>(),
      pinnedProjectIds: new Set<string>(),
      loaded: false
    })
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

  it('loads connections through connectionApi RPC', async () => {
    await useConnectionStore.getState().loadConnections()

    expect(request).toHaveBeenCalledWith('connectionOps.getAll', {})
    expect(useConnectionStore.getState().connections).toEqual([
      expect.objectContaining({ id: 'connection-1', name: 'Hive' })
    ])
    expect(useConnectionStore.getState()).toMatchObject({
      isLoading: false,
      loaded: true,
      error: null
    })
  })

  it('creates connections through connectionApi RPC', async () => {
    await expect(
      useConnectionStore.getState().createConnection(['worktree-1', 'worktree-2'])
    ).resolves.toBe('connection-created')

    expect(request).toHaveBeenCalledWith('connectionOps.create', {
      worktreeIds: ['worktree-1', 'worktree-2']
    })
    expect(useConnectionStore.getState()).toMatchObject({
      selectedConnectionId: 'connection-created'
    })
    expect(useConnectionStore.getState().connections).toEqual([
      expect.objectContaining({
        id: 'connection-created',
        name: 'Created Connection',
        members: [
          expect.objectContaining({ worktree_id: 'worktree-1' }),
          expect.objectContaining({ worktree_id: 'worktree-2' })
        ]
      })
    ])
    expect(toast.success).toHaveBeenCalledWith('Connection "Created Connection" created')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('deletes connections through connectionApi RPC', async () => {
    useConnectionStore.setState({
      connections: [
        {
          id: 'connection-1',
          name: 'Hive',
          custom_name: null,
          status: 'active',
          path: '/tmp/hive-connection',
          color: null,
          created_at: '2026-05-28T00:00:00.000Z',
          updated_at: '2026-05-28T00:00:00.000Z',
          members: []
        },
        {
          id: 'connection-2',
          name: 'Other',
          custom_name: null,
          status: 'active',
          path: '/tmp/other-connection',
          color: null,
          created_at: '2026-05-28T00:00:00.000Z',
          updated_at: '2026-05-28T00:00:00.000Z',
          members: []
        }
      ],
      selectedConnectionId: 'connection-1'
    })
    usePinnedStore.setState({
      pinnedConnectionIds: new Set(['connection-1', 'connection-2'])
    })

    await useConnectionStore.getState().deleteConnection('connection-1')

    expect(request).toHaveBeenCalledWith('connectionOps.delete', {
      connectionId: 'connection-1'
    })
    expect(useConnectionStore.getState()).toMatchObject({
      selectedConnectionId: null
    })
    expect(useConnectionStore.getState().connections).toEqual([
      expect.objectContaining({ id: 'connection-2', name: 'Other' })
    ])
    expect(usePinnedStore.getState().pinnedConnectionIds).toEqual(new Set(['connection-2']))
    expect(toast.success).toHaveBeenCalledWith('Connection deleted')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('adds a member and reloads the connection through connectionApi RPC', async () => {
    useConnectionStore.setState({
      connections: [
        {
          id: 'connection-1',
          name: 'Hive',
          custom_name: null,
          status: 'active',
          path: '/tmp/hive-connection',
          color: null,
          created_at: '2026-05-28T00:00:00.000Z',
          updated_at: '2026-05-28T00:00:00.000Z',
          members: [
            {
              id: 'member-1',
              connection_id: 'connection-1',
              worktree_id: 'worktree-1',
              project_id: 'project-1',
              symlink_name: 'worktree-1',
              added_at: '2026-05-28T00:00:00.000Z',
              worktree_name: 'Worktree 1',
              worktree_branch: 'branch-1',
              worktree_path: '/tmp/worktree-1',
              project_name: 'Project 1'
            }
          ]
        }
      ]
    })

    await useConnectionStore.getState().addMember('connection-1', 'worktree-2')

    expect(request).toHaveBeenCalledWith('connectionOps.addMember', {
      connectionId: 'connection-1',
      worktreeId: 'worktree-2'
    })
    expect(request).toHaveBeenCalledWith('connectionOps.get', {
      connectionId: 'connection-1'
    })
    expect(useConnectionStore.getState().connections).toEqual([
      expect.objectContaining({
        id: 'connection-1',
        name: 'Hive Updated',
        members: [
          expect.objectContaining({ worktree_id: 'worktree-1' }),
          expect.objectContaining({ worktree_id: 'worktree-2' })
        ]
      })
    ])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('removes a member and reloads the connection through connectionApi RPC', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'connectionOps.removeMember') {
        return { success: true, connectionDeleted: false }
      }
      if (method === 'connectionOps.get') {
        return {
          success: true,
          connection: {
            id: 'connection-1',
            name: 'Hive Removed',
            custom_name: null,
            status: 'active',
            path: '/tmp/hive-connection',
            color: null,
            pinned: 0,
            created_at: '2026-05-28T00:00:00.000Z',
            updated_at: '2026-05-28T00:00:00.000Z',
            members: [
              {
                id: 'member-1',
                connection_id: 'connection-1',
                worktree_id: 'worktree-1',
                project_id: 'project-1',
                symlink_name: 'worktree-1',
                added_at: '2026-05-28T00:00:00.000Z',
                worktree_name: 'Worktree 1',
                worktree_branch: 'branch-1',
                worktree_path: '/tmp/worktree-1',
                project_name: 'Project 1'
              }
            ]
          }
        }
      }
      return null
    })
    useConnectionStore.setState({
      connections: [
        {
          id: 'connection-1',
          name: 'Hive',
          custom_name: null,
          status: 'active',
          path: '/tmp/hive-connection',
          color: null,
          created_at: '2026-05-28T00:00:00.000Z',
          updated_at: '2026-05-28T00:00:00.000Z',
          members: [
            {
              id: 'member-1',
              connection_id: 'connection-1',
              worktree_id: 'worktree-1',
              project_id: 'project-1',
              symlink_name: 'worktree-1',
              added_at: '2026-05-28T00:00:00.000Z',
              worktree_name: 'Worktree 1',
              worktree_branch: 'branch-1',
              worktree_path: '/tmp/worktree-1',
              project_name: 'Project 1'
            },
            {
              id: 'member-2',
              connection_id: 'connection-1',
              worktree_id: 'worktree-2',
              project_id: 'project-2',
              symlink_name: 'worktree-2',
              added_at: '2026-05-28T00:00:00.000Z',
              worktree_name: 'Worktree 2',
              worktree_branch: 'branch-2',
              worktree_path: '/tmp/worktree-2',
              project_name: 'Project 2'
            }
          ]
        }
      ]
    })

    await useConnectionStore.getState().removeMember('connection-1', 'worktree-2')

    expect(request).toHaveBeenCalledWith('connectionOps.removeMember', {
      connectionId: 'connection-1',
      worktreeId: 'worktree-2'
    })
    expect(request).toHaveBeenCalledWith('connectionOps.get', {
      connectionId: 'connection-1'
    })
    expect(useConnectionStore.getState().connections).toEqual([
      expect.objectContaining({
        id: 'connection-1',
        name: 'Hive Removed',
        members: [expect.objectContaining({ worktree_id: 'worktree-1' })]
      })
    ])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('updates connection members by adding new members through the batched connectionOps.updateMembers RPC', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'connectionOps.updateMembers') {
        return {
          success: true,
          connection: {
            id: 'connection-1',
            name: 'Hive Updated',
            custom_name: null,
            status: 'active',
            path: '/tmp/hive-connection',
            color: null,
            pinned: 0,
            created_at: '2026-05-28T00:00:00.000Z',
            updated_at: '2026-05-28T00:00:00.000Z',
            members: [
              {
                id: 'member-1',
                connection_id: 'connection-1',
                worktree_id: 'worktree-1',
                project_id: 'project-1',
                symlink_name: 'worktree-1',
                added_at: '2026-05-28T00:00:00.000Z',
                worktree_name: 'Worktree 1',
                worktree_branch: 'branch-1',
                worktree_path: '/tmp/worktree-1',
                project_name: 'Project 1'
              },
              {
                id: 'member-2',
                connection_id: 'connection-1',
                worktree_id: 'worktree-2',
                project_id: 'project-2',
                symlink_name: 'worktree-2',
                added_at: '2026-05-28T00:00:00.000Z',
                worktree_name: 'Worktree 2',
                worktree_branch: 'branch-2',
                worktree_path: '/tmp/worktree-2',
                project_name: 'Project 2'
              }
            ]
          }
        }
      }
      return null
    })
    useConnectionStore.setState({
      connections: [
        {
          id: 'connection-1',
          name: 'Hive',
          custom_name: null,
          status: 'active',
          path: '/tmp/hive-connection',
          color: null,
          created_at: '2026-05-28T00:00:00.000Z',
          updated_at: '2026-05-28T00:00:00.000Z',
          members: [
            {
              id: 'member-1',
              connection_id: 'connection-1',
              worktree_id: 'worktree-1',
              project_id: 'project-1',
              symlink_name: 'worktree-1',
              added_at: '2026-05-28T00:00:00.000Z',
              worktree_name: 'Worktree 1',
              worktree_branch: 'branch-1',
              worktree_path: '/tmp/worktree-1',
              project_name: 'Project 1'
            }
          ]
        }
      ]
    })

    await useConnectionStore
      .getState()
      .updateConnectionMembers('connection-1', ['worktree-1', 'worktree-2'])

    // Exactly one batched RPC call — no per-member add/remove or reload round-trips.
    expect(request).toHaveBeenCalledWith('connectionOps.updateMembers', {
      connectionId: 'connection-1',
      worktreeIds: ['worktree-1', 'worktree-2']
    })
    expect(
      request.mock.calls.filter(([method]) => method === 'connectionOps.updateMembers')
    ).toHaveLength(1)
    expect(request).not.toHaveBeenCalledWith('connectionOps.addMember', expect.anything())
    expect(request).not.toHaveBeenCalledWith('connectionOps.get', expect.anything())
    expect(useConnectionStore.getState().connections).toEqual([
      expect.objectContaining({
        id: 'connection-1',
        name: 'Hive Updated',
        members: [
          expect.objectContaining({ worktree_id: 'worktree-1' }),
          expect.objectContaining({ worktree_id: 'worktree-2' })
        ]
      })
    ])
    expect(toast.success).toHaveBeenCalledWith('Connection updated')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('updates connection members by removing departing members through the batched connectionOps.updateMembers RPC', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'connectionOps.updateMembers') {
        return {
          success: true,
          connection: {
            id: 'connection-1',
            name: 'Hive Removed',
            custom_name: null,
            status: 'active',
            path: '/tmp/hive-connection',
            color: null,
            pinned: 0,
            created_at: '2026-05-28T00:00:00.000Z',
            updated_at: '2026-05-28T00:00:00.000Z',
            members: [
              {
                id: 'member-1',
                connection_id: 'connection-1',
                worktree_id: 'worktree-1',
                project_id: 'project-1',
                symlink_name: 'worktree-1',
                added_at: '2026-05-28T00:00:00.000Z',
                worktree_name: 'Worktree 1',
                worktree_branch: 'branch-1',
                worktree_path: '/tmp/worktree-1',
                project_name: 'Project 1'
              }
            ]
          }
        }
      }
      return null
    })
    useConnectionStore.setState({
      connections: [
        {
          id: 'connection-1',
          name: 'Hive',
          custom_name: null,
          status: 'active',
          path: '/tmp/hive-connection',
          color: null,
          created_at: '2026-05-28T00:00:00.000Z',
          updated_at: '2026-05-28T00:00:00.000Z',
          members: [
            {
              id: 'member-1',
              connection_id: 'connection-1',
              worktree_id: 'worktree-1',
              project_id: 'project-1',
              symlink_name: 'worktree-1',
              added_at: '2026-05-28T00:00:00.000Z',
              worktree_name: 'Worktree 1',
              worktree_branch: 'branch-1',
              worktree_path: '/tmp/worktree-1',
              project_name: 'Project 1'
            },
            {
              id: 'member-2',
              connection_id: 'connection-1',
              worktree_id: 'worktree-2',
              project_id: 'project-2',
              symlink_name: 'worktree-2',
              added_at: '2026-05-28T00:00:00.000Z',
              worktree_name: 'Worktree 2',
              worktree_branch: 'branch-2',
              worktree_path: '/tmp/worktree-2',
              project_name: 'Project 2'
            }
          ]
        }
      ]
    })

    await useConnectionStore.getState().updateConnectionMembers('connection-1', ['worktree-1'])

    expect(request).toHaveBeenCalledWith('connectionOps.updateMembers', {
      connectionId: 'connection-1',
      worktreeIds: ['worktree-1']
    })
    expect(request).not.toHaveBeenCalledWith('connectionOps.removeMember', expect.anything())
    expect(request).not.toHaveBeenCalledWith('connectionOps.get', expect.anything())
    expect(useConnectionStore.getState().connections).toEqual([
      expect.objectContaining({
        id: 'connection-1',
        name: 'Hive Removed',
        members: [expect.objectContaining({ worktree_id: 'worktree-1' })]
      })
    ])
    expect(toast.success).toHaveBeenCalledWith('Connection updated')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('renames a connection through connectionApi RPC', async () => {
    useConnectionStore.setState({
      connections: [
        {
          id: 'connection-1',
          name: 'Hive',
          custom_name: null,
          status: 'active',
          path: '/tmp/hive-connection',
          color: null,
          created_at: '2026-05-28T00:00:00.000Z',
          updated_at: '2026-05-28T00:00:00.000Z',
          members: []
        }
      ]
    })

    await useConnectionStore.getState().renameConnection('connection-1', 'Renamed Hive')

    expect(request).toHaveBeenCalledWith('connectionOps.rename', {
      connectionId: 'connection-1',
      customName: 'Renamed Hive'
    })
    expect(useConnectionStore.getState().connections).toEqual([
      expect.objectContaining({
        id: 'connection-1',
        custom_name: 'Renamed Hive'
      })
    ])
    expect(toast.error).not.toHaveBeenCalled()
  })

  describe('quickCreateConnection', () => {
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

    it('returns null without creating anything when fewer than two projects are given', async () => {
      const result = await useConnectionStore
        .getState()
        .quickCreateConnection([projects[0]])

      expect(result).toBeNull()
      expect(request).not.toHaveBeenCalledWith('worktreeOps.create', expect.anything())
      expect(request).not.toHaveBeenCalledWith('connectionOps.create', expect.anything())
    })

    it('creates a worktree per project then a single connection, without touching worktree selection', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'worktreeOps.create') {
          const { projectId } = params as { projectId: string }
          return { success: true, worktree: worktreeFor(projectId) }
        }
        if (method === 'connectionOps.create') {
          const { worktreeIds } = params as { worktreeIds: string[] }
          return {
            success: true,
            connection: {
              id: 'connection-created',
              name: 'Created Connection',
              custom_name: null,
              status: 'active',
              path: '/tmp/created-connection',
              color: null,
              pinned: 0,
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
              }))
            }
          }
        }
        return null
      })

      const result = await useConnectionStore.getState().quickCreateConnection(projects)

      expect(result).toBe('connection-created')
      expect(request).toHaveBeenCalledWith('worktreeOps.create', {
        projectId: 'project-1',
        projectPath: '/tmp/project-1',
        projectName: 'Project 1'
      })
      expect(request).toHaveBeenCalledWith('worktreeOps.create', {
        projectId: 'project-2',
        projectPath: '/tmp/project-2',
        projectName: 'Project 2'
      })
      expect(request).toHaveBeenCalledWith('connectionOps.create', {
        worktreeIds: ['worktree-project-1', 'worktree-project-2']
      })

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

      // Deliberately inserts WITHOUT selecting: no selecting createWorktree action, no rollback.
      expect(worktreeStoreMocks.createWorktree).not.toHaveBeenCalled()
      expect(worktreeStoreMocks.removeWorktreeFromProject).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalledWith('worktreeOps.delete', expect.anything())
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('rolls back already-created worktrees and skips connection creation when a create fails', async () => {
      request.mockImplementation(async (method: string, params?: unknown) => {
        if (method === 'worktreeOps.create') {
          const { projectId } = params as { projectId: string }
          if (projectId === 'project-2') {
            return { success: false, error: 'disk full' }
          }
          return { success: true, worktree: worktreeFor(projectId) }
        }
        if (method === 'worktreeOps.delete') {
          return { success: true }
        }
        return null
      })

      const result = await useConnectionStore.getState().quickCreateConnection(projects)

      expect(result).toBeNull()
      // The first (successful) worktree is deleted, non-archiving.
      expect(request).toHaveBeenCalledWith('worktreeOps.delete', {
        worktreeId: 'worktree-project-1',
        worktreePath: '/tmp/project-1/wt',
        branchName: 'branch-project-1',
        projectPath: '/tmp/project-1',
        archive: false
      })
      expect(worktreeStoreMocks.removeWorktreeFromProject).toHaveBeenCalledWith(
        'project-1',
        'worktree-project-1'
      )
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Project 2')
      )
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('disk full'))
      // No connection is created when a worktree create fails.
      expect(request).not.toHaveBeenCalledWith('connectionOps.create', expect.anything())
    })
  })
})
