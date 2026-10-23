// Data import (`dataProjects.import.*`): a CSV/TSV file into an existing SQL table, or a JSON
// array / NDJSON / CSV file into a MongoDB collection. Contract: shared/data-projects/
// import-types.ts; UI: renderer components/data-projects/import/.
//
// Nothing loads the whole file. It is read as a stream (256 KB chunks) through a streaming
// TextDecoder and an incremental parser (CsvParser / JsonDocumentSplitter below); the records of
// a chunk are converted and batched, and the next chunk is read only after the batches it filled
// were written, so memory stays flat for any file size.
//
// Bytes that are invalid for the chosen encoding (a Windows-1252 é in a file read as UTF-8, also
// far past the detection window) refuse the file with their line instead of becoming U+FFFD.
// In a one-column CSV file for a table a blank line is a row with an empty value (NULL), the way
// our export and PostgreSQL's COPY write one; elsewhere blank lines are skipped (as mongoimport
// does for collections).
//
// preview  reads the head of the file: encoding (BOM, UTF-8 validity, the NUL pattern of UTF-16),
//          format (extension, first character), delimiter (the candidate whose field count is
//          the most consistent across records), header (names vs values, matches with the
//          table's columns), the first rows, and for Mongo CSV a suggested type per column.
// start    1. scans the whole file once (phase `scanning`): counts the rows and finds what can
//             be known before writing (wrong field count, broken JSON, a value a Mongo column
//             type cannot convert). Cached by file identity (path, size, mtime) and options, so
//             the confirmation round trip reads the file once.
//          2. passes the safety gate as ONE write, `INSERT INTO <table> (…) VALUES (…)` or
//             `db.getCollection(…).insertMany([…])`, with the reason "Import N rows from
//             file.csv into table": read-only refuses, half-safe/safe confirm. The token is bound
//             to the file identity and every option, so a file changed meanwhile asks again.
//          3. streams the rows again in batches (500 rows per INSERT, 1000 documents per
//             insertMany, at most 4 MB of SQL per statement), with progress events on
//             DATA_IMPORT_CHANNEL (every 250 ms) and cancel between and during batches.
//          One history row records the import (ok / error / cancelled / blocked).
//
// SQL: parameter-free INSERTs (identifiers through quoteSqlIdentifier, values through
// quoteSqlLiteral for the MySQL/MariaDB session's backslash mode) on the project's SQL session
// (runSerial: other tabs' queries wait; an open transaction or LOCK TABLES refuses, like a grid
// save). Error modes:
//   rollback  BEGIN … COMMIT. When a batch fails everything is rolled back first; the failing
//             row is then found by a binary search over prefixes of that batch, each probe in
//             its own BEGIN … ROLLBACK. No SAVEPOINT per batch: thousands of PostgreSQL
//             subtransactions in one transaction overflow the subxid cache, which slows every
//             session of the server.
//   stop      autocommit. A failing batch is split in halves, left half first, until the failing
//             row is alone: every row before it is in, nothing after it. A MySQL/MariaDB table
//             without transactions (MyISAM, MEMORY, Aria…) gets one row per INSERT instead: a
//             failing multi-row INSERT there keeps the rows before the failing one. A session
//             with `autocommit = 0` gets autocommit for the import (restored after it), so the
//             rows reported as imported are committed.
//   skip      the same splitting, but a failing row is reported and the import goes on (it stops
//             after 1,000 failed rows: the mapping is probably wrong).
// Failures that are not about a row (lost connection, permissions, missing table or column,
// read-only server, deadlock, timeout, cancel) end the import at once instead of being split.
// ClickHouse has no transactions (rollback is refused); one INSERT of one batch is atomic there.
//
// MongoDB: insertMany per batch (ordered for stop, unordered for skip) as a cancellable operation
// (comment tag + killOp). A cancel lets the batch in flight finish (a killed insertMany reports 0
// inserted whatever the server wrote); a second cancel kills it, and the documents it wrote are
// then counted by their _id (ours for documents without one), else reported as uncertain. JSON
// documents are Extended JSON (`$oid`, `$date`, `$numberLong`…; plain numbers become Int32 /
// Int64 / Double like mongoimport, integers beyond 2^53 exactly). CSV columns are converted by
// the mapping's type; `a.b` field names nest, built with own properties only (a `__proto__` or
// `constructor.prototype` path can never reach a prototype, and such names are refused).

import { withConsoleSource } from './console-log'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import type * as Bson from 'bson'
import type { BulkWriteOptions } from 'mongodb'
import {
  sqlDialectOf,
  type DataColumnInfo,
  type DataEngine,
  type DataHistoryEntry,
  type DataObjectRef,
  type DataTableDetails,
  type SqlDialect
} from '../../../shared/data-projects/types'
import {
  DATA_IMPORT_CHANNEL,
  DATA_IMPORT_ENCODING_LABELS,
  DATA_IMPORT_ENCODINGS,
  DATA_IMPORT_FORMATS,
  DATA_IMPORT_MAX_BATCH_ROWS,
  DATA_IMPORT_MAX_PREVIEW_ROWS,
  DATA_IMPORT_MAX_REPORTED_ERRORS,
  DATA_IMPORT_MONGO_BATCH_ROWS,
  DATA_IMPORT_PREVIEW_ROWS,
  DATA_IMPORT_SQL_BATCH_ROWS,
  MONGO_IMPORT_RESERVED_FIELD_NAMES,
  MONGO_IMPORT_TYPES,
  importColumnLabel,
  importNameKey,
  type DataImportColumnMapping,
  type DataImportCsvOptions,
  type DataImportEmptyMode,
  type DataImportEncoding,
  type DataImportFormat,
  type DataImportOnError,
  type DataImportPreviewRequest,
  type DataImportPreviewResponse,
  type DataImportProgressEvent,
  type DataImportQuote,
  type DataImportResponse,
  type DataImportRowError,
  type DataImportStartRequest,
  type DataImportSummary,
  type MongoImportFieldType
} from '../../../shared/data-projects/import-types'
import {
  qualifiedSqlName,
  quoteSqlIdentifier,
  quoteSqlLiteral,
  splitSqlStatements,
  type SqlQuoteOptions
} from '../../../shared/sql'
import {
  DataDriverError,
  type DataCallContext,
  type DataDriver,
  type DataProjectRecord,
  type DriverExecuteOptions,
  type SafetyEvaluationInput
} from './contracts'
import {
  isConnectionLostError,
  noopLogger,
  QueueAbortedError,
  type ConnectionManager,
  type EngineLogger
} from './connection-manager'
import type { MongoDriver } from './mongo'
import type { SafetyGate } from './safety-gate'
import { sqlTextOptions } from './table-ops'
import { busyError, errorMessage, invalidInputError, unsupportedError } from './redact'

const READ_CHUNK_BYTES = 256 * 1024
/** Bytes read for detection (encoding, format, delimiter). */
const DETECT_BYTES = 256 * 1024
/** A preview stops reading here even when it has fewer rows (very wide rows). */
const PREVIEW_MAX_BYTES = 16 * 1024 * 1024
/** Rows sampled for the Mongo CSV type suggestion and for header/delimiter detection. */
const INFER_SAMPLE_ROWS = 500
const DETECT_SAMPLE_RECORDS = 50
const SQL_BATCH_MAX_CHARS = 4 * 1024 * 1024
const MONGO_BATCH_MAX_CHARS = 8 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 250
const MAX_FIELD_CHARS = 64 * 1024 * 1024
const MAX_FIELDS = 16_384
const MAX_DOCUMENT_CHARS = 32 * 1024 * 1024
/** Skip mode gives up after this many failed rows. */
export const MAX_SKIPPED_FAILURES = 1_000
const MAX_MESSAGE_CHARS = 600
const MAX_JSON_PREVIEW_COLUMNS = 200
const SCAN_CACHE_TTL_MS = 10 * 60_000
const SCAN_CACHE_MAX = 16

const CR = 13
const LF = 10

