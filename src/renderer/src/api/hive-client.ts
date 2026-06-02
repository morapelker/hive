import { resolveBackendTarget, type BackendTarget } from './environment'
import { WsTransport, type ServerEventListener, type WsTransportOptions } from './ws-transport'
import type { SubscriptionRequest } from '@shared/rpc/protocol'

export interface HiveClientOptions extends WsTransportOptions {
  readonly target: BackendTarget
  readonly fetch?: typeof fetch
}

export class HiveClient {
  private readonly transport: WsTransport

  constructor(readonly target: BackendTarget, options: Omit<HiveClientOptions, 'target'> = {}) {
    const {
      fetch: fetchImpl = fetch,
      webSocketTokenProvider,
      ...transportOptions
    } = options
    this.transport = new WsTransport(target.wsBaseUrl, {
      ...transportOptions,
      webSocketTokenProvider:
        webSocketTokenProvider ?? createWebSocketTokenProvider(target, fetchImpl)
    })
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.transport.request(method, params) as Promise<T>
  }

  subscribe(channel: string, listener: ServerEventListener): () => void
  subscribe(
    channel: string,
    params: Partial<Omit<SubscriptionRequest, 'channel'>>,
    listener: ServerEventListener
  ): () => void
  subscribe(
    channel: string,
    paramsOrListener: Partial<Omit<SubscriptionRequest, 'channel'>> | ServerEventListener,
    maybeListener?: ServerEventListener
  ): () => void {
    if (typeof paramsOrListener === 'function') {
      return this.transport.subscribe(channel, paramsOrListener)
    }

    return this.transport.subscribe(channel, maybeListener as ServerEventListener, paramsOrListener)
  }

  close(): void {
    this.transport.close()
  }
}

export const createHiveClient = async (
  options: Omit<HiveClientOptions, 'target'> = {}
): Promise<HiveClient> => new HiveClient(await resolveBackendTarget(), options)

interface AuthSession {
  readonly accessToken: string
}

interface BootstrapResponse {
  readonly session: AuthSession
}

interface WebSocketTokenResponse {
  readonly webSocketToken: {
    readonly token: string
  }
}

const createWebSocketTokenProvider = (
  target: BackendTarget,
  fetchImpl: typeof fetch
): (() => Promise<string | null>) | undefined => {
  if (!target.bootstrapToken) return undefined

  let sessionPromise: Promise<AuthSession> | null = null
  const getSession = async (): Promise<AuthSession> => {
    sessionPromise ??= fetchImpl(`${target.httpBaseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: target.bootstrapToken })
    }).then(async (response) => {
      if (!response.ok) throw new Error('Failed to authenticate Hive backend session')
      const body = (await response.json()) as BootstrapResponse
      return body.session
    })
    return sessionPromise
  }

  return async () => {
    const session = await getSession()
    const response = await fetchImpl(`${target.httpBaseUrl}/api/auth/ws-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessToken}` }
    })
    if (!response.ok) {
      sessionPromise = null
      throw new Error('Failed to issue Hive WebSocket token')
    }

    const body = (await response.json()) as WebSocketTokenResponse
    return body.webSocketToken.token
  }
}
