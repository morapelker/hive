import { describe, expect, it } from 'vitest'

import {
  FALLBACK_TICKET_KEY_PREFIX,
  deriveTicketKeyPrefix,
  formatTicketKey,
  organisationLabelOfEmail,
  ticketKeyOf,
  ticketKeyPrefixFromSession,
  ticketTitleWithKey
} from './ticket-key'

// The prefix derivation is deterministic and runs once per machine (the first organisation
// to sign in names every key for good), so these tables pin the exact letters: a change here
// would rename nothing retroactively but would make new machines disagree with old ones.

describe('deriveTicketKeyPrefix', () => {
  const cases: [string, string][] = [
    ['tedooo', 'TD'],
    ['google', 'GL'],
    ['acme', 'ACM'],
    ['ab', 'AB'],
    ['x', 'XX'],
    ['openai', 'OPN'],
    ['my-startup', 'MS'],
    ['shopify', 'SHP'],
    ['aaa', 'AA'],
    ['github', 'GTH'],
    ['microsoft', 'MCR'],
    ['123go', 'GO'],
    ['acme2', 'ACM'],
    ['tedooo-labs', 'TL'],
    ['a1', 'AX'],
    ['99', 'T99'],
    ['', 'TK'],
    ['Tedooo Labs Ltd', 'TLL']
  ]

  it.each(cases)('%j -> %s', (label, expected) => {
    expect(deriveTicketKeyPrefix(label)).toBe(expected)
  })

  it.each(cases)('%j yields a 2-3 character uppercase key', (label) => {
    expect(deriveTicketKeyPrefix(label)).toMatch(/^[A-Z][A-Z0-9]{1,2}$/)
  })

  it('is case-insensitive and ignores surrounding punctuation', () => {
    expect(deriveTicketKeyPrefix('TEDOOO')).toBe('TD')
    expect(deriveTicketKeyPrefix('  tedooo.  ')).toBe('TD')
    expect(deriveTicketKeyPrefix('--my--startup--')).toBe('MS')
  })

  it('falls back for null, undefined and punctuation-only input', () => {
    expect(deriveTicketKeyPrefix(null)).toBe(FALLBACK_TICKET_KEY_PREFIX)
    expect(deriveTicketKeyPrefix(undefined)).toBe(FALLBACK_TICKET_KEY_PREFIX)
    expect(deriveTicketKeyPrefix('---')).toBe(FALLBACK_TICKET_KEY_PREFIX)
    expect(FALLBACK_TICKET_KEY_PREFIX).toBe('TK')
  })

  it('uses only the first three words of a long name', () => {
    expect(deriveTicketKeyPrefix('alpha beta gamma delta')).toBe('ABG')
  })

  it('falls back to the single-word rule when the initials are all digits', () => {
    // "1 2 go": the initials "12g" lose their leading digits and are too short.
    expect(deriveTicketKeyPrefix('1 2 go')).toBe('GO')
  })
})

describe('organisationLabelOfEmail', () => {
  const cases: [string, string | null][] = [
    ['mor@tedooo.com', 'tedooo'],
    ['x@mail.my-startup.io', 'my-startup'],
    ['a@bbc.co.uk', 'bbc'],
    ['bob@gmail.com', null],
    ['bad', null]
  ]

  it.each(cases)('%j -> %j', (email, expected) => {
    expect(organisationLabelOfEmail(email)).toBe(expected)
  })

  it('lower-cases and trims the domain', () => {
    expect(organisationLabelOfEmail('Mor@Tedooo.COM ')).toBe('tedooo')
  })

  it('still sees the two-letter country code through trailing whitespace or a trailing dot', () => {
    expect(organisationLabelOfEmail('a@bbc.co.uk ')).toBe('bbc')
    expect(organisationLabelOfEmail(' a@bbc.co.uk\n')).toBe('bbc')
    expect(organisationLabelOfEmail('a@bbc.co.uk.')).toBe('bbc')
  })

  it('keeps a second-level label that is not a public suffix', () => {
    // "co" only hides a company under a two-letter country code (co.uk), not under .com.
    expect(organisationLabelOfEmail('a@dev.co.com')).toBe('co')
    expect(organisationLabelOfEmail('a@shop.com.au')).toBe('shop')
  })

  it('treats every public mail provider as unknown', () => {
    for (const domain of ['outlook.com', 'icloud.com', 'proton.me', 'yahoo.co.uk']) {
      expect(organisationLabelOfEmail(`someone@${domain}`)).toBeNull()
    }
  })

  it('returns null for null, undefined, empty and address-less input', () => {
    expect(organisationLabelOfEmail(null)).toBeNull()
    expect(organisationLabelOfEmail(undefined)).toBeNull()
    expect(organisationLabelOfEmail('')).toBeNull()
    expect(organisationLabelOfEmail('mor@')).toBeNull()
  })
})

