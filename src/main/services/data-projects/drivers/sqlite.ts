// SQLite DataDriver. better-sqlite3 is synchronous and cannot be interrupted, so the driver
// never runs user SQL on the server's event loop (when bundled): every connection is a forked
// child process speaking the protocol of ./sqlite-worker.ts.
//
//   session  the user's sticky connection (temp tables, BEGIN…COMMIT, ATTACH, PRAGMAs). Cancel
//            and statement timeouts SIGKILL it and respawn a fresh one (re-ATTACHing what was
//            attached); the journal/WAL rolls the killed statement back. What could not
//            survive (open transaction, temp objects) is reported as a notice.
//   control  lazily spawned, PRAGMA query_only=ON: schema tree, describe, DDL, autocomplete and
//            AI tools stay responsive while the session grinds through a long query. It mirrors
//            the session's ATTACHes before each call; the temp schema is only visible to the
//            session, so `temp` introspection goes there.
//   export   one more child per streamRows call (an open iterator pins its connection), killed
//            when the export is cancelled.
//
// Outside the server bundle (vitest, unbundled dev runs) there is no entry to fork, so the
// same SqliteSession runs in-process: identical results, no real cancel or timeout.

import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import {
  DATA_HARD_ROW_CAP,
  type DataCell,
  type DataCompletionSchema,
  type DataDatabaseInfo,
  type DataKillScope,
  type DataObjectInfo,
  type DataObjectRef,
  type DataObjectsListing,
  type DataProcessInfo,
  type DataStatementOutput,
  type DataTableDetails
} from '../../../../shared/data-projects/types'
import { hasUserLimit, quoteSqlIdentifier } from '../../../../shared/sql'
import {
  DataDriverError,
  type DataDriver,
  type DriverConnectInput,
  type DriverExecuteOptions,
  type DriverStatementResult
} from '../contracts'
import {
  SQLITE_WORKER_ENV,
  SqliteSession,
  toSqliteWorkerError,
  type SqliteCompletionSnapshot,
  type SqliteExecParams,
  type SqliteExecResult,
  type SqliteIntrospectQuery,
  type SqliteOpenParams,
  type SqliteOpenResult,
  type SqliteSessionState,
  type SqliteStreamParams,
  type SqliteWorkerError,
  type SqliteWorkerMessage,
  type SqliteWorkerRequest
} from './sqlite-worker'

export type SqliteWorkerMode = 'child' | 'in-process'

export interface SqliteDriverOptions {
  /** Default: 'child' inside the server bundle, 'in-process' elsewhere (see defaultSqliteWorkerMode). */
  mode?: SqliteWorkerMode
  /** Script the child runs. Default: process.argv[1] (the server bundle, which dispatches on the env flag). */
  workerEntry?: string
  /** Runtime for the child. Default: process.execPath (Electron with ELECTRON_RUN_AS_NODE=1). */
  execPath?: string
  /** Extra environment for the child. */
  env?: Record<string, string | undefined>
  /** How long a child may take to load and say ready, ms. */
  startTimeoutMs?: number
  /** SQLite busy timeout, ms. */
  busyTimeoutMs?: number
}

const DEFAULT_START_TIMEOUT_MS = 30_000
const DEFAULT_BUSY_TIMEOUT_MS = 5_000
const CLOSE_GRACE_MS = 2_000
const STREAM_BATCH_ROWS = 1_000
const COMPLETION_MAX_TABLES = 2_000
const STDERR_TAIL_CHARS = 4_000
const QUERY_PREVIEW_CHARS = 4_000

/**
 * The child can only be forked when this process IS the server bundle: bin.ts re-enters the
 * worker loop from process.argv[1] when TEDOOO_DATA_SQLITE_WORKER=1. vitest, ts runners and the
 * Electron main process have no such entry.
 */
