import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { startHiveServer, type StartedHiveServer } from '../server'

describe('auth websocket upgrade', () => {
  let started: StartedHiveServer | null = null

  afterEach(async () => {
    await started?.close()
    started = null
  })

  it('rejects unauthenticated WebSocket upgrades', async () => {
    started = await startAuthServer()

    await expect(openRawWebSocket(started)).resolves.toContain('401 Unauthorized')
    await expect(openRawWebSocket(started, 'invalid-token')).resolves.toContain('401 Unauthorized')
  })

  it('accepts WebSocket upgrades with an issued short-lived token', async () => {
    started = await startAuthServer()
    const token = await issueWebSocketToken(started)

    await expect(openRawWebSocket(started, token)).resolves.toContain('101 Switching Protocols')
  })
})

const startAuthServer = (): Promise<StartedHiveServer> =>
  Effect.runPromise(
    startHiveServer({
      port: 0,
      baseDir: mkdtempSync(join(tmpdir(), 'hive-auth-ws-')),
      desktopBootstrapToken: 'desktop-bootstrap-token'
    })
  )

const issueWebSocketToken = async (server: StartedHiveServer): Promise<string> => {
  const bootstrapResponse = await fetch(`${server.httpBaseUrl}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: 'desktop-bootstrap-token' })
  })
  const bootstrapBody = await bootstrapResponse.json()
  const response = await fetch(`${server.httpBaseUrl}/api/auth/ws-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bootstrapBody.session.accessToken}` }
  })
  const body = await response.json()
  return body.webSocketToken.token
}

const openRawWebSocket = (server: StartedHiveServer, token?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const socket = createConnection(server.port, server.host)
    const path = token ? `/ws?token=${encodeURIComponent(token)}` : '/ws'
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
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
      socket.off('error', reject)
      const response = chunk.toString('utf8')
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.end()

      if (response.includes('101 Switching Protocols')) {
        expect(response).toContain(accept)
      }
      resolve(response)
    })
  })
