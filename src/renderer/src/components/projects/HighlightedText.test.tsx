import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { HighlightedText } from './HighlightedText'
import { toHighlightRuns } from '@/lib/highlight-runs'

function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
}

describe('toHighlightRuns', () => {
  it('groups consecutive characters and preserves the text exactly', () => {
    expect(toHighlightRuns('tedooo-web', [0, 1, 2])).toEqual([
      { text: 'ted', hit: true },
      { text: 'ooo-web', hit: false }
    ])
    expect(toHighlightRuns('alpha', [])).toEqual([{ text: 'alpha', hit: false }])
    expect(toHighlightRuns('ab', [0, 1])).toEqual([{ text: 'ab', hit: true }])
    expect(toHighlightRuns('', [])).toEqual([])
  })

  it('matches the per-character rendering for random inputs', () => {
    const rand = seeded(7)
    for (let n = 0; n < 200; n++) {
      const len = Math.floor(rand() * 40)
      const text = Array.from({ length: len }, () =>
        String.fromCharCode(97 + Math.floor(rand() * 26))
      ).join('')
      const indices = [...Array(len).keys()].filter(() => rand() < 0.4)
      const runs = toHighlightRuns(text, indices)
      expect(runs.map((r) => r.text).join('')).toBe(text)
      // No two adjacent runs share a state, and every run is non-empty.
      for (let i = 0; i < runs.length; i++) {
        expect(runs[i].text.length).toBeGreaterThan(0)
        if (i > 0) expect(runs[i].hit).not.toBe(runs[i - 1].hit)
      }
      const hitChars = runs.filter((r) => r.hit).flatMap((r) => r.text.split(''))
      expect(hitChars).toEqual(indices.map((i) => text[i]))
    }
  })
})

describe('HighlightedText', () => {
  it('renders one span per highlighted run and plain text otherwise', () => {
    const { container } = render(
      <HighlightedText text="/Users/mor/dev/tedooo-web" indices={[15, 16, 17, 22, 23, 24]} />
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.textContent).toBe('/Users/mor/dev/tedooo-web')
    const spans = [...root.querySelectorAll('span')]
    expect(spans.map((s) => s.textContent)).toEqual(['ted', 'web'])
    expect(spans.every((s) => s.className.includes('font-semibold'))).toBe(true)
  })
})