export function defaultSqliteWorkerMode(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv
): SqliteWorkerMode {
  const entry = argv[1] ?? ''
  const bundled = /(?:^|[\\/])server\.js$/.test(entry) || /[\\/]server[\\/]bin\.js$/.test(entry)
  return env.HIVE_SERVER_MODE && bundled ? 'child' : 'in-process'
}

/** config.filePath → absolute path ('~' expanded) or ':memory:'. */
export function resolveSqlitePath(filePath: string | undefined): string {
  const raw = (filePath ?? '').trim()
  if (!raw) {
    throw new DataDriverError('No SQLite database file is configured for this project.', {
      code: 'SQLITE_CANTOPEN',
      hint: 'Edit the connection and choose a database file.'
    })
  }
  if (raw === ':memory:') return raw
  let path = raw
  if (path === '~') path = homedir()
  else if (path.startsWith('~/')) path = join(homedir(), path.slice(2))
  if (!isAbsolute(path)) {
    throw new DataDriverError(`The SQLite file path must be absolute: ${raw}`, {
      code: 'SQLITE_CANTOPEN',
      hint: 'Edit the connection and choose the file with the file picker.'
    })
  }
  return resolvePath(path)
}

const toDriverError = (
  error: SqliteWorkerError,
  redact: (text: string) => string
): DataDriverError =>
  new DataDriverError(redact(error.message), {
    code: error.code,
    position: error.position,
    hint: error.hint ? redact(error.hint) : undefined,
    sandboxRejected: error.sandboxRejected
  })

// ---------------------------------------------------------------------------------------------
// Transports: where a SqliteSession runs
// ---------------------------------------------------------------------------------------------

interface SqliteTransport {
  readonly kind: SqliteWorkerMode
  readonly pid: number | null
  readonly alive: boolean
  open(params: SqliteOpenParams): Promise<SqliteOpenResult>
  exec(params: SqliteExecParams): Promise<SqliteExecResult>
  introspect<T>(query: SqliteIntrospectQuery): Promise<T>
  stream(
    params: SqliteStreamParams,
    onBatch: (columns: string[], rows: DataCell[][]) => Promise<void>
  ): Promise<{ rows: number }>
  /** Hard-stops whatever runs (child: SIGKILL). False when that is impossible (in-process). */
  kill(reason: 'cancel' | 'timeout'): boolean
  close(): Promise<void>
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Runs the session on this event loop (tests, unbundled runs). Nothing here can interrupt it. */
class InProcessSqliteTransport implements SqliteTransport {
  readonly kind = 'in-process' as const
  readonly pid = null
  private readonly session = new SqliteSession()
  private closed = false

  constructor(private readonly redact: (text: string) => string) {}

  get alive(): boolean {
    return !this.closed
  }

  private async run<T>(fn: () => T | Promise<T>, sql?: string, sandbox = false): Promise<T> {
    if (this.closed)
      throw new DataDriverError('The SQLite connection is closed.', { code: 'SQLITE_MISUSE' })
    // Let the caller's bookkeeping (running statement, timers) settle before blocking the loop.
    await nextTurn()
    try {
      return await fn()
    } catch (error) {
      // Errors of an export consumer (cancel, failed write) pass through unchanged.
      if (error instanceof DataDriverError) throw error
      throw toDriverError(toSqliteWorkerError(error, sql, sandbox), this.redact)
    }
  }

  open(params: SqliteOpenParams): Promise<SqliteOpenResult> {
    return this.run(() => this.session.open(params))
  }

  exec(params: SqliteExecParams): Promise<SqliteExecResult> {
    return this.run(() => this.session.exec(params), params.sql, params.sandbox)
  }

  introspect<T>(query: SqliteIntrospectQuery): Promise<T> {
    return this.run(() => this.session.introspect(query) as T)
  }

  stream(
    params: SqliteStreamParams,
    onBatch: (columns: string[], rows: DataCell[][]) => Promise<void>
  ): Promise<{ rows: number }> {
    return this.run(
      () =>
        this.session.stream(params, async (columns, rows) => {
          await onBatch(columns, rows)
          // Give the rest of the server a turn between batches of a long export.
          await nextTurn()
        }),
      params.sql,
      params.sandbox
    )
  }

