// Shared fixtures for the engine-core tests: in-memory repository / secrets store, a project
// record factory and a scriptable fake driver. No database, no Electron.

import type {
  DataCompletionSchema,
  DataDatabaseInfo,
  DataHistoryEntry,
  DataObjectsListing,
  DataProcessInfo,
  DataSavedQuery,
  DataSecrets,
  DataSecretState,
  DataTableDetails,
  DataEngine
} from '../../../../shared/data-projects/types'
import {
  DataDriverError,
  type DataDriver,
  type DataProjectRecord,
  type DataProjectsRepository,
  type DataSecretsStore,
  type DriverConnectInput,
  type DriverExecuteOptions,
  type DriverStatementResult
} from '../contracts'

export function makeRecord(overrides: Partial<DataProjectRecord> = {}): DataProjectRecord {
  return {
    id: 'dp-1',
    name: 'Shop DB',
    engine: 'postgres',
    config: { host: '127.0.0.1', port: 5432, database: 'shop', user: 'postgres' },
    icon: null,
    iconColor: null,
    environment: 'development',
    color: null,
    safeMode: 'half-safe',
    defaultLimit: 1000,
    allowAiDataAccess: false,
    pinned: false,
    secretCiphertext: null,
    secretState: 'none',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastAccessedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

export class MemoryRepository implements DataProjectsRepository {
  records = new Map<string, DataProjectRecord>()
  history: DataHistoryEntry[] = []
  private seq = 0

  constructor(records: DataProjectRecord[] = []) {
    for (const r of records) this.records.set(r.id, r)
  }
  getDataProjects(): DataProjectRecord[] {
    return [...this.records.values()]
  }
  getDataProject(id: string): DataProjectRecord | null {
    return this.records.get(id) ?? null
  }
  createDataProject(): DataProjectRecord {
    throw new Error('not used')
  }
  updateDataProject(id: string, patch: Partial<DataProjectRecord>): DataProjectRecord | null {
    const r = this.records.get(id)
    if (!r) return null
    const next = { ...r, ...patch }
    this.records.set(id, next)
    return next
  }
  deleteDataProject(id: string): boolean {
    return this.records.delete(id)
  }
  touchDataProject(): void {}
  reorderSidebar(): void {}
  addDataQueryHistory(entry: Omit<DataHistoryEntry, 'id'>): DataHistoryEntry {
    const full = { ...entry, id: `h${++this.seq}` }
    this.history.push(full)
    return full
  }
  listDataQueryHistory(id: string): DataHistoryEntry[] {
    return this.history.filter((h) => h.dataProjectId === id).reverse()
  }
  clearDataQueryHistory(): void {
    this.history = []
  }
  listDataSavedQueries(): DataSavedQuery[] {
    return []
  }
  saveDataSavedQuery(): DataSavedQuery {
    throw new Error('not used')
  }
  deleteDataSavedQuery(): void {}
}

export class MemorySecrets implements DataSecretsStore {
  map = new Map<string, DataSecrets>()
  failing = new Set<string>()
  constructor(entries: Record<string, DataSecrets> = {}) {
    for (const [k, v] of Object.entries(entries)) this.map.set(k, v)
  }
  async store(
    id: string,
    secrets: DataSecrets
  ): Promise<{ ciphertext: string | null; state: DataSecretState }> {
    this.map.set(id, secrets)
    return { ciphertext: null, state: 'session' }
  }
  async resolve(id: string): Promise<DataSecrets> {
    if (this.failing.has(id)) {
      const err = new Error('secret unavailable') as Error & { code: string }
      err.name = 'DATA_CREDENTIALS_REQUIRED'
      err.code = 'DATA_CREDENTIALS_REQUIRED'
      throw err
    }
    return { ...(this.map.get(id) ?? {}) }
  }
  remember(id: string, secrets: DataSecrets): void {
    this.map.set(id, secrets)
  }
  forget(id: string): void {
    this.map.delete(id)
  }
  stateOf(): DataSecretState {
    return 'session'
  }
  knownSecrets(id: string): string[] {
    return Object.values(this.map.get(id) ?? {}).filter((v): v is string => !!v)
  }
}

export interface FakeCall {
  statement: string
  options: DriverExecuteOptions
}

type Handler = (
  statement: string,
  options: DriverExecuteOptions,
  driver: FakeDriver
) => Promise<DriverStatementResult> | DriverStatementResult

/** A DataDriver whose execute() is scripted per test. */
export class FakeDriver implements DataDriver {
  readonly engine: DataEngine
  connected = false
  connects = 0
  closes = 0
  calls: FakeCall[] = []
  inTransaction = false
  currentDatabase: string | undefined
  /** MySQL/MariaDB NO_BACKSLASH_ESCAPES as the driver reports it (undefined = not reported). */
  backslashEscapes: boolean | undefined
  cancelRequests = 0
  handler: Handler = (statement) => ({
    output: { kind: 'command', message: `OK ${statement}`, affectedRows: 1 }
  })
  private running: { reject: (err: Error) => void } | null = null
  failConnect: Error | null = null

  constructor(readonly input: DriverConnectInput) {
    this.engine = input.project.engine
    this.currentDatabase = input.database ?? input.project.config.database
  }

  async connect(): Promise<{ serverVersion: string; currentDatabase?: string }> {
    this.connects++
    if (this.failConnect) throw this.failConnect
    this.connected = true
    return { serverVersion: 'fake 1.0', currentDatabase: this.currentDatabase }
  }
  async close(): Promise<void> {
    this.closes++
    this.connected = false
  }
  isConnected(): boolean {
    return this.connected
  }
  sessionState(): {
    inTransaction?: boolean
    currentDatabase?: string
    backslashEscapes?: boolean
  } {
    const state: { inTransaction?: boolean; currentDatabase?: string; backslashEscapes?: boolean } =
      { inTransaction: this.inTransaction, currentDatabase: this.currentDatabase }
    if (this.backslashEscapes !== undefined) state.backslashEscapes = this.backslashEscapes
    return state
  }
  async execute(statement: string, options: DriverExecuteOptions): Promise<DriverStatementResult> {
    this.calls.push({ statement, options })
    if (options.database) this.currentDatabase = options.database
    return new Promise<DriverStatementResult>((resolve, reject) => {
      this.running = { reject }
      Promise.resolve()
        .then(() => this.handler(statement, options, this))
        .then(resolve, reject)
        .finally(() => {
          this.running = null
        })
    })
  }
  async cancelCurrent(): Promise<void> {
    this.cancelRequests++
    this.running?.reject(
      new DataDriverError('canceling statement due to user request', {
        code: '57014',
        cancelled: true
      })
    )
  }
  async listDatabases(): Promise<DataDatabaseInfo[]> {
    return [{ name: 'shop' }, { name: 'postgres' }]
  }
  async listObjects(): Promise<DataObjectsListing> {
    return { objects: [] }
  }
  details: DataTableDetails | null = null
  async describe(ref: { name: string }): Promise<DataTableDetails> {
    if (this.details) return this.details
    return {
      ref,
      kind: 'table',
      columns: [],
      indexes: [],
      foreignKeys: [],
      triggers: [],
      primaryKey: []
    }
  }
  async ddl(): Promise<string> {
    return 'CREATE TABLE x ();'
  }
  async completionSchema(): Promise<DataCompletionSchema> {
    return { databases: ['shop'], tables: [] }
  }
  async listProcesses(): Promise<DataProcessInfo[]> {
    return []
  }
  killed: Array<{ id: string; scope: string }> = []
  async killProcess(id: string, scope: 'query' | 'connection'): Promise<void> {
    this.killed.push({ id, scope })
  }
  streamBatches: Array<{ columns: string[]; rows: unknown[][] }> = []
  streamCalls: Array<{ statement: string; readOnlySandbox: boolean }> = []
  async streamRows(
    statement: string,
    options: { readOnlySandbox: boolean; signal: AbortSignal },
    onBatch: (columns: string[], rows: unknown[][]) => Promise<void>
  ): Promise<{ rows: number }> {
    this.streamCalls.push({ statement, readOnlySandbox: options.readOnlySandbox })
    let rows = 0
    for (const batch of this.streamBatches) {
      if (options.signal.aborted) throw new DataDriverError('cancelled', { cancelled: true })
      await onBatch(batch.columns, batch.rows)
      rows += batch.rows.length
    }
    return { rows }
  }
  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
  }
}

export const rowsOutput = (columns: string[], rows: unknown[][]): DriverStatementResult => ({
  output: {
    kind: 'rows',
    columns: columns.map((name) => ({ name })),
    rows: rows as never,
    truncated: false,
    limit: null,
    autoLimited: false
  }
})

export const deferred = <T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
