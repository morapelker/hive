import { describe, expect, it } from 'vitest'
import { decodeEntities } from './html-tokenizer'

describe('decodeEntities', () => {
  it('shows C1 numeric references as browsers do, not as control characters', () => {
    // What Word writes for curly quotes, an en dash and a bullet.
    expect(decodeEntities('don&#146;t 5&#150;10 &#149; &#147;Save&#148; &#x80;')).toBe(
      'don’t 5–10 • “Save” €'
    )
    // The unassigned ones stay what they are; nothing else in the range is touched.
    expect(decodeEntities('&#129;&#65;')).toBe('\u0081A')
  })

  it('decodes the Latin-1 letter entities', () => {
    expect(
      decodeEntities('caf&eacute; &Uuml;ber fa&ccedil;ade stra&szlig;e &times; &divide;')
    ).toBe('café Über façade straße × ÷')
    expect(decodeEntities('&unknown; &amp;eacute;')).toBe('&unknown; &eacute;')
  })
})
