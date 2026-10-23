// DataQueryRequest → DataQueryResponse: the editor's run pipeline.
//
//   split      shared splitSqlStatements (SQL) / splitMongoShell (MongoDB); offsets map results
//              and errors back into the editor. MySQL/MariaDB text with a backslash is split and
//              classified with the session's real NO_BACKSLASH_ESCAPES mode
//   classify   shared classifySqlStatement / classifyMongoShellStatement (server-side: the
//              renderer's badge is only a prediction). Mongo statements are classified in the
//              database they will run in: the request's (else the connection's, else "test"),
//              moved by each `use` in the text
//   gate       evaluateSafety → run | confirmation_required | blocked (nothing runs unless the
//              whole request may run)
//   execute    on the project's sticky session, one statement per driver call, serialised per
//              session; reads in the read-only sandbox as the gate decided; auto-limit + hard cap;
//              per-statement timing; stopOnError. The request's database applies to its first
//              statement; a `USE x` inside the request carries over to the statements after it
//              (Mongo: the planned database of each statement). A session that died with the
//              user's transaction open is reported (TransactionLostError) instead of running on
//              a fresh session
//   map        DataDriverError → DataQueryError (position relative to the statement); a sandbox
//              rejection of an auto-run read turns the response into confirmation_required
//              ("tried to write"), or blocked in read-only mode; a cancel returns the statements
//              that finished before it (a statement that completed although the cancel was
//              already on its way keeps its result: it may have committed)
//   record     one history row per request; deps.recordHistory masks secrets (IDENTIFIED BY /
//              PASSWORD / conninfo / mongosh pwd...) in the text and in the error (maskForHistory).
//              The console log (console-log.ts) sees every statement as it is sent: the run is
//              scoped with the request's console source ('query', 'structure' for schema
//              actions…)
//
// Cancellation is by client-generated queryId through QueryRegistry, which also lets the RPC
// layer cancel everything a disconnected renderer left running (releaseClient).

import {
  DATA_HARD_ROW_CAP,
  sqlDialectOf,
  type DataHistoryEntry,
  type DataQueryError,
  type DataQueryRequest,
  type DataQueryResponse,
  type DataQuerySource,
  type DataStatementClass,
  type DataStatementOutput,
  type DataStatementResult
} from '../../../shared/data-projects/types'
import {
  classifySqlStatement,
  maskSqlSecrets,
  splitSqlStatements,
  type SqlLexOptions
} from '../../../shared/sql'
import {
  classifyMongoShellStatement,
  maskMongoSecrets,
  splitMongoShell
} from '../../../shared/data-projects/mongo-shell'
import {
  DataDriverError,
  type DataCallContext,
  type DataDriver,
  type DataProjectRecord,
  type SafetyEvaluationInput,
  type SafetyStatementInput
} from './contracts'
import {
  isConnectionLostError,
  QueueAbortedError,
  TransactionLostError,
  type ConnectionManager,
  type EngineLogger,
  noopLogger
} from './connection-manager'
import type { SafetyGate } from './safety-gate'
import { busyError, errorMessage } from './redact'
import { withConsoleSource } from './console-log'
import type { DataConsoleSource } from '../../../shared/data-projects/console-types'

// One mongosh masker for history, the assistant and the renderer's persisted drafts.
export { maskMongoSecrets }

// ---------------------------------------------------------------------------------------------
// Query registry (cancel by queryId, release by clientId)
// ---------------------------------------------------------------------------------------------

export interface RegisteredQuery {
  clientId: string | null
  projectId: string | null
  cancel(): Promise<void>
}

export class QueryRegistry {
  private readonly queries = new Map<
    string,
    RegisteredQuery & { cancelling: Promise<void> | null }
  >()

  /** Registers a running query; returns the unregister function. Duplicate ids are refused. */
  register(queryId: string, query: RegisteredQuery): () => void {
    if (!queryId) throw busyError('A query id is required.')
    if (this.queries.has(queryId)) throw busyError('A query with this id is already running.')
    const entry = { ...query, cancelling: null as Promise<void> | null }
    this.queries.set(queryId, entry)
    return () => {
      if (this.queries.get(queryId) === entry) this.queries.delete(queryId)
    }
  }

