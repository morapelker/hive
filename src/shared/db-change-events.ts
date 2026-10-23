// Entity change events: published on the server event bus after every DB write so that
// every connected client (the desktop renderer, the mobile app, the website relay) can
// refresh what changed instead of relying on its own optimistic state alone.
// See hive-react-native/docs/CONTRACT.md §2.
export const DB_CHANGED_CHANNEL = 'db:changed'

export type DbChangedEntity =
  | 'ticket'
  | 'project'
  | 'worktree'
  | 'session'
  | 'connection'
  | 'setting'
  | 'space'
  | 'favoriteTicket'
  | 'dependency'
  /** The machine-wide saved ticket-label catalog (ticket_labels); projectId is always null. */
  | 'ticketLabel'
  /** A data project (database connection) row, its saved queries, or the merged sidebar order. */
  | 'dataProject'

export type DbChangedOp =
  'create' | 'update' | 'delete' | 'move' | 'reorder' | 'archive' | 'unarchive' | 'batch'

export interface DbChangedEvent {
  readonly entity: DbChangedEntity
  readonly op: DbChangedOp
  /** Row id; null for batch operations or reorders that touch many rows. */
  readonly id: string | null
  /** Project scope for ticket/worktree/session/dependency events (and the project itself). */
  readonly projectId: string | null
  /** Worktree scope for session events. */
  readonly worktreeId?: string | null
  /** Setting key for `entity: 'setting'` (e.g. `app_settings`). */
  readonly key?: string
  /** The `clientId` of the WebSocket connection whose RPC caused the write; `'desktop-main'` for Electron-main writes; null when unknown. */
  readonly originClientId: string | null
  /** ISO timestamp of the write. */
  readonly at: string
}

const ENTITIES: ReadonlySet<string> = new Set<DbChangedEntity>([
  'ticket',
  'project',
  'worktree',
  'session',
  'connection',
  'setting',
  'space',
  'favoriteTicket',
  'dependency',
  'ticketLabel',
  'dataProject'
])

const OPS: ReadonlySet<string> = new Set<DbChangedOp>([
  'create',
  'update',
  'delete',
  'move',
  'reorder',
  'archive',
  'unarchive',
  'batch'
])

export const isDbChangedEvent = (value: unknown): value is DbChangedEvent => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.entity === 'string' &&
    ENTITIES.has(v.entity) &&
    typeof v.op === 'string' &&
    OPS.has(v.op) &&
    (v.id === null || typeof v.id === 'string') &&
    (v.projectId === null || typeof v.projectId === 'string') &&
    (v.originClientId === null || typeof v.originClientId === 'string') &&
    typeof v.at === 'string'
  )
}
