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
}

interface ActiveSubscription {
  readonly listeners: Set<ServerEventListener>
  readonly request: SubscriptionRequest
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
  private closed = false

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
      this.pending.set(id, { resolve, reject })
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
    void this.connect().catch(() => undefined)

    return () => {
      subscription?.listeners.delete(listener)
      if (subscription?.listeners.size === 0) {
        this.eventListeners.delete(channel)
        this.sendUnsubscribe(channel)
      }
    }
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
        let opened = false
        this.socket = socket

        socket.addEventListener('open', () => {
          opened = true
          this.connectPromise = null
          this.sendSubscriptions(socket)
          resolve(socket)
        })

        socket.addEventListener('message', (event) => {
          this.handleMessage(event.data)
        })

        socket.addEventListener('close', () => {
          if (this.socket === socket) this.socket = null
          if (!opened && this.connectPromise) {
            this.connectPromise = null
            reject(new Error(`Hive WebSocket closed before connecting at ${webSocketUrl}`))
          }
          this.connectPromise = null
          this.rejectPending(new Error('Hive WebSocket connection closed'))
          this.scheduleReconnect()
        })

        socket.addEventListener('error', () => {
          const error = new Error(`Failed to connect Hive WebSocket at ${this.wsBaseUrl}`)
          if (this.connectPromise) {
            this.connectPromise = null
            reject(error)
          }
          this.rejectPending(error)
        })
      })

    const webSocketUrl = this.createWebSocketUrl()
    const connectPromise =
      typeof webSocketUrl === 'string' ? openSocket(webSocketUrl) : webSocketUrl.then(openSocket)
    this.connectPromise = connectPromise.catch((error) => {
      this.connectPromise = null
      throw error
    })

    return this.connectPromise
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
    const message = JSON.parse(String(raw)) as RpcResponse | ServerEvent
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

    const subscription = this.eventListeners.get(message.channel)
    if (!subscription) return
    for (const listener of subscription.listeners) listener(message)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }

  private scheduleReconnect(): void {
    if (this.closed || this.eventListeners.size === 0 || this.reconnectTimer) return

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closed || this.eventListeners.size === 0) return

      void this.connect().catch(() => {
        this.scheduleReconnect()
      })
    }, this.reconnectDelayMs)
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
