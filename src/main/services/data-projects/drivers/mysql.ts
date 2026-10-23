// MySQL and MariaDB through mysql2 (one adapter: mysql2 reads MariaDB's extended metadata too).
//
// Connections (drivers.md §1): a sticky SESSION connection for the editor (USE, SET, temp tables,
// BEGIN…COMMIT all live there; the caller serialises execute()), a lazy CONTROL connection for
// introspection, the process list and `KILL QUERY <session thread id>`, and a throwaway
// connection per export stream so the session stays usable.
//
// Values: user statements run with `typeCast: false`, so every cell arrives as the raw bytes of
// the text protocol and is decoded here with the column definition in hand: text as UTF-8
// (the connection charset is utf8mb4), BLOB/BINARY/VARBINARY (charset 63) and GEOMETRY as binary
// cells, BIT as its unsigned value (a number up to 53 bits, exact text beyond), small integers
// as numbers, BIGINT/DECIMAL/dates as the exact server text. Warnings of a statement (OK packet
// or, for rows, the EOF packets) come back as notices.
//
// sql_mode: the session's is read at connect and after any statement that names sql_mode;
// `sessionState().backslashEscapes` reports NO_BACKSLASH_ESCAPES for literal quoting elsewhere,
// export connections mirror it, and the control connection runs without that mode (its catalog
// queries bind values with mysql2's backslash escaping).
//
// Auto-limit: `SET SESSION sql_select_limit = N+1` (applies to top-level SELECTs without their
// own LIMIT; no SQL rewriting) plus a client-side cap while streaming. Rows past the cap are
// drained without being kept; a runaway result (far past the cap) is stopped with KILL QUERY.
// When the statement has a LIMIT of its own (the user's LIMIT wins), sql_select_limit is back at
// DEFAULT: the server would otherwise still cut a result whose LIMIT does not bound the outer
// query (`(SELECT … LIMIT n) UNION ALL (SELECT …)`, MariaDB `LIMIT ROWS EXAMINED n`) at N+1 rows
// that nothing here would report as cut. Only the hard cap applies then, and it reports its cut.
//
// Read-only sandbox: START TRANSACTION READ ONLY … ROLLBACK around auto-run reads when the
// session has no open transaction; errno 1792 → sandboxRejected. It does not stop DDL (implicit
// commit), which is why the classifier owns DDL. Starting a transaction releases the session's
// LOCK TABLES locks, so while the user holds table locks the sandbox is the session's
// transaction_read_only flag instead (set for the statement, restored after it), which leaves
// the locks alone and still fails writes with 1792.
//
// ProxySQL: a SET of a variable it does not track (information_schema_stats_expiry, MariaDB's
// SET STATEMENT … FOR) pins the connection to the hostgroup that ran it, and the next query its
// rules route elsewhere (catalog SELECTs → readers) fails with 9006 "connection is locked to
// hostgroup". The control connection sends such SETs only as optional tuning: on the first 9006
// it is reopened without them, for the rest of this driver's life.

import net from 'node:net'
import { readFile } from 'node:fs/promises'
import type { Connection, ConnectionOptions, FieldPacket, QueryError, SslOptions } from 'mysql2'
import {
  DATA_HARD_ROW_CAP,
  type DataCell,
  type DataColumnInfo,
  type DataColumnMeta,
  type DataCompletionSchema,
  type DataCompletionTable,
  type DataDatabaseInfo,
  type DataForeignKeyInfo,
  type DataIndexInfo,
  type DataKillScope,
  type DataObjectInfo,
  type DataObjectKind,
  type DataObjectRef,
  type DataObjectsListing,
  type DataProcessInfo,
  type DataRowsResult,
  type DataStatementOutput,
  type DataTableDetails
} from '../../../../shared/data-projects/types'
import { hasUserLimit, quoteSqlString } from '../../../../shared/sql'
import { traceDriverStatement } from '../console-log'
import {
  DataDriverError,
  type DataDriver,
  type DriverConnectInput,
  type DriverExecuteOptions,
  type DriverStatementResult
} from '../contracts'
import { binaryCell, cellSize, toCell } from '../cells'
import { errorMessage } from '../redact'
import { expandHomePath } from '../ssh-tunnel'

type Mysql2Module = typeof import('mysql2')

let mysqlPromise: Promise<Mysql2Module> | null = null
const loadMysql2 = (): Promise<Mysql2Module> => {
  mysqlPromise ??= import('mysql2').then((mod) => {
    const m = mod as Mysql2Module & { default?: Mysql2Module }
    return (typeof m.createConnection === 'function' ? m : m.default) as Mysql2Module
  })
  return mysqlPromise
}

/** Bytes of kept cell text per result before the result is cut (keeps WS frames sane). */
const MAX_RESULT_BYTES = 96 * 1024 * 1024
/** Rows drained past the cap before the query is stopped with KILL QUERY. */
const DRAIN_BEFORE_KILL = 5_000
const STREAM_BATCH_ROWS = 500
const COMPLETION_TABLE_CAP = 5_000
const COMPLETION_COLUMN_CAP = 200_000

const SERVER_STATUS_IN_TRANS = 1

const ER_QUERY_INTERRUPTED = 1317
const ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION = 1792
const ER_KILL_DENIED = 1095
const ER_NO_SUCH_THREAD = 1094
const ER_UNKNOWN_SYSTEM_VARIABLE = 1193
/** ProxySQL: the connection is locked to a hostgroup and the query was routed to another. */
const ER_PROXYSQL_HOSTGROUP_LOCKED = 9006

// Column type codes (mysql2 constants/types).
const T = {
  DECIMAL: 0x00,
  TINY: 0x01,
  SHORT: 0x02,
  LONG: 0x03,
  FLOAT: 0x04,
  DOUBLE: 0x05,
  NULL: 0x06,
  TIMESTAMP: 0x07,
  LONGLONG: 0x08,
  INT24: 0x09,
  DATE: 0x0a,
  TIME: 0x0b,
  DATETIME: 0x0c,
  YEAR: 0x0d,
  NEWDATE: 0x0e,
  VARCHAR: 0x0f,
  BIT: 0x10,
  VECTOR: 0xf2,
  JSON: 0xf5,
  NEWDECIMAL: 0xf6,
  ENUM: 0xf7,
  SET: 0xf8,
  TINY_BLOB: 0xf9,
  MEDIUM_BLOB: 0xfa,
  LONG_BLOB: 0xfb,
  BLOB: 0xfc,
  VAR_STRING: 0xfd,
  STRING: 0xfe,
  GEOMETRY: 0xff
} as const

const BINARY_CHARSET = 63
const UNSIGNED_FLAG = 32
const ENUM_FLAG = 256
const SET_FLAG = 2048

interface ColumnDef {
  name: string
  orgTable?: string
  table?: string
  schema?: string
  columnType: number
  characterSet: number
  flags: number
  columnLength: number
  decimals: number
  extendedTypeName?: string
  extendedFormat?: string
}

const BLOBISH = new Set<number>([
  T.TINY_BLOB,
  T.MEDIUM_BLOB,
  T.LONG_BLOB,
  T.BLOB,
  T.VAR_STRING,
  T.STRING,
  T.VARCHAR
])
const SMALL_INTS = new Set<number>([T.TINY, T.SHORT, T.LONG, T.INT24, T.YEAR])

function typeName(f: ColumnDef): string {
  if (f.extendedTypeName) return f.extendedTypeName.toUpperCase()
  const binary = f.characterSet === BINARY_CHARSET
  const unsigned = (f.flags & UNSIGNED_FLAG) !== 0 ? ' UNSIGNED' : ''
  if (f.flags & ENUM_FLAG) return 'ENUM'
  if (f.flags & SET_FLAG) return 'SET'
  switch (f.columnType) {
    case T.DECIMAL:
    case T.NEWDECIMAL:
      return `DECIMAL${unsigned}`
    case T.TINY:
      return `TINYINT${unsigned}`
    case T.SHORT:
      return `SMALLINT${unsigned}`
    case T.INT24:
      return `MEDIUMINT${unsigned}`
    case T.LONG:
      return `INT${unsigned}`
    case T.LONGLONG:
      return `BIGINT${unsigned}`
    case T.FLOAT:
      return 'FLOAT'
    case T.DOUBLE:
      return 'DOUBLE'
    case T.NULL:
      return 'NULL'
    case T.TIMESTAMP:
      return 'TIMESTAMP'
    case T.DATE:
    case T.NEWDATE:
      return 'DATE'
    case T.TIME:
      return 'TIME'
    case T.DATETIME:
      return 'DATETIME'
    case T.YEAR:
      return 'YEAR'
    case T.BIT:
      return 'BIT'
    case T.VECTOR:
      return 'VECTOR'
    case T.JSON:
      return 'JSON'
    case T.ENUM:
      return 'ENUM'
    case T.SET:
      return 'SET'
    case T.TINY_BLOB:
    case T.MEDIUM_BLOB:
    case T.LONG_BLOB:
    case T.BLOB:
      return binary ? 'BLOB' : f.extendedFormat === 'json' ? 'JSON' : 'TEXT'
    case T.VAR_STRING:
    case T.VARCHAR:
      return binary ? 'VARBINARY' : 'VARCHAR'
    case T.STRING:
      return binary ? 'BINARY' : 'CHAR'
    case T.GEOMETRY:
      return 'GEOMETRY'
    default:
      return 'UNKNOWN'
  }
}

