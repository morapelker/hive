// ClickHouse DataDriver over the HTTP(S) interface (@clickhouse/client).
//
// Two clients per open project (drivers.md §5):
//   session  carries a `session_id`, so USE, SET and temporary tables persist like on a real
//            connection. ClickHouse locks a session while a query runs (a concurrent request
//            fails with SESSION_IS_LOCKED), so every session request goes through one queue,
//            and a lock left behind by a just-cancelled query is waited out with a short retry.
//            Sessions are created with session_timeout=3600 and later checked with
//            session_check=1: when the server dropped an idle session the driver recreates it
//            and says that temp tables / SETs are gone instead of failing in confusing ways.
//   control  sessionless: KILL QUERY, system.* introspection, autocomplete, process list. It
//            works while the session is busy.
//   export   a throwaway client per streamRows call with a long idle timeout (an aggregation
//            can be silent for minutes before its first block).
//
// The current database is not sent as the `database` URL param (that would override USE on
// every request); each request names it with the X-ClickHouse-Database header instead, which
// does not touch the session's own database. `options.database` sets it for the statement; USE
// updates it from `currentDatabase()`.
//
// Statements: one per HTTP request. Row-returning statements run with our own
// `FORMAT JSONCompactEachRowWithNamesAndTypes` (names + types arrive even for 0 rows) through
// exec(), and the rows are parsed from the raw bytes so String values that are not UTF-8 come
// back as binary cells; a user FORMAT clause (or a statement that refuses our FORMAT) shows the
// raw text as a one-column result; everything else is command(). Exactness: 64-bit ints and
// decimals are quoted by the server, nested values become JSON text (cells.ts).
//
// Limits: `max_result_rows = N+1` + `result_overflow_mode = 'break'` stops the server early
// (block granularity, so rows are trimmed here too), `wait_end_of_query=1` makes the
// X-ClickHouse-Summary header (rows/bytes read) final and turns mid-stream exceptions into proper
// errors. A LIMIT the user wrote wins over the auto-limit (LIMIT n BY does not count).
//
// Sandbox: per-query `readonly=2` (reads + settings; writes, DDL and readonly changes fail with
// code 164 → sandboxRejected). A user whose profile is already readonly=1 may not change any
// setting, so for them nothing is sent and values come as strings (JSONCompactStrings*).

import { isUtf8 } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import type {
  ClickHouseClient,
  ClickHouseClientConfigOptions,
  ClickHouseSettings,
  ResponseHeaders
} from '@clickhouse/client'
import {
  DATA_HARD_ROW_CAP,
  type DataCell,
  type DataColumnInfo,
  type DataColumnMeta,
  type DataCompletionSchema,
  type DataCompletionTable,
  type DataConnectionConfig,
  type DataDatabaseInfo,
  type DataIndexInfo,
  type DataKillScope,
  type DataObjectInfo,
  type DataObjectKind,
  type DataObjectRef,
  type DataObjectsListing,
  type DataProcessInfo,
  type DataStatementOutput,
  type DataTableDetails
} from '../../../../shared/data-projects/types'
import { lexSql, quoteSqlIdentifier, type SqlToken } from '../../../../shared/sql'
import {
  DataDriverError,
  type DataDriver,
  type DriverConnectInput,
  type DriverExecuteOptions,
  type DriverStatementResult
} from '../contracts'
import { binaryCell, cellSize, toCell } from '../cells'
import { errorMessage } from '../redact'
import { expandHomePath } from '../ssh-tunnel'

type ClickHouseModule = typeof import('@clickhouse/client')

let clickhousePromise: Promise<ClickHouseModule> | null = null
const loadClickHouse = (): Promise<ClickHouseModule> => {
  clickhousePromise ??= import('@clickhouse/client').then((mod) => {
    const m = mod as ClickHouseModule & { default?: ClickHouseModule }
    return (typeof m.createClient === 'function' ? m : m.default) as ClickHouseModule
  })
  return clickhousePromise
}

/** Idle-socket timeout of session/export requests: a query may be silent until it finishes. */
const LONG_REQUEST_TIMEOUT_MS = 6 * 60 * 60 * 1000
const CONTROL_REQUEST_TIMEOUT_MS = 120_000
const SESSION_TIMEOUT_S = 3600
/** How long to wait out SESSION_IS_LOCKED left behind by a cancelled query. */
const SESSION_LOCK_RETRY_MS = 5_000
/** Kept cell text per result before it is cut (keeps WS frames sane). */
const MAX_RESULT_CHARS = 64 * 1024 * 1024
/** Raw (user FORMAT) output kept for display. */
const MAX_RAW_BYTES = 16 * 1024 * 1024
const STREAM_BATCH_ROWS = 1_000
const COMPLETION_TABLE_CAP = 5_000
const COMPLETION_COLUMN_CAP = 200_000
const COMPLETION_FUNCTION_CAP = 4_000
const QUERY_PREVIEW_CHARS = 4_000

const CH = {
  UNKNOWN_IDENTIFIER: '47',
  SYNTAX_ERROR: '62',
  UNKNOWN_DATABASE: '81',
  TIMEOUT_EXCEEDED: '159',
  READONLY: '164',
  MEMORY_LIMIT_EXCEEDED: '241',
  SESSION_NOT_FOUND: '372',
  SESSION_IS_LOCKED: '373',
  INVALID_SESSION_TIMEOUT: '374',
  QUERY_WAS_CANCELLED: '394',
  AUTHENTICATION_FAILED: '516'
} as const

const SYSTEM_DATABASES = new Set(['system', 'INFORMATION_SCHEMA', 'information_schema'])

/** Formats whose output is bytes, not text: shown as one binary cell. */
const BINARY_FORMATS =
  /^(Parquet|Arrow|ArrowStream|ORC|Native|RowBinary\w*|Avro|AvroConfluent|CapnProto|Protobuf\w*|MsgPack|BSONEachRow|Npy)$/i

// ---------------------------------------------------------------------------------------------
// Statement analysis (shared lexer; only the statement head and depth-0 clauses matter)
// ---------------------------------------------------------------------------------------------

export interface ClickHouseStatementInfo {
  /** First keyword, upper-cased (SELECT for a statement that starts with '('). */
  leading: string | null
  /** Goes through query() with a JSON format. */
  returnsRows: boolean
  /** FORMAT the user wrote at the end of the statement, e.g. 'CSV'. */
  format: string | null
  /** A top-level LIMIT caps the whole result (LIMIT n BY and UNION branches do not). */
  hasLimit: boolean
  /** ALTER … UPDATE / DELETE: an asynchronous mutation. */
  isMutation: boolean
}

const ROW_LEADERS = new Set([
  'SELECT',
  'WITH',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'EXPLAIN',
  'EXISTS',
  'CHECK',
  'KILL',
  'BACKUP',
  'RESTORE'
])

const CLAUSE_STOPS = new Set([
  'LIMIT',
  'SETTINGS',
  'FORMAT',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'INTO'
])

const isSignificant = (t: SqlToken): boolean => t.type !== 'whitespace' && t.type !== 'comment'

const wordOf = (t: SqlToken | undefined): string | null =>
  t && (t.type === 'keyword' || t.type === 'identifier') ? (t.upper ?? t.text.toUpperCase()) : null

