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
import { clearRejectedAnthropicRefreshTokensForTests } from '../../src/main/services/oauth-anthropic'

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

/**
 * `GET /api/oauth/usage` as captured on 2026-11-01 from a plan without a
 * 5-hour limit (Anthropic dropped it from many plans): `five_hour` is null,
 * `limits[]` carries no `session` row, and every extra-usage number is null.
 * Verbatim, so the normalization is exercised against the real key set.
 */
const NO_FIVE_HOUR_RESPONSE = {
  five_hour: null,
  seven_day: {
    utilization: 6,
    resets_at: '2026-11-06T15:00:00.066253+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  seven_day_omelette: null,
  tangelo: null,
  iguana_necktie: null,
  omelette_promotional: null,
  nimbus_quill: null,
  cinder_cove: null,
  copper_kite: null,
  brass_thimble: null,
  harbor_lantern: null,
  wattle_ember: null,
  promo_credits: null,
  amber_ladder: null,
  granite_teacup: null,
  amber_cistern: null,
  amber_cistern_offer: null,
  juniper_tide: null,
  cedar_ember: null,
  starry_waterfall: null,
  amber_gauge: null,
  pace: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: null,
    used_credits: null,
    utilization: null,
    currency: null,
    decimal_places: null,
    disabled_reason: null,
    user_disabled: false,
    spend_limit_reached: false,
    credits_ever_enabled: false,
    daily: null,
    weekly: null
  },
  limits: [
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 6,
      severity: 'normal',
      resets_at: '2026-11-06T15:00:00.066253+00:00',
      scope: null,
      is_active: false
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 10,
      severity: 'normal',
      resets_at: '2026-11-06T15:00:00.066382+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true
    }
  ],
  spend: {
    used: { amount_minor: 0, currency: 'USD', exponent: 2 },
    limit: null,
    percent: 0,
    severity: 'normal',
    enabled: false,
    disabled_reason: null,
    cap: null,
    balance: null,
    auto_reload: null,
    disclaimer:
      'Usage credits cover you when you hit your plan limits. [Learn more](https://support.claude.com/articles/12429409)',
    can_purchase_credits: false,
    can_toggle: false
  },
  member_dashboard_available: false,
  seven_day_breakdown: {
    as_of: '2026-11-01T12:23:37.097136+00:00',
    window_started_at: '2026-10-30T15:00:00.066253+00:00',
    rows: [
      { key: 'claude_code', display_name: 'Claude Code', percent: 100 },
      { key: 'chat', display_name: 'Chats', percent: 0 },
      { key: 'cowork', display_name: 'Cowork', percent: 0 },
      { key: 'other', display_name: 'Other', percent: 0 }
    ]
  },
  weekly_scoped_shares: [
    { limit_index: 1, used_percent_of_weekly: 5, allowance_percent_of_weekly: 50 }
  ]
}