const TX: Partial<Record<SqlDialect, { begin: string; commit: string; rollback: string }>> = {
  mysql: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  mariadb: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  postgres: { begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK' },
  sqlite: { begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK' }
}

export interface ImportDeps {
  manager: ConnectionManager
  gate: SafetyGate
  registry: ImportRegistry
  getRecord(id: string): DataProjectRecord
  /** Cached describe (the engine service owns the cache). */
  describe(id: string, ref: DataObjectRef): Promise<DataTableDetails>
  recordHistory(entry: Omit<DataHistoryEntry, 'id'>): void
  publish(channel: string, payload: unknown): void
  /** BSON of the Mongo runtime (mongo/runtime.ts); loaded on the first Mongo import/preview. */
  loadBson?(): Promise<typeof Bson>
  now?: () => number
  logger?: EngineLogger
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

interface RunningImport {
  clientId: string | null
  projectId: string
  controller: AbortController
  /** Interrupts the statement / insertMany in flight (set only while one runs). */
  interrupt: (() => Promise<void>) | null
}

export class ImportRegistry {
  private readonly imports = new Map<string, RunningImport>()

  register(importId: string, entry: RunningImport): () => void {
    if (!importId) throw invalidInputError('An import id is required.')
    if (this.imports.has(importId)) throw busyError('An import with this id is already running.')
    this.imports.set(importId, entry)
    return () => {
      if (this.imports.get(importId) === entry) this.imports.delete(importId)
    }
  }

  private stop(entry: RunningImport): void {
    entry.controller.abort()
    const interrupt = entry.interrupt
    if (interrupt) void interrupt().catch(() => undefined)
  }

  cancel(importId: string): boolean {
    const entry = this.imports.get(importId)
    if (!entry) return false
    this.stop(entry)
    return true
  }

  releaseClient(clientId: string): void {
    for (const entry of this.imports.values()) if (entry.clientId === clientId) this.stop(entry)
  }

  cancelProject(projectId: string): void {
    for (const entry of this.imports.values()) if (entry.projectId === projectId) this.stop(entry)
  }

  cancelAll(): void {
    for (const entry of this.imports.values()) this.stop(entry)
  }

  get size(): number {
    return this.imports.size
  }
}

// ---------------------------------------------------------------------------------------------
// Parsers (pure; unit-tested)
// ---------------------------------------------------------------------------------------------

/** The file cannot be read past this point (the parser cannot find the next row). */
export class ImportSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(message)
    this.name = 'ImportSyntaxError'
  }
}

export interface CsvRecord {
  /** Field text; null = an empty unquoted field (a quoted `""` is the empty string). */
  fields: Array<string | null>
  /** 1-based line where the record starts. */
  line: number
  /** A blank line (only with `keepBlankLines`; `fields` is then `[null]`). */
  blank?: true
}

const FIELD_START = 0
const UNQUOTED = 1
const QUOTED = 2
const QUOTE_IN_QUOTED = 3

/**
 * Incremental RFC 4180 reader: any one-character delimiter, `"` or `'` quoting (doubled to
 * escape) or none, CRLF / LF / CR line breaks (also across chunk boundaries), line breaks inside
 * quoted fields. Lenient where readers usually are: a quote inside an unquoted field is a plain
 * character, and text after a closing quote is appended to the field. Blank lines are skipped,
 * or with `keepBlankLines` emitted as `{ fields: [null], blank: true }` (in a one-column file a
 * blank line is a NULL value: that is how our export and PostgreSQL's COPY write one).
 */
export class CsvParser {
  private readonly delim: number
  private readonly quoteCode: number
  private readonly quoteChar: string
  private readonly keepBlankLines: boolean
  private fields: Array<string | null> = []
  private field = ''
  private quoted = false
  private state = FIELD_START
  private started = false
  private line = 1
  private recordLine = 1
  private skipLf = false
  private quotedCr = false

  constructor(options: { delimiter: string; quote: DataImportQuote; keepBlankLines?: boolean }) {
    if (options.delimiter.length !== 1)
      throw invalidInputError('The delimiter must be a single character.')
    this.delim = options.delimiter.charCodeAt(0)
    if (this.delim === CR || this.delim === LF)
      throw invalidInputError('The delimiter cannot be a line break.')
    this.quoteChar = options.quote
    this.quoteCode = options.quote ? options.quote.charCodeAt(0) : -1
    if (this.delim === this.quoteCode)
      throw invalidInputError('The delimiter and the quote character must differ.')
    this.keepBlankLines = options.keepBlankLines === true
  }

  /** The 1-based line the text read so far ends on. */
  get currentLine(): number {
    return this.line
  }

  /** Parses `text` (the next piece of the file) and appends the complete records to `out`. */
  push(text: string, out: CsvRecord[]): void {
    const n = text.length
    let i = 0
    if (this.skipLf) {
      this.skipLf = false
      if (n > 0 && text.charCodeAt(0) === LF) i = 1
    }
    while (i < n) {
      if (this.state === QUOTED) {
        const j = text.indexOf(this.quoteChar, i)
        const end = j < 0 ? n : j
        if (end > i) {
          this.countLines(text, i, end)
          this.append(text, i, end)
        }
        if (j < 0) return
        i = j + 1
        this.state = QUOTE_IN_QUOTED
        continue
      }
      if (this.state === QUOTE_IN_QUOTED) {
        this.quotedCr = false
        if (text.charCodeAt(i) === this.quoteCode) {
          this.field += this.quoteChar
          i++
          this.state = QUOTED
          continue
        }
        // The closing quote: what follows is read like unquoted text.
        this.state = UNQUOTED
        continue
      }
      if (this.state === FIELD_START) {
        this.started = true
        if (text.charCodeAt(i) === this.quoteCode) {
          this.quoted = true
          this.state = QUOTED
          i++
          continue
        }
        this.state = UNQUOTED
      }
      let j = i
      while (j < n) {
        const c = text.charCodeAt(j)
        if (c === this.delim || c === LF || c === CR) break
        j++
      }
      if (j > i) this.append(text, i, j)
      if (j === n) return
      const c = text.charCodeAt(j)
      this.endField()
      if (c === this.delim) {
        this.state = FIELD_START
        i = j + 1
        continue
      }
      this.endRecord(out)
      this.line++
      this.recordLine = this.line
      if (c === CR) {
        if (j + 1 < n) i = text.charCodeAt(j + 1) === LF ? j + 2 : j + 1
        else {
          this.skipLf = true
          i = n
        }
      } else i = j + 1
    }
  }

  /** The end of the file: flushes the last record (throws when a quoted field is still open). */
  end(out: CsvRecord[]): void {
    if (this.state === QUOTED) {
      throw new ImportSyntaxError(
        `The quoted field that starts on line ${this.recordLine} is never closed (is the quote character right?).`,
        this.recordLine
      )
    }
    if (!this.started) return
    this.endField()
    this.endRecord(out)
  }

  private countLines(text: string, from: number, to: number): void {
    let k = from
    if (this.quotedCr) {
      this.quotedCr = false
      if (k < to && text.charCodeAt(k) === LF) k++
    }
    for (; k < to; k++) {
      const c = text.charCodeAt(k)
      if (c === LF) this.line++
      else if (c === CR) {
        this.line++
        if (k + 1 < to) {
          if (text.charCodeAt(k + 1) === LF) k++
        } else if (to === text.length) this.quotedCr = true
      }
    }
  }

  private append(text: string, from: number, to: number): void {
    this.field += text.slice(from, to)
    if (this.field.length > MAX_FIELD_CHARS) {
      throw new ImportSyntaxError(
        `A field longer than 64 MB starts on line ${this.recordLine} (is the quote character right?).`,
        this.recordLine
      )
    }
  }

  private endField(): void {
    this.fields.push(this.quoted || this.field !== '' ? this.field : null)
    this.field = ''
    this.quoted = false
    if (this.fields.length > MAX_FIELDS) {
      throw new ImportSyntaxError(
        `Line ${this.recordLine} has more than ${MAX_FIELDS.toLocaleString('en-US')} fields (is the delimiter right?).`,
        this.recordLine
      )
    }
  }

  private endRecord(out: CsvRecord[]): void {
    const fields = this.fields
    this.fields = []
    this.started = false
    this.state = FIELD_START
    if (fields.length === 1 && fields[0] === null) {
      // A blank line.
      if (this.keepBlankLines) out.push({ fields, line: this.recordLine, blank: true })
      return
    }
    out.push({ fields, line: this.recordLine })
  }
}

export interface JsonDocumentText {
  /** The document's JSON text (one top-level value). */
  text: string
  /** 1-based line where it starts. */
  line: number
}

const J_BEFORE_ARRAY = 0
const J_BETWEEN = 1
const J_CONTAINER = 2
const J_STRING = 3
const J_SCALAR = 4
const J_AFTER_ARRAY = 5

const isJsonSpace = (c: number): boolean => c === 32 || c === 9 || c === LF || c === CR

/**
 * Splits a JSON file into its documents without parsing them: `array` = one top-level array
 * (each element is a document), `sequence` = top-level values one after another (NDJSON, also
 * pretty-printed concatenated documents; commas between them are tolerated). It tracks strings,
 * escapes and bracket depth only, so a document is parsed (and may fail) on its own.
 */
export class JsonDocumentSplitter {
  private state: number
  private depth = 0
  private inString = false
  private escaped = false
  private parts: string[] = []
  private size = 0
  private line = 1
  private valueLine = 1
  private expectComma = false
  private count = 0

  constructor(private readonly mode: 'array' | 'sequence') {
    this.state = mode === 'array' ? J_BEFORE_ARRAY : J_BETWEEN
  }

  /** The 1-based line the text read so far ends on. */
  get currentLine(): number {
    return this.line
  }

  push(text: string, out: JsonDocumentText[]): void {
    const n = text.length
    let i = 0
    while (i < n) {
      switch (this.state) {
        case J_BEFORE_ARRAY: {
          const c = text.charCodeAt(i)
          if (isJsonSpace(c)) {
            if (c === LF) this.line++
            i++
            continue
          }
          if (c !== 0x5b) {
            throw this.syntax(
              'a JSON array file must start with "[" (choose NDJSON for one document per line)'
            )
          }
          this.state = J_BETWEEN
          i++
          continue
        }
        case J_BETWEEN: {
          const c = text.charCodeAt(i)
          if (isJsonSpace(c)) {
            if (c === LF) this.line++
            i++
            continue
          }
          if (c === 0x2c) {
            if (this.mode === 'array' && !this.expectComma) throw this.syntax('unexpected ","')
            this.expectComma = false
            i++
            continue
          }
          if (c === 0x5d && this.mode === 'array') {
            this.state = J_AFTER_ARRAY
            i++
            continue
          }
          if (this.expectComma) {
            throw this.syntax(`expected "," or "]" after document ${this.count}`)
          }
          this.valueLine = this.line
          this.parts = []
          this.size = 0
          this.depth = 0
          this.inString = false
          this.escaped = false
          if (c === 0x7b || c === 0x5b) this.state = J_CONTAINER
          else if (c === 0x22) {
            this.state = J_STRING
            this.take(text, i, i + 1)
            i++
          } else this.state = J_SCALAR
          continue
        }
        case J_CONTAINER: {
          let j = i
          let done = false
          for (; j < n; j++) {
            const c = text.charCodeAt(j)
            if (this.inString) {
              if (this.escaped) this.escaped = false
              else if (c === 0x5c) this.escaped = true
              else if (c === 0x22) this.inString = false
              else if (c === LF) this.line++
              continue
            }
            if (c === 0x22) this.inString = true
            else if (c === 0x7b || c === 0x5b) this.depth++
            else if (c === 0x7d || c === 0x5d) {
              this.depth--
              if (this.depth === 0) {
                j++
                done = true
                break
              }
            } else if (c === LF) this.line++
          }
          this.take(text, i, j)
          i = j
          if (done) this.emit(out)
          continue
        }
        case J_STRING: {
          let j = i
          let done = false
          for (; j < n; j++) {
            const c = text.charCodeAt(j)
            if (this.escaped) this.escaped = false
            else if (c === 0x5c) this.escaped = true
            else if (c === 0x22) {
              j++
              done = true
              break
            } else if (c === LF) this.line++
          }
          this.take(text, i, j)
          i = j
          if (done) this.emit(out)
          continue
        }
        case J_SCALAR: {
          let j = i
          while (j < n) {
            const c = text.charCodeAt(j)
            if (isJsonSpace(c) || c === 0x2c || c === 0x5d || c === 0x7d) break
            j++
          }
          this.take(text, i, j)
          i = j
          if (j < n) this.emit(out)
          continue
        }
        default: {
          const c = text.charCodeAt(i)
          if (!isJsonSpace(c)) throw this.syntax('unexpected text after the closing "]"')
          if (c === LF) this.line++
          i++
        }
      }
    }
  }

  end(out: JsonDocumentText[]): void {
    switch (this.state) {
      case J_CONTAINER:
      case J_STRING:
        throw new ImportSyntaxError(
          `Document ${this.count + 1} (line ${this.valueLine}) is not complete: the file ends inside it.`,
          this.valueLine
        )
      case J_SCALAR:
        this.emit(out)
        break
      case J_BETWEEN:
        if (this.mode === 'array') throw this.syntax('the JSON array is not closed with "]"')
        break
    }
  }

  private take(text: string, from: number, to: number): void {
    if (to <= from) return
    this.parts.push(text.slice(from, to))
    this.size += to - from
    if (this.size > MAX_DOCUMENT_CHARS) {
      throw new ImportSyntaxError(
        `Document ${this.count + 1} (line ${this.valueLine}) is larger than 32 MB.`,
        this.valueLine
      )
    }
  }

  private emit(out: JsonDocumentText[]): void {
    out.push({ text: this.parts.join(''), line: this.valueLine })
    this.parts = []
    this.size = 0
    this.count++
    this.state = J_BETWEEN
    this.expectComma = this.mode === 'array'
  }

  private syntax(what: string): ImportSyntaxError {
    return new ImportSyntaxError(`Line ${this.line}: ${what}.`, this.line)
  }
}

// ---------------------------------------------------------------------------------------------
// Detection (pure; unit-tested)
// ---------------------------------------------------------------------------------------------

const isValidUtf8 = (bytes: Uint8Array): boolean => {
  try {
    // `stream`: the head may end inside a multi-byte character; that tail is not an error.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
    return true
  } catch {
    return false
  }
}

/** BOM → UTF-8/16; NUL in every other byte → UTF-16 without BOM; invalid UTF-8 → Windows-1252. */
export function detectEncoding(head: Uint8Array): DataImportEncoding {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf-8'
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le'
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be'
  const sample = head.subarray(0, Math.min(head.length, 4096))
  if (sample.length >= 4) {
    let evenZero = 0
    let oddZero = 0
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0) {
        if (i % 2 === 0) evenZero++
        else oddZero++
      }
    }
    const half = sample.length / 2
    if (oddZero > half * 0.4 && evenZero < half * 0.05) return 'utf-16le'
    if (evenZero > half * 0.4 && oddZero < half * 0.05) return 'utf-16be'
  }
  return isValidUtf8(head) ? 'utf-8' : 'windows-1252'
}

/** SQL targets read CSV only; Mongo: extension first, then the first character. */
export function detectFormat(
  fileName: string,
  headText: string,
  family: 'sql' | 'document'
): DataImportFormat {
  if (family === 'sql') return 'csv'
  const ext = extname(fileName).toLowerCase()
  if (ext === '.ndjson' || ext === '.jsonl' || ext === '.ldjson') return 'ndjson'
  if (ext === '.csv' || ext === '.tsv' || ext === '.tab' || ext === '.psv') return 'csv'
  // trimStart also drops a BOM (U+FEFF counts as white space).
  const first = headText.trimStart().charAt(0)
  if (first === '[') return 'json'
  if (first === '{') return 'ndjson'
  return 'csv'
}

const DELIMITER_CANDIDATES = [',', ';', '\t', '|'] as const

/** Complete records of a sample (the last one may be cut by the sample's end: left out). */
const sampleRecords = (text: string, delimiter: string, quote: DataImportQuote): CsvRecord[] => {
  const out: CsvRecord[] = []
  try {
    const parser = new CsvParser({ delimiter, quote })
    parser.push(text, out)
  } catch {
    // A runaway quoted field: whatever was complete still counts.
  }
  return out.slice(0, DETECT_SAMPLE_RECORDS)
}

/**
 * The delimiter whose field count is the most consistent across the sample's records (and is
 * more than one field). `.tsv`/`.tab` prefer tab and `.psv` pipe when they split at all.
 */
