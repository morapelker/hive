import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { usePinnedStore } from './usePinnedStore'

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
