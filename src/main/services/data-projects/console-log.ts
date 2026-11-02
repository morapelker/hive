// The console log of data projects (TablePlus' Console, contract: shared/data-projects/
// console-types.ts): every statement the app sends to a project's server, kept in memory per
// project and pushed live on DATA_CONSOLE_CHANNEL.
//
// One capture point: `instrumentDriver` wraps each driver the ConnectionManager opens, so every
// path that talks to a database — the query runner, table pages and counts, grid edits, exports,
// introspection, kills, the assistant's reads, the Mongo views — is logged without each of them
// calling the log. What the wrapper sees:
//   execute / streamRows   the statement itself, with duration, rows / affected rows, error
//   introspection methods  (listDatabases, listObjects, describe, ddl, completionSchema,
//                          listProcesses, connect) the catalog statements the driver reports
//                          through `traceDriverStatement`, with their bind values written in
//                          (`TABLE_NAME = 'users'`, not `= ?`), else one summary line per call
//                          ("-- describe shop.users") so the metadata view is never blind
//   MongoDB                the wire commands themselves, from the client's command monitoring:
//                          find / aggregate / insert … as `db.runCommand({...})`, whichever view
//                          or helper sent them — while a Console tab follows the project. Without
//                          one (or without monitoring), the Shell statements as typed.
//
// Mongo command monitoring is not free: with it on, the driver turns every reply into JS objects
// a second time just to build the event (CommandSucceededEvent), which slows big finds, exports
// and getMore batches by a third or more. So it runs only while the project is watched: a
// console's list (`DataConsoleLog.list`, renewed by the open tab every 30 s: console-store's
// CONSOLE_RENEW_MS) marks the project watched for CONSOLE_WATCH_LEASE_MS, and each pooled
// connection's monitoring flag is set as it is checked out for a command
// (`MongoCommandMonitor`; the client is created with monitoring on so that a driver whose pool
// cannot be reached keeps logging, slower).
//
// Who sent a statement is an AsyncLocalStorage scope: callers wrap their work in
// `withConsoleSource('table', …)` (query runner, table-ops, export do), the wrapper opens its
// own scope around each driver call so that statements the driver runs for itself (USE, SET,
// the read-only sandbox's BEGIN, catalog queries) are filed as 'metadata', and Mongo commands
// outside any scope are classified by command name. A driver statement outside any scope (a
// test connection) is not logged.
//
// Texts go through the same masking as query history (maskForHistory: IDENTIFIED BY / PASSWORD /
// conninfo / mongosh pwd → '***') and the project's secret redactor, then are capped; errors too.
// An entry whose text was masked is flagged `masked`: it no longer is the statement that ran
// (running it would write '***'), so the console does not open it in an editor.
// Statements and metadata entries live in two ring buffers per project (DATA_CONSOLE_MAX_ENTRIES
// each), so polling the process list cannot push the user's own statements out. Nothing is
// written to disk. Live entries are batched (CONSOLE_FLUSH_MS) per project before publishing.

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  DATA_CONSOLE_CHANNEL,
  DATA_CONSOLE_MAX_ENTRIES,
  DATA_CONSOLE_MAX_TEXT,
  type DataConsoleEntry,
  type DataConsoleEvent,
  type DataConsoleListResponse,
  type DataConsoleSource,
  type DataConsoleStatus
} from '../../../shared/data-projects/console-types'
import {
  sqlDialectOf,
  type DataDatabaseInfo,
  type DataEngine,
  type DataObjectRef,
  type DataObjectsListing,
  type DataProcessInfo,
  type DataStatementOutput,
  type DataTableDetails,
  type SqlDialect
} from '../../../shared/data-projects/types'
import { lexSql } from '../../../shared/sql/lexer'
import { quoteSqlLiteral, quoteSqlString } from '../../../shared/sql/quote'
import {
  DataDriverError,
  type DataDriver,
  type DriverConnectInput,
  type DriverStatementResult
} from './contracts'
import { maskForHistory } from './query-runner'
import { errorMessage } from './redact'

/** Live entries are published at most this often per project. */
export const CONSOLE_FLUSH_MS = 60
/** Metadata entries keep less text: catalog queries are long and rarely re-run. */
const METADATA_MAX_TEXT = 4_000
/** Masked beyond the cap, so a secret the cut falls into is still masked whole. */
const MASK_SLACK = 2_048
const MAX_ERROR_TEXT = 2_000
/** Mongo commands started and not finished yet, per client (a lost reply must not leak). */
const MAX_PENDING_COMMANDS = 1_000
/** A console's list keeps its project watched (Mongo command monitoring on) this long. */
export const CONSOLE_WATCH_LEASE_MS = 90_000

/**
 * A console entry plus the flags console-types.ts may not declare yet. `masked`: literals in the
 * text were masked ('***'), so it is not the statement that ran and must not be run as it is.
 */
export type ConsoleEntry = DataConsoleEntry & { masked?: boolean }

// ---------------------------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------------------------

export interface ConsoleRecordInput {
  dataProjectId: string
  engine: DataEngine
  source: DataConsoleSource
  text: string
  database?: string | null
  /** Epoch ms the statement was sent (default: now). */
  at?: number
  durationMs?: number | null
  rows?: number | null
  affected?: number | null
  status?: DataConsoleStatus
  error?: string | null
  summary?: boolean
  /** Removes the project's known secrets (DriverConnectInput.redact). */
  redact?: (text: string) => string
}

interface ProjectLog {
  statements: DataConsoleEntry[]
  metadata: DataConsoleEntry[]
}

