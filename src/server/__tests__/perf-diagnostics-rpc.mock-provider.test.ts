import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { PerfSnapshot } from '../../main/services/perf-diagnostics'
import { makeEventBus } from '../events/event-bus'
import type { PerfDiagnosticsOpsRpcService } from '../rpc/domains/perf-diagnostics-ops'
import { makeRpcRouter } from '../rpc/router'

describe('perf diagnostics ops RPC mocked provider', () => {
  it('routes perfDiagnosticsOps.enable to the injected provider service', async () => {
    const enable = vi.fn(() => Effect.void)
    const service = { enable } as unknown as PerfDiagnosticsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      perfDiagnosticsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'perf-diagnostics-enable-1',
        method: 'perfDiagnosticsOps.enable',
        params: { enabled: true }
      })
    )

    expect(enable).toHaveBeenCalledWith(true)
    expect(response).toEqual({
      id: 'perf-diagnostics-enable-1',
      ok: true,
      value: undefined
    })
  })

  it('validates perfDiagnosticsOps.enable params before calling the provider service', async () => {
    const enable = vi.fn(() => Effect.void)
    const service = { enable } as unknown as PerfDiagnosticsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      perfDiagnosticsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'perf-diagnostics-enable-invalid',
        method: 'perfDiagnosticsOps.enable',
        params: { enabled: 'yes' }
      })
    )

    expect(enable).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'perf-diagnostics-enable-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes perfDiagnosticsOps.getSnapshot to the injected provider service', async () => {
    const snapshot: PerfSnapshot = {
      perfVersion: 'v6',
      timestamp: '2026-05-31T00:00:00.000Z',
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
      handles: { active: 22, requests: 23, byType: { Socket: 2 } },
      electron: { windows: 24, webContents: 25 },
      eventLoopLagMs: 26
    }
    const getSnapshot = vi.fn(() => Effect.succeed(snapshot))
    const service = { getSnapshot } as unknown as PerfDiagnosticsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      perfDiagnosticsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'perf-diagnostics-get-snapshot-1',
        method: 'perfDiagnosticsOps.getSnapshot',
        params: {}
      })
    )

    expect(getSnapshot).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'perf-diagnostics-get-snapshot-1',
      ok: true,
      value: snapshot
    })
  })

  it('validates perfDiagnosticsOps.getSnapshot params before calling the provider service', async () => {
    const getSnapshot = vi.fn(() =>
      Effect.succeed({
        perfVersion: 'v6',
        timestamp: '2026-05-31T00:00:00.000Z',
        uptimeMs: 0,
        cpu: { userMs: 0, systemMs: 0, percentSinceLastSample: 0 },
        memory: {
          rss: 0,
          heapUsed: 0,
          heapTotal: 0,
          external: 0,
          arrayBuffers: 0,
          nativeEstimate: 0
        },
        heap: {
          sizeLimit: 0,
          totalPhysical: 0,
          mallocedMemory: 0,
          numberOfGcContexts: 0
        },
        processes: {
          ptyActive: 0,
          scriptsActive: 0,
          scriptsTotalOpened: 0,
          scriptsTotalClosed: 0
        },
        watchers: { fileTree: 0, worktree: 0, branch: 0 },
        sessions: { active: 0 },
        handles: { active: 0, requests: 0, byType: {} },
        electron: { windows: 0, webContents: 0 },
        eventLoopLagMs: 0
      })
    )
    const service = { getSnapshot } as unknown as PerfDiagnosticsOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      perfDiagnosticsOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'perf-diagnostics-get-snapshot-invalid',
        method: 'perfDiagnosticsOps.getSnapshot',
        params: { unexpected: true }
      })
    )

    expect(getSnapshot).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'perf-diagnostics-get-snapshot-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