/** Decodes one raw text-protocol value with its column definition. */
function decodeValue(raw: Buffer | null, f: ColumnDef, binaryPreviewBytes: number): DataCell {
  if (raw === null || raw === undefined) return null
  const type = f.columnType
  if (type === T.GEOMETRY || type === T.VECTOR) return binaryCell(raw, binaryPreviewBytes)
  if (type === T.BIT) {
    let value = 0n
    for (const byte of raw) value = (value << 8n) | BigInt(byte)
    // A number (columnLength = bits): edits and SQL exports then write an unquoted integer,
    // which MySQL stores as those bits; a quoted '6' would be the byte 0x36. Wider columns keep
    // the exact decimal text.
    const bits = f.columnLength > 0 ? f.columnLength : raw.length * 8
    return bits <= 53 ? Number(value) : value.toString()
  }
  if (
    BLOBISH.has(type) &&
    f.characterSet === BINARY_CHARSET &&
    !(f.flags & (ENUM_FLAG | SET_FLAG))
  ) {
    return binaryCell(raw, binaryPreviewBytes)
  }
  const text = raw.toString('utf8')
  if (SMALL_INTS.has(type)) {
    const n = Number(text)
    return Number.isSafeInteger(n) ? n : text
  }
  if (type === T.FLOAT || type === T.DOUBLE) {
    const n = Number(text)
    return Number.isFinite(n) && String(n) === text ? n : text
  }
  return text
}

const columnMeta = (f: ColumnDef): DataColumnMeta => {
  const meta: DataColumnMeta = { name: f.name, type: typeName(f) }
  if (f.orgTable) meta.table = f.orgTable
  if (f.schema) meta.database = f.schema
  return meta
}

/** `near '…' at line N` → 0-based offset inside the statement text. */
export function mysqlErrorPosition(statement: string, message: string): number | undefined {
  const m = message.match(/near '([\s\S]*)' at line (\d+)\s*$/)
  if (!m) return undefined
  const snippet = m[1]
  const line = Number(m[2])
  let lineStart = 0
  for (let i = 1; i < line; i++) {
    const nl = statement.indexOf('\n', lineStart)
    if (nl < 0) break
    lineStart = nl + 1
  }
  if (snippet.length === 0) return statement.trimEnd().length
  // MySQL truncates the snippet to ~80 chars; match a prefix.
  const probe = snippet.slice(0, Math.min(snippet.length, 40))
  const at = statement.indexOf(probe, lineStart)
  if (at >= 0) return at
  const anywhere = statement.indexOf(probe)
  return anywhere >= 0 ? anywhere : undefined
}

const quoteIdent = (name: string): string => `\`${name.replace(/`/g, '``')}\``

const isFatal = (error: unknown): boolean =>
  !!error &&
  typeof error === 'object' &&
  ((error as { fatal?: boolean }).fatal === true ||
    ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED'].includes(
      String((error as { code?: unknown }).code)
    ))

const isHostgroupLocked = (error: unknown): boolean =>
  !!error &&
  typeof error === 'object' &&
  ((error as { errno?: unknown }).errno === ER_PROXYSQL_HOSTGROUP_LOCKED ||
    /connection is locked to hostgroup/i.test(
      String((error as { message?: unknown }).message ?? '')
    ))

const closedError = (): DataDriverError =>
  new DataDriverError('The connection was closed.', { code: 'CONNECTION_LOST' })

interface ResultSetHeaderLike {
  affectedRows?: number | string
  insertId?: number | string
  info?: string
  serverStatus?: number
  warningStatus?: number
  stateChanges?: { schema?: string | null } | null
}

interface ResultSetAcc {
  fields: ColumnDef[]
  rows: DataCell[][]
  truncated: boolean
  /** Cut by the result byte budget (not by a row limit). */
  byteLimited: boolean
  bytes: number
}

/** The packet mysql2 hands a Query command's parser states. */
interface Mysql2Packet {
  isEOF?: () => boolean
  eofWarningCount?: () => number
  eofStatusFlags?: () => number
}

type Mysql2ParserState = (this: unknown, packet: Mysql2Packet, connection: unknown) => unknown

/**
 * Reads the EOF packets after the rows of the result sets a query streams: their warning count
 * and server status. mysql2 reports both only in OK packets (statements without rows); for a
 * SELECT they sit in the EOF packet after the rows, which mysql2 reads in its `row` parser state
 * without exposing it. The instance gets a `row` that reads them and then defers to mysql2's own
 * (the first row is parsed through `this.row`, later ones through whatever `row` returns).
 * Without the expected internals this does nothing: warnings of row results are not reported,
 * and the transaction flag only follows OK packets.
 */
function watchEofPackets(
  query: unknown,
  onWarnings: (count: number) => void,
  onStatus: (status: number) => void
): void {
  const target = query as { row?: Mysql2ParserState }
  const original = target.row
  if (typeof original !== 'function') return
  const row: Mysql2ParserState = function (this: unknown, packet, connection) {
    try {
      if (packet?.isEOF?.()) {
        const count = packet.eofWarningCount?.()
        if (typeof count === 'number' && count > 0) onWarnings(count)
        const status = packet.eofStatusFlags?.()
        if (typeof status === 'number') onStatus(status)
      }
    } catch {
      // Diagnostics only.
    }
    const next = original.call(this, packet, connection)
    return next === original ? row : next
  }
  target.row = row
}

/** SHOW WARNINGS / ERRORS and GET DIAGNOSTICS: their rows already are the warnings. */
const DIAGNOSTIC_STATEMENT =
  /^\s*(SHOW\s+(COUNT\s*\(\s*\*\s*\)\s+)?(WARNINGS|ERRORS)|GET\s+((CURRENT|STACKED)\s+)?DIAGNOSTICS)\b/i

