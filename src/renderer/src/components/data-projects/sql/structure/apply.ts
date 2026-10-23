// Apply of the structure editor: the planned DDL goes out as ONE `dataProjects.query.execute`
// (source 'schema-action', stopOnError) wrapped in runWithConfirmation, so the server's safety
// gate judges every statement like any other DDL: read-only mode blocks it, safe / half-safe ask
// with the statements listed, a DROP COLUMN / DROP INDEX on production asks for the table name
// to be typed. The server runs the statements one by one on the project's session and stops at
// the first error; what ran before it stays applied (only MySQL's single ALTER is all or nothing).
//
// The outcome says how many statements succeeded, so the caller can drop exactly those
// operations from the staging (rebaseAfterApply) and keep the rest for another try. Before and
// after the run, the engine's own rules decide what that count really means:
//
//   MySQL / MariaDB  DDL commits an open transaction implicitly: with one open on the session
//                    (a BEGIN in a query tab) nothing is sent ('refused'). When the statements
//                    hold a backslash, the session's NO_BACKSLASH_ESCAPES mode must be the one
//                    they were built for (it changes what the backslash means); otherwise
//                    nothing is sent and the outcome carries the mode to rebuild them with.
//   PostgreSQL       a failure inside an open transaction aborts it: COMMIT then rolls back
//                    everything, so nothing of the run counts as applied.
//   ClickHouse       ALTERs are not transactional: MODIFY COLUMN commits the new type before it
//                    converts the stored data, so a failed conversion can leave the new type in
//                    effect. The column is read back (SHOW CREATE TABLE) to say what holds now.

import type {
  DataConnectionStatus,
  DataEngine,
  DataObjectRef,
  DataProject,
  DataQueryResponse
} from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import { errorMessage } from '@/components/data-projects/data-project-ui'
import { runWithConfirmation } from '../../shared/confirm'
import { newQueryId } from '../query-runner'
import { clickhouseColumnType, parseCreateTable } from './ddl-parse'
import type { PlannedStatement, StructureOp } from './structure-model'

export interface StructureApplyContext {
  /** The altered table (ClickHouse: read back after a failure). */
  table?: DataObjectRef
  /** MySQL / MariaDB: the backslash mode the statements were built for (default true). */
  backslashEscapes?: boolean
}

/** ClickHouse: a failed type change, read back from the table after the failure. */
export interface RetypeReadBack {
  column: string
  from: string
  to: string
  /** The column's type now (null when it could not be read). */
  now: string | null
  /** 'in-effect': the type is no longer `from`; 'not-applied': it still is. */
  state: 'in-effect' | 'not-applied' | 'unknown'
  /** The statement that changes the type back. */
  revert: string
}

