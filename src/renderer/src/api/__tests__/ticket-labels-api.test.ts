import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { ticketLabelsApi } from '../ticket-labels-api'
import { WsTransport } from '../ws-transport'

const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => queueMicrotask(resolve))
}

/** Just enough of a WebSocket for one request (same shape as ws-transport.test.ts). */
class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  serverMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }))
  }
}

const label = {
  id: 'lbl-1',
  name: 'Waiting for Joy',
  color: 'yellow',
  sort_order: 0,
  created_at: '2026-10-22T00:00:00.000Z',
  updated_at: '2026-10-22T00:00:00.000Z'
}

describe('ticketLabelsApi', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
    FakeWebSocket.instances = []
  })

  it('routes every catalog call through the renderer RPC client with the server params', async () => {
    const mutation = { label, affectedProjectIds: ['p1'] }
    const request = vi.fn().mockResolvedValue(undefined)
    setRendererRpcClient({ request, subscribe: vi.fn() })

    request.mockResolvedValueOnce([label])
    await expect(ticketLabelsApi.list()).resolves.toEqual([label])
    expect(request).toHaveBeenLastCalledWith('ticketLabels.list', {})

    request.mockResolvedValueOnce(label)
    await expect(
      ticketLabelsApi.create({ name: 'Waiting for Joy', color: 'yellow' })
    ).resolves.toBe(label)
    expect(request).toHaveBeenLastCalledWith('ticketLabels.create', {
      name: 'Waiting for Joy',
      color: 'yellow'
    })

    request.mockResolvedValueOnce(mutation)
    await expect(ticketLabelsApi.update('lbl-1', { color: 'teal' })).resolves.toBe(mutation)
    expect(request).toHaveBeenLastCalledWith('ticketLabels.update', {
      id: 'lbl-1',
      data: { color: 'teal' }
    })

    request.mockResolvedValueOnce(mutation)
    await expect(ticketLabelsApi.reorder(['lbl-2', 'lbl-1'])).resolves.toBe(mutation)
    expect(request).toHaveBeenLastCalledWith('ticketLabels.reorder', { ids: ['lbl-2', 'lbl-1'] })

    request.mockResolvedValueOnce(mutation)
    await expect(ticketLabelsApi.delete('lbl-1')).resolves.toBe(mutation)
    expect(request).toHaveBeenLastCalledWith('ticketLabels.delete', { id: 'lbl-1' })

    request.mockResolvedValueOnce({ 'lbl-1': 3 })
    await expect(ticketLabelsApi.usage()).resolves.toEqual({ 'lbl-1': 3 })
    expect(request).toHaveBeenLastCalledWith('ticketLabels.usage', {})
  })

  it("rejects with the server's message, so a name clash can be shown as is", async () => {
    // The server's router turns the DB's Error into { code: 'INTERNAL_ERROR', message } (see
    // rpc/domains/__tests__/ticket-labels.test.ts); here the real WebSocket transport turns that
    // response back into an Error carrying the same message.
    const message = 'A label named "Waiting for Joy" already exists'
    const transport = new WsTransport('ws://127.0.0.1:3773/ws', {
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      idFactory: () => 'req-1'
    })
    setRendererRpcClient({
      request: <T>(method: string, params?: unknown) =>
        transport.request(method, params) as Promise<T>,
      subscribe: vi.fn()
    })

    const created = ticketLabelsApi.create({ name: 'waiting for joy', color: 'red' })
    await flushPromises()
    const socket = FakeWebSocket.instances[0]
    socket.open()
    await flushPromises()
    expect(JSON.parse(socket.sent[0])).toEqual({
      id: 'req-1',
      method: 'ticketLabels.create',
      params: { name: 'waiting for joy', color: 'red' }
    })
    socket.serverMessage({ id: 'req-1', ok: false, error: { code: 'INTERNAL_ERROR', message } })

    await expect(created).rejects.toThrow(message)
    transport.close()
  })
})
