// Cell conversion shared by every driver: whatever a driver hands back must survive
// `JSON.stringify` in the RPC connection (a BigInt there throws inside the send callback and the
// renderer's request hangs forever) and must be exact (no JS Date, no lossy float for int64 or
// DECIMAL). So: strings stay strings, bigint → decimal string, Date → ISO string, binary → a hex
// preview cell, nested objects → JSON text. Drivers that already return exact strings (mysql2
// typeCast, pg raw parsers) mostly hit the string fast path.

import type { DataBinaryCell, DataCell } from '../../../shared/data-projects/types'

/** Bytes of a binary value previewed in the grid; the full length travels in `len`. */
export const BINARY_PREVIEW_BYTES = 64

export interface ToCellOptions {
  /** Bytes of binary values to include as hex (Infinity for exports). Default 64. */
  binaryPreviewBytes?: number
}

const isBinary = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))

export function binaryCell(bytes: Uint8Array, previewBytes = BINARY_PREVIEW_BYTES): DataBinaryCell {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const take = Number.isFinite(previewBytes) ? Math.max(0, Math.floor(previewBytes)) : view.length
  return { $t: 'bin', hex: view.subarray(0, take).toString('hex'), len: view.length }
}

/** True when a binary cell carries every byte (safe to write back / export). */
export const isCompleteBinaryCell = (cell: DataBinaryCell): boolean =>
  cell.hex.length === cell.len * 2

/** JSON.stringify that survives bigint, Buffer, Map/Set and cycles (for nested driver values). */
export function safeJsonText(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return (
      JSON.stringify(value, function replacer(_key, v: unknown) {
        if (typeof v === 'bigint') return v.toString()
        if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
        if (isBinary(v)) return `\\x${Buffer.from(v as Uint8Array).toString('hex')}`
        // Buffer.toJSON runs before the replacer sees the value: { type: 'Buffer', data: [...] }.
        if (
          v &&
          typeof v === 'object' &&
          (v as { type?: unknown }).type === 'Buffer' &&
          Array.isArray((v as { data?: unknown }).data)
        ) {
          return `\\x${Buffer.from((v as { data: number[] }).data).toString('hex')}`
        }
        if (v instanceof Map) return Object.fromEntries(v)
        if (v instanceof Set) return [...v]
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[Circular]'
          seen.add(v)
        }
        return v
      }) ?? 'null'
    )
  } catch {
    return String(value)
  }
}

/** Converts one driver value to a JSON-safe, exact DataCell. */
export function toCell(value: unknown, options: ToCellOptions = {}): DataCell {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      // NaN/Infinity are not JSON; keep them visible as text.
      return Number.isFinite(value) ? value : String(value)
    case 'bigint':
      return value.toString()
    case 'symbol':
    case 'function':
      return String(value)
    default:
      break
  }
  if (isBinary(value)) return binaryCell(value, options.binaryPreviewBytes)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof ArrayBuffer)
    return binaryCell(new Uint8Array(value), options.binaryPreviewBytes)
  if (typeof value === 'object' && (value as { $t?: unknown }).$t === 'bin') {
    const cell = value as DataBinaryCell
    if (typeof cell.hex === 'string' && typeof cell.len === 'number') return cell
  }
  return safeJsonText(value)
}

export function toCellRow(values: readonly unknown[], options?: ToCellOptions): DataCell[] {
  const out: DataCell[] = new Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = toCell(values[i], options)
  return out
}

/** Rough UTF-16 size of a cell, for byte caps on result sets. */
export function cellSize(cell: DataCell): number {
  if (cell === null) return 4
  if (typeof cell === 'string') return cell.length + 2
  if (typeof cell === 'object') return cell.hex.length + 32
  return 8
}

/**
 * Text form of a cell for CSV/SQL exports: binary as hex, everything else as-is.
 * Returns null for SQL NULL (the caller decides how NULL is written).
 */
export function cellToText(cell: DataCell): string | null {
  if (cell === null) return null
  if (typeof cell === 'object') return cell.hex
  return String(cell)
}
