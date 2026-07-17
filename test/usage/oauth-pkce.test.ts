// @vitest-environment node
import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { generatePkce } from '../../src/main/services/oauth-pkce'

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

describe('generatePkce', () => {
  it('produces a challenge equal to base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generatePkce()
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
  })

  it('produces a verifier and state using the base64url alphabet with no padding', () => {
    const { verifier, state } = generatePkce()

    expect(verifier).toMatch(BASE64URL_RE)
    expect(state).toMatch(BASE64URL_RE)
    expect(verifier).not.toContain('=')
    expect(verifier).not.toContain('+')
    expect(verifier).not.toContain('/')
    expect(state).not.toContain('=')
    expect(state).not.toContain('+')
    expect(state).not.toContain('/')
  })

  it('produces a verifier and state of the expected lengths', () => {
    const { verifier, state } = generatePkce()

    // base64url of 64 random bytes -> ceil(64*4/3) = 86 chars (no padding)
    expect(verifier.length).toBe(86)
    // base64url of 32 random bytes -> ceil(32*4/3) = 43 chars (no padding)
    expect(state.length).toBe(43)
  })

  it('generates distinct values on each call', () => {
    const first = generatePkce()
    const second = generatePkce()

    expect(first.verifier).not.toBe(second.verifier)
    expect(first.state).not.toBe(second.state)
    expect(first.challenge).not.toBe(second.challenge)
  })
})
