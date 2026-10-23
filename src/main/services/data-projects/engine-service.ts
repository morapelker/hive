// DataEngineService: everything the `dataProjects.*` RPC domain asks of a database. One lazy
// process-wide instance (getDataEngineService) in the server child; the domain hands it the
// event bus through setDataEnginePublisher so connection status and export progress reach every
// renderer.
//
// It wires the pieces of this directory together:
//   ConnectionManager   drivers per (project, database), SSH tunnels, idle close, status events
//   query-runner        split → classify → safety gate → execute → history, cancel by queryId
//   table-ops           table browsing and staged grid edits
//   export              streamed CSV/JSON/SQL exports with progress and cancel
//   import              streamed CSV/TSV → table and JSON/NDJSON/CSV → collection imports
//   mongo (mongo-server) MongoEngineService for dataProjects.mongo.*, sharing gate/registry/history
// plus small caches (describe 30 s, completion schema 5 min; both dropped when a DDL statement
// runs or the project is invalidated).
//
// Records come from the app DB (DatabaseService implements DataProjectsRepository) and secrets
// from DataSecretsStore; both are loaded lazily so tests can inject in-memory fakes instead.

import { randomUUID } from 'node:crypto'
import {
  DATA_ENGINE_INFO,
  DATA_STATUS_CHANNEL,
  sqlDialectOf,
  type DataApplyEditsRequest,
  type DataApplyEditsResponse,
  type DataCompletionSchema,
  type DataConnectionStatus,
  type DataDatabaseInfo,
  type DataExportRequest,
  type DataExportResponse,
  type DataHistoryEntry,
  type DataKillScope,
  type DataObjectRef,
  type DataObjectsListing,
  type DataProcessInfo,
  type DataQueryRequest,
  type DataQueryResponse,
  type DataRowEdit,
  type DataSecrets,
  type DataStatementOutput,
  type DataTableDetails,
  type DataTableRowsRequest,
  type DataTableRowsResponse,
  type DataTestConnectionInput,
  type DataTestConnectionResult,
  type DataExportFormat,
  type DataExportSource
} from '../../../shared/data-projects/types'
import type {
  DataCallContext,
  DataDriver,
  DataEngineService,
  DataProjectRecord,
  DataProjectsRepository,
  DataSecretsStore,
  DriverConnectInput,
  MongoEngineService
} from './contracts'
import type { MongoDriver, MongoServiceDeps } from './mongo'
import { createLogger } from '../logger'
import { ConnectionManager, noopLogger, type EngineLogger } from './connection-manager'
import { maskForHistory, QueryRegistry, runQuery } from './query-runner'
import { createSafetyGate, defaultSafetyGate, type SafetyGate } from './safety-gate'
import {
  applyEdits,
  assertSingleRead,
  previewEdits,
  qualifiedTableName,
  tableRows
} from './table-ops'
import { ExportRegistry, startExport } from './export'
import { instrumentDriver, withConsoleSource } from './console-log'
import { ImportRegistry, previewImport, startImport, type ImportDeps } from './import'
import type { OpenSshTunnelInput, SshTunnel } from './ssh-tunnel'
import { errorMessage, forbiddenError, notFoundError, redactSecrets, secretValues } from './redact'

const DESCRIBE_TTL_MS = 30_000
const COMPLETION_TTL_MS = 5 * 60_000
const TEST_CONNECT_TIMEOUT_MS = 30_000
const SAMPLE_ROWS_MAX = 50

export interface DataEngineDeps {
  /** The app DB (DatabaseService) or a test fake; a function is resolved lazily. */
  repository?:
    DataProjectsRepository | (() => DataProjectsRepository | Promise<DataProjectsRepository>)
  secrets?: DataSecretsStore
  publish?: (channel: string, payload: unknown) => void
  createDriver?: (input: DriverConnectInput) => DataDriver | Promise<DataDriver>
  openTunnel?: (input: OpenSshTunnelInput) => Promise<SshTunnel>
  showSaveDialog?: (input: { defaultName: string; extensions: string[] }) => Promise<string | null>
  createMongoEngineService?: (
    deps: MongoServiceDeps
  ) => MongoEngineService | Promise<MongoEngineService>
  mongoExportStatement?: (
    source: DataExportSource,
    format: DataExportFormat
  ) => string | Promise<string>
  gate?: SafetyGate
  logger?: EngineLogger
  idleMs?: number
  /** Tests: how often a session with an open transaction is checked (ConnectionManager). */
  txWatchMs?: number
  now?: () => number
}