  has(queryId: string): boolean {
    return this.queries.has(queryId)
  }

  /** Cancels a running query; false when no query with that id is running. */
  async cancel(queryId: string): Promise<boolean> {
    const entry = this.queries.get(queryId)
    if (!entry) return false
    entry.cancelling ??= entry.cancel().catch(() => undefined)
    await entry.cancelling
    return true
  }

  /** A renderer went away: cancel everything it started. */
  releaseClient(clientId: string): void {
    for (const [queryId, entry] of this.queries) {
      if (entry.clientId === clientId) void this.cancel(queryId)
    }
  }

  async cancelProject(projectId: string): Promise<void> {
    const ids = [...this.queries].filter(([, e]) => e.projectId === projectId).map(([id]) => id)
    await Promise.all(ids.map((id) => this.cancel(id)))
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.queries.keys()].map((id) => this.cancel(id)))
  }

  get size(): number {
    return this.queries.size
  }
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

/** Sessions that ran DDL inside a transaction still open (see finish() in runQuery). */
const ddlInOpenTransaction = new WeakSet<object>()

export interface PlannedStatement extends SafetyStatementInput {
  reasons: string[]
  /** MongoDB: the database the statement runs in (before its own getSiblingDB). */
  database?: string
}

export interface PlanOptions {
  /**
   * MySQL/MariaDB: the session's NO_BACKSLASH_ESCAPES state (false = backslashes are literal).
   * Undefined = unknown: the classifier then refuses to guess when the two readings differ.
   */
  backslashEscapes?: boolean
  /** MongoDB: the database the request starts in; each `use x` in the text moves it. */
  database?: string
}

/** mongosh's database when nothing selected one (the Mongo driver uses it too). */
const MONGO_DEFAULT_DATABASE = 'test'

const isMysqlFamily = (engine: DataProjectRecord['engine']): boolean =>
  engine === 'mysql' || engine === 'mariadb'

/** Splits and classifies a request text for the project's engine. */
export function planStatements(
  engine: DataProjectRecord['engine'],
  text: string,
  options: PlanOptions = {}
): PlannedStatement[] {
  if (engine === 'mongodb') {
    let spans: Array<{ text: string; start: number; end: number }>
    try {
      spans = splitMongoShell(text)
    } catch {
      spans = text.trim()
        ? [
            {
              text: text.trim(),
              start: text.indexOf(text.trim()),
              end: text.indexOf(text.trim()) + text.trim().length
            }
          ]
        : []
    }
    // The danger text and the production type-to-confirm name the database the driver will use:
    // `use archive\ndb.dropDatabase()` drops "archive", not the tab's database.
    let database = options.database || undefined
    return spans.map((span, index) => {
      const c = classifyMongoShellStatement(span.text, database ? { database } : {})
      const planned: PlannedStatement = {
        index,
        text: span.text,
        start: span.start,
        end: span.end,
        classification: c.classification,
        dangerous: c.dangerous,
        reasons: c.reasons,
        targets: c.targets ?? []
      }
      if (database) planned.database = database
      // `use x` is the only Mongo statement classified 'session'; its database is x.
      if (c.classification === 'session' && c.database) database = c.database
      return planned
    })
  }
  const dialect = sqlDialectOf(engine) ?? 'mysql'
  const lexOptions: SqlLexOptions | undefined =
    isMysqlFamily(engine) && options.backslashEscapes !== undefined
      ? { backslashEscapes: options.backslashEscapes }
      : undefined
  let spans: Array<{ text: string; start: number; end: number }>
  try {
    spans = splitSqlStatements(text, dialect, lexOptions)
  } catch {
    // A splitter failure must never run anything unclassified: one 'unknown' statement.
    const trimmed = text.trim()
    const start = text.indexOf(trimmed)
    spans = trimmed ? [{ text: trimmed, start, end: start + trimmed.length }] : []
    return spans.map((span, index) => ({
      index,
      ...span,
      classification: 'unknown' as DataStatementClass,
      dangerous: [],
      reasons: ['the statement could not be split'],
      targets: []
    }))
  }
  return spans.map((span, index) => {
    const c = classifySqlStatement(span.text, dialect, lexOptions)
    return {
      index,
      text: span.text,
      start: span.start,
      end: span.end,
      classification: c.classification,
      dangerous: c.dangerous,
      reasons: c.reasons,
      targets: c.targetTables
    }
  })
}

