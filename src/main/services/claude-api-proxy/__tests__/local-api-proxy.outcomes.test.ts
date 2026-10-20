// @vitest-environment node
import http from 'http'
import net from 'net'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECT_TIMEOUT_CODE,
  startLocalApiProxy,
  type LocalApiProxy,
  type LocalApiProxyRequestRecord
} from '../local-api-proxy'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()!
    await Promise.race([
      cleanup(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('cleanup hung')), 3_000))
    ])
  }
})

async function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ origin: string; server: http.Server }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, server }
}

async function startProxy(
  upstream: () => string,
  extra: Partial<Parameters<typeof startLocalApiProxy>[0]> = {}
): Promise<{ proxy: LocalApiProxy; records: LocalApiProxyRequestRecord[]; log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } }> {
  const records: LocalApiProxyRequestRecord[] = []
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  const proxy = await startLocalApiProxy({
    port: 0,
    resolveUpstream: upstream,
    onRequestRecord: (record) => records.push(record),
    log,
    ...extra
  })
  cleanups.push(() => proxy.close())
  return { proxy, records, log }
}

const waitFor = async (predicate: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function request(
  port: number,
  options: http.RequestOptions,
  body?: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

describe('local API proxy outcomes', () => {
  it('records a completed exchange with its timings', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.setHeader('request-id', 'req_123')
      res.end('{"ok":true}')
    })
    const { proxy, records } = await startProxy(() => upstream.origin)
    const response = await request(proxy.port, { method: 'POST', path: '/v1/messages' }, '{}')
    expect(response.status).toBe(200)
    await waitFor(() => records.length === 1)
    expect(records[0]).toMatchObject({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      outcome: 'ok',
      phase: 'done',
      requestId: 'req_123',
      bytesOut: 11
    })
    expect(records[0].ttfbMs).toBeGreaterThanOrEqual(0)
    expect(proxy.stats().totals.exchanges).toBe(1)
  })

  it('logs an upstream error status with the body preview and counts it', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.statusCode = 529
      res.setHeader('retry-after', '5')
      res.end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')
    })
    const { proxy, records, log } = await startProxy(() => upstream.origin)
    const response = await request(proxy.port, { method: 'POST', path: '/v1/messages' }, '{}')
    expect(response.status).toBe(529)
    await waitFor(() => records.length === 1)
    expect(records[0]).toMatchObject({ status: 529, outcome: 'upstream-status' })
    expect(log.warn).toHaveBeenCalledWith(
      'Upstream answered with an error status',
      expect.objectContaining({ status: 529, retryAfter: '5', body: expect.stringContaining('overloaded_error') })
    )
    expect(proxy.stats().totals.status5xx).toBe(1)
  })

  it('tells a client abort apart from an upstream failure, with the phase and the wait', async () => {
    let release: (() => void) | null = null
    const upstream = await startUpstream((_req, res) => {
      release = () => res.end('late')
    })
    const { proxy, records, log } = await startProxy(() => upstream.origin)

    const socket = net.connect(proxy.port, '127.0.0.1')
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    socket.write(`POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nContent-Length: 2\r\n\r\n{}`)
    await waitFor(() => release !== null)
    // The client gives up (as the CLI does after its first-byte timeout).
    socket.destroy()
    await waitFor(() => records.length === 1)
    expect(records[0]).toMatchObject({ outcome: 'client-abort', phase: 'waiting', status: null })
    expect(log.info).toHaveBeenCalledWith(
      'Client aborted before the upstream answered',
      expect.objectContaining({ phase: 'waiting', method: 'POST' })
    )
    expect(log.warn).not.toHaveBeenCalledWith('Upstream request failed', expect.anything())
    expect(proxy.stats().totals.clientAborts).toBe(1)
    release!()
  })

  it('fails fast with a retryable 502 when the upstream never completes the handshake', async () => {
    // A server that accepts TCP connections but never speaks.
    const silentSockets = new Set<net.Socket>()
    const silent = net.createServer((socket) => {
      silentSockets.add(socket)
      socket.on('close', () => silentSockets.delete(socket))
    })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of silentSockets) socket.destroy()
          silent.close(() => resolve())
        })
    )
    const { port } = silent.address() as AddressInfo
    // A plain-http upstream is "connected" as soon as TCP is; use TLS so the
    // handshake is what has to complete within the deadline.
    const { proxy, records, log } = await startProxy(() => `https://127.0.0.1:${port}`, { connectTimeoutMs: 100 })
    const startedAt = Date.now()
    const response = await request(proxy.port, { method: 'POST', path: '/v1/messages' }, '{}')
    expect(response.status).toBe(502)
    expect(response.headers['x-should-retry']).toBe('true')
    expect(response.body).toContain('connect timed out')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    await waitFor(() => records.length === 1)
    expect(records[0]).toMatchObject({ outcome: 'connect-timeout', code: CONNECT_TIMEOUT_CODE, phase: 'connecting' })
    expect(log.warn).toHaveBeenCalledWith('Upstream request failed', expect.objectContaining({ code: CONNECT_TIMEOUT_CODE }))
    expect(proxy.stats().totals.connectTimeouts).toBe(1)
  })

  it('records an upstream drop mid-stream', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      setTimeout(() => res.socket?.destroy(), 20)
    })
    const { proxy, records, log } = await startProxy(() => upstream.origin)
    await new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: '/v1/messages' }, (res) => {
        res.on('data', () => {})
        res.on('error', () => resolve())
        res.on('end', () => resolve())
        res.on('close', () => resolve())
      })
      req.on('error', () => resolve())
      req.end('{}')
    })
    await waitFor(() => records.length === 1)
    expect(records[0]).toMatchObject({ outcome: 'upstream-drop-mid-stream', status: 200 })
    expect(records[0].bytesOut).toBeGreaterThan(0)
    expect(log.warn).toHaveBeenCalledWith('Upstream dropped the connection mid-stream', expect.objectContaining({ status: 200 }))
    expect(proxy.stats().totals.midStreamDrops).toBe(1)
  })

  it('probes the upstream through the same path and reports any HTTP answer as reachable', async () => {
    const upstream = await startUpstream((req, res) => {
      res.statusCode = req.url === '/v1/models' ? 401 : 200
      res.end()
    })
    const { proxy } = await startProxy(() => upstream.origin)
    const result = await proxy.probeUpstream(1_000)
    expect(result).toMatchObject({ ok: true, status: 401, error: null })

    const dead = await startUpstream(() => {})
    const deadOrigin = dead.origin
    await cleanups.pop()!()
    const { proxy: deadProxy } = await startProxy(() => deadOrigin)
    const failed = await deadProxy.probeUpstream(1_000)
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('ECONNREFUSED')
  })

  it('keeps retrying the preferred port for a while before falling back', async () => {
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const { port } = blocker.address() as AddressInfo
    setTimeout(() => blocker.close(), 150)
    const proxy = await startLocalApiProxy({ port, resolveUpstream: () => 'http://127.0.0.1:1', bindRetryMs: 2_000 })
    cleanups.push(() => proxy.close())
    expect(proxy.port).toBe(port)
  })
})
