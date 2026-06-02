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

vi.mock('./useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map(),
      loadWorktrees: vi.fn()
    }))
  }
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

  it('updates connection members by adding new members through connectionApi RPC', async () => {
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
    expect(toast.success).toHaveBeenCalledWith('Connection updated')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('updates connection members by removing departing members through connectionApi RPC', async () => {
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

    await useConnectionStore.getState().updateConnectionMembers('connection-1', ['worktree-1'])

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
})
