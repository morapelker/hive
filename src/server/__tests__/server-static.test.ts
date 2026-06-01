import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startHiveServer, type StartedHiveServer } from '../server'

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>'
const APP_JS = 'console.log("hive web")'

describe('hive server static web serving', () => {
  let started: StartedHiveServer | null = null
  let staticDir: string

  beforeAll(() => {
    staticDir = mkdtempSync(join(tmpdir(), 'hive-web-'))
    writeFileSync(join(staticDir, 'index.html'), INDEX_HTML)
    mkdirSync(join(staticDir, 'assets'))
    writeFileSync(join(staticDir, 'assets', 'app.js'), APP_JS)
  })

  afterEach(async () => {
    await started?.close()
    started = null
  })

  const startWebServer = (): Promise<StartedHiveServer> =>
    Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-web-base-')),
        staticDir,
        requireAuth: false
      })
    )

  it('serves index.html at the root', async () => {
    started = await startWebServer()
    const response = await fetch(`${started.httpBaseUrl}/`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    await expect(response.text()).resolves.toBe(INDEX_HTML)
  })

  it('serves hashed assets with the right content type', async () => {
    started = await startWebServer()
    const response = await fetch(`${started.httpBaseUrl}/assets/app.js`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    await expect(response.text()).resolves.toBe(APP_JS)
  })

  it('falls back to index.html for extensionless routes', async () => {
    started = await startWebServer()
    const response = await fetch(`${started.httpBaseUrl}/projects/some-route`)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe(INDEX_HTML)
  })

  it('keeps API routes working alongside static serving', async () => {
    started = await startWebServer()
    const response = await fetch(`${started.httpBaseUrl}/health`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('accepts token-less WebSocket upgrades when auth is disabled', async () => {
    started = await startWebServer()
    await expect(openRawWebSocket(started)).resolves.toContain('101 Switching Protocols')
  })
})

const openRawWebSocket = (server: StartedHiveServer): Promise<string> =>
  new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const socket: Socket = createConnection(server.port, server.host)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(
        [
          `GET /ws HTTP/1.1`,
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
