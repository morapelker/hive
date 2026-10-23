// Text formats for copying grid selections and saving visible results: TSV (pastes cleanly into
// spreadsheets), RFC 4180 CSV, JSON (array of objects, or one object for a single row), SQL
// INSERT statements and Markdown.
// Full exports (no row limit) stream server-side instead: see shared/export-actions.ts.

import {
  isBinaryCell,
  type DataCell,
  type DataColumnMeta,
  type SqlDialect
} from '@shared/data-projects/types'
import { qualifiedSqlName, quoteSqlIdentifier, quoteSqlLiteral } from '@shared/sql'
import { cellToText, isCompleteBinary, tryParseJson } from './cell-format'

const TSV_SPECIAL = /[\t\n\r"]/

const tsvField = (text: string): string =>
  TSV_SPECIAL.test(text) ? `"${text.replace(/"/g, '""')}"` : text

/**
 * Tab-separated values; quotes fields holding tabs, newlines or quotes (Excel/Sheets style). NULL
 * and the empty string both paste as an empty cell: spreadsheets have no NULL to tell them apart.
 */
export function toTsv(
  columns: DataColumnMeta[],
  rows: DataCell[][],
  options: { header?: boolean } = {}
): string {
  const lines: string[] = []
  if (options.header) lines.push(columns.map((c) => tsvField(c.name)).join('\t'))
  for (const row of rows) lines.push(columns.map((_, i) => tsvField(cellToText(row[i]))).join('\t'))
  return lines.join('\n')
}

export interface CsvOptions {
  delimiter?: ',' | ';' | '\t'
  header?: boolean
  /** Text written for NULL ('' by default; some tools want \N or NULL). */
  nullText?: string
  /** Prepend a UTF-8 BOM so Excel detects the encoding. */
  bom?: boolean
}

/**
 * RFC 4180 CSV (CRLF line breaks, fields quoted when needed). Like the server-side full export
 * (main/services/data-projects/export.ts csvField), NULL is `nullText` (an empty unquoted field by
 * default) and the empty string is `""`, so a re-import can tell them apart.
 */
export function toCsv(
  columns: DataColumnMeta[],
  rows: DataCell[][],
  options: CsvOptions = {}
): string {
  const delimiter = options.delimiter ?? ','
  const nullText = options.nullText ?? ''
  const field = (text: string): string =>
    text === '' || text.includes(delimiter) || /["\r\n]/.test(text) || /^\s|\s$/.test(text)
      ? `"${text.replace(/"/g, '""')}"`
      : text
  const lines: string[] = []
  if (options.header !== false) lines.push(columns.map((c) => field(c.name)).join(delimiter))
  for (const row of rows) {
    lines.push(
      columns
        .map((_, i) => {
          const cell = row[i]
          return cell === null || cell === undefined ? nullText : field(cellToText(cell))
        })
        .join(delimiter)
    )
  }
  return (options.bom ? '﻿' : '') + lines.join('\r\n') + (lines.length ? '\r\n' : '')
}

/** Unique keys for duplicate column names (`id`, `id_2`, ...). */
export function uniqueColumnKeys(columns: DataColumnMeta[]): string[] {
  const seen = new Map<string, number>()
  return columns.map((c) => {
    const n = (seen.get(c.name) ?? 0) + 1
    seen.set(c.name, n)
    return n === 1 ? c.name : `${c.name}_${n}`
  })
}

const jsonValue = (cell: DataCell | undefined, column: DataColumnMeta): unknown => {
  if (cell === null || cell === undefined) return null
  if (isBinaryCell(cell)) return `0x${cell.hex}${isCompleteBinary(cell) ? '' : '…'}`
  // JSON columns arrive as their JSON text: nest them as values when the type says JSON.
  if (typeof cell === 'string' && /json/i.test(column.type ?? '')) {
    const parsed = tryParseJson(cell)
    if (parsed !== undefined) return parsed
  }
  return cell
}

/** A JSON array of row objects keyed by column name. */
export function toJson(
  columns: DataColumnMeta[],
  rows: DataCell[][],
  options: { pretty?: boolean } = {}
): string {
  const keys = uniqueColumnKeys(columns)
  const objects = rows.map((row) => rowObject(keys, columns, row))
  return JSON.stringify(objects, null, options.pretty === false ? undefined : 2)
}

const rowObject = (
  keys: string[],
  columns: DataColumnMeta[],
  row: DataCell[]
): Record<string, unknown> =>
  Object.fromEntries(keys.map((key, i) => [key, jsonValue(row[i], columns[i])]))

/** One row as a pretty-printed JSON object (the row detail panel's "Copy row"). */
export function rowToJson(columns: DataColumnMeta[], row: DataCell[]): string {
  return JSON.stringify(rowObject(uniqueColumnKeys(columns), columns, row), null, 2)
}

export interface SqlInsertOptions {
  dialect: SqlDialect
  /** Target table; defaults to the first column's source table, else `table_name`. */
  table?: { database?: string; schema?: string; name: string } | string
  /** Rows per INSERT statement (default 1: one statement per row). */
  batchSize?: number
}

const literal = (cell: DataCell | undefined, dialect: SqlDialect): string => {
  try {
    return quoteSqlLiteral(cell, dialect)
  } catch {
    // A binary preview cannot be written back faithfully: never emit a truncated value.
    return 'NULL /* binary value truncated in the result */'
  }
}

/** `INSERT INTO t (cols) VALUES (...);` statements for the rows. */
export function toSqlInserts(
  columns: DataColumnMeta[],
  rows: DataCell[][],
  options: SqlInsertOptions
): string {
  const { dialect } = options
  const target =
    typeof options.table === 'string'
      ? quoteSqlIdentifier(options.table, dialect)
      : options.table
        ? qualifiedSqlName(options.table, dialect)
        : columns[0]?.table
          ? qualifiedSqlName(
              { name: columns[0].table, schema: columns[0].schema, database: columns[0].database },
              dialect
            )
          : 'table_name'
  const head = `INSERT INTO ${target} (${columns.map((c) => quoteSqlIdentifier(c.name, dialect)).join(', ')}) VALUES`
  // MySQL BIT wider than 53 bits arrives as exact decimal text: quoted, '6' would be the byte 0x36.
  const bit = columns.map(
    (c) => (dialect === 'mysql' || dialect === 'mariadb') && /^bit\b/i.test(c.type ?? '')
  )
  const value = (cell: DataCell, c: number): string =>
    bit[c] && typeof cell === 'string' && /^\d+$/.test(cell) ? cell : literal(cell, dialect)
  const batch = Math.max(1, options.batchSize ?? 1)
  const statements: string[] = []
  for (let i = 0; i < rows.length; i += batch) {
    const values = rows
      .slice(i, i + batch)
      .map((row) => `(${columns.map((_, c) => value(row[c], c)).join(', ')})`)
    statements.push(batch === 1 ? `${head} ${values[0]};` : `${head}\n  ${values.join(',\n  ')};`)
  }
  return statements.join('\n')
}

/** A GitHub-flavoured Markdown table. */
export function toMarkdown(columns: DataColumnMeta[], rows: DataCell[][]): string {
  const esc = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const lines = [
    `| ${columns.map((c) => esc(c.name)).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`
  ]
  for (const row of rows) {
    lines.push(
      `| ${columns.map((_, i) => (row[i] === null || row[i] === undefined ? 'NULL' : esc(cellToText(row[i])))).join(' | ')} |`
    )
  }
  return lines.join('\n')
}

export type CopyFormat = 'tsv' | 'csv' | 'json' | 'sql' | 'markdown'

/** One dispatcher for menus. */
export function formatRows(
  format: CopyFormat,
  columns: DataColumnMeta[],
  rows: DataCell[][],
  options: { dialect?: SqlDialect; table?: SqlInsertOptions['table']; header?: boolean } = {}
): string {
  switch (format) {
    case 'tsv':
      return toTsv(columns, rows, { header: options.header })
    case 'csv':
      return toCsv(columns, rows, { header: options.header ?? true })
    case 'json':
      return toJson(columns, rows)
    case 'sql':
      return toSqlInserts(columns, rows, {
        dialect: options.dialect ?? 'postgres',
        table: options.table
      })
    case 'markdown':
      return toMarkdown(columns, rows)
  }
}
