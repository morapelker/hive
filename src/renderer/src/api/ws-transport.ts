import type {
  RpcRequest,
  RpcResponse,
  ServerEvent,
  SubscriptionRequest,
  WebSocketSubscribeMessage,
  WebSocketUnsubscribeMessage
} from '@shared/rpc/protocol'

export type ServerEventListener = (event: ServerEvent) => void

export interface WsTransportOptions {
  readonly WebSocketCtor?: typeof WebSocket
  readonly idFactory?: () => string
  readonly webSocketTokenProvider?: () => Promise<string | null>
  readonly reconnectDelayMs?: number
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  /** Socket the request was sent on, so only that socket's close rejects it. */
  readonly socket: WebSocket
}

/** Longest reconnect delay; the exponential backoff stops growing here. */
const MAX_RECONNECT_DELAY_MS = 10_000
/** Upper bound of the random jitter added to every reconnect delay. */
const MAX_RECONNECT_JITTER_MS = 250

interface ActiveSubscription {
  readonly listeners: Set<ServerEventListener>
  readonly request: SubscriptionRequest
}

/** Counters for performance logging (see lib/perf-logging/renderer-perf-collector.ts). */
export interface WsTransportStats {
  readonly connected: boolean
  readonly pendingRequests: number
  readonly channels: number
  readonly listeners: number
  readonly reconnects: number
  /** Since the previous `stats({ reset: true })`. */
  readonly inboundMessages: number
  readonly inboundBytes: number
  readonly inboundByChannel: Record<string, { count: number; bytes: number }>
}

export class WsTransport {
  private socket: WebSocket | null = null
  private connectPromise: Promise<WebSocket> | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Map<string, ActiveSubscription>()
  private readonly WebSocketCtor: typeof WebSocket
  private readonly idFactory: () => string
  private readonly webSocketTokenProvider?: () => Promise<string | null>
  private readonly reconnectDelayMs: number
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private closed = false
  private everOpened = false
  private reconnects = 0
  private inboundMessages = 0
  private inboundBytes = 0
  private inboundByChannel = new Map<string, { count: number; bytes: number }>()

