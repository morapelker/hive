import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { CodexDebugLoggerOpsRpcService } from '../rpc/domains/codex-debug-logger-ops'
import { makeRpcRouter } from '../rpc/router'

describe('codex debug logger ops RPC mocked provider', () => {
  it('routes codexDebugLoggerOps.configure to the injected provider service', async () => {
    const configure = vi.fn(() => Effect.void)
    const service = { configure } as unknown as CodexDebugLoggerOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      codexDebugLoggerOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'codex-debug-logger-configure-1',
        method: 'codexDebugLoggerOps.configure',
        params: { enabled: true, resetPerSession: false }
      })
    )

    expect(configure).toHaveBeenCalledWith(true, false)
    expect(response).toEqual({
      id: 'codex-debug-logger-configure-1',
      ok: true,
      value: undefined
    })
  })

  it('validates codexDebugLoggerOps.configure params before calling the provider service', async () => {
    const configure = vi.fn(() => Effect.void)
    const service = { configure } as unknown as CodexDebugLoggerOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      codexDebugLoggerOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'codex-debug-logger-configure-invalid',
        method: 'codexDebugLoggerOps.configure',
        params: { enabled: true, resetPerSession: 'no' }
      })
    )

    expect(configure).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'codex-debug-logger-configure-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