  kill(): boolean {
    return false
  }

  async close(): Promise<void> {
    this.closed = true
    this.session.close()
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onBatch?: (columns: string[], rows: DataCell[][]) => Promise<void>
  /** Set when the consumer of a stream batch failed; reported instead of the kill. */
  failure?: Error
}

/** A request without its id (the transport numbers them). */
type SqliteRequestBody = SqliteWorkerRequest extends infer R
  ? R extends SqliteWorkerRequest
    ? Omit<R, 'id'>
    : never
  : never

interface ChildSpawnOptions {
  entry: string
  execPath: string
  env: Record<string, string | undefined>
  startTimeoutMs: number
  redact: (text: string) => string
}

/** A forked worker process (one better-sqlite3 connection). */
class ChildSqliteTransport implements SqliteTransport {
  readonly kind = 'child' as const
  private readonly child: ChildProcess
  private readonly pending = new Map<number, PendingRequest>()
  private readonly ready: Promise<void>
  private readonly redact: (text: string) => string
  private nextId = 1
  private isReady = false
  private exited = false
  private killReason: 'cancel' | 'timeout' | 'close' | null = null
  private stderrTail = ''

  constructor(options: ChildSpawnOptions) {
    this.redact = options.redact
    this.child = fork(options.entry, [], {
      execPath: options.execPath,
      // Never inherit --inspect & co. from the server: the child would fight for the port.
      execArgv: [],
      env: { ...options.env, ELECTRON_RUN_AS_NODE: '1', [SQLITE_WORKER_ENV]: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json'
    })
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })

    let readyTimer: NodeJS.Timeout | undefined
    this.ready = new Promise<void>((resolve, reject) => {
      readyTimer = setTimeout(() => {
        reject(
          new DataDriverError(this.failureMessage('The SQLite worker did not start in time'), {
            code: 'SQLITE_WORKER_START'
          })
        )
        this.child.kill('SIGKILL')
      }, options.startTimeoutMs)
      this.child.on('message', (raw: unknown) => {
        const message = raw as SqliteWorkerMessage
        if (message?.type === 'ready') {
          clearTimeout(readyTimer)
          this.isReady = true
          resolve()
          return
        }
        this.onMessage(message)
      })
      this.child.on('error', (error) => {
        clearTimeout(readyTimer)
        const failure = new DataDriverError(
          this.redact(`Could not start the SQLite worker: ${error.message}`),
          { code: 'SQLITE_WORKER_START' }
        )
        reject(failure)
        // A failed spawn emits 'error' and never 'exit': settle everything here.
        if (this.child.pid === undefined) {
          this.exited = true
          for (const [id, pending] of this.pending) {
            this.pending.delete(id)
            pending.reject(failure)
          }
        }
      })
      this.child.on('exit', (code, signal) => {
        clearTimeout(readyTimer)
        this.exited = true
        const error = this.exitError(code, signal)
        reject(error)
        for (const [id, pending] of this.pending) {
          this.pending.delete(id)
          pending.reject(pending.failure ?? error)
        }
      })
    })
    // A start failure is reported by the first request; never as an unhandled rejection.
    this.ready.catch(() => undefined)
  }

  get pid(): number | null {
    return this.child.pid ?? null
  }

  get alive(): boolean {
    return !this.exited && this.killReason === null
  }

  private failureMessage(prefix: string): string {
    const tail = this.stderrTail.trim().split('\n').slice(-6).join('\n')
    return this.redact(tail ? `${prefix}:\n${tail}` : `${prefix}.`)
  }

