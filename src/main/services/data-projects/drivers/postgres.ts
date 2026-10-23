// PostgreSQL through node-postgres (pg) + pg-cursor. One driver instance per (project, database)
// because PG has no USE: the engine opens one per database it is asked about.
//
// Connections: a sticky SESSION client for the editor (raw text values: every type parser is the
// identity, so int8/numeric/json/arrays/timestamps arrive exactly as psql prints them), a lazy
// CONTROL client (default parsers) for catalog introspection, pg_cancel_backend, the process
// list and type-name lookups, and one throwaway client per export stream (with the session's
// datestyle / bytea_output / TimeZone prologue, so exported cells match the grid).
//
// The control client runs with lock_timeout and statement_timeout, and sizes skip relations
// someone holds an ACCESS EXCLUSIVE lock on (the user's own open ALTER TABLE / LOCK TABLE
// included): catalog reads are serialised there, so one read stuck behind a lock would stall the
// tree, describe, and the column metadata of every result. Column metadata is best-effort anyway:
// a finished statement waits for it only briefly and then returns names only.
//
// User SQL always goes through pg-cursor, i.e. the extended protocol: the server refuses a string
// with more than one command ("cannot insert multiple commands into a prepared statement"), so a
// splitter mistake can never smuggle a second statement. Rows are read in batches sized by what
// the rows so far weigh, then the portal is closed: the server stops producing rows at the
// auto-limit, the hard cap or the result byte budget without everything being buffered first;
// the shared `applyAutoLimit` rewrite additionally gives the planner a LIMIT for simple SELECTs
// (reported as `executedText`).
//
// search_path: a schema picked in the explorer / tab is applied when the pick changes (or the
// session lost it: reconnect, DISCARD ALL, a rolled-back transaction that carried it). A
// `SET search_path` the user runs wins from then on, also for later statements and requests that
// still name the old pick, like in psql.
//
// Read-only sandbox: BEGIN READ ONLY … ROLLBACK around auto-run reads when the session is idle
// (status 'I'); SQLSTATE 25006 → sandboxRejected. Inside a user transaction the classifier alone
// guards. SSL follows libpq semantics (prefer/require do not verify, verify-ca checks the chain,
// verify-full also the host name), not pg-connection-string's "require means verify-full".

import { readFile } from 'node:fs/promises'
import type { Client, ClientConfig, FieldDef, QueryResult } from 'pg'
import type CursorType from 'pg-cursor'
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls'
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
  type DataTableDetails
} from '../../../../shared/data-projects/types'
import { applyAutoLimit, hasUserLimit } from '../../../../shared/sql'
import { traceDriverStatement, type StatementCounts } from '../console-log'
import {
  DataDriverError,
  type DataDriver,
  type DriverConnectInput,
  type DriverExecuteOptions,
  type DriverStatementResult
} from '../contracts'
import { binaryCell, cellSize } from '../cells'
import { errorMessage } from '../redact'
import { expandHomePath } from '../ssh-tunnel'

type PgModule = typeof import('pg')
type CursorCtor = typeof CursorType

let pgPromise: Promise<{ pg: PgModule; Cursor: CursorCtor }> | null = null
const loadPg = (): Promise<{ pg: PgModule; Cursor: CursorCtor }> => {
  pgPromise ??= Promise.all([import('pg'), import('pg-cursor')]).then(([pgMod, cursorMod]) => {
    const p = pgMod as PgModule & { default?: PgModule }
    const pg = (typeof p.Client === 'function' ? p : p.default) as PgModule
    const c = cursorMod as unknown
    const Cursor = (
      typeof c === 'function' ? c : (c as { default?: unknown }).default
    ) as CursorCtor
    return { pg, Cursor }
  })
  return pgPromise
}

/** Every type parser is the identity: cells keep the server's exact text. */
const RAW_TYPES = { getTypeParser: () => (value: string) => value }

const MAX_RESULT_BYTES = 96 * 1024 * 1024
/** First cursor read; later reads are sized by the bytes per row seen so far. */
const FIRST_BATCH_ROWS = 100
const MAX_BATCH_ROWS = 10_000
const STREAM_BATCH_ROWS = 1_000
/** Rough bytes of decoded cells per export batch handed to the writer. */
const STREAM_BATCH_BYTES = 8 * 1024 * 1024
/** Control-client limits: a catalog read gives up instead of queueing behind a lock. */
const CONTROL_LOCK_TIMEOUT = '2s'
const CONTROL_STATEMENT_TIMEOUT = '30s'
/** How long a finished statement waits for column metadata (types, source tables). */
const META_WAIT_MS = 1_500
/** …when other catalog reads are already queued on the control client. */
const META_WAIT_BUSY_MS = 400
const LOCK_NOT_AVAILABLE = '55P03'
const QUERY_CANCELED = '57014'
const COMPLETION_TABLE_CAP = 5_000
const COMPLETION_COLUMN_CAP = 200_000

const OID = {
  bool: 16,
  bytea: 17,
  int8: 20,
  int2: 21,
  int4: 23,
  oid: 26,
  float4: 700,
  float8: 701
} as const

const SYSTEM_DATABASES = new Set([
  'rdsadmin',
  'azure_maintenance',
  'azure_sys',
  'cloudsqladmin',
  'template0',
  'template1'
])

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

/** One raw PG text value → DataCell, using the column's type OID. */
function decodePgValue(raw: unknown, typeId: number, binaryPreviewBytes: number): DataCell {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') {
    if (Buffer.isBuffer(raw)) return binaryCell(raw, binaryPreviewBytes)
    return String(raw)
  }
  switch (typeId) {
    case OID.bool:
      return raw === 't' ? true : raw === 'f' ? false : raw
    case OID.int2:
    case OID.int4:
    case OID.oid: {
      const n = Number(raw)
      return Number.isSafeInteger(n) ? n : raw
    }
    case OID.float4:
    case OID.float8: {
      const n = Number(raw)
      return Number.isFinite(n) && String(n) === raw ? n : raw
    }
    case OID.bytea:
      if (raw.startsWith('\\x'))
        return binaryCell(Buffer.from(raw.slice(2), 'hex'), binaryPreviewBytes)
      return raw
    default:
      return raw
  }
}

/** Strips leading comments/whitespace (for keyword sniffing only). */
const leadingKeywordText = (sql: string): string => {
  let s = sql
  for (;;) {
    const before = s
    s = s.replace(/^\s+/, '')
    if (s.startsWith('--')) s = s.replace(/^[^\n]*\n?/, '')
    else if (s.startsWith('/*')) {
      let depth = 0
      let i = 0
      for (; i < s.length; i++) {
        if (s.startsWith('/*', i)) {
          depth++
          i++
        } else if (s.startsWith('*/', i)) {
          depth--
          i++
          if (depth === 0) break
        }
      }
      s = s.slice(i + 1)
    }
    if (s === before) return s
  }
}

const isClientCopy = (sql: string): boolean => {
  const body = leadingKeywordText(sql)
  return /^copy\b/i.test(body) && /\b(stdin|stdout)\b/i.test(body)
}

/** The statement sets the search_path itself (SET / RESET / set_config). */
const setsSearchPath = (sql: string): boolean =>
  /\b(set|reset)\s+(session\s+|local\s+)?search_path\b|\bset_config\s*\(\s*'search_path'/i.test(sql)

/**
 * Relations (and indexes) someone holds or waits for an ACCESS EXCLUSIVE lock on, in this
 * database. pg_total_relation_size / pg_get_indexdef / pg_get_expr(…, relid) / pg_get_viewdef
 * take an ACCESS SHARE lock and would queue behind it (an open ALTER TABLE, LOCK TABLE, TRUNCATE
 * or DROP INDEX, the user's own session included). A CTE: pg_locks is read once per query.
 */
const LOCKED_RELATIONS_CTE =
  "locked AS (SELECT l.relation FROM pg_locks l WHERE l.locktype = 'relation' " +
  "AND l.mode = 'AccessExclusiveLock' AND l.relation IS NOT NULL " +
  'AND l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()))'

/** True for `c` (a pg_class row) when it or one of its indexes is in `locked`. */
const IS_LOCKED_EXPR =
  '(c.oid IN (SELECT relation FROM locked) OR EXISTS (SELECT 1 FROM pg_index x ' +
  'WHERE x.indrelid = c.oid AND x.indexrelid IN (SELECT relation FROM locked)))'

/** Total size of `c` unless that would wait for a lock (NULL then). */
const LOCK_SAFE_SIZE_EXPR = `CASE WHEN c.relkind IN ('r','p','m') AND NOT ${IS_LOCKED_EXPR} THEN pg_total_relation_size(c.oid) END`

/** A control-client read gave up on a lock (lock_timeout) or ran out of time (statement_timeout). */
const isLockOrTimeout = (error: unknown): boolean =>
  error instanceof DataDriverError &&
  (error.code === LOCK_NOT_AVAILABLE || error.code === QUERY_CANCELED)

const closedError = (): DataDriverError =>
  new DataDriverError('The connection was closed.', { code: 'CONNECTION_LOST' })

/** Fatal = the socket/connection is gone (the session must be reopened). */
const isConnectionError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const code = String((error as { code?: unknown }).code ?? '')
  const message = String((error as { message?: unknown }).message ?? '')
  return (
    [
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
      'ECONNREFUSED',
      '57P01',
      '57P02',
      '57P03',
      '08000',
      '08003',
      '08006'
    ].includes(code) ||
    /Connection terminated|Client has encountered a connection error|not queryable|connection is closed/i.test(
      message
    )
  )
}

