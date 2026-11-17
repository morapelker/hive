// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// What the two requests that can teach an account's organization hand back, on simulated
// responses: the usage poll (a response header) and the profile request (the body).

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp'
  }
}))

const logMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))
vi.mock('../../src/main/services/logger', () => ({ createLogger: () => logMocks }))

import {
  fetchClaudeProfileOrganization,
  fetchClaudeUsage
} from '../../src/main/services/usage-service'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const ORG = 'f43590b8-1111-4222-8333-444455556666'

const usageBody = {
  five_hour: { utilization: 12, resets_at: '2026-05-19T12:00:00.000Z' },
  seven_day: { utilization: 34, resets_at: '2026-05-20T12:00:00.000Z' }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

function stubFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const fetchMock =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchClaudeUsage: the organization on the poll response', () => {
  const poll = () => fetchClaudeUsage({ accessToken: 'oauth-token' }, { caller: 'usage:fetch' })

  it('returns the organization a successful response names, next to the unchanged usage', async () => {
    stubFetch(json(usageBody, 200, { 'anthropic-organization-id': ORG }))

    const result = await poll()

    expect(result.success).toBe(true)
    expect(result.organizationUuid).toBe(ORG)
    expect(result.data?.five_hour?.utilization).toBe(12)
    expect(result.data?.seven_day?.utilization).toBe(34)
  })

  it('stores the form the database compares: trimmed and lower-cased', async () => {
    stubFetch(json(usageBody, 200, { 'anthropic-organization-id': `  ${ORG.toUpperCase()} ` }))

    expect((await poll()).organizationUuid).toBe(ORG)
  })

  it('returns exactly what it returned before when the response has no such header', async () => {
    stubFetch(json(usageBody))

    const result = await poll()

    expect(Object.keys(result).sort()).toEqual(['data', 'success'])
    expect(result).not.toHaveProperty('organizationUuid')
  })

  it('ignores a header value that does not look like an id', async () => {
    stubFetch(json(usageBody, 200, { 'anthropic-organization-id': 'not an id; drop table' }))

    const result = await poll()

    expect(result.success).toBe(true)
    expect(result).not.toHaveProperty('organizationUuid')
  })

  it('takes no organization from a rate-limited response, and reports the 429 as before', async () => {
    stubFetch(
      json({ error: 'rate_limited' }, 429, {
        'anthropic-organization-id': ORG,
        'retry-after': '120'
      })
    )

    const result = await poll()

    expect(result).toEqual({
      success: false,
      error: 'Usage API returned 429: ',
      retryAfter: 120
    })
  })

  it('takes no organization from a rejected credential, and reports needsLogin as before', async () => {
    stubFetch(json({ error: 'unauthorized' }, 401, { 'anthropic-organization-id': ORG }))

    const result = await poll()

    expect(result).toEqual({
      success: false,
      error: 'Usage API returned 401: ',
      needsLogin: true
    })
  })

  it('does not write the organization to the log', async () => {
    stubFetch(json(usageBody, 200, { 'anthropic-organization-id': ORG }))

    await poll()

    const logged = JSON.stringify([
      logMocks.debug.mock.calls,
      logMocks.info.mock.calls,
      logMocks.warn.mock.calls
    ])
    expect(logged).not.toContain(ORG)
  })
})

describe('fetchClaudeProfileOrganization', () => {
  const profileBody = {
    account: { uuid: 'acct-1', email: 'me@example.com', full_name: 'Me Example' },
    organization: { uuid: ORG, name: 'Example Org', organization_type: 'claude_max' }
  }

  it('asks for the profile with the account token, as the Claude Code client', async () => {
    const fetchMock = stubFetch(json(profileBody))

    await fetchClaudeProfileOrganization('oauth-token')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      PROFILE_URL,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-token',
          'User-Agent': 'claude-code/2.1.5',
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        })
      })
    )
    // It is not the usage poll: that endpoint's clock and rate limit are left alone.
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(USAGE_URL)
  })

  it('returns the organization in the body, normalised', async () => {
    stubFetch(json({ ...profileBody, organization: { uuid: ORG.toUpperCase() } }))

    expect(await fetchClaudeProfileOrganization('oauth-token')).toEqual({
      ok: true,
      organizationUuid: ORG
    })
  })

  it.each([
    ['no organization object', { account: profileBody.account }],
    ['an organization without a uuid', { organization: { name: 'Example Org' } }],
    ['a uuid that is not a string', { organization: { uuid: 42 } }],
    ['a uuid that is not an id', { organization: { uuid: 'two words' } }],
    ['a body that is null', null]
  ])('reports "missing" for a 200 with %s', async (_name, body) => {
    stubFetch(json(body))

    expect(await fetchClaudeProfileOrganization('oauth-token')).toEqual({
      ok: false,
      reason: 'missing',
      status: 200
    })
  })

  it.each([401, 403])('reports a %i as a rejected credential', async (status) => {
    stubFetch(json({ error: 'nope' }, status))

    expect(await fetchClaudeProfileOrganization('oauth-token')).toEqual({
      ok: false,
      reason: 'rejected',
      status
    })
  })

  it('reports a 429 with the wait the server asked for', async () => {
    stubFetch(json({ error: 'rate_limited' }, 429, { 'retry-after': '300' }))

    expect(await fetchClaudeProfileOrganization('oauth-token')).toEqual({
      ok: false,
      reason: 'rate-limited',
      status: 429,
      retryAfter: 300
    })
  })

  it('reports a 429 without retry-after', async () => {
    stubFetch(json({ error: 'rate_limited' }, 429))

    expect(await fetchClaudeProfileOrganization('oauth-token')).toEqual({
      ok: false,
      reason: 'rate-limited',
      status: 429
    })
  })

  it('reports a server error, a network error and a body that is not JSON as failures, without throwing', async () => {
    stubFetch(json({ error: 'boom' }, 503))
    expect(await fetchClaudeProfileOrganization('oauth-token')).toEqual({
      ok: false,
      reason: 'failed',
      status: 503
    })

    stubFetch(new Error('getaddrinfo ENOTFOUND api.anthropic.com'))
    expect(await fetchClaudeProfileOrganization('oauth-token')).toEqual({
      ok: false,
      reason: 'failed'
    })

    stubFetch(new Response('<html>gateway</html>', { status: 200 }))
    expect(await fetchClaudeProfileOrganization('oauth-token')).toEqual({
      ok: false,
      reason: 'failed'
    })
  })

  it('logs nothing: the body holds the email and the name', async () => {
    stubFetch(json(profileBody))
    await fetchClaudeProfileOrganization('oauth-token')
    stubFetch(json({ error: 'nope', email: 'me@example.com' }, 401))
    await fetchClaudeProfileOrganization('oauth-token')

    for (const level of [logMocks.debug, logMocks.info, logMocks.warn, logMocks.error]) {
      expect(level).not.toHaveBeenCalled()
    }
  })
})
