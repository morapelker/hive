// The MongoDB DataDriver. One MongoClient (pooled) per open data project: Mongo has no
// connection-scoped session state, so the "sticky session" of the SQL drivers is just the
// session database kept here, and control operations (cancel, process list, introspection,
// export) simply take another pooled connection. Every Shell tab shares this driver, so the
// session database is per request: each execute() starts in the database the request names
// (the tab's, else the connection's), and a `use x` lasts only for the rest of its own request.
//
// execute() runs exactly one mongosh-style statement: shared parser → shared classifier (the
// read-only sandbox is enforced here from the exact classification, since MongoDB has no
// server-side read-only transaction) → BSON argument conversion → executor. Every operation gets
// a `hive:<uuid>` comment, an AbortSignal and an explicit session; cancelling aborts locally,
// then kills the server op via $currentOp(comment) → killOp, falling back to killSessions.

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  AbstractCursor,
  ClientSession,
  CollationOptions,
  Document,
  FindOptions,
  Hint,
  MongoClient,
  Sort
} from 'mongodb'
import {
  DATA_ERROR_CODES,
  isAutoRunClass,
  type DataColumnInfo,
  type DataCompletionSchema,
  type DataDatabaseInfo,
  type DataIndexInfo,
  type DataKillScope,
  type DataObjectInfo,
  type DataObjectRef,
  type DataObjectsListing,
  type DataProcessInfo,
  type DataTableDetails
} from '../../../../shared/data-projects/types'
import {
  classifyParsedMongoShell,
  findMongoOutputStages,
  parseMongoShell
} from '../../../../shared/data-projects/mongo-shell'
import { createLogger } from '../../logger'
import {
  DataDriverError,
  type DataDriver,
  type DriverConnectInput,
  type DriverExecuteOptions,
  type DriverStatementResult
} from '../contracts'
import { buildMongoClientConfig, MONGO_APP_NAME } from './connection'
import { cancelledError, toMongoDriverError } from './errors'
import {
  MONGO_MAX_RESULT_BYTES,
  aggregateSpec,
  collectDocuments,
  executeMongoShellStatement,
  findSpec,
  type MongoExecContext
} from './executor'
import {
  CsvColumnCollector,
  MONGO_EJSON_COLUMN,
  csvRow,
  parseMongoExportSpec,
  type MongoExportSpec
} from './export'
import {
  bsonSize,
  isPlainObject,
  loadMongoRuntime,
  parseShellHint,
  parseShellObject,
  parseShellValue,
  relaxedText,
  toNumberValue,
  toRelaxed,
  toShellInline,
  toShellText
} from './runtime'
import { analyzeMongoDocuments, schemaFieldsToColumns, schemaTypeLabel } from './schema'

const log = createLogger({ component: 'DataProjectsMongo' })

/** Default maxTimeMS of interactive reads when the connection sets no query timeout (Compass). */
export const MONGO_DEFAULT_READ_TIMEOUT_MS = 60_000
const SYSTEM_DATABASES = new Set(['admin', 'local', 'config'])
/**
 * Short on purpose: the engine service keeps the long-lived completion cache (and its refresh);
 * this one only absorbs bursts (editor + assistant asking at once) and in-flight duplicates.
 */
const COMPLETION_TTL_MS = 10_000
const COMPLETION_MAX_COLLECTIONS = 300
const COMPLETION_MAX_FIELDS = 300
/** Sampled BSON per collection for completion (several collections are sampled at once). */
const COMPLETION_SAMPLE_BYTES = 8 * 1024 * 1024
const LIST_STATS_MAX_COLLECTIONS = 500
const EXPORT_BATCH = 500
/** An export batch is also handed over once its documents reach this much BSON. */
const EXPORT_BATCH_BYTES = 16 * 1024 * 1024

/** Privilege actions that mean the user can change something. */
const WRITE_ACTIONS = new Set([
  'insert',
  'update',
  'remove',
  'createCollection',
  'dropCollection',
  'createIndex',
  'dropIndex',
  'dropDatabase',
  'renameCollectionSameDB',
  'collMod',
  'convertToCapped',
  'createUser',
  'dropUser'
])

export interface MongoOperationHandle {
  /** Comment attached to every command of the operation ("hive:<uuid>"). */
  readonly tag: string
  readonly signal: AbortSignal
  readonly session: ClientSession | undefined
  readonly cancelled: boolean
  /** Aborts locally and kills the server-side operation (best effort). */
  cancel(): Promise<void>
  /** Ends the explicit session; call in `finally`. */
  end(): Promise<void>
}

/**
 * DataDriver for MongoDB plus what the Mongo engine service needs (the client, cancellable
 * operations, sampling). `listObjects` = collections (engine: collection | view | timeseries |
 * capped), `describe` = sampled fields as columns + indexes, `ddl` = createCollection +
 * createIndex script, `streamRows` = see export.ts.
 */
