// Pure pieces of the import dialog: auto-mapping file columns to table columns (or Mongo
// fields), the checks that keep Import disabled, the start request, progress and result texts.
// The server re-validates everything; these only make the dialog honest before it asks.

import {
  DATA_IMPORT_ENCODING_LABELS,
  MONGO_IMPORT_RESERVED_FIELD_NAMES,
  importNameKey,
  type DataImportColumnMapping,
  type DataImportCsvOptions,
  type DataImportEmptyMode,
  type DataImportEncoding,
  type DataImportFormat,
  type DataImportOnError,
  type DataImportPreviewResponse,
  type DataImportProgressEvent,
  type DataImportQuote,
  type DataImportResponse,
  type DataImportRowError,
  type DataImportStartRequest,
  type DataImportTarget,
  type MongoImportFieldType
} from '@shared/data-projects/import-types'
import type { DataColumnInfo, SqlDialect } from '@shared/data-projects/types'

export type ImportFamily = 'sql' | 'document'

export const familyOfTarget = (target: DataImportTarget): ImportFamily =>
  target.kind === 'table' ? 'sql' : 'document'

/** `accept` of the file input (the native open panel's filter). */
export const importAccept = (family: ImportFamily): string =>
  family === 'sql'
    ? '.csv,.tsv,.tab,.psv,.txt,text/csv,text/tab-separated-values,text/plain'
    : '.json,.ndjson,.jsonl,.csv,.tsv,.txt,application/json,application/x-ndjson,text/csv,text/plain'

export const FORMAT_LABELS: Readonly<Record<DataImportFormat, string>> = {
  csv: 'CSV / TSV',
  json: 'JSON array',
  ndjson: 'NDJSON (one document per line)'
}

export const ENCODING_LABELS = DATA_IMPORT_ENCODING_LABELS

export const DELIMITER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe  |' }
]

export const delimiterLabel = (delimiter: string): string =>
  DELIMITER_OPTIONS.find((o) => o.value === delimiter)?.label ??
  (delimiter === ' ' ? 'Space' : `"${delimiter}"`)

export const QUOTE_OPTIONS: ReadonlyArray<{ value: DataImportQuote; label: string }> = [
  { value: '"', label: 'Double  "' },
  { value: "'", label: "Single  '" },
  { value: '', label: 'None' }
]

export const ON_ERROR_LABELS: Readonly<Record<DataImportOnError, string>> = {
  rollback: 'All or nothing (one transaction)',
  stop: 'Stop at the first error',
  skip: 'Skip failing rows'
}

export const defaultOnError = (preview: Pick<DataImportPreviewResponse, 'supportsTransaction'>) =>
  preview.supportsTransaction ? ('rollback' as const) : ('stop' as const)

export const defaultEmpty = (family: ImportFamily): DataImportEmptyMode =>
  family === 'sql' ? 'null' : 'omit'

// ---------------------------------------------------------------------------------------------
// SQL mapping
// ---------------------------------------------------------------------------------------------

/**
 * Table column per file column (null = skip). With a header: by name (exact first, then
 * case/space/underscore-insensitive), each table column used once. Without one: by position.
 */
export function autoMapSql(
  fileColumns: readonly string[],
  tableColumns: readonly DataColumnInfo[],
  header: boolean
): Array<string | null> {
  const ordered = [...tableColumns].sort((a, b) => a.ordinal - b.ordinal)
  if (!header) return fileColumns.map((_, i) => ordered[i]?.name ?? null)
  const used = new Set<string>()
  const result: Array<string | null> = fileColumns.map(() => null)
  // Exact names first, so "Name" does not steal the column an exact "name" wants.
  fileColumns.forEach((name, i) => {
    const exact = ordered.find((c) => c.name === name.trim())
    if (exact && !used.has(exact.name)) {
      result[i] = exact.name
      used.add(exact.name)
    }
  })
  fileColumns.forEach((name, i) => {
    if (result[i] !== null) return
    const key = importNameKey(name)
    const match = ordered.find((c) => !used.has(c.name) && importNameKey(c.name) === key)
    if (match) {
      result[i] = match.name
      used.add(match.name)
    }
  })
  return result
}

