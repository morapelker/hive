import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetRendererRpcClientForTests,
  setRendererRpcClient,
  type RendererRpcClient
} from '@/api/rpc-client'
import {
  instrumentRendererRpcClient,
  isRendererPerfLoggingEnabled,
  shallowSizes,
  startRendererPerfCollector,
  stopRendererPerfCollector
} from './renderer-perf-collector'

describe('shallowSizes', () => {
  it('reports top-level collection sizes and nested totals without serializing', () => {
    const state = {
      sessions: [1, 2, 3],
      messagesBySession: { a: [1, 2], b: [3] },
      byId: new Map([['x', new Set([1, 2])]]),
      flag: true,
      fn: () => undefined
    }
    expect(shallowSizes(state)).toEqual({
      sessions: 3,
      messagesBySession: 2,
      'messagesBySession.*': 3,
      byId: 1,
      'byId.*': 2
    })
  })
})

describe('instrumentRendererRpcClient', () => {
  afterEach(() => {
    stopRendererPerfCollector()
    resetRendererRpcClientForTests()
    vi.useRealTimers()
  })

  it('passes requests through untouched while logging is off', async () => {
    const request = vi.fn().mockResolvedValue('value')
    const subscribe = vi.fn()
    const client = instrumentRendererRpcClient({ request, subscribe })
    await expect(client.request('db.get', { id: 1 })).resolves.toBe('value')
    expect(request).toHaveBeenCalledWith('db.get', { id: 1 })
    expect(client.subscribe).toBeDefined()
    expect(isRendererPerfLoggingEnabled()).toBe(false)
  })

  it('ships timed samples to the backend while enabled', async () => {
    vi.useFakeTimers()
    const request = vi.fn((method: string, _params?: unknown): Promise<unknown> => {
      if (method === 'perfDiagnosticsOps.appendRecords') return Promise.resolve(undefined)
      return Promise.resolve('ok')
    })
    const client = instrumentRendererRpcClient({
      request: request as unknown as RendererRpcClient['request'],
      subscribe: vi.fn()
    })
    setRendererRpcClient(client)

    startRendererPerfCollector()
    expect(isRendererPerfLoggingEnabled()).toBe(true)
    await client.request('db.listSessions', {})
    await vi.advanceTimersByTimeAsync(10_100)

    const appendCalls = request.mock.calls.filter(
      ([method]) => method === 'perfDiagnosticsOps.appendRecords'
    )
    expect(appendCalls.length).toBeGreaterThan(0)
    const records = appendCalls.flatMap(
      (call) => (call[1] as { records: Array<Record<string, unknown>> }).records
    )
    expect(records.some((r) => r.kind === 'start')).toBe(true)
    const sample = records.find((r) => r.kind === 'sample') as
      | { rpc: { count: number; top: Array<{ method: string }> }; dom: { nodes: number } }
      | undefined
    expect(sample).toBeDefined()
    expect(sample?.rpc.top.some((m) => m.method === 'db.listSessions')).toBe(true)
    expect(sample?.dom.nodes).toBeGreaterThan(0)
  })
})
