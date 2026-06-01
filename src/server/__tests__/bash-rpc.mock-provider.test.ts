import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { BashRpcService } from '../rpc/domains/bash'
import { makeRpcRouter } from '../rpc/router'

describe('bash RPC mocked provider', () => {
  it('routes bash.run to the injected provider service', async () => {
    const run = vi.fn(() => Effect.succeed({ runId: 'run-1' }))
    const service = { run } as unknown as BashRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      bash: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'bash-run-1',
        method: 'bash.run',
        params: {
          sessionId: 'session-1',
          command: 'pnpm test',
          cwd: '/tmp/hive'
        }
      })
    )

    expect(run).toHaveBeenCalledWith('session-1', 'pnpm test', '/tmp/hive')
    expect(response).toEqual({
      id: 'bash-run-1',
      ok: true,
      value: { runId: 'run-1' }
    })
  })

  it('validates bash.run params before calling the provider service', async () => {
    const run = vi.fn(() => Effect.succeed({ runId: 'run-1' }))
    const service = { run } as unknown as BashRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      bash: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'bash-run-invalid',
        method: 'bash.run',
        params: {
          sessionId: 'session-1',
          command: '',
          cwd: '/tmp/hive'
        }
      })
    )

    expect(run).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'bash-run-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes bash.abort to the injected provider service', async () => {
    const abort = vi.fn(() => Effect.succeed(false))
    const service = { abort } as unknown as BashRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      bash: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'bash-abort-1',
        method: 'bash.abort',
        params: { sessionId: 'session-1' }
      })
    )

    expect(abort).toHaveBeenCalledWith('session-1')
    expect(response).toEqual({
      id: 'bash-abort-1',
      ok: true,
      value: false
    })
  })

  it('validates bash.abort params before calling the provider service', async () => {
    const abort = vi.fn(() => Effect.succeed(true))
    const service = { abort } as unknown as BashRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      bash: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'bash-abort-invalid',
        method: 'bash.abort',
        params: { sessionId: '' }
      })
    )

    expect(abort).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'bash-abort-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes bash.getRun to the injected provider service', async () => {
    const snapshot = {
      sessionId: 'session-1',
      id: 'run-1',
      command: 'pnpm test',
      cwd: '/tmp/hive',
      startedAt: 1770000000000,
      status: 'running' as const,
      outputBuffer: 'stdout',
      outputBytes: 6
    }
    const getRun = vi.fn(() => Effect.succeed(snapshot))
    const service = { getRun } as unknown as BashRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      bash: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'bash-get-run-1',
        method: 'bash.getRun',
        params: { sessionId: 'session-1' }
      })
    )

    expect(getRun).toHaveBeenCalledWith('session-1')
    expect(response).toEqual({
      id: 'bash-get-run-1',
      ok: true,
      value: snapshot
    })
  })

  it('preserves null bash.getRun results from the provider service', async () => {
    const getRun = vi.fn(() => Effect.succeed(null))
    const service = { getRun } as unknown as BashRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      bash: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'bash-get-run-null',
        method: 'bash.getRun',
        params: { sessionId: 'session-1' }
      })
    )

    expect(getRun).toHaveBeenCalledWith('session-1')
    expect(response).toEqual({
      id: 'bash-get-run-null',
      ok: true,
      value: null
    })
  })

  it('validates bash.getRun params before calling the provider service', async () => {
    const getRun = vi.fn(() => Effect.succeed(null))
    const service = { getRun } as unknown as BashRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      bash: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'bash-get-run-invalid',
        method: 'bash.getRun',
        params: { sessionId: '' }
      })
    )

    expect(getRun).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'bash-get-run-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
