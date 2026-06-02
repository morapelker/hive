import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { startHiveServer, type StartedHiveServer } from '../server'

describe('auth session route', () => {
  let started: StartedHiveServer | null = null

  afterEach(async () => {
    await started?.close()
    started = null
  })

  it('returns the active authenticated session for a valid bearer token', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-auth-session-')),
        desktopBootstrapToken: 'desktop-bootstrap-token'
      })
    )

    const bootstrapResponse = await fetch(`${started.httpBaseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: 'desktop-bootstrap-token' })
    })
    const bootstrapBody = await bootstrapResponse.json()
    const accessToken = bootstrapBody.session.accessToken

    const response = await fetch(`${started.httpBaseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      session: bootstrapBody.session
    })
  })

  it('rejects missing or invalid bearer tokens', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-auth-session-')),
        desktopBootstrapToken: 'desktop-bootstrap-token'
      })
    )

    const missingResponse = await fetch(`${started.httpBaseUrl}/api/auth/session`)
    const invalidResponse = await fetch(`${started.httpBaseUrl}/api/auth/session`, {
      headers: { Authorization: 'Bearer invalid-token' }
    })

    expect(missingResponse.status).toBe(401)
    await expect(missingResponse.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(invalidResponse.status).toBe(401)
    await expect(invalidResponse.json()).resolves.toEqual({ error: 'Unauthorized' })
  })
})
