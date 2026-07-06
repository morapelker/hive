import { randomBytes, createHash } from 'crypto'

export interface Pkce {
  verifier: string
  challenge: string
  state: string
}

/**
 * Generate an OAuth PKCE (RFC 7636, S256) verifier/challenge pair plus a
 * random `state` value, all base64url-encoded (no padding, `-`/`_` alphabet).
 */
export function generatePkce(): Pkce {
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(32).toString('base64url')
  return { verifier, challenge, state }
}
