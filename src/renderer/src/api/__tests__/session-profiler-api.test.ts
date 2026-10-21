import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { sessionProfilerApi } from '../session-profiler-api'
import type { SessionProfilerSnapshot } from '@shared/types/session-profiler'

describe('sessionProfilerApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes getSnapshot through the renderer RPC client', async () => {
    const snapshot: SessionProfilerSnapshot = {
      supported: true,
      sampledAt: 1_700_000_000_000,
      cpuWindowMs: 60_000,
      idleThresholdSeconds: 1800,
      sessions: [],
      totals: {
        processCount: 12,
        cpuPercent: 14.5,
        agentCpuPercent: 3.2,
        rssBytes: 1_500_000_000,
        agentRssBytes: 400_000_000,
        cpuCount: 10
      }
    }
    const request = vi.fn().mockResolvedValue(snapshot)
    setRendererRpcClient({ request, subscribe: vi.fn() })

    await expect(sessionProfilerApi.getSnapshot()).resolves.toEqual(snapshot)
    expect(request).toHaveBeenCalledWith('sessionProfilerOps.getSnapshot', {})
  })

  it('routes kill through the renderer RPC client with the request as params', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, method: 'pty' })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    const killRequest = { sessionId: 's1', pid: 4242, startedAt: 'Tue Oct 21 10:00:00 2026' }
    await expect(sessionProfilerApi.kill(killRequest)).resolves.toEqual({ ok: true, method: 'pty' })
    expect(request).toHaveBeenCalledWith('sessionProfilerOps.kill', killRequest)
  })

  it('surfaces RPC failures to the caller', async () => {
    const request = vi.fn().mockRejectedValue(new Error('boom'))
    setRendererRpcClient({ request, subscribe: vi.fn() })

    await expect(sessionProfilerApi.getSnapshot()).rejects.toThrow('boom')
  })
})