export interface DataConsoleLogOptions {
  /** Per project and kind (statements / metadata). */
  maxEntries?: number
  publish?: ((channel: string, payload: unknown) => void) | null
  flushMs?: number
  /** How long a list keeps the project watched (tests). */
  watchLeaseMs?: number
  /** Clock (tests). */
  now?: () => number
}

/**
 * Masks (like history) and redacts `text`, then caps it; never throws, never leaks. `masked`
 * says whether masking or redaction changed anything.
 */
function prepareText(
  engine: DataEngine,
  text: string,
  cap: number,
  redact?: (text: string) => string
): { text: string; truncated: boolean; masked: boolean } {
  let truncated = false
  let head = text
  if (head.length > cap + MASK_SLACK) {
    head = head.slice(0, cap + MASK_SLACK)
    truncated = true
  }
  let out: string
  try {
    out = maskForHistory(engine, head)
    if (redact) out = redact(out)
  } catch {
    return {
      text: '-- (text hidden: it could not be checked for secrets)',
      truncated: false,
      masked: true
    }
  }
  const masked = out !== head
  out = out.trim()
  if (out.length > cap) {
    out = out.slice(0, cap)
    truncated = true
  }
  return { text: out, truncated, masked }
}

export class DataConsoleLog {
  /** Distinguishes this process' `seq` numbers from a previous server's. */
  readonly epoch = randomUUID()
  private seq = 0
  private readonly projects = new Map<string, ProjectLog>()
  private readonly pending = new Map<string, DataConsoleEntry[]>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private publisher: ((channel: string, payload: unknown) => void) | null
  private readonly maxEntries: number
  private readonly flushMs: number
  private readonly watchLeaseMs: number
  private readonly now: () => number
  /** Per project: until when a console is taken to follow it (epoch ms). */
  private readonly watchedUntil = new Map<string, number>()

  constructor(options: DataConsoleLogOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DATA_CONSOLE_MAX_ENTRIES)
    this.publisher = options.publish ?? null
    this.flushMs = options.flushMs ?? CONSOLE_FLUSH_MS
    this.watchLeaseMs = options.watchLeaseMs ?? CONSOLE_WATCH_LEASE_MS
    this.now = options.now ?? Date.now
  }

  setPublisher(publish: ((channel: string, payload: unknown) => void) | null): void {
    this.publisher = publish
  }

  /** Stores one entry (masked, capped) and queues it for the live channel. Never throws. */
  record(input: ConsoleRecordInput): DataConsoleEntry | null {
    try {
      const metadata = input.source === 'metadata'
      const { text, truncated, masked } = prepareText(
        input.engine,
        input.text,
        metadata ? METADATA_MAX_TEXT : DATA_CONSOLE_MAX_TEXT,
        input.redact
      )
      if (!text) return null
      const error = input.error
        ? prepareText(input.engine, input.error, MAX_ERROR_TEXT, input.redact).text
        : null
      const entry: ConsoleEntry = {
        seq: ++this.seq,
        dataProjectId: input.dataProjectId,
        at: new Date(input.at ?? Date.now()).toISOString(),
        source: input.source,
        language: input.engine === 'mongodb' ? 'mongo' : 'sql',
        database: input.database || null,
        text,
        status: input.status ?? (error ? 'error' : 'ok'),
        durationMs:
          typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
            ? Math.max(0, Math.round(input.durationMs * 10) / 10)
            : null,
        rows: finiteOrNull(input.rows),
        affected: finiteOrNull(input.affected),
        error
      }
      if (truncated) entry.truncated = true
      if (masked) entry.masked = true
      if (input.summary) entry.summary = true
      let log = this.projects.get(input.dataProjectId)
      if (!log) {
        log = { statements: [], metadata: [] }
        this.projects.set(input.dataProjectId, log)
      }
      const ring = metadata ? log.metadata : log.statements
      ring.push(entry)
      if (ring.length > this.maxEntries) ring.splice(0, ring.length - this.maxEntries)
      this.queue(entry)
      return entry
    } catch {
      // The console is a diagnostic: it must never break the statement it describes.
      return null
    }
  }

  /**
   * The project's entries, oldest first (only those after `since` when given). Listing is how a
   * Console tab follows a project: it also marks the project watched for CONSOLE_WATCH_LEASE_MS
   * (the tab lists again every CONSOLE_WATCH_RENEW_MS while it is open).
   */
  list(dataProjectId: string, since?: number): DataConsoleListResponse {
    this.watch(dataProjectId)
    const log = this.projects.get(dataProjectId)
    if (!log) return { entries: [], epoch: this.epoch }
    const after = (e: DataConsoleEntry): boolean => since === undefined || e.seq > since
    const a = log.statements.filter(after)
    const b = log.metadata.filter(after)
    const entries: DataConsoleEntry[] = []
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (j >= b.length || (i < a.length && a[i].seq < b[j].seq)) entries.push(a[i++])
      else entries.push(b[j++])
    }
    return { entries, epoch: this.epoch }
  }

  /** Empties the project's log (both kinds) and tells the renderers. */
  clear(dataProjectId: string): void {
    this.projects.delete(dataProjectId)
    this.pending.delete(dataProjectId)
    this.emit({ dataProjectId, epoch: this.epoch, kind: 'cleared' })
  }

  /** A deleted project: drop its entries without an event. */
  forget(dataProjectId: string): void {
    this.projects.delete(dataProjectId)
    this.pending.delete(dataProjectId)
    this.watchedUntil.delete(dataProjectId)
  }

  /** Marks the project watched (a console follows it) for the next CONSOLE_WATCH_LEASE_MS. */
  watch(dataProjectId: string): void {
    this.watchedUntil.set(dataProjectId, this.now() + this.watchLeaseMs)
  }

  /** A console followed the project recently: costly logging (Mongo monitoring) is on. */
  isWatched(dataProjectId: string): boolean {
    const until = this.watchedUntil.get(dataProjectId)
    if (until === undefined) return false
    if (until > this.now()) return true
    this.watchedUntil.delete(dataProjectId)
    return false
  }

  /** Publishes the queued entries now (also used by tests). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const batches = [...this.pending]
    this.pending.clear()
    for (const [dataProjectId, entries] of batches) {
      this.emit({
        dataProjectId,
        epoch: this.epoch,
        kind: 'entries',
        // A burst (a long script) can exceed what anyone keeps: send only the newest.
        entries:
          entries.length > 2 * this.maxEntries ? entries.slice(-2 * this.maxEntries) : entries
      })
    }
  }

  private queue(entry: DataConsoleEntry): void {
    if (!this.publisher) return
    const list = this.pending.get(entry.dataProjectId)
    if (list) list.push(entry)
    else this.pending.set(entry.dataProjectId, [entry])
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.flushMs)
    this.timer.unref?.()
  }

  private emit(event: DataConsoleEvent): void {
    try {
      this.publisher?.(DATA_CONSOLE_CHANNEL, event)
    } catch {
      // Live delivery is best effort; the entries stay listable.
    }
  }
}

const finiteOrNull = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

let singleton: DataConsoleLog | null = null

/** The server process' console log (created on first use). */
export function getDataConsoleLog(): DataConsoleLog {
  singleton ??= new DataConsoleLog()
  return singleton
}