export function detectDelimiter(text: string, fileName: string, quote: DataImportQuote): string {
  const ext = extname(fileName).toLowerCase()
  let best: { delimiter: string; score: number } = { delimiter: ',', score: 0 }
  for (const delimiter of DELIMITER_CANDIDATES) {
    const records = sampleRecords(text, delimiter, quote)
    if (records.length === 0) continue
    const freq = new Map<number, number>()
    for (const r of records) freq.set(r.fields.length, (freq.get(r.fields.length) ?? 0) + 1)
    let mode = 0
    let modeFreq = 0
    for (const [count, f] of freq) {
      if (f > modeFreq || (f === modeFreq && count > mode)) {
        mode = count
        modeFreq = f
      }
    }
    if (mode < 2) continue
    const preferred =
      ((ext === '.tsv' || ext === '.tab') && delimiter === '\t') ||
      (ext === '.psv' && delimiter === '|')
    // Consistency first; more fields breaks ties (a comma inside text splits fewer lines).
    const score =
      (modeFreq / records.length) * 1000 + Math.min(mode, 500) / 1000 + (preferred ? 2000 : 0)
    if (score > best.score) best = { delimiter, score }
  }
  return best.delimiter
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `'` when the sample has more whole fields wrapped in single quotes than in double quotes
 * (and at least two), else `"` (RFC 4180, and what every spreadsheet writes).
 */
export function detectQuote(text: string, delimiter: string): DataImportQuote {
  const sample = text.slice(0, 64 * 1024)
  const d = escapeRegExp(delimiter)
  const count = (q: string): number =>
    (sample.match(new RegExp(`(?:^|${d}|\n)${q}[^${q}\n]*${q}(?=${d}|\r?\n|$)`, 'gm')) ?? []).length
  const single = count("'")
  return single >= 2 && single > count('"') ? "'" : '"'
}

const INT_RE = /^[+-]?\d+$/
// Unambiguous (one way to match any digit run), so a long almost-number fails in linear time;
// `\d+\.?\d*` backtracked quadratically on a long run of digits followed by a non-digit.
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const BOOL_RE = /^(true|false)$/i
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/
const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i
/**
 * Longer values are text to type detection (header detection, the Mongo type suggestion, the
 * `auto` conversion): no number, date or boolean a person means is this long, and the checks
 * then cost nothing on a huge field.
 */
const MAX_DETECT_CHARS = 400
/** Digits of the largest Int64 (9223372036854775807): longer integers never fit. */
const INT64_DIGITS = 19

const hasLeadingZero = (t: string): boolean => /^[+-]?0\d/.test(t)
/** Significant digits of an integer literal (sign and leading zeros dropped). */
const integerDigits = (t: string): number => {
  let i = t.charCodeAt(0) === 0x2b || t.charCodeAt(0) === 0x2d ? 1 : 0
  while (i < t.length - 1 && t.charCodeAt(i) === 0x30) i++
  return t.length - i
}

/**
 * Whether the first record is a header: names that match the table's columns (half or more) →
 * yes; a number, date or boolean among its cells → no (that is data); repeated names → no;
 * otherwise yes (most files have one, and a header of plain words looks like text data).
 */
export function detectHeader(
  records: ReadonlyArray<ReadonlyArray<string | null>>,
  targetNames: readonly string[] = []
): boolean {
  const first = records[0]
  if (!first || first.length === 0) return true
  const keys = new Set(targetNames.map(importNameKey))
  if (keys.size > 0) {
    const matches = first.filter((f) => f !== null && keys.has(importNameKey(f))).length
    if (matches >= Math.max(1, Math.ceil(first.length / 2))) return true
  }
  const names = first.filter((f): f is string => f !== null && f.trim() !== '').map((f) => f.trim())
  if (names.length === 0) return false
  if (
    names.some(
      (t) =>
        t.length <= MAX_DETECT_CHARS &&
        (NUMBER_RE.test(t) || ISO_DATE_RE.test(t) || BOOL_RE.test(t))
    )
  )
    return false
  return new Set(names.map((t) => t.toLowerCase())).size === names.length
}

/** The type a Mongo CSV column suggests from sampled values (empty values do not count). */
export function inferMongoType(
  values: ReadonlyArray<string | null | undefined>
): MongoImportFieldType {
  let n = 0
  let numbers = 0
  let bools = 0
  let dates = 0
  let ids = 0
  for (const value of values) {
    if (value === null || value === undefined) continue
    const t = value.trim()
    if (t === '') continue
    n++
    if (t.length > MAX_DETECT_CHARS) continue // text
    if (NUMBER_RE.test(t) && !hasLeadingZero(t)) numbers++
    if (BOOL_RE.test(t)) bools++
    if (OBJECT_ID_RE.test(t)) ids++
    if (ISO_DATE_RE.test(t) && parseImportDate(t, false)) dates++
  }
  if (n === 0) return 'string'
  if (ids === n) return 'objectId'
  if (numbers === n) return 'number'
  if (bools === n) return 'boolean'
  if (dates === n) return 'date'
  return 'string'
}

/**
 * ISO 8601 (date, or date and time with optional seconds, fraction and zone; a space may stand
 * for the T). Without a zone the time is UTC. `allowEpoch`: an integer is epoch milliseconds.
 */
export function parseImportDate(text: string, allowEpoch: boolean): Date | null {
  const t = text.trim()
  const m = ISO_DATE_RE.exec(t)
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', zone] = m
    const year = Number(y)
    const month = Number(mo)
    const day = Number(d)
    const hour = Number(h)
    const minute = Number(mi)
    const second = Number(s)
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
      return null
    const ms = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0
    // Not Date.UTC: it reads the years 0–99 as 1900–1999 (0001-01-01 would become 1901).
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hour, minute, second, ms)
    let time = date.getTime()
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day // Feb 30
    )
      return null
    if (zone && zone.toUpperCase() !== 'Z') {
      const sign = zone[0] === '-' ? -1 : 1
      const digits = zone.slice(1).replace(':', '')
      const offset = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || '0')
      time -= sign * offset * 60_000
    }
    return new Date(time)
  }
  if (allowEpoch && /^-?\d{1,15}$/.test(t)) return new Date(Number(t))
  return null
}

// ---------------------------------------------------------------------------------------------
// Values (pure; unit-tested)
// ---------------------------------------------------------------------------------------------

/** A value that the column's type cannot hold (Mongo CSV conversion). */
export class ImportValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportValueError'
  }
}

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/** Int32 when it fits, else Int64, else Double (Extended JSON / mongoimport semantics). */
function mongoNumber(t: string, bson: typeof Bson): unknown {
  // BigInt only for what can be an Int64 (BigInt of a huge digit string is slow).
  if (INT_RE.test(t) && integerDigits(t) <= INT64_DIGITS) {
    const big = BigInt(t)
    if (big >= BigInt(INT32_MIN) && big <= BigInt(INT32_MAX)) return new bson.Int32(Number(big))
    if (big >= INT64_MIN && big <= INT64_MAX) return bson.Long.fromBigInt(big)
  }
  return new bson.Double(Number(t))
}

const quoteForMessage = (text: string): string =>
  JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text)

/** One CSV value as `type` (throws ImportValueError when it does not convert). */
export function convertMongoValue(
  text: string,
  type: MongoImportFieldType,
  bson: typeof Bson
): unknown {
  const t = text.trim()
  const fail = (what: string): never => {
    throw new ImportValueError(`${quoteForMessage(text)} is not ${what}`)
  }
  switch (type) {
    case 'string':
      return text
    case 'number':
      if (!NUMBER_RE.test(t)) fail('a number')
      return mongoNumber(t, bson)
    case 'int32': {
      if (!INT_RE.test(t)) fail('an integer')
      const n = Number(t)
      if (n < INT32_MIN || n > INT32_MAX) fail('within the Int32 range')
      return new bson.Int32(n)
    }
    case 'int64': {
      if (!INT_RE.test(t)) fail('an integer')
      if (integerDigits(t) > INT64_DIGITS) fail('within the Int64 range')
      const big = BigInt(t)
      if (big < INT64_MIN || big > INT64_MAX) fail('within the Int64 range')
      return bson.Long.fromBigInt(big)
    }
    case 'double':
      if (!NUMBER_RE.test(t)) fail('a number')
      return new bson.Double(Number(t))
    case 'decimal':
      if (!NUMBER_RE.test(t)) fail('a decimal number')
      try {
        return bson.Decimal128.fromString(t.replace(/^\+/, ''))
      } catch {
        return fail('a Decimal128 value')
      }
    case 'boolean': {
      const l = t.toLowerCase()
      if (l === 'true' || l === '1' || l === 'yes' || l === 'y' || l === 't') return true
      if (l === 'false' || l === '0' || l === 'no' || l === 'n' || l === 'f') return false
      return fail('a boolean (true / false)')
    }
    case 'date': {
      const d = parseImportDate(t, true)
      if (!d) fail('a date (ISO 8601 such as 2024-05-01T10:00:00Z, or epoch milliseconds)')
      return d
    }
    case 'objectId':
      if (!OBJECT_ID_RE.test(t)) fail('an ObjectId (24 hex digits)')
      return new bson.ObjectId(t)
    case 'auto':
    default: {
      if (t === '' || t.length > MAX_DETECT_CHARS) return text
      if (NUMBER_RE.test(t) && !hasLeadingZero(t)) return mongoNumber(t, bson)
      if (BOOL_RE.test(t)) return t.toLowerCase() === 'true'
      if (OBJECT_ID_RE.test(t)) return new bson.ObjectId(t)
      if (ISO_DATE_RE.test(t)) {
        const d = parseImportDate(t, false)
        if (d) return d
      }
      return text
    }
  }
}

export interface MongoFieldSpec {
  source: number
  /** Field name for messages. */
  name: string
  /** Dotted path split into segments. */
  path: string[]
  type: MongoImportFieldType
}

/**
 * Sets an own, enumerable property. Never `target[key] = value`: with a key from the file,
 * `__proto__` would replace the object's prototype, and walking `__proto__` or
 * `constructor.prototype` would reach Object.prototype and change every object of the process.
 */
const defineOwn = (target: object, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true
  })
}

