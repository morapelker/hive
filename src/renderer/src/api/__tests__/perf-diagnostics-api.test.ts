import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { perfDiagnosticsApi } from '../perf-diagnostics-api'

describe('perfDiagnosticsApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('routes enable through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(perfDiagnosticsApi.enable(true)).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('perfDiagnosticsOps.enable', { enabled: true })
  })

  it('routes getSnapshot through the renderer RPC client', async () => {
    const snapshot = {
      perfVersion: 'v6',
      timestamp: '2026-05-26T00:00:00.000Z',
      uptimeMs: 1234,
      cpu: { userMs: 1, systemMs: 2, percentSinceLastSample: 3 },
      memory: {
        rss: 4,
        heapUsed: 5,
        heapTotal: 6,
        external: 7,
        arrayBuffers: 8,
        nativeEstimate: 9
      },
      heap: {
        sizeLimit: 10,
        totalPhysical: 11,
        mallocedMemory: 12,
        numberOfGcContexts: 13
      },
      processes: {
        ptyActive: 14,
        scriptsActive: 15,
        scriptsTotalOpened: 16,
        scriptsTotalClosed: 17
      },
      watchers: { fileTree: 18, worktree: 19, branch: 20 },
      sessions: { active: 21 },
      handles: { active: 22, requests: 23, byType: { Timeout: 24 } },
      electron: { windows: 25, webContents: 26 },
      eventLoopLagMs: 27
    }
    const request = vi.fn().mockResolvedValue(snapshot)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(perfDiagnosticsApi.getSnapshot()).resolves.toEqual(snapshot)
    expect(request).toHaveBeenCalledWith('perfDiagnosticsOps.getSnapshot', {})
  })
})