/** The RPC domain hands the event bus publisher over here (before or after first use). */
export function setDataConsolePublisher(
  publish: ((channel: string, payload: unknown) => void) | null
): void {
  getDataConsoleLog().setPublisher(publish)
}

/** Tests only. */
export function resetDataConsoleLogForTests(): void {
  singleton = null
}

// ---------------------------------------------------------------------------------------------
// Scopes: who sent a statement
// ---------------------------------------------------------------------------------------------

type ConsoleScope =
  /** Set by the code that drives a connection (query runner, table-ops, export). */
  | { kind: 'caller'; source: DataConsoleSource }
  /** Set by the instrumented driver around one driver call. */
  | {
      kind: 'driver'
      /** Source of statements the driver reports from inside the call. */
      source: DataConsoleSource
      /** Source of the caller around the call. */
      callerSource: DataConsoleSource
      /** The statement the wrapper logs itself (a driver report of it is not logged twice). */
      mainText: string | null
      /** Statements reported / commands seen during the call. */
      reported: number
      /** How bind values are written into reported statements (null: Mongo). */
      dialect: SqlDialect | null
      record(input: Omit<ConsoleRecordInput, 'dataProjectId' | 'engine' | 'redact'>): void
    }

const consoleScope = new AsyncLocalStorage<ConsoleScope>()

/**
 * Runs `fn` with `source` as the console source of every statement it sends through an
 * instrumented driver (the query runner passes 'query', table pages 'table', exports 'export').
 */
export function withConsoleSource<T>(source: DataConsoleSource, fn: () => T): T {
  return consoleScope.run({ kind: 'caller', source }, fn)
}

/** The console source the current caller asked for ('other' outside any scope). */
const currentCallerSource = (): DataConsoleSource => {
  const scope = consoleScope.getStore()
  if (!scope) return 'other'
  return scope.kind === 'caller' ? scope.source : scope.callerSource
}

export interface StatementCounts {
  rows?: number | null
  affected?: number | null
}

const isCancelled = (error: unknown): boolean =>
  (error instanceof DataDriverError && error.cancelled) ||
  (error as { name?: unknown } | null)?.name === 'AbortError'

const statusOf = (error: unknown): DataConsoleStatus => (isCancelled(error) ? 'cancelled' : 'error')

/**
 * For drivers: runs one statement the driver sends for itself (a catalog query, `USE`, `SET`,
 * the sandbox's BEGIN READ ONLY …) and logs it as part of the driver call around it — as
 * 'metadata' inside introspection and execute, as 'admin' inside a kill. `values` are the
 * statement's bind values: the log shows them in place of the placeholders (see
 * `inlineBindValues`), so an entry says which object it read. Outside an instrumented call it
 * just runs `run`.
 */
export async function traceDriverStatement<T>(
  sql: string,
  run: () => Promise<T>,
  measure?: (result: T) => StatementCounts,
  values?: readonly unknown[]
): Promise<T> {
  const scope = consoleScope.getStore()
  if (scope?.kind !== 'driver' || !sql.trim() || sql.trim() === scope.mainText?.trim()) {
    return run()
  }
  scope.reported++
  let text = sql
  if (values && values.length > 0) {
    try {
      text = inlineBindValues(sql, values, scope.dialect)
    } catch {
      text = sql
    }
  }
  const at = Date.now()
  const started = performance.now()
  try {
    const result = await run()
    let counts: StatementCounts = {}
    try {
      counts = measure?.(result) ?? {}
    } catch {
      // Counting is cosmetic.
    }
    scope.record({
      source: scope.source,
      text,
      at,
      durationMs: performance.now() - started,
      status: 'ok',
      ...counts
    })
    return result
  } catch (error) {
    scope.record({
      source: scope.source,
      text,
      at,
      durationMs: performance.now() - started,
      status: statusOf(error),
      error: errorMessage(error)
    })
    throw error
  }
}