export interface MongoDriver extends DataDriver {
  readonly engine: 'mongodb'
  /** Connected client (connects on first use). */
  getClient(): Promise<MongoClient>
  /** A fresh cancellable operation context. */
  startOperation(): Promise<MongoOperationHandle>
  /** Default maxTimeMS for interactive reads (config.queryTimeoutMs or 60 s). */
  readonly readTimeoutMs: number
  /** Default maxTimeMS for writes (config.queryTimeoutMs, else none). */
  readonly writeTimeoutMs: number | undefined
  /** Any error → redacted DataDriverError. */
  toError(
    error: unknown,
    context?: { cancelled?: boolean; timeoutMs?: number | null }
  ): DataDriverError
  /**
   * Random sample (or the first documents of views where $sample fails), promoteValues:false.
   * Stops early at `maxBytes` of BSON (default MONGO_MAX_RESULT_BYTES): callers use the length.
   */
  sampleDocuments(
    database: string,
    collection: string,
    size: number,
    maxTimeMS?: number,
    maxBytes?: number
  ): Promise<Document[]>
  /** Collection info from listCollections (type, options), null when missing. */
  collectionInfo(database: string, collection: string): Promise<Document | null>
  /** Drops cached completion schemas (all databases when omitted). */
  invalidateSchemaCache(database?: string): void
  completionSchema(
    database?: string,
    options?: { refresh?: boolean }
  ): Promise<DataCompletionSchema>
}

const indexType = (key: Record<string, unknown>): string => {
  const values = Object.values(key).map((v) => (typeof v === 'string' ? v : null))
  if (Object.keys(key).some((k) => k.includes('$**'))) return 'wildcard'
  for (const special of ['text', '2dsphere', '2d', 'hashed', 'geoHaystack']) {
    if (values.includes(special)) return special
  }
  return Object.keys(key).length > 1 ? 'compound' : 'single'
}

