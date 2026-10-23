// Data projects: a database connection that sits in the sidebar next to git projects and opens
// a database client (SQL or document) instead of a board. This file is the contract between
// the renderer, the RPC domain (`dataProjects.*`, `dataAssistant.*`) and the server-side engine
// (src/main/services/data-projects). It is pure types and constants: no Node or DOM imports.
//
// Secrets (passwords, SSH passphrases) never appear in a DataProject DTO, never reach the
// renderer after submit, and are never persisted in plaintext: the server keeps a
// safeStorage-encrypted blob per data project (see DataSecrets / DataSecretState).

// ---------------------------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------------------------

export const DATA_ENGINES = [
  'mysql',
  'mariadb',
  'postgres',
  'sqlite',
  'clickhouse',
  'mongodb'
] as const
export type DataEngine = (typeof DATA_ENGINES)[number]

/** 'sql' engines get the SQL client (schema tree, query tabs, grid); 'document' gets the Mongo UI. */
export type DataEngineFamily = 'sql' | 'document'

/** The SQL dialect the shared lexer, splitter, classifier and editor use for an engine. */
export type SqlDialect = 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'clickhouse'

export interface DataEngineInfo {
  readonly id: DataEngine
  readonly label: string
  readonly family: DataEngineFamily
  /** null for file-based engines (SQLite). */
  readonly defaultPort: number | null
  /** URL schemes recognised by the connection-URL importer, lowercase, without "://". */
  readonly urlSchemes: readonly string[]
  /** Brand colour (hex) used for the default icon tint. */
  readonly brandColor: string
  /** Default database name offered by the wizard ('' = none). */
  readonly defaultDatabase: string
  /** Default user offered by the wizard ('' = none). */
  readonly defaultUser: string
}

export const DATA_ENGINE_INFO: Readonly<Record<DataEngine, DataEngineInfo>> = {
  mysql: {
    id: 'mysql',
    label: 'MySQL',
    family: 'sql',
    defaultPort: 3306,
    urlSchemes: ['mysql', 'jdbc:mysql'],
    brandColor: '#4479A1',
    defaultDatabase: '',
    defaultUser: 'root'
  },
  mariadb: {
    id: 'mariadb',
    label: 'MariaDB',
    family: 'sql',
    defaultPort: 3306,
    urlSchemes: ['mariadb', 'jdbc:mariadb'],
    brandColor: '#C0765A',
    defaultDatabase: '',
    defaultUser: 'root'
  },
  postgres: {
    id: 'postgres',
    label: 'PostgreSQL',
    family: 'sql',
    defaultPort: 5432,
    urlSchemes: ['postgres', 'postgresql', 'jdbc:postgresql'],
    brandColor: '#4169E1',
    defaultDatabase: 'postgres',
    defaultUser: 'postgres'
  },
  sqlite: {
    id: 'sqlite',
    label: 'SQLite',
    family: 'sql',
    defaultPort: null,
    urlSchemes: ['sqlite', 'sqlite3', 'file', 'jdbc:sqlite'],
    brandColor: '#003B57',
    defaultDatabase: 'main',
    defaultUser: ''
  },
  clickhouse: {
    id: 'clickhouse',
    label: 'ClickHouse',
    family: 'sql',
    defaultPort: 8123,
    urlSchemes: ['clickhouse', 'ch', 'jdbc:clickhouse', 'http', 'https'],
    brandColor: '#FFCC01',
    defaultDatabase: 'default',
    defaultUser: 'default'
  },
  mongodb: {
    id: 'mongodb',
    label: 'MongoDB',
    family: 'document',
    defaultPort: 27017,
    urlSchemes: ['mongodb', 'mongodb+srv'],
    brandColor: '#47A248',
    defaultDatabase: '',
    defaultUser: ''
  }
}

export const isDataEngine = (value: unknown): value is DataEngine =>
  typeof value === 'string' && (DATA_ENGINES as readonly string[]).includes(value)

export const dataEngineFamily = (engine: DataEngine): DataEngineFamily =>
  DATA_ENGINE_INFO[engine].family

/** The SQL dialect of a SQL engine; null for MongoDB. */
export const sqlDialectOf = (engine: DataEngine): SqlDialect | null =>
  engine === 'mongodb' ? null : engine

// ---------------------------------------------------------------------------------------------
// Safety, environment
// ---------------------------------------------------------------------------------------------

/**
 * Per data project:
 * - `off`        nothing is confirmed (dangerous-statement warnings still show)
 * - `half-safe`  reads run (inside a DB-level read-only sandbox); everything else is confirmed
 * - `safe`       every statement is confirmed before it runs
 * - `read-only`  reads run in the sandbox; everything else is refused outright
 */
