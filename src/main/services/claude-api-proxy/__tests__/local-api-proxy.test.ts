// @vitest-environment node
import http from 'http'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startLocalApiProxy,
  stripHopByHopHeaders,
  type LocalApiProxy,
  type LocalApiProxyExchange
} from '../local-api-proxy'

interface UpstreamSeen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

interface FakeUpstream {
  server: http.Server
  origin: string
  seen: UpstreamSeen[]
  close: () => Promise<void>
}

type UpstreamHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer
) => void | Promise<void>

async function startUpstream(handler: UpstreamHandler): Promise<FakeUpstream> {
  const seen: UpstreamSeen[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      void handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function startProxy(
  upstreamOrigin: () => string,
  onExchange?: (exchange: LocalApiProxyExchange) => void,
  extra: { maxCaptureBytes?: number } = {}
): Promise<LocalApiProxy> {
  const proxy = await startLocalApiProxy({
    port: 0,
    resolveUpstream: upstreamOrigin,
    onExchange,
    ...extra
  })
  cleanups.push(() => proxy.close())
  return proxy
}

function rawRequest(
  port: number,
  options: http.RequestOptions,
  body?: Buffer | string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      )
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

describe('stripHopByHopHeaders', () => {
  it('drops hop-by-hop and Connection-named headers but keeps framing and encoding', () => {
    expect(
      stripHopByHopHeaders({
        host: '127.0.0.1:1',
        connection: 'keep-alive, X-Custom',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'x-custom': 'dropped by Connection',
        'content-length': '12',
        'content-encoding': 'gzip',
        'accept-encoding': 'gzip, br',
        authorization: 'Bearer secret',
        'anthropic-beta': 'oauth-2025-04-20'
      })
    ).toEqual({
      'content-length': '12',
      'content-encoding': 'gzip',
      'accept-encoding': 'gzip, br',
      authorization: 'Bearer secret',
      'anthropic-beta': 'oauth-2025-04-20'
    })
  })
})

describe('startLocalApiProxy', () => {
  it('relays a POST byte-for-byte, rewrites Host, and reports the exchange with a redacted header set', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': '0.25',
        connection: 'close'
      })
      res.end('{"ok":true}')
    })
    cleanups.push(upstream.close)
    const exchanges: LocalApiProxyExchange[] = []
    const proxy = await startProxy(
      () => upstream.origin,
      (exchange) => exchanges.push(exchange)
    )

    const body = JSON.stringify({ model: 'claude-opus-5-5', metadata: { user_id: '{}' } })
    const response = await rawRequest(
      proxy.port,
      {
        method: 'POST',
        path: '/v1/messages?beta=true',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: 'Bearer secret-token',
          'anthropic-beta': 'oauth-2025-04-20',
          'x-claude-code-session-id': 'sess-1'
        }
      },
      body
    )

    expect(response.status).toBe(200)
    expect(response.body.toString()).toBe('{"ok":true}')
    expect(response.headers['anthropic-ratelimit-unified-5h-utilization']).toBe('0.25')

    expect(upstream.seen).toHaveLength(1)
    const seen = upstream.seen[0]
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/v1/messages?beta=true')
    expect(seen.body.toString()).toBe(body)
    expect(seen.headers.host).toBe(new URL(upstream.origin).host)
    expect(seen.headers.authorization).toBe('Bearer secret-token')
    expect(seen.headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(seen.headers['content-length']).toBe(String(Buffer.byteLength(body)))

    expect(exchanges).toHaveLength(1)
    const exchange = exchanges[0]
    expect(exchange.method).toBe('POST')
    expect(exchange.path).toBe('/v1/messages?beta=true')
    expect(exchange.status).toBe(200)
    expect(exchange.requestBody?.toString()).toBe(body)
    expect(exchange.requestHeaders.authorization).toBeUndefined()
    expect(exchange.requestHeaders['x-claude-code-session-id']).toBe('sess-1')
    expect(exchange.responseHeaders['anthropic-ratelimit-unified-5h-utilization']).toBe('0.25')
    expect(exchange.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('streams SSE chunks through as they are written, before the upstream body ends', async () => {
    let upstreamRes: http.ServerResponse | null = null
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.write('event: message_start\ndata: {}\n\n')
      upstreamRes = res
    })
    cleanups.push(upstream.close)
    const proxy = await startProxy(() => upstream.origin)

    const received: string[] = []
    const done = new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxy.port, method: 'POST', path: '/v1/messages' },
        (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => received.push(chunk))
          res.on('end', resolve)
        }
      )
      req.on('error', reject)
      req.end('{}')
    })

    await vi.waitFor(() => expect(received.join('')).toContain('message_start'))
    expect(upstreamRes).not.toBeNull()
    upstreamRes!.write('event: content_block_delta\ndata: {"text":"hi"}\n\n')
    await vi.waitFor(() => expect(received.join('')).toContain('content_block_delta'))
    upstreamRes!.end('event: message_stop\ndata: {}\n\n')
    await done
    expect(received.join('')).toContain('message_stop')
  })

  it('answers 502 with an Anthropic-shaped retryable error when the upstream is unreachable', async () => {
    // Bind then close so the port is known-dead.
    const dead = await startUpstream(() => {})
    const deadOrigin = dead.origin
    await dead.close()
    const exchanges: LocalApiProxyExchange[] = []
    const proxy = await startProxy(
      () => deadOrigin,
      (exchange) => exchanges.push(exchange)
    )

    const response = await rawRequest(proxy.port, { method: 'POST', path: '/v1/messages' }, '{}')
    expect(response.status).toBe(502)
    expect(response.headers['x-should-retry']).toBe('true')
    const parsed = JSON.parse(response.body.toString()) as {
      type: string
      error: { type: string; message: string }
    }
    expect(parsed.type).toBe('error')
    expect(parsed.error.type).toBe('api_error')
    expect(parsed.error.message).toContain('ECONNREFUSED')
    expect(exchanges).toHaveLength(0)
  })

  it('refuses requests whose Host header is not the proxy (DNS rebinding guard)', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.end('no')
    })
    cleanups.push(upstream.close)
    const proxy = await startProxy(() => upstream.origin)

    const response = await rawRequest(proxy.port, {
      method: 'GET',
      path: '/v1/models',
      headers: { host: 'evil.example.com' }
    })
    expect(response.status).toBe(403)
    expect(upstream.seen).toHaveLength(0)
  })

  it('refuses to forward when the upstream would loop back into the proxy itself', async () => {
    let origin = ''
    const proxy = await startProxy(() => origin)
    origin = proxy.baseUrl
    const response = await rawRequest(proxy.port, { method: 'GET', path: '/api/hello' })
    expect(response.status).toBe(502)
    expect(response.headers['x-should-retry']).toBe('false')
  })

  it('preserves a gateway path prefix and relays HEAD without a body', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '20' })
      res.end()
    })
    cleanups.push(upstream.close)
    const proxy = await startProxy(() => `${upstream.origin}/gateway/anthropic/`)

    const response = await rawRequest(proxy.port, { method: 'HEAD', path: '/api/hello' })
    expect(response.status).toBe(200)
    expect(response.body.length).toBe(0)
    expect(upstream.seen[0].url).toBe('/gateway/anthropic/api/hello')
  })

  it('reuses one client connection for sequential requests (keep-alive)', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.end('ok')
    })
    cleanups.push(upstream.close)
    const proxy = await startProxy(() => upstream.origin)

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    cleanups.push(async () => agent.destroy())
    const ports = new Set<number>()
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: proxy.port, method: 'GET', path: `/r/${i}`, agent },
          (res) => {
            ports.add(res.socket!.localPort!)
            res.resume()
            res.on('end', resolve)
          }
        )
        req.on('error', reject)
        req.end()
      })
    }
    expect(upstream.seen.map((s) => s.url)).toEqual(['/r/0', '/r/1', '/r/2'])
    expect(ports.size).toBe(1)
  })

  it('aborts the upstream request when the client disconnects mid-stream', async () => {
    // Only the upstream RESPONSE closing proves the abort reached upstream:
    // a server-side IncomingMessage auto-closes as soon as its body ends.
    let upstreamRes: http.ServerResponse | null = null
    let upstreamClosed = false
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: ping\n\n')
      upstreamRes = res
      res.on('close', () => {
        upstreamClosed = true
      })
    })
    cleanups.push(upstream.close)
    const proxy = await startProxy(() => upstream.origin)

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxy.port, method: 'POST', path: '/v1/messages' },
        (res) => {
          res.once('data', () => {
            req.destroy()
            resolve()
          })
        }
      )
      req.on('error', () => {})
      req.on('error', reject)
      req.end('{}')
    })

    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
    expect(upstreamRes!.destroyed).toBe(true)
  })

  it('dropUpstreamSockets prunes idle pooled sockets but never an in-flight stream', async () => {
    let connections = 0
    let streamingRes: http.ServerResponse | null = null
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: ping\n\n')
        streamingRes = res
        return
      }
      res.end('ok')
    })
    upstream.server.on('connection', () => {
      connections += 1
    })
    cleanups.push(upstream.close)
    const proxy = await startProxy(() => upstream.origin)

    // A streaming request occupies the first upstream socket...
    const received: string[] = []
    let streamOutcome: 'ended' | 'errored' | null = null
    const streamDone = new Promise<void>((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxy.port, method: 'GET', path: '/stream' },
        (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => received.push(chunk))
          res.on('end', () => {
            streamOutcome = 'ended'
            resolve()
          })
          res.on('error', () => {
            streamOutcome = 'errored'
            resolve()
          })
        }
      )
      req.on('error', () => {
        streamOutcome = 'errored'
        resolve()
      })
      req.end()
    })
    await vi.waitFor(() => expect(received.join('')).toContain('ping'))
    expect(connections).toBe(1)

    // ...and a completed request leaves a second socket idle in the pool.
    await rawRequest(proxy.port, { method: 'GET', path: '/one' })
    expect(connections).toBe(2)

    proxy.dropUpstreamSockets()

    // The idle socket is gone, so the next plain request (while the stream
    // still holds its own socket) must open a fresh upstream connection...
    await rawRequest(proxy.port, { method: 'GET', path: '/two' })
    expect(connections).toBe(3)

    // ...and the in-flight stream survived and completes normally.
    streamingRes!.end('event: message_stop\n\n')
    await streamDone
    expect(streamOutcome).toBe('ended')
    expect(received.join('')).toContain('message_stop')
  })

  it('reaches an upstream given as an IPv6 literal', async () => {
    const server = http.createServer((_req, res) => res.end('v6'))
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(0, '::1', () => resolve(true))
    })
    if (!listening) return // no IPv6 loopback on this machine
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
    const { port } = server.address() as AddressInfo
    const proxy = await startProxy(() => `http://[::1]:${port}`)
    const response = await rawRequest(proxy.port, { method: 'GET', path: '/v1/models' })
    expect(response.status).toBe(200)
    expect(response.body.toString()).toBe('v6')
  })

  it('does not hand oversized bodies to the observer but still proxies them', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.end('ok')
    })
    cleanups.push(upstream.close)
    const exchanges: LocalApiProxyExchange[] = []
    const proxy = await startProxy(
      () => upstream.origin,
      (exchange) => exchanges.push(exchange),
      { maxCaptureBytes: 1024 }
    )

    const big = Buffer.alloc(4096, 0x61)
    const response = await rawRequest(
      proxy.port,
      { method: 'POST', path: '/v1/messages', headers: { 'content-length': big.length } },
      big
    )
    expect(response.status).toBe(200)
    expect(upstream.seen[0].body.length).toBe(4096)
    expect(exchanges[0].requestBody).toBeNull()
  })

  it('falls back to an ephemeral port when the preferred port is taken', async () => {
    const blocker = await startUpstream(() => {})
    cleanups.push(blocker.close)
    const takenPort = (blocker.server.address() as AddressInfo).port
    const proxy = await startLocalApiProxy({
      port: takenPort,
      resolveUpstream: () => blocker.origin
    })
    cleanups.push(() => proxy.close())
    expect(proxy.port).not.toBe(takenPort)
    expect(proxy.port).toBeGreaterThan(0)
  })
})