/** An own property's value (never one inherited from the prototype chain). */
const ownValue = (target: object, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(target, key)
    ? (target as Record<string, unknown>)[key]
    : undefined

/**
 * Builds one document from a CSV record (throws ImportValueError naming the field). Only own
 * properties are read and written, so no field path (`__proto__.x`, `constructor.prototype.x`)
 * can reach a prototype; validateMongoFieldPaths refuses those names before this runs.
 */
export function buildMongoDocument(
  fields: ReadonlyArray<string | null>,
  specs: readonly MongoFieldSpec[],
  empty: DataImportEmptyMode,
  bson: typeof Bson
): Record<string, unknown> {
  const doc: Record<string, unknown> = {}
  /** The objects this call created for nested paths (the only ones it may write into). */
  const containers = new Set<object>([doc])
  for (const spec of specs) {
    const raw = fields[spec.source] ?? null
    let value: unknown
    // An unquoted empty field follows `empty`; so does a blank value in a typed column. A quoted
    // "" (or blank text) stays a string in String / Auto columns.
    const blank =
      raw === null || (spec.type !== 'string' && spec.type !== 'auto' && raw.trim() === '')
    if (blank) {
      if (empty === 'omit') continue
      value = empty === 'null' ? null : ''
    } else {
      try {
        value = convertMongoValue(raw, spec.type, bson)
      } catch (error) {
        if (error instanceof ImportValueError)
          throw new ImportValueError(`field "${spec.name}": ${error.message}`)
        throw error
      }
    }
    let target: object = doc
    for (let i = 0; i < spec.path.length - 1; i++) {
      const key = spec.path[i]
      const next = ownValue(target, key)
      if (next === undefined) {
        const created: Record<string, unknown> = {}
        defineOwn(target, key, created)
        containers.add(created)
        target = created
      } else if (typeof next === 'object' && next !== null && containers.has(next)) {
        target = next
      } else {
        // validateMongoFieldPaths refuses a path inside another; this is the guard.
        throw new ImportValueError(
          `field "${spec.name}": "${spec.path.slice(0, i + 1).join('.')}" already holds a value`
        )
      }
    }
    defineOwn(target, spec.path[spec.path.length - 1], value)
  }
  return doc
}

const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(MONGO_IMPORT_RESERVED_FIELD_NAMES)

/**
 * Field paths of a Mongo CSV mapping: no empty segment, no `$` segment, no reserved segment
 * (`__proto__`, `constructor`, `prototype`), no path inside another.
 */
export function validateMongoFieldPaths(names: readonly string[]): string[][] {
  const paths = names.map((name) => {
    const trimmed = name.trim()
    if (!trimmed) throw invalidInputError('A field name is empty.')
    const segments = trimmed.split('.')
    for (const segment of segments) {
      if (!segment) throw invalidInputError(`The field name "${trimmed}" has an empty part.`)
      if (segment.startsWith('$'))
        throw invalidInputError(`The field name "${trimmed}" cannot start a part with "$".`)
      if (RESERVED_FIELD_NAMES.has(segment))
        throw invalidInputError(
          `The field name "${trimmed}" uses "${segment}", which cannot be a field name (rename the field).`
        )
    }
    return segments
  })
  const seen = new Map<string, string>()
  for (let i = 0; i < paths.length; i++) {
    const key = paths[i].join('.')
    if (seen.has(key)) throw invalidInputError(`Two columns write the field "${key}".`)
    seen.set(key, key)
  }
  for (const a of paths) {
    for (const b of paths) {
      if (a.length < b.length && a.every((seg, i) => b[i] === seg)) {
        throw invalidInputError(
          `The field "${a.join('.')}" cannot hold a value and the field "${b.join('.')}" at once.`
        )
      }
    }
  }
  return paths
}

/** How a SQL column's literals are written (beyond plain quoted text). */
export type SqlColumnKind = 'bit' | 'bool' | 'other'

export function sqlColumnKind(dialect: SqlDialect, type: string): SqlColumnKind {
  let t = type.trim().toLowerCase()
  for (let i = 0; i < 3; i++) t = t.replace(/^(nullable|lowcardinality)\((.*)\)$/, '$2')
  if (dialect === 'mysql' || dialect === 'mariadb') {
    if (/^bit(\(\d+\))?$/.test(t)) return 'bit'
    if (/^(tinyint\(1\)|bool|boolean)(\s|$)/.test(t)) return 'bool'
  }
  if (dialect === 'sqlite' && /\bbool/.test(t)) return 'bool'
  return 'other'
}

/**
 * The SQL literal of one CSV field. Text goes in quoted (every engine converts a quoted literal
 * to the column's type, ClickHouse included); MySQL BIT digits go in unquoted ('5' would store
 * the byte 0x35), and true/false become 1/0 for MySQL tinyint(1) and SQLite BOOLEAN columns.
 */
export function sqlLiteral(
  value: string | null,
  kind: SqlColumnKind,
  dialect: SqlDialect,
  quote: SqlQuoteOptions,
  empty: DataImportEmptyMode
): string {
  if (value === null) return empty === 'empty' ? quoteSqlLiteral('', dialect, quote) : 'NULL'
  if (kind === 'bit') {
    const t = value.trim()
    if (/^\d+$/.test(t) || /^b'[01]*'$/i.test(t)) return t
  } else if (kind === 'bool') {
    const t = value.trim().toLowerCase()
    if (t === 'true') return '1'
    if (t === 'false') return '0'
  }
  return quoteSqlLiteral(value, dialect, quote)
}

// ---------------------------------------------------------------------------------------------
// Errors of a run
// ---------------------------------------------------------------------------------------------

const PG_FATAL_CLASSES = new Set(['08', '25', '28', '40', '42', '53', '55', '57', '58', 'XX'])
const MYSQL_FATAL = new Set([
  '1036',
  '1044',
  '1045',
  '1054',
  '1142',
  '1143',
  '1146',
  '1205',
  '1213',
  '1290',
  '1317',
  '1792',
  '2006',
  '2013',
  '3024'
])
const CLICKHOUSE_FATAL = new Set([
  '16',
  '47',
  '60',
  '81',
  '159',
  '164',
  '202',
  '209',
  '210',
  '241',
  '252',
  '394',
  '497',
  '516'
])
const SQLITE_FATAL =
  /^SQLITE_(READONLY|BUSY|LOCKED|FULL|IOERR|CORRUPT|NOTADB|INTERRUPT|PERM|AUTH|CANTOPEN|WORKER|TIMEOUT|MISUSE)/
const FATAL_MESSAGE =
  /no such table|has no column named|doesn't exist|does not exist|permission denied|access denied|read-only|readonly|denied/i

/** A failure that is not about one row: splitting the batch would only repeat it. */
export function isStatementLevelError(
  error: unknown,
  engine: DataEngine,
  driver?: Pick<DataDriver, 'isConnected'>
): boolean {
  if (error instanceof DataDriverError && error.cancelled) return true
  if (error instanceof QueueAbortedError) return true
  if (driver && !driver.isConnected()) return true
  if (isConnectionLostError(error)) return true
  const code = String((error as { code?: unknown } | null)?.code ?? '')
  if (code) {
    switch (engine) {
      case 'postgres':
        if (/^[0-9A-Z]{5}$/.test(code)) return PG_FATAL_CLASSES.has(code.slice(0, 2))
        break
      case 'mysql':
      case 'mariadb':
        if (/^\d+$/.test(code)) return MYSQL_FATAL.has(code)
        break
      case 'clickhouse':
        if (/^\d+$/.test(code)) return CLICKHOUSE_FATAL.has(code)
        break
      case 'sqlite':
        if (SQLITE_FATAL.test(code)) return true
        if (code.startsWith('SQLITE_CONSTRAINT') || code === 'SQLITE_MISMATCH') return false
        break
      default:
        break
    }
  }
  return FATAL_MESSAGE.test(errorMessage(error))
}

/** A driver error as one readable line: message (+ PostgreSQL detail), ClickHouse noise cut. */
export function importErrorText(
  error: unknown,
  engine: DataEngine,
  redact: (text: string) => string = (t) => t
): string {
  let text = errorMessage(error, redact)
  const detail = error instanceof DataDriverError ? error.detail : undefined
  if (detail && !/^SQLSTATE/i.test(detail)) text = `${text} — ${redact(detail).split('\n')[0]}`
  if (engine === 'clickhouse') {
    text = text
      .replace(/: while executing '[\s\S]*?'(?=[:.])/g, '')
      .replace(/\s*\(version [^()]*(\([^()]*\))?[^()]*\)\s*$/, '')
      .replace(/\s*Note: there are \w+ and \w+ functions[^.]*\.:?\s*/g, ' ')
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text
}

const fmtCount = (n: number): string => n.toLocaleString('en-US')

const rowLabel = (e: DataImportRowError): string => {
  const rows =
    e.rowTo && e.rowTo !== e.row
      ? `Rows ${fmtCount(e.row)}–${fmtCount(e.rowTo)}`
      : `Row ${fmtCount(e.row)}`
  return e.line ? `${rows} (line ${fmtCount(e.line)})` : rows
}

export const describeRowError = (e: DataImportRowError): string => `${rowLabel(e)}: ${e.message}`

// ---------------------------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------------------------

interface ImportFile {
  path: string
  name: string
  size: number
  mtimeMs: number
}

async function statImportFile(filePath: string): Promise<ImportFile> {
  const path = filePath.trim()
  if (!path || !isAbsolute(path)) throw invalidInputError('The import file path must be absolute.')
  let info
  try {
    info = await stat(path)
  } catch {
    throw invalidInputError(`The file ${basename(path)} does not exist or cannot be read.`)
  }
  if (!info.isFile()) throw invalidInputError(`${basename(path)} is not a file.`)
  return { path, name: basename(path), size: info.size, mtimeMs: info.mtimeMs }
}

async function readHead(path: string, bytes: number): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * `fatal`: invalid bytes throw instead of becoming U+FFFD (Windows-1252 decodes every byte, so it
 * never throws). Imports decode fatally; the preview's display falls back to replacing.
 */
const makeDecoder = (
  encoding: DataImportEncoding,
  options: { fatal?: boolean; ignoreBOM?: boolean } = {}
): TextDecoder => {
  try {
    return new TextDecoder(encoding, {
      fatal: options.fatal === true && encoding !== 'windows-1252',
      ignoreBOM: options.ignoreBOM === true
    })
  } catch {
    throw unsupportedError(`The ${encoding} encoding is not available.`)
  }
}

const cancelledError = (): DataDriverError =>
  new DataDriverError('The import was cancelled.', { cancelled: true, code: 'CANCELLED' })

/**
 * The file's bytes are not valid in the chosen encoding (readText). The readers turn it into an
 * ImportSyntaxError with the line they reached, so nothing is written with characters replaced.
 */
export class ImportEncodingError extends Error {
  constructor(
    readonly encoding: DataImportEncoding,
    /** 0-based offset of the first invalid byte (approximate when it cannot be pinned down). */
    readonly byteOffset: number,
    /** The file ends inside a character. */
    readonly atEnd: boolean
  ) {
    super(describeEncodingError(encoding, byteOffset, atEnd))
    this.name = 'ImportEncodingError'
  }
}

function describeEncodingError(
  encoding: DataImportEncoding,
  byteOffset: number,
  atEnd: boolean
): string {
  const label = DATA_IMPORT_ENCODING_LABELS[encoding]
  const what = atEnd
    ? `The file ends inside a ${label} character (byte ${fmtCount(byteOffset + 1)})`
    : `The file is not valid ${label} at byte ${fmtCount(byteOffset + 1)}`
  const hint =
    encoding === 'utf-8'
      ? 'If it was saved by Excel or an older program, choose the Windows-1252 (Latin-1) encoding; nothing is imported with characters replaced.'
      : 'Choose the encoding the file was written in; nothing is imported with characters replaced.'
  return `${what}. ${hint}`
}

/** An ImportEncodingError as the ImportSyntaxError of the line a reader reached. */
const atLine = (error: unknown, line: number): unknown =>
  error instanceof ImportEncodingError ? new ImportSyntaxError(error.message, line) : error

const NO_BYTES = new Uint8Array(0)

/**
 * The bytes at the end of `previous` that a streaming decoder still holds (an unfinished
 * character), given that `consumed` bytes of the file came before the next chunk.
 */
function pendingBytes(
  encoding: DataImportEncoding,
  previous: Uint8Array,
  consumed: number
): Uint8Array {
  const n = previous.length
  if (encoding === 'utf-8') {
    for (let back = 1; back <= Math.min(3, n); back++) {
      const b = previous[n - back]
      if ((b & 0xc0) === 0x80) continue // a continuation byte
      if (b < 0xc0) return NO_BYTES // ASCII: nothing unfinished
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2
      return need > back ? previous.subarray(n - back) : NO_BYTES
    }
    return NO_BYTES
  }
  if (encoding !== 'utf-16le' && encoding !== 'utf-16be') return NO_BYTES
  // Half a code unit, and a high surrogate waiting for its low half.
  let start = n - (consumed % 2)
  if (start >= 2) {
    const unit =
      encoding === 'utf-16le'
        ? previous[start - 2] | (previous[start - 1] << 8)
        : (previous[start - 2] << 8) | previous[start - 1]
    if (unit >= 0xd800 && unit <= 0xdbff) start -= 2
  }
  return previous.subarray(Math.max(0, start))
}

/**
 * Where in `chunk` the bytes stop being valid (a fatal decoder threw on it), and the text of the
 * valid bytes before that point (with what `previous` left unfinished), so the reader can still
 * parse the rows before the bad byte and report its line. Error path only: a binary search with
 * fresh decoders over prefixes of the chunk.
 */
function locateInvalidBytes(
  encoding: DataImportEncoding,
  previous: Uint8Array | null,
  chunk: Uint8Array,
  chunkStart: number
): { offset: number; validText: string } {
  const pending = previous ? pendingBytes(encoding, previous, chunkStart) : NO_BYTES
  const decodePrefix = (k: number): string | null => {
    // Mid-file a U+FEFF is a character, not a BOM to drop.
    const decoder = makeDecoder(encoding, { fatal: true, ignoreBOM: chunkStart > 0 })
    try {
      const head = pending.length > 0 ? decoder.decode(pending, { stream: true }) : ''
      return head + decoder.decode(chunk.subarray(0, k), { stream: true })
    } catch {
      return null
    }
  }
  if (decodePrefix(0) === null || decodePrefix(chunk.length) !== null)
    return { offset: chunkStart, validText: '' } // cannot pin it down: the chunk's start
  // decodePrefix(lo) works, decodePrefix(hi) fails.
  let lo = 0
  let hi = chunk.length
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1
    if (decodePrefix(mid) === null) hi = mid
    else lo = mid
  }
  // The byte at `lo` shows the error; in UTF-8 it may break a sequence that started a little
  // earlier (a Latin-1 "é" followed by ","), possibly in the previous chunk: report the lead
  // byte of that unfinished sequence.
  let at = lo
  if (encoding === 'utf-8') {
    const byteAt = (i: number): number => (i >= 0 ? chunk[i] : pending[pending.length + i])
    for (let back = 1; back <= 3 && lo - back >= -pending.length; back++) {
      const b = byteAt(lo - back)
      if ((b & 0xc0) === 0x80) continue // a continuation byte
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
      if (need > back) at = lo - back
      break
    }
  }
  return { offset: chunkStart + at, validText: decodePrefix(lo) ?? '' }
}

/**
 * The file as decoded text pieces; `onBytes` counts raw bytes. Stops when `signal` aborts.
 * Invalid bytes for `encoding` end it with an ImportEncodingError after the valid text before
 * them (`lenient`: they become U+FFFD instead; only the preview's display reads that way).
 */
async function* readText(
  path: string,
  encoding: DataImportEncoding,
  signal: AbortSignal | null,
  onBytes?: (bytes: number) => void,
  lenient = false
): AsyncGenerator<string> {
  const decoder = makeDecoder(encoding, { fatal: !lenient })
  const stream = createReadStream(path, { highWaterMark: READ_CHUNK_BYTES })
  let consumed = 0
  let previous: Uint8Array | null = null
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (signal?.aborted) throw cancelledError()
      onBytes?.(chunk.length)
      let text: string
      try {
        text = decoder.decode(chunk, { stream: true })
      } catch {
        const found = locateInvalidBytes(encoding, previous, chunk, consumed)
        if (found.validText) yield found.validText
        throw new ImportEncodingError(encoding, found.offset, false)
      }
      if (text) yield text
      consumed += chunk.length
      previous = chunk
    }
    let tail: string
    try {
      tail = decoder.decode()
    } catch {
      const unfinished = previous ? pendingBytes(encoding, previous, consumed).length : 0
      throw new ImportEncodingError(encoding, Math.max(0, consumed - unfinished), true)
    }
    if (tail) yield tail
  } finally {
    stream.destroy()
  }
}

/** One data row (CSV) or document text (JSON formats) of the file. */
interface FileItem {
  /** 1-based data row / document number. */
  row: number
  line: number
  fields?: Array<string | null>
  text?: string
}

interface ReadSpec {
  path: string
  encoding: DataImportEncoding
  format: DataImportFormat
  csv: DataImportCsvOptions | null
  /**
   * SQL tables: in a one-column CSV file a blank line is a row with a NULL (empty) value, the
   * way our export and PostgreSQL's COPY write one. Collections skip blank lines like
   * mongoimport (a row there would be an empty document).
   */
  blankLineRows: boolean
}

/** What the CSV header (or the first record without one) says about the columns. */
interface FileShape {
  header: Array<string | null> | null
  fieldCount: number | null
}

/**
 * The file's items, a chunk's worth at a time. A CSV header record is consumed into `shape`.
 * Parser syntax errors (ImportSyntaxError) end the stream.
 */
async function* readItems(
  spec: ReadSpec,
  signal: AbortSignal | null,
  shape: FileShape,
  onBytes?: (bytes: number) => void
): AsyncGenerator<FileItem[]> {
  let row = 0
  if (spec.format === 'csv') {
    const csv = spec.csv!
    const parser = new CsvParser({
      delimiter: csv.delimiter,
      quote: csv.quote,
      keepBlankLines: true
    })
    let headerPending = csv.header
    const convert = (records: CsvRecord[]): FileItem[] => {
      const items: FileItem[] = []
      for (const record of records) {
        if (record.blank) {
          // In a one-column file a blank line is a NULL value (how our export and PostgreSQL's
          // COPY write one); anywhere else it is nothing.
          if (!spec.blankLineRows || headerPending || shape.fieldCount !== 1) continue
        } else if (headerPending) {
          headerPending = false
          shape.header = record.fields
          shape.fieldCount = record.fields.length
          continue
        }
        if (shape.fieldCount === null) shape.fieldCount = record.fields.length
        items.push({ row: ++row, line: record.line, fields: record.fields })
      }
      return items
    }
    try {
      for await (const text of readText(spec.path, spec.encoding, signal, onBytes)) {
        const records: CsvRecord[] = []
        parser.push(text, records)
        if (records.length > 0) yield convert(records)
      }
      const last: CsvRecord[] = []
      parser.end(last)
      if (last.length > 0) yield convert(last)
    } catch (error) {
      throw atLine(error, parser.currentLine)
    }
    return
  }
  const splitter = new JsonDocumentSplitter(spec.format === 'json' ? 'array' : 'sequence')
  const convert = (docs: JsonDocumentText[]): FileItem[] =>
    docs.map((d) => ({ row: ++row, line: d.line, text: d.text }))
  try {
    for await (const text of readText(spec.path, spec.encoding, signal, onBytes)) {
      const docs: JsonDocumentText[] = []
      splitter.push(text, docs)
      if (docs.length > 0) yield convert(docs)
    }
    const last: JsonDocumentText[] = []
    splitter.end(last)
    if (last.length > 0) yield convert(last)
  } catch (error) {
    throw atLine(error, splitter.currentLine)
  }
}

