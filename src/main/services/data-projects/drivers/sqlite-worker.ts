// The SQLite side of a data project: a better-sqlite3 connection plus the message protocol that
// drives it from another process.
//
// Why a separate process: better-sqlite3 is synchronous and has no interrupt API
// (sqlite3_interrupt / progress handlers are not exposed). A user query on the server's event
// loop would freeze every renderer, phone and relay tunnel until it finished, and a
// worker_thread is no way out: `worker.terminate()` blocks until the current native step returns
// and was measured to SEGFAULT the whole process with better-sqlite3 (research/drivers.md §0).
// So each open SQLite project gets a forked child (the server bundle re-entered with
// HIVE_DATA_SQLITE_WORKER=1, see server/bin.ts → runSqliteWorker), and cancel = SIGKILL +
// respawn. SQLite's journal/WAL rolls back whatever the killed statement was doing.
//
// The same `SqliteSession` also runs in-process (vitest, unbundled runs) behind the identical
// request shapes, which is why the protocol is plain data and every error crosses it as a
// `SqliteWorkerError`.
//
// This module must stay self-contained: only `import type` and Node built-ins. The child loads
// the whole server bundle anyway, but tests fork this file directly through Node's built-in type
// stripping, which cannot resolve extensionless relative imports.

import { existsSync, realpathSync, statSync } from 'node:fs'
import type BetterSqlite3 from 'better-sqlite3'
import type {
  DataBinaryCell,
  DataCell,
  DataColumnInfo,
  DataColumnMeta,
  DataCommandResult,
  DataCompletionTable,
  DataDatabaseInfo,
  DataForeignKeyInfo,
  DataIndexInfo,
  DataObjectInfo,
  DataObjectKind,
  DataTableDetails
} from '../../../../shared/data-projects/types'

// ---------------------------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------------------------

export interface SqliteAttachment {
  name: string
  file: string
}

export interface SqliteOpenParams {
  /** Absolute path, or ':memory:'. */
  path: string
  /** Open with SQLITE_OPEN_READONLY (project "read-only file"). */
  readonly: boolean
  /** Create the file when missing ("New database…" in the wizard); otherwise fileMustExist. */
  create: boolean
  /** SQLite busy timeout (waiting for another process's lock), ms. */
  busyTimeoutMs: number
  /** Control/export connections: PRAGMA query_only=ON for the connection's whole life. */
  queryOnly?: boolean
  /** Databases to ATTACH after opening (mirrors the session's ATTACHes after a respawn). */
  attach?: SqliteAttachment[]
}

export interface SqliteSessionState {
  inTransaction: boolean
  /** ATTACHed databases (not main/temp). */
  attached: SqliteAttachment[]
  /** Objects in the temp schema (temp tables/views/triggers live only on this connection). */
  tempObjects: number
}

export interface SqliteOpenResult {
  sqliteVersion: string
  state: SqliteSessionState
  /** Size of the main file in bytes (null for :memory:). */
  fileSize: number | null
  /** ATTACHes from `attach` that failed (file gone, ...): "name: reason". */
  attachWarnings: string[]
}

export interface SqliteExecParams {
  sql: string
  /** Rows to return at most; one more is read to detect truncation. */
  maxRows: number
  /** DB-level read-only sandbox: stmt.readonly check + PRAGMA query_only=ON around the run. */
  sandbox: boolean
}

export interface SqliteRowsPayload {
  kind: 'rows'
  columns: DataColumnMeta[]
  rows: DataCell[][]
  /** More rows existed than `maxRows` (or the byte budget ran out). */
  truncated: boolean
  /** True when the byte budget, not `maxRows`, cut the result. */
  byteLimited: boolean
}

export interface SqliteExecResult {
  output: SqliteRowsPayload | DataCommandResult
  elapsedMs: number
  state: SqliteSessionState
}

export type SqliteIntrospectQuery = (
  | { kind: 'state' }
  | { kind: 'databases' }
  | { kind: 'objects'; schema: string }
  | { kind: 'describe'; schema: string; name: string }
  | { kind: 'ddl'; schema: string; name: string }
  | { kind: 'completion'; schema: string; maxTables: number }
) & {
  /** Control connection: make its ATTACHes match the session's before answering. */
  attach?: SqliteAttachment[]
}

export interface SqliteStreamParams {
  sql: string
  sandbox: boolean
  batchSize: number
}

export type SqliteWorkerRequest =
  | { id: number; op: 'open'; params: SqliteOpenParams }
  | { id: number; op: 'exec'; params: SqliteExecParams }
  | { id: number; op: 'introspect'; query: SqliteIntrospectQuery }
  | { id: number; op: 'stream'; params: SqliteStreamParams }
  /** Flow control: the parent consumed the last batch of stream `id`; send the next. */
  | { id: number; op: 'ack' }
  | { id: number; op: 'close' }

export interface SqliteWorkerError {
  message: string
  code?: string
  sandboxRejected?: boolean
  /** 0-based offset inside the statement, when it can be derived from the message. */
  position?: number
  hint?: string
}

export type SqliteWorkerMessage =
  | { type: 'ready'; pid: number }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: SqliteWorkerError }
  | { type: 'batch'; id: number; columns: string[]; rows: DataCell[][] }

/** Env flag the server bundle checks first thing (server/bin.ts) to run the worker loop. */
export const SQLITE_WORKER_ENV = 'HIVE_DATA_SQLITE_WORKER'

// ---------------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------------

const BINARY_PREVIEW_BYTES = 64
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)
/** Rough cap on result text per exec (UTF-16 units) so one SELECT of huge BLOBs cannot OOM. */
const MAX_RESULT_CHARS = 64 * 1024 * 1024

