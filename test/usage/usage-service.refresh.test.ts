// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const osMock = vi.hoisted(() => ({
  homeDir: '/tmp/hive-usage-refresh-test'
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp'
  }
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => osMock.homeDir,
    platform: () => 'linux'
  }
})

import { fetchClaudeUsage } from '../../src/main/services/usage-service'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'

function usageData(utilization = 12) {
  return {
    five_hour: { utilization, resets_at: '2026-05-19T12:00:00.000Z' },
    seven_day: { utilization: utilization + 1, resets_at: '2026-05-20T12:00:00.000Z' }
  }
}

function jsonResponse(body: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init
  })
}

describe('fetchClaudeUsage saved-account refresh', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    osMock.homeDir = await mkdtemp(join(tmpdir(), 'hive-usage-refresh-'))
  })

  it('refreshes an expired saved-account token before the usage request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600 },
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(jsonResponse(usageData(), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchClaudeUsage(
      {
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
        expiresAt: Date.now() - 1_000,
        accountId: 'acct-1'
      },
      { caller: 'usage:fetchForAccount', accountId: 'acct-1' }
    )

    expect(result.success).toBe(true)
    expect(result.rotated).toMatchObject({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token'
    })
    expect(result.rotated?.expiresAt).toBeGreaterThan(Date.now())
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      TOKEN_URL,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'old-refresh-token',
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
        })
      })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      USAGE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer new-access-token' })
      })
    )
  })

  it('refreshes and retries once when a saved-account usage request returns 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'expired' }, { status: 401, statusText: 'Unauthorized' }))
      .mockResolvedValueOnce(
        jsonResponse(
          { access_token: 'retry-access-token', refresh_token: 'retry-refresh-token', expires_in: 7200 },
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(jsonResponse(usageData(44), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchClaudeUsage(
      {
        accessToken: 'expired-access-token',
        refreshToken: 'old-refresh-token',
        expiresAt: Date.now() + 3600_000,
        accountId: 'acct-2'
      },
      { caller: 'usage:fetchForAccount', accountId: 'acct-2' }
    )

    expect(result.success).toBe(true)
    expect(result.data?.five_hour.utilization).toBe(44)
    expect(result.rotated).toMatchObject({
      accessToken: 'retry-access-token',
      refreshToken: 'retry-refresh-token'
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      USAGE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer retry-access-token' })
      })
    )
  })

  it('returns a token refresh failure when the 401 retry refresh fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'expired' }, { status: 401, statusText: 'Unauthorized' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid refresh' }, { status: 400, statusText: 'Bad Request' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchClaudeUsage(
      {
        accessToken: 'expired-access-token',
        refreshToken: 'dead-refresh-token',
        expiresAt: Date.now() + 3600_000,
        accountId: 'acct-3'
      },
      { caller: 'usage:fetchForAccount', accountId: 'acct-3' }
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('Token refresh failed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent refreshes for the same saved account', async () => {
    let refreshCount = 0
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === TOKEN_URL) {
        refreshCount += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        return jsonResponse(
          { access_token: 'shared-access-token', refresh_token: 'shared-refresh-token', expires_in: 3600 },
          { status: 200 }
        )
      }
      return jsonResponse(usageData(refreshCount), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const override = {
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      expiresAt: Date.now() - 1_000,
      accountId: 'same-account'
    }

    const [first, second] = await Promise.all([
      fetchClaudeUsage(override, { caller: 'refreshAllForProvider', accountId: 'same-account' }),
      fetchClaudeUsage(override, { caller: 'refreshAllForProvider', accountId: 'same-account' })
    ])

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(refreshCount).toBe(1)
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === TOKEN_URL)).toHaveLength(1)
  })

  it('does not attempt refresh for a legacy saved account without a refresh token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'expired' }, { status: 401, statusText: 'Unauthorized' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchClaudeUsage(
      { accessToken: 'legacy-access-token', expiresAt: Date.now() - 1_000, accountId: 'legacy' },
      { caller: 'usage:fetchForAccount', accountId: 'legacy' }
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('Usage API returned 401')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(USAGE_URL, expect.anything())
  })

  it('does not refresh live Claude credentials even when the stored blob is expired', async () => {
    await mkdir(join(osMock.homeDir, '.claude'), { recursive: true })
    await writeFile(
      join(osMock.homeDir, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'live-access-token',
          refreshToken: 'live-refresh-token',
          expiresAt: Date.now() - 1_000
        }
      })
    )
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'expired' }, { status: 401, statusText: 'Unauthorized' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchClaudeUsage(undefined, { caller: 'usage:fetch' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Usage API returned 401')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      USAGE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer live-access-token' })
      })
    )

    await rm(osMock.homeDir, { recursive: true, force: true })
  })
})
