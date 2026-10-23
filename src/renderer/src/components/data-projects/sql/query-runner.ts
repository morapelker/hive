// Running editor text for a query tab: one `dataProjects.query.execute` per run, wrapped in the
// safety confirmation flow, with the run's lifecycle kept in useDataWorkspaceStore so the tab's
// results survive switching tabs and a late answer of an older run never overwrites a newer one.
//
// Cancel: the queryId of the request in flight is in the run; `dataProjects.query.cancel` stops
// the statement server-side and the execute answers `cancelled` with what finished before.
//
// A run in which a DDL statement (CREATE / ALTER / DROP / RENAME / TRUNCATE / COMMENT ...)
// succeeded tells the workspace store, which reloads the schema tree and the completion schemas.
// The tree and completion load on a separate control connection, which cannot see DDL that is
// still inside the session's open transaction (PostgreSQL, SQLite): the run that ends that
// transaction (COMMIT, END, ROLLBACK, a lost session) reloads them once more.

import {
  sqlDialectOf,
  type DataProject,
  type DataQueryResponse,
  type DataStatementResult
} from '@shared/data-projects/types'
import { dataProjectsApi } from '@/api/data-projects-api'
import {
  errorMessage,
  isCredentialsRequiredError
} from '@/components/data-projects/data-project-ui'
import {
  runWithConfirmation,
  type DeclinedResponse
} from '@/components/data-projects/shared/confirm'
import { toast } from '@/lib/toast'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useDataWorkspaceStore, type QueryRunTarget } from '@/stores/useDataWorkspaceStore'
import { explainPrefix, isExplainStatement } from '../editor/dialects'

export const newQueryId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `q-${Date.now()}-${Math.random().toString(36).slice(2)}`

/**
 * The result tab to show after a run: the first result set, or Messages (-1) when a statement
 * failed (the error matters more than earlier rows) or nothing returned rows.
 */
export function firstResultIndex(statements: DataStatementResult[]): number {
  if (statements.some((s) => s.error)) return -1
  return statements.some((s) => s.output?.kind === 'rows') ? 0 : -1
}

/** True when a statement of the run changed the schema (a DDL statement that succeeded). */
export const ranSchemaChange = (statements: DataStatementResult[]): boolean =>
  statements.some((s) => s.classification === 'ddl' && !s.error)

/**
 * Sessions in which DDL succeeded while a transaction was (or may have been) open and that has
 * not ended yet. Keyed like the server's session slots: one per project, one per database on
 * PostgreSQL.
 */
const ddlInOpenTx = new Set<string>()

const txSessionKey = (
  projectId: string,
  dialect: ReturnType<typeof sqlDialectOf>,
  database: string | undefined
): string => `${projectId}\u0000${dialect === 'postgres' ? (database ?? '') : ''}`

/**
 * Whether the run must reload the explorer and completion: it ran DDL, or it ended a
 * transaction in which earlier DDL ran. Keeps the open-transaction bookkeeping up to date.
 */
function schemaRefreshNeeded(response: DataQueryResponse | DeclinedResponse, key: string): boolean {
  if (response.status !== 'ok' && response.status !== 'cancelled') return false
  const changed = ranSchemaChange(response.statements)
  if (response.status === 'cancelled') {
    // The transaction state after a cancel is unknown: check again on the next answer.
    if (changed) ddlInOpenTx.add(key)
    return changed
  }
  if (response.inTransaction === true) {
    if (changed) ddlInOpenTx.add(key)
    return changed
  }
  return ddlInOpenTx.delete(key) || changed
}

/** Forgets the open-transaction bookkeeping (tests). */
export function resetQueryRunnerForTests(): void {
  ddlInOpenTx.clear()
}

export interface RunQueryInput {
  project: DataProject
  tabId: string
  target: QueryRunTarget
  database?: string
  schema?: string
  /** Auto-limit (null/0 = none). */
  limit: number | null
  explain?: boolean
}