  private exitError(code: number | null, signal: NodeJS.Signals | null): DataDriverError {
    if (this.killReason === 'cancel' || this.killReason === 'close') {
      return new DataDriverError('The statement was cancelled.', { cancelled: true })
    }
    if (this.killReason === 'timeout') {
      return new DataDriverError('The statement ran past the time limit and was stopped.', {
        code: 'SQLITE_TIMEOUT'
      })
    }
    const how = signal ? `signal ${signal}` : `exit code ${code ?? '?'}`
    return new DataDriverError(
      this.failureMessage(`The SQLite worker stopped unexpectedly (${how})`),
      {
        code: 'SQLITE_WORKER_EXIT',
        hint: 'The connection restarts on the next statement. Temporary tables and any open transaction were lost.'
      }
    )
  }

  private onMessage(message: SqliteWorkerMessage): void {
    if (!message || typeof message !== 'object') return
    if (message.type === 'batch') {
      const pending = this.pending.get(message.id)
      if (!pending?.onBatch) return
      pending.onBatch(message.columns, message.rows).then(
        () => this.post({ id: message.id, op: 'ack' }),
        (error: unknown) => {
          // The consumer gave up (file write failed, export cancelled): stop the child, which
          // also finalizes the half-read statement, and report the consumer's error.
          pending.failure = error instanceof Error ? error : new Error(String(error))
          this.kill('cancel')
        }
      )
      return
    }
    if (message.type !== 'result') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.ok) pending.resolve(message.value)
    else pending.reject(toDriverError(message.error, this.redact))
  }

  private post(request: SqliteWorkerRequest): void {
    if (this.exited || !this.child.connected) return
    try {
      this.child.send(request)
    } catch {
      // channel closed: 'exit' rejects whatever is pending
    }
  }

  private async request<T>(
    request: SqliteRequestBody,
    onBatch?: (columns: string[], rows: DataCell[][]) => Promise<void>
  ): Promise<T> {
    await this.ready
    if (this.exited || this.killReason) throw this.exitError(null, null)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onBatch })
      try {
        this.child.send({ ...request, id } as SqliteWorkerRequest, (error) => {
          if (error && this.pending.delete(id)) {
            reject(
              new DataDriverError(this.redact(`The SQLite worker is unreachable: ${error.message}`))
            )
          }
        })
      } catch (error) {
        this.pending.delete(id)
        reject(
          new DataDriverError(
            this.redact(
              `The SQLite worker is unreachable: ${error instanceof Error ? error.message : String(error)}`
            )
          )
        )
      }
    })
  }

  open(params: SqliteOpenParams): Promise<SqliteOpenResult> {
    return this.request({ op: 'open', params })
  }

  exec(params: SqliteExecParams): Promise<SqliteExecResult> {
    return this.request({ op: 'exec', params })
  }

  introspect<T>(query: SqliteIntrospectQuery): Promise<T> {
    return this.request({ op: 'introspect', query })
  }

  stream(
    params: SqliteStreamParams,
    onBatch: (columns: string[], rows: DataCell[][]) => Promise<void>
  ): Promise<{ rows: number }> {
    return this.request({ op: 'stream', params }, onBatch)
  }

  kill(reason: 'cancel' | 'timeout' | 'close'): boolean {
    if (this.exited) return true
    if (!this.killReason) this.killReason = reason
    this.child.kill('SIGKILL')
    return true
  }

  async close(): Promise<void> {
    if (this.exited) return
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
    // Graceful when idle, so SQLite closes cleanly (WAL checkpoint); a child that is still
    // loading or busy with a statement is killed right away (the journal rolls it back).
    const graceful =
      this.isReady && !this.killReason && this.child.connected && this.pending.size === 0
    let timer: NodeJS.Timeout | undefined
    if (graceful) {
      this.killReason = 'close'
      this.post({ id: this.nextId++, op: 'close' })
      timer = setTimeout(() => this.child.kill('SIGKILL'), CLOSE_GRACE_MS)
    } else {
      this.kill('close')
    }
    // Never hang a shutdown on a process that does not report its exit.
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS * 2))
    ])
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