/** A bind value as a SQL literal of `dialect`, or null when it has no faithful one. */
function bindLiteral(value: unknown, dialect: SqlDialect): string | null {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'string' || typeof value === 'boolean')
    return quoteSqlLiteral(value, dialect)
  if (typeof value === 'number') {
    return Number.isFinite(value) ? quoteSqlLiteral(value, dialect) : null
  }
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : quoteSqlString(value.toISOString(), dialect)
  }
  if (Array.isArray(value) && dialect === 'postgres') return pgArrayLiteral(value)
  if (Array.isArray(value) && (dialect === 'mysql' || dialect === 'mariadb')) {
    // mysql2 writes an array as a list (`IN (?)`), a nested one as grouped lists.
    const items = value.map((item) =>
      Array.isArray(item) ? groupLiteral(item, dialect) : bindLiteral(item, dialect)
    )
    return items.every((item) => item !== null) && items.length > 0 ? items.join(', ') : null
  }
  return null
}

/** A one-dimensional array of numbers / strings / NULLs as PostgreSQL text ('{1,"a b",NULL}'). */
function pgArrayLiteral(values: unknown[]): string | null {
  const items: string[] = []
  for (const item of values) {
    if (item === null || item === undefined) items.push('NULL')
    else if (typeof item === 'number' && Number.isFinite(item)) items.push(String(item))
    else if (typeof item === 'bigint') items.push(item.toString())
    else if (typeof item === 'string') items.push(`"${item.replace(/[\\"]/g, '\\$&')}"`)
    else return null
  }
  return quoteSqlString(`{${items.join(',')}}`, 'postgres')
}

const groupLiteral = (values: unknown[], dialect: SqlDialect): string | null => {
  const items = values.map((item) => bindLiteral(item, dialect))
  return items.every((item) => item !== null) ? `(${items.join(', ')})` : null
}

/**
 * `sql` with its bind values written in place of the placeholders (`?` for MySQL / MariaDB /
 * SQLite, `$n` for PostgreSQL, found by the shared lexer: never inside strings or comments), as
 * literals of the dialect. When a value or a placeholder has no faithful text, the statement is
 * kept as sent and the values follow it in a `-- params:` comment.
 */
export function inlineBindValues(
  sql: string,
  values: readonly unknown[],
  dialect: SqlDialect | null
): string {
  if (values.length === 0) return sql
  if (dialect) {
    const lexed = lexSql(sql, dialect)
    if (!lexed.error) {
      const parts: string[] = []
      let last = 0
      let positional = 0
      let complete = true
      for (const token of lexed.tokens) {
        if (token.type !== 'parameter') continue
        let index = -1
        if (token.text === '?' && dialect !== 'postgres' && dialect !== 'clickhouse')
          index = positional++
        else if (dialect === 'postgres' && /^\$\d+$/.test(token.text))
          index = Number(token.text.slice(1)) - 1
        else if (dialect === 'sqlite' && /^\?\d+$/.test(token.text))
          index = Number(token.text.slice(1)) - 1
        const literal =
          index >= 0 && index < values.length ? bindLiteral(values[index], dialect) : null
        if (literal === null) {
          complete = false
          break
        }
        parts.push(sql.slice(last, token.start), literal)
        last = token.end
      }
      if (complete && parts.length > 0) {
        parts.push(sql.slice(last))
        return parts.join('')
      }
    }
  }
  const shown = values.map((value) => {
    const literal = dialect ? bindLiteral(value, dialect) : null
    if (literal !== null) return literal
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  })
  return `${sql}\n-- params: ${shown.join(', ')}`
}

// ---------------------------------------------------------------------------------------------
// Instrumented drivers
// ---------------------------------------------------------------------------------------------

const INSTRUMENTED = Symbol.for('hive.dataConsole.instrumented')

/** Rows returned / rows affected of a driver result (all its result sets). */
export function resultCounts(
  outputs: ReadonlyArray<DataStatementOutput | null | undefined>
): StatementCounts {
  let rows: number | null = null
  let affected: number | null = null
  for (const output of outputs) {
    if (!output) continue
    if (output.kind === 'rows') rows = (rows ?? 0) + output.rows.length
    else if (output.kind === 'documents') rows = (rows ?? 0) + output.documents.length
    else if (output.kind === 'command' && typeof output.affectedRows === 'number')
      affected = (affected ?? 0) + output.affectedRows
  }
  return { rows, affected }
}

const refName = (ref: DataObjectRef | undefined): string =>
  ref ? [ref.database, ref.schema, ref.name].filter(Boolean).join('.') : ''

/** Introspection calls: their summary line (when the driver reports nothing) and row count. */
const INTROSPECTION: Record<
  string,
  { describe: (args: unknown[]) => string; count?: (result: unknown) => number | null }
> = {
  connect: { describe: () => 'connect' },
  listDatabases: {
    describe: () => 'list databases',
    count: (r) => (Array.isArray(r) ? (r as DataDatabaseInfo[]).length : null)
  },
  listObjects: {
    describe: ([database, schema]) => {
      const where = [database, schema].filter(Boolean).join('.')
      return where ? `list objects of ${where}` : 'list objects'
    },
    count: (r) => (r as DataObjectsListing | null)?.objects?.length ?? null
  },
  describe: {
    describe: ([ref]) => `describe ${refName(ref as DataObjectRef)}`,
    count: (r) => (r as DataTableDetails | null)?.columns?.length ?? null
  },
  ddl: { describe: ([ref]) => `DDL of ${refName(ref as DataObjectRef)}` },
  completionSchema: {
    describe: ([database]) =>
      typeof database === 'string' && database
        ? `load the autocomplete schema of ${database}`
        : 'load the autocomplete schema'
  },
  listProcesses: {
    describe: () => 'list processes',
    count: (r) => (Array.isArray(r) ? (r as DataProcessInfo[]).length : null)
  }
}

