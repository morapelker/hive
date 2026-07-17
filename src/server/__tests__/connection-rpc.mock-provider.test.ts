import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionWithMembers } from '../../shared/types/connection'
import { makeEventBus } from '../events/event-bus'
import type { ConnectionOpsRpcService } from '../rpc/domains/connection-ops'
import { makeRpcRouter } from '../rpc/router'

describe('connection ops RPC mocked provider', () => {
  it('routes connectionOps.create to the injected provider service', async () => {
    const connection: ConnectionWithMembers = {
      id: 'connection-1',
      name: 'Hive',
      custom_name: null,
      status: 'active',
      path: '/tmp/hive-connection',
      color: null,
      pinned: 0,
      created_at: '2026-05-26T00:00:00.000Z',
      updated_at: '2026-05-26T00:00:00.000Z',
      members: [
        {
          id: 'member-1',
          connection_id: 'connection-1',
          worktree_id: 'worktree-1',
          project_id: 'project-1',
          symlink_name: 'hive',
          added_at: '2026-05-26T00:00:00.000Z',
          worktree_name: 'main',
          worktree_branch: 'main',
          worktree_path: '/tmp/hive',
          project_name: 'Hive'
        }
      ]
    }
    const result = { success: true, connection }
    const create = vi.fn(() => Effect.succeed(result))
    const service = { create } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-create-1',
        method: 'connectionOps.create',
        params: {
          worktreeIds: ['worktree-1', 'worktree-2']
        }
      })
    )

    expect(create).toHaveBeenCalledWith(['worktree-1', 'worktree-2'])
    expect(response).toEqual({
      id: 'connection-create-1',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.create params before calling the provider service', async () => {
    const create = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { create } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-create-invalid',
        method: 'connectionOps.create',
        params: {
          worktreeIds: ['worktree-1', '']
        }
      })
    )

    expect(create).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-create-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.addMember to the injected provider service', async () => {
    const member: ConnectionWithMembers['members'][0] = {
      id: 'member-1',
      connection_id: 'connection-1',
      worktree_id: 'worktree-1',
      project_id: 'project-1',
      symlink_name: 'hive',
      added_at: '2026-05-26T00:00:00.000Z',
      worktree_name: 'main',
      worktree_branch: 'main',
      worktree_path: '/tmp/hive',
      project_name: 'Hive'
    }
    const result = { success: true, member }
    const addMember = vi.fn(() => Effect.succeed(result))
    const service = { addMember } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-add-member-1',
        method: 'connectionOps.addMember',
        params: {
          connectionId: 'connection-1',
          worktreeId: 'worktree-1'
        }
      })
    )

    expect(addMember).toHaveBeenCalledWith('connection-1', 'worktree-1')
    expect(response).toEqual({
      id: 'connection-add-member-1',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.addMember params before calling the provider service', async () => {
    const addMember = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { addMember } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-add-member-invalid',
        method: 'connectionOps.addMember',
        params: {
          connectionId: 'connection-1',
          worktreeId: ''
        }
      })
    )

    expect(addMember).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-add-member-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.removeMember to the injected provider service', async () => {
    const result = { success: true, connectionDeleted: false }
    const removeMember = vi.fn(() => Effect.succeed(result))
    const service = { removeMember } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-remove-member-1',
        method: 'connectionOps.removeMember',
        params: {
          connectionId: 'connection-1',
          worktreeId: 'worktree-1'
        }
      })
    )

    expect(removeMember).toHaveBeenCalledWith('connection-1', 'worktree-1')
    expect(response).toEqual({
      id: 'connection-remove-member-1',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.removeMember params before calling the provider service', async () => {
    const removeMember = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { removeMember } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-remove-member-invalid',
        method: 'connectionOps.removeMember',
        params: {
          connectionId: '',
          worktreeId: 'worktree-1'
        }
      })
    )

    expect(removeMember).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-remove-member-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.getAll to the injected provider service', async () => {
    const connection: ConnectionWithMembers = {
      id: 'connection-1',
      name: 'Hive',
      custom_name: null,
      status: 'active',
      path: '/tmp/hive-connection',
      color: null,
      pinned: 0,
      created_at: '2026-05-26T00:00:00.000Z',
      updated_at: '2026-05-26T00:00:00.000Z',
      members: [
        {
          id: 'member-1',
          connection_id: 'connection-1',
          worktree_id: 'worktree-1',
          project_id: 'project-1',
          symlink_name: 'hive',
          added_at: '2026-05-26T00:00:00.000Z',
          worktree_name: 'main',
          worktree_branch: 'main',
          worktree_path: '/tmp/hive',
          project_name: 'Hive'
        }
      ]
    }
    const result = { success: true, connections: [connection] }
    const getAll = vi.fn(() => Effect.succeed(result))
    const service = { getAll } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-get-all-1',
        method: 'connectionOps.getAll',
        params: {}
      })
    )

    expect(getAll).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'connection-get-all-1',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.getAll params before calling the provider service', async () => {
    const getAll = vi.fn(() => Effect.succeed({ success: true, connections: [] }))
    const service = { getAll } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-get-all-invalid',
        method: 'connectionOps.getAll',
        params: { connectionId: 'connection-1' }
      })
    )

    expect(getAll).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-get-all-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.get to the injected provider service', async () => {
    const connection: ConnectionWithMembers = {
      id: 'connection-1',
      name: 'Hive',
      custom_name: null,
      status: 'active',
      path: '/tmp/hive-connection',
      color: null,
      pinned: 0,
      created_at: '2026-05-26T00:00:00.000Z',
      updated_at: '2026-05-26T00:00:00.000Z',
      members: [
        {
          id: 'member-1',
          connection_id: 'connection-1',
          worktree_id: 'worktree-1',
          project_id: 'project-1',
          symlink_name: 'hive',
          added_at: '2026-05-26T00:00:00.000Z',
          worktree_name: 'main',
          worktree_branch: 'main',
          worktree_path: '/tmp/hive',
          project_name: 'Hive'
        }
      ]
    }
    const result = { success: true, connection }
    const get = vi.fn(() => Effect.succeed(result))
    const service = { get } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-get-1',
        method: 'connectionOps.get',
        params: { connectionId: 'connection-1' }
      })
    )

    expect(get).toHaveBeenCalledWith('connection-1')
    expect(response).toEqual({
      id: 'connection-get-1',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.get params before calling the provider service', async () => {
    const get = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { get } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-get-invalid',
        method: 'connectionOps.get',
        params: { connectionId: '' }
      })
    )

    expect(get).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-get-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.delete to the injected provider service', async () => {
    const result = { success: true }
    const deleteConnection = vi.fn(() => Effect.succeed(result))
    const service = { delete: deleteConnection } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-delete-1',
        method: 'connectionOps.delete',
        params: { connectionId: 'connection-1' }
      })
    )

    expect(deleteConnection).toHaveBeenCalledWith('connection-1')
    expect(response).toEqual({
      id: 'connection-delete-1',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.delete params before calling the provider service', async () => {
    const deleteConnection = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { delete: deleteConnection } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-delete-invalid',
        method: 'connectionOps.delete',
        params: { connectionId: '' }
      })
    )

    expect(deleteConnection).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-delete-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.openInTerminal to the injected provider service', async () => {
    const result = { success: true }
    const openInTerminal = vi.fn(() => Effect.succeed(result))
    const service = { openInTerminal } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-open-terminal-1',
        method: 'connectionOps.openInTerminal',
        params: { connectionPath: '/tmp/hive-connection' }
      })
    )

    expect(openInTerminal).toHaveBeenCalledWith('/tmp/hive-connection')
    expect(response).toEqual({
      id: 'connection-open-terminal-1',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.openInTerminal params before calling the provider service', async () => {
    const openInTerminal = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { openInTerminal } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-open-terminal-invalid',
        method: 'connectionOps.openInTerminal',
        params: { connectionPath: '' }
      })
    )

    expect(openInTerminal).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-open-terminal-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.openInEditor to the injected provider service', async () => {
    const result = { success: true }
    const openInEditor = vi.fn(() => Effect.succeed(result))
    const service = { openInEditor } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-open-editor-1',
        method: 'connectionOps.openInEditor',
        params: { connectionPath: '/tmp/hive-connection' }
      })
    )

    expect(openInEditor).toHaveBeenCalledWith('/tmp/hive-connection')
    expect(response).toEqual({
      id: 'connection-open-editor-1',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.openInEditor params before calling the provider service', async () => {
    const openInEditor = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { openInEditor } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-open-editor-invalid',
        method: 'connectionOps.openInEditor',
        params: { connectionPath: '' }
      })
    )

    expect(openInEditor).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-open-editor-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.removeWorktreeFromAll to the injected provider service', async () => {
    const result = { success: true }
    const removeWorktreeFromAll = vi.fn(() => Effect.succeed(result))
    const service = { removeWorktreeFromAll } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-remove-worktree-from-all-1',
        method: 'connectionOps.removeWorktreeFromAll',
        params: { worktreeId: 'worktree-1' }
      })
    )

    expect(removeWorktreeFromAll).toHaveBeenCalledWith('worktree-1')
    expect(response).toEqual({
      id: 'connection-remove-worktree-from-all-1',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.removeWorktreeFromAll params before calling the provider service', async () => {
    const removeWorktreeFromAll = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { removeWorktreeFromAll } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-remove-worktree-from-all-invalid',
        method: 'connectionOps.removeWorktreeFromAll',
        params: { worktreeId: '' }
      })
    )

    expect(removeWorktreeFromAll).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-remove-worktree-from-all-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.rename to the injected provider service', async () => {
    const connection: ConnectionWithMembers = {
      id: 'connection-1',
      name: 'Hive',
      custom_name: 'Renamed Hive',
      status: 'active',
      path: '/tmp/hive-connection',
      color: null,
      pinned: 0,
      created_at: '2026-05-26T00:00:00.000Z',
      updated_at: '2026-05-26T00:00:00.000Z',
      members: []
    }
    const result = { success: true, connection }
    const rename = vi.fn(() => Effect.succeed(result))
    const service = { rename } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-rename-1',
        method: 'connectionOps.rename',
        params: { connectionId: 'connection-1', customName: 'Renamed Hive' }
      })
    )

    expect(rename).toHaveBeenCalledWith('connection-1', 'Renamed Hive')
    expect(response).toEqual({
      id: 'connection-rename-1',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.rename params before calling the provider service', async () => {
    const rename = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { rename } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-rename-invalid',
        method: 'connectionOps.rename',
        params: { connectionId: '', customName: 'Renamed Hive' }
      })
    )

    expect(rename).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-rename-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.setPinned to the injected provider service', async () => {
    const result = { success: true }
    const setPinned = vi.fn(() => Effect.succeed(result))
    const service = { setPinned } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-set-pinned-1',
        method: 'connectionOps.setPinned',
        params: { connectionId: 'connection-1', pinned: true }
      })
    )

    expect(setPinned).toHaveBeenCalledWith('connection-1', true)
    expect(response).toEqual({
      id: 'connection-set-pinned-1',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.setPinned params before calling the provider service', async () => {
    const setPinned = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { setPinned } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-set-pinned-invalid',
        method: 'connectionOps.setPinned',
        params: { connectionId: 'connection-1', pinned: 'yes' }
      })
    )

    expect(setPinned).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-set-pinned-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.getPinned to the injected provider service', async () => {
    const connections: ConnectionWithMembers[] = [
      {
        id: 'connection-1',
        name: 'Hive',
        custom_name: null,
        status: 'active',
        path: '/tmp/hive-connection',
        color: null,
        pinned: 1,
        created_at: '2026-05-26T00:00:00.000Z',
        updated_at: '2026-05-26T00:00:00.000Z',
        members: []
      }
    ]
    const getPinned = vi.fn(() => Effect.succeed(connections))
    const service = { getPinned } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-get-pinned-1',
        method: 'connectionOps.getPinned'
      })
    )

    expect(getPinned).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'connection-get-pinned-1',
      ok: true,
      value: connections
    })
  })

  it('validates connectionOps.getPinned params before calling the provider service', async () => {
    const getPinned = vi.fn(() => Effect.succeed([]))
    const service = { getPinned } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-get-pinned-invalid',
        method: 'connectionOps.getPinned',
        params: { connectionId: 'connection-1' }
      })
    )

    expect(getPinned).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-get-pinned-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.updateMembers to the injected provider service', async () => {
    const connection: ConnectionWithMembers = {
      id: 'connection-1',
      name: 'Hive',
      custom_name: null,
      status: 'active',
      path: '/tmp/hive-connection',
      color: null,
      pinned: 0,
      created_at: '2026-05-26T00:00:00.000Z',
      updated_at: '2026-05-26T00:00:00.000Z',
      members: [
        {
          id: 'member-1',
          connection_id: 'connection-1',
          worktree_id: 'worktree-1',
          project_id: 'project-1',
          symlink_name: 'hive',
          added_at: '2026-05-26T00:00:00.000Z',
          worktree_name: 'main',
          worktree_branch: 'main',
          worktree_path: '/tmp/hive',
          project_name: 'Hive'
        }
      ]
    }
    const result = { success: true, connection }
    const updateMembers = vi.fn(() => Effect.succeed(result))
    const service = { updateMembers } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-update-members-1',
        method: 'connectionOps.updateMembers',
        params: {
          connectionId: 'connection-1',
          worktreeIds: ['worktree-1', 'worktree-2']
        }
      })
    )

    expect(updateMembers).toHaveBeenCalledWith('connection-1', ['worktree-1', 'worktree-2'])
    expect(response).toEqual({
      id: 'connection-update-members-1',
      ok: true,
      value: result
    })
  })

  it('rejects connectionOps.updateMembers with an empty worktreeIds array before calling the provider service', async () => {
    const updateMembers = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { updateMembers } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-update-members-invalid',
        method: 'connectionOps.updateMembers',
        params: {
          connectionId: 'connection-1',
          worktreeIds: []
        }
      })
    )

    expect(updateMembers).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-update-members-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.getRecentConnections to the injected provider service', async () => {
    const result = {
      success: true,
      entries: [
        {
          id: 'history-1',
          project_set_key: 'project-1|project-2',
          projects: [
            { id: 'project-1', name: 'Hive', path: '/tmp/hive' },
            { id: 'project-2', name: 'Other', path: '/tmp/other' }
          ],
          last_used_at: '2026-05-26T00:00:00.000Z',
          use_count: 3,
          note: 'demo note'
        }
      ]
    }
    const getRecentConnections = vi.fn(() => Effect.succeed(result))
    const service = { getRecentConnections } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-get-recent-1',
        method: 'connectionOps.getRecentConnections',
        params: {}
      })
    )

    expect(getRecentConnections).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'connection-get-recent-1',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.getRecentConnections params before calling the provider service', async () => {
    const getRecentConnections = vi.fn(() => Effect.succeed({ success: true, entries: [] }))
    const service = { getRecentConnections } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-get-recent-invalid',
        method: 'connectionOps.getRecentConnections',
        params: { connectionId: 'connection-1' }
      })
    )

    expect(getRecentConnections).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'connection-get-recent-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes connectionOps.setRecentConnectionNote to the injected provider service', async () => {
    const result = { success: true }
    const setRecentConnectionNote = vi.fn(() => Effect.succeed(result))
    const service = { setRecentConnectionNote } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-set-recent-note-1',
        method: 'connectionOps.setRecentConnectionNote',
        params: { entryId: 'history-1', note: 'my note' }
      })
    )

    expect(setRecentConnectionNote).toHaveBeenCalledWith('history-1', 'my note')
    expect(response).toEqual({
      id: 'connection-set-recent-note-1',
      ok: true,
      value: result
    })
  })

  it('routes connectionOps.setRecentConnectionNote with a null note (clear)', async () => {
    const result = { success: true }
    const setRecentConnectionNote = vi.fn(() => Effect.succeed(result))
    const service = { setRecentConnectionNote } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'connection-set-recent-note-clear',
        method: 'connectionOps.setRecentConnectionNote',
        params: { entryId: 'history-1', note: null }
      })
    )

    expect(setRecentConnectionNote).toHaveBeenCalledWith('history-1', null)
    expect(response).toEqual({
      id: 'connection-set-recent-note-clear',
      ok: true,
      value: result
    })
  })

  it('validates connectionOps.setRecentConnectionNote params before calling the provider service', async () => {
    const setRecentConnectionNote = vi.fn(() => Effect.succeed({ success: true }))
    const service = { setRecentConnectionNote } as unknown as ConnectionOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      connectionOps: service
    })

    const invalidParams = [
      { note: 'missing entry id' },
      { entryId: '', note: 'empty entry id' },
      { entryId: 'history-1', note: 42 },
      { entryId: 'history-1', note: 'extra key', extra: true }
    ]

    for (const [index, params] of invalidParams.entries()) {
      const response = await Effect.runPromise(
        router.handle({
          id: `connection-set-recent-note-invalid-${index}`,
          method: 'connectionOps.setRecentConnectionNote',
          params
        })
      )

      expect(response).toMatchObject({
        id: `connection-set-recent-note-invalid-${index}`,
        ok: false,
        error: { code: 'VALIDATION_FAILED' }
      })
    }

    expect(setRecentConnectionNote).not.toHaveBeenCalled()
  })
})
