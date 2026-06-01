import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { connectionApi } from '../connection-api'

describe('connectionApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes addMember through the renderer RPC client', async () => {
    const result = {
      success: true,
      member: {
        id: 'member-1',
        connection_id: 'connection-1',
        worktree_id: 'worktree-1',
        project_id: 'project-1',
        symlink_name: 'hive',
        added_at: '2026-05-28T00:00:00.000Z',
        worktree_name: 'main',
        worktree_branch: 'main',
        worktree_path: '/tmp/hive',
        project_name: 'Hive'
      }
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(connectionApi.addMember('connection-1', 'worktree-1')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('connectionOps.addMember', {
      connectionId: 'connection-1',
      worktreeId: 'worktree-1'
    })
  })

  it('routes create through the renderer RPC client', async () => {
    const result = {
      success: true,
      connection: {
        id: 'connection-1',
        name: 'Hive',
        custom_name: null,
        status: 'active' as const,
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
            symlink_name: 'hive',
            added_at: '2026-05-28T00:00:00.000Z',
            worktree_name: 'main',
            worktree_branch: 'main',
            worktree_path: '/tmp/hive',
            project_name: 'Hive'
          }
        ]
      }
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(connectionApi.create(['worktree-1', 'worktree-2'])).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('connectionOps.create', {
      worktreeIds: ['worktree-1', 'worktree-2']
    })
  })

  it('routes delete through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(connectionApi.delete('connection-1')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('connectionOps.delete', {
      connectionId: 'connection-1'
    })
  })

  it('routes get through the renderer RPC client', async () => {
    const result = {
      success: true,
      connection: {
        id: 'connection-1',
        name: 'Hive',
        custom_name: null,
        status: 'active' as const,
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
            symlink_name: 'hive',
            added_at: '2026-05-28T00:00:00.000Z',
            worktree_name: 'main',
            worktree_branch: 'main',
            worktree_path: '/tmp/hive',
            project_name: 'Hive'
          }
        ]
      }
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(connectionApi.get('connection-1')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('connectionOps.get', { connectionId: 'connection-1' })
  })

  it('routes openInTerminal through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(connectionApi.openInTerminal('/tmp/hive-connection')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('connectionOps.openInTerminal', {
      connectionPath: '/tmp/hive-connection'
    })
  })

  it('routes openInEditor through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(connectionApi.openInEditor('/tmp/hive-connection')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('connectionOps.openInEditor', {
      connectionPath: '/tmp/hive-connection'
    })
  })

  it('routes removeMember through the renderer RPC client', async () => {
    const result = {
      success: true,
      connectionDeleted: false
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(connectionApi.removeMember('connection-1', 'worktree-1')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('connectionOps.removeMember', {
      connectionId: 'connection-1',
      worktreeId: 'worktree-1'
    })
  })

  it('routes removeWorktreeFromAll through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(connectionApi.removeWorktreeFromAll('worktree-1')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('connectionOps.removeWorktreeFromAll', {
      worktreeId: 'worktree-1'
    })
  })

  it('routes rename through the renderer RPC client', async () => {
    const result = {
      success: true,
      connection: {
        id: 'connection-1',
        name: 'Hive',
        custom_name: 'Renamed Hive',
        status: 'active' as const,
        path: '/tmp/hive-connection',
        color: null,
        pinned: 0,
        created_at: '2026-05-28T00:00:00.000Z',
        updated_at: '2026-05-28T00:00:00.000Z',
        members: []
      }
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(connectionApi.rename('connection-1', 'Renamed Hive')).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('connectionOps.rename', {
      connectionId: 'connection-1',
      customName: 'Renamed Hive'
    })
  })

  it('routes getAll through the renderer RPC client', async () => {
    const result = {
      success: true,
      connections: [
        {
          id: 'connection-1',
          name: 'Hive',
          custom_name: null,
          status: 'active' as const,
          path: '/tmp/hive-connection',
          color: null,
          pinned: 0,
          created_at: '2026-05-28T00:00:00.000Z',
          updated_at: '2026-05-28T00:00:00.000Z',
          members: []
        }
      ]
    }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(connectionApi.getAll()).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('connectionOps.getAll', {})
  })

  it('routes getPinned through the renderer RPC client', async () => {
    const connections = [
      {
        id: 'connection-1',
        name: 'Hive',
        custom_name: null,
        status: 'active' as const,
        path: '/tmp/hive-connection',
        color: null,
        pinned: 1,
        created_at: '2026-05-28T00:00:00.000Z',
        updated_at: '2026-05-28T00:00:00.000Z',
        members: []
      }
    ]
    const request = vi.fn().mockResolvedValue(connections)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(connectionApi.getPinned()).resolves.toBe(connections)
    expect(request).toHaveBeenCalledWith('connectionOps.getPinned', {})
  })

  it('routes setPinned through the renderer RPC client', async () => {
    const result = { success: true }
    const request = vi.fn().mockResolvedValue(result)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(connectionApi.setPinned('connection-1', true)).resolves.toBe(result)
    expect(request).toHaveBeenCalledWith('connectionOps.setPinned', {
      connectionId: 'connection-1',
      pinned: true
    })
  })
})
