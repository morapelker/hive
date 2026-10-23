// Client-side sort and quick filter of loaded query results. The rows are already in memory (a
// table's Data tab sorts and filters on the server instead), so this only reorders / narrows what
// the grid shows: the result is a list of indexes into the original rows, in display order.
//
// Sorting is type-aware and stable: numbers compare as numbers, including the exact decimal
// strings the server sends for int64 / numeric / decimal columns (compared digit by digit, never
// through a float); booleans false < true; text with the locale collator; NULLs always last in
// both directions; equal keys keep their original order.

import { isBinaryCell, type DataCell, type DataColumnMeta } from '@shared/data-projects/types'
import { cellToText } from './cell-format'

export interface ClientSort {
  /** Column position in the result (names may repeat: `SELECT a.id, b.id`). */
  col: number
  direction: 'asc' | 'desc'
}

export interface ClientValueFilter {
  col: number
  value: DataCell
}

export interface ClientView {
  sort: ClientSort[]
  /** Rows containing this text in any column (case-insensitive). */
  text: string
  /** "Filter by this value": rows whose cell equals the value (all of them must match). */
  values: ClientValueFilter[]
}

export const EMPTY_CLIENT_VIEW: ClientView = { sort: [], text: '', values: [] }

export const isClientViewActive = (view: ClientView): boolean =>
  view.sort.length > 0 || view.text.trim() !== '' || view.values.length > 0

export const isClientFilterActive = (view: ClientView): boolean =>
  view.text.trim() !== '' || view.values.length > 0

/** Header click: asc → desc → off. `additive` (shift-click) keeps the other sorted columns. */
export function nextClientSort(sort: ClientSort[], col: number, additive: boolean): ClientSort[] {
  const current = sort.find((s) => s.col === col)
  const next: ClientSort | null = !current
    ? { col, direction: 'asc' }
    : current.direction === 'asc'
      ? { col, direction: 'desc' }
      : null
  if (!additive) return next ? [next] : []
  const rest = sort.filter((s) => s.col !== col)
  return next ? [...rest, next] : rest
}

/** Adds (or replaces) the value filter of a column. */
export const withValueFilter = (view: ClientView, col: number, value: DataCell): ClientView => ({
  ...view,
  values: [...view.values.filter((v) => v.col !== col), { col, value }]
})

const NUMERIC_TYPE = /int|dec|numeric|float|double|real|number|money|serial|uint/i
const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/

/** Exact order of two plain decimal strings of any length ("-12.50", "9007199254740993"). */
export function compareDecimalStrings(a: string, b: string): number {
  const ma = DECIMAL.exec(a.trim())
  const mb = DECIMAL.exec(b.trim())
  if (!ma || !mb) return 0
  const parts = (m: RegExpExecArray): { neg: boolean; int: string; frac: string } => {
    const int = m[2].replace(/^0+(?=\d)/, '')
    const frac = (m[3] ?? '').replace(/0+$/, '')
    const zero = /^0*$/.test(int) && frac === ''
    return { neg: m[1] === '-' && !zero, int, frac }
  }
  const x = parts(ma)
  const y = parts(mb)
  if (x.neg !== y.neg) return x.neg ? -1 : 1
  let magnitude = 0
  if (x.int.length !== y.int.length) magnitude = x.int.length < y.int.length ? -1 : 1
  else if (x.int !== y.int) magnitude = x.int < y.int ? -1 : 1
  else {
    const width = Math.max(x.frac.length, y.frac.length)
    const fx = x.frac.padEnd(width, '0')
    const fy = y.frac.padEnd(width, '0')
    magnitude = fx === fy ? 0 : fx < fy ? -1 : 1
  }
  return x.neg ? -magnitude : magnitude
}

/** Sort key of one cell: rank 0 = numeric (or boolean), 1 = text, null handled apart. */
type SortKey = null | { rank: 0; num: number; decimal: string | null } | { rank: 1; text: string }

const collator = new Intl.Collator(undefined, { sensitivity: 'variant' })

