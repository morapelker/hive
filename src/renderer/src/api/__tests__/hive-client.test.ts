import { describe, expect, it, vi } from 'vitest'
import { HiveClient } from '../hive-client'

const flushPromises = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
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

describe('HiveClient', () => {
  it('sends system.ping over WebSocket RPC', async () => {
    FakeWebSocket.instances = []
    const client = new HiveClient(
      {
        httpBaseUrl: 'http://127.0.0.1:3773',
        wsBaseUrl: 'ws://127.0.0.1:3773/ws',
        bootstrapToken: null,
        source: 'desktop'
      },
      {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
        idFactory: () => 'request-1'
      }
    )

    const request = client.request<{ ok: true }>('system.ping', {})
    const socket = FakeWebSocket.instances[0]
    socket.open()
    await flushPromises()

    expect(JSON.parse(socket.sent[0])).toEqual({
      id: 'request-1',
      method: 'system.ping',
      params: {}
    })

    socket.serverMessage({ id: 'request-1', ok: true, value: { ok: true } })
    await expect(request).resolves.toEqual({ ok: true })
    client.close()
  })

  it('rejects request promises for RPC error responses', async () => {
    FakeWebSocket.instances = []
    const client = new HiveClient(
      {
        httpBaseUrl: 'http://127.0.0.1:3773',
        wsBaseUrl: 'ws://127.0.0.1:3773/ws',
        bootstrapToken: null,
        source: 'desktop'
      },
      {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
        idFactory: () => 'request-2'
      }
    )

    const request = client.request('missing.method', {})
    const socket = FakeWebSocket.instances[0]
    socket.open()
    await flushPromises()
    socket.serverMessage({
      id: 'request-2',
      ok: false,
      error: { code: 'METHOD_NOT_FOUND', message: 'Unknown RPC method' }
    })

    await expect(request).rejects.toMatchObject({
      name: 'METHOD_NOT_FOUND',
      message: 'Unknown RPC method'
    })
    client.close()
  })

  it('dispatches server events to subscribed listeners', async () => {
    FakeWebSocket.instances = []
    const client = new HiveClient(
      {
        httpBaseUrl: 'http://127.0.0.1:3773',
        wsBaseUrl: 'ws://127.0.0.1:3773/ws',
        bootstrapToken: null,
        source: 'desktop'
      },
      { WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket }
    )
    const listener = vi.fn()
    const unsubscribe = client.subscribe('git:statusChanged', listener)
    const socket = FakeWebSocket.instances.at(-1)!
    socket.open()
    await flushPromises()

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'subscribe', channel: 'git:statusChanged' })
    ])

    socket.serverMessage({ channel: 'git:statusChanged', payload: { worktreePath: '/tmp/repo' } })
    expect(listener).toHaveBeenCalledWith({
      channel: 'git:statusChanged',
      payload: { worktreePath: '/tmp/repo' }
    })

    unsubscribe()
    socket.serverMessage({ channel: 'git:statusChanged', payload: { worktreePath: '/tmp/repo' } })
    expect(listener).toHaveBeenCalledTimes(1)

    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'subscribe', channel: 'git:statusChanged' }),
      JSON.stringify({ type: 'unsubscribe', channel: 'git:statusChanged' })
    ])
    client.close()
  })

  it('sends subscription params with WebSocket subscribe requests', async () => {
    FakeWebSocket.instances = []
    const client = new HiveClient(
      {
        httpBaseUrl: 'http://127.0.0.1:3773',
        wsBaseUrl: 'ws://127.0.0.1:3773/ws',
        bootstrapToken: null,
        source: 'desktop'
      },
      { WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket }
    )
    const listener = vi.fn()
    const unsubscribe = client.subscribe(
      'terminal:data:terminal-1',
      { filter: { terminalId: 'terminal-1' } },
      listener
    )
    const socket = FakeWebSocket.instances.at(-1)!
    socket.open()
    await flushPromises()

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        channel: 'terminal:data:terminal-1',
        filter: { terminalId: 'terminal-1' }
      })
    ])

    unsubscribe()
    client.close()
  })

  it('reconnects active subscriptions and resubscribes after an unexpected close', async () => {
    FakeWebSocket.instances = []
    const client = new HiveClient(
      {
        httpBaseUrl: 'http://127.0.0.1:3773',
        wsBaseUrl: 'ws://127.0.0.1:3773/ws',
        bootstrapToken: null,
        source: 'desktop'
      },
      {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
        reconnectDelayMs: 0
      }
    )
    const listener = vi.fn()
    client.subscribe('git:statusChanged', listener)
    const firstSocket = FakeWebSocket.instances[0]
    firstSocket.open()
    await flushPromises()

    firstSocket.close()
    const secondSocket = await waitForFakeSocketCount(2)
    secondSocket.open()
    await waitForSentFrame(secondSocket)

    expect(secondSocket.sent).toEqual([
      JSON.stringify({ type: 'subscribe', channel: 'git:statusChanged' })
    ])
    secondSocket.serverMessage({
      channel: 'git:statusChanged',
      payload: { worktreePath: '/tmp/reconnected' }
    })
    expect(listener).toHaveBeenCalledWith({
      channel: 'git:statusChanged',
      payload: { worktreePath: '/tmp/reconnected' }
    })
    client.close()
  })

  it('exchanges the desktop bootstrap token before opening an authenticated WebSocket', async () => {
    FakeWebSocket.instances = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ session: { accessToken: 'access-token-1' } }))
      .mockResolvedValueOnce(jsonResponse({ webSocketToken: { token: 'ws-token-1' } }))
    const client = new HiveClient(
      {
        httpBaseUrl: 'http://127.0.0.1:3773',
        wsBaseUrl: 'ws://127.0.0.1:3773/ws',
        bootstrapToken: 'desktop-bootstrap-token',
        source: 'desktop'
      },
      {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
        idFactory: () => 'request-3',
        fetch: fetchMock as unknown as typeof fetch
      }
    )

    const request = client.request<{ ok: true }>('system.ping', {})
    const socket = await waitForFakeSocket()

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:3773/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: 'desktop-bootstrap-token' })
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:3773/api/auth/ws-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer access-token-1' }
    })
    expect(socket.url).toBe('ws://127.0.0.1:3773/ws?token=ws-token-1')

    socket.open()
    await waitForSentFrame(socket)
    socket.serverMessage({ id: 'request-3', ok: true, value: { ok: true } })
    await expect(request).resolves.toEqual({ ok: true })
    client.close()
  })
})

const jsonResponse = (body: unknown): Pick<Response, 'ok' | 'json'> => ({
  ok: true,
  json: () => Promise.resolve(body)
})

const waitForFakeSocket = async (): Promise<FakeWebSocket> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await flushPromises()
    const socket = FakeWebSocket.instances[0]
    if (socket) return socket
  }
  throw new Error('Expected FakeWebSocket to be created')
}

const waitForFakeSocketCount = async (count: number): Promise<FakeWebSocket> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const socket = FakeWebSocket.instances[count - 1]
    if (socket) return socket
  }
  throw new Error(`Expected ${count} FakeWebSocket instances`)
}

const waitForSentFrame = async (socket: FakeWebSocket): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await flushPromises()
    if (socket.sent.length > 0) return
  }
  throw new Error('Expected FakeWebSocket to send an RPC frame')
}
