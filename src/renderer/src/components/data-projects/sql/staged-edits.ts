// The pending-changes model of the table Data tab (TablePlus / Beekeeper style): cell edits,
// inserted rows and deleted rows are staged in memory, drawn over the grid (amber / green / red),
// previewed as SQL and committed in one `applyEdits` call (one transaction server-side).
//
// Existing rows are identified by their primary key values as loaded (`key`), so an edit of a
// PK column still targets the original row. All operations are immutable (React state).

import { isBinaryCell, type DataCell, type DataRowEdit } from '@shared/data-projects/types'

export interface StagedUpdate {
  key: Record<string, DataCell>
  changes: Record<string, DataCell>
}

export interface StagedInsert {
  id: number
  values: Record<string, DataCell>
}

export interface StagedEdits {
  /** keyString → update of an existing row. */
  updates: Record<string, StagedUpdate>
  inserts: StagedInsert[]
  /** keyString → key of an existing row marked for deletion. */
  deletes: Record<string, Record<string, DataCell>>
}

export const emptyStagedEdits = (): StagedEdits => ({ updates: {}, inserts: [], deletes: {} })

export const pendingCount = (s: StagedEdits): number =>
  Object.keys(s.updates).length + s.inserts.length + Object.keys(s.deletes).length

const cellKey = (cell: DataCell): unknown =>
  isBinaryCell(cell) ? { bin: cell.hex, len: cell.len } : cell

/** Stable string for a key object (column order follows the primary key). */
export const keyString = (key: Record<string, DataCell>, primaryKey: string[]): string =>
  JSON.stringify(primaryKey.map((c) => cellKey(key[c] ?? null)))

/** The PK values of a loaded row, or null when a PK column is missing from the result. */
export function rowKey(
  row: DataCell[],
  columns: string[],
  primaryKey: string[]
): Record<string, DataCell> | null {
  const key: Record<string, DataCell> = {}
  for (const pk of primaryKey) {
    const index = columns.indexOf(pk)
    if (index < 0) return null
    key[pk] = row[index] ?? null
  }
  return key
}

const sameCell = (a: DataCell | undefined, b: DataCell | undefined): boolean =>
  JSON.stringify(cellKey(a ?? null)) === JSON.stringify(cellKey(b ?? null))

/** Stages `value` for one cell of an existing row (removing the change when it is reverted). */
export function stageCellEdit(
  staged: StagedEdits,
  row: DataCell[],
  column: string,
  value: DataCell,
  columns: string[],
  primaryKey: string[]
): StagedEdits {
  const key = rowKey(row, columns, primaryKey)
  if (!key) return staged
  const k = keyString(key, primaryKey)
  if (staged.deletes[k]) return staged
  const original = row[columns.indexOf(column)]
  const current = staged.updates[k] ?? { key, changes: {} }
  const changes = { ...current.changes }
  if (sameCell(original, value)) delete changes[column]
  else changes[column] = value
  const updates = { ...staged.updates }
  if (Object.keys(changes).length) updates[k] = { key, changes }
  else delete updates[k]
  return { ...staged, updates }
}

let insertSeq = 1

export function addStagedInsert(staged: StagedEdits): { staged: StagedEdits; id: number } {
  const id = insertSeq++
  return { staged: { ...staged, inserts: [...staged.inserts, { id, values: {} }] }, id }
}

/** Sets a value of a staged insert (`undefined` = back to the column default). */
export function stageInsertValue(
  staged: StagedEdits,
  id: number,
  column: string,
  value: DataCell | undefined
): StagedEdits {
  return {
    ...staged,
    inserts: staged.inserts.map((ins) => {
      if (ins.id !== id) return ins
      const values = { ...ins.values }
      if (value === undefined) delete values[column]
      else values[column] = value
      return { ...ins, values }
    })
  }
}

export const removeStagedInsert = (staged: StagedEdits, id: number): StagedEdits => ({
  ...staged,
  inserts: staged.inserts.filter((i) => i.id !== id)
})

/**
 * Marks existing rows for deletion, or restores them when every one is already marked. A row's
 * staged cell edits are dropped when it is marked (a deleted row has nothing to update).
 */
export function toggleStagedDeletes(
  staged: StagedEdits,
  rows: DataCell[][],
  columns: string[],
  primaryKey: string[]
): StagedEdits {
  const keys = rows
    .map((r) => rowKey(r, columns, primaryKey))
    .filter((k): k is Record<string, DataCell> => k !== null)
  if (!keys.length) return staged
  const allMarked = keys.every((k) => staged.deletes[keyString(k, primaryKey)])
  const deletes = { ...staged.deletes }
  const updates = { ...staged.updates }
  for (const key of keys) {
    const k = keyString(key, primaryKey)
    if (allMarked) delete deletes[k]
    else {
      deletes[k] = key
      delete updates[k]
    }
  }
  return { ...staged, deletes, updates }
}

/** The edits to send: deletes first (frees unique keys), then updates, then inserts. */
export function toRowEdits(staged: StagedEdits): DataRowEdit[] {
  return [
    ...Object.values(staged.deletes).map((key): DataRowEdit => ({ kind: 'delete', key })),
    ...Object.values(staged.updates).map((u): DataRowEdit => ({
      kind: 'update',
      key: u.key,
      changes: u.changes
    })),
    ...staged.inserts.map((i): DataRowEdit => ({ kind: 'insert', values: i.values }))
  ]
}

export type DisplayRowInfo =
  { kind: 'existing'; index: number; key: string | null } | { kind: 'inserted'; id: number }

/** The grid's rows: the page with staged values applied, staged inserts appended. */
export function displayRows(
  pageRows: DataCell[][],
  columns: string[],
  primaryKey: string[],
  staged: StagedEdits
): { rows: DataCell[][]; info: DisplayRowInfo[] } {
  const rows: DataCell[][] = []
  const info: DisplayRowInfo[] = []
  pageRows.forEach((row, index) => {
    const key = primaryKey.length ? rowKey(row, columns, primaryKey) : null
    const k = key ? keyString(key, primaryKey) : null
    const update = k ? staged.updates[k] : undefined
    rows.push(
      update ? columns.map((c, i) => (c in update.changes ? update.changes[c] : row[i])) : row
    )
    info.push({ kind: 'existing', index, key: k })
  })
  for (const ins of staged.inserts) {
    rows.push(columns.map((c) => (c in ins.values ? ins.values[c] : null)))
    info.push({ kind: 'inserted', id: ins.id })
  }
  return { rows, info }
}
