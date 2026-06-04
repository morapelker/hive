import WebSocket from 'ws'
import type { TeleportSettings } from '@shared/types/settings'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import { getDatabase } from '../db'

const REQUEST_TIMEOUT_MS = 30_000

export interface TeleportRemoteReceiveParams {
  gitUrl: string
  branch: string
  headSha: string
  projectName: string
  claudeSessionId: string
  transcript: string
  model: {
    providerId: string | null
    id: string | null
    variant: string | null
  }
  mode: 'build' | 'plan' | 'super-plan'
}

export interface TeleportRemoteReceiveResult {
  success: true
  channelId: string
  channelUrl: string
  remoteWorktreeId: string
  remoteSessionId: string
}

interface RpcResponse<T> {
  id: string
  ok: boolean
  value?: T
  error?: {
    code: string
    message: string
    details?: unknown
  }
}

export function parseTeleportSettings(raw: string | null): TeleportSettings {
  if (!raw) {
    throw new Error('Teleport remote is not configured')
  }

  let parsed: { teleport?: Partial<TeleportSettings> | null }
  try {
    parsed = JSON.parse(raw) as { teleport?: Partial<TeleportSettings> | null }
  } catch {
    // Corrupted/non-JSON settings should surface as "not configured", not an
    // opaque SyntaxError.
    throw new Error('Teleport remote is not configured')
  }
  const url = parsed.teleport?.url?.trim()
  const bootstrapToken = parsed.teleport?.bootstrapToken?.trim()
  if (!url || !bootstrapToken) {
    throw new Error('Teleport remote is not configured')
  }

  return { url, bootstrapToken }
}

export function targetFromSettings(settings: TeleportSettings): {
  httpBaseUrl: string
  wsBaseUrl: string
  bootstrapToken: string
} {
  const httpUrl = new URL(settings.url)
  httpUrl.hash = ''
  httpUrl.search = ''
  httpUrl.pathname = httpUrl.pathname.replace(/\/+$/, '')
  const httpBaseUrl = httpUrl.toString().replace(/\/+$/, '')

  const wsUrl = new URL(httpBaseUrl)
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  // Append '/ws' to the configured base path rather than replacing it, so
  // sub-path deployments (e.g. https://host/teleport) connect to the right
  // endpoint. Root URLs (empty pathname) still resolve to '/ws'.
  wsUrl.pathname = `${wsUrl.pathname.replace(/\/+$/, '')}/ws`

  return {
    httpBaseUrl,
    wsBaseUrl: wsUrl.toString().replace(/\/+$/, ''),
    bootstrapToken: settings.bootstrapToken
  }
}

export function getTeleportSettings(): TeleportSettings {
  return parseTeleportSettings(getDatabase().getSetting(APP_SETTINGS_DB_KEY))
}

async function issueWebSocketToken(target: ReturnType<typeof targetFromSettings>): Promise<string> {
  const bootstrapResponse = await fetch(`${target.httpBaseUrl}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: target.bootstrapToken })
  })
  if (!bootstrapResponse.ok) throw new Error('Failed to authenticate Hive backend session')
  const bootstrap = (await bootstrapResponse.json()) as { session: { accessToken: string } }

  const wsTokenResponse = await fetch(`${target.httpBaseUrl}/api/auth/ws-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bootstrap.session.accessToken}` }
  })
  if (!wsTokenResponse.ok) throw new Error('Failed to issue Hive WebSocket token')
  const wsToken = (await wsTokenResponse.json()) as { webSocketToken: { token: string } }
  return wsToken.webSocketToken.token
}

export async function requestRemote<T>(
  target: ReturnType<typeof targetFromSettings>,
  method: string,
  params: unknown,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<T> {
  const token = await issueWebSocketToken(target)
  const url = new URL(target.wsBaseUrl)
  url.searchParams.set('token', token)
  const id = crypto.randomUUID()

  return new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(url)
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // ignore close errors during teardown
      }
      action()
    }
    // Without this the promise would hang forever on a clean close or a stalled
    // connection (the 'close' handler used to be a no-op and there was no timeout).
    const timer = setTimeout(
      () => finish(() => reject(new Error('Remote Hive RPC timed out'))),
      timeoutMs
    )

    socket.on('open', () => {
      socket.send(JSON.stringify({ id, method, params }))
    })
    socket.on('message', (data) => {
      let response: RpcResponse<T>
      try {
        response = JSON.parse(String(data)) as RpcResponse<T>
      } catch {
        // Ignore non-JSON frames (heartbeats, proxy noise) instead of throwing
        // inside the listener and leaving the promise unsettled.
        return
      }
      if (response.id !== id) return
      if (response.ok) {
        finish(() => resolve(response.value as T))
      } else {
        finish(() => {
          const error = new Error(response.error?.message ?? 'Remote Hive RPC failed') as Error & {
            details?: unknown
          }
          error.name = response.error?.code ?? 'RemoteHiveRpcError'
          error.details = response.error?.details
          reject(error)
        })
      }
    })
    socket.on('error', (error) => finish(() => reject(error)))
    socket.on('close', () =>
      finish(() => reject(new Error('Remote Hive connection closed before responding')))
    )
  })
}

export async function withTeleportRemote<T>(
  fn: (client: {
    request: <TValue = unknown>(method: string, params?: unknown) => Promise<TValue>
  }) => Promise<T>
): Promise<T> {
  const target = targetFromSettings(getTeleportSettings())
  return fn({
    request: (method, params) => requestRemote(target, method, params)
  })
}

export async function sendTeleportReceive(
  params: TeleportRemoteReceiveParams
): Promise<TeleportRemoteReceiveResult> {
  return withTeleportRemote((client) =>
    client.request<TeleportRemoteReceiveResult>('teleportOps.receive', params)
  )
}