export const DATA_SAFE_MODES = ['off', 'half-safe', 'safe', 'read-only'] as const
export type DataSafeMode = (typeof DATA_SAFE_MODES)[number]

export const DATA_ENVIRONMENTS = ['local', 'development', 'staging', 'production'] as const
export type DataEnvironment = (typeof DATA_ENVIRONMENTS)[number]

export const DATA_ENVIRONMENT_DEFAULTS: Readonly<
  Record<
    DataEnvironment,
    { readonly label: string; readonly color: string; readonly safeMode: DataSafeMode }
  >
> = {
  local: { label: 'Local', color: '#22c55e', safeMode: 'off' },
  development: { label: 'Development', color: '#3b82f6', safeMode: 'off' },
  staging: { label: 'Staging', color: '#f59e0b', safeMode: 'half-safe' },
  production: { label: 'Production', color: '#ef4444', safeMode: 'half-safe' }
}

/** Statement classes produced by the shared SQL classifier and the Mongo classifier. */
export const DATA_STATEMENT_CLASSES = [
  'read',
  'session',
  'tx',
  'lock',
  'write',
  'ddl',
  'admin',
  'unknown'
] as const
export type DataStatementClass = (typeof DATA_STATEMENT_CLASSES)[number]

/** True when a class may run without confirmation in half-safe / read-only mode. */
export const isAutoRunClass = (cls: DataStatementClass): boolean =>
  cls === 'read' || cls === 'session'

/** Default auto-limit for new data projects (rows). */
export const DEFAULT_DATA_ROW_LIMIT = 1000
/** Hard cap applied by every driver even when the auto-limit is off. */
export const DATA_HARD_ROW_CAP = 100_000

// ---------------------------------------------------------------------------------------------
// Connection configuration (non-secret) and secrets
// ---------------------------------------------------------------------------------------------

export const DATA_SSL_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const
export type DataSslMode = (typeof DATA_SSL_MODES)[number]

export interface DataSslConfig {
  mode: DataSslMode
  /** Paths only: certificate/key file contents are never copied into the app DB. */
  caPath?: string
  certPath?: string
  keyPath?: string
}

export type DataSshAuthMethod = 'password' | 'privateKey' | 'agent'

export interface DataSshConfig {
  enabled: boolean
  host: string
  port: number
  username: string
  authMethod: DataSshAuthMethod
  /** For authMethod 'privateKey'; '~' is expanded server-side. */
  privateKeyPath?: string
}

export interface DataMongoConfig {
  /** mongodb+srv:// (one host, no port, DNS seed list). */
  srv: boolean
  /** "host:port" entries (or just "host" for srv). `host`/`port` on the parent mirror hosts[0]. */
  hosts: string[]
  authSource?: string
  /** SCRAM-SHA-256 | SCRAM-SHA-1 | MONGODB-X509 | PLAIN | MONGODB-AWS ... */
  authMechanism?: string
  replicaSet?: string
  directConnection?: boolean
  tls?: boolean
  tlsAllowInvalidCertificates?: boolean
  readPreference?: string
}

/**
 * Everything needed to connect except secrets. Stored as JSON on the data project row.
 * Fields irrelevant to an engine are ignored (e.g. `filePath` for anything but SQLite).
 */
export interface DataConnectionConfig {
  host?: string
  port?: number
  /** Default database (MySQL/MariaDB/PG/ClickHouse/Mongo); attached-db name for SQLite ('main'). */
  database?: string
  user?: string
  ssl?: DataSslConfig
  /** SQLite: absolute path to the database file ('~' expanded server-side). */
  filePath?: string
  /** SQLite: open the file read-only at the driver level. */
  readOnlyFile?: boolean
  mongo?: DataMongoConfig
  /** ClickHouse: HTTP interface protocol. */
  clickhouseProtocol?: 'http' | 'https'
  /** Extra driver/URL options that were not mapped to a field (never secrets). */
  options?: Record<string, string>
  ssh?: DataSshConfig
  /** Session time zone to render timestamps in (IANA, e.g. 'UTC'); undefined = server default. */
  timezone?: string
  /** Statement timeout applied to every query on this connection, ms (0 / undefined = none). */
  queryTimeoutMs?: number
}

/** Secrets travel renderer → server only on create/update/test. Never server → renderer. */
export interface DataSecrets {
  password?: string
  sshPassword?: string
  sshPassphrase?: string
}

/** Update semantics per secret: string = replace, null = clear, undefined = keep. */
export interface DataSecretsPatch {
  password?: string | null
  sshPassword?: string | null
  sshPassphrase?: string | null
}

/**
 * - `none`        no secret was ever given
 * - `stored`      encrypted at rest (safeStorage) and decryptable
 * - `session`     no persistent vault available: kept in server memory until restart
 * - `unavailable` a secret existed but cannot be decrypted / was lost (restart without a vault,
 *                 Keychain reset, DB copied from another Mac). The UI asks for it again.
 */