export function analyzeClickHouseStatement(text: string): ClickHouseStatementInfo {
  let tokens: SqlToken[]
  try {
    tokens = lexSql(text, 'clickhouse').tokens.filter(isSignificant)
  } catch {
    tokens = []
  }
  if (tokens.length === 0) {
    // No lexer result: fall back to the first word so the statement still runs somewhere.
    const first = /^\s*\(*\s*([A-Za-z_]+)/.exec(text)?.[1]?.toUpperCase() ?? null
    return {
      leading: first,
      returnsRows: first !== null && ROW_LEADERS.has(first),
      format: null,
      hasLimit: false,
      isMutation: false
    }
  }

  let leading: string | null = null
  for (const t of tokens) {
    if (t.text === '(') {
      leading = 'SELECT'
      continue
    }
    leading = wordOf(t) ?? leading
    break
  }

  // Depth per token (parentheses and array brackets).
  const depth: number[] = new Array(tokens.length)
  let d = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].text
    if (t === ')' || t === ']') d = Math.max(0, d - 1)
    depth[i] = d
    if (t === '(' || t === '[') d++
  }

  let format: string | null = null
  let hasLimit = false
  let hasSetOp = false
  let mutationWord = false
  for (let i = 0; i < tokens.length; i++) {
    if (depth[i] !== 0) continue
    const w = wordOf(tokens[i])
    if (!w) continue
    const prev = tokens[i - 1]
    if (prev && prev.text === '.') continue // a column/table named like a keyword
    if (w === 'UNION' || w === 'INTERSECT' || w === 'EXCEPT') hasSetOp = true
    if ((w === 'UPDATE' || w === 'DELETE') && leading === 'ALTER') mutationWord = true
    if (w === 'FORMAT') {
      // `FORMAT <name>` closes the statement (only SETTINGS may follow); `format(...)` is a
      // function and `AS format` an alias.
      const name = tokens[i + 1]
      const after = wordOf(tokens[i + 2])
      if (
        name &&
        (name.type === 'identifier' || name.type === 'keyword') &&
        (tokens.length === i + 2 || after === 'SETTINGS')
      ) {
        format = name.text
      }
    }
    if (w === 'LIMIT') {
      // LIMIT n [OFFSET m | , m] BY expr is per group, not a cap on the result.
      let perGroup = false
      for (let j = i + 1; j < Math.min(tokens.length, i + 6); j++) {
        if (depth[j] !== 0) continue
        const wj = wordOf(tokens[j])
        if (wj === 'BY') {
          perGroup = true
          break
        }
        if (wj && CLAUSE_STOPS.has(wj)) break
      }
      if (!perGroup) hasLimit = true
    }
  }
  const returnsRows = leading !== null && ROW_LEADERS.has(leading)
  return {
    leading,
    returnsRows,
    format: returnsRows ? format : null,
    // In ClickHouse a trailing LIMIT binds to the last SELECT of a UNION, not to the whole.
    hasLimit: returnsRows && hasLimit && !hasSetOp,
    isMutation: mutationWord
  }
}

/** "CREATE TABLE", "INSERT", "SYSTEM" — the tag shown for a command result. */
export function clickHouseCommandTag(text: string): string {
  let tokens: SqlToken[] = []
  try {
    tokens = lexSql(text, 'clickhouse').tokens.filter(isSignificant)
  } catch {
    tokens = []
  }
  const words: string[] = []
  for (const t of tokens) {
    const w = wordOf(t)
    if (!w || words.length >= 3) break
    words.push(w)
  }
  if (words.length === 0) return 'OK'
  if (
    ['CREATE', 'DROP', 'ALTER', 'RENAME', 'EXCHANGE', 'ATTACH', 'DETACH', 'TRUNCATE'].includes(
      words[0]
    ) &&
    words[1]
  ) {
    if (['TEMPORARY', 'OR', 'MATERIALIZED', 'LIVE', 'WINDOW'].includes(words[1]) && words[2]) {
      return `${words[0]} ${words[1]} ${words[2]}`
    }
    return `${words[0]} ${words[1]}`
  }
  return words[0]
}

/**
 * ClickHouse reports "failed at position N" as a 1-based BYTE offset into the query it got;
 * converted to a 0-based character offset when it points inside the user's statement (not into
 * the FORMAT clause the client appended).
 */
export function clickHouseErrorPosition(message: string, statement: string): number | undefined {
  const m = /failed at position (\d+)/i.exec(message)
  if (!m) return undefined
  const byteOffset = Number(m[1]) - 1
  const bytes = Buffer.from(statement, 'utf8')
  if (!Number.isFinite(byteOffset) || byteOffset < 0 || byteOffset > bytes.length) return undefined
  return bytes.subarray(0, byteOffset).toString('utf8').length
}

/** True when a syntax error points past the statement, i.e. at the FORMAT the client appended. */
const failsAtAppendedFormat = (
  code: string | undefined,
  message: string,
  statement: string
): boolean => {
  if (code !== CH.SYNTAX_ERROR) return false
  const m = /failed at position (\d+)/i.exec(message)
  return !!m && Number(m[1]) - 1 >= Buffer.byteLength(statement.trim(), 'utf8')
}

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  if (typeof code === 'number') return String(code)
  return undefined
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))

const HINTS: Record<string, string> = {
  [CH.AUTHENTICATION_FAILED]: 'Check the user name and password.',
  [CH.UNKNOWN_DATABASE]: 'The database does not exist or this user cannot see it.',
  [CH.TIMEOUT_EXCEEDED]:
    'The query ran past max_execution_time. Raise the query timeout or narrow the query.',
  [CH.MEMORY_LIMIT_EXCEEDED]: 'The query needs more memory than max_memory_usage allows.',
  ECONNREFUSED:
    'Is ClickHouse running, and is this the HTTP interface port (8123, or 8443 for HTTPS)?',
  ENOTFOUND: 'The host name could not be resolved.',
  ECONNRESET: 'The server closed the connection. If it speaks HTTPS, switch the protocol to HTTPS.',
  EPROTO: 'TLS handshake failed: the server may not speak HTTPS on this port.',
  DEPTH_ZERO_SELF_SIGNED_CERT:
    'The server uses a self-signed certificate: provide its CA file or set SSL mode to "require".',
  SELF_SIGNED_CERT_IN_CHAIN:
    'Provide the CA certificate file, or set SSL mode to "require" to skip verification.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    'Provide the CA certificate file, or set SSL mode to "require" to skip verification.',
  ERR_TLS_CERT_ALTNAME_INVALID:
    'The certificate does not match the host name. Use SSL mode "verify-ca" to skip the name check.'
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value))

function parseSummary(
  headers: ResponseHeaders | undefined
): DriverStatementResult['stats'] | undefined {
  const raw = headers?.['x-clickhouse-summary']
  const text = Array.isArray(raw) ? raw[raw.length - 1] : raw
  if (!text) return undefined
  try {
    const s = JSON.parse(text) as Record<string, string | undefined>
    const stats: NonNullable<DriverStatementResult['stats']> = {}
    const rowsRead = num(s.read_rows)
    const bytesRead = num(s.read_bytes)
    const elapsedNs = num(s.elapsed_ns)
    if (rowsRead !== null) stats.rowsRead = rowsRead
    if (bytesRead !== null) stats.bytesRead = bytesRead
    if (elapsedNs !== null) stats.elapsedMs = Math.round(elapsedNs / 1e5) / 10
    return stats
  } catch {
    return undefined
  }
}

