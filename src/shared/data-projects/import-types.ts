// Data import contract: a CSV/TSV file into an existing SQL table, or a JSON array / NDJSON /
// CSV file into a MongoDB collection (`dataProjects.import.*`, server: main/services/
// data-projects/import.ts, renderer: components/data-projects/import/). Pure types, constants
// and two tiny pure helpers shared by both sides; no Node or DOM imports.
//
// The flow: `preview` reads the head of the file (detects encoding, format, delimiter, header)
// and returns the first rows plus the target's columns; the renderer maps file columns to table
// columns (or Mongo fields and types); `start` scans the whole file once (row count and
// structural errors, streamed, never loaded whole), passes the safety gate as one INSERT /
// insertMany of N rows, then streams the rows again in batches. Progress events go out on
// DATA_IMPORT_CHANNEL; `cancel` stops between batches and interrupts the running SQL statement.
// A MongoDB insertMany in flight finishes first, so its count stays exact; a second `cancel`
// kills it (its documents are then counted when that can be known, else `rowsUncertain`).

import type { DataColumnInfo, DataExecutionPlan, DataObjectRef } from './types'

export const DATA_IMPORT_CHANNEL = 'dataProjects:import'

/** `csv` covers TSV and other delimiters; `json` = one top-level array of documents. */
export const DATA_IMPORT_FORMATS = ['csv', 'json', 'ndjson'] as const
export type DataImportFormat = (typeof DATA_IMPORT_FORMATS)[number]

/** Text encodings the server can decode (WHATWG labels; a BOM always wins for UTF-8/16). */
export const DATA_IMPORT_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'] as const
export type DataImportEncoding = (typeof DATA_IMPORT_ENCODINGS)[number]

export const DATA_IMPORT_ENCODING_LABELS: Readonly<Record<DataImportEncoding, string>> = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'windows-1252': 'Windows-1252 (Latin-1)'
}

/** Quote character of a CSV file; '' = no quoting (every quote is a plain character). */
export type DataImportQuote = '"' | "'" | ''

export interface DataImportCsvOptions {
  /** One character (',', ';', '\t', '|', or any other single character). */
  delimiter: string
  quote: DataImportQuote
  /** The first record holds the column names (and is not imported). */
  header: boolean
}

export type DataImportTarget =
  | { kind: 'table'; ref: DataObjectRef }
  | { kind: 'collection'; database: string; collection: string }

/**
 * What an EMPTY, UNQUOTED CSV field becomes. A quoted empty field (`""`) is always the empty
 * string, so files written by our own export (NULL = empty, '' = `""`) round-trip. In a
 * one-column file imported into a table a blank line is such a field (that is how a NULL row is
 * written); elsewhere blank lines are skipped.
 * - `null`  NULL (SQL) / null (Mongo)
 * - `empty` the empty string
 * - `omit`  Mongo only: the field is left out of the document
 */
export type DataImportEmptyMode = 'null' | 'empty' | 'omit'

/**
 * - `rollback` all or nothing: one transaction, any failure rolls everything back
 *              (MySQL/MariaDB/PostgreSQL/SQLite only)
 * - `stop`     stop at the first failing row; rows imported before it stay
 * - `skip`     skip failing rows, import the rest, report the failures
 */
export type DataImportOnError = 'rollback' | 'stop' | 'skip'

/**
 * Mongo CSV column types. `auto` converts each value on its own (numbers, true/false, ISO dates,
 * 24-digit ObjectId hex; numbers with a leading zero stay text). `number` is what mongoimport
 * and Extended JSON do with a plain number: Int32 when it fits, else Int64, else Double. The
 * others convert every value of the column or report the row.
 */
export const MONGO_IMPORT_TYPES = [
  'auto',
  'string',
  'number',
  'int32',
  'int64',
  'double',
  'decimal',
  'boolean',
  'date',
  'objectId'
] as const
export type MongoImportFieldType = (typeof MONGO_IMPORT_TYPES)[number]

export const MONGO_IMPORT_TYPE_LABELS: Readonly<Record<MongoImportFieldType, string>> = {
  auto: 'Auto (per value)',
  string: 'String',
  number: 'Number',
  int32: 'Int32',
  int64: 'Int64 (Long)',
  double: 'Double',
  decimal: 'Decimal128',
  boolean: 'Boolean',
  date: 'Date',
  objectId: 'ObjectId'
}

/**
 * Field-path parts a Mongo CSV import refuses (`__proto__.x`, `a.constructor`…): in JavaScript
 * they name an object's prototype, so they are never document fields here.
 */
export const MONGO_IMPORT_RESERVED_FIELD_NAMES: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype'
]

export interface DataImportColumnMapping {
  /** 0-based index of the file column. */
  source: number
  /** SQL: the table column. Mongo CSV: the field path (`address.city` nests). */
  target: string
  /** Mongo CSV only (default `string`). */
  type?: MongoImportFieldType
}

/** Default rows per INSERT / insertMany, and the cap. */
export const DATA_IMPORT_SQL_BATCH_ROWS = 500
export const DATA_IMPORT_MONGO_BATCH_ROWS = 1000
export const DATA_IMPORT_MAX_BATCH_ROWS = 10_000
/** Preview rows returned by default, and the cap. */
export const DATA_IMPORT_PREVIEW_ROWS = 50
export const DATA_IMPORT_MAX_PREVIEW_ROWS = 500
/** Row errors kept in a report (the total is always counted). */
export const DATA_IMPORT_MAX_REPORTED_ERRORS = 100

