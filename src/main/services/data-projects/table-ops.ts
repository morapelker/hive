// Table tab of the SQL client: paged browsing with filters/sort/raw WHERE, and staged grid
// edits (UPDATE/INSERT/DELETE keyed by primary key).
//
// Browsing: the SELECT is generated here (qualified, quoted identifiers; filter values as
// literals via the shared buildSqlWhere, combined with AND or — `filterJoin: 'or'` — OR, always
// as one parenthesised group), and a user-typed raw WHERE is ANDed after it on its own line
// inside parentheses (so a trailing `-- comment` cannot swallow the rest). The whole
// generated statement is then split and classified like any user SQL: more than one statement or
// anything but a plain read is refused (table browsing has no confirmation round trip), and it
// always runs inside the read-only sandbox. Total rows: exact COUNT(*) when the table is small
// (estimate < 200k) or the page was not full; the catalog estimate otherwise. Pages without a
// user sort are ordered by the primary key (ClickHouse: the table's sorting key, which it reads
// in order cheaply; without one, parallel reads return rows in any order).
//
// MySQL/MariaDB literals and the classification of generated text follow the session's
// NO_BACKSLASH_ESCAPES mode (DataDriver.sessionState().backslashEscapes; unknown = the server
// default, escapes on): quoting `C:\temp` for the wrong mode stores doubled backslashes.
//
// Edits: parameter-free statements (every value through quoteSqlLiteral, every identifier through
// quoteSqlIdentifier), keyed by the table's primary key (refused without one). They go through
// the safety gate with source 'grid-edit', run in ONE transaction where the engine has them
// (MySQL/MariaDB/PG/SQLite), and every UPDATE/DELETE/INSERT must touch exactly one row, otherwise
// the transaction is rolled back (the row changed under us, or the key is not unique).
// ClickHouse has no transactions and uses ALTER TABLE … UPDATE/DELETE mutations.
//
// The console log (console-log.ts) files pages and counts under 'table' and the edits (with
// their BEGIN / COMMIT / ROLLBACK) under 'edit'.

import {
  DATA_HARD_ROW_CAP,
  sqlDialectOf,
  type DataApplyEditsRequest,
  type DataApplyEditsResponse,
  type DataCell,
  type DataFilter,
  type DataFilterJoin,
  type DataHistoryEntry,
  type DataObjectRef,
  type DataRowEdit,
  type DataRowsResult,
  type DataSort,
  type DataTableDetails,
  type DataTableRowsRequest,
  type DataTableRowsResponse,
  type SqlDialect
} from '../../../shared/data-projects/types'
import {
  buildSqlWhere,
  classifySqlStatement,
  quoteSqlIdentifier,
  quoteSqlLiteral,
  splitSqlStatements,
  type SqlQuoteOptions
} from '../../../shared/sql'
import type { SqlWhereOptions } from '../../../shared/sql/filters'
import {
  DataDriverError,
  type DataCallContext,
  type DataDriver,
  type DataProjectRecord
} from './contracts'
import type { ConnectionManager, EngineLogger } from './connection-manager'
import { noopLogger, QueueAbortedError } from './connection-manager'
import type { QueryRegistry } from './query-runner'
import type { SafetyGate } from './safety-gate'
import { busyError, errorMessage, invalidInputError, unsupportedError } from './redact'
import { isCompleteBinaryCell } from './cells'
import { withConsoleSource } from './console-log'

/** Below this estimate the exact COUNT(*) is cheap enough to run on every page. */
export const EXACT_COUNT_THRESHOLD = 200_000
const COUNT_TIMEOUT_MS = 3_000

export interface TableOpsDeps {
  manager: ConnectionManager
  gate: SafetyGate
  registry: QueryRegistry
  getRecord(id: string): DataProjectRecord
  /** Cached describe (the engine service owns the cache). */
  describe(id: string, ref: DataObjectRef): Promise<DataTableDetails>
  recordHistory(entry: Omit<DataHistoryEntry, 'id'>): void
  now?: () => number
  logger?: EngineLogger
}

const dialectOf = (record: DataProjectRecord): SqlDialect => {
  const dialect = sqlDialectOf(record.engine)
  if (!dialect) throw unsupportedError('Table browsing is not available for this engine.')
  return dialect
}