export type DataSecretState = 'none' | 'stored' | 'session' | 'unavailable'

// ---------------------------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------------------------

/**
 * The sidebar icon. Default (null) = the engine's brand logo. `color` tints lucide/engine icons
 * and draws the environment dot when set.
 */
export type DataProjectIcon =
  | { kind: 'engine'; engine: DataEngine }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'lucide'; name: string }
  /** File name under the project-icons dir (same pipeline as git projects' custom icons). */
  | { kind: 'image'; fileName: string }

// ---------------------------------------------------------------------------------------------
// Data project DTO
// ---------------------------------------------------------------------------------------------

export interface DataProject {
  id: string
  name: string
  engine: DataEngine
  config: DataConnectionConfig
  icon: DataProjectIcon | null
  /** Hex colour that tints the icon; null = engine brand colour / theme foreground. */
  iconColor: string | null
  environment: DataEnvironment
  /** Environment colour override (hex); null = DATA_ENVIRONMENT_DEFAULTS[environment].color. */
  color: string | null
  safeMode: DataSafeMode
  /** Auto-limit for query results; 0 = no auto-limit (the hard cap still applies). */
  defaultLimit: number
  /** May the AI assistant read sample rows/documents (data leaves the machine)? Off by default. */
  allowAiDataAccess: boolean
  /** Shown in the sidebar Pinned list (one click away from the pinned board). */
  pinned: boolean
  secretState: DataSecretState
  /** Shared ordering space with git projects (projects.sort_order). */
  sortOrder: number
  createdAt: string
  lastAccessedAt: string
}

export interface DataProjectCreateInput {
  name: string
  engine: DataEngine
  config: DataConnectionConfig
  secrets?: DataSecrets
  icon?: DataProjectIcon | null
  iconColor?: string | null
  environment?: DataEnvironment
  color?: string | null
  safeMode?: DataSafeMode
  defaultLimit?: number
  allowAiDataAccess?: boolean
  pinned?: boolean
}

export interface DataProjectUpdateInput {
  name?: string
  /** Replacing the config (or secrets) closes open connections of the project. */
  config?: DataConnectionConfig
  secrets?: DataSecretsPatch
  icon?: DataProjectIcon | null
  iconColor?: string | null
  environment?: DataEnvironment
  color?: string | null
  safeMode?: DataSafeMode
  defaultLimit?: number
  allowAiDataAccess?: boolean
  pinned?: boolean
}

/** One entry of the merged sidebar order (git projects and data projects share sort_order). */
export interface SidebarOrderEntry {
  kind: 'project' | 'data'
  id: string
}

// ---------------------------------------------------------------------------------------------
// Connection URL import
// ---------------------------------------------------------------------------------------------

export interface DataParsedConnectionUrl {
  engine: DataEngine
  config: DataConnectionConfig
  /** Only the secrets present in the URL (usually just the password). */
  secrets: DataSecrets
  /** Suggested project name (e.g. "shop @ db.example.com"). */
  suggestedName: string
  /** Non-fatal notes for the wizard ("multi-host PG URL: using the first host", ...). */
  warnings: string[]
}

export type DataParseConnectionUrlResult =
  { ok: true; value: DataParsedConnectionUrl } | { ok: false; error: string }

// ---------------------------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------------------------

export type DataConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface DataConnectionStatus {
  dataProjectId: string
  state: DataConnectionState
  serverVersion?: string
  error?: string
  /** The user's sticky session has an open transaction (BEGIN without COMMIT). */
  inTransaction?: boolean
  /** Current database of the sticky session (after USE / reconnect). */
  currentDatabase?: string
  connectedAt?: string
  /** Server-side read-only hint (e.g. Mongo user without write roles, CH readonly profile). */
  readOnlyUser?: boolean
  /**
   * Non-fatal warning to show next to a working connection, e.g. "SSH host key of bastion:22
   * (SHA256:…) is not in ~/.ssh/known_hosts; accepted on first use".
   */
  notice?: string
  /** MySQL / MariaDB: false when the session runs with NO_BACKSLASH_ESCAPES. */
  backslashEscapes?: boolean
}

export interface DataTestConnectionInput {
  engine: DataEngine
  config: DataConnectionConfig
  /** Secrets typed in the wizard; when omitted and `dataProjectId` is set, the stored ones. */
  secrets?: DataSecrets
  dataProjectId?: string
}

export interface DataTestConnectionResult {
  ok: boolean
  serverVersion?: string
  latencyMs?: number
  error?: string
  /** Databases visible to the user (for the wizard's database picker), when cheap to get. */
  databases?: string[]
  /** Non-fatal warning to show with a working connection (e.g. the SSH host key fingerprint). */
  notice?: string
}

