// Server-side contracts of data projects (runs in the backend server child). The modules of
// this directory implement them:
//
//   secrets.ts            DataSecretsStore      (safeStorage vault via desktop commands + memory)
//   engine-service.ts     DataEngineService     (connection manager, query runner, export, ...)
//   safety-gate.ts        evaluateSafety()      (mode × classification → run / confirm / block)
//   drivers/*.ts          DataDriver            (one per engine family)
//   mongo/*.ts            MongoDriver + MongoEngineService
//   ../db (database.ts)   DataProjectsRepository (rows, history, saved queries)
//
// The RPC domains (src/server/rpc/domains/data-projects.ts, data-assistant.ts) are thin zod
// wrappers over DataEngineService / DataProjectsRepository / DataAssistantService.

import type {
  DataApplyEditsRequest,
  DataApplyEditsResponse,
  DataCompletionSchema,
  DataConnectionConfig,
  DataConnectionStatus,
  DataDatabaseInfo,
  DataEngine,
  DataExecutionPlan,
  DataExportRequest,
  DataExportResponse,
  DataHistoryEntry,
  DataKillScope,
  DataObjectRef,
  DataObjectsListing,
  DataProcessInfo,
  DataProject,
  DataProjectIcon,
  DataEnvironment,
  DataQueryRequest,
  DataQueryResponse,
  DataQuerySource,
  DataRowEdit,
  DataSafeMode,
  DataSavedQuery,
  DataSecrets,
  DataSecretState,
  DataStatementClass,
  DataStatementOutput,
  DataTableDetails,
  DataTableRowsRequest,
  DataTableRowsResponse,
  DataTestConnectionInput,
  DataTestConnectionResult,
  MongoAggregateRequest,
  MongoAggregateResponse,
  MongoCollectionMutationRequest,
  MongoCollectionMutationResponse,
  MongoCreateIndexRequest,
  MongoDropIndexRequest,
  MongoExplainRequest,
  MongoExplainResponse,
  MongoFindRequest,
  MongoFindResponse,
  MongoIndexInfo,
  MongoIndexMutationResponse,
  MongoSchemaRequest,
  MongoSchemaResponse,
  MongoWriteRequest,
  MongoWriteResponse,
  SidebarOrderEntry
} from '../../../shared/data-projects/types'
import type {
  DataImportPreviewRequest,
  DataImportPreviewResponse,
  DataImportResponse,
  DataImportStartRequest
} from '../../../shared/data-projects/import-types'

// ---------------------------------------------------------------------------------------------
// Persistence (implemented on DatabaseService in src/main/db/database.ts)
// ---------------------------------------------------------------------------------------------

/** The stored row, mapped. `secretCiphertext` never leaves the server. */
export interface DataProjectRecord {
  id: string
  name: string
  engine: DataEngine
  config: DataConnectionConfig
  icon: DataProjectIcon | null
  iconColor: string | null
  environment: DataEnvironment
  color: string | null
  safeMode: DataSafeMode
  defaultLimit: number
  allowAiDataAccess: boolean
  pinned: boolean
  /** `v1:<base64>` safeStorage ciphertext of JSON DataSecrets, or null. */
  secretCiphertext: string | null
  /** 'none' | 'stored' | 'session' as last written; 'unavailable' is computed at read time. */
  secretState: DataSecretState
  sortOrder: number
  createdAt: string
  lastAccessedAt: string
}

export interface DataProjectRecordCreate {
  id?: string
  name: string
  engine: DataEngine
  config: DataConnectionConfig
  icon: DataProjectIcon | null
  iconColor: string | null
  environment: DataEnvironment
  color: string | null
  safeMode: DataSafeMode
  defaultLimit: number
  allowAiDataAccess: boolean
  pinned: boolean
  secretCiphertext: string | null
  secretState: DataSecretState
}

export type DataProjectRecordPatch = Partial<Omit<DataProjectRecordCreate, 'id' | 'engine'>>

/**
 * Methods added to DatabaseService (src/main/db/database.ts). Every mutation emits
 * `db:changed { entity: 'dataProject', op, id }` (shared/db-change-events.ts), except history.
 */
