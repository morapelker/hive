/**
 * Pure parsing of one complete line of a Claude CLI debug log into the API
 * response entry it may hold: line time, HTTP status, the unified rate-limit
 * response headers and the organization the request was billed to.
 *
 * Format facts (CODE_MODE_PRD.html section 4 and appendix 17A, checked against
 * the SDK source and CLI 2.1.326 run against a local stand-in API):
 * - Every physical line is `<ISO timestamp> [LEVEL] <payload>`.
 * - With `ANTHROPIC_LOG=debug` the Anthropic SDK inside the CLI logs each HTTP
 *   exchange through `console`, and the CLI's TUI captures it as a payload
 *   that starts with `console.log: [log_xxxxxx] `. A payload containing a
 *   newline is written as ONE JSON string literal, so an entry is always one
 *   line; a payload without one is written as is.
 * - The entries that carry response headers are `response start` (headers of
 *   a successful response, written before the first streamed byte) and
 *   `response error (...)` (any non-2xx, including a plan-limit 429). The text
 *   after the label is the SDK's details object printed by `util.inspect`:
 *   keys are bare when identifier-like and quoted otherwise; string values are
 *   single-quoted, double-quoted when they contain a single quote, backticked
 *   when they contain both. A short object prints on one line.
 * - `sending request`, the `succeeded with status` line, `response parsed`
 *   and `connection failed` share the `[log_` prefix and are deliberately not
 *   entries. The `succeeded with status` line is the one thing recognised
 *   besides entries (`isClaudeDebugLogSuccessStatusLine`): it is written for
 *   every successful response, also at a log level that leaves the headers
 *   out, so it tells health detection that a response was logged (FR-30).
 * - Only a payload that STARTS with the SDK prefix counts. Hook and MCP output
 *   is logged inside other entries and can contain the same text.
 * - Credentials are masked upstream, by the SDK (`***`) and then by the CLI's
 *   redactor (`[REDACTED]`, which also hits any header whose name contains
 *   `token`, `key`, `secret`, `cookie`, `session-id`, ...). A masked value is
 *   treated as absent.
 *
 * Security (PRD SEC-5, SEC-6): masking happens outside the app's control, so
 * a line is never trusted. This module logs nothing, never throws, and returns
 * only the fields above; a rejected line yields a fixed reason code and none
 * of its content. Response headers other than the unified rate-limit ones and
 * the organization id (request ids, ray ids, ...) are dropped here.
 */
import { UNIFIED_HEADER_PREFIX } from '../claude-api-proxy/anthropic-rate-limit-headers'

/** A longer line is discarded unread (PRD FR-21, SEC-6). UTF-16 units, so never laxer than 1 MiB of bytes. */
export const CLAUDE_DEBUG_LOG_MAX_LINE_LENGTH = 1024 * 1024

export const ORGANIZATION_ID_HEADER = 'anthropic-organization-id'

export type ClaudeDebugLogEntryKind = 'response-start' | 'response-error'

export interface ClaudeDebugLogResponseEntry {
  kind: ClaudeDebugLogEntryKind
  /** The line's own timestamp, epoch milliseconds. */
  observedAt: number
  /** HTTP status of the response. */
  status: number
  /**
   * Every `anthropic-ratelimit-unified-*` response header (model-scoped
   * buckets included), names lower-cased, masked values removed. Ready for
   * `parseUnifiedRateLimitHeaders`. Empty when the response carried none.
   */
  headers: Record<string, string>
  /** `anthropic-organization-id`, or null when absent, masked or not id-shaped. */
  organizationUuid: string | null
}

/**
 * Why a line produced no entry. A code, never content.
 * - `unrelated`: not a response entry at all (the cheap, common case).
 * - `oversized`: longer than `CLAUDE_DEBUG_LOG_MAX_LINE_LENGTH`.
 * - `malformed`: starts like a response entry but could not be read. This is
 *   the parse failure callers count for health detection.
 */
export type ClaudeDebugLogRejectReason = 'unrelated' | 'oversized' | 'malformed'