// ---------------------------------------------------------------------------------------------
// Schema / introspection
// ---------------------------------------------------------------------------------------------

export interface DataDatabaseInfo {
  name: string
  sizeBytes?: number | null
  /** information_schema, pg_catalog, system, admin/local/config, ... */
  isSystem?: boolean
}

export const DATA_OBJECT_KINDS = [
  'table',
  'view',
  'materialized_view',
  'foreign_table',
  'function',
  'procedure',
  'trigger',
  'sequence',
  'type',
  'event',
  'dictionary',
  'collection'
] as const
export type DataObjectKind = (typeof DATA_OBJECT_KINDS)[number]

export interface DataObjectInfo {
  name: string
  /** PG schema; undefined for engines without schemas. */
  schema?: string
  kind: DataObjectKind
  rowEstimate?: number | null
  sizeBytes?: number | null
  /** Storage engine (InnoDB, MergeTree, ...) or collection type (view, timeseries, capped). */
  engine?: string
  comment?: string
  /** For triggers: the table it belongs to. For functions: identity arguments. */
  detail?: string
}

export interface DataObjectsListing {
  /** PG only: the schemas of the database (for the schema switcher). */
  schemas?: string[]
  objects: DataObjectInfo[]
}

/** Identifies a table/view/collection. */
export interface DataObjectRef {
  database?: string
  schema?: string
  name: string
  kind?: DataObjectKind
}

export interface DataColumnInfo {
  name: string
  /** Full declared type, e.g. "varchar(255)", "Nullable(UInt32)", "timestamp with time zone". */
  type: string
  nullable: boolean
  defaultValue?: string | null
  isPrimaryKey: boolean
  /** 1-based position. */
  ordinal: number
  autoIncrement?: boolean
  comment?: string
  /** Engine-specific extras (EXTRA, generation expression, codec, sorting-key membership, ...). */
  extra?: string
}

export interface DataIndexInfo {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  /** Full definition when the engine can produce one (pg_get_indexdef, Mongo key spec JSON). */
  definition?: string
  type?: string
  sizeBytes?: number | null
}

export interface DataForeignKeyInfo {
  name: string
  columns: string[]
  refDatabase?: string
  refSchema?: string
  refTable: string
  refColumns: string[]
  onUpdate?: string
  onDelete?: string
}

export interface DataTableDetails {
  ref: DataObjectRef
  kind: DataObjectKind
  columns: DataColumnInfo[]
  indexes: DataIndexInfo[]
  foreignKeys: DataForeignKeyInfo[]
  triggers: Array<{ name: string; definition?: string }>
  /** Primary key columns in key order ([] when none: grid edits are then disabled). */
  primaryKey: string[]
  rowEstimate?: number | null
  sizeBytes?: number | null
  engine?: string
  comment?: string
  /** Labelled engine-specific facts (ClickHouse sorting key, partition key, TTL, Mongo validator). */
  properties?: Array<{ label: string; value: string }>
}

/** Compact schema snapshot for autocomplete and AI context. */
export interface DataCompletionTable {
  schema?: string
  name: string
  kind: DataObjectKind
  columns: Array<{ name: string; type: string }>
}

export interface DataCompletionSchema {
  database?: string
  defaultSchema?: string
  databases: string[]
  schemas?: string[]
  tables: DataCompletionTable[]
  /** User-defined + notable built-in functions worth completing. */
  functions?: string[]
  /** True when the snapshot was cut short (very large schemas). */
  truncated?: boolean
}

// ---------------------------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------------------------

/** Binary values are sent as a hex preview (first 64 bytes) plus the full length. */
export interface DataBinaryCell {
  $t: 'bin'
  hex: string
  len: number
}

/**
 * A JSON-safe cell. Big integers, decimals, dates/times are strings (exact, as the server
 * printed them); JSON columns are their JSON text; Mongo sub-documents are relaxed-EJSON text.
 */
export type DataCell = string | number | boolean | null | DataBinaryCell

export const isBinaryCell = (cell: unknown): cell is DataBinaryCell =>
  typeof cell === 'object' && cell !== null && (cell as { $t?: unknown }).$t === 'bin'

export interface DataColumnMeta {
  name: string
  /** Server type name when known (int4, VARCHAR, Nullable(String), ...). */
  type?: string
  /** Source table when the engine reports it (lets the grid offer edits on simple SELECTs). */
  table?: string
  schema?: string
  database?: string
}

export interface DataRowsResult {
  kind: 'rows'
  columns: DataColumnMeta[]
  rows: DataCell[][]
  /** True when more rows existed than were returned (auto-limit or the hard cap). */
  truncated: boolean
  /** The limit that applied (auto-limit N or the hard cap), null when nothing limited it. */
  limit: number | null
  /** True when the auto-limit (not a LIMIT in the user's SQL) cut the result. */
  autoLimited: boolean
}

