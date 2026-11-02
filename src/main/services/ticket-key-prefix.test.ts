import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TICKET_KEY_PREFIX,
  ensureTicketKeyPrefixFromIdentity,
  prefixForIdentity
} from './ticket-key-prefix'

describe('ticket key prefix (git identity)', () => {
  it('derives the prefix from the organisation label of the git email', () => {
    expect(prefixForIdentity({ email: 'mor@tedooo.com', name: 'Mor' })).toBe(
      prefixForIdentity({ email: 'someone@tedooo.com', name: null })
    )
    expect(prefixForIdentity({ email: 'mor@tedooo.com', name: null })).not.toBe(
      DEFAULT_TICKET_KEY_PREFIX
    )
  })

  it('falls back to the git name for personal mail, and to HIVE without any identity', () => {
    expect(prefixForIdentity({ email: 'mor@gmail.com', name: 'Mor Apelker' })).toBe(
      prefixForIdentity({ email: null, name: 'Mor Apelker' })
    )
    expect(prefixForIdentity({ email: null, name: null })).toBe(DEFAULT_TICKET_KEY_PREFIX)
  })

  it('stamps the derived prefix and reports the stored one when the machine already has a prefix', async () => {
    const ensurePrefix = vi.fn(() => 'FIRST')
    const effective = await ensureTicketKeyPrefixFromIdentity({
      readIdentity: async () => ({ email: 'a@acme.com', name: null }),
      ensurePrefix
    })
    expect(ensurePrefix).toHaveBeenCalledWith(prefixForIdentity({ email: 'a@acme.com', name: null }))
    expect(effective).toBe('FIRST')
  })

  it('returns null and never throws when the database refuses', async () => {
    const effective = await ensureTicketKeyPrefixFromIdentity({
      readIdentity: async () => ({ email: null, name: null }),
      ensurePrefix: () => {
        throw new Error('locked')
      }
    })
    expect(effective).toBeNull()
  })
})
