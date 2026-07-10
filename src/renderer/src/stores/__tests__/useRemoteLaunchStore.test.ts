import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useRemoteLaunchStore } from '../useRemoteLaunchStore'
import type { RemoteLaunchClientInfo } from '@shared/types/remote-launch'

const clientInfo: RemoteLaunchClientInfo = {
  role: 'client',
  url: 'https://host',
  remoteSessionId: 'remote-session-1',
  remoteWorktreeId: 'remote-worktree-1',
  remoteProjectId: 'remote-project-1',
  tmuxSession: 'hive-launch-1',
  branch: 'feature-1',
  worktreePath: '/remote/worktree-1',
  launchedAt: '2026-07-09T00:00:00.000Z'
}

describe('useRemoteLaunchStore', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    request = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'db.session.get') {
        const { id } = params as { id: string }
        if (id === 'session-client') {
          return { id, remote_launch: JSON.stringify(clientInfo) }
        }
        if (id === 'session-host') {
          return {
            id,
            remote_launch: JSON.stringify({
              role: 'host',
              launchId: 'launch-1',
              tmuxSession: null,
              promptFile: null
            })
          }
        }
        if (id === 'session-garbage') {
          return { id, remote_launch: 'not-json' }
        }
        if (id === 'session-stopped') {
          return {
            id,
            remote_launch: JSON.stringify({
              ...clientInfo,
              stoppedAt: '2026-07-10T00:00:00.000Z'
            })
          }
        }
        if (id === 'session-fetch-fails') {
          throw new Error('rpc unavailable')
        }
        return { id, remote_launch: null }
      }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })
    useRemoteLaunchStore.setState({ remoteBySessionId: {} })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('loads and caches client-role remote launch info for a session', async () => {
    await useRemoteLaunchStore.getState().ensureLoaded('session-client')

    expect(request).toHaveBeenCalledWith('db.session.get', { id: 'session-client' })
    expect(useRemoteLaunchStore.getState().remoteBySessionId['session-client']).toEqual(
      clientInfo
    )
  })

  it('caches null for a plain (non-remote) session', async () => {
    await useRemoteLaunchStore.getState().ensureLoaded('session-plain')

    expect(useRemoteLaunchStore.getState().remoteBySessionId['session-plain']).toBeNull()
  })

  it('caches null for a host-role session', async () => {
    await useRemoteLaunchStore.getState().ensureLoaded('session-host')

    expect(useRemoteLaunchStore.getState().remoteBySessionId['session-host']).toBeNull()
  })

  it('caches null for unparseable remote_launch JSON', async () => {
    await useRemoteLaunchStore.getState().ensureLoaded('session-garbage')

    expect(useRemoteLaunchStore.getState().remoteBySessionId['session-garbage']).toBeNull()
  })

  it('does not re-fetch a session that is already loaded', async () => {
    await useRemoteLaunchStore.getState().ensureLoaded('session-client')
    await useRemoteLaunchStore.getState().ensureLoaded('session-client')

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent ensureLoaded calls for the same session into a single fetch', async () => {
    await Promise.all([
      useRemoteLaunchStore.getState().ensureLoaded('session-client'),
      useRemoteLaunchStore.getState().ensureLoaded('session-client')
    ])

    expect(request).toHaveBeenCalledTimes(1)
    expect(useRemoteLaunchStore.getState().remoteBySessionId['session-client']).toEqual(
      clientInfo
    )
  })

  it('eagerly sets remote info via setRemoteInfo without fetching', () => {
    useRemoteLaunchStore.getState().setRemoteInfo('session-fresh', clientInfo)

    expect(useRemoteLaunchStore.getState().remoteBySessionId['session-fresh']).toEqual(
      clientInfo
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('caches null for a stopped client-role session', async () => {
    await useRemoteLaunchStore.getState().ensureLoaded('session-stopped')

    expect(useRemoteLaunchStore.getState().remoteBySessionId['session-stopped']).toBeNull()
  })

  it('caches null (resolved, not stuck loading) when the session fetch rejects', async () => {
    await useRemoteLaunchStore.getState().ensureLoaded('session-fetch-fails')

    expect(
      useRemoteLaunchStore.getState().remoteBySessionId['session-fetch-fails']
    ).toBeNull()
    expect('session-fetch-fails' in useRemoteLaunchStore.getState().remoteBySessionId).toBe(
      true
    )
  })

  it('retries a previously failed load on the next ensureLoaded call', async () => {
    let failNext = true
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method !== 'db.session.get') return null
      if (failNext) {
        failNext = false
        throw new Error('rpc unavailable')
      }
      const { id } = params as { id: string }
      return { id, remote_launch: JSON.stringify(clientInfo) }
    })

    await useRemoteLaunchStore.getState().ensureLoaded('session-flaky')
    expect(useRemoteLaunchStore.getState().remoteBySessionId['session-flaky']).toBeNull()

    // A later mount calls ensureLoaded again — the failed entry is retried
    // (a successful null result would NOT be, see the non-refetch test above).
    await useRemoteLaunchStore.getState().ensureLoaded('session-flaky')
    expect(useRemoteLaunchStore.getState().remoteBySessionId['session-flaky']).toEqual(
      clientInfo
    )
  })

  it('clearRemoteInfo marks a session as no longer remote', () => {
    useRemoteLaunchStore.getState().setRemoteInfo('session-fresh', clientInfo)
    useRemoteLaunchStore.getState().clearRemoteInfo('session-fresh')

    expect(useRemoteLaunchStore.getState().remoteBySessionId['session-fresh']).toBeNull()
  })
})