export interface DataCommandResult {
  kind: 'command'
  /** INSERT/UPDATE/DELETE affected rows, when reported. */
  affectedRows?: number | null
  /** Command tag or human message ("CREATE TABLE", "USE shop", "OK"). */
  message?: string
  lastInsertId?: string | null
}

/** Mongo find/aggregate output: canonical EJSON documents (JSON-safe objects). */
export interface DataDocumentsResult {
  kind: 'documents'
  documents: Array<Record<string, unknown>>
  truncated: boolean
  limit: number | null
}

/** Scalar outputs (Mongo countDocuments/distinct/write results, explain...): canonical EJSON. */
export interface DataValueResult {
  kind: 'value'
  value: unknown
}

export type DataStatementOutput =
  DataRowsResult | DataCommandResult | DataDocumentsResult | DataValueResult

export interface DataQueryError {
  message: string
  /** SQLSTATE / errno / ClickHouse code / Mongo codeName, as a string. */
  code?: string
  /** 0-based character offset inside the statement text, when the server reports one. */
  position?: number
  hint?: string
  detail?: string
}

export interface DataStatementResult {
  index: number
  /** Statement text as split from the request (no trailing ';'). */
  text: string
  /** Offsets of the statement inside the request text. */
  start: number
  end: number
  classification: DataStatementClass
  /** What was actually sent when it differs from `text` (auto-limit rewrite, USE prefix...). */
  executedText?: string
  durationMs: number
  output: DataStatementOutput | null
  error?: DataQueryError
  /** PG RAISE NOTICE, MySQL warnings, ClickHouse progress summary... */
  notices?: string[]
  /** ClickHouse: rows/bytes read; other engines may leave it empty. */
  stats?: { rowsRead?: number; bytesRead?: number; elapsedMs?: number }
}

export type DataQuerySource = 'editor' | 'table' | 'grid-edit' | 'mongo' | 'schema-action'

export interface DataQueryRequest {
  dataProjectId: string
  /** Client-generated UUID; lets `dataProjects.query.cancel` reach a running execute. */
  queryId: string
  /** One or more statements (SQL) or mongosh-style commands (MongoDB). */
  text: string
  /** Database to run in (MySQL USE, PG connection per database, CH session db, Mongo db). */
  database?: string
  /** PG search_path head for this run. */
  schema?: string
  /** Auto-limit N; null/0 = no auto-limit (the hard cap still applies). */
  limit: number | null
  /** Token from a previous `confirmation_required` response for exactly this request text. */
  confirmToken?: string
  source: DataQuerySource
  /** Stop at the first failing statement (default true). */
  stopOnError?: boolean
}

export interface DataPlannedStatement {
  index: number
  text: string
  start: number
  end: number
  classification: DataStatementClass
  /** Red warnings: "DELETE without WHERE", "DROP TABLE", "calls pg_terminate_backend"... */
  dangerous: string[]
  /** Why it needs confirmation / was blocked ("write", "unknown statement", "sandbox rejected"...). */
  reasons: string[]
  needsConfirmation: boolean
}

export interface DataExecutionPlan {
  dataProjectId: string
  projectName: string
  engine: DataEngine
  environment: DataEnvironment
  safeMode: DataSafeMode
  database?: string
  statements: DataPlannedStatement[]
  /**
   * When set, the confirm button stays disabled until the user types this exact text
   * (production + DROP/TRUNCATE/DELETE-without-WHERE).
   */
  typedConfirmation?: string
}

export type DataQueryResponse =
  | {
      status: 'ok'
      statements: DataStatementResult[]
      durationMs: number
      database?: string
      inTransaction?: boolean
    }
  /** Nothing ran. Show the plan; re-send the same request with `confirmToken` to run it. */
  | { status: 'confirmation_required'; plan: DataExecutionPlan; confirmToken: string }
  /** Nothing ran (read-only mode, or a statement that is never allowed). */
  | { status: 'blocked'; plan: DataExecutionPlan; reason: string }
  /** Cancelled by the user; statements that finished before the cancel are included. */
  | { status: 'cancelled'; statements: DataStatementResult[]; durationMs: number }

// ---------------------------------------------------------------------------------------------
// Table browsing and staged edits (SQL engines)
// ---------------------------------------------------------------------------------------------

export const DATA_FILTER_OPERATORS = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'contains',
  'not contains',
  'starts with',
  'in',
  'not in',
  'is null',
  'is not null',
  'like'
] as const
export type DataFilterOperator = (typeof DATA_FILTER_OPERATORS)[number]

export interface DataFilter {
  column: string
  operator: DataFilterOperator
  /** For 'in'/'not in': comma-separated values. Ignored for null checks. */
  value?: string
}