export type ClaudeDebugLogParseResult =
  | { kind: 'entry'; entry: ClaudeDebugLogResponseEntry }
  | { kind: 'not-entry'; reason: ClaudeDebugLogRejectReason }

// Shared, frozen results: a rejection allocates nothing.
const UNRELATED: ClaudeDebugLogParseResult = Object.freeze({
  kind: 'not-entry',
  reason: 'unrelated'
})
const OVERSIZED: ClaudeDebugLogParseResult = Object.freeze({
  kind: 'not-entry',
  reason: 'oversized'
})
const MALFORMED: ClaudeDebugLogParseResult = Object.freeze({
  kind: 'not-entry',
  reason: 'malformed'
})

const TIMESTAMP_LENGTH = '2026-01-01T00:00:00.000Z'.length
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
/** Longest level tag the CLI writes is `VERBOSE`; a little slack costs nothing. */
const MAX_LEVEL_LENGTH = 12
const SDK_LINE_PREFIX = 'console.log: [log_'
/** `log_` plus 6 hex digits today; bounded so an unrelated line is rejected quickly. */
const MAX_LOG_ID_LENGTH = 40
const RESPONSE_START_LABEL = 'response start '
const RESPONSE_ERROR_LABEL = 'response error ('
/** What follows the URL in the SDK's report of a response that was `ok`. */
const SUCCESS_STATUS_LABEL = ' succeeded with status '
/** `log_xxxxxx, retryOf: log_xxxxxx, request-id: "req_..."` is under a hundred characters. */
const MAX_STATUS_BRACKET_LENGTH = 512
/** `post`, `get`, `delete`, ... */
const MAX_METHOD_LENGTH = 16
const MAX_URL_LENGTH = 8192
/** `error; not retryable`, `retrying, 2 attempts remaining`, ... */
const MAX_ERROR_REASON_LENGTH = 200

const MASKED_VALUES: ReadonlySet<string> = new Set(['[REDACTED]', '***'])
/** Real unified values are a few characters (a fraction, an epoch, a status word). */
const MAX_HEADER_VALUE_LENGTH = 256
/** A response carries about fifteen today. Far past that, the line is not what it claims to be. */
const MAX_KEPT_HEADERS = 128
const ORGANIZATION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/

const CHAR_TAB = 0x09
const CHAR_LF = 0x0a
const CHAR_CR = 0x0d
const CHAR_SPACE = 0x20
const CHAR_DOUBLE_QUOTE = 0x22
const CHAR_DOLLAR = 0x24
const CHAR_SINGLE_QUOTE = 0x27
const CHAR_OPEN_PAREN = 0x28
const CHAR_CLOSE_PAREN = 0x29
const CHAR_PLUS = 0x2b
const CHAR_COMMA = 0x2c
const CHAR_COLON = 0x3a
const CHAR_OPEN_BRACKET = 0x5b
const CHAR_BACKSLASH = 0x5c
const CHAR_CLOSE_BRACKET = 0x5d
const CHAR_UNDERSCORE = 0x5f
const CHAR_BACKTICK = 0x60
const CHAR_OPEN_BRACE = 0x7b
const CHAR_CLOSE_BRACE = 0x7d

function isWhitespace(code: number): boolean {
  return code === CHAR_SPACE || code === CHAR_LF || code === CHAR_CR || code === CHAR_TAB
}