function sortKey(cell: DataCell | undefined, numericColumn: boolean): SortKey {
  if (cell === null || cell === undefined) return null
  if (typeof cell === 'number') return { rank: 0, num: cell, decimal: null }
  if (typeof cell === 'boolean') return { rank: 0, num: cell ? 1 : 0, decimal: null }
  if (isBinaryCell(cell)) return { rank: 1, text: cell.hex }
  if (numericColumn) {
    const trimmed = cell.trim()
    if (DECIMAL.test(trimmed)) return { rank: 0, num: Number(trimmed), decimal: trimmed }
    const num = trimmed === '' ? NaN : Number(trimmed)
    if (Number.isFinite(num)) return { rank: 0, num, decimal: null }
  }
  return { rank: 1, text: cell }
}

function compareKeys(a: Exclude<SortKey, null>, b: Exclude<SortKey, null>): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  if (a.rank === 0 && b.rank === 0) {
    if (a.decimal !== null && b.decimal !== null) return compareDecimalStrings(a.decimal, b.decimal)
    return a.num === b.num ? 0 : a.num < b.num ? -1 : 1
  }
  return collator.compare((a as { text: string }).text, (b as { text: string }).text)
}

/** True when the column holds numbers (by its type, or every sampled value being a JS number). */
export function isNumericColumn(
  column: DataColumnMeta | undefined,
  rows: DataCell[][],
  col: number
): boolean {
  if (column?.type && NUMERIC_TYPE.test(column.type)) return true
  let seen = 0
  for (let r = 0; r < rows.length && seen < 50; r++) {
    const cell = rows[r][col]
    if (cell === null || cell === undefined) continue
    if (typeof cell !== 'number') return false
    seen++
  }
  return seen > 0
}

/** Row indexes in sorted order (stable; NULLs last whatever the direction). */
export function sortRowIndexes(
  rows: DataCell[][],
  columns: DataColumnMeta[],
  sort: ClientSort[],
  indexes: number[] = rows.map((_, i) => i)
): number[] {
  const specs = sort.filter((s) => s.col >= 0 && s.col < columns.length)
  if (!specs.length) return indexes
  const keys = specs.map((s) => {
    const numeric = isNumericColumn(columns[s.col], rows, s.col)
    const column: SortKey[] = new Array(rows.length)
    for (const i of indexes) column[i] = sortKey(rows[i][s.col], numeric)
    return { keys: column, sign: s.direction === 'desc' ? -1 : 1 }
  })
  return [...indexes].sort((ia, ib) => {
    for (const { keys: column, sign } of keys) {
      const a = column[ia]
      const b = column[ib]
      if (a === null || b === null) {
        if (a === b) continue
        return a === null ? 1 : -1
      }
      const order = compareKeys(a, b)
      if (order !== 0) return order * sign
    }
    return ia - ib
  })
}

const sameCell = (a: DataCell | undefined, b: DataCell): boolean => {
  if (a === undefined) return b === null
  if (a === null || b === null) return a === b
  if (isBinaryCell(a) || isBinaryCell(b))
    return isBinaryCell(a) && isBinaryCell(b) && a.hex === b.hex && a.len === b.len
  return a === b
}

/** Row indexes passing the quick filter (all value filters, and the text in any column). */
export function filterRowIndexes(rows: DataCell[][], view: ClientView): number[] {
  const needle = view.text.trim().toLowerCase()
  const out: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!view.values.every((f) => sameCell(row[f.col], f.value))) continue
    if (
      needle &&
      !row.some((cell) => cell !== null && cellToText(cell).toLowerCase().includes(needle))
    )
      continue
    out.push(i)
  }
  return out
}

/**
 * Indexes of the rows to show, in display order, or null when the view changes nothing (the grid
 * then gets the original rows array as it is).
 */
export function applyClientView(
  rows: DataCell[][],
  columns: DataColumnMeta[],
  view: ClientView
): number[] | null {
  if (!isClientViewActive(view)) return null
  const filtered = isClientFilterActive(view) ? filterRowIndexes(rows, view) : undefined
  return sortRowIndexes(rows, columns, view.sort, filtered)
}
