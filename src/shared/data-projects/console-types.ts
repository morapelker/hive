// The console log of a data project (TablePlus' Console): every statement the app sends to the
// project's server on the user's behalf — editor queries, table pages and their counts, grid
// edits (with their BEGIN / COMMIT), export reads, structure DDL, process kills, and, flagged as
// `metadata`, the catalog / introspection / session statements the drivers run around them.
//
// The server keeps the log in memory only (a ring buffer per project, statements and metadata
// apart so a busy explorer cannot push the user's own statements out), masks secrets in every
// text exactly like query history (IDENTIFIED BY / PASSWORD / conninfo / mongosh pwd → '***')
// and caps the text. The renderer reads it with `dataProjects.console.list` and follows it on
// DATA_CONSOLE_CHANNEL. Desktop-only like every `dataProjects.*` method and channel: the
// remote-access policy lists neither, so paired phones and peer Macs can never read it.

/** Push channel of new entries / clears (desktop sockets only: not in the remote allowlist). */
export const DATA_CONSOLE_CHANNEL = 'dataProjects:console'

/** Entries the server keeps per project, for statements and again for metadata queries. */
export const DATA_CONSOLE_MAX_ENTRIES = 1000

/** Characters of text kept per entry (longer statements are cut and flagged `truncated`). */
export const DATA_CONSOLE_MAX_TEXT = 10_000

export const DATA_CONSOLE_SOURCES = [
  'query',
  'table',
  'edit',
  'structure',
  'export',
  'import',
  'mongo',
  'admin',
  'assistant',
  'metadata',
  'other'
] as const

/**
 * What sent the statement: the editor / Shell ('query'), the table browser's pages and counts
 * ('table'), staged grid edits ('edit'), schema actions ('structure'), full exports ('export'),
 * file imports ('import'), the Mongo document / aggregation / index views ('mongo'), process
 * kills and cancels ('admin'), the AI assistant's tool reads ('assistant'), catalog and session
 * housekeeping ('metadata'), anything else the app runs ('other').
 */
export type DataConsoleSource = (typeof DATA_CONSOLE_SOURCES)[number]

export type DataConsoleStatus = 'ok' | 'error' | 'cancelled'

export interface DataConsoleEntry {
  /** Increases by one per entry in the server process (list cursor, ordering, React key). */
  seq: number
  /**
   * Literals in the text were masked ('***') like history: it is not the statement that ran, and
   * the console never opens it in an editor.
   */
  masked?: boolean
  dataProjectId: string
  /** ISO time the statement was sent. */
  at: string
  source: DataConsoleSource
  /** 'sql' text, or 'mongo' (a `db.runCommand({...})` / mongosh line). */
  language: 'sql' | 'mongo'
  database: string | null
  /** Masked like history; at most DATA_CONSOLE_MAX_TEXT characters. */
  text: string
  /** The text was cut: it cannot be opened and run as it is. */
  truncated?: boolean
  /**
   * Not a statement but a one-line description of an introspection call whose own statements
   * the driver does not report (e.g. `-- describe shop.users`). Never opened in an editor.
   */
  summary?: boolean
  status: DataConsoleStatus
  durationMs: number | null
  /** Rows / documents returned. */
  rows: number | null
  /** Rows / documents written. */
  affected: number | null
  /** Masked, secret-redacted error text. */
  error: string | null
}

export interface DataConsoleListRequest {
  id: string
  /** Only entries with a greater `seq`. */
  since?: number
}

export interface DataConsoleListResponse {
  /** Oldest first. */
  entries: DataConsoleEntry[]
  /**
   * Random id of the server process' log: `seq` restarts with a new server, so a renderer that
   * sees another epoch drops what it has and lists again.
   */
  epoch: string
}

export type DataConsoleEvent =
  | { dataProjectId: string; epoch: string; kind: 'entries'; entries: DataConsoleEntry[] }
  | { dataProjectId: string; epoch: string; kind: 'cleared' }

export function isDataConsoleEvent(value: unknown): value is DataConsoleEvent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.dataProjectId !== 'string' || typeof v.epoch !== 'string') return false
  if (v.kind === 'cleared') return true
  return v.kind === 'entries' && Array.isArray(v.entries)
}