export interface DataSort {
  column: string
  direction: 'asc' | 'desc'
}

/** How a table view's filters combine. */
export type DataFilterJoin = 'and' | 'or'

export interface DataTableRowsRequest {
  dataProjectId: string
  queryId: string
  ref: DataObjectRef
  filters?: DataFilter[]
  /** How the filters combine (default 'and'); the raw WHERE is always ANDed with the group. */
  filterJoin?: DataFilterJoin
  /** Raw WHERE clause typed by the user (classified like any statement before it runs). */
  where?: string
  orderBy?: DataSort[]
  limit: number
  offset: number
}

export interface DataTableRowsResponse {
  result: DataRowsResult
  /** The SELECT that was generated and run (shown in the UI, copyable). */
  sql: string
  primaryKey: string[]
  /** Exact count when cheap, else an estimate, else null. */
  totalRows: number | null
  totalIsEstimate: boolean
  durationMs: number
}

export type DataRowEdit =
  | { kind: 'update'; key: Record<string, DataCell>; changes: Record<string, DataCell> }
  | { kind: 'insert'; values: Record<string, DataCell> }
  | { kind: 'delete'; key: Record<string, DataCell> }

export interface DataApplyEditsRequest {
  dataProjectId: string
  ref: DataObjectRef
  edits: DataRowEdit[]
  confirmToken?: string
}

export type DataApplyEditsResponse =
  | { status: 'ok'; statements: string[]; affectedRows: number; durationMs: number }
  | { status: 'confirmation_required'; plan: DataExecutionPlan; confirmToken: string }
  | { status: 'blocked'; plan: DataExecutionPlan; reason: string }

// ---------------------------------------------------------------------------------------------
// Processes (running queries on the server)
// ---------------------------------------------------------------------------------------------

export interface DataProcessInfo {
  /** Thread id / pid / query_id / opid, as a string. */
  id: string
  user?: string | null
  host?: string | null
  database?: string | null
  state?: string | null
  command?: string | null
  durationMs?: number | null
  query?: string | null
  /** True for this app's own sticky session / control connection. */
  isOwn?: boolean
  /** Engine extras (ClickHouse read_rows/memory, PG wait_event/blocked_by, Mongo ns/op...). */
  extra?: Record<string, string | number | null>
}

export type DataKillScope = 'query' | 'connection'

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export type DataExportFormat = 'csv' | 'json' | 'sql'

export type DataExportSource =
  | {
      kind: 'table'
      ref: DataObjectRef
      filters?: DataFilter[]
      filterJoin?: DataFilterJoin
      where?: string
      orderBy?: DataSort[]
    }
  | { kind: 'query'; text: string; database?: string; schema?: string }
  | {
      kind: 'mongo'
      database: string
      collection: string
      filter?: string
      projection?: string
      sort?: string
      /** Query bar collation (shell/EJSON object text). */
      collation?: string
      /** Query bar index hint (index name or key document text). */
      hint?: string
      /** Shell/EJSON text of an aggregation pipeline array (instead of filter/sort). */
      pipeline?: string
    }

export interface DataExportRequest {
  dataProjectId: string
  /** Client-generated UUID for progress events and cancel. */
  exportId: string
  source: DataExportSource
  format: DataExportFormat
  /** When omitted the server shows a native save dialog. */
  filePath?: string
  csv?: { delimiter?: ',' | ';' | '\t'; header?: boolean }
  /** Only for `query` sources: confirmation token like DataQueryRequest. */
  confirmToken?: string
}

export type DataExportResponse =
  | { status: 'ok'; filePath: string; rows: number; bytes: number; durationMs: number }
  | { status: 'cancelled' }
  | { status: 'confirmation_required'; plan: DataExecutionPlan; confirmToken: string }
  | { status: 'blocked'; plan: DataExecutionPlan; reason: string }

export interface DataExportProgressEvent {
  exportId: string
  rows: number
  bytes: number
  done: boolean
  error?: string
}

// ---------------------------------------------------------------------------------------------
// History and saved queries
// ---------------------------------------------------------------------------------------------

export interface DataHistoryEntry {
  id: string
  dataProjectId: string
  database: string | null
  /** Literals after IDENTIFIED BY / PASSWORD are masked before storing. */
  text: string
  status: 'ok' | 'error' | 'cancelled' | 'blocked'
  durationMs: number | null
  rowCount: number | null
  error: string | null
  executedAt: string
}

