import { describe, it, expect } from 'vitest'
import { generateApiKey, hashApiKey, verifyApiKey } from '../../src/server/plugins/auth'

describe('generateApiKey', () => {
  it('returns a string starting with hive_', () => {
    const key = generateApiKey()
    expect(key.startsWith('hive_')).toBe(true)
  })

  it('returns different keys each call', () => {
    const key1 = generateApiKey()
    const key2 = generateApiKey()
    expect(key1).not.toBe(key2)
  })

  it('returns a key longer than 40 characters', () => {
    const key = generateApiKey()
    expect(key.length).toBeGreaterThan(40)
  })
})

describe('hashApiKey', () => {
  it('returns consistent hash for same input', () => {
    const key = 'hive_test123'
    expect(hashApiKey(key)).toBe(hashApiKey(key))
  })

  it('returns 64 hex characters (SHA-256)', () => {
    const hash = hashApiKey('hive_test123')
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns different hashes for different inputs', () => {
    expect(hashApiKey('hive_key1')).not.toBe(hashApiKey('hive_key2'))
  })
})

describe('verifyApiKey', () => {
  it('returns true for correct key', () => {
    const key = generateApiKey()
    const hash = hashApiKey(key)
    expect(verifyApiKey(key, hash)).toBe(true)
  })

  it('returns false for wrong key', () => {
    const key = generateApiKey()
    const hash = hashApiKey(key)
    expect(verifyApiKey('hive_wrong_key', hash)).toBe(false)
  })

  it('returns false for empty key', () => {
    const hash = hashApiKey('hive_test')
    expect(verifyApiKey('', hash)).toBe(false)
  })

  it('returns false for hash length mismatch', () => {
    const key = generateApiKey()
    expect(verifyApiKey(key, 'short')).toBe(false)
  })
})