/** The statement without its leading whitespace and comments (executable comments stay). */
function withoutLeadingComments(statement: string): string {
  let text = statement
  for (;;) {
    const next = text
      .replace(/^\s+/, '')
      .replace(/^(--(?=\s|$)|#)[^\n]*/, '')
      .replace(/^\/\*(?!!|M!)[\s\S]*?\*\//, '')
    if (next === text) return text
    text = next
  }
}

/**
 * After these the session holds table locks (LOCK TABLES, FLUSH TABLES … WITH READ LOCK / FOR
 * EXPORT) that a START TRANSACTION would silently release.
 */
const TAKES_TABLE_LOCKS = /^(LOCK\s+TABLES?\b|FLUSH\b[\s\S]*\b(WITH\s+READ\s+LOCK|FOR\s+EXPORT)\b)/i
/** …and these release them (a bare BEGIN; MariaDB's BEGIN NOT ATOMIC is a compound statement). */
const RELEASES_TABLE_LOCKS = /^(UNLOCK\s+TABLES?\b|START\s+TRANSACTION\b|BEGIN(\s+WORK)?\s*;?\s*$)/i

/** What a statement that succeeded does to the session's table locks. */
function tableLockEffect(statement: string): 'takes' | 'releases' | null {
  const head = withoutLeadingComments(statement)
  if (TAKES_TABLE_LOCKS.test(head)) return 'takes'
  if (RELEASES_TABLE_LOCKS.test(head)) return 'releases'
  return null
}

/** sql_mode as a literal-safe list of mode names, or null when it is something else. */
const sqlModeList = (mode: unknown): string | null =>
  typeof mode === 'string' && /^[A-Za-z0-9_,]*$/.test(mode) ? mode : null

const noBackslashEscapes = (mode: string | null): boolean =>
  !!mode && /(^|,)NO_BACKSLASH_ESCAPES(,|$)/i.test(mode)

interface StatementOutcome {
  sets: ResultSetAcc[]
  headers: ResultSetHeaderLike[]
  /** Warnings reported in the EOF packets after result-set rows. */
  eofWarnings: number
  /** Server status of the last EOF packet after result-set rows (null: none seen). */
  eofStatus: number | null
}

interface RunningStatement {
  threadId: number
  cancelRequested: boolean
  kills: Array<Promise<void>>
}

type Row = Record<string, unknown>

/** A SELECT SLEEP(…) that KILL QUERY cut short: it returns 1 instead of failing. */
function interruptedSleep(statement: string, sets: Array<{ rows: unknown[][] }>): boolean {
  return (
    /\bsleep\s*\(/i.test(statement) &&
    sets.some((set) => set.rows.some((row) => row.some((cell) => cell === 1 || cell === '1')))
  )
}

class MysqlDriver implements DataDriver {
  readonly engine: DriverConnectInput['project']['engine']
  private readonly input: DriverConnectInput
  private session: Connection | null = null
  private sessionDead = true
  private sessionThreadId = 0
  private control: Connection | null = null
  private controlPromise: Promise<Connection> | null = null
  private controlThreadId = 0
  /**
   * A proxy (ProxySQL) locked a control connection to one hostgroup after an untracked SET:
   * control connections skip the optional session SETs and statement hints from then on.
   */
  private hostgroupLocking = false
  private readonly streamConnections = new Set<Connection>()
  private serverVersion = ''
  private mariaDb = false
  private majorVersion = 0
  private currentDb: string | undefined
  private inTx = false
  /**
   * The user's LOCK TABLES (or FLUSH TABLES … WITH READ LOCK) may still hold: reads are then
   * sandboxed without starting a transaction. Erring towards true only costs that sandbox's
   * extra round trips; erring towards false would release the user's locks.
   */
  private tablesLocked = false
  /** transaction_read_only, or tx_read_only on servers without it; null = not looked up yet. */
  private readOnlyVariable: string | null = null
  /** The read-only flag a sandbox switched on and has not switched off yet. */
  private readOnlyToReset: string | null = null
  /** Bumped by close(): a connection that finishes opening afterwards is ended at once. */
  private epoch = 0
  /** close() ran (and connect() did not since): no control connection is opened any more. */
  private closed = false
  /** The session's sql_mode (read at connect and after a statement that names sql_mode). */
  private sessionSqlMode: string | null = null
  private appliedSelectLimit: number | null = null
  private appliedTimeoutMs = 0
  private running: RunningStatement | null = null
  private connectPromise: Promise<{
    serverVersion: string
    currentDatabase?: string
    readOnlyUser?: boolean
  }> | null = null
  private lastConnectInfo: {
    serverVersion: string
    currentDatabase?: string
    readOnlyUser?: boolean
  } | null = null
  private everConnected = false

  constructor(input: DriverConnectInput) {
    this.input = input
    this.engine = input.project.engine
  }

  // ---- connection plumbing -------------------------------------------------------------------

  private redact(text: string): string {
    return this.input.redact(text)
  }

  private async sslOptions(): Promise<SslOptions | undefined> {
    const ssl = this.input.project.config.ssl
    if (!ssl || ssl.mode === 'disable') return undefined
    const read = async (path: string | undefined, label: string): Promise<string | undefined> => {
      if (!path) return undefined
      try {
        return await readFile(expandHomePath(path), 'utf8')
      } catch (error) {
        throw new DataDriverError(
          `Cannot read the SSL ${label} file ${path}: ${errorMessage(error, (t) => this.redact(t))}`,
          {
            code: 'SSL_FILE'
          }
        )
      }
    }
    const options: SslOptions & { verifyIdentity?: boolean } = {}
    const ca = await read(ssl.caPath, 'CA')
    const cert = await read(ssl.certPath, 'certificate')
    const key = await read(ssl.keyPath, 'key')
    if (ca) options.ca = ca
    if (cert) options.cert = cert
    if (key) options.key = key
    if (ssl.mode === 'verify-ca') {
      options.rejectUnauthorized = true
      options.verifyIdentity = false
    } else if (ssl.mode === 'verify-full') {
      options.rejectUnauthorized = true
      options.verifyIdentity = true
    } else {
      // prefer / require: encrypted, not verified (mysql CLI semantics).
      options.rejectUnauthorized = false
    }
    return options
  }

  private async connectionOptions(
    ssl: SslOptions | undefined,
    database: string | undefined
  ): Promise<ConnectionOptions> {
    const { project, secrets, tunnel } = this.input
    const config = project.config
    const options: ConnectionOptions = {
      host: tunnel?.remoteHost ?? config.host ?? '127.0.0.1',
      port: tunnel?.remotePort ?? config.port ?? 3306,
      user: config.user ?? '',
      password: secrets.password ?? '',
      database: database || undefined,
      ssl,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      decimalNumbers: false,
      multipleStatements: false,
      connectTimeout: 10_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      charset: 'utf8mb4',
      connectAttributes: { program_name: 'Hive' }
    }
    if (tunnel) {
      // Keep `host` = the real server (TLS servername / identity check) and dial the local
      // forward ourselves.
      const localHost = config.host ?? '127.0.0.1'
      const localPort = config.port ?? 3306
      options.stream = () => {
        const socket = net.connect(localPort, localHost)
        socket.setKeepAlive(true, 10_000)
        return socket
      }
    }
    return options
  }

  private async openConnection(
    database: string | undefined,
    onLost: (error: unknown) => void
  ): Promise<Connection> {
    const mysql = await loadMysql2()
    const mode = this.input.project.config.ssl?.mode ?? 'disable'
    const attempt = async (ssl: SslOptions | undefined): Promise<Connection> => {
      const conn = mysql.createConnection(await this.connectionOptions(ssl, database))
      await new Promise<void>((resolve, reject) => {
        conn.connect((error) => (error ? reject(error) : resolve()))
      }).catch((error) => {
        conn.destroy()
        throw error
      })
      conn.on('error', (error) => onLost(error))
      conn.on('end', () => onLost(null))
      return conn
    }
    const ssl = await this.sslOptions()
    try {
      return await attempt(ssl)
    } catch (error) {
      // sslmode=prefer: fall back to plain TCP when the server has no TLS.
      if (mode === 'prefer' && (error as { code?: string }).code === 'HANDSHAKE_NO_SSL_SUPPORT') {
        return attempt(undefined)
      }
      throw this.mapConnectError(error)
    }
  }

  private mapConnectError(error: unknown): DataDriverError {
    if (error instanceof DataDriverError) return error
    const e = error as QueryError & { errno?: number; sqlMessage?: string }
    let message = errorMessage(error, (t) => this.redact(t))
    if (/client_ed25519|parsec|auth_gssapi|unknown plugin/i.test(message)) {
      message +=
        ' — this user authenticates with a plugin mysql2 does not support; use mysql_native_password or caching_sha2_password for it.'
    }
    return new DataDriverError(message, {
      code: e?.errno ? String(e.errno) : e?.code ? String(e.code) : undefined
    })
  }

  /** Promise wrapper for internal queries (object rows, server-side typeCast). */
  private query<R = Row>(conn: Connection, sql: string, values?: unknown[]): Promise<R[]> {
    // Catalog and housekeeping statements show in the console's metadata view.
    return traceDriverStatement(
      sql,
      () =>
        new Promise<R[]>((resolve, reject) => {
          conn.query({ sql, values, rowsAsArray: false }, (error, rows) => {
            if (error) reject(error)
            else resolve((Array.isArray(rows) ? rows : [rows]) as R[])
          })
        }),
      (rows) => ({ rows: rows.length }),
      // Logged with the values in place of the `?`s, as mysql2 sends it.
      values
    )
  }

  /** Runs an internal statement on the session and tracks its transaction flag. */
  private async sessionCommand(sql: string): Promise<ResultSetHeaderLike> {
    const conn = this.requireSession()
    const rows = await this.query<ResultSetHeaderLike>(conn, sql)
    const header = rows[0]
    if (header && typeof header.serverStatus === 'number') {
      this.inTx = (header.serverStatus & SERVER_STATUS_IN_TRANS) !== 0
    }
    return header ?? {}
  }

  /**
   * First use connects; a session that was connected and then died is NOT silently reopened:
   * that would run e.g. a COMMIT on a fresh connection after the transaction was lost. The
   * connection manager sees CONNECTION_LOST and decides (reads are retried, writes never).
   */
  private async ensureLive(): Promise<void> {
    if (this.isConnected()) return
    if (this.everConnected) {
      throw new DataDriverError('The connection to the server was lost.', {
        code: 'CONNECTION_LOST'
      })
    }
    await this.connect()
  }

  private requireSession(): Connection {
    if (!this.session || this.sessionDead) {
      throw new DataDriverError('The connection to the server was lost.', {
        code: 'CONNECTION_LOST'
      })
    }
    return this.session
  }

  async connect(): Promise<{
    serverVersion: string
    currentDatabase?: string
    readOnlyUser?: boolean
  }> {
    if (this.session && !this.sessionDead && this.lastConnectInfo) return this.lastConnectInfo
    this.connectPromise ??= this.doConnect().finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  private async doConnect(): Promise<{
    serverVersion: string
    currentDatabase?: string
    readOnlyUser?: boolean
  }> {
    const database = this.input.database ?? this.input.project.config.database
    this.closed = false
    const epoch = this.epoch
    let opened: Connection | null = null
    const conn = await this.openConnection(database, () => {
      if (opened && this.session === opened) this.sessionDead = true
    })
    if (epoch !== this.epoch) {
      // close() ran while this connection was opening (connect timeout, disconnect).
      conn.destroy()
      throw closedError()
    }
    opened = conn
    this.session = conn
    this.sessionDead = false
    this.sessionThreadId = conn.threadId ?? 0
    this.inTx = false
    this.tablesLocked = false
    this.readOnlyToReset = null
    this.appliedSelectLimit = null
    this.appliedTimeoutMs = 0
    try {
      type Info = { v: string; db: string | null; ro?: number | string; id?: number | string }
      // Some managed servers/proxies refuse @@global reads: fall back to the bare minimum.
      const [info] = await this.query<Info>(
        conn,
        'SELECT VERSION() AS v, DATABASE() AS db, @@global.read_only AS ro, CONNECTION_ID() AS id'
      ).catch(() => this.query<Info>(conn, 'SELECT VERSION() AS v, DATABASE() AS db'))
      this.serverVersion = String(info?.v ?? '')
      this.mariaDb = /mariadb/i.test(this.serverVersion)
      this.majorVersion = Number(this.serverVersion.split('.')[0]) || 0
      this.currentDb = info?.db ?? undefined
      if (info?.id) this.sessionThreadId = Number(info.id)
      await this.readSqlMode()
      await this.applyTimeZone(conn, !noBackslashEscapes(this.sessionSqlMode))
      this.everConnected = true
      this.lastConnectInfo = {
        serverVersion: this.serverVersion,
        currentDatabase: this.currentDb,
        readOnlyUser: Number(info?.ro) === 1
      }
      return this.lastConnectInfo
    } catch (error) {
      conn.destroy()
      this.session = null
      this.sessionDead = true
      throw this.mapConnectError(error)
    }
  }

  /**
   * The project's time_zone on a session or export connection. Named zones need the tz tables
   * (often not loaded); UTC as an offset always works. A failure keeps the server zone.
   */
  private async applyTimeZone(conn: Connection, backslashEscapes: boolean): Promise<void> {
    const tz = this.input.project.config.timezone
    if (!tz) return
    const zone = /^(Etc\/)?(UTC|GMT|Z|Zulu|UCT)$/i.test(tz) ? '+00:00' : tz
    await this.query(
      conn,
      `SET time_zone = ${quoteSqlString(zone, this.engine === 'mariadb' ? 'mariadb' : 'mysql', { backslashEscapes })}`
    ).catch(() => undefined)
  }

  /** Re-reads the session's sql_mode (NO_BACKSLASH_ESCAPES changes how literals are quoted). */
  private async readSqlMode(): Promise<void> {
    if (!this.session || this.sessionDead) return
    const [row] = await this.query<{ mode: unknown }>(
      this.requireSession(),
      'SELECT @@SESSION.sql_mode AS mode'
    ).catch(() => [])
    if (row) this.sessionSqlMode = sqlModeList(nullableString(row.mode))
  }

  private async getControl(): Promise<Connection> {
    if (this.control) return this.control
    if (this.closed) throw closedError()
    if (!this.controlPromise) {
      const pending: Promise<Connection> = this.openControl().finally(() => {
        if (this.controlPromise === pending) this.controlPromise = null
      })
      this.controlPromise = pending
    }
    return this.controlPromise
  }

  private async openControl(): Promise<Connection> {
    const epoch = this.epoch
    let opened: Connection | null = null
    const conn = await this.openConnection(
      this.input.database ?? this.input.project.config.database,
      () => {
        if (opened && this.control === opened) {
          this.control = null
          this.controlPromise = null
        }
      }
    )
    opened = conn
    if (epoch === this.epoch) {
      if (!this.mariaDb && this.majorVersion >= 8 && !this.hostgroupLocking) {
        // Otherwise TABLE_ROWS / sizes come from a cache up to 24 h old.
        await this.query(conn, 'SET SESSION information_schema_stats_expiry = 0').catch(
          () => undefined
        )
      }
      // Catalog queries bind values with mysql2's client-side escaping, which writes `\'`: under
      // a server-wide NO_BACKSLASH_ESCAPES that would end the string early. This connection is
      // ours alone, so it simply runs without that mode.
      const [row] = await this.query<{ mode: unknown }>(
        conn,
        'SELECT @@SESSION.sql_mode AS mode'
      ).catch(() => [])
      const mode = row ? sqlModeList(nullableString(row.mode)) : null
      if (mode !== null && noBackslashEscapes(mode)) {
        const without = mode
          .split(',')
          .filter((m) => m.toUpperCase() !== 'NO_BACKSLASH_ESCAPES')
          .join(',')
        await this.query(conn, `SET SESSION sql_mode = '${without}'`).catch(() => undefined)
      }
    }
    if (epoch !== this.epoch) {
      // close() ran while this connection was opening.
      conn.destroy()
      throw closedError()
    }
    this.controlThreadId = conn.threadId ?? 0
    this.control = conn
    return conn
  }

  /** Internal query on the control connection, retried once if the connection had died. */
  private async controlQuery<R = Row>(sql: string, values?: unknown[]): Promise<R[]> {
    if (!this.serverVersion) await this.connect()
    for (let attempt = 0; ; attempt++) {
      const conn = await this.getControl()
      try {
        return await this.query<R>(conn, sql, values)
      } catch (error) {
        if (attempt === 0 && isFatal(error)) {
          if (this.control === conn) this.control = null
          conn.destroy()
          continue
        }
        // Rejected by the proxy before reaching a server, so running it again is safe. The locked
        // connection is replaced every time: a hint sent before the flag was set may lock it again.
        if (attempt === 0 && isHostgroupLocked(error)) {
          this.hostgroupLocking = true
          if (this.control === conn) this.control = null
          conn.destroy()
          continue
        }
        throw this.mapError(error, sql, false)
      }
    }
  }

  async close(): Promise<void> {
    this.epoch++
    this.closed = true
    const conns = [this.session, this.control, ...this.streamConnections].filter(
      (c): c is Connection => !!c
    )
    this.session = null
    this.sessionDead = true
    this.control = null
    this.controlPromise = null
    this.streamConnections.clear()
    this.lastConnectInfo = null
    await Promise.all(
      conns.map(
        (conn) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              conn.destroy()
              resolve()
            }, 2_000)
            conn.end(() => {
              clearTimeout(timer)
              resolve()
            })
          })
      )
    )
  }

  isConnected(): boolean {
    return !!this.session && !this.sessionDead
  }

  sessionState(): {
    inTransaction?: boolean
    currentDatabase?: string
    backslashEscapes?: boolean
    tablesLocked?: boolean
  } {
    return {
      inTransaction: this.inTx,
      currentDatabase: this.currentDb,
      backslashEscapes: !noBackslashEscapes(this.sessionSqlMode),
      tablesLocked: this.tablesLocked
    }
  }

  quoteIdentifier(name: string): string {
    return quoteIdent(name)
  }

  // ---- execute -------------------------------------------------------------------------------

  private mapError(error: unknown, statement: string, cancelRequested: boolean): DataDriverError {
    if (error instanceof DataDriverError) return error
    const e = error as QueryError & { errno?: number; sqlMessage?: string; sqlState?: string }
    const raw = e?.sqlMessage ?? errorMessage(error)
    const message = this.redact(raw)
    const errno = typeof e?.errno === 'number' ? e.errno : undefined
    return new DataDriverError(cancelRequested ? 'Query cancelled' : message, {
      code: errno !== undefined ? String(errno) : e?.code ? String(e.code) : undefined,
      position: errno === 1064 ? mysqlErrorPosition(statement, raw) : undefined,
      detail: e?.sqlState ? `SQLSTATE ${e.sqlState}` : undefined,
      sandboxRejected: errno === ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION,
      cancelled: cancelRequested
    })
  }

  private async killQuery(threadId: number): Promise<void> {
    if (!threadId) return
    try {
      await this.controlQuery(`KILL QUERY ${Math.trunc(threadId)}`)
    } catch (error) {
      const code = (error as DataDriverError).code
      if (code === String(ER_KILL_DENIED)) {
        // Amazon RDS / Aurora without SUPER.
        await this.controlQuery('CALL mysql.rds_kill_query(?)', [threadId])
        return
      }
      if (code === String(ER_NO_SUCH_THREAD)) return
      throw error
    }
  }

  private async applySessionSettings(options: DriverExecuteOptions): Promise<void> {
    const conn = this.requireSession()
    // A sandbox whose read-only flag could not be switched off: no write may run under it.
    await this.resetReadOnlyFlag()
    if (options.database && options.database !== this.currentDb) {
      await this.query(conn, `USE ${quoteIdent(options.database)}`)
      this.currentDb = options.database
    }
    const wantLimit =
      options.limit !== null && options.limit !== undefined && options.limit > 0
        ? options.limit + 1
        : null
    if (wantLimit !== this.appliedSelectLimit) {
      await this.query(
        conn,
        wantLimit === null
          ? 'SET SESSION sql_select_limit = DEFAULT'
          : `SET SESSION sql_select_limit = ${Math.trunc(wantLimit)}`
      )
      this.appliedSelectLimit = wantLimit
    }
    const wantTimeout =
      options.timeoutMs && options.timeoutMs > 0 ? Math.trunc(options.timeoutMs) : 0
    if (wantTimeout !== this.appliedTimeoutMs) {
      if (this.mariaDb) {
        await this.query(conn, `SET SESSION max_statement_time = ${wantTimeout / 1000}`)
      } else {
        await this.query(conn, `SET SESSION max_execution_time = ${wantTimeout}`)
      }
      this.appliedTimeoutMs = wantTimeout
    }
  }

  async execute(statement: string, options: DriverExecuteOptions): Promise<DriverStatementResult> {
    await this.ensureLive()
    const running: RunningStatement = {
      threadId: this.sessionThreadId,
      cancelRequested: false,
      kills: []
    }
    this.running = running
    try {
      // A LIMIT the user wrote wins over the auto-limit: only the hard cap still applies to the
      // rows kept here, and sql_select_limit goes back to DEFAULT. Left at N+1 it would still
      // cut a result that LIMIT does not bound (a LIMIT inside a parenthesised UNION branch,
      // MariaDB's LIMIT ROWS EXAMINED) at N+1 rows, under the hard cap, so the cut would read as
      // the complete result.
      const limitOptions: DriverExecuteOptions = hasUserLimit(
        statement,
        this.engine === 'mariadb' ? 'mariadb' : 'mysql'
      )
        ? { ...options, limit: 0 }
        : options
      await this.applySessionSettings(limitOptions)
      if (running.cancelRequested) throw new DataDriverError('Query cancelled', { cancelled: true })
      const endSandbox = options.readOnlySandbox && !this.inTx ? await this.openReadSandbox() : null
      const sandboxed = endSandbox !== null
      let outcome: Awaited<ReturnType<MysqlDriver['runStatement']>>
      let warnings: string[] = []
      try {
        outcome = await this.runStatement(statement, limitOptions, running)
        await Promise.allSettled(running.kills)
        // Before the sandbox ROLLBACK (or anything else) clears the diagnostics area.
        if (!running.cancelRequested && !DIAGNOSTIC_STATEMENT.test(statement))
          warnings = await this.collectWarnings(outcome)
      } finally {
        await Promise.allSettled(running.kills)
        if (endSandbox && this.isConnected()) await endSandbox().catch(() => undefined)
      }
      // A SELECT reports the transaction flag only in the EOF packet after its rows (with
      // autocommit=0 it opens a transaction); inside a sandbox the flag is the sandbox's own.
      if (!sandboxed && outcome.eofStatus !== null)
        this.inTx = (outcome.eofStatus & SERVER_STATUS_IN_TRANS) !== 0
      const lockEffect = tableLockEffect(statement)
      if (lockEffect) this.tablesLocked = lockEffect === 'takes'
      // SLEEP() returns 1 instead of failing when KILL QUERY interrupts it. Anything else the
      // server finished before the cancel landed keeps its result: a committed write must not
      // read as cancelled (an interrupted statement already failed with errno 1317).
      if (running.cancelRequested && interruptedSleep(statement, outcome.sets))
        throw new DataDriverError('Query cancelled', { cancelled: true })
      // The user changed a variable we manage: re-apply ours before the next statement.
      if (/\bsql_select_limit\b/i.test(statement)) this.appliedSelectLimit = -1
      if (/\bmax_(execution|statement)_time\b/i.test(statement)) this.appliedTimeoutMs = -1
      // NO_BACKSLASH_ESCAPES may have been switched: literal quoting follows the session.
      if (/\bsql_mode\b/i.test(statement)) await this.readSqlMode()
      return await this.buildResult(statement, limitOptions, outcome, warnings, sandboxed)
    } catch (error) {
      throw this.mapError(error, statement, running.cancelRequested)
    } finally {
      if (this.running === running) this.running = null
    }
  }

  /**
   * Starts the read-only sandbox of one statement and returns what ends it. Normally START
   * TRANSACTION READ ONLY … ROLLBACK. While the user holds table locks a transaction would
   * release them, so the session's read-only flag is switched on for the statement instead (a
   * write still fails with 1792) and restored after it; with autocommit off the read opened a
   * read-only transaction, which is rolled back (ROLLBACK keeps table locks). Null when the
   * server has no such flag: the statement then runs unsandboxed (the classifier still gates).
   */
  private async openReadSandbox(): Promise<(() => Promise<void>) | null> {
    if (!this.tablesLocked) {
      await this.sessionCommand('START TRANSACTION READ ONLY')
      return async () => {
        await this.sessionCommand('ROLLBACK')
      }
    }
    const conn = this.requireSession()
    const names =
      this.readOnlyVariable !== null
        ? [this.readOnlyVariable]
        : ['transaction_read_only', 'tx_read_only']
    for (const name of names) {
      if (!name) return null
      let row: { ro?: unknown; ac?: unknown } | undefined
      try {
        ;[row] = await this.query<{ ro?: unknown; ac?: unknown }>(
          conn,
          `SELECT @@SESSION.${name} AS ro, @@SESSION.autocommit AS ac`
        )
      } catch (error) {
        if ((error as { errno?: number }).errno === ER_UNKNOWN_SYSTEM_VARIABLE) continue
        throw error
      }
      this.readOnlyVariable = name
      const wasReadOnly = Number(row?.ro) === 1
      const autocommit = Number(row?.ac) !== 0
      if (!wasReadOnly) await this.query(conn, `SET SESSION ${name} = 1`)
      if (!wasReadOnly) this.readOnlyToReset = name
      return async () => {
        try {
          if (!autocommit) await this.sessionCommand('ROLLBACK')
        } finally {
          await this.resetReadOnlyFlag()
        }
      }
    }
    this.readOnlyVariable = ''
    return null
  }

  /** Switches the sandbox's read-only flag off again (retried before the next statement). */
  private async resetReadOnlyFlag(): Promise<void> {
    const name = this.readOnlyToReset
    if (!name) return
    await this.query(this.requireSession(), `SET SESSION ${name} = 0`)
    this.readOnlyToReset = null
  }

  private runStatement(
    statement: string,
    options: DriverExecuteOptions,
    running: RunningStatement
  ): Promise<StatementOutcome> {
    const conn = this.requireSession()
    const hardCap = Math.max(1, Math.min(options.hardCap || DATA_HARD_ROW_CAP, DATA_HARD_ROW_CAP))
    const keep = options.limit && options.limit > 0 ? Math.min(options.limit, hardCap) : hardCap
    return new Promise((resolve, reject) => {
      const outcome: StatementOutcome = { sets: [], headers: [], eofWarnings: 0, eofStatus: null }
      let current: ResultSetAcc | null = null
      let drained = 0
      let killedForCap = false
      let settled = false
      const query = conn.query({ sql: statement, rowsAsArray: true, typeCast: false })
      watchEofPackets(
        query,
        (count) => {
          outcome.eofWarnings += count
        },
        (status) => {
          outcome.eofStatus = status
        }
      )
      query.on('fields', (fields?: FieldPacket[]) => {
        if (!fields) return
        current = {
          fields: fields as unknown as ColumnDef[],
          rows: [],
          truncated: false,
          byteLimited: false,
          bytes: 0
        }
        outcome.sets.push(current)
      })
      query.on('result', (row: unknown) => {
        if (!Array.isArray(row)) {
          outcome.headers.push(row as ResultSetHeaderLike)
          return
        }
        const acc = current
        if (!acc) return
        if (acc.truncated || acc.rows.length >= keep) {
          acc.truncated = true
          drained++
          if (drained > DRAIN_BEFORE_KILL && !killedForCap && !running.cancelRequested) {
            killedForCap = true
            running.kills.push(this.killQuery(running.threadId).catch(() => undefined))
          }
          return
        }
        const cells = (row as Array<Buffer | null>).map((v, i) => decodeValue(v, acc.fields[i], 64))
        let size = 0
        for (const c of cells) size += cellSize(c)
        // The row that would cross the budget is left out unless it is the only one.
        if (acc.rows.length > 0 && acc.bytes + size > MAX_RESULT_BYTES) {
          acc.truncated = true
          acc.byteLimited = true
          drained++
          return
        }
        acc.bytes += size
        acc.rows.push(cells)
      })
      query.on('error', (error: QueryError & { errno?: number }) => {
        if (settled) return
        settled = true
        if (killedForCap && error.errno === ER_QUERY_INTERRUPTED && !running.cancelRequested) {
          resolve(outcome)
        } else {
          reject(error)
        }
      })
      query.on('end', () => {
        if (settled) return
        settled = true
        resolve(outcome)
      })
    })
  }

  /**
   * SHOW WARNINGS of the statement that just ran, when it reported any: from its OK packet
   * (statements without rows) or the EOF packets after its rows (a SELECT that truncated or
   * converted values).
   */
  private async collectWarnings(outcome: StatementOutcome): Promise<string[]> {
    const counted = Math.max(
      outcome.eofWarnings,
      ...outcome.headers.map((h) => (typeof h.warningStatus === 'number' ? h.warningStatus : 0))
    )
    if (counted <= 0 || !this.isConnected()) return []
    const warnings = await this.query<{ Level: string; Code: number; Message: string }>(
      this.requireSession(),
      'SHOW WARNINGS LIMIT 50'
    ).catch(() => [])
    return warnings.map((w) => this.redact(`${w.Level} ${w.Code}: ${w.Message}`))
  }

  private async buildResult(
    statement: string,
    options: DriverExecuteOptions,
    outcome: StatementOutcome,
    warnings: string[],
    sandboxed: boolean
  ): Promise<DriverStatementResult> {
    const notices: string[] = [...warnings]
    for (const header of outcome.headers) {
      // Inside a sandbox the flag is the sandbox's own transaction, which has ended since.
      if (typeof header.serverStatus === 'number' && !sandboxed) {
        this.inTx = (header.serverStatus & SERVER_STATUS_IN_TRANS) !== 0
      }
      if (header.stateChanges?.schema) this.currentDb = header.stateChanges.schema
    }
    if (/^\s*use\s/i.test(statement) && !outcome.headers.some((h) => h.stateChanges?.schema)) {
      const [row] = await this.query<{ db: string | null }>(
        this.requireSession(),
        'SELECT DATABASE() AS db'
      )
      this.currentDb = row?.db ?? undefined
    }
    const lastHeader = outcome.headers[outcome.headers.length - 1]

    const hardCap = Math.max(1, Math.min(options.hardCap || DATA_HARD_ROW_CAP, DATA_HARD_ROW_CAP))
    const autoLimit = options.limit && options.limit > 0 ? options.limit : null
    const rowOutputs: DataRowsResult[] = outcome.sets.map((set) => {
      const capByAuto = autoLimit !== null && autoLimit <= hardCap
      if (set.byteLimited) {
        notices.push(
          `Showing the first ${set.rows.length} rows: the full result is too large to display.`
        )
      }
      return {
        kind: 'rows',
        columns: set.fields.map(columnMeta),
        rows: set.rows,
        truncated: set.truncated,
        limit: set.byteLimited
          ? set.rows.length
          : set.truncated
            ? capByAuto
              ? autoLimit
              : hardCap
            : autoLimit,
        autoLimited: set.truncated && !set.byteLimited && capByAuto
      }
    })

    let output: DataStatementOutput
    let moreOutputs: DataStatementOutput[] | undefined
    if (rowOutputs.length > 0) {
      output = rowOutputs[0]
      if (rowOutputs.length > 1) moreOutputs = rowOutputs.slice(1)
    } else {
      const header = lastHeader ?? {}
      const verb = (statement.match(/^\s*([a-z]+)/i)?.[1] ?? 'OK').toUpperCase()
      const affected = header.affectedRows !== undefined ? Number(header.affectedRows) : null
      const insertId =
        header.insertId !== undefined && String(header.insertId) !== '0'
          ? String(header.insertId)
          : null
      output = {
        kind: 'command',
        affectedRows: affected,
        message: header.info
          ? `${verb} · ${header.info.trim()}`
          : affected !== null
            ? `${verb} ${affected}`
            : verb,
        lastInsertId: insertId
      }
    }
    const result: DriverStatementResult = { output }
    if (moreOutputs) result.moreOutputs = moreOutputs
    if (notices.length > 0) result.notices = notices
    return result
  }

  async cancelCurrent(): Promise<void> {
    const running = this.running
    if (!running) return
    running.cancelRequested = true
    const kill = this.killQuery(running.threadId).catch(() => {
      // Cannot KILL (proxy, privileges): drop the session; the manager reconnects and the
      // user loses session state (temp tables, open transaction).
      this.session?.destroy()
      this.sessionDead = true
    })
    running.kills.push(kill)
    await kill
  }

  // ---- introspection -------------------------------------------------------------------------

  private databaseOf(ref?: { database?: string }): string | undefined {
    return (
      ref?.database ||
      this.currentDb ||
      this.input.database ||
      this.input.project.config.database ||
      undefined
    )
  }

  async listDatabases(): Promise<DataDatabaseInfo[]> {
    const system = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])
    let rows: Array<{ name: string; size: string | number | null }>
    try {
      const hint =
        this.mariaDb && !this.hostgroupLocking ? 'SET STATEMENT max_statement_time = 5 FOR ' : ''
      const mysqlHint = this.mariaDb ? '' : '/*+ MAX_EXECUTION_TIME(5000) */ '
      rows = await this.controlQuery(
        `${hint}SELECT ${mysqlHint}s.SCHEMA_NAME AS name, t.size AS size FROM information_schema.SCHEMATA s ` +
          'LEFT JOIN (SELECT TABLE_SCHEMA AS db, SUM(DATA_LENGTH + INDEX_LENGTH) AS size FROM information_schema.TABLES GROUP BY TABLE_SCHEMA) t ' +
          'ON t.db = s.SCHEMA_NAME ORDER BY s.SCHEMA_NAME'
      )
    } catch {
      rows = (
        await this.controlQuery<{ name: string }>(
          'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME'
        )
      ).map((r) => ({ ...r, size: null }))
    }
    return rows.map((r) => ({
      name: String(r.name),
      sizeBytes: r.size === null || r.size === undefined ? null : Number(r.size),
      isSystem: system.has(String(r.name).toLowerCase())
    }))
  }

  async listObjects(database?: string): Promise<DataObjectsListing> {
    const db = this.databaseOf({ database })
    if (!db) return { objects: [] }
    const objects: DataObjectInfo[] = []
    const tables = await this.controlQuery<{
      name: string
      type: string
      engine: string | null
      rows: string | number | null
      size: string | number | null
      comment: string | null
    }>(
      'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS `rows`, ' +
        'DATA_LENGTH + INDEX_LENGTH AS size, TABLE_COMMENT AS comment FROM information_schema.TABLES ' +
        'WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [db]
    )
    for (const t of tables) {
      const kind = tableKind(t.type)
      objects.push({
        name: String(t.name),
        kind,
        rowEstimate: kind === 'table' && t.rows !== null ? Number(t.rows) : null,
        sizeBytes: kind === 'table' && t.size !== null ? Number(t.size) : null,
        engine: t.engine ?? undefined,
        comment: kind === 'view' || !t.comment ? undefined : String(t.comment)
      })
    }
    const routines = await this.controlQuery<{
      name: string
      type: string
      returns: string | null
      comment: string | null
    }>(
      'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, DTD_IDENTIFIER AS `returns`, ROUTINE_COMMENT AS comment ' +
        'FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME',
      [db]
    ).catch(() => [])
    for (const r of routines) {
      objects.push({
        name: String(r.name),
        kind: String(r.type).toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function',
        detail: r.returns ? `returns ${r.returns}` : undefined,
        comment: r.comment || undefined
      })
    }
    const triggers = await this.controlQuery<{
      name: string
      tbl: string
      timing: string
      ev: string
    }>(
      'SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing, EVENT_MANIPULATION AS ev ' +
        'FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME',
      [db]
    ).catch(() => [])
    for (const t of triggers) {
      objects.push({
        name: String(t.name),
        kind: 'trigger',
        detail: String(t.tbl),
        comment: `${t.timing} ${t.ev}`
      })
    }
    const events = await this.controlQuery<{ name: string; status: string }>(
      'SELECT EVENT_NAME AS name, STATUS AS status FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME',
      [db]
    ).catch(() => [])
    for (const e of events)
      objects.push({ name: String(e.name), kind: 'event', detail: String(e.status) })
    return { objects }
  }

  async describe(ref: DataObjectRef): Promise<DataTableDetails> {
    const db = this.databaseOf(ref)
    if (!db) throw new DataDriverError('No database selected.', { code: 'NO_DATABASE' })
    if (
      ref.kind === 'function' ||
      ref.kind === 'procedure' ||
      ref.kind === 'trigger' ||
      ref.kind === 'event'
    ) {
      return this.describeRoutine(db, ref)
    }
    const [table] = await this.controlQuery<{
      type: string
      engine: string | null
      rows: string | number | null
      size: string | number | null
      comment: string | null
      collation: string | null
      auto_increment: string | number | null
      created: string | null
      row_format: string | null
    }>(
      'SELECT TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS `rows`, DATA_LENGTH + INDEX_LENGTH AS size, ' +
        'TABLE_COMMENT AS comment, TABLE_COLLATION AS collation, AUTO_INCREMENT AS auto_increment, ' +
        'CREATE_TIME AS created, ROW_FORMAT AS row_format FROM information_schema.TABLES ' +
        'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [db, ref.name]
    )
    if (!table)
      throw new DataDriverError(`Table ${db}.${ref.name} not found.`, { code: 'NOT_FOUND' })
    const kind = tableKind(table.type)

    const columnsRows = await this.controlQuery<{
      name: string
      pos: number
      type: string
      nullable: string
      def: string | null
      ckey: string
      extra: string
      gen: string | null
      comment: string
      charset: string | null
      collation: string | null
    }>(
      'SELECT COLUMN_NAME AS name, ORDINAL_POSITION AS pos, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, ' +
        'COLUMN_DEFAULT AS def, COLUMN_KEY AS ckey, EXTRA AS extra, GENERATION_EXPRESSION AS gen, ' +
        'COLUMN_COMMENT AS comment, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation ' +
        'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [db, ref.name]
    )
    const statRows = await this.controlQuery<Row>(
      'SELECT * FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
      [db, ref.name]
    )
    const indexes = new Map<string, DataIndexInfo>()
    for (const s of statRows) {
      const name = String(pick(s, 'INDEX_NAME'))
      const column = pick(s, 'COLUMN_NAME')
      const expression = pick(s, 'EXPRESSION')
      const subPart = pick(s, 'SUB_PART')
      const label = column
        ? `${column}${subPart ? `(${subPart})` : ''}`
        : expression
          ? `(${expression})`
          : '?'
      const existing = indexes.get(name)
      if (existing) existing.columns.push(label)
      else
        indexes.set(name, {
          name,
          columns: [label],
          unique: Number(pick(s, 'NON_UNIQUE')) === 0,
          primary: name === 'PRIMARY',
          type: String(pick(s, 'INDEX_TYPE') ?? '') || undefined
        })
    }
    const primaryKey = (indexes.get('PRIMARY')?.columns ?? []).map((c) => c.replace(/\(\d+\)$/, ''))
    const pkSet = new Set(primaryKey)
    const columns: DataColumnInfo[] = columnsRows.map((c) => {
      const extra = [String(c.extra ?? ''), c.gen ? `AS (${c.gen})` : '']
        .filter(Boolean)
        .join(' ')
        .trim()
      return {
        name: String(c.name),
        type: String(c.type),
        nullable: String(c.nullable).toUpperCase() === 'YES',
        defaultValue: c.def === null || c.def === undefined ? null : String(c.def),
        isPrimaryKey: pkSet.has(String(c.name)),
        ordinal: Number(c.pos),
        autoIncrement: /auto_increment/i.test(String(c.extra ?? '')),
        comment: c.comment ? String(c.comment) : undefined,
        extra: extra || undefined
      }
    })

    const fkRows = await this.controlQuery<{
      name: string
      col: string
      rdb: string
      rtable: string
      rcol: string
      upd: string
      del: string
    }>(
      'SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS rdb, ' +
        'k.REFERENCED_TABLE_NAME AS rtable, k.REFERENCED_COLUMN_NAME AS rcol, r.UPDATE_RULE AS upd, r.DELETE_RULE AS del ' +
        'FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ' +
        'ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME ' +
        'WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ' +
        'ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION',
      [db, ref.name]
    ).catch(() => [])
    const fks = new Map<string, DataForeignKeyInfo>()
    for (const f of fkRows) {
      const existing = fks.get(f.name)
      if (existing) {
        existing.columns.push(f.col)
        existing.refColumns.push(f.rcol)
      } else {
        fks.set(f.name, {
          name: f.name,
          columns: [f.col],
          refDatabase: f.rdb,
          refTable: f.rtable,
          refColumns: [f.rcol],
          onUpdate: f.upd,
          onDelete: f.del
        })
      }
    }
    const triggerRows = await this.controlQuery<{
      name: string
      timing: string
      ev: string
      body: string
    }>(
      'SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS ev, ACTION_STATEMENT AS body ' +
        'FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME',
      [db, ref.name]
    ).catch(() => [])

    const properties: Array<{ label: string; value: string }> = []
    if (table.collation) properties.push({ label: 'Collation', value: String(table.collation) })
    if (table.auto_increment !== null && table.auto_increment !== undefined)
      properties.push({ label: 'Next AUTO_INCREMENT', value: String(table.auto_increment) })
    if (table.row_format) properties.push({ label: 'Row format', value: String(table.row_format) })
    if (table.created) properties.push({ label: 'Created', value: String(table.created) })

    return {
      ref: { database: db, name: ref.name, kind },
      kind,
      columns,
      indexes: [...indexes.values()],
      foreignKeys: [...fks.values()],
      triggers: triggerRows.map((t) => ({
        name: t.name,
        definition: `${t.timing} ${t.ev} FOR EACH ROW ${t.body}`
      })),
      primaryKey,
      rowEstimate: kind === 'table' && table.rows !== null ? Number(table.rows) : null,
      sizeBytes: kind === 'table' && table.size !== null ? Number(table.size) : null,
      engine: table.engine ?? undefined,
      comment: kind === 'view' || !table.comment ? undefined : String(table.comment),
      properties
    }
  }

  private async describeRoutine(db: string, ref: DataObjectRef): Promise<DataTableDetails> {
    const kind = ref.kind as DataObjectKind
    const columns: DataColumnInfo[] = []
    if (kind === 'function' || kind === 'procedure') {
      const params = await this.controlQuery<{
        name: string | null
        mode: string | null
        type: string
        pos: number
      }>(
        'SELECT PARAMETER_NAME AS name, PARAMETER_MODE AS mode, DTD_IDENTIFIER AS type, ORDINAL_POSITION AS pos ' +
          'FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? ORDER BY ORDINAL_POSITION',
        [db, ref.name]
      ).catch(() => [])
      for (const p of params) {
        columns.push({
          name: p.name ?? '(returns)',
          type: String(p.type),
          nullable: true,
          isPrimaryKey: false,
          ordinal: Number(p.pos),
          extra: p.mode ?? 'RETURNS'
        })
      }
    }
    return {
      ref: { database: db, name: ref.name, kind },
      kind,
      columns,
      indexes: [],
      foreignKeys: [],
      triggers: [],
      primaryKey: []
    }
  }

  async ddl(ref: DataObjectRef): Promise<string> {
    const db = this.databaseOf(ref)
    if (!db) throw new DataDriverError('No database selected.', { code: 'NO_DATABASE' })
    let kind = ref.kind
    if (!kind || kind === 'table' || kind === 'view' || kind === 'sequence') {
      const [row] = await this.controlQuery<{ type: string }>(
        'SELECT TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [db, ref.name]
      )
      if (row) kind = tableKind(row.type)
      else if (!kind) {
        const [routine] = await this.controlQuery<{ type: string }>(
          'SELECT ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?',
          [db, ref.name]
        )
        kind = routine
          ? String(routine.type).toUpperCase() === 'PROCEDURE'
            ? 'procedure'
            : 'function'
          : 'table'
      }
    }
    const qualified = `${quoteIdent(db)}.${quoteIdent(ref.name)}`
    const show = async (what: string, column: string): Promise<string> => {
      const rows = await this.controlQuery<Row>(`SHOW CREATE ${what} ${qualified}`)
      const value = rows[0] ? pick(rows[0], column) : null
      if (value === null || value === undefined) {
        throw new DataDriverError(
          `No definition available for ${ref.name} (missing privileges?).`,
          { code: 'NO_DDL' }
        )
      }
      return String(value)
    }
    const withDelimiter = (body: string): string =>
      body.includes(';') ? `DELIMITER ;;\n${body};;\nDELIMITER ;\n` : `${body};\n`
    switch (kind) {
      case 'view':
        return `${await show('VIEW', 'Create View')};\n`
      case 'sequence':
        return `${await show('SEQUENCE', 'Create Table')};\n`
      case 'procedure':
        return withDelimiter(await show('PROCEDURE', 'Create Procedure'))
      case 'function':
        return withDelimiter(await show('FUNCTION', 'Create Function'))
      case 'trigger':
        return withDelimiter(await show('TRIGGER', 'SQL Original Statement'))
      case 'event':
        return withDelimiter(await show('EVENT', 'Create Event'))
      default:
        return `${await show('TABLE', 'Create Table')};\n`
    }
  }

  async completionSchema(database?: string): Promise<DataCompletionSchema> {
    const db = this.databaseOf({ database })
    const databases = (
      await this.controlQuery<{ name: string }>(
        'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME'
      )
    ).map((r) => String(r.name))
    if (!db) return { databases, tables: [] }
    const tableRows = await this.controlQuery<{ name: string; type: string }>(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT ${COMPLETION_TABLE_CAP + 1}`,
      [db]
    )
    let truncated = tableRows.length > COMPLETION_TABLE_CAP
    const tables = new Map<string, DataCompletionTable>()
    for (const t of tableRows.slice(0, COMPLETION_TABLE_CAP)) {
      tables.set(String(t.name), { name: String(t.name), kind: tableKind(t.type), columns: [] })
    }
    const columnRows = await this.controlQuery<{ tbl: string; name: string; type: string }>(
      `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT ${COMPLETION_COLUMN_CAP + 1}`,
      [db]
    )
    if (columnRows.length > COMPLETION_COLUMN_CAP) truncated = true
    for (const c of columnRows.slice(0, COMPLETION_COLUMN_CAP)) {
      tables.get(String(c.tbl))?.columns.push({ name: String(c.name), type: String(c.type) })
    }
    const functions = (
      await this.controlQuery<{ name: string }>(
        "SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'FUNCTION' ORDER BY ROUTINE_NAME",
        [db]
      ).catch(() => [])
    ).map((r) => String(r.name))
    const schema: DataCompletionSchema = {
      database: db,
      databases,
      tables: [...tables.values()],
      functions
    }
    if (truncated) schema.truncated = true
    return schema
  }

  async listProcesses(): Promise<DataProcessInfo[]> {
    const rows = await this.controlQuery<Row>('SHOW FULL PROCESSLIST')
    const own = new Set<number>([this.sessionThreadId, this.controlThreadId])
    for (const c of this.streamConnections) if (c.threadId) own.add(c.threadId)
    const list = rows.map((r): DataProcessInfo => {
      const id = Number(pick(r, 'Id'))
      const time = pick(r, 'Time')
      const timeMs = pick(r, 'Time_ms')
      const progress = pick(r, 'Progress')
      const info: DataProcessInfo = {
        id: String(id),
        user: nullableString(pick(r, 'User')),
        host: nullableString(pick(r, 'Host')),
        database: nullableString(pick(r, 'db')),
        command: nullableString(pick(r, 'Command')),
        state: nullableString(pick(r, 'State')),
        durationMs:
          timeMs !== undefined && timeMs !== null
            ? Number(timeMs)
            : time !== null && time !== undefined
              ? Number(time) * 1000
              : null,
        query: nullableString(pick(r, 'Info')),
        isOwn: own.has(id)
      }
      if (progress !== undefined && progress !== null && Number(progress) > 0)
        info.extra = { progress: Number(progress) }
      return info
    })
    // Active statements first, longest running first; idle connections after.
    return list.sort((a, b) => {
      const aIdle = a.command === 'Sleep' ? 1 : 0
      const bIdle = b.command === 'Sleep' ? 1 : 0
      if (aIdle !== bIdle) return aIdle - bIdle
      return (b.durationMs ?? 0) - (a.durationMs ?? 0)
    })
  }

  async killProcess(processId: string, scope: DataKillScope): Promise<void> {
    if (!/^\d+$/.test(processId))
      throw new DataDriverError('Invalid process id.', { code: 'INVALID_INPUT' })
    const id = Number(processId)
    try {
      await this.controlQuery(scope === 'query' ? `KILL QUERY ${id}` : `KILL CONNECTION ${id}`)
    } catch (error) {
      if ((error as DataDriverError).code === String(ER_KILL_DENIED)) {
        await this.controlQuery(
          scope === 'query' ? 'CALL mysql.rds_kill_query(?)' : 'CALL mysql.rds_kill(?)',
          [id]
        )
        return
      }
      throw error
    }
    if (scope === 'connection' && id === this.sessionThreadId) this.sessionDead = true
    if (scope === 'connection' && id === this.controlThreadId) this.control = null
  }

  // ---- export streaming ----------------------------------------------------------------------

  /**
   * `onBatch` also gets each column's type name (typeName: 'BIT', 'BIGINT UNSIGNED'…): an SQL
   * export writes a BIT value wider than 53 bits, which arrives as exact decimal text, unquoted.
   */
  async streamRows(
    statement: string,
    options: { database?: string; schema?: string; readOnlySandbox: boolean; signal: AbortSignal },
    onBatch: (columns: string[], rows: unknown[][], columnTypes?: string[]) => Promise<void>
  ): Promise<{ rows: number }> {
    if (options.signal.aborted) throw new DataDriverError('Export cancelled', { cancelled: true })
    if (!this.serverVersion) await this.connect()
    let lostError: unknown = null
    const conn = await this.openConnection(options.database ?? this.databaseOf(), (error) => {
      lostError = error
    })
    this.streamConnections.add(conn)
    const onAbort = (): void => conn.destroy()
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (options.database) await this.query(conn, `USE ${quoteIdent(options.database)}`)
      // Read the statement like the session would: its sql_mode (ANSI_QUOTES,
      // NO_BACKSLASH_ESCAPES…) decides how the text parses, the project time zone how
      // TIMESTAMP values read (exports must match the grid).
      if (this.sessionSqlMode !== null) {
        await this.query(conn, `SET SESSION sql_mode = '${this.sessionSqlMode}'`).catch(
          () => undefined
        )
      }
      await this.applyTimeZone(conn, !noBackslashEscapes(this.sessionSqlMode))
      if (options.readOnlySandbox) await this.query(conn, 'START TRANSACTION READ ONLY')
      const total = await new Promise<number>((resolve, reject) => {
        let fields: ColumnDef[] | null = null
        let names: string[] = []
        let types: string[] = []
        let batch: unknown[][] = []
        let count = 0
        let flushing: Promise<void> = Promise.resolve()
        let failed = false
        let firstSetDone = false
        const fail = (error: unknown): void => {
          if (failed) return
          failed = true
          conn.destroy()
          reject(error)
        }
        const flush = (): void => {
          if (batch.length === 0) return
          const rows = batch
          batch = []
          conn.pause()
          flushing = flushing
            .then(() => onBatch(names, rows, types))
            .then(
              () => {
                if (!failed) conn.resume()
              },
              (error) => fail(error)
            )
        }
        const query = conn.query({ sql: statement, rowsAsArray: true, typeCast: false })
        query.on('fields', (f?: FieldPacket[]) => {
          if (!f || fields) {
            if (f && fields) firstSetDone = true
            return
          }
          fields = f as unknown as ColumnDef[]
          names = fields.map((c) => c.name)
          types = fields.map(typeName)
        })
        query.on('result', (row: unknown) => {
          if (failed || firstSetDone || !Array.isArray(row) || !fields) return
          const defs = fields
          batch.push((row as Array<Buffer | null>).map((v, i) => decodeValue(v, defs[i], Infinity)))
          count++
          if (batch.length >= STREAM_BATCH_ROWS) flush()
        })
        query.on('error', (error) => fail(error))
        query.on('end', () => {
          if (failed) return
          // A statement without a result set still has columns: none.
          if (!fields) {
            flushing.then(() => resolve(count), fail)
            return
          }
          flush()
          // Zero rows: still hand over the column names (the export writes its header).
          if (count === 0) flushing = flushing.then(() => onBatch(names, [], types))
          flushing.then(() => resolve(count), fail)
        })
      })
      return { rows: total }
    } catch (error) {
      if (options.signal.aborted) throw new DataDriverError('Export cancelled', { cancelled: true })
      throw this.mapError(error ?? lostError, statement, false)
    } finally {
      options.signal.removeEventListener('abort', onAbort)
      this.streamConnections.delete(conn)
      if (!options.signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            conn.destroy()
            resolve()
          }, 2_000)
          conn.end(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      } else conn.destroy()
    }
  }
}

function tableKind(type: string | null | undefined): DataObjectKind {
  switch (String(type ?? '').toUpperCase()) {
    case 'VIEW':
    case 'SYSTEM VIEW':
      return 'view'
    case 'SEQUENCE':
      return 'sequence'
    default:
      return 'table'
  }
}

/** Case-insensitive column pick (I_S column names are upper case on MySQL 8, mixed on MariaDB). */
function pick(row: Row, key: string): unknown {
  if (key in row) return row[key]
  const lower = key.toLowerCase()
  for (const k of Object.keys(row)) if (k.toLowerCase() === lower) return row[k]
  return undefined
}

const nullableString = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : Buffer.isBuffer(value)
      ? value.toString('utf8')
      : String(value)

export function createMysqlDriver(input: DriverConnectInput): DataDriver {
  return new MysqlDriver(input)
}

/** Exposed for unit tests. */
export const __mysqlInternals = { decodeValue, typeName, tableKind, toCell, tableLockEffect }