export interface StructureApplyOutcome {
  /** 'refused': nothing was sent (see `error`). */
  status: 'ok' | 'failed' | 'declined' | 'blocked' | 'refused'
  /** Statements that ran without error (a prefix of the plan) and are kept. */
  applied: number
  total: number
  /** The operations of the applied statements, in order. */
  appliedOps: StructureOp[]
  error?: { message: string; statement?: string; index?: number }
  /** The session still has an open transaction (PostgreSQL / SQLite DDL is not committed). */
  inTransaction?: boolean
  /**
   * MySQL / MariaDB, 'refused' because the session's NO_BACKSLASH_ESCAPES differs from what the
   * statements were built for: the session's mode (false = NO_BACKSLASH_ESCAPES).
   */
  backslashEscapes?: boolean
  /** PostgreSQL: the failure aborted the open transaction; nothing of this run will be kept. */
  transactionAborted?: boolean
  /** ClickHouse: the failing statement changed a column's type; what is in effect now. */
  retype?: RetypeReadBack
  /** The table may have changed although `applied` does not say so: read it again. */
  schemaChanged?: boolean
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const engineLabel = (engine: DataEngine): string => (engine === 'mariadb' ? 'MariaDB' : 'MySQL')

export const openTransactionMessage = (engine: DataEngine): string =>
  `This connection has an open transaction (started in a query tab). ${engineLabel(engine)} commits it before running any DDL, so its changes could no longer be rolled back. COMMIT or ROLLBACK it in a query tab, then apply again.`

export const backslashModeMessage = (backslashEscapes: boolean): string =>
  backslashEscapes
    ? 'This connection no longer runs with NO_BACKSLASH_ESCAPES (a backslash in a string starts an escape again): the statements were rebuilt for it. Review them and apply again.'
    : 'This connection runs with NO_BACKSLASH_ESCAPES (a backslash in a string is an ordinary character): the statements were rebuilt for it. Review them and apply again.'

/** Counts the leading statements of a response that ran without error. */
function succeededPrefix(response: Extract<DataQueryResponse, { statements: unknown }>): {
  applied: number
  failed?: { index: number; message: string; statement: string }
} {
  const byIndex = new Map<number, { error?: string; text: string }>()
  for (const s of response.statements) {
    const seen = byIndex.get(s.index)
    if (!seen || s.error)
      byIndex.set(s.index, { error: s.error?.message ?? seen?.error, text: s.text })
  }
  let applied = 0
  for (;;) {
    const s = byIndex.get(applied)
    if (!s) return { applied }
    if (s.error) return { applied, failed: { index: applied, message: s.error, statement: s.text } }
    applied++
  }
}

/** The connection status (fresh from the server; null when it cannot be had). */
async function sessionStatus(
  project: DataProject
): Promise<(DataConnectionStatus & { backslashEscapes?: boolean }) | null> {
  try {
    return (await dataProjectsApi.status(project.id)) ?? null
  } catch {
    return null
  }
}

const NO_BACKSLASH_ESCAPES = /(^|,)\s*NO_BACKSLASH_ESCAPES\s*(,|$)/i

/** MySQL / MariaDB: reads the session's sql_mode (a read through the normal gate). */
async function readBackslashMode(
  project: DataProject,
  database: string | undefined
): Promise<
  | { kind: 'mode'; backslashEscapes: boolean; inTransaction?: boolean }
  | { kind: 'declined' }
  | { kind: 'error'; message: string }
> {
  try {
    const response = await runWithConfirmation((confirmToken) =>
      dataProjectsApi.execute({
        dataProjectId: project.id,
        queryId: newQueryId(),
        text: 'SELECT @@SESSION.sql_mode',
        ...(database ? { database } : {}),
        limit: null,
        ...(confirmToken ? { confirmToken } : {}),
        source: 'table',
        stopOnError: true
      })
    )
    if (response.status === 'declined') return { kind: 'declined' }
    if (response.status === 'blocked') return { kind: 'error', message: response.reason }
    if (response.status !== 'ok') return { kind: 'error', message: 'The check did not run.' }
    const statement = response.statements[0]
    if (statement?.error) return { kind: 'error', message: statement.error.message }
    const cell = statement?.output?.kind === 'rows' ? statement.output.rows[0]?.[0] : undefined
    if (typeof cell !== 'string')
      return { kind: 'error', message: 'The session did not report its sql_mode.' }
    return {
      kind: 'mode',
      backslashEscapes: !NO_BACKSLASH_ESCAPES.test(cell),
      inTransaction: response.inTransaction
    }
  } catch (err) {
    return { kind: 'error', message: errorMessage(err, 'The check failed') }
  }
}

const sameType = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '')

/** ClickHouse: the type the column has now, from SHOW CREATE TABLE (uncached). */
async function readBackRetype(
  project: DataProject,
  table: DataObjectRef | undefined,
  retype: NonNullable<Extract<StructureOp, { kind: 'column' }>['retype']>
): Promise<RetypeReadBack> {
  const base = { column: retype.column, from: retype.from, to: retype.to, revert: retype.revert }
  if (!table) return { ...base, now: null, state: 'unknown' }
  try {
    const ddl = await dataProjectsApi.ddl(project.id, table)
    const definition = parseCreateTable(ddl, 'clickhouse')?.columns.get(retype.column)
    const now = definition ? clickhouseColumnType(definition) : ''
    if (!now) return { ...base, now: null, state: 'unknown' }
    return { ...base, now, state: sameType(now, retype.from) ? 'not-applied' : 'in-effect' }
  } catch {
    return { ...base, now: null, state: 'unknown' }
  }
}

