import { describe, expect, it } from 'vitest'
import {
  decryptSharePayload,
  encryptSharePayload,
  isShareAccountLink
} from '../account-share-service'
import { buildShareAccountLink } from '../../../shared/account-share-link'

describe('share payload crypto', () => {
  it('round-trips a payload', () => {
    const plaintext = JSON.stringify({ v: 1, provider: 'anthropic', email: 'a@b.com' })
    const { key, ciphertext } = encryptSharePayload(plaintext)
    expect(decryptSharePayload(key, ciphertext)).toBe(plaintext)
  })

  it('produces a different key and ciphertext every time', () => {
    const a = encryptSharePayload('same input')
    const b = encryptSharePayload('same input')
    expect(a.key).not.toBe(b.key)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('rejects a wrong key', () => {
    const { ciphertext } = encryptSharePayload('secret')
    const { key: otherKey } = encryptSharePayload('other')
    expect(() => decryptSharePayload(otherKey, ciphertext)).toThrow()
  })

  it('rejects tampered ciphertext', () => {
    const { key, ciphertext } = encryptSharePayload('secret')
    const raw = Buffer.from(ciphertext, 'base64')
    raw[raw.length - 1] ^= 0xff
    expect(() => decryptSharePayload(key, raw.toString('base64'))).toThrow()
  })

  it('rejects a malformed key', () => {
    const { ciphertext } = encryptSharePayload('secret')
    expect(() => decryptSharePayload('short', ciphertext)).toThrow(
      'Share link has an invalid encryption key'
    )
  })
})

describe('share account links', () => {
  it('builds a link that parses back with the same parameters', () => {
    const link = buildShareAccountLink({
      serverUrl: 'https://hive.example.com/',
      token: 'tok_123',
      key: 'a-b_c'
    })
    expect(isShareAccountLink(link)).toBe(true)
    const parsed = new URL(link)
    expect(parsed.searchParams.get('server')).toBe('https://hive.example.com')
    expect(parsed.searchParams.get('token')).toBe('tok_123')
    expect(parsed.searchParams.get('key')).toBe('a-b_c')
  })

  it('rejects non-share links', () => {
    expect(isShareAccountLink('https://example.com')).toBe(false)
    expect(isShareAccountLink('hive://something-else?token=x')).toBe(false)
    expect(isShareAccountLink('not a url')).toBe(false)
  })
})
