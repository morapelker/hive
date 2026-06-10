import { describe, expect, it } from 'vitest'
import { parseGhosttyConfigContent } from '../ghostty-config'

describe('parseGhosttyConfigContent font-family', () => {
  it('parses a single font-family into fontFamily and fontFamilies', () => {
    const config = parseGhosttyConfigContent('font-family = JetBrains Mono')
    expect(config.fontFamily).toBe('JetBrains Mono')
    expect(config.fontFamilies).toEqual(['JetBrains Mono'])
  })

  it('strips surrounding double quotes from font-family values', () => {
    const config = parseGhosttyConfigContent('font-family = "JetBrains Mono"')
    expect(config.fontFamily).toBe('JetBrains Mono')
    expect(config.fontFamilies).toEqual(['JetBrains Mono'])
  })

  it('keeps repeated font-family lines in order with the first as primary', () => {
    const config = parseGhosttyConfigContent(
      ['font-family = TX-02', 'font-family = "Symbols Nerd Font"'].join('\n')
    )
    expect(config.fontFamily).toBe('TX-02')
    expect(config.fontFamilies).toEqual(['TX-02', 'Symbols Nerd Font'])
  })

  it('dedupes repeated identical font-family lines', () => {
    const config = parseGhosttyConfigContent(
      ['font-family = Menlo', 'font-family = Menlo'].join('\n')
    )
    expect(config.fontFamilies).toEqual(['Menlo'])
  })

  it('resets the font list on an empty font-family value (Ghostty semantics)', () => {
    const config = parseGhosttyConfigContent(
      ['font-family = TX-02', 'font-family =', 'font-family = Menlo'].join('\n')
    )
    expect(config.fontFamily).toBe('Menlo')
    expect(config.fontFamilies).toEqual(['Menlo'])
  })

  it('clears any previous fonts when an empty font-family value is last', () => {
    const config = parseGhosttyConfigContent(
      ['font-family = TX-02', 'font-family ='].join('\n')
    )
    expect(config.fontFamily).toBeUndefined()
    expect(config.fontFamilies).toEqual([])
  })

  it('keeps last-wins behavior and empty-value skip for other keys', () => {
    const config = parseGhosttyConfigContent(
      ['font-size = 12', 'font-size = 14', 'background =', 'background = #1e1e2e'].join('\n')
    )
    expect(config.fontSize).toBe(14)
    expect(config.background).toBe('#1e1e2e')
  })

  it('merges font-family lines from config-file includes in order', () => {
    const includes: Record<string, string> = {
      'extra-fonts': 'font-family = "Symbols Nerd Font"'
    }
    const config = parseGhosttyConfigContent(
      ['font-family = TX-02', 'config-file = extra-fonts'].join('\n'),
      {},
      (path) => includes[path]
    )
    expect(config.fontFamily).toBe('TX-02')
    expect(config.fontFamilies).toEqual(['TX-02', 'Symbols Nerd Font'])
  })
})