export interface DataProjectsRepository {
  getDataProjects(): DataProjectRecord[]
  getDataProject(id: string): DataProjectRecord | null
  /** Inserts at sort_order 0 and shifts both projects and data_projects down by one. */
  createDataProject(data: DataProjectRecordCreate): DataProjectRecord
  updateDataProject(id: string, patch: DataProjectRecordPatch): DataProjectRecord | null
  deleteDataProject(id: string): boolean
  touchDataProject(id: string): void
  /** Writes sort_order = index across projects and data_projects in one transaction. */
  reorderSidebar(entries: SidebarOrderEntry[]): void

  addDataQueryHistory(entry: Omit<DataHistoryEntry, 'id'>): DataHistoryEntry
  /** Newest first; `search` is a case-insensitive substring filter on the text. */
  listDataQueryHistory(
    dataProjectId: string,
    options?: { search?: string; limit?: number }
  ): DataHistoryEntry[]
  clearDataQueryHistory(dataProjectId: string): void

  listDataSavedQueries(dataProjectId: string): DataSavedQuery[]
  saveDataSavedQuery(
    dataProjectId: string,
    query: { id?: string; name: string; text: string; database?: string | null }
  ): DataSavedQuery
  deleteDataSavedQuery(dataProjectId: string, savedId: string): void
}

/** DataProjectRecord → the renderer DTO (drops the ciphertext, resolves the secret state). */
export type ToDataProjectDto = (record: DataProjectRecord) => DataProject

// ---------------------------------------------------------------------------------------------
// Secrets (secrets.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Persistent secrets are encrypted with Electron safeStorage in the MAIN process (desktop
 * commands `dataSecretEncrypt` / `dataSecretDecrypt` over the server↔main IPC pipe). When no
 * vault is reachable (browser/headless mode, encryption unavailable) secrets live in server
 * memory only ('session') and are asked for again after a restart.
 */
export interface DataSecretsStore {
  /** Encrypts and stores (or keeps in memory) the secrets; returns the resulting state. */
  store(
    dataProjectId: string,
    secrets: DataSecrets
  ): Promise<{ ciphertext: string | null; state: DataSecretState }>
  /** Plaintext secrets for connecting ({} when none). Throws DATA_CREDENTIALS_REQUIRED-coded errors when a secret exists but cannot be read. */
  resolve(dataProjectId: string): Promise<DataSecrets>
  /** Session-only secrets (not persisted), e.g. "enter password for this session". */
  remember(dataProjectId: string, secrets: DataSecrets): void
  forget(dataProjectId: string): void
  /** Current state for the DTO (stored / session / unavailable / none). */
  stateOf(record: DataProjectRecord): DataSecretState
  /** Every secret string currently known for a project, for `redactSecrets` in error texts. */
  knownSecrets(dataProjectId: string): string[]
}

// ---------------------------------------------------------------------------------------------
// Safety gate (safety-gate.ts)
// ---------------------------------------------------------------------------------------------

export interface SafetyStatementInput {
  index: number
  text: string
  start: number
  end: number
  classification: DataStatementClass
  dangerous: string[]
  /**
   * Objects the statement targets (classifier `targetTables`, Mongo collection). Used for the
   * production type-to-confirm name; the gate falls back to parsing the text, then the database.
   */
  targets?: string[]
  /** The classifier's own explanation ("calls pg_sleep(), which has side effects"), if any. */
  reasons?: string[]
}

export interface SafetyEvaluationInput {
  project: DataProjectRecord
  database?: string
  source: DataQuerySource
  statements: SafetyStatementInput[]
  /**
   * The canonical text the token is bound to (request text, or the generated statements of a
   * grid edit / Mongo write serialised deterministically).
   */
  fingerprintText: string
  confirmToken?: string
}

export type SafetyDecision =
  /** `sandboxReads[i]` = run statement i inside the DB read-only sandbox. */
  | { action: 'run'; sandboxReads: boolean[] }
  | { action: 'confirm'; plan: DataExecutionPlan; confirmToken: string }
  | { action: 'block'; plan: DataExecutionPlan; reason: string }

/**
 * Decides per safe mode. Tokens are random, single-use, bound to
 * (dataProjectId, database, source, fingerprintText) and expire after 5 minutes.
 * A valid token means "run everything in this request, writes unsandboxed".
 */
export type EvaluateSafety = (input: SafetyEvaluationInput) => SafetyDecision