/** Mongo driver helpers that read catalog / sample data for the views (no summary line). */
const MONGO_METADATA_HELPERS = new Set(['sampleDocuments', 'collectionInfo'])

/**
 * Wraps a driver so every statement it sends is logged for the project in `input`. Idempotent;
 * methods it does not log pass through bound to the driver itself (the driver's own internal
 * calls never go through the wrapper). Wrap only drivers of real data projects (the
 * ConnectionManager's), not test connections.
 */
export function instrumentDriver<D extends DataDriver>(
  driver: D,
  input: Pick<DriverConnectInput, 'project' | 'redact' | 'database'>,
  log: DataConsoleLog = getDataConsoleLog()
): D {
  if ((driver as unknown as Record<symbol, unknown>)[INSTRUMENTED]) return driver
  const projectId = input.project.id
  const engine = input.project.engine
  const mongo = engine === 'mongodb'
  const comment = mongo ? '//' : '--'
  const dialect = sqlDialectOf(engine)

  const record = (entry: Omit<ConsoleRecordInput, 'dataProjectId' | 'engine' | 'redact'>): void => {
    log.record({ ...entry, dataProjectId: projectId, engine, redact: input.redact })
  }

  const sessionDatabase = (): string | undefined => {
    try {
      return driver.isConnected() ? driver.sessionState().currentDatabase : undefined
    } catch {
      return undefined
    }
  }
  const databaseOf = (requested?: string): string | null =>
    requested || sessionDatabase() || input.database || input.project.config.database || null

  const monitor = mongo ? new MongoCommandMonitor(record, () => log.isWatched(projectId)) : null
  /** Mongo commands are logged by command monitoring: the wrapper does not log statements. */
  const commandsLogged = (): boolean => monitor?.logging() === true

  const driverScope = (
    source: DataConsoleSource,
    callerSource: DataConsoleSource,
    mainText: string | null
  ): Extract<ConsoleScope, { kind: 'driver' }> => ({
    kind: 'driver',
    source,
    callerSource,
    mainText,
    reported: 0,
    dialect,
    record
  })

  /** execute / streamRows: one logged statement (SQL; Mongo without command monitoring). */
  const logStatement = async <R>(
    statement: string,
    database: string | null,
    run: () => Promise<R>,
    counts: (result: R) => StatementCounts,
    textOf: (result: R) => string = () => statement
  ): Promise<R> => {
    const source = currentCallerSource()
    if (commandsLogged()) {
      // The wire commands are the statements; housekeeping ones are filed as metadata.
      return consoleScope.run(driverScope(source, source, null), run)
    }
    const at = Date.now()
    const started = performance.now()
    try {
      const result = await consoleScope.run(driverScope('metadata', source, statement), run)
      let measured: StatementCounts = {}
      try {
        measured = counts(result)
      } catch {
        // Counting is cosmetic.
      }
      record({
        source,
        text: textOf(result),
        database,
        at,
        durationMs: performance.now() - started,
        status: 'ok',
        ...measured
      })
      return result
    } catch (error) {
      record({
        source,
        text: statement,
        database,
        at,
        durationMs: performance.now() - started,
        status: statusOf(error),
        error: errorMessage(error)
      })
      throw error
    }
  }

  /**
   * A driver call whose own statements are reported by the driver (or, for Mongo, seen on the
   * wire); `summary` adds a one-line description when nothing was reported.
   */
  const scoped = async <R>(
    source: DataConsoleSource,
    run: () => Promise<R>,
    summary?: { text: string; count?: (result: R) => number | null }
  ): Promise<R> => {
    const scope = driverScope(source, currentCallerSource(), null)
    const at = Date.now()
    const started = performance.now()
    try {
      const result = await consoleScope.run(scope, run)
      if (summary && scope.reported === 0) {
        let rows: number | null = null
        try {
          rows = summary.count?.(result) ?? null
        } catch {
          rows = null
        }
        record({
          source,
          text: `${comment} ${summary.text}`,
          database: databaseOf(),
          at,
          durationMs: performance.now() - started,
          status: 'ok',
          rows,
          summary: true
        })
      }
      return result
    } catch (error) {
      if (summary && scope.reported === 0) {
        record({
          source,
          text: `${comment} ${summary.text}`,
          database: databaseOf(),
          at,
          durationMs: performance.now() - started,
          status: statusOf(error),
          error: errorMessage(error),
          summary: true
        })
      }
      throw error
    }
  }

  const attachMonitor = async (): Promise<void> => {
    if (!monitor) return
    try {
      const getClient = (driver as unknown as { getClient?: () => Promise<unknown> }).getClient
      if (typeof getClient === 'function') monitor.attach(await getClient.call(driver))
    } catch {
      // Not connected after all: the next getClient() attaches.
    }
  }

  const wrapped: Record<string, (...args: never[]) => unknown> = {
    execute: (statement: string, options: Parameters<DataDriver['execute']>[1]) =>
      logStatement<DriverStatementResult>(
        statement,
        databaseOf(options?.database),
        () => driver.execute(statement, options),
        (r) => resultCounts([r.output, ...(r.moreOutputs ?? [])]),
        (r) => r.executedText || statement
      ),
    streamRows: (
      statement: string,
      options: Parameters<DataDriver['streamRows']>[1],
      onBatch: Parameters<DataDriver['streamRows']>[2]
    ) =>
      logStatement(
        statement,
        databaseOf(options?.database),
        () => driver.streamRows(statement, options, onBatch),
        (r) => ({ rows: r.rows })
      ),
    connect: async () => {
      const result = await scoped('metadata', () => driver.connect(), {
        text: INTROSPECTION.connect.describe([])
      })
      await attachMonitor()
      return result
    },
    killProcess: (processId: string, scope: string) =>
      scoped('admin', () => driver.killProcess(processId, scope as 'query' | 'connection'), {
        text: `kill ${scope} ${processId}`
      }),
    cancelCurrent: () => scoped('admin', () => driver.cancelCurrent())
  }
  for (const [method, info] of Object.entries(INTROSPECTION)) {
    if (method === 'connect') continue
    wrapped[method] = (...args: unknown[]) =>
      scoped(
        'metadata',
        () =>
          (driver as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method](
            ...args
          ),
        { text: info.describe(args), count: info.count }
      )
  }
  if (mongo) {
    wrapped.getClient = async () => {
      const client = await (driver as unknown as { getClient(): Promise<unknown> }).getClient()
      monitor?.attach(client)
      return client
    }
    for (const method of MONGO_METADATA_HELPERS) {
      wrapped[method] = (...args: unknown[]) =>
        scoped('metadata', () =>
          (driver as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method](
            ...args
          )
        )
    }
  }

  // Everything else runs on the driver itself (bound once per method).
  const bound = new WeakMap<object, unknown>()
  return new Proxy(driver, {
    get(target, prop) {
      if (prop === INSTRUMENTED) return true
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(wrapped, prop)) {
        return typeof (target as unknown as Record<string, unknown>)[prop] === 'function'
          ? wrapped[prop]
          : undefined
      }
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      let fn = bound.get(value)
      if (!fn) {
        fn = (value as (...a: unknown[]) => unknown).bind(target)
        bound.set(value, fn)
      }
      return fn
    }
  })
}

