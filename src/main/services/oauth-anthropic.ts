/**
 * Anthropic (Claude Code) OAuth: authorize-URL construction, refresh-token
 * rotation, and authorization-code exchange. Port of ccswitch's
 * `src/providers/anthropic.rs` OAuth surface (usage fetching stays in
 * usage-service.ts).
 */
import { fingerprintSecret } from './credential-fingerprint'
import type { Pkce } from './oauth-pkce'

export const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
export const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
/**
 * Anthropic's hosted "copy this code" callback page. The interactive login
 * flow (login-service.ts) passes its own loopback `http://localhost:<port>/callback`
 * redirect instead — the same shape Claude Code uses — so this only serves as
 * the default for callers that don't supply one.
 */
export const ANTHROPIC_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
export const ANTHROPIC_SCOPE = 'org:create_api_key user:profile user:inference'

const REQUEST_TIMEOUT_MS = 10_000
const BODY_SNIPPET_LENGTH = 500

/**
 * The token endpoint's verdicts that can never change for a given refresh
 * token: the sign-in session reached its end (sessions last about 30 days and
 * rotating the token does not extend them), or the token is not the session's
 * current one (rotated by another holder, or signed out).
 */
const TERMINAL_REJECTIONS = ['Refresh token expired', 'Refresh token not found or invalid']
/** Any other rejection (e.g. `account_on_hold`) may be lifted server-side. */
const REJECTED_RETRY_AFTER_MS = 10 * 60_000

type AnthropicRefreshRejection = { ok: false; needsLogin: true; error: string }

/**
 * Refresh tokens the token endpoint already rejected, by fingerprint (never
 * the token). Every usage sweep, watcher tick and live fetch funnels through
 * `refreshAnthropicToken`, so without this a signed-out account re-posts its
 * dead token on each of them — thousands of rejected requests a day once a
 * batch of accounts expires together. A new sign-in stores a new token, which
 * is simply not in here.
 */
const rejectedRefreshTokens = new Map<
  string,
  { outcome: AnthropicRefreshRejection; retryAt: number }
>()

/** Test-only: forget every remembered rejection. */
export function clearRejectedAnthropicRefreshTokensForTests(): void {
  rejectedRefreshTokens.clear()
}

/** `expires_in`-style seconds from now, as epoch ms; undefined when the field is absent. */
function expiresInToEpochMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Date.now() + value * 1000 : undefined
}

export function buildAnthropicAuthorizeUrl(
  pkce: Pkce,
  redirectUri: string = ANTHROPIC_REDIRECT_URI
): string {
  const url = new URL(ANTHROPIC_AUTHORIZE_URL)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', ANTHROPIC_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', ANTHROPIC_SCOPE)
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', pkce.state)
  return url.toString()
}

export type AnthropicRefreshOutcome =
  | {
      ok: true
      result: {
        accessToken: string
        refreshToken: string
        expiresAt: number
        /** When the sign-in session itself ends (`refresh_token_expires_in`), if the server said. */
        refreshTokenExpiresAt?: number
      }
      scope?: string
    }
  | AnthropicRefreshRejection

/**
 * Read the full response body. Do NOT cap this: successful token responses
 * carry JWTs that easily exceed a few KB, and truncating them before
 * `JSON.parse` fails the whole login with an "unexpected end of JSON" error.
 * Error messages slice to `BODY_SNIPPET_LENGTH` at the call sites instead.
 */
async function readBody(response: Response): Promise<string> {
  try {
    return await response.text()
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
 * non-2xx status). A token the endpoint already rejected is answered from
 * memory (see `rejectedRefreshTokens`) instead of being posted again.
 */
export async function refreshAnthropicToken(
  refreshToken: string
): Promise<AnthropicRefreshOutcome> {
  const fingerprint = fingerprintSecret(refreshToken)
  const rejected = rejectedRefreshTokens.get(fingerprint)
  if (rejected) {
    if (Date.now() < rejected.retryAt) return rejected.outcome
    rejectedRefreshTokens.delete(fingerprint)
  }

  const response = await postJson({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: ANTHROPIC_CLIENT_ID
  })
  const body = await readBody(response)

  if (response.status === 401 || response.status === 400 || body.includes('invalid_grant')) {
    const outcome: AnthropicRefreshRejection = {
      ok: false,
      needsLogin: true,
      error: `Anthropic refresh needs login (${response.status}): ${body.slice(0, BODY_SNIPPET_LENGTH)}`
    }
    const terminal = TERMINAL_REJECTIONS.some((description) => body.includes(description))
    rejectedRefreshTokens.set(fingerprint, {
      outcome,
      retryAt: terminal ? Number.POSITIVE_INFINITY : Date.now() + REJECTED_RETRY_AFTER_MS
    })
    return outcome
  }

  if (!response.ok) {
    throw new Error(
      `Anthropic token refresh returned ${response.status}: ${body.slice(0, BODY_SNIPPET_LENGTH)}`
    )
  }

  const data = JSON.parse(body) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
    refresh_token_expires_in?: unknown
    scope?: unknown
  }

  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('Anthropic token refresh: missing access_token in response')
  }
  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in)) {
    throw new Error('Anthropic token refresh: missing expires_in in response')
  }

  const rotatedRefreshToken =
    typeof data.refresh_token === 'string' && data.refresh_token.length > 0
      ? data.refresh_token
      : refreshToken

  const refreshTokenExpiresAt = expiresInToEpochMs(data.refresh_token_expires_in)

  return {
    ok: true,
    result: {
      accessToken: data.access_token,
      refreshToken: rotatedRefreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {})
    },
    scope: typeof data.scope === 'string' ? data.scope : undefined
  }
}

export interface AnthropicTokenExchange {
  accessToken: string
  refreshToken: string
  expiresAt: number
  /** When the sign-in session itself ends (`refresh_token_expires_in`), if the server said. */
  refreshTokenExpiresAt?: number
  scope?: string
  account?: { uuid?: string; emailAddress?: string }
}

/**
 * Exchange an authorization code (from the interactive login flow) for tokens.
 * `redirectUri` must be the exact value the authorize URL was built with.
 */
export async function exchangeAnthropicCode(
  code: string,
  state: string,
  pkce: Pkce,
  redirectUri: string = ANTHROPIC_REDIRECT_URI
): Promise<AnthropicTokenExchange> {
  const response = await postJson({
    grant_type: 'authorization_code',
    code,
    state,
    redirect_uri: redirectUri,
    client_id: ANTHROPIC_CLIENT_ID,
    code_verifier: pkce.verifier
  })
  const body = await readBody(response)

  if (!response.ok) {
    throw new Error(
      `Anthropic token exchange returned ${response.status}: ${body.slice(0, BODY_SNIPPET_LENGTH)}`
    )
  }

  const data = JSON.parse(body) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
    refresh_token_expires_in?: unknown
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

  const refreshTokenExpiresAt = expiresInToEpochMs(data.refresh_token_expires_in)

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
    scope: typeof data.scope === 'string' ? data.scope : undefined,
    account
  }
}