function summaryField(headers: ResponseHeaders | undefined, field: string): number | null {
  const raw = headers?.['x-clickhouse-summary']
  const text = Array.isArray(raw) ? raw[raw.length - 1] : raw
  if (!text) return null
  try {
    return num((JSON.parse(text) as Record<string, unknown>)[field])
  } catch {
    return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------------------------
// Row decoding from raw bytes
//
// String / FixedString hold arbitrary bytes, and ClickHouse writes them into JSON as they are.
// Decoding the response as UTF-8 (what the client's row stream does) turns hashes, binary UUIDs
// etc. into U+FFFD. So rows are split and parsed from the bytes: each line is decoded as latin1
// (one char per byte) for JSON.parse, which leaves every string value holding its exact bytes;
// valid UTF-8 becomes text again, anything else a binary cell (in String/FixedString columns).
// ---------------------------------------------------------------------------------------------

/** Appends ` FORMAT <format>` the way the client's query() does. */
export function withFormatClause(statement: string, format: string): string {
  return `${statement.trim().replace(/;+$/, '')} \nFORMAT ${format}`
}

const NON_ASCII = /[\u0080-\uffff]/
const PAST_LATIN1 = /[\u0100-\uffff]/

/** The bytes of a JSON string value parsed from latin1 text. */
function latin1Bytes(text: string): Buffer {
  if (!PAST_LATIN1.test(text)) return Buffer.from(text, 'latin1')
  // Characters past U+00FF can only come from \u escapes (U+2028/U+2029): UTF-8 for those.
  const parts: Buffer[] = []
  let run = ''
  for (const ch of text) {
    if (ch.codePointAt(0)! <= 0xff) {
      run += ch
      continue
    }
    if (run) parts.push(Buffer.from(run, 'latin1'))
    run = ''
    parts.push(Buffer.from(ch, 'utf8'))
  }
  if (run) parts.push(Buffer.from(run, 'latin1'))
  return Buffer.concat(parts)
}

/** A string value parsed from latin1 text: UTF-8 text again, or its bytes when not UTF-8. */
export function restoreClickHouseString(text: string): string | Buffer {
  if (!NON_ASCII.test(text)) return text
  const bytes = latin1Bytes(text)
  return isUtf8(bytes) ? bytes.toString('utf8') : bytes
}

/** Nested values (arrays, maps, tuples, JSON) as text; invalid UTF-8 inside them stays lossy. */
function restoreNested(value: unknown): unknown {
  if (typeof value === 'string') {
    const restored = restoreClickHouseString(value)
    return typeof restored === 'string' ? restored : restored.toString('utf8')
  }
  if (Array.isArray(value)) return value.map(restoreNested)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value))
      out[String(restoreNested(key))] = restoreNested(inner)
    return out
  }
  return value
}

/** String / FixedString(N), also inside Nullable / LowCardinality. */
const isByteStringType = (type: string | undefined): boolean => {
  if (!type) return false
  let t = type.trim()
  for (;;) {
    const m = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(t)
    if (!m) break
    t = m[1].trim()
  }
  return t === 'String' || /^FixedString\(\d+\)$/.test(t)
}

/** One parsed JSON value of a column → DataCell. */
export function clickHouseCell(
  value: unknown,
  type: string | undefined,
  binaryPreviewBytes?: number
): DataCell {
  if (typeof value === 'string') {
    const restored = restoreClickHouseString(value)
    if (typeof restored === 'string') return restored
    return isByteStringType(type)
      ? binaryCell(restored, binaryPreviewBytes)
      : restored.toString('utf8')
  }
  return toCell(restoreNested(value), { binaryPreviewBytes })
}

/** An exception ClickHouse wrote into the body after rows had started (no wait_end_of_query). */
function streamException(text: string): Error {
  const m = /Code:\s*(\d+)\.\s*(DB::Exception:[^\n\r]*)/.exec(text)
  if (m) return Object.assign(new Error(`Code: ${m[1]}. ${m[2].trim()}`), { code: m[1] })
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 300)
  return new Error(`Unexpected response from ClickHouse: ${preview || '(empty line)'}`)
}

/**
 * JSONCompact*EachRow* rows parsed from a raw response stream, in batches (one per chunk).
 * A line that is not a JSON array is the server's exception text: what follows it is collected
 * (up to 64 KB) and thrown as an error with the ClickHouse code.
 */
export async function* compactRowsFromBytes(
  stream: AsyncIterable<Buffer | string> | Iterable<Buffer | string>
): AsyncGenerator<unknown[][]> {
  let pending: Buffer[] = []
  let failure: Buffer[] | null = null
  let failureBytes = 0
  const parse = (line: Buffer): unknown[] | null => {
    const text = line.toString('latin1').replace(/\r$/, '')
    if (text.startsWith('[')) {
      try {
        const row: unknown = JSON.parse(text)
        if (Array.isArray(row)) return row
      } catch {
        // Not a row: the exception text below.
      }
    }
    return null
  }
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (failure) {
      if (failureBytes < 64 * 1024) {
        failure.push(buf)
        failureBytes += buf.length
      }
      continue
    }
    const rows: unknown[][] = []
    let start = 0
    for (;;) {
      const nl = buf.indexOf(0x0a, start)
      if (nl < 0) break
      const piece = buf.subarray(start, nl)
      const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece
      pending = []
      start = nl + 1
      if (line.length === 0) continue
      const row = parse(line)
      if (!row) {
        failure = [line, Buffer.from('\n'), buf.subarray(start)]
        failureBytes = line.length + buf.length - start
        break
      }
      rows.push(row)
    }
    if (failure) {
      if (rows.length > 0) yield rows
      continue
    }
    if (start < buf.length) pending.push(buf.subarray(start))
    if (rows.length > 0) yield rows
  }
  if (!failure && pending.length > 0) {
    const line = Buffer.concat(pending)
    if (line.toString('latin1').trim() !== '') {
      const row = parse(line)
      if (row) yield [row]
      else failure = [line]
    }
  }
  if (failure) throw streamException(Buffer.concat(failure).toString('utf8'))
}

function objectKind(engine: string): DataObjectKind {
  switch (engine) {
    case 'View':
    case 'LiveView':
    case 'WindowView':
      return 'view'
    case 'MaterializedView':
      return 'materialized_view'
    case 'Dictionary':
      return 'dictionary'
    default:
      return 'table'
  }
}

/** Storage tables of materialized views without TO (`.inner.mv`, `.inner_id.<uuid>`). */
const isInnerTable = (name: string): boolean =>
  name.startsWith('.inner.') || name.startsWith('.inner_id.')