export const toSafetyStatements = (statements: PlannedStatement[]): SafetyStatementInput[] =>
  statements.map(({ index, text, start, end, classification, dangerous, targets, reasons }) => ({
    index,
    text,
    start,
    end,
    classification,
    dangerous,
    targets,
    reasons
  }))

// ---------------------------------------------------------------------------------------------
// History masking
// ---------------------------------------------------------------------------------------------

/** History keeps this much of a request's text (or error). */
const HISTORY_TEXT_MAX = 100_000
/**
 * Masked beyond the cut, so a literal the cut falls into is masked whole, without masking all
 * of a 16 MB request (the masked text can be shorter than the original).
 */
const HISTORY_MASK_SLACK = 8_192

/**
 * Masks secrets before history and the assistant: SQL (IDENTIFIED BY / PASSWORD, conninfo, URL
 * userinfo...) in the engine's dialect, and mongosh (password-like keys, positional passwords,
 * URLs) with the masker the renderer uses for persisted drafts. Used for the text AND the error
 * column: a syntax error echoes the statement ("…near 'IDENTIFIED BY 'x'' at line 1").
 */
export function maskForHistory(engine: DataProjectRecord['engine'], text: string): string {
  if (!text) return text
  const head =
    text.length > HISTORY_TEXT_MAX + HISTORY_MASK_SLACK
      ? text.slice(0, HISTORY_TEXT_MAX + HISTORY_MASK_SLACK)
      : text
  let masked: string
  if (engine === 'mongodb') {
    masked = maskMongoSecrets(head)
  } else {
    try {
      masked = maskSqlSecrets(head, sqlDialectOf(engine) ?? undefined)
    } catch {
      masked = head.replace(
        /(IDENTIFIED\s+(?:WITH\s+\S+\s+)?BY|PASSWORD)\s*(\(?\s*)'(?:''|[^'])*'/gi,
        "$1 $2'***'"
      )
    }
  }
  return masked.length > HISTORY_TEXT_MAX || head !== text
    ? `${masked.slice(0, HISTORY_TEXT_MAX)}\n-- … truncated`
    : masked
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

export interface QueryRunnerDeps {
  manager: ConnectionManager
  gate: SafetyGate
  registry: QueryRegistry
  getRecord(id: string): DataProjectRecord
  /** Stores a history row; masks its text and error (engine-service.recordHistory). */
  recordHistory(entry: Omit<DataHistoryEntry, 'id'>): void
  /** A DDL statement ran: drop schema caches. */
  onSchemaChanged?(projectId: string): void
  now?: () => number
  logger?: EngineLogger
}

const toQueryError = (
  error: unknown,
  statementText: string,
  redact: (t: string) => string
): DataQueryError => {
  if (error instanceof DataDriverError) {
    const out: DataQueryError = { message: redact(error.message) || 'Statement failed' }
    if (error.code) out.code = error.code
    if (typeof error.position === 'number' && Number.isFinite(error.position)) {
      out.position = Math.max(0, Math.min(error.position, statementText.length))
    }
    if (error.hint) out.hint = redact(error.hint)
    if (error.detail) out.detail = redact(error.detail)
    return out
  }
  const out: DataQueryError = { message: errorMessage(error, redact) }
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string' || typeof code === 'number') out.code = String(code)
  return out
}

const outputRowCount = (output: DataStatementOutput | null): { rows: number; affected: number } => {
  if (!output) return { rows: 0, affected: 0 }
  switch (output.kind) {
    case 'rows':
      return { rows: output.rows.length, affected: 0 }
    case 'documents':
      return { rows: output.documents.length, affected: 0 }
    case 'command':
      return {
        rows: 0,
        affected: typeof output.affectedRows === 'number' ? output.affectedRows : 0
      }
    default:
      return { rows: 0, affected: 0 }
  }
}

export function historyRowCount(results: DataStatementResult[]): number | null {
  let rows = 0
  let affected = 0
  let any = false
  for (const r of results) {
    if (!r.output) continue
    any = true
    const c = outputRowCount(r.output)
    rows += c.rows
    affected += c.affected
  }
  if (!any) return null
  return rows > 0 ? rows : affected
}