export interface ImportIssue {
  level: 'error' | 'warning'
  text: string
}

/** A column the INSERT must give a value for (NOT NULL, no default, not generated). */
export function isRequiredColumn(column: DataColumnInfo, dialect: SqlDialect): boolean {
  if (dialect === 'clickhouse') return false // non-Nullable columns get their type's default
  if (column.nullable || column.autoIncrement) return false
  if (column.defaultValue !== undefined && column.defaultValue !== null) return false
  if (/generated|identity|auto_increment|nextval/i.test(`${column.extra ?? ''}`)) return false
  // SQLite: INTEGER PRIMARY KEY is the rowid and fills itself.
  if (dialect === 'sqlite' && column.isPrimaryKey && /^integer$/i.test(column.type.trim()))
    return false
  return true
}

export function sqlMappingIssues(
  targets: ReadonlyArray<string | null>,
  tableColumns: readonly DataColumnInfo[],
  dialect: SqlDialect
): ImportIssue[] {
  const issues: ImportIssue[] = []
  const mapped = targets.filter((t): t is string => !!t)
  if (mapped.length === 0) {
    issues.push({ level: 'error', text: 'Map at least one file column to a table column.' })
    return issues
  }
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const t of mapped) {
    if (seen.has(t)) dupes.add(t)
    seen.add(t)
  }
  for (const d of dupes)
    issues.push({ level: 'error', text: `"${d}" is mapped from more than one file column.` })
  const missing = tableColumns.filter((c) => !seen.has(c.name) && isRequiredColumn(c, dialect))
  if (missing.length > 0) {
    issues.push({
      level: 'warning',
      text: `Not mapped but required (NOT NULL, no default): ${missing.map((c) => c.name).join(', ')}. Rows will fail unless the database fills them.`
    })
  }
  return issues
}

// ---------------------------------------------------------------------------------------------
// Mongo fields
// ---------------------------------------------------------------------------------------------

export interface MongoFieldDraft {
  include: boolean
  /** Field path; dots nest. */
  name: string
  type: MongoImportFieldType
}

export const defaultFieldName = (column: string, index: number, header: boolean): string =>
  header && column.trim() ? column.trim() : `field${index + 1}`

export function autoMongoFields(
  columns: readonly string[],
  inferred: readonly MongoImportFieldType[] | undefined,
  header: boolean,
  detectTypes: boolean
): MongoFieldDraft[] {
  return columns.map((column, i) => ({
    include: true,
    name: defaultFieldName(column, i, header),
    type: detectTypes ? (inferred?.[i] ?? 'string') : 'string'
  }))
}

export function mongoFieldIssues(fields: readonly MongoFieldDraft[]): ImportIssue[] {
  const issues: ImportIssue[] = []
  const included = fields.filter((f) => f.include)
  if (included.length === 0) {
    issues.push({ level: 'error', text: 'Include at least one column.' })
    return issues
  }
  const paths: string[][] = []
  for (const f of included) {
    const name = f.name.trim()
    if (!name) {
      issues.push({ level: 'error', text: 'A field name is empty.' })
      continue
    }
    const segments = name.split('.')
    if (segments.some((s) => !s)) {
      issues.push({ level: 'error', text: `"${name}" has an empty part.` })
      continue
    }
    if (segments.some((s) => s.startsWith('$'))) {
      issues.push({ level: 'error', text: `"${name}": field names cannot start with "$".` })
      continue
    }
    const reserved = segments.find((s) => MONGO_IMPORT_RESERVED_FIELD_NAMES.includes(s))
    if (reserved !== undefined) {
      issues.push({
        level: 'error',
        text: `"${name}": "${reserved}" cannot be a field name here. Rename the field.`
      })
      continue
    }
    paths.push(segments)
  }
  const keys = new Set<string>()
  for (const p of paths) {
    const key = p.join('.')
    if (keys.has(key)) issues.push({ level: 'error', text: `"${key}" is written by two columns.` })
    keys.add(key)
  }
  for (const a of paths)
    for (const b of paths)
      if (a.length < b.length && a.every((s, i) => b[i] === s))
        issues.push({
          level: 'error',
          text: `"${a.join('.')}" cannot hold a value and "${b.join('.')}" at once.`
        })
  return issues
}