export interface DataImportPreviewRequest {
  dataProjectId: string
  /** Absolute path of a local file (picked in the native open panel or dropped). */
  filePath: string
  target: DataImportTarget
  /** Overrides; omitted = detected. */
  format?: DataImportFormat
  encoding?: DataImportEncoding
  csv?: Partial<DataImportCsvOptions>
  /** Rows to return (default DATA_IMPORT_PREVIEW_ROWS). */
  limit?: number
}

export interface DataImportPreviewResponse {
  fileName: string
  fileSize: number
  /** Effective settings (overrides applied). */
  format: DataImportFormat
  encoding: DataImportEncoding
  /** null for JSON formats. */
  csv: DataImportCsvOptions | null
  /** What detection alone chose (the UI marks these "detected"). */
  detected: {
    format: DataImportFormat
    encoding: DataImportEncoding
    csv: DataImportCsvOptions | null
  }
  /**
   * File columns: the header's names (or "Column 1"…); JSON formats: the top-level keys of the
   * sampled documents.
   */
  columns: string[]
  /**
   * The first rows. CSV: raw field text, null = an empty unquoted field. JSON formats (display
   * only): strings as they are, other values as relaxed Extended JSON, null = absent or null.
   */
  rows: Array<Array<string | null>>
  /** Line where each preview row starts (1-based). */
  lines: number[]
  /** More data follows the preview rows. */
  more: boolean
  /** Mongo CSV: the type detection suggests per column (from up to 500 sampled rows). */
  inferredTypes?: MongoImportFieldType[]
  /** SQL: the target table's columns (the mapping targets). */
  tableColumns?: DataColumnInfo[]
  /** `rollback` (one transaction) is available for this target. */
  supportsTransaction: boolean
  /** Why it is not, for the UI. */
  transactionNote?: string
  /** Non-fatal notes ("Invalid UTF-8: decoded as Windows-1252", "Row 12 has 3 fields"…). */
  warnings: string[]
}

export interface DataImportStartRequest {
  dataProjectId: string
  /** Client-generated UUID for progress events and cancel. */
  importId: string
  filePath: string
  target: DataImportTarget
  format: DataImportFormat
  encoding: DataImportEncoding
  /** Required for CSV. */
  csv?: DataImportCsvOptions
  /** CSV only (SQL and Mongo); JSON formats import whole documents. */
  columns?: DataImportColumnMapping[]
  empty: DataImportEmptyMode
  onError: DataImportOnError
  /** Rows per INSERT / insertMany (default per engine family, max DATA_IMPORT_MAX_BATCH_ROWS). */
  batchSize?: number
  /** Token from a previous `confirmation_required` answer for exactly this request. */
  confirmToken?: string
}

export interface DataImportRowError {
  /** 1-based data row (CSV: after the header; JSON: document number). */
  row: number
  /** Last row of the range when a whole batch failed and no single row could be isolated. */
  rowTo?: number
  /** 1-based line where the row starts, when known. */
  line: number | null
  message: string
}

export interface DataImportSummary {
  /** Data rows / documents read from the file. */
  rowsRead: number
  /** Rows that are in the database now (committed). */
  rowsImported: number
  /**
   * Rows of a batch that was interrupted (a forced cancel, a lost connection) whose outcome is
   * unknown: between `rowsImported` and `rowsImported + rowsUncertain` rows are in the
   * database. Absent when every row is accounted for.
   */
  rowsUncertain?: number
  /** Rows left out (skip mode, malformed rows). */
  rowsSkipped: number
  /** Total failures; `errors` keeps the first DATA_IMPORT_MAX_REPORTED_ERRORS. */
  errorCount: number
  errors: DataImportRowError[]
  durationMs: number
  /** The transaction was rolled back (nothing of this import stayed). */
  rolledBack: boolean
}

export type DataImportResponse =
  | ({ status: 'ok' } & DataImportSummary)
  /** Stopped by a failure; `message` says why, `rowsImported` how many stayed. */
  | ({ status: 'failed'; message: string } & DataImportSummary)
  | ({ status: 'cancelled' } & DataImportSummary)
  /** Nothing ran. Show the plan; re-send the same request with `confirmToken` to run it. */
  | { status: 'confirmation_required'; plan: DataExecutionPlan; confirmToken: string }
  /** Nothing ran (read-only mode). */
  | { status: 'blocked'; plan: DataExecutionPlan; reason: string }

export interface DataImportProgressEvent {
  importId: string
  /** `scanning` = counting and checking rows before anything is written. */
  phase: 'scanning' | 'importing'
  bytesRead: number
  totalBytes: number
  rowsRead: number
  rowsImported: number
  /** Rows to import (known once the scan finished). */
  totalRows: number | null
  done: boolean
  error?: string
}

export const isDataImportProgressEvent = (value: unknown): value is DataImportProgressEvent =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as DataImportProgressEvent).importId === 'string' &&
  typeof (value as DataImportProgressEvent).rowsRead === 'number'

/**
 * Name key for auto-mapping file columns to table columns: case-, space-, dash- and
 * underscore-insensitive ("First Name" ↔ first_name).
 */
export const importNameKey = (name: string): string =>
  name
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-.]+/g, '')

/** "Column 1", "Column 2"… for files without a header (and header cells that are empty). */
export const importColumnLabel = (index: number): string => `Column ${index + 1}`
