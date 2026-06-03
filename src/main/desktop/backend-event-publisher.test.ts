import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  publishDesktopBackendEvent,
  setCurrentBackend
} from './backend-event-publisher'
import type { StartedDesktopBackend } from './backend-manager'

const makeBackend = (): StartedDesktopBackend => ({
  config: {
    executablePath: '/electron',
    entryPath: '/app/server.js',
    cwd: '/app',
    baseDir: '/base',
    env: {},
    host: '127.0.0.1',
    port: 3773,
    httpBaseUrl: 'http://127.0.0.1:3773',
    wsBaseUrl: 'ws://127.0.0.1:3773',
    bootstrapToken: 'bootstrap-token-1'
  },
  bootstrap: {
    httpBaseUrl: 'http://127.0.0.1:3773',
    wsBaseUrl: 'ws://127.0.0.1:3773',
    bootstrapToken: 'bootstrap-token-1'
  },
  stop: vi.fn(),
  getChild: () => null
})

afterEach(() => {
  setCurrentBackend(null)
})

describe('backend event publisher', () => {
  it('authenticates before publishing desktop backend events over HTTP', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session: { accessToken: 'access-token-1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const backend = makeBackend()
    setCurrentBackend(backend)

    await expect(
      publishDesktopBackendEvent(
        'test:channel',
        { message: 'hello' },
        fetchImpl as unknown as typeof fetch
      )
    ).resolves.toBe(true)

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      `${backend.bootstrap.httpBaseUrl}/api/auth/bootstrap`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootstrapToken: backend.bootstrap.bootstrapToken })
      }
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `${backend.bootstrap.httpBaseUrl}/api/events/publish`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer access-token-1'
        },
        body: JSON.stringify({ channel: 'test:channel', payload: { message: 'hello' } })
      }
    )
  })
})