// ---------------------------------------------------------------------------------------------
// MongoDB command monitoring
// ---------------------------------------------------------------------------------------------

/** Handshake / auth / session bookkeeping: never logged. */
const MONGO_IGNORED = new Set([
  'hello',
  'isMaster',
  'ismaster',
  'saslStart',
  'saslContinue',
  'authenticate',
  'getnonce',
  'endSessions'
])
/** Cursor housekeeping of a logged find / aggregate: metadata whoever sent it. */
const MONGO_HOUSEKEEPING = new Set(['getMore', 'killCursors'])
/** Catalog / status commands: metadata unless a caller scope says otherwise. */
const MONGO_METADATA_COMMANDS = new Set([
  'listDatabases',
  'listCollections',
  'listIndexes',
  'collStats',
  'dbStats',
  'buildInfo',
  'ping',
  'serverStatus',
  'connectionStatus',
  'hostInfo',
  'getParameter',
  'getCmdLineOpts',
  'currentOp',
  'replSetGetStatus',
  'usersInfo',
  'rolesInfo'
])
/** Envelope fields the driver adds to every command: noise in a log. */
const MONGO_ENVELOPE = new Set([
  '$db',
  'lsid',
  '$clusterTime',
  '$readPreference',
  'txnNumber',
  'autocommit',
  'startTransaction',
  'apiVersion',
  'apiStrict',
  'apiDeprecationErrors'
])

interface MongoCommandEventLike {
  commandName: string
  requestId: number
  connectionId?: string | number
  address?: string
  databaseName?: string
  command?: Record<string, unknown>
  duration?: number
  reply?: unknown
  failure?: unknown
}

interface StartedCommand {
  at: number
  source: DataConsoleSource
  text: string
  summary: boolean
  database: string | null
}

const numberOf = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    const n = (value as { toNumber(): number }).toNumber()
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Documents returned / written according to a command reply. */
export function mongoReplyCounts(commandName: string, reply: unknown): StatementCounts {
  if (!reply || typeof reply !== 'object') return {}
  const r = reply as Record<string, unknown>
  const cursor = r.cursor as { firstBatch?: unknown; nextBatch?: unknown } | undefined
  if (cursor && typeof cursor === 'object') {
    const batch = cursor.firstBatch ?? cursor.nextBatch
    return { rows: Array.isArray(batch) ? batch.length : null }
  }
  switch (commandName) {
    case 'insert':
    case 'delete':
      return { affected: numberOf(r.n) }
    case 'update':
      return { affected: numberOf(r.nModified) ?? numberOf(r.n) }
    case 'findAndModify': {
      const last = r.lastErrorObject as { n?: unknown } | undefined
      return { rows: r.value ? 1 : 0, affected: numberOf(last?.n) }
    }
    case 'distinct':
      return { rows: Array.isArray(r.values) ? r.values.length : null }
    default:
      return {}
  }
}

/** What the monitor reaches inside a MongoClient (mongodb 7.x internals, checked at runtime). */
interface PooledConnectionLike {
  id?: unknown
  monitorCommands?: unknown
}
interface MongoServerLike {
  pool?: { checkedOut?: unknown }
}

/** The client's servers by address, or null when the driver is not built as expected. */
function mongoServers(client: object): Map<string, MongoServerLike> | null {
  const servers = (client as { topology?: { s?: { servers?: unknown } } }).topology?.s?.servers
  return servers instanceof Map ? (servers as Map<string, MongoServerLike>) : null
}