// ---------------------------------------------------------------------------------------------
// Drivers (drivers/*.ts, mongo/*.ts)
// ---------------------------------------------------------------------------------------------

export interface DriverConnectInput {
  project: DataProjectRecord
  /** Overrides project.config.database (PG opens one connection per database). */
  database?: string
  secrets: DataSecrets
  /** Redacts known secrets from error texts. */
  redact: (text: string) => string
  /**
   * Set when the connection goes through an SSH tunnel: `project.config.host/port` then point at
   * the local forward (127.0.0.1:<port>) and this is the real server as the SSH host sees it.
   * Use `remoteHost` as the TLS servername / for hostname verification.
   */
  tunnel?: { remoteHost: string; remotePort: number }
}

export interface DriverExecuteOptions {
  /** Auto-limit N (fetch N+1 to detect truncation); null = none. */
  limit: number | null
  /** Hard cap always enforced while reading rows. */
  hardCap: number
  /** Run inside the DB-level read-only sandbox (BEGIN READ ONLY ... ROLLBACK, readonly=2, ...). */
  readOnlySandbox: boolean
  database?: string
  schema?: string
  /** Per-statement timeout, ms. */
  timeoutMs?: number
}

export interface DriverStatementResult {
  output: DataStatementOutput
  executedText?: string
  notices?: string[]
  stats?: { rowsRead?: number; bytesRead?: number; elapsedMs?: number }
  /**
   * Further result sets of the same statement (MySQL `CALL proc()` returning several SELECTs).
   * The query runner reports each as an extra DataStatementResult with the same index/offsets.
   */
  moreOutputs?: DataStatementOutput[]
}

/** Thrown by drivers; `sandboxRejected` = the DB refused a write inside the read-only sandbox. */
export class DataDriverError extends Error {
  readonly code?: string
  readonly position?: number
  readonly hint?: string
  readonly detail?: string
  readonly sandboxRejected: boolean
  readonly cancelled: boolean

  constructor(
    message: string,
    options: {
      code?: string
      position?: number
      hint?: string
      detail?: string
      sandboxRejected?: boolean
      cancelled?: boolean
    } = {}
  ) {
    super(message)
    this.name = 'DataDriverError'
    this.code = options.code
    this.position = options.position
    this.hint = options.hint
    this.detail = options.detail
    this.sandboxRejected = options.sandboxRejected ?? false
    this.cancelled = options.cancelled ?? false
  }
}

export interface DataDriver {
  readonly engine: DataEngine
  /** Opens the sticky session connection (and lazily the control connection later). */
  connect(): Promise<{ serverVersion: string; currentDatabase?: string; readOnlyUser?: boolean }>
  close(): Promise<void>
  isConnected(): boolean
  /** Session flags for the status DTO. */
  sessionState(): {
    inTransaction?: boolean
    currentDatabase?: string
    /**
     * MySQL/MariaDB: false when the session's sql_mode has NO_BACKSLASH_ESCAPES (read at connect
     * and after SET sql_mode). Literal quoting and the classifier must then not treat `\` as an
     * escape. Undefined for other engines.
     */
    backslashEscapes?: boolean
    /**
     * MySQL/MariaDB: true while LOCK TABLES / FLUSH TABLES … WITH READ LOCK holds tables (the
     * read sandbox is skipped then, and grid saves are refused). Undefined for other engines.
     */
    tablesLocked?: boolean
  }

  /**
   * Runs ONE already-split statement on the sticky session (serialised by the caller).
   * Must never run more than one statement even if `statement` contains several.
   */
  execute(statement: string, options: DriverExecuteOptions): Promise<DriverStatementResult>
  /** Cancels whatever `execute` is running on the session now (KILL QUERY, pg_cancel_backend...). */
  cancelCurrent(): Promise<void>

  listDatabases(): Promise<DataDatabaseInfo[]>
  listObjects(database?: string, schema?: string): Promise<DataObjectsListing>
  describe(ref: DataObjectRef): Promise<DataTableDetails>
  ddl(ref: DataObjectRef): Promise<string>
  completionSchema(database?: string): Promise<DataCompletionSchema>
  listProcesses(): Promise<DataProcessInfo[]>
  killProcess(processId: string, scope: DataKillScope): Promise<void>