export interface DataSavedQuery {
  id: string
  dataProjectId: string
  name: string
  text: string
  database: string | null
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------------------------

/**
 * Text fields (filter, projection, sort, pipeline, document, update) accept relaxed shell syntax
 * (`{ _id: ObjectId('...'), at: ISODate('...') }`) or canonical/relaxed EJSON. They are parsed
 * server-side without eval (acorn + @mongodb-js/shell-bson-parser).
 */
export interface MongoFindRequest {
  dataProjectId: string
  queryId: string
  database: string
  collection: string
  filter?: string
  projection?: string
  sort?: string
  collation?: string
  hint?: string
  skip?: number
  limit: number
  maxTimeMS?: number
  /** Also run countDocuments(filter) (bounded by maxTimeMS) for "1–20 of N". */
  withCount?: boolean
}

export interface MongoFindResponse {
  documents: Array<Record<string, unknown>>
  truncated: boolean
  /** countDocuments result when requested and it finished in time. */
  count: number | null
  durationMs: number
}

export interface MongoAggregateRequest {
  dataProjectId: string
  queryId: string
  database: string
  collection: string
  /** Shell/EJSON text of the pipeline array. */
  pipeline: string
  /** Preview: run only stages [0..stageIndex] (and never $out/$merge). */
  stageIndex?: number
  limit: number
  maxTimeMS?: number
  allowDiskUse?: boolean
  confirmToken?: string
}

export type MongoAggregateResponse =
  | {
      status: 'ok'
      documents: Array<Record<string, unknown>>
      truncated: boolean
      durationMs: number
    }
  | { status: 'confirmation_required'; plan: DataExecutionPlan; confirmToken: string }
  | { status: 'blocked'; plan: DataExecutionPlan; reason: string }
  | { status: 'cancelled' }

export type MongoWriteOperation =
  | 'insertOne'
  | 'insertMany'
  | 'replaceOne'
  | 'updateOne'
  | 'updateMany'
  | 'deleteOne'
  | 'deleteMany'

export interface MongoWriteRequest {
  dataProjectId: string
  database: string
  collection: string
  op: MongoWriteOperation
  /** For update/replace/delete. */
  filter?: string
  /** insertOne/replaceOne: one document; insertMany: an array. */
  document?: string
  /** updateOne/updateMany: update document or pipeline. */
  update?: string
  upsert?: boolean
  /** Collation (EJSON object text) for updateMany/deleteMany, matching the query bar's. */
  collation?: string
  confirmToken?: string
}

export type MongoWriteResponse =
  | {
      status: 'ok'
      matchedCount?: number
      modifiedCount?: number
      deletedCount?: number
      insertedCount?: number
      upsertedId?: unknown
      durationMs: number
    }
  | { status: 'confirmation_required'; plan: DataExecutionPlan; confirmToken: string }
  | { status: 'blocked'; plan: DataExecutionPlan; reason: string }

export interface MongoIndexInfo {
  name: string
  /** Canonical EJSON key spec, e.g. { createdAt: -1 }. */
  keys: Record<string, unknown>
  unique: boolean
  sparse: boolean
  hidden: boolean
  ttlSeconds?: number | null
  partialFilterExpression?: Record<string, unknown> | null
  sizeBytes?: number | null
  /** $indexStats ops since server start, when available. */
  accesses?: number | null
}

export interface MongoCreateIndexRequest {
  dataProjectId: string
  database: string
  collection: string
  /** Shell/EJSON text of the key spec. */
  keys: string
  /** Shell/EJSON text of options (unique, sparse, expireAfterSeconds, partialFilterExpression, name...). */
  options?: string
  confirmToken?: string
}

export interface MongoDropIndexRequest {
  dataProjectId: string
  database: string
  collection: string
  name: string
  confirmToken?: string
}

export type MongoIndexMutationResponse =
  | { status: 'ok'; name?: string; durationMs: number }
  | { status: 'confirmation_required'; plan: DataExecutionPlan; confirmToken: string }
  | { status: 'blocked'; plan: DataExecutionPlan; reason: string }

export interface MongoSchemaField {
  /** Dotted path ("address.city", "items.productId"). */
  path: string
  /** Share of sampled documents that have the field (0..1). */
  probability: number
  types: Array<{ type: string; probability: number }>
  /** A few sample values (relaxed EJSON text), only for scalar types. */
  sampleValues?: string[]
  /** Distinct-value share among sampled values (0..1), when computed. */
  uniqueness?: number
}

export interface MongoSchemaRequest {
  dataProjectId: string
  database: string
  collection: string
  sampleSize?: number
}

export interface MongoSchemaResponse {
  fields: MongoSchemaField[]
  sampleSize: number
  /** Estimated collection count. */
  count: number | null
  /** $jsonSchema validator when the collection has one. */
  validator?: Record<string, unknown> | null
}

export interface MongoExplainRequest {
  dataProjectId: string
  database: string
  collection: string
  /** Explain a find (filter/sort/projection) ... */
  find?: Pick<
    MongoFindRequest,
    'filter' | 'projection' | 'sort' | 'collation' | 'hint' | 'skip' | 'limit'
  >
  /** ... or an aggregation pipeline (shell text). */
  pipeline?: string
}

export interface MongoExplainResponse {
  summary: {
    /** COLLSCAN, IXSCAN, FETCH, ... (winning plan root → leaf). */
    stages: string[]
    indexName?: string | null
    docsExamined?: number | null
    keysExamined?: number | null
    nReturned?: number | null
    executionTimeMs?: number | null
  }
  /** Raw explain output, canonical EJSON. */
  raw: Record<string, unknown>
}

export interface MongoCollectionMutationRequest {
  dataProjectId: string
  database: string
  action:
    | { kind: 'create'; collection: string; options?: string }
    | { kind: 'drop'; collection: string }
    | { kind: 'rename'; collection: string; to: string }
    | { kind: 'dropDatabase' }
  confirmToken?: string
}

export type MongoCollectionMutationResponse =
  | { status: 'ok'; durationMs: number }
  | { status: 'confirmation_required'; plan: DataExecutionPlan; confirmToken: string }
  | { status: 'blocked'; plan: DataExecutionPlan; reason: string }

// ---------------------------------------------------------------------------------------------
// AI assistant
// ---------------------------------------------------------------------------------------------

export interface DataAssistantGeneration {
  provider: 'claude-code' | 'codex' | 'opencode'
  model?: string
  effort?: string
}

export interface DataAssistantStartRequest {
  /** Client-generated UUID; events carry it. */
  requestId: string
  dataProjectId: string
  question: string
  database?: string
  schema?: string
  /** Current editor contents (for "fix this query" / "explain this"). */
  editorText?: string
  /** Earlier turns of this conversation, oldest first. */
  history: Array<{ role: 'user' | 'assistant'; text: string }>
  generation: DataAssistantGeneration
}

export interface DataQueryProposal {
  /** 'sql' for SQL engines; 'mongo' = mongosh-style text (db.orders.find(...)). */
  language: 'sql' | 'mongo'
  query: string
  explanation: string
  /** The assistant's own read/write claim; the UI re-classifies with the shared classifier. */
  isWrite: boolean
  database?: string
}

export type DataAssistantEvent =
  | { type: 'status'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; callId: string; ok: boolean; summary: string; ms: number }
  | { type: 'proposal'; proposal: DataQueryProposal }
  /** The model answered in prose without a query (a question back, or a plain answer). */
  | { type: 'answer'; text: string }
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'done'; provider: string; model?: string }