/**
 * Logs a MongoClient's commands from its command monitoring events, only while the project is
 * watched. The driver decides per pooled connection whether to emit events (its
 * `monitorCommands` flag, copied from the client options when the connection is made): the
 * monitor sets that flag on each connection as the pool checks it out for an operation — before
 * any command is sent on it — to whether a console follows the project. Unwatched, the driver
 * then skips the events and the second decoding of every reply that comes with them.
 * Without reachable pool internals the client's own setting stays in force on every connection.
 */
class MongoCommandMonitor {
  /** Command events are emitted (the client was created with monitorCommands). */
  active = false
  /** Monitoring follows the watch per connection; false: always as the client was created. */
  private toggling = false
  private readonly attached = new WeakSet<object>()
  private readonly started = new Map<string, StartedCommand>()

  constructor(
    private readonly record: (
      entry: Omit<ConsoleRecordInput, 'dataProjectId' | 'engine' | 'redact'>
    ) => void,
    private readonly watched: () => boolean = () => true
  ) {}

  /** Commands are being logged from events now (the wrapper does not log the statements). */
  logging(): boolean {
    return this.active && (!this.toggling || this.watched())
  }

  attach(client: unknown): void {
    if (!client || typeof client !== 'object' || this.attached.has(client)) return
    const c = client as {
      on?: (event: string, listener: (e: MongoCommandEventLike) => void) => unknown
      options?: { monitorCommands?: boolean }
      monitorCommands?: boolean
    }
    if (typeof c.on !== 'function') return
    this.attached.add(client)
    this.active = c.options?.monitorCommands === true || c.monitorCommands === true
    if (!this.active) return
    this.toggling = mongoServers(client) !== null
    if (this.toggling) {
      c.on('connectionCheckedOut', (e) => this.onCheckedOut(client, e))
    }
    c.on('commandStarted', (e) => this.onStarted(e))
    c.on('commandSucceeded', (e) => this.onFinished(e, false))
    c.on('commandFailed', (e) => this.onFinished(e, true))
  }

  /** Sets the connection's event flag before the operation it was checked out for runs. */
  private onCheckedOut(client: object, e: MongoCommandEventLike): void {
    try {
      const checkedOut = mongoServers(client)?.get(String(e.address ?? ''))?.pool?.checkedOut
      if (!(checkedOut instanceof Set)) return
      const on = this.watched()
      for (const connection of checkedOut as Set<PooledConnectionLike>) {
        if (connection?.id !== e.connectionId) continue
        if (typeof connection.monitorCommands === 'boolean' && connection.monitorCommands !== on)
          connection.monitorCommands = on
        return
      }
    } catch {
      // Never disturb the driver's event loop.
    }
  }

  private key(e: MongoCommandEventLike): string {
    return `${String(e.connectionId ?? e.address ?? '')}:${e.requestId}`
  }

  private onStarted(e: MongoCommandEventLike): void {
    try {
      const name = e.commandName
      // A connection flagged before the watch ended: the wrapper logs the statements now.
      if (MONGO_IGNORED.has(name) || !this.logging()) return
      const scope = consoleScope.getStore()
      let source: DataConsoleSource
      if (MONGO_HOUSEKEEPING.has(name)) source = 'metadata'
      else if (scope) source = scope.source
      else if (MONGO_METADATA_COMMANDS.has(name)) source = 'metadata'
      else source = name === 'killOp' ? 'admin' : 'mongo'
      if (scope?.kind === 'driver') scope.reported++
      const { text, summary } = mongoCommandText(
        name,
        e.command ?? {},
        source === 'metadata' ? METADATA_MAX_TEXT : DATA_CONSOLE_MAX_TEXT
      )
      if (this.started.size >= MAX_PENDING_COMMANDS) {
        const oldest = this.started.keys().next().value
        if (oldest !== undefined) this.started.delete(oldest)
      }
      this.started.set(this.key(e), {
        at: Date.now(),
        source,
        text,
        summary,
        database: e.databaseName ?? null
      })
    } catch {
      // Never disturb the driver's event loop.
    }
  }

  private onFinished(e: MongoCommandEventLike, failed: boolean): void {
    const key = this.key(e)
    const started = this.started.get(key)
    if (!started) return
    this.started.delete(key)
    try {
      const failure = e.failure as { code?: unknown; codeName?: unknown; name?: unknown } | null
      const cancelled =
        failed &&
        (failure?.code === 11601 ||
          failure?.codeName === 'Interrupted' ||
          failure?.name === 'MongoAbortError')
      this.record({
        source: started.source,
        text: started.text,
        database: started.database,
        at: started.at,
        durationMs: typeof e.duration === 'number' ? e.duration : null,
        status: failed ? (cancelled ? 'cancelled' : 'error') : 'ok',
        error: failed ? errorMessage(e.failure) : null,
        summary: started.summary,
        ...(failed ? {} : mongoReplyCounts(e.commandName, e.reply))
      })
    } catch {
      // Never disturb the driver's event loop.
    }
  }
}

/**
 * A command document as a runnable mongosh line, `db.runCommand({ find: "orders", … })`, cut
 * at `limit` characters. The driver hands sensitive commands (createUser, auth…) over empty:
 * those become a summary line without arguments.
 */
