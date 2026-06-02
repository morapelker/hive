import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { startHiveServer, type StartedHiveServer } from '../server'

describe('authenticated HTTP routes', () => {
  let started: StartedHiveServer | null = null

  afterEach(async () => {
    await started?.close()
    started = null
  })

  it('requires a bearer session for event publishing', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-auth-http-routes-')),
        desktopBootstrapToken: 'desktop-bootstrap-token'
      })
    )

    const missingResponse = await publishEvent(started)
    const rawBootstrapResponse = await publishEvent(started, {
      'x-hive-bootstrap-token': 'desktop-bootstrap-token'
    })
    const invalidResponse = await publishEvent(started, { Authorization: 'Bearer invalid-token' })
    const accessToken = await issueAccessToken(started)
    const authorizedResponse = await publishEvent(started, {
      Authorization: `Bearer ${accessToken}`
    })

    expect(missingResponse.status).toBe(401)
    await expect(missingResponse.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(rawBootstrapResponse.status).toBe(401)
    await expect(rawBootstrapResponse.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(invalidResponse.status).toBe(401)
    await expect(invalidResponse.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(authorizedResponse.status).toBe(200)
    await expect(authorizedResponse.json()).resolves.toEqual({ ok: true })
  })

  it('allows unauthenticated access only to health, environment, and bootstrap endpoints', async () => {
    started = await Effect.runPromise(
      startHiveServer({
        port: 0,
        baseDir: mkdtempSync(join(tmpdir(), 'hive-auth-http-routes-')),
        desktopBootstrapToken: 'desktop-bootstrap-token'
      })
    )

    const healthResponse = await fetch(`${started.httpBaseUrl}/health`)
    const environmentResponse = await fetch(`${started.httpBaseUrl}/.well-known/hive/environment`)
    const bootstrapResponse = await fetch(`${started.httpBaseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: 'desktop-bootstrap-token' })
    })
    const sessionResponse = await fetch(`${started.httpBaseUrl}/api/auth/session`)
    const wsTokenResponse = await fetch(`${started.httpBaseUrl}/api/auth/ws-token`, {
      method: 'POST'
    })
    const eventPublishResponse = await publishEvent(started)

    expect(healthResponse.status).toBe(200)
    await expect(healthResponse.json()).resolves.toEqual({ ok: true })
    expect(environmentResponse.status).toBe(200)
    expect(bootstrapResponse.status).toBe(200)
    expect(sessionResponse.status).toBe(401)
    await expect(sessionResponse.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(wsTokenResponse.status).toBe(401)
    await expect(wsTokenResponse.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(eventPublishResponse.status).toBe(401)
    await expect(eventPublishResponse.json()).resolves.toEqual({ error: 'Unauthorized' })
  })
})

const publishEvent = (
  server: StartedHiveServer,
  headers: Record<string, string> = {}
): Promise<Response> =>
  fetch(`${server.httpBaseUrl}/api/events/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify({
      channel: 'test:channel',
      payload: { ok: true }
    })
  })

const issueAccessToken = async (server: StartedHiveServer): Promise<string> => {
  const response = await fetch(`${server.httpBaseUrl}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: 'desktop-bootstrap-token' })
  })
  const body = await response.json()
  return body.session.accessToken
}
