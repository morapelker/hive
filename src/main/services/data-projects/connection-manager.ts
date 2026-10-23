// Owns every open database connection of every data project in the server child.
//
// Shape: one ProjectEntry per data project, holding driver SLOTS keyed by "database key":
// PostgreSQL needs a connection per database (no USE), so its key is the database name; every
// other engine has a single slot ('') and switches database per call (MySQL/MariaDB `USE` on the
// session, ClickHouse session database, Mongo db per operation). Each slot has its own serial
// queue: the sticky session runs one user statement at a time (a pool would silently break USE,
// SET, temp tables and transactions).
//
// Lifecycle: lazy connect on first use with dedupe of concurrent connects; a status DTO
// (DATA_STATUS_CHANNEL) published on every change; idle close after 15 minutes without activity
// (never while a user transaction is open: closing would silently roll it back); fatal connection
// errors drop the slot so the next call reconnects (callers retry idempotent reads once). The SSH
// tunnel (if configured) is opened before the first driver and closed with the last one; when the
// tunnel dies every driver of the project is dropped and the status shows why.
//
// Lost transactions: a session that dies while the user's transaction is open (wait_timeout,
// idle_in_transaction_session_timeout, failover, a kill, the tunnel) took that transaction with
// it. Each slot remembers whether its session was last seen inside a transaction; while one is,
// a cheap timer watches the driver's connected flag so the status drops the transaction (and
// shows the loss) at once. The next editor run on that slot is then refused with
// TransactionLostError instead of silently running on a fresh session, where a COMMIT would
// "succeed" with nothing to commit. Background readers (table pages, introspection, the
// assistant) reconnect without consuming that report.
//
// Secrets come from DataSecretsStore.resolve() at connect time and are only kept as the list of
// strings to redact from errors.

import {
  DATA_ENGINE_INFO,
  DATA_ERROR_CODES,
  DATA_STATUS_CHANNEL,
  type DataConnectionStatus,
  type DataSecrets
} from '../../../shared/data-projects/types'
import {
  DataDriverError,
  type DataDriver,
  type DataProjectRecord,
  type DataSecretsStore,
  type DriverConnectInput
} from './contracts'
import {
  connectionFailedError,
  credentialsRequiredError,
  errorMessage,
  isDataEngineError,
  redactSecrets,
  secretValues
} from './redact'
import type { OpenSshTunnelInput, SshTunnel } from './ssh-tunnel'

export const IDLE_CLOSE_MS = 15 * 60 * 1000
const CONNECT_TIMEOUT_MS = 45_000
/** How often a session with an open transaction is checked for having died while idle. */
export const TX_WATCH_MS = 1_000

const TX_LOST_MESSAGE =
  'The connection to the server was lost while a transaction was open, so the server rolled the transaction back. Nothing was run; run again to continue on a new connection.'
const TX_CLOSED_MESSAGE =
  'The connection was closed while a transaction was open, so the server rolled the transaction back. Nothing was run; run again to continue on a new connection.'
/** The status error while no session is left after such a loss (the workspace banner). */
const TX_LOST_STATUS =
  'The connection was lost while a transaction was open; the server rolled the transaction back.'

/**
 * Thrown by runSerial (`reportLostTransaction`) when the slot's previous session died with the
 * user's transaction open: nothing ran, and the next run uses a fresh session.
 */
export class TransactionLostError extends DataDriverError {
  constructor(message: string = TX_LOST_MESSAGE) {
    super(message, { code: 'CONNECTION_LOST' })
    this.name = 'TransactionLostError'
  }
}

export interface EngineLogger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, error?: Error, data?: Record<string, unknown>): void
}

export const noopLogger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {} }

export interface ConnectionManagerDeps {
  getRecord(id: string): DataProjectRecord
  secrets: DataSecretsStore
  createDriver(input: DriverConnectInput): DataDriver | Promise<DataDriver>
  publish(channel: string, payload: unknown): void
  openTunnel?(input: OpenSshTunnelInput): Promise<SshTunnel>
  idleMs?: number
  /** Check interval for sessions with an open transaction (TX_WATCH_MS). */
  txWatchMs?: number
  logger?: EngineLogger
}

/** Thrown to a queued task whose AbortSignal fired before it started. */
export class QueueAbortedError extends Error {
  constructor() {
    super('Cancelled before it started')
    this.name = 'QueueAbortedError'
  }
}