/** A shallow copy without the given keys. */
function withoutKeys(doc: Document, keys: readonly string[]): Document {
  const out: Document = {}
  for (const [key, value] of Object.entries(doc)) if (!keys.includes(key)) out[key] = value
  return out
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

class MongoDriverImpl implements MongoDriver {
  readonly engine = 'mongodb' as const
  readonly readTimeoutMs: number
  readonly writeTimeoutMs: number | undefined
  private client: MongoClient | null = null
  private connecting: Promise<{
    serverVersion: string
    currentDatabase?: string
    readOnlyUser?: boolean
  }> | null = null
  /** The connection's database (URI path): requests and introspection without one use it. */
  private readonly defaultDb: string | undefined
  /** Session database of the statement running / last run (after any `use` in its request). */
  private currentDb: string | undefined
  private current: MongoOperationHandle | null = null
  /** Bumped by close(): an open() that started earlier must not install its client. */
  private generation = 0
  private readonly operations = new Set<MongoOperationHandle>()
  private readonly completionCache = new Map<string, { at: number; value: DataCompletionSchema }>()
  private readonly completionInFlight = new Map<string, Promise<DataCompletionSchema>>()

  constructor(private readonly input: DriverConnectInput) {
    const config = input.project.config
    this.defaultDb = input.database?.trim() || config.database?.trim() || undefined
    this.currentDb = this.defaultDb
    const timeout =
      config.queryTimeoutMs && config.queryTimeoutMs > 0 ? config.queryTimeoutMs : undefined
    this.readTimeoutMs = timeout ?? MONGO_DEFAULT_READ_TIMEOUT_MS
    this.writeTimeoutMs = timeout
  }

  toError(
    error: unknown,
    context: { cancelled?: boolean; timeoutMs?: number | null } = {}
  ): DataDriverError {
    return toMongoDriverError(error, this.input.redact, context)
  }

  // ---- connection -----------------------------------------------------------------------------

  async connect(): Promise<{
    serverVersion: string
    currentDatabase?: string
    readOnlyUser?: boolean
  }> {
    if (this.connecting) return this.connecting
    // Set synchronously so concurrent connect() calls share one attempt (reconnect = close + open).
    this.connecting = (async () => {
      if (this.client) await this.close()
      return this.open()
    })().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async open(): Promise<{
    serverVersion: string
    currentDatabase?: string
    readOnlyUser?: boolean
  }> {
    const generation = this.generation
    const runtime = await loadMongoRuntime()
    const config = buildMongoClientConfig(this.input.project, this.input.secrets)
    const options = { ...config.options }
    if (config.tlsFiles) {
      try {
        const [cert, key] = await Promise.all([
          readFile(config.tlsFiles.certPath),
          readFile(config.tlsFiles.keyPath)
        ])
        Object.assign(options, { cert, key })
      } catch (error) {
        throw new DataDriverError(
          this.input.redact(`Cannot read the TLS certificate or key: ${(error as Error).message}`),
          {
            code: DATA_ERROR_CODES.connectionFailed
          }
        )
      }
    }
    const client = new runtime.mongodb.MongoClient(config.uri, options)
    try {
      await client.connect()
      const admin = client.db('admin')
      const build = await admin.command({ buildInfo: 1 }).catch(() => null)
      const readOnlyUser = await this.detectReadOnlyUser(client)
      if (generation !== this.generation) {
        // close() ran while we were connecting: do not resurrect the connection.
        throw new DataDriverError('The connection was closed while connecting', {
          code: DATA_ERROR_CODES.connectionFailed
        })
      }
      this.client = client
      log.info('connected', { dataProjectId: this.input.project.id, target: config.describe })
      return {
        serverVersion: typeof build?.version === 'string' ? build.version : 'unknown',
        currentDatabase: this.currentDb,
        readOnlyUser
      }
    } catch (error) {
      await client.close(true).catch(() => undefined)
      const mapped = this.toError(error)
      log.warn('connect failed', {
        dataProjectId: this.input.project.id,
        target: config.describe,
        code: mapped.code
      })
      throw mapped
    }
  }

  private async detectReadOnlyUser(client: MongoClient): Promise<boolean | undefined> {
    try {
      const status = await client.db('admin').command({ connectionStatus: 1, showPrivileges: true })
      const authInfo = (status.authInfo ?? {}) as Document
      const users = (authInfo.authenticatedUsers as unknown[]) ?? []
      if (users.length === 0) return undefined
      const privileges = (authInfo.authenticatedUserPrivileges as Document[]) ?? []
      if (privileges.length === 0) return undefined
      const canWrite = privileges.some((p) =>
        ((p.actions as string[]) ?? []).some((a) => WRITE_ACTIONS.has(a))
      )
      return !canWrite
    } catch {
      return undefined
    }
  }

  async close(): Promise<void> {
    this.generation++
    const client = this.client
    this.client = null
    this.completionCache.clear()
    for (const op of [...this.operations]) await op.cancel().catch(() => undefined)
    if (client) await client.close(true).catch(() => undefined)
  }

  isConnected(): boolean {
    return this.client !== null
  }

  sessionState(): { inTransaction?: boolean; currentDatabase?: string } {
    return { inTransaction: false, currentDatabase: this.currentDb }
  }

  async getClient(): Promise<MongoClient> {
    if (!this.client) await this.connect()
    if (!this.client)
      throw new DataDriverError('Not connected', { code: DATA_ERROR_CODES.connectionFailed })
    return this.client
  }

  // ---- operations / cancel -------------------------------------------------------------------

  async startOperation(): Promise<MongoOperationHandle> {
    const client = await this.getClient()
    const tag = `hive:${randomUUID()}`
    const controller = new AbortController()
    let session: ClientSession | undefined
    try {
      session = client.startSession({ causalConsistency: false })
    } catch {
      session = undefined
    }
    let cancelled = false
    let ended = false
    const operations = this.operations
    const killServerSide = (): Promise<void> => this.killServerSide(client, tag, session)
    const handle: MongoOperationHandle = {
      tag,
      signal: controller.signal,
      session,
      get cancelled() {
        return cancelled
      },
      async cancel() {
        if (cancelled || ended) return
        cancelled = true
        controller.abort(cancelledError())
        await killServerSide()
      },
      async end() {
        if (ended) return
        ended = true
        operations.delete(handle)
        if (session) await session.endSession().catch(() => undefined)
      }
    }
    operations.add(handle)
    return handle
  }

  /** Finds the operation by its comment tag (or session) and kills it; best effort. */
  private async killServerSide(
    client: MongoClient,
    tag: string,
    session: ClientSession | undefined
  ): Promise<void> {
    const admin = client.db('admin')
    const tagPattern = new RegExp(`^${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    const or: Document[] = [
      { 'command.comment': tagPattern },
      { 'cursor.originatingCommand.comment': tagPattern },
      { 'originatingCommand.comment': tagPattern }
    ]
    const sessionId = (session?.id as { id?: unknown } | undefined)?.id
    if (sessionId) or.push({ 'lsid.id': sessionId })
    let killed = 0
    try {
      const ops = await admin
        .aggregate(
          [
            { $currentOp: { allUsers: false, idleConnections: false, idleSessions: false } },
            { $match: { $or: or } }
          ],
          {
            maxTimeMS: 5000
          }
        )
        .toArray()
      for (const op of ops) {
        try {
          await admin.command({ killOp: 1, op: op.opid })
          killed++
        } catch (error) {
          log.debug('killOp failed', { message: this.toError(error).message })
        }
      }
    } catch (error) {
      log.debug('$currentOp for cancel failed', { message: this.toError(error).message })
    }
    if (killed === 0 && session?.id) {
      // Atlas shared tiers refuse $currentOp/killOp for some users; killSessions is the fallback.
      await admin.command({ killSessions: [session.id] }).catch(() => undefined)
    }
  }

  async cancelCurrent(): Promise<void> {
    await this.current?.cancel()
  }

  // ---- execute --------------------------------------------------------------------------------

  async execute(statement: string, options: DriverExecuteOptions): Promise<DriverStatementResult> {
    // The request's database is authoritative. A `use` only carries on to the later statements
    // of its own request (the query runner passes sessionState().currentDatabase to them), so
    // another tab's `use`, or this tab's before its selector moved, never redirects a statement
    // to a database the safety plan did not show. Set first: even a statement that fails to
    // parse must report its own request's database, not the previous request's.
    const database = options.database || this.defaultDb
    this.currentDb = database
    const parsed = parseMongoShell(statement)
    if (!parsed.ok) {
      throw new DataDriverError(parsed.error.message, {
        code: 'SyntaxError',
        position: parsed.error.offset
      })
    }
    const classification = classifyParsedMongoShell(parsed.value, { database })
    if (options.readOnlySandbox && !isAutoRunClass(classification.classification)) {
      throw new DataDriverError(
        `This statement ${classification.reasons[0] ?? 'is not a read'}; it cannot run as a read`,
        {
          code: 'ReadOnlySandbox',
          sandboxRejected: true
        }
      )
    }
    if (parsed.value.structure.kind === 'use') {
      this.currentDb = parsed.value.structure.database
      return { output: { kind: 'command', message: `switched to db ${this.currentDb}` } }
    }
    if (this.current) {
      throw new DataDriverError('Another statement is still running on this connection', {
        code: DATA_ERROR_CODES.busy
      })
    }
    const client = await this.getClient()
    const op = await this.startOperation()
    this.current = op
    const timeout = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined
    const ctx: MongoExecContext = {
      client,
      database: database ?? '',
      useDatabase: (name) => {
        this.currentDb = name
      },
      tag: op.tag,
      signal: op.signal,
      session: op.session,
      limit: options.limit,
      hardCap: options.hardCap,
      readTimeoutMs: timeout ?? this.readTimeoutMs,
      writeTimeoutMs: timeout ?? this.writeTimeoutMs
    }
    const started = Date.now()
    try {
      const result = await executeMongoShellStatement(ctx, parsed.value)
      result.stats = { ...(result.stats ?? {}), elapsedMs: Date.now() - started }
      if (classification.classification === 'ddl') this.invalidateSchemaCache()
      return result
    } catch (error) {
      throw this.toError(error, { cancelled: op.cancelled, timeoutMs: ctx.effectiveTimeoutMs })
    } finally {
      this.current = null
      await op.end()
    }
  }

  // ---- introspection --------------------------------------------------------------------------

  /** Introspection target: the given database, else the connection's (never a shell `use`). */
  private databaseFor(database?: string): string {
    return database || this.defaultDb || 'test'
  }

  async listDatabases(): Promise<DataDatabaseInfo[]> {
    const client = await this.getClient()
    try {
      const result = await client
        .db('admin')
        .command({ listDatabases: 1, nameOnly: false, authorizedDatabases: true })
      const list = ((result.databases as Document[]) ?? []).map((d) => ({
        name: String(d.name),
        sizeBytes: toNumberValue(d.sizeOnDisk),
        isSystem: SYSTEM_DATABASES.has(String(d.name))
      }))
      return list.sort(
        (a, b) => Number(a.isSystem) - Number(b.isSystem) || a.name.localeCompare(b.name)
      )
    } catch (error) {
      // Users limited to one database may not list databases: show the configured one.
      const fallback = this.defaultDb
      if (fallback) return [{ name: fallback, sizeBytes: null, isSystem: false }]
      throw this.toError(error)
    }
  }

  async collectionInfo(database: string, collection: string): Promise<Document | null> {
    const client = await this.getClient()
    const list = await client
      .db(database)
      .listCollections({ name: collection }, { nameOnly: false, authorizedCollections: true })
      .toArray()
    return (list[0] as Document | undefined) ?? null
  }

  private async collStats(
    database: string,
    collection: string,
    maxTimeMS = 5000
  ): Promise<Document | null> {
    const client = await this.getClient()
    try {
      const docs = await client
        .db(database)
        .collection(collection)
        .aggregate([{ $collStats: { storageStats: {}, count: {} } }], { maxTimeMS })
        .toArray()
      return (docs[0] as Document | undefined) ?? null
    } catch {
      return null
    }
  }

  async listObjects(database?: string): Promise<DataObjectsListing> {
    const dbName = this.databaseFor(database)
    const client = await this.getClient()
    let infos: Document[]
    try {
      infos = await client
        .db(dbName)
        .listCollections({}, { nameOnly: false, authorizedCollections: true })
        .toArray()
    } catch (error) {
      throw this.toError(error)
    }
    infos = infos
      .filter((info) => typeof info.name === 'string' && !String(info.name).startsWith('system.'))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    const objects = await mapLimit(infos, 8, async (info, position): Promise<DataObjectInfo> => {
      const name = String(info.name)
      const type = String(info.type ?? 'collection')
      const options = (info.options ?? {}) as Document
      const engine = type === 'collection' && options.capped ? 'capped' : type
      const object: DataObjectInfo = {
        name,
        kind: 'collection',
        engine,
        rowEstimate: null,
        sizeBytes: null
      }
      if (type === 'view') {
        object.detail = typeof options.viewOn === 'string' ? `view on ${options.viewOn}` : 'view'
        return object
      }
      if (position >= LIST_STATS_MAX_COLLECTIONS) return object
      const stats = await this.collStats(dbName, name)
      const storage = (stats?.storageStats ?? null) as Document | null
      object.rowEstimate = toNumberValue(stats?.count?.count ?? storage?.count)
      object.sizeBytes = toNumberValue(storage?.storageSize ?? storage?.size)
      if (object.rowEstimate === null) {
        object.rowEstimate = await client
          .db(dbName)
          .collection(name)
          .estimatedDocumentCount({ maxTimeMS: 5000 })
          .catch(() => null)
      }
      const nindexes = toNumberValue(storage?.nindexes)
      if (nindexes !== null) object.detail = `${nindexes} index${nindexes === 1 ? '' : 'es'}`
      return object
    })
    return { objects }
  }

  async sampleDocuments(
    database: string,
    collection: string,
    size: number,
    maxTimeMS = 30_000,
    maxBytes = MONGO_MAX_RESULT_BYTES
  ): Promise<Document[]> {
    const client = await this.getClient()
    const coll = client.db(database).collection(collection)
    try {
      const sampled = await collectDocuments(
        coll.aggregate([{ $sample: { size } }], {
          maxTimeMS,
          promoteValues: false,
          allowDiskUse: true
        }),
        size,
        maxBytes
      )
      return sampled.docs
    } catch (error) {
      const code = (error as { code?: number }).code
      if (code === 50) throw error // maxTimeMS: do not double the wait
      const first = await collectDocuments(
        coll.find({}, { limit: size, maxTimeMS, promoteValues: false }),
        size,
        maxBytes
      )
      return first.docs
    }
  }

  private async indexDetails(
    database: string,
    collection: string,
    storage: Document | null
  ): Promise<DataIndexInfo[]> {
    const client = await this.getClient()
    let indexes: Document[]
    try {
      indexes = await client.db(database).collection(collection).listIndexes().toArray()
    } catch {
      return [] // views and time-series views have no listIndexes
    }
    const sizes = (storage?.indexSizes ?? {}) as Document
    return indexes.map((index) => {
      const key = (index.key ?? {}) as Record<string, unknown>
      const rest = withoutKeys(index, ['v', 'key', 'ns'])
      const definition = Object.keys(rest).length > 1 ? { key, ...rest } : key
      return {
        name: String(index.name),
        columns: Object.keys(key),
        unique: index.unique === true || index.name === '_id_',
        primary: index.name === '_id_',
        definition: relaxedText(definition, 4000),
        type: index.expireAfterSeconds !== undefined ? `${indexType(key)} (TTL)` : indexType(key),
        sizeBytes: toNumberValue(sizes[String(index.name)])
      }
    })
  }

  async describe(ref: DataObjectRef): Promise<DataTableDetails> {
    const dbName = this.databaseFor(ref.database)
    try {
      const [info, stats, sample] = await Promise.all([
        this.collectionInfo(dbName, ref.name),
        this.collStats(dbName, ref.name),
        this.sampleDocuments(dbName, ref.name, 100, 10_000).catch(() => [] as Document[])
      ])
      if (!info) {
        throw new DataDriverError(`Collection "${ref.name}" does not exist in ${dbName}`, {
          code: DATA_ERROR_CODES.notFound
        })
      }
      const storage = (stats?.storageStats ?? null) as Document | null
      const type = String(info.type ?? 'collection')
      const options = (info.options ?? {}) as Document
      const columns: DataColumnInfo[] = schemaFieldsToColumns(analyzeMongoDocuments(sample))
      const indexes = await this.indexDetails(dbName, ref.name, storage)
      const properties: Array<{ label: string; value: string }> = [{ label: 'Type', value: type }]
      if (options.capped) {
        properties.push({
          label: 'Capped',
          value: `size ${options.size ?? '?'} bytes${options.max ? `, max ${options.max} documents` : ''}`
        })
      }
      if (options.viewOn) properties.push({ label: 'View on', value: String(options.viewOn) })
      if (options.pipeline)
        properties.push({ label: 'Pipeline', value: relaxedText(options.pipeline, 4000) })
      if (options.timeseries)
        properties.push({ label: 'Time series', value: relaxedText(options.timeseries, 1000) })
      if (options.expireAfterSeconds !== undefined)
        properties.push({ label: 'Expire after (s)', value: String(options.expireAfterSeconds) })
      if (options.clusteredIndex)
        properties.push({
          label: 'Clustered index',
          value: relaxedText(options.clusteredIndex, 1000)
        })
      if (options.collation)
        properties.push({ label: 'Collation', value: relaxedText(options.collation, 1000) })
      if (options.validator)
        properties.push({ label: 'Validator', value: relaxedText(options.validator, 8000) })
      if (options.validationLevel)
        properties.push({ label: 'Validation level', value: String(options.validationLevel) })
      if (options.validationAction)
        properties.push({ label: 'Validation action', value: String(options.validationAction) })
      const avg = toNumberValue(storage?.avgObjSize)
      if (avg !== null)
        properties.push({ label: 'Average document size', value: `${Math.round(avg)} bytes` })
      const totalIndexSize = toNumberValue(storage?.totalIndexSize)
      if (totalIndexSize !== null)
        properties.push({ label: 'Total index size', value: `${totalIndexSize} bytes` })
      properties.push({ label: 'Sampled documents', value: String(sample.length) })
      return {
        ref: { ...ref, database: dbName, kind: 'collection' },
        kind: 'collection',
        columns,
        indexes,
        foreignKeys: [],
        triggers: [],
        primaryKey: type === 'view' ? [] : ['_id'],
        rowEstimate: toNumberValue(stats?.count?.count ?? storage?.count),
        sizeBytes: toNumberValue(storage?.storageSize ?? storage?.size),
        engine: type === 'collection' && options.capped ? 'capped' : type,
        properties
      }
    } catch (error) {
      throw this.toError(error)
    }
  }

  async ddl(ref: DataObjectRef): Promise<string> {
    const dbName = this.databaseFor(ref.database)
    const client = await this.getClient()
    try {
      const info = await this.collectionInfo(dbName, ref.name)
      if (!info) {
        throw new DataDriverError(`Collection "${ref.name}" does not exist in ${dbName}`, {
          code: DATA_ERROR_CODES.notFound
        })
      }
      const quoted = JSON.stringify(ref.name)
      const lines = [`// ${dbName}.${ref.name}`]
      const options = { ...((info.options ?? {}) as Document) }
      if (info.type === 'view') {
        const { viewOn, pipeline, ...rest } = options
        const extra = Object.keys(rest).length > 0 ? `, ${toShellText(rest)}` : ''
        lines.push(
          `db.createView(${quoted}, ${JSON.stringify(viewOn)}, ${toShellText(pipeline ?? [])}${extra})`
        )
        return lines.join('\n')
      }
      lines.push(
        `db.createCollection(${quoted}${Object.keys(options).length > 0 ? `, ${toShellText(options)}` : ''})`
      )
      const indexes = await client
        .db(dbName)
        .collection(ref.name)
        .listIndexes()
        .toArray()
        .catch(() => [] as Document[])
      for (const index of indexes) {
        if (index.name === '_id_' || index.clustered) continue
        const rest = withoutKeys(index, ['v', 'key', 'ns'])
        lines.push(
          `db.getCollection(${quoted}).createIndex(${toShellInline(index.key)}, ${toShellInline(rest)})`
        )
      }
      return lines.join('\n')
    } catch (error) {
      throw this.toError(error)
    }
  }

  invalidateSchemaCache(database?: string): void {
    if (database === undefined) this.completionCache.clear()
    else this.completionCache.delete(database)
  }

  async completionSchema(
    database?: string,
    options: { refresh?: boolean } = {}
  ): Promise<DataCompletionSchema> {
    const dbName = this.databaseFor(database)
    const cached = this.completionCache.get(dbName)
    if (cached && !options.refresh && Date.now() - cached.at < COMPLETION_TTL_MS)
      return cached.value
    const inFlight = this.completionInFlight.get(dbName)
    if (inFlight && !options.refresh) return inFlight
    const promise = this.buildCompletionSchema(dbName).finally(() => {
      if (this.completionInFlight.get(dbName) === promise) this.completionInFlight.delete(dbName)
    })
    this.completionInFlight.set(dbName, promise)
    return promise
  }

  private async buildCompletionSchema(dbName: string): Promise<DataCompletionSchema> {
    const client = await this.getClient()
    const databases = await this.listDatabases()
      .then((list) => list.map((d) => d.name))
      .catch(() => [] as string[])
    let names: Array<{ name: string; type: string }> = []
    try {
      const infos = await client
        .db(dbName)
        .listCollections({}, { nameOnly: true, authorizedCollections: true })
        .toArray()
      names = infos
        .map((info) => ({ name: String(info.name), type: String(info.type ?? 'collection') }))
        .filter((info) => !info.name.startsWith('system.'))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) {
      throw this.toError(error)
    }
    let truncated = names.length > COMPLETION_MAX_COLLECTIONS
    const sampled = names.slice(0, COMPLETION_MAX_COLLECTIONS)
    const tables = await mapLimit(sampled, 6, async (entry) => {
      let docs: Document[] = []
      try {
        docs = await this.sampleDocuments(dbName, entry.name, 100, 3000, COMPLETION_SAMPLE_BYTES)
      } catch {
        truncated = true
      }
      const fields = analyzeMongoDocuments(docs, {
        maxFields: COMPLETION_MAX_FIELDS,
        maxSampleValues: 0
      })
      return {
        name: entry.name,
        kind: 'collection' as const,
        columns: fields.map((field) => ({ name: field.path, type: schemaTypeLabel(field) }))
      }
    })
    for (const entry of names.slice(COMPLETION_MAX_COLLECTIONS))
      tables.push({ name: entry.name, kind: 'collection', columns: [] })
    const value: DataCompletionSchema = { database: dbName, databases, tables }
    if (truncated) value.truncated = true
    this.completionCache.set(dbName, { at: Date.now(), value })
    return value
  }

  // ---- processes ------------------------------------------------------------------------------

  async listProcesses(): Promise<DataProcessInfo[]> {
    const client = await this.getClient()
    const admin = client.db('admin')
    const tag = `hive:processes:${randomUUID()}`
    const run = (allUsers: boolean): Promise<Document[]> =>
      admin
        .aggregate(
          [
            {
              $currentOp: {
                allUsers,
                idleConnections: false,
                idleSessions: false,
                truncateOps: true
              }
            },
            { $match: { 'command.comment': { $ne: tag } } },
            { $limit: 2000 }
          ],
          { maxTimeMS: 10_000, comment: tag }
        )
        .toArray()
    let ops: Document[]
    try {
      ops = await run(true)
    } catch (error) {
      // Without the inprog privilege only our own user's operations are visible.
      if ((error as { code?: number }).code !== 13) throw this.toError(error)
      ops = await run(false).catch((e) => {
        throw this.toError(e)
      })
    }
    return ops.map((op) => {
      const users = (op.effectiveUsers as Document[] | undefined) ?? []
      const ns = typeof op.ns === 'string' ? op.ns : null
      const micros = toNumberValue(op.microsecs_running)
      const secs = toNumberValue(op.secs_running)
      const command = op.command ?? op.originatingCommand
      const extra: Record<string, string | number | null> = {
        op: typeof op.op === 'string' ? op.op : null,
        ns,
        appName: typeof op.appName === 'string' ? op.appName : null,
        planSummary: typeof op.planSummary === 'string' ? op.planSummary : null,
        desc: typeof op.desc === 'string' ? op.desc : null,
        connectionId: toNumberValue(op.connectionId),
        waitingForLock:
          op.waitingForLock === true ? 'yes' : op.waitingForLock === false ? 'no' : null
      }
      return {
        id: String(op.opid),
        user: users.length > 0 ? `${users[0].user}@${users[0].db}` : null,
        host:
          typeof op.client === 'string'
            ? op.client
            : typeof op.client_s === 'string'
              ? op.client_s
              : null,
        database: ns ? ns.split('.')[0] || null : null,
        state: op.active === false ? 'idle' : op.waitingForLock ? 'waiting for lock' : 'active',
        command: typeof op.op === 'string' ? op.op : typeof op.type === 'string' ? op.type : null,
        durationMs:
          micros !== null ? Math.round(micros / 1000) : secs !== null ? secs * 1000 : null,
        query: command ? relaxedText(command, 4000) : null,
        isOwn: op.appName === MONGO_APP_NAME,
        extra
      }
    })
  }

  async killProcess(processId: string, _scope: DataKillScope): Promise<void> {
    // MongoDB kills operations, not connections: both scopes run killOp.
    const client = await this.getClient()
    const id = processId.trim()
    const op: number | string = /^-?\d+$/.test(id) ? Number(id) : id
    try {
      await client.db('admin').command({ killOp: 1, op })
    } catch (error) {
      throw this.toError(error)
    }
  }

  // ---- export ---------------------------------------------------------------------------------

  async streamRows(
    statement: string,
    options: { database?: string; schema?: string; readOnlySandbox: boolean; signal: AbortSignal },
    onBatch: (columns: string[], rows: unknown[][]) => Promise<void>
  ): Promise<{ rows: number }> {
    const spec = parseMongoExportSpec(statement)
    const format = spec?.format ?? 'json'
    if (format !== 'csv' && format !== 'json') {
      throw new DataDriverError('MongoDB exports are CSV or JSON', {
        code: DATA_ERROR_CODES.unsupported
      })
    }
    const client = await this.getClient()
    const tag = `hive:export:${randomUUID()}`
    const openCursor = this.exportCursorFactory(client, spec, statement, options.database, tag)
    const { signal } = options
    let current: { close(): Promise<void> } | null = null
    const onAbort = (): void => {
      void current?.close().catch(() => undefined)
      void this.killServerSide(client, tag, undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const checkAbort = (): void => {
      if (signal.aborted) throw cancelledError()
    }
    // Batches are handed over every EXPORT_BATCH documents or EXPORT_BATCH_BYTES of BSON,
    // whichever comes first (500 documents of up to 16 MB each must not pile up in memory).
    let rows = 0
    let batch: unknown[][] = []
    let batchBytes = 0
    const flush = async (columns: string[]): Promise<void> => {
      rows += batch.length
      const out = batch
      batch = []
      batchBytes = 0
      await onBatch(columns, out)
    }
    const add = async (columns: string[], row: unknown[], doc: Document): Promise<void> => {
      batch.push(row)
      batchBytes += bsonSize(doc)
      if (batch.length >= EXPORT_BATCH || batchBytes >= EXPORT_BATCH_BYTES) await flush(columns)
    }
    try {
      checkAbort()
      if (format === 'json') {
        const cursor = openCursor()
        current = cursor
        for await (const doc of cursor) {
          checkAbort()
          await add([MONGO_EJSON_COLUMN], [toRelaxed(doc)], doc)
        }
        checkAbort()
        if (batch.length > 0) await flush([MONGO_EJSON_COLUMN])
        return { rows }
      }
      // CSV: pass 1 finds every dotted path so the header is complete; pass 2 writes rows.
      const collector = new CsvColumnCollector()
      const first = openCursor()
      current = first
      for await (const doc of first) {
        checkAbort()
        collector.add(doc as Record<string, unknown>)
      }
      checkAbort()
      const columns = collector.columns()
      const index = new Map(columns.map((name, i) => [name, i]))
      const second = openCursor()
      current = second
      for await (const doc of second) {
        checkAbort()
        await add(columns, csvRow(doc as Record<string, unknown>, columns, index), doc)
      }
      checkAbort()
      if (batch.length > 0 || rows === 0) await flush(columns)
      return { rows }
    } catch (error) {
      throw this.toError(error, { cancelled: signal.aborted })
    } finally {
      signal.removeEventListener('abort', onAbort)
      await current?.close().catch(() => undefined)
    }
  }

  /** A function opening a fresh cursor over the export source (CSV needs two passes). */
  private exportCursorFactory(
    client: MongoClient,
    spec: MongoExportSpec | null,
    statement: string,
    database: string | undefined,
    tag: string
  ): () => AbstractCursor<Document> {
    const base = { comment: tag, promoteValues: false, batchSize: 1000, allowDiskUse: true }
    if (spec && !spec.shell) {
      if (!spec.collection)
        throw new DataDriverError('Export: no collection given', {
          code: DATA_ERROR_CODES.invalidInput
        })
      const coll = client
        .db(spec.database || this.databaseFor(database))
        .collection(spec.collection)
      // The query bar's collation and hint: the export matches what the Documents tab showed.
      const collation = parseShellObject(spec.collation, 'Collation')
      const hint = parseShellHint(spec.hint)
      const matching: { collation?: CollationOptions; hint?: Hint } = {}
      if (collation) matching.collation = collation as unknown as CollationOptions
      if (hint) matching.hint = hint
      if (spec.pipeline?.trim()) {
        const pipeline = parseShellValue(spec.pipeline, 'Pipeline')
        if (!Array.isArray(pipeline) || pipeline.some((stage) => !isPlainObject(stage))) {
          throw new DataDriverError('Pipeline must be an array of stages', {
            code: DATA_ERROR_CODES.invalidInput
          })
        }
        if (findMongoOutputStages(pipeline).length > 0) {
          throw new DataDriverError('Exports never write: remove $out/$merge from the pipeline', {
            code: DATA_ERROR_CODES.invalidInput
          })
        }
        return () => coll.aggregate(pipeline as Document[], { ...base, ...matching })
      }
      const filter = parseShellObject(spec.filter, 'Filter') ?? {}
      const projection = parseShellObject(spec.projection, 'Projection')
      const sort = parseShellObject(spec.sort, 'Sort')
      const findOptions: FindOptions = { ...base, ...matching }
      if (projection) findOptions.projection = projection
      if (sort) findOptions.sort = sort as Sort
      return () => coll.find(filter, findOptions)
    }
    const text = spec?.shell ?? statement
    const parsed = parseMongoShell(text)
    if (!parsed.ok)
      throw new DataDriverError(parsed.error.message, {
        code: 'SyntaxError',
        position: parsed.error.offset
      })
    const structure = parsed.value.structure
    const dbName = structure.database || spec?.database || this.databaseFor(database)
    const classification = classifyParsedMongoShell(parsed.value, { database: dbName })
    const exportable =
      classification.classification === 'read' &&
      classification.returnsDocuments &&
      structure.kind === 'collection' &&
      (structure.method === 'find' || structure.method === 'aggregate') &&
      !structure.explain
    if (!exportable) {
      throw new DataDriverError(
        'Only find() and aggregate() statements that return documents can be exported',
        {
          code: DATA_ERROR_CODES.unsupported
        }
      )
    }
    const coll = client.db(dbName).collection(structure.collection ?? '')
    if (structure.method === 'aggregate') {
      const { pipeline, options } = aggregateSpec(parsed.value)
      return () => coll.aggregate(pipeline, { ...options, ...base })
    }
    const { filter, options, userLimit } = findSpec(parsed.value)
    const findOptions = {
      ...options,
      ...base,
      ...(userLimit ? { limit: Math.abs(userLimit) } : {})
    }
    return () => coll.find(filter, findOptions)
  }

  quoteIdentifier(name: string): string {
    return JSON.stringify(name)
  }
}

export function createMongoDriver(input: DriverConnectInput): MongoDriver {
  return new MongoDriverImpl(input)
}