export interface DataEngineServiceInternals extends DataEngineService {
  readonly connections: ConnectionManager
  readonly queries: QueryRegistry
  readonly exports: ExportRegistry
  readonly imports: ImportRegistry
}

interface CacheEntry<T> {
  at: number
  value?: T
  pending?: Promise<T>
}

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })

const definedSecrets = (secrets: DataSecrets | undefined): DataSecrets => {
  const out: DataSecrets = {}
  if (!secrets) return out
  for (const key of ['password', 'sshPassword', 'sshPassphrase'] as const) {
    const value = secrets[key]
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  return out
}

const SSH_ENGINES = new Set(['mysql', 'mariadb', 'postgres', 'clickhouse'])

export function createDataEngineService(deps: DataEngineDeps = {}): DataEngineServiceInternals {
  const now = deps.now ?? Date.now
  const log = deps.logger ?? noopLogger
  const gate = deps.gate ?? defaultSafetyGate()
  const publish = (channel: string, payload: unknown): void => {
    try {
      deps.publish?.(channel, payload)
    } catch (error) {
      log.warn('Data engine event publish failed', { channel, error: errorMessage(error) })
    }
  }

  // ---- lazy dependencies ------------------------------------------------------------------------

  let repository: DataProjectsRepository | null =
    deps.repository && typeof deps.repository !== 'function' ? deps.repository : null
  let secretsStore: DataSecretsStore | null = deps.secrets ?? null
  let readyPromise: Promise<void> | null = null

  const ready = (): Promise<void> => {
    if (repository && secretsStore) return Promise.resolve()
    readyPromise ??= (async () => {
      if (!repository) {
        if (typeof deps.repository === 'function') repository = await deps.repository()
        else {
          const { getDatabase } = await import('../../db/database')
          const db: DataProjectsRepository = getDatabase()
          repository = db
        }
      }
      if (!secretsStore) secretsStore = (await import('./secrets')).getDataSecretsStore()
    })().finally(() => {
      readyPromise = null
    })
    return readyPromise
  }

  const repo = (): DataProjectsRepository => {
    if (!repository) throw new Error('Data engine used before it was ready')
    return repository
  }

  const getRecord = (id: string): DataProjectRecord => {
    const record = repo().getDataProject(id)
    if (!record) throw notFoundError()
    return record
  }

  const secrets: DataSecretsStore = {
    store: (id, s) => secretsStore!.store(id, s),
    resolve: (id) => secretsStore!.resolve(id),
    remember: (id, s) => secretsStore!.remember(id, s),
    forget: (id) => secretsStore!.forget(id),
    stateOf: (record) => secretsStore!.stateOf(record),
    knownSecrets: (id) => (secretsStore ? secretsStore.knownSecrets(id) : [])
  }

  const createDriver = async (input: DriverConnectInput): Promise<DataDriver> => {
    if (deps.createDriver) return deps.createDriver(input)
    return (await import('./drivers')).createDriver(input)
  }

  // Every history row (editor, grid edits, Mongo documents/aggregations) passes here: its text and
  // error are masked for the project's engine before they are stored (research/safety.md §D4).
  const recordHistory = (entry: Omit<DataHistoryEntry, 'id'>): void => {
    try {
      const engine = repo().getDataProject(entry.dataProjectId)?.engine ?? 'postgres'
      repo().addDataQueryHistory({
        ...entry,
        text: maskForHistory(engine, entry.text),
        error: entry.error === null ? null : maskForHistory(engine, entry.error)
      })
    } catch (error) {
      log.warn('Failed to store data query history', {
        dataProjectId: entry.dataProjectId,
        error: errorMessage(error)
      })
    }
  }

  const manager = new ConnectionManager({
    getRecord,
    secrets,
    // Every connection of a project logs what it sends to the console (console-log.ts);
    // testConnection's own drivers are not logged.
    createDriver: async (input) => instrumentDriver(await createDriver(input), input),
    publish,
    openTunnel: deps.openTunnel,
    idleMs: deps.idleMs,
    txWatchMs: deps.txWatchMs,
    logger: log
  })
  const queries = new QueryRegistry()
  const exports = new ExportRegistry()
  const imports = new ImportRegistry()

  // ---- caches -------------------------------------------------------------------------------------

  const describeCache = new Map<string, CacheEntry<DataTableDetails>>()
  const completionCache = new Map<string, CacheEntry<DataCompletionSchema>>()
  const dropCaches = (projectId: string): void => {
    for (const key of [...describeCache.keys()])
      if (key.startsWith(`${projectId}\u0000`)) describeCache.delete(key)
    for (const key of [...completionCache.keys()])
      if (key.startsWith(`${projectId}\u0000`)) completionCache.delete(key)
  }

  const cached = async <T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    ttl: number,
    load: () => Promise<T>
  ): Promise<T> => {
    const hit = cache.get(key)
    if (hit?.value !== undefined && now() - hit.at < ttl) return hit.value
    if (hit?.pending) return hit.pending
    const entry: CacheEntry<T> = { at: now() }
    entry.pending = load().then(
      (value) => {
        if (cache.get(key) === entry) {
          entry.value = value
          entry.at = now()
          entry.pending = undefined
        }
        return value
      },
      (error) => {
        if (cache.get(key) === entry) cache.delete(key)
        throw error
      }
    )
    cache.set(key, entry)
    return entry.pending
  }

  const describe = async (id: string, ref: DataObjectRef): Promise<DataTableDetails> => {
    const key = [id, ref.database ?? '', ref.schema ?? '', ref.name, ref.kind ?? ''].join('\u0000')
    return cached(describeCache, key, DESCRIBE_TTL_MS, () =>
      manager.withDriver(id, ref.database, (driver) => driver.describe(ref), { idempotent: true })
    )
  }

  // ---- Mongo ---------------------------------------------------------------------------------------

  let mongoService: MongoEngineService | null = null
  let mongoPromise: Promise<MongoEngineService> | null = null
  const mongoDeps: MongoServiceDeps = {
    getRecord,
    getDriver: async (id) => (await manager.getDriver(id)) as MongoDriver,
    evaluateSafety: (input) => gate.evaluate(input),
    registerQuery: (queryId, clientId, cancel) =>
      queries.register(queryId, { clientId, projectId: null, cancel }),
    recordHistory
  }
  const mongoEngine = async (): Promise<MongoEngineService> => {
    await ready()
    if (mongoService) return mongoService
    mongoPromise ??= (async () => {
      const factory =
        deps.createMongoEngineService ?? (await import('./mongo')).createMongoEngineService
      mongoService = await factory(mongoDeps)
      return mongoService
    })().finally(() => {
      mongoPromise = null
    })
    return mongoPromise
  }
  const mongo: MongoEngineService = {
    find: async (req, ctx) => (await mongoEngine()).find(req, ctx),
    aggregate: async (req, ctx) => (await mongoEngine()).aggregate(req, ctx),
    write: async (req, ctx) => (await mongoEngine()).write(req, ctx),
    indexes: async (id, database, collection) =>
      (await mongoEngine()).indexes(id, database, collection),
    createIndex: async (req) => (await mongoEngine()).createIndex(req),
    dropIndex: async (req) => (await mongoEngine()).dropIndex(req),
    schema: async (req) => (await mongoEngine()).schema(req),
    explain: async (req) => (await mongoEngine()).explain(req),
    collection: async (req) => {
      const result = await (await mongoEngine()).collection(req)
      if (result.status === 'ok') dropCaches(req.dataProjectId)
      return result
    }
  }

  // ---- service ---------------------------------------------------------------------------------------

  const runnerDeps = {
    manager,
    gate,
    registry: queries,
    getRecord,
    recordHistory,
    onSchemaChanged: dropCaches,
    now,
    logger: log
  }
  const tableDeps = {
    manager,
    gate,
    registry: queries,
    getRecord,
    describe,
    recordHistory,
    now,
    logger: log
  }

  const importDeps: ImportDeps = {
    manager,
    gate,
    registry: imports,
    getRecord,
    describe,
    recordHistory,
    publish,
    now,
    logger: log
  }

  const service: DataEngineServiceInternals = {
    connections: manager,
    queries,
    exports,
    imports,

    async testConnection(input: DataTestConnectionInput): Promise<DataTestConnectionResult> {
      await ready()
      let stored: DataSecrets = {}
      if (input.dataProjectId) {
        try {
          stored = await secrets.resolve(input.dataProjectId)
        } catch {
          // Nothing usable stored: test with what was typed.
        }
      }
      const effective: DataSecrets = { ...definedSecrets(stored), ...definedSecrets(input.secrets) }
      const redact = (text: string): string =>
        redactSecrets(text, secretValues(effective as Record<string, unknown>))
      const record: DataProjectRecord = {
        id: input.dataProjectId ?? `test-${randomUUID()}`,
        name: 'Connection test',
        engine: input.engine,
        config: input.config,
        icon: null,
        iconColor: null,
        environment: 'local',
        color: null,
        safeMode: 'read-only',
        defaultLimit: 0,
        allowAiDataAccess: false,
        pinned: false,
        secretCiphertext: null,
        secretState: 'none',
        sortOrder: 0,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString()
      }
      let tunnel: SshTunnel | null = null
      let driver: DataDriver | null = null
      try {
        const driverInput: DriverConnectInput = { project: record, secrets: effective, redact }
        if (input.config.ssh?.enabled && SSH_ENGINES.has(input.engine)) {
          const open = deps.openTunnel ?? (await import('./ssh-tunnel')).openSshTunnel
          const remotePort = input.config.port || DATA_ENGINE_INFO[input.engine].defaultPort || 0
          tunnel = await open({
            ssh: input.config.ssh,
            secrets: effective,
            dstHost: input.config.host || '127.0.0.1',
            dstPort: remotePort,
            redact
          })
          driverInput.project = {
            ...record,
            config: { ...record.config, host: tunnel.localHost, port: tunnel.localPort }
          }
          driverInput.tunnel = { remoteHost: input.config.host || '127.0.0.1', remotePort }
        }
        driver = await createDriver(driverInput)
        const started = now()
        const info = await withTimeout(
          driver.connect(),
          TEST_CONNECT_TIMEOUT_MS,
          'Timed out while connecting to the server.'
        )
        const latencyMs = Math.max(0, Math.round(now() - started))
        let databases: string[] | undefined
        try {
          const list = await withTimeout(
            driver.listDatabases(),
            5_000,
            'listing databases timed out'
          )
          databases = list.filter((d) => !d.isSystem).map((d) => d.name)
        } catch {
          // Cheap extra only: users without the privilege still get a successful test.
        }
        const result: DataTestConnectionResult = {
          ok: true,
          serverVersion: info.serverVersion,
          latencyMs
        }
        if (databases) result.databases = databases
        // The SSH host key was accepted on first use: the wizard shows its fingerprint (once).
        if (tunnel?.notice) {
          result.notice = tunnel.notice
          tunnel.acknowledgeNotice?.()
        }
        return result
      } catch (error) {
        const failed: DataTestConnectionResult = { ok: false, error: errorMessage(error, redact) }
        // The tunnel opened (and saved a first-use host key) but the database step failed: still
        // show the fingerprint. An SSH-stage failure already carries it in its message.
        if (tunnel?.notice) {
          failed.notice = tunnel.notice
          tunnel.acknowledgeNotice?.()
        }
        return failed
      } finally {
        if (driver) await driver.close().catch(() => undefined)
        if (tunnel) await tunnel.close().catch(() => undefined)
      }
    },

    async connect(id: string): Promise<DataConnectionStatus> {
      await ready()
      getRecord(id)
      return manager.connect(id)
    },

    async disconnect(id: string): Promise<DataConnectionStatus> {
      await ready()
      await queries.cancelProject(id)
      exports.cancelProject(id)
      imports.cancelProject(id)
      return manager.disconnect(id)
    },

    status(id: string): DataConnectionStatus {
      return manager.status(id)
    },

    async invalidate(id: string): Promise<void> {
      await ready()
      await queries.cancelProject(id)
      exports.cancelProject(id)
      imports.cancelProject(id)
      dropCaches(id)
      await manager.invalidate(id)
      publish(DATA_STATUS_CHANNEL, {
        dataProjectId: id,
        state: 'disconnected'
      } satisfies DataConnectionStatus)
    },

    async databases(id: string): Promise<DataDatabaseInfo[]> {
      await ready()
      return manager.withDriver(id, undefined, (d) => d.listDatabases(), { idempotent: true })
    },

    async objects(id: string, database?: string, schema?: string): Promise<DataObjectsListing> {
      await ready()
      return manager.withDriver(id, database, (d) => d.listObjects(database, schema), {
        idempotent: true
      })
    },

    async describe(id: string, ref: DataObjectRef): Promise<DataTableDetails> {
      await ready()
      return describe(id, ref)
    },

    async ddl(id: string, ref: DataObjectRef): Promise<string> {
      await ready()
      return manager.withDriver(id, ref.database, (d) => d.ddl(ref), { idempotent: true })
    },

    async completionSchema(
      id: string,
      database?: string,
      refresh?: boolean
    ): Promise<DataCompletionSchema> {
      await ready()
      const key = [id, database ?? ''].join('\u0000')
      if (refresh) completionCache.delete(key)
      return cached(completionCache, key, COMPLETION_TTL_MS, () =>
        manager.withDriver(id, database, (d) => d.completionSchema(database), { idempotent: true })
      )
    },

    async execute(req: DataQueryRequest, ctx: DataCallContext): Promise<DataQueryResponse> {
      await ready()
      return runQuery(runnerDeps, req, ctx)
    },

    async cancel(queryId: string): Promise<{ cancelled: boolean }> {
      return { cancelled: await queries.cancel(queryId) }
    },

    async tableRows(
      req: DataTableRowsRequest,
      ctx: DataCallContext
    ): Promise<DataTableRowsResponse> {
      await ready()
      return tableRows(tableDeps, req, ctx)
    },

    async previewEdits(id: string, ref: DataObjectRef, edits: DataRowEdit[]): Promise<string[]> {
      await ready()
      return previewEdits(tableDeps, id, ref, edits)
    },

    async applyEdits(
      req: DataApplyEditsRequest,
      ctx: DataCallContext
    ): Promise<DataApplyEditsResponse> {
      await ready()
      return applyEdits(tableDeps, req, ctx)
    },

    async processes(id: string): Promise<DataProcessInfo[]> {
      await ready()
      return manager.withDriver(id, undefined, (d) => d.listProcesses(), { idempotent: true })
    },

    async kill(id: string, processId: string, scope: DataKillScope): Promise<void> {
      await ready()
      const record = getRecord(id)
      const text = scope === 'query' ? `KILL QUERY ${processId}` : `KILL CONNECTION ${processId}`
      // The processes panel confirms the click itself; the gate decides whether killing is
      // allowed at all (read-only mode refuses, like every other non-read).
      const decision = gate.evaluate({
        project: record,
        source: 'schema-action',
        statements: [
          { index: 0, text, start: 0, end: text.length, classification: 'admin', dangerous: [] }
        ],
        fingerprintText: `kill:${scope}:${processId}:${randomUUID()}`
      })
      if (decision.action === 'block') throw forbiddenError(decision.reason)
      await manager.withDriver(id, undefined, (d) => d.killProcess(processId, scope))
      manager.refresh(id)
    },

    async exportStart(req: DataExportRequest, ctx: DataCallContext): Promise<DataExportResponse> {
      await ready()
      return startExport(
        {
          manager,
          gate,
          registry: exports,
          getRecord,
          publish,
          showSaveDialog:
            deps.showSaveDialog ??
            (async (input) => (await import('./desktop-dialogs')).showDataSaveDialog(input)),
          mongoExportStatement: deps.mongoExportStatement,
          now,
          logger: log
        },
        req,
        ctx
      )
    },

    async exportCancel(exportId: string): Promise<{ cancelled: boolean }> {
      return { cancelled: exports.cancel(exportId) }
    },

    async importPreview(req) {
      await ready()
      return previewImport(importDeps, req)
    },

    async importStart(req, ctx) {
      await ready()
      return startImport(importDeps, req, ctx)
    },

    async importCancel(importId: string): Promise<{ cancelled: boolean }> {
      return { cancelled: imports.cancel(importId) }
    },

    mongo,

    async sampleRows(id: string, ref: DataObjectRef, limit: number): Promise<DataStatementOutput> {
      await ready()
      const record = getRecord(id)
      if (!record.allowAiDataAccess) {
        throw forbiddenError(
          'Sample data is not shared with the AI assistant for this data project.'
        )
      }
      const n = Math.max(1, Math.min(Math.trunc(limit) || 1, SAMPLE_ROWS_MAX))
      let statement: string
      let sessionDatabase: string | undefined
      if (record.engine === 'mongodb') {
        statement = `db.getCollection(${JSON.stringify(ref.name)}).find({}).limit(${n})`
        sessionDatabase = ref.database
      } else {
        const dialect = sqlDialectOf(record.engine)!
        statement = `SELECT * FROM ${qualifiedTableName(ref, dialect)} LIMIT ${n}`
        assertSingleRead(statement, dialect)
        sessionDatabase = dialect === 'postgres' ? ref.database : undefined
      }
      // The assistant's reads show as 'AI' in the console.
      return withConsoleSource('assistant', () =>
        manager.runSerial(id, ref.database, async ({ driver }) => {
          const result = await driver.execute(statement, {
            limit: n,
            hardCap: n,
            readOnlySandbox: true,
            database: sessionDatabase,
            schema: ref.schema,
            timeoutMs: 15_000
          })
          return result.output
        })
      )
    },

    releaseClient(clientId: string): void {
      queries.releaseClient(clientId)
      exports.releaseClient(clientId)
      imports.releaseClient(clientId)
    },

    async shutdown(): Promise<void> {
      exports.cancelAll()
      imports.cancelAll()
      await queries.cancelAll().catch(() => undefined)
      await manager.closeAll()
    }
  }
  return service
}