interface PgDatabaseError extends Error {
  code?: string
  position?: string
  hint?: string
  detail?: string
  where?: string
  severity?: string
}

interface RunningStatement {
  cancelRequested: boolean
  /** Ends the wait for column metadata at once (set while that wait runs). */
  wake: (() => void) | null
  /** cancelCurrent's request to the server, settled once it was sent. */
  cancelling: Promise<void> | null
}

interface CursorOutcome {
  fields: FieldDef[]
  rows: DataCell[][]
  truncated: boolean
  /** Cut by the result byte budget (not by a row limit). */
  byteLimited: boolean
  command: string | null
  rowCount: number | null
}

const FK_ACTIONS: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT'
}

const relkindToKind = (relkind: string): DataObjectKind => {
  switch (relkind) {
    case 'v':
      return 'view'
    case 'm':
      return 'materialized_view'
    case 'f':
      return 'foreign_table'
    case 'S':
      return 'sequence'
    default:
      return 'table'
  }
}

type Row = Record<string, unknown>

class PostgresDriver implements DataDriver {
  readonly engine = 'postgres' as const
  private readonly input: DriverConnectInput
  private readonly database: string
  private session: Client | null = null
  private sessionDead = true
  private sessionPid = 0
  private control: Client | null = null
  private controlPromise: Promise<Client> | null = null
  private controlPid = 0
  private controlTail: Promise<unknown> = Promise.resolve()
  private controlPending = 0
  private readonly streamClients = new Set<Client>()
  private readonly streamPids = new Set<number>()
  private serverVersion = ''
  private versionNum = 0
  /** Bumped by close(): a connection that finishes opening afterwards is ended at once. */
  private epoch = 0
  /** close() ran (and connect() did not since): no control connection is opened any more. */
  private closed = false
  /** The schema last picked by the caller and set as search_path (see the file header). */
  private requestedSchema: string | null = null
  /** The session lost that search_path (DISCARD ALL, a rollback): set it again. */
  private schemaStale = false
  /** Our search_path SET ran inside a still-open user transaction (a ROLLBACK may undo it). */
  private schemaInTx = false
  private appliedTimeoutMs = 0
  /** Our statement_timeout SET ran inside a still-open user transaction. */
  private timeoutInTx = false
  private running: RunningStatement | null = null
  private notices: string[] | null = null
  private readonly typeNames = new Map<number, string>()
  private typeNamesLoadedAt = 0
  private typeNamesLoading: Promise<void> | null = null
  private readonly relNames = new Map<number, { name: string; schema: string }>()
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
    this.database = input.database || input.project.config.database || 'postgres'
  }

  private redact(text: string): string {
    return this.input.redact(text)
  }

  // ---- connection plumbing -------------------------------------------------------------------

  private async ssl(): Promise<false | TlsConnectionOptions> {
    const ssl = this.input.project.config.ssl
    if (!ssl || ssl.mode === 'disable') return false
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
    const ca = await read(ssl.caPath, 'CA')
    const cert = await read(ssl.certPath, 'certificate')
    const key = await read(ssl.keyPath, 'key')
    const base: TlsConnectionOptions = {}
    if (cert) base.cert = cert
    if (key) base.key = key
    const servername = this.input.tunnel?.remoteHost ?? this.input.project.config.host
    switch (ssl.mode) {
      case 'verify-full':
        return { ...base, ca, rejectUnauthorized: true, ...(servername ? { servername } : {}) }
      case 'verify-ca':
        return { ...base, ca, rejectUnauthorized: true, checkServerIdentity: () => undefined }
      default:
        // prefer / require (libpq): with a root cert given, require behaves like verify-ca.
        return ca
          ? { ...base, ca, rejectUnauthorized: true, checkServerIdentity: () => undefined }
          : { ...base, rejectUnauthorized: false }
    }
  }

  private async clientConfig(
    ssl: false | TlsConnectionOptions,
    raw: boolean
  ): Promise<ClientConfig> {
    const config = this.input.project.config
    const options = config.options ?? {}
    const cfg: ClientConfig = {
      host: config.host || '127.0.0.1',
      port: config.port || 5432,
      user: config.user || undefined,
      password: this.input.secrets.password ?? '',
      database: this.database,
      ssl,
      application_name: 'Hive',
      keepAlive: true,
      connectionTimeoutMillis: 10_000
    }
    if (raw) cfg.types = RAW_TYPES
    if (options.sslnegotiation === 'direct' && ssl) {
      ;(cfg as ClientConfig & { sslNegotiation?: string }).sslNegotiation = 'direct'
    }
    return cfg
  }

  private async openClient(raw: boolean, onLost: (error: unknown) => void): Promise<Client> {
    const { pg } = await loadPg()
    const mode = this.input.project.config.ssl?.mode ?? 'disable'
    const attempt = async (ssl: false | TlsConnectionOptions): Promise<Client> => {
      const client = new pg.Client(await this.clientConfig(ssl, raw))
      // An idle client whose socket dies emits 'error'; without a listener that is a crash. While
      // connecting, failures arrive through connect()'s rejection; `onLost` only after success.
      let connected = false
      client.on('error', (error) => {
        if (connected) onLost(error)
      })
      client.on('end', () => {
        if (connected) onLost(null)
      })
      try {
        await client.connect()
      } catch (error) {
        client.end().catch(() => undefined)
        throw error
      }
      connected = true
      return client
    }
    const ssl = await this.ssl()
    try {
      return await attempt(ssl)
    } catch (error) {
      if (mode === 'prefer' && ssl && /does not support SSL/i.test(errorMessage(error)))
        return attempt(false)
      throw this.mapConnectError(error)
    }
  }

  private mapConnectError(error: unknown): DataDriverError {
    if (error instanceof DataDriverError) return error
    const e = error as PgDatabaseError
    let message = errorMessage(error, (t) => this.redact(t))
    if (
      /self[- ]signed certificate|unable to verify|certificate/i.test(message) &&
      this.input.project.config.ssl?.mode !== 'verify-full'
    ) {
      message +=
        ' — set SSL mode to "require" to encrypt without verifying, or add the server CA certificate.'
    }
    return new DataDriverError(message, {
      code: e?.code ? String(e.code) : undefined,
      detail: e?.detail ? this.redact(e.detail) : undefined
    })
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
    this.closed = false
    const epoch = this.epoch
    let opened: Client | null = null
    const client = await this.openClient(true, () => {
      if (opened && this.session === opened) this.sessionDead = true
    })
    if (epoch !== this.epoch) {
      // close() ran while this connection was opening (connect timeout, disconnect).
      await client.end().catch(() => undefined)
      throw closedError()
    }
    opened = client
    client.on('notice', (notice: { severity?: string; message?: string }) => {
      if (this.notices && this.notices.length < 200) {
        this.notices.push(this.redact(`${notice.severity ?? 'NOTICE'}: ${notice.message ?? ''}`))
      }
    })
    this.session = client
    this.sessionDead = false
    this.sessionPid = (client as Client & { processID?: number }).processID ?? 0
    this.requestedSchema = null
    this.schemaStale = false
    this.schemaInTx = false
    this.appliedTimeoutMs = 0
    this.timeoutInTx = false
    try {
      await this.applyPrologue(client)
      const info = await this.housekeeping(
        client,
        "SELECT current_setting('server_version') AS v, current_setting('server_version_num') AS n, current_database() AS db, " +
          "pg_is_in_recovery() AS rec, current_setting('default_transaction_read_only') AS ro"
      )
      const row = info.rows[0] as Record<string, string>
      this.serverVersion = `PostgreSQL ${row.v}`
      this.versionNum = Number(row.n) || 0
      this.everConnected = true
      this.lastConnectInfo = {
        serverVersion: this.serverVersion,
        currentDatabase: row.db,
        readOnlyUser: row.rec === 't' || row.ro === 'on'
      }
      return this.lastConnectInfo
    } catch (error) {
      this.session = null
      this.sessionDead = true
      await client.end().catch(() => undefined)
      throw this.mapConnectError(error)
    }
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

  private requireSession(): Client {
    if (!this.session || this.sessionDead) {
      throw new DataDriverError('The connection to the server was lost.', {
        code: 'CONNECTION_LOST'
      })
    }
    return this.session
  }

  private txStatus(): string {
    const s = this.session as (Client & { getTransactionStatus?: () => string | null }) | null
    return s?.getTransactionStatus?.() ?? 'I'
  }

  /**
   * Settings of every connection that reads user data (session and export streams): cells are
   * decoded with them, and exports must show the same text as the grid. Trusted prologue: simple
   * protocol, several statements in one round trip.
   */
  private async applyPrologue(client: Client): Promise<void> {
    await this.housekeeping(client, "SET datestyle = 'ISO, MDY'; SET bytea_output = 'hex'")
    const tz = this.input.project.config.timezone
    if (tz) {
      await this.housekeeping(client, "SELECT set_config('TimeZone', $1, false)", [tz]).catch(
        () => undefined
      )
    }
  }

  /**
   * A statement the driver runs for itself on `client` — session settings, the connect probe,
   * the read-only sandbox's BEGIN / SAVEPOINT / ROLLBACK, an export's transaction — traced so
   * the console's metadata view shows it (with its bind values), like MySQL's.
   */
  private housekeeping(client: Client, sql: string, values?: unknown[]): Promise<QueryResult> {
    return traceDriverStatement(
      sql,
      () => (values ? client.query(sql, values) : client.query(sql)),
      pgCounts,
      values
    )
  }

  private async getControl(): Promise<Client> {
    if (this.control) return this.control
    if (this.closed) throw closedError()
    if (!this.controlPromise) {
      const pending: Promise<Client> = this.openControl().finally(() => {
        if (this.controlPromise === pending) this.controlPromise = null
      })
      this.controlPromise = pending
    }
    return this.controlPromise
  }

  private async openControl(): Promise<Client> {
    const epoch = this.epoch
    let opened: Client | null = null
    const client = await this.openClient(false, () => {
      if (opened && this.control === opened) this.control = null
    })
    opened = client
    if (epoch === this.epoch) {
      // A catalog read must give up rather than wait behind a lock (see the file header). A
      // pooler that refuses SET only loses this protection.
      await this.housekeeping(
        client,
        `SET lock_timeout = '${CONTROL_LOCK_TIMEOUT}'; SET statement_timeout = '${CONTROL_STATEMENT_TIMEOUT}'`
      ).catch(() => undefined)
    }
    if (epoch !== this.epoch) {
      // close() ran while this connection was opening.
      await client.end().catch(() => undefined)
      throw closedError()
    }
    this.controlPid = (client as Client & { processID?: number }).processID ?? 0
    this.control = client
    return client
  }

  /**
   * Catalog query on the control client, one at a time: the explorer, completion and describe
   * fire together, and pg only queues concurrent client.query() calls as a deprecated fallback.
   */
  private controlQuery<R = Row>(sql: string, values?: unknown[]): Promise<R[]> {
    this.controlPending++
    const run = this.controlTail.then(() => this.controlQueryNow<R>(sql, values))
    this.controlTail = run.catch(() => undefined)
    return run.finally(() => {
      this.controlPending--
    })
  }

  /** One retry when the control client had died. */
  private async controlQueryNow<R = Row>(sql: string, values?: unknown[]): Promise<R[]> {
    if (!this.serverVersion) await this.connect()
    for (let attempt = 0; ; attempt++) {
      const client = await this.getControl()
      try {
        // Catalog statements show in the console's metadata view.
        const result = await traceDriverStatement(
          sql,
          () => client.query(sql, values as unknown[]),
          (r) => ({ rows: r.rows.length }),
          values
        )
        return result.rows as R[]
      } catch (error) {
        if (attempt === 0 && isConnectionError(error)) {
          if (this.control === client) this.control = null
          client.end().catch(() => undefined)
          continue
        }
        const mapped = this.mapError(error, sql, false)
        if (mapped.code === LOCK_NOT_AVAILABLE) {
          throw new DataDriverError(
            'Timed out waiting for a lock: an open transaction (possibly in this session) is changing this object. Try again after it commits or rolls back.',
            { code: LOCK_NOT_AVAILABLE }
          )
        }
        throw mapped
      }
    }
  }

  async close(): Promise<void> {
    this.epoch++
    this.closed = true
    const clients = [this.session, this.control, ...this.streamClients].filter(
      (c): c is Client => !!c
    )
    this.session = null
    this.sessionDead = true
    this.control = null
    this.controlPromise = null
    this.streamClients.clear()
    this.lastConnectInfo = null
    await Promise.all(
      clients.map((client) =>
        Promise.race([
          client.end().catch(() => undefined),
          new Promise<void>((r) => setTimeout(r, 2_000))
        ])
      )
    )
  }

  isConnected(): boolean {
    return !!this.session && !this.sessionDead
  }

  sessionState(): { inTransaction?: boolean; currentDatabase?: string } {
    const status = this.isConnected() ? this.txStatus() : 'I'
    return { inTransaction: status === 'T' || status === 'E', currentDatabase: this.database }
  }

  quoteIdentifier(name: string): string {
    return quoteIdent(name)
  }

  // ---- execute -------------------------------------------------------------------------------

  private mapError(error: unknown, statement: string, cancelRequested: boolean): DataDriverError {
    if (error instanceof DataDriverError) return error
    const e = error as PgDatabaseError
    const code = e?.code ? String(e.code) : undefined
    const position = e?.position !== undefined ? Number(e.position) - 1 : undefined
    const detailParts = [e?.detail, e?.where].filter((p): p is string => !!p)
    return new DataDriverError(
      cancelRequested ? 'Query cancelled' : errorMessage(error, (t) => this.redact(t)),
      {
        code,
        position:
          position !== undefined &&
          Number.isFinite(position) &&
          position >= 0 &&
          position <= statement.length
            ? position
            : undefined,
        hint: e?.hint ? this.redact(e.hint) : undefined,
        detail: detailParts.length ? this.redact(detailParts.join('\n')) : undefined,
        sandboxRejected: code === '25006',
        cancelled: cancelRequested || (code === '57014' && /user request/i.test(String(e?.message)))
      }
    )
  }

  private async applySettings(options: DriverExecuteOptions): Promise<void> {
    const client = this.requireSession()
    const status = this.txStatus()
    if (status === 'E') return // Every statement but ROLLBACK fails now; leave the session alone.
    // The transaction that carried our SETs is over; it may have rolled them back.
    if (status === 'I' && this.schemaInTx) {
      this.schemaStale = true
      this.schemaInTx = false
    }
    if (status === 'I' && this.timeoutInTx) {
      this.appliedTimeoutMs = -1
      this.timeoutInTx = false
    }
    // Only a new pick (or a lost one) sets the search_path: a SET search_path the user ran keeps
    // ruling while requests keep naming the same pick.
    if (options.schema && (options.schema !== this.requestedSchema || this.schemaStale)) {
      const path =
        options.schema === 'public' ? quoteIdent('public') : `${quoteIdent(options.schema)}, public`
      await this.housekeeping(client, "SELECT set_config('search_path', $1, false)", [path])
      this.requestedSchema = options.schema
      this.schemaStale = false
      if (status === 'T') this.schemaInTx = true
    }
    const wantTimeout =
      options.timeoutMs && options.timeoutMs > 0 ? Math.trunc(options.timeoutMs) : 0
    if (wantTimeout !== this.appliedTimeoutMs) {
      await this.housekeeping(client, "SELECT set_config('statement_timeout', $1, false)", [
        String(wantTimeout)
      ])
      this.appliedTimeoutMs = wantTimeout
      if (status === 'T') this.timeoutInTx = true
    }
  }

  /**
   * Runs `text` through a cursor and keeps at most `keep` rows (reading one more to detect
   * truncation) within the result byte budget. Reads come in batches sized by the bytes per row
   * seen so far, so a result of wide rows is stopped before it is buffered whole.
   *
   * Between two reads the portal is suspended and the backend waits for the client: a cancel
   * that reaches it then is dropped by the server, and the statement would run on. So a cancel
   * is honoured before each read: `discardOnCancel` (the caller rolls the statement back:
   * read-only sandbox or savepoint) closes the portal and fails as cancelled; otherwise the
   * cancel is sent again while the next read runs, and the server decides (an interrupted
   * statement fails with 57014 and its implicit transaction rolls back; one that finishes first
   * keeps its result, like any late cancel).
   */
  private async runCursor(
    text: string,
    keep: number,
    running: RunningStatement,
    discardOnCancel: boolean
  ): Promise<CursorOutcome> {
    const { Cursor } = await loadPg()
    const client = this.requireSession()
    const cursor = new Cursor(text, undefined, { rowMode: 'array', types: RAW_TYPES })
    // pg-cursor has no COPY handlers; a stray CopyIn/CopyOut would throw inside pg's message
    // loop. Fail/ignore them like pg's own Query does.
    const c = cursor as unknown as Record<string, unknown>
    c.handleCopyInResponse = (connection: { sendCopyFail: (msg: string) => void }) =>
      connection.sendCopyFail('COPY FROM STDIN is not supported here')
    c.handleCopyData = () => undefined
    client.query(cursor)
    const read = (count: number): Promise<{ rows: unknown[][]; result: QueryResult }> =>
      new Promise((resolve, reject) => {
        cursor.read(count, (error, rows, result: QueryResult) =>
          error ? reject(error) : resolve({ rows: rows as unknown[][], result })
        )
      })
    const close = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        cursor.close((error) => (error ? reject(error) : resolve()))
      })
    const rows: DataCell[][] = []
    let fields: FieldDef[] = []
    let bytes = 0
    let batch = FIRST_BATCH_ROWS
    for (;;) {
      const want = Math.min(keep + 1 - rows.length, batch)
      const cancelBetweenReads = running.cancelRequested
      if (cancelBetweenReads) {
        // The cancel already sent is spent (dropped while the backend waited) before anything
        // else reaches the session, so it cannot hit what runs next.
        await running.cancelling?.catch(() => undefined)
        if (discardOnCancel) {
          await close().catch(() => undefined)
          throw new DataDriverError('Query cancelled', { cancelled: true })
        }
      }
      const reading = read(want)
      const resent = cancelBetweenReads ? this.sendCancel().catch(() => undefined) : null
      const { rows: raw, result } = await reading
      await resent
      fields = result?.fields ?? fields
      let stop: 'rows' | 'bytes' | null = null
      for (const values of raw) {
        if (rows.length >= keep) {
          stop = 'rows'
          break
        }
        const cells = values.map((v, i) => decodePgValue(v, fields[i]?.dataTypeID ?? 0, 64))
        let size = 0
        for (const cell of cells) size += cellSize(cell)
        // The row that would cross the budget is left out unless it is the only one.
        if (rows.length > 0 && bytes + size > MAX_RESULT_BYTES) {
          stop = 'bytes'
          break
        }
        bytes += size
        rows.push(cells)
      }
      if (stop) {
        // Closing the portal makes the server stop producing rows.
        await close()
        return {
          fields,
          rows,
          truncated: true,
          byteLimited: stop === 'bytes',
          command: null,
          rowCount: null
        }
      }
      if (raw.length < want) {
        return {
          fields,
          rows,
          truncated: false,
          byteLimited: false,
          command: result?.command ?? null,
          rowCount: typeof result?.rowCount === 'number' ? result.rowCount : null
        }
      }
      const perRow = Math.max(1, bytes / Math.max(1, rows.length))
      batch = Math.max(
        1,
        Math.min(MAX_BATCH_ROWS, Math.floor((MAX_RESULT_BYTES - bytes) / perRow) + 1)
      )
    }
  }

  async execute(statement: string, options: DriverExecuteOptions): Promise<DriverStatementResult> {
    if (isClientCopy(statement)) {
      throw new DataDriverError(
        'COPY … FROM STDIN / TO STDOUT needs a client-side stream and is not supported here. Use COPY with a server file, INSERT, or the Export action.',
        { code: 'UNSUPPORTED' }
      )
    }
    await this.ensureLive()
    const running: RunningStatement = { cancelRequested: false, wake: null, cancelling: null }
    this.running = running
    this.notices = []
    let text = statement
    try {
      await this.applySettings(options)
      if (running.cancelRequested) throw new DataDriverError('Query cancelled', { cancelled: true })
      const hardCap = Math.max(1, Math.min(options.hardCap || DATA_HARD_ROW_CAP, DATA_HARD_ROW_CAP))
      // A LIMIT / FETCH the user wrote wins over the auto-limit; only the hard cap still applies.
      const autoLimit =
        options.limit && options.limit > 0 && !hasUserLimit(statement, 'postgres')
          ? options.limit
          : null
      const keep = autoLimit !== null ? Math.min(autoLimit, hardCap) : hardCap
      let executedText: string | undefined
      if (autoLimit !== null) {
        const rewritten = applyAutoLimit(statement, 'postgres', keep + 1)
        if (rewritten.applied) {
          text = rewritten.text
          executedText = rewritten.text
        }
      }
      const status = this.txStatus()
      const sandbox = options.readOnlySandbox && status === 'I'
      // Inside the user's open transaction the read-only mode cannot be switched on, but an
      // app-run read (table page, COUNT with a timeout) must not abort that transaction when it
      // fails: wrap it in a savepoint and roll back to it on error.
      const savepoint = options.readOnlySandbox && status === 'T'
      const client = this.requireSession()
      if (sandbox) await this.housekeeping(client, 'BEGIN READ ONLY')
      if (savepoint) await this.housekeeping(client, 'SAVEPOINT tedooo_read')
      let outcome: CursorOutcome
      let failed = false
      try {
        outcome = await this.runCursor(text, keep, running, sandbox || savepoint)
      } catch (error) {
        failed = true
        throw error
      } finally {
        if (sandbox && this.isConnected())
          await this.housekeeping(client, 'ROLLBACK').catch(() => undefined)
        if (savepoint && this.isConnected()) {
          await this.housekeeping(
            client,
            failed
              ? 'ROLLBACK TO SAVEPOINT tedooo_read; RELEASE SAVEPOINT tedooo_read'
              : 'RELEASE SAVEPOINT tedooo_read'
          ).catch(() => undefined)
        }
      }
      // No cancel check here: a statement the server finished before the cancel landed keeps its
      // result (a committed UPDATE must not read as cancelled); an interrupted one already threw
      // SQLSTATE 57014 above.
      // DISCARD ALL / RESET ALL wipe what applySettings put on the session: re-apply next run.
      const resetsAll = /^\s*(DISCARD|RESET)\s+ALL\b/i.test(statement)
      if (resetsAll) {
        this.schemaStale = this.requestedSchema !== null
      } else if (setsSearchPath(statement)) {
        // The user's own search_path rules now (see applySettings).
        this.schemaStale = false
        this.schemaInTx = false
      }
      if (resetsAll || /\bstatement_timeout\b/i.test(statement)) this.appliedTimeoutMs = -1

      const notices = [...this.notices]
      if (outcome.byteLimited) {
        notices.push(
          `Showing the first ${outcome.rows.length} rows: the full result is too large to display.`
        )
      }
      const result: DriverStatementResult = {
        output:
          outcome.fields.length > 0
            ? {
                kind: 'rows',
                columns: await this.columnMeta(outcome.fields, running),
                rows: outcome.rows,
                truncated: outcome.truncated,
                limit: outcome.byteLimited
                  ? outcome.rows.length
                  : outcome.truncated
                    ? keep
                    : autoLimit,
                autoLimited:
                  outcome.truncated &&
                  !outcome.byteLimited &&
                  autoLimit !== null &&
                  autoLimit <= hardCap
              }
            : {
                kind: 'command',
                affectedRows:
                  outcome.command &&
                  /^(INSERT|UPDATE|DELETE|MERGE|COPY|MOVE|FETCH|SELECT)$/.test(outcome.command)
                    ? outcome.rowCount
                    : null,
                message: outcome.command
                  ? outcome.rowCount !== null &&
                    /^(INSERT|UPDATE|DELETE|MERGE|COPY|MOVE|FETCH|SELECT)$/.test(outcome.command)
                    ? `${outcome.command} ${outcome.rowCount}`
                    : outcome.command
                  : 'OK',
                lastInsertId: null
              }
      }
      if (executedText) result.executedText = executedText
      if (notices.length > 0) result.notices = notices
      return result
    } catch (error) {
      throw this.mapError(error, text, running.cancelRequested)
    } finally {
      this.notices = null
      if (this.running === running) this.running = null
    }
  }

  private loadTypeNames(force = false): Promise<void> {
    // One load at a time: results arriving while it is queued must not stack up more.
    if (this.typeNamesLoading) return this.typeNamesLoading
    if (!force && this.typeNames.size > 0) return Promise.resolve()
    // Throttle reloads triggered by unknown OIDs (types created after the first load).
    if (force && Date.now() - this.typeNamesLoadedAt < 30_000) return Promise.resolve()
    this.typeNamesLoadedAt = Date.now()
    const loading = this.controlQuery<{ oid: number; name: string }>(
      'SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type'
    )
      .then((rows) => {
        for (const r of rows) this.typeNames.set(Number(r.oid), String(r.name))
      })
      .finally(() => {
        if (this.typeNamesLoading === loading) this.typeNamesLoading = null
      })
    this.typeNamesLoading = loading
    return loading
  }

  private async loadColumnMeta(fields: FieldDef[]): Promise<void> {
    await this.loadTypeNames()
    if (fields.some((f) => !this.typeNames.has(f.dataTypeID))) await this.loadTypeNames(true)
    const unknownRels = [
      ...new Set(fields.map((f) => f.tableID).filter((id) => id && !this.relNames.has(id)))
    ]
    if (unknownRels.length > 0) {
      const rows = await this.controlQuery<{ oid: number; name: string; schema: string }>(
        'SELECT c.oid::int AS oid, c.relname AS name, n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = ANY($1::oid[])',
        [unknownRels]
      )
      for (const r of rows) this.relNames.set(Number(r.oid), { name: r.name, schema: r.schema })
    }
  }

  /**
   * Type names and source tables of a result. Strictly best-effort: the statement has finished
   * and still holds the session, so it waits for the (serialised) control client only briefly —
   * or not at all once cancelled — and otherwise returns names only. A late answer still fills
   * the caches for the next result.
   */
  private async columnMeta(
    fields: FieldDef[],
    running: RunningStatement
  ): Promise<DataColumnMeta[]> {
    const missing = fields.some(
      (f) => !this.typeNames.has(f.dataTypeID) || (!!f.tableID && !this.relNames.has(f.tableID))
    )
    if (missing && !running.cancelRequested) {
      const waitMs = this.controlPending === 0 ? META_WAIT_MS : META_WAIT_BUSY_MS
      // Metadata is a nicety; the result itself is fine without it.
      const load = this.loadColumnMeta(fields).catch(() => undefined)
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          if (running.wake === done) running.wake = null
          resolve()
        }
        // `done` only runs later (timer, load, cancel), after `timer` is set.
        const timer = setTimeout(done, waitMs)
        running.wake = done
        void load.then(done)
      })
    }
    return fields.map((f) => {
      const meta: DataColumnMeta = { name: f.name }
      const type = this.typeNames.get(f.dataTypeID)
      if (type) meta.type = type
      const rel = f.tableID ? this.relNames.get(f.tableID) : undefined
      if (rel) {
        meta.table = rel.name
        meta.schema = rel.schema
        meta.database = this.database
      }
      return meta
    })
  }

  async cancelCurrent(): Promise<void> {
    const running = this.running
    if (!running) return
    running.cancelRequested = true
    // Finished on the server and only waiting for column metadata: nothing to cancel there.
    if (running.wake) {
      running.wake()
      return
    }
    const sending = this.sendCancel()
    running.cancelling = sending
    await sending
  }

  /**
   * Asks the server to cancel what the session runs now. A backend that is waiting for the
   * client (between two cursor reads) drops it: runCursor sends it again with the next read.
   */
  private async sendCancel(): Promise<void> {
    const pid = this.sessionPid
    // pg_cancel_backend rides the control client; when catalog queries are queued there, a
    // cancel must not wait behind them, so go straight to the protocol-level cancel.
    if (this.controlPending === 0) {
      try {
        const rows = await this.controlQuery<{ ok: boolean }>(
          'SELECT pg_cancel_backend($1) AS ok',
          [pid]
        )
        if (rows[0]?.ok) return
      } catch {
        // Fall through to the protocol-level cancel (what psql ^C sends; also passes PgBouncer).
      }
    }
    try {
      const { pg } = await loadPg()
      const session = this.session as (Client & { activeQuery?: unknown }) | null
      if (!session) return
      const canceller = new pg.Client(await this.clientConfig(await this.ssl(), true)) as Client & {
        cancel: (client: Client, query: unknown) => void
      }
      canceller.cancel(session, session.activeQuery)
    } catch {
      // Last resort: drop the session; the manager reconnects (session state is lost).
      this.session?.end().catch(() => undefined)
      this.sessionDead = true
    }
  }

  // ---- introspection -------------------------------------------------------------------------

  private get hasRelispartition(): boolean {
    return this.versionNum >= 100000
  }

  private get hasProkind(): boolean {
    return this.versionNum >= 110000
  }

  async listDatabases(): Promise<DataDatabaseInfo[]> {
    const rows = await this.controlQuery<{ name: string; size: string | null }>(
      "SELECT datname AS name, CASE WHEN has_database_privilege(oid, 'CONNECT') THEN pg_database_size(oid) END AS size " +
        'FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname'
    )
    return rows.map((r) => ({
      name: r.name,
      sizeBytes: r.size === null || r.size === undefined ? null : Number(r.size),
      isSystem: SYSTEM_DATABASES.has(r.name)
    }))
  }

  private async userSchemas(): Promise<string[]> {
    const rows = await this.controlQuery<{ name: string }>(
      "SELECT nspname AS name FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' " +
        "ORDER BY (nspname = 'public') DESC, nspname"
    )
    return rows.map((r) => r.name)
  }

  async listObjects(_database?: string, schema?: string): Promise<DataObjectsListing> {
    const schemas = await this.userSchemas()
    const target = schema ? [schema] : schemas
    const objects: DataObjectInfo[] = []
    const notPartition = this.hasRelispartition ? 'AND NOT c.relispartition' : ''
    const rels = await this.withLockFallback((full) =>
      this.controlQuery<{
        schema: string
        name: string
        kind: string
        est: string | null
        size: string | null
        comment: string | null
        am: string | null
      }>(
        (full ? `WITH ${LOCKED_RELATIONS_CTE} ` : '') +
          'SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, c.reltuples::bigint AS est, ' +
          `${full ? LOCK_SAFE_SIZE_EXPR : 'NULL::bigint'} AS size, ` +
          "obj_description(c.oid, 'pg_class') AS comment, " +
          (this.versionNum >= 120000 ? 'am.amname' : 'NULL::name') +
          ' AS am FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
          (this.versionNum >= 120000 ? 'LEFT JOIN pg_am am ON am.oid = c.relam ' : '') +
          `WHERE c.relkind IN ('r','p','v','m','f','S') ${notPartition} AND n.nspname = ANY($1::text[]) ORDER BY 1, 2`,
        [target]
      )
    )
    for (const r of rels) {
      const kind = relkindToKind(r.kind)
      const est = r.est === null ? null : Number(r.est)
      objects.push({
        name: r.name,
        schema: r.schema,
        kind,
        rowEstimate:
          kind === 'table' || kind === 'materialized_view'
            ? est !== null && est >= 0
              ? est
              : null
            : null,
        sizeBytes: r.size === null || r.size === undefined ? null : Number(r.size),
        engine: r.kind === 'p' ? 'partitioned' : (r.am ?? undefined),
        comment: r.comment ?? undefined
      })
    }
    const kindFilter = this.hasProkind
      ? "p.prokind IN ('f','p')"
      : 'NOT p.proisagg AND NOT p.proiswindow'
    const kindExpr = this.hasProkind ? 'p.prokind::text' : "'f'"
    const funcs = await this.controlQuery<{
      schema: string
      name: string
      kind: string
      args: string
      result: string | null
    }>(
      `SELECT n.nspname AS schema, p.proname AS name, ${kindExpr} AS kind, pg_get_function_identity_arguments(p.oid) AS args, ` +
        'pg_get_function_result(p.oid) AS result FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace ' +
        `WHERE n.nspname = ANY($1::text[]) AND ${kindFilter} ` +
        "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') " +
        'ORDER BY 1, 2',
      [target]
    ).catch(() => [])
    for (const f of funcs) {
      objects.push({
        name: f.name,
        schema: f.schema,
        kind: f.kind === 'p' ? 'procedure' : 'function',
        detail: f.args,
        comment: f.result ? `returns ${f.result}` : undefined
      })
    }
    const triggers = await this.controlQuery<{ schema: string; name: string; tbl: string }>(
      'SELECT n.nspname AS schema, t.tgname AS name, c.relname AS tbl FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid ' +
        'JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = ANY($1::text[]) ORDER BY 1, 2',
      [target]
    ).catch(() => [])
    for (const t of triggers)
      objects.push({ name: t.name, schema: t.schema, kind: 'trigger', detail: t.tbl })
    const types = await this.controlQuery<{ schema: string; name: string; typtype: string }>(
      'SELECT n.nspname AS schema, t.typname AS name, t.typtype::text AS typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace ' +
        "WHERE n.nspname = ANY($1::text[]) AND (t.typtype IN ('e','d') OR (t.typtype = 'c' AND " +
        "(SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c')) " +
        "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e') " +
        'ORDER BY 1, 2',
      [target]
    ).catch(() => [])
    for (const t of types) {
      objects.push({
        name: t.name,
        schema: t.schema,
        kind: 'type',
        detail: t.typtype === 'e' ? 'enum' : t.typtype === 'd' ? 'domain' : 'composite'
      })
    }
    return { schemas, objects }
  }

  private async resolveRelation(ref: DataObjectRef): Promise<{
    oid: number
    schema: string
    name: string
    relkind: string
    est: number | null
    size: number | null
    comment: string | null
    owner: string
    persistence: string
    ispartition: boolean
    /** schema.name with pg_dump-style minimal quoting (server quote_ident). */
    qualified: string
    /**
     * Someone holds (or waits for) an ACCESS EXCLUSIVE lock on it or one of its indexes:
     * definitions that need its lock (pg_get_indexdef, pg_get_expr with the relation) are left
     * out, or refused for DDL.
     */
    locked: boolean
  }> {
    const rows = await this.withLockFallback((full) =>
      this.controlQuery<Row>(
        (full ? `WITH ${LOCKED_RELATIONS_CTE} ` : '') +
          "SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS qualified, " +
          'c.relkind::text AS relkind, c.reltuples::bigint AS est, ' +
          `${full ? LOCK_SAFE_SIZE_EXPR : 'NULL::bigint'} AS size, ${full ? IS_LOCKED_EXPR : 'true'} AS locked, ` +
          "obj_description(c.oid, 'pg_class') AS comment, pg_get_userbyid(c.relowner) AS owner, c.relpersistence::text AS persistence, " +
          (this.hasRelispartition ? 'c.relispartition' : 'false') +
          ' AS ispartition FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
          'WHERE n.nspname = COALESCE($1, current_schema()) AND c.relname = $2',
        [ref.schema ?? null, ref.name]
      )
    )
    const r = rows[0]
    if (!r)
      throw new DataDriverError(
        `Relation ${ref.schema ? `${ref.schema}.` : ''}${ref.name} not found.`,
        { code: 'NOT_FOUND' }
      )
    const est = r.est === null || r.est === undefined ? null : Number(r.est)
    return {
      oid: Number(r.oid),
      schema: String(r.schema),
      name: String(r.name),
      relkind: String(r.relkind),
      est: est !== null && est >= 0 ? est : null,
      size: r.size === null || r.size === undefined ? null : Number(r.size),
      comment: (r.comment as string | null) ?? null,
      owner: String(r.owner),
      persistence: String(r.persistence),
      ispartition: r.ispartition === true,
      qualified: String(r.qualified),
      locked: r.locked === true
    }
  }

  /**
   * Runs a catalog read whose full form may need relation locks (sizes, definitions) and, when
   * it still hits the control client's lock or statement timeout, once more without those parts.
   */
  private async withLockFallback<T>(run: (full: boolean) => Promise<T>): Promise<T> {
    try {
      return await run(true)
    } catch (error) {
      if (!isLockOrTimeout(error)) throw error
      return run(false)
    }
  }

  /**
   * Columns of a relation. `full: false` reads defaults without the relation (no lock needed;
   * a default never refers to a column) and leaves generated-column expressions out.
   */
  private async columnsOf(
    oid: number,
    full = true
  ): Promise<
    Array<{
      num: number
      name: string
      qname: string
      type: string
      notnull: boolean
      def: string | null
      identity: string
      generated: string
      comment: string | null
      collation: string | null
    }>
  > {
    const identity = this.versionNum >= 100000 ? 'a.attidentity::text' : "''"
    const generated = this.versionNum >= 120000 ? 'a.attgenerated::text' : "''"
    const def = full
      ? 'pg_get_expr(d.adbin, d.adrelid)'
      : `CASE WHEN ${generated} = '' THEN pg_get_expr(d.adbin, 0) END`
    return this.controlQuery(
      `SELECT a.attnum::int AS num, a.attname AS name, quote_ident(a.attname) AS qname, format_type(a.atttypid, a.atttypmod) AS type, ` +
        `a.attnotnull AS notnull, ${def} AS def, ${identity} AS identity, ${generated} AS generated, ` +
        'col_description(a.attrelid, a.attnum) AS comment, ' +
        'CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN quote_ident(co.collname) END AS collation ' +
        'FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum ' +
        'LEFT JOIN pg_collation co ON co.oid = a.attcollation ' +
        'WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum',
      [oid]
    )
  }

  private async primaryKeyOf(oid: number): Promise<string[]> {
    const rows = await this.controlQuery<{ name: string }>(
      'SELECT a.attname AS name FROM pg_constraint con CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ' +
        "JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum WHERE con.conrelid = $1 AND con.contype = 'p' ORDER BY k.ord",
      [oid]
    )
    return rows.map((r) => r.name)
  }

  async describe(ref: DataObjectRef): Promise<DataTableDetails> {
    if (
      ref.kind === 'function' ||
      ref.kind === 'procedure' ||
      ref.kind === 'trigger' ||
      ref.kind === 'type'
    ) {
      return {
        ref: { ...ref, database: this.database },
        kind: ref.kind,
        columns: [],
        indexes: [],
        foreignKeys: [],
        triggers: [],
        primaryKey: []
      }
    }
    const rel = await this.resolveRelation(ref)
    const kind = relkindToKind(rel.relkind)
    const primaryKey = await this.primaryKeyOf(rel.oid)
    const pk = new Set(primaryKey)
    // A relation under someone's ACCESS EXCLUSIVE lock is described without what needs its lock
    // (generated-column expressions, index definitions and sizes) instead of waiting.
    const cols = await this.withLockFallback((full) => this.columnsOf(rel.oid, full && !rel.locked))
    const columns: DataColumnInfo[] = cols.map((c) => {
      const extra: string[] = []
      if (c.identity === 'a') extra.push('GENERATED ALWAYS AS IDENTITY')
      if (c.identity === 'd') extra.push('GENERATED BY DEFAULT AS IDENTITY')
      if (c.generated === 's') extra.push(`GENERATED ALWAYS AS (${c.def ?? '…'}) STORED`)
      if (c.collation) extra.push(`COLLATE ${c.collation}`)
      return {
        name: c.name,
        type: c.type,
        nullable: !c.notnull,
        defaultValue: c.generated === 's' ? null : c.def,
        isPrimaryKey: pk.has(c.name),
        ordinal: c.num,
        autoIncrement: c.identity === 'a' || c.identity === 'd' || /^nextval\(/.test(c.def ?? ''),
        comment: c.comment ?? undefined,
        extra: extra.length ? extra.join(' ') : undefined
      }
    })
    const idxRows = await this.withLockFallback((full) =>
      this.controlQuery<{
        name: string
        uniq: boolean
        prim: boolean
        def: string | null
        type: string
        size: string | null
        col: string
      }>(
        full && !rel.locked
          ? 'SELECT ic.relname AS name, i.indisunique AS uniq, i.indisprimary AS prim, pg_get_indexdef(i.indexrelid) AS def, ' +
              'am.amname AS type, pg_relation_size(i.indexrelid) AS size, pg_get_indexdef(i.indexrelid, k, true) AS col ' +
              'FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam ' +
              'CROSS JOIN LATERAL generate_series(1, i.indnatts) AS k WHERE i.indrelid = $1 ORDER BY ic.relname, k'
          : // Lock-free: plain column names (expressions unnamed), no definition or size.
            'SELECT ic.relname AS name, i.indisunique AS uniq, i.indisprimary AS prim, NULL::text AS def, ' +
              "am.amname AS type, NULL::bigint AS size, COALESCE(quote_ident(a.attname), '(expression)') AS col " +
              'FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam ' +
              'CROSS JOIN LATERAL generate_series(1, i.indnatts) AS k ' +
              'LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[k - 1] AND a.attnum > 0 ' +
              'WHERE i.indrelid = $1 ORDER BY ic.relname, k',
        [rel.oid]
      )
    )
    const indexes = new Map<string, DataIndexInfo>()
    for (const r of idxRows) {
      const existing = indexes.get(r.name)
      if (existing) existing.columns.push(r.col)
      else
        indexes.set(r.name, {
          name: r.name,
          columns: [r.col],
          unique: r.uniq,
          primary: r.prim,
          definition: r.def ?? undefined,
          type: r.type,
          sizeBytes: r.size === null ? null : Number(r.size)
        })
    }
    const fkRows = await this.controlQuery<{
      name: string
      upd: string
      del: string
      rschema: string
      rtable: string
      col: string
      rcol: string
    }>(
      'SELECT con.conname AS name, con.confupdtype::text AS upd, con.confdeltype::text AS del, rn.nspname AS rschema, rc.relname AS rtable, ' +
        'a.attname AS col, ra.attname AS rcol FROM pg_constraint con ' +
        'JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace ' +
        'CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, rattnum, ord) ' +
        'JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ' +
        'JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.rattnum ' +
        "WHERE con.conrelid = $1 AND con.contype = 'f' ORDER BY con.conname, k.ord",
      [rel.oid]
    )
    const fks = new Map<string, DataForeignKeyInfo>()
    for (const r of fkRows) {
      const existing = fks.get(r.name)
      if (existing) {
        existing.columns.push(r.col)
        existing.refColumns.push(r.rcol)
      } else {
        fks.set(r.name, {
          name: r.name,
          columns: [r.col],
          refDatabase: this.database,
          refSchema: r.rschema,
          refTable: r.rtable,
          refColumns: [r.rcol],
          onUpdate: FK_ACTIONS[r.upd] ?? r.upd,
          onDelete: FK_ACTIONS[r.del] ?? r.del
        })
      }
    }
    const triggers = await this.controlQuery<{ name: string; def: string }>(
      'SELECT tgname AS name, pg_get_triggerdef(oid, true) AS def FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal ORDER BY tgname',
      [rel.oid]
    )
    const properties: Array<{ label: string; value: string }> = [
      { label: 'Owner', value: rel.owner }
    ]
    if (rel.persistence === 'u') properties.push({ label: 'Persistence', value: 'UNLOGGED' })
    if (rel.relkind === 'p') {
      const [pkDef] = await this.controlQuery<{ def: string }>(
        'SELECT pg_get_partkeydef($1::oid) AS def',
        [rel.oid]
      ).catch(() => [])
      if (pkDef?.def) properties.push({ label: 'Partition key', value: pkDef.def })
    }
    if (rel.ispartition) {
      const [bound] = await this.controlQuery<{ parent: string; bound: string }>(
        'SELECT i.inhparent::regclass::text AS parent, pg_get_expr(c.relpartbound, c.oid) AS bound FROM pg_class c ' +
          'JOIN pg_inherits i ON i.inhrelid = c.oid WHERE c.oid = $1',
        [rel.oid]
      ).catch(() => [])
      if (bound) properties.push({ label: 'Partition of', value: `${bound.parent} ${bound.bound}` })
    }
    return {
      ref: { database: this.database, schema: rel.schema, name: rel.name, kind },
      kind,
      columns,
      indexes: [...indexes.values()],
      foreignKeys: [...fks.values()],
      triggers: triggers.map((t) => ({ name: t.name, definition: t.def })),
      primaryKey,
      rowEstimate: kind === 'table' || kind === 'materialized_view' ? rel.est : null,
      sizeBytes: rel.size,
      engine: rel.relkind === 'p' ? 'partitioned' : undefined,
      comment: rel.comment ?? undefined,
      properties
    }
  }

  async ddl(ref: DataObjectRef): Promise<string> {
    const schemaParam = ref.schema ?? null
    switch (ref.kind) {
      case 'function':
      case 'procedure': {
        const filter = this.hasProkind ? "AND p.prokind IN ('f','p')" : 'AND NOT p.proisagg'
        const rows = await this.controlQuery<{ def: string }>(
          'SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace ' +
            `WHERE n.nspname = COALESCE($1, current_schema()) AND p.proname = $2 ${filter} ORDER BY p.oid`,
          [schemaParam, ref.name]
        )
        if (rows.length === 0)
          throw new DataDriverError(`Function ${ref.name} not found.`, { code: 'NOT_FOUND' })
        return rows.map((r) => `${r.def.trimEnd()};\n`).join('\n')
      }
      case 'trigger': {
        const rows = await this.controlQuery<{ def: string }>(
          'SELECT pg_get_triggerdef(t.oid, true) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid ' +
            'JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = COALESCE($1, current_schema()) AND t.tgname = $2',
          [schemaParam, ref.name]
        )
        if (rows.length === 0)
          throw new DataDriverError(`Trigger ${ref.name} not found.`, { code: 'NOT_FOUND' })
        return rows.map((r) => `${r.def};\n`).join('\n')
      }
      case 'type':
        return this.typeDdl(ref)
      default:
        break
    }
    const rel = await this.resolveRelation(ref)
    if (rel.locked) {
      // pg_get_viewdef / pg_get_indexdef / pg_get_expr would wait for that lock.
      throw new DataDriverError(
        `${rel.qualified} is locked by an open transaction (ALTER TABLE, LOCK TABLE, …), possibly in this session. Its DDL can be read once that transaction ends.`,
        { code: LOCK_NOT_AVAILABLE }
      )
    }
    const qualified = rel.qualified
    const out: string[] = []
    if (rel.relkind === 'v' || rel.relkind === 'm') {
      const [view] = await this.controlQuery<{ def: string }>(
        'SELECT pg_get_viewdef($1::oid, true) AS def',
        [rel.oid]
      )
      const body = String(view?.def ?? '')
        .trim()
        .replace(/;\s*$/, '')
      if (rel.relkind === 'v') out.push(`CREATE OR REPLACE VIEW ${qualified} AS\n${body};`)
      else out.push(`CREATE MATERIALIZED VIEW ${qualified} AS\n${body}\nWITH DATA;`)
    } else if (rel.relkind === 'S') {
      const [seq] = await this.controlQuery<{ def: string }>(
        "SELECT format('CREATE SEQUENCE %s AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s%s;', " +
          "$3::text, data_type, increment_by, min_value, max_value, start_value, cache_size, CASE WHEN cycle THEN ' CYCLE' ELSE '' END) AS def " +
          'FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2',
        [rel.schema, rel.name, qualified]
      )
      out.push(seq?.def ?? `CREATE SEQUENCE ${qualified};`)
    } else {
      out.push(await this.tableDdl(rel, qualified))
    }
    if (rel.relkind !== 'v' && rel.relkind !== 'S') {
      const indexes = await this.controlQuery<{ def: string }>(
        'SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i WHERE i.indrelid = $1 ' +
          'AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid AND c.conrelid = i.indrelid) ORDER BY 1',
        [rel.oid]
      )
      for (const i of indexes) out.push(`${i.def};`)
    }
    const triggers = await this.controlQuery<{ def: string }>(
      'SELECT pg_get_triggerdef(oid, true) AS def FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal ORDER BY tgname',
      [rel.oid]
    )
    for (const t of triggers) out.push(`${t.def};`)
    if (rel.comment !== null) {
      const [lit] = await this.controlQuery<{ lit: string }>('SELECT quote_literal($1) AS lit', [
        rel.comment
      ])
      const what =
        rel.relkind === 'v'
          ? 'VIEW'
          : rel.relkind === 'm'
            ? 'MATERIALIZED VIEW'
            : rel.relkind === 'S'
              ? 'SEQUENCE'
              : rel.relkind === 'f'
                ? 'FOREIGN TABLE'
                : 'TABLE'
      out.push(`COMMENT ON ${what} ${qualified} IS ${lit.lit};`)
    }
    const colComments = await this.controlQuery<{ qname: string; lit: string }>(
      'SELECT quote_ident(a.attname) AS qname, quote_literal(d.description) AS lit FROM pg_attribute a ' +
        "JOIN pg_description d ON d.objoid = a.attrelid AND d.objsubid = a.attnum AND d.classoid = 'pg_class'::regclass " +
        'WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum',
      [rel.oid]
    )
    for (const c of colComments) out.push(`COMMENT ON COLUMN ${qualified}.${c.qname} IS ${c.lit};`)
    return `${out.join('\n\n')}\n`
  }

  private async tableDdl(
    rel: Awaited<ReturnType<PostgresDriver['resolveRelation']>>,
    qualified: string
  ): Promise<string> {
    if (rel.ispartition) {
      const [p] = await this.controlQuery<{ parent: string; bound: string }>(
        'SELECT i.inhparent::regclass::text AS parent, pg_get_expr(c.relpartbound, c.oid) AS bound FROM pg_class c ' +
          'JOIN pg_inherits i ON i.inhrelid = c.oid WHERE c.oid = $1',
        [rel.oid]
      )
      if (p) return `CREATE TABLE ${qualified} PARTITION OF ${p.parent}\n  ${p.bound};`
    }
    const cols = await this.columnsOf(rel.oid)
    const lines = cols.map((c) => {
      let line = `  ${c.qname} ${c.type}`
      if (c.collation) line += ` COLLATE ${c.collation}`
      if (c.identity === 'a') line += ' GENERATED ALWAYS AS IDENTITY'
      else if (c.identity === 'd') line += ' GENERATED BY DEFAULT AS IDENTITY'
      else if (c.generated === 's') line += ` GENERATED ALWAYS AS (${c.def}) STORED`
      else if (c.def !== null) line += ` DEFAULT ${c.def}`
      if (c.notnull) line += ' NOT NULL'
      return line
    })
    const constraints = await this.controlQuery<{ qname: string; def: string }>(
      "SELECT quote_ident(conname) AS qname, pg_get_constraintdef(oid, true) AS def FROM pg_constraint WHERE conrelid = $1 AND contype IN ('p','u','f','c','x') " +
        "ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'x' THEN 3 ELSE 4 END, conname",
      [rel.oid]
    )
    for (const c of constraints) lines.push(`  CONSTRAINT ${c.qname} ${c.def}`)
    const prefix =
      rel.relkind === 'f'
        ? 'CREATE FOREIGN TABLE'
        : rel.persistence === 'u'
          ? 'CREATE UNLOGGED TABLE'
          : 'CREATE TABLE'
    let ddl = `${prefix} ${qualified} (\n${lines.join(',\n')}\n)`
    if (rel.relkind === 'p') {
      const [pk] = await this.controlQuery<{ def: string }>(
        'SELECT pg_get_partkeydef($1::oid) AS def',
        [rel.oid]
      )
      if (pk?.def) ddl += `\nPARTITION BY ${pk.def}`
    }
    const inherits = await this.controlQuery<{ parent: string }>(
      'SELECT inhparent::regclass::text AS parent FROM pg_inherits WHERE inhrelid = $1 ORDER BY inhseqno',
      [rel.oid]
    )
    if (inherits.length > 0 && !rel.ispartition)
      ddl += `\nINHERITS (${inherits.map((i) => i.parent).join(', ')})`
    if (rel.relkind === 'f') {
      const [srv] = await this.controlQuery<{ server: string; options: string | null }>(
        "SELECT quote_ident(s.srvname) AS server, array_to_string(ft.ftoptions, ', ') AS options FROM pg_foreign_table ft " +
          'JOIN pg_foreign_server s ON s.oid = ft.ftserver WHERE ft.ftrelid = $1',
        [rel.oid]
      )
      if (srv) ddl += `\nSERVER ${srv.server}${srv.options ? ` OPTIONS (${srv.options})` : ''}`
    }
    const [opts] = await this.controlQuery<{ opts: string | null }>(
      "SELECT array_to_string(reloptions, ', ') AS opts FROM pg_class WHERE oid = $1",
      [rel.oid]
    )
    if (opts?.opts) ddl += `\nWITH (${opts.opts})`
    return `${ddl};`
  }

  private async typeDdl(ref: DataObjectRef): Promise<string> {
    const [t] = await this.controlQuery<{
      oid: number
      typtype: string
      qualified: string
      base: string | null
      def: string | null
      notnull: boolean
    }>(
      "SELECT t.oid::int AS oid, t.typtype::text AS typtype, quote_ident(n.nspname) || '.' || quote_ident(t.typname) AS qualified, " +
        "CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END AS base, t.typdefault AS def, t.typnotnull AS notnull " +
        'FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = COALESCE($1, current_schema()) AND t.typname = $2',
      [ref.schema ?? null, ref.name]
    )
    if (!t) throw new DataDriverError(`Type ${ref.name} not found.`, { code: 'NOT_FOUND' })
    if (t.typtype === 'e') {
      const labels = await this.controlQuery<{ lit: string }>(
        'SELECT quote_literal(enumlabel) AS lit FROM pg_enum WHERE enumtypid = $1 ORDER BY enumsortorder',
        [t.oid]
      )
      return `CREATE TYPE ${t.qualified} AS ENUM (\n  ${labels.map((l) => l.lit).join(',\n  ')}\n);\n`
    }
    if (t.typtype === 'd') {
      const checks = await this.controlQuery<{ qname: string; def: string }>(
        'SELECT quote_ident(conname) AS qname, pg_get_constraintdef(oid, true) AS def FROM pg_constraint WHERE contypid = $1 ORDER BY conname',
        [t.oid]
      )
      let ddl = `CREATE DOMAIN ${t.qualified} AS ${t.base}`
      if (t.def !== null) ddl += `\n  DEFAULT ${t.def}`
      if (t.notnull) ddl += '\n  NOT NULL'
      for (const c of checks) ddl += `\n  CONSTRAINT ${c.qname} ${c.def}`
      return `${ddl};\n`
    }
    const attrs = await this.controlQuery<{ qname: string; type: string }>(
      'SELECT quote_ident(a.attname) AS qname, format_type(a.atttypid, a.atttypmod) AS type FROM pg_type t ' +
        'JOIN pg_attribute a ON a.attrelid = t.typrelid WHERE t.oid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum',
      [t.oid]
    )
    return `CREATE TYPE ${t.qualified} AS (\n  ${attrs.map((a) => `${a.qname} ${a.type}`).join(',\n  ')}\n);\n`
  }

  async completionSchema(): Promise<DataCompletionSchema> {
    const databases = (
      await this.controlQuery<{ name: string }>(
        'SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname'
      )
    ).map((r) => r.name)
    const schemas = await this.userSchemas()
    const [cur] = await this.controlQuery<{ s: string | null }>('SELECT current_schema() AS s')
    const notPartition = this.hasRelispartition ? 'AND NOT c.relispartition' : ''
    const rels = await this.controlQuery<{ schema: string; name: string; kind: string }>(
      'SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
        `WHERE c.relkind IN ('r','p','v','m','f') ${notPartition} AND n.nspname = ANY($1::text[]) ORDER BY 1, 2 LIMIT ${COMPLETION_TABLE_CAP + 1}`,
      [schemas]
    )
    let truncated = rels.length > COMPLETION_TABLE_CAP
    const tables = new Map<string, DataCompletionTable>()
    for (const r of rels.slice(0, COMPLETION_TABLE_CAP)) {
      tables.set(`${r.schema}\u0000${r.name}`, {
        schema: r.schema,
        name: r.name,
        kind: relkindToKind(r.kind),
        columns: []
      })
    }
    const cols = await this.controlQuery<{
      schema: string
      tbl: string
      name: string
      type: string
    }>(
      'SELECT n.nspname AS schema, c.relname AS tbl, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type ' +
        'FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace ' +
        `WHERE c.relkind IN ('r','p','v','m','f') ${notPartition} AND a.attnum > 0 AND NOT a.attisdropped AND n.nspname = ANY($1::text[]) ` +
        `ORDER BY n.nspname, c.relname, a.attnum LIMIT ${COMPLETION_COLUMN_CAP + 1}`,
      [schemas]
    )
    if (cols.length > COMPLETION_COLUMN_CAP) truncated = true
    for (const c of cols.slice(0, COMPLETION_COLUMN_CAP)) {
      tables.get(`${c.schema}\u0000${c.tbl}`)?.columns.push({ name: c.name, type: c.type })
    }
    const functions = (
      await this.controlQuery<{ name: string }>(
        'SELECT DISTINCT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace ' +
          'WHERE n.nspname = ANY($1::text[]) ORDER BY 1 LIMIT 5000',
        [schemas]
      ).catch(() => [])
    ).map((r) => r.name)
    const schema: DataCompletionSchema = {
      database: this.database,
      defaultSchema: cur?.s ?? 'public',
      databases,
      schemas,
      tables: [...tables.values()],
      functions
    }
    if (truncated) schema.truncated = true
    return schema
  }

  async listProcesses(): Promise<DataProcessInfo[]> {
    const backendFilter = this.versionNum >= 100000 ? "WHERE backend_type = 'client backend'" : ''
    const rows = await this.controlQuery<Row>(
      'SELECT pid, usename AS user, datname AS database, application_name AS app, client_addr::text AS client, state, ' +
        'wait_event_type, wait_event, (EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000)::bigint AS dur_ms, ' +
        '(EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) * 1000)::bigint AS xact_ms, ' +
        `array_to_string(pg_blocking_pids(pid), ',') AS blocked_by, query FROM pg_stat_activity ${backendFilter} ` +
        "ORDER BY (state = 'idle'), query_start"
    )
    const own = new Set<number>([this.sessionPid, this.controlPid, ...this.streamPids])
    return rows.map((r): DataProcessInfo => {
      const pid = Number(r.pid)
      const state = (r.state as string | null) ?? null
      const extra: Record<string, string | number | null> = {
        application: (r.app as string | null) || null,
        wait_event: r.wait_event ? `${r.wait_event_type}:${r.wait_event}` : null,
        blocked_by: (r.blocked_by as string | null) || null,
        transaction_ms: r.xact_ms === null || r.xact_ms === undefined ? null : Number(r.xact_ms)
      }
      return {
        id: String(pid),
        user: (r.user as string | null) ?? null,
        host: (r.client as string | null) ?? null,
        database: (r.database as string | null) ?? null,
        state,
        command: state,
        durationMs:
          state && state !== 'idle' && r.dur_ms !== null && r.dur_ms !== undefined
            ? Number(r.dur_ms)
            : null,
        query: (r.query as string | null) ?? null,
        isOwn: own.has(pid),
        extra
      }
    })
  }

  async killProcess(processId: string, scope: DataKillScope): Promise<void> {
    if (!/^\d+$/.test(processId))
      throw new DataDriverError('Invalid process id.', { code: 'INVALID_INPUT' })
    const pid = Number(processId)
    const fn = scope === 'query' ? 'pg_cancel_backend' : 'pg_terminate_backend'
    const [row] = await this.controlQuery<{ ok: boolean }>(`SELECT ${fn}($1) AS ok`, [pid])
    if (!row?.ok) {
      throw new DataDriverError(
        `Could not signal process ${pid} (it ended already, or you lack the privilege).`,
        {
          code: 'KILL_FAILED'
        }
      )
    }
    if (scope === 'connection' && pid === this.sessionPid) this.sessionDead = true
  }

  // ---- export streaming ----------------------------------------------------------------------

  async streamRows(
    statement: string,
    options: { database?: string; schema?: string; readOnlySandbox: boolean; signal: AbortSignal },
    onBatch: (columns: string[], rows: unknown[][]) => Promise<void>
  ): Promise<{ rows: number }> {
    if (isClientCopy(statement)) {
      throw new DataDriverError('COPY … TO STDOUT cannot be exported; export the SELECT instead.', {
        code: 'UNSUPPORTED'
      })
    }
    if (options.signal.aborted) throw new DataDriverError('Export cancelled', { cancelled: true })
    const { Cursor } = await loadPg()
    const client = await this.openClient(true, () => undefined)
    const pid = (client as Client & { processID?: number }).processID ?? 0
    this.streamClients.add(client)
    if (pid) this.streamPids.add(pid)
    const onAbort = (): void => {
      // Ending the socket stops the server-side portal; the pending read rejects.
      const conn = (client as Client & { connection?: { stream?: { destroy: () => void } } })
        .connection
      conn?.stream?.destroy()
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      // Same datestyle / bytea_output / TimeZone as the session: exported cells match the grid.
      await this.applyPrologue(client)
      if (options.schema) {
        const path =
          options.schema === 'public'
            ? quoteIdent('public')
            : `${quoteIdent(options.schema)}, public`
        await this.housekeeping(client, "SELECT set_config('search_path', $1, false)", [path])
      }
      await this.housekeeping(client, options.readOnlySandbox ? 'BEGIN READ ONLY' : 'BEGIN')
      const cursor = client.query(
        new Cursor(statement, undefined, { rowMode: 'array', types: RAW_TYPES })
      )
      let total = 0
      let want = FIRST_BATCH_ROWS
      for (;;) {
        const { rows, result } = await new Promise<{ rows: unknown[][]; result: QueryResult }>(
          (resolve, reject) => {
            cursor.read(want, (error, rows, result) =>
              error ? reject(error) : resolve({ rows: rows as unknown[][], result })
            )
          }
        )
        const fields = result?.fields ?? []
        if (rows.length > 0) {
          total += rows.length
          let bytes = 0
          const cells = rows.map((row) => {
            const decoded = row.map((v, i) =>
              decodePgValue(v, fields[i]?.dataTypeID ?? 0, Infinity)
            )
            for (const cell of decoded) bytes += cellSize(cell)
            return decoded
          })
          await onBatch(
            fields.map((f) => f.name),
            cells
          )
          if (rows.length < want) break
          // Batches of about STREAM_BATCH_BYTES: wide rows must not pile up a huge read.
          const perRow = Math.max(1, bytes / rows.length)
          want = Math.max(1, Math.min(STREAM_BATCH_ROWS, Math.floor(STREAM_BATCH_BYTES / perRow)))
        } else {
          if (total === 0 && fields.length > 0) {
            await onBatch(
              fields.map((f) => f.name),
              []
            )
          }
          break
        }
        if (options.signal.aborted)
          throw new DataDriverError('Export cancelled', { cancelled: true })
      }
      if (options.signal.aborted) throw new DataDriverError('Export cancelled', { cancelled: true })
      await new Promise<void>((resolve) => cursor.close(() => resolve()))
      await this.housekeeping(client, 'ROLLBACK').catch(() => undefined)
      return { rows: total }
    } catch (error) {
      if (options.signal.aborted) throw new DataDriverError('Export cancelled', { cancelled: true })
      throw this.mapError(error, statement, false)
    } finally {
      options.signal.removeEventListener('abort', onAbort)
      this.streamClients.delete(client)
      this.streamPids.delete(pid)
      await Promise.race([
        client.end().catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, 2_000))
      ])
    }
  }
}

/** Rows a housekeeping statement returned (SELECT only; a multi-statement text: none). */
const pgCounts = (result: QueryResult | QueryResult[]): StatementCounts =>
  Array.isArray(result) || result.command !== 'SELECT' ? {} : { rows: result.rows.length }

export function createPostgresDriver(input: DriverConnectInput): DataDriver {
  return new PostgresDriver(input)
}

/** Exposed for unit tests. */
export const __postgresInternals = { decodePgValue, isClientCopy, setsSearchPath }
