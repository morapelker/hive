import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { startHiveServer, type StartedHiveServer } from '../server'

describe('auth websocket token route', () => {
  let started: StartedHiveServer | null = null

  afterEach(async () => {
    await started?.close()
    started = null
  })

  it('issues a short-lived WebSocket token for an authenticated session', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-auth-ws-token-')),
        desktopBootstrapToken: 'desktop-bootstrap-token'
      })
    )

    const bootstrapResponse = await fetch(`${started.httpBaseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: 'desktop-bootstrap-token' })
    })
    const bootstrapBody = await bootstrapResponse.json()

    const response = await fetch(`${started.httpBaseUrl}/api/auth/ws-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bootstrapBody.session.accessToken}` }
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.webSocketToken).toEqual({
      token: expect.any(String),
      issuedAt: expect.any(String),
      expiresAt: expect.any(String)
    })
    expect(body.webSocketToken.token).not.toBe('')
    expect(Date.parse(body.webSocketToken.expiresAt)).toBeGreaterThan(
      Date.parse(body.webSocketToken.issuedAt)
    )
    expect(
      Date.parse(body.webSocketToken.expiresAt) - Date.parse(body.webSocketToken.issuedAt)
    ).toBeLessThanOrEqual(60_000)
  })

  it('rejects missing or invalid bearer tokens before issuing a WebSocket token', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-auth-ws-token-')),
        desktopBootstrapToken: 'desktop-bootstrap-token'
      })
    )

    const missingResponse = await fetch(`${started.httpBaseUrl}/api/auth/ws-token`, {
      method: 'POST'
    })
    const invalidResponse = await fetch(`${started.httpBaseUrl}/api/auth/ws-token`, {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid-token' }
    })

    expect(missingResponse.status).toBe(401)
    await expect(missingResponse.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(invalidResponse.status).toBe(401)
    await expect(invalidResponse.json()).resolves.toEqual({ error: 'Unauthorized' })
  })
})
