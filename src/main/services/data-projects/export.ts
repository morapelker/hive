// Full exports (no auto-limit, no hard cap) of a table, a query or a Mongo collection/pipeline to
// CSV (RFC 4180), JSON (one streamed array) or SQL (multi-row INSERTs).
//
// CSV keeps NULL and the empty string apart the way PostgreSQL's COPY … CSV does: NULL is an
// empty unquoted field, '' is `""`. MySQL/MariaDB SQL exports write string literals for the
// session's NO_BACKSLASH_ESCAPES mode (and say so in the file when backslashes are literal).
//
// Rows come from DataDriver.streamRows, which runs on its own connection (the editor session
// stays usable) inside the read-only sandbox, in batches with backpressure: a batch is written
// (and the write stream drained) before the driver reads the next one, so memory stays flat for
// any table size. The file is written next to its destination as a hidden `.part` file and
// renamed into place only when complete; a failure or cancel deletes it. Progress events go out
// on DATA_EXPORT_CHANNEL at most every 250 ms, plus a final `done` event.
//
// Safety: only reads are exportable. A query source is split and classified; anything that is
// not exactly one read statement is blocked (writes) or refused (several statements), and reads
// still pass the safety gate (safe mode confirms, dangerous reads confirm) with the usual
// confirm-token round trip. Table sources are generated SELECTs with the table view's filters
// (AND or OR, `filterJoin`), sort and raw WHERE (checked like tableRows). The console log files
// the streamed statement under 'export'.

