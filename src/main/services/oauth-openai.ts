/**
 * OpenAI (Codex) OAuth: authorize-URL construction, refresh-token rotation,
 * and authorization-code exchange. Port of ccswitch's
 * `src/providers/openai.rs` OAuth surface (usage fetching stays in
 * openai-usage-service.ts).
 */
import type { Pkce } from './oauth-pkce'

export const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const OPENAI_REDIRECT_URI = 'http://localhost:1455/auth/callback'
export const OPENAI_SCOPE = 'openid profile email offline_access'
const OPENAI_ORIGINATOR = 'codex_cli_rs'

const REQUEST_TIMEOUT_MS = 10_000
const BODY_SNIPPET_LENGTH = 500

export function buildOpenAIAuthorizeUrl(pkce: Pkce): string {
  const url = new URL(OPENAI_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', OPENAI_CLIENT_ID)
  url.searchParams.set('redirect_uri', OPENAI_REDIRECT_URI)
  url.searchParams.set('scope', OPENAI_SCOPE)
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('state', pkce.state)
  url.searchParams.set('originator', OPENAI_ORIGINATOR)
  return url.toString()
}

export type OpenAIRefreshOutcome =
  | { ok: true; result: { accessToken: string; refreshToken?: string; idToken?: string } }
  | { ok: false; needsLogin: true; error: string }

async function readCappedBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1024)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Failed to read response body: ${message}`
  }
}

/**
 * Refresh an OpenAI (Codex) OAuth access token. The refresh/id tokens only
 * rotate when the response includes them — callers should fall back to
 * whatever they already have on hand for the fields left `undefined` here.
 * Returns a `needsLogin` outcome for 401/400 responses or a body containing
 * `invalid_grant`; throws on any other failure (network error or other
 * non-2xx status).
 */
export async function refreshOpenAIToken(refreshToken: string): Promise<OpenAIRefreshOutcome> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: OPENAI_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }),
      signal: controller.signal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('OpenAI token refresh timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  const body = await readCappedBody(response)

  if (response.status === 401 || response.status === 400 || body.includes('invalid_grant')) {
    return {
      ok: false,
      needsLogin: true,
      error: `OpenAI refresh needs login (${response.status}): ${body.slice(0, BODY_SNIPPET_LENGTH)}`
    }
  }

  if (!response.ok) {
    throw new Error(`OpenAI token refresh returned ${response.status}: ${body.slice(0, BODY_SNIPPET_LENGTH)}`)
  }

  const data = JSON.parse(body) as {
    id_token?: unknown
    access_token?: unknown
    refresh_token?: unknown
  }

  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('OpenAI token refresh: missing access_token in response')
  }

  return {
    ok: true,
    result: {
      accessToken: data.access_token,
      refreshToken:
        typeof data.refresh_token === 'string' && data.refresh_token.length > 0 ? data.refresh_token : undefined,
      idToken: typeof data.id_token === 'string' && data.id_token.length > 0 ? data.id_token : undefined
    }
  }
}

/** Exchange an authorization code (from the interactive login flow) for tokens. */
export async function exchangeOpenAICode(
  code: string,
  pkce: Pkce
): Promise<{ idToken: string; accessToken: string; refreshToken: string }> {
  const form = new URLSearchParams()
  form.set('grant_type', 'authorization_code')
  form.set('code', code)
  form.set('redirect_uri', OPENAI_REDIRECT_URI)
  form.set('client_id', OPENAI_CLIENT_ID)
  form.set('code_verifier', pkce.verifier)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: controller.signal
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('OpenAI token exchange timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  const body = await readCappedBody(response)
  if (!response.ok) {
    throw new Error(`OpenAI token exchange returned ${response.status}: ${body.slice(0, BODY_SNIPPET_LENGTH)}`)
  }

  const data = JSON.parse(body) as {
    id_token?: unknown
    access_token?: unknown
    refresh_token?: unknown
  }

  if (typeof data.id_token !== 'string' || data.id_token.length === 0) {
    throw new Error('OpenAI token exchange: missing id_token in response')
  }
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('OpenAI token exchange: missing access_token in response')
  }
  if (typeof data.refresh_token !== 'string' || data.refresh_token.length === 0) {
    throw new Error('OpenAI token exchange: missing refresh_token in response')
  }

  return { idToken: data.id_token, accessToken: data.access_token, refreshToken: data.refresh_token }
}