  /**
   * Streams every row of a read statement (no auto-limit, no hard cap) in batches, on a
   * separate connection so the session stays usable. Used by export.
   */
  streamRows(
    statement: string,
    options: { database?: string; schema?: string; readOnlySandbox: boolean; signal: AbortSignal },
    /** `columnTypes`: the driver's type name per column when it has one (MySQL: BIT export). */
    onBatch: (
      columns: string[],
      rows: unknown[][],
      columnTypes?: readonly string[]
    ) => Promise<void>
  ): Promise<{ rows: number }>

  /** Identifier quoting for generated SQL (SQL engines). */
  quoteIdentifier(name: string): string
}

export type DataDriverFactory = (input: DriverConnectInput) => DataDriver

// ---------------------------------------------------------------------------------------------
// Engine service (engine-service.ts) — what the RPC domain calls
// ---------------------------------------------------------------------------------------------

export interface DataCallContext {
  /** RPC client id (renderer page) that owns long-running work, for release on disconnect. */
  clientId: string | null
}

export interface MongoEngineService {
  find(req: MongoFindRequest, ctx: DataCallContext): Promise<MongoFindResponse>
  aggregate(req: MongoAggregateRequest, ctx: DataCallContext): Promise<MongoAggregateResponse>
  write(req: MongoWriteRequest, ctx: DataCallContext): Promise<MongoWriteResponse>
  indexes(id: string, database: string, collection: string): Promise<MongoIndexInfo[]>
  createIndex(req: MongoCreateIndexRequest): Promise<MongoIndexMutationResponse>
  dropIndex(req: MongoDropIndexRequest): Promise<MongoIndexMutationResponse>
  schema(req: MongoSchemaRequest): Promise<MongoSchemaResponse>
  explain(req: MongoExplainRequest): Promise<MongoExplainResponse>
  collection(req: MongoCollectionMutationRequest): Promise<MongoCollectionMutationResponse>
}

export interface DataEngineService {
  testConnection(input: DataTestConnectionInput): Promise<DataTestConnectionResult>
  connect(id: string): Promise<DataConnectionStatus>
  disconnect(id: string): Promise<DataConnectionStatus>
  status(id: string): DataConnectionStatus
  /** Config/secret changed or project deleted: close connections, drop caches. */
  invalidate(id: string): Promise<void>

  databases(id: string): Promise<DataDatabaseInfo[]>
  objects(id: string, database?: string, schema?: string): Promise<DataObjectsListing>
  describe(id: string, ref: DataObjectRef): Promise<DataTableDetails>
  ddl(id: string, ref: DataObjectRef): Promise<string>
  completionSchema(id: string, database?: string, refresh?: boolean): Promise<DataCompletionSchema>

  execute(req: DataQueryRequest, ctx: DataCallContext): Promise<DataQueryResponse>
  cancel(queryId: string): Promise<{ cancelled: boolean }>

  tableRows(req: DataTableRowsRequest, ctx: DataCallContext): Promise<DataTableRowsResponse>
  previewEdits(id: string, ref: DataObjectRef, edits: DataRowEdit[]): Promise<string[]>
  applyEdits(req: DataApplyEditsRequest, ctx: DataCallContext): Promise<DataApplyEditsResponse>

  processes(id: string): Promise<DataProcessInfo[]>
  kill(id: string, processId: string, scope: DataKillScope): Promise<void>

  exportStart(req: DataExportRequest, ctx: DataCallContext): Promise<DataExportResponse>
  exportCancel(exportId: string): Promise<{ cancelled: boolean }>

  /** Reads the head of a file: detected format/encoding/CSV options, first rows, target columns. */
  importPreview(req: DataImportPreviewRequest): Promise<DataImportPreviewResponse>
  /** Scans, gates (one INSERT / insertMany) and streams a file into a table or collection. */
  importStart(req: DataImportStartRequest, ctx: DataCallContext): Promise<DataImportResponse>
  importCancel(importId: string): Promise<{ cancelled: boolean }>

  readonly mongo: MongoEngineService

  /** Read-only helpers for the AI assistant's tools (always sandboxed, tiny caps). */
  sampleRows(id: string, ref: DataObjectRef, limit: number): Promise<DataStatementOutput>

  /** A renderer disconnected: cancel its running queries/exports/imports. */
  releaseClient(clientId: string): void
  shutdown(): Promise<void>
}
