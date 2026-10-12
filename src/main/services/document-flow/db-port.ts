import type {
  DocumentRun,
  DocumentRunConfig,
  DocumentRunEvent,
  DocumentRunExtractionMeta,
  DocumentRunItem,
  DocumentRunItemDraft,
  DocumentRunItemPatch,
  DocumentRunMember,
  DocumentRunReport,
  DocumentRunStatus,
  SessionFinalMessage,
  SessionTurnState
} from '@shared/types/document-flow'

// The persistence the document flow needs, as an interface: `DatabaseService` implements it
// (document_runs, document_run_items, document_run_events, session_final_messages — schema v52,
// document_runs.ticket_id v53,
// document_runs.migration_session_id / migration_started_at / migration_owner_pid v54,
// document_runs.integration_connection_id / integration_connection_path / members and
// document_run_items.connection_id / members v56), and the service's tests substitute an in-memory fake.

export interface DocumentRunCreate {
  /** Caller-supplied so the run directory can be named after it before the row exists. */
  id: string
  project_id: string
  title: string
  source_path: string
  run_dir: string
  document_path?: string | null
  status: DocumentRunStatus
  config: DocumentRunConfig
}

/** Every mutable column of a run. `config` replaces the stored object. */
export interface DocumentRunRowPatch {
  title?: string
  document_path?: string | null
  status?: DocumentRunStatus
  error?: string | null
  config?: DocumentRunConfig
  extraction?: DocumentRunExtractionMeta | null
  base_branch?: string | null
  base_sha?: string | null
  integration_branch?: string | null
  integration_worktree_id?: string | null
  integration_worktree_path?: string | null
  integration_connection_id?: string | null
  integration_connection_path?: string | null
  members?: DocumentRunMember[] | null
  ticket_id?: string | null
  report?: DocumentRunReport | null
  migration_session_id?: string | null
  migration_started_at?: string | null
  migration_owner_pid?: number | null
  started_at?: string | null
  finished_at?: string | null
}

/** Stored as-is; `position` follows the array order and `status` starts as `pending`. */
export type DocumentRunItemCreate = DocumentRunItemDraft

/** Every mutable column of an item: the renderer-facing patch plus the merge bookkeeping. */
export interface DocumentRunItemRowPatch extends DocumentRunItemPatch {
  pre_merge_sha?: string | null
  merge_sha?: string | null
}

export interface DocumentRunEventCreate {
  run_id: string
  item_id?: string | null
  type: string
  message: string
  data?: unknown
}

export interface SessionFinalMessageUpsert {
  session_id: string
  /** Defaults to `ended`. */
  state?: SessionTurnState
  /** For a non-ended state, pass undefined to keep the text of the last turn end. */
  text?: string
  completion: string | null
  api_error: string | null
  hook_event: string
  detail?: string | null
}

export interface DocumentRunnerClaimResult {
  owned: boolean
  ownerClientId: string | null
}

export interface DocumentFlowDb {
  createDocumentRun(data: DocumentRunCreate): DocumentRun
  getDocumentRun(id: string): DocumentRun | null
  /** Newest first. */
  listDocumentRuns(projectId?: string, limit?: number): DocumentRun[]
  updateDocumentRun(id: string, patch: DocumentRunRowPatch): DocumentRun | null
  /** Deletes the run with its items and events. */
  deleteDocumentRun(id: string): boolean

  /** Replace every item of the run (one transaction). `position` follows the array order. */
  replaceDocumentRunItems(runId: string, items: DocumentRunItemCreate[]): DocumentRunItem[]
  /** Ordered by `position`. */
  getDocumentRunItems(runId: string): DocumentRunItem[]
  getDocumentRunItem(id: string): DocumentRunItem | null
  updateDocumentRunItem(id: string, patch: DocumentRunItemRowPatch): DocumentRunItem | null

  appendDocumentRunEvent(data: DocumentRunEventCreate): DocumentRunEvent
  /** The newest `limit` events, oldest first; only those of `type` when it is given. */
  listDocumentRunEvents(runId: string, limit?: number, type?: string): DocumentRunEvent[]

  /**
   * Single-owner lease. Grants (and stamps the heartbeat) when the run has no owner, the
   * owner is `clientId`, or the owner's heartbeat is older than `staleBeforeIso`. One
   * atomic UPDATE, so two clients racing for a stale lease cannot both win.
   */
  claimDocumentRunRunner(
    runId: string,
    clientId: string,
    nowIso: string,
    staleBeforeIso: string
  ): DocumentRunnerClaimResult

  upsertSessionFinalMessage(data: SessionFinalMessageUpsert): void
  getSessionFinalMessage(sessionId: string): SessionFinalMessage | null
  deleteSessionFinalMessage(sessionId: string): void
}