function isQuote(code: number): boolean {
  return code === CHAR_SINGLE_QUOTE || code === CHAR_DOUBLE_QUOTE || code === CHAR_BACKTICK
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

function isWordChar(code: number): boolean {
  return (
    isDigit(code) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === CHAR_UNDERSCORE ||
    code === CHAR_DOLLAR
  )
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0'
}

function parseHex(text: string, start: number, digits: number): number | null {
  if (start + digits > text.length) return null
  let value = 0
  for (let i = start; i < start + digits; i++) {
    const code = text.charCodeAt(i)
    let digit: number
    if (isDigit(code)) digit = code - 0x30
    else if (code >= 0x61 && code <= 0x66) digit = code - 0x61 + 10
    else if (code >= 0x41 && code <= 0x46) digit = code - 0x41 + 10
    else return null
    value = value * 16 + digit
  }
  return value
}

/**
 * A single forward pass over the text `util.inspect` printed for the SDK's
 * details object. It is a reader for that one shape, not a JavaScript parser:
 * nothing is evaluated, every step consumes input (so the work is linear in
 * the line length whatever the line holds), and anything unexpected makes the
 * caller give up on the line.
 */
class InspectReader {
  pos: number

  constructor(
    private readonly text: string,
    start: number
  ) {
    this.pos = start
  }

  atEnd(): boolean {
    return this.pos >= this.text.length
  }

  /** NaN at the end of the text, which matches no character test. */
  peek(): number {
    return this.text.charCodeAt(this.pos)
  }

  skipWhitespace(): void {
    while (this.pos < this.text.length && isWhitespace(this.text.charCodeAt(this.pos))) this.pos++
  }

  /** Whether everything from `start` up to the cursor is whitespace. */
  isBlankSince(start: number): boolean {
    for (let i = start; i < this.pos; i++) {
      if (!isWhitespace(this.text.charCodeAt(i))) return false
    }
    return true
  }

  /** Whitespace and the commas between properties. */
  skipSeparators(): void {
    while (this.pos < this.text.length) {
      const code = this.text.charCodeAt(this.pos)
      if (!isWhitespace(code) && code !== CHAR_COMMA) return
      this.pos++
    }
  }

  /**
   * Read the quoted string at the cursor (any of the three quote styles) and
   * undo `util.inspect`'s escaping. Null when it is not terminated.
   */
  readQuoted(): string | null {
    const text = this.text
    const quote = text.charCodeAt(this.pos)
    let i = this.pos + 1
    let chunkStart = i
    let value = ''
    while (i < text.length) {
      const code = text.charCodeAt(i)
      if (code === quote) {
        this.pos = i + 1
        return value + text.slice(chunkStart, i)
      }
      if (code !== CHAR_BACKSLASH) {
        i++
        continue
      }
      if (i + 1 >= text.length) return null
      value += text.slice(chunkStart, i)
      const escaped = text[i + 1]
      const hexDigits = escaped === 'x' ? 2 : escaped === 'u' ? 4 : 0
      const codeUnit = hexDigits > 0 ? parseHex(text, i + 2, hexDigits) : null
      if (codeUnit !== null) {
        value += String.fromCharCode(codeUnit)
        i += 2 + hexDigits
      } else {
        // `\'`, `\\` and anything unknown stand for the character itself.
        value += SIMPLE_ESCAPES[escaped] ?? escaped
        i += 2
      }
      chunkStart = i
    }
    return null
  }

  /**
   * A string value. `util.inspect` can print a long multi-line string as
   * several quoted pieces joined by ` +`; header values never contain a
   * newline, but the pieces are joined rather than misread.
   */
  readString(): string | null {
    let value = this.readQuoted()
    while (value !== null) {
      const resume = this.pos
      this.skipWhitespace()
      if (this.peek() !== CHAR_PLUS) {
        this.pos = resume
        break
      }
      this.pos++
      this.skipWhitespace()
      if (!isQuote(this.peek())) return null
      const next = this.readQuoted()
      value = next === null ? null : value + next
    }
    return value
  }

  /** A property name: quoted, or bare when identifier-like. Null when there is none. */
  readKey(): string | null {
    if (isQuote(this.peek())) return this.readQuoted()
    const start = this.pos
    while (this.pos < this.text.length && isWordChar(this.text.charCodeAt(this.pos))) this.pos++
    return this.pos > start ? this.text.slice(start, this.pos) : null
  }

  /** The `: ` between a name and its value. */
  skipColon(): boolean {
    this.skipWhitespace()
    if (this.peek() !== CHAR_COLON) return false
    this.pos++
    this.skipWhitespace()
    return true
  }

  /** Exactly three digits, as an HTTP status is printed. */
  readStatus(): number | null {
    const start = this.pos
    while (this.pos < this.text.length && isDigit(this.text.charCodeAt(this.pos))) this.pos++
    if (this.pos - start !== 3) return null
    return Number(this.text.slice(start, this.pos))
  }

  /**
   * Step over a value this module does not read (a number, `undefined`,
   * `[Array]`, a nested object, a string) and stop on the `,` or closing
   * bracket that ends it. False when the text ends first.
   */
  skipValue(): boolean {
    const text = this.text
    let depth = 0
    while (this.pos < text.length) {
      const code = text.charCodeAt(this.pos)
      if (isQuote(code)) {
        if (this.readQuoted() === null) return false
        continue
      }
      if (code === CHAR_OPEN_BRACE || code === CHAR_OPEN_BRACKET || code === CHAR_OPEN_PAREN) {
        depth++
      } else if (
        code === CHAR_CLOSE_BRACE ||
        code === CHAR_CLOSE_BRACKET ||
        code === CHAR_CLOSE_PAREN
      ) {
        if (depth === 0) return true
        depth--
      } else if (code === CHAR_COMMA && depth === 0) {
        return true
      }
      this.pos++
    }
    return false
  }
}

/**
 * Read the `headers: { ... }` object at the cursor, keeping what this module
 * returns: unified rate-limit headers in `kept`, the organization id on the
 * side. Null when the object cannot be read to its closing brace.
 */
function readHeaders(
  reader: InspectReader
): { kept: Record<string, string>; organizationUuid: string | null } | null {
  if (reader.peek() !== CHAR_OPEN_BRACE) return null
  reader.pos++
  const kept: Record<string, string> = {}
  let keptCount = 0
  let organizationUuid: string | null = null
  for (;;) {
    reader.skipSeparators()
    if (reader.atEnd()) return null
    if (reader.peek() === CHAR_CLOSE_BRACE) {
      reader.pos++
      return { kept, organizationUuid }
    }
    const rawName = reader.readKey()
    if (rawName === null || !reader.skipColon()) return null
    if (!isQuote(reader.peek())) {
      // Not a string value: nothing a header can be. Skipped, not guessed.
      if (!reader.skipValue()) return null
      continue
    }
    const value = reader.readString()
    if (value === null) return null
    // Anything between the closing quote and the separator means the string is
    // not the whole value (`util.inspect` cuts a very long one short and says
    // so after the quote). Such a value is skipped, not half-read.
    const valueEnd = reader.pos
    if (!reader.skipValue()) return null
    if (!reader.isBlankSince(valueEnd)) continue
    if (MASKED_VALUES.has(value) || value.length > MAX_HEADER_VALUE_LENGTH) continue
    const name = rawName.toLowerCase()
    if (name.startsWith(UNIFIED_HEADER_PREFIX)) {
      if (!(name in kept) && ++keptCount > MAX_KEPT_HEADERS) return null
      kept[name] = value
    } else if (name === ORGANIZATION_ID_HEADER) {
      const trimmed = value.trim()
      organizationUuid = ORGANIZATION_ID.test(trimmed) ? trimmed : null
    }
  }
}

/**
 * Read `status` and `headers` out of the details object that starts at
 * `start` (its opening brace). Null when either is missing or unreadable.
 * Reading stops as soon as both are found, so whatever the SDK prints after
 * them (an error body under `message`, for instance) is never looked at.
 */
function readDetails(
  text: string,
  start: number
): { status: number; headers: Record<string, string>; organizationUuid: string | null } | null {
  const reader = new InspectReader(text, start)
  if (reader.peek() !== CHAR_OPEN_BRACE) return null
  reader.pos++
  let status: number | null = null
  let headers: ReturnType<typeof readHeaders> = null
  for (;;) {
    reader.skipSeparators()
    if (reader.atEnd() || reader.peek() === CHAR_CLOSE_BRACE) return null
    const key = reader.readKey()
    if (key === null || !reader.skipColon()) return null
    if (key === 'status' && status === null) {
      status = reader.readStatus()
      if (status === null) return null
    } else if (key === 'headers' && headers === null) {
      headers = readHeaders(reader)
      if (headers === null) return null
    } else if (!reader.skipValue()) {
      return null
    }
    if (status !== null && headers !== null) {
      return { status, headers: headers.kept, organizationUuid: headers.organizationUuid }
    }
  }
}

/**
 * Where the SDK's log id starts (right after `console.log: [log_`), or -1 for
 * a line that is not one of the SDK's. Fixed-offset character tests and
 * bounded prefix comparisons only: this is the check every unrelated line
 * fails, before any JSON decoding or regular expression runs (PRD PF-5).
 */
function findSdkLogId(line: string): number {
  if (
    line.charCodeAt(TIMESTAMP_LENGTH) !== CHAR_SPACE ||
    line.charCodeAt(TIMESTAMP_LENGTH + 1) !== CHAR_OPEN_BRACKET
  ) {
    return -1
  }
  const levelStart = TIMESTAMP_LENGTH + 2
  let levelEnd = levelStart
  while (levelEnd - levelStart <= MAX_LEVEL_LENGTH) {
    const code = line.charCodeAt(levelEnd)
    if (code === CHAR_CLOSE_BRACKET) break
    // A level tag is upper-case letters; anything else (or the end) is not one.
    if (!(code >= 0x41 && code <= 0x5a)) return -1
    levelEnd++
  }
  if (levelEnd === levelStart || line.charCodeAt(levelEnd) !== CHAR_CLOSE_BRACKET) return -1
  if (line.charCodeAt(levelEnd + 1) !== CHAR_SPACE) return -1

  // The SDK's text follows either the opening quote of a JSON string literal
  // or, for a payload without newlines, nothing at all. None of the characters
  // compared here and by the callers is ever escaped by JSON, so the raw line
  // can be tested.
  let cursor = levelEnd + 2
  if (line.charCodeAt(cursor) === CHAR_DOUBLE_QUOTE) cursor++
  if (!line.startsWith(SDK_LINE_PREFIX, cursor)) return -1
  return cursor + SDK_LINE_PREFIX.length
}

/** Where the payload of a response entry starts, or -1. */
function findResponseEntryPayload(line: string): number {
  const idStart = findSdkLogId(line)
  if (idStart < 0) return -1
  let cursor = idStart
  const idEnd = cursor + MAX_LOG_ID_LENGTH
  while (cursor < idEnd && isWordChar(line.charCodeAt(cursor))) cursor++
  if (line.charCodeAt(cursor) !== CHAR_CLOSE_BRACKET) return -1
  if (line.charCodeAt(cursor + 1) !== CHAR_SPACE) return -1
  cursor += 2
  if (
    !line.startsWith(RESPONSE_START_LABEL, cursor) &&
    !line.startsWith(RESPONSE_ERROR_LABEL, cursor)
  ) {
    return -1
  }
  // The payload starts at the quote of a JSON string literal when there is one.
  const prefixStart = idStart - SDK_LINE_PREFIX.length
  return line.charCodeAt(prefixStart - 1) === CHAR_DOUBLE_QUOTE ? prefixStart - 1 : prefixStart
}

/**
 * Whether the line is the SDK's one-line report of a successful response:
 * `console.log: [log_xxxxxx, request-id: "..."] post <url> succeeded with
 * status 200 in 15ms`. It carries no headers and is no entry. It is what says
 * that a response was logged at all: a log with these lines and no entry that
 * can be read is a log whose format the parser does not know (PRD FR-30).
 *
 * As strict and as cheap as the entry check: the SDK's prefix, its bracket
 * (bounded), a lower-case method, a URL without a space, then the words. Text
 * that merely contains the words (a prompt inside `sending request`) does not
 * match. Never throws, and tells nothing about the line but yes or no.
 */
export function isClaudeDebugLogSuccessStatusLine(line: string): boolean {
  if (typeof line !== 'string' || line.length > CLAUDE_DEBUG_LOG_MAX_LINE_LENGTH) return false
  let cursor = findSdkLogId(line)
  if (cursor < 0) return false
  // `log_xxxxxx`, then what the SDK adds inside the bracket (a retry, the request id).
  const bracketEnd = line.indexOf('] ', cursor)
  if (bracketEnd < 0 || bracketEnd - cursor > MAX_STATUS_BRACKET_LENGTH) return false
  cursor = bracketEnd + 2
  const methodStart = cursor
  while (cursor - methodStart <= MAX_METHOD_LENGTH) {
    const code = line.charCodeAt(cursor)
    if (!(code >= 0x61 && code <= 0x7a)) break
    cursor++
  }
  if (cursor === methodStart || line.charCodeAt(cursor) !== CHAR_SPACE) return false
  const urlStart = ++cursor
  const urlEnd = line.indexOf(' ', urlStart)
  if (urlEnd <= urlStart || urlEnd - urlStart > MAX_URL_LENGTH) return false
  return line.startsWith(SUCCESS_STATUS_LABEL, urlEnd)
}

/** The SDK's text for the payload: decoded when it is a JSON string literal, as is otherwise. */
function decodePayload(line: string, payloadStart: number): string | null {
  let end = line.length
  if (line.charCodeAt(end - 1) === CHAR_LF) end--
  if (line.charCodeAt(end - 1) === CHAR_CR) end--
  const payload = line.slice(payloadStart, end)
  if (payload.charCodeAt(0) !== CHAR_DOUBLE_QUOTE) return payload
  try {
    const decoded: unknown = JSON.parse(payload)
    return typeof decoded === 'string' ? decoded : null
  } catch {
    // Truncated or otherwise broken. The error text would quote the line, so it is dropped.
    return null
  }
}

/**
 * The entry kind and the offset of the details object's opening brace within
 * the decoded text, which `findResponseEntryPayload` has already vetted up to
 * the label.
 */
function locateDetails(text: string): { kind: ClaudeDebugLogEntryKind; start: number } | null {
  const labelStart = text.indexOf('] ', SDK_LINE_PREFIX.length) + 2
  if (text.startsWith(RESPONSE_START_LABEL, labelStart)) {
    return { kind: 'response-start', start: labelStart + RESPONSE_START_LABEL.length }
  }
  if (!text.startsWith(RESPONSE_ERROR_LABEL, labelStart)) return null
  const reasonStart = labelStart + RESPONSE_ERROR_LABEL.length
  const reasonEnd = text.indexOf(')', reasonStart)
  if (reasonEnd < 0 || reasonEnd - reasonStart > MAX_ERROR_REASON_LENGTH) return null
  if (text.charCodeAt(reasonEnd + 1) !== CHAR_SPACE) return null
  return { kind: 'response-error', start: reasonEnd + 2 }
}

/**
 * Parse one complete line of a Claude CLI debug log (a trailing newline is
 * tolerated). Returns the API response entry it holds, or "not an entry" with
 * a reason code. Never throws and never logs; see the module comment.
 */
export function parseClaudeDebugLogLine(line: string): ClaudeDebugLogParseResult {
  if (typeof line !== 'string') return UNRELATED
  if (line.length > CLAUDE_DEBUG_LOG_MAX_LINE_LENGTH) return OVERSIZED
  const payloadStart = findResponseEntryPayload(line)
  if (payloadStart < 0) return UNRELATED

  // From here on the line claims to be a response entry: a failure is a parse failure.
  const timestamp = line.slice(0, TIMESTAMP_LENGTH)
  if (!TIMESTAMP.test(timestamp)) return MALFORMED
  const observedAt = Date.parse(timestamp)
  if (!Number.isFinite(observedAt)) return MALFORMED

  const text = decodePayload(line, payloadStart)
  if (text === null) return MALFORMED
  const located = locateDetails(text)
  if (located === null) return MALFORMED
  const details = readDetails(text, located.start)
  if (details === null || details.status < 100 || details.status > 599) return MALFORMED

  return {
    kind: 'entry',
    entry: {
      kind: located.kind,
      observedAt,
      status: details.status,
      headers: details.headers,
      organizationUuid: details.organizationUuid
    }
  }
}