interface RunningStatement {
  id: string
  text: string
  startedAt: number
  transport: SqliteTransport
  outcome: 'cancel' | 'timeout' | null
}

const EMPTY_STATE: SqliteSessionState = { inTransaction: false, attached: [], tempObjects: 0 }

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

const truthyOption = (value: string | undefined): boolean =>
  value === '1' || value?.toLowerCase() === 'true'

class SqliteDriver implements DataDriver {
  readonly engine = 'sqlite' as const
  private readonly redact: (text: string) => string
  private readonly mode: SqliteWorkerMode
  private readonly path: string
  private readonly readOnlyFile: boolean
  private readonly create: boolean
  private readonly busyTimeoutMs: number
  private readonly configTimeoutMs: number | undefined
  private readonly spawn: Omit<ChildSpawnOptions, 'redact'>

  private connected = false
  private closed = false
  private version = ''
  private state: SqliteSessionState = EMPTY_STATE
  private session: SqliteTransport | null = null
  private sessionStarting: Promise<SqliteTransport> | null = null
  private control: SqliteTransport | null = null
  private controlStarting: Promise<SqliteTransport> | null = null
  private readonly exports = new Set<SqliteTransport>()
  private running: RunningStatement | null = null
  private pendingNotices: string[] = []

  constructor(input: DriverConnectInput, options: SqliteDriverOptions) {
    const config = input.project.config
    this.redact = input.redact
    this.mode = options.mode ?? defaultSqliteWorkerMode()
    this.path = resolveSqlitePath(config.filePath)
    this.readOnlyFile = config.readOnlyFile === true
    this.create = !this.readOnlyFile && truthyOption(config.options?.create)
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
    this.configTimeoutMs = config.queryTimeoutMs
    this.spawn = {
      entry: options.workerEntry ?? process.argv[1] ?? '',
      execPath: options.execPath ?? process.execPath,
      env: { ...process.env, ...options.env },
      startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    }
  }

  private newTransport(): SqliteTransport {
    if (this.mode === 'in-process') return new InProcessSqliteTransport(this.redact)
    if (!this.spawn.entry) {
      throw new DataDriverError('No SQLite worker entry to start (process.argv[1] is empty).', {
        code: 'SQLITE_WORKER_START'
      })
    }
    return new ChildSqliteTransport({ ...this.spawn, redact: this.redact })
  }

  private openParams(extra: Partial<SqliteOpenParams> = {}): SqliteOpenParams {
    return {
      path: this.path,
      readonly: this.readOnlyFile,
      create: false,
      busyTimeoutMs: this.busyTimeoutMs,
      attach: this.state.attached,
      ...extra
    }
  }

  // ---- session / control lifecycle ----------------------------------------------------------

  private ensureSession(): Promise<SqliteTransport> {
    if (this.closed) return Promise.reject(new DataDriverError('The SQLite connection is closed.'))
    if (this.session?.alive) return Promise.resolve(this.session)
    if (!this.sessionStarting) {
      const starting = this.startSession()
      this.sessionStarting = starting
      starting.then(
        () => {
          if (this.sessionStarting === starting) this.sessionStarting = null
        },
        () => {
          if (this.sessionStarting === starting) this.sessionStarting = null
        }
      )
    }
    return this.sessionStarting
  }

  private async startSession(): Promise<SqliteTransport> {
    const transport = this.newTransport()
    try {
      // `create` only matters for the very first open ("New database…").
      const opened = await transport.open(
        this.openParams({ create: this.create && !this.connected })
      )
      if (this.closed) {
        await transport.close()
        throw new DataDriverError('The SQLite connection is closed.')
      }
      this.version = opened.sqliteVersion
      this.state = opened.state
      if (opened.attachWarnings.length > 0) {
        this.pendingNotices.push(`Could not re-attach: ${opened.attachWarnings.join('; ')}`)
      }
      this.session = transport
      return transport
    } catch (error) {
      await transport.close().catch(() => undefined)
      throw error
    }
  }