/** FIFO of async tasks; a waiting task can be dropped through its AbortSignal. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve()
  private waiting = 0
  private active = false

  get busy(): boolean {
    return this.active || this.waiting > 0
  }

  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.waiting++
    return new Promise<T>((resolve, reject) => {
      let aborted = false
      const onAbort = (): void => {
        aborted = true
        reject(new QueueAbortedError())
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      void previous.then(async () => {
        signal?.removeEventListener('abort', onAbort)
        this.waiting--
        if (aborted) {
          release()
          return
        }
        this.active = true
        try {
          resolve(await fn())
        } catch (error) {
          reject(error)
        } finally {
          this.active = false
          release()
        }
      })
    })
  }
}

interface Slot {
  key: string
  database: string | undefined
  driver: DataDriver | null
  connecting: Promise<DataDriver> | null
  queue: SerialQueue
  /** The session was inside the user's transaction when last seen alive (after a session task). */
  txOpen: boolean
  /** Set when that session went away with the transaction open, until an editor run reports it. */
  lostTx: string | null
}

interface ProjectEntry {
  id: string
  state: DataConnectionStatus['state']
  error?: string
  serverVersion?: string
  connectedAt?: string
  readOnlyUser?: boolean
  notice?: string
  slots: Map<string, Slot>
  lastSlotKey: string | null
  tunnel: SshTunnel | null
  tunnelPromise: Promise<SshTunnel> | null
  knownSecrets: string[]
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Polls the sessions of slots with an open transaction (see TX_WATCH_MS). */
  txWatch: ReturnType<typeof setTimeout> | null
  activity: number
  /** Bumped by disconnect/invalidate: in-flight connects of an older generation are discarded. */
  generation: number
  lastPublished: string | null
}

const SSH_ENGINES = new Set(['mysql', 'mariadb', 'postgres', 'clickhouse'])

/** Error codes that mean "wrong user/password" (ask for credentials again). */
const AUTH_FAILURE_CODES = new Set([
  '1045', // MySQL/MariaDB ER_ACCESS_DENIED_ERROR
  '1698', // MySQL ER_ACCESS_DENIED_NO_PASSWORD_ERROR
  '28P01', // PG invalid_password
  '28000', // PG invalid_authorization_specification
  '516', // ClickHouse AUTHENTICATION_FAILED
  '192', // ClickHouse UNKNOWN_USER
  '18', // Mongo AuthenticationFailed
  'AuthenticationFailed'
])

const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'PROTOCOL_CONNECTION_LOST',
  'CONNECTION_LOST',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08003',
  '08006',
  '2006', // MySQL CR_SERVER_GONE_ERROR
  '2013' // MySQL CR_SERVER_LOST
])

/** Does this error mean the connection itself is gone (as opposed to a statement error)? */
export function isConnectionLostError(error: unknown, driver?: DataDriver | null): boolean {
  if (isDataEngineError(error)) return false
  if (driver && !driver.isConnected()) return true
  if (!error || typeof error !== 'object') return false
  const code = String((error as { code?: unknown }).code ?? '')
  if (CONNECTION_ERROR_CODES.has(code)) return true
  const name = String((error as { name?: unknown }).name ?? '')
  if (/MongoNetwork|MongoServerSelection|MongoNotConnected/.test(name)) return true
  return /connection (was )?(lost|terminated|closed|reset)|socket hang up|Connection terminated|server has gone away|Lost connection/i.test(
    errorMessage(error)
  )
}

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DataDriverError(message, { code: 'ETIMEDOUT' })), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })

export class ConnectionManager {
  private readonly entries = new Map<string, ProjectEntry>()
  private readonly idleMs: number
  private readonly txWatchMs: number
  private readonly log: EngineLogger

  constructor(private readonly deps: ConnectionManagerDeps) {
    this.idleMs = deps.idleMs ?? IDLE_CLOSE_MS
    this.txWatchMs = deps.txWatchMs ?? TX_WATCH_MS
    this.log = deps.logger ?? noopLogger
  }

  // ---- keys and entries ----------------------------------------------------------------------

  /** Slot key: the database for PostgreSQL, '' for every other engine. */
  slotKey(record: DataProjectRecord, database?: string): string {
    if (record.engine !== 'postgres') return ''
    return database || record.config.database || 'postgres'
  }

