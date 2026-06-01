import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { startHiveServer, type StartedHiveServer } from '../server'

describe('auth bootstrap route', () => {
  let started: StartedHiveServer | null = null

  afterEach(async () => {
    await started?.close()
    started = null
  })

  it('exchanges a valid desktop bootstrap token for an authenticated session', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-auth-bootstrap-')),
        desktopBootstrapToken: 'desktop-bootstrap-token'
      })
    )

    const response = await fetch(`${started.httpBaseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: 'desktop-bootstrap-token' })
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.session).toEqual({
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      issuedAt: expect.any(String),
      expiresAt: expect.any(String)
    })
    expect(body.session.accessToken).not.toBe('')
    expect(Date.parse(body.session.expiresAt)).toBeGreaterThan(Date.parse(body.session.issuedAt))
  })

  it('rejects invalid or missing desktop bootstrap tokens', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-auth-bootstrap-')),
        desktopBootstrapToken: 'desktop-bootstrap-token'
      })
    )

    const invalidResponse = await fetch(`${started.httpBaseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: 'wrong-token' })
    })
    const missingResponse = await fetch(`${started.httpBaseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })

    expect(invalidResponse.status).toBe(401)
    await expect(invalidResponse.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(missingResponse.status).toBe(400)
    await expect(missingResponse.json()).resolves.toEqual({ error: 'Invalid bootstrap request' })
  })
})