  private ensureControl(): Promise<SqliteTransport> {
    if (this.closed) return Promise.reject(new DataDriverError('The SQLite connection is closed.'))
    if (this.control?.alive) return Promise.resolve(this.control)
    if (!this.controlStarting) {
      const starting = (async () => {
        const transport = this.newTransport()
        try {
          await transport.open(this.openParams({ queryOnly: true }))
          if (this.closed) {
            await transport.close()
            throw new DataDriverError('The SQLite connection is closed.')
          }
          this.control = transport
          return transport
        } catch (error) {
          await transport.close().catch(() => undefined)
          throw error
        }
      })()
      this.controlStarting = starting
      starting.then(
        () => {
          if (this.controlStarting === starting) this.controlStarting = null
        },
        () => {
          if (this.controlStarting === starting) this.controlStarting = null
        }
      )
    }
    return this.controlStarting
  }

  /** Introspection runs on the control connection, except what only the session can see. */
  private async introspect<T>(query: SqliteIntrospectQuery, schema: string): Promise<T> {
    if (this.path === ':memory:' || schema === 'temp') {
      return (await this.ensureSession()).introspect<T>(query)
    }
    const control = await this.ensureControl()
    return control.introspect<T>({ ...query, attach: this.state.attached })
  }

  private takeNotices(): string[] {
    const notices = this.pendingNotices
    this.pendingNotices = []
    return notices
  }

  /** What a restart of the session throws away, from the state after the last statement. */
  private lostState(): string[] {
    const lost: string[] = []
    if (this.state.inTransaction) lost.push('the open transaction was rolled back')
    if (this.state.tempObjects > 0) {
      lost.push(
        `${plural(this.state.tempObjects, 'temporary object was', 'temporary objects were')} dropped`
      )
    }
    return lost
  }

  /** Stops a running statement by killing its child; a fresh session is started right away. */
  private interrupt(run: RunningStatement, reason: 'cancel' | 'timeout'): boolean {
    if (this.running !== run || run.outcome || run.transport.kind !== 'child') return false
    run.outcome = reason
    const lost = this.lostState()
    const what =
      reason === 'cancel'
        ? 'cancel a running statement'
        : 'stop a statement that ran past the time limit'
    if (lost.length > 0) {
      this.pendingNotices.push(
        `The SQLite connection was restarted to ${what}: ${lost.join(' and ')}.`
      )
    }
    if (this.session === run.transport) this.session = null
    run.transport.kill(reason)
    this.state = { ...EMPTY_STATE, attached: this.state.attached }
    // Respawn now so the next statement does not wait for the bundle to load; a failure here
    // resurfaces on that next statement.
    this.ensureSession().catch(() => undefined)
    return true
  }

  // ---- DataDriver -----------------------------------------------------------------------------

