// The `db:changed` seam of the database layer. Tedooo Code publishes every row write on this
// lane so the other app instances sharing its SQLite file (and paired phones) can reload what
// changed. Hive runs one instance per database and has no such listener, so the lane is a
// no-op here: the call sites in database.ts and the RPC domains stay as they are, so later ports
// from tedooo-code keep applying, and nothing is published.
import type { DbChangedEvent } from '@shared/db-change-events'

export type DbChangedEventInput = Omit<DbChangedEvent, 'at' | 'originClientId'> & {
  readonly at?: string
}

/** Records nothing: Hive has no second instance to tell. */
export const emitDbChanged = (_event: DbChangedEventInput): void => {}

/** Runs `fn` as is; there is no event batching to collapse. */
export const withDbChangeBatch = <T>(fn: () => T): T => fn()

export type DbChangeEventPublisher = (channel: string, payload: unknown) => Promise<void>

/** Accepted and ignored: nothing is published. */
export const setDbChangeEventPublisher = (_publisher: DbChangeEventPublisher | null): void => {}

/** Nothing is ever pending. */
export const flushPendingDbChangedEvents = (): void => {}

export const isDbChangeBatchActive = (): boolean => false
