import type { ServerEvent } from '@shared/rpc/protocol'
import {
  DATA_ASSISTANT_CHANNEL,
  DATA_EXPORT_CHANNEL,
  DATA_STATUS_CHANNEL,
  isDataAssistantEventPayload,
  isDataConnectionStatus,
  isDataExportProgressEvent,
  type DataApplyEditsRequest,
  type DataApplyEditsResponse,
  type DataAssistantEventPayload,
  type DataAssistantStartRequest,
  type DataCompletionSchema,
  type DataConnectionStatus,
  type DataDatabaseInfo,
  type DataEngine,
  type DataExportProgressEvent,
  type DataExportRequest,
  type DataExportResponse,
  type DataHistoryEntry,
  type DataKillScope,
  type DataObjectRef,
  type DataObjectsListing,
  type DataParseConnectionUrlResult,
  type DataProcessInfo,
  type DataProject,
  type DataProjectCreateInput,
  type DataProjectUpdateInput,
  type DataQueryRequest,
  type DataQueryResponse,
  type DataRowEdit,
  type DataSavedQuery,
  type DataTableDetails,
  type DataTableRowsRequest,
  type DataTableRowsResponse,
  type DataTestConnectionInput,
  type DataTestConnectionResult,
  type MongoAggregateRequest,
  type MongoAggregateResponse,
  type MongoCollectionMutationRequest,
  type MongoCollectionMutationResponse,
  type MongoCreateIndexRequest,
  type MongoDropIndexRequest,
  type MongoExplainRequest,
  type MongoExplainResponse,
  type MongoFindRequest,
  type MongoFindResponse,
  type MongoIndexInfo,
  type MongoIndexMutationResponse,
  type MongoSchemaRequest,
  type MongoSchemaResponse,
  type MongoWriteRequest,
  type MongoWriteResponse,
  type SidebarOrderEntry
} from '@shared/data-projects/types'
import {
  DATA_IMPORT_CHANNEL,
  isDataImportProgressEvent,
  type DataImportPreviewRequest,
  type DataImportPreviewResponse,
  type DataImportProgressEvent,
  type DataImportResponse,
  type DataImportStartRequest
} from '@shared/data-projects/import-types'
import { getRendererRpcClient } from './rpc-client'

const request = <T>(method: string, params: object): Promise<T> =>
  getRendererRpcClient().request<T>(method, params)

/**
 * RPC surface of data projects (server: src/server/rpc/domains/data-projects.ts and
 * data-assistant.ts). Every method is desktop-only: device principals (phones, peer Macs) are
 * refused by the remote-access policy and by the domain's own principal guard.
 *
 * Methods that can run user SQL/commands (`query.execute`, `table.applyEdits`, `export.start`,
 * the Mongo writes) answer `confirmation_required` instead of running when the data project's
 * safe mode asks for it; re-send the same request with the returned `confirmToken` to run it.
 */
