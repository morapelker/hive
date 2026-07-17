/**
 * Shared JWT helpers. Decodes the payload segment only — there is no
 * signature verification, so these must never be used to authorize anything;
 * they exist purely to read claims out of tokens we already trust (because we
 * obtained them ourselves via OAuth or read them from local credential
 * storage).
 */

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'

/**
 * Decode the payload (middle segment) of a JWT. Returns null on any failure
 * (malformed token, invalid base64, invalid JSON).
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf-8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Convert a JWT's `exp` claim (seconds since epoch) to milliseconds.
 * Returns null when the claim is absent, non-numeric, or the token can't be
 * decoded.
 */
export function jwtExpMs(token: string): number | null {
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
}

export interface CodexIdTokenClaims {
  email: string | null
  accountId: string | null
  userId: string | null
  plan: string | null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Extract the account/user/plan claims Codex (ChatGPT) puts under the
 * `https://api.openai.com/auth` custom claim of its id_token, plus the
 * top-level `email` claim. Every field is null-safe: a malformed token or
 * missing claim yields nulls rather than throwing.
 */
export function parseCodexIdToken(idToken: string): CodexIdTokenClaims {
  const payload = decodeJwtPayload(idToken)
  const email = asNonEmptyString(payload?.email)
  const auth = asRecord(payload?.[OPENAI_AUTH_CLAIM])

  let accountId = asNonEmptyString(auth?.chatgpt_account_id)
  if (!accountId) {
    const organizations = Array.isArray(auth?.organizations) ? auth.organizations : []
    const orgRecords = organizations
      .map((org) => asRecord(org))
      .filter((org): org is Record<string, unknown> => org !== null)
    const defaultOrg = orgRecords.find((org) => org.is_default === true)
    const fallbackOrg = defaultOrg ?? orgRecords[0]
    accountId = asNonEmptyString(fallbackOrg?.id)
  }

  const userId = asNonEmptyString(auth?.chatgpt_user_id) ?? asNonEmptyString(auth?.user_id)
  const plan = asNonEmptyString(auth?.chatgpt_plan_type)

  return { email, accountId, userId, plan }
}
