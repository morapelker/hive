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

interface BruteForceEntry {
  attempts: number
  firstAttempt: number
  blockedUntil: number
}

interface BruteForceOpts {
  maxAttempts: number
  windowMs: number
  blockMs: number
}

export class BruteForceTracker {
  private map = new Map<string, BruteForceEntry>()
  private opts: BruteForceOpts

  constructor(opts: BruteForceOpts) {
    this.opts = opts
  }

  get size(): number {
    return this.map.size
  }

  recordFailure(ip: string): void {
    const now = Date.now()
    const entry = this.map.get(ip)

    if (!entry || now - entry.firstAttempt > this.opts.windowMs) {
      this.map.set(ip, { attempts: 1, firstAttempt: now, blockedUntil: 0 })
      return
    }

    entry.attempts++
    if (entry.attempts >= this.opts.maxAttempts) {
      entry.blockedUntil = now + this.opts.blockMs
    }
  }

  recordSuccess(ip: string): void {
    this.map.delete(ip)
  }

  isBlocked(ip: string): boolean {
    const entry = this.map.get(ip)
    if (!entry) return false
    if (entry.blockedUntil === 0) return false
    if (Date.now() > entry.blockedUntil) {
      this.map.delete(ip)
      return false
    }
    return true
  }

  cleanup(): void {
    const now = Date.now()
    for (const [ip, entry] of this.map) {
      const expiry = entry.blockedUntil > 0
        ? entry.blockedUntil
        : entry.firstAttempt + this.opts.windowMs
      if (now > expiry) {
        this.map.delete(ip)
      }
    }
  }
}
