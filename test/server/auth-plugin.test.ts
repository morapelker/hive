import { describe, it, expect } from 'vitest'
import {
  extractBearerToken,
  hashApiKey,
  generateApiKey,
  verifyApiKey
} from '../../src/server/plugins/auth'

describe('extractBearerToken', () => {
  it('extracts token from valid Bearer header', () => {
    expect(extractBearerToken('Bearer hive_abc123')).toBe('hive_abc123')
  })

  it('returns null for missing header', () => {
    expect(extractBearerToken(undefined)).toBeNull()
    expect(extractBearerToken(null as unknown as string)).toBeNull()
  })

  it('returns null for non-Bearer scheme', () => {
    expect(extractBearerToken('Basic abc123')).toBeNull()
  })

  it('returns null for Bearer with empty token', () => {
    expect(extractBearerToken('Bearer ')).toBeNull()
    expect(extractBearerToken('Bearer')).toBeNull()
  })
})

describe('auth verification flow', () => {
  it('valid key verifies against stored hash', () => {
    const key = generateApiKey()
    const hash = hashApiKey(key)
    expect(verifyApiKey(key, hash)).toBe(true)
  })

  it('invalid key does not verify', () => {
    const key = generateApiKey()
    const hash = hashApiKey(key)
    const wrongKey = generateApiKey()
    expect(verifyApiKey(wrongKey, hash)).toBe(false)
  })
})
