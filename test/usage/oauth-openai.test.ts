// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  OPENAI_AUTHORIZE_URL,
  OPENAI_CLIENT_ID,
  OPENAI_REDIRECT_URI,
  OPENAI_SCOPE,
  OPENAI_TOKEN_URL,
  buildOpenAIAuthorizeUrl,
  exchangeOpenAICode,
  refreshOpenAIToken
} from '../../src/main/services/oauth-openai'
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

describe('buildOpenAIAuthorizeUrl', () => {
  it('builds the authorize URL with exactly the expected query params', () => {
    const url = new URL(buildOpenAIAuthorizeUrl(pkce()))

    expect(url.origin + url.pathname).toBe(OPENAI_AUTHORIZE_URL)
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      response_type: 'code',
      client_id: OPENAI_CLIENT_ID,
      redirect_uri: OPENAI_REDIRECT_URI,
      scope: OPENAI_SCOPE,
      code_challenge: 'test-challenge',
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state: 'test-state',
      originator: 'codex_cli_rs'
    })
  })
})

describe('refreshOpenAIToken', () => {
  it('returns needsLogin on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'unauthorized' }, { status: 401 })))

    const outcome = await refreshOpenAIToken('refresh-1')
    expect(outcome).toMatchObject({ ok: false, needsLogin: true })
  })

  it('returns needsLogin on 400', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'bad request' }, { status: 400 })))

    const outcome = await refreshOpenAIToken('refresh-1')
    expect(outcome).toMatchObject({ ok: false, needsLogin: true })
  })

  it('throws on a 500 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse('internal error', { status: 500 })))

    await expect(refreshOpenAIToken('refresh-1')).rejects.toThrow(/500/)
  })

  it('propagates a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))

    await expect(refreshOpenAIToken('refresh-1')).rejects.toThrow('ECONNRESET')
  })

  it('maps a success response and rotates refresh/id tokens when present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new-id' },
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await refreshOpenAIToken('old-refresh')
    expect(outcome).toEqual({
      ok: true,
      result: { accessToken: 'new-access', refreshToken: 'new-refresh', idToken: 'new-id' }
    })
    expect(fetchMock).toHaveBeenCalledWith(
      OPENAI_TOKEN_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          client_id: OPENAI_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: 'old-refresh'
        })
      })
    )
  })

  it('omits refreshToken/idToken from the result when the response does not include them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ access_token: 'new-access' }, { status: 200 })))

    const outcome = await refreshOpenAIToken('old-refresh')
    expect(outcome).toEqual({ ok: true, result: { accessToken: 'new-access', refreshToken: undefined, idToken: undefined } })
  })
})

describe('exchangeOpenAICode', () => {
  it('POSTs a form-urlencoded (not JSON) body with the expected fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { id_token: 'id-1', access_token: 'access-1', refresh_token: 'refresh-1' },
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await exchangeOpenAICode('the-code', pkce())

    expect(fetchMock).toHaveBeenCalledWith(
      OPENAI_TOKEN_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' })
      })
    )
    const [, init] = fetchMock.mock.calls[0]
    expect(typeof init.body).toBe('string')
    const parsedBody = new URLSearchParams(init.body as string)
    expect(Object.fromEntries(parsedBody.entries())).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: OPENAI_REDIRECT_URI,
      client_id: OPENAI_CLIENT_ID,
      code_verifier: 'test-verifier'
    })

    expect(result).toEqual({ idToken: 'id-1', accessToken: 'access-1', refreshToken: 'refresh-1' })
  })

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse('nope', { status: 400 })))

    await expect(exchangeOpenAICode('code', pkce())).rejects.toThrow(/400/)
  })
})
