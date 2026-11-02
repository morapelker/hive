// The `db:changed` lane of the database layer: every row write is coalesced and handed to the
// publisher set here. Tedooo Code publishes these events to its other app instances (one
// SQLite file shared by several processes), its paired phones and the relay. Hive runs one
// instance per database and nothing subscribes, so no publisher is ever installed at runtime
// and the events are dropped at `publish`; the lane is kept whole so the call sites ported from
// tedooo-code (database.ts, the RPC domains) and their tests stay as they are.
import { DB_CHANGED_CHANNEL, type DbChangedEvent } from '../../shared/db-change-events'
import { getRpcRequestContext } from '../../server/rpc/request-context'

export type DbChangeEventPublisher = (channel: string, payload: unknown) => Promise<void>

/** Input accepted by `emitDbChanged`: `at` is stamped here, `originClientId` is resolved when omitted. */
export type DbChangedEventInput = Omit<DbChangedEvent, 'at' | 'originClientId'> & {
  readonly originClientId?: string | null
}

let dbChangeEventPublisher: DbChangeEventPublisher | null = null
const pendingEvents = new Map<string, DbChangedEvent>()
let flushHandle: ReturnType<typeof setImmediate> | null = null

export const setDbChangeEventPublisher = (publisher: DbChangeEventPublisher | null): void => {
  dbChangeEventPublisher = publisher
}

/**
 * `originClientId` precedence: explicit value on the event, then the clientId of the
 * WebSocket connection whose RPC is running (AsyncLocalStorage), then a process default —
 * inside the server child (spawned with an IPC channel, so `process.send` exists) an
 * unknown origin is `null`; in Electron main it is `'desktop-main'`.
 */
const resolveOriginClientId = (explicit: string | null | undefined): string | null => {
  if (explicit !== undefined && explicit !== null) return explicit
  const fromContext = getRpcRequestContext()?.clientId
  if (fromContext !== undefined && fromContext !== null) return fromContext
  return typeof process.send === 'function' ? null : 'desktop-main'
}

const coalesceKey = (event: DbChangedEvent): string =>
  [
    event.entity,
    event.op,
    event.id ?? '',
    event.projectId ?? '',
    event.key ?? '',
    event.worktreeId ?? '',
    event.originClientId ?? ''
  ].join('|')

/** Without a publisher (always, in the app) the event is dropped: there is no one to tell. */
const publish = (event: DbChangedEvent): void => {
  if (!dbChangeEventPublisher) return
  try {
    void Promise.resolve(dbChangeEventPublisher(DB_CHANGED_CHANNEL, event)).catch(() => undefined)
  } catch {
    // A publisher that throws must never break the write that produced the event.
  }
}

/** Publishes every coalesced event now. Exposed for tests; production relies on setImmediate. */
export const flushPendingDbChangedEvents = (): void => {
  if (flushHandle) {
    clearImmediate(flushHandle)
    flushHandle = null
  }
  if (pendingEvents.size === 0) return
  const events = [...pendingEvents.values()]
  pendingEvents.clear()
  for (const event of events) publish(event)
}

const scheduleFlush = (): void => {
  if (flushHandle) return
  flushHandle = setImmediate(() => {
    flushHandle = null
    flushPendingDbChangedEvents()
  })
}

export const emitDbChanged = (event: DbChangedEventInput): void => {
  try {
    if (isDbChangeBatchActive()) return
    const stamped: DbChangedEvent = {
      entity: event.entity,
      op: event.op,
      id: event.id ?? null,
      projectId: event.projectId ?? null,
      ...(event.worktreeId !== undefined ? { worktreeId: event.worktreeId } : {}),
      ...(event.key !== undefined ? { key: event.key } : {}),
      originClientId: resolveOriginClientId(event.originClientId),
      at: new Date().toISOString()
    }
    pendingEvents.set(coalesceKey(stamped), stamped)
    scheduleFlush()
  } catch {
    // Never let event bookkeeping break the database write that produced it.
  }
}

let dbChangeBatchDepth = 0

/** True while inside `withDbChangeBatch`: `emitDbChanged` drops events instead of queueing them. */
export const isDbChangeBatchActive = (): boolean => dbChangeBatchDepth > 0

export const withDbChangeBatch = <T>(fn: () => T): T => {
  dbChangeBatchDepth += 1
  try {
    return fn()
  } finally {
    dbChangeBatchDepth -= 1
  }
}
