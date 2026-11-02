import { EventEmitter } from 'node:events'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeDesktopCommandResult, type DesktopCommandRequest } from '../../shared/desktop-command'
import type { SessionProfilerSnapshot } from '../../shared/types/session-profiler'
import { makeEventBus } from '../events/event-bus'
import {
  makeLiveSessionProfilerOpsRpcService,
  type SessionProfilerOpsRpcService
} from '../rpc/domains/session-profiler-ops'
import { makeRpcRouter } from '../rpc/router'

const snapshot: SessionProfilerSnapshot = {
  supported: true,
  sampledAt: 1_700_000_000_000,
  cpuWindowMs: 1500,
  idleThresholdSeconds: 1800,
  sessions: [],
  totals: {
    processCount: 12,
    cpuPercent: 42,
    agentCpuPercent: 30,
    rssBytes: 1024,
    agentRssBytes: 512,
    cpuCount: 8
  }
}

/** A desktop parent that answers each request through `answer`. */
function makeTransport(answer: (request: DesktopCommandRequest) => unknown): {
  transport: Parameters<typeof makeLiveSessionProfilerOpsRpcService>[0]
  sent: DesktopCommandRequest[]
} {
  const messages = new EventEmitter()
  const sent: DesktopCommandRequest[] = []
  return {
    sent,
    transport: {
      getSend: () => (message, callback) => {
        const request = message as DesktopCommandRequest
        sent.push(request)
        callback(null)
        setImmediate(() => messages.emit('message', answer(request)))
        return true
      },
      messages
    }
  }
}

describe('session profiler ops RPC mocked provider', () => {
  it('routes sessionProfilerOps.getSnapshot to the injected provider service', async () => {
    const getSnapshot = vi.fn(() => Effect.succeed(snapshot))
    const service = { getSnapshot } as unknown as SessionProfilerOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), sessionProfilerOps: service })

    const response = await Effect.runPromise(
      router.handle({ id: 'profiler-1', method: 'sessionProfilerOps.getSnapshot', params: {} })
    )

    expect(getSnapshot).toHaveBeenCalledWith()
    expect(response).toEqual({ id: 'profiler-1', ok: true, value: snapshot })
  })

  it('validates sessionProfilerOps.getSnapshot params', async () => {
    const getSnapshot = vi.fn(() => Effect.succeed(snapshot))
    const service = { getSnapshot } as unknown as SessionProfilerOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), sessionProfilerOps: service })

    const response = await Effect.runPromise(
      router.handle({
        id: 'profiler-invalid',
        method: 'sessionProfilerOps.getSnapshot',
        params: { unexpected: true }
      })
    )

    expect(getSnapshot).not.toHaveBeenCalled()
    expect(response).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('routes a valid sessionProfilerOps.kill to the provider service', async () => {
    const kill = vi.fn(() => Effect.succeed({ ok: true, method: 'signal' as const }))
    const service = { kill } as unknown as SessionProfilerOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), sessionProfilerOps: service })
    const params = { sessionId: null, pid: 4242, startedAt: 'Wed Oct 21 00:46:03 2026' }

    const response = await Effect.runPromise(
      router.handle({ id: 'kill-1', method: 'sessionProfilerOps.kill', params })
    )

    expect(kill).toHaveBeenCalledWith(params)
    expect(response).toEqual({ id: 'kill-1', ok: true, value: { ok: true, method: 'signal' } })
  })

  it.each([
    ['no target', {}],
    ['a negative pid', { pid: -1, startedAt: 'x' }],
    ['a fractional pid', { pid: 1.5 }],
    ['an unknown key', { sessionId: 's', signal: 'SIGKILL' }],
    ['a non-string session id', { sessionId: 42 }]
  ])('rejects sessionProfilerOps.kill with %s', async (_label, params) => {
    const kill = vi.fn(() => Effect.succeed({ ok: true }))
    const service = { kill } as unknown as SessionProfilerOpsRpcService
    const router = makeRpcRouter({ eventBus: makeEventBus(), sessionProfilerOps: service })

    const response = await Effect.runPromise(
      router.handle({ id: 'kill-invalid', method: 'sessionProfilerOps.kill', params })
    )

    expect(kill).not.toHaveBeenCalled()
    expect(response).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('reports unsupported without a desktop parent', async () => {
    const service = makeLiveSessionProfilerOpsRpcService({
      getSend: () => undefined,
      messages: new EventEmitter()
    })

    const result = await Effect.runPromise(service.getSnapshot())
    expect(result).toMatchObject({ supported: false, sessions: [] })
    expect(result.error).toBeUndefined()
    expect(await Effect.runPromise(service.kill({ sessionId: 's' }))).toEqual({
      ok: false,
      error: 'unsupported'
    })
  })

  it('forwards both methods to the Electron main process as desktop commands', async () => {
    const { transport, sent } = makeTransport((request) =>
      makeDesktopCommandResult(request.id, {
        ok: true,
        value:
          request.command === 'sessionProfilerSnapshot' ? snapshot : { ok: true, method: 'pty' }
      })
    )
    const service = makeLiveSessionProfilerOpsRpcService(transport)

    expect(await Effect.runPromise(service.getSnapshot())).toEqual(snapshot)
    expect(await Effect.runPromise(service.kill({ sessionId: 'session-1' }))).toEqual({
      ok: true,
      method: 'pty'
    })
    expect(sent.map((request) => request.command)).toEqual([
      'sessionProfilerSnapshot',
      'sessionProfilerKill'
    ])
    expect(sent[1]).toMatchObject({ payload: { sessionId: 'session-1' } })
  })

  it('turns a failed desktop command into an error result instead of an RPC failure', async () => {
    const { transport } = makeTransport((request) =>
      makeDesktopCommandResult(request.id, { ok: false, error: 'ps timed out' })
    )
    const service = makeLiveSessionProfilerOpsRpcService(transport)

    expect(await Effect.runPromise(service.getSnapshot())).toMatchObject({
      supported: true,
      sessions: [],
      error: 'ps timed out'
    })
    expect(await Effect.runPromise(service.kill({ pid: 9 }))).toEqual({
      ok: false,
      error: 'ps timed out'
    })
  })
})