/** A run of 16 digits: the text may hold an integer JSON.parse cannot keep exact (≥ 2^53). */
const LONG_DIGIT_RUN = /\d{16}/
const JSON_INTEGER_SOURCE = /^-?\d+$/

/**
 * Extended JSON with exact integers. EJSON.parse reads numbers through JSON.parse, which rounds
 * an integer beyond ±2^53 to a double (9007199254740993 → 9007199254740992) before EJSON makes
 * it a Long. Here a reviver reads such an integer from its source text (JSON.parse source text
 * access) and makes it `{ $numberLong: "<digits>" }`, which EJSON then turns into the exact
 * Long. Integers outside the Int64 range stay Double, like mongoimport; `outOfRange` reports
 * that. Only texts with a 16-digit run take this path (shorter integers are exact anyway).
 */
function parseExactJson(text: string, bson: typeof Bson): { value: unknown; outOfRange: boolean } {
  let outOfRange = false
  const raw: unknown = JSON.parse(
    text,
    (_key: string, value: unknown, context?: { source?: string }): unknown => {
      if (typeof value !== 'number') return value
      // EJSON keeps -0 a Double; written back as text below it would read as the integer 0.
      if (Object.is(value, -0)) return { $numberDouble: '-0.0' }
      if (Number.isSafeInteger(value) || !Number.isInteger(value)) return value
      const source = context?.source
      if (source === undefined) {
        throw new Error(
          `the integer ${value} is beyond ±2^53 and cannot be read exactly here; write it as {"$numberLong": "…"}`
        )
      }
      if (!JSON_INTEGER_SOURCE.test(source)) return value // 1e20 and the like: a Double
      const big = BigInt(source)
      if (big < INT64_MIN || big > INT64_MAX) {
        outOfRange = true
        return value
      }
      return { $numberLong: source }
    }
  )
  return {
    value: bson.EJSON.deserialize(raw as Bson.Document, { relaxed: false }),
    outOfRange
  }
}

/** A JSON object (not an array, a scalar or a top-level Extended JSON value like `{"$oid"…}`). */
const isPlainDocument = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * A parsed JSON document, or why it is not one. `outOfRange`: it has an integer beyond the
 * Int64 range, stored as a (rounded) Double.
 */
export function parseJsonDocument(
  text: string,
  bson: typeof Bson
):
  | { ok: true; doc: Record<string, unknown>; outOfRange?: boolean }
  | { ok: false; message: string } {
  let value: unknown
  let outOfRange = false
  try {
    // relaxed:false keeps mongoimport's number typing (Int32 / Int64 / Double).
    if (LONG_DIGIT_RUN.test(text)) ({ value, outOfRange } = parseExactJson(text, bson))
    else value = bson.EJSON.parse(text, { relaxed: false })
  } catch (error) {
    return { ok: false, message: `Invalid JSON: ${errorMessage(error)}` }
  }
  if (!isPlainDocument(value)) {
    const wrapper = typeof value === 'object' && value !== null && !Array.isArray(value)
    return {
      ok: false,
      message: wrapper
        ? 'is an Extended JSON value ($oid, $date…), not a document (every document must be { … })'
        : 'is not a JSON object (every document must be { … })'
    }
  }
  return outOfRange ? { ok: true, doc: value, outOfRange } : { ok: true, doc: value }
}

// ---------------------------------------------------------------------------------------------
// Request → spec
// ---------------------------------------------------------------------------------------------

interface SqlColumnSpec {
  source: number
  name: string
  kind: SqlColumnKind
}

type TargetSpec =
  | {
      kind: 'table'
      dialect: SqlDialect
      ref: DataObjectRef
      columns: SqlColumnSpec[]
      /**
       * One row per INSERT (stop / skip): the table's engine is not transactional (MySQL /
       * MariaDB MyISAM, MEMORY, Aria…), so a failing multi-row INSERT keeps the rows before the
       * failing one and only the first row's bad value is an error under STRICT_TRANS_TABLES
       * (the others are clipped with a warning).
       */
      rowByRow: boolean
    }
  | {
      kind: 'collection'
      database: string
      collection: string
      /** CSV only. */
      fields: MongoFieldSpec[] | null
    }

interface ImportSpec extends ReadSpec {
  record: DataProjectRecord
  file: ImportFile
  target: TargetSpec
  empty: DataImportEmptyMode
  onError: DataImportOnError
  batchSize: number
  /** Highest mapped source column (checked against the file's field count). */
  maxSource: number
}

const familyOf = (record: DataProjectRecord): 'sql' | 'document' =>
  record.engine === 'mongodb' ? 'document' : 'sql'

/** Transactions for this target, or why not. */
export function transactionSupport(
  engine: DataEngine,
  details?: Pick<DataTableDetails, 'engine'> | null
): { supported: boolean; note?: string } {
  if (engine === 'clickhouse')
    return {
      supported: false,
      note: 'ClickHouse has no transactions: rows inserted before a failure stay.'
    }
  if (engine === 'mongodb')
    return {
      supported: false,
      note: 'MongoDB imports run in batches without a transaction: documents inserted before a failure stay.'
    }
  if (nonTransactionalTable(engine, details))
    return {
      supported: false,
      note: `${details!.engine} tables are not transactional: rows inserted before a failure stay (they are inserted one at a time).`
    }
  return { supported: true }
}

/** A MySQL / MariaDB table whose storage engine has no transactions (anything but InnoDB). */
export const nonTransactionalTable = (
  engine: DataEngine,
  details?: Pick<DataTableDetails, 'engine'> | null
): boolean =>
  (engine === 'mysql' || engine === 'mariadb') &&
  !!details?.engine &&
  !/^innodb$/i.test(details.engine.trim())

const assertImportableTable = (details: DataTableDetails): void => {
  if (details.kind && details.kind !== 'table')
    throw unsupportedError('Only tables can be imported into (not views or other objects).')
}

const normalizeCsv = (csv: DataImportCsvOptions | undefined): DataImportCsvOptions => {
  if (!csv) throw invalidInputError('CSV options are required for a CSV import.')
  if (csv.delimiter.length !== 1)
    throw invalidInputError('The delimiter must be a single character.')
  if (csv.quote !== '"' && csv.quote !== "'" && csv.quote !== '')
    throw invalidInputError('The quote character must be " or \' (or none).')
  if (csv.delimiter === csv.quote)
    throw invalidInputError('The delimiter and the quote character must differ.')
  return { delimiter: csv.delimiter, quote: csv.quote, header: csv.header }
}

async function resolveSpec(
  deps: ImportDeps,
  record: DataProjectRecord,
  req: DataImportStartRequest
): Promise<ImportSpec> {
  const family = familyOf(record)
  if (!(DATA_IMPORT_FORMATS as readonly string[]).includes(req.format))
    throw invalidInputError('Unknown import format.')
  if (!(DATA_IMPORT_ENCODINGS as readonly string[]).includes(req.encoding))
    throw invalidInputError('Unknown encoding.')
  if (family === 'sql' && req.format !== 'csv')
    throw invalidInputError('SQL tables import CSV / TSV files.')
  const csv = req.format === 'csv' ? normalizeCsv(req.csv) : null
  const batchSize = Math.max(
    1,
    Math.min(
      Math.trunc(
        req.batchSize ||
          (family === 'sql' ? DATA_IMPORT_SQL_BATCH_ROWS : DATA_IMPORT_MONGO_BATCH_ROWS)
      ),
      DATA_IMPORT_MAX_BATCH_ROWS
    )
  )
  const file = await statImportFile(req.filePath)
  const base = {
    record,
    file,
    path: file.path,
    encoding: req.encoding,
    format: req.format,
    csv,
    blankLineRows: family === 'sql',
    empty: req.empty,
    onError: req.onError,
    batchSize
  }

  if (req.target.kind === 'table') {
    if (family !== 'sql') throw invalidInputError('This data project imports into collections.')
    const dialect = sqlDialectOf(record.engine)!
    const details = await deps.describe(record.id, req.target.ref)
    assertImportableTable(details)
    if (req.empty === 'omit')
      throw invalidInputError('SQL imports write empty values as NULL or as empty strings.')
    if (req.onError === 'rollback') {
      const tx = transactionSupport(record.engine, details)
      if (!tx.supported) throw unsupportedError(tx.note ?? 'Transactions are not available here.')
    }
    const mapping = req.columns ?? []
    if (mapping.length === 0)
      throw invalidInputError('Map at least one file column to a table column.')
    const byName = new Map<string, DataColumnInfo>(details.columns.map((c) => [c.name, c]))
    const used = new Set<string>()
    const columns: SqlColumnSpec[] = mapping.map((m) => {
      if (!Number.isInteger(m.source) || m.source < 0)
        throw invalidInputError('A column mapping has an invalid source column.')
      if (byName.size > 0 && !byName.has(m.target))
        throw invalidInputError(`The table has no column "${m.target}".`)
      if (used.has(m.target))
        throw invalidInputError(`Two file columns are mapped to "${m.target}".`)
      used.add(m.target)
      return {
        source: m.source,
        name: m.target,
        kind: sqlColumnKind(dialect, byName.get(m.target)?.type ?? '')
      }
    })
    const ref: DataObjectRef = {
      ...req.target.ref,
      schema: req.target.ref.schema ?? details.ref.schema,
      database: req.target.ref.database ?? details.ref.database
    }
    return {
      ...base,
      target: {
        kind: 'table',
        dialect,
        ref,
        columns,
        rowByRow: nonTransactionalTable(record.engine, details)
      },
      maxSource: Math.max(...columns.map((c) => c.source))
    }
  }

  if (family !== 'document') throw invalidInputError('This data project imports into tables.')
  const database = req.target.database.trim()
  const collection = req.target.collection.trim()
  if (!database || !collection) throw invalidInputError('Choose a database and a collection.')
  if (req.onError === 'rollback') throw unsupportedError(transactionSupport('mongodb').note!)
  let fields: MongoFieldSpec[] | null = null
  let maxSource = -1
  if (req.format === 'csv') {
    const mapping: DataImportColumnMapping[] = req.columns ?? []
    if (mapping.length === 0) throw invalidInputError('Import at least one column.')
    const paths = validateMongoFieldPaths(mapping.map((m) => m.target))
    fields = mapping.map((m, i) => {
      if (!Number.isInteger(m.source) || m.source < 0)
        throw invalidInputError('A column mapping has an invalid source column.')
      const type = m.type ?? 'string'
      if (!(MONGO_IMPORT_TYPES as readonly string[]).includes(type))
        throw invalidInputError(`Unknown type "${type}".`)
      return { source: m.source, name: m.target.trim(), path: paths[i], type }
    })
    maxSource = Math.max(...fields.map((f) => f.source))
  }
  return {
    ...base,
    target: { kind: 'collection', database, collection, fields },
    maxSource
  }
}

// ---------------------------------------------------------------------------------------------
// Scan (count + structural check, cached)
// ---------------------------------------------------------------------------------------------

interface ScanResult {
  rowsRead: number
  validRows: number
  errorCount: number
  errors: DataImportRowError[]
  at: number
}

const scanCache = new Map<string, ScanResult>()

const scanKey = (spec: ImportSpec): string =>
  JSON.stringify([
    spec.file.path,
    spec.file.size,
    spec.file.mtimeMs,
    spec.format,
    spec.encoding,
    spec.csv,
    spec.maxSource,
    spec.target.kind === 'collection' ? spec.target.fields : null,
    spec.target.kind === 'collection' ? spec.empty : null
  ])

/** Tests. */
export const clearImportScanCache = (): void => scanCache.clear()

/**
 * The per-item check shared by the scan and the import pass, so both skip the same rows:
 * field count (CSV), JSON object (JSON formats), Mongo CSV conversions.
 */
function itemChecker(
  spec: ImportSpec,
  shape: FileShape,
  bson: typeof Bson | null
): (
  item: FileItem
) => { ok: true; doc?: Record<string, unknown> } | { ok: false; message: string } {
  return (item) => {
    if (item.fields) {
      const expected = shape.fieldCount ?? item.fields.length
      if (spec.maxSource >= expected) {
        throw invalidInputError(
          `The mapping uses column ${spec.maxSource + 1}, but the file has ${expected} column${expected === 1 ? '' : 's'}.`
        )
      }
      if (item.fields.length !== expected) {
        return {
          ok: false,
          message: `has ${item.fields.length} field${item.fields.length === 1 ? '' : 's'}; ${shape.header ? 'the header has' : 'the first row has'} ${expected}`
        }
      }
      if (spec.target.kind === 'collection' && spec.target.fields) {
        try {
          return {
            ok: true,
            doc: buildMongoDocument(item.fields, spec.target.fields, spec.empty, bson!)
          }
        } catch (error) {
          if (error instanceof ImportValueError) return { ok: false, message: error.message }
          throw error
        }
      }
      return { ok: true }
    }
    const parsed = parseJsonDocument(item.text ?? '', bson!)
    if (!parsed.ok) return parsed
    return { ok: true, doc: parsed.doc }
  }
}

