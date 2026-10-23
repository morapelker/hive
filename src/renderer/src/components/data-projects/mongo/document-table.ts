// Documents → grid for the Table view: one column per top-level field (the union over the shown
// documents, `_id` first, then in order of first appearance), each value a JSON-safe cell
// (nested objects/arrays as relaxed JSON text). A field missing from a document is `undefined`,
// not null: `{ deletedAt: null }` and a document without `deletedAt` are different documents,
// and the grid shows the missing field apart from NULL (copied as an empty cell).

import type { DataCell, DataColumnMeta } from '@shared/data-projects/types'
import { mongoTypeLabel, toGridCell } from './ejson'

/** Wide collections: more columns than this are cut (the List/JSON views show everything). */
export const TABLE_MAX_COLUMNS = 400

/** A Table view cell: undefined = the document has no such field. */
export type DocumentTableCell = DataCell | undefined

export interface DocumentTable {
  columns: DataColumnMeta[]
  rows: DocumentTableCell[][]
  /** Fields dropped by TABLE_MAX_COLUMNS. */
  hiddenColumns: number
}

export function documentsToTable(documents: ReadonlyArray<Record<string, unknown>>): DocumentTable {
  const order: string[] = []
  const seen = new Set<string>()
  const types = new Map<string, Set<string>>()
  for (const doc of documents) {
    for (const key of Object.keys(doc)) {
      if (!seen.has(key)) {
        seen.add(key)
        order.push(key)
      }
      let set = types.get(key)
      if (!set) types.set(key, (set = new Set()))
      if (set.size < 4) set.add(mongoTypeLabel(doc[key]))
    }
  }
  const idIndex = order.indexOf('_id')
  if (idIndex > 0) {
    order.splice(idIndex, 1)
    order.unshift('_id')
  }
  const keys = order.slice(0, TABLE_MAX_COLUMNS)
  const columns: DataColumnMeta[] = keys.map((name) => {
    const set = types.get(name) ?? new Set<string>()
    set.delete('Null')
    return { name, type: set.size === 0 ? 'Null' : set.size === 1 ? [...set][0] : 'Mixed' }
  })
  const rows = documents.map((doc) =>
    keys.map((key): DocumentTableCell => (key in doc ? toGridCell(doc[key]) : undefined))
  )
  return { columns, rows, hiddenColumns: order.length - keys.length }
}