// ---------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------

export interface ImportDraft {
  filePath: string
  target: DataImportTarget
  format: DataImportFormat
  encoding: DataImportEncoding
  csv: DataImportCsvOptions | null
  sqlTargets: ReadonlyArray<string | null>
  mongoFields: readonly MongoFieldDraft[]
  empty: DataImportEmptyMode
  onError: DataImportOnError
}

export function buildStartRequest(
  dataProjectId: string,
  importId: string,
  draft: ImportDraft
): DataImportStartRequest {
  const request: DataImportStartRequest = {
    dataProjectId,
    importId,
    filePath: draft.filePath,
    target: draft.target,
    format: draft.format,
    encoding: draft.encoding,
    empty: draft.empty,
    onError: draft.onError
  }
  if (draft.format === 'csv' && draft.csv) {
    request.csv = draft.csv
    let columns: DataImportColumnMapping[]
    if (draft.target.kind === 'table') {
      columns = draft.sqlTargets.flatMap((target, source) => (target ? [{ source, target }] : []))
    } else {
      columns = draft.mongoFields.flatMap((f, source) =>
        f.include ? [{ source, target: f.name.trim(), type: f.type }] : []
      )
    }
    request.columns = columns
  }
  return request
}

// ---------------------------------------------------------------------------------------------
// Progress and results
// ---------------------------------------------------------------------------------------------

const nf = new Intl.NumberFormat('en-US')
export const fmt = (n: number): string => nf.format(n)

export const unitOf = (family: ImportFamily, n: number): string =>
  family === 'sql' ? (n === 1 ? 'row' : 'rows') : n === 1 ? 'document' : 'documents'

/** 0..1 of the current phase (rows when the total is known, else bytes); null = unknown. */
export function progressFraction(event: DataImportProgressEvent | null): number | null {
  if (!event) return null
  if (event.phase === 'importing' && event.totalRows)
    return Math.min(1, event.rowsImported / event.totalRows)
  if (event.totalBytes > 0) return Math.min(1, event.bytesRead / event.totalBytes)
  return null
}

export function progressText(event: DataImportProgressEvent | null, family: ImportFamily): string {
  if (!event) return 'Starting…'
  if (event.phase === 'scanning') {
    return `Checking the file… ${fmt(event.rowsRead)} ${unitOf(family, event.rowsRead)} read`
  }
  const total = event.totalRows
  return total
    ? `Importing… ${fmt(event.rowsImported)} of ${fmt(total)} ${unitOf(family, total)}`
    : `Importing… ${fmt(event.rowsImported)} ${unitOf(family, event.rowsImported)}`
}

export type FinishedResponse = Extract<
  DataImportResponse,
  { status: 'ok' | 'failed' | 'cancelled' }
>

/**
 * How many rows are in: "12", or "12–40" when an interrupted batch may be partly written
 * (`rowsUncertain`).
 */
export const importedCountText = (
  response: Pick<FinishedResponse, 'rowsImported' | 'rowsUncertain'>
): string =>
  response.rowsUncertain
    ? `${fmt(response.rowsImported)}–${fmt(response.rowsImported + response.rowsUncertain)}`
    : fmt(response.rowsImported)