export interface DataAssistantEventPayload {
  requestId: string
  dataProjectId: string
  seq: number
  event: DataAssistantEvent
}

// ---------------------------------------------------------------------------------------------
// Events (server → renderer). Desktop-only: none of these channels is in the remote allowlist.
// ---------------------------------------------------------------------------------------------

export const DATA_STATUS_CHANNEL = 'dataProjects:status'
export const DATA_EXPORT_CHANNEL = 'dataProjects:export'
export const DATA_ASSISTANT_CHANNEL = 'dataAssistant:event'

export const isDataConnectionStatus = (value: unknown): value is DataConnectionStatus =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as DataConnectionStatus).dataProjectId === 'string' &&
  typeof (value as DataConnectionStatus).state === 'string'

export const isDataExportProgressEvent = (value: unknown): value is DataExportProgressEvent =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as DataExportProgressEvent).exportId === 'string' &&
  typeof (value as DataExportProgressEvent).rows === 'number'

export const isDataAssistantEventPayload = (value: unknown): value is DataAssistantEventPayload =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as DataAssistantEventPayload).requestId === 'string' &&
  typeof (value as DataAssistantEventPayload).event === 'object'

// ---------------------------------------------------------------------------------------------
// Errors (RpcRouteError codes; the renderer sees them as Error.name)
// ---------------------------------------------------------------------------------------------

export const DATA_ERROR_CODES = {
  notFound: 'DATA_NOT_FOUND',
  /** No usable password: ask the user (DataSecretState 'unavailable' or never given). */
  credentialsRequired: 'DATA_CREDENTIALS_REQUIRED',
  connectionFailed: 'DATA_CONNECTION_FAILED',
  /** Called from a remote device principal: data projects are desktop-only. */
  forbidden: 'DATA_FORBIDDEN',
  invalidInput: 'DATA_INVALID_INPUT',
  /** A confirm token that is unknown, expired, or for a different request. */
  confirmationInvalid: 'DATA_CONFIRMATION_INVALID',
  busy: 'DATA_BUSY',
  unsupported: 'DATA_UNSUPPORTED'
} as const
export type DataErrorCode = (typeof DATA_ERROR_CODES)[keyof typeof DATA_ERROR_CODES]