/** `db`.`t` (MySQL/MariaDB/ClickHouse), "schema"."t" (PG, the database is the connection), "main"."t" (SQLite). */
export function qualifiedTableName(ref: DataObjectRef, dialect: SqlDialect): string {
  const q = (name: string): string => quoteSqlIdentifier(name, dialect)
  switch (dialect) {
    case 'postgres':
      return ref.schema ? `${q(ref.schema)}.${q(ref.name)}` : q(ref.name)
    case 'sqlite': {
      const schema = ref.schema ?? ref.database
      return schema ? `${q(schema)}.${q(ref.name)}` : q(ref.name)
    }
    default:
      return ref.database ? `${q(ref.database)}.${q(ref.name)}` : q(ref.name)
  }
}

/**
 * Quoting/lexing options for generated MySQL/MariaDB text: the session's backslash mode, the
 * server default (escapes on) when unknown. Empty for other dialects.
 */
export const sqlTextOptions = (
  dialect: SqlDialect,
  backslashEscapes: boolean | undefined
): SqlQuoteOptions =>
  dialect === 'mysql' || dialect === 'mariadb' ? { backslashEscapes: backslashEscapes ?? true } : {}

/**
 * The WHERE body ('' when none): (filters joined by `options.join`, AND by default) AND (raw
 * WHERE). `options` also carries the literal quoting (sqlTextOptions).
 */
export function buildWhereBody(
  dialect: SqlDialect,
  filters: DataFilter[] | undefined,
  where: string | undefined,
  options: SqlWhereOptions = {}
): string {
  const parts: string[] = []
  if (filters && filters.length > 0) {
    const built = buildSqlWhere(filters, dialect, options)
      .trim()
      .replace(/^where\s+/i, '')
    if (built) parts.push(`(${built})`)
  }
  // A pasted "WHERE …" or a trailing ';' is tolerated (the splitter would see an empty second
  // statement otherwise).
  const raw = where
    ?.trim()
    .replace(/^where\s+/i, '')
    .replace(/;\s*$/, '')
    .trim()
  if (raw) {
    // The newline keeps a trailing `-- comment` in the user's text from eating the ')'.
    parts.push(`(${raw}\n)`)
  }
  return parts.join(' AND ')
}

export interface SelectOptions {
  filters?: DataFilter[]
  /** How the filters combine (default 'and'); the raw WHERE is always ANDed with the group. */
  filterJoin?: DataFilterJoin
  where?: string
  orderBy?: DataSort[]
  /** Used when `orderBy` is empty: a catalog-provided ORDER BY list (ClickHouse sorting key). */
  orderByExpression?: string
  limit?: number
  offset?: number
  /** MySQL/MariaDB: the session's backslash mode for filter literals (see sqlTextOptions). */
  backslashEscapes?: boolean
}