interface Counters {
  rowsRead: number
  imported: number
  /** Rows of an interrupted batch that may or may not be in (DataImportSummary.rowsUncertain). */
  uncertain: number
  skipped: number
  errorCount: number
  errors: DataImportRowError[]
}

const newCounters = (): Counters => ({
  rowsRead: 0,
  imported: 0,
  uncertain: 0,
  skipped: 0,
  errorCount: 0,
  errors: []
})

const recordError = (counters: Counters, error: DataImportRowError): void => {
  counters.errorCount++
  if (counters.errors.length < DATA_IMPORT_MAX_REPORTED_ERRORS) counters.errors.push(error)
}

interface Progress {
  phase: DataImportProgressEvent['phase']
  bytesRead: number
  totalRows: number | null
  counters: Counters
  emit(force?: boolean, extra?: { done?: boolean; error?: string }): void
}

async function scanFile(
  spec: ImportSpec,
  bson: typeof Bson | null,
  signal: AbortSignal,
  progress: Progress,
  now: () => number
): Promise<ScanResult> {
  const key = scanKey(spec)
  const hit = scanCache.get(key)
  if (hit && now() - hit.at < SCAN_CACHE_TTL_MS) return hit
  const shape: FileShape = { header: null, fieldCount: null }
  const check = itemChecker(spec, shape, bson)
  const result: ScanResult = { rowsRead: 0, validRows: 0, errorCount: 0, errors: [], at: 0 }
  progress.phase = 'scanning'
  progress.bytesRead = 0
  try {
    for await (const items of readItems(spec, signal, shape, (n) => (progress.bytesRead += n))) {
      for (const item of items) {
        result.rowsRead++
        const verdict = check(item)
        if (verdict.ok) result.validRows++
        else {
          result.errorCount++
          if (result.errors.length < DATA_IMPORT_MAX_REPORTED_ERRORS)
            result.errors.push({ row: item.row, line: item.line, message: verdict.message })
        }
      }
      progress.counters.rowsRead = result.rowsRead
      progress.emit()
    }
  } catch (error) {
    if (error instanceof ImportSyntaxError) {
      // Nothing can be read past this point: the whole file is refused before writing.
      result.errorCount++
      result.errors.push({ row: result.rowsRead + 1, line: error.line, message: error.message })
      result.validRows = 0
      result.at = now()
      return result
    }
    throw error
  }
  result.at = now()
  scanCache.set(key, result)
  while (scanCache.size > SCAN_CACHE_MAX) {
    const oldest = scanCache.keys().next().value
    if (oldest === undefined) break
    scanCache.delete(oldest)
  }
  return result
}

// ---------------------------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------------------------

/** Plain display text of a document value for the preview grid. */
const displayValue = (value: unknown, bson: typeof Bson): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  try {
    return bson.EJSON.stringify(value as never, { relaxed: true })
  } catch {
    return String(value)
  }
}

export async function previewImport(
  deps: ImportDeps,
  req: DataImportPreviewRequest
): Promise<DataImportPreviewResponse> {
  const record = deps.getRecord(req.dataProjectId)
  const family = familyOf(record)
  if ((req.target.kind === 'table') !== (family === 'sql'))
    throw invalidInputError(
      family === 'sql'
        ? 'This data project imports into tables.'
        : 'This data project imports into collections.'
    )
  const limit = Math.max(
    1,
    Math.min(Math.trunc(req.limit || DATA_IMPORT_PREVIEW_ROWS), DATA_IMPORT_MAX_PREVIEW_ROWS)
  )
  const file = await statImportFile(req.filePath)
  const head = await readHead(file.path, DETECT_BYTES)
  const detectedEncoding = detectEncoding(head)
  const encoding = req.encoding ?? detectedEncoding
  const headText = makeDecoder(encoding).decode(head, { stream: true })
  const detectedFormat = detectFormat(file.name, headText, family)
  const format = req.format ?? detectedFormat
  if (family === 'sql' && format !== 'csv')
    throw invalidInputError('SQL tables import CSV / TSV files.')
  const warnings: string[] = []
  if (!req.encoding && detectedEncoding === 'windows-1252')
    warnings.push(
      'The file is not valid UTF-8, so it is read as Windows-1252 (Latin-1). Pick another encoding if characters look wrong.'
    )

  let tableColumns: DataColumnInfo[] | undefined
  let tx = transactionSupport(record.engine)
  if (req.target.kind === 'table') {
    const details = await deps.describe(record.id, req.target.ref)
    assertImportableTable(details)
    tableColumns = details.columns
    tx = transactionSupport(record.engine, details)
  }
  const bson = family === 'document' ? await loadBson(deps) : null

  const base = {
    fileName: file.name,
    fileSize: file.size,
    encoding,
    format,
    supportsTransaction: tx.supported,
    ...(tx.note ? { transactionNote: tx.note } : {}),
    ...(tableColumns ? { tableColumns } : {})
  }

  if (format === 'csv') {
    // The delimiter is read with double quotes first; single-quoted files then re-read it.
    let detectedDelimiter = detectDelimiter(headText, file.name, req.csv?.quote ?? '"')
    const detectedQuote = detectQuote(headText, req.csv?.delimiter ?? detectedDelimiter)
    if (detectedQuote !== '"' && req.csv?.quote === undefined)
      detectedDelimiter = detectDelimiter(headText, file.name, detectedQuote)
    const quote: DataImportQuote = req.csv?.quote ?? detectedQuote
    const delimiter = req.csv?.delimiter ?? detectedDelimiter
    const parserOptions = { delimiter, quote }
    // Validate the overrides before reading.
    new CsvParser(parserOptions)
    const want =
      Math.max(limit, family === 'document' ? INFER_SAMPLE_ROWS : DETECT_SAMPLE_RECORDS) + 1
    const { items: read, eof } = await previewRead(
      file.path,
      encoding,
      warnings,
      () => new CsvParser({ ...parserOptions, keepBlankLines: true }),
      (n) => n >= want
    )
    // Blank lines: rows with an empty value in a one-column file for a table (as in readItems),
    // else nothing.
    const firstRecord = read.findIndex((r) => !r.blank)
    const oneColumn = family === 'sql' && firstRecord >= 0 && read[firstRecord].fields.length === 1
    const records = read.filter((r, i) => !r.blank || (oneColumn && i > firstRecord))
    const blankRows = records.filter((r) => r.blank).length
    if (blankRows > 0)
      warnings.push(
        `The file has one column, so each blank line is a row with an empty value (NULL unless you choose otherwise), the way exports write NULL: ${fmtCount(blankRows)} in this preview. Remove them from the file if they are not data.`
      )
    const detectedHeader = detectHeader(
      records.slice(0, 20).map((r) => r.fields),
      (tableColumns ?? []).map((c) => c.name)
    )
    const header = req.csv?.header ?? detectedHeader
    const fieldCount = records[0]?.fields.length ?? 0
    const columns = header
      ? (records[0]?.fields ?? []).map((f, i) => f?.trim() || importColumnLabel(i))
      : Array.from({ length: fieldCount }, (_, i) => importColumnLabel(i))
    const data = header ? records.slice(1) : records
    const mismatched = data.filter((r) => r.fields.length !== fieldCount)
    for (const r of mismatched.slice(0, 3)) {
      const n = data.indexOf(r) + 1
      warnings.push(
        `Row ${fmtCount(n)} (line ${fmtCount(r.line)}) has ${r.fields.length} field${r.fields.length === 1 ? '' : 's'}; ${header ? 'the header has' : 'the first row has'} ${fieldCount}. Is the delimiter right?`
      )
    }
    if (header) {
      const seen = new Set<string>()
      const dupes = new Set<string>()
      for (const c of columns) {
        if (seen.has(c)) dupes.add(c)
        seen.add(c)
      }
      if (dupes.size > 0)
        warnings.push(`The header repeats ${[...dupes].map((d) => `"${d}"`).join(', ')}.`)
    }
    const shown = data.slice(0, limit)
    const csv: DataImportCsvOptions = { delimiter, quote, header }
    const detectedCsv: DataImportCsvOptions = {
      delimiter: detectedDelimiter,
      quote: detectedQuote,
      header: detectedHeader
    }
    return {
      ...base,
      csv,
      detected: { format: detectedFormat, encoding: detectedEncoding, csv: detectedCsv },
      columns,
      rows: shown.map((r) => r.fields),
      lines: shown.map((r) => r.line),
      more: !eof || data.length > limit,
      ...(family === 'document'
        ? {
            inferredTypes: columns.map((_, i) =>
              inferMongoType(data.slice(0, INFER_SAMPLE_ROWS).map((r) => r.fields[i] ?? null))
            )
          }
        : {}),
      warnings
    }
  }

  // JSON array / NDJSON.
  const docs: Array<{ doc: Record<string, unknown> | null; line: number; error?: string }> = []
  const { items: pieces, eof } = await previewRead(
    file.path,
    encoding,
    warnings,
    () => new JsonDocumentSplitter(format === 'json' ? 'array' : 'sequence'),
    (n) => n > limit
  )
  let outOfRange = false
  for (const piece of pieces.slice(0, limit)) {
    const parsed = parseJsonDocument(piece.text, bson!)
    if (parsed.ok) {
      docs.push({ doc: parsed.doc, line: piece.line })
      if (parsed.outOfRange && !outOfRange) {
        outOfRange = true
        warnings.push(
          `Document ${docs.length} (line ${fmtCount(piece.line)}) has an integer beyond the Int64 range: it is stored as a Double (rounded), as mongoimport does. Write it as {"$numberDecimal": "…"} to keep every digit.`
        )
      }
    } else {
      docs.push({ doc: null, line: piece.line, error: parsed.message })
      if (warnings.length < 5)
        warnings.push(`Document ${docs.length} (line ${fmtCount(piece.line)}) ${parsed.message}.`)
    }
  }
  const columns: string[] = []
  const known = new Set<string>()
  for (const { doc } of docs) {
    if (!doc) continue
    for (const key of Object.keys(doc)) {
      if (known.has(key) || columns.length >= MAX_JSON_PREVIEW_COLUMNS) continue
      known.add(key)
      columns.push(key)
    }
  }
  return {
    ...base,
    csv: null,
    detected: { format: detectedFormat, encoding: detectedEncoding, csv: null },
    columns,
    rows: docs.map(({ doc }) =>
      columns.map((k) => (doc ? displayValue(ownValue(doc, k), bson!) : null))
    ),
    lines: docs.map((d) => d.line),
    more: !eof || pieces.length > limit,
    warnings
  }
}

/**
 * The head of the file for the preview: up to `enough(count)` items or PREVIEW_MAX_BYTES,
 * through a fresh parser. A structural error becomes a warning (the items before it are kept).
 * Bytes that are invalid for the encoding become a warning too, and the head is then read again
 * with them replaced, so the rows still show (the import itself refuses such a file).
 */
async function previewRead<T>(
  path: string,
  encoding: DataImportEncoding,
  warnings: string[],
  makeParser: () => {
    push(text: string, out: T[]): void
    end(out: T[]): void
    readonly currentLine: number
  },
  enough: (count: number) => boolean
): Promise<{ items: T[]; eof: boolean }> {
  for (const lenient of [false, true]) {
    const items: T[] = []
    const parser = makeParser()
    let bytes = 0
    let eof = false
    try {
      for await (const text of readText(path, encoding, null, (n) => (bytes += n), lenient)) {
        parser.push(text, items)
        if (enough(items.length) || bytes >= PREVIEW_MAX_BYTES) break
      }
      if (!enough(items.length) && bytes < PREVIEW_MAX_BYTES) {
        eof = true
        parser.end(items)
      }
    } catch (error) {
      if (error instanceof ImportEncodingError) {
        warnings.push(`Line ${fmtCount(parser.currentLine)}: ${error.message}`)
        continue
      }
      if (!(error instanceof ImportSyntaxError)) throw error
      warnings.push(error.message)
    }
    return { items, eof }
  }
  return { items: [], eof: false }
}

async function loadBson(deps: ImportDeps): Promise<typeof Bson> {
  if (deps.loadBson) return deps.loadBson()
  return (await (await import('./mongo')).loadMongoRuntime()).bson
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

type RunOutcome = Exclude<DataImportResponse, { status: 'confirmation_required' | 'blocked' }>

/** Ends the import with a `failed` answer carrying this message. */
class ImportStop extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportStop'
  }
}

const tableDisplayName = (target: Extract<TargetSpec, { kind: 'table' }>): string => {
  const ref = target.ref
  const qualifier = target.dialect === 'postgres' ? ref.schema : ref.database
  return qualifier && target.dialect !== 'sqlite' ? `${qualifier}.${ref.name}` : ref.name
}

const targetName = (target: TargetSpec): string =>
  target.kind === 'table' ? tableDisplayName(target) : `${target.database}.${target.collection}`

const ON_ERROR_NOTE: Record<DataImportOnError, string> = {
  rollback: 'all or nothing, one transaction',
  stop: 'stops at the first failing row',
  skip: 'failing rows are skipped'
}

/** The statement the gate sees and the history keeps (the values are not repeated). */
function statementText(spec: ImportSpec, totalRows: number, outcome?: string): string {
  const what = units(spec, totalRows)
  if (spec.target.kind === 'table') {
    const t = spec.target
    const columns = t.columns.map((c) => quoteSqlIdentifier(c.name, t.dialect)).join(', ')
    const head = outcome ?? `Import ${what} from ${spec.file.name} into ${tableDisplayName(t)}`
    return `-- ${head}\nINSERT INTO ${qualifiedSqlName(t.ref, t.dialect)} (${columns}) VALUES (…)`
  }
  const head = outcome ?? `Import ${what} from ${spec.file.name}`
  return `db.getCollection(${JSON.stringify(spec.target.collection)}).insertMany([ /* ${head} */ ])`
}