/** Runs `target` for the tab. Resolves when the run finished (any outcome); never throws. */
export async function runQueryInTab(input: RunQueryInput): Promise<void> {
  const store = useDataWorkspaceStore.getState()
  const { project, tabId } = input
  const dialect = sqlDialectOf(project.engine)
  let target = input.target
  if (input.explain && dialect && !isExplainStatement(target.text)) {
    const prefix = explainPrefix(dialect)
    // Shift `from` so server error offsets (which include the prefix) still map onto the editor.
    target = { ...target, text: `${prefix}${target.text}`, from: target.from - prefix.length }
  }
  const limit = input.limit && input.limit > 0 ? input.limit : null
  // Only PostgreSQL takes a schema (search_path head) with the request.
  const schema = dialect === 'postgres' && input.schema ? input.schema : undefined
  const runId = store.startRun(tabId, {
    status: 'running',
    target,
    queryId: null,
    startedAt: Date.now(),
    database: input.database,
    ...(schema ? { schema } : {}),
    limit,
    explain: input.explain,
    statements: [],
    activeResult: 0
  })
  // A run counts as "touching" the tab: the origin badge goes away.
  store.patchQueryTab(project.id, tabId, { origin: undefined })

  // The queryId is only set while a request is in flight: while the confirm dialog waits there
  // is nothing to cancel (and the overlay says so).
  const call = async (confirmToken?: string): Promise<DataQueryResponse> => {
    const queryId = newQueryId()
    useDataWorkspaceStore.getState().updateRun(tabId, runId, { queryId })
    try {
      return await dataProjectsApi.execute({
        dataProjectId: project.id,
        queryId,
        text: target.text,
        ...(input.database ? { database: input.database } : {}),
        ...(schema ? { schema } : {}),
        limit,
        ...(confirmToken ? { confirmToken } : {}),
        source: 'editor',
        stopOnError: true
      })
    } finally {
      useDataWorkspaceStore.getState().updateRun(tabId, runId, { queryId: null })
    }
  }

  const finish = (patch: Parameters<typeof store.updateRun>[2]): void =>
    useDataWorkspaceStore.getState().updateRun(tabId, runId, {
      queryId: null,
      finishedAt: Date.now(),
      ...patch
    })

  try {
    const response = await runWithConfirmation(call)
    const sessionDatabase = (response.status === 'ok' && response.database) || input.database
    if (schemaRefreshNeeded(response, txSessionKey(project.id, dialect, sessionDatabase))) {
      useDataWorkspaceStore.getState().notifySchemaChanged(project.id)
    }
    switch (response.status) {
      case 'ok': {
        finish({
          status: 'ok',
          statements: response.statements,
          durationMs: response.durationMs,
          inTransaction: response.inTransaction,
          activeResult: firstResultIndex(response.statements),
          ...(response.database ? { database: response.database } : {})
        })
        // `USE other` / a reconnect moved the session: keep the tab pointing where it runs now.
        if (response.database && response.database !== input.database) {
          useDataWorkspaceStore
            .getState()
            .patchQueryTab(project.id, tabId, { database: response.database })
        }
        break
      }
      case 'cancelled':
        finish({
          status: 'cancelled',
          statements: response.statements,
          durationMs: response.durationMs,
          activeResult: firstResultIndex(response.statements)
        })
        break
      case 'declined':
        finish({ status: 'declined', activeResult: -1 })
        break
      case 'blocked':
        finish({ status: 'blocked', blockedReason: response.reason, activeResult: -1 })
        break
      default:
        finish({
          status: 'error',
          error: 'The server asked for confirmation again; nothing ran.',
          activeResult: -1
        })
    }
  } catch (error) {
    const message = errorMessage(error, 'The query failed')
    finish({ status: 'error', error: message, activeResult: -1 })
    if (isCredentialsRequiredError(error)) {
      useDataProjectStore.getState().openCredentialsPrompt(project.id, message)
    }
  } finally {
    useDataWorkspaceStore.getState().bumpHistory(project.id)
  }
}

/** Cancels the tab's running query (no-op when nothing is in flight). */
export async function cancelQueryInTab(tabId: string): Promise<void> {
  const run = useDataWorkspaceStore.getState().runs[tabId]
  if (!run || run.status !== 'running' || !run.queryId) return
  const queryId = run.queryId
  useDataWorkspaceStore.getState().updateRun(tabId, run.runId, { cancelRequested: true })
  try {
    const { cancelled } = await dataProjectsApi.cancel(queryId)
    if (!cancelled) {
      // Finished between the click and the cancel: the result arrives normally.
      useDataWorkspaceStore.getState().updateRun(tabId, run.runId, { cancelRequested: false })
    }
  } catch (error) {
    useDataWorkspaceStore.getState().updateRun(tabId, run.runId, { cancelRequested: false })
    toast.error(`Cancel failed: ${errorMessage(error)}`)
  }
}
