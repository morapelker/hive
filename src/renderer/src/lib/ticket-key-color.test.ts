import { describe, expect, it } from 'vitest'
import { hashTicketKey, ticketKeyColor, ticketKeyColorStyle } from './ticket-key-color'

describe('ticket key colour', () => {
  it('hashes deterministically and spreads neighbouring keys over the palette', () => {
    expect(hashTicketKey('TD-7')).toBe(hashTicketKey('TD-7'))
    const colours = new Set(
      Array.from({ length: 40 }, (_, i) => ticketKeyColor(`TD-${5300 + i}`).dark)
    )
    // 14 entries, 40 keys: a good hash lands on most of them.
    expect(colours.size).toBeGreaterThanOrEqual(10)
  })

  it('gives every key a light and a dark hex colour', () => {
    for (const key of ['TD-1', 'GL-12', 'ACM-999', 'TK-0']) {
      const colour = ticketKeyColor(key)
      expect(colour.light).toMatch(/^#[0-9a-f]{6}$/)
      expect(colour.dark).toMatch(/^#[0-9a-f]{6}$/)
      expect(colour.light).not.toBe(colour.dark)
    }
  })

  it('exposes both tones as the custom properties the colour class reads', () => {
    const style = ticketKeyColorStyle('TD-7') as Record<string, string>
    const colour = ticketKeyColor('TD-7')
    expect(style['--ticket-key-light']).toBe(colour.light)
    expect(style['--ticket-key-dark']).toBe(colour.dark)
  })
})