const units = (spec: ImportSpec, n: number): string =>
  `${fmtCount(n)} ${spec.target.kind === 'collection' ? 'document' : 'row'}${n === 1 ? '' : 's'}`

function gateInput(
  spec: ImportSpec,
  scan: ScanResult,
  confirmToken: string | undefined
): SafetyEvaluationInput {
  const text = statementText(spec, scan.validRows)
  const skipped =
    spec.onError === 'skip' && scan.errorCount > 0
      ? `; ${fmtCount(scan.errorCount)} malformed ${scan.errorCount === 1 ? 'entry' : 'entries'} will be skipped`
      : ''
  const reason = `Import ${units(spec, scan.validRows)} from ${spec.file.name} into ${targetName(spec.target)} (${ON_ERROR_NOTE[spec.onError]}${skipped})`
  const target = spec.target
  return {
    project: spec.record,
    database: target.kind === 'table' ? target.ref.database : target.database,
    source: target.kind === 'table' ? 'table' : 'mongo',
    statements: [
      {
        index: 0,
        text,
        start: 0,
        end: text.length,
        classification: 'write',
        dangerous: [],
        targets: [target.kind === 'table' ? target.ref.name : target.collection],
        reasons: [reason]
      }
    ],
    fingerprintText: JSON.stringify([
      'import',
      spec.file.path,
      spec.file.size,
      spec.file.mtimeMs,
      spec.format,
      spec.encoding,
      spec.csv,
      target.kind === 'table'
        ? [target.ref, target.columns]
        : [target.database, target.collection, target.fields],
      spec.empty,
      spec.onError,
      spec.batchSize,
      scan.validRows,
      scan.errorCount
    ]),
    confirmToken
  }
}

interface RunContext {
  deps: ImportDeps
  spec: ImportSpec
  running: RunningImport
  progress: Progress
  bson: typeof Bson | null
  redact: (text: string) => string
  now: () => number
}

const summary = (
  counters: Counters,
  durationMs: number,
  rolledBack: boolean
): DataImportSummary => ({
  rowsRead: counters.rowsRead,
  rowsImported: counters.imported,
  ...(counters.uncertain > 0 && !rolledBack ? { rowsUncertain: counters.uncertain } : {}),
  rowsSkipped: counters.skipped,
  errorCount: counters.errorCount,
  errors: counters.errors,
  durationMs,
  rolledBack
})

/**
 * "12 documents were imported before it.", or with an interrupted batch "12 to 40 documents were
 * imported before it (the last batch was interrupted and may be partly written)."
 */
const importedText = (spec: ImportSpec, counters: Counters, when: string): string =>
  counters.uncertain > 0
    ? `${fmtCount(counters.imported)} to ${units(spec, counters.imported + counters.uncertain)} were imported ${when} (the last batch was interrupted and may be partly written).`
    : `${units(spec, counters.imported)} ${counters.imported === 1 ? 'was' : 'were'} imported ${when}.`

export async function startImport(
  deps: ImportDeps,
  req: DataImportStartRequest,
  ctx: DataCallContext
): Promise<DataImportResponse> {
  const now = deps.now ?? Date.now
  const log = deps.logger ?? noopLogger
  const record = deps.getRecord(req.dataProjectId)
  const spec = await resolveSpec(deps, record, req)
  const bson = familyOf(record) === 'document' ? await loadBson(deps) : null
  const running: RunningImport = {
    clientId: ctx.clientId,
    projectId: record.id,
    controller: new AbortController(),
    interrupt: null
  }
  const unregister = deps.registry.register(req.importId, running)
  const counters = newCounters()
  let lastEmit = 0
  const progress: Progress = {
    phase: 'scanning',
    bytesRead: 0,
    totalRows: null,
    counters,
    emit(force = false, extra = {}) {
      const t = now()
      if (!force && t - lastEmit < PROGRESS_INTERVAL_MS) return
      lastEmit = t
      const event: DataImportProgressEvent = {
        importId: req.importId,
        phase: this.phase,
        bytesRead: Math.min(this.bytesRead, spec.file.size),
        totalBytes: spec.file.size,
        rowsRead: counters.rowsRead,
        rowsImported: counters.imported,
        totalRows: this.totalRows,
        done: extra.done ?? false,
        ...(extra.error ? { error: extra.error } : {})
      }
      try {
        deps.publish(DATA_IMPORT_CHANNEL, event)
      } catch {
        // Progress is best effort.
      }
    }
  }
  const started = now()
  const redact = deps.manager.redactor(record.id)
  const history = (
    status: DataHistoryEntry['status'],
    text: string,
    error: string | null
  ): void => {
    try {
      deps.recordHistory({
        dataProjectId: record.id,
        database:
          (spec.target.kind === 'table' ? spec.target.ref.database : spec.target.database) ??
          record.config.database ??
          null,
        text,
        status,
        durationMs: status === 'blocked' ? null : now() - started,
        rowCount: status === 'blocked' ? null : counters.imported,
        error,
        executedAt: new Date().toISOString()
      })
    } catch (e) {
      log.warn('Failed to record import history', {
        dataProjectId: record.id,
        error: errorMessage(e)
      })
    }
  }

  try {
    progress.emit(true)
    const scan = await scanFile(spec, bson, running.controller.signal, progress, now)
    if (running.controller.signal.aborted) throw cancelledError()
    counters.rowsRead = 0
    progress.totalRows = scan.validRows
    if (scan.errorCount > 0 && (spec.onError !== 'skip' || scan.validRows === 0)) {
      // Nothing was written: the file is refused as a whole.
      for (const e of scan.errors) recordError(counters, e)
      counters.errorCount = scan.errorCount
      counters.rowsRead = scan.rowsRead
      const first = scan.errors[0]
      const message = `Nothing was imported: ${first ? describeRowError(first) : 'the file has errors'}${scan.errorCount > 1 ? ` (and ${fmtCount(scan.errorCount - 1)} more)` : ''}.`
      progress.emit(true, { done: true, error: message })
      return { status: 'failed', message, ...summary(counters, now() - started, false) }
    }
    if (scan.validRows === 0) {
      const message = 'Nothing to import: the file has no data rows.'
      progress.emit(true, { done: true, error: message })
      return { status: 'failed', message, ...summary(counters, now() - started, false) }
    }

    const input = gateInput(spec, scan, req.confirmToken)
    const decision = deps.gate.evaluate(input)
    if (decision.action === 'block') {
      history('blocked', input.statements[0].text, decision.reason)
      progress.emit(true, { done: true, error: decision.reason })
      return { status: 'blocked', plan: decision.plan, reason: decision.reason }
    }
    if (decision.action === 'confirm') {
      return {
        status: 'confirmation_required',
        plan: decision.plan,
        confirmToken: decision.confirmToken
      }
    }

    progress.phase = 'importing'
    progress.bytesRead = 0
    progress.emit(true)
    const context: RunContext = { deps, spec, running, progress, bson, redact, now }
    let outcome: RunOutcome
    try {
      outcome =
        spec.target.kind === 'table' ? await runSqlImport(context) : await runMongoImport(context)
    } catch (error) {
      if (running.controller.signal.aborted || isCancel(error)) {
        outcome = { status: 'cancelled', ...summary(counters, now() - started, false) }
      } else {
        const message = importErrorText(error, record.engine, redact)
        history('error', statementText(spec, scan.validRows), message)
        progress.emit(true, { done: true, error: message })
        if (error instanceof DataDriverError)
          throw new DataDriverError(message, { code: error.code })
        throw error
      }
    }
    const verb =
      outcome.status === 'ok'
        ? `Imported ${fmtCount(outcome.rowsImported)} of ${units(spec, scan.validRows)}${outcome.rowsSkipped ? ` (${fmtCount(outcome.rowsSkipped)} skipped)` : ''}`
        : outcome.status === 'cancelled'
          ? `Import cancelled (${outcome.rolledBack ? 'rolled back' : `${importedRange(spec, outcome)} imported before the cancel`})`
          : `Import failed (${outcome.rolledBack ? 'rolled back' : `${importedRange(spec, outcome)} imported before the failure`})`
    const text = statementText(
      spec,
      scan.validRows,
      `${verb} from ${spec.file.name} into ${targetName(spec.target)}`
    )
    history(
      outcome.status === 'ok' ? 'ok' : outcome.status === 'cancelled' ? 'cancelled' : 'error',
      text,
      outcome.status === 'failed' ? outcome.message : null
    )
    progress.emit(true, {
      done: true,
      ...(outcome.status === 'failed' ? { error: outcome.message } : {})
    })
    log.info('Data import finished', {
      dataProjectId: record.id,
      status: outcome.status,
      rows: outcome.rowsImported
    })
    return outcome
  } catch (error) {
    if (running.controller.signal.aborted || isCancel(error)) {
      progress.emit(true, { done: true })
      return { status: 'cancelled', ...summary(counters, now() - started, false) }
    }
    throw error
  } finally {
    unregister()
  }
}

/** "12 rows", or "12 to 40 rows" when the last batch was interrupted. */
const importedRange = (spec: ImportSpec, outcome: DataImportSummary): string =>
  outcome.rowsUncertain
    ? `${fmtCount(outcome.rowsImported)} to ${units(spec, outcome.rowsImported + outcome.rowsUncertain)}`
    : units(spec, outcome.rowsImported)

const isCancel = (error: unknown): boolean =>
  (error instanceof DataDriverError && error.cancelled) || error instanceof QueueAbortedError

// ---------------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------------

interface SqlRow {
  row: number
  line: number
  tuple: string
}

