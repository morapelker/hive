import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { WsTransport } from '../ws-transport'

const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => queueMicrotask(resolve))
}

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

  error(): void {
    this.dispatchEvent(new Event('error'))
  }

  serverMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }))
  }
}

const createTransport = (reconnectDelayMs = 250): WsTransport =>
  new WsTransport('ws://127.0.0.1:3773/ws', {
    WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    idFactory: (() => {
      let next = 0
      return () => `req-${(next += 1)}`
    })(),
    reconnectDelayMs
  })

/** Delays passed to setTimeout since the spy was installed. */
const scheduledDelays = (spy: MockInstance<typeof setTimeout>): number[] =>
  spy.mock.calls.map((call) => Number(call[1]))

describe('WsTransport', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.useFakeTimers()
    // Deterministic jitter: half of its maximum.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('backs off exponentially with jitter, capped at 10 s', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const transport = createTransport(250)
    transport.subscribe('git:statusChanged', vi.fn())
    const first = FakeWebSocket.instances[0]
    first.open()
    await flushPromises()

    // Base delay 250 ms doubles each attempt (+125 ms jitter) until the cap.
    const expected = [375, 625, 1125, 2125, 4125, 8125, 10125, 10125]
    first.close()
    for (let attempt = 0; attempt < expected.length; attempt += 1) {
      expect(scheduledDelays(setTimeoutSpy)).toEqual(expected.slice(0, attempt + 1))
      expect(FakeWebSocket.instances).toHaveLength(attempt + 1)
      await vi.advanceTimersByTimeAsync(expected[attempt] - 1)
      expect(FakeWebSocket.instances).toHaveLength(attempt + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeWebSocket.instances).toHaveLength(attempt + 2)
      // The backend is still down: the new socket closes before opening.
      FakeWebSocket.instances.at(-1)!.close()
      await flushPromises()
    }
    expect(scheduledDelays(setTimeoutSpy)).toEqual([...expected, 10125])
    transport.close()
  })

  it('resets the backoff once a socket opens', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const transport = createTransport(250)
    transport.subscribe('git:statusChanged', vi.fn())
    FakeWebSocket.instances[0].open()
    await flushPromises()

    FakeWebSocket.instances[0].close()
    await vi.advanceTimersByTimeAsync(375)
    FakeWebSocket.instances[1].close()
    await vi.advanceTimersByTimeAsync(625)
    expect(scheduledDelays(setTimeoutSpy)).toEqual([375, 625])

    // Third attempt succeeds, so the next outage starts over from the base delay.
    const third = FakeWebSocket.instances[2]
    third.open()
    await flushPromises()
    expect(transport.stats().reconnects).toBe(1)
    third.close()
    expect(scheduledDelays(setTimeoutSpy)).toEqual([375, 625, 375])
    transport.close()
  })

  it('keeps retrying after a failed token exchange even though no socket was created', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const transport = new WsTransport('ws://127.0.0.1:3773/ws', {
      WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
      webSocketTokenProvider: () => Promise.reject(new Error('backend down')),
      reconnectDelayMs: 250
    })
    transport.subscribe('git:statusChanged', vi.fn())
    await flushPromises()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(scheduledDelays(setTimeoutSpy)).toEqual([375])
    await vi.advanceTimersByTimeAsync(375)
    expect(scheduledDelays(setTimeoutSpy)).toEqual([375, 625])
    transport.close()
  })

  it("ignores a stale socket's close except for the requests sent on it", async () => {
    const transport = createTransport(250)
    transport.subscribe('git:statusChanged', vi.fn())
    const first = FakeWebSocket.instances[0]
    first.open()
    await flushPromises()
    const onFirst = transport.request('system.ping')
    const onFirstRejected = vi.fn()
    onFirst.catch(onFirstRejected)
    await flushPromises()
    expect(first.sent).toHaveLength(2)

    // The browser flips readyState before the close event is dispatched; a request made in
    // that window opens a replacement socket.
    first.readyState = FakeWebSocket.CLOSED
    const onSecond = transport.request('system.ping')
    const second = FakeWebSocket.instances[1]
    second.open()
    await flushPromises()
    expect(second.sent).toHaveLength(2)

    first.dispatchEvent(new Event('close'))
    await flushPromises()
    expect(onFirstRejected).toHaveBeenCalledTimes(1)
    expect(transport.stats()).toMatchObject({ connected: true, pendingRequests: 1 })

    // No reconnect was scheduled by the stale close and the new socket keeps serving.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    second.serverMessage({ id: JSON.parse(second.sent[1]).id, ok: true, value: 'pong' })
    await expect(onSecond).resolves.toBe('pong')
    transport.close()
  })

  it('closes a socket that opens after it was superseded', async () => {
    const transport = createTransport(250)
    transport.subscribe('git:statusChanged', vi.fn())
    const first = FakeWebSocket.instances[0]
    const onFirstRejected = vi.fn()
    const requestOnFirst = transport.request('system.ping')
    requestOnFirst.catch(onFirstRejected)
    first.error()
    await flushPromises()
    expect(onFirstRejected).toHaveBeenCalledTimes(1)

    const onSecond = transport.request('system.ping')
    const second = FakeWebSocket.instances[1]
    expect(second).toBeDefined()
    // The old socket still manages to open: it must be dropped, not adopted.
    first.open()
    await flushPromises()
    expect(first.readyState).toBe(FakeWebSocket.CLOSED)
    expect(first.sent).toEqual([])
    expect(transport.stats().connected).toBe(false)

    second.open()
    await flushPromises()
    expect(transport.stats()).toMatchObject({ connected: true, reconnects: 0 })
    expect(second.sent[0]).toBe(JSON.stringify({ type: 'subscribe', channel: 'git:statusChanged' }))
    second.serverMessage({ id: JSON.parse(second.sent[1]).id, ok: true, value: 'pong' })
    await expect(onSecond).resolves.toBe('pong')
    transport.close()
  })

  it('still rejects pending requests when the current socket closes', async () => {
    const transport = createTransport(250)
    transport.subscribe('git:statusChanged', vi.fn())
    const socket = FakeWebSocket.instances[0]
    socket.open()
    await flushPromises()
    const request = transport.request('system.ping')
    await flushPromises()

    socket.close()
    await expect(request).rejects.toThrow('Hive WebSocket connection closed')
    expect(transport.stats()).toMatchObject({ connected: false, pendingRequests: 0 })
    transport.close()
  })
})
