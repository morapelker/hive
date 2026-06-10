import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_XTERM_FONT_STACK,
  clampTerminalFontSize,
  ensureTerminalFontsLoaded,
  isFontResolvable,
  quoteFontFamily,
  resolveTerminalFontFamily
} from './terminal-fonts'

function resolvableSet(names: string[]): (family: string) => boolean {
  return (family: string) => names.includes(family)
}

describe('quoteFontFamily', () => {
  it('wraps family names in double quotes', () => {
    expect(quoteFontFamily('Symbols Nerd Font')).toBe('"Symbols Nerd Font"')
  })

  it('does not double-quote already quoted names', () => {
    expect(quoteFontFamily('"JetBrains Mono"')).toBe('"JetBrains Mono"')
  })
})

describe('resolveTerminalFontFamily', () => {
  it('returns the default stack when no ghostty families are given', () => {
    const result = resolveTerminalFontFamily(undefined, resolvableSet([]))
    expect(result.fontFamily).toBe(DEFAULT_XTERM_FONT_STACK)
    expect(result.dropped).toEqual([])
    expect(result.primary).toBeNull()
  })

  it('keeps a resolvable family and always appends the default stack', () => {
    const result = resolveTerminalFontFamily(['TX-02'], resolvableSet(['TX-02']))
    expect(result.fontFamily).toBe(`"TX-02", ${DEFAULT_XTERM_FONT_STACK}`)
    expect(result.primary).toBe('TX-02')
    expect(result.primaryResolved).toBe(true)
    expect(result.dropped).toEqual([])
  })

  it('drops families the browser cannot resolve', () => {
    const result = resolveTerminalFontFamily(['NonexistentFont 123'], resolvableSet([]))
    expect(result.fontFamily).toBe(DEFAULT_XTERM_FONT_STACK)
    expect(result.dropped).toEqual(['NonexistentFont 123'])
    expect(result.primary).toBe('NonexistentFont 123')
    expect(result.primaryResolved).toBe(false)
  })

  it('keeps resolvable families and drops unresolvable ones, preserving order', () => {
    const result = resolveTerminalFontFamily(
      ['Bad Font', 'Good Font', 'Other Good'],
      resolvableSet(['Good Font', 'Other Good'])
    )
    expect(result.fontFamily).toBe(`"Good Font", "Other Good", ${DEFAULT_XTERM_FONT_STACK}`)
    expect(result.dropped).toEqual(['Bad Font'])
  })

  it('ignores empty family names', () => {
    const result = resolveTerminalFontFamily(['', '  '], resolvableSet([]))
    expect(result.fontFamily).toBe(DEFAULT_XTERM_FONT_STACK)
    expect(result.dropped).toEqual([])
  })

  it('keeps ghostty families when the resolvability probe throws', () => {
    const result = resolveTerminalFontFamily(['TX-02'], () => {
      throw new Error('no canvas')
    })
    expect(result.fontFamily).toBe(`"TX-02", ${DEFAULT_XTERM_FONT_STACK}`)
    expect(result.dropped).toEqual([])
  })
})

describe('isFontResolvable', () => {
  it('keeps families (returns true) when canvas measurement is unavailable', () => {
    // jsdom has no 2d canvas context, so the probe must fail open.
    expect(isFontResolvable('Anything At All')).toBe(true)
  })
})

describe('clampTerminalFontSize', () => {
  it('passes through undefined', () => {
    expect(clampTerminalFontSize(undefined)).toBeUndefined()
  })

  it('clamps to a sane range and keeps in-range values', () => {
    expect(clampTerminalFontSize(2)).toBe(6)
    expect(clampTerminalFontSize(100)).toBe(32)
    expect(clampTerminalFontSize(14)).toBe(14)
  })
})

describe('ensureTerminalFontsLoaded', () => {
  it('loads regular, bold, italic and bold-italic variants', async () => {
    const load = vi.fn().mockResolvedValue([])
    await ensureTerminalFontsLoaded({ load } as unknown as Pick<FontFaceSet, 'load'>)
    const requested = load.mock.calls.map((call) => call[0])
    expect(requested).toEqual([
      '13px "JetBrains Mono"',
      'bold 13px "JetBrains Mono"',
      'italic 13px "JetBrains Mono"',
      'bold italic 13px "JetBrains Mono"'
    ])
  })

  it('resolves even when font loading rejects', async () => {
    const load = vi.fn().mockRejectedValue(new Error('no such font'))
    await expect(
      ensureTerminalFontsLoaded({ load } as unknown as Pick<FontFaceSet, 'load'>)
    ).resolves.toBeUndefined()
  })

  it('resolves after the timeout when loading never settles', async () => {
    const load = vi.fn().mockReturnValue(new Promise(() => {}))
    await expect(
      ensureTerminalFontsLoaded({ load } as unknown as Pick<FontFaceSet, 'load'>, 20)
    ).resolves.toBeUndefined()
  })

  it('resolves when no FontFaceSet is available', async () => {
    await expect(ensureTerminalFontsLoaded(undefined)).resolves.toBeUndefined()
  })
})