/**
 * One SQLite value → JSON-safe exact cell. Statements run with safeIntegers, so every INTEGER
 * is a bigint: in-range ones become numbers (ids stay numeric in the grid), larger ones exact
 * strings. REAL NaN/±Inf become text (JSON has no such numbers). BLOB → hex cell; exports ask
 * for every byte (`fullBinary`), the grid gets a 64-byte preview plus the length.
 */
export function sqliteCell(value: unknown, fullBinary = false): DataCell {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'bigint':
      return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString()
    default:
      break
  }
  if (value instanceof Uint8Array) {
    const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    const cell: DataBinaryCell = {
      $t: 'bin',
      hex: (fullBinary ? buf : buf.subarray(0, BINARY_PREVIEW_BYTES)).toString('hex'),
      len: buf.length
    }
    return cell
  }
  return String(value)
}

const cellChars = (cell: DataCell): number => {
  if (cell === null) return 4
  if (typeof cell === 'string') return cell.length + 2
  if (typeof cell === 'object') return cell.hex.length + 32
  return 8
}

/** Storage class of a JS value from better-sqlite3 (for expression columns without a declared type). */
const storageClassOf = (value: unknown): string | undefined => {
  if (typeof value === 'bigint') return 'INTEGER'
  if (typeof value === 'number') return 'REAL'
  if (typeof value === 'string') return 'TEXT'
  if (value instanceof Uint8Array) return 'BLOB'
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** A failure the worker raises itself (as opposed to a SqliteError from the engine). */
export class SqliteWorkerFailure extends Error {
  readonly code?: string
  readonly sandboxRejected: boolean
  readonly position?: number
  readonly hint?: string

  constructor(
    message: string,
    options: { code?: string; sandboxRejected?: boolean; position?: number; hint?: string } = {}
  ) {
    super(message)
    this.name = 'SqliteWorkerFailure'
    this.code = options.code
    this.sandboxRejected = options.sandboxRejected ?? false
    this.position = options.position
    this.hint = options.hint
  }
}

const HINTS: Record<string, string> = {
  SQLITE_BUSY:
    'The database file is locked by another process (or another connection is writing). Try again when it is done.',
  SQLITE_LOCKED: 'A table is locked by another statement on this connection.',
  SQLITE_CANTOPEN:
    'Check that the file exists, that its folder is readable, and that macOS allows Hive to access it.',
  SQLITE_NOTADB: 'This file is not an SQLite database (or it is encrypted).',
  SQLITE_CORRUPT: 'The database file is damaged. Run PRAGMA integrity_check on a copy.',
  SQLITE_FULL: 'The disk is full.',
  SQLITE_PERM: 'The file is not writable (permissions, or opened read-only).'
}

/**
 * SQLite reports syntax errors as `near "tok": syntax error` without an offset (better-sqlite3
 * does not expose sqlite3_error_offset). When the token occurs exactly once in the statement
 * that is where the editor underline goes; `incomplete input` points at the end.
 */
export function sqliteErrorPosition(message: string, sql: string | undefined): number | undefined {
  if (!sql) return undefined
  if (/incomplete input/i.test(message)) return sql.trimEnd().length
  const near = /near "([^"]+)": syntax error/.exec(message)
  if (!near) return undefined
  const token = near[1]
  const first = sql.indexOf(token)
  if (first < 0 || sql.indexOf(token, first + 1) >= 0) return undefined
  return first
}

