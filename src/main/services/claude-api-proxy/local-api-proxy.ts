/**
 * A byte-exact loopback reverse proxy built on Node's `http`/`https` only.
 *
 * Launched CLIs point their API base URL at `http://127.0.0.1:<port>`; every
 * request is streamed to the configured upstream unchanged (bar hop-by-hop
 * headers) and the response is streamed straight back, so SSE events reach the
 * client as the API emits them and compressed bodies stay compressed (this
 * layer never decodes anything). Observers get the request/response HEADERS
 * plus a bounded copy of the request body as soon as the upstream answers —
 * nothing is written to disk and credentials never leave the socket pair.
 *
 * Provider-agnostic on purpose: the Claude-specific upstream resolution and
 * header parsing live next door, and a Codex tunnel can reuse this unchanged.
 *
 * Two things here exist because of a night when every session's request
 * silently hung for ten minutes while the network was fine:
 *
 * - upstream names resolve through `upstream-dns.ts` (c-ares, cached), not
 *   through the thread-pool `getaddrinfo` that a wedged pool starves;
 * - a connect deadline turns a stalled TCP/TLS handshake into a retryable 502
 *   within seconds, and every request's outcome is logged with its phase and
 *   elapsed time so "the client gave up" and "the upstream failed" cannot be
 *   confused again.
 */
import http from 'http'
import https from 'https'
import type { AddressInfo, LookupFunction, Socket } from 'net'
import { pipeline } from 'stream'
import type { TLSSocket } from 'tls'
import { fingerprintRequestCredential } from '../credential-fingerprint'
import { perfLog } from '../perf-logging/perf-logger'
import { createUpstreamDns, type UpstreamDns, type UpstreamDnsStats } from './upstream-dns'

export interface LocalApiProxyExchange {
  method: string
  /** Request target as the client sent it (path + query). */
  path: string
  /** Request headers minus credentials (`authorization`, `x-api-key`, `cookie`, ...). */
  requestHeaders: http.IncomingHttpHeaders
  /**
   * SHA-256 of the credential the request authenticated with (bearer token or
   * API key), or null when it carried none. Lets an observer recognise WHICH
   * account's credential was used — the thing the upstream actually bills —
   * without ever seeing the credential.
   */
  credentialFingerprint: string | null
  /**
   * Full request body when it was captured (POST/PUT/PATCH under the capture
   * cap and fully received before the upstream answered), else null.
   */
  requestBody: Buffer | null
  status: number
  responseHeaders: http.IncomingHttpHeaders
  /** Epoch ms at which the upstream response headers arrived. */
  observedAt: number
  /** Milliseconds from the first request byte to the upstream response headers. */
  latencyMs: number
}

export interface LocalApiProxyLogger {
  debug: (message: string, data?: Record<string, unknown>) => void
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
}

export interface LocalApiProxyUpstreamTls {
  /**
   * Trust roots for the upstream TLS leg. The CLI terminates TLS itself and
   * trusts its bundled roots PLUS the OS store (and `NODE_EXTRA_CA_CERTS`);
   * this hop must trust the same set or every request behind a corporate
   * TLS-inspection proxy dies with a certificate error.
   */
  ca?: ReadonlyArray<string | Buffer>
}

export type LocalApiProxyPhase = 'connecting' | 'sending' | 'waiting' | 'streaming' | 'done'

export type LocalApiProxyOutcome =
  | 'ok'
  | 'upstream-error'
  | 'upstream-status'
  | 'connect-timeout'
  | 'client-abort'
  | 'client-abort-mid-stream'
  | 'upstream-drop-mid-stream'
  | 'rejected'

/** One finished request, for the perf log and the gauges. */
export interface LocalApiProxyRequestRecord {
  method: string
  path: string
  status: number | null
  outcome: LocalApiProxyOutcome
  /** Phase the request was in when it ended (`done` for a complete exchange). */
  phase: LocalApiProxyPhase
  /** Milliseconds from the first client byte to the upstream response headers, when they came. */
  ttfbMs: number | null
  totalMs: number
  /** Response body bytes relayed to the client. */
  bytesOut: number
  /** Whether the upstream socket was a reused keep-alive socket. */
  reusedSocket: boolean
  code: string | null
  /** The upstream's `request-id` header, to quote in a support ticket. */
  requestId: string | null
}

