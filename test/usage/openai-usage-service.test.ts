// @vitest-environment node
import { readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// openai-usage-service.ts reads `process.env.CODEX_HOME` once, at module
// load time (`const CODEX_HOME = process.env.CODEX_HOME || ...`) — so this
// has to be set inside `vi.hoisted`, which Vitest runs before the module
// under test is ever imported. `require` (rather than the statically
// imported bindings, which aren't initialized yet at hoist time) is used to
// reach the real `fs`/`os`/`path` builtins synchronously.
const mocks = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require('node:fs') as typeof import('fs')
  const os = require('node:os') as typeof import('os')
  const path = require('node:path') as typeof import('path')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-openai-usage-'))
  process.env.CODEX_HOME = dir
  return { codexHome: dir }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' }
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { fetchOpenAIUsage } from '../../src/main/services/openai-usage-service'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const AUTH_FILE = join(mocks.codexHome, 'auth.json')

function base64url(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url')
}

function accessTokenWithExp(expSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const body = base64url(JSON.stringify({ exp: expSeconds }))
  return `${header}.${body}.fake-signature`
}

function jsonResponse(body: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init })
}

function usageBody() {
  return {
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 300, reset_after_seconds: 100, reset_at: 1000 },
      secondary_window: null
    }
  }
}

async function writeLiveAuth(overrides: Partial<{ accessToken: string; refreshToken: string }> = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  const content = JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: 'id-token',
      access_token: overrides.accessToken ?? accessTokenWithExp(nowSec - 100),
      refresh_token: overrides.refreshToken ?? 'live-refresh-token',
      account_id: 'live-account'
    },
    last_refresh: '2026-01-01T00:00:00.000Z'
  })
  await writeFile(AUTH_FILE, content, 'utf-8')
  return content
}

describe('fetchOpenAIUsage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(async () => {
    await rm(AUTH_FILE, { force: true })
  })

  afterAll(async () => {
    await rm(mocks.codexHome, { recursive: true, force: true })
  })

  describe('live path (no override)', () => {
    it('refreshes in memory and does not write auth.json from inside the service', async () => {
      const before = await writeLiveAuth()
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            { access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new-id' },
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(jsonResponse(usageBody(), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      const result = await fetchOpenAIUsage()

      expect(result.success).toBe(true)
      expect(result.rotated).toEqual({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        idToken: 'new-id'
      })
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        TOKEN_URL,
        expect.objectContaining({
          body: JSON.stringify({
            client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
            grant_type: 'refresh_token',
            refresh_token: 'live-refresh-token'
          })
        })
      )
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        USAGE_URL,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer new-access' })
        })
      )

      // The service itself must not have persisted anything — auth.json on
      // disk is byte-for-byte the same as before the fetch.
      const after = await readFile(AUTH_FILE, 'utf-8')
      expect(after).toBe(before)
    })

    it('needsLogin when the live refresh itself returns invalid_grant, without touching auth.json', async () => {
      const before = await writeLiveAuth()
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, { status: 400 }))
      )

      const result = await fetchOpenAIUsage()

      expect(result.success).toBe(false)
      expect(result.needsLogin).toBe(true)
      expect(result.error).toContain('Token refresh failed: invalid_grant')

      const after = await readFile(AUTH_FILE, 'utf-8')
      expect(after).toBe(before)
    })
  })

  describe('override (saved-account) path', () => {
    function override() {
      return {
        accessToken: accessTokenWithExp(Math.floor(Date.now() / 1000) + 10_000),
        refreshToken: 'saved-refresh-token',
        accountId: 'saved-account'
      }
    }

    it('sets needsLogin on a 403 usage response (after the one-refresh-retry)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, { status: 403, statusText: 'Forbidden' }))
      vi.stubGlobal('fetch', fetchMock)

      const result = await fetchOpenAIUsage(override())

      expect(result.success).toBe(false)
      expect(result.needsLogin).toBe(true)
      expect(result.error).toContain('403')
    })

    it('sets needsLogin on a 401 usage response that persists through the retry', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: 'expired' }, { status: 401 }))
        .mockResolvedValueOnce(
          jsonResponse({ access_token: 'retry-access', refresh_token: 'retry-refresh' }, { status: 200 })
        )
        .mockResolvedValueOnce(jsonResponse({ error: 'still unauthorized' }, { status: 401 }))
      vi.stubGlobal('fetch', fetchMock)

      const result = await fetchOpenAIUsage(override())

      expect(result.success).toBe(false)
      expect(result.needsLogin).toBe(true)
      expect(result.rotated).toEqual({
        accessToken: 'retry-access',
        refreshToken: 'retry-refresh',
        idToken: ''
      })
    })

    it('surfaces rotated tokens on a successful retry-after-401', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: 'expired' }, { status: 401 }))
        .mockResolvedValueOnce(
          jsonResponse({ access_token: 'retry-access', refresh_token: 'retry-refresh' }, { status: 200 })
        )
        .mockResolvedValueOnce(jsonResponse(usageBody(), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      const result = await fetchOpenAIUsage(override())

      expect(result.success).toBe(true)
      expect(result.rotated).toEqual({
        accessToken: 'retry-access',
        refreshToken: 'retry-refresh',
        idToken: ''
      })
    })

    it('sets needsLogin when the refresh itself returns invalid_grant (400)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, { status: 400 }))
      )

      const expiredOverride = {
        accessToken: accessTokenWithExp(Math.floor(Date.now() / 1000) - 100),
        refreshToken: 'dead-refresh-token',
        accountId: 'saved-account'
      }
      const result = await fetchOpenAIUsage(expiredOverride)

      expect(result.success).toBe(false)
      expect(result.needsLogin).toBe(true)
      expect(result.error).toContain('Token refresh failed: invalid_grant')
    })
  })
})