describe('fetchClaudeUsage saved-account refresh', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    clearRejectedAnthropicRefreshTokensForTests()
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
      refreshToken: 'new-refresh-token',
      rotatedFrom: 'old-refresh-token'
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
    expect(result.data?.five_hour?.utilization).toBe(44)
    expect(result.rotated).toMatchObject({
      accessToken: 'retry-access-token',
      refreshToken: 'retry-refresh-token',
      rotatedFrom: 'old-refresh-token'
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      USAGE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer retry-access-token' })
      })
    )
  })

  it('returns a token refresh failure (with needsLogin) when the 401 retry refresh fails', async () => {
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
    expect(result.needsLogin).toBe(true)
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

  it('does not attempt refresh for a legacy saved account without a refresh token, and flags needsLogin', async () => {
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
    expect(result.needsLogin).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(USAGE_URL, expect.anything())
  })

  it('refreshes live Claude credentials proactively when the stored blob is expired, and returns rotated tokens', async () => {
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
      .mockResolvedValueOnce(
        jsonResponse(
          { access_token: 'live-new-access', refresh_token: 'live-new-refresh', expires_in: 3600 },
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(jsonResponse(usageData(), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchClaudeUsage(undefined, { caller: 'usage:fetch' })

    expect(result.success).toBe(true)
    expect(result.rotated).toMatchObject({
      accessToken: 'live-new-access',
      refreshToken: 'live-new-refresh',
      rotatedFrom: 'live-refresh-token'
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      TOKEN_URL,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'live-refresh-token',
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
        })
      })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      USAGE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer live-new-access' })
      })
    )

    await rm(osMock.homeDir, { recursive: true, force: true })
  })

  it('refreshes and retries once when the live usage request returns 401 (reactive path)', async () => {
    await mkdir(join(osMock.homeDir, '.claude'), { recursive: true })
    await writeFile(
      join(osMock.homeDir, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'live-expired-access',
          refreshToken: 'live-refresh-token',
          expiresAt: Date.now() + 3600_000
        }
      })
    )
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'expired' }, { status: 401, statusText: 'Unauthorized' }))
      .mockResolvedValueOnce(
        jsonResponse(
          { access_token: 'live-retry-access', refresh_token: 'live-retry-refresh', expires_in: 7200 },
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(jsonResponse(usageData(77), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchClaudeUsage(undefined, { caller: 'usage:fetch' })

    expect(result.success).toBe(true)
    expect(result.data?.five_hour?.utilization).toBe(77)
    expect(result.rotated).toMatchObject({
      accessToken: 'live-retry-access',
      refreshToken: 'live-retry-refresh',
      rotatedFrom: 'live-refresh-token'
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      USAGE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer live-retry-access' })
      })
    )

    await rm(osMock.homeDir, { recursive: true, force: true })
  })

  describe('rotated token surfacing on usage-request failure (after a successful proactive rotation)', () => {
    it('carries rotated (with rotatedFrom) on a non-2xx usage response, so the new refresh token still gets persisted', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            { access_token: 'proactive-new-access', refresh_token: 'proactive-new-refresh', expires_in: 3600 },
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          jsonResponse({ error: 'server error' }, { status: 500, statusText: 'Internal Server Error' })
        )
      vi.stubGlobal('fetch', fetchMock)

      const result = await fetchClaudeUsage(
        {
          accessToken: 'old-access-token',
          refreshToken: 'old-refresh-token',
          expiresAt: Date.now() - 1_000,
          accountId: 'acct-500'
        },
        { caller: 'usage:fetchForAccount', accountId: 'acct-500' }
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('Usage API returned 500')
      expect(result.rotated).toMatchObject({
        accessToken: 'proactive-new-access',
        refreshToken: 'proactive-new-refresh',
        rotatedFrom: 'old-refresh-token'
      })
    })

    it('carries rotated (with rotatedFrom) when the usage request throws (e.g. network error/timeout)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            { access_token: 'proactive-new-access', refresh_token: 'proactive-new-refresh', expires_in: 3600 },
            { status: 200 }
          )
        )
        .mockRejectedValueOnce(new Error('network down'))
      vi.stubGlobal('fetch', fetchMock)

      const result = await fetchClaudeUsage(
        {
          accessToken: 'old-access-token',
          refreshToken: 'old-refresh-token',
          expiresAt: Date.now() - 1_000,
          accountId: 'acct-network-error'
        },
        { caller: 'usage:fetchForAccount', accountId: 'acct-network-error' }
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('network down')
      expect(result.rotated).toMatchObject({
        accessToken: 'proactive-new-access',
        refreshToken: 'proactive-new-refresh',
        rotatedFrom: 'old-refresh-token'
      })
    })

    it('still surfaces the earlier proactive rotation when the reactive 401-retry refresh itself needs login', async () => {
      const fetchMock = vi
        .fn()
        // Proactive refresh (expiresAt already elapsed) succeeds.
        .mockResolvedValueOnce(
          jsonResponse(
            { access_token: 'proactive-new-access', refresh_token: 'proactive-new-refresh', expires_in: 3600 },
            { status: 200 }
          )
        )
        // Usage request with the freshly rotated token still comes back 401.
        .mockResolvedValueOnce(jsonResponse({ error: 'expired' }, { status: 401, statusText: 'Unauthorized' }))
        // The reactive retry refresh is rejected outright (invalid_grant).
        .mockResolvedValueOnce(
          jsonResponse({ error: 'invalid_grant' }, { status: 400, statusText: 'Bad Request' })
        )
      vi.stubGlobal('fetch', fetchMock)

      const result = await fetchClaudeUsage(
        {
          accessToken: 'old-access-token',
          refreshToken: 'old-refresh-token',
          expiresAt: Date.now() - 1_000,
          accountId: 'acct-double-refresh'
        },
        { caller: 'usage:fetchForAccount', accountId: 'acct-double-refresh' }
      )

      expect(result.success).toBe(false)
      expect(result.needsLogin).toBe(true)
      // The rotated tokens from the FIRST (proactive) refresh must still be
      // surfaced so the caller persists them — otherwise the live store is
      // left holding the now-burned `old-refresh-token`.
      expect(result.rotated).toMatchObject({
        accessToken: 'proactive-new-access',
        refreshToken: 'proactive-new-refresh',
        rotatedFrom: 'old-refresh-token'
      })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
  })

  it('sets needsLogin and a Token refresh failed: invalid_grant error when the refresh itself needs login', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, { status: 400, statusText: 'Bad Request' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchClaudeUsage(
      {
        accessToken: 'expired-access-token',
        refreshToken: 'dead-refresh-token',
        expiresAt: Date.now() - 1_000,
        accountId: 'acct-needs-login'
      },
      { caller: 'usage:fetchForAccount', accountId: 'acct-needs-login' }
    )

    expect(result.success).toBe(false)
    expect(result.needsLogin).toBe(true)
    expect(result.error).toContain('Token refresh failed: invalid_grant')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not go back to the network for an account whose sign-in session already ended', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        { error: 'invalid_grant', error_description: 'Refresh token expired' },
        { status: 400, statusText: 'Bad Request' }
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    const signedOut = {
      accessToken: 'expired-access-token',
      refreshToken: 'ended-session-refresh-token',
      expiresAt: Date.now() - 1_000,
      accountId: 'acct-ended'
    }

    const first = await fetchClaudeUsage(signedOut, { caller: 'refreshAllForProvider' })
    const second = await fetchClaudeUsage(signedOut, { caller: 'refreshAllForProvider' })

    expect(first.needsLogin).toBe(true)
    expect(second.needsLogin).toBe(true)
    expect(second.error).toBe(first.error)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  describe('scoped (model-specific) usage limits', () => {
    it('parses limits[] into data.scoped, dropping entries without scope.model.display_name', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse(
          {
            ...usageData(),
            limits: [
              {
                percent: 42,
                resets_at: '2026-06-01T00:00:00.000Z',
                scope: { model: { display_name: 'Fable' } }
              },
              { percent: 10, resets_at: null, scope: { model: {} } },
              { percent: 5, scope: {} },
              { percent: 1 }
            ]
          },
          { status: 200 }
        )
      )
      vi.stubGlobal('fetch', fetchMock)

      const result = await fetchClaudeUsage(
        { accessToken: 'tok', accountId: 'acct-scoped' },
        { caller: 'usage:fetchForAccount', accountId: 'acct-scoped' }
      )

      expect(result.success).toBe(true)
      expect(result.data?.scoped).toEqual([
        { label: 'Fable', used_percent: 42, resets_at: '2026-06-01T00:00:00.000Z' }
      ])
    })

    it('defaults used_percent to 0 and resets_at to null when the entry omits them', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse(
          { ...usageData(), limits: [{ scope: { model: { display_name: 'Opus' } } }] },
          { status: 200 }
        )
      )
      vi.stubGlobal('fetch', fetchMock)

      const result = await fetchClaudeUsage(
        { accessToken: 'tok', accountId: 'acct-scoped-defaults' },
        { caller: 'usage:fetchForAccount', accountId: 'acct-scoped-defaults' }
      )

      expect(result.data?.scoped).toEqual([{ label: 'Opus', used_percent: 0, resets_at: null }])
    })

    it('omits data.scoped entirely when limits has no usable entries', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ ...usageData(), limits: [{ percent: 5 }] }, { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      const result = await fetchClaudeUsage(
        { accessToken: 'tok', accountId: 'acct-scoped-empty' },
        { caller: 'usage:fetchForAccount', accountId: 'acct-scoped-empty' }
      )

      expect(result.success).toBe(true)
      expect(result.data?.scoped).toBeUndefined()
    })

    it('omits data.scoped when limits is absent from the response entirely', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(usageData(), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      const result = await fetchClaudeUsage(
        { accessToken: 'tok', accountId: 'acct-scoped-absent' },
        { caller: 'usage:fetchForAccount', accountId: 'acct-scoped-absent' }
      )

      expect(result.success).toBe(true)
      expect(result.data?.scoped).toBeUndefined()
    })
  })

  describe('response normalization', () => {
    async function fetchWithBody(body: unknown) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(body, { status: 200 })))
      return fetchClaudeUsage(
        { accessToken: 'tok', accountId: 'acct-shape' },
        { caller: 'usage:fetchForAccount', accountId: 'acct-shape' }
      )
    }

    it('maps a plan without a 5-hour window: five_hour null, nothing else carried over', async () => {
      const result = await fetchWithBody(NO_FIVE_HOUR_RESPONSE)

      expect(result.success).toBe(true)
      // `toEqual` on the whole object: none of the dozens of null keys,
      // `spend`, `pace` or `seven_day_breakdown` may leak into the cache row.
      expect(result.data).toEqual({
        five_hour: null,
        seven_day: { utilization: 6, resets_at: '2026-11-06T15:00:00.066253+00:00' },
        extra_usage: { is_enabled: false, utilization: 0, used_credits: 0, monthly_limit: 0 },
        scoped: [
          { label: 'Fable', used_percent: 10, resets_at: '2026-11-06T15:00:00.066382+00:00' }
        ]
      })
    })

    it('still maps the legacy shape (both windows as objects, credits in cents) and drops stray keys', async () => {
      const result = await fetchWithBody({
        ...usageData(12),
        extra_usage: {
          is_enabled: true,
          utilization: 25,
          used_credits: 150,
          monthly_limit: 5000,
          currency: 'USD'
        },
        seven_day_opus: null,
        spend: { used: { amount_minor: 0 } },
        pace: null
      })

      expect(result.success).toBe(true)
      expect(result.data).toEqual({
        five_hour: { utilization: 12, resets_at: '2026-05-19T12:00:00.000Z' },
        seven_day: { utilization: 13, resets_at: '2026-05-20T12:00:00.000Z' },
        extra_usage: { is_enabled: true, utilization: 25, used_credits: 1.5, monthly_limit: 50 }
      })
    })

    it('accepts a null weekly window alongside a 5-hour one', async () => {
      const result = await fetchWithBody({
        five_hour: { utilization: 40, resets_at: '2026-11-01T17:00:00.000Z' },
        seven_day: null
      })

      expect(result.success).toBe(true)
      expect(result.data).toEqual({
        five_hour: { utilization: 40, resets_at: '2026-11-01T17:00:00.000Z' },
        seven_day: null
      })
    })

    it('falls back to limits[] rows by kind when the top-level windows are absent', async () => {
      const result = await fetchWithBody({
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 40,
            resets_at: '2026-11-01T17:00:00.000Z',
            scope: null
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 7,
            resets_at: '2026-11-06T15:00:00.000Z',
            scope: null
          },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 10,
            resets_at: null,
            scope: { model: { id: null, display_name: 'Fable' }, surface: null }
          }
        ]
      })

      expect(result.success).toBe(true)
      expect(result.data).toEqual({
        five_hour: { utilization: 40, resets_at: '2026-11-01T17:00:00.000Z' },
        seven_day: { utilization: 7, resets_at: '2026-11-06T15:00:00.000Z' },
        scoped: [{ label: 'Fable', used_percent: 10, resets_at: null }]
      })
    })

    it('takes a null top-level window at its word and never reads a session row as scoped', async () => {
      // `five_hour: null` is the plan's statement; a stray `session` row must
      // neither resurrect the window nor pass for a model bucket.
      const result = await fetchWithBody({
        five_hour: null,
        seven_day: null,
        limits: [
          { kind: 'session', percent: 40, scope: { model: { display_name: 'Not a bucket' } } }
        ]
      })

      expect(result.success).toBe(true)
      expect(result.data).toEqual({ five_hour: null, seven_day: null })
    })

    it('treats a 200 whose body is not usage as a failed fetch', async () => {
      const result = await fetchWithBody({
        error: { type: 'authentication_error', message: 'nope' }
      })

      expect(result.success).toBe(false)
      expect(result.data).toBeUndefined()
      expect(result.error).toBe('Usage API returned an unexpected body')
    })
  })
})
