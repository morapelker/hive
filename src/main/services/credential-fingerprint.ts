/**
 * One-way fingerprints of API credentials, so code that must recognise WHICH
 * credential a request carried (to attribute it to an account) never has to
 * hold, compare, log or pass around the credential itself.
 */
import { createHash } from 'crypto'
import type { IncomingHttpHeaders } from 'http'

export function fingerprintSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/**
 * Fingerprint of the credential an API request authenticates with: the
 * `Authorization: Bearer <token>` token (OAuth / auth-token sessions), else the
 * `x-api-key`. Null when the request carries neither.
 */
export function fingerprintRequestCredential(headers: IncomingHttpHeaders): string | null {
  const authorization = headers.authorization
  if (typeof authorization === 'string' && authorization.trim() !== '') {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    const token = (bearer ? bearer[1] : authorization).trim()
    if (token !== '') return fingerprintSecret(token)
  }
  const apiKey = headers['x-api-key']
  const key = Array.isArray(apiKey) ? apiKey[0] : apiKey
  if (typeof key === 'string' && key.trim() !== '') return fingerprintSecret(key.trim())
  return null
}