  constructor(
    private readonly wsBaseUrl: string,
    options: WsTransportOptions = {}
  ) {
    this.WebSocketCtor = options.WebSocketCtor ?? WebSocket
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID())
    this.webSocketTokenProvider = options.webSocketTokenProvider
    this.reconnectDelayMs = options.reconnectDelayMs ?? 250
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const socket = await this.connect()
    const id = this.idFactory()
    const request: RpcRequest = { id, method, params }

    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, socket })
    })
    socket.send(JSON.stringify(request))
    return response
  }

  subscribe(
    channel: string,
    listener: ServerEventListener,
    request: Partial<Omit<SubscriptionRequest, 'channel'>> = {}
  ): () => void {
    let subscription = this.eventListeners.get(channel)
    this.closed = false
    if (!subscription) {
      subscription = {
        listeners: new Set(),
        request: {
          channel,
          ...request
        }
      }
      this.eventListeners.set(channel, subscription)
    }
    subscription.listeners.add(listener)

    if (subscription.listeners.size === 1) this.sendSubscribe(subscription.request)
    // A failed token exchange creates no socket, so nothing else would retry.
    void this.connect().catch(() => this.scheduleReconnect())

    return () => {
      subscription?.listeners.delete(listener)
      if (subscription?.listeners.size === 0) {
        this.eventListeners.delete(channel)
        this.sendUnsubscribe(channel)
      }
    }
  }

  /** Counters for performance logging; `reset` starts a new window for the inbound totals. */
  stats(options: { reset?: boolean } = {}): WsTransportStats {
    let listeners = 0
    for (const subscription of this.eventListeners.values()) {
      listeners += subscription.listeners.size
    }
    const inboundByChannel: Record<string, { count: number; bytes: number }> = {}
    for (const [channel, entry] of this.inboundByChannel) inboundByChannel[channel] = entry
    const snapshot: WsTransportStats = {
      connected: this.socket?.readyState === this.WebSocketCtor.OPEN,
      pendingRequests: this.pending.size,
      channels: this.eventListeners.size,
      listeners,
      reconnects: this.reconnects,
      inboundMessages: this.inboundMessages,
      inboundBytes: this.inboundBytes,
      inboundByChannel
    }
    if (options.reset) {
      this.inboundMessages = 0
      this.inboundBytes = 0
      this.inboundByChannel = new Map()
    }
    return snapshot
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rejectPending(new Error('Hive WebSocket transport closed'))
    this.socket?.close()
    this.socket = null
    this.connectPromise = null
  }

  private connect(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === this.WebSocketCtor.OPEN) {
      return Promise.resolve(this.socket)
    }
    if (this.connectPromise) return this.connectPromise

    const openSocket = (webSocketUrl: string): Promise<WebSocket> =>
      new Promise<WebSocket>((resolve, reject) => {
        const socket = new this.WebSocketCtor(webSocketUrl)
        let settled = false
        this.socket = socket
        // Every handler below checks `this.socket === socket`: after a reconnect race the
        // events of a superseded socket must not touch the shared state of the current one.

        socket.addEventListener('open', () => {
          if (this.socket !== socket) {
            socket.close()
            if (!settled) {
              settled = true
              reject(new Error('Hive WebSocket was superseded while connecting'))
            }
            return
          }
          settled = true
          this.reconnectAttempt = 0
          if (this.everOpened) this.reconnects += 1
          this.everOpened = true
          this.connectPromise = null
          this.sendSubscriptions(socket)
          resolve(socket)
        })

        socket.addEventListener('message', (event) => {
          if (this.socket !== socket) return
          this.handleMessage(event.data)
        })

        socket.addEventListener('close', () => {
          if (!settled) {
            settled = true
            reject(new Error(`Hive WebSocket closed before connecting at ${webSocketUrl}`))
          }
          this.rejectPending(new Error('Hive WebSocket connection closed'), socket)
          if (this.socket !== socket) return
          this.socket = null
          this.connectPromise = null
          this.scheduleReconnect()
        })

        socket.addEventListener('error', () => {
          const error = new Error(`Failed to connect Hive WebSocket at ${this.wsBaseUrl}`)
          if (!settled) {
            settled = true
            reject(error)
          }
          this.rejectPending(error, socket)
        })
      })

    const webSocketUrl = this.createWebSocketUrl()
    const connectPromise =
      typeof webSocketUrl === 'string' ? openSocket(webSocketUrl) : webSocketUrl.then(openSocket)
    const tracked: Promise<WebSocket> = connectPromise.catch((error) => {
      if (this.connectPromise === tracked) this.connectPromise = null
      throw error
    })
    this.connectPromise = tracked

    return tracked
  }

  private createWebSocketUrl(): string | Promise<string> {
    if (!this.webSocketTokenProvider) return this.wsBaseUrl

    return this.webSocketTokenProvider().then((token) => {
      if (!token) return this.wsBaseUrl

      const url = new URL(this.wsBaseUrl)
      url.searchParams.set('token', token)
      return url.toString()
    })
  }

  private handleMessage(raw: unknown): void {
    const text = String(raw)
    const message = JSON.parse(text) as RpcResponse | ServerEvent
    this.inboundMessages += 1
    this.inboundBytes += text.length
    if ('id' in message) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)

      if (message.ok) {
        pending.resolve(message.value)
      } else {
        const error = new Error(message.error.message) as Error & { details?: unknown }
        error.name = message.error.code
        error.details = message.error.details
        pending.reject(error)
      }
      return
    }

    const key = collapseChannel(message.channel)
    const entry = this.inboundByChannel.get(key)
    if (entry) {
      entry.count += 1
      entry.bytes += text.length
    } else {
      this.inboundByChannel.set(key, { count: 1, bytes: text.length })
    }
    const subscription = this.eventListeners.get(message.channel)
    if (!subscription) return
    for (const listener of subscription.listeners) listener(message)
  }

  /** Rejects every pending request, or only those sent on `socket` when given. */
  private rejectPending(error: Error, socket?: WebSocket): void {
    for (const [id, pending] of this.pending) {
      if (socket && pending.socket !== socket) continue
      this.pending.delete(id)
      pending.reject(error)
    }
  }

  /**
   * Exponential backoff with jitter: a slow or restarting backend must not be hammered with
   * a token exchange plus a socket every 250 ms. The counter resets once a socket opens.
   */
  private nextReconnectDelayMs(): number {
    const backoff = Math.min(
      this.reconnectDelayMs * 2 ** this.reconnectAttempt,
      MAX_RECONNECT_DELAY_MS
    )
    // Jitter never exceeds the base delay so a zero base (tests) stays immediate.
    const jitter = Math.random() * Math.min(this.reconnectDelayMs, MAX_RECONNECT_JITTER_MS)
    return backoff + jitter
  }

  private scheduleReconnect(): void {
    if (this.closed || this.eventListeners.size === 0 || this.reconnectTimer) return

    const delayMs = this.nextReconnectDelayMs()
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closed || this.eventListeners.size === 0) return

      void this.connect().catch(() => {
        this.scheduleReconnect()
      })
    }, delayMs)
  }

  private sendSubscriptions(socket: WebSocket): void {
    for (const subscription of this.eventListeners.values()) {
      socket.send(JSON.stringify(toSubscribeMessage(subscription.request)))
    }
  }

  private sendSubscribe(request: SubscriptionRequest): void {
    if (this.socket?.readyState === this.WebSocketCtor.OPEN) {
      this.socket.send(JSON.stringify(toSubscribeMessage(request)))
    }
  }

  private sendUnsubscribe(channel: string): void {
    if (this.socket?.readyState === this.WebSocketCtor.OPEN) {
      const message: WebSocketUnsubscribeMessage = { type: 'unsubscribe', channel }
      this.socket.send(JSON.stringify(message))
    }
  }
}

const toSubscribeMessage = (request: SubscriptionRequest): WebSocketSubscribeMessage => ({
  type: 'subscribe',
  ...request
})

/** `session:<uuid>:stream` → `session:*:stream` so per-entity channels aggregate in stats. */
const collapseChannel = (channel: string): string =>
  channel
    .split(':')
    .map((part) =>
      /^[0-9a-f-]{16,}$/i.test(part) ||
      /^\d{4,}$/.test(part) ||
      (part.includes('-') && /\d/.test(part) && part.length >= 12) ||
      part.length > 40
        ? '*'
        : part
    )
    .join(':')