export async function applyStructureStatements(
  project: DataProject,
  database: string | undefined,
  statements: PlannedStatement[],
  context: StructureApplyContext = {}
): Promise<StructureApplyOutcome> {
  const total = statements.length
  const text = statements.map((s) => `${s.sql};`).join('\n')
  const opsOf = (n: number): StructureOp[] => statements.slice(0, n).flatMap((s) => s.ops)
  const engine = project.engine
  const mysqlFamily = engine === 'mysql' || engine === 'mariadb'
  const notSent = (
    status: 'failed' | 'declined' | 'refused',
    message?: string
  ): StructureApplyOutcome => ({
    status,
    applied: 0,
    total,
    appliedOps: [],
    ...(message ? { error: { message } } : {})
  })
  try {
    if (mysqlFamily) {
      const status = await sessionStatus(project)
      if (status?.inTransaction)
        return { ...notSent('refused', openTransactionMessage(engine)), inTransaction: true }
      // A backslash is the one thing NO_BACKSLASH_ESCAPES changes (the server checks the same).
      if (text.includes('\\')) {
        let mode = status?.backslashEscapes
        if (mode === undefined) {
          const probe = await readBackslashMode(project, database)
          if (probe.kind === 'declined') return notSent('declined')
          if (probe.kind === 'error')
            return notSent(
              'failed',
              `Could not read the session’s sql_mode, which decides how the backslashes in these statements are read: ${probe.message}`
            )
          if (probe.inTransaction)
            return { ...notSent('refused', openTransactionMessage(engine)), inTransaction: true }
          mode = probe.backslashEscapes
        }
        if (mode !== (context.backslashEscapes ?? true))
          return { ...notSent('refused', backslashModeMessage(mode)), backslashEscapes: mode }
      }
    }
    const response = await runWithConfirmation((confirmToken) =>
      dataProjectsApi.execute({
        dataProjectId: project.id,
        queryId: newQueryId(),
        text,
        ...(database ? { database } : {}),
        limit: null,
        ...(confirmToken ? { confirmToken } : {}),
        source: 'schema-action',
        stopOnError: true
      })
    )
    switch (response.status) {
      case 'declined':
        return { status: 'declined', applied: 0, total, appliedOps: [] }
      case 'blocked':
        return {
          status: 'blocked',
          applied: 0,
          total,
          appliedOps: [],
          error: { message: response.reason }
        }
      case 'confirmation_required':
        return notSent('failed', 'The server asked for confirmation again; nothing ran.')
      case 'ok':
      case 'cancelled': {
        const { applied, failed } = succeededPrefix(response)
        const inTransaction = response.status === 'ok' ? response.inTransaction : undefined
        if (!failed && applied >= total)
          return { status: 'ok', applied, total, appliedOps: opsOf(total), inTransaction }
        const error = failed
          ? failed
          : { message: 'The run was cancelled before every statement ran.', index: applied }
        // A PostgreSQL error inside a transaction block aborts the transaction: the statements
        // of this run that succeeded go when it ends (COMMIT rolls back too), so none is applied.
        if (engine === 'postgres' && failed && inTransaction === true)
          return {
            status: 'failed',
            applied: 0,
            total,
            appliedOps: [],
            inTransaction: true,
            transactionAborted: true,
            error
          }
        const outcome: StructureApplyOutcome = {
          status: 'failed',
          applied,
          total,
          appliedOps: opsOf(applied),
          inTransaction,
          error
        }
        if (engine === 'clickhouse' && failed) {
          // Not transactional: whatever the failing ALTER got to commit stays.
          outcome.schemaChanged = true
          const op = statements[applied]?.ops.find(
            (o): o is Extract<StructureOp, { kind: 'column' }> => o.kind === 'column' && !!o.retype
          )
          if (op?.retype) outcome.retype = await readBackRetype(project, context.table, op.retype)
        }
        return outcome
      }
    }
  } catch (err) {
    return notSent('failed', errorMessage(err, 'The structure change failed'))
  }
}

/** The banner of a run that did not apply everything: a headline and an optional note. */
export function applyFailureSummary(outcome: StructureApplyOutcome): {
  headline: string
  note?: string
} {
  const { applied, total } = outcome
  if (outcome.status === 'refused') return { headline: 'Nothing was applied.' }
  // The failing statement (an aborted transaction keeps none applied, so not `applied + 1`).
  const failedAt = outcome.error?.index ?? applied
  const which = total > 1 ? `Statement ${failedAt + 1} of ${total}` : 'The statement'
  if (outcome.transactionAborted)
    return {
      headline: `${which} failed inside the open transaction, which is now aborted: nothing of this run will be kept.`,
      note: 'COMMIT would roll it back as well. ROLLBACK in a query tab, then apply again: every change is still staged.'
    }
  const before =
    applied > 0
      ? `the ${plural(applied, 'statement')} before it ${applied === 1 ? 'was' : 'were'} applied`
      : null
  const retype = outcome.retype
  if (retype?.state === 'in-effect')
    return {
      headline: `${which} failed after its type change took effect: "${retype.column}" is now ${retype.now}, but ClickHouse could not convert the stored data${before ? `; ${before}` : ''}.`,
      note: 'ClickHouse ALTERs are not transactional. Reads of the table fail until the type is changed back (below), or until the data is fixed and the change applied again: it is still staged.'
    }
  if (retype?.state === 'unknown')
    return {
      headline: `${which} failed${before ? `; ${before}` : ''}. ClickHouse may have kept the new type of "${retype.column}" (its ALTERs are not transactional): check the table.`,
      note: 'If reads of the table fail, change the type back (below). The change is still staged.'
    }
  if (before) return { headline: `${which} failed; ${before}, the rest is still staged.` }
  if (outcome.error?.statement === undefined) return { headline: 'Nothing was applied.' }
  return {
    headline:
      total > 1
        ? `Statement 1 of ${total} failed; nothing was applied.`
        : 'The statement failed; nothing was applied.'
  }
}