export const dataProjectsApi = {
  // ---- CRUD -----------------------------------------------------------------------------------
  list: (): Promise<DataProject[]> => request('dataProjects.list', {}),
  get: (id: string): Promise<DataProject | null> => request('dataProjects.get', { id }),
  create: (input: DataProjectCreateInput): Promise<DataProject> =>
    request('dataProjects.create', { input }),
  update: (id: string, patch: DataProjectUpdateInput): Promise<DataProject> =>
    request('dataProjects.update', { id, patch }),
  /** Closes the project's connections, deletes its secret, history and saved queries. */
  delete: (id: string): Promise<{ success: boolean }> => request('dataProjects.delete', { id }),
  /** Marks the project as just opened (last_accessed_at). */
  touch: (id: string): Promise<void> => request('dataProjects.touch', { id }),
  /** Writes the merged sidebar order (git projects + data projects share one sort_order space). */
  reorderSidebar: (entries: SidebarOrderEntry[]): Promise<void> =>
    request('dataProjects.reorderSidebar', { entries }),
  /** Duplicate a data project (config, icon, safety; the secret is copied server-side). */
  duplicate: (id: string): Promise<DataProject> => request('dataProjects.duplicate', { id }),

  // ---- Connection -----------------------------------------------------------------------------
  /** Server-side twin of the shared parser (also strips secrets from what it logs). */
  parseUrl: (url: string, engineHint?: DataEngine): Promise<DataParseConnectionUrlResult> =>
    request('dataProjects.parseUrl', { url, engineHint }),
  testConnection: (input: DataTestConnectionInput): Promise<DataTestConnectionResult> =>
    request('dataProjects.testConnection', { input }),
  connect: (id: string): Promise<DataConnectionStatus> => request('dataProjects.connect', { id }),
  disconnect: (id: string): Promise<DataConnectionStatus> =>
    request('dataProjects.disconnect', { id }),
  status: (id: string): Promise<DataConnectionStatus> => request('dataProjects.status', { id }),
  /** Provide a password for this app session only (when secretState is 'unavailable'/'session'). */
  provideSessionSecrets: (
    id: string,
    secrets: { password?: string; sshPassword?: string; sshPassphrase?: string },
    remember: boolean
  ): Promise<DataProject> =>
    request('dataProjects.provideSessionSecrets', { id, secrets, remember }),

  // ---- Schema ---------------------------------------------------------------------------------
  databases: (id: string): Promise<DataDatabaseInfo[]> =>
    request('dataProjects.schema.databases', { id }),
  objects: (id: string, database?: string, schema?: string): Promise<DataObjectsListing> =>
    request('dataProjects.schema.objects', { id, database, schema }),
  describe: (id: string, ref: DataObjectRef): Promise<DataTableDetails> =>
    request('dataProjects.schema.describe', { id, ref }),
  ddl: (id: string, ref: DataObjectRef): Promise<string> =>
    request('dataProjects.schema.ddl', { id, ref }),
  /** Compact schema for autocomplete (cached server-side; `refresh` drops the cache). */
  completionSchema: (
    id: string,
    database?: string,
    refresh?: boolean
  ): Promise<DataCompletionSchema> =>
    request('dataProjects.schema.completion', { id, database, refresh }),

  // ---- Queries --------------------------------------------------------------------------------
  execute: (req: DataQueryRequest): Promise<DataQueryResponse> =>
    request('dataProjects.query.execute', req),
  /** Cancels a running `execute`/`tableRows`/`mongo.find`/`mongo.aggregate` by its queryId. */
  cancel: (queryId: string): Promise<{ cancelled: boolean }> =>
    request('dataProjects.query.cancel', { queryId }),

  // ---- Table data (SQL engines) ---------------------------------------------------------------
  tableRows: (req: DataTableRowsRequest): Promise<DataTableRowsResponse> =>
    request('dataProjects.table.rows', req),
  /** The SQL that `applyEdits` would run, for the "Preview SQL" panel. Runs nothing. */
  previewEdits: (id: string, ref: DataObjectRef, edits: DataRowEdit[]): Promise<string[]> =>
    request('dataProjects.table.previewEdits', { id, ref, edits }),
  applyEdits: (req: DataApplyEditsRequest): Promise<DataApplyEditsResponse> =>
    request('dataProjects.table.applyEdits', req),

  // ---- Processes ------------------------------------------------------------------------------
  processes: (id: string): Promise<DataProcessInfo[]> =>
    request('dataProjects.processes.list', { id }),
  kill: (id: string, processId: string, scope: DataKillScope): Promise<{ success: boolean }> =>
    request('dataProjects.processes.kill', { id, processId, scope }),

  // ---- Export ---------------------------------------------------------------------------------
  /** Streams a whole table / query / collection to a file (no auto-limit). */
  exportStart: (req: DataExportRequest): Promise<DataExportResponse> =>
    request('dataProjects.export.start', req),
  exportCancel: (exportId: string): Promise<{ cancelled: boolean }> =>
    request('dataProjects.export.cancel', { exportId }),
  /** Save renderer-built text (CSV/JSON of visible results) through a native save dialog. */
  saveTextFile: (
    defaultName: string,
    content: string,
    extensions: string[]
  ): Promise<{ filePath: string | null }> =>
    request('dataProjects.files.saveText', { defaultName, content, extensions }),
  /** Native open dialog (SQLite file, SSL CA/cert/key, SSH private key). */
  pickFile: (
    purpose: 'sqlite' | 'certificate' | 'ssh-key',
    allowCreate?: boolean
  ): Promise<{ filePath: string | null }> =>
    request('dataProjects.files.pick', { purpose, allowCreate }),

  // ---- Import ---------------------------------------------------------------------------------
  import: {
    /** Reads the head of a local file: detected settings, first rows, the target's columns. */
    preview: (req: DataImportPreviewRequest): Promise<DataImportPreviewResponse> =>
      request('dataProjects.import.preview', req),
    /**
     * Scans and imports the file (gated like a write: may answer `confirmation_required`).
     * Progress arrives through `onProgress`.
     */
    start: (req: DataImportStartRequest): Promise<DataImportResponse> =>
      request('dataProjects.import.start', req),
    cancel: (importId: string): Promise<{ cancelled: boolean }> =>
      request('dataProjects.import.cancel', { importId }),
    onProgress: (callback: (event: DataImportProgressEvent) => void): (() => void) =>
      getRendererRpcClient().subscribe(DATA_IMPORT_CHANNEL, (event: ServerEvent) => {
        if (isDataImportProgressEvent(event.payload)) callback(event.payload)
      })
  },

  // ---- History / saved queries ----------------------------------------------------------------
  history: (id: string, search?: string, limit?: number): Promise<DataHistoryEntry[]> =>
    request('dataProjects.history.list', { id, search, limit }),
  clearHistory: (id: string): Promise<void> => request('dataProjects.history.clear', { id }),
  savedQueries: (id: string): Promise<DataSavedQuery[]> =>
    request('dataProjects.saved.list', { id }),
  saveQuery: (
    id: string,
    query: { id?: string; name: string; text: string; database?: string | null }
  ): Promise<DataSavedQuery> => request('dataProjects.saved.save', { id, query }),
  deleteSavedQuery: (id: string, savedId: string): Promise<void> =>
    request('dataProjects.saved.delete', { id, savedId }),

  // ---- MongoDB --------------------------------------------------------------------------------
  mongo: {
    find: (req: MongoFindRequest): Promise<MongoFindResponse> =>
      request('dataProjects.mongo.find', req),
    aggregate: (req: MongoAggregateRequest): Promise<MongoAggregateResponse> =>
      request('dataProjects.mongo.aggregate', req),
    write: (req: MongoWriteRequest): Promise<MongoWriteResponse> =>
      request('dataProjects.mongo.write', req),
    indexes: (id: string, database: string, collection: string): Promise<MongoIndexInfo[]> =>
      request('dataProjects.mongo.indexes', { id, database, collection }),
    createIndex: (req: MongoCreateIndexRequest): Promise<MongoIndexMutationResponse> =>
      request('dataProjects.mongo.createIndex', req),
    dropIndex: (req: MongoDropIndexRequest): Promise<MongoIndexMutationResponse> =>
      request('dataProjects.mongo.dropIndex', req),
    schema: (req: MongoSchemaRequest): Promise<MongoSchemaResponse> =>
      request('dataProjects.mongo.schema', req),
    explain: (req: MongoExplainRequest): Promise<MongoExplainResponse> =>
      request('dataProjects.mongo.explain', req),
    collection: (req: MongoCollectionMutationRequest): Promise<MongoCollectionMutationResponse> =>
      request('dataProjects.mongo.collection', req)
  },

  // ---- AI assistant ---------------------------------------------------------------------------
  assistant: {
    /** Resolves at once; progress and the final proposal arrive through `onEvent`. */
    start: (req: DataAssistantStartRequest): Promise<{ requestId: string }> =>
      request('dataAssistant.start', req),
    cancel: (requestId: string): Promise<{ cancelled: boolean }> =>
      request('dataAssistant.cancel', { requestId }),
    onEvent: (callback: (payload: DataAssistantEventPayload) => void): (() => void) =>
      getRendererRpcClient().subscribe(DATA_ASSISTANT_CHANNEL, (event: ServerEvent) => {
        if (isDataAssistantEventPayload(event.payload)) callback(event.payload)
      })
  },

  // ---- Events ---------------------------------------------------------------------------------
  onStatus: (callback: (status: DataConnectionStatus) => void): (() => void) =>
    getRendererRpcClient().subscribe(DATA_STATUS_CHANNEL, (event: ServerEvent) => {
      if (isDataConnectionStatus(event.payload)) callback(event.payload)
    }),
  onExportProgress: (callback: (event: DataExportProgressEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(DATA_EXPORT_CHANNEL, (event: ServerEvent) => {
      if (isDataExportProgressEvent(event.payload)) callback(event.payload)
    })
}