const isNullableType = (type: string): boolean =>
  /^Nullable\(/.test(type) || /^LowCardinality\(Nullable\(/.test(type)

// ---------------------------------------------------------------------------------------------
// Connection options
// ---------------------------------------------------------------------------------------------

export interface ClickHouseEndpoint {
  url: string
  tls: boolean
}

/** URL of the HTTP interface. With a tunnel, config.host/port already point at the local forward. */
export function clickHouseEndpoint(config: DataConnectionConfig): ClickHouseEndpoint {
  const mode = config.ssl?.mode
  const tlsWanted =
    config.clickhouseProtocol === 'https' ||
    (config.clickhouseProtocol !== 'http' &&
      (mode === 'require' || mode === 'verify-ca' || mode === 'verify-full'))
  const host = (config.host || '127.0.0.1').trim()
  const port = config.port ?? (tlsWanted ? 8443 : 8123)
  const hostPart = net.isIPv6(host) ? `[${host}]` : host
  const pathname = config.options?.pathname ? `/${config.options.pathname.replace(/^\/+/, '')}` : ''
  return { url: `${tlsWanted ? 'https' : 'http'}://${hostPart}:${port}${pathname}`, tls: tlsWanted }
}

async function readOptionalFile(
  path: string | undefined,
  what: string,
  redact: (t: string) => string
): Promise<Buffer | undefined> {
  if (!path) return undefined
  try {
    return await readFile(expandHomePath(path))
  } catch (error) {
    throw new DataDriverError(
      redact(`Cannot read the ${what} file ${path}: ${errorMessage(error)}`),
      {
        code: 'CERT_FILE'
      }
    )
  }
}

/**
 * TLS agent: CA/client certificate files, verification per SSL mode (require/prefer = encrypted,
 * not verified; verify-ca = chain only; otherwise full), and through an SSH tunnel the real
 * host as SNI/identity. A custom agent (instead of the client's `tls` option) keeps password
 * auth as basic auth: the client's mutual-TLS mode would switch to certificate authentication.
 */
async function tlsAgent(input: DriverConnectInput): Promise<https.Agent> {
  const config = input.project.config
  const mode = config.ssl?.mode
  const verify =
    mode === 'require' || mode === 'prefer' ? 'none' : mode === 'verify-ca' ? 'ca' : 'full'
  const [ca, cert, key] = await Promise.all([
    readOptionalFile(config.ssl?.caPath, 'CA certificate', input.redact),
    readOptionalFile(config.ssl?.certPath, 'client certificate', input.redact),
    readOptionalFile(config.ssl?.keyPath, 'client key', input.redact)
  ])
  const remote = input.tunnel?.remoteHost
  const options: https.AgentOptions = {
    keepAlive: true,
    maxSockets: 8,
    rejectUnauthorized: verify !== 'none'
  }
  if (ca) options.ca = ca
  if (cert) options.cert = cert
  if (key) options.key = key
  if (remote && net.isIP(remote) === 0) options.servername = remote
  if (verify === 'ca') options.checkServerIdentity = () => undefined
  else if (remote)
    options.checkServerIdentity = (_host, peer) => tls.checkServerIdentity(remote, peer)
  return new https.Agent(options)
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

interface RunningQuery {
  queryId: string
  controller: AbortController
  text: string
  startedAt: number
  cancelled: boolean
}

interface RowsRead {
  columns: DataColumnMeta[]
  rows: DataCell[][]
  truncated: boolean
  byteLimited: boolean
}

class ClickHouseDriver implements DataDriver {
  readonly engine = 'clickhouse' as const
  private readonly input: DriverConnectInput
  private readonly redact: (text: string) => string

  private module: ClickHouseModule | null = null
  private baseConfig: ClickHouseClientConfigOptions | null = null
  private agent: https.Agent | null = null
  private session: ClickHouseClient | null = null
  private control: ClickHouseClient | null = null
  private connected = false
  private serverVersion = ''
  private sessionId = randomUUID()
  /** First request of a session creates it; later ones ask the server to check it exists. */
  private sessionFresh = true
  private sessionTimeout: number | null = SESSION_TIMEOUT_S
  /** readonly of the user's profile: 0, 1 (no setting may change) or 2. */
  private profileReadonly = 0
  private currentDb: string | undefined
  private running: RunningQuery | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private pendingNotices: string[] = []

  constructor(input: DriverConnectInput) {
    this.input = input
    this.redact = input.redact
  }

  private get config(): DataConnectionConfig {
    return this.input.project.config
  }

  /** Settings may be sent (false for readonly=1 profiles). */
  private get settingsAllowed(): boolean {
    return this.profileReadonly !== 1
  }

  // ---- connection -----------------------------------------------------------------------------

  private async buildBaseConfig(): Promise<ClickHouseClientConfigOptions> {
    const ch = await loadClickHouse()
    this.module = ch
    const endpoint = clickHouseEndpoint(this.config)
    if (endpoint.tls) this.agent = await tlsAgent(this.input)
    return {
      url: endpoint.url,
      username: this.config.user || 'default',
      password: this.input.secrets.password ?? '',
      application: 'Hive',
      // The client's logger prints every failed query to stderr; errors are reported by us.
      log: { level: ch.ClickHouseLogLevel.OFF },
      keep_alive: { enabled: true },
      ...(this.agent ? { http_agent: this.agent } : {})
    }
  }

  private createClient(extra: ClickHouseClientConfigOptions): ClickHouseClient {
    if (!this.module || !this.baseConfig) throw new DataDriverError('ClickHouse is not connected.')
    return this.module.createClient({ ...this.baseConfig, ...extra })
  }

  private requireSession(): ClickHouseClient {
    if (!this.session || !this.connected)
      throw new DataDriverError('ClickHouse is not connected.', { code: 'NOT_CONNECTED' })
    return this.session
  }

  private requireControl(): ClickHouseClient {
    if (!this.control || !this.connected)
      throw new DataDriverError('ClickHouse is not connected.', { code: 'NOT_CONNECTED' })
    return this.control
  }

  private dbHeaders(db: string | undefined = this.currentDb): Record<string, string> | undefined {
    // Header values must be latin1; a database name outside it falls back to the session default.
    return db && /^[\x20-\x7e]*$/.test(db) ? { 'X-ClickHouse-Database': db } : undefined
  }

  async connect(): Promise<{
    serverVersion: string
    currentDatabase?: string
    readOnlyUser?: boolean
  }> {
    if (this.connected) {
      return {
        serverVersion: this.serverVersion,
        currentDatabase: this.currentDb,
        readOnlyUser: this.profileReadonly > 0
      }
    }
    try {
      this.baseConfig = await this.buildBaseConfig()
      const requestTimeout =
        this.config.queryTimeoutMs && this.config.queryTimeoutMs > 0
          ? this.config.queryTimeoutMs + 60_000
          : LONG_REQUEST_TIMEOUT_MS
      this.sessionId = randomUUID()
      this.sessionFresh = true
      this.session = this.createClient({
        session_id: this.sessionId,
        request_timeout: requestTimeout,
        max_open_connections: 2
      })
      this.control = this.createClient({
        request_timeout: CONTROL_REQUEST_TIMEOUT_MS,
        max_open_connections: 4
      })
      this.connected = true
      const db = this.input.database || this.config.database || undefined
      const probe = await this.probeSession(db)
      this.serverVersion = probe.version
      this.profileReadonly = probe.readonly
      this.currentDb = probe.database
      return {
        serverVersion: `ClickHouse ${probe.version}`,
        currentDatabase: probe.database,
        readOnlyUser: probe.readonly > 0
      }
    } catch (error) {
      await this.close().catch(() => undefined)
      throw this.toDriverError(error)
    }
  }

  /** Creates the session and learns version, profile readonly and the effective database. */
  private async probeSession(
    db: string | undefined
  ): Promise<{ version: string; readonly: number; database: string }> {
    const session = this.requireSession()
    const run = (settings: ClickHouseSettings) =>
      session
        .query({
          query:
            "SELECT version() AS v, toString(getSetting('readonly')) AS ro, currentDatabase() AS db",
          format: 'JSONEachRow',
          clickhouse_settings: settings,
          http_headers: this.dbHeaders(db)
        })
        .then((rs) => rs.json<{ v: string; ro: string; db: string }>())
    let rows: Array<{ v: string; ro: string; db: string }>
    try {
      rows = await run({ session_timeout: String(SESSION_TIMEOUT_S) })
    } catch (error) {
      // Servers with a lower max_session_timeout (or profiles that refuse it) get the default.
      const code = errorCode(error)
      if (code !== CH.INVALID_SESSION_TIMEOUT && code !== CH.READONLY) throw error
      this.sessionTimeout = null
      rows = await run({})
    }
    this.sessionFresh = false
    const row = rows[0]
    if (!row) throw new DataDriverError('ClickHouse returned no version information.')
    return { version: row.v, readonly: Number(row.ro) || 0, database: row.db }
  }

  async close(): Promise<void> {
    this.connected = false
    const run = this.running
    if (run) {
      run.cancelled = true
      run.controller.abort()
    }
    this.running = null
    const clients = [this.session, this.control].filter((c): c is ClickHouseClient => c !== null)
    this.session = null
    this.control = null
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)))
    this.agent?.destroy()
    this.agent = null
  }

  isConnected(): boolean {
    return this.connected
  }

  sessionState(): { inTransaction?: boolean; currentDatabase?: string } {
    return { currentDatabase: this.currentDb }
  }

  // ---- settings -------------------------------------------------------------------------------

  /** Settings for user statements on the session. */
  private querySettings(options: { sandbox: boolean; timeoutMs?: number }): ClickHouseSettings {
    if (!this.settingsAllowed) return {}
    const settings: ClickHouseSettings = {
      output_format_json_quote_64bit_integers: 1,
      output_format_json_quote_decimals: 1,
      output_format_json_quote_denormals: 1,
      cancel_http_readonly_queries_on_client_close: 1
    }
    if (this.config.timezone) settings.session_timezone = this.config.timezone
    // A readonly=2 profile is already sandboxed and may not touch `readonly` at all.
    if (options.sandbox && this.profileReadonly === 0) settings.readonly = '2'
    if (options.timeoutMs && options.timeoutMs > 0)
      settings.max_execution_time = Math.max(1, Math.ceil(options.timeoutMs / 1000))
    return settings
  }

  /** Settings for internal metadata reads on the control client. */
  private controlSettings(): ClickHouseSettings {
    if (!this.settingsAllowed) return {}
    return { output_format_json_quote_64bit_integers: 1, output_format_json_quote_decimals: 1 }
  }

  /** session_timeout / session_check for the next session request. */
  private sessionParams(): ClickHouseSettings {
    const params: ClickHouseSettings = {}
    if (this.sessionTimeout) params.session_timeout = String(this.sessionTimeout)
    if (!this.sessionFresh) params.session_check = 1
    return params
  }

  /**
   * Runs one session request: recreates an expired session (and says what was lost) and waits
   * out SESSION_IS_LOCKED, which only means the previous (cancelled) query is still unwinding —
   * the server refused the request before running anything, so retrying is safe.
   */
  private async onSession<T>(
    run: RunningQuery | null,
    fn: (params: ClickHouseSettings) => Promise<T>
  ): Promise<T> {
    const deadline = Date.now() + SESSION_LOCK_RETRY_MS
    for (;;) {
      const params = this.sessionParams()
      try {
        const out = await fn(params)
        this.sessionFresh = false
        return out
      } catch (error) {
        const code = errorCode(error)
        if (code === CH.SESSION_NOT_FOUND && params.session_check) {
          this.sessionFresh = true
          this.pendingNotices.push(
            'The ClickHouse session had expired (idle for too long): temporary tables and SET values from before are gone.'
          )
          continue
        }
        if (code === CH.SESSION_IS_LOCKED && !run?.cancelled && Date.now() < deadline) {
          await sleep(100)
          continue
        }
        throw error
      }
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  // ---- execution ------------------------------------------------------------------------------

  async execute(statement: string, options: DriverExecuteOptions): Promise<DriverStatementResult> {
    this.requireSession()
    return this.serial(() => this.executeNow(statement, options))
  }

  private async executeNow(
    statement: string,
    options: DriverExecuteOptions
  ): Promise<DriverStatementResult> {
    // `options.database` is where this statement runs. A USE earlier in the same request sticks
    // because the query runner passes the session's current database for the statements after
    // the first; a later request (another tab, or the dropdown switched back) gets its own.
    if (options.database && options.database !== this.currentDb) this.currentDb = options.database
    const info = analyzeClickHouseStatement(statement)
    const hardCap = Math.max(
      1,
      Math.min(Math.floor(options.hardCap || DATA_HARD_ROW_CAP), DATA_HARD_ROW_CAP)
    )
    const autoLimit =
      options.limit !== null && options.limit > 0 && !info.hasLimit
        ? Math.floor(options.limit)
        : null
    const cap = autoLimit !== null ? Math.min(autoLimit, hardCap) : hardCap
    const settings = this.querySettings({
      sandbox: options.readOnlySandbox,
      timeoutMs: options.timeoutMs ?? this.config.queryTimeoutMs
    })
    const run: RunningQuery = {
      queryId: randomUUID(),
      controller: new AbortController(),
      text: statement,
      startedAt: Date.now(),
      cancelled: false
    }
    this.running = run
    try {
      let result: DriverStatementResult
      if (info.leading === 'USE') {
        result = await this.runUse(statement, run, settings)
      } else if (info.format) {
        result = await this.runRaw(statement, info.format, run, settings, cap)
      } else if (info.returnsRows) {
        try {
          result = await this.runRows(statement, run, settings, cap, autoLimit, hardCap)
        } catch (error) {
          // A statement that does not accept our FORMAT suffix (SHOW … short forms, a FORMAT we
          // did not recognise): it never ran, so show its raw output instead.
          if (
            run.cancelled ||
            !failsAtAppendedFormat(errorCode(error), errorMessage(error), statement)
          )
            throw error
          result = await this.runRaw(statement, null, run, settings, cap)
        }
      } else {
        result = await this.runCommand(statement, info, run, settings)
      }
      const notices = [...this.takeNotices(), ...(result.notices ?? [])]
      return {
        output: result.output,
        ...(notices.length > 0 ? { notices } : {}),
        ...(result.stats ? { stats: result.stats } : {})
      }
    } catch (error) {
      if (run.cancelled || errorCode(error) === CH.QUERY_WAS_CANCELLED) {
        throw new DataDriverError('The query was cancelled.', { cancelled: true })
      }
      throw this.toDriverError(error, statement, options.readOnlySandbox)
    } finally {
      if (this.running === run) this.running = null
    }
  }

  private takeNotices(): string[] {
    const out = this.pendingNotices
    this.pendingNotices = []
    return out
  }

  private async runRows(
    statement: string,
    run: RunningQuery,
    settings: ClickHouseSettings,
    cap: number,
    autoLimit: number | null,
    hardCap: number
  ): Promise<DriverStatementResult> {
    const session = this.requireSession()
    const format = this.settingsAllowed
      ? 'JSONCompactEachRowWithNamesAndTypes'
      : 'JSONCompactStringsEachRowWithNamesAndTypes'
    const limits: ClickHouseSettings = this.settingsAllowed
      ? { max_result_rows: String(cap + 1), result_overflow_mode: 'break', wait_end_of_query: 1 }
      : {}
    // exec() + our own FORMAT clause: the rows are parsed from the raw bytes (see above).
    const res = await this.onSession(run, (params) =>
      session.exec({
        query: withFormatClause(statement, format),
        query_id: run.queryId,
        abort_signal: run.controller.signal,
        clickhouse_settings: { ...settings, ...limits, ...params },
        http_headers: this.dbHeaders()
      })
    )
    const read = await this.readCompactRows(
      compactRowsFromBytes(res.stream as AsyncIterable<Buffer | string>),
      cap,
      () => res.stream.destroy()
    )
    const output: DataStatementOutput = {
      kind: 'rows',
      columns: read.columns,
      rows: read.rows,
      truncated: read.truncated,
      limit: read.truncated ? (read.byteLimited ? read.rows.length : cap) : autoLimit,
      autoLimited: read.truncated && !read.byteLimited && autoLimit !== null && autoLimit <= hardCap
    }
    const notices = read.byteLimited
      ? [`Showing the first ${read.rows.length} rows: the full result is too large to display.`]
      : undefined
    return { output, notices, stats: parseSummary(res.response_headers) }
  }

  /**
   * Reads JSONCompact*EachRowWithNamesAndTypes rows: first the names row, then the types row,
   * then data. Stops at `cap` rows (+1 to detect more) or the text budget.
   */
  private async readCompactRows(
    stream: AsyncIterable<unknown[][]>,
    cap: number,
    stop: () => void
  ): Promise<RowsRead> {
    let names: string[] = []
    let types: string[] = []
    const rows: DataCell[][] = []
    let index = 0
    let chars = 0
    let truncated = false
    let byteLimited = false
    outer: for await (const batch of stream) {
      for (const values of batch) {
        if (index === 0) names = values.map((v) => str(restoreNested(v)))
        else if (index === 1) types = values.map((v) => str(restoreNested(v)))
        else {
          if (rows.length >= cap) {
            truncated = true
            break outer
          }
          const cells = values.map((v, i) => clickHouseCell(v, types[i]))
          let rowChars = 0
          for (const c of cells) rowChars += cellSize(c)
          // The row that would cross the budget is left out unless it is the only one.
          if (rows.length > 0 && chars + rowChars > MAX_RESULT_CHARS) {
            truncated = true
            byteLimited = true
            break outer
          }
          chars += rowChars
          rows.push(cells)
        }
        index++
      }
    }
    if (truncated) stop()
    const columns = names.map((name, i) => (types[i] ? { name, type: types[i] } : { name }))
    return { columns, rows, truncated, byteLimited }
  }

  /** User FORMAT (or a statement that refuses ours): the raw output as a one-column result. */
  private async runRaw(
    statement: string,
    format: string | null,
    run: RunningQuery,
    settings: ClickHouseSettings,
    cap: number
  ): Promise<DriverStatementResult> {
    const session = this.requireSession()
    const limits: ClickHouseSettings = this.settingsAllowed
      ? { max_result_rows: String(cap + 1), result_overflow_mode: 'break', wait_end_of_query: 1 }
      : {}
    const res = await this.onSession(run, (params) =>
      session.exec({
        query: statement,
        query_id: run.queryId,
        abort_signal: run.controller.signal,
        clickhouse_settings: { ...settings, ...limits, ...params },
        http_headers: this.dbHeaders()
      })
    )
    const chunks: Buffer[] = []
    let bytes = 0
    let cut = false
    for await (const chunk of res.stream as AsyncIterable<Buffer | string>) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      chunks.push(buf)
      bytes += buf.length
      if (bytes > MAX_RAW_BYTES) {
        cut = true
        res.stream.destroy()
        break
      }
    }
    const body = Buffer.concat(chunks).subarray(0, MAX_RAW_BYTES)
    const resultRows = summaryField(res.response_headers, 'result_rows')
    const serverCut = resultRows !== null && resultRows > cap
    const name = format ? `${format} output` : 'output'
    let output: DataStatementOutput
    if (format && BINARY_FORMATS.test(format)) {
      output = {
        kind: 'rows',
        columns: [{ name, type: 'binary' }],
        rows: [[binaryCell(body)]],
        truncated: cut || serverCut,
        limit: cut || serverCut ? cap : null,
        autoLimited: false
      }
    } else {
      const text = body.toString('utf8')
      const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
      const rows: DataCell[][] = text.length === 0 ? [] : lines.map((line) => [line])
      output = {
        kind: 'rows',
        columns: [{ name, type: 'String' }],
        rows,
        truncated: cut || serverCut,
        limit: cut || serverCut ? cap : null,
        autoLimited: false
      }
    }
    const notices: string[] = []
    if (serverCut) notices.push(`The server stopped after about ${cap} rows (row limit).`)
    if (cut) notices.push(`Output cut at ${Math.round(MAX_RAW_BYTES / (1024 * 1024))} MB.`)
    return {
      output,
      notices: notices.length ? notices : undefined,
      stats: parseSummary(res.response_headers)
    }
  }

  private async runCommand(
    statement: string,
    info: ClickHouseStatementInfo,
    run: RunningQuery,
    settings: ClickHouseSettings
  ): Promise<DriverStatementResult> {
    const session = this.requireSession()
    const res = await this.onSession(run, (params) =>
      session.command({
        query: statement,
        query_id: run.queryId,
        abort_signal: run.controller.signal,
        // wait_end_of_query: the response (and its summary) comes when the work is done.
        clickhouse_settings: {
          ...settings,
          ...(this.settingsAllowed ? { wait_end_of_query: 1 } : {}),
          ...params
        },
        http_headers: this.dbHeaders()
      })
    )
    const written = num(res.summary?.written_rows)
    const output: DataStatementOutput = {
      kind: 'command',
      message: clickHouseCommandTag(statement),
      affectedRows: info.leading === 'INSERT' ? written : null
    }
    const notices = info.isMutation
      ? [
          'ALTER … UPDATE/DELETE runs as an asynchronous mutation: follow it in system.mutations (KILL MUTATION stops it).'
        ]
      : undefined
    return { output, notices, stats: parseSummary(res.response_headers) }
  }

  private async runUse(
    statement: string,
    run: RunningQuery,
    settings: ClickHouseSettings
  ): Promise<DriverStatementResult> {
    const session = this.requireSession()
    await this.onSession(run, (params) =>
      session.command({
        query: statement,
        query_id: run.queryId,
        abort_signal: run.controller.signal,
        clickhouse_settings: { ...settings, ...params }
      })
    )
    // The session's database is now what USE said; ask for it without our header (which would
    // override it) to get the exact unquoted name.
    const rows = await this.onSession(run, (params) =>
      session
        .query({
          query: 'SELECT currentDatabase() AS db',
          format: 'JSONEachRow',
          clickhouse_settings: params
        })
        .then((rs) => rs.json<{ db: string }>())
    )
    const db = rows[0]?.db ?? this.currentDb
    this.currentDb = db
    return { output: { kind: 'command', message: db ? `USE ${db}` : 'USE' } }
  }

  async cancelCurrent(): Promise<void> {
    const run = this.running
    if (!run || run.cancelled) return
    run.cancelled = true
    // Abort first (closes the socket; read-only queries stop with
    // cancel_http_readonly_queries_on_client_close), then KILL for everything else.
    run.controller.abort()
    await this.killQueryId(run.queryId).catch(() => undefined)
  }

  private async killQueryId(queryId: string): Promise<number> {
    const control = this.requireControl()
    const rs = await control.query({
      query: 'KILL QUERY WHERE query_id = {id:String} ASYNC',
      format: 'JSONEachRow',
      query_params: { id: queryId },
      clickhouse_settings: this.controlSettings()
    })
    const rows = await rs.json<Record<string, unknown>>()
    return rows.length
  }

  // ---- metadata (control client) --------------------------------------------------------------

  private async controlRows<T>(
    query: string,
    params?: Record<string, unknown>,
    db?: string
  ): Promise<T[]> {
    const control = this.requireControl()
    const rs = await control.query({
      query,
      format: 'JSONEachRow',
      query_params: params,
      clickhouse_settings: this.controlSettings(),
      http_headers: this.dbHeaders(db)
    })
    return rs.json<T>()
  }

  /** Newer system columns first, a conservative column set for older servers. */
  private async controlRowsWithFallback<T>(
    primary: string,
    fallback: string,
    params?: Record<string, unknown>
  ): Promise<T[]> {
    try {
      return await this.controlRows<T>(primary, params)
    } catch (error) {
      const code = errorCode(error)
      if (code !== CH.UNKNOWN_IDENTIFIER && code !== '16' /* NO_SUCH_COLUMN_IN_TABLE */)
        throw this.toDriverError(error)
      return this.controlRows<T>(fallback, params)
    }
  }

  private async metadata<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      throw error instanceof DataDriverError ? error : this.toDriverError(error)
    }
  }

  async listDatabases(): Promise<DataDatabaseInfo[]> {
    return this.metadata(async () => {
      const [dbs, sizes] = await Promise.all([
        this.controlRows<{ name: string }>('SELECT name FROM system.databases ORDER BY name'),
        this.controlRows<{ database: string; bytes: string | number | null }>(
          'SELECT database, sum(total_bytes) AS bytes FROM system.tables GROUP BY database'
        ).catch(() => [])
      ])
      const bytesByDb = new Map(sizes.map((s) => [s.database, num(s.bytes)] as const))
      return dbs.map((d) => ({
        name: d.name,
        sizeBytes: bytesByDb.get(d.name) ?? null,
        ...(SYSTEM_DATABASES.has(d.name) ? { isSystem: true } : {})
      }))
    })
  }

  async listObjects(database?: string): Promise<DataObjectsListing> {
    return this.metadata(async () => {
      const db = database || this.currentDb || 'default'
      const rows = await this.controlRowsWithFallback<{
        name: string
        engine: string
        total_rows: string | number | null
        total_bytes: string | number | null
        comment?: string
      }>(
        'SELECT name, engine, total_rows, total_bytes, comment FROM system.tables WHERE database = {db:String} AND NOT is_temporary ORDER BY name',
        'SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database = {db:String} ORDER BY name',
        { db }
      )
      const objects: DataObjectInfo[] = rows
        .filter((r) => !isInnerTable(r.name))
        .map((r) => {
          const kind = objectKind(r.engine)
          return {
            name: r.name,
            kind,
            rowEstimate: kind === 'table' ? num(r.total_rows) : null,
            sizeBytes: num(r.total_bytes),
            engine: r.engine,
            ...(r.comment ? { comment: r.comment } : {})
          }
        })
      return { objects }
    })
  }

  async describe(ref: DataObjectRef): Promise<DataTableDetails> {
    return this.metadata(async () => {
      const db = ref.database || ref.schema || this.currentDb || 'default'
      const params = { db, t: ref.name }
      const tables = await this.controlRowsWithFallback<{
        engine: string
        engine_full: string
        total_rows: string | number | null
        total_bytes: string | number | null
        sorting_key: string
        primary_key: string
        partition_key: string
        sampling_key: string
        comment?: string
        as_select?: string
      }>(
        `SELECT engine, engine_full, total_rows, total_bytes, sorting_key, primary_key, partition_key, sampling_key, comment, as_select
         FROM system.tables WHERE database = {db:String} AND name = {t:String}`,
        `SELECT engine, engine_full, total_rows, total_bytes, sorting_key, primary_key, partition_key, sampling_key
         FROM system.tables WHERE database = {db:String} AND name = {t:String}`,
        params
      )
      const table = tables[0]
      if (!table) {
        throw new DataDriverError(`No table named ${ref.name} in database ${db}.`, {
          code: CH.UNKNOWN_IDENTIFIER
        })
      }
      const kind = objectKind(table.engine)
      const columnRows = await this.controlRowsWithFallback<{
        name: string
        type: string
        position: string | number
        default_kind: string
        default_expression: string
        is_in_primary_key: number
        is_in_sorting_key: number
        is_in_partition_key: number
        is_in_sampling_key: number
        compression_codec: string
        comment: string
      }>(
        `SELECT name, type, position, default_kind, default_expression, is_in_primary_key, is_in_sorting_key,
                is_in_partition_key, is_in_sampling_key, compression_codec, comment
         FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position`,
        `SELECT name, type, position, default_kind, default_expression, is_in_primary_key, is_in_sorting_key,
                is_in_partition_key, is_in_sampling_key, compression_codec, '' AS comment
         FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position`,
        params
      )
      const columns: DataColumnInfo[] = columnRows.map((c, i) => {
        const extras: string[] = []
        if (c.default_kind && c.default_kind !== 'DEFAULT') extras.push(c.default_kind)
        if (Number(c.is_in_sorting_key)) extras.push('sorting key')
        if (Number(c.is_in_partition_key)) extras.push('partition key')
        if (Number(c.is_in_sampling_key)) extras.push('sampling key')
        if (c.compression_codec) extras.push(c.compression_codec)
        return {
          name: c.name,
          type: c.type,
          nullable: isNullableType(c.type),
          defaultValue: c.default_expression ? c.default_expression : null,
          isPrimaryKey: Number(c.is_in_primary_key) === 1,
          ordinal: num(c.position) ?? i + 1,
          ...(c.comment ? { comment: c.comment } : {}),
          ...(extras.length ? { extra: extras.join(', ') } : {})
        }
      })

      const indexes: DataIndexInfo[] = []
      const keyColumns = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
      if (table.primary_key) {
        indexes.push({
          name: 'PRIMARY KEY',
          columns: keyColumns.length ? keyColumns : [table.primary_key],
          unique: false,
          primary: true,
          definition: `PRIMARY KEY (${table.primary_key})`,
          type: 'sparse primary index'
        })
      }
      const skipping = await this.controlRows<{
        name: string
        type: string
        expr: string
        granularity: string | number
      }>(
        'SELECT name, type, expr, granularity FROM system.data_skipping_indices WHERE database = {db:String} AND table = {t:String}',
        params
      ).catch(() => [])
      for (const idx of skipping) {
        indexes.push({
          name: idx.name,
          columns: [idx.expr],
          unique: false,
          primary: false,
          definition: `INDEX ${quoteSqlIdentifier(idx.name, 'clickhouse')} ${idx.expr} TYPE ${idx.type} GRANULARITY ${idx.granularity}`,
          type: idx.type
        })
      }

      const properties: Array<{ label: string; value: string }> = [
        { label: 'Engine', value: table.engine_full || table.engine }
      ]
      if (table.sorting_key) properties.push({ label: 'Sorting key', value: table.sorting_key })
      if (table.primary_key && table.primary_key !== table.sorting_key)
        properties.push({ label: 'Primary key', value: table.primary_key })
      if (table.partition_key)
        properties.push({ label: 'Partition key', value: table.partition_key })
      if (table.sampling_key) properties.push({ label: 'Sampling key', value: table.sampling_key })
      if (table.as_select) properties.push({ label: 'Query', value: table.as_select })
      if (kind === 'table') {
        const parts = await this.controlRows<{
          parts: string | number
          rows: string | number
          compressed: string | number
          uncompressed: string | number
        }>(
          `SELECT count() AS parts, sum(rows) AS rows, sum(data_compressed_bytes) AS compressed,
                  sum(data_uncompressed_bytes) AS uncompressed
           FROM system.parts WHERE database = {db:String} AND table = {t:String} AND active`,
          params
        ).catch(() => [])
        const p = parts[0]
        const partCount = num(p?.parts)
        if (p && partCount) {
          properties.push({ label: 'Active parts', value: String(partCount) })
          const compressed = num(p.compressed)
          const uncompressed = num(p.uncompressed)
          if (compressed && uncompressed) {
            properties.push({
              label: 'Compression ratio',
              value: `${(uncompressed / compressed).toFixed(2)}×`
            })
          }
        }
      }

      return {
        ref: { database: db, name: ref.name, kind },
        kind,
        columns,
        indexes,
        foreignKeys: [],
        triggers: [],
        // ClickHouse keys are not unique, and row edits would be asynchronous mutations: no
        // grid editing (the key columns are still marked in `columns`).
        primaryKey: [],
        rowEstimate: kind === 'table' ? num(table.total_rows) : null,
        sizeBytes: num(table.total_bytes),
        engine: table.engine,
        ...(table.comment ? { comment: table.comment } : {}),
        properties
      }
    })
  }

  async ddl(ref: DataObjectRef): Promise<string> {
    return this.metadata(async () => {
      const db = ref.database || ref.schema || this.currentDb || 'default'
      const name = `${quoteSqlIdentifier(db, 'clickhouse')}.${quoteSqlIdentifier(ref.name, 'clickhouse')}`
      const show = async (what: 'TABLE' | 'DICTIONARY'): Promise<string> => {
        const rows = await this.controlRows<{ statement: string }>(`SHOW CREATE ${what} ${name}`)
        return rows[0]?.statement ?? ''
      }
      let text: string
      if (ref.kind === 'dictionary') {
        text = await show('DICTIONARY')
      } else {
        try {
          text = await show('TABLE')
        } catch (error) {
          if (ref.kind) throw error
          text = await show('DICTIONARY')
        }
      }
      const trimmed = text.trimEnd()
      return trimmed ? `${trimmed};\n` : ''
    })
  }

  async completionSchema(database?: string): Promise<DataCompletionSchema> {
    return this.metadata(async () => {
      const db = database || this.currentDb || 'default'
      const [dbs, tables, columns, functions, tableFunctions] = await Promise.all([
        this.controlRows<{ name: string }>('SELECT name FROM system.databases ORDER BY name'),
        this.controlRows<{ name: string; engine: string }>(
          `SELECT name, engine FROM system.tables WHERE database = {db:String} ORDER BY name LIMIT ${COMPLETION_TABLE_CAP + 1}`,
          { db }
        ),
        this.controlRows<{ table: string; name: string; type: string }>(
          `SELECT table, name, type FROM system.columns WHERE database = {db:String} ORDER BY table, position LIMIT ${COMPLETION_COLUMN_CAP + 1}`,
          { db }
        ),
        this.controlRows<{ name: string }>(
          `SELECT name FROM system.functions WHERE NOT startsWith(name, '_') ORDER BY name LIMIT ${COMPLETION_FUNCTION_CAP}`
        ).catch(() => []),
        this.controlRows<{ name: string }>(
          'SELECT name FROM system.table_functions ORDER BY name'
        ).catch(() => [])
      ])
      const byTable = new Map<string, Array<{ name: string; type: string }>>()
      for (const c of columns.slice(0, COMPLETION_COLUMN_CAP)) {
        const list = byTable.get(c.table)
        if (list) list.push({ name: c.name, type: c.type })
        else byTable.set(c.table, [{ name: c.name, type: c.type }])
      }
      const completionTables: DataCompletionTable[] = tables
        .slice(0, COMPLETION_TABLE_CAP)
        .filter((t) => !isInnerTable(t.name))
        .map((t) => ({
          name: t.name,
          kind: objectKind(t.engine),
          columns: byTable.get(t.name) ?? []
        }))
      const fnNames = [
        ...new Set([...functions.map((f) => f.name), ...tableFunctions.map((f) => f.name)])
      ].sort()
      const truncated =
        tables.length > COMPLETION_TABLE_CAP || columns.length > COMPLETION_COLUMN_CAP
      return {
        database: db,
        databases: dbs.map((d) => d.name),
        tables: completionTables,
        functions: fnNames,
        ...(truncated ? { truncated: true } : {})
      }
    })
  }

  async listProcesses(): Promise<DataProcessInfo[]> {
    return this.metadata(async () => {
      const rows = await this.controlRows<{
        query_id: string
        user: string
        address: string
        db: string
        elapsed: number
        read_rows: string | number
        read_bytes: string | number
        total_rows_approx: string | number
        written_rows: string | number
        memory_usage: string | number
        is_cancelled: number
        query: string
      }>(
        `SELECT query_id, user, toString(address) AS address, current_database AS db, elapsed, read_rows, read_bytes,
                total_rows_approx, written_rows, memory_usage, is_cancelled, query
         FROM system.processes WHERE query_id != queryID() ORDER BY elapsed DESC`
      )
      const own = this.running?.queryId
      return rows.map((r) => {
        const query = str(r.query)
        return {
          id: r.query_id,
          user: r.user || null,
          host: r.address || null,
          database: r.db || null,
          state: Number(r.is_cancelled) ? 'cancelling' : 'running',
          command: /^\s*\(*\s*([A-Za-z]+)/.exec(query)?.[1]?.toUpperCase() ?? null,
          durationMs: Math.round((num(r.elapsed) ?? 0) * 1000),
          query:
            query.length > QUERY_PREVIEW_CHARS ? `${query.slice(0, QUERY_PREVIEW_CHARS)}…` : query,
          isOwn: r.query_id === own,
          extra: {
            read_rows: num(r.read_rows),
            read_bytes: num(r.read_bytes),
            total_rows_approx: num(r.total_rows_approx),
            written_rows: num(r.written_rows),
            memory_usage: num(r.memory_usage)
          }
        }
      })
    })
  }

  async killProcess(processId: string, _scope: DataKillScope): Promise<void> {
    // HTTP has no connections to kill: both scopes stop the query.
    const run = this.running
    if (run && run.queryId === processId) {
      await this.cancelCurrent()
      return
    }
    const killed = await this.metadata(() => this.killQueryId(processId))
    if (killed === 0) {
      throw new DataDriverError('That query is no longer running.', { code: 'NO_SUCH_QUERY' })
    }
  }

  async streamRows(
    statement: string,
    options: { database?: string; schema?: string; readOnlySandbox: boolean; signal: AbortSignal },
    onBatch: (columns: string[], rows: unknown[][]) => Promise<void>
  ): Promise<{ rows: number }> {
    const cancelled = (): DataDriverError =>
      new DataDriverError('The export was cancelled.', { cancelled: true })
    if (options.signal.aborted) throw cancelled()
    this.requireControl()
    const info = analyzeClickHouseStatement(statement)
    if (info.format) {
      throw new DataDriverError(`Remove the FORMAT ${info.format} clause to export this query.`, {
        code: 'EXPORT_FORMAT'
      })
    }
    if (!info.returnsRows) {
      throw new DataDriverError('Only statements that return rows can be exported.', {
        code: 'EXPORT_NOT_ROWS'
      })
    }
    // A client of its own: a long idle timeout (aggregations are silent until done) and no
    // session (the console's session stays usable; temp tables are not visible here).
    const client = this.createClient({
      request_timeout: LONG_REQUEST_TIMEOUT_MS,
      max_open_connections: 1
    })
    const queryId = randomUUID()
    const controller = new AbortController()
    const onAbort = (): void => {
      controller.abort()
      void this.killQueryId(queryId).catch(() => undefined)
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      // No wait_end_of_query and no row cap: rows flow to the file as the server produces them.
      const settings = this.querySettings({ sandbox: options.readOnlySandbox })
      // Parsed from the raw bytes like the grid's rows (binary String values stay bytes); the
      // types row says which columns may hold them.
      const res = await client.exec({
        query: withFormatClause(
          statement,
          this.settingsAllowed
            ? 'JSONCompactEachRowWithNamesAndTypes'
            : 'JSONCompactStringsEachRowWithNamesAndTypes'
        ),
        query_id: queryId,
        abort_signal: controller.signal,
        clickhouse_settings: settings,
        http_headers: this.dbHeaders(options.database || this.currentDb)
      })
      let names: string[] | null = null
      let types: string[] | null = null
      let batch: unknown[][] = []
      let total = 0
      let emitted = false
      for await (const rows of compactRowsFromBytes(res.stream as AsyncIterable<Buffer | string>)) {
        for (const values of rows) {
          if (names === null) {
            names = values.map((v) => str(restoreNested(v)))
            continue
          }
          if (types === null) {
            types = values.map((v) => str(restoreNested(v)))
            continue
          }
          const columnTypes = types
          batch.push(values.map((v, i) => clickHouseCell(v, columnTypes[i], Infinity)))
          total++
          if (batch.length >= STREAM_BATCH_ROWS) {
            if (options.signal.aborted) throw cancelled()
            const out = batch
            batch = []
            emitted = true
            await onBatch(names, out)
          }
        }
      }
      if (options.signal.aborted) throw cancelled()
      if (batch.length > 0 || !emitted) await onBatch(names ?? [], batch)
      return { rows: total }
    } catch (error) {
      if (options.signal.aborted) throw cancelled()
      throw error instanceof DataDriverError
        ? error
        : this.toDriverError(error, statement, options.readOnlySandbox)
    } finally {
      options.signal.removeEventListener('abort', onAbort)
      await client.close().catch(() => undefined)
    }
  }

  quoteIdentifier(name: string): string {
    return quoteSqlIdentifier(name, 'clickhouse')
  }

  // ---- errors ---------------------------------------------------------------------------------

  private toDriverError(error: unknown, statement?: string, sandbox = false): DataDriverError {
    if (error instanceof DataDriverError) return error
    if (isAbortError(error))
      return new DataDriverError('The query was cancelled.', { cancelled: true })
    const message = errorMessage(error, this.redact)
    const code = errorCode(error)
    const position = statement ? clickHouseErrorPosition(message, statement) : undefined
    const sandboxRejected = sandbox && code === CH.READONLY
    let hint = code ? HINTS[code] : undefined
    if (code === CH.READONLY && !sandbox)
      hint = 'This ClickHouse user is read-only (profile readonly setting).'
    return new DataDriverError(message, {
      code,
      ...(position !== undefined ? { position } : {}),
      ...(hint ? { hint } : {}),
      sandboxRejected
    })
  }
}

export function createClickHouseDriver(input: DriverConnectInput): DataDriver {
  return new ClickHouseDriver(input)
}
