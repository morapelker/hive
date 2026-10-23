// Documents → Table view grid: `_id` first then first-appearance order, column types, and a
// field the document lacks kept apart from a field that is null.
import { describe, expect, it } from 'vitest'
import { documentsToTable } from './document-table'

describe('documentsToTable', () => {
  it('keeps a missing field (undefined) apart from a null one', () => {
    const table = documentsToTable([
      { name: 'a', deletedAt: null, _id: 1 },
      { _id: 2, name: 'b' },
      { _id: 3, extra: true }
    ])
    expect(table.columns.map((c) => c.name)).toEqual(['_id', 'name', 'deletedAt', 'extra'])
    expect(table.rows).toEqual([
      [1, 'a', null, undefined],
      [2, 'b', undefined, undefined],
      [3, undefined, undefined, true]
    ])
    // A column only ever null (where present) is typed Null; absent cells do not count.
    expect(table.columns[2].type).toBe('Null')
    expect(table.columns[3].type).toBe('Boolean')
    expect(table.hiddenColumns).toBe(0)
  })
})
