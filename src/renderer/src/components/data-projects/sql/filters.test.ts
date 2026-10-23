// Filter drafts → DataFilter list, the AND / OR join (sent only for OR between two or more
// filters) and how "Filter by this value" combines with the existing filters.
import { describe, expect, it } from 'vitest'
import {
  addValueFilter,
  effectiveFilterJoin,
  filterJoinField,
  newFilterDraft,
  toDataFilters
} from './filters'

describe('table filters', () => {
  it('sends only complete drafts', () => {
    const drafts = [
      newFilterDraft('status', '=', 'paid'),
      newFilterDraft('total', '>'),
      newFilterDraft('note', 'is null'),
      newFilterDraft('', '=', 'x')
    ]
    expect(toDataFilters(drafts)).toEqual([
      { column: 'status', operator: '=', value: 'paid' },
      { column: 'note', operator: 'is null' }
    ])
  })

  it('uses OR only between two or more filters, and sends the join only then', () => {
    const one = toDataFilters([newFilterDraft('a', '=', '1')])
    const two = toDataFilters([newFilterDraft('a', '=', '1'), newFilterDraft('b', '=', '2')])
    expect(effectiveFilterJoin(two, 'or')).toBe('or')
    expect(effectiveFilterJoin(two, 'and')).toBe('and')
    expect(effectiveFilterJoin(one, 'or')).toBe('and')
    expect(filterJoinField(two, 'or')).toEqual({ filterJoin: 'or' })
    expect(filterJoinField(two, 'and')).toEqual({})
    expect(filterJoinField(one, 'or')).toEqual({})
    expect(filterJoinField([], 'or')).toEqual({})
  })

  it('narrows with "Filter by this value": AND is extended, an OR group is replaced', () => {
    const a = newFilterDraft('status', '=', 'paid')
    const b = newFilterDraft('status', '=', 'new')
    const value = newFilterDraft('country', '=', 'US')
    expect(addValueFilter([a, b], 'and', value)).toEqual({
      drafts: [a, b, value],
      join: 'and',
      replaced: false
    })
    expect(addValueFilter([a, b], 'or', value)).toEqual({
      drafts: [value],
      join: 'and',
      replaced: true
    })
    // a single filter (or an incomplete second row) under OR: one more AND, nothing lost
    const blank = newFilterDraft('total', '>')
    expect(addValueFilter([a, blank], 'or', value)).toEqual({
      drafts: [a, blank, value],
      join: 'and',
      replaced: false
    })
  })
})
