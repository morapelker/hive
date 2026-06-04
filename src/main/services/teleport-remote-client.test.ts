import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'

import {
  parseTeleportSettings,
  requestRemote,
  targetFromSettings
} from './teleport-remote-client'

const servers: WebSocketServer[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function startServer(onConnection: (socket: WsSocket) => void): {
  httpBaseUrl: string
  wsBaseUrl: string
  bootstrapToken: string
} {
  const server = new WebSocketServer({ port: 0 })
  servers.push(server)
  server.on('connection', onConnection)
  const port = (server.address() as AddressInfo).port
  // The HTTP auth dance is stubbed below; only wsBaseUrl actually connects.
  return {
    httpBaseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    bootstrapToken: 'bootstrap-token'
  }
}

function stubAuthFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (String(input).endsWith('/api/auth/bootstrap')) {
        return { ok: true, json: async () => ({ session: { accessToken: 'access' } }) }
      }
      return { ok: true, json: async () => ({ webSocketToken: { token: 'ws-token' } }) }
    })
  )
}

describe('requestRemote', () => {
  it('resolves with the value of a matching response', async () => {
    stubAuthFetch()
    const target = startServer((socket) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw))
        socket.send(JSON.stringify({ id: msg.id, ok: true, value: { greeting: 'hi' } }))
      })
    })

    await expect(requestRemote(target, 'teleportOps.ping', {})).resolves.toEqual({ greeting: 'hi' })
  })

  it('rejects when the socket closes before a matching response', async () => {
    stubAuthFetch()
    const target = startServer((socket) => socket.close())

    await expect(requestRemote(target, 'teleportOps.ping', {})).rejects.toThrow(
      /closed before responding|closed/i
    )
  })

  it('ignores a non-JSON frame and still resolves on the later valid frame', async () => {
    stubAuthFetch()
    const target = startServer((socket) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw))
        socket.send('not-json{{{')
        socket.send(JSON.stringify({ id: msg.id, ok: true, value: { greeting: 'after-noise' } }))
      })
    })

    await expect(requestRemote(target, 'teleportOps.ping', {})).resolves.toEqual({
      greeting: 'after-noise'
    })
  })

  it('rejects with a timeout when the server never replies', async () => {
    stubAuthFetch()
    const target = startServer(() => {
      // Accept the connection but never send a response.
    })

    await expect(requestRemote(target, 'teleportOps.ping', {}, 100)).rejects.toThrow(
      /timed out/i
    )
  })

  it('rejects with the remote error for an !ok response', async () => {
    stubAuthFetch()
    const target = startServer((socket) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw))
        socket.send(
          JSON.stringify({ id: msg.id, ok: false, error: { code: 'BadThing', message: 'nope' } })
        )
      })
    })

    await expect(requestRemote(target, 'teleportOps.ping', {})).rejects.toThrow('nope')
  })
})

describe('targetFromSettings', () => {
  it('derives the ws endpoint for a root URL', () => {
    const target = targetFromSettings({ url: 'http://localhost:3773', bootstrapToken: 't' })
    expect(target.httpBaseUrl).toBe('http://localhost:3773')
    expect(target.wsBaseUrl).toBe('ws://localhost:3773/ws')
  })

  it('preserves a configured sub-path and upgrades to wss', () => {
    const target = targetFromSettings({ url: 'https://host/teleport/', bootstrapToken: 't' })
    expect(target.httpBaseUrl).toBe('https://host/teleport')
    expect(target.wsBaseUrl).toBe('wss://host/teleport/ws')
  })
})

describe('parseTeleportSettings', () => {
  it('returns trimmed url and token from valid settings', () => {
    const raw = JSON.stringify({ teleport: { url: ' http://localhost:3773 ', bootstrapToken: ' tok ' } })
    expect(parseTeleportSettings(raw)).toEqual({ url: 'http://localhost:3773', bootstrapToken: 'tok' })
  })

  it('throws "not configured" for null, malformed JSON, or missing fields', () => {
    expect(() => parseTeleportSettings(null)).toThrow('Teleport remote is not configured')
    expect(() => parseTeleportSettings('{not valid json')).toThrow(
      'Teleport remote is not configured'
    )
    expect(() => parseTeleportSettings(JSON.stringify({ teleport: { url: 'x' } }))).toThrow(
      'Teleport remote is not configured'
    )
  })
})
