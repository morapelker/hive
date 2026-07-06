/**
 * Anthropic (Claude Code) OAuth: authorize-URL construction, refresh-token
 * rotation, and authorization-code exchange. Port of ccswitch's
 * `src/providers/anthropic.rs` OAuth surface (usage fetching stays in
 * usage-service.ts).
 */
import type { Pkce } from './oauth-pkce'

export const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
export const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const ANTHROPIC_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
export const ANTHROPIC_SCOPE = 'org:create_api_key user:profile user:inference'

const REQUEST_TIMEOUT_MS = 10_000
const BODY_SNIPPET_LENGTH = 500

export function buildAnthropicAuthorizeUrl(pkce: Pkce): string {
  const url = new URL(ANTHROPIC_AUTHORIZE_URL)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', ANTHROPIC_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', ANTHROPIC_REDIRECT_URI)
  url.searchParams.set('scope', ANTHROPIC_SCOPE)
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', pkce.state)
  return url.toString()
}

export type AnthropicRefreshOutcome =
  | { ok: true; result: { accessToken: string; refreshToken: string; expiresAt: number }; scope?: string }
  | { ok: false; needsLogin: true; error: string }

async function readCappedBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1024)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Failed to read response body: ${message}`
  }
}

async function postJson(body: unknown): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(ANTHROPIC_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Anthropic token request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Refresh an Anthropic OAuth access token. Rotates the refresh token
 * (falling back to the input token when the response omits one). Returns a
 * `needsLogin` outcome for 401/400 responses or a body containing
 * `invalid_grant`; throws on any other failure (network error or other
 * non-2xx status).
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<AnthropicRefreshOutcome> {
  const response = await postJson({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: ANTHROPIC_CLIENT_ID
  })
  const body = await readCappedBody(response)

  if (response.status === 401 || response.status === 400 || body.includes('invalid_grant')) {
    return {
      ok: false,
      needsLogin: true,
      error: `Anthropic refresh needs login (${response.status}): ${body.slice(0, BODY_SNIPPET_LENGTH)}`
    }
  }

  if (!response.ok) {
    throw new Error(`Anthropic token refresh returned ${response.status}: ${body.slice(0, BODY_SNIPPET_LENGTH)}`)
  }

  const data = JSON.parse(body) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
    scope?: unknown
  }

  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('Anthropic token refresh: missing access_token in response')
  }
  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in)) {
    throw new Error('Anthropic token refresh: missing expires_in in response')
  }

  const rotatedRefreshToken =
    typeof data.refresh_token === 'string' && data.refresh_token.length > 0 ? data.refresh_token : refreshToken

  return {
    ok: true,
    result: {
      accessToken: data.access_token,
      refreshToken: rotatedRefreshToken,
      expiresAt: Date.now() + data.expires_in * 1000
    },
    scope: typeof data.scope === 'string' ? data.scope : undefined
  }
}

export interface AnthropicTokenExchange {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope?: string
  account?: { uuid?: string; emailAddress?: string }
}

/** Exchange an authorization code (from the interactive login flow) for tokens. */
export async function exchangeAnthropicCode(
  code: string,
  state: string,
  pkce: Pkce
): Promise<AnthropicTokenExchange> {
  const response = await postJson({
    grant_type: 'authorization_code',
    code,
    state,
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    client_id: ANTHROPIC_CLIENT_ID,
    code_verifier: pkce.verifier
  })
  const body = await readCappedBody(response)

  if (!response.ok) {
    throw new Error(`Anthropic token exchange returned ${response.status}: ${body.slice(0, BODY_SNIPPET_LENGTH)}`)
  }

  const data = JSON.parse(body) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
    scope?: unknown
    account?: { uuid?: unknown; email_address?: unknown }
  }

  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('Anthropic token exchange: missing access_token in response')
  }
  if (typeof data.refresh_token !== 'string' || data.refresh_token.length === 0) {
    throw new Error('Anthropic token exchange: missing refresh_token in response')
  }
  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in)) {
    throw new Error('Anthropic token exchange: missing expires_in in response')
  }

  const account =
    data.account && typeof data.account === 'object'
      ? {
          uuid: typeof data.account.uuid === 'string' ? data.account.uuid : undefined,
          emailAddress:
            typeof data.account.email_address === 'string' ? data.account.email_address : undefined
        }
      : undefined

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
    account
  }
}
