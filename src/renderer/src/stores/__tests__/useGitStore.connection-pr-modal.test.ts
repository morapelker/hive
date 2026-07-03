import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '../../api/rpc-client'

let request: ReturnType<typeof vi.fn>
let useGitStore: typeof import('../useGitStore').useGitStore

describe('useGitStore connection PR modal state', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    request = vi.fn().mockResolvedValue([])
    setRendererRpcClient({ request, subscribe: vi.fn() })
    ;({ useGitStore } = await import('../useGitStore'))
    useGitStore.setState({
      createPRModalOpen: false,
      createPRWorktreeId: null,
      createPRWorktreePath: null,
      connectionPRModalOpen: false,
      connectionPRConnectionId: null
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('opens the connection PR modal with a connection id', () => {
    useGitStore.getState().setConnectionPRModalOpen(true, 'conn-1')

    expect(useGitStore.getState().connectionPRModalOpen).toBe(true)
    expect(useGitStore.getState().connectionPRConnectionId).toBe('conn-1')
  })

  it('ignores opening without a connection id', () => {
    useGitStore.getState().setConnectionPRModalOpen(true)

    expect(useGitStore.getState().connectionPRModalOpen).toBe(false)
    expect(useGitStore.getState().connectionPRConnectionId).toBeNull()
  })

  it('clears the connection id on close', () => {
    useGitStore.getState().setConnectionPRModalOpen(true, 'conn-1')
    useGitStore.getState().setConnectionPRModalOpen(false)

    expect(useGitStore.getState().connectionPRModalOpen).toBe(false)
    expect(useGitStore.getState().connectionPRConnectionId).toBeNull()
  })

  it('keeps the single-worktree modal state independent', () => {
    useGitStore.getState().setCreatePRModalOpen(true, {
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt-1'
    })
    useGitStore.getState().setConnectionPRModalOpen(true, 'conn-1')
    useGitStore.getState().setConnectionPRModalOpen(false)

    expect(useGitStore.getState().createPRModalOpen).toBe(true)
    expect(useGitStore.getState().createPRWorktreeId).toBe('wt-1')
  })
})