export function buildSelectSql(
  dialect: SqlDialect,
  ref: DataObjectRef,
  options: SelectOptions
): string {
  let sql = `SELECT * FROM ${qualifiedTableName(ref, dialect)}`
  const where = buildWhereBody(dialect, options.filters, options.where, {
    ...sqlTextOptions(dialect, options.backslashEscapes),
    join: options.filterJoin
  })
  if (where) sql += ` WHERE ${where}`
  if (options.orderBy && options.orderBy.length > 0) {
    sql += ` ORDER BY ${options.orderBy
      .map(
        (s) => `${quoteSqlIdentifier(s.column, dialect)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`
      )
      .join(', ')}`
  } else if (options.orderByExpression?.trim()) {
    sql += ` ORDER BY ${options.orderByExpression.trim()}`
  }
  if (options.limit !== undefined) {
    sql += ` LIMIT ${Math.max(0, Math.trunc(options.limit))}`
    if (options.offset) sql += ` OFFSET ${Math.max(0, Math.trunc(options.offset))}`
  }
  return sql
}

/** `options`: literal quoting (sqlTextOptions) and the filters' join, as for buildSelectSql. */
export function buildCountSql(
  dialect: SqlDialect,
  ref: DataObjectRef,
  filters?: DataFilter[],
  where?: string,
  options: SqlWhereOptions = {}
): string {
  let sql = `SELECT COUNT(*) FROM ${qualifiedTableName(ref, dialect)}`
  const body = buildWhereBody(dialect, filters, where, options)
  if (body) sql += ` WHERE ${body}`
  return sql
}

/**
 * Refuses generated SQL that is not exactly one plain read (raw WHERE injection, side effects).
 * `options` = the lexing the text was quoted for (sqlTextOptions).
 */
export function assertSingleRead(
  sql: string,
  dialect: SqlDialect,
  options: SqlQuoteOptions = {}
): void {
  const spans = splitSqlStatements(sql, dialect, options)
  if (spans.length !== 1) {
    throw invalidInputError('The WHERE clause must not contain statement separators (;).')
  }
  const c = classifySqlStatement(spans[0].text, dialect, options)
  if (c.classification !== 'read' || c.dangerous.length > 0) {
    const why = [...c.dangerous, ...c.reasons].filter(Boolean).join('; ')
    throw invalidInputError(
      `The WHERE clause must only read data${why ? ` (${why})` : ''}. Run it from a query tab instead.`
    )
  }
}

const validateColumns = (
  details: DataTableDetails,
  names: Iterable<string>,
  what: string
): void => {
  const known = new Set(details.columns.map((c) => c.name))
  if (known.size === 0) return
  for (const name of names) {
    if (!known.has(name)) throw invalidInputError(`Unknown column "${name}" in ${what}.`)
  }
}

// ---------------------------------------------------------------------------------------------
// Edits → SQL
// ---------------------------------------------------------------------------------------------

const literal = (
  value: DataCell | undefined,
  dialect: SqlDialect,
  column: string,
  quote: SqlQuoteOptions,
  bitColumns?: ReadonlySet<string>
): string => {
  if (value !== null && typeof value === 'object') {
    if (!isCompleteBinaryCell(value)) {
      throw invalidInputError(
        `Column "${column}" holds a binary value that was only previewed; edit it from a query instead.`
      )
    }
  }
  // MySQL BIT: a quoted '6' would store the byte 0x36 (and fail on BIT(1)). Text typed into a
  // NULL cell, or a value wider than 53 bits (sent as exact decimal text), goes in unquoted.
  if (typeof value === 'string' && bitColumns?.has(column)) {
    const text = value.trim()
    if (/^\d+$/.test(text) || /^b'[01]*'$/i.test(text)) return text
    throw invalidInputError(
      `Column "${column}" is a BIT column: give a number (e.g. 5) or a bit literal (e.g. b'101').`
    )
  }
  return quoteSqlLiteral(value ?? null, dialect, quote)
}

/** MySQL/MariaDB BIT columns of a table (their values must not be written as quoted text). */
const bitColumnsOf = (
  dialect: SqlDialect,
  details: Pick<DataTableDetails, 'columns'>
): ReadonlySet<string> =>
  dialect === 'mysql' || dialect === 'mariadb'
    ? new Set(
        (details.columns ?? [])
          .filter((c) => /^bit(\(\d+\))?$/i.test(c.type.trim()))
          .map((c) => c.name)
      )
    : new Set()

const keyCondition = (
  dialect: SqlDialect,
  primaryKey: string[],
  key: Record<string, DataCell>,
  quote: SqlQuoteOptions,
  bitColumns?: ReadonlySet<string>
): string =>
  primaryKey
    .map((column) => {
      if (!(column in key))
        throw invalidInputError(`The row key is missing the primary key column "${column}".`)
      const value = key[column]
      const q = quoteSqlIdentifier(column, dialect)
      return value === null
        ? `${q} IS NULL`
        : `${q} = ${literal(value, dialect, column, quote, bitColumns)}`
    })
    .join(' AND ')

/**
 * Generates the statements (no trailing ';') for staged grid edits. `backslashEscapes`: the
 * MySQL/MariaDB session's mode (see sqlTextOptions).
 */
export function buildEditStatements(
  dialect: SqlDialect,
  ref: DataObjectRef,
  details: Pick<DataTableDetails, 'primaryKey' | 'columns' | 'kind'>,
  edits: DataRowEdit[],
  backslashEscapes?: boolean
): string[] {
  const quote = sqlTextOptions(dialect, backslashEscapes)
  if (details.kind && details.kind !== 'table') throw unsupportedError('Only tables can be edited.')
  const primaryKey = details.primaryKey
  if (primaryKey.length === 0) {
    throw unsupportedError(
      'This table has no primary key, so rows cannot be identified safely. Edit it with SQL instead.'
    )
  }
  const table = qualifiedTableName(ref, dialect)
  const q = (name: string): string => quoteSqlIdentifier(name, dialect)
  const single = dialect === 'mysql' || dialect === 'mariadb' ? ' LIMIT 1' : ''
  const full = details as DataTableDetails
  const bits = bitColumnsOf(dialect, details)
  return edits.map((edit) => {
    switch (edit.kind) {
      case 'update': {
        const columns = Object.keys(edit.changes)
        if (columns.length === 0) throw invalidInputError('An update without changed columns.')
        validateColumns(full, columns, 'the changes')
        const where = keyCondition(dialect, primaryKey, edit.key, quote, bits)
        const sets = columns
          .map((c) => `${q(c)} = ${literal(edit.changes[c], dialect, c, quote, bits)}`)
          .join(', ')
        if (dialect === 'clickhouse') return `ALTER TABLE ${table} UPDATE ${sets} WHERE ${where}`
        return `UPDATE ${table} SET ${sets} WHERE ${where}${single}`
      }
      case 'delete': {
        const where = keyCondition(dialect, primaryKey, edit.key, quote, bits)
        if (dialect === 'clickhouse') return `ALTER TABLE ${table} DELETE WHERE ${where}`
        return `DELETE FROM ${table} WHERE ${where}${single}`
      }
      case 'insert': {
        const columns = Object.keys(edit.values)
        validateColumns(full, columns, 'the new row')
        if (columns.length === 0) {
          if (dialect === 'mysql' || dialect === 'mariadb')
            return `INSERT INTO ${table} () VALUES ()`
          if (dialect === 'clickhouse')
            throw invalidInputError('Give at least one column value for the new row.')
          return `INSERT INTO ${table} DEFAULT VALUES`
        }
        const values = columns
          .map((c) => literal(edit.values[c], dialect, c, quote, bits))
          .join(', ')
        return `INSERT INTO ${table} (${columns.map(q).join(', ')}) VALUES (${values})`
      }
      default:
        throw invalidInputError('Unknown edit kind.')
    }
  })
}

const TX: Partial<Record<SqlDialect, { begin: string; commit: string; rollback: string }>> = {
  mysql: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  mariadb: { begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  postgres: { begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK' },
  sqlite: { begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK' }
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

/** The session-level `database` option: only PG routes by it (slot); others use qualified names. */
const sessionDatabase = (dialect: SqlDialect, ref: DataObjectRef): string | undefined =>
  dialect === 'postgres' ? ref.database : undefined

/**
 * ClickHouse: the ORDER BY list that pages a table deterministically and cheaply (read in
 * order): its sorting key as the catalog formats it, else its primary key columns. Undefined
 * when the table has neither (views, Memory/Log tables, ORDER BY tuple()).
 */
export function clickhouseSortingKey(details: DataTableDetails): string | undefined {
  const key = details.properties?.find((p) => p.label === 'Sorting key')?.value.trim()
  if (key && key !== 'tuple()') return key
  const primary = details.columns
    .filter((c) => c.isPrimaryKey)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((c) => quoteSqlIdentifier(c.name, 'clickhouse'))
  return primary.length > 0 ? primary.join(', ') : undefined
}

/** A table page over the drivers' result byte budget: refused rather than shown short. */
const pageTooLarge = (pageSize: number): DataDriverError =>
  new DataDriverError(
    `These rows are too large to show ${pageSize} per page. Choose a smaller page size, or select fewer columns from a query tab.`,
    { code: 'ResultTooLarge' }
  )

const firstCellNumber = (result: DataRowsResult): number | null => {
  const cell = result.rows[0]?.[0]
  if (cell === null || cell === undefined || typeof cell === 'object') return null
  const n = Number(cell)
  return Number.isFinite(n) ? n : null
}

export async function tableRows(
  deps: TableOpsDeps,
  req: DataTableRowsRequest,
  ctx: DataCallContext
): Promise<DataTableRowsResponse> {
  const now = deps.now ?? Date.now
  const record = deps.getRecord(req.dataProjectId)
  const dialect = dialectOf(record)
  const limit = Math.max(1, Math.min(Math.trunc(req.limit || 1), DATA_HARD_ROW_CAP))
  const offset = Math.max(0, Math.trunc(req.offset || 0))
  const details = await deps.describe(record.id, req.ref)
  validateColumns(
    details,
    (req.filters ?? []).map((f) => f.column),
    'the filters'
  )
  validateColumns(
    details,
    (req.orderBy ?? []).map((s) => s.column),
    'the sort'
  )
  // Stable pages: without an ORDER BY the engine may return rows in any order between pages
  // (ClickHouse reads parts in parallel), so the same page can repeat or skip rows.
  let orderBy = req.orderBy ?? []
  let orderByExpression: string | undefined
  if (orderBy.length === 0) {
    if (dialect === 'clickhouse') orderByExpression = clickhouseSortingKey(details)
    else if (details.primaryKey.length > 0)
      orderBy = details.primaryKey.map((column) => ({ column, direction: 'asc' as const }))
  }
  const ref: DataObjectRef = {
    ...req.ref,
    schema: req.ref.schema ?? details.ref.schema,
    database: req.ref.database ?? details.ref.database
  }
  /** The checked page SELECT for the session's backslash mode (MySQL/MariaDB literals). */
  const pageSql = (backslashEscapes: boolean | undefined): string => {
    const build = (expression: string | undefined): string =>
      buildSelectSql(dialect, ref, {
        filters: req.filters,
        filterJoin: req.filterJoin,
        where: req.where,
        orderBy,
        orderByExpression: expression,
        limit,
        offset,
        backslashEscapes
      })
    const lexing = sqlTextOptions(dialect, backslashEscapes)
    const sql = build(orderByExpression)
    try {
      assertSingleRead(sql, dialect, lexing)
      return sql
    } catch (error) {
      if (!orderByExpression) throw error
      // A catalog sorting key the classifier cannot vouch for: page unordered rather than fail.
      const unordered = build(undefined)
      assertSingleRead(unordered, dialect, lexing)
      return unordered
    }
  }
  // A bad raw WHERE is refused before queueing; MySQL/MariaDB text depends on the session's
  // backslash mode, so it is built (and checked) on the session.
  const mysqlFamily = dialect === 'mysql' || dialect === 'mariadb'
  let sql = mysqlFamily ? '' : pageSql(undefined)
  const hasFilter = (req.filters?.length ?? 0) > 0 || !!req.where?.trim()

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
      if (state.current) await state.current.cancelCurrent()
    }
  })
  const started = now()
  try {
    return await withConsoleSource('table', () =>
      deps.manager.runSerial(
        record.id,
        req.ref.database,
        async ({ driver }) => {
          const backslashEscapes = driver.sessionState().backslashEscapes
          if (mysqlFamily) sql = pageSql(backslashEscapes)
          const options = {
            limit: null,
            hardCap: limit,
            readOnlySandbox: true,
            database: sessionDatabase(dialect, ref),
            schema: ref.schema
          }
          state.current = driver
          let page
          try {
            page = await driver.execute(sql, options)
          } finally {
            state.current = null
          }
          if (state.cancelled) throw new DataDriverError('Query cancelled', { cancelled: true })
          if (page.output.kind !== 'rows')
            throw new DataDriverError('The table query returned no rows result.')
          // Fewer rows than asked for and still cut: the driver stopped at its result byte budget
          // (wide rows). Shown short, the page would read as the end of the table (its total
          // taken from it) and the next page (offset + page size) would skip the rows left out.
          if (page.output.truncated && page.output.rows.length < limit) throw pageTooLarge(limit)
          const result: DataRowsResult = {
            ...page.output,
            truncated: false,
            limit,
            autoLimited: false
          }

          let totalRows: number | null = null
          let totalIsEstimate = false
          const estimate =
            typeof details.rowEstimate === 'number' && details.rowEstimate >= 0
              ? details.rowEstimate
              : null
          if (result.rows.length < limit && (result.rows.length > 0 || offset === 0)) {
            totalRows = offset + result.rows.length
          } else {
            const cheap = estimate !== null && estimate < EXACT_COUNT_THRESHOLD
            if (!hasFilter && estimate !== null && !cheap) {
              totalRows = estimate
              totalIsEstimate = true
            } else {
              try {
                state.current = driver
                const count = await driver.execute(
                  buildCountSql(dialect, ref, req.filters, req.where, {
                    ...sqlTextOptions(dialect, backslashEscapes),
                    join: req.filterJoin
                  }),
                  {
                    ...options,
                    hardCap: 1,
                    timeoutMs: cheap ? undefined : COUNT_TIMEOUT_MS
                  }
                )
                if (count.output.kind === 'rows') totalRows = firstCellNumber(count.output)
              } catch (error) {
                if (state.cancelled) throw error
                // Too slow or refused: fall back to the estimate (unfiltered) or "unknown".
                if (!hasFilter && estimate !== null) {
                  totalRows = estimate
                  totalIsEstimate = true
                }
              } finally {
                state.current = null
              }
            }
          }
          // There is at least one more row after a full page.
          if (
            totalRows !== null &&
            result.rows.length === limit &&
            totalRows <= offset + limit &&
            totalIsEstimate
          ) {
            totalRows = offset + limit + 1
          }
          result.truncated =
            totalRows === null
              ? result.rows.length === limit
              : offset + result.rows.length < totalRows
          return {
            result,
            sql,
            primaryKey: details.primaryKey,
            totalRows,
            totalIsEstimate,
            durationMs: now() - started
          }
        },
        abort.signal
      )
    )
  } catch (error) {
    if (
      error instanceof QueueAbortedError ||
      state.cancelled ||
      (error instanceof DataDriverError && error.cancelled)
    ) {
      throw new DataDriverError('Query cancelled', { cancelled: true, code: 'CANCELLED' })
    }
    throw error
  } finally {
    unregister()
  }
}

/**
 * The edit statements as the session will read them. MySQL/MariaDB statements whose literals
 * depend on NO_BACKSLASH_ESCAPES (a backslash, NUL or ^Z in a value) are built for the
 * session's mode, which is returned so the caller can check it has not changed before running
 * them; `backslashEscapes` is null when the text means the same in both modes.
 */
async function editStatementsForSession(
  deps: TableOpsDeps,
  record: DataProjectRecord,
  dialect: SqlDialect,
  ref: DataObjectRef,
  details: DataTableDetails,
  edits: DataRowEdit[]
): Promise<{ statements: string[]; backslashEscapes: boolean | null }> {
  const escaped = buildEditStatements(dialect, ref, details, edits, true)
  if (dialect !== 'mysql' && dialect !== 'mariadb')
    return { statements: escaped, backslashEscapes: null }
  const literal = buildEditStatements(dialect, ref, details, edits, false)
  if (literal.every((text, i) => text === escaped[i]))
    return { statements: escaped, backslashEscapes: null }
  const mode = (await deps.manager.backslashEscapes(record.id, ref.database)) ?? true
  return { statements: mode ? escaped : literal, backslashEscapes: mode }
}

export async function previewEdits(
  deps: TableOpsDeps,
  id: string,
  ref: DataObjectRef,
  edits: DataRowEdit[]
): Promise<string[]> {
  const record = deps.getRecord(id)
  const dialect = dialectOf(record)
  const details = await deps.describe(id, ref)
  const prepared = await editStatementsForSession(
    deps,
    record,
    dialect,
    { ...ref, schema: ref.schema ?? details.ref.schema },
    details,
    edits
  )
  return prepared.statements
}

export async function applyEdits(
  deps: TableOpsDeps,
  req: DataApplyEditsRequest,
  _ctx: DataCallContext
): Promise<DataApplyEditsResponse> {
  const now = deps.now ?? Date.now
  const log = deps.logger ?? noopLogger
  const record = deps.getRecord(req.dataProjectId)
  const dialect = dialectOf(record)
  if (req.edits.length === 0)
    return { status: 'ok', statements: [], affectedRows: 0, durationMs: 0 }
  const details = await deps.describe(record.id, req.ref)
  const ref: DataObjectRef = { ...req.ref, schema: req.ref.schema ?? details.ref.schema }
  const { statements, backslashEscapes } = await editStatementsForSession(
    deps,
    record,
    dialect,
    ref,
    details,
    req.edits
  )
  const lexing = sqlTextOptions(dialect, backslashEscapes ?? undefined)
  const redact = deps.manager.redactor(record.id)

  const fingerprintText = statements.join(';\n')
  const safetyInput = {
    project: record,
    database: req.ref.database,
    source: 'grid-edit' as const,
    statements: statements.map((text, index) => {
      const c = classifySqlStatement(text, dialect, lexing)
      return {
        index,
        text,
        start: 0,
        end: text.length,
        // Generated edits are writes whatever the classifier makes of them.
        classification: c.classification === 'read' ? ('write' as const) : c.classification,
        dangerous: c.dangerous,
        targets: [ref.name]
      }
    }),
    fingerprintText,
    confirmToken: req.confirmToken
  }
  const decision = deps.gate.evaluate(safetyInput)
  const history = (
    status: DataHistoryEntry['status'],
    durationMs: number | null,
    rowCount: number | null,
    error: string | null
  ): void => {
    try {
      deps.recordHistory({
        dataProjectId: record.id,
        database: req.ref.database ?? record.config.database ?? null,
        // engine-service.recordHistory masks every history row (text and error) once.
        text: `${statements.join(';\n')};`,
        status,
        durationMs,
        rowCount,
        error,
        executedAt: new Date().toISOString()
      })
    } catch (e) {
      log.warn('Failed to record grid-edit history', {
        dataProjectId: record.id,
        error: errorMessage(e)
      })
    }
  }
  if (decision.action === 'block') {
    history('blocked', null, null, decision.reason)
    return { status: 'blocked', plan: decision.plan, reason: decision.reason }
  }
  if (decision.action === 'confirm') {
    return {
      status: 'confirmation_required',
      plan: decision.plan,
      confirmToken: decision.confirmToken
    }
  }

  const started = now()
  const tx = TX[dialect]
  return withConsoleSource('edit', () =>
    deps.manager.runSerial(record.id, req.ref.database, async ({ driver }) => {
      const session: ReturnType<DataDriver['sessionState']> = driver.sessionState()
      if (session.inTransaction) {
        throw busyError(
          'The SQL session has an open transaction. COMMIT or ROLLBACK it in the query tab before saving grid changes.'
        )
      }
      if (session.tablesLocked && tx) {
        // Saving starts a transaction, and on MySQL/MariaDB that silently releases LOCK TABLES.
        throw busyError(
          'The SQL session holds table locks (LOCK TABLES). Run UNLOCK TABLES in the query tab before saving grid changes: saving starts a transaction, which would release them.'
        )
      }
      if (backslashEscapes !== null && (session.backslashEscapes ?? true) !== backslashEscapes) {
        // A SET sql_mode ran since the statements were built: their backslashes would be misread.
        throw busyError(
          'The session’s sql_mode (NO_BACKSLASH_ESCAPES) changed while the changes were being saved. Nothing was saved; save again.'
        )
      }
      const options = {
        limit: null,
        hardCap: 1,
        readOnlySandbox: false,
        database: sessionDatabase(dialect, ref),
        schema: ref.schema
      }
      let affected = 0
      let inTx = false
      try {
        if (tx) {
          await driver.execute(tx.begin, options)
          inTx = true
        }
        for (let i = 0; i < statements.length; i++) {
          let result
          try {
            result = await driver.execute(statements[i], options)
          } catch (error) {
            throw new Error(
              `Change ${i + 1} of ${statements.length} failed: ${errorMessage(error, redact)}`
            )
          }
          const count = result.output.kind === 'command' ? result.output.affectedRows : null
          if (dialect !== 'clickhouse' && typeof count === 'number') {
            if (count === 0) {
              throw invalidInputError(
                `Change ${i + 1} of ${statements.length} matched no row: it was changed or deleted since it was loaded. Nothing was saved; reload the table.`
              )
            }
            if (count > 1) {
              throw invalidInputError(
                `Change ${i + 1} of ${statements.length} would affect ${count} rows (the key is not unique). Nothing was saved.`
              )
            }
          }
          affected += typeof count === 'number' ? count : 1
        }
        if (tx) {
          await driver.execute(tx.commit, options)
          inTx = false
        }
        const durationMs = now() - started
        history('ok', durationMs, affected, null)
        return { status: 'ok' as const, statements, affectedRows: affected, durationMs }
      } catch (error) {
        if (inTx && tx && driver.isConnected())
          await driver.execute(tx.rollback, options).catch(() => undefined)
        const message = errorMessage(error, redact)
        history('error', now() - started, null, message)
        throw error instanceof Error ? error : new Error(message)
      }
    })
  )
}
