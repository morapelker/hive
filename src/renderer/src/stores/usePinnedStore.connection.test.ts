import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { usePinnedStore } from './usePinnedStore'
import { registerConnectionSavedProjectResolver } from './store-coordination'

vi.mock('./useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map(),
      loadWorktrees: vi.fn()
    }))
  }
}))

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

describe('usePinnedStore connection pinning', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    request = vi.fn(async (method: string) => {
      if (method === 'connectionOps.setPinned') return { success: true }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
    usePinnedStore.setState({
      pinnedConnectionIds: new Set(),
      pinnedWorktreeIds: new Set(),
      pinnedProjectIds: new Set(),
      loaded: false
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('pins a connection through connectionApi RPC', async () => {
    await usePinnedStore.getState().pinConnection('connection-1')

    expect(request).toHaveBeenCalledWith('connectionOps.setPinned', {
      connectionId: 'connection-1',
      pinned: true
    })
    expect(usePinnedStore.getState().pinnedConnectionIds.has('connection-1')).toBe(true)
  })

  it('unpins a connection through connectionApi RPC', async () => {
    usePinnedStore.setState({
      pinnedConnectionIds: new Set(['connection-1'])
    })

    await usePinnedStore.getState().unpinConnection('connection-1')

    expect(request).toHaveBeenCalledWith('connectionOps.setPinned', {
      connectionId: 'connection-1',
      pinned: false
    })
    expect(usePinnedStore.getState().pinnedConnectionIds.has('connection-1')).toBe(false)
  })
})

describe('usePinnedStore connection-project scoping', () => {
  let request: ReturnType<typeof vi.fn>
  const savedProjectByConnection: Record<string, string | null> = {
    'base-1': 'conn-project-1',
    'inst-1': 'conn-project-1',
    adhoc: null
  }

  beforeEach(() => {
    request = vi.fn(async (method: string) => {
      if (method === 'connectionOps.setPinned') return { success: true }
      if (method === 'db.worktree.getPinned') return [{ id: 'wt-1', project_id: 'git-project-1' }]
      if (method === 'connectionOps.getPinned') {
        return [
          { id: 'base-1', saved_project_id: 'conn-project-1', is_base: 1, members: [] },
          { id: 'adhoc', saved_project_id: null, is_base: 0, members: [] }
        ]
      }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
    registerConnectionSavedProjectResolver((id) => savedProjectByConnection[id] ?? null)
    usePinnedStore.setState({
      pinnedConnectionIds: new Set(),
      pinnedWorktreeIds: new Set(),
      pinnedProjectIds: new Set(),
      loaded: false
    })
  })

  afterEach(() => {
    registerConnectionSavedProjectResolver(() => null)
    resetRendererRpcClientForTests()
  })

  it('pinning an instance of a connection project scopes that project onto the pinned board', async () => {
    await usePinnedStore.getState().pinConnection('base-1')

    expect(usePinnedStore.getState().pinnedConnectionIds.has('base-1')).toBe(true)
    expect(usePinnedStore.getState().pinnedProjectIds.has('conn-project-1')).toBe(true)
  })

  it('pinning an ad-hoc connection adds no project', async () => {
    await usePinnedStore.getState().pinConnection('adhoc')

    expect(usePinnedStore.getState().pinnedConnectionIds.has('adhoc')).toBe(true)
    expect(usePinnedStore.getState().pinnedProjectIds.size).toBe(0)
  })

  it('keeps the project while another instance of it is still pinned, drops it on the last unpin', async () => {
    await usePinnedStore.getState().pinConnection('base-1')
    await usePinnedStore.getState().pinConnection('inst-1')
    expect(usePinnedStore.getState().pinnedProjectIds.has('conn-project-1')).toBe(true)

    await usePinnedStore.getState().unpinConnection('inst-1')
    expect(usePinnedStore.getState().pinnedProjectIds.has('conn-project-1')).toBe(true)

    await usePinnedStore.getState().unpinConnection('base-1')
    expect(usePinnedStore.getState().pinnedProjectIds.has('conn-project-1')).toBe(false)
  })

  it('removeConnection (local, on delete) drops the project the same way', async () => {
    await usePinnedStore.getState().pinConnection('inst-1')
    expect(usePinnedStore.getState().pinnedProjectIds.has('conn-project-1')).toBe(true)

    usePinnedStore.getState().removeConnection('inst-1')
    expect(usePinnedStore.getState().pinnedConnectionIds.has('inst-1')).toBe(false)
    expect(usePinnedStore.getState().pinnedProjectIds.has('conn-project-1')).toBe(false)
  })

  it('does not disturb worktree-derived project ids', async () => {
    usePinnedStore.setState({
      pinnedWorktreeIds: new Set(['wt-1']),
      pinnedProjectIds: new Set(['git-project-1'])
    })

    await usePinnedStore.getState().pinConnection('base-1')
    await usePinnedStore.getState().unpinConnection('base-1')

    expect(usePinnedStore.getState().pinnedProjectIds.has('git-project-1')).toBe(true)
    expect(usePinnedStore.getState().pinnedProjectIds.has('conn-project-1')).toBe(false)
  })

  it('loadPinned derives connection-project ids from pinned instances (plus worktree projects)', async () => {
    await usePinnedStore.getState().loadPinned()

    const state = usePinnedStore.getState()
    expect(state.loaded).toBe(true)
    expect(state.pinnedConnectionIds).toEqual(new Set(['base-1', 'adhoc']))
    expect(state.pinnedWorktreeIds).toEqual(new Set(['wt-1']))
    expect(state.pinnedProjectIds).toEqual(new Set(['git-project-1', 'conn-project-1']))
  })
})
