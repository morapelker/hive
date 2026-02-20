import crypto from 'node:crypto'

export function generateApiKey(): string {
  return 'hive_' + crypto.randomBytes(32).toString('base64url')
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

export function verifyApiKey(key: string, storedHash: string): boolean {
  const keyHash = hashApiKey(key)
  const keyBuf = Buffer.from(keyHash, 'hex')
  const storedBuf = Buffer.from(storedHash, 'hex')
  if (keyBuf.length !== storedBuf.length) return false
  return crypto.timingSafeEqual(keyBuf, storedBuf)
}

export function extractBearerToken(header: string | undefined | null): string | null {
  if (!header || typeof header !== 'string') return null
  const parts = header.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null
  const token = parts[1]
  if (!token || token.trim() === '') return null
  return token
}
