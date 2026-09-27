import { describe, expect, it } from 'vitest'
import { SEARCH_AUTO_EXPAND_LIMIT, pickSearchAutoExpandIds } from './search-auto-expand'

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i}`)

describe('pickSearchAutoExpandIds', () => {
  it('expands every match when there are fewer than the limit', () => {
    expect([...pickSearchAutoExpandIds(ids(3), () => true)]).toEqual(['p0', 'p1', 'p2'])
  })

  it('keeps only the best-ranked matches of a broad query', () => {
    const picked = pickSearchAutoExpandIds(ids(200), () => true)
    expect(picked.size).toBe(SEARCH_AUTO_EXPAND_LIMIT)
    expect(picked.has('p0')).toBe(true)
    expect(picked.has(`p${SEARCH_AUTO_EXPAND_LIMIT - 1}`)).toBe(true)
    expect(picked.has(`p${SEARCH_AUTO_EXPAND_LIMIT}`)).toBe(false)
  })

  it('does not spend the limit on projects with nothing to show', () => {
    const picked = pickSearchAutoExpandIds(ids(6), (id) => id !== 'p0' && id !== 'p2', 3)
    expect([...picked]).toEqual(['p1', 'p3', 'p4'])
  })
})
