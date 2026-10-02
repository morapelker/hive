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
 */
import http from 'http'
import https from 'https'
import type { AddressInfo } from 'net'
import { pipeline } from 'stream'

export interface LocalApiProxyExchange {
  method: string
  /** Request target as the client sent it (path + query). */
  path: string
  /** Request headers minus credentials (`authorization`, `x-api-key`, `cookie`, ...). */
  requestHeaders: http.IncomingHttpHeaders
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
  /** Request bodies larger than this are proxied but not handed to `onExchange`. Default 8 MiB. */
  maxCaptureBytes?: number
  upstreamTls?: LocalApiProxyUpstreamTls
  log?: LocalApiProxyLogger
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
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_MAX_CAPTURE_BYTES = 8 * 1024 * 1024
// A Bun/Node client reuses one socket for several requests; keep it open long
// enough that the "server closed an idle socket just as the client reused it"
// race is rare. headersTimeout must stay above keepAliveTimeout.
const KEEP_ALIVE_TIMEOUT_MS = 120_000
const HEADERS_TIMEOUT_MS = 130_000
// Idle pooled upstream sockets are pruned after this; in-flight requests are
// never cut (the agent timeout only closes sockets nothing is using).
const UPSTREAM_IDLE_SOCKET_MS = 30_000

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

interface ResolvedUpstream {
  url: URL
  /** `url.hostname` without IPv6 brackets — `http.request` wants the bare address. */
  hostname: string
  request: typeof http.request
  agent: http.Agent
}

export async function startLocalApiProxy(options: LocalApiProxyOptions): Promise<LocalApiProxy> {
  const host = options.host ?? DEFAULT_HOST
  const log = options.log ?? noopLog
  const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES

  const ca = options.upstreamTls?.ca
  const httpsAgent = new https.Agent({
    keepAlive: true,
    timeout: UPSTREAM_IDLE_SOCKET_MS,
    ...(ca && ca.length > 0 ? { ca: [...ca] } : {})
  })
  const httpAgent = new http.Agent({ keepAlive: true, timeout: UPSTREAM_IDLE_SOCKET_MS })

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
    return {
      tlsTrust: false,
      message: `local proxy: upstream unreachable (${error.code ?? error.message})`
    }
  }

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const startedAt = Date.now()
    const method = req.method ?? 'GET'
    const path = req.url ?? '/'

    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      writeJsonResponse(res, 403, upstreamErrorBody('local proxy: loopback clients only'))
      req.resume()
      return
    }
    const hostHeader = req.headers.host?.trim().toLowerCase()
    if (hostHeader === undefined || !hosts.has(hostHeader)) {
      writeJsonResponse(res, 403, upstreamErrorBody('local proxy: unexpected Host header'))
      req.resume()
      return
    }

    const upstream = resolveUpstream()
    if (upstream === null) {
      writeJsonResponse(res, 502, upstreamErrorBody('local proxy: no usable upstream configured'), {
        'x-should-retry': 'false'
      })
      // Drain the body so the keep-alive socket stays usable.
      req.resume()
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

    // `.pipe`, not `pipeline`: an upstream failure must leave `req`/`res`
    // intact so the client still gets a proper 502 below.
    req.pipe(upstreamReq)

    let responded = false
    const abortUpstream = (): void => {
      if (!upstreamReq.destroyed) upstreamReq.destroy()
    }
    // Client went away (Esc in the CLI, process exit): stop the upstream
    // generation too, before or after its headers arrived.
    res.on('close', () => {
      if (!res.writableFinished) abortUpstream()
    })
    req.on('error', abortUpstream)
    req.on('aborted', abortUpstream)

    upstreamReq.on('error', (error: NodeJS.ErrnoException) => {
      if (responded || res.headersSent) {
        // Mid-stream failure: a dropped connection is what the CLI expects
        // from a dying API, and it retries/reports accordingly.
        res.destroy()
        return
      }
      responded = true
      const described = describeUpstreamError(error, upstream.url.origin)
      if (!described.tlsTrust || !warnedTlsTrust) {
        warnedTlsTrust ||= described.tlsTrust
        log.warn(
          described.tlsTrust ? 'Upstream TLS certificate not trusted' : 'Upstream request failed',
          {
            method,
            path,
            upstream: upstream.url.origin,
            code: error.code ?? null,
            error: error.message
          }
        )
      }
      writeJsonResponse(res, 502, upstreamErrorBody(described.message), {
        'x-should-retry': 'true'
      })
    })

    upstreamReq.on('response', (upstreamRes) => {
      responded = true
      const status = upstreamRes.statusCode ?? 502
      const observedAt = Date.now()

      res.writeHead(status, upstreamRes.statusMessage, stripHopByHopHeaders(upstreamRes.headers))
      res.flushHeaders()

      if (options.onExchange) {
        const requestBody = capture && bodyEnded && !overCap ? Buffer.concat(chunks) : null
        try {
          options.onExchange({
            method,
            path,
            requestHeaders: redactCredentialHeaders(req.headers),
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
      pipeline(upstreamRes, res, () => {})
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

  await listen(server, options.port ?? 0, host)
  const address = server.address() as AddressInfo | null
  if (!address || typeof address !== 'object') {
    server.close()
    throw new Error('local API proxy failed to bind a TCP port')
  }
  boundPort = address.port
  hosts = allowedHosts(host, boundPort)
  log.info('Local API proxy listening', { host, port: boundPort })

  return {
    port: boundPort,
    host,
    baseUrl: `http://${host}:${boundPort}`,
    dropUpstreamSockets: () => {
      destroyIdleSockets(httpsAgent)
      destroyIdleSockets(httpAgent)
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
        httpsAgent.destroy()
        httpAgent.destroy()
      })
  }
}

/**
 * Bind `preferredPort`, falling back to an ephemeral port when it is taken (a
 * second app instance, a stale process). Throws only when even that fails.
 */
async function listen(server: http.Server, preferredPort: number, host: string): Promise<void> {
  try {
    await listenOnce(server, preferredPort, host)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (preferredPort === 0 || (code !== 'EADDRINUSE' && code !== 'EACCES')) throw error
    await listenOnce(server, 0, host)
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
