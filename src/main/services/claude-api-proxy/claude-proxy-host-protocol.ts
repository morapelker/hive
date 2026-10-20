/**
 * Messages between the Electron main process and the Claude API proxy host
 * (`claude-proxy-host.ts`, an Electron utility process).
 *
 * The host owns the sockets; main owns the policy (where the upstream is,
 * whether perf logging is on) and the consumers (the live usage updater, the
 * DB, the Keychain). Everything crossing this boundary is structured-clone
 * safe and small: request bodies never leave the host — the one field the
 * updater needs from a body (`accountUuid`) is extracted on the host side.
 */
import type http from 'http'
import type {
  LocalApiProxyExchange,
  LocalApiProxyProbeResult,
  LocalApiProxyRequestRecord,
  LocalApiProxyStats
} from './local-api-proxy'

export const CLAUDE_PROXY_HOST_SERVICE_NAME = 'claude-api-proxy'

/** Exit code the host uses when its own thread-pool probe declares a stall. */
export const CLAUDE_PROXY_HOST_EXIT_STALLED = 70
/** Exit code for an uncaught exception in the host. */
export const CLAUDE_PROXY_HOST_EXIT_CRASHED = 71

/** An exchange as the host reports it: no body, the account uuid already extracted. */
export interface ClaudeProxyExchange extends Omit<LocalApiProxyExchange, 'requestBody'> {
  requestBody: null
  /** `metadata.user_id`'s account uuid from the request body, when the body carried one. */
  accountUuid: string | null
  requestHeaders: http.IncomingHttpHeaders
  responseHeaders: http.IncomingHttpHeaders
}

export interface ClaudeProxyHostStartCommand {
  type: 'start'
  port: number
  host: string
  upstream: string
  ca: string[]
  connectTimeoutMs?: number
  /** Keep retrying the preferred port for this long before falling back (a restart must reuse the port). */
  bindRetryMs: number
  perfEnabled: boolean
}

export type ClaudeProxyHostCommand =
  | ClaudeProxyHostStartCommand
  | { type: 'upstream'; url: string }
  | { type: 'perf'; enabled: boolean }
  | { type: 'drop-idle-sockets' }
  | { type: 'ping'; id: number }
  | { type: 'probe-upstream'; id: number; timeoutMs: number }
  | { type: 'dump-handles'; reason: string }
  | { type: 'shutdown' }

export interface ClaudeProxyHostHealth {
  pid: number
  uptimeMs: number
  rssMb: number
  stats: LocalApiProxyStats
  probe: {
    ok: boolean
    consecutiveMisses: number
    fsMs: number | null
    dnsMs: number | null
    pendingRequests: number
    pendingLookups: string[]
  } | null
}

export type ClaudeProxyHostEvent =
  | { type: 'listening'; port: number; host: string; baseUrl: string }
  | { type: 'start-failed'; error: string }
  | { type: 'exchange'; exchange: ClaudeProxyExchange }
  | { type: 'request'; record: LocalApiProxyRequestRecord }
  | { type: 'log'; level: 'debug' | 'info' | 'warn'; message: string; data?: Record<string, unknown> }
  | { type: 'pong'; id: number; health: ClaudeProxyHostHealth }
  | { type: 'probe-result'; id: number; result: LocalApiProxyProbeResult }
  | { type: 'stall'; detail: Record<string, unknown> }

export function isClaudeProxyHostEvent(value: unknown): value is ClaudeProxyHostEvent {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

export function isClaudeProxyHostCommand(value: unknown): value is ClaudeProxyHostCommand {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}