// ---------------------------------------------------------------------------------------------
// Process-wide instance
// ---------------------------------------------------------------------------------------------

let publisher: ((channel: string, payload: unknown) => void) | null = null
let singleton: DataEngineServiceInternals | null = null

/** The RPC domain passes the event bus publisher here (before or after first use). */
export function setDataEnginePublisher(publish: (channel: string, payload: unknown) => void): void {
  publisher = publish
}

export function getDataEngineService(): DataEngineService {
  if (!singleton) {
    let logger: EngineLogger | null = null
    const lazyLogger: EngineLogger = {
      info: (m, d) => (logger ??= makeLogger()).info(m, d),
      warn: (m, d) => (logger ??= makeLogger()).warn(m, d),
      error: (m, e, d) => (logger ??= makeLogger()).error(m, e, d)
    }
    singleton = createDataEngineService({
      publish: (channel, payload) => publisher?.(channel, payload),
      logger: lazyLogger
    })
  }
  return singleton
}

/** Tests only. */
export async function resetDataEngineServiceForTests(): Promise<void> {
  const current = singleton
  singleton = null
  publisher = null
  if (current) await current.shutdown()
}

function makeLogger(): EngineLogger {
  // Created on the first log line, not at import, so tests that build their own engine never
  // touch the log directory.
  return createLogger({ component: 'DataEngine' })
}

/** Re-exported for the RPC domain's convenience. */
export { createSafetyGate }
