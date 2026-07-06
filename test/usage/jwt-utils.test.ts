// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decodeJwtPayload, jwtExpMs, parseCodexIdToken } from '../../src/main/services/jwt-utils'

function base64url(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url')
}

function buildJwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  return `${header}.${body}.fake-signature`
}

describe('decodeJwtPayload', () => {
  it('decodes the payload of a hand-built JWT', () => {
    const token = buildJwt({ sub: 'user-123', email: 'person@example.com' })

    expect(decodeJwtPayload(token)).toEqual({ sub: 'user-123', email: 'person@example.com' })
  })

  it('returns null for a malformed token', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull()
    expect(decodeJwtPayload('only.two')).toBeNull()
    expect(decodeJwtPayload('a.b.c.d')).toBeNull()
    expect(decodeJwtPayload('a.!!!not-base64!!!.c')).toBeNull()
  })
})

describe('jwtExpMs', () => {
  it('converts the exp claim from seconds to milliseconds', () => {
    const token = buildJwt({ exp: 1_700_000_000 })

    expect(jwtExpMs(token)).toBe(1_700_000_000 * 1000)
  })

  it('returns null when exp is absent', () => {
    const token = buildJwt({ sub: 'user-123' })

    expect(jwtExpMs(token)).toBeNull()
  })

  it('returns null for an invalid token', () => {
    expect(jwtExpMs('garbage')).toBeNull()
  })
})

describe('parseCodexIdToken', () => {
  it('reads accountId/userId/plan from the https://api.openai.com/auth claim', () => {
    const token = buildJwt({
      email: 'codex-user@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-abc',
        chatgpt_user_id: 'user-abc',
        chatgpt_plan_type: 'plus'
      }
    })

    expect(parseCodexIdToken(token)).toEqual({
      email: 'codex-user@example.com',
      accountId: 'acct-abc',
      userId: 'user-abc',
      plan: 'plus'
    })
  })

  it('falls back to the default organization id when chatgpt_account_id is absent', () => {
    const token = buildJwt({
      email: 'codex-user@example.com',
      'https://api.openai.com/auth': {
        organizations: [
          { id: 'org-1', is_default: false },
          { id: 'org-2', is_default: true }
        ]
      }
    })

    expect(parseCodexIdToken(token).accountId).toBe('org-2')
  })

  it('falls back to the first organization id when there is no default organization', () => {
    const token = buildJwt({
      'https://api.openai.com/auth': {
        organizations: [{ id: 'org-1' }, { id: 'org-2' }]
      }
    })

    expect(parseCodexIdToken(token).accountId).toBe('org-1')
  })

  it('falls back to the auth claim user_id when chatgpt_user_id is absent', () => {
    const token = buildJwt({
      'https://api.openai.com/auth': {
        user_id: 'legacy-user-id'
      }
    })

    expect(parseCodexIdToken(token).userId).toBe('legacy-user-id')
  })

  it('returns all nulls for a malformed token', () => {
    expect(parseCodexIdToken('not-a-jwt')).toEqual({
      email: null,
      accountId: null,
      userId: null,
      plan: null
    })
  })

  it('returns all nulls when the auth claim and email are missing entirely', () => {
    const token = buildJwt({ sub: 'user-123' })

    expect(parseCodexIdToken(token)).toEqual({
      email: null,
      accountId: null,
      userId: null,
      plan: null
    })
  })
})
