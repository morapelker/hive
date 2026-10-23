// How grid cells look and how they become text. Cells are JSON-safe (types.ts): big numbers,
// decimals and dates arrive as exact strings, binary as a hex preview plus its full length, JSON
// columns as their JSON text. Nothing here reformats a value (no locale number formatting, no
// date parsing): what the server printed is what the user sees and copies.

import { isBinaryCell, type DataBinaryCell, type DataCell } from '@shared/data-projects/types'

export type CellKind = 'null' | 'binary' | 'number' | 'boolean' | 'json' | 'text'

/** Characters rendered inside a grid cell (the inspector shows everything). */
export const CELL_DISPLAY_LIMIT = 300

export const cellKind = (cell: DataCell | undefined): CellKind => {
  if (cell === null || cell === undefined) return 'null'
  if (isBinaryCell(cell)) return 'binary'
  if (typeof cell === 'number') return 'number'
  if (typeof cell === 'boolean') return 'boolean'
  const first = cell.trimStart()[0]
  return first === '{' || first === '[' ? 'json' : 'text'
}

/** True when every byte of the binary value is present in the preview. */
export const isCompleteBinary = (cell: DataBinaryCell): boolean => cell.hex.length / 2 >= cell.len

/** `0x0a1b2c… (128 bytes)`: a short hex head and the full size. */
export function binaryPreview(cell: DataBinaryCell, headBytes = 12): string {
  const head = cell.hex.slice(0, headBytes * 2)
  const more = cell.len > headBytes || !isCompleteBinary(cell)
  const unit = cell.len === 1 ? 'byte' : 'bytes'
  return `0x${head}${more ? '…' : ''} (${cell.len.toLocaleString()} ${unit})`
}

/** One-line text for a cell inside the grid (newlines shown as ↵, long text cut). */
export function cellDisplayText(cell: DataCell | undefined, limit = CELL_DISPLAY_LIMIT): string {
  if (cell === undefined) return '' // an absent document field (Mongo table view)
  if (cell === null) return 'NULL'
  if (isBinaryCell(cell)) return binaryPreview(cell)
  if (typeof cell === 'boolean') return cell ? 'true' : 'false'
  if (typeof cell === 'number') return String(cell)
  const cut = cell.length > limit ? `${cell.slice(0, limit)}…` : cell
  return cut.replace(/\r\n|\r|\n/g, '↵').replace(/\t/g, ' ')
}

/**
 * The full text of a cell for copying: NULL becomes '' (spreadsheets paste it as empty), binary
 * becomes `0x<hex>` (with a trailing … when only a preview was sent).
 */
export function cellToText(cell: DataCell | undefined): string {
  if (cell === null || cell === undefined) return ''
  if (isBinaryCell(cell)) return `0x${cell.hex}${isCompleteBinary(cell) ? '' : '…'}`
  if (typeof cell === 'boolean') return cell ? 'true' : 'false'
  return String(cell)
}

/** Parses JSON objects/arrays (only), for the inspector and JSON export; undefined otherwise. */
export function tryParseJson(text: string): unknown {
  const t = text.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined
  try {
    // Keep each number's source text (1234567890123456789 or 1.0 would otherwise change when
    // the value is stringified again), where the runtime supports JSON.rawJSON.
    return JSON.parse(t, (_key, value, context?: { source?: string }) =>
      typeof value === 'number' &&
      context?.source !== undefined &&
      String(value) !== context.source &&
      typeof (JSON as { rawJSON?: unknown }).rawJSON === 'function'
        ? (JSON as unknown as { rawJSON: (text: string) => unknown }).rawJSON(context.source)
        : value
    )
  } catch {
    return undefined
  }
}

/** Classic 16-bytes-per-line hex dump with an ASCII gutter. */
export function hexDump(hex: string, bytesPerLine = 16): string {
  const lines: string[] = []
  for (let offset = 0; offset * 2 < hex.length; offset += bytesPerLine) {
    const chunk = hex.slice(offset * 2, (offset + bytesPerLine) * 2)
    const bytes = chunk.match(/.{1,2}/g) ?? []
    const ascii = bytes
      .map((b) => {
        const code = parseInt(b, 16)
        return code >= 32 && code < 127 ? String.fromCharCode(code) : '.'
      })
      .join('')
    lines.push(
      `${offset.toString(16).padStart(8, '0')}  ${bytes.join(' ').padEnd(bytesPerLine * 3 - 1, ' ')}  ${ascii}`
    )
  }
  return lines.join('\n')
}

// Grid geometry (12px monospace ≈ 7.2px per character).
const CHAR_PX = 7.2
const CELL_PADDING_PX = 20
export const MIN_COLUMN_WIDTH = 56
export const MAX_AUTO_COLUMN_WIDTH = 380

/** A column width that fits the header and a sample of the rows. */
export function estimateColumnWidth(
  name: string,
  type: string | undefined,
  values: Iterable<DataCell | undefined>,
  sample = 60
): number {
  let chars = Math.max(name.length + 2, Math.min((type ?? '').length, 16))
  let n = 0
  for (const value of values) {
    if (n++ >= sample) break
    const text = cellDisplayText(value, 64)
    if (text.length > chars) chars = text.length
  }
  return Math.round(
    Math.min(MAX_AUTO_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, chars * CHAR_PX + CELL_PADDING_PX))
  )
}

/**
 * The value an inline edit commits: '' stays an empty string (NULL is explicit), and a number
 * column keeps numbers numeric when the text parses exactly.
 */
export function parseEditedValue(
  text: string,
  setNull: boolean,
  original: DataCell | undefined
): DataCell {
  if (setNull) return null
  if (typeof original === 'number') {
    const n = Number(text)
    if (text.trim() !== '' && Number.isFinite(n) && String(n) === text.trim()) return n
  }
  if (typeof original === 'boolean') {
    if (/^(true|t|1)$/i.test(text.trim())) return true
    if (/^(false|f|0)$/i.test(text.trim())) return false
  }
  return text
}

/**
 * What committing an edit draft does: the parsed value, and whether it changes the cell at all.
 * An untouched draft never changes the value; in particular a NULL cell opened and left empty
 * stays NULL (an empty string is set through the inspector). Shared by the inline cell editor and
 * the row detail panel so both stage exactly the same values.
 */
export function resolveCellEdit(
  draft: string,
  setNull: boolean,
  original: DataCell | undefined
): { changed: boolean; value: DataCell } {
  const value = parseEditedValue(draft, setNull, original)
  const isNull = original === null || original === undefined
  const unchanged =
    value === original ||
    (!setNull && isNull && draft === '') ||
    (!isNull && !setNull && cellToText(original) === draft)
  return { changed: !unchanged, value }
}