  async connect(): Promise<{
    serverVersion: string
    currentDatabase?: string
    readOnlyUser?: boolean
  }> {
    this.closed = false
    await this.ensureSession()
    this.connected = true
    return {
      serverVersion: `SQLite ${this.version}`,
      currentDatabase: 'main',
      readOnlyUser: this.readOnlyFile
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.connected = false
    const transports = [this.session, this.control, ...this.exports].filter(
      (t): t is SqliteTransport => t !== null
    )
    this.session = null
    this.control = null
    this.exports.clear()
    this.running = null
    await Promise.all(transports.map((t) => t.close().catch(() => undefined)))
  }

  isConnected(): boolean {
    return this.connected && !this.closed
  }

  sessionState(): { inTransaction?: boolean; currentDatabase?: string } {
    return { inTransaction: this.state.inTransaction, currentDatabase: 'main' }
  }

  async execute(statement: string, options: DriverExecuteOptions): Promise<DriverStatementResult> {
    const transport = await this.ensureSession()
    const hardCap = Math.max(
      1,
      Math.min(Math.floor(options.hardCap || DATA_HARD_ROW_CAP), DATA_HARD_ROW_CAP)
    )
    const autoLimit =
      options.limit !== null && options.limit > 0 && !hasUserLimit(statement, 'sqlite')
        ? Math.floor(options.limit)
        : null
    const cap = autoLimit !== null ? Math.min(autoLimit, hardCap) : hardCap

    const run: RunningStatement = {
      id: randomUUID(),
      text: statement,
      startedAt: Date.now(),
      transport,
      outcome: null
    }
    this.running = run
    // engine-core normally passes timeoutMs; the connection setting covers callers that do not.
    const timeoutMs = options.timeoutMs ?? this.configTimeoutMs
    const timer =
      timeoutMs && timeoutMs > 0 && transport.kind === 'child'
        ? setTimeout(() => this.interrupt(run, 'timeout'), timeoutMs)
        : undefined
    try {
      const result = await transport.exec({
        sql: statement,
        maxRows: cap,
        sandbox: options.readOnlySandbox
      })
      this.state = result.state
      const notices = this.takeNotices()
      let output: DataStatementOutput
      if (result.output.kind === 'rows') {
        const payload = result.output
        if (payload.byteLimited) {
          notices.push(
            `Showing the first ${payload.rows.length} rows: the full result is too large to display.`
          )
        }
        output = {
          kind: 'rows',
          columns: payload.columns,
          rows: payload.rows,
          truncated: payload.truncated,
          limit: payload.truncated ? (payload.byteLimited ? payload.rows.length : cap) : autoLimit,
          autoLimited:
            payload.truncated && !payload.byteLimited && autoLimit !== null && autoLimit <= hardCap
        }
      } else {
        output = result.output
      }
      return {
        output,
        ...(notices.length > 0 ? { notices } : {}),
        stats: { elapsedMs: Math.round(result.elapsedMs) }
      }
    } catch (error) {
      if (run.outcome === 'cancel') {
        const lost =
          this.pendingNotices.length > 0
            ? ` ${this.pendingNotices[this.pendingNotices.length - 1]}`
            : ''
        throw new DataDriverError(`The statement was cancelled.${lost}`, { cancelled: true })
      }
      if (run.outcome === 'timeout') {
        throw new DataDriverError(
          `The statement was stopped after ${Math.round((timeoutMs ?? 0) / 1000)} s (statement time limit).`,
          {
            code: 'SQLITE_TIMEOUT',
            hint: 'Raise the query timeout in the connection settings, or narrow the query.'
          }
        )
      }
      throw error instanceof DataDriverError
        ? error
        : new DataDriverError(this.redact(error instanceof Error ? error.message : String(error)))
    } finally {
      if (timer) clearTimeout(timer)
      if (this.running === run) this.running = null
    }
  }

  async cancelCurrent(): Promise<void> {
    const run = this.running
    if (!run) return
    // In-process the statement blocks this very event loop, so there is never anything to
    // interrupt by the time this runs.
    this.interrupt(run, 'cancel')
  }

  async listDatabases(): Promise<DataDatabaseInfo[]> {
    if (!this.connected) await this.connect()
    const size = (file: string): number | null => {
      if (!file || file === ':memory:') return null
      try {
        return statSync(file).size
      } catch {
        return null
      }
    }
    const out: DataDatabaseInfo[] = [{ name: 'main', sizeBytes: size(this.path) }]
    for (const a of this.state.attached) out.push({ name: a.name, sizeBytes: size(a.file) })
    if (this.state.tempObjects > 0) out.push({ name: 'temp', sizeBytes: null })
    return out
  }

  async listObjects(database?: string, schema?: string): Promise<DataObjectsListing> {
    const name = database || schema || 'main'
    const objects = await this.introspect<DataObjectInfo[]>({ kind: 'objects', schema: name }, name)
    return { objects }
  }

  async describe(ref: DataObjectRef): Promise<DataTableDetails> {
    const name = ref.database || ref.schema || 'main'
    return this.introspect<DataTableDetails>(
      { kind: 'describe', schema: name, name: ref.name },
      name
    )
  }

  async ddl(ref: DataObjectRef): Promise<string> {
    const name = ref.database || ref.schema || 'main'
    return this.introspect<string>({ kind: 'ddl', schema: name, name: ref.name }, name)
  }

  async completionSchema(database?: string): Promise<DataCompletionSchema> {
    const name = database || 'main'
    const snap = await this.introspect<SqliteCompletionSnapshot>(
      { kind: 'completion', schema: name, maxTables: COMPLETION_MAX_TABLES },
      name
    )
    // The control connection has no temp schema; the session knows whether one is in use.
    const databases = [
      ...new Set([
        ...snap.databases.filter((d) => d !== 'temp'),
        ...this.state.attached.map((a) => a.name)
      ])
    ]
    if (this.state.tempObjects > 0) databases.push('temp')
    return {
      database: snap.database,
      databases,
      tables: snap.tables,
      functions: snap.functions,
      ...(snap.truncated ? { truncated: true } : {})
    }
  }

  async listProcesses(): Promise<DataProcessInfo[]> {
    const run = this.running
    if (!run) return []
    return [
      {
        id: run.id,
        user: null,
        host: null,
        database: 'main',
        state: run.outcome ? 'cancelling' : 'running',
        command: 'query',
        durationMs: Date.now() - run.startedAt,
        query:
          run.text.length > QUERY_PREVIEW_CHARS
            ? `${run.text.slice(0, QUERY_PREVIEW_CHARS)}…`
            : run.text,
        isOwn: true,
        extra: { pid: run.transport.pid, mode: run.transport.kind }
      }
    ]
  }

  async killProcess(processId: string, _scope: DataKillScope): Promise<void> {
    const run = this.running
    if (!run || run.id !== processId) {
      throw new DataDriverError('That statement is no longer running.', {
        code: 'SQLITE_NO_SUCH_PROCESS'
      })
    }
    if (run.transport.kind !== 'child') {
      throw new DataDriverError('SQLite statements cannot be cancelled in this mode.', {
        code: 'SQLITE_UNSUPPORTED'
      })
    }
    // A connection-scoped kill is the same thing here: the session's process is the connection.
    await this.cancelCurrent()
  }

  async streamRows(
    statement: string,
    options: { database?: string; schema?: string; readOnlySandbox: boolean; signal: AbortSignal },
    onBatch: (columns: string[], rows: unknown[][]) => Promise<void>
  ): Promise<{ rows: number }> {
    const cancelled = (): DataDriverError =>
      new DataDriverError('The export was cancelled.', { cancelled: true })
    if (options.signal.aborted) throw cancelled()
    if (this.path === ':memory:') {
      throw new DataDriverError(
        'Exporting a whole query is not available for in-memory databases (an export needs its own connection). Export the visible rows instead.',
        { code: 'SQLITE_UNSUPPORTED' }
      )
    }
    const transport = this.newTransport()
    this.exports.add(transport)
    const onAbort = (): void => {
      transport.kill('cancel')
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      await transport.open(this.openParams({ queryOnly: options.readOnlySandbox }))
      return await transport.stream(
        { sql: statement, sandbox: options.readOnlySandbox, batchSize: STREAM_BATCH_ROWS },
        async (columns, rows) => {
          if (options.signal.aborted) throw cancelled()
          await onBatch(columns, rows)
        }
      )
    } catch (error) {
      if (options.signal.aborted) throw cancelled()
      throw error
    } finally {
      options.signal.removeEventListener('abort', onAbort)
      this.exports.delete(transport)
      await transport.close().catch(() => undefined)
    }
  }

  quoteIdentifier(name: string): string {
    return quoteSqlIdentifier(name, 'sqlite')
  }
}

export function createSqliteDriver(
  input: DriverConnectInput,
  options: SqliteDriverOptions = {}
): DataDriver {
  return new SqliteDriver(input, options)
}