describe('ticketKeyPrefixFromSession', () => {
  it('derives from the email domain when it names an organisation', () => {
    expect(ticketKeyPrefixFromSession('mor@tedooo.com', 'Something Else')).toBe('TD')
  })

  it('falls back to the organisation name for a public mail address', () => {
    expect(ticketKeyPrefixFromSession('bob@gmail.com', 'Tedooo')).toBe('TD')
  })

  it('returns null when neither the email nor the organisation name is known', () => {
    expect(ticketKeyPrefixFromSession(null, null)).toBeNull()
    expect(ticketKeyPrefixFromSession(undefined, undefined)).toBeNull()
    expect(ticketKeyPrefixFromSession('bob@gmail.com', '   ')).toBeNull()
    expect(ticketKeyPrefixFromSession('bob@gmail.com', null)).toBeNull()
  })
})

describe('formatTicketKey', () => {
  it('joins the prefix and the number', () => {
    expect(formatTicketKey('TD', 12)).toBe('TD-12')
    expect(formatTicketKey('T99', 1)).toBe('T99-1')
  })

  it('returns null when either half is missing or unusable', () => {
    expect(formatTicketKey(null, 12)).toBeNull()
    expect(formatTicketKey(undefined, 12)).toBeNull()
    expect(formatTicketKey('', 12)).toBeNull()
    expect(formatTicketKey('TD', null)).toBeNull()
    expect(formatTicketKey('TD', undefined)).toBeNull()
    expect(formatTicketKey('TD', 0)).toBeNull()
    expect(formatTicketKey('TD', -3)).toBeNull()
    expect(formatTicketKey('TD', Number.NaN)).toBeNull()
    expect(formatTicketKey('TD', Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('ticketKeyOf', () => {
  it('formats a keyed ticket', () => {
    expect(ticketKeyOf({ ticket_prefix: 'TD', ticket_number: 12 })).toBe('TD-12')
  })

  it('is null for markdown cards, older rows and missing tickets', () => {
    expect(ticketKeyOf({ ticket_prefix: null, ticket_number: null })).toBeNull()
    expect(ticketKeyOf({ ticket_prefix: 'TD', ticket_number: null })).toBeNull()
    expect(ticketKeyOf({ ticket_prefix: null, ticket_number: 4 })).toBeNull()
    expect(ticketKeyOf(null)).toBeNull()
    expect(ticketKeyOf(undefined)).toBeNull()
  })
})

describe('ticketTitleWithKey', () => {
  it('prefixes the title with the key', () => {
    expect(ticketTitleWithKey({ ticket_prefix: 'TD', ticket_number: 12, title: 'Fix login' })).toBe(
      'TD-12 · Fix login'
    )
  })

  it('returns the bare title when the ticket has no key', () => {
    expect(
      ticketTitleWithKey({ ticket_prefix: null, ticket_number: null, title: 'Fix login' })
    ).toBe('Fix login')
  })

  it('falls back when the title is blank or the ticket is missing', () => {
    expect(ticketTitleWithKey({ ticket_prefix: 'TD', ticket_number: 3, title: '   ' })).toBe(
      'TD-3 · A ticket'
    )
    expect(ticketTitleWithKey(null)).toBe('A ticket')
    expect(ticketTitleWithKey(undefined, 'Untitled')).toBe('Untitled')
    expect(ticketTitleWithKey({ ticket_prefix: null, ticket_number: null, title: '' }, 'X')).toBe(
      'X'
    )
  })
})