export interface LocalApiProxyOptions {
  /** Loopback interface to bind; defaults to 127.0.0.1 (never `localhost`, which may resolve to ::1). */
  host?: string
  /** Preferred port; 0 (default) lets the OS pick one. */
  port?: number
  /**
   * Base URL of the real API for this request (`https://api.anthropic.com`, or a
   * corporate gateway — a path prefix is preserved). Evaluated per request so a
   * settings change takes effect without a restart.
   */
  resolveUpstream: () => string
  onExchange?: (exchange: LocalApiProxyExchange) => void
  /** Every finished request, after `onExchange`; failures and aborts included. */
  onRequestRecord?: (record: LocalApiProxyRequestRecord) => void
  /** Request bodies larger than this are proxied but not handed to `onExchange`. Default 8 MiB. */
  maxCaptureBytes?: number
  upstreamTls?: LocalApiProxyUpstreamTls
  /**
   * TCP connect + TLS handshake deadline for a NEW upstream socket. A stalled
   * handshake becomes a retryable 502 instead of waiting for the client's own
   * (minutes-long) timeout. Default 15 s; 0 disables.
   */
  connectTimeoutMs?: number
  /**
   * Resolver for the upstream host. Defaults to the cached c-ares resolver;
   * tests pass `dns.lookup` or a stub.
   */
  lookup?: LookupFunction
  /** Keep the preferred port even when it is taken, retrying for this long before falling back to an ephemeral one. Default 0. */
  bindRetryMs?: number
  log?: LocalApiProxyLogger
}

export interface LocalApiProxyProbeResult {
  ok: boolean
  status: number | null
  ms: number
  error: string | null
}

export interface LocalApiProxyStats {
  inFlight: number
  byPhase: Record<LocalApiProxyPhase, number>
  upstreamSockets: { active: number; free: number }
  dns: UpstreamDnsStats | null
  /** Since start. */
  totals: {
    exchanges: number
    clientAborts: number
    upstreamErrors: number
    connectTimeouts: number
    status4xx: number
    status5xx: number
    midStreamDrops: number
  }
}

export interface LocalApiProxy {
  port: number
  host: string
  baseUrl: string
  close: () => Promise<void>
  /**
   * Drop IDLE pooled upstream sockets (e.g. after the machine wakes from
   * sleep, when they are silently dead). In-flight streams are left alone: a
   * short sleep lets them resume, and a genuinely dead one fails on its own
   * (pipeline → client response destroyed → the CLI retries).
   */
  dropUpstreamSockets: () => void
  /**
   * Can the upstream be reached right now? Opens a request to `/v1/models`
   * through the same agent and resolver the proxied traffic uses; any HTTP
   * status (401 without credentials included) proves the path works.
   */
  probeUpstream: (timeoutMs?: number) => Promise<LocalApiProxyProbeResult>
  stats: () => LocalApiProxyStats
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
// A Bun/Node client reuses one socket for several requests; keep it open long
// enough that the "server closed an idle socket just as the client reused it"
// race is rare. headersTimeout must stay above keepAliveTimeout.
const KEEP_ALIVE_TIMEOUT_MS = 120_000
const HEADERS_TIMEOUT_MS = 130_000
// Idle pooled upstream sockets are pruned after this; in-flight requests are
// never cut (the agent timeout only closes sockets nothing is using).
const UPSTREAM_IDLE_SOCKET_MS = 30_000
/** First bytes of a non-2xx response body kept for the log (`{"type":"error","error":{"type":"overloaded_error",…`). */
const ERROR_BODY_PREVIEW_BYTES = 512

/** RFC 9110 §7.6.1 hop-by-hop headers plus `host` (regenerated per leg). */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host'
])

/** Never surfaced to observers. */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-authorization',
  'cookie',
  'set-cookie'
])

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const CAPTURED_METHODS = new Set(['POST', 'PUT', 'PATCH'])

/** OpenSSL / Node codes meaning "the upstream certificate is not trusted here". */
const TLS_TRUST_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID'
])

export const CONNECT_TIMEOUT_CODE = 'ECONNDEADLINE'

const noopLog: LocalApiProxyLogger = { debug: () => {}, info: () => {}, warn: () => {} }

/**
 * Drop hop-by-hop headers (and anything the `Connection` header names) so the
 * next leg frames the message itself. `content-length`, `content-encoding`
 * and `accept-encoding` are deliberately kept: the body bytes are untouched,
 * so the original framing and compression stay valid end to end.
 */
export function stripHopByHopHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const connectionNamed = new Set(
    (typeof headers.connection === 'string' ? headers.connection : '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0)
  )
  const out: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionNamed.has(lower)) continue
    out[name] = value
  }
  return out
}

