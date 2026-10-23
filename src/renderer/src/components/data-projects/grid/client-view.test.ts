// Client-side sort and quick filter of query results: exact decimal-string order (int64 /
// numeric beyond float precision), NULLs last in both directions, stable multi-column sort,
// header-click cycling, text and value filters, and the identity case (no view = original rows).
import { describe, expect, it } from 'vitest'
import type { DataCell, DataColumnMeta } from '@shared/data-projects/types'
import {
  applyClientView,
  compareDecimalStrings,
  EMPTY_CLIENT_VIEW,
  filterRowIndexes,
  isNumericColumn,
  nextClientSort,
  sortRowIndexes,
  withValueFilter
} from './client-view'

const col = (name: string, type?: string): DataColumnMeta => ({ name, ...(type ? { type } : {}) })

describe('compareDecimalStrings', () => {
  it('orders decimal strings exactly, beyond float precision', () => {
    expect(compareDecimalStrings('9007199254740993', '9007199254740992')).toBe(1)
    expect(compareDecimalStrings('10', '9')).toBe(1)
    expect(compareDecimalStrings('-10', '-9')).toBe(-1)
    expect(compareDecimalStrings('1.50', '1.5')).toBe(0)
    expect(compareDecimalStrings('0.10', '0.09')).toBe(1)
    expect(compareDecimalStrings('-0', '0.00')).toBe(0)
    expect(compareDecimalStrings('-1', '0')).toBe(-1)
    expect(compareDecimalStrings('007', '7')).toBe(0)
  })
})

describe('sortRowIndexes', () => {
  const columns = [col('id', 'int8'), col('name', 'text'), col('price', 'numeric')]
  const rows: DataCell[][] = [
    ['10', 'b', '2.50'],
    ['9', null, '10.00'],
    [null, 'a', '2.5'],
    ['9007199254740993', 'c', null],
    ['9007199254740992', 'a', '-1']
  ]

  it('sorts int64 strings numerically with NULLs last, both directions', () => {
    expect(sortRowIndexes(rows, columns, [{ col: 0, direction: 'asc' }])).toEqual([1, 0, 4, 3, 2])
    expect(sortRowIndexes(rows, columns, [{ col: 0, direction: 'desc' }])).toEqual([3, 4, 0, 1, 2])
  })

  it('is stable and sorts by several columns', () => {
    // price 2.50 and 2.5 are equal: original order (0 before 2) is kept
    expect(sortRowIndexes(rows, columns, [{ col: 2, direction: 'asc' }])).toEqual([4, 0, 2, 1, 3])
    expect(
      sortRowIndexes(rows, columns, [
        { col: 1, direction: 'asc' },
        { col: 0, direction: 'desc' }
      ])
    ).toEqual([4, 2, 0, 3, 1])
  })

  it('compares JS numbers and booleans by value and text with the collator', () => {
    const r: DataCell[][] = [
      [3, true, 'b'],
      [20, false, 'B'],
      [1, null, 'a']
    ]
    const c = [col('n'), col('flag', 'bool'), col('t')]
    expect(isNumericColumn(c[0], r, 0)).toBe(true)
    expect(sortRowIndexes(r, c, [{ col: 0, direction: 'asc' }])).toEqual([2, 0, 1])
    expect(sortRowIndexes(r, c, [{ col: 1, direction: 'asc' }])).toEqual([1, 0, 2])
    expect(sortRowIndexes(r, c, [{ col: 2, direction: 'asc' }])).toEqual([2, 0, 1])
  })

  it('keeps text after numbers in a numeric column that holds both', () => {
    const r: DataCell[][] = [['n/a'], ['5'], ['-2']]
    expect(sortRowIndexes(r, [col('v', 'numeric')], [{ col: 0, direction: 'asc' }])).toEqual([
      2, 1, 0
    ])
  })
})

describe('nextClientSort', () => {
  it('cycles asc → desc → off; shift-click adds a column', () => {
    let sort = nextClientSort([], 1, false)
    expect(sort).toEqual([{ col: 1, direction: 'asc' }])
    sort = nextClientSort(sort, 1, false)
    expect(sort).toEqual([{ col: 1, direction: 'desc' }])
    sort = nextClientSort(sort, 2, true)
    expect(sort).toEqual([
      { col: 1, direction: 'desc' },
      { col: 2, direction: 'asc' }
    ])
    sort = nextClientSort(sort, 1, true)
    expect(sort).toEqual([{ col: 2, direction: 'asc' }])
    expect(nextClientSort([{ col: 2, direction: 'desc' }], 2, false)).toEqual([])
  })
})

describe('filters', () => {
  const rows: DataCell[][] = [
    [1, 'Shira Levi', { $t: 'bin', hex: 'cafe', len: 2 }],
    [2, null, null],
    [3, 'noa levi', { $t: 'bin', hex: 'beef', len: 2 }]
  ]
  const columns = [col('id', 'int4'), col('name', 'text'), col('avatar', 'bytea')]

  it('keeps rows containing the text in any column, case-insensitive', () => {
    expect(filterRowIndexes(rows, { ...EMPTY_CLIENT_VIEW, text: 'LEVI' })).toEqual([0, 2])
    expect(filterRowIndexes(rows, { ...EMPTY_CLIENT_VIEW, text: '0xbe' })).toEqual([2])
    expect(filterRowIndexes(rows, { ...EMPTY_CLIENT_VIEW, text: 'null' })).toEqual([])
  })

  it('filters by exact values (NULL and binary included) and replaces a column filter', () => {
    let view = withValueFilter(EMPTY_CLIENT_VIEW, 1, null)
    expect(filterRowIndexes(rows, view)).toEqual([1])
    view = withValueFilter(view, 1, 'noa levi')
    expect(view.values).toHaveLength(1)
    expect(filterRowIndexes(rows, view)).toEqual([2])
    expect(
      filterRowIndexes(
        rows,
        withValueFilter(EMPTY_CLIENT_VIEW, 2, { $t: 'bin', hex: 'cafe', len: 2 })
      )
    ).toEqual([0])
  })

  it('applies filter then sort, and returns null when nothing is active', () => {
    expect(applyClientView(rows, columns, EMPTY_CLIENT_VIEW)).toBeNull()
    expect(
      applyClientView(rows, columns, {
        text: 'levi',
        values: [],
        sort: [{ col: 0, direction: 'desc' }]
      })
    ).toEqual([2, 0])
  })
})
