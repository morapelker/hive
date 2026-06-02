import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { LoggingOpsRpcService } from '../rpc/domains/logging-ops'
import { makeRpcRouter } from '../rpc/router'

describe('logging ops RPC mocked provider', () => {
  it('routes loggingOps.createResponseLog to the injected provider service', async () => {
    const createResponseLog = vi.fn((sessionId: string) =>
      Effect.succeed(`/tmp/hive/${sessionId}.jsonl`)
    )
    const service = { createResponseLog } as unknown as LoggingOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      loggingOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'logging-create-response-log-1',
        method: 'loggingOps.createResponseLog',
        params: { sessionId: 'session-1' }
      })
    )

    expect(createResponseLog).toHaveBeenCalledWith('session-1')
    expect(response).toEqual({
      id: 'logging-create-response-log-1',
      ok: true,
      value: '/tmp/hive/session-1.jsonl'
    })
  })

  it('validates loggingOps.createResponseLog params before calling the provider service', async () => {
    const createResponseLog = vi.fn(() => Effect.succeed('/tmp/hive/session-1.jsonl'))
    const service = { createResponseLog } as unknown as LoggingOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      loggingOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'logging-create-response-log-invalid',
        method: 'loggingOps.createResponseLog',
        params: { sessionId: '' }
      })
    )

    expect(createResponseLog).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'logging-create-response-log-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes loggingOps.appendResponseLog to the injected provider service', async () => {
    const data = { type: 'part_updated', event: { text: 'hello' } }
    const appendResponseLog = vi.fn(() => Effect.succeed(undefined))
    const service = { appendResponseLog } as unknown as LoggingOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      loggingOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'logging-append-response-log-1',
        method: 'loggingOps.appendResponseLog',
        params: {
          filePath: '/tmp/hive/session-1.jsonl',
          data
        }
      })
    )

    expect(appendResponseLog).toHaveBeenCalledWith('/tmp/hive/session-1.jsonl', data)
    expect(response).toEqual({
      id: 'logging-append-response-log-1',
      ok: true,
      value: undefined
    })
  })

  it('validates loggingOps.appendResponseLog params before calling the provider service', async () => {
    const appendResponseLog = vi.fn(() => Effect.succeed(undefined))
    const service = { appendResponseLog } as unknown as LoggingOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      loggingOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'logging-append-response-log-invalid',
        method: 'loggingOps.appendResponseLog',
        params: {
          filePath: '',
          data: { type: 'part_updated' }
        }
      })
    )

    expect(appendResponseLog).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'logging-append-response-log-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
