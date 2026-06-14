import { mkdtempSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startHiveServer, type StartedHiveServer } from '../server'
import { OPENCODE_STREAM_CHANNEL } from '../../shared/opencode-events'

const markdownWatcherMocks = vi.hoisted(() => ({
  cleanupMarkdownKanbanWatchers: vi.fn(async () => undefined),
  setMarkdownKanbanEventPublisher: vi.fn()
}))

vi.mock('../../main/services/markdown-kanban-watcher', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../main/services/markdown-kanban-watcher')>()
  return {
    ...actual,
    cleanupMarkdownKanbanWatchers: markdownWatcherMocks.cleanupMarkdownKanbanWatchers,
    setMarkdownKanbanEventPublisher: markdownWatcherMocks.setMarkdownKanbanEventPublisher
  }
})

describe('hive server smoke', () => {
  let started: StartedHiveServer | null = null

  afterEach(async () => {
    await started?.close()
    started = null
  })

  it('serves the environment descriptor over HTTP', async () => {
    started = await Effect.runPromise(
      startHiveServer({ port: 0, baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')) })
    )

    const response = await fetch(`${started.httpBaseUrl}/.well-known/hive/environment`)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      mode: 'desktop',
      host: '127.0.0.1',
      port: started.port,
      httpBaseUrl: started.httpBaseUrl,
      wsBaseUrl: started.wsBaseUrl,
      hasDesktopBootstrapToken: false
    })
  })

  it('serves health over HTTP without authentication', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')),
        desktopBootstrapToken: 'token-1'
      })
    )

    const response = await fetch(`${started.httpBaseUrl}/health`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('allows loopback browser origins without using wildcard CORS', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')),
        desktopBootstrapToken: 'token-1'
      })
    )

    const response = await fetch(`${started.httpBaseUrl}/health`, {
      headers: { Origin: 'http://localhost:5173' }
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*')
    expect(response.headers.get('vary')).toBe('Origin')
  })

  it('handles loopback CORS preflight for authenticated browser requests', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')),
        desktopBootstrapToken: 'token-1'
      })
    )

    const response = await fetch(`${started.httpBaseUrl}/api/auth/session`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization'
      }
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173')
    expect(response.headers.get('access-control-allow-methods')).toContain('GET')
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization')
    expect(response.headers.get('access-control-allow-headers')).toContain('Content-Type')
  })

  it('rejects non-loopback CORS origins', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')),
        desktopBootstrapToken: 'token-1'
      })
    )

    const response = await fetch(`${started.httpBaseUrl}/health`, {
      headers: { Origin: 'https://example.com' }
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden origin' })
  })

  it('handles system.ping over WebSocket RPC', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')),
        desktopBootstrapToken: 'token-1'
      })
    )

    const socket = await openRawWebSocket(started, await issueWebSocketToken(started, 'token-1'))
    socket.write(
      createMaskedFrame(JSON.stringify({ id: 'ping-1', method: 'system.ping', params: {} }))
    )
    const response = JSON.parse(await readTextFrame(socket))
    socket.end()

    expect(response).toEqual({
      id: 'ping-1',
      ok: true,
      value: { ok: true }
    })
  })

  it('delivers subscribed published agent stream events over WebSocket', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')),
        desktopBootstrapToken: 'token-1'
      })
    )

    const socket = await openRawWebSocket(started, await issueWebSocketToken(started, 'token-1'))
    socket.write(
      createMaskedFrame(JSON.stringify({ type: 'subscribe', channel: OPENCODE_STREAM_CHANNEL }))
    )
    const frame = readTextFrame(socket)
    const accessToken = await issueAccessToken(started, 'token-1')
    const response = await fetch(`${started.httpBaseUrl}/api/events/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        channel: OPENCODE_STREAM_CHANNEL,
        payload: { type: 'message.delta', sessionId: 'session-1', data: { text: 'hello' } }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    const event = JSON.parse(await frame)
    socket.end()
    expect(event).toEqual({
      channel: OPENCODE_STREAM_CHANNEL,
      payload: { type: 'message.delta', sessionId: 'session-1', data: { text: 'hello' } }
    })
  })

  it('cleans up markdown kanban watchers when closing', async () => {
    markdownWatcherMocks.cleanupMarkdownKanbanWatchers.mockClear()
    markdownWatcherMocks.setMarkdownKanbanEventPublisher.mockClear()

    started = await Effect.runPromise(
      startHiveServer({ port: 0, baseDir: mkdtempSync(join(tmpdir(), 'hive-server-')) })
    )

    await started.close()
    started = null

    expect(markdownWatcherMocks.cleanupMarkdownKanbanWatchers).toHaveBeenCalledTimes(1)
    expect(markdownWatcherMocks.setMarkdownKanbanEventPublisher).toHaveBeenLastCalledWith(null)
  })
})

const openRawWebSocket = (server: StartedHiveServer, token: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const socket = createConnection(server.port, server.host)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(
        [
          `GET /ws?token=${encodeURIComponent(token)} HTTP/1.1`,
          `Host: ${server.host}:${server.port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n'
        ].join('\r\n')
      )
    })

    socket.once('data', (chunk) => {
      const response = chunk.toString('utf8')
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')

      if (!response.includes('101 Switching Protocols') || !response.includes(accept)) {
        reject(new Error(`Unexpected WebSocket handshake response: ${response}`))
        return
      }

      socket.off('error', reject)
      resolve(socket)
    })
  })

const issueWebSocketToken = async (
  server: StartedHiveServer,
  bootstrapToken: string
): Promise<string> => {
  const accessToken = await issueAccessToken(server, bootstrapToken)
  const tokenResponse = await fetch(`${server.httpBaseUrl}/api/auth/ws-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const tokenBody = await tokenResponse.json()
  return tokenBody.webSocketToken.token
}

const issueAccessToken = async (
  server: StartedHiveServer,
  bootstrapToken: string
): Promise<string> => {
  const bootstrapResponse = await fetch(`${server.httpBaseUrl}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken })
  })
  const bootstrapBody = await bootstrapResponse.json()
  return bootstrapBody.session.accessToken
}

const createMaskedFrame = (text: string): Buffer => {
  const payload = Buffer.from(text)
  const mask = randomBytes(4)
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4)
  header[0] = 0x81
  if (payload.length < 126) {
    header[1] = 0x80 | payload.length
  } else {
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  }

  const maskedPayload = Buffer.from(payload)
  for (let i = 0; i < maskedPayload.length; i += 1) {
    maskedPayload[i] ^= mask[i % 4]
  }

  return Buffer.concat([header, mask, maskedPayload])
}

const readTextFrame = (socket: Socket): Promise<string> =>
  new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.once('data', (chunk) => {
      socket.off('error', reject)
      const length = chunk[1] & 0x7f
      const offset = length === 126 ? 4 : length === 127 ? 10 : 2
      resolve(chunk.subarray(offset, offset + length).toString('utf8'))
    })
  })
