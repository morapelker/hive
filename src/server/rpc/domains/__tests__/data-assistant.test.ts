// `dataAssistant.*` handlers: the method names the renderer API requests, zod validation of the
// start request, the desktop-only principal guard, and that the live service publishes its
// events on DATA_ASSISTANT_CHANNEL.
import { Effect, Exit } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
  DATA_ASSISTANT_CHANNEL,
  type DataAssistantEventPayload,
  type DataAssistantStartRequest
} from '../../../../shared/data-projects/types'
import type { ServerEvent } from '../../../../shared/rpc/protocol'
import { makeEventBus } from '../../../events/event-bus'
import { runWithRpcRequestContext } from '../../request-context'
import type { RpcContext } from '../../router'
import {
  makeDataAssistantRpcHandlers,
  makeLiveDataAssistantRpcService,
  type DataAssistantRpcService
} from '../data-assistant'

const serviceMocks = vi.hoisted(() => ({
  publish: null as ((payload: DataAssistantEventPayload) => void) | null,
  start: vi.fn(async (request: { requestId: string }) => ({ requestId: request.requestId })),
  cancel: vi.fn(() => ({ cancelled: true })),
  releaseClient: vi.fn(),
  shutdown: vi.fn()
}))

vi.mock('../../../../main/services/data-projects/assistant/service', () => ({
  getDataAssistantService: (publish: (payload: DataAssistantEventPayload) => void) => {
    serviceMocks.publish = publish
    return {
      start: serviceMocks.start,
      cancel: serviceMocks.cancel,
      releaseClient: serviceMocks.releaseClient,
      shutdown: serviceMocks.shutdown
    }
  }
}))

const context = { eventBus: null } as unknown as RpcContext

const startRequest: DataAssistantStartRequest = {
  requestId: 'req-1',
  dataProjectId: 'dp-1',
  question: 'orders since yesterday',
  database: 'shop',
  editorText: '',
  history: [{ role: 'user', text: 'hi' }],
  generation: { provider: 'claude-code', model: 'opus', effort: 'medium' }
}

function fakeService(): DataAssistantRpcService {
  return {
    start: vi.fn((request: DataAssistantStartRequest) =>
      Effect.succeed({ requestId: request.requestId })
    ),
    cancel: vi.fn(() => Effect.succeed({ cancelled: true }))
  }
}

describe('makeDataAssistantRpcHandlers', () => {
  it('registers exactly the methods the renderer API calls', () => {
    const handlers = makeDataAssistantRpcHandlers(fakeService())
    expect([...handlers.keys()].sort()).toEqual(['dataAssistant.cancel', 'dataAssistant.start'])
  })

  it('validates and forwards a start request', async () => {
    const service = fakeService()
    const handler = makeDataAssistantRpcHandlers(service).get('dataAssistant.start')!
    await expect(Effect.runPromise(handler(startRequest, context))).resolves.toEqual({
      requestId: 'req-1'
    })
    expect(service.start).toHaveBeenCalledWith(startRequest, null)

    // The asking renderer is remembered so its runs stop when its socket closes.
    await runWithRpcRequestContext({ clientId: 'renderer-1', principal: { kind: 'desktop' } }, () =>
      Effect.runPromise(handler({ ...startRequest, requestId: 'req-2' }, context))
    )
    expect(service.start).toHaveBeenLastCalledWith(
      { ...startRequest, requestId: 'req-2' },
      'renderer-1'
    )
  })

  it('rejects malformed requests before the service sees them', async () => {
    const service = fakeService()
    const handler = makeDataAssistantRpcHandlers(service).get('dataAssistant.start')!
    for (const params of [
      { ...startRequest, question: '   ' },
      { ...startRequest, generation: { provider: 'gpt' } },
      { ...startRequest, history: [{ role: 'system', text: 'x' }] },
      { ...startRequest, extra: true }
    ]) {
      const exit = await Effect.runPromiseExit(handler(params, context))
      expect(Exit.isFailure(exit)).toBe(true)
    }
    expect(service.start).not.toHaveBeenCalled()
  })

  it('refuses device principals (data projects are desktop-only)', async () => {
    const service = fakeService()
    const handlers = makeDataAssistantRpcHandlers(service)
    const exit = await runWithRpcRequestContext(
      {
        clientId: 'phone',
        principal: { kind: 'device', deviceId: 'd1', name: 'Phone', scope: 'full' as never }
      },
      () =>
        Effect.runPromiseExit(
          handlers.get('dataAssistant.cancel')!({ requestId: 'req-1' }, context)
        )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain('DATA_FORBIDDEN')
    expect(service.cancel).not.toHaveBeenCalled()

    const desktop = await runWithRpcRequestContext(
      { clientId: 'desk', principal: { kind: 'desktop' } },
      () =>
        Effect.runPromise(handlers.get('dataAssistant.cancel')!({ requestId: 'req-1' }, context))
    )
    expect(desktop).toEqual({ cancelled: true })
  })
})

describe('makeLiveDataAssistantRpcService', () => {
  it('runs the lazily loaded service and publishes its events on the assistant channel', async () => {
    const eventBus = makeEventBus()
    const idle = makeLiveDataAssistantRpcService({ eventBus })
    // Lifecycle hooks before first use: nothing to load, nothing to stop.
    idle.releaseClient?.('renderer-1')
    idle.shutdown?.()
    expect(serviceMocks.releaseClient).not.toHaveBeenCalled()
    expect(serviceMocks.shutdown).not.toHaveBeenCalled()

    const received: ServerEvent[] = []
    await Effect.runPromise(
      eventBus.subscribe(DATA_ASSISTANT_CHANNEL, (event) => received.push(event))
    )
    const service = makeLiveDataAssistantRpcService({ eventBus })

    await expect(Effect.runPromise(service.start(startRequest))).resolves.toEqual({
      requestId: 'req-1'
    })
    await expect(Effect.runPromise(service.cancel('req-1'))).resolves.toEqual({ cancelled: true })
    expect(serviceMocks.cancel).toHaveBeenCalledWith('req-1')
    service.releaseClient?.('renderer-1')
    expect(serviceMocks.releaseClient).toHaveBeenCalledWith('renderer-1')
    service.shutdown?.()
    expect(serviceMocks.shutdown).toHaveBeenCalled()

    const payload: DataAssistantEventPayload = {
      requestId: 'req-1',
      dataProjectId: 'dp-1',
      seq: 1,
      event: { type: 'status', text: 'Thinking…' }
    }
    serviceMocks.publish?.(payload)
    await vi.waitFor(() => expect(received).toEqual([{ channel: DATA_ASSISTANT_CHANNEL, payload }]))
  })
})