export function mongoCommandText(
  commandName: string,
  command: Record<string, unknown>,
  limit: number = DATA_CONSOLE_MAX_TEXT
): { text: string; summary: boolean } {
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(command)) {
    if (MONGO_ENVELOPE.has(key)) continue
    // The executor tags operations for killOp: an id, not something the user wrote.
    if (key === 'comment' && typeof value === 'string' && value.startsWith('hive:')) continue
    body[key] = value
  }
  if (Object.keys(body).length === 0) {
    return {
      text: `// ${commandName} (arguments not shown: they carry credentials)`,
      summary: true
    }
  }
  const out = new BoundedText(limit)
  out.write('db.runCommand(')
  writeMongoValue(body, out, 0)
  out.write(')')
  return { text: out.toString(), summary: false }
}

class BoundedText {
  private readonly parts: string[] = []
  private length = 0
  full = false

  constructor(private readonly limit: number) {}

  get remaining(): number {
    return Math.max(0, this.limit - this.length)
  }

  write(text: string): void {
    if (this.full) return
    if (this.length + text.length > this.limit) {
      this.parts.push(text.slice(0, this.limit - this.length), '…')
      this.length = this.limit
      this.full = true
      return
    }
    this.parts.push(text)
    this.length += text.length
  }

  toString(): string {
    return this.parts.join('')
  }
}

const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/

function writeMongoValue(value: unknown, out: BoundedText, depth: number): void {
  if (out.full) return
  if (value === null) return out.write('null')
  if (value === undefined) return out.write('undefined')
  switch (typeof value) {
    case 'string':
      // Never stringify a 16 MB string just to cut it.
      return out.write(
        JSON.stringify(value.length > out.remaining ? value.slice(0, out.remaining + 1) : value)
      )
    case 'number':
      return out.write(
        Number.isFinite(value)
          ? String(value)
          : Number.isNaN(value)
            ? 'NaN'
            : value > 0
              ? 'Infinity'
              : '-Infinity'
      )
    case 'bigint':
      return out.write(`NumberLong("${value.toString()}")`)
    case 'boolean':
      return out.write(String(value))
    case 'object':
      break
    default:
      return out.write('undefined')
  }
  if (depth > 32) return out.write('…')
  if (value instanceof Date) {
    return out.write(
      Number.isNaN(value.getTime()) ? 'ISODate("invalid")' : `ISODate("${value.toISOString()}")`
    )
  }
  if (value instanceof RegExp) return out.write(`/${value.source}/${value.flags}`)
  if (value instanceof Uint8Array) return out.write(binData(0, value, out.remaining))
  const bsonType = (value as { _bsontype?: unknown })._bsontype
  if (typeof bsonType === 'string') return out.write(bsonText(bsonType, value, out.remaining))
  if (Array.isArray(value)) {
    out.write('[')
    value.forEach((item, i) => {
      if (i > 0) out.write(', ')
      writeMongoValue(item, out, depth + 1)
    })
    return out.write(']')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return out.write('{}')
  out.write('{ ')
  entries.forEach(([key, item], i) => {
    if (i > 0) out.write(', ')
    out.write(IDENTIFIER_KEY.test(key) ? key : JSON.stringify(key))
    out.write(': ')
    writeMongoValue(item, out, depth + 1)
  })
  out.write(' }')
}

const binData = (subtype: number, bytes: Uint8Array, budget: number): string => {
  // Base64 is 4/3 the size: encode only what can be shown.
  const take = Math.max(0, Math.min(bytes.length, Math.ceil((budget * 3) / 4)))
  const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, take).toString('base64')
  return `BinData(${subtype}, "${base64}${take < bytes.length ? '…' : ''}")`
}

function bsonText(type: string, value: unknown, budget: number): string {
  const v = value as Record<string, unknown> & { toString(encoding?: string): string }
  try {
    switch (type) {
      case 'ObjectId':
      case 'ObjectID': {
        const hex =
          typeof v.toHexString === 'function'
            ? (v.toHexString as () => string)()
            : v.toString('hex')
        return `ObjectId("${hex}")`
      }
      case 'Long':
        return `NumberLong("${v.toString()}")`
      case 'Int32':
      case 'Double':
        return String(numberOf((v as { value?: unknown }).value) ?? v.toString())
      case 'Decimal128':
        return `NumberDecimal("${v.toString()}")`
      case 'Binary': {
        const subtype = typeof v.sub_type === 'number' ? v.sub_type : 0
        const bytes = v.buffer instanceof Uint8Array ? v.buffer : new Uint8Array()
        if (subtype === 4 && bytes.length === 16 && typeof v.toUUID === 'function') {
          return `UUID("${String((v.toUUID as () => unknown)())}")`
        }
        return binData(subtype, bytes, budget)
      }
      case 'Timestamp': {
        const t = numberOf(v.t) ?? numberOf(v.high)
        const i = numberOf(v.i) ?? numberOf(v.low)
        return `Timestamp({ t: ${t ?? 0}, i: ${i ?? 0} })`
      }
      case 'MinKey':
        return 'MinKey()'
      case 'MaxKey':
        return 'MaxKey()'
      case 'BSONRegExp':
        return `RegExp(${JSON.stringify(String(v.pattern ?? ''))}, ${JSON.stringify(String(v.options ?? ''))})`
      case 'Code':
        return `Code(${JSON.stringify(String(v.code ?? ''))})`
      case 'BSONSymbol':
        return JSON.stringify(String(v.value ?? ''))
      case 'DBRef': {
        const inner = new BoundedText(budget)
        writeMongoValue(v.oid, inner, 1)
        return `DBRef(${JSON.stringify(String(v.collection ?? ''))}, ${inner.toString()})`
      }
      default:
        return `${type}("${v.toString()}")`
    }
  } catch {
    return `${type}()`
  }
}