import { createWriteStream, type WriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import {
  DATA_EXPORT_CHANNEL,
  sqlDialectOf,
  type DataCell,
  type DataExportFormat,
  type DataExportProgressEvent,
  type DataExportRequest,
  type DataExportResponse,
  type DataExportSource,
  type SqlDialect
} from '../../../shared/data-projects/types'
import { quoteSqlIdentifier, quoteSqlLiteral, type SqlQuoteOptions } from '../../../shared/sql'
import { classifyMongoShellStatement } from '../../../shared/data-projects/mongo-shell'
import {
  DataDriverError,
  type DataCallContext,
  type DataProjectRecord,
  type SafetyEvaluationInput
} from './contracts'
import type { ConnectionManager, EngineLogger } from './connection-manager'
import { noopLogger } from './connection-manager'
import { cellToText, safeJsonText, toCell } from './cells'
import { planStatements, toSafetyStatements } from './query-runner'
import type { SafetyGate } from './safety-gate'
import { assertSingleRead, buildSelectSql, sqlTextOptions } from './table-ops'
import { busyError, errorMessage, invalidInputError, unsupportedError } from './redact'
import { withConsoleSource } from './console-log'

const PROGRESS_INTERVAL_MS = 250
const SQL_ROWS_PER_INSERT = 100

/** Mongo JSON exports stream one relaxed-EJSON document per row in this single column. */
const MONGO_EJSON_COLUMN = '__ejson__'

export interface ExportDeps {
  manager: ConnectionManager
  gate: SafetyGate
  registry: ExportRegistry
  getRecord(id: string): DataProjectRecord
  publish(channel: string, payload: unknown): void
  showSaveDialog(input: { defaultName: string; extensions: string[] }): Promise<string | null>
  /** Builds the MongoDriver.streamRows statement (mongo/export.ts `mongoExportStatement`). */
  mongoExportStatement?(
    source: DataExportSource,
    format: DataExportFormat
  ): string | Promise<string>
  now?: () => number
  logger?: EngineLogger
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

interface RunningExport {
  clientId: string | null
  projectId: string
  controller: AbortController
}

export class ExportRegistry {
  private readonly exports = new Map<string, RunningExport>()

  register(exportId: string, entry: RunningExport): () => void {
    if (!exportId) throw invalidInputError('An export id is required.')
    if (this.exports.has(exportId)) throw busyError('An export with this id is already running.')
    this.exports.set(exportId, entry)
    return () => {
      if (this.exports.get(exportId) === entry) this.exports.delete(exportId)
    }
  }

  cancel(exportId: string): boolean {
    const entry = this.exports.get(exportId)
    if (!entry) return false
    entry.controller.abort()
    return true
  }

  releaseClient(clientId: string): void {
    for (const entry of this.exports.values())
      if (entry.clientId === clientId) entry.controller.abort()
  }

  cancelProject(projectId: string): void {
    for (const entry of this.exports.values())
      if (entry.projectId === projectId) entry.controller.abort()
  }

  cancelAll(): void {
    for (const entry of this.exports.values()) entry.controller.abort()
  }

  get size(): number {
    return this.exports.size
  }
}

// ---------------------------------------------------------------------------------------------
// Formatters (pure; unit-tested)
// ---------------------------------------------------------------------------------------------

/**
 * One CSV field (RFC 4180): quoted when it contains the delimiter, a quote, CR or LF. NULL is an
 * empty unquoted field and the empty string is `""`, so a re-import can tell them apart.
 */
export function csvField(value: unknown, delimiter: string): string {
  const cell = toCell(value, { binaryPreviewBytes: Infinity })
  if (cell === null) return ''
  const text = typeof cell === 'object' ? (cellToText(cell) ?? '') : String(cell)
  if (text === '') return '""'
  if (
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return `"${text.replace(/"/g, '""')}"`
  }
  // A leading/trailing space would be trimmed by some readers: quote it to keep it.
  if (text.length > 0 && (text[0] === ' ' || text[text.length - 1] === ' ')) return `"${text}"`
  return text
}

export function csvLine(values: readonly unknown[], delimiter: string): string {
  return `${values.map((v) => csvField(v, delimiter)).join(delimiter)}\r\n`
}

/** Unique object keys for JSON rows (`id`, `id_2`, ...). */
export function uniqueKeys(columns: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return columns.map((name) => {
    const base = name || 'column'
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}_${n}`
  })
}

/** A JSON-ready value: exact strings stay strings, binary becomes hex. */
const jsonValue = (value: unknown): unknown => {
  const cell = toCell(value, { binaryPreviewBytes: Infinity })
  if (cell !== null && typeof cell === 'object') return cellToText(cell)
  return cell
}

export function jsonRow(keys: readonly string[], values: readonly unknown[]): string {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < keys.length; i++) obj[keys[i]] = jsonValue(values[i])
  return safeJsonText(obj)
}

/**
 * MySQL/MariaDB BIT columns of a result, by index, from the driver's column type names. Their
 * values must not be written as quoted text: '5' would store the byte 0x35 (53).
 */
const bitColumnIndexes = (
  dialect: SqlDialect,
  columnTypes: readonly string[] | undefined
): ReadonlySet<number> => {
  const out = new Set<number>()
  if ((dialect !== 'mysql' && dialect !== 'mariadb') || !columnTypes) return out
  columnTypes.forEach((type, i) => {
    if (/^bit\b/i.test(type.trim())) out.add(i)
  })
  return out
}

/**
 * `INSERT INTO t (a, b) VALUES\n  (…),\n  (…);\n` for a batch of rows. `quote`: the MySQL/MariaDB
 * backslash mode the literals are written for (sqlTextOptions). `columnTypes`: the driver's type
 * names, when it gives them: a MySQL BIT value wider than 53 bits arrives as exact decimal text
 * and is written as an unquoted integer, which stores those bits (BIT ≤ 53 arrives as a number).
 */
export function sqlInsert(
  dialect: SqlDialect,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
  quote: SqlQuoteOptions = {},
  columnTypes?: readonly string[]
): string {
  if (rows.length === 0) return ''
  const cols = columns.map((c) => quoteSqlIdentifier(c, dialect)).join(', ')
  const bits = bitColumnIndexes(dialect, columnTypes)
  const literal = (value: unknown, index: number): string => {
    const cell = toCell(value, { binaryPreviewBytes: Infinity }) as DataCell
    if (bits.has(index) && typeof cell === 'string' && /^\d+$/.test(cell)) return cell
    return quoteSqlLiteral(cell, dialect, quote)
  }
  const values = rows.map((row) => `  (${row.map(literal).join(', ')})`).join(',\n')
  return `INSERT INTO ${quoteSqlIdentifier(table, dialect)} (${cols}) VALUES\n${values};\n`
}

/** Incremental writer for one format. */
export class ExportFormatter {
  private keys: string[] | null = null
  private columns: string[] = []
  private columnTypes: readonly string[] | undefined
  private rowsWritten = 0
  private pendingSql: unknown[][] = []

  constructor(
    private readonly format: DataExportFormat,
    private readonly options: {
      delimiter: string
      header: boolean
      dialect: SqlDialect | null
      table: string
      /** MySQL/MariaDB SQL exports: the session's backslash mode (unknown = escapes on). */
      backslashEscapes?: boolean
    }
  ) {}

  private sqlQuote(): SqlQuoteOptions {
    return this.options.dialect
      ? sqlTextOptions(this.options.dialect, this.options.backslashEscapes)
      : {}
  }

  /**
   * Text for a batch (header/opening on the first call). `columnTypes`: the driver's column type
   * names, when it reports them (see sqlInsert).
   */
  batch(columns: string[], rows: unknown[][], columnTypes?: readonly string[]): string {
    let out = ''
    if (columnTypes && columnTypes.length === columns.length) this.columnTypes = columnTypes
    if (this.keys === null) {
      this.columns = columns
      this.keys = uniqueKeys(columns)
      if (this.format === 'csv' && this.options.header)
        out += csvLine(columns, this.options.delimiter)
      if (this.format === 'json') out += '['
      if (this.format === 'sql') {
        out += `-- Exported by Hive\n`
        if (this.sqlQuote().backslashEscapes === false)
          out += `-- String literals are written for sql_mode NO_BACKSLASH_ESCAPES (a backslash is a plain character).\n`
      }
    }
    switch (this.format) {
      case 'csv':
        for (const row of rows) out += csvLine(row, this.options.delimiter)
        break
      case 'json': {
        const ejson = this.columns.length === 1 && this.columns[0] === MONGO_EJSON_COLUMN
        for (const row of rows) {
          out += `${this.rowsWritten === 0 ? '\n  ' : ',\n  '}${ejson ? safeJsonText(row[0]) : jsonRow(this.keys, row)}`
          this.rowsWritten++
        }
        return out
      }
      case 'sql': {
        if (!this.options.dialect) throw unsupportedError('SQL export needs a SQL engine.')
        this.pendingSql.push(...rows)
        while (this.pendingSql.length >= SQL_ROWS_PER_INSERT) {
          out += sqlInsert(
            this.options.dialect,
            this.options.table,
            this.columns,
            this.pendingSql.splice(0, SQL_ROWS_PER_INSERT),
            this.sqlQuote(),
            this.columnTypes
          )
        }
        break
      }
    }
    this.rowsWritten += rows.length
    return out
  }

  /** Closing text (also produces a valid file for zero rows). */
  end(columns: string[]): string {
    let out = ''
    if (this.keys === null) out += this.batch(columns, [])
    if (this.format === 'json') out += this.rowsWritten === 0 ? ']\n' : '\n]\n'
    if (this.format === 'sql' && this.options.dialect && this.pendingSql.length > 0) {
      out += sqlInsert(
        this.options.dialect,
        this.options.table,
        this.columns,
        this.pendingSql.splice(0),
        this.sqlQuote(),
        this.columnTypes
      )
    }
    return out
  }
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

const EXTENSIONS: Record<DataExportFormat, string> = { csv: 'csv', json: 'json', sql: 'sql' }

/** A default file name from a table/collection name (no path separators or control chars). */
const safeFileBase = (name: string): string => {
  let out = ''
  for (const ch of name) out += ch.charCodeAt(0) < 0x20 || '/\\:*?"<>|'.includes(ch) ? '_' : ch
  return (out.trim() || 'export').slice(0, 120)
}

interface PreparedExport {
  statement: string
  database?: string
  schema?: string
  defaultName: string
  table: string
}

type Gated =
  { kind: 'ok'; prepared: PreparedExport } | { kind: 'response'; response: DataExportResponse }

async function prepare(
  deps: ExportDeps,
  record: DataProjectRecord,
  req: DataExportRequest
): Promise<Gated> {
  const source = req.source
  const dialect = sqlDialectOf(record.engine)
  const isMongo = record.engine === 'mongodb'
  if (isMongo && req.format === 'sql')
    throw unsupportedError('MongoDB data cannot be exported as SQL. Choose CSV or JSON.')
  // MySQL/MariaDB text with a backslash is quoted/lexed for the session's backslash mode.
  const backslashEscapesFor = async (
    text: string,
    database: string | undefined
  ): Promise<boolean | undefined> =>
    (record.engine === 'mysql' || record.engine === 'mariadb') && text.includes('\\')
      ? deps.manager.backslashEscapes(record.id, database)
      : undefined

  const mongoStatement = async (s: DataExportSource): Promise<string> => {
    const build =
      deps.mongoExportStatement ??
      (async (src: DataExportSource, fmt: DataExportFormat) =>
        (await import('./mongo')).mongoExportStatement(src, fmt))
    return build(s, req.format)
  }

  if (source.kind === 'table') {
    if (isMongo) {
      return {
        kind: 'ok',
        prepared: {
          statement: await mongoStatement(source),
          database: source.ref.database,
          defaultName: source.ref.name,
          table: source.ref.name
        }
      }
    }
    if (!dialect) throw unsupportedError('Unsupported engine.')
    const backslashEscapes = await backslashEscapesFor(
      JSON.stringify([source.filters ?? [], source.where ?? '']),
      source.ref.database
    )
    const statement = buildSelectSql(dialect, source.ref, {
      filters: source.filters,
      filterJoin: source.filterJoin,
      where: source.where,
      orderBy: source.orderBy,
      backslashEscapes
    })
    assertSingleRead(statement, dialect, sqlTextOptions(dialect, backslashEscapes))
    return {
      kind: 'ok',
      prepared: {
        statement,
        database: source.ref.database,
        schema: source.ref.schema,
        defaultName: source.ref.name,
        table: source.ref.name
      }
    }
  }

  if (source.kind === 'mongo') {
    if (!isMongo) throw invalidInputError('This export source needs a MongoDB project.')
    // The closing paren goes on its own line: a filter or pipeline ending in `// comment` must
    // not comment it out (the Documents view parses its fields the same way).
    const shell = source.pipeline?.trim()
      ? `db.getCollection(${JSON.stringify(source.collection)}).aggregate(${source.pipeline}\n)`
      : `db.getCollection(${JSON.stringify(source.collection)}).find(${source.filter?.trim() || '{}'}\n)`
    const database = source.database || record.config.database || undefined
    const c = classifyMongoShellStatement(shell, database ? { database } : {})
    const input: SafetyEvaluationInput = {
      project: record,
      database: source.database,
      source: 'mongo',
      statements: [
        {
          index: 0,
          text: shell,
          start: 0,
          end: shell.length,
          classification: c.classification,
          dangerous: c.dangerous,
          targets: [source.collection]
        }
      ],
      fingerprintText: JSON.stringify(['export', source]),
      confirmToken: req.confirmToken
    }
    if (c.classification !== 'read') {
      const blocked = deps.gate.block(
        input,
        'Only reads can be exported ($out/$merge write to a collection).'
      )
      return {
        kind: 'response',
        response: { status: 'blocked', plan: blocked.plan, reason: blocked.reason }
      }
    }
    const decision = deps.gate.evaluate(input)
    if (decision.action === 'block')
      return {
        kind: 'response',
        response: { status: 'blocked', plan: decision.plan, reason: decision.reason }
      }
    if (decision.action === 'confirm') {
      return {
        kind: 'response',
        response: {
          status: 'confirmation_required',
          plan: decision.plan,
          confirmToken: decision.confirmToken
        }
      }
    }
    return {
      kind: 'ok',
      prepared: {
        statement: await mongoStatement(source),
        database: source.database,
        defaultName: source.collection,
        table: source.collection
      }
    }
  }

  // Query source.
  const statements = planStatements(record.engine, source.text, {
    backslashEscapes: await backslashEscapesFor(source.text, source.database),
    database: isMongo ? source.database || record.config.database || undefined : undefined
  })
  if (statements.length === 0) throw invalidInputError('There is no statement to export.')
  if (statements.length > 1)
    throw invalidInputError('Export one statement at a time (the text contains several).')
  const input: SafetyEvaluationInput = {
    project: record,
    database: source.database,
    source: 'editor',
    statements: toSafetyStatements(statements),
    fingerprintText: JSON.stringify(['export', source.text, source.schema ?? null]),
    confirmToken: req.confirmToken
  }
  if (statements[0].classification !== 'read') {
    const blocked = deps.gate.block(input, 'Only statements that read data can be exported.')
    return {
      kind: 'response',
      response: { status: 'blocked', plan: blocked.plan, reason: blocked.reason }
    }
  }
  const decision = deps.gate.evaluate(input)
  if (decision.action === 'block')
    return {
      kind: 'response',
      response: { status: 'blocked', plan: decision.plan, reason: decision.reason }
    }
  if (decision.action === 'confirm') {
    return {
      kind: 'response',
      response: {
        status: 'confirmation_required',
        plan: decision.plan,
        confirmToken: decision.confirmToken
      }
    }
  }
  const table = statements[0].targets?.[0]?.split('.').pop() || 'query_result'
  return {
    kind: 'ok',
    prepared: {
      statement: isMongo ? await mongoStatement(source) : statements[0].text,
      database: source.database,
      schema: source.schema,
      defaultName: `${table === 'query_result' ? 'query' : table}`,
      table
    }
  }
}

/** Writes with backpressure; rejects with the stream's error (disk full, permission...). */
async function writeChunk(stream: WriteStream, chunk: string): Promise<void> {
  if (!chunk) return
  if (stream.errored) throw stream.errored
  if (stream.write(chunk, 'utf8')) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.off('drain', onDrain)
      stream.off('error', onError)
      stream.off('close', onClose)
    }
    const onDrain = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void => {
      cleanup()
      reject(stream.errored ?? new Error('The export file was closed unexpectedly.'))
    }
    stream.on('drain', onDrain)
    stream.on('error', onError)
    stream.on('close', onClose)
  })
}

