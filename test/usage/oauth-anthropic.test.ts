// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_AUTHORIZE_URL,
  ANTHROPIC_CLIENT_ID,
  ANTHROPIC_REDIRECT_URI,
  ANTHROPIC_SCOPE,
  ANTHROPIC_TOKEN_URL,
  buildAnthropicAuthorizeUrl,
  exchangeAnthropicCode,
  refreshAnthropicToken
} from '../../src/main/services/oauth-anthropic'
import type { Pkce } from '../../src/main/services/oauth-pkce'

function pkce(): Pkce {
  return { verifier: 'test-verifier', challenge: 'test-challenge', state: 'test-state' }
}

function textResponse(body: string, init: ResponseInit): Response {
  return new Response(body, init)
}

function jsonResponse(body: unknown, init: ResponseInit): Response {
  return textResponse(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init })
}

describe('buildAnthropicAuthorizeUrl', () => {
  it('builds the authorize URL with exactly the expected query params', () => {
    const url = new URL(buildAnthropicAuthorizeUrl(pkce()))

    expect(url.origin + url.pathname).toBe(ANTHROPIC_AUTHORIZE_URL)
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      code: 'true',
      client_id: ANTHROPIC_CLIENT_ID,
      response_type: 'code',
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      scope: ANTHROPIC_SCOPE,
      code_challenge: 'test-challenge',
      code_challenge_method: 'S256',
      state: 'test-state'
    })
  })
})

describe('refreshAnthropicToken', () => {
  it('returns needsLogin on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'unauthorized' }, { status: 401 }))
    )

    const outcome = await refreshAnthropicToken('refresh-1')
    expect(outcome).toMatchObject({ ok: false, needsLogin: true })
  })

  it('returns needsLogin on 400 (status-based, regardless of body content)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'bad request' }, { status: 400 }))
    )

    const outcome = await refreshAnthropicToken('refresh-1')
    expect(outcome).toMatchObject({ ok: false, needsLogin: true })
  })

  it('returns needsLogin when a non-4xx-classified body still contains invalid_grant', async () => {
    // A 400 response whose body literally contains 'invalid_grant' — exercises
    // the body-substring branch of the needsLogin rule directly.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(textResponse('{"error":"invalid_grant"}', { status: 400 }))
    )

    const outcome = await refreshAnthropicToken('refresh-1')
    expect(outcome).toMatchObject({ ok: false, needsLogin: true })
    expect((outcome as { error: string }).error).toContain('400')
  })

  it('throws on a 500 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(textResponse('internal error', { status: 500 }))
    )

    await expect(refreshAnthropicToken('refresh-1')).rejects.toThrow(/500/)
  })

  it('propagates a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))

    await expect(refreshAnthropicToken('refresh-1')).rejects.toThrow('ECONNRESET')
  })

  it('maps a success response, computing expiresAt from expires_in', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'a b' },
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const before = Date.now()
    const outcome = await refreshAnthropicToken('old-refresh')
    const after = Date.now()

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.accessToken).toBe('new-access')
    expect(outcome.result.refreshToken).toBe('new-refresh')
    expect(outcome.result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(outcome.result.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000)
    expect(outcome.scope).toBe('a b')

    expect(fetchMock).toHaveBeenCalledWith(
      ANTHROPIC_TOKEN_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'old-refresh',
          client_id: ANTHROPIC_CLIENT_ID
        })
      })
    )
  })

  it('falls back to the input refresh token when the response omits one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ access_token: 'new-access', expires_in: 60 }, { status: 200 }))
    )

    const outcome = await refreshAnthropicToken('kept-refresh-token')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.refreshToken).toBe('kept-refresh-token')
  })
})

describe('exchangeAnthropicCode', () => {
  it('POSTs a JSON body with code, state, redirect_uri, client_id, code_verifier', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          account: { uuid: 'uuid-1', email_address: 'person@example.com' }
        },
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await exchangeAnthropicCode('the-code', 'the-state', pkce())

    expect(fetchMock).toHaveBeenCalledWith(
      ANTHROPIC_TOKEN_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: 'the-code',
          state: 'the-state',
          redirect_uri: ANTHROPIC_REDIRECT_URI,
          client_id: ANTHROPIC_CLIENT_ID,
          code_verifier: 'test-verifier'
        })
      })
    )
    expect(result).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      account: { uuid: 'uuid-1', emailAddress: 'person@example.com' }
    })
  })

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse('nope', { status: 403 })))

    await expect(exchangeAnthropicCode('code', 'state', pkce())).rejects.toThrow(/403/)
  })
})