export function redactCredentialHeaders(
  headers: http.IncomingHttpHeaders
): http.IncomingHttpHeaders {
  const out: http.IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

export function isTlsTrustErrorCode(code: string | undefined): boolean {
  return code !== undefined && TLS_TRUST_ERROR_CODES.has(code)
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address)
}

/** The `Host` values a client must use to reach this proxy (DNS-rebinding guard). */
function allowedHosts(host: string, port: number): Set<string> {
  return new Set([`${host}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
}

function upstreamErrorBody(message: string): string {
  // Anthropic-shaped so the CLI's error classifier (and the Stainless retry
  // logic for 5xx) treats it like any other server-side failure.
  return JSON.stringify({ type: 'error', error: { type: 'api_error', message } })
}

function writeJsonResponse(
  res: http.ServerResponse,
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {}
): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders
  })
  res.end(body)
}

/** Destroy only idle pooled sockets; sockets carrying a request are left alone. */
function destroyIdleSockets(agent: http.Agent): void {
  for (const sockets of Object.values(agent.freeSockets)) {
    for (const socket of [...(sockets ?? [])]) socket.destroy()
  }
}

function countSockets(agent: http.Agent): { active: number; free: number } {
  let active = 0
  let free = 0
  for (const sockets of Object.values(agent.sockets)) active += sockets?.length ?? 0
  for (const sockets of Object.values(agent.freeSockets)) free += sockets?.length ?? 0
  return { active, free }
}

const headerValue = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? null) : null

/**
 * Whether the socket a request got is already connected (and, for TLS,
 * handshaken). A pooled keep-alive socket is; a fresh one is not, and the
 * connect deadline applies to it.
 */
function isSocketEstablished(socket: Socket): boolean {
  const tls = socket as TLSSocket & { _secureEstablished?: boolean }
  // `authorized` only turns true once the handshake verified the peer (this
  // tunnel always verifies); `_secureEstablished` is Node's own flag for the
  // same moment. `getProtocol()` is NOT usable here: it answers before the
  // handshake is done.
  if (tls.encrypted) return tls.authorized === true || tls._secureEstablished === true
  return !socket.connecting
}

interface ResolvedUpstream {
  url: URL
  /** `url.hostname` without IPv6 brackets — `http.request` wants the bare address. */
  hostname: string
  request: typeof http.request
  agent: http.Agent
}

const PROXY_SLOW_TTFB_MS = 10_000
const PROXY_STALL_MS = 30_000

// Performance logging: the proxy sits on an event loop between every Claude
// CLI and the API, so its time-to-first-byte and stalls are the CLI's view of
// that loop's lag (and of the upstream's).
const proxyStats = {
  inFlight: 0,
  inFlightMax: 0,
  exchanges: 0,
  ttfbTotalMs: 0,
  ttfbMaxMs: 0,
  stalls: 0,
  clientAborts: 0,
  upstreamErrors: 0,
  connectTimeouts: 0,
  status4xx: 0,
  status5xx: 0,
  midStreamDrops: 0
}
const proxyTotals = {
  exchanges: 0,
  clientAborts: 0,
  upstreamErrors: 0,
  connectTimeouts: 0,
  status4xx: 0,
  status5xx: 0,
  midStreamDrops: 0
}
const phaseCounts: Record<LocalApiProxyPhase, number> = {
  connecting: 0,
  sending: 0,
  waiting: 0,
  streaming: 0,
  done: 0
}
let gaugeAgents: { https: http.Agent; http: http.Agent; dns: UpstreamDns | null } | null = null

perfLog.registerGauge('claudeApiProxy', () => {
  const sockets = gaugeAgents
    ? (() => {
        const a = countSockets(gaugeAgents.https)
        const b = countSockets(gaugeAgents.http)
        return { active: a.active + b.active, free: a.free + b.free }
      })()
    : { active: 0, free: 0 }
  const dns = gaugeAgents?.dns?.stats()
  const snapshot = {
    inFlight: proxyStats.inFlight,
    inFlightMax: proxyStats.inFlightMax,
    connecting: phaseCounts.connecting,
    sending: phaseCounts.sending,
    waiting: phaseCounts.waiting,
    streaming: phaseCounts.streaming,
    exchanges: proxyStats.exchanges,
    ttfbAvgMs: Math.round(proxyStats.ttfbTotalMs / Math.max(1, proxyStats.exchanges)),
    ttfbMaxMs: proxyStats.ttfbMaxMs,
    stalls: proxyStats.stalls,
    clientAborts: proxyStats.clientAborts,
    upstreamErrors: proxyStats.upstreamErrors,
    connectTimeouts: proxyStats.connectTimeouts,
    status4xx: proxyStats.status4xx,
    status5xx: proxyStats.status5xx,
    midStreamDrops: proxyStats.midStreamDrops,
    socketsActive: sockets.active,
    socketsFree: sockets.free,
    dnsHits: dns?.hits ?? 0,
    dnsMisses: dns?.misses ?? 0,
    dnsFallbacks: dns?.fallbacks ?? 0,
    dnsErrors: dns?.fallbackErrors ?? 0,
    dnsLastResolveMs: dns?.lastResolveMs ?? 0
  }
  proxyStats.inFlightMax = proxyStats.inFlight
  proxyStats.exchanges = 0
  proxyStats.ttfbTotalMs = 0
  proxyStats.ttfbMaxMs = 0
  proxyStats.stalls = 0
  proxyStats.clientAborts = 0
  proxyStats.upstreamErrors = 0
  proxyStats.connectTimeouts = 0
  proxyStats.status4xx = 0
  proxyStats.status5xx = 0
  proxyStats.midStreamDrops = 0
  return snapshot
})

export async function startLocalApiProxy(options: LocalApiProxyOptions): Promise<LocalApiProxy> {
  const host = options.host ?? DEFAULT_HOST
  const log = options.log ?? noopLog
  const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS

  const upstreamDns = options.lookup ? null : createUpstreamDns()
  const lookup = options.lookup ?? upstreamDns!.lookup
  const ca = options.upstreamTls?.ca
  const httpsAgent = new https.Agent({
    keepAlive: true,
    timeout: UPSTREAM_IDLE_SOCKET_MS,
    lookup,
    ...(ca && ca.length > 0 ? { ca: [...ca] } : {})
  })
  const httpAgent = new http.Agent({ keepAlive: true, timeout: UPSTREAM_IDLE_SOCKET_MS, lookup })
  gaugeAgents = { https: httpsAgent, http: httpAgent, dns: upstreamDns }

  let boundPort = 0
  let hosts = new Set<string>()
  let warnedTlsTrust = false

  const resolveUpstream = (): ResolvedUpstream | null => {
    let url: URL
    try {
      url = new URL(options.resolveUpstream())
    } catch {
      return null
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    // Pointing the upstream back at this proxy would loop forever.
    const upstreamPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    const upstreamHost = url.hostname.replace(/^\[|\]$/g, '')
    if (
      upstreamPort === boundPort &&
      (isLoopbackAddress(upstreamHost) || upstreamHost === 'localhost')
    ) {
      return null
    }
    return url.protocol === 'https:'
      ? { url, hostname: upstreamHost, request: https.request, agent: httpsAgent }
      : { url, hostname: upstreamHost, request: http.request, agent: httpAgent }
  }

  const describeUpstreamError = (
    error: NodeJS.ErrnoException,
    origin: string
  ): { message: string; tlsTrust: boolean } => {
    if (isTlsTrustErrorCode(error.code)) {
      return {
        tlsTrust: true,
        message: `local proxy: TLS verification of ${origin} failed (${error.code}) — the upstream certificate is not trusted here (corporate TLS inspection? install the root in the system store or point NODE_EXTRA_CA_CERTS at it)`
      }
    }
    if (error.code === CONNECT_TIMEOUT_CODE) {
      return {
        tlsTrust: false,
        message: `local proxy: upstream connect timed out (${origin} did not complete the TCP/TLS handshake within ${connectTimeoutMs} ms)`
      }
    }
    return {
      tlsTrust: false,
      message: `local proxy: upstream unreachable (${error.code ?? error.message})`
    }
  }

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const startedAt = Date.now()
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'
    proxyStats.inFlight += 1
    if (proxyStats.inFlight > proxyStats.inFlightMax) proxyStats.inFlightMax = proxyStats.inFlight

    let phase: LocalApiProxyPhase = 'connecting'
    phaseCounts.connecting += 1
    const setPhase = (next: LocalApiProxyPhase): void => {
      if (phase === next) return
      phaseCounts[phase] = Math.max(0, phaseCounts[phase] - 1)
      phase = next
      phaseCounts[next] += 1
    }

    let stallTimer: NodeJS.Timeout | null = null
    let connectTimer: NodeJS.Timeout | null = null
    let recorded = false
    let status: number | null = null
    let ttfbMs: number | null = null
    let bytesOut = 0
    let reusedSocket = false
    let requestId: string | null = null
    let clientClosed = false
    let bodyFlushed = false
    // Who broke a streaming exchange: whichever side's close/abort event fires
    // first (the pipeline then tears the other side down, which must not be
    // mistaken for the cause).
    let failureOrigin: 'client' | 'upstream' | null = null

    const record = (outcome: LocalApiProxyOutcome, code: string | null = null): void => {
      if (recorded) return
      recorded = true
      const endPhase = phase
      setPhase('done')
      phaseCounts.done = Math.max(0, phaseCounts.done - 1)
      proxyStats.inFlight = Math.max(0, proxyStats.inFlight - 1)
      if (stallTimer) clearTimeout(stallTimer)
      if (connectTimer) clearTimeout(connectTimer)
      const totalMs = Date.now() - startedAt
      const entry: LocalApiProxyRequestRecord = {
        method,
        path,
        status,
        outcome,
        phase: outcome === 'ok' ? 'done' : endPhase,
        ttfbMs,
        totalMs,
        bytesOut,
        reusedSocket,
        code,
        requestId
      }
      if (perfLog.isEnabled()) perfLog.record('proxy', { ...entry })
      try {
        options.onRequestRecord?.(entry)
      } catch (error) {
        log.warn('Request record observer threw', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    res.once('close', () => {
      clientClosed = true
      if (failureOrigin === null && !res.writableFinished) failureOrigin = 'client'
      if (recorded) return
      // The upstream handlers record a client abort with its error code a
      // tick or two after we destroy the upstream request; give them that
      // chance, then record what is left (a client that left while nothing
      // was in flight upstream).
      const fallback = setTimeout(() => {
        if (recorded) return
        if (res.writableFinished) record('ok')
        else record(phase === 'streaming' ? 'client-abort-mid-stream' : 'client-abort')
      }, 50)
      fallback.unref?.()
    })

    const armStallTimer = (): void => {
      if (!perfLog.isEnabled()) return
      // One timer per response, refreshed per chunk: no per-token timer churn.
      if (stallTimer) {
        stallTimer.refresh()
        return
      }
      stallTimer = setTimeout(() => {
        stallTimer = null
        if (res.writableFinished || res.destroyed) return
        proxyStats.stalls += 1
        perfLog.slow('proxy-stall', PROXY_STALL_MS, {
          path,
          phase,
          sinceStartMs: Date.now() - startedAt,
          bytesOut
        })
      }, PROXY_STALL_MS)
      stallTimer.unref?.()
    }

    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      writeJsonResponse(res, 403, upstreamErrorBody('local proxy: loopback clients only'))
      req.resume()
      status = 403
      record('rejected')
      return
    }
    const hostHeader = req.headers.host?.trim().toLowerCase()
    if (hostHeader === undefined || !hosts.has(hostHeader)) {
      writeJsonResponse(res, 403, upstreamErrorBody('local proxy: unexpected Host header'))
      req.resume()
      status = 403
      record('rejected')
      return
    }

    const upstream = resolveUpstream()
    if (upstream === null) {
      writeJsonResponse(res, 502, upstreamErrorBody('local proxy: no usable upstream configured'), {
        'x-should-retry': 'false'
      })
      // Drain the body so the keep-alive socket stays usable.
      req.resume()
      status = 502
      record('rejected')
      return
    }

    const upstreamPath = `${upstream.url.pathname.replace(/\/$/, '')}${path}`
    const upstreamReq = upstream.request({
      protocol: upstream.url.protocol,
      hostname: upstream.hostname,
      port: upstream.url.port || undefined,
      method,
      path: upstreamPath,
      headers: stripHopByHopHeaders(req.headers),
      agent: upstream.agent
    })

    // Connect deadline: a fresh socket must finish TCP + TLS within the
    // budget, or the request fails fast (retryable) instead of hanging on a
    // black-holed SYN or a stalled handshake. Pooled sockets are exempt.
    upstreamReq.on('socket', (socket) => {
      const established = isSocketEstablished(socket)
      reusedSocket = established
      const onConnected = (): void => {
        if (connectTimer) clearTimeout(connectTimer)
        connectTimer = null
        if (phase === 'connecting') setPhase(bodyFlushed ? 'waiting' : 'sending')
      }
      if (established) {
        onConnected()
        return
      }
      if (connectTimeoutMs > 0) {
        connectTimer = setTimeout(() => {
          connectTimer = null
          if (phase !== 'connecting' || upstreamReq.destroyed) return
          const error = new Error(
            `upstream connect timed out after ${connectTimeoutMs} ms`
          ) as NodeJS.ErrnoException
          error.code = CONNECT_TIMEOUT_CODE
          upstreamReq.destroy(error)
        }, connectTimeoutMs)
        connectTimer.unref?.()
      }
      const tls = socket as TLSSocket
      if (tls.encrypted) tls.once('secureConnect', onConnected)
      else socket.once('connect', onConnected)
    })

    // Tee a bounded copy of the body while it streams through; the response
    // (which is what observers attribute) cannot arrive before `end`, so the
    // copy is complete by the time it is needed and adds no latency.
    const capture = CAPTURED_METHODS.has(method)
    const chunks: Buffer[] = []
    let capturedBytes = 0
    let overCap = false
    let bodyEnded = false
    if (capture) {
      req.on('data', (chunk: Buffer) => {
        if (overCap) return
        capturedBytes += chunk.length
        if (capturedBytes > maxCaptureBytes) {
          overCap = true
          chunks.length = 0
          return
        }
        chunks.push(chunk)
      })
    }
    req.on('end', () => {
      bodyEnded = true
    })
    upstreamReq.on('finish', () => {
      // The whole request is handed to the socket; once that socket is
      // connected the wait is the upstream's. (`connecting` stays as is so
      // the connect deadline still applies.)
      bodyFlushed = true
      if (phase === 'sending') setPhase('waiting')
      armStallTimer()
    })

    // `.pipe`, not `pipeline`: an upstream failure must leave `req`/`res`
    // intact so the client still gets a proper 502 below.
    req.pipe(upstreamReq)

    let responded = false
    const abortUpstream = (): void => {
      if (!upstreamReq.destroyed) upstreamReq.destroy()
    }
    // Client went away (Esc in the CLI, process exit, its own timeout): stop
    // the upstream generation too, before or after its headers arrived.
    res.on('close', () => {
      if (!res.writableFinished) abortUpstream()
    })
    req.on('error', abortUpstream)
    req.on('aborted', abortUpstream)

    upstreamReq.on('error', (error: NodeJS.ErrnoException) => {
      const elapsedMs = Date.now() - startedAt
      if (responded || res.headersSent) {
        // Mid-stream failure: a dropped connection is what the CLI expects
        // from a dying API, and it retries/reports accordingly.
        if (!recorded) {
          if (failureOrigin === 'client') {
            log.info('Client closed the connection mid-stream', {
              method,
              path,
              status,
              elapsedMs,
              bytesOut
            })
            record('client-abort-mid-stream', error.code ?? null)
          } else {
            proxyStats.midStreamDrops += 1
            proxyTotals.midStreamDrops += 1
            log.warn('Upstream dropped the connection mid-stream', {
              method,
              path,
              status,
              elapsedMs,
              bytesOut,
              code: error.code ?? null,
              error: error.message,
              requestId
            })
            record('upstream-drop-mid-stream', error.code ?? null)
          }
        }
        res.destroy()
        return
      }
      responded = true
      if (clientClosed) {
        // We destroyed the upstream request ourselves because the client left:
        // the CLI's own first-byte/total timeout, Escape, or a process exit.
        // `elapsedMs` tells which (≈ 4–10 min: the CLI gave up waiting).
        proxyStats.clientAborts += 1
        proxyTotals.clientAborts += 1
        log.info('Client aborted before the upstream answered', {
          method,
          path,
          phase,
          elapsedMs,
          reusedSocket
        })
        record('client-abort', error.code ?? null)
        return
      }
      const described = describeUpstreamError(error, upstream.url.origin)
      const connectTimeout = error.code === CONNECT_TIMEOUT_CODE
      if (connectTimeout) {
        proxyStats.connectTimeouts += 1
        proxyTotals.connectTimeouts += 1
      } else {
        proxyStats.upstreamErrors += 1
        proxyTotals.upstreamErrors += 1
      }
      if (!described.tlsTrust || !warnedTlsTrust) {
        warnedTlsTrust ||= described.tlsTrust
        log.warn(
          described.tlsTrust ? 'Upstream TLS certificate not trusted' : 'Upstream request failed',
          {
            method,
            path,
            phase,
            elapsedMs,
            reusedSocket,
            upstream: upstream.url.origin,
            code: error.code ?? null,
            error: error.message
          }
        )
      }
      status = 502
      writeJsonResponse(res, 502, upstreamErrorBody(described.message), {
        'x-should-retry': 'true'
      })
      record(connectTimeout ? 'connect-timeout' : 'upstream-error', error.code ?? null)
    })

    upstreamReq.on('response', (upstreamRes) => {
      responded = true
      status = upstreamRes.statusCode ?? 502
      const observedAt = Date.now()
      ttfbMs = observedAt - startedAt
      requestId = headerValue(upstreamRes.headers['request-id'])
      setPhase('streaming')
      const upstreamBroke = (): void => {
        if (failureOrigin === null && !upstreamRes.complete) failureOrigin = 'upstream'
      }
      upstreamRes.once('aborted', upstreamBroke)
      upstreamRes.once('error', upstreamBroke)
      upstreamRes.once('close', upstreamBroke)
      proxyStats.exchanges += 1
      proxyTotals.exchanges += 1
      proxyStats.ttfbTotalMs += ttfbMs
      if (ttfbMs > proxyStats.ttfbMaxMs) proxyStats.ttfbMaxMs = ttfbMs
      if (ttfbMs >= PROXY_SLOW_TTFB_MS) perfLog.slow('proxy-ttfb', ttfbMs, { path, status })
      armStallTimer()
      upstreamRes.on('data', (chunk: Buffer) => {
        bytesOut += chunk.length
        armStallTimer()
      })

      // Error statuses: keep the first bytes of the body for the log — the
      // Anthropic error type (`overloaded_error`, `rate_limit_error`, …) is
      // what explains a turn that the hook later reports as `server_error`.
      let errorPreview: Buffer[] | null = null
      let errorPreviewBytes = 0
      if (status >= 400) {
        if (status >= 500) {
          proxyStats.status5xx += 1
          proxyTotals.status5xx += 1
        } else {
          proxyStats.status4xx += 1
          proxyTotals.status4xx += 1
        }
        errorPreview = []
        upstreamRes.on('data', (chunk: Buffer) => {
          if (errorPreview === null || errorPreviewBytes >= ERROR_BODY_PREVIEW_BYTES) return
          const take = chunk.subarray(0, ERROR_BODY_PREVIEW_BYTES - errorPreviewBytes)
          errorPreview.push(take)
          errorPreviewBytes += take.length
        })
        upstreamRes.once('end', () => {
          const preview = errorPreview ? Buffer.concat(errorPreview).toString('utf8') : ''
          const encoding = headerValue(upstreamRes.headers['content-encoding'])
          log.warn('Upstream answered with an error status', {
            method,
            path,
            status,
            ttfbMs,
            requestId,
            retryAfter: headerValue(upstreamRes.headers['retry-after']),
            shouldRetry: headerValue(upstreamRes.headers['x-should-retry']),
            // A compressed error body is not readable here; say so instead of logging bytes.
            body: encoding && encoding !== 'identity' ? `<${encoding}>` : preview
          })
        })
      }

      res.writeHead(status, upstreamRes.statusMessage, stripHopByHopHeaders(upstreamRes.headers))
      res.flushHeaders()

      if (options.onExchange) {
        const requestBody = capture && bodyEnded && !overCap ? Buffer.concat(chunks) : null
        try {
          options.onExchange({
            method,
            path,
            requestHeaders: redactCredentialHeaders(req.headers),
            credentialFingerprint: fingerprintRequestCredential(req.headers),
            requestBody,
            status,
            responseHeaders: upstreamRes.headers,
            observedAt,
            latencyMs: observedAt - startedAt
          })
        } catch (error) {
          log.warn('Exchange observer threw', {
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      chunks.length = 0

      // Either side closing early destroys the other: a client abort stops
      // the upstream stream, an upstream drop ends the client's response.
      pipeline(upstreamRes, res, (error) => {
        if (error) {
          // The upstream 'error' handler above classifies and records it; a
          // client-side close with no upstream error lands here.
          if (!recorded) {
            if (failureOrigin !== 'upstream') {
              log.info('Client closed the connection mid-stream', {
                method,
                path,
                status,
                elapsedMs: Date.now() - startedAt,
                bytesOut
              })
              record('client-abort-mid-stream', (error as NodeJS.ErrnoException).code ?? null)
            } else {
              proxyStats.midStreamDrops += 1
              proxyTotals.midStreamDrops += 1
              log.warn('Upstream dropped the connection mid-stream', {
                method,
                path,
                status,
                elapsedMs: Date.now() - startedAt,
                bytesOut,
                code: (error as NodeJS.ErrnoException).code ?? null,
                error: error.message,
                requestId
              })
              record('upstream-drop-mid-stream', (error as NodeJS.ErrnoException).code ?? null)
            }
          }
          return
        }
        record(status !== null && status >= 400 ? 'upstream-status' : 'ok')
      })
    })
  }

  const server = http.createServer(
    { keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS, headersTimeout: HEADERS_TIMEOUT_MS },
    handleRequest
  )
  // Streaming completions stay open for minutes: no socket inactivity or
  // whole-request deadline on this side. (The CLI runs its own watchdogs.)
  server.requestTimeout = 0
  server.timeout = 0
  // SSE events are tiny writes; never let Nagle hold them back.
  server.on('connection', (socket) => socket.setNoDelay(true))
  // Accept errors (EMFILE under fd exhaustion) must not become an uncaught
  // exception in whichever process hosts the proxy.
  server.on('error', (error: NodeJS.ErrnoException) => {
    log.warn('Proxy server error', { code: error.code ?? null, error: error.message })
  })

  await listen(server, options.port ?? 0, host, options.bindRetryMs ?? 0, log)
  const address = server.address() as AddressInfo | null
  if (!address || typeof address !== 'object') {
    server.close()
    throw new Error('local API proxy failed to bind a TCP port')
  }
  boundPort = address.port
  hosts = allowedHosts(host, boundPort)
  log.info('Local API proxy listening', { host, port: boundPort })

  const probeUpstream = (timeoutMs = 10_000): Promise<LocalApiProxyProbeResult> =>
    new Promise((resolve) => {
      const upstream = resolveUpstream()
      const startedAt = Date.now()
      if (upstream === null) {
        resolve({ ok: false, status: null, ms: 0, error: 'no usable upstream configured' })
        return
      }
      let settled = false
      const finish = (result: LocalApiProxyProbeResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const probeReq = upstream.request({
        protocol: upstream.url.protocol,
        hostname: upstream.hostname,
        port: upstream.url.port || undefined,
        method: 'GET',
        path: `${upstream.url.pathname.replace(/\/$/, '')}/v1/models`,
        headers: { accept: 'application/json', 'user-agent': 'hive-proxy-probe' },
        agent: upstream.agent
      })
      const timer = setTimeout(() => {
        probeReq.destroy(new Error('probe timed out'))
        finish({ ok: false, status: null, ms: Date.now() - startedAt, error: `timed out after ${timeoutMs} ms` })
      }, timeoutMs)
      timer.unref?.()
      probeReq.on('response', (probeRes) => {
        probeRes.resume()
        finish({ ok: true, status: probeRes.statusCode ?? null, ms: Date.now() - startedAt, error: null })
      })
      probeReq.on('error', (error: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          status: null,
          ms: Date.now() - startedAt,
          error: `${error.code ?? 'ERROR'}: ${error.message}`
        })
      })
      probeReq.end()
    })

  return {
    port: boundPort,
    host,
    baseUrl: `http://${host}:${boundPort}`,
    dropUpstreamSockets: () => {
      destroyIdleSockets(httpsAgent)
      destroyIdleSockets(httpAgent)
      upstreamDns?.clear()
    },
    probeUpstream,
    stats: () => {
      const a = countSockets(httpsAgent)
      const b = countSockets(httpAgent)
      return {
        inFlight: proxyStats.inFlight,
        byPhase: { ...phaseCounts },
        upstreamSockets: { active: a.active + b.active, free: a.free + b.free },
        dns: upstreamDns?.stats() ?? null,
        totals: { ...proxyTotals }
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
        httpsAgent.destroy()
        httpAgent.destroy()
        if (gaugeAgents?.https === httpsAgent) gaugeAgents = null
      })
  }
}

/**
 * Bind `preferredPort`, falling back to an ephemeral port when it is taken (a
 * second app instance, a stale process). With `retryMs` > 0 the preferred port
 * is retried for that long first — a restarted proxy host must come back on
 * the port every running CLI already carries in its environment, and the
 * previous host's socket can take a moment to be released. Throws only when
 * even the ephemeral bind fails.
 */
async function listen(
  server: http.Server,
  preferredPort: number,
  host: string,
  retryMs: number,
  log: LocalApiProxyLogger
): Promise<void> {
  const deadline = Date.now() + retryMs
  for (;;) {
    try {
      await listenOnce(server, preferredPort, host)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (preferredPort === 0 || (code !== 'EADDRINUSE' && code !== 'EACCES')) throw error
      if (code === 'EADDRINUSE' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        continue
      }
      log.warn('Preferred proxy port is taken; falling back to an ephemeral port', {
        port: preferredPort,
        code
      })
      await listenOnce(server, 0, host)
      return
    }
  }
}

function listenOnce(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}