async function closeStream(stream: WriteStream): Promise<void> {
  stream.end()
  await finished(stream)
}

export async function startExport(
  deps: ExportDeps,
  req: DataExportRequest,
  ctx: DataCallContext
): Promise<DataExportResponse> {
  const now = deps.now ?? Date.now
  const log = deps.logger ?? noopLogger
  const record = deps.getRecord(req.dataProjectId)
  const gated = await prepare(deps, record, req)
  if (gated.kind === 'response') return gated.response
  const prepared = gated.prepared

  const extension = EXTENSIONS[req.format]
  let filePath = req.filePath?.trim() || null
  if (!filePath) {
    filePath = await deps.showSaveDialog({
      defaultName: `${safeFileBase(prepared.defaultName)}.${extension}`,
      extensions: [extension]
    })
    if (!filePath) return { status: 'cancelled' }
  }
  if (!isAbsolute(filePath)) throw invalidInputError('The export path must be absolute.')
  const dir = dirname(filePath)
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw invalidInputError(`The folder ${dir} does not exist.`)
  }

  // Before the .part file exists: looking the mode up may connect (and fail).
  const sqlBackslashEscapes =
    req.format === 'sql'
      ? await deps.manager.backslashEscapes(record.id, prepared.database)
      : undefined

  const controller = new AbortController()
  const unregister = deps.registry.register(req.exportId, {
    clientId: ctx.clientId,
    projectId: record.id,
    controller
  })
  const tempPath = join(
    dir,
    `.${basename(filePath)}.${req.exportId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36)}.part`
  )
  const stream = createWriteStream(tempPath, { flags: 'w', encoding: 'utf8', mode: 0o644 })
  // Errors surface through writeChunk/closeStream; this listener only keeps an 'error' emitted
  // between writes from becoming an uncaught exception in the server process.
  stream.on('error', () => undefined)
  const delimiter = req.csv?.delimiter ?? ','
  const formatter = new ExportFormatter(req.format, {
    delimiter,
    header: req.csv?.header !== false,
    dialect: sqlDialectOf(record.engine),
    table: prepared.table,
    backslashEscapes: sqlBackslashEscapes
  })
  const started = now()
  let rows = 0
  let bytes = 0
  let lastColumns: string[] = []
  let lastProgress = 0
  const progress = (event: Omit<DataExportProgressEvent, 'exportId'>): void => {
    try {
      deps.publish(DATA_EXPORT_CHANNEL, { exportId: req.exportId, ...event })
    } catch {
      // Progress is best effort.
    }
  }
  const write = async (text: string): Promise<void> => {
    if (!text) return
    bytes += Buffer.byteLength(text, 'utf8')
    await writeChunk(stream, text)
  }

  progress({ rows: 0, bytes: 0, done: false })
  try {
    await withConsoleSource('export', () =>
      deps.manager.withDriver(record.id, prepared.database, (driver) =>
        driver.streamRows(
          prepared.statement,
          {
            database: prepared.database,
            schema: prepared.schema,
            readOnlySandbox: true,
            signal: controller.signal
          },
          // The MySQL driver also hands over its column type names (BIT values; see sqlInsert).
          async (columns, batch, columnTypes?: readonly string[]) => {
            if (controller.signal.aborted)
              throw new DataDriverError('Export cancelled', { cancelled: true })
            lastColumns = columns
            await write(formatter.batch(columns, batch, columnTypes))
            rows += batch.length
            const t = now()
            if (t - lastProgress >= PROGRESS_INTERVAL_MS) {
              lastProgress = t
              progress({ rows, bytes, done: false })
            }
          }
        )
      )
    )
    if (controller.signal.aborted)
      throw new DataDriverError('Export cancelled', { cancelled: true })
    await write(formatter.end(lastColumns))
    await closeStream(stream)
    await rename(tempPath, filePath)
    progress({ rows, bytes, done: true })
    log.info('Data export finished', { dataProjectId: record.id, format: req.format, rows, bytes })
    return { status: 'ok', filePath, rows, bytes, durationMs: now() - started }
  } catch (error) {
    // Wait for the fd to close: the file's open() may still be pending and would otherwise
    // recreate the .part file after the unlink.
    if (!stream.closed) {
      const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()))
      stream.destroy()
      await closed
    }
    await unlink(tempPath).catch(() => undefined)
    const cancelled =
      controller.signal.aborted || (error instanceof DataDriverError && error.cancelled)
    if (cancelled) {
      progress({ rows, bytes, done: true })
      return { status: 'cancelled' }
    }
    if (error instanceof DataDriverError && error.sandboxRejected) {
      const plan = deps.gate.block(
        {
          project: record,
          database: prepared.database,
          source: 'editor',
          statements: [
            {
              index: 0,
              text: prepared.statement,
              start: 0,
              end: prepared.statement.length,
              classification: 'read',
              dangerous: []
            }
          ],
          fingerprintText: prepared.statement
        },
        'The statement tried to write; only reads can be exported.'
      )
      progress({ rows, bytes, done: true, error: plan.reason })
      return { status: 'blocked', plan: plan.plan, reason: plan.reason }
    }
    const message = errorMessage(error, deps.manager.redactor(record.id))
    progress({ rows, bytes, done: true, error: message })
    if (error instanceof DataDriverError) throw new DataDriverError(message, { code: error.code })
    throw error
  } finally {
    unregister()
  }
}