  private entry(id: string): ProjectEntry {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = {
        id,
        state: 'disconnected',
        slots: new Map(),
        lastSlotKey: null,
        tunnel: null,
        tunnelPromise: null,
        knownSecrets: [],
        idleTimer: null,
        txWatch: null,
        activity: 0,
        generation: 0,
        lastPublished: null
      }
      this.entries.set(id, entry)
    }
    return entry
  }

  private slot(entry: ProjectEntry, key: string, database: string | undefined): Slot {
    let slot = entry.slots.get(key)
    if (!slot) {
      slot = {
        key,
        database,
        driver: null,
        connecting: null,
        queue: new SerialQueue(),
        txOpen: false,
        lostTx: null
      }
      entry.slots.set(key, slot)
    }
    return slot
  }

  /** Redactor bound to every secret known for the project (connect-time and store). */
  redactor(id: string): (text: string) => string {
    return (text: string) => {
      const entry = this.entries.get(id)
      let stored: string[] = []
      try {
        stored = this.deps.secrets.knownSecrets(id)
      } catch {
        // The store may not know the project (test connections).
      }
      return redactSecrets(text, [...(entry?.knownSecrets ?? []), ...stored])
    }
  }

  // ---- status ----------------------------------------------------------------------------------

  status(id: string): DataConnectionStatus {
    const entry = this.entries.get(id)
    if (!entry) return { dataProjectId: id, state: 'disconnected' }
    return this.computeStatus(entry)
  }

  private computeStatus(entry: ProjectEntry): DataConnectionStatus {
    const status: DataConnectionStatus = { dataProjectId: entry.id, state: entry.state }
    if (entry.serverVersion) status.serverVersion = entry.serverVersion
    if (entry.error) status.error = entry.error
    if (entry.connectedAt && entry.state === 'connected') status.connectedAt = entry.connectedAt
    if (entry.readOnlyUser) status.readOnlyUser = true
    if (entry.notice && entry.state === 'connected') {
      status.notice = entry.notice
      // Shown with this connection's status: later tunnels to the host need not repeat it.
      entry.tunnel?.acknowledgeNotice?.()
    }
    let inTx = false
    for (const slot of entry.slots.values()) {
      if (slot.driver?.isConnected() && slot.driver.sessionState().inTransaction) inTx = true
    }
    if (entry.state === 'connected') status.inTransaction = inTx
    const last = entry.lastSlotKey !== null ? entry.slots.get(entry.lastSlotKey) : undefined
    const current = last?.driver?.isConnected()
      ? last.driver.sessionState().currentDatabase
      : undefined
    if (current) status.currentDatabase = current
    else if (last?.database && entry.state === 'connected') status.currentDatabase = last.database
    // MySQL / MariaDB literal quoting in the renderer (structure editor) follows the session.
    const escapes = last?.driver?.isConnected()
      ? last.driver.sessionState().backslashEscapes
      : undefined
    if (entry.state === 'connected' && escapes !== undefined) status.backslashEscapes = escapes
    return status
  }

  private publish(entry: ProjectEntry): void {
    const status = this.computeStatus(entry)
    const json = JSON.stringify(status)
    if (json === entry.lastPublished) return
    entry.lastPublished = json
    try {
      this.deps.publish(DATA_STATUS_CHANNEL, status)
    } catch (error) {
      this.log.warn('Failed to publish data connection status', {
        dataProjectId: entry.id,
        error: errorMessage(error)
      })
    }
  }

  /** Re-publishes the status if the session state (transaction, database) changed. */
  refresh(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.checkSessions(entry)
    this.publish(entry)
  }

  // ---- lost transactions ---------------------------------------------------------------------------

  /**
   * The slot's session is going away (died, dropped, closed). If it was last seen inside the
   * user's transaction, the slot keeps `lostTx` so the next editor run reports the rollback.
   */
  private flagLostTransaction(slot: Slot, message: string): void {
    if (!slot.txOpen) return
    slot.txOpen = false
    slot.lostTx = message
  }

  /** Records whether the slot's live session is inside a transaction (after a session task). */
  private noteTransaction(entry: ProjectEntry, slot: Slot): void {
    const driver = slot.driver
    // A session that died during the task keeps the last known state: the next call reports it.
    if (!driver?.isConnected()) return
    slot.txOpen = driver.sessionState().inTransaction === true
    if (slot.txOpen) this.watchTransactions(entry)
  }

  private watchTransactions(entry: ProjectEntry): void {
    if (entry.txWatch) return
    entry.txWatch = setTimeout(() => {
      entry.txWatch = null
      this.checkSessions(entry)
      if ([...entry.slots.values()].some((s) => s.txOpen && s.driver)) this.watchTransactions(entry)
    }, this.txWatchMs)
    entry.txWatch.unref?.()
  }

  /**
   * A session that died while its transaction was open (it sat idle in the user's BEGIN) is
   * flagged and published at once: the status drops the transaction and, with no other session
   * left, shows the loss. Dead sessions without a transaction are left to getDriver (they
   * reconnect silently on the next call).
   */
  private checkSessions(entry: ProjectEntry): void {
    let lost = false
    for (const slot of entry.slots.values()) {
      const driver = slot.driver
      if (!driver || !slot.txOpen || driver.isConnected()) continue
      // The dead driver stays on the slot: getDriver closes and replaces it on the next call.
      this.flagLostTransaction(slot, TX_LOST_MESSAGE)
      lost = true
    }
    if (!lost) return
    this.log.warn('Data project session lost with an open transaction', { dataProjectId: entry.id })
    if (![...entry.slots.values()].some((s) => s.driver?.isConnected())) {
      entry.state = 'error'
      entry.error = TX_LOST_STATUS
      entry.connectedAt = undefined
    }
    this.publish(entry)
  }

  // ---- connecting --------------------------------------------------------------------------------

  private async resolveSecrets(id: string): Promise<DataSecrets> {
    try {
      return await this.deps.secrets.resolve(id)
    } catch (error) {
      if (isDataEngineError(error)) throw error
      throw credentialsRequiredError(
        `The stored credentials could not be read (${errorMessage(error, this.redactor(id))}). Enter them again.`
      )
    }
  }

  private mapConnectError(id: string, error: unknown, secrets: DataSecrets): Error {
    if (isDataEngineError(error)) return error as Error
    const redact = this.redactor(id)
    const message = errorMessage(error, redact)
    const code = String((error as { code?: unknown })?.code ?? '')
    if (
      AUTH_FAILURE_CODES.has(code) ||
      /authentication failed|access denied for user/i.test(message)
    ) {
      return credentialsRequiredError(
        secrets.password
          ? `${message}. Check the password.`
          : `${message}. This connection needs a password.`
      )
    }
    return connectionFailedError(message)
  }

  private async ensureTunnel(
    entry: ProjectEntry,
    record: DataProjectRecord,
    secrets: DataSecrets
  ): Promise<SshTunnel> {
    if (entry.tunnel?.isOpen()) return entry.tunnel
    if (entry.tunnelPromise) return entry.tunnelPromise
    const ssh = record.config.ssh
    if (!ssh) throw connectionFailedError('SSH tunnel is not configured.')
    const open =
      this.deps.openTunnel ??
      (async (input: OpenSshTunnelInput) => (await import('./ssh-tunnel')).openSshTunnel(input))
    const generation = entry.generation
    entry.tunnelPromise = open({
      ssh,
      secrets,
      dstHost: record.config.host || '127.0.0.1',
      dstPort: record.config.port || DATA_ENGINE_INFO[record.engine].defaultPort || 0,
      redact: this.redactor(entry.id)
    })
      .then((tunnel) => {
        if (generation !== entry.generation) {
          void tunnel.close()
          throw connectionFailedError('The connection was reset while the SSH tunnel was opening.')
        }
        entry.tunnel = tunnel
        entry.notice = tunnel.notice ?? undefined
        if (tunnel.notice)
          this.log.warn('SSH host key accepted on first use', { dataProjectId: entry.id })
        tunnel.onClose((reason) => {
          if (entry.tunnel !== tunnel) return
          entry.tunnel = null
          void this.dropAllDrivers(entry, reason ?? 'SSH tunnel closed')
        })
        return tunnel
      })
      .finally(() => {
        entry.tunnelPromise = null
      })
    return entry.tunnelPromise
  }

  private async openDriver(entry: ProjectEntry, slot: Slot): Promise<DataDriver> {
    const generation = entry.generation
    const record = this.deps.getRecord(entry.id)
    const anyConnected = [...entry.slots.values()].some((s) => s.driver?.isConnected())
    if (!anyConnected) {
      entry.state = 'connecting'
      entry.error = undefined
      this.publish(entry)
    }
    let secrets: DataSecrets = {}
    let driver: DataDriver | null = null
    try {
      secrets = await this.resolveSecrets(entry.id)
      entry.knownSecrets = secretValues(secrets as Record<string, unknown>)
      let project = record
      let tunnelInfo: DriverConnectInput['tunnel']
      if (record.config.ssh?.enabled && SSH_ENGINES.has(record.engine)) {
        const tunnel = await this.ensureTunnel(entry, record, secrets)
        project = {
          ...record,
          config: { ...record.config, host: tunnel.localHost, port: tunnel.localPort }
        }
        tunnelInfo = {
          remoteHost: record.config.host || '127.0.0.1',
          remotePort: record.config.port || DATA_ENGINE_INFO[record.engine].defaultPort || 0
        }
      }
      const input: DriverConnectInput = { project, secrets, redact: this.redactor(entry.id) }
      if (record.engine === 'postgres') input.database = slot.key
      if (tunnelInfo) input.tunnel = tunnelInfo
      driver = await this.deps.createDriver(input)
      const info = await withTimeout(
        driver.connect(),
        CONNECT_TIMEOUT_MS,
        'Timed out while connecting to the server.'
      )
      if (generation !== entry.generation) {
        await driver.close().catch(() => undefined)
        throw connectionFailedError('The connection was closed while it was opening.')
      }
      slot.driver = driver
      slot.txOpen = false
      entry.state = 'connected'
      entry.error = undefined
      entry.serverVersion = info.serverVersion
      entry.readOnlyUser = info.readOnlyUser ?? entry.readOnlyUser
      entry.connectedAt ??= new Date().toISOString()
      entry.lastSlotKey ??= slot.key
      this.log.info('Data project connected', {
        dataProjectId: entry.id,
        engine: record.engine,
        viaSsh: !!tunnelInfo
      })
      this.publish(entry)
      return driver
    } catch (error) {
      if (driver) await driver.close().catch(() => undefined)
      const mapped = this.mapConnectError(entry.id, error, secrets)
      const stillConnected = [...entry.slots.values()].some(
        (s) => s !== slot && s.driver?.isConnected()
      )
      if (generation === entry.generation && !stillConnected) {
        entry.state = 'error'
        entry.error = mapped.message
        entry.connectedAt = undefined
        if (!entry.slots.size || [...entry.slots.values()].every((s) => !s.driver))
          await this.closeTunnel(entry)
        this.publish(entry)
      }
      this.log.warn('Data project connection failed', {
        dataProjectId: entry.id,
        engine: record.engine,
        code: (mapped as { code?: string }).code ?? null
      })
      throw mapped
    }
  }

  /** The connected driver of a slot (connecting it if needed). */
  async getDriver(id: string, database?: string): Promise<DataDriver> {
    const record = this.deps.getRecord(id)
    const entry = this.entry(id)
    const key = this.slotKey(record, database)
    const slot = this.slot(entry, key, record.engine === 'postgres' ? key : database)
    this.touch(entry)
    if (slot.driver?.isConnected()) return slot.driver
    if (slot.driver) {
      // The session died (server restart, network): drop it and open a fresh one. An open
      // transaction it took with it stays flagged on the slot for the next editor run.
      const dead = slot.driver
      slot.driver = null
      this.flagLostTransaction(slot, TX_LOST_MESSAGE)
      void dead.close().catch(() => undefined)
    }
    slot.connecting ??= this.openDriver(entry, slot).finally(() => {
      slot.connecting = null
    })
    return slot.connecting
  }

  /** Opens the default connection; resolves with the status (throws coded errors). */
  async connect(id: string): Promise<DataConnectionStatus> {
    await this.getDriver(id)
    const entry = this.entry(id)
    this.armIdle(entry)
    return this.computeStatus(entry)
  }

  /**
   * Drops a slot's driver after a fatal error so the next call reconnects. An open transaction
   * of that session is flagged for the next editor run unless `reported` (the caller already
   * told the user, as the query runner does).
   */
  async dropDriver(
    id: string,
    database: string | undefined,
    driver: DataDriver,
    options: { reported?: boolean } = {}
  ): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    const record = this.deps.getRecord(id)
    const slot = entry.slots.get(this.slotKey(record, database))
    if (slot?.driver === driver) {
      slot.driver = null
      if (options.reported) slot.txOpen = false
      else this.flagLostTransaction(slot, TX_LOST_MESSAGE)
    }
    await driver.close().catch(() => undefined)
    if (![...entry.slots.values()].some((s) => s.driver?.isConnected())) {
      entry.state = 'disconnected'
      entry.connectedAt = undefined
    }
    this.publish(entry)
  }

  /**
   * Runs `fn` with the slot's driver outside the session queue (introspection, process list,
   * kill: drivers use their control connection for those). Idempotent calls are retried once
   * on a fresh connection when the connection was lost.
   */
  async withDriver<T>(
    id: string,
    database: string | undefined,
    fn: (driver: DataDriver) => Promise<T>,
    options: { idempotent?: boolean } = {}
  ): Promise<T> {
    const entry = this.entry(id)
    entry.activity++
    try {
      const driver = await this.getDriver(id, database)
      try {
        return await fn(driver)
      } catch (error) {
        if (!isConnectionLostError(error, driver)) throw error
        // Only a side connection failed (control, export stream) while the session is alive
        // inside the user's transaction: dropping the driver would roll that back. The driver
        // reopens its side connections on the next call.
        const keep = driver.isConnected() && driver.sessionState().inTransaction === true
        if (!keep) await this.dropDriver(id, database, driver)
        if (!options.idempotent) throw error
        return await fn(keep ? driver : await this.getDriver(id, database))
      }
    } finally {
      entry.activity--
      this.touch(entry)
    }
  }

  /**
   * Runs `fn` on the slot's serial queue (one session statement at a time). `signal` drops the
   * task while it is still waiting in the queue (QueueAbortedError). `fn` receives a getter for
   * the current driver and a `reconnect()` that replaces a dead session (the caller reports what
   * that session took with it, open transaction included).
   *
   * `reportLostTransaction` (the editor's runs): when the slot's previous session died with the
   * user's transaction open, nothing runs and TransactionLostError is thrown once; the next run
   * opens a fresh session. Other callers reconnect and leave that report for the editor.
   */
  async runSerial<T>(
    id: string,
    database: string | undefined,
    fn: (session: { driver: DataDriver; reconnect(): Promise<DataDriver> }) => Promise<T>,
    signal?: AbortSignal,
    options: { reportLostTransaction?: boolean } = {}
  ): Promise<T> {
    const record = this.deps.getRecord(id)
    const entry = this.entry(id)
    const key = this.slotKey(record, database)
    const slot = this.slot(entry, key, record.engine === 'postgres' ? key : database)
    entry.activity++
    try {
      return await slot.queue.run(async () => {
        // The status' currentDatabase follows the session the user last ran something on
        // (introspecting another PG database in the tree must not move it).
        entry.lastSlotKey = key
        if (options.reportLostTransaction) {
          if (slot.driver && !slot.driver.isConnected())
            this.flagLostTransaction(slot, TX_LOST_MESSAGE)
          const lost = slot.lostTx
          if (lost) {
            slot.lostTx = null
            this.publish(entry)
            throw new TransactionLostError(lost)
          }
        }
        const session = {
          driver: await this.getDriver(id, database),
          reconnect: async (): Promise<DataDriver> => {
            await this.dropDriver(id, database, session.driver, { reported: true })
            session.driver = await this.getDriver(id, database)
            return session.driver
          }
        }
        try {
          return await fn(session)
        } finally {
          this.noteTransaction(entry, slot)
          this.publish(entry)
        }
      }, signal)
    } finally {
      entry.activity--
      this.touch(entry)
    }
  }

  /**
   * The live session state of a slot, connecting it if needed. Read outside the session queue:
   * a statement queued ahead may still change it, so callers re-check inside runSerial.
   */
  async sessionState(
    id: string,
    database?: string
  ): Promise<ReturnType<DataDriver['sessionState']>> {
    return this.withDriver(id, database, async (driver) => driver.sessionState(), {
      idempotent: true
    })
  }

  /**
   * MySQL/MariaDB: whether the session reads backslash escapes in '…' literals (false under
   * NO_BACKSLASH_ESCAPES; undefined when the driver does not say). Undefined, without
   * connecting, for every other engine.
   */
  async backslashEscapes(id: string, database?: string): Promise<boolean | undefined> {
    const engine = this.deps.getRecord(id).engine
    if (engine !== 'mysql' && engine !== 'mariadb') return undefined
    return (await this.sessionState(id, database)).backslashEscapes
  }

  // ---- idle / close ------------------------------------------------------------------------------

  private touch(entry: ProjectEntry): void {
    if (entry.activity === 0) this.armIdle(entry)
    else if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }

  private armIdle(entry: ProjectEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null
      void this.idleClose(entry)
    }, this.idleMs)
    // Never keep the server process alive just for an idle timer.
    entry.idleTimer.unref?.()
  }

  private async idleClose(entry: ProjectEntry): Promise<void> {
    if (entry.activity > 0) return
    const inTx = [...entry.slots.values()].some(
      (s) => s.driver?.isConnected() && s.driver.sessionState().inTransaction
    )
    if (inTx) {
      // Closing would roll back the user's open transaction: keep it, check again later.
      this.armIdle(entry)
      return
    }
    if (![...entry.slots.values()].some((s) => s.driver)) return
    this.log.info('Closing idle data project connection', { dataProjectId: entry.id })
    await this.closeEntry(entry, 'disconnected')
  }

  private async closeTunnel(entry: ProjectEntry): Promise<void> {
    const tunnel = entry.tunnel
    entry.tunnel = null
    if (tunnel) await tunnel.close().catch(() => undefined)
  }

  private async dropAllDrivers(entry: ProjectEntry, reason: string): Promise<void> {
    const drivers = [...entry.slots.values()]
      .map((s) => s.driver)
      .filter((d): d is DataDriver => !!d)
    for (const slot of entry.slots.values()) {
      if (slot.driver) this.flagLostTransaction(slot, TX_LOST_MESSAGE)
      slot.driver = null
    }
    await Promise.all(drivers.map((d) => d.close().catch(() => undefined)))
    if (drivers.length > 0) {
      entry.state = 'error'
      entry.error = reason
      entry.connectedAt = undefined
      this.publish(entry)
    }
  }

  private async closeEntry(entry: ProjectEntry, state: 'disconnected'): Promise<void> {
    entry.generation++
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    if (entry.txWatch) {
      clearTimeout(entry.txWatch)
      entry.txWatch = null
    }
    const drivers = [...entry.slots.values()]
      .map((s) => s.driver)
      .filter((d): d is DataDriver => !!d)
    for (const slot of entry.slots.values()) {
      // Disconnecting during a transaction rolls it back: the next editor run says so.
      if (slot.driver)
        this.flagLostTransaction(
          slot,
          slot.driver.isConnected() ? TX_CLOSED_MESSAGE : TX_LOST_MESSAGE
        )
      slot.driver = null
    }
    await Promise.all(drivers.map((d) => d.close().catch(() => undefined)))
    await this.closeTunnel(entry)
    entry.state = state
    entry.error = undefined
    entry.connectedAt = undefined
    entry.notice = undefined
    this.publish(entry)
  }

  async disconnect(id: string): Promise<DataConnectionStatus> {
    const entry = this.entries.get(id)
    if (!entry) return { dataProjectId: id, state: 'disconnected' }
    await this.closeEntry(entry, 'disconnected')
    return this.computeStatus(entry)
  }

  /** Config/secrets changed or the project was deleted: close and forget everything. */
  async invalidate(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    await this.closeEntry(entry, 'disconnected')
    entry.serverVersion = undefined
    entry.readOnlyUser = undefined
    entry.knownSecrets = []
    entry.slots.clear()
    this.entries.delete(id)
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((entry) => this.closeEntry(entry, 'disconnected'))
    )
    this.entries.clear()
  }

  /** True when a project has any driver object (connected or not). For tests/diagnostics. */
  hasOpenDrivers(id: string): boolean {
    const entry = this.entries.get(id)
    return !!entry && [...entry.slots.values()].some((s) => !!s.driver)
  }
}

/** Error raised for a project id the repository does not know. */
export const isNotFoundError = (error: unknown): boolean =>
  isDataEngineError(error) && (error as { code?: string }).code === DATA_ERROR_CODES.notFound
