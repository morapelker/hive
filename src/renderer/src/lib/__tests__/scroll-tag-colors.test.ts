import { describe, it, expect, afterEach, vi } from 'vitest'
import { generateScrollTagColor, SCROLL_TAG_COLORS } from '../scroll-tag-colors'

describe('generateScrollTagColor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a color from the curated palette', () => {
    const color = generateScrollTagColor(new Set())
    expect(SCROLL_TAG_COLORS).toContain(color)
  })

  it('avoids colors already taken when an untaken one exists', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const first = generateScrollTagColor(new Set())
    const next = generateScrollTagColor(new Set([first]))
    expect(next).not.toBe(first)
    expect(SCROLL_TAG_COLORS).toContain(next)
  })

  it('falls back to a random palette color when all colors are taken', () => {
    const allTaken = new Set(SCROLL_TAG_COLORS)
    const color = generateScrollTagColor(allTaken)
    expect(SCROLL_TAG_COLORS).toContain(color)
  })
})