/** Anything thrown by better-sqlite3 or the session → the plain-data error that crosses IPC. */
export function toSqliteWorkerError(
  error: unknown,
  sql?: string,
  sandbox = false
): SqliteWorkerError {
  if (error instanceof SqliteWorkerFailure) {
    return {
      message: error.message,
      code: error.code,
      sandboxRejected: error.sandboxRejected || undefined,
      position: error.position,
      hint: error.hint
    }
  }
  const message =
    error instanceof Error
      ? error.message || error.name
      : typeof error === 'string'
        ? error
        : 'Unknown SQLite error'
  const rawCode = (error as { code?: unknown } | null)?.code
  const code = typeof rawCode === 'string' ? rawCode : undefined
  // Extended codes (SQLITE_BUSY_SNAPSHOT, SQLITE_READONLY_DBMOVED) share their primary's hint.
  const primary = code ? /^SQLITE_[A-Z]+/.exec(code)?.[0] : undefined
  const sandboxRejected = sandbox && primary === 'SQLITE_READONLY'
  const out: SqliteWorkerError = { message, code }
  if (sandboxRejected) out.sandboxRejected = true
  const position = sqliteErrorPosition(message, sql)
  if (position !== undefined) out.position = position
  const hint = (code && HINTS[code]) || (primary && HINTS[primary]) || undefined
  if (hint) out.hint = hint
  if (/more than one statement/i.test(message)) {
    out.code = out.code ?? 'SQLITE_MULTIPLE_STATEMENTS'
    out.hint = 'Run one statement at a time (the editor splits on semicolons).'
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Small SQL helpers (the worker has no lexer; these only look at the statement head)
// ---------------------------------------------------------------------------------------------

export const quoteSqliteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

/** Upper-cased leading words, skipping whitespace and comments. */
export function leadingWords(sql: string, count = 3): string[] {
  let i = 0
  const n = sql.length
  for (;;) {
    while (i < n && /\s/.test(sql[i])) i++
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i)
      i = nl < 0 ? n : nl + 1
      continue
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    break
  }
  const words: string[] = []
  const re = /\s*([A-Za-z_]+)/y
  re.lastIndex = i
  while (words.length < count) {
    const m = re.exec(sql)
    if (!m) break
    words.push(m[1].toUpperCase())
  }
  return words
}

const DML_LEADERS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT', 'WITH'])
const TWO_WORD_LEADERS = new Set(['CREATE', 'DROP', 'ALTER'])
const QUALIFIERS = new Set(['TEMP', 'TEMPORARY', 'UNIQUE', 'VIRTUAL'])

/** "CREATE TABLE", "DROP INDEX", "INSERT", "BEGIN" — the command tag shown for non-row results. */
export function commandTag(sql: string): string {
  const words = leadingWords(sql, 3)
  if (words.length === 0) return 'OK'
  if (TWO_WORD_LEADERS.has(words[0]) && words[1]) {
    if (QUALIFIERS.has(words[1]) && words[2]) return `${words[0]} ${words[1]} ${words[2]}`
    return `${words[0]} ${words[1]}`
  }
  return words[0]
}

// ---------------------------------------------------------------------------------------------
// better-sqlite3 loading
// ---------------------------------------------------------------------------------------------

type DatabaseCtor = typeof BetterSqlite3
type Db = BetterSqlite3.Database

let databaseCtor: DatabaseCtor | null = null

async function loadBetterSqlite3(): Promise<DatabaseCtor> {
  if (databaseCtor) return databaseCtor
  // Dynamic import keeps the native module out of every process that never opens a SQLite
  // project; in the CJS server bundle it compiles to require().
  const mod = (await import('better-sqlite3')) as unknown as {
    default?: DatabaseCtor
  } & DatabaseCtor
  databaseCtor = (mod.default ?? mod) as DatabaseCtor
  return databaseCtor
}

// ---------------------------------------------------------------------------------------------
// Session state helpers
// ---------------------------------------------------------------------------------------------

interface DatabaseListRow {
  seq: number
  name: string
  file: string
}

const databaseList = (db: Db): DatabaseListRow[] =>
  db.prepare('PRAGMA database_list').all() as DatabaseListRow[]

export function readSessionState(db: Db): SqliteSessionState {
  const attached = databaseList(db)
    .filter((row) => row.name !== 'main' && row.name !== 'temp')
    .map((row) => ({ name: row.name, file: row.file }))
  let tempObjects = 0
  try {
    tempObjects = Number(
      (db.prepare('SELECT count(*) AS n FROM temp.sqlite_schema').get() as { n: number | bigint }).n
    )
  } catch {
    // temp schema unreadable: report none rather than failing the statement that just ran
  }
  return { inTransaction: db.inTransaction, attached, tempObjects }
}

const realPath = (file: string): string => {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

/** SQLite reports resolved paths (/private/var/... for /var/... on macOS). */
const sameFile = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && (a === b || realPath(a) === realPath(b))

/** Makes the connection's ATTACHes match `wanted` (control connections mirror the session). */
export function syncAttachments(db: Db, wanted: readonly SqliteAttachment[]): string[] {
  const warnings: string[] = []
  const current = new Map(
    databaseList(db)
      .filter((row) => row.name !== 'main' && row.name !== 'temp')
      .map((row) => [row.name, row.file] as const)
  )
  const wantedByName = new Map(wanted.map((a) => [a.name, a.file] as const))
  for (const [name, file] of current) {
    if (!sameFile(wantedByName.get(name), file)) {
      try {
        db.prepare('DETACH DATABASE ?').run(name)
      } catch (error) {
        warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  for (const { name, file } of wanted) {
    if (sameFile(current.get(name), file)) continue
    try {
      // Both operands of ATTACH are expressions, so they bind (no identifier quoting games).
      db.prepare('ATTACH DATABASE ? AS ?').run(file, name)
    } catch (error) {
      warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return warnings
}

function schemaFile(db: Db, schema: string): string | null {
  const row = databaseList(db).find((r) => r.name === schema)
  return row && row.file ? row.file : null
}

function fileSizeOf(file: string | null): number | null {
  if (!file) return null
  try {
    return statSync(file).size
  } catch {
    return null
  }
}

function requireSchema(db: Db, schema: string): void {
  if (!databaseList(db).some((r) => r.name === schema)) {
    throw new SqliteWorkerFailure(
      `Unknown database "${schema}" (not main, temp or an ATTACHed database).`,
      {
        code: 'SQLITE_ERROR'
      }
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Introspection (also exported for direct tests)
// ---------------------------------------------------------------------------------------------

/** Exact count(*) per table only when the file is small enough to scan quickly. */
const EXACT_COUNT_MAX_FILE = 64 * 1024 * 1024
/** Exact count(*) for one described table. */
const DESCRIBE_COUNT_MAX_FILE = 512 * 1024 * 1024
/** dbstat walks every page; skip sizes on very large files. */
const DBSTAT_MAX_FILE = 1024 * 1024 * 1024

interface SchemaRow {
  type: string
  name: string
  tbl: string
  sql: string | null
}

interface TableListRow {
  name: string
  type: string
  wr: number
  strict: number
}

function tableList(db: Db, schema: string): Map<string, TableListRow> {
  try {
    const rows = db.prepare(`PRAGMA ${quoteSqliteIdent(schema)}.table_list`).all() as TableListRow[]
    return new Map(rows.map((r) => [r.name, r]))
  } catch {
    // SQLite < 3.37: no table_list; flags just stay unknown
    return new Map()
  }
}

const virtualModule = (sql: string | null): string | null => {
  const m = sql ? /\bUSING\s+([A-Za-z0-9_]+)/i.exec(sql) : null
  return m ? m[1].toLowerCase() : null
}

function tableEngine(row: SchemaRow, flags: TableListRow | undefined): string | undefined {
  if (flags?.type === 'shadow') return 'shadow'
  if (flags?.type === 'virtual' || (row.sql && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql))) {
    const module = virtualModule(row.sql)
    return module ? `virtual: ${module}` : 'virtual'
  }
  const parts: string[] = []
  if (flags?.strict) parts.push('STRICT')
  if (flags?.wr) parts.push('WITHOUT ROWID')
  return parts.length ? parts.join(', ') : undefined
}

function stat1RowCounts(db: Db, schema: string): Map<string, number> {
  const out = new Map<string, number>()
  const s = quoteSqliteIdent(schema)
  try {
    const has = db
      .prepare(`SELECT 1 FROM ${s}.sqlite_schema WHERE type = 'table' AND name = 'sqlite_stat1'`)
      .get()
    if (!has) return out
    const rows = db.prepare(`SELECT tbl, stat FROM ${s}.sqlite_stat1`).all() as Array<{
      tbl: string
      stat: string
    }>
    for (const row of rows) {
      // The first integer of `stat` is the row count of the table (or of the index ≈ table).
      const n = Number.parseInt(String(row.stat).split(' ')[0] ?? '', 10)
      if (Number.isFinite(n)) out.set(row.tbl, Math.max(out.get(row.tbl) ?? 0, n))
    }
  } catch {
    // stat table unreadable: estimates stay null
  }
  return out
}

function exactCount(db: Db, schema: string, table: string): number | null {
  try {
    const row = db
      .prepare(`SELECT count(*) AS n FROM ${quoteSqliteIdent(schema)}.${quoteSqliteIdent(table)}`)
      .safeIntegers(true)
      .get() as { n: bigint }
    return Number(row.n)
  } catch {
    return null
  }
}

/** Bytes per table including its indexes (dbstat aggregate mode). Empty map when unavailable. */
function tableSizes(db: Db, schema: string, rows: readonly SchemaRow[]): Map<string, number> {
  const out = new Map<string, number>()
  try {
    const btrees = db.prepare('SELECT name, pgsize FROM dbstat(?, 1)').all(schema) as Array<{
      name: string
      pgsize: number
    }>
    const ownerOf = new Map<string, string>()
    for (const row of rows) ownerOf.set(row.name, row.type === 'index' ? row.tbl : row.name)
    for (const b of btrees) {
      // Autoindexes are not always in our row list (they have no sql); their name embeds the table.
      const owner = ownerOf.get(b.name) ?? /^sqlite_autoindex_(.+)_\d+$/.exec(b.name)?.[1] ?? b.name
      out.set(owner, (out.get(owner) ?? 0) + Number(b.pgsize))
    }
  } catch {
    // no DBSTAT_VTAB in this build, or the schema is gone: sizes stay null
  }
  return out
}

function schemaRows(db: Db, schema: string): SchemaRow[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name AS tbl, sql FROM ${quoteSqliteIdent(schema)}.sqlite_schema ORDER BY name`
    )
    .all() as SchemaRow[]
}

const isInternal = (name: string): boolean => name.toLowerCase().startsWith('sqlite_')

export function listSqliteDatabases(db: Db): DataDatabaseInfo[] {
  const state = readSessionState(db)
  const out: DataDatabaseInfo[] = []
  for (const row of databaseList(db)) {
    if (row.name === 'temp') {
      if (state.tempObjects > 0) out.push({ name: 'temp', sizeBytes: null, isSystem: false })
      continue
    }
    out.push({ name: row.name, sizeBytes: fileSizeOf(row.file || null) })
  }
  return out
}

export function listSqliteObjects(db: Db, schema: string): DataObjectInfo[] {
  requireSchema(db, schema)
  const rows = schemaRows(db, schema)
  const flags = tableList(db, schema)
  const size = fileSizeOf(schemaFile(db, schema))
  // temp lives in memory/temp files: always small enough to measure.
  const small = schema === 'temp' || (size !== null && size <= EXACT_COUNT_MAX_FILE)
  const measurable = schema === 'temp' || (size !== null && size <= DBSTAT_MAX_FILE)
  const stat1 = stat1RowCounts(db, schema)
  const sizes = measurable ? tableSizes(db, schema, rows) : new Map<string, number>()

  const out: DataObjectInfo[] = []
  for (const row of rows) {
    if (isInternal(row.name)) continue
    if (row.type === 'table') {
      const engine = tableEngine(row, flags.get(row.name))
      const isVirtual = engine?.startsWith('virtual') ?? false
      let rowEstimate: number | null = stat1.get(row.name) ?? null
      if (small && !isVirtual) rowEstimate = exactCount(db, schema, row.name) ?? rowEstimate
      out.push({
        name: row.name,
        kind: 'table',
        rowEstimate,
        sizeBytes: sizes.get(row.name) ?? null,
        ...(engine ? { engine } : {})
      })
    } else if (row.type === 'view') {
      out.push({ name: row.name, kind: 'view', rowEstimate: null, sizeBytes: null })
    } else if (row.type === 'trigger') {
      out.push({ name: row.name, kind: 'trigger', detail: row.tbl })
    }
  }
  return out
}

interface XInfoRow {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
  hidden: number
}

interface IndexListRow {
  seq: number
  name: string
  unique: number
  origin: string
  partial: number
}

interface IndexXInfoRow {
  seqno: number
  cid: number
  name: string | null
  desc: number
  key: number
}

interface ForeignKeyRow {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
  on_update: string
  on_delete: string
}

/** Table-level `CONSTRAINT name FOREIGN KEY (cols) REFERENCES t` names, keyed "cols→table". */
function foreignKeyNames(sql: string | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!sql) return out
  const ident = String.raw`(?:"(?:[^"]|"")+"|\x60(?:[^\x60]|\x60\x60)+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`
  const re = new RegExp(
    String.raw`CONSTRAINT\s+(${ident})\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(${ident})`,
    'gi'
  )
  const unquote = (s: string): string => {
    const t = s.trim()
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('`') && t.endsWith('`')))
      return t.slice(1, -1).replace(/""|``/g, (m) => m[0])
    if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1)
    return t
  }
  for (const m of sql.matchAll(re)) {
    const cols = m[2]
      .split(',')
      .map((c) => unquote(c).toLowerCase())
      .join(',')
    out.set(`${cols}->${unquote(m[3]).toLowerCase()}`, unquote(m[1]))
  }
  return out
}

function primaryKeyOf(db: Db, schema: string, table: string): string[] {
  try {
    const cols = db
      .prepare('SELECT name, pk FROM pragma_table_info(?, ?) WHERE pk > 0 ORDER BY pk')
      .all(table, schema) as Array<{ name: string }>
    return cols.map((c) => c.name)
  } catch {
    return []
  }
}

export function describeSqliteObject(db: Db, schema: string, name: string): DataTableDetails {
  requireSchema(db, schema)
  const s = quoteSqliteIdent(schema)
  const obj = db
    .prepare(
      `SELECT type, name, tbl_name AS tbl, sql FROM ${s}.sqlite_schema WHERE name = ? AND type IN ('table','view')`
    )
    .get(name) as SchemaRow | undefined
  if (!obj) {
    throw new SqliteWorkerFailure(`No table or view named "${name}" in ${schema}.`, {
      code: 'SQLITE_ERROR'
    })
  }
  const kind: DataObjectKind = obj.type === 'view' ? 'view' : 'table'
  const xinfo = db.prepare('SELECT * FROM pragma_table_xinfo(?, ?)').all(name, schema) as XInfoRow[]
  const pkCols = xinfo.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk)
  const flags = tableList(db, schema).get(name)
  const engine = kind === 'table' ? tableEngine(obj, flags) : undefined
  const hasAutoincrement = !!obj.sql && /\bAUTOINCREMENT\b/i.test(obj.sql)
  // INTEGER PRIMARY KEY (exactly that type, single column) is the rowid alias: auto-assigned.
  const rowidAlias =
    kind === 'table' &&
    !flags?.wr &&
    pkCols.length === 1 &&
    pkCols[0].type.toUpperCase() === 'INTEGER'
      ? pkCols[0].name
      : null

  const columns: DataColumnInfo[] = xinfo.map((c, i) => {
    const extras: string[] = []
    if (c.hidden === 2) extras.push('GENERATED ALWAYS (VIRTUAL)')
    else if (c.hidden === 3) extras.push('GENERATED ALWAYS (STORED)')
    else if (c.hidden === 1) extras.push('HIDDEN')
    if (c.name === rowidAlias) extras.push(hasAutoincrement ? 'AUTOINCREMENT' : 'rowid alias')
    return {
      name: c.name,
      type: c.type || '',
      // A rowid alias can never be NULL; other legacy PK columns can unless declared NOT NULL.
      nullable: c.notnull === 0 && c.name !== rowidAlias,
      defaultValue: c.dflt_value,
      isPrimaryKey: c.pk > 0,
      ordinal: i + 1,
      autoIncrement: c.name === rowidAlias,
      ...(extras.length ? { extra: extras.join(', ') } : {})
    }
  })

  const indexes: DataIndexInfo[] = []
  if (kind === 'table') {
    const list = db
      .prepare('SELECT * FROM pragma_index_list(?, ?)')
      .all(name, schema) as IndexListRow[]
    const indexSql = new Map(
      (
        db
          .prepare(`SELECT name, sql FROM ${s}.sqlite_schema WHERE type = 'index' AND tbl_name = ?`)
          .all(name) as Array<{ name: string; sql: string | null }>
      ).map((r) => [r.name, r.sql] as const)
    )
    for (const idx of list) {
      const cols = (
        db
          .prepare('SELECT * FROM pragma_index_xinfo(?, ?) WHERE key = 1 ORDER BY seqno')
          .all(idx.name, schema) as IndexXInfoRow[]
      ).map((c) => (c.name ?? (c.cid === -2 ? '<expression>' : 'rowid')) + (c.desc ? ' DESC' : ''))
      const origin =
        idx.origin === 'pk' ? 'primary key' : idx.origin === 'u' ? 'unique constraint' : 'index'
      indexes.push({
        name: idx.name,
        columns: cols,
        unique: idx.unique === 1,
        primary: idx.origin === 'pk',
        definition: indexSql.get(idx.name) ?? undefined,
        type: idx.partial ? `${origin}, partial` : origin
      })
    }
    // The rowid alias PK has no index entry of its own: show it so the PK is visible.
    if (pkCols.length > 0 && !indexes.some((i) => i.primary)) {
      indexes.unshift({
        name: 'PRIMARY KEY',
        columns: pkCols.map((c) => c.name),
        unique: true,
        primary: true,
        type: rowidAlias ? 'rowid' : 'primary key'
      })
    }
  }

  const foreignKeys: DataForeignKeyInfo[] = []
  if (kind === 'table') {
    const fkRows = db
      .prepare('SELECT * FROM pragma_foreign_key_list(?, ?)')
      .all(name, schema) as ForeignKeyRow[]
    const names = foreignKeyNames(obj.sql)
    const byId = new Map<number, ForeignKeyRow[]>()
    for (const row of fkRows) byId.set(row.id, [...(byId.get(row.id) ?? []), row])
    // pragma ids run in reverse declaration order; list them in declaration order.
    for (const id of [...byId.keys()].sort((a, b) => b - a)) {
      const parts = (byId.get(id) ?? []).sort((a, b) => a.seq - b.seq)
      const first = parts[0]
      const columnsFrom = parts.map((p) => p.from)
      // `REFERENCES parent` without columns means the parent's primary key.
      let refColumns = parts.map((p) => p.to).filter((c): c is string => !!c)
      if (refColumns.length === 0) refColumns = primaryKeyOf(db, schema, first.table)
      const key = `${columnsFrom.map((c) => c.toLowerCase()).join(',')}->${first.table.toLowerCase()}`
      foreignKeys.push({
        name: names.get(key) ?? `${name}_${columnsFrom.join('_')}_fkey`,
        columns: columnsFrom,
        refTable: first.table,
        refColumns,
        onUpdate: first.on_update,
        onDelete: first.on_delete
      })
    }
  }

  const triggers = (
    db
      .prepare(
        `SELECT name, sql FROM ${s}.sqlite_schema WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`
      )
      .all(name) as Array<{ name: string; sql: string | null }>
  ).map((t) => ({ name: t.name, definition: t.sql ?? undefined }))

  const size = fileSizeOf(schemaFile(db, schema))
  const isVirtual = engine?.startsWith('virtual') ?? false
  let rowEstimate: number | null = null
  if (kind === 'table') {
    rowEstimate = stat1RowCounts(db, schema).get(name) ?? null
    if (!isVirtual && (schema === 'temp' || (size !== null && size <= DESCRIBE_COUNT_MAX_FILE))) {
      rowEstimate = exactCount(db, schema, name) ?? rowEstimate
    }
  }
  let sizeBytes: number | null = null
  if (kind === 'table' && (schema === 'temp' || (size !== null && size <= DBSTAT_MAX_FILE))) {
    const all = schemaRows(db, schema)
    sizeBytes = tableSizes(db, schema, all).get(name) ?? null
  }

  const properties: Array<{ label: string; value: string }> = [{ label: 'Database', value: schema }]
  if (engine) properties.push({ label: 'Table type', value: engine })
  if (rowidAlias) properties.push({ label: 'Rowid alias', value: rowidAlias })
  else if (kind === 'table' && !flags?.wr && !isVirtual)
    properties.push({ label: 'Rowid', value: 'implicit rowid' })

  return {
    ref: { database: schema, name, kind },
    kind,
    columns,
    indexes,
    foreignKeys,
    triggers,
    primaryKey: pkCols.map((c) => c.name),
    rowEstimate,
    sizeBytes,
    ...(engine ? { engine } : {}),
    properties
  }
}

const withSemicolon = (sql: string): string =>
  sql.trimEnd().endsWith(';') ? sql.trimEnd() : `${sql.trimEnd()};`

/** CREATE statement of the object plus its indexes and triggers, from sqlite_schema.sql. */
export function sqliteObjectDdl(db: Db, schema: string, name: string): string {
  requireSchema(db, schema)
  const s = quoteSqliteIdent(schema)
  const obj = db
    .prepare(`SELECT type, name, tbl_name AS tbl, sql FROM ${s}.sqlite_schema WHERE name = ?`)
    .get(name) as SchemaRow | undefined
  if (!obj)
    throw new SqliteWorkerFailure(`No object named "${name}" in ${schema}.`, {
      code: 'SQLITE_ERROR'
    })
  if (!obj.sql) {
    // Autoindexes (UNIQUE/PK constraints) have no SQL of their own.
    return `-- ${obj.name} is created implicitly by a constraint of table ${obj.tbl}`
  }
  const parts = [withSemicolon(obj.sql)]
  if (obj.type === 'table' || obj.type === 'view') {
    const deps = db
      .prepare(
        `SELECT type, sql FROM ${s}.sqlite_schema
         WHERE tbl_name = ? AND name <> ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
         ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END, name`
      )
      .all(name, name) as Array<{ type: string; sql: string }>
    for (const dep of deps) parts.push(withSemicolon(dep.sql))
  }
  return parts.join('\n\n') + '\n'
}

export interface SqliteCompletionSnapshot {
  database: string
  databases: string[]
  tables: DataCompletionTable[]
  functions: string[]
  truncated: boolean
}

export function sqliteCompletionSnapshot(
  db: Db,
  schema: string,
  maxTables: number
): SqliteCompletionSnapshot {
  requireSchema(db, schema)
  const s = quoteSqliteIdent(schema)
  const objects = db
    .prepare(
      `SELECT type, name FROM ${s}.sqlite_schema WHERE type IN ('table', 'view') ORDER BY name`
    )
    .all() as Array<{ type: string; name: string }>
  const visible = objects.filter((o) => !isInternal(o.name))
  const tables: DataCompletionTable[] = []
  const columnsStmt = db.prepare('SELECT name, type FROM pragma_table_info(?, ?) ORDER BY cid')
  for (const o of visible.slice(0, maxTables)) {
    let columns: Array<{ name: string; type: string }> = []
    try {
      // Per object: one broken view (dropped base table) must not empty the whole snapshot.
      columns = (columnsStmt.all(o.name, schema) as Array<{ name: string; type: string }>).map(
        (c) => ({
          name: c.name,
          type: c.type || ''
        })
      )
    } catch {
      columns = []
    }
    tables.push({ name: o.name, kind: o.type === 'view' ? 'view' : 'table', columns })
  }
  let functions: string[] = []
  try {
    functions = (
      db.prepare('SELECT DISTINCT name FROM pragma_function_list ORDER BY name').all() as Array<{
        name: string
      }>
    )
      .map((f) => f.name)
      .filter((n) => !isInternal(n))
  } catch {
    functions = []
  }
  const state = readSessionState(db)
  const databases = databaseList(db)
    .map((r) => r.name)
    .filter((n) => n !== 'temp' || state.tempObjects > 0)
  return { database: schema, databases, tables, functions, truncated: visible.length > maxTables }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

/** One better-sqlite3 connection and the operations the protocol exposes. */
export class SqliteSession {
  private db: Db | null = null

  get isOpen(): boolean {
    return this.db !== null && this.db.open
  }

  private requireDb(): Db {
    if (!this.db || !this.db.open) {
      throw new SqliteWorkerFailure('The SQLite database is not open.', { code: 'SQLITE_MISUSE' })
    }
    return this.db
  }

  async open(params: SqliteOpenParams): Promise<SqliteOpenResult> {
    this.close()
    const Database = await loadBetterSqlite3()
    const memory = params.path === ':memory:'
    if (!memory && !params.create && !existsSync(params.path)) {
      throw new SqliteWorkerFailure(`Database file not found: ${params.path}`, {
        code: 'SQLITE_CANTOPEN',
        hint: 'The file was moved or deleted. Edit the connection to pick it again.'
      })
    }
    let db: Db
    try {
      db = new Database(params.path, {
        readonly: params.readonly && !memory,
        fileMustExist: !params.create && !memory,
        timeout: Math.max(0, params.busyTimeoutMs)
      })
    } catch (error) {
      const e = toSqliteWorkerError(error)
      throw new SqliteWorkerFailure(`Cannot open ${params.path}: ${e.message}`, {
        code: e.code,
        hint: e.hint ?? HINTS.SQLITE_CANTOPEN
      })
    }
    try {
      // Opening is lazy: the first read is what discovers "file is not a database".
      db.prepare('SELECT count(*) FROM sqlite_schema').get()
      // Most users expect declared FOREIGN KEYs to be enforced (SQLite's default is off).
      db.pragma('foreign_keys = ON')
      if (params.queryOnly) db.pragma('query_only = ON')
    } catch (error) {
      db.close()
      const e = toSqliteWorkerError(error)
      throw new SqliteWorkerFailure(`Cannot open ${params.path}: ${e.message}`, {
        code: e.code,
        hint: e.hint
      })
    }
    this.db = db
    const attachWarnings = params.attach?.length ? syncAttachments(db, params.attach) : []
    const version = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
    return {
      sqliteVersion: version,
      state: readSessionState(db),
      fileSize: memory ? null : fileSizeOf(params.path),
      attachWarnings
    }
  }

  exec(params: SqliteExecParams): SqliteExecResult {
    const db = this.requireDb()
    const started = performance.now()
    let stmt: BetterSqlite3.Statement
    try {
      stmt = db.prepare(params.sql)
    } catch (error) {
      if (error instanceof RangeError && /contains no statements/i.test(error.message)) {
        // A comment-only "statement": nothing to run, nothing went wrong.
        return {
          output: { kind: 'command', message: 'Nothing to run (comment only)', affectedRows: null },
          elapsedMs: performance.now() - started,
          state: readSessionState(db)
        }
      }
      throw error
    }

    let restoreQueryOnly: number | null = null
    if (params.sandbox) {
      // sqlite3_stmt_readonly is exact and prepare() does not execute anything: refuse a writer
      // before it runs. query_only is the engine-level backstop for anything the flag misses
      // (it is re-asserted per statement because `PRAGMA query_only=OFF` itself would run).
      if (!stmt.readonly) {
        throw new SqliteWorkerFailure(
          'This statement can modify the database; it was not run in read-only mode.',
          {
            code: 'SQLITE_READONLY',
            sandboxRejected: true
          }
        )
      }
      restoreQueryOnly = Number(db.pragma('query_only', { simple: true }) ?? 0)
      db.pragma('query_only = ON')
    }

    try {
      let output: SqliteExecResult['output']
      if (stmt.reader) {
        output = this.readRows(stmt, params.maxRows)
      } else {
        const info = stmt.run()
        const words = leadingWords(params.sql, 1)
        const dml = words.length > 0 && DML_LEADERS.has(words[0])
        const isInsert = words[0] === 'INSERT' || words[0] === 'REPLACE'
        output = {
          kind: 'command',
          message: commandTag(params.sql),
          affectedRows: dml ? info.changes : null,
          lastInsertId: isInsert && info.changes > 0 ? String(info.lastInsertRowid) : null
        }
      }
      return { output, elapsedMs: performance.now() - started, state: readSessionState(db) }
    } finally {
      if (restoreQueryOnly !== null && db.open) {
        db.pragma(`query_only = ${restoreQueryOnly ? 'ON' : 'OFF'}`)
      }
    }
  }

  private readRows(stmt: BetterSqlite3.Statement, maxRows: number): SqliteRowsPayload {
    stmt.raw(true)
    stmt.safeIntegers(true)
    const declared = stmt.columns()
    const cap = Math.max(0, Math.floor(maxRows))
    const rows: DataCell[][] = []
    const inferred: Array<string | undefined> = declared.map(() => undefined)
    let chars = 0
    let truncated = false
    let byteLimited = false
    // iterate() hands control back per row, so the cap stops SQLite early; break → return()
    // resets the statement.
    for (const raw of stmt.iterate() as IterableIterator<unknown[]>) {
      if (rows.length >= cap) {
        truncated = true
        break
      }
      const row: DataCell[] = new Array(raw.length)
      let rowChars = 0
      for (let i = 0; i < raw.length; i++) {
        const v = raw[i]
        if (inferred[i] === undefined && v !== null && declared[i]?.type == null)
          inferred[i] = storageClassOf(v)
        const cell = sqliteCell(v)
        rowChars += cellChars(cell)
        row[i] = cell
      }
      // The row that would cross the budget is left out (unless it is the only one), so one
      // giant TEXT value cannot turn into a giant IPC/WebSocket message.
      if (rows.length > 0 && chars + rowChars > MAX_RESULT_CHARS) {
        truncated = true
        byteLimited = true
        break
      }
      chars += rowChars
      rows.push(row)
    }
    const columns: DataColumnMeta[] = declared.map((c, i) => {
      const meta: DataColumnMeta = { name: c.name }
      const type = c.type ?? inferred[i]
      if (type) meta.type = type
      if (c.table) meta.table = c.table
      if (c.database) meta.database = c.database
      return meta
    })
    return { kind: 'rows', columns, rows, truncated, byteLimited }
  }

  introspect(query: SqliteIntrospectQuery): unknown {
    const db = this.requireDb()
    if (query.attach) syncAttachments(db, query.attach)
    switch (query.kind) {
      case 'state':
        return readSessionState(db)
      case 'databases':
        return listSqliteDatabases(db)
      case 'objects':
        return listSqliteObjects(db, query.schema)
      case 'describe':
        return describeSqliteObject(db, query.schema, query.name)
      case 'ddl':
        return sqliteObjectDdl(db, query.schema, query.name)
      case 'completion':
        return sqliteCompletionSnapshot(db, query.schema, query.maxTables)
      default:
        throw new SqliteWorkerFailure(`Unknown introspection query`, { code: 'SQLITE_MISUSE' })
    }
  }

  /**
   * Streams every row of a read statement in batches (export). `emit` resolves when the batch
   * was consumed; the statement stays open across those awaits, which is why exports get a
   * connection of their own.
   */
  async stream(
    params: SqliteStreamParams,
    emit: (columns: string[], rows: DataCell[][]) => Promise<void>
  ): Promise<{ rows: number }> {
    const db = this.requireDb()
    const stmt = db.prepare(params.sql)
    if (!stmt.reader) {
      throw new SqliteWorkerFailure('Only statements that return rows can be exported.', {
        code: 'SQLITE_MISUSE'
      })
    }
    if (params.sandbox && !stmt.readonly) {
      throw new SqliteWorkerFailure(
        'This statement can modify the database; it was not run in read-only mode.',
        {
          code: 'SQLITE_READONLY',
          sandboxRejected: true
        }
      )
    }
    stmt.raw(true)
    stmt.safeIntegers(true)
    const columns = stmt.columns().map((c) => c.name)
    const batchSize = Math.max(1, Math.floor(params.batchSize))
    let batch: DataCell[][] = []
    let total = 0
    let emitted = false
    for (const raw of stmt.iterate() as IterableIterator<unknown[]>) {
      batch.push(raw.map((v) => sqliteCell(v, true)))
      total++
      if (batch.length >= batchSize) {
        const out = batch
        batch = []
        emitted = true
        await emit(columns, out)
      }
    }
    // Always emit once so an empty result still produces a header.
    if (batch.length > 0 || !emitted) await emit(columns, batch)
    return { rows: total }
  }

  close(): void {
    if (this.db) {
      try {
        if (this.db.open) this.db.close()
      } catch {
        // closing a connection that is mid-iteration throws; the process/handle goes away anyway
      }
      this.db = null
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Child-process entry
// ---------------------------------------------------------------------------------------------

const sqlOf = (req: SqliteWorkerRequest): string | undefined =>
  req.op === 'exec' || req.op === 'stream' ? req.params.sql : undefined

const sandboxOf = (req: SqliteWorkerRequest): boolean =>
  req.op === 'exec' || req.op === 'stream' ? req.params.sandbox : false

/**
 * Handles one request against `session`. Shared by the child loop below; `emitBatch` sends a
 * stream batch and resolves when the parent acknowledged it.
 */
export async function handleSqliteWorkerRequest(
  session: SqliteSession,
  req: SqliteWorkerRequest,
  emitBatch: (columns: string[], rows: DataCell[][]) => Promise<void>
): Promise<SqliteWorkerMessage> {
  try {
    let value: unknown = null
    switch (req.op) {
      case 'open':
        value = await session.open(req.params)
        break
      case 'exec':
        value = session.exec(req.params)
        break
      case 'introspect':
        value = session.introspect(req.query)
        break
      case 'stream':
        value = await session.stream(req.params, emitBatch)
        break
      case 'close':
        session.close()
        break
      default:
        throw new SqliteWorkerFailure(`Unknown request`, { code: 'SQLITE_MISUSE' })
    }
    return { type: 'result', id: req.id, ok: true, value }
  } catch (error) {
    return {
      type: 'result',
      id: req.id,
      ok: false,
      error: toSqliteWorkerError(error, sqlOf(req), sandboxOf(req))
    }
  }
}

/**
 * Child-process main loop (server/bin.ts calls it when HIVE_DATA_SQLITE_WORKER=1). Requests
 * run strictly one after another; stream acks bypass the queue because the running stream is
 * what waits for them. The process exits when the parent goes away (IPC disconnect) or after
 * `close`.
 */
export function runSqliteWorker(): void {
  const send = process.send?.bind(process)
  if (!send) {
    process.stderr.write('[sqlite-worker] started without an IPC channel; exiting\n')
    process.exit(1)
  }
  const post = (message: SqliteWorkerMessage): Promise<void> =>
    new Promise((resolve) => {
      try {
        send(message, undefined, undefined, () => resolve())
      } catch {
        // channel closed: the parent is gone and 'disconnect' ends this process
        resolve()
      }
    })

  const session = new SqliteSession()
  const acks = new Map<number, () => void>()
  let queue: Promise<void> = Promise.resolve()

  process.on('message', (raw: unknown) => {
    const req = raw as SqliteWorkerRequest
    if (!req || typeof req !== 'object' || typeof req.id !== 'number' || typeof req.op !== 'string')
      return
    if (req.op === 'ack') {
      const resolve = acks.get(req.id)
      acks.delete(req.id)
      resolve?.()
      return
    }
    queue = queue
      .then(async () => {
        const reply = await handleSqliteWorkerRequest(session, req, (columns, rows) => {
          const acked = new Promise<void>((resolve) => acks.set(req.id, resolve))
          void post({ type: 'batch', id: req.id, columns, rows })
          return acked
        })
        await post(reply)
        if (req.op === 'close') process.exit(0)
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `[sqlite-worker] request failed: ${error instanceof Error ? error.message : String(error)}\n`
        )
      })
  })

  process.on('disconnect', () => {
    session.close()
    process.exit(0)
  })
  process.on('uncaughtException', (error) => {
    process.stderr.write(
      `[sqlite-worker] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    )
    session.close()
    process.exit(1)
  })

  void post({ type: 'ready', pid: process.pid })
}