async function runSqlImport(context: RunContext): Promise<RunOutcome> {
  const { deps, spec, running, progress, redact, now } = context
  const target = spec.target as Extract<TargetSpec, { kind: 'table' }>
  const { dialect, ref, columns } = target
  const engine = spec.record.engine
  const isMysql = dialect === 'mysql' || dialect === 'mariadb'
  const counters = progress.counters
  const signal = running.controller.signal
  const started = now()
  const tx = TX[dialect]
  const useTx = spec.onError === 'rollback'
  if (useTx && !tx) throw unsupportedError(transactionSupport(engine).note ?? 'No transactions.')
  const prefix = `INSERT INTO ${qualifiedSqlName(ref, dialect)} (${columns
    .map((c) => quoteSqlIdentifier(c.name, dialect))
    .join(', ')}) VALUES `

  return withConsoleSource('import', () =>
    deps.manager.runSerial(
      spec.record.id,
      ref.database,
      async ({ driver }) => {
        const session = driver.sessionState()
        if (session.inTransaction) {
          throw busyError(
            'The SQL session has an open transaction. COMMIT or ROLLBACK it in the query tab before importing.'
          )
        }
        if (session.tablesLocked) {
          throw busyError(
            'The SQL session holds table locks (LOCK TABLES). Run UNLOCK TABLES in the query tab before importing.'
          )
        }
        const quote = sqlTextOptions(dialect, session.backslashEscapes)
        const options: DriverExecuteOptions = {
          limit: null,
          hardCap: 1,
          readOnlySandbox: false,
          database: dialect === 'postgres' ? ref.database : undefined,
          schema: ref.schema
        }
        const exec = async (sql: string): Promise<void> => {
          if (signal.aborted) throw cancelledError()
          // SQLite cancels by killing its worker (and the session with it): batches are short,
          // so a cancel waits for the one in flight there.
          running.interrupt = engine === 'sqlite' ? null : () => driver.cancelCurrent()
          try {
            await driver.execute(sql, options)
          } catch (error) {
            if (signal.aborted) throw cancelledError()
            throw error
          } finally {
            running.interrupt = null
          }
        }
        const fatal = (error: unknown): boolean => isStatementLevelError(error, engine, driver)
        const rowError = (row: SqlRow, error: unknown): DataImportRowError => ({
          row: row.row,
          line: row.line,
          message: importErrorText(error, engine, redact)
        })
        const insert = async (rows: SqlRow[]): Promise<void> => {
          await exec(prefix + rows.map((r) => r.tuple).join(', '))
          progress.emit()
        }
        let inTx = false
        let checked = false
        const rollback = async (): Promise<void> => {
          if (!inTx || !tx) return
          inTx = false
          if (driver.isConnected())
            await driver.execute(tx.rollback, options).catch(() => undefined)
        }

        /**
         * rollback mode: the failing row of `rows` by binary search over prefixes, each probe in
         * its own transaction that is rolled back. Null when it does not reproduce on its own
         * (e.g. a duplicate of a row of an earlier batch).
         */
        const isolate = async (rows: SqlRow[]): Promise<DataImportRowError | null> => {
          const probe = async (k: number): Promise<unknown> => {
            await exec(tx!.begin)
            try {
              await insert(rows.slice(0, k))
              return null
            } catch (error) {
              return error ?? new Error('failed')
            } finally {
              if (driver.isConnected())
                await driver.execute(tx!.rollback, options).catch(() => undefined)
            }
          }
          let failure = await probe(rows.length)
          if (!failure || fatal(failure)) return null
          let lo = 1
          let hi = rows.length
          while (lo < hi) {
            const mid = (lo + hi) >>> 1
            const e = await probe(mid)
            if (e && fatal(e)) return null
            if (e) {
              hi = mid
              failure = e
            } else lo = mid + 1
          }
          return rowError(rows[lo - 1], failure)
        }

        /**
         * stop / skip mode: left half first, so everything before a failing row is in. A table
         * without transactions gets one row per INSERT: there a failing multi-row INSERT keeps
         * the rows before the failing one, so splitting would re-insert (and blame) them.
         */
        const insertSplitting = async (rows: SqlRow[]): Promise<boolean> => {
          if (target.rowByRow && rows.length > 1) {
            for (const row of rows) if (!(await insertSplitting([row]))) return false
            return true
          }
          try {
            await insert(rows)
            counters.imported += rows.length
            return true
          } catch (error) {
            if (fatal(error)) throw error
            if (rows.length === 1) {
              recordError(counters, rowError(rows[0], error))
              if (spec.onError === 'stop') return false
              counters.skipped++
              if (counters.errorCount >= MAX_SKIPPED_FAILURES) {
                throw new ImportStop(
                  `Stopped after ${fmtCount(MAX_SKIPPED_FAILURES)} failed rows (is the column mapping right?).`
                )
              }
              return true
            }
            const mid = rows.length >>> 1
            if (!(await insertSplitting(rows.slice(0, mid)))) return false
            return insertSplitting(rows.slice(mid))
          }
        }

        const flush = async (rows: SqlRow[]): Promise<boolean> => {
          if (rows.length === 0) return true
          if (!checked) {
            checked = true
            // One statement, whatever the values: a cheap guard on the generated text.
            const text = prefix + rows[0].tuple
            if (splitSqlStatements(text, dialect, quote).length !== 1)
              throw new Error('The generated INSERT did not parse as one statement.')
          }
          if (!useTx) return insertSplitting(rows)
          try {
            await insert(rows)
            counters.imported += rows.length
            return true
          } catch (error) {
            if (fatal(error)) throw error
            const original = rowError(rows[0], error)
            await rollback()
            counters.imported = 0
            const found = signal.aborted ? null : await isolate(rows).catch(() => null)
            recordError(counters, found ?? { ...original, rowTo: rows[rows.length - 1].row })
            return false
          }
        }

        /**
         * MySQL / MariaDB with `SET autocommit = 0` in the query tab: stop / skip INSERTs would
         * open a transaction nobody commits (the summary would count rows a ROLLBACK or a
         * disconnect then discards). Autocommit is switched on for the import and back off after.
         */
        let restoreAutocommit = false
        const ensureAutocommit = async (): Promise<void> => {
          if (useTx || !isMysql) return
          const res = await driver.execute('SELECT @@SESSION.autocommit', options)
          const value = res.output.kind === 'rows' ? res.output.rows[0]?.[0] : undefined
          if (value === undefined || value === null || Number(value) !== 0) return
          await exec('SET SESSION autocommit = 1')
          restoreAutocommit = true
        }

        const shape: FileShape = { header: null, fieldCount: null }
        const check = itemChecker(spec, shape, null)
        let batch: SqlRow[] = []
        let batchChars = 0
        let stopped = false
        try {
          await ensureAutocommit()
          if (useTx) {
            await exec(tx!.begin)
            inTx = true
          }
          outer: for await (const items of readItems(
            spec,
            signal,
            shape,
            (n) => (progress.bytesRead += n)
          )) {
            for (const item of items) {
              counters.rowsRead++
              const verdict = check(item)
              if (!verdict.ok) {
                recordError(counters, { row: item.row, line: item.line, message: verdict.message })
                if (spec.onError !== 'skip') {
                  stopped = true
                  break outer
                }
                counters.skipped++
                continue
              }
              const fields = item.fields!
              const tuple = `(${columns
                .map((c) =>
                  sqlLiteral(fields[c.source] ?? null, c.kind, dialect, quote, spec.empty)
                )
                .join(', ')})`
              batch.push({ row: item.row, line: item.line, tuple })
              batchChars += tuple.length + 2
              if (batch.length >= spec.batchSize || batchChars >= SQL_BATCH_MAX_CHARS) {
                const rows = batch
                batch = []
                batchChars = 0
                if (!(await flush(rows))) {
                  stopped = true
                  break outer
                }
              }
            }
            progress.emit()
          }
          if (!stopped && !(await flush(batch))) stopped = true
          batch = []
          if (stopped) {
            await rollback()
            if (useTx) counters.imported = 0
            const first = counters.errors[0]
            const message = first
              ? useTx
                ? `${describeRowError(first)}. Nothing was imported (the transaction was rolled back).`
                : `Stopped at ${describeRowError(first)}. ${fmtCount(counters.imported)} row${counters.imported === 1 ? ' was' : 's were'} imported before it.`
              : 'The import stopped.'
            return { status: 'failed', message, ...summary(counters, now() - started, useTx) }
          }
          if (useTx) {
            try {
              await exec(tx!.commit)
              inTx = false
            } catch (error) {
              await rollback()
              counters.imported = 0
              if (isCancel(error)) throw error
              const message = `The transaction could not be committed: ${importErrorText(error, engine, redact)}. Nothing was imported.`
              return { status: 'failed', message, ...summary(counters, now() - started, true) }
            }
          }
          return { status: 'ok', ...summary(counters, now() - started, false) }
        } catch (error) {
          await rollback()
          if (useTx) counters.imported = 0
          if (signal.aborted || isCancel(error)) {
            return { status: 'cancelled', ...summary(counters, now() - started, useTx) }
          }
          if (error instanceof ImportStop) {
            return {
              status: 'failed',
              message: error.message,
              ...summary(counters, now() - started, useTx)
            }
          }
          const text =
            error instanceof ImportSyntaxError
              ? error.message
              : `${importErrorText(error, engine, redact).replace(/\.?$/, '.')}`
          if (error instanceof ImportSyntaxError)
            recordError(counters, { row: counters.rowsRead + 1, line: error.line, message: text })
          const message = `${text} ${useTx ? 'Nothing was imported (the transaction was rolled back).' : `${fmtCount(counters.imported)} row${counters.imported === 1 ? ' was' : 's were'} imported before the failure.`}`
          return { status: 'failed', message, ...summary(counters, now() - started, useTx) }
        } finally {
          if (restoreAutocommit && driver.isConnected())
            await driver.execute('SET SESSION autocommit = 0', options).catch(() => undefined)
        }
      },
      signal
    )
  )
}

// ---------------------------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------------------------

interface MongoRow {
  row: number
  line: number
  doc: Record<string, unknown>
}

interface BulkWriteErrorLike {
  writeErrors?: unknown
  insertedCount?: number
  result?: { insertedCount?: number }
}

const writeErrorsOf = (error: unknown): Array<{ index: number; message: string }> | null => {
  const e = error as BulkWriteErrorLike & { name?: string }
  if (!e || typeof e !== 'object' || e.writeErrors === undefined) return null
  const list = Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors]
  return list
    .map((w) => {
      const item = w as {
        index?: number
        errmsg?: string
        code?: number
        err?: { index?: number; errmsg?: string }
      }
      return {
        index: Number(item.index ?? item.err?.index ?? 0),
        message: String(item.errmsg ?? item.err?.errmsg ?? `write error ${item.code ?? ''}`).trim()
      }
    })
    .sort((a, b) => a.index - b.index)
}

const insertedCountOf = (error: unknown): number => {
  const e = error as BulkWriteErrorLike
  const n = e.insertedCount ?? e.result?.insertedCount
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

async function runMongoImport(context: RunContext): Promise<RunOutcome> {
  const { deps, spec, running, progress, bson, now } = context
  const target = spec.target as Extract<TargetSpec, { kind: 'collection' }>
  const counters = progress.counters
  const signal = running.controller.signal
  const started = now()

  return withConsoleSource('import', () =>
    deps.manager.withDriver(spec.record.id, undefined, async (driverBase) => {
      const driver = driverBase as MongoDriver
      const client = await driver.getClient()
      const collection = client.db(target.database).collection(target.collection)
      const shape: FileShape = { header: null, fieldCount: null }
      const check = itemChecker(spec, shape, bson)
      const ordered = spec.onError !== 'skip'

      /**
       * How many documents of an interrupted batch are in the collection, or null when that
       * cannot be known. Only when the server answered (an error with a server code: it has
       * stopped writing) and every _id of the batch is one we just generated (no document
       * existed with it before): then the documents with those ids are exactly the ones written.
       */
      const countWritten = async (
        rows: MongoRow[],
        ownIds: boolean,
        error: unknown
      ): Promise<number | null> => {
        const code = (error as { code?: unknown } | null)?.code
        if (!ownIds || typeof code !== 'number' || isConnectionLostError(error)) return null
        if (!driver.isConnected()) return null
        try {
          const ids = rows.map((r) => r.doc._id as Bson.ObjectId)
          return await collection.countDocuments(
            { _id: { $in: ids } },
            { readPreference: 'primary', maxTimeMS: 60_000 }
          )
        } catch {
          return null
        }
      }

      const insert = async (rows: MongoRow[]): Promise<boolean> => {
        if (signal.aborted) throw cancelledError()
        // Our own _id where the document has none (what the driver would do), so the documents
        // an interrupted batch wrote can be counted.
        let ownIds = true
        for (const r of rows) {
          if (r.doc._id === undefined || r.doc._id === null)
            defineOwn(r.doc, '_id', new bson!.ObjectId())
          else ownIds = false
        }
        const op = await driver.startOperation()
        if (signal.aborted) {
          await op.end()
          throw cancelledError()
        }
        // A cancel lets the batch in flight finish, so the count stays exact (a killed
        // insertMany reports 0 inserted whatever the server wrote); a second cancel kills it.
        let cancels = 0
        running.interrupt = async () => {
          if (++cancels > 1) await op.cancel()
        }
        try {
          const options: BulkWriteOptions = { ordered, comment: op.tag }
          if (op.session) options.session = op.session
          if (driver.writeTimeoutMs) options.maxTimeMS = driver.writeTimeoutMs
          const result = await collection.insertMany(
            rows.map((r) => r.doc),
            options
          )
          counters.imported += result.insertedCount
          progress.emit()
        } catch (error) {
          const writeErrors = op.cancelled ? null : writeErrorsOf(error)
          if (!writeErrors || writeErrors.length === 0) {
            // Interrupted (a forced cancel, a lost connection, a timeout): part of the batch
            // may be in.
            const known = insertedCountOf(error)
            const written = await countWritten(rows, ownIds, error)
            if (written !== null) counters.imported += written
            else {
              counters.imported += known
              counters.uncertain += Math.max(0, rows.length - known)
            }
            progress.emit()
            if (op.cancelled || signal.aborted) throw cancelledError()
            throw driver.toError(error)
          }
          // The server answered for every document: the count is exact.
          counters.imported += insertedCountOf(error)
          for (const w of writeErrors) {
            const row = rows[w.index] ?? rows[rows.length - 1]
            recordError(counters, {
              row: row.row,
              line: row.line,
              message:
                w.message.length > MAX_MESSAGE_CHARS
                  ? `${w.message.slice(0, MAX_MESSAGE_CHARS)}…`
                  : w.message
            })
          }
          if (ordered) return false
          counters.skipped += writeErrors.length
          if (signal.aborted) throw cancelledError()
          if (counters.errorCount >= MAX_SKIPPED_FAILURES) {
            throw new ImportStop(
              `Stopped after ${fmtCount(MAX_SKIPPED_FAILURES)} failed documents (is the file right for this collection?).`
            )
          }
          return true
        } finally {
          running.interrupt = null
          await op.end()
        }
        // The batch is complete: a cancel that came during it stops here.
        if (signal.aborted) throw cancelledError()
        return true
      }

      let batch: MongoRow[] = []
      let batchChars = 0
      let stopped = false
      try {
        outer: for await (const items of readItems(
          spec,
          signal,
          shape,
          (n) => (progress.bytesRead += n)
        )) {
          for (const item of items) {
            counters.rowsRead++
            const verdict = check(item)
            if (!verdict.ok) {
              recordError(counters, { row: item.row, line: item.line, message: verdict.message })
              if (spec.onError !== 'skip') {
                stopped = true
                break outer
              }
              counters.skipped++
              continue
            }
            batch.push({ row: item.row, line: item.line, doc: verdict.doc! })
            batchChars +=
              item.text?.length ??
              (item.fields ?? []).reduce((n, f) => n + (f?.length ?? 0) + 8, 16)
            if (batch.length >= spec.batchSize || batchChars >= MONGO_BATCH_MAX_CHARS) {
              const rows = batch
              batch = []
              batchChars = 0
              if (!(await insert(rows))) {
                stopped = true
                break outer
              }
            }
          }
          progress.emit()
        }
        if (!stopped && batch.length > 0 && !(await insert(batch))) stopped = true
        if (stopped) {
          const first = counters.errors[0]
          const message = first
            ? `Stopped at ${describeRowError(first)}. ${importedText(spec, counters, 'before it')}`
            : 'The import stopped.'
          return { status: 'failed', message, ...summary(counters, now() - started, false) }
        }
        return { status: 'ok', ...summary(counters, now() - started, false) }
      } catch (error) {
        if (signal.aborted || isCancel(error))
          return { status: 'cancelled', ...summary(counters, now() - started, false) }
        if (error instanceof ImportStop)
          return {
            status: 'failed',
            message: error.message,
            ...summary(counters, now() - started, false)
          }
        const text =
          error instanceof ImportSyntaxError
            ? error.message
            : `${importErrorText(error, 'mongodb', context.redact).replace(/\.?$/, '.')}`
        if (error instanceof ImportSyntaxError)
          recordError(counters, { row: counters.rowsRead + 1, line: error.line, message: text })
        const message = `${text} ${importedText(spec, counters, 'before the failure')}`
        return { status: 'failed', message, ...summary(counters, now() - started, false) }
      }
    })
  )
}
