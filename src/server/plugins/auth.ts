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