/** Rows of this import may be in the target (also when the count is uncertain). */
export const mayHaveImported = (
  response: Pick<FinishedResponse, 'rowsImported' | 'rowsUncertain'>
): boolean => response.rowsImported > 0 || (response.rowsUncertain ?? 0) > 0

export const rowErrorLabel = (e: DataImportRowError): string => {
  const rows = e.rowTo && e.rowTo !== e.row ? `${fmt(e.row)}–${fmt(e.rowTo)}` : fmt(e.row)
  return e.line ? `${rows} (line ${fmt(e.line)})` : rows
}

/** Headline of a finished import. */
export function resultTitle(
  response: FinishedResponse,
  family: ImportFamily,
  targetName: string
): { tone: 'ok' | 'warning' | 'error'; title: string } {
  const n = response.rowsImported
  switch (response.status) {
    case 'ok':
      return response.errorCount > 0
        ? {
            tone: 'warning',
            title: `Imported ${fmt(n)} ${unitOf(family, n)} into ${targetName}; ${fmt(response.rowsSkipped)} skipped`
          }
        : { tone: 'ok', title: `Imported ${fmt(n)} ${unitOf(family, n)} into ${targetName}` }
    case 'cancelled': {
      if (response.rolledBack)
        return { tone: 'warning', title: 'Import cancelled: nothing was imported (rolled back)' }
      const most = n + (response.rowsUncertain ?? 0)
      return {
        tone: 'warning',
        title: response.rowsUncertain
          ? `Import cancelled: ${importedCountText(response)} ${unitOf(family, most)} were imported before the cancel (the batch in flight was interrupted and may be partly written)`
          : `Import cancelled: ${fmt(n)} ${unitOf(family, n)} ${n === 1 ? 'was' : 'were'} imported before the cancel`
      }
    }
    default:
      return { tone: 'error', title: response.message }
  }
}

/** Plain-text report for the clipboard. */
export function reportText(
  response: FinishedResponse,
  family: ImportFamily,
  fileName: string,
  targetName: string
): string {
  const lines = [
    `Import of ${fileName} into ${targetName}: ${response.status}`,
    resultTitle(response, family, targetName).title,
    `Read ${fmt(response.rowsRead)}, imported ${importedCountText(response)}, skipped ${fmt(response.rowsSkipped)}, errors ${fmt(response.errorCount)}${response.rolledBack ? ', rolled back' : ''}.`
  ]
  if (response.errors.length > 0) {
    lines.push('')
    for (const e of response.errors) lines.push(`Row ${rowErrorLabel(e)}: ${e.message}`)
    if (response.errorCount > response.errors.length)
      lines.push(`… and ${fmt(response.errorCount - response.errors.length)} more`)
  }
  return lines.join('\n')
}

/** Display name of a target ("shop.orders", "public.orders", "orders"). */
export function targetDisplayName(target: DataImportTarget, dialect: SqlDialect | null): string {
  if (target.kind === 'collection') return `${target.database}.${target.collection}`
  const qualifier = dialect === 'postgres' ? target.ref.schema : target.ref.database
  return qualifier && dialect !== 'sqlite' ? `${qualifier}.${target.ref.name}` : target.ref.name
}

/** A file column's display of a preview cell. */
export function cellDisplay(
  value: string | null,
  options: { family: ImportFamily; format: DataImportFormat; empty: DataImportEmptyMode }
): { text: string; kind: 'value' | 'null' | 'empty' | 'omitted' } {
  if (value === null) {
    if (options.format !== 'csv') return { text: '—', kind: 'omitted' }
    if (options.empty === 'null') return { text: 'NULL', kind: 'null' }
    if (options.empty === 'omit') return { text: '—', kind: 'omitted' }
    return { text: '""', kind: 'empty' }
  }
  if (value === '') return { text: '""', kind: 'empty' }
  return { text: value.replace(/\r\n|\r|\n/g, '↵'), kind: 'value' }
}

/** Short identifier for an import (progress events and cancel). */
export const newImportId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path