/** What the console log files a request's statements under. */
export const CONSOLE_SOURCE_OF: Readonly<Record<DataQuerySource, DataConsoleSource>> = {
  editor: 'query',
  mongo: 'query',
  'schema-action': 'structure',
  table: 'table',
  'grid-edit': 'edit'
}

export async function runQuery(
  deps: QueryRunnerDeps,
  req: DataQueryRequest,
  ctx: DataCallContext
): Promise<DataQueryResponse> {
  const now = deps.now ?? Date.now
  const log = deps.logger ?? noopLogger
  const record = deps.getRecord(req.dataProjectId)
  const redact = deps.manager.redactor(record.id)
  const startedAt = now()
  const database = req.database || undefined
  const mysqlFamily = isMysqlFamily(record.engine)
  // Backslashes are the only thing NO_BACKSLASH_ESCAPES changes: only then is the session's
  // mode worth a lookup (which connects first).
  const lastBackslash = mysqlFamily ? req.text.lastIndexOf('\\') : -1
  const backslashEscapes =
    lastBackslash >= 0 ? await deps.manager.backslashEscapes(record.id, database) : undefined
  // Mongo: the tab's database, else the connection's configured one, else mongosh's default
  // "test" (where the driver runs it too). Never where the session is now: another tab's `use`
  // must not redirect a '(connection default)' tab, nor change what its confirmation names.
  const mongoDatabase =
    record.engine === 'mongodb'
      ? database || record.config.database?.trim() || MONGO_DEFAULT_DATABASE
      : undefined
  const statements = planStatements(record.engine, req.text, {
    backslashEscapes,
    database: mongoDatabase
  })

  const record_ = (
    entry: Pick<DataHistoryEntry, 'status' | 'durationMs' | 'rowCount' | 'error'>
  ): void => {
    if (req.source === 'table') return
    try {
      // recordHistory (engine-service) masks the text and the error for every history writer.
      deps.recordHistory({
        dataProjectId: record.id,
        database: mongoDatabase ?? database ?? record.config.database ?? null,
        text: req.text,
        executedAt: new Date(startedAt).toISOString(),
        ...entry
      })
    } catch (error) {
      log.warn('Failed to record data query history', {
        dataProjectId: record.id,
        error: errorMessage(error)
      })
    }
  }

  if (statements.length === 0) {
    return { status: 'ok', statements: [], durationMs: 0, database }
  }

  const safetyInput: SafetyEvaluationInput = {
    project: record,
    database: mongoDatabase ?? database,
    source: req.source,
    statements: toSafetyStatements(statements),
    fingerprintText: JSON.stringify([req.text, req.schema ?? null]),
    confirmToken: req.confirmToken
  }
  const decision = deps.gate.evaluate(safetyInput)
  if (decision.action === 'block') {
    record_({ status: 'blocked', durationMs: null, rowCount: null, error: decision.reason })
    return { status: 'blocked', plan: decision.plan, reason: decision.reason }
  }
  if (decision.action === 'confirm') {
    return {
      status: 'confirmation_required',
      plan: decision.plan,
      confirmToken: decision.confirmToken
    }
  }

  const limit =
    req.limit && req.limit > 0 ? Math.min(Math.trunc(req.limit), DATA_HARD_ROW_CAP) : null
  const timeoutMs =
    record.config.queryTimeoutMs && record.config.queryTimeoutMs > 0
      ? record.config.queryTimeoutMs
      : undefined
  const abort = new AbortController()
  const state: { cancelled: boolean; current: DataDriver | null } = {
    cancelled: false,
    current: null
  }
  const unregister = deps.registry.register(req.queryId, {
    clientId: ctx.clientId,
    projectId: record.id,
    cancel: async () => {
      state.cancelled = true
      abort.abort()
      const driver = state.current
      if (driver) await driver.cancelCurrent()
    }
  })

  const results: DataStatementResult[] = []
  const baseOf = (
    statement: PlannedStatement
  ): Pick<DataStatementResult, 'index' | 'text' | 'start' | 'end' | 'classification'> => ({
    index: statement.index,
    text: statement.text,
    start: statement.start,
    end: statement.end,
    classification: statement.classification
  })
  const cancelledResponse = (): DataQueryResponse => {
    const durationMs = now() - startedAt
    record_({ status: 'cancelled', durationMs, rowCount: historyRowCount(results), error: null })
    return { status: 'cancelled', statements: results, durationMs }
  }
  const lostTransactionResponse = (error: TransactionLostError): DataQueryResponse => {
    // Nothing ran: the session that held the user's transaction is gone (see ConnectionManager).
    const message = redact(error.message)
    results.push({
      ...baseOf(statements[0]),
      durationMs: 0,
      output: null,
      error: { message, code: error.code ?? 'CONNECTION_LOST' }
    })
    const durationMs = now() - startedAt
    record_({ status: 'error', durationMs, rowCount: null, error: message })
    return { status: 'ok', statements: results, durationMs, database, inTransaction: false }
  }

  try {
    return await withConsoleSource(CONSOLE_SOURCE_OF[req.source] ?? 'query', () =>
      deps.manager.runSerial(
        record.id,
        database,
        async (session): Promise<DataQueryResponse> => {
          let schemaChanged = false
          // The request's database applies to its first statement; a USE inside the request moves
          // the session for the statements after it (the drivers re-apply options.database when it
          // differs from the session's). Mongo statements carry their planned database instead.
          const followsUse = mysqlFamily || record.engine === 'clickhouse'
          let sessionDatabase = database
          // Transaction state of the session before each statement: a dead PG session reports
          // none, so the last state seen alive is kept for the "rolled back" message.
          let knownInTx = session.driver.sessionState().inTransaction === true
          for (let i = 0; i < statements.length; i++) {
            if (state.cancelled) return cancelledResponse()
            const statement = statements[i]
            const sandbox = decision.sandboxReads[i] ?? false
            const options = {
              limit,
              hardCap: DATA_HARD_ROW_CAP,
              readOnlySandbox: sandbox,
              database:
                record.engine === 'mongodb' ? (statement.database ?? database) : sessionDatabase,
              schema: req.schema,
              timeoutMs
            }
            const t0 = now()
            let retried = false
            for (;;) {
              const driver = session.driver
              const live = driver.isConnected()
              const wasInTx = live ? driver.sessionState().inTransaction === true : knownInTx
              if (
                live &&
                lastBackslash >= statement.start &&
                driver.sessionState().backslashEscapes !== backslashEscapes
              ) {
                // The rest of the text was split and classified with the other backslash mode
                // (a SET sql_mode ran before it, or a fresh session has the server default).
                results.push({
                  ...baseOf(statement),
                  durationMs: 0,
                  output: null,
                  error: {
                    message:
                      'The session’s sql_mode (NO_BACKSLASH_ESCAPES) changed after this text was checked, which changes how its backslashes are read. This statement and the ones after it were not run; run them again.',
                    code: 'SQL_MODE_CHANGED'
                  }
                })
                return finish()
              }
              state.current = driver
              try {
                const r = await driver.execute(statement.text, options)
                state.current = null
                const result: DataStatementResult = {
                  ...baseOf(statement),
                  durationMs: now() - t0,
                  output: r.output
                }
                if (r.executedText && r.executedText !== statement.text)
                  result.executedText = r.executedText
                const notices = [...(r.notices ?? [])]
                if (retried)
                  notices.unshift(
                    'The connection was lost and re-opened before this statement ran again; session state (temporary tables, variables) was reset.'
                  )
                // The driver returned a result, so the server finished the statement before the
                // cancel reached it: it may have committed, so its result is never dropped.
                if (state.cancelled)
                  notices.push('The cancel arrived after this statement had finished.')
                if (notices.length) result.notices = notices.map(redact)
                if (r.stats) result.stats = r.stats
                results.push(result)
                for (const extra of r.moreOutputs ?? [])
                  results.push({ ...baseOf(statement), durationMs: 0, output: extra })
                if (statement.classification === 'ddl') schemaChanged = true
                if (driver.isConnected()) {
                  const after = driver.sessionState()
                  knownInTx = after.inTransaction === true
                  if (followsUse && after.currentDatabase) sessionDatabase = after.currentDatabase
                }
                if (state.cancelled && i < statements.length - 1) return cancelledResponse()
                break
              } catch (error) {
                state.current = null
                if (error instanceof DataDriverError && error.cancelled) return cancelledResponse()
                if (state.cancelled) {
                  // Failed on its own while the cancel was on its way: show why.
                  results.push({
                    ...baseOf(statement),
                    durationMs: now() - t0,
                    output: null,
                    error: toQueryError(error, statement.text, redact)
                  })
                  return cancelledResponse()
                }
                if (error instanceof DataDriverError && error.sandboxRejected && sandbox) {
                  // An auto-run "read" tried to write (a UDF, a trigger...). Nothing after it ran.
                  const escalated = deps.gate.escalate(
                    safetyInput,
                    statement.index,
                    'tried to write'
                  )
                  if (escalated.action === 'block') {
                    record_({
                      status: 'blocked',
                      durationMs: now() - startedAt,
                      rowCount: null,
                      error: escalated.reason
                    })
                    return { status: 'blocked', plan: escalated.plan, reason: escalated.reason }
                  }
                  return {
                    status: 'confirmation_required',
                    plan: escalated.plan,
                    confirmToken: escalated.confirmToken
                  }
                }
                if (isConnectionLostError(error, driver)) {
                  // Reads are safe to repeat on a fresh session; writes never are (they may have
                  // been applied before the connection died).
                  const repeatable = statement.classification === 'read' && !wasInTx && !retried
                  const lost = toQueryError(error, statement.text, redact)
                  lost.message = `${lost.message} — the connection was lost${
                    statement.classification === 'read'
                      ? ''
                      : '; the statement may or may not have been applied'
                  }${wasInTx ? ', and the open transaction was rolled back' : ''}.`
                  knownInTx = false
                  try {
                    await session.reconnect()
                  } catch (reconnectError) {
                    lost.message = `${lost.message} Reconnecting failed: ${errorMessage(reconnectError, redact)}`
                    results.push({
                      ...baseOf(statement),
                      durationMs: now() - t0,
                      output: null,
                      error: lost
                    })
                    return finish()
                  }
                  if (repeatable) {
                    retried = true
                    continue
                  }
                  results.push({
                    ...baseOf(statement),
                    durationMs: now() - t0,
                    output: null,
                    error: lost
                  })
                  return finish()
                }
                results.push({
                  ...baseOf(statement),
                  durationMs: now() - t0,
                  output: null,
                  error: toQueryError(error, statement.text, redact)
                })
                // ClickHouse ALTERs are not transactional: a failed MODIFY COLUMN can leave its new
                // type committed, so the schema caches go too.
                if (record.engine === 'clickhouse' && statement.classification === 'ddl') {
                  schemaChanged = true
                }
                if (req.stopOnError !== false) return finish()
                break
              }
            }
          }
          return finish()

          function finish(): DataQueryResponse {
            // Schema caches load on a control connection that cannot see DDL inside the session's
            // open transaction: drop them again when that transaction ends (COMMIT / ROLLBACK).
            const inTx =
              session.driver.isConnected() && session.driver.sessionState().inTransaction === true
            if (schemaChanged && inTx) ddlInOpenTransaction.add(session.driver)
            else if (!inTx && ddlInOpenTransaction.delete(session.driver)) schemaChanged = true
            if (schemaChanged) deps.onSchemaChanged?.(record.id)
            schemaChanged = false
            const durationMs = now() - startedAt
            const firstError = results.find((r) => r.error)?.error
            record_({
              status: firstError ? 'error' : 'ok',
              durationMs,
              rowCount: historyRowCount(results),
              error: firstError ? firstError.message : null
            })
            const sessionState = session.driver.isConnected() ? session.driver.sessionState() : {}
            const response: DataQueryResponse = {
              status: 'ok',
              statements: results,
              durationMs,
              database: sessionState.currentDatabase ?? database
            }
            if (sessionState.inTransaction !== undefined)
              response.inTransaction = sessionState.inTransaction
            return response
          }
        },
        abort.signal,
        { reportLostTransaction: true }
      )
    )
  } catch (error) {
    if (error instanceof TransactionLostError) return lostTransactionResponse(error)
    if (error instanceof QueueAbortedError || state.cancelled) return cancelledResponse()
    throw error
  } finally {
    unregister()
  }
}
